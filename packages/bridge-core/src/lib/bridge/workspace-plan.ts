import path from 'node:path';

export type WorkspaceAccessMode = 'read_only' | 'read_write';

export interface WorkspaceMount {
  projectId?: string;
  path: string;
  accessMode: WorkspaceAccessMode;
  evidenceIds: string[];
  reason: string;
  expiresAfterTurn: true;
}

export interface DeniedWorkspaceRoot {
  path: string;
  reason: string;
}

export interface TurnWorkspacePlan {
  version: 'cti-turn-workspace/v1';
  primaryWorkspace: WorkspaceMount;
  temporaryMounts: WorkspaceMount[];
  deniedRoots: DeniedWorkspaceRoot[];
  resolvedFrom: 'explicit_path' | 'session_binding' | 'default';
  createdAt: string;
  expiresAfterTurn: true;
}

export interface ResolveTurnWorkspacePlanInput {
  prompt: string;
  currentWorkingDirectory?: string;
  defaultWorkingDirectory?: string;
  registeredRoots?: readonly string[];
  deniedRoots?: readonly DeniedWorkspaceRoot[];
  requiresWrite?: boolean;
  now?: string;
}

function normalizeWorkspacePath(value: string): string {
  return path.normalize(path.resolve(value.trim())).replace(/[\\/]+$/u, '');
}

function compareKey(value: string): string {
  const normalized = normalizeWorkspacePath(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSameOrChildPath(candidate: string, root: string): boolean {
  const candidateKey = compareKey(candidate);
  const rootKey = compareKey(root);
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${path.sep}`);
}

function uniquePaths(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value?.trim()) continue;
    const normalized = normalizeWorkspacePath(value);
    const key = compareKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

/**
 * 只提取用户明确写出的绝对路径。未加引号的含空格路径无法可靠判断边界，
 * 因此要求用户使用引号，避免把后续自然语言误当作目录名。
 */
export function extractAbsolutePathCandidates(text: string): string[] {
  const source = (text || '').normalize('NFKC');
  const candidates: string[] = [];
  const quoted = /["'`]([A-Za-z]:[\\/][^"'`\r\n]+)["'`]/gu;
  const bare = /\b[A-Za-z]:[\\/][^\s"'`<>|?*\r\n，。；;、)）]+/gu;
  for (const match of source.matchAll(quoted)) candidates.push(match[1]);
  for (const match of source.matchAll(bare)) candidates.push(match[0]);
  return uniquePaths(candidates.map((item) => item.replace(/[.,，。；;、]+$/u, '')));
}

function findMostSpecificRegisteredRoot(candidate: string, registeredRoots: readonly string[]): string | undefined {
  return registeredRoots
    .filter((root) => isSameOrChildPath(candidate, root))
    .sort((left, right) => normalizeWorkspacePath(right).length - normalizeWorkspacePath(left).length)[0];
}

function makeMount(pathValue: string, accessMode: WorkspaceAccessMode, explicit: boolean): WorkspaceMount {
  return {
    path: normalizeWorkspacePath(pathValue),
    accessMode,
    evidenceIds: [explicit ? 'current_message' : 'session_binding'],
    reason: explicit ? 'explicit absolute path matched a registered workspace root' : 'current session working directory',
    expiresAfterTurn: true,
  };
}

export function resolveTurnWorkspacePlan(input: ResolveTurnWorkspacePlanInput): TurnWorkspacePlan {
  const deniedRoots = (input.deniedRoots || [])
    .filter((item) => item.path?.trim())
    .map((item) => ({ path: normalizeWorkspacePath(item.path), reason: item.reason }));
  const isDenied = (candidate: string) => deniedRoots.some((item) => isSameOrChildPath(candidate, item.path));
  const registeredRoots = uniquePaths(input.registeredRoots || []).filter((root) => !isDenied(root));
  const explicitRoots: string[] = [];

  for (const candidate of extractAbsolutePathCandidates(input.prompt)) {
    if (isDenied(candidate)) continue;
    const matchedRoot = findMostSpecificRegisteredRoot(candidate, registeredRoots);
    if (matchedRoot) explicitRoots.push(matchedRoot);
  }

  const distinctExplicitRoots = uniquePaths(explicitRoots);
  const accessMode: WorkspaceAccessMode = input.requiresWrite ? 'read_write' : 'read_only';
  const isWithinRegisteredRoots = (candidate: string) => registeredRoots.length === 0
    || registeredRoots.some((root) => isSameOrChildPath(candidate, root));
  const primaryCandidates: Array<{ path?: string; source: TurnWorkspacePlan['resolvedFrom'] }> = [
    { path: input.currentWorkingDirectory, source: 'session_binding' },
    { path: input.defaultWorkingDirectory, source: 'default' },
    ...distinctExplicitRoots.map((root) => ({ path: root, source: 'explicit_path' as const })),
    ...registeredRoots.map((root) => ({ path: root, source: 'default' as const })),
    { path: process.cwd(), source: 'default' },
  ];
  const primary = primaryCandidates.find((candidate) => {
    if (!candidate.path?.trim()) return false;
    return !isDenied(candidate.path) && isWithinRegisteredRoots(candidate.path);
  });
  if (!primary?.path) {
    throw new Error('no safe primary workspace is available for this turn');
  }
  const primaryPath = normalizeWorkspacePath(primary.path);
  const resolvedFrom = primary.source;
  const temporaryRoots = distinctExplicitRoots.filter((root) => {
    if (compareKey(root) === compareKey(primaryPath)) return false;
    // 主工作区已经覆盖其子目录时，无需重复扩大 Provider 的挂载列表。
    return !isSameOrChildPath(root, primaryPath);
  });

  return {
    version: 'cti-turn-workspace/v1',
    primaryWorkspace: makeMount(primaryPath, accessMode, resolvedFrom === 'explicit_path'),
    temporaryMounts: temporaryRoots
      .map((root) => makeMount(root, accessMode, true)),
    deniedRoots,
    resolvedFrom,
    createdAt: input.now || new Date().toISOString(),
    expiresAfterTurn: true,
  };
}

export function getWorkspacePlanRoots(plan: TurnWorkspacePlan): string[] {
  return uniquePaths([
    plan.primaryWorkspace.path,
    ...plan.temporaryMounts.map((item) => item.path),
  ]);
}

export function formatTurnWorkspacePlanPrompt(plan: TurnWorkspacePlan): string {
  const lines = [
    'Turn workspace plan (authoritative):',
    `- Primary workspace: ${plan.primaryWorkspace.path}`,
    `- Primary access: ${plan.primaryWorkspace.accessMode}`,
    `- Resolved from: ${plan.resolvedFrom}`,
    `- Expires after this turn: ${plan.expiresAfterTurn}`,
  ];
  if (plan.temporaryMounts.length > 0) {
    lines.push('- Temporary mounts:');
    for (const mount of plan.temporaryMounts) {
      lines.push(`  - ${mount.path} (${mount.accessMode}; ${mount.reason})`);
    }
  } else {
    lines.push('- Temporary mounts: none');
  }
  lines.push('- Registered or allowed roots that are absent from this plan are not mounted.');
  return lines.join('\n');
}
