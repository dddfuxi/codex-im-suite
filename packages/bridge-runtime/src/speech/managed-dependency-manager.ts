import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';

import { ensureNonSymlinkDirectory, isWithinRoot, removeManagedTempDirectorySafely } from './dependency-resolution.js';
import {
  MANAGED_INSTALL_PROTOCOL,
  MANAGED_INSTALL_SET_PROTOCOL,
  readManagedInstallMarker,
  readManagedInstallSetMarker,
} from './managed-install-marker.js';
import { runNoShell } from './subprocess.js';
import type { ManagedSpeechComponentStatus } from './speech-status.js';

interface ManagedDownloadAsset {
  source: string;
  sha256: string;
  size: number;
  archive: 'zip';
  entryPoint: string;
}

/**
 * 固定 Python、固定安装器与全哈希 requirements 的声明式运行环境。
 * Manifest 只能提供数据；argv、探针与目录边界均由 Runtime 固定，
 * 因而不会成为可携带任意命令的包管理旁路。
 */
interface ManagedPythonTargetInstallerV1 {
  kind: 'python_target/v1';
  python: ManagedDownloadAsset & { pthFile: string; stdlibZip: string };
  tool: ManagedDownloadAsset;
  requirements: { path: string; sha256: string; size: number };
  sitePackages: string;
  pythonVersion: string;
  probeModules: string[];
  requireCuda: boolean;
  cudaVersion?: string;
  requiredDiskBytes: number;
}

interface ManagedSourceArchive {
  source: string;
  sha256: string;
  size: number;
  archive: 'zip';
  maxExtractedBytes: number;
}

interface ManagedSourceTreeMapping {
  source: string;
  target: string;
}

interface ManagedPythonTargetInstallerV2 extends Omit<ManagedPythonTargetInstallerV1, 'kind'> {
  kind: 'python_target/v2';
  source: ManagedSourceArchive;
  packageTrees: ManagedSourceTreeMapping[];
}

type ManagedPythonTargetInstaller = ManagedPythonTargetInstallerV1 | ManagedPythonTargetInstallerV2;

interface ManagedDependencyRecord {
  id: string;
  displayName: string;
  kind: string;
  capabilities: string[];
  source: string;
  version: string | null;
  sha256: string | null;
  size: number | null;
  license: string;
  archive: 'file' | 'zip';
  fileName: string | null;
  availability: 'ready' | 'blocked';
  platforms?: string[];
  diagnosticCode?: string;
  entryPoint?: string;
  files?: ManagedDependencyFileRecord[];
  installer?: ManagedPythonTargetInstaller;
}
interface ManagedDependencyFileRecord {
  source: string;
  sha256: string;
  size: number;
  path: string;
}
interface ManagedDependencyManifest {
  protocol: 'cti-speech-managed-dependencies/v1' | 'cti-speech-managed-dependencies/v2';
  components: ManagedDependencyRecord[];
}

function readManifest(filePath: string): ManagedDependencyManifest {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('dependency_manifest_unsafe');
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ManagedDependencyManifest>;
  if ((parsed.protocol !== 'cti-speech-managed-dependencies/v1' && parsed.protocol !== 'cti-speech-managed-dependencies/v2') || !Array.isArray(parsed.components)) throw new Error('dependency_manifest_invalid');
  const seen = new Set<string>();
  const components = parsed.components.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('dependency_manifest_invalid');
    const item = raw as ManagedDependencyRecord;
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(item.id) || seen.has(item.id)) throw new Error('dependency_manifest_id_invalid');
    seen.add(item.id);
    if (!item.displayName?.trim() || !item.kind?.trim() || !Array.isArray(item.capabilities) || !item.license?.trim()) throw new Error('dependency_manifest_metadata_invalid');
    if (item.version && !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(item.version)) throw new Error('dependency_manifest_version_invalid');
    if (item.platforms !== undefined) {
      if (!Array.isArray(item.platforms) || item.platforms.length === 0 || new Set(item.platforms).size !== item.platforms.length
        || item.platforms.some((platform) => !/^[a-z0-9][a-z0-9._-]{1,31}$/i.test(platform))) {
        throw new Error('dependency_manifest_platforms_invalid');
      }
    }
    const url = new URL(item.source);
    if (url.protocol !== 'https:') throw new Error('dependency_manifest_source_insecure');
    if (item.availability !== 'ready' && item.availability !== 'blocked') throw new Error('dependency_manifest_availability_invalid');
    if (item.installer !== undefined) {
      if (parsed.protocol !== 'cti-speech-managed-dependencies/v2' || item.files !== undefined) {
        throw new Error('dependency_manifest_installer_invalid');
      }
      item.installer = validatePythonTargetInstaller(item.installer);
      if (item.sha256?.toLowerCase() !== pythonInstallerIdentity(item.installer)) {
        throw new Error('dependency_manifest_installer_identity_invalid');
      }
      const installerSourceBytes = item.installer.kind === 'python_target/v2' ? item.installer.source.size : 0;
      if (item.fileName !== item.installer.python.entryPoint
        || item.size !== item.installer.python.size + item.installer.tool.size + item.installer.requirements.size + installerSourceBytes) {
        throw new Error('dependency_manifest_installer_metadata_invalid');
      }
    }
    if (item.files !== undefined) {
      if (parsed.protocol !== 'cti-speech-managed-dependencies/v2' || !Array.isArray(item.files) || item.files.length === 0 || item.files.length > 4096) {
        throw new Error('dependency_manifest_files_invalid');
      }
      const filePaths = new Set<string>();
      let totalSize = 0;
      item.files = item.files.map((file) => {
        if (!file || typeof file !== 'object') throw new Error('dependency_manifest_files_invalid');
        const targetPath = assertSafeRelativePath(file.path);
        if (filePaths.has(targetPath)) throw new Error('dependency_manifest_file_duplicate');
        filePaths.add(targetPath);
        if (new URL(file.source).protocol !== 'https:' || !/^[a-f0-9]{64}$/i.test(file.sha256 || '')
          || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('dependency_manifest_file_invalid');
        totalSize += file.size;
        if (!Number.isSafeInteger(totalSize)) throw new Error('dependency_manifest_total_size_invalid');
        return { source: file.source, sha256: file.sha256.toLowerCase(), size: file.size, path: targetPath };
      });
      if (!item.entryPoint?.trim() || !filePaths.has(assertSafeRelativePath(item.entryPoint))) throw new Error('dependency_manifest_entry_point_invalid');
    }
    if (item.availability === 'ready') {
      const collectionReady = parsed.protocol === 'cti-speech-managed-dependencies/v2' && item.files?.length;
      const legacyReady = /^[a-f0-9]{64}$/i.test(item.sha256 || '') && item.fileName?.trim()
        && Number.isSafeInteger(item.size) && Number(item.size) > 0;
      if (!item.version?.trim() || (!collectionReady && !legacyReady)) throw new Error('dependency_manifest_install_metadata_invalid');
      if (legacyReady) assertSafeRelativePath(item.fileName!);
    }
    return { ...item, capabilities: [...item.capabilities], ...(item.platforms ? { platforms: [...item.platforms] } : {}) };
  });
  return { protocol: parsed.protocol, components } as ManagedDependencyManifest;
}

export function assertSafeRelativePath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value) || /^[a-z]:/i.test(value)) throw new Error('archive_path_unsafe');
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) throw new Error('archive_path_unsafe');
  return normalized.replace(/^\.\//, '');
}

export const assertSafeZipEntryName = assertSafeRelativePath;

async function extractZipSafely(zipPath: string, destination: string, maxBytes: number): Promise<void> {
  const root = path.resolve(destination);
  ensureNonSymlinkDirectory(root);
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, value) => {
      if (error || !value) reject(error || new Error('zip_open_failed'));
      else resolve(value);
    });
  });
  let totalBytes = 0;
  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => {
      try { zip.close(); } catch { /* no-op */ }
      reject(error);
    };
    zip.once('error', fail);
    zip.once('end', resolve);
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        try {
          const relative = assertSafeZipEntryName(entry.fileName);
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if ((mode & 0o170000) === 0o120000) throw new Error('zip_symlink_rejected');
          totalBytes += entry.uncompressedSize;
          if (totalBytes > maxBytes) throw new Error('archive_too_large');
          const outputPath = path.resolve(root, ...relative.split('/'));
          if (!isWithinRoot(outputPath, root)) throw new Error('zip_slip_rejected');
          if (entry.fileName.endsWith('/')) {
            ensureNonSymlinkDirectory(outputPath);
            zip.readEntry();
            return;
          }
          ensureNonSymlinkDirectory(path.dirname(outputPath));
          const readStream = await new Promise<Readable>((streamResolve, streamReject) => {
            zip.openReadStream(entry, (error, stream) => error || !stream ? streamReject(error || new Error('zip_stream_failed')) : streamResolve(stream));
          });
          await new Promise<void>((streamResolve, streamReject) => {
            const output = fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
            readStream.once('error', streamReject);
            output.once('error', streamReject);
            output.once('finish', streamResolve);
            readStream.pipe(output);
          });
          zip.readEntry();
        } catch (error) {
          fail(error);
        }
      })();
    });
    zip.readEntry();
  });
}

async function fetchHttps(input: { url: string; targetPath: string; expectedSha256: string; expectedBytes: number; maxBytes: number; signal?: AbortSignal }): Promise<void> {
  if (input.expectedBytes > input.maxBytes) throw new Error('download_too_large');
  let current = new URL(input.url);
  let response: Response | undefined;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    if (current.protocol !== 'https:') throw new Error('download_source_insecure');
    response = await fetch(current, { redirect: 'manual', signal: input.signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('download_redirect_invalid');
      current = new URL(location, current);
      continue;
    }
    break;
  }
  if (!response?.ok || !response.body) throw new Error('download_failed');
  const declaredLengthHeader = response.headers.get('content-length');
  const declaredLength = declaredLengthHeader === null ? Number.NaN : Number(declaredLengthHeader);
  if (Number.isFinite(declaredLength) && declaredLength > input.maxBytes) throw new Error('download_too_large');
  if (Number.isFinite(declaredLength) && declaredLength >= 0 && declaredLength !== input.expectedBytes) throw new Error('download_size_mismatch');
  const descriptor = fs.openSync(input.targetPath, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > input.maxBytes) throw new Error('download_too_large');
      hash.update(chunk.value);
      fs.writeSync(descriptor, chunk.value);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (total !== input.expectedBytes) throw new Error('download_size_mismatch');
  if (hash.digest('hex') !== input.expectedSha256.toLowerCase()) throw new Error('download_sha256_mismatch');
}

export interface ManagedDependencyOperations {
  fetchAsset(input: Parameters<typeof fetchHttps>[0]): Promise<void>;
  extractZip(zipPath: string, destination: string, maxBytes: number): Promise<void>;
  runProcess: typeof runNoShell;
}

const defaultOperations: ManagedDependencyOperations = {
  fetchAsset: fetchHttps,
  extractZip: extractZipSafely,
  runProcess: runNoShell,
};

function validateDownloadAsset(raw: ManagedDownloadAsset): ManagedDownloadAsset {
  if (!raw || typeof raw !== 'object' || raw.archive !== 'zip'
    || new URL(raw.source).protocol !== 'https:'
    || !/^[a-f0-9]{64}$/i.test(raw.sha256 || '')
    || !Number.isSafeInteger(raw.size) || raw.size <= 0) {
    throw new Error('dependency_manifest_installer_asset_invalid');
  }
  return {
    source: raw.source,
    sha256: raw.sha256.toLowerCase(),
    size: raw.size,
    archive: 'zip',
    entryPoint: assertSafeRelativePath(raw.entryPoint),
  };
}

function validatePythonTargetInstaller(raw: ManagedPythonTargetInstaller): ManagedPythonTargetInstaller {
  if (!raw || typeof raw !== 'object' || (raw.kind !== 'python_target/v1' && raw.kind !== 'python_target/v2')) {
    throw new Error('dependency_manifest_installer_invalid');
  }
  const pythonAsset = validateDownloadAsset(raw.python);
  const toolAsset = validateDownloadAsset(raw.tool);
  if (!/^[a-f0-9]{64}$/i.test(raw.requirements?.sha256 || '')
    || !Number.isSafeInteger(raw.requirements?.size) || raw.requirements.size <= 0
    || !/^3\.\d{1,2}$/.test(raw.pythonVersion || '')
    || !Array.isArray(raw.probeModules) || raw.probeModules.length === 0 || raw.probeModules.length > 16
    || raw.probeModules.some((moduleName) => !/^[a-z_][a-z0-9_.]{0,127}$/i.test(moduleName))
    || typeof raw.requireCuda !== 'boolean'
    || (raw.cudaVersion !== undefined && !/^\d{1,2}\.\d{1,2}$/.test(raw.cudaVersion))
    || !Number.isSafeInteger(raw.requiredDiskBytes) || raw.requiredDiskBytes < 256 * 1024 * 1024
    || raw.requiredDiskBytes > 32 * 1024 * 1024 * 1024) {
    throw new Error('dependency_manifest_installer_invalid');
  }
  const common = {
    python: {
      ...pythonAsset,
      pthFile: assertSafeRelativePath(raw.python.pthFile),
      stdlibZip: assertSafeRelativePath(raw.python.stdlibZip),
    },
    tool: toolAsset,
    requirements: {
      path: assertSafeRelativePath(raw.requirements.path),
      sha256: raw.requirements.sha256.toLowerCase(),
      size: raw.requirements.size,
    },
    sitePackages: assertSafeRelativePath(raw.sitePackages),
    pythonVersion: raw.pythonVersion,
    probeModules: [...raw.probeModules],
    requireCuda: raw.requireCuda,
    ...(raw.cudaVersion ? { cudaVersion: raw.cudaVersion } : {}),
    requiredDiskBytes: raw.requiredDiskBytes,
  };
  if (raw.kind === 'python_target/v1') return { kind: 'python_target/v1', ...common };

  const source = raw.source;
  if (!source || typeof source !== 'object' || source.archive !== 'zip'
    || new URL(source.source).protocol !== 'https:'
    || !/^[a-f0-9]{64}$/i.test(source.sha256 || '')
    || !Number.isSafeInteger(source.size) || source.size <= 0
    || !Number.isSafeInteger(source.maxExtractedBytes) || source.maxExtractedBytes < source.size
    || source.maxExtractedBytes > 2 * 1024 * 1024 * 1024
    || !Array.isArray(raw.packageTrees) || raw.packageTrees.length === 0 || raw.packageTrees.length > 32) {
    throw new Error('dependency_manifest_installer_source_invalid');
  }
  const sourcePaths = new Set<string>();
  const targetPaths = new Set<string>();
  const packageTrees = raw.packageTrees.map((mapping) => {
    if (!mapping || typeof mapping !== 'object') throw new Error('dependency_manifest_installer_mapping_invalid');
    const sourcePath = assertSafeRelativePath(mapping.source);
    const targetPath = assertSafeRelativePath(mapping.target);
    if (sourcePaths.has(sourcePath) || targetPaths.has(targetPath)) throw new Error('dependency_manifest_installer_mapping_duplicate');
    for (const existing of targetPaths) {
      if (targetPath.startsWith(`${existing}/`) || existing.startsWith(`${targetPath}/`)) {
        throw new Error('dependency_manifest_installer_mapping_overlap');
      }
    }
    sourcePaths.add(sourcePath);
    targetPaths.add(targetPath);
    return { source: sourcePath, target: targetPath };
  });
  return {
    kind: 'python_target/v2',
    ...common,
    source: {
      source: source.source,
      sha256: source.sha256.toLowerCase(),
      size: source.size,
      archive: 'zip',
      maxExtractedBytes: source.maxExtractedBytes,
    },
    packageTrees,
  };
}

function pythonInstallerIdentity(installer: ManagedPythonTargetInstaller): string {
  return crypto.createHash('sha256').update(JSON.stringify(installer), 'utf8').digest('hex');
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

export class ManagedSpeechDependencyManager {
  private readonly manifest: ManagedDependencyManifest;
  private readonly manifestRoot: string;
  private readonly operations: ManagedDependencyOperations;
  private readonly installedStatusCache = new Map<string, { fingerprint: string; installed: boolean }>();

  constructor(
    manifestPath: string,
    private readonly runtimeDepsRoot: string,
    private readonly maxDownloadBytes = 8 * 1024 * 1024 * 1024,
    private readonly runtimePlatform = `${process.platform}-${process.arch}`,
    private readonly maxTotalDownloadBytes = 16 * 1024 * 1024 * 1024,
    operations: Partial<ManagedDependencyOperations> = {},
  ) {
    const resolvedManifestPath = path.resolve(manifestPath);
    this.manifest = readManifest(resolvedManifestPath);
    this.manifestRoot = path.dirname(resolvedManifestPath);
    this.operations = { ...defaultOperations, ...operations };
    ensureNonSymlinkDirectory(path.resolve(runtimeDepsRoot));
  }

  listStatuses(): ManagedSpeechComponentStatus[] {
    return this.manifest.components.map((item) => {
      const platformSupported = !item.platforms || item.platforms.includes(this.runtimePlatform);
      const installed = platformSupported && item.availability === 'ready' && item.version
        ? this.isInstalled(item)
        : false;
      return {
        id: item.id,
        displayName: item.displayName,
        kind: item.kind,
        state: installed ? 'ready' : !platformSupported || item.availability === 'blocked' ? 'blocked' : 'optional_missing',
        ...(item.version ? { version: item.version } : {}),
        capabilities: [...item.capabilities],
        diagnosticCode: installed
          ? undefined
          : !platformSupported ? 'component_platform_unsupported' : item.diagnosticCode || (item.availability === 'blocked' ? 'manifest_incomplete' : 'component_not_installed'),
        installable: platformSupported && item.availability === 'ready' && !installed,
      };
    });
  }

  /**
   * 只释放已通过安装 marker 复验的受管组件位置。
   * 调用方仍需按自身协议继续验证具体文件，不能把 manifest 路径当作运行授权。
   */
  resolveInstalledComponent(componentId: string): { id: string; version: string; root: string; entryPoint: string } | undefined {
    const item = this.manifest.components.find((candidate) => candidate.id === componentId);
    // 真正释放可执行/模型路径前始终重新做完整 Hash；状态页缓存不能成为启动授权。
    if (!item?.version || !this.isInstalled(item, 'full')) return undefined;
    const root = path.resolve(this.runtimeDepsRoot, 'speech', item.id, item.version);
    const entryPointRelative = assertSafeRelativePath(item.entryPoint || item.fileName || '');
    const entryPoint = this.resolveOrdinaryFile(root, entryPointRelative, 'component_entry_point_missing_or_unsafe');
    return { id: item.id, version: item.version, root, entryPoint };
  }

  private isInstalled(item: ManagedDependencyRecord, verification: 'cached' | 'full' = 'cached'): boolean {
    if (!item.version) return false;
    const targetRoot = path.join(this.runtimeDepsRoot, 'speech', item.id, item.version);
    const cacheKey = `${item.id}\0${item.version}`;
    const fingerprint = this.computeInstalledMetadataFingerprint(item, targetRoot);
    if (verification === 'cached' && fingerprint) {
      const cached = this.installedStatusCache.get(cacheKey);
      if (cached?.fingerprint === fingerprint) return cached.installed;
    }
    const installed = item.files?.length
      ? readManagedInstallSetMarker(targetRoot, {
        id: item.id,
        version: item.version,
        source: item.source,
        license: item.license,
        platform: this.runtimePlatform,
        entryPoint: item.entryPoint,
        manifestSha256: this.computeFileSetHash(item.files),
        totalSize: item.files.reduce((sum, file) => sum + file.size, 0),
      }) !== null
      : readManagedInstallMarker(targetRoot, {
      id: item.id,
      version: item.version,
      sha256: item.sha256 || undefined,
      size: item.size || undefined,
      source: item.source,
      license: item.license,
      platform: this.runtimePlatform,
      entryPoint: item.fileName || undefined,
    }) !== null;
    const postVerificationFingerprint = this.computeInstalledMetadataFingerprint(item, targetRoot);
    if (postVerificationFingerprint) {
      this.installedStatusCache.set(cacheKey, { fingerprint: postVerificationFingerprint, installed });
    } else {
      this.installedStatusCache.delete(cacheKey);
    }
    return installed;
  }

  async install(componentId: string, signal?: AbortSignal): Promise<void> {
    const item = this.manifest.components.find((candidate) => candidate.id === componentId);
    if (!item) throw new Error('component_not_found');
    if (item.platforms && !item.platforms.includes(this.runtimePlatform)) throw new Error('component_platform_unsupported');
    const collectionReady = item.files?.length && item.entryPoint;
    const installerReady = item.installer && item.sha256 && item.fileName && item.size;
    const legacyReady = !item.installer && item.sha256 && item.fileName && item.size;
    if (item.availability !== 'ready' || !item.version || (!collectionReady && !installerReady && !legacyReady)) throw new Error(item.diagnosticCode || 'manifest_incomplete');
    const componentRoot = path.join(this.runtimeDepsRoot, 'speech', item.id);
    const targetRoot = path.join(componentRoot, item.version);
    ensureNonSymlinkDirectory(componentRoot);
    const releaseInstallLock = this.acquireInstallLock(componentRoot, item.id);
    const stageRoot = path.join(componentRoot, `.stage-${crypto.randomUUID()}`);
    try {
      if (fs.existsSync(targetRoot)) {
        if (this.isInstalled(item, 'full')) return;
        throw new Error('component_target_conflict');
      }
      ensureNonSymlinkDirectory(stageRoot);
      const payloadRoot = path.join(stageRoot, 'payload');
      ensureNonSymlinkDirectory(payloadRoot);
      if (installerReady) {
        await this.installPythonTarget(item, item.installer!, stageRoot, payloadRoot, signal);
      } else if (collectionReady) {
        const totalSize = item.files!.reduce((sum, file) => sum + file.size, 0);
        if (!Number.isSafeInteger(totalSize) || totalSize > this.maxTotalDownloadBytes) throw new Error('download_total_too_large');
        this.assertDiskSpace(payloadRoot, totalSize);
        // 所有资源先进入同一 stage；只有完整 Hash 集合通过后才原子发布版本目录。
        for (const file of item.files!) {
          const target = path.resolve(payloadRoot, ...file.path.split('/'));
          if (!isWithinRoot(target, payloadRoot)) throw new Error('component_path_escape');
          ensureNonSymlinkDirectory(path.dirname(target));
          await this.operations.fetchAsset({
            url: file.source,
            targetPath: target,
            expectedSha256: file.sha256,
            expectedBytes: file.size,
            maxBytes: this.maxDownloadBytes,
            signal,
          });
        }
      } else {
        const downloadPath = path.join(stageRoot, 'download.bin');
        await this.operations.fetchAsset({
          url: item.source,
          targetPath: downloadPath,
          expectedSha256: item.sha256!,
          expectedBytes: item.size!,
          maxBytes: this.maxDownloadBytes,
          signal,
        });
        if (item.archive === 'zip') {
          await this.operations.extractZip(downloadPath, payloadRoot, this.maxDownloadBytes);
        } else {
          const target = path.resolve(payloadRoot, ...assertSafeRelativePath(item.fileName!).split('/'));
          if (!isWithinRoot(target, payloadRoot)) throw new Error('component_path_escape');
          ensureNonSymlinkDirectory(path.dirname(target));
          fs.renameSync(downloadPath, target);
        }
      }
      const entryPointRelative = collectionReady ? assertSafeRelativePath(item.entryPoint!) : assertSafeRelativePath(item.fileName!);
      const entryPoint = path.resolve(payloadRoot, ...entryPointRelative.split('/'));
      if (!isWithinRoot(entryPoint, payloadRoot)) throw new Error('component_path_escape');
      const entryPointStat = fs.lstatSync(entryPoint);
      if (entryPointStat.isSymbolicLink() || !entryPointStat.isFile()) throw new Error('component_entry_point_missing_or_unsafe');
      const entryPointSha256 = hashFileSha256Sync(entryPoint);
      const marker = collectionReady ? {
        protocol: MANAGED_INSTALL_SET_PROTOCOL,
        id: item.id,
        version: item.version,
        source: item.source,
        license: item.license,
        platform: this.runtimePlatform,
        entryPoint: entryPointRelative,
        manifestSha256: this.computeFileSetHash(item.files!),
        totalSize: item.files!.reduce((sum, file) => sum + file.size, 0),
        files: item.files!.map((file) => ({ path: file.path, sha256: file.sha256, size: file.size, source: file.source })),
        installedAt: new Date().toISOString(),
      } : {
        protocol: MANAGED_INSTALL_PROTOCOL,
        id: item.id,
        version: item.version,
        sha256: item.sha256,
        size: item.size,
        source: item.source,
        license: item.license,
        platform: this.runtimePlatform,
        entryPoint: entryPointRelative,
        entryPointSha256,
        entryPointSize: entryPointStat.size,
        installedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(payloadRoot, '.installed.json'), `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(payloadRoot, targetRoot);
    } finally {
      try {
        removeManagedTempDirectorySafely({
          targetPath: stageRoot,
          managedRoot: componentRoot,
          requiredNamePrefix: '.stage-',
        });
      } catch { /* 失败 stage 不会被 resolver 采用，也绝不放宽递归删除边界。 */ }
      releaseInstallLock();
    }
  }

  private async installPythonTarget(
    item: ManagedDependencyRecord,
    installer: ManagedPythonTargetInstaller,
    stageRoot: string,
    payloadRoot: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const sourceBytes = installer.kind === 'python_target/v2' ? installer.source.size : 0;
    if (installer.python.size + installer.tool.size + sourceBytes > this.maxTotalDownloadBytes) throw new Error('download_total_too_large');
    this.assertDiskSpace(payloadRoot, installer.requiredDiskBytes);

    const requirementsPath = this.resolveBundledRequirements(installer.requirements);
    const pythonArchive = path.join(stageRoot, 'download-python.zip');
    const toolArchive = path.join(stageRoot, 'download-tool.zip');
    const toolRoot = path.join(stageRoot, 'tool');
    ensureNonSymlinkDirectory(toolRoot);
    const sourceArchive = installer.kind === 'python_target/v2' ? path.join(stageRoot, 'download-source.zip') : undefined;
    const sourceRoot = installer.kind === 'python_target/v2' ? path.join(stageRoot, 'source') : undefined;
    if (sourceRoot) ensureNonSymlinkDirectory(sourceRoot);

    await this.operations.fetchAsset({
      url: installer.python.source,
      targetPath: pythonArchive,
      expectedSha256: installer.python.sha256,
      expectedBytes: installer.python.size,
      maxBytes: this.maxDownloadBytes,
      signal,
    });
    this.verifyDownloadedAsset(pythonArchive, installer.python);
    await this.operations.fetchAsset({
      url: installer.tool.source,
      targetPath: toolArchive,
      expectedSha256: installer.tool.sha256,
      expectedBytes: installer.tool.size,
      maxBytes: this.maxDownloadBytes,
      signal,
    });
    this.verifyDownloadedAsset(toolArchive, installer.tool);
    if (installer.kind === 'python_target/v2' && sourceArchive && sourceRoot) {
      await this.operations.fetchAsset({
        url: installer.source.source,
        targetPath: sourceArchive,
        expectedSha256: installer.source.sha256,
        expectedBytes: installer.source.size,
        maxBytes: this.maxDownloadBytes,
        signal,
      });
      this.verifyDownloadedArchive(sourceArchive, installer.source);
    }
    await this.operations.extractZip(pythonArchive, payloadRoot, this.maxDownloadBytes);
    await this.operations.extractZip(toolArchive, toolRoot, this.maxDownloadBytes);
    if (installer.kind === 'python_target/v2' && sourceArchive && sourceRoot) {
      await this.operations.extractZip(sourceArchive, sourceRoot, installer.source.maxExtractedBytes);
    }

    const pythonPath = this.resolveOrdinaryFile(payloadRoot, installer.python.entryPoint, 'component_entry_point_missing_or_unsafe');
    this.resolveOrdinaryFile(payloadRoot, installer.python.stdlibZip, 'python_stdlib_missing_or_unsafe');
    const pthPath = this.resolveOrdinaryFile(payloadRoot, installer.python.pthFile, 'python_pth_missing_or_unsafe');
    const uvPath = this.resolveOrdinaryFile(toolRoot, installer.tool.entryPoint, 'installer_tool_missing_or_unsafe');
    const sitePackagesPath = path.resolve(payloadRoot, ...installer.sitePackages.split('/'));
    if (!isWithinRoot(sitePackagesPath, payloadRoot)) throw new Error('component_path_escape');
    ensureNonSymlinkDirectory(sitePackagesPath);

    // Embeddable Python 默认不加载 site-packages。这里完全重写固定 _pth，
    // 只开放标准库、本包目录和受管 site-packages，不继承系统 Python 环境。
    const pthDirectory = path.posix.dirname(installer.python.pthFile);
    const relativeFromPth = (target: string) => path.posix.relative(pthDirectory, target) || '.';
    const pthContents = `${relativeFromPth(installer.python.stdlibZip)}\n.\n${relativeFromPth(installer.sitePackages)}\nimport site\n`;
    fs.writeFileSync(pthPath, pthContents, { encoding: 'utf8', mode: 0o600 });

    const cacheRoot = path.join(stageRoot, 'uv-cache');
    ensureNonSymlinkDirectory(cacheRoot);
    const cleanEnvironment = this.createIsolatedPythonEnvironment(cacheRoot);
    const cudaWheelIndex = installer.requireCuda && installer.cudaVersion
      ? `https://download.pytorch.org/whl/cu${installer.cudaVersion.replace('.', '')}`
      : undefined;
    const installResult = await this.operations.runProcess(uvPath, [
      'pip', 'install',
      '--python', pythonPath,
      '--target', sitePackagesPath,
      '--no-python-downloads',
      '--no-config',
      '--require-hashes',
      // CUDA local-version wheel 不在 PyPI；索引地址由受限 cudaVersion 推导，
      // 不接受 manifest URL 或任意附加 argv，所有 wheel 仍须命中锁文件 Hash。
      ...(cudaWheelIndex ? [
        '--index', cudaWheelIndex,
        // PyPI 与 PyTorch 官方索引会有少量同名基础包。require-hashes 已把
        // 最终 wheel 身份锁死，因此允许在两个固定可信索引中择优匹配。
        '--index-strategy', 'unsafe-best-match',
      ] : []),
      '-r', requirementsPath,
    ], {
      signal,
      timeoutMs: 45 * 60 * 1000,
      maxOutputBytes: 1024 * 1024,
      env: cleanEnvironment,
    });
    if (installResult.code !== 0) {
      this.writeInstallerDiagnostic(item.id, 'install', installResult);
      throw new Error('python_target_install_failed');
    }

    if (installer.kind === 'python_target/v2' && sourceRoot) {
      for (const mapping of installer.packageTrees) {
        this.copyOrdinaryTree(sourceRoot, mapping.source, sitePackagesPath, mapping.target);
      }
    }

    const probeScript = [
      'import importlib,json,sys',
      `mods=${JSON.stringify(installer.probeModules)}`,
      '[importlib.import_module(name) for name in mods]',
      `torch=importlib.import_module("torch") if ${installer.requireCuda ? 'True' : 'False'} else None`,
      'print(json.dumps({"version":[sys.version_info[0],sys.version_info[1]],"cuda_available":bool(torch and torch.cuda.is_available()),"cuda_version":(torch.version.cuda if torch else None)},separators=(",",":")))',
    ].join(';');
    const probeResult = await this.operations.runProcess(pythonPath, ['-I', '-c', probeScript], {
      signal,
      timeoutMs: 5 * 60 * 1000,
      maxOutputBytes: 256 * 1024,
      env: cleanEnvironment,
    });
    if (probeResult.code !== 0) {
      this.writeInstallerDiagnostic(item.id, 'probe', probeResult);
      throw new Error('python_target_probe_failed');
    }
    const probeLine = probeResult.stdout.trim().split(/\r?\n/).at(-1) || '';
    let probe: { version?: unknown; cuda_available?: unknown; cuda_version?: unknown };
    try {
      probe = JSON.parse(probeLine) as typeof probe;
    } catch {
      throw new Error('python_target_probe_invalid');
    }
    const expectedVersion = installer.pythonVersion.split('.').map(Number);
    if (!Array.isArray(probe.version) || probe.version.length !== 2
      || probe.version[0] !== expectedVersion[0] || probe.version[1] !== expectedVersion[1]) {
      throw new Error('python_target_version_mismatch');
    }
    if (installer.requireCuda && probe.cuda_available !== true) throw new Error('python_target_cuda_unavailable');
    if (installer.cudaVersion && probe.cuda_version !== installer.cudaVersion) throw new Error('python_target_cuda_version_mismatch');

    // 安装 recipe 的最终入口必须与组件声明一致，避免 marker 指向另一份解释器。
    if (assertSafeRelativePath(item.fileName!) !== installer.python.entryPoint) {
      throw new Error('dependency_manifest_installer_metadata_invalid');
    }
  }

  private resolveBundledRequirements(requirements: ManagedPythonTargetInstaller['requirements']): string {
    const candidate = path.resolve(this.manifestRoot, ...requirements.path.split('/'));
    if (!isWithinRoot(candidate, this.manifestRoot)) throw new Error('requirements_path_escape');
    const stat = fs.lstatSync(candidate);
    const comparable = (value: string) => process.platform === 'win32'
      ? path.normalize(value).toLowerCase()
      : path.normalize(value);
    if (stat.isSymbolicLink() || !stat.isFile()
      || comparable(fs.realpathSync.native(candidate)) !== comparable(candidate)) {
      throw new Error('requirements_file_unsafe');
    }
    if (stat.size !== requirements.size) throw new Error('requirements_size_mismatch');
    if (hashFileSha256Sync(candidate) !== requirements.sha256) throw new Error('requirements_sha256_mismatch');
    return candidate;
  }

  /** 安装器原始输出只进入本机 Runtime 诊断目录，绝不跨控制面板 DTO 外发。 */
  private writeInstallerDiagnostic(
    componentId: string,
    phase: 'install' | 'probe',
    result: { code: number; stdout: string; stderr: string },
  ): void {
    try {
      const root = path.resolve(this.runtimeDepsRoot, '..', 'runtime', 'speech', 'install-logs');
      ensureNonSymlinkDirectory(root);
      const bounded = (value: string) => value.slice(-64 * 1024);
      fs.writeFileSync(path.join(root, `${componentId}-${phase}.log`), [
        `phase=${phase}`,
        `exitCode=${result.code}`,
        '--- stdout ---',
        bounded(result.stdout),
        '--- stderr ---',
        bounded(result.stderr),
        '',
      ].join('\n'), { encoding: 'utf8', mode: 0o600 });
    } catch {
      // 诊断日志属于观察链，不能改变真实安装失败结果。
    }
  }

  private verifyDownloadedAsset(filePath: string, asset: ManagedDownloadAsset): void {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('download_file_unsafe');
    if (stat.size !== asset.size) throw new Error('download_size_mismatch');
    if (hashFileSha256Sync(filePath) !== asset.sha256) throw new Error('download_sha256_mismatch');
  }

  private verifyDownloadedArchive(filePath: string, asset: ManagedSourceArchive): void {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('download_file_unsafe');
    if (stat.size !== asset.size) throw new Error('download_size_mismatch');
    if (hashFileSha256Sync(filePath) !== asset.sha256) throw new Error('download_sha256_mismatch');
  }

  private copyOrdinaryTree(sourceRoot: string, sourceRelative: string, targetRoot: string, targetRelative: string): void {
    const source = path.resolve(sourceRoot, ...sourceRelative.split('/'));
    const target = path.resolve(targetRoot, ...targetRelative.split('/'));
    if (!isWithinRoot(source, sourceRoot) || !isWithinRoot(target, targetRoot)) throw new Error('component_path_escape');
    if (fs.existsSync(target)) throw new Error('python_target_mapping_conflict');

    const copyDirectory = (currentSource: string, currentTarget: string): void => {
      const stat = fs.lstatSync(currentSource);
      const comparable = (value: string) => process.platform === 'win32'
        ? path.normalize(value).toLowerCase()
        : path.normalize(value);
      if (stat.isSymbolicLink() || !stat.isDirectory()
        || comparable(fs.realpathSync.native(currentSource)) !== comparable(currentSource)) {
        throw new Error('python_target_mapping_source_unsafe');
      }
      ensureNonSymlinkDirectory(currentTarget);
      for (const entry of fs.readdirSync(currentSource, { withFileTypes: true })) {
        const childSource = path.join(currentSource, entry.name);
        const childTarget = path.join(currentTarget, entry.name);
        const childStat = fs.lstatSync(childSource);
        if (childStat.isSymbolicLink()) throw new Error('python_target_mapping_source_unsafe');
        if (childStat.isDirectory()) copyDirectory(childSource, childTarget);
        else if (childStat.isFile()) fs.copyFileSync(childSource, childTarget, fs.constants.COPYFILE_EXCL);
        else throw new Error('python_target_mapping_source_unsafe');
      }
    };

    copyDirectory(source, target);
  }

  private resolveOrdinaryFile(root: string, relativePath: string, errorCode: string): string {
    const candidate = path.resolve(root, ...relativePath.split('/'));
    if (!isWithinRoot(candidate, root)) throw new Error('component_path_escape');
    try {
      const stat = fs.lstatSync(candidate);
      const comparable = (value: string) => process.platform === 'win32'
        ? path.normalize(value).toLowerCase()
        : path.normalize(value);
      if (stat.isSymbolicLink() || !stat.isFile()
        || comparable(fs.realpathSync.native(candidate)) !== comparable(candidate)) throw new Error(errorCode);
      return candidate;
    } catch (error) {
      if (error instanceof Error && error.message === errorCode) throw error;
      throw new Error(errorCode);
    }
  }

  private createIsolatedPythonEnvironment(cacheRoot: string): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      const upper = key.toUpperCase();
      if (upper === 'PYTHONHOME' || upper === 'PYTHONPATH' || upper.startsWith('PIP_') || upper.startsWith('UV_')) continue;
      environment[key] = value;
    }
    environment.PYTHONUTF8 = '1';
    environment.PYTHONNOUSERSITE = '1';
    environment.UV_CACHE_DIR = cacheRoot;
    environment.UV_NO_PROGRESS = '1';
    return environment;
  }

  private computeFileSetHash(files: readonly ManagedDependencyFileRecord[]): string {
    const canonical = files.map((file) => [file.path, file.sha256.toLowerCase(), file.size, file.source]);
    return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
  }

  /**
   * 状态轮询只缓存完整校验的结果，并绑定 marker 内容及每个声明文件的元数据。
   * 任一大小、mtime、ctime、文件类型或 realpath 变化都会使缓存失效；执行解析仍走完整 Hash。
   */
  private computeInstalledMetadataFingerprint(item: ManagedDependencyRecord, targetRoot: string): string | null {
    try {
      const root = path.resolve(targetRoot);
      const comparable = (value: string) => process.platform === 'win32'
        ? path.normalize(value).toLowerCase()
        : path.normalize(value);
      const rootStat = fs.lstatSync(root, { bigint: true });
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
        || comparable(fs.realpathSync.native(root)) !== comparable(root)) return null;

      const markerPath = path.join(root, '.installed.json');
      const markerStat = fs.lstatSync(markerPath, { bigint: true });
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 256n * 1024n
        || comparable(fs.realpathSync.native(markerPath)) !== comparable(markerPath)) return null;
      const markerBytes = fs.readFileSync(markerPath);
      const records: Array<readonly [string, string, string, string]> = [[
        '.installed.json',
        markerStat.size.toString(),
        markerStat.mtimeNs.toString(),
        crypto.createHash('sha256').update(markerBytes).digest('hex'),
      ]];

      const declaredFiles = item.files?.length
        ? item.files.map((file) => ({ path: file.path, size: file.size }))
        : item.fileName && item.size ? [{ path: item.fileName, size: item.size }] : [];
      if (declaredFiles.length === 0) return null;
      for (const declared of declaredFiles) {
        const relative = assertSafeRelativePath(declared.path);
        const candidate = path.resolve(root, ...relative.split('/'));
        if (!isWithinRoot(candidate, root)) return null;
        const stat = fs.lstatSync(candidate, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== BigInt(declared.size)
          || comparable(fs.realpathSync.native(candidate)) !== comparable(candidate)) return null;
        records.push([relative, stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString()]);
      }
      return crypto.createHash('sha256').update(JSON.stringify(records), 'utf8').digest('hex');
    } catch {
      return null;
    }
  }

  private assertDiskSpace(targetRoot: string, requiredBytes: number): void {
    try {
      const statfs = fs.statfsSync(targetRoot);
      const available = Number(statfs.bavail) * Number(statfs.bsize);
      // 下载阶段和最终发布位于同一组件卷，rename 不会复制数据；仅预留少量 marker/目录开销。
      if (Number.isFinite(available) && available < requiredBytes + 64 * 1024 * 1024) throw new Error('disk_space_insufficient');
    } catch (error) {
      if (error instanceof Error && error.message === 'disk_space_insufficient') throw error;
      // 无法探测文件系统容量时继续依赖逐文件硬上限，避免把兼容性问题误报成安装成功。
    }
  }

  private acquireInstallLock(componentRoot: string, componentId: string): () => void {
    const lockPath = path.join(componentRoot, '.install.lock');
    const runId = crypto.randomUUID();
    let descriptor: number;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify({
        protocol: 'cti-speech-component-install-lock/v1',
        componentId,
        runId,
        ownerPid: process.pid,
        createdAt: new Date().toISOString(),
      })}\n`, { encoding: 'utf8' });
      fs.fsyncSync(descriptor);
    } catch {
      throw new Error('component_install_locked');
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { fs.closeSync(descriptor); } catch { /* 后续仍按文件归属复验。 */ }
      try {
        const stat = fs.lstatSync(lockPath);
        const value = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
          protocol?: string;
          componentId?: string;
          runId?: string;
          ownerPid?: number;
        };
        if (
          stat.isFile()
          && !stat.isSymbolicLink()
          && value.protocol === 'cti-speech-component-install-lock/v1'
          && value.componentId === componentId
          && value.runId === runId
          && value.ownerPid === process.pid
        ) fs.unlinkSync(lockPath);
      } catch { /* 非持有者或观察失败时保留锁，绝不误删。 */ }
    };
  }
}

