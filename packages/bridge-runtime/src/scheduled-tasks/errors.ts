export type ScheduledTaskErrorKind =
  | 'rate_limit'
  | 'overloaded'
  | 'network'
  | 'timeout'
  | 'server_error'
  | 'permission'
  | 'invalid_input'
  | 'target_missing'
  | 'tool_not_allowed'
  | 'workspace_unavailable'
  | 'interrupted_by_restart'
  | 'unknown';

const TRANSIENT_ERROR_KINDS = new Set<ScheduledTaskErrorKind>([
  'rate_limit',
  'overloaded',
  'network',
  'timeout',
  'server_error',
]);

export function classifyScheduledTaskError(error: unknown): ScheduledTaskErrorKind {
  const text = (error instanceof Error ? error.message : String(error || '')).normalize('NFKC').toLowerCase();
  if (/429|rate[_ -]?limit|too many requests|resource exhausted/iu.test(text)) return 'rate_limit';
  if (/overload|high demand|capacity exceeded|529/iu.test(text)) return 'overloaded';
  if (/timeout|timed out|etimedout|stalled/iu.test(text)) return 'timeout';
  if (/econnrefused|econnreset|enotfound|network|socket hang up|fetch failed/iu.test(text)) return 'network';
  if (/permission denied|forbidden|unauthori[sz]ed|\b401\b|\b403\b|无权限|权限不足/iu.test(text)) return 'permission';
  if (/target.{0,20}(?:not found|missing)|chat.{0,20}(?:not found|missing)|目标.{0,12}(?:不存在|缺失)/iu.test(text)) return 'target_missing';
  if (/tool.{0,20}(?:not allowed|denied)|工具.{0,12}(?:不允许|未注册)/iu.test(text)) return 'tool_not_allowed';
  if (/workspace.{0,20}(?:unavailable|invalid|outside)|工作区.{0,12}(?:不可用|越界|无效)/iu.test(text)) return 'workspace_unavailable';
  if (/invalid input|validation|参数无效|格式错误/iu.test(text)) return 'invalid_input';
  if (/\b5\d{2}\b.{0,30}(?:server|service|gateway)|(?:server|service|gateway).{0,30}\b5\d{2}\b|internal server error|bad gateway|service unavailable/iu.test(text)) {
    return 'server_error';
  }
  return 'unknown';
}

export function isRetryableScheduledTaskError(kind: ScheduledTaskErrorKind): boolean {
  return TRANSIENT_ERROR_KINDS.has(kind);
}
