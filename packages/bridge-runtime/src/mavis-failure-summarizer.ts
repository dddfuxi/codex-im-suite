/**
 * Summarize / sanitize mavis failure messages and tool result payloads.
 *
 * Goals:
 * - Never echo raw `status.message` / stdout / stderr to the user
 *   (it may contain tokens, internal paths, or partial diffs).
 * - Replace known failure shapes (auth, quota, timeout, ...) with a
 *   stable short summary, so the chat reply stays under 80 chars.
 * - Strip `<skill_content>`, HTML comments, and `<citation>` blocks
 *   from tool result strings — they are bridge-internal artifacts
 *   that should never reach the user.
 *
 * These helpers are pure and side-effect-free so they can be unit-tested
 * without spawning mavis.
 */

const FAILURE_PATTERNS: Array<{ pattern: RegExp; summary: string }> = [
  { pattern: /usage\s*limit|quota|429|rate\s*limit/i,         summary: '远端 API 额度或速率限制' },
  { pattern: /401|unauthorized|refresh\s*token|auth\s*token/i, summary: '远端登录已失效' },
  { pattern: /403|forbidden/i,                                summary: '远端拒绝访问（权限或资源不可用）' },
  { pattern: /econnrefused|connection\s*refused|fetch\s*failed/i, summary: '远端服务不可达' },
  { pattern: /timeout|etimedout|socket\s*hang\s*up/i,         summary: '远端调用超时' },
  { pattern: /404|not\s*found/i,                              summary: '远端资源不存在（session 可能已被 GC）' },
  { pattern: /500|502|503|504/i,                              summary: '远端服务内部错误' },
  { pattern: /invalid\s*request|bad\s*request/i,             summary: '请求参数不合法' },
  { pattern: /\bv1\/responses\b/i,                            summary: 'API 协议不兼容' },
];

export function summarizeMavisFailureMessage(raw: string | undefined, maxLen = 180): string {
  if (!raw || typeof raw !== 'string') return '远端返回未提供错误细节';
  for (const { pattern, summary } of FAILURE_PATTERNS) {
    if (pattern.test(raw)) return summary;
  }
  const normalized = raw.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLen ? normalized : `${normalized.slice(0, maxLen - 3)}...`;
}

const MAX_TOOL_RESULT_CHARS = 240;
const TOOL_RESULT_DROP_PATTERNS: RegExp[] = [
  /<skill_content[\s\S]*?<\/skill_content>/gi,
  /<!--[\s\S]*?-->/g,
  /<citation>[\s\S]*?<\/citation>/gi,
];

export function sanitizeToolResult(raw: string, maxChars = MAX_TOOL_RESULT_CHARS): string {
  if (typeof raw !== 'string') return '';
  let text = raw;
  for (const pattern of TOOL_RESULT_DROP_PATTERNS) text = text.replace(pattern, '[已脱敏]');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}
