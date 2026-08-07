export interface FeishuCliUserAuthorizationChallenge {
  protocol: 'cti-feishu-cli-user-auth/v1';
  toolUseId: string;
  verificationUrl: string;
  deviceCode: string;
  requestedScopes: string[];
  expiresInSeconds: number;
}

export type FeishuCliUserAuthorizationPolicyViolationCode =
  | 'broad_recommend'
  | 'domain_bundle'
  | 'missing_exact_scope'
  | 'multiple_scopes'
  | 'bot_scope_requires_admin';

export interface FeishuCliUserAuthorizationPolicyViolation {
  protocol: 'cti-feishu-cli-user-auth-policy/v1';
  toolUseId: string;
  code: FeishuCliUserAuthorizationPolicyViolationCode;
  requestedScopes: string[];
  userMessage: string;
}

export interface FeishuCliUserAuthorizationEvidenceInput {
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  toolResultContent: unknown;
  toolResultIsError?: boolean;
}

const OFFICIAL_DEVICE_AUTH_HOSTS = new Set([
  'accounts.feishu.cn',
  'accounts.larksuite.com',
  'accounts.larkoffice.com',
]);

function readCommand(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const command = (input as Record<string, unknown>).command;
  return typeof command === 'string' ? command.replace(/\\"/g, '"') : '';
}

function parseFlagValues(command: string, flag: string): string[] {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\s)--${escaped}(?:\\s*=\\s*|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s;]+))`, 'giu');
  return [...command.matchAll(pattern)].map((matched) => matched[1] || matched[2] || matched[3] || '');
}

function parseRequestedScopes(command: string): string[] {
  const raw = parseFlagValues(command, 'scope').join(' ');
  return Array.from(new Set(
    raw
      .split(/[\s,]+/)
      .map((scope) => scope.trim())
      .filter((scope) => /^[a-z0-9_.-]+:[a-z0-9_.:-]+$/i.test(scope)),
  )).sort();
}

function parseRequestedDomains(command: string): string[] {
  return Array.from(new Set(
    parseFlagValues(command, 'domain')
      .flatMap((raw) => raw.split(/[\s,]+/))
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean),
  )).sort();
}

function isFeishuCliAuthLoginCommand(command: string): boolean {
  return /\blark-cli(?:\.cmd|\.exe)?\s+auth\s+login\b/i.test(command);
}

function hasBooleanFlag(command: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Codex 在 Windows 上经常把 lark-cli 包在 PowerShell -Command 的引号中，
  // 因此末尾布尔参数后可能直接跟闭合引号或分号，而不一定是空白/字符串结尾。
  return new RegExp(`(?:^|\\s)--${escaped}(?=$|[\\s'\";)])`, 'iu').test(command);
}

function hasNonBlockingJsonContract(command: string): boolean {
  return hasBooleanFlag(command, 'no-wait') && hasBooleanFlag(command, 'json');
}

function parseJsonObject(content: unknown): Record<string, unknown> | null {
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // lark-cli 输出可能带有 CLI 提示；仅接受其中可独立解析的 JSON 对象。
    }
  }
  return null;
}

function isOfficialVerificationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && OFFICIAL_DEVICE_AUTH_HOSTS.has(url.hostname.toLowerCase())
      && url.pathname === '/oauth/v1/device/verify';
  } catch {
    return false;
  }
}

export function extractFeishuBotMissingAppScopes(content: unknown): string[] {
  const result = parseJsonObject(content);
  if (!result) return [];
  const error = result.error && typeof result.error === 'object' && !Array.isArray(result.error)
    ? result.error as Record<string, unknown>
    : result;
  const identity = String(error.identity || result.identity || '').trim().toLowerCase();
  const subtype = String(error.subtype || '').trim().toLowerCase();
  const code = Number(error.code);
  if (identity !== 'bot' || (subtype !== 'app_scope_not_applied' && code !== 99991672)) return [];
  const scopes = Array.isArray(error.missing_scopes) ? error.missing_scopes : [];
  return Array.from(new Set(
    scopes
      .map((scope) => typeof scope === 'string' ? scope.trim() : '')
      .filter((scope) => /^[a-z0-9_.-]+:[a-z0-9_.:-]+$/iu.test(scope)),
  )).sort();
}

export function extractFeishuCliUserAuthorizationPolicyViolation(
  input: FeishuCliUserAuthorizationEvidenceInput,
  observedBotMissingScopes: Iterable<string> = [],
): FeishuCliUserAuthorizationPolicyViolation | null {
  const command = readCommand(input.toolInput);
  if (!command || !isFeishuCliAuthLoginCommand(command) || !hasNonBlockingJsonContract(command)) return null;
  const requestedScopes = parseRequestedScopes(command);
  const requestedDomains = parseRequestedDomains(command);
  const hasRecommend = /(?:^|\s)--recommend(?:\s|$)/iu.test(command);
  let code: FeishuCliUserAuthorizationPolicyViolationCode | null = null;
  let userMessage = '';
  if (hasRecommend) {
    code = 'broad_recommend';
    userMessage = '未发起飞书用户授权：`--recommend` 会扩展为一组推荐权限，范围仍然过宽。请先执行目标 API 或查看 schema，只申请当前动作缺少的一个精确 scope。';
  } else if (requestedDomains.length > 0) {
    code = 'domain_bundle';
    userMessage = '未发起飞书用户授权：按 domain 授权会一次加入整组业务权限。请改为当前动作真实缺少的一个 `--scope`。';
  } else if (requestedScopes.length === 0) {
    code = 'missing_exact_scope';
    userMessage = '未发起飞书用户授权：没有提供当前动作需要的精确 scope。请先取得真实 missing_scope 证据。';
  } else if (requestedScopes.length > 1) {
    code = 'multiple_scopes';
    userMessage = `未发起飞书用户授权：本次同时请求了 ${requestedScopes.length} 项权限。请按最小权限原则一次只申请一个当前动作必需的 scope。`;
  } else if (new Set(Array.from(observedBotMissingScopes)).has(requestedScopes[0])) {
    code = 'bot_scope_requires_admin';
    userMessage = `未发起飞书用户授权：${requestedScopes[0]} 是当前应用 bot 缺少的权限，需要管理员在开发者后台开通并发布，不能用普通用户 OAuth 代替。请先询问 Owner 是否申请这一项。`;
  }
  return code ? {
    protocol: 'cti-feishu-cli-user-auth-policy/v1',
    toolUseId: input.toolUseId,
    code,
    requestedScopes,
    userMessage,
  } : null;
}

/**
 * 只从本轮真实执行的 lark-cli 非阻塞登录命令及其对应成功结果构造授权证据。
 * scope 来自工具输入，URL/device code 来自同一 tool_use_id 的工具结果，模型正文不参与裁决。
 */
export function extractFeishuCliUserAuthorizationChallenge(
  input: FeishuCliUserAuthorizationEvidenceInput,
  observedBotMissingScopes: Iterable<string> = [],
): FeishuCliUserAuthorizationChallenge | null {
  if (input.toolResultIsError) return null;
  const command = readCommand(input.toolInput);
  if (!command) return null;
  if (!isFeishuCliAuthLoginCommand(command)) return null;
  if (!hasNonBlockingJsonContract(command)) return null;

  if (extractFeishuCliUserAuthorizationPolicyViolation(input, observedBotMissingScopes)) return null;

  const requestedScopes = parseRequestedScopes(command);
  if (requestedScopes.length !== 1) return null;
  const result = parseJsonObject(input.toolResultContent);
  if (!result) return null;

  const deviceCode = typeof result.device_code === 'string' ? result.device_code.trim() : '';
  const verificationUrl = typeof result.verification_url === 'string' ? result.verification_url.trim() : '';
  const expiresInSeconds = typeof result.expires_in === 'number' ? result.expires_in : Number(result.expires_in);
  if (!deviceCode || !isOfficialVerificationUrl(verificationUrl)) return null;
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0 || expiresInSeconds > 3600) return null;

  return {
    protocol: 'cti-feishu-cli-user-auth/v1',
    toolUseId: input.toolUseId,
    verificationUrl,
    deviceCode,
    requestedScopes,
    expiresInSeconds: Math.floor(expiresInSeconds),
  };
}
