import type { FeishuOAuthPendingRequest } from './feishu-oauth.js';

export const FEISHU_OAUTH_BASE_SCOPES = [
  'offline_access',
] as const;

export function normalizeFeishuOAuthScopes(scopes: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(scopes)
    .map((scope) => scope.trim())
    .filter(Boolean)))
    .sort((left, right) => left.localeCompare(right));
}

export function buildFeishuOAuthAuthorizationKey(userId: string, scopes: Iterable<string>): string {
  return `${userId.trim()}|${normalizeFeishuOAuthScopes(scopes).join(',')}`;
}

export function mergeFeishuOAuthPendingRequests(
  current: FeishuOAuthPendingRequest[],
  next?: FeishuOAuthPendingRequest,
): FeishuOAuthPendingRequest[] {
  const merged = [...current];
  if (!next?.text?.trim()) return merged;
  const key = pendingRequestKey(next);
  if (!merged.some((item) => pendingRequestKey(item) === key)) merged.push(next);
  return merged;
}

function pendingRequestKey(request: FeishuOAuthPendingRequest): string {
  return [
    request.channelType,
    request.chatId,
    request.userId || '',
    request.messageId || '',
    request.text.trim(),
  ].join('|');
}
