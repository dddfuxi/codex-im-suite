import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface WorkspaceIdentity {
  id: string;
  label: string;
  normalizedPath: string;
  legacyIds: string[];
}

function safeWorkspaceLabel(label: string): string {
  return label
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
    .toLowerCase() || 'workspace';
}

function workspaceId(label: string, seed: string): string {
  const digest = crypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 10);
  return `${safeWorkspaceLabel(label)}-${digest}`;
}

function findGitRoot(startPath: string): string | null {
  if (!fs.existsSync(startPath)) return null;
  let cursor = fs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath);
  while (true) {
    if (fs.existsSync(path.join(cursor, '.git'))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function resolveGitConfigPath(gitRoot: string): string | null {
  const dotGit = path.join(gitRoot, '.git');
  if (fs.statSync(dotGit).isDirectory()) return path.join(dotGit, 'config');
  try {
    const pointer = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/imu)?.[1]?.trim();
    return pointer ? path.join(path.resolve(gitRoot, pointer), 'config') : null;
  } catch {
    return null;
  }
}

function readGitRemoteIdentity(gitRoot: string): { seed: string; label: string } | null {
  const configPath = resolveGitConfigPath(gitRoot);
  if (!configPath || !fs.existsSync(configPath)) return null;
  try {
    const config = fs.readFileSync(configPath, 'utf8');
    const originSection = config.match(/\[remote\s+"origin"\]([\s\S]*?)(?=\n\[|$)/iu)?.[1] || '';
    const rawUrl = originSection.match(/^\s*url\s*=\s*(.+)$/imu)?.[1]?.trim();
    if (!rawUrl) return null;
    const normalized = rawUrl
      .replace(/^[^@\s]+@([^:]+):/u, '$1/')
      .replace(/[?#].*$/u, '')
      .replace(/\/+$/u, '')
      .replace(/\.git$/iu, '')
      .toLowerCase();
    const label = normalized.split(/[\\/]/u).filter(Boolean).at(-1) || path.basename(gitRoot);
    return { seed: `git-remote:${normalized}`, label };
  } catch {
    return null;
  }
}

/**
 * 统一工作区身份口径：显示名保留原路径大小写，持久化 ID 对 Windows
 * 路径大小写和末尾分隔符不敏感，读写两端必须复用本函数。
 */
export function resolveWorkspaceIdentity(workingDirectory?: string): WorkspaceIdentity {
  const requestedPath = workingDirectory ? path.resolve(workingDirectory) : 'unknown-workspace';
  const gitRoot = workingDirectory ? findGitRoot(requestedPath) : null;
  const normalizedPath = gitRoot || requestedPath;
  const gitIdentity = gitRoot ? readGitRemoteIdentity(gitRoot) : null;
  const label = gitIdentity?.label || (workingDirectory ? path.basename(normalizedPath) || 'workspace' : '未绑定工作区');
  const identitySeed = gitIdentity?.seed || normalizedPath.toLowerCase();
  const id = workspaceId(label, identitySeed);
  const legacyLabel = workingDirectory ? path.basename(normalizedPath) || 'workspace' : '未绑定工作区';
  const legacyId = workspaceId(legacyLabel, normalizedPath.toLowerCase());
  return { id, label, normalizedPath, legacyIds: legacyId === id ? [] : [legacyId] };
}
