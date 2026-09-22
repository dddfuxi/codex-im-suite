import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { writeUtf8TextAtomic } from '../atomic-text-file.js';
import { ensureNonSymlinkDirectory, isWithinRoot } from './dependency-resolution.js';

const DEFAULT_MAX_LOG_BYTES = 256 * 1024;
const MAX_LOG_LINE_CHARS = 4_096;
const SIDECAR_LOCK_PROTOCOL = 'cti-speech-sidecar-lock/v1' as const;

interface SidecarInstanceLockRecord {
  protocol: typeof SIDECAR_LOCK_PROTOCOL;
  runId: string;
  ownerPid: number;
  createdAt: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: string }).code
      : undefined;
    // EPERM 只表示无权探测，不能据此把仍在运行的外部进程判成陈旧。
    return code !== 'ESRCH';
  }
}

function safeOpaqueId(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{7,79}$/i.test(value)) throw new Error('sidecar_run_id_invalid');
  return value;
}

function truncateCharacters(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  return characters.length <= maxCharacters ? value : `${characters.slice(0, Math.max(0, maxCharacters - 1)).join('')}…`;
}

export function sanitizeSidecarDiagnostic(value: string, sensitiveValues: string[] = []): string {
  let sanitized = String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  for (const sensitive of sensitiveValues.filter(Boolean)) sanitized = sanitized.split(sensitive).join('[REDACTED]');
  sanitized = sanitized
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/g, '[PATH]')
    .replace(/(^|\s)\/(?:[^\s"'<>/]+\/)*[^\s"'<>]*/g, '$1[PATH]')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateCharacters(sanitized, MAX_LOG_LINE_CHARS);
}

/**
 * CTI_HOME 级 Sidecar 单实例锁。锁只记录不透明 runId 和宿主 PID；
 * 不保存端口、token、模型路径，也绝不终止已存在的外部进程。
 */
export class SpeechSidecarInstanceLock {
  readonly runId: string;
  readonly lockPath: string;
  private acquired = false;

  constructor(
    runtimeStateRoot: string,
    runId = `run-${crypto.randomUUID()}`,
    private readonly isProcessAlive: (pid: number) => boolean = processIsAlive,
    private readonly ownerPid = process.pid,
  ) {
    this.runId = safeOpaqueId(runId);
    const root = path.resolve(runtimeStateRoot);
    ensureNonSymlinkDirectory(root);
    this.lockPath = path.join(root, 'sidecar-single-instance.lock');
    if (!isWithinRoot(this.lockPath, root)) throw new Error('sidecar_instance_locked');
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) throw new Error('sidecar_instance_locked');
  }

  acquire(): void {
    // 同一 Supervisor 的上一代 child 尚未 close 时也必须失败，不能重入后加载第二份模型。
    if (this.acquired) throw new Error('sidecar_instance_locked');
    if (this.tryCreate()) return;

    const existing = this.readLock(this.lockPath);
    if (!existing || this.isProcessAlive(existing.ownerPid)) throw new Error('sidecar_instance_locked');

    // 先原子改名再删除，避免两个启动者同时回收陈旧锁时误删新持有者的锁。
    const stalePath = `${this.lockPath}.stale-${this.runId}-${crypto.randomUUID()}`;
    try {
      fs.renameSync(this.lockPath, stalePath);
    } catch {
      throw new Error('sidecar_instance_locked');
    }
    try {
      const moved = this.readLock(stalePath);
      if (
        !moved
        || moved.runId !== existing.runId
        || moved.ownerPid !== existing.ownerPid
        || this.isProcessAlive(moved.ownerPid)
      ) {
        this.restoreUnexpectedLock(stalePath);
        throw new Error('sidecar_instance_locked');
      }
      fs.unlinkSync(stalePath);
    } catch (error) {
      if (fs.existsSync(stalePath)) this.restoreUnexpectedLock(stalePath);
      throw error instanceof Error && error.message === 'sidecar_instance_locked'
        ? error
        : new Error('sidecar_instance_locked');
    }

    // 只重试一次；若另一实例抢先获得锁，本实例立即失败关闭。
    if (!this.tryCreate()) throw new Error('sidecar_instance_locked');
  }

  release(): boolean {
    if (!this.acquired) return false;
    const existing = this.readLock(this.lockPath);
    if (!existing || existing.runId !== this.runId || existing.ownerPid !== this.ownerPid) {
      this.acquired = false;
      return false;
    }
    try {
      fs.unlinkSync(this.lockPath);
      this.acquired = false;
      return true;
    } catch {
      return false;
    }
  }

  private tryCreate(): boolean {
    let descriptor: number;
    try {
      descriptor = fs.openSync(this.lockPath, 'wx', 0o600);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: string }).code
        : undefined;
      if (code === 'EEXIST') return false;
      throw new Error('sidecar_instance_locked');
    }
    try {
      const record: SidecarInstanceLockRecord = {
        protocol: SIDECAR_LOCK_PROTOCOL,
        runId: this.runId,
        ownerPid: this.ownerPid,
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
      fs.fsyncSync(descriptor);
      this.acquired = true;
      return true;
    } catch {
      try { fs.closeSync(descriptor); } catch { /* 随后仍只清理本次 wx 创建的锁。 */ }
      try { fs.unlinkSync(this.lockPath); } catch { /* 写入不完整时保留即失败关闭。 */ }
      throw new Error('sidecar_instance_locked');
    } finally {
      try { fs.closeSync(descriptor); } catch { /* 已在失败分支关闭或正常释放描述符。 */ }
    }
  }

  private readLock(lockPath: string): SidecarInstanceLockRecord | null {
    try {
      const stat = fs.lstatSync(lockPath);
      if (stat.isSymbolicLink() || !stat.isFile()) return null;
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<SidecarInstanceLockRecord>;
      if (
        parsed.protocol !== SIDECAR_LOCK_PROTOCOL
        || typeof parsed.runId !== 'string'
        || !/^[a-z0-9][a-z0-9_-]{7,79}$/i.test(parsed.runId)
        || !Number.isInteger(parsed.ownerPid)
        || parsed.ownerPid! <= 0
        || typeof parsed.createdAt !== 'string'
        || !Number.isFinite(Date.parse(parsed.createdAt))
      ) return null;
      return parsed as SidecarInstanceLockRecord;
    } catch {
      return null;
    }
  }

  private restoreUnexpectedLock(stalePath: string): void {
    try {
      if (!fs.existsSync(this.lockPath)) fs.renameSync(stalePath, this.lockPath);
    } catch { /* 无法证明归属时保留隔离文件并失败关闭，不继续删除。 */ }
  }
}

export class SpeechSidecarRuntimeDiagnostics {
  readonly runId: string;
  readonly root: string;
  readonly pidPath: string;
  readonly statePath: string;
  readonly logPath: string;
  readonly rotatedLogPath: string;
  private startedAt: string | undefined;

  constructor(runtimeStateRoot: string, runId = `run-${crypto.randomUUID()}`, private readonly maxLogBytes = DEFAULT_MAX_LOG_BYTES) {
    this.runId = safeOpaqueId(runId);
    this.root = path.resolve(runtimeStateRoot, 'sidecars');
    ensureNonSymlinkDirectory(this.root);
    this.pidPath = path.join(this.root, `${this.runId}.pid`);
    this.statePath = path.join(this.root, `${this.runId}.state.json`);
    this.logPath = path.join(this.root, `${this.runId}.log`);
    this.rotatedLogPath = `${this.logPath}.1`;
  }

  recordStarted(pid: number, port: number): void {
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port < 1 || port > 65_535) return;
    this.startedAt = new Date().toISOString();
    this.safeObserve(() => {
      writeUtf8TextAtomic(this.pidPath, `${pid}\n`);
      this.writeState({ state: 'running', pid, port, startedAt: this.startedAt! });
    });
  }

  recordStopped(pid: number | undefined, exitCode: string): void {
    const safeExitCode = /^[a-z0-9_-]{1,64}$/i.test(exitCode) ? exitCode : 'unknown';
    this.safeObserve(() => {
      if (Number.isInteger(pid) && pid! > 0 && this.ownsPid(pid!)) fs.unlinkSync(this.pidPath);
      this.writeState({ state: 'stopped', pid: null, startedAt: this.startedAt, exitCode: safeExitCode });
    });
  }

  append(stream: 'stdout' | 'stderr', value: string, sensitiveValues: string[] = []): void {
    const message = sanitizeSidecarDiagnostic(value, sensitiveValues);
    if (!message) return;
    this.safeObserve(() => {
      const timestamp = new Date().toISOString();
      let line = `${timestamp} ${stream} ${message}\n`;
      const maxLineBytes = Math.max(64, Math.min(this.maxLogBytes, 8 * 1024));
      while (Buffer.byteLength(line, 'utf8') > maxLineBytes && line.length > 1) line = `${line.slice(0, Math.floor(line.length * 0.8))}…\n`;
      this.rotateIfNeeded(Buffer.byteLength(line, 'utf8'));
      fs.appendFileSync(this.logPath, line, { encoding: 'utf8', mode: 0o600 });
    });
  }

  private ownsPid(pid: number): boolean {
    try {
      const stat = fs.lstatSync(this.pidPath);
      return stat.isFile() && !stat.isSymbolicLink() && fs.readFileSync(this.pidPath, 'utf8').trim() === String(pid);
    } catch {
      return false;
    }
  }

  private writeState(input: { state: 'running' | 'stopped'; pid: number | null; port?: number; startedAt?: string; exitCode?: string }): void {
    writeUtf8TextAtomic(this.statePath, `${JSON.stringify({
      protocol: 'cti-speech-sidecar-state/v1',
      runId: this.runId,
      ...input,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);
  }

  private rotateIfNeeded(incomingBytes: number): void {
    let currentBytes = 0;
    try {
      const stat = fs.lstatSync(this.logPath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('sidecar_log_unsafe');
      currentBytes = stat.size;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') return;
      throw error;
    }
    if (currentBytes + incomingBytes <= this.maxLogBytes) return;
    if (!isWithinRoot(this.rotatedLogPath, this.root)) throw new Error('sidecar_log_path_escape');
    try {
      const rotated = fs.lstatSync(this.rotatedLogPath);
      if (rotated.isSymbolicLink() || !rotated.isFile()) throw new Error('sidecar_rotated_log_unsafe');
      fs.unlinkSync(this.rotatedLogPath);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT')) throw error;
    }
    fs.renameSync(this.logPath, this.rotatedLogPath);
  }

  private safeObserve(operation: () => void): void {
    try { operation(); } catch { /* 观察链失败不能阻断 Primary、语音请求或 Delivery。 */ }
  }
}
