export type FeishuScopeRequirement = string | readonly string[];

function normalizeScope(scope: string): string {
  return scope.trim().toLowerCase();
}

function scopeRiskScore(scope: string): number {
  const normalized = normalizeScope(scope);
  let score = 0;
  if (!/(?:readonly|:read)$/u.test(normalized)) score += 100;
  if (/(?:write|manage|admin|delete|create|update|access_as_user)/u.test(normalized)) score += 100;
  if (normalized.includes('access_as_app')) score += 30;
  if (normalized.includes('.base:readonly') || normalized.includes('.base:read')) score -= 40;
  if (normalized.endsWith(':readonly')) score -= 20;
  else if (normalized.endsWith(':read')) score -= 10;
  return score;
}

/**
 * 飞书缺权限错误经常把“任选其一”的兼容 scope 全部列出。这里只选一个
 * 最小只读候选，避免把兼容别名误当成需要同时申请的一揽子权限。
 */
export function selectPreferredFeishuScope(scopes: Iterable<string>): string | undefined {
  const normalized = Array.from(new Set(
    Array.from(scopes)
      .map((scope) => scope.trim())
      .filter((scope) => /^[a-z0-9_.-]+:[a-z0-9_.:-]+$/iu.test(scope)),
  ));
  return normalized.sort((left, right) => (
    scopeRiskScore(left) - scopeRiskScore(right)
    || left.length - right.length
    || left.localeCompare(right)
  ))[0];
}

export function resolvePreferredFeishuScopeRequirements(
  requirements: readonly FeishuScopeRequirement[],
): string[] {
  const selected: string[] = [];
  for (const requirement of requirements) {
    const scope = typeof requirement === 'string'
      ? requirement.trim()
      : selectPreferredFeishuScope(requirement);
    if (scope && !selected.includes(scope)) selected.push(scope);
  }
  return selected;
}
