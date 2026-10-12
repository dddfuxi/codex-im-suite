import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_RETRY_DELAYS_MS = [20, 50, 100, 200, 400] as const;

function getFsErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : '';
}

export function isRetryableWindowsFileLock(error: unknown): boolean {
  const code = getFsErrorCode(error);
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

export function retryLockedFileOperation<T>(
  operation: () => T,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): T {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isRetryableWindowsFileLock(error) || attempt >= retryDelaysMs.length) throw error;
      lastError = error;
      sleepSync(retryDelaysMs[attempt]);
    }
  }
  throw lastError;
}

/**
 * Windows readers may briefly hold a file without FILE_SHARE_DELETE, causing an
 * otherwise-valid atomic rename to fail. Retry first; derived observation files
 * fall back to a direct overwrite only after the lock window is exhausted.
 */
export function writeUtf8TextAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  retryLockedFileOperation(() => fs.writeFileSync(tempPath, content, 'utf8'));
  try {
    retryLockedFileOperation(() => fs.renameSync(tempPath, filePath));
  } catch (error) {
    if (!isRetryableWindowsFileLock(error)) throw error;
    retryLockedFileOperation(() => fs.writeFileSync(filePath, content, 'utf8'));
  } finally {
    try {
      if (fs.existsSync(tempPath)) retryLockedFileOperation(() => fs.unlinkSync(tempPath));
    } catch {
      // 下一次启动会清理过期临时文件；写入主文件的结果不因此回滚。
    }
  }
}

/** 只清理同一事实文件产生、且已明显过期的普通临时文件。 */
export function cleanupStaleAtomicWriteTemps(filePath: string, olderThanMs = 5 * 60_000): number {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) return 0;
  const prefix = `${path.basename(filePath)}.`;
  const cutoff = Date.now() - Math.max(0, olderThanMs);
  let removed = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) continue;
    const candidate = path.join(directory, entry.name);
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs > cutoff) continue;
      retryLockedFileOperation(() => fs.unlinkSync(candidate));
      removed += 1;
    } catch {
      // 临时锁或并发写入不应影响 Bridge 启动。
    }
  }
  return removed;
}
