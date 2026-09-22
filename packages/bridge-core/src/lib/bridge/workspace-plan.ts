import {
  findRegisteredProjectForPath,
  importLegacyWorkspaceRoots,
  isSameOrChildProjectPath,
  normalizeProjectPath,
  type RegisteredProject,
  type RegisteredProjectAccessMode,
} from '@codex-im-suite/contracts';

export type WorkspaceAccessMode = RegisteredProjectAccessMode;

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
  registeredProjects?: readonly RegisteredProject[];
  deniedRoots?: readonly DeniedWorkspaceRoot[];
  requiresWrite?: boolean;
  now?: string;
}

function normalizeWorkspacePath(value: string): string {
  return normalizeProjectPath(value);
}

function compareKey(value: string): string {
  const normalized = normalizeWorkspacePath(value);
  return /^[A-Za-z]:\\/u.test(normalized) ? normalized.toLowerCase() : normalized;
}

function isSameOrChildPath(candidate: string, root: string): boolean {
  return isSameOrChildProjectPath(candidate, root);
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

function makeMount(input: {
  path: string;
  project?: RegisteredProject;
  requiresWrite: boolean;
  explicit: boolean;
}): WorkspaceMount {
  const allowedAccessMode = input.project?.accessMode || 'read_write';
  if (input.requiresWrite && allowedAccessMode === 'read_only') throw new Error('project_read_only');
  const accessMode: WorkspaceAccessMode = input.requiresWrite ? 'read_write' : 'read_only';
  return {
    ...(input.project ? { projectId: input.project.id } : {}),
    path: normalizeWorkspacePath(input.path),
    accessMode,
    evidenceIds: [input.explicit ? 'current_message' : 'session_binding'],
    reason: input.explicit ? 'explicit absolute path matched a registered project' : 'current session working directory',
    expiresAfterTurn: true,
  };
}

function mergeRegisteredProjects(input: ResolveTurnWorkspacePlanInput, deniedPaths: readonly string[]): RegisteredProject[] {
  const structured = (input.registeredProjects || []).filter((project) => (
    project.enabled && !deniedPaths.some((denied) => isSameOrChildPath(project.workspaceRoot, denied))
  ));
  const legacy = importLegacyWorkspaceRoots(input.registeredRoots || [], { deniedRoots: deniedPaths });
  const compatibleLegacy = legacy.filter((legacyProject) => !structured.some((project) => (
    isSameOrChildPath(legacyProject.workspaceRoot, project.workspaceRoot)
    || isSameOrChildPath(project.workspaceRoot, legacyProject.workspaceRoot)
  )));
  return [...structured, ...compatibleLegacy];
}

export function resolveTurnWorkspacePlan(input: ResolveTurnWorkspacePlanInput): TurnWorkspacePlan {
  const deniedRoots = (input.deniedRoots || [])
    .filter((item) => item.path?.trim())
    .map((item) => ({ path: normalizeWorkspacePath(item.path), reason: item.reason }));
  const isDenied = (candidate: string) => deniedRoots.some((item) => isSameOrChildPath(candidate, item.path));
  const projects = mergeRegisteredProjects(input, deniedRoots.map((item) => item.path));
  const explicitProjects: RegisteredProject[] = [];

  for (const candidate of extractAbsolutePathCandidates(input.prompt)) {
    if (isDenied(candidate)) continue;
    const matchedProject = findRegisteredProjectForPath(projects, candidate);
    if (matchedProject) explicitProjects.push(matchedProject);
  }

  const distinctExplicitProjects = Array.from(new Map(explicitProjects.map((project) => [project.id, project])).values());
  const resolveCandidateProject = (candidate?: string) => candidate?.trim()
    ? findRegisteredProjectForPath(projects, candidate)
    : undefined;
  const primaryCandidates: Array<{
    path?: string;
    project?: RegisteredProject;
    source: TurnWorkspacePlan['resolvedFrom'];
  }> = [
    {
      path: resolveCandidateProject(input.currentWorkingDirectory)?.workspaceRoot || input.currentWorkingDirectory,
      project: resolveCandidateProject(input.currentWorkingDirectory),
      source: 'session_binding',
    },
    {
      path: resolveCandidateProject(input.defaultWorkingDirectory)?.workspaceRoot || input.defaultWorkingDirectory,
      project: resolveCandidateProject(input.defaultWorkingDirectory),
      source: 'default',
    },
    ...distinctExplicitProjects.map((project) => ({ path: project.workspaceRoot, project, source: 'explicit_path' as const })),
    ...projects.map((project) => ({ path: project.workspaceRoot, project, source: 'default' as const })),
    { path: projects.length === 0 ? process.cwd() : undefined, source: 'default' },
  ];
  const primary = primaryCandidates.find((candidate) => {
    if (!candidate.path?.trim()) return false;
    if (isDenied(candidate.path)) return false;
    return projects.length === 0 || Boolean(candidate.project);
  });
  if (!primary?.path) {
    throw new Error('no safe primary workspace is available for this turn');
  }
  const primaryPath = normalizeWorkspacePath(primary.path);
  const resolvedFrom = primary.source;
  const temporaryProjects = distinctExplicitProjects.filter((project) => {
    if (compareKey(project.workspaceRoot) === compareKey(primaryPath)) return false;
    // 主工作区已经覆盖其子目录时，无需重复扩大 Provider 的挂载列表。
    return !isSameOrChildPath(project.workspaceRoot, primaryPath);
  });

  return {
    version: 'cti-turn-workspace/v1',
    primaryWorkspace: makeMount({
      path: primaryPath,
      project: primary.project,
      requiresWrite: input.requiresWrite === true,
      explicit: resolvedFrom === 'explicit_path',
    }),
    temporaryMounts: temporaryProjects.map((project) => makeMount({
      path: project.workspaceRoot,
      project,
      requiresWrite: input.requiresWrite === true,
      explicit: true,
    })),
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
