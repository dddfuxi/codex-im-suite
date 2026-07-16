import type {
  FeishuCloudDocumentHost,
  FeishuCloudLinkResolveInput,
  FeishuCloudLinkResolveResult,
} from 'claude-to-im/src/lib/bridge/host.js';
import type { FeishuAuthorizationInput, FeishuAuthorizationResult } from './feishu-oauth.js';
import {
  FEISHU_OAUTH_BASE_SCOPES,
  normalizeFeishuOAuthScopes,
} from './feishu-oauth-governance.js';

const FEISHU_OPEN_API_BASE = 'https://open.feishu.cn';
const PERMISSION_CODES = new Set([1770032, 1310213, 125403, 99991663]);
const TENANT_TOKEN_SKEW_MS = 60 * 1000;

export type FeishuCloudLinkType = 'docx' | 'sheets' | 'base';

export interface FeishuCloudLink {
  type: FeishuCloudLinkType;
  url: string;
  token: string;
  sheetId?: string;
  tableId?: string;
  viewId?: string;
}

export interface FeishuCloudDocumentConfig {
  appId?: string;
  appSecret?: string;
  maxChars: number;
  maxRows: number;
  maxRecords: number;
  maxSheets: number;
}

export interface FeishuCloudAccessTokenProvider {
  getAccessToken(userId: string, requiredScopes?: string[]): Promise<string | null>;
  requestUserAuthorization(input: FeishuAuthorizationInput): Promise<FeishuAuthorizationResult>;
}

export interface FeishuCloudTenantTokenProvider {
  getTenantAccessToken(): Promise<string | null>;
}

export class FeishuTenantAccessTokenProvider implements FeishuCloudTenantTokenProvider {
  private cached: { token: string; expiresAtMs: number } | null = null;

  constructor(private readonly options: {
    appId?: string;
    appSecret?: string;
    fetch?: typeof fetch;
    now?: () => number;
  }) {}

  async getTenantAccessToken(): Promise<string | null> {
    if (!this.options.appId || !this.options.appSecret) return null;
    const now = this.options.now ? this.options.now() : Date.now();
    if (this.cached && this.cached.expiresAtMs > now + TENANT_TOKEN_SKEW_MS) {
      return this.cached.token;
    }
    const fetchImpl = this.options.fetch || fetch;
    const response = await fetchImpl(`${FEISHU_OPEN_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        app_id: this.options.appId,
        app_secret: this.options.appSecret,
      }),
    });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok || Number(payload.code || 0) !== 0 || !payload.tenant_access_token) {
      throw new Error(payload.msg || payload.message || `HTTP ${response.status}`);
    }
    const ttlMs = Math.max(60, Number(payload.expire || payload.expires_in || 7200)) * 1000;
    this.cached = {
      token: String(payload.tenant_access_token),
      expiresAtMs: now + ttlMs,
    };
    return this.cached.token;
  }
}

export function parseFeishuCloudLinks(text: string): FeishuCloudLink[] {
  const urls = text.match(/https?:\/\/[^\s<>"'\]\)]+/gi) || [];
  const seen = new Set<string>();
  const links: FeishuCloudLink[] = [];
  for (const rawUrl of urls) {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      continue;
    }
    if (!/(^|\.)((feishu\.cn)|(larksuite\.com))$/i.test(url.hostname)) continue;
    const parts = url.pathname.split('/').filter(Boolean);
    const kind = parts[0]?.toLowerCase();
    const token = parts[1];
    if (!kind || !token) continue;
    const type = kind === 'docx' || kind === 'docs'
      ? 'docx'
      : kind === 'sheets'
        ? 'sheets'
        : kind === 'base' || kind === 'bitable'
          ? 'base'
          : null;
    if (!type) continue;
    const sheetId = url.searchParams.get('sheet') || url.searchParams.get('sheet_id') || undefined;
    const tableId = url.searchParams.get('table') || url.searchParams.get('table_id') || undefined;
    const viewId = url.searchParams.get('view') || url.searchParams.get('view_id') || undefined;
    const dedupeKey = `${type}:${token}:${sheetId || ''}:${tableId || ''}:${viewId || ''}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    links.push({ type, url: rawUrl, token, sheetId, tableId, viewId });
  }
  return links;
}

export function resolveFeishuCloudOAuthScopes(links: FeishuCloudLink[]): string[] {
  const scopes = new Set<string>(FEISHU_OAUTH_BASE_SCOPES);
  for (const link of links) {
    if (link.type === 'docx') scopes.add('docx:document:readonly');
    if (link.type === 'sheets') scopes.add('sheets:spreadsheet:readonly');
    if (link.type === 'base') scopes.add('bitable:app:readonly');
  }
  return normalizeFeishuOAuthScopes(scopes);
}

export function createFeishuCloudDocumentHost(options: {
  config: FeishuCloudDocumentConfig;
  tokenProvider: FeishuCloudAccessTokenProvider;
  tenantTokenProvider?: FeishuCloudTenantTokenProvider;
  fetch?: typeof fetch;
}): FeishuCloudDocumentHost {
  const fetchImpl = options.fetch || fetch;
  return {
    resolveFeishuCloudLinks: async (input) => {
      const links = parseFeishuCloudLinks(input.text);
      if (links.length === 0) {
        return { status: 'no_links', linkCount: 0 };
      }
      const requestedScopes = resolveFeishuCloudOAuthScopes(links);

      let tenantPermissionError: FeishuCloudPermissionError | null = null;
      let tenantTokenError: Error | null = null;
      if (options.tenantTokenProvider) {
        let tenantToken: string | null = null;
        try {
          tenantToken = await options.tenantTokenProvider.getTenantAccessToken();
        } catch (error) {
          tenantTokenError = normalizeError(error);
        }
        if (tenantToken) {
          try {
            const resolved = await readLinks(links, tenantToken, options.config, fetchImpl);
            return {
              status: 'resolved',
              linkCount: links.length,
              systemPrompt: buildSystemPrompt(resolved.sections, resolved.truncated, 'tenant'),
            };
          } catch (error) {
            if (error instanceof FeishuCloudPermissionError) {
              tenantPermissionError = error;
            } else {
              return {
                status: 'error',
                linkCount: links.length,
                userMessage: `未完成：应用 token 读取飞书云文档失败：${error instanceof Error ? error.message : String(error)}`,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }
        }
      }

      if (!input.userId) {
        return {
          status: 'auth_required',
          linkCount: links.length,
          userMessage: buildMissingSenderMessage(tenantPermissionError, tenantTokenError),
          error: tenantPermissionError?.message || tenantTokenError?.message,
        };
      }

      const requestAuthorization = () => options.tokenProvider.requestUserAuthorization({
        resourceClass: 'cloud_document',
        userId: input.userId!,
        chatId: input.chatId,
        channelType: input.channelType,
        userDisplayName: input.userDisplayName,
        messageId: input.messageId,
        text: input.text,
        linkUrls: links.map((link) => link.url),
        requestedScopes,
      });
      const buildAuthorizationRequiredResult = (authorization: Extract<FeishuAuthorizationResult, { status: 'auth_required' }>): FeishuCloudLinkResolveResult => ({
        status: 'auth_required',
        linkCount: links.length,
        loginUrl: authorization.loginUrl,
        userMessage: authorization.userMessage,
        feishuCardJson: authorization.feishuCardJson,
        authorizationRequestId: authorization.authorizationRequestId,
        requestedScopes: authorization.requestedScopes,
        authorizationCardDisposition: authorization.cardDisposition,
      });

      let accessToken = await options.tokenProvider.getAccessToken(input.userId, requestedScopes);
      if (!accessToken) {
        const authorization = await requestAuthorization();
        if (authorization.status !== 'authorized') {
          return buildAuthorizationRequiredResult(authorization);
        }
        accessToken = authorization.accessToken;
      }

      try {
        const resolved = await readLinks(links, accessToken, options.config, fetchImpl);
        return {
          status: 'resolved',
          linkCount: links.length,
          systemPrompt: buildSystemPrompt(resolved.sections, resolved.truncated, 'user'),
        };
      } catch (error) {
        if (error instanceof FeishuCloudPermissionError) {
          if (error.scopeRelated && !input.messageId?.endsWith(':oauth-resume')) {
            const authorization = await requestAuthorization();
            if (authorization.status !== 'authorized') {
              return buildAuthorizationRequiredResult(authorization);
            }
            try {
              const resolved = await readLinks(links, authorization.accessToken, options.config, fetchImpl);
              return {
                status: 'resolved',
                linkCount: links.length,
                systemPrompt: buildSystemPrompt(resolved.sections, resolved.truncated, 'user'),
              };
            } catch (retryError) {
              if (retryError instanceof FeishuCloudPermissionError) {
                return {
                  status: 'permission_denied',
                  linkCount: links.length,
                  userMessage: buildUserPermissionDeniedMessage(retryError, tenantPermissionError, tenantTokenError),
                  error: retryError.message,
                };
              }
              return {
                status: 'error',
                linkCount: links.length,
                userMessage: `未完成：读取飞书云文档失败：${retryError instanceof Error ? retryError.message : String(retryError)}`,
                error: retryError instanceof Error ? retryError.message : String(retryError),
              };
            }
          }
          return {
            status: 'permission_denied',
            linkCount: links.length,
            userMessage: buildUserPermissionDeniedMessage(error, tenantPermissionError, tenantTokenError),
            error: error.message,
          };
        }
        return {
          status: 'error',
          linkCount: links.length,
          userMessage: `未完成：读取飞书云文档失败：${error instanceof Error ? error.message : String(error)}`,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

async function readLinks(
  links: FeishuCloudLink[],
  accessToken: string,
  config: FeishuCloudDocumentConfig,
  fetchImpl: typeof fetch,
): Promise<{ sections: string[]; truncated: boolean }> {
  const sections: string[] = [];
  let truncated = false;
  let remaining = Math.max(1000, config.maxChars);
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    const section = await readLink(link, accessToken, config, fetchImpl);
    const trimmed = limitText(section, remaining);
    sections.push(`## Source ${index + 1}: ${link.url}\n${trimmed.text}`);
    remaining -= trimmed.text.length;
    truncated ||= trimmed.truncated;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
  }
  return { sections, truncated };
}

async function readLink(
  link: FeishuCloudLink,
  accessToken: string,
  config: FeishuCloudDocumentConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (link.type === 'docx') return readDocx(link, accessToken, fetchImpl);
  if (link.type === 'sheets') return readSheets(link, accessToken, config, fetchImpl);
  return readBitable(link, accessToken, config, fetchImpl);
}

async function readDocx(link: FeishuCloudLink, accessToken: string, fetchImpl: typeof fetch): Promise<string> {
  const payload = await feishuRequest<any>(
    `${FEISHU_OPEN_API_BASE}/open-apis/docx/v1/documents/${encodeURIComponent(link.token)}/raw_content`,
    accessToken,
    fetchImpl,
    {},
    ['docx:document:readonly'],
  );
  const content = payload.data?.content || payload.data?.raw_content || payload.content || '';
  return [`Type: Docx`, `Document ID: ${link.token}`, '', String(content)].join('\n');
}

async function readSheets(
  link: FeishuCloudLink,
  accessToken: string,
  config: FeishuCloudDocumentConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  const queryPayload = await feishuRequest<any>(
    `${FEISHU_OPEN_API_BASE}/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(link.token)}/sheets/query`,
    accessToken,
    fetchImpl,
    {},
    ['sheets:spreadsheet:readonly', 'sheets:spreadsheet:read', 'drive:drive:readonly'],
  );
  const allSheets = queryPayload.data?.sheets || queryPayload.sheets || [];
  const selectedSheets = link.sheetId
    ? allSheets.filter((sheet: any) => {
        const sheetId = sheet.sheet_id || sheet.sheetId || sheet.id;
        return sheetId === link.sheetId;
      })
    : allSheets;
  const sheets = selectedSheets.length > 0
    ? selectedSheets.slice(0, Math.max(1, config.maxSheets))
    : link.sheetId
      ? [{ sheet_id: link.sheetId, title: link.sheetId }]
      : [];
  const sections = [`Type: Sheets`, `Spreadsheet token: ${link.token}`, `Sheets read: ${sheets.length}`];
  for (const sheet of sheets) {
    const sheetId = sheet.sheet_id || sheet.sheetId || sheet.id;
    if (!sheetId) continue;
    const title = sheet.title || sheet.name || sheetId;
    const range = `${sheetId}!A1:Z${Math.max(1, config.maxRows)}`;
    const valuesPayload = await feishuRequest<any>(
      `${FEISHU_OPEN_API_BASE}/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(link.token)}/values/${encodeURIComponent(range)}?valueRenderOption=ToString&dateTimeRenderOption=FormattedString`,
      accessToken,
      fetchImpl,
      {},
      ['sheets:spreadsheet:readonly', 'sheets:spreadsheet:read', 'drive:drive:readonly'],
    );
    const values = valuesPayload.data?.valueRange?.values || valuesPayload.data?.values || [];
    sections.push('', `### Sheet: ${title} (${sheetId})`, `Rows read: ${values.length}`, formatRows(values));
  }
  return sections.join('\n');
}

async function readBitable(
  link: FeishuCloudLink,
  accessToken: string,
  config: FeishuCloudDocumentConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  const tablesPayload = await feishuRequest<any>(
    `${FEISHU_OPEN_API_BASE}/open-apis/bitable/v1/apps/${encodeURIComponent(link.token)}/tables`,
    accessToken,
    fetchImpl,
    {},
    ['bitable:app:readonly', 'base:table:read'],
  );
  const allTables = tablesPayload.data?.items || tablesPayload.data?.tables || tablesPayload.items || [];
  const selectedTables = link.tableId
    ? allTables.filter((table: any) => table.table_id === link.tableId || table.id === link.tableId)
    : allTables.slice(0, 3);
  const sections = [`Type: Bitable`, `App token: ${link.token}`, `Tables read: ${selectedTables.length}`];
  for (const table of selectedTables) {
    const tableId = table.table_id || table.id;
    if (!tableId) continue;
    const tableName = table.name || table.table_name || tableId;
    const fieldsPayload = await feishuRequest<any>(
      `${FEISHU_OPEN_API_BASE}/open-apis/bitable/v1/apps/${encodeURIComponent(link.token)}/tables/${encodeURIComponent(tableId)}/fields`,
      accessToken,
      fetchImpl,
      {},
      ['bitable:app:readonly', 'base:field:read'],
    );
    const fields = fieldsPayload.data?.items || fieldsPayload.items || [];
    const records = await readBitableRecords(link, tableId, accessToken, config, fetchImpl);
    sections.push(
      '',
      `### Table: ${tableName} (${tableId})`,
      `Fields: ${fields.map((field: any) => field.field_name || field.name).filter(Boolean).join(', ')}`,
      `Records read: ${records.length}`,
      formatRecords(records),
    );
  }
  return sections.join('\n');
}

async function readBitableRecords(
  link: FeishuCloudLink,
  tableId: string,
  accessToken: string,
  config: FeishuCloudDocumentConfig,
  fetchImpl: typeof fetch,
): Promise<any[]> {
  const records: any[] = [];
  let pageToken = '';
  const pageSize = Math.min(500, Math.max(1, config.maxRecords));
  while (records.length < config.maxRecords) {
    const url = new URL(`${FEISHU_OPEN_API_BASE}/open-apis/bitable/v1/apps/${encodeURIComponent(link.token)}/tables/${encodeURIComponent(tableId)}/records/search`);
    url.searchParams.set('page_size', String(Math.min(pageSize, config.maxRecords - records.length)));
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const body = link.viewId ? { view_id: link.viewId } : {};
    const payload = await feishuRequest<any>(url.toString(), accessToken, fetchImpl, {
      method: 'POST',
      body: JSON.stringify(body),
    }, ['bitable:app:readonly', 'base:record:retrieve']);
    const items = payload.data?.items || payload.items || [];
    records.push(...items);
    if (!payload.data?.has_more || !payload.data?.page_token) break;
    pageToken = payload.data.page_token;
  }
  return records.slice(0, config.maxRecords);
}

async function feishuRequest<T>(
  url: string,
  accessToken: string,
  fetchImpl: typeof fetch,
  init: RequestInit = {},
  requiredScopes: string[] = [],
): Promise<T> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({})) as any;
  const code = Number(payload.code || 0);
  if (!response.ok || code !== 0) {
    const message = payload.msg || payload.message || `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403 || PERMISSION_CODES.has(code)) {
      throw new FeishuCloudPermissionError(message, requiredScopes, isScopeRelatedPermissionMessage(message));
    }
    throw new Error(message);
  }
  return payload as T;
}

class FeishuCloudPermissionError extends Error {
  constructor(
    message: string,
    readonly requiredScopes: string[] = [],
    readonly scopeRelated = false,
  ) {
    super(message);
  }
}

function isScopeRelatedPermissionMessage(message: string): boolean {
  return /scope|scopes|token_type=user|openapi|permission/i.test(message)
    && /sheets:|docx:|drive:|bitable:|base:|auth:/i.test(message);
}

function buildSystemPrompt(sections: string[], truncated: boolean, tokenSource: 'tenant' | 'user'): string {
  const sourceLine = tokenSource === 'tenant'
    ? '- The following content was read through the Feishu application tenant token.'
    : '- The following content was read through the requesting Feishu user OAuth token.';
  return [
    'Feishu cloud document evidence prompt (agent context, not a final reply):',
    sourceLine,
    '- Use this content as source evidence when the agent answers the current user request.',
    '- Do not copy this evidence prompt verbatim into the final reply.',
    '- Do not fetch, browse, curl, or otherwise access the original Feishu cloud document URLs again in this turn.',
    '- If the user asks to view, summarize, or analyze the document, answer from this context instead of saying the link is private, unavailable, or requires public sharing.',
    truncated ? '- Content was truncated by bridge limits; mention truncation if it affects completeness.' : '',
    '',
    ...sections,
  ].filter(Boolean).join('\n');
}

function buildMissingSenderMessage(
  tenantPermissionError: FeishuCloudPermissionError | null,
  tenantTokenError: Error | null,
): string {
  if (tenantPermissionError) {
    return [
      '未完成：应用 token 无法读取这个飞书云文档，且这条旧请求缺少发起人用户 ID，无法继续发起用户 OAuth 授权。',
      '请让发起人重新发送原消息以触发安全登录授权，或让文档所有者把内容分享给应用/导出内容。',
      buildScopeHint(tenantPermissionError),
    ].filter(Boolean).join('\n');
  }
  if (tenantTokenError) {
    return [
      `未完成：应用 token 获取或读取失败：${tenantTokenError.message}`,
      '这条旧请求缺少发起人用户 ID，无法继续发起用户 OAuth 授权。请重新发送原消息。',
    ].join('\n');
  }
  return '未完成：这条飞书消息缺少发起人用户 ID，无法按用户身份安全读取云文档。';
}

function buildUserPermissionDeniedMessage(
  userError: FeishuCloudPermissionError,
  tenantPermissionError: FeishuCloudPermissionError | null,
  tenantTokenError: Error | null,
): string {
  const lines = tenantPermissionError || tenantTokenError
    ? [
      '未完成：应用 token 无法读取这个云文档，当前登录飞书用户也没有这个云文档权限。',
      '请让文档所有者确认登录用户有文档访问权限，或把文档分享给应用，或导出内容后再发。',
    ]
    : [
      '未完成：当前登录飞书用户或应用权限无法读取这个云文档。',
      '请让文档所有者确认你有文档访问权限，或导出内容后再发。',
    ];
  if (tenantPermissionError) {
    lines.push(`应用 token 失败原因：${tenantPermissionError.message}`);
  } else if (tenantTokenError) {
    lines.push(`应用 token 失败原因：${tenantTokenError.message}`);
  }
  lines.push(buildScopeHint(userError));
  return lines.filter(Boolean).join('\n');
}

function buildScopeHint(error: FeishuCloudPermissionError): string {
  return error.requiredScopes.length > 0
    ? `请确认飞书开放平台已开通并发布这些权限：${error.requiredScopes.join(', ')}。`
    : '请确认飞书开放平台权限已开通并发布。';
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function limitText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, maxChars - 32))}\n[TRUNCATED BY BRIDGE LIMIT]`, truncated: true };
}

function formatRows(rows: unknown[][]): string {
  return rows
    .map((row, index) => `${index + 1}. ${row.map((cell) => cell == null ? '' : String(cell)).join(' | ')}`)
    .join('\n');
}

function formatRecords(records: any[]): string {
  return records
    .map((record, index) => `${index + 1}. ${JSON.stringify(record.fields || record.record || record)}`)
    .join('\n');
}
