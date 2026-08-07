import crypto from 'node:crypto';
import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import { resolveSpeechBackendDependencies, speechBackendEnvironment } from './backend-dependencies.js';
import { resolveExecutableDependency, resolveSidecarDependency, type ResolvedDependencyPath } from './dependency-resolution.js';
import { RuntimeSpeechError, type SpeechRuntimeConfig, type SpeechSidecarHealth } from './runtime-types.js';
import { SpeechSidecarInstanceLock, SpeechSidecarRuntimeDiagnostics } from './sidecar-runtime-diagnostics.js';

const SIDECAR_PROTOCOL = 'cti-speech-sidecar/v1' as const;

interface SidecarOperationEnvelope<T> {
  protocol: 'cti-speech-sidecar-result/v1';
  ok: boolean;
  status?: 'ready' | 'optional_missing' | 'blocked' | 'error';
  result?: T;
  errorCode?: string;
}

export interface SidecarTranscriptionResult {
  text: string;
  language: string;
  durationMs?: number;
  provider?: string;
  model: string;
}

export interface SidecarSynthesisResult {
  durationMs?: number;
  provider?: string;
  model?: string;
}

export type SpeechSidecarInterruption = 'abort' | 'timeout';

function combineAbort(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason || new Error('request_aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('request_timeout')), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

export class SpeechSidecarClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly onInterrupted?: (reason: SpeechSidecarInterruption) => Promise<void>,
  ) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new Error('sidecar_endpoint_not_loopback');
  }

  private async request<T>(pathname: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const abort = combineAbort(signal, this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(pathname, this.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-cti-speech-token': this.token,
          'x-cti-speech-protocol': SIDECAR_PROTOCOL,
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      let envelope: SidecarOperationEnvelope<T>;
      try { envelope = await response.json() as SidecarOperationEnvelope<T>; } catch { throw new RuntimeSpeechError('sidecar_invalid_json', 'error', '语音服务返回了无效响应'); }
      if (envelope.protocol !== 'cti-speech-sidecar-result/v1') throw new RuntimeSpeechError('sidecar_protocol_mismatch', 'blocked', '语音服务协议版本不匹配');
      if (!response.ok || !envelope.ok || !envelope.result) {
        const status = envelope.status === 'blocked' || envelope.status === 'optional_missing' ? envelope.status : 'error';
        throw new RuntimeSpeechError(envelope.errorCode || 'sidecar_request_failed', status, '语音服务未能完成请求');
      }
      return envelope.result;
    } catch (error) {
      const interruption: SpeechSidecarInterruption | undefined = signal?.aborted
        ? 'abort'
        : abort.signal.aborted ? 'timeout' : undefined;
      if (interruption) {
        try {
          await this.onInterrupted?.(interruption);
        } catch {
          // Supervisor 已先失效 client/child；终止器异常不能恢复旧 client。
        }
        if (interruption === 'abort') {
          throw new RuntimeSpeechError('speech_request_aborted', 'error', '语音请求已取消');
        }
        throw new RuntimeSpeechError('sidecar_request_timeout', 'error', '语音服务请求超时');
      }
      if (error instanceof RuntimeSpeechError) throw error;
      throw new RuntimeSpeechError('sidecar_unreachable', 'error', '本地语音服务不可达');
    } finally {
      abort.dispose();
    }
  }

  async health(signal?: AbortSignal): Promise<SpeechSidecarHealth> {
    const abort = combineAbort(signal, Math.min(this.timeoutMs, 5_000));
    try {
      const response = await this.fetchImpl(new URL('/v1/health', this.baseUrl), {
        headers: {
          'x-cti-speech-token': this.token,
          'x-cti-speech-protocol': SIDECAR_PROTOCOL,
        },
        signal: abort.signal,
      });
      const payload = await response.json() as SpeechSidecarHealth;
      if (!response.ok || payload.protocol !== SIDECAR_PROTOCOL) throw new Error('health_invalid');
      return payload;
    } catch {
      throw new RuntimeSpeechError('sidecar_health_failed', 'error', '本地语音服务健康检查失败');
    } finally {
      abort.dispose();
    }
  }

  transcribe(input: { audioPath: string; provider: string; model?: string }, signal?: AbortSignal): Promise<SidecarTranscriptionResult> {
    return this.request('/v1/transcribe', input, signal);
  }

  synthesize(input: {
    text: string;
    outputPath: string;
    provider: string;
    voiceProfileId?: string;
    presetSpeakerId?: string;
    voiceReferencePath?: string;
    voiceReferenceTranscript?: string;
  }, signal?: AbortSignal): Promise<SidecarSynthesisResult> {
    return this.request('/v1/synthesize', input, signal);
  }
}

interface ReadyLine {
  protocol?: string;
  status?: string;
  port?: number;
}

function stableExitCode(code: number | null, signal: NodeJS.Signals | null): string {
  if (Number.isInteger(code)) return `exit_${code}`;
  return signal && /^[A-Z0-9]+$/.test(signal) ? `signal_${signal.toLowerCase()}` : 'unknown';
}
type SidecarChild = ChildProcessByStdio<null, Readable, Readable>;
export type SpeechSidecarProcessTreeTerminator = (child: SidecarChild) => Promise<void>;

function waitForChildClose(child: ChildProcess, timeoutMs = 3_000): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('close', finish);
      child.removeListener('exit', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    child.once('close', finish);
    child.once('exit', finish);
  });
}

function runWindowsTaskkill(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      try { killer.kill('SIGKILL'); } catch { /* taskkill helper 已退出。 */ }
      finish(new Error('taskkill_timeout'));
    }, 5_000);
    timer.unref?.();
    killer.once('error', (error) => finish(error));
    killer.once('close', (code) => {
      if (code === 0 || code === 128) finish();
      else finish(new Error('taskkill_failed'));
    });
  });
}

/** Sidecar 可能再启动模型 CLI；停止必须覆盖整棵进程树。 */
export async function terminateSpeechSidecarProcessTree(child: SidecarChild): Promise<void> {
  const pid = child.pid;
  if (!Number.isInteger(pid) || pid! <= 0 || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      await runWindowsTaskkill(pid!);
    } else {
      try { process.kill(-pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* 锁继续保留，禁止新 Sidecar 并发启动。 */ }
  }
  await waitForChildClose(child);
}

export interface SpeechDependencySnapshot {
  python: ResolvedDependencyPath;
  sidecar: ResolvedDependencyPath;
}

export class SpeechSidecarSupervisor {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private client: SpeechSidecarClient | null = null;
  private startPromise: Promise<SpeechSidecarClient> | null = null;
  private readonly processTreeTerminator: SpeechSidecarProcessTreeTerminator;
  private readonly terminating = new WeakMap<SidecarChild, Promise<void>>();
  private readonly diagnostics: SpeechSidecarRuntimeDiagnostics;
  private readonly instanceLock: SpeechSidecarInstanceLock;

  constructor(private readonly options: {
    config: SpeechRuntimeConfig;
    runtimeDepsRoot: string;
    runtimeStateRoot: string;
    bundledSidecarCandidates: string[];
    fetchImpl?: typeof fetch;
    terminateProcessTree?: SpeechSidecarProcessTreeTerminator;
  }) {
    this.diagnostics = new SpeechSidecarRuntimeDiagnostics(options.runtimeStateRoot);
    this.instanceLock = new SpeechSidecarInstanceLock(options.runtimeStateRoot, this.diagnostics.runId);
    this.processTreeTerminator = options.terminateProcessTree || terminateSpeechSidecarProcessTree;
  }

  resolveDependencies(): SpeechDependencySnapshot {
    return {
      python: resolveExecutableDependency({
        id: 'python', displayName: 'Python', executableName: process.platform === 'win32' ? 'python' : 'python3',
        explicitPath: this.options.config.pythonPath, runtimeDepsRoot: this.options.runtimeDepsRoot,
      }),
      sidecar: resolveSidecarDependency({
        explicitPath: this.options.config.sidecarPath,
        runtimeDepsRoot: this.options.runtimeDepsRoot,
        bundledCandidates: this.options.bundledSidecarCandidates,
      }),
    };
  }

  async ensureClient(signal?: AbortSignal): Promise<SpeechSidecarClient> {
    if (this.client && this.child && this.child.exitCode === null) return this.client;
    if (!this.startPromise) {
      this.startPromise = this.start(signal).finally(() => { this.startPromise = null; });
    }
    return this.startPromise;
  }

  private async start(signal?: AbortSignal): Promise<SpeechSidecarClient> {
    const dependencies = this.resolveDependencies();
    for (const dependency of [dependencies.python, dependencies.sidecar]) {
      if (dependency.state !== 'ready' || !dependency.path) {
        throw new RuntimeSpeechError(
          dependency.diagnosticCode || `${dependency.id}_missing`,
          dependency.state === 'blocked' ? 'blocked' : 'optional_missing',
          `${dependency.displayName} 尚不可用`,
        );
      }
    }
    if (signal?.aborted) throw new RuntimeSpeechError('speech_request_aborted', 'error', '语音请求已取消');
    try {
      this.instanceLock.acquire();
    } catch {
      throw new RuntimeSpeechError('sidecar_instance_locked', 'blocked', '另一个 Bridge 正在使用本地语音服务');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const backendEnvironment = speechBackendEnvironment(resolveSpeechBackendDependencies(this.options.config, this.options.runtimeDepsRoot));
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(dependencies.python.path!, [
        dependencies.sidecar.path!, '--host', '127.0.0.1', '--port', '0', '--protocol', SIDECAR_PROTOCOL,
      ], {
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...backendEnvironment, CTI_SPEECH_SIDECAR_TOKEN: token },
      });
    } catch {
      this.instanceLock.release();
      throw new RuntimeSpeechError('sidecar_start_failed', 'error', '本地语音服务启动失败');
    }
    if (!child.pid) {
      // spawn 在返回无 PID 时不会加载模型；先接住异步 error，再释放本实例锁。
      child.once('error', () => undefined);
      this.instanceLock.release();
      throw new RuntimeSpeechError('sidecar_pid_missing', 'error', '本地语音服务进程身份无效');
    }
    this.child = child;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    child.stdout.on('data', (chunk: Buffer) => this.diagnostics.append('stdout', stdoutDecoder.write(chunk), [token]));
    child.stderr.on('data', (chunk: Buffer) => this.diagnostics.append('stderr', stderrDecoder.write(chunk), [token]));
    child.once('exit', () => {
      if (this.child === child) {
        this.child = null;
        this.client = null;
      }
    });
    child.once('close', (code, signal) => {
      this.diagnostics.append('stdout', stdoutDecoder.end(), [token]);
      this.diagnostics.append('stderr', stderrDecoder.end(), [token]);
      this.diagnostics.recordStopped(child.pid, stableExitCode(code, signal));
      this.instanceLock.release();
    });
    try {
      const ready = await this.waitForReadyLine(child, signal);
      const client = new SpeechSidecarClient(
        `http://127.0.0.1:${ready.port}`,
        token,
        this.options.config.requestTimeoutMs,
        this.options.fetchImpl,
        async () => this.invalidateAndTerminate(child),
      );
      await client.health(signal);
      this.diagnostics.recordStarted(child.pid, ready.port);
      this.client = client;
      return client;
    } catch (error) {
      await this.invalidateAndTerminate(child);
      if (error instanceof RuntimeSpeechError) throw error;
      throw new RuntimeSpeechError('sidecar_start_failed', 'error', '本地语音服务启动失败');
    }
  }

  private waitForReadyLine(child: ChildProcessByStdio<null, Readable, Readable>, signal?: AbortSignal): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        child.stdout.removeListener('data', data);
        child.removeListener('exit', exit);
        child.removeListener('error', failed);
        callback();
      };
      const failed = () => finish(() => reject(new Error('sidecar_start_failed')));
      const exit = () => finish(() => reject(new Error('sidecar_exited_before_ready')));
      const abort = () => finish(() => reject(new RuntimeSpeechError('speech_request_aborted', 'error', '语音请求已取消')));
      const data = (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        if (buffer.length > 16 * 1024) return failed();
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        let parsed: ReadyLine;
        try { parsed = JSON.parse(buffer.slice(0, newline)) as ReadyLine; } catch { return failed(); }
        if (parsed.protocol !== SIDECAR_PROTOCOL || parsed.status !== 'ready' || !Number.isInteger(parsed.port) || parsed.port! < 1 || parsed.port! > 65535) return failed();
        finish(() => resolve({ port: parsed.port! }));
      };
      const timer = setTimeout(failed, this.options.config.startupTimeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', data);
      child.once('exit', exit);
      child.once('error', failed);
    });
  }

  private async invalidateAndTerminate(child: SidecarChild): Promise<void> {
    if (this.child === child) {
      this.child = null;
      this.client = null;
    }
    const existing = this.terminating.get(child);
    if (existing) return existing;
    const termination = (async () => {
      await this.processTreeTerminator(child);
      // 注入终止器也必须等待 child 真正退出；否则实例锁不会释放。
      await waitForChildClose(child);
    })().finally(() => {
      this.terminating.delete(child);
    });
    this.terminating.set(child, termination);
    return termination;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.client = null;
    if (!child) return;
    await this.invalidateAndTerminate(child);
  }
}

