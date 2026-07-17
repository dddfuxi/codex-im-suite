export interface FeishuCliUserAuthorizationChallenge {
  protocol: 'cti-feishu-cli-user-auth/v1';
  toolUseId: string;
  verificationUrl: string;
  deviceCode: string;
  requestedScopes: string[];
  expiresInSeconds: number;
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

function parseRequestedScopes(command: string): string[] {
  const matched = command.match(/(?:^|\s)--scope(?:\s*=\s*|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;]+))/i);
  const raw = matched?.[1] || matched?.[2] || matched?.[3] || '';
  return Array.from(new Set(
    raw
      .split(/[\s,]+/)
      .map((scope) => scope.trim())
      .filter((scope) => /^[a-z0-9_.-]+:[a-z0-9_.:-]+$/i.test(scope)),
  )).sort();
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

/**
 * 只从本轮真实执行的 lark-cli 非阻塞登录命令及其对应成功结果构造授权证据。
 * scope 来自工具输入，URL/device code 来自同一 tool_use_id 的工具结果，模型正文不参与裁决。
 */
export function extractFeishuCliUserAuthorizationChallenge(
  input: FeishuCliUserAuthorizationEvidenceInput,
): FeishuCliUserAuthorizationChallenge | null {
  if (input.toolResultIsError) return null;
  const command = readCommand(input.toolInput);
  if (!command) return null;
  if (!/\blark-cli(?:\.cmd|\.exe)?\s+auth\s+login\b/i.test(command)) return null;
  if (!/(?:^|\s)--no-wait(?:\s|$)/i.test(command)) return null;
  if (!/(?:^|\s)--json(?:\s|$)/i.test(command)) return null;

  const requestedScopes = parseRequestedScopes(command);
  if (requestedScopes.length === 0) return null;
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
