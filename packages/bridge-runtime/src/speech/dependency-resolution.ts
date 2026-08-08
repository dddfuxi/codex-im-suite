import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import { readAnyManagedInstallMarker } from './managed-install-marker.js';

export type ResolvedDependencyState = 'ready' | 'optional_missing' | 'blocked';

export interface ResolvedDependencyPath {
  id: string;
  displayName: string;
  state: ResolvedDependencyState;
  source?: 'explicit' | 'managed' | 'path' | 'bundled';
  path?: string;
  diagnosticCode?: string;
}

function inspectFile(candidate: string): 'ready' | 'missing' | 'unsafe' {
  try {
    const comparable = (value: string) => process.platform === 'win32'
      ? path.normalize(value).toLowerCase()
      : path.normalize(value);
    if (comparable(fs.realpathSync.native(candidate)) !== comparable(path.resolve(candidate))) return 'unsafe';
    const stat = fs.lstatSync(candidate);
    return !stat.isSymbolicLink() && stat.isFile() ? 'ready' : 'unsafe';
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT'
      ? 'missing'
      : 'unsafe';
  }
}

function executableNames(baseName: string): string[] {
  if (process.platform !== 'win32') return [baseName];
  const suffixes = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return [baseName, ...suffixes.map((suffix) => `${baseName}${suffix}`)];
}

function managedVersionRoots(root: string, id: string): string[] {
  const roots: string[] = [];
  for (const componentRoot of [path.join(root, 'speech', id), path.join(root, id)]) {
    try {
      const componentStat = fs.lstatSync(componentRoot);
      if (componentStat.isSymbolicLink() || !componentStat.isDirectory()) continue;
      for (const entry of fs.readdirSync(componentRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-z0-9._-]+$/i.test(entry.name)) continue;
        const versionRoot = path.join(componentRoot, entry.name);
        if (readAnyManagedInstallMarker(versionRoot, {
          id,
          version: entry.name,
          platform: `${process.platform}-${process.arch}`,
        })) roots.push(versionRoot);
      }
    } catch {
      // 未安装是正常的 optional_missing。
    }
  }
  return roots;
}

function managedExecutableCandidates(root: string, componentIds: string[], names: string[]): string[] {
  return componentIds.flatMap((id) => managedVersionRoots(root, id).flatMap((base) => names.flatMap((name) => [
    path.join(base, 'bin', name),
    path.join(base, name),
  ])));
}

export function resolveExecutableDependency(input: {
  id: string;
  displayName: string;
  executableName?: string;
  explicitPath?: string;
  runtimeDepsRoot: string;
  /** 允许一个受管运行包同时提供多个固定可执行文件，调用方不复制查找逻辑。 */
  componentIds?: string[];
}): ResolvedDependencyPath {
  const explicit = input.explicitPath?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      return { id: input.id, displayName: input.displayName, state: 'blocked', source: 'explicit', diagnosticCode: 'explicit_path_not_absolute' };
    }
    const candidate = path.resolve(explicit);
    const inspected = inspectFile(candidate);
    return inspected === 'ready'
      ? { id: input.id, displayName: input.displayName, state: 'ready', source: 'explicit', path: candidate }
      : { id: input.id, displayName: input.displayName, state: 'blocked', source: 'explicit', diagnosticCode: inspected === 'missing' ? 'explicit_path_missing' : 'explicit_path_unsafe' };
  }

  const names = executableNames(input.executableName || input.id);
  const componentIds = input.componentIds?.length ? input.componentIds : [input.id];
  for (const candidate of managedExecutableCandidates(input.runtimeDepsRoot, componentIds, names)) {
    if (inspectFile(candidate) === 'ready') {
      return { id: input.id, displayName: input.displayName, state: 'ready', source: 'managed', path: path.resolve(candidate) };
    }
  }
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (inspectFile(candidate) === 'ready') {
        return { id: input.id, displayName: input.displayName, state: 'ready', source: 'path', path: path.resolve(candidate) };
      }
    }
  }
  return { id: input.id, displayName: input.displayName, state: 'optional_missing', diagnosticCode: 'executable_not_found' };
}

export function resolveSidecarDependency(input: {
  explicitPath?: string;
  runtimeDepsRoot: string;
  bundledCandidates: string[];
}): ResolvedDependencyPath {
  const explicit = input.explicitPath?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      return { id: 'sidecar', displayName: '语音 Sidecar', state: 'blocked', source: 'explicit', diagnosticCode: 'explicit_path_not_absolute' };
    }
    const candidate = path.resolve(explicit);
    const inspected = inspectFile(candidate);
    return inspected === 'ready'
      ? { id: 'sidecar', displayName: '语音 Sidecar', state: 'ready', source: 'explicit', path: candidate }
      : { id: 'sidecar', displayName: '语音 Sidecar', state: 'blocked', source: 'explicit', diagnosticCode: inspected === 'missing' ? 'explicit_path_missing' : 'explicit_path_unsafe' };
  }
  for (const root of managedVersionRoots(input.runtimeDepsRoot, 'sidecar')) {
    const managed = path.join(root, 'server.py');
    if (inspectFile(managed) === 'ready') {
      return { id: 'sidecar', displayName: '语音 Sidecar', state: 'ready', source: 'managed', path: path.resolve(managed) };
    }
  }
  for (const candidate of input.bundledCandidates) {
    if (inspectFile(candidate) === 'ready') {
      return { id: 'sidecar', displayName: '语音 Sidecar', state: 'ready', source: 'bundled', path: path.resolve(candidate) };
    }
  }
  return { id: 'sidecar', displayName: '语音 Sidecar', state: 'optional_missing', diagnosticCode: 'sidecar_not_found' };
}

export function assertRegularNonSymlink(filePath: string): fs.Stats {
  if (!path.isAbsolute(filePath)) throw new Error('path_not_absolute');
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('path_unsafe');
  return stat;
}

export function ensureNonSymlinkDirectory(directoryPath: string): void {
  if (!path.isAbsolute(directoryPath)) throw new Error('directory_not_absolute');
  const resolved = path.resolve(directoryPath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('directory_unsafe');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: string }).code
        : undefined;
      if (code !== 'ENOENT') throw error;
      // 逐段创建，先验证父目录不是 junction/symlink，避免 recursive mkdir 穿透到边界外。
      fs.mkdirSync(current);
      const created = fs.lstatSync(current);
      if (created.isSymbolicLink() || !created.isDirectory()) throw new Error('directory_unsafe');
    }
  }
  const real = fs.realpathSync.native(resolved);
  const comparable = (value: string) => process.platform === 'win32'
    ? path.normalize(value).toLowerCase()
    : path.normalize(value);
  if (comparable(real) !== comparable(resolved)) throw new Error('directory_unsafe');
}

export function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  return candidate === root || candidate.startsWith(root + path.sep);
}

function comparablePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * 只清理受管根目录的直接子目录。先将已复验对象原子改名到随机隔离名，
 * 再核对目录身份后递归删除；目标在复验与删除间被替换时会保留并失败关闭。
 */
export function removeManagedTempDirectorySafely(input: {
  targetPath: string;
  managedRoot: string;
  requiredNamePrefix: string;
}): void {
  const root = path.resolve(input.managedRoot);
  const target = path.resolve(input.targetPath);
  if (!input.requiredNamePrefix || path.dirname(target) !== root || !path.basename(target).startsWith(input.requiredNamePrefix)) {
    throw new Error('managed_cleanup_target_invalid');
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || comparablePath(fs.realpathSync.native(root)) !== comparablePath(root)) {
    throw new Error('managed_cleanup_root_unsafe');
  }
  const targetStat = fs.lstatSync(target);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()
    || comparablePath(fs.realpathSync.native(target)) !== comparablePath(target)
    || !isWithinRoot(target, root)) {
    throw new Error('managed_cleanup_target_unsafe');
  }

  const quarantine = path.join(root, `.delete-${crypto.randomUUID()}`);
  fs.renameSync(target, quarantine);
  const quarantineStat = fs.lstatSync(quarantine);
  const sameIdentity = targetStat.dev === quarantineStat.dev && targetStat.ino === quarantineStat.ino;
  if (!sameIdentity
    || !quarantineStat.isDirectory()
    || quarantineStat.isSymbolicLink()
    || comparablePath(fs.realpathSync.native(quarantine)) !== comparablePath(path.resolve(quarantine))
    || !isWithinRoot(quarantine, root)) {
    throw new Error('managed_cleanup_identity_changed');
  }
  fs.rmSync(quarantine, { recursive: true, force: false });
}
