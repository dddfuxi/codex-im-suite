import crypto from 'node:crypto';
import path from 'node:path';

export type RegisteredProjectType = 'unity' | 'node' | 'dotnet' | 'generic';
export type RegisteredProjectAccessMode = 'read_only' | 'read_write';

export interface RegisteredProject {
  id: string;
  displayName: string;
  type: RegisteredProjectType;
  workspaceRoot: string;
  accessMode: RegisteredProjectAccessMode;
  unityProjectRoot?: string;
  mcpProfileIds?: string[];
  enabled: boolean;
}

export interface ProjectRegistryDocumentV1 {
  schema: 'codex-im-suite/project-registry/v1';
  projects: RegisteredProject[];
}

export interface ProjectRegistrySnapshotContract {
  schema: 'codex-im-suite/project-registry-snapshot/v1';
  generatedAt: string;
  registryPath: string;
  exists: boolean;
  projects: RegisteredProject[];
  error: string;
}

export interface ParseProjectRegistryOptions {
  deniedRoots?: readonly string[];
}

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MCP_PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/u;

function isWindowsPath(value: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(value);
}

export function isAbsoluteProjectPath(value: string): boolean {
  return isWindowsPath(value) || path.posix.isAbsolute(value);
}

export function normalizeProjectPath(value: string): string {
  const trimmed = value.trim();
  if (!isAbsoluteProjectPath(trimmed)) throw new Error('project_root_must_be_absolute');
  if (isWindowsPath(trimmed)) {
    const normalized = path.win32.normalize(trimmed.replace(/\//gu, '\\'));
    return /^[A-Za-z]:\\$/u.test(normalized) ? normalized : normalized.replace(/[\\]+$/u, '');
  }
  const normalized = path.posix.normalize(trimmed);
  return normalized === '/' ? normalized : normalized.replace(/\/+$/u, '');
}

function comparePathKey(value: string): string {
  const normalized = normalizeProjectPath(value);
  return isWindowsPath(normalized) ? normalized.toLowerCase() : normalized;
}

export function isSameOrChildProjectPath(candidate: string, root: string): boolean {
  const candidateNormalized = normalizeProjectPath(candidate);
  const rootNormalized = normalizeProjectPath(root);
  const candidateKey = comparePathKey(candidateNormalized);
  const rootKey = comparePathKey(rootNormalized);
  const separator = isWindowsPath(rootNormalized) ? '\\' : '/';
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${separator}`);
}

function requireRecord(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, error: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(error);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(error);
  return normalized;
}

function parseProject(value: unknown, deniedRoots: readonly string[]): RegisteredProject {
  const record = requireRecord(value, 'invalid_project_record');
  const id = requireString(record.id, 'invalid_project_id', 64);
  if (!PROJECT_ID_RE.test(id)) throw new Error('invalid_project_id');
  const displayName = requireString(record.displayName, 'invalid_project_display_name', 160);
  if (!['unity', 'node', 'dotnet', 'generic'].includes(String(record.type))) throw new Error('invalid_project_type');
  const type = record.type as RegisteredProjectType;
  if (!['read_only', 'read_write'].includes(String(record.accessMode))) throw new Error('invalid_project_access_mode');
  const accessMode = record.accessMode as RegisteredProjectAccessMode;
  if (typeof record.enabled !== 'boolean') throw new Error('invalid_project_enabled');
  const workspaceRoot = normalizeProjectPath(requireString(record.workspaceRoot, 'invalid_workspace_root', 1024));
  if (deniedRoots.some((root) => isSameOrChildProjectPath(workspaceRoot, root))) throw new Error('project_root_denied');

  let unityProjectRoot: string | undefined;
  if (type === 'unity') {
    unityProjectRoot = normalizeProjectPath(requireString(record.unityProjectRoot, 'unity_project_root_required', 1024));
    if (!isSameOrChildProjectPath(unityProjectRoot, workspaceRoot)) throw new Error('unity_project_root_outside_workspace');
    if (deniedRoots.some((root) => isSameOrChildProjectPath(unityProjectRoot!, root))) throw new Error('project_root_denied');
  } else if (record.unityProjectRoot !== undefined) {
    throw new Error('unity_project_root_not_allowed');
  }

  let mcpProfileIds: string[] | undefined;
  if (record.mcpProfileIds !== undefined) {
    if (!Array.isArray(record.mcpProfileIds)) throw new Error('invalid_mcp_profile_ids');
    const seen = new Set<string>();
    mcpProfileIds = record.mcpProfileIds.flatMap((item) => {
      if (typeof item !== 'string' || !item.trim()) return [];
      const normalized = item.trim();
      if (!MCP_PROFILE_ID_RE.test(normalized)) throw new Error('invalid_mcp_profile_id');
      if (seen.has(normalized)) return [];
      seen.add(normalized);
      return [normalized];
    });
    if (mcpProfileIds.length === 0) mcpProfileIds = undefined;
  }

  return {
    id,
    displayName,
    type,
    workspaceRoot,
    accessMode,
    ...(unityProjectRoot ? { unityProjectRoot } : {}),
    ...(mcpProfileIds ? { mcpProfileIds } : {}),
    enabled: record.enabled,
  };
}

export function parseProjectRegistryDocument(
  value: unknown,
  options: ParseProjectRegistryOptions = {},
): RegisteredProject[] {
  const document = requireRecord(value, 'invalid_project_registry');
  if (document.schema !== 'codex-im-suite/project-registry/v1') throw new Error('invalid_project_registry_schema');
  if (!Array.isArray(document.projects)) throw new Error('invalid_project_registry_projects');
  if (document.projects.length > 500) throw new Error('project_registry_too_large');
  const deniedRoots = (options.deniedRoots || []).map(normalizeProjectPath);
  const projects = document.projects.map((item) => parseProject(item, deniedRoots));
  const ids = new Set<string>();
  const roots = new Set<string>();
  for (const project of projects) {
    if (ids.has(project.id)) throw new Error('duplicate_project_id');
    ids.add(project.id);
    const rootKey = comparePathKey(project.workspaceRoot);
    if (roots.has(rootKey)) throw new Error('duplicate_workspace_root');
    roots.add(rootKey);
  }
  return projects;
}

export function importLegacyWorkspaceRoots(
  roots: readonly string[],
  options: ParseProjectRegistryOptions = {},
): RegisteredProject[] {
  const deniedRoots = (options.deniedRoots || []).map(normalizeProjectPath);
  const seen = new Set<string>();
  const projects: RegisteredProject[] = [];
  for (const root of roots) {
    if (!root?.trim()) continue;
    const workspaceRoot = normalizeProjectPath(root);
    if (deniedRoots.some((denied) => isSameOrChildProjectPath(workspaceRoot, denied))) continue;
    const key = comparePathKey(workspaceRoot);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = isWindowsPath(workspaceRoot)
      ? path.win32.basename(workspaceRoot)
      : path.posix.basename(workspaceRoot);
    projects.push({
      id: `legacy-${crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12)}`,
      displayName: name || workspaceRoot,
      type: 'generic',
      workspaceRoot,
      accessMode: 'read_write',
      enabled: true,
    });
  }
  return projects;
}

export function findRegisteredProjectForPath(
  projects: readonly RegisteredProject[],
  candidatePath: string,
): RegisteredProject | undefined {
  const candidate = normalizeProjectPath(candidatePath);
  return projects
    .filter((project) => project.enabled)
    .flatMap((project) => {
      const matchingRoots = [project.workspaceRoot, project.unityProjectRoot]
        .filter((root): root is string => Boolean(root))
        .filter((root) => isSameOrChildProjectPath(candidate, root));
      if (matchingRoots.length === 0) return [];
      return [{
        project,
        specificity: Math.max(...matchingRoots.map((root) => normalizeProjectPath(root).length)),
      }];
    })
    .sort((left, right) => right.specificity - left.specificity)[0]?.project;
}
