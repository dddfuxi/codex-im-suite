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
import type { ManagedSpeechComponentStatus } from './speech-status.js';

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

  constructor(
    manifestPath: string,
    private readonly runtimeDepsRoot: string,
    private readonly maxDownloadBytes = 8 * 1024 * 1024 * 1024,
    private readonly runtimePlatform = `${process.platform}-${process.arch}`,
    private readonly maxTotalDownloadBytes = 16 * 1024 * 1024 * 1024,
  ) {
    this.manifest = readManifest(path.resolve(manifestPath));
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

  private isInstalled(item: ManagedDependencyRecord): boolean {
    if (!item.version) return false;
    const targetRoot = path.join(this.runtimeDepsRoot, 'speech', item.id, item.version);
    if (item.files?.length) {
      return readManagedInstallSetMarker(targetRoot, {
        id: item.id,
        version: item.version,
        source: item.source,
        license: item.license,
        platform: this.runtimePlatform,
        entryPoint: item.entryPoint,
        manifestSha256: this.computeFileSetHash(item.files),
        totalSize: item.files.reduce((sum, file) => sum + file.size, 0),
      }) !== null;
    }
    return readManagedInstallMarker(targetRoot, {
      id: item.id,
      version: item.version,
      sha256: item.sha256 || undefined,
      size: item.size || undefined,
      source: item.source,
      license: item.license,
      platform: this.runtimePlatform,
      entryPoint: item.fileName || undefined,
    }) !== null;
  }

  async install(componentId: string, signal?: AbortSignal): Promise<void> {
    const item = this.manifest.components.find((candidate) => candidate.id === componentId);
    if (!item) throw new Error('component_not_found');
    if (item.platforms && !item.platforms.includes(this.runtimePlatform)) throw new Error('component_platform_unsupported');
    const collectionReady = item.files?.length && item.entryPoint;
    const legacyReady = item.sha256 && item.fileName && item.size;
    if (item.availability !== 'ready' || !item.version || (!collectionReady && !legacyReady)) throw new Error(item.diagnosticCode || 'manifest_incomplete');
    const componentRoot = path.join(this.runtimeDepsRoot, 'speech', item.id);
    const targetRoot = path.join(componentRoot, item.version);
    ensureNonSymlinkDirectory(componentRoot);
    const releaseInstallLock = this.acquireInstallLock(componentRoot, item.id);
    const stageRoot = path.join(componentRoot, `.stage-${crypto.randomUUID()}`);
    try {
      if (fs.existsSync(targetRoot)) {
        if (this.isInstalled(item)) return;
        throw new Error('component_target_conflict');
      }
      ensureNonSymlinkDirectory(stageRoot);
      const payloadRoot = path.join(stageRoot, 'payload');
      ensureNonSymlinkDirectory(payloadRoot);
      if (collectionReady) {
        const totalSize = item.files!.reduce((sum, file) => sum + file.size, 0);
        if (!Number.isSafeInteger(totalSize) || totalSize > this.maxTotalDownloadBytes) throw new Error('download_total_too_large');
        this.assertDiskSpace(payloadRoot, totalSize);
        // 所有资源先进入同一 stage；只有完整 Hash 集合通过后才原子发布版本目录。
        for (const file of item.files!) {
          const target = path.resolve(payloadRoot, ...file.path.split('/'));
          if (!isWithinRoot(target, payloadRoot)) throw new Error('component_path_escape');
          ensureNonSymlinkDirectory(path.dirname(target));
          await fetchHttps({
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
        await fetchHttps({
          url: item.source,
          targetPath: downloadPath,
          expectedSha256: item.sha256!,
          expectedBytes: item.size!,
          maxBytes: this.maxDownloadBytes,
          signal,
        });
        if (item.archive === 'zip') {
          await extractZipSafely(downloadPath, payloadRoot, this.maxDownloadBytes);
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

  private computeFileSetHash(files: readonly ManagedDependencyFileRecord[]): string {
    const canonical = files.map((file) => [file.path, file.sha256.toLowerCase(), file.size, file.source]);
    return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
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

