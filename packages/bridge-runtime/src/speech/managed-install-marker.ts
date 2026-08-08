import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

export const MANAGED_INSTALL_PROTOCOL = 'cti-speech-component-install/v1' as const;
export const MANAGED_INSTALL_SET_PROTOCOL = 'cti-speech-component-install/v2' as const;

export interface ManagedInstallFileMarker {
  path: string;
  sha256: string;
  size: number;
  source: string;
}

export interface ManagedInstallMarker {
  protocol: typeof MANAGED_INSTALL_PROTOCOL;
  id: string;
  version: string;
  sha256: string;
  size: number;
  source: string;
  license: string;
  platform: string;
  entryPoint: string;
  entryPointSha256: string;
  entryPointSize: number;
  installedAt: string;
}

export interface ManagedInstallSetMarker {
  protocol: typeof MANAGED_INSTALL_SET_PROTOCOL;
  id: string;
  version: string;
  source: string;
  license: string;
  platform: string;
  entryPoint: string;
  manifestSha256: string;
  totalSize: number;
  files: ManagedInstallFileMarker[];
  installedAt: string;
}

export interface ManagedInstallExpectation {
  id?: string;
  version?: string;
  sha256?: string;
  size?: number;
  source?: string;
  license?: string;
  platform?: string;
  entryPoint?: string;
  entryPointSha256?: string;
  entryPointSize?: number;
  manifestSha256?: string;
  totalSize?: number;
}

function comparable(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  return candidate === root || candidate.startsWith(root + path.sep);
}

function safeRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) return null;
  if (path.posix.isAbsolute(value) || /^[a-z]:/i.test(value)) return null;
  const normalized = path.posix.normalize(value).replace(/^\.\//, '');
  if (!normalized || normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) return null;
  return normalized;
}

function hashFileSha256Sync(filePath: string): string {
  const descriptor = fs.openSync(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

/** 校验既有路径的每一层都不是 symlink/junction，并确认 realpath 未逃逸。 */
function isExistingPathTreeSafe(candidatePath: string): boolean {
  try {
    const resolved = path.resolve(candidatePath);
    const parsed = path.parse(resolved);
    let current = parsed.root;
    for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return false;
    }
    return comparable(fs.realpathSync.native(resolved)) === comparable(resolved);
  } catch {
    return false;
  }
}

/**
 * 受管目录只有在 marker 元数据和声明入口均可信时才可被 resolver 采用。
 * 返回 null 表示 optional_missing/损坏，不把原始路径或解析异常外发。
 */
export function readManagedInstallMarker(
  targetRoot: string,
  expected: ManagedInstallExpectation = {},
): { marker: ManagedInstallMarker; entryPointPath: string } | null {
  try {
    const root = path.resolve(targetRoot);
    if (!isExistingPathTreeSafe(root)) return null;
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const markerPath = path.join(root, '.installed.json');
    if (!isExistingPathTreeSafe(markerPath)) return null;
    const markerStat = fs.lstatSync(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 16 * 1024) return null;
    const value = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Partial<ManagedInstallMarker>;
    const entryPoint = safeRelativePath(value.entryPoint);
    if (
      value.protocol !== MANAGED_INSTALL_PROTOCOL
      || typeof value.id !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(value.id)
      || typeof value.version !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.version)
      || typeof value.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/i.test(value.sha256)
      || !Number.isSafeInteger(value.size)
      || value.size! <= 0
      || typeof value.source !== 'string'
      || new URL(value.source).protocol !== 'https:'
      || typeof value.license !== 'string'
      || !value.license.trim()
      || typeof value.platform !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{1,31}$/i.test(value.platform)
      || !entryPoint
      || typeof value.entryPointSha256 !== 'string'
      || !/^[a-f0-9]{64}$/i.test(value.entryPointSha256)
      || !Number.isSafeInteger(value.entryPointSize)
      || value.entryPointSize! <= 0
      || typeof value.installedAt !== 'string'
      || !Number.isFinite(Date.parse(value.installedAt))
    ) return null;
    const marker = { ...value, entryPoint } as ManagedInstallMarker;
    for (const [field, expectedValue] of Object.entries(expected)) {
      if (expectedValue !== undefined && marker[field as keyof ManagedInstallMarker] !== expectedValue) return null;
    }
    // 目录层级本身也绑定 id/version，伪 marker 不能把另一个组件目录冒充当前组件。
    if (path.basename(root) !== marker.version || path.basename(path.dirname(root)) !== marker.id) return null;
    const entryPointPath = path.resolve(root, ...entryPoint.split('/'));
    if (!isWithinRoot(entryPointPath, root) || !isExistingPathTreeSafe(entryPointPath)) return null;
    const entryStat = fs.lstatSync(entryPointPath);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) return null;
    if (entryStat.size !== marker.entryPointSize
      || hashFileSha256Sync(entryPointPath) !== marker.entryPointSha256.toLowerCase()) return null;
    return { marker, entryPointPath };
  } catch {
    return null;
  }
}

/**
 * v2 marker 绑定整个资源集合，而不是只验证一个入口文件。
 * 这使多分片模型在任一权重或配置被替换后都立即降级为 optional_missing。
 */
export function readManagedInstallSetMarker(
  targetRoot: string,
  expected: ManagedInstallExpectation = {},
): { marker: ManagedInstallSetMarker; entryPointPath: string } | null {
  try {
    const root = path.resolve(targetRoot);
    if (!isExistingPathTreeSafe(root)) return null;
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const markerPath = path.join(root, '.installed.json');
    if (!isExistingPathTreeSafe(markerPath)) return null;
    const markerStat = fs.lstatSync(markerPath);
    // 模型文件集合允许比 v1 更大的 marker，但仍设置硬上限，避免状态探测读取任意大文件。
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 256 * 1024) return null;
    const value = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Partial<ManagedInstallSetMarker>;
    const entryPoint = safeRelativePath(value.entryPoint);
    if (
      value.protocol !== MANAGED_INSTALL_SET_PROTOCOL
      || typeof value.id !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(value.id)
      || typeof value.version !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.version)
      || typeof value.source !== 'string'
      || new URL(value.source).protocol !== 'https:'
      || typeof value.license !== 'string'
      || !value.license.trim()
      || typeof value.platform !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{1,31}$/i.test(value.platform)
      || !entryPoint
      || typeof value.manifestSha256 !== 'string'
      || !/^[a-f0-9]{64}$/i.test(value.manifestSha256)
      || !Number.isSafeInteger(value.totalSize)
      || value.totalSize! <= 0
      || !Array.isArray(value.files)
      || value.files.length === 0
      || value.files.length > 4096
      || typeof value.installedAt !== 'string'
      || !Number.isFinite(Date.parse(value.installedAt))
    ) return null;
    const seen = new Set<string>();
    let totalSize = 0;
    const files: ManagedInstallFileMarker[] = [];
    for (const raw of value.files) {
      const relative = safeRelativePath(raw?.path);
      if (
        !relative
        || seen.has(relative)
        || typeof raw.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/i.test(raw.sha256)
        || !Number.isSafeInteger(raw.size)
        || raw.size <= 0
        || typeof raw.source !== 'string'
        || new URL(raw.source).protocol !== 'https:'
      ) return null;
      seen.add(relative);
      totalSize += raw.size;
      if (!Number.isSafeInteger(totalSize)) return null;
      files.push({ path: relative, sha256: raw.sha256.toLowerCase(), size: raw.size, source: raw.source });
    }
    if (totalSize !== value.totalSize || !seen.has(entryPoint)) return null;
    const marker: ManagedInstallSetMarker = { ...value, entryPoint, files } as ManagedInstallSetMarker;
    for (const [field, expectedValue] of Object.entries(expected)) {
      if (expectedValue !== undefined && marker[field as keyof ManagedInstallSetMarker] !== expectedValue) return null;
    }
    if (path.basename(root) !== marker.version || path.basename(path.dirname(root)) !== marker.id) return null;
    for (const file of files) {
      const filePath = path.resolve(root, ...file.path.split('/'));
      if (!isWithinRoot(filePath, root) || !isExistingPathTreeSafe(filePath)) return null;
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) return null;
      if (hashFileSha256Sync(filePath) !== file.sha256) return null;
    }
    return { marker, entryPointPath: path.resolve(root, ...entryPoint.split('/')) };
  } catch {
    return null;
  }
}

/** 解析器只关心组件目录是否完整可信；具体 v1/v2 差异由 marker 模块吸收。 */
export function readAnyManagedInstallMarker(
  targetRoot: string,
  expected: ManagedInstallExpectation = {},
): { entryPointPath: string } | null {
  return readManagedInstallMarker(targetRoot, expected) || readManagedInstallSetMarker(targetRoot, expected);
}
