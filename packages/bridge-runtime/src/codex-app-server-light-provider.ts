import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire as createNodeRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/host';
import {
  buildRestrictedCodexRuntimeProfile,
  type CodexProviderProfile,
} from './codex-provider.js';
import { CTI_HOME } from './config.js';
import { sseEvent } from './sse-utils.js';

const require = createNodeRequire(import.meta.url);
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SESSION_THREADS = 16;
const DEFAULT_MAX_TURNS_PER_THREAD = 12;
const FORBIDDEN_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'webSearch',
]);

type JsonRecord = Record<string, unknown>;

interface AppServerProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  exitCode: number | null;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface SessionThread {
  threadId: string;
  turns: number;
  lastUsedAt: number;
  tail: Promise<void>;
}

interface ActiveTurn {
  threadId: string;
  turnId: string;
  text: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  };
  resolve: (value: ActiveTurnResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  abortCleanup?: () => void;
}

interface ActiveTurnResult {
  text: string;
  usage?: ActiveTurn['usage'];
}

interface CodexAppServerLightProviderOptions {
  profile?: Extract<CodexProviderProfile, 'official' | 'external'>;
  rpcTimeoutMs?: number;
  turnTimeoutMs?: number;
  maxSessionThreads?: number;
  maxTurnsPerThread?: number;
  executablePath?: string;
  spawnProcess?: (file: string, args: string[], options: Parameters<typeof spawn>[2]) => AppServerProcess;
  terminateProcess?: (child: AppServerProcess) => void;
  isolatedDirectory?: string;
  restrictedCodexHome?: string;
}

const TARGETS: Record<string, { packageName: string; triple: string }> = {
  'linux-x64': { packageName: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'linux-arm64': { packageName: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  'android-x64': { packageName: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'android-arm64': { packageName: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  'darwin-x64': { packageName: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'darwin-arm64': { packageName: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'win32-x64': { packageName: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  'win32-arm64': { packageName: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
};

export function resolveBundledCodexExecutable(
  platform = process.platform,
  arch = process.arch,
): string {
  const explicit = process.env.CTI_CODEX_APP_SERVER_EXECUTABLE?.trim();
  if (explicit) return path.resolve(explicit);
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) throw new Error(`不支持的 Codex app-server 平台：${platform}/${arch}`);
  const packageJson = require.resolve(`${target.packageName}/package.json`);
  const binary = platform === 'win32' ? 'codex.exe' : 'codex';
  return path.join(path.dirname(packageJson), 'vendor', target.triple, 'codex', binary);
}

function normalizeError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  if (value && typeof value === 'object') {
    const record = value as JsonRecord;
    if (typeof record.message === 'string' && record.message.trim()) return new Error(record.message.trim());
  }
  return new Error(typeof value === 'string' && value.trim() ? value.trim() : fallback);
}

function terminateProcessTree(child: AppServerProcess): void {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.unref();
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // 进程可能已经退出。
  }
}

function getObject(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function getString(record: JsonRecord | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getTurnError(turn: JsonRecord | null): string | undefined {
  const error = getObject(turn?.error);
  return getString(error, 'message') || getString(error, 'additionalDetails');
}

/**
 * 轻聊专用的常驻 Codex app-server Provider。
 *
 * 它只接受 classifier/response_only 回合，所有线程均为 ephemeral、只读、无网络、
 * 无工具且不挂载项目工作区；任务执行仍由 Primary Provider 独占。
 */
export class CodexAppServerLightProvider implements LLMProvider {
  private child: AppServerProcess | null = null;
  private stdoutBuffer = '';
  private stderrTail = '';
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private activeTurns = new Map<string, ActiveTurn>();
  private earlyTurnMessages = new Map<string, Array<{ method: string; params: JsonRecord }>>();
  private sessionThreads = new Map<string, SessionThread>();
  private warmThreadId: string | null = null;
  private warmupPromise: Promise<void> | null = null;
  private initialized = false;
  private disposed = false;
  private readonly profile: Extract<CodexProviderProfile, 'official' | 'external'>;
  private readonly rpcTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly maxSessionThreads: number;
  private readonly maxTurnsPerThread: number;
  private readonly executablePath: string;
  private readonly spawnProcess: NonNullable<CodexAppServerLightProviderOptions['spawnProcess']>;
  private readonly terminateProcess: NonNullable<CodexAppServerLightProviderOptions['terminateProcess']>;
  private readonly isolatedDirectory: string;
  private readonly restrictedCodexHome: string;

  constructor(options: CodexAppServerLightProviderOptions = {}) {
    this.profile = options.profile || 'official';
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.maxSessionThreads = Math.max(1, options.maxSessionThreads ?? DEFAULT_MAX_SESSION_THREADS);
    this.maxTurnsPerThread = Math.max(1, options.maxTurnsPerThread ?? DEFAULT_MAX_TURNS_PER_THREAD);
    this.executablePath = options.executablePath || resolveBundledCodexExecutable();
    this.spawnProcess = options.spawnProcess || ((file, args, spawnOptions) => (
      spawn(file, args, spawnOptions) as ChildProcessWithoutNullStreams
    ));
    this.terminateProcess = options.terminateProcess || terminateProcessTree;
    this.isolatedDirectory = path.resolve(
      options.isolatedDirectory || path.join(CTI_HOME, 'runtime', 'codex-light-chat'),
    );
    this.restrictedCodexHome = path.resolve(
      options.restrictedCodexHome
      || path.join(this.isolatedDirectory, `codex-home-${this.profile}`),
    );
  }

  warmup(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Codex app-server 已关闭'));
    if (this.initialized) return Promise.resolve();
    if (!this.warmupPromise) {
      const startedAt = Date.now();
      this.warmupPromise = this.startAndWarm()
        .then(() => {
          console.log(`[codex-app-server] 轻聊协调器已预热，耗时 ${Date.now() - startedAt}ms`);
        })
        .catch((error) => {
          this.resetAfterFailure(normalizeError(error, 'Codex app-server 预热失败'));
          throw error;
        })
        .finally(() => {
          this.warmupPromise = null;
        });
    }
    return this.warmupPromise;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream<string>({
      start: (controller) => {
        void this.streamRestrictedTurn(controller, params);
      },
      cancel: () => {
        params.abortController?.abort();
      },
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    this.child = null;
    this.initialized = false;
    this.warmThreadId = null;
    this.sessionThreads.clear();
    const error = new Error('Codex app-server 已关闭');
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const turn of this.activeTurns.values()) {
      clearTimeout(turn.timer);
      turn.reject(error);
    }
    this.activeTurns.clear();
    this.earlyTurnMessages.clear();
    if (child) this.terminateProcess(child);
  }

  private async streamRestrictedTurn(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
  ): Promise<void> {
    try {
      if (params.interactionMode !== 'classifier' && params.interactionMode !== 'response_only') {
        throw new Error('Codex app-server 轻聊 Provider 拒绝执行 Agent/工具回合');
      }
      const signal = params.abortController?.signal;
      await this.waitWithAbort(this.warmup(), signal);
      const result = await this.runSerialized(params.sessionId, () => this.runTurn(params));
      const runtimeProfile = buildRestrictedCodexRuntimeProfile(this.profile, this.restrictedCodexHome);
      controller.enqueue(sseEvent('status', {
        provider: 'codex_app_server',
        codexProfile: this.profile,
        modelSource: runtimeProfile.executionProfile.modelSource,
        model: runtimeProfile.executionProfile.submittedModel,
        persistentProcess: true,
      }));
      controller.enqueue(sseEvent('text', result.text));
      controller.enqueue(sseEvent('result', result.usage ? { usage: result.usage } : {}));
      controller.close();
    } catch (error) {
      const message = normalizeError(error, 'Codex app-server 轻聊失败').message;
      try {
        controller.enqueue(sseEvent('error', message));
        controller.close();
      } catch {
        // 上游超时取消后 controller 可能已经关闭。
      }
    }
  }

  private async startAndWarm(): Promise<void> {
    fs.mkdirSync(this.isolatedDirectory, { recursive: true });
    await this.ensureProcess();
    if (!this.warmThreadId) this.warmThreadId = await this.startThread();
  }

  private async ensureProcess(): Promise<void> {
    if (this.initialized && this.child && this.child.exitCode === null) return;
    if (this.disposed) throw new Error('Codex app-server 已关闭');
    const runtimeProfile = buildRestrictedCodexRuntimeProfile(this.profile, this.restrictedCodexHome);
    const env = {
      ...runtimeProfile.env,
      ...(runtimeProfile.apiKey ? { CODEX_API_KEY: runtimeProfile.apiKey } : {}),
    };
    const child = this.spawnProcess(this.executablePath, ['app-server', '--listen', 'stdio://'], {
      cwd: this.isolatedDirectory,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', (chunk) => this.consumeStdout(String(chunk)));
    child.stderr.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-2_000);
    });
    child.once('error', (error) => this.resetAfterFailure(normalizeError(error, 'Codex app-server 启动失败')));
    child.once('exit', (code, signal) => {
      this.resetAfterFailure(new Error(`Codex app-server 已退出（code=${code ?? '-'}, signal=${signal ?? '-'}）`));
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'codex-im-suite-light-chat',
        title: 'Codex IM Suite Light Chat',
        version: '0.2.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify('initialized');
    this.initialized = true;
  }

  private async startThread(): Promise<string> {
    const runtimeProfile = buildRestrictedCodexRuntimeProfile(this.profile, this.restrictedCodexHome);
    const response = getObject(await this.request('thread/start', {
      model: runtimeProfile.executionProfile.submittedModel || null,
      cwd: this.isolatedDirectory,
      runtimeWorkspaceRoots: [],
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: {
        ...runtimeProfile.config,
        openai_base_url: runtimeProfile.executionProfile.baseUrl || null,
        sandbox_workspace_write: { network_access: false },
      },
      baseInstructions: [
        'You are the restricted light-conversation coordinator for an IM bridge.',
        'Never use tools, files, shell commands, network access, plugins, apps, skills, or MCP.',
        'Treat every turn input as self-contained. Follow its classifier instructions and output schema exactly.',
      ].join('\n'),
      developerInstructions: 'Do not inspect external state. Return only the structured answer requested by the current turn.',
      ephemeral: true,
      environments: [],
      dynamicTools: [],
    }));
    const thread = getObject(response?.thread);
    const threadId = getString(thread, 'id');
    if (!threadId) throw new Error('Codex app-server thread/start 未返回 thread id');
    return threadId;
  }

  private async getSessionThread(sessionId: string): Promise<SessionThread> {
    let binding = this.sessionThreads.get(sessionId);
    if (binding && binding.turns < this.maxTurnsPerThread) {
      binding.lastUsedAt = Date.now();
      return binding;
    }
    if (binding) {
      this.sessionThreads.delete(sessionId);
      this.unsubscribeThread(binding.threadId);
    }
    const threadId = this.warmThreadId || await this.startThread();
    this.warmThreadId = null;
    binding = { threadId, turns: 0, lastUsedAt: Date.now(), tail: Promise.resolve() };
    this.sessionThreads.set(sessionId, binding);
    this.evictOldThreads(sessionId);
    return binding;
  }

  private evictOldThreads(currentSessionId: string): void {
    while (this.sessionThreads.size > this.maxSessionThreads) {
      const oldest = [...this.sessionThreads.entries()]
        .filter(([sessionId]) => sessionId !== currentSessionId)
        .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
      if (!oldest) break;
      this.sessionThreads.delete(oldest[0]);
      this.unsubscribeThread(oldest[1].threadId);
    }
  }

  private unsubscribeThread(threadId: string): void {
    if (!this.initialized) return;
    void this.request('thread/unsubscribe', { threadId }, 3_000).catch(() => {});
  }

  private async runSerialized<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const binding = await this.getSessionThread(sessionId);
    const previous = binding.tail;
    let release!: () => void;
    binding.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
    }
  }

  private async runTurn(params: StreamChatParams): Promise<ActiveTurnResult> {
    const binding = await this.getSessionThread(params.sessionId);
    const prompt = [
      params.systemPrompt?.trim() ? `Classifier instructions:\n${params.systemPrompt.trim()}` : '',
      `Classifier input:\n${params.prompt.trim()}`,
    ].filter(Boolean).join('\n\n');
    const response = getObject(await this.request('turn/start', {
      threadId: binding.threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      cwd: this.isolatedDirectory,
      runtimeWorkspaceRoots: [],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      effort: 'low',
      outputSchema: params.responseSchema || null,
      environments: [],
    }));
    const turn = getObject(response?.turn);
    const turnId = getString(turn, 'id');
    if (!turnId) throw new Error('Codex app-server turn/start 未返回 turn id');
    binding.lastUsedAt = Date.now();

    try {
      const result = await new Promise<ActiveTurnResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.activeTurns.delete(turnId);
          active.abortCleanup?.();
          void this.request('turn/interrupt', { threadId: binding.threadId, turnId }, 3_000).catch(() => {});
          reject(new Error('Codex app-server 轻聊回合超时'));
        }, this.turnTimeoutMs);
        const active: ActiveTurn = {
          threadId: binding.threadId,
          turnId,
          text: '',
          resolve,
          reject,
          timer,
        };
        this.activeTurns.set(turnId, active);

        const signal = params.abortController?.signal;
        if (signal) {
          const abort = () => {
            if (!this.activeTurns.delete(turnId)) return;
            clearTimeout(timer);
            void this.request('turn/interrupt', { threadId: binding.threadId, turnId }, 3_000).catch(() => {});
            const error = new Error('Codex app-server 轻聊已取消');
            error.name = 'AbortError';
            reject(error);
          };
          active.abortCleanup = () => signal.removeEventListener('abort', abort);
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        }
        this.replayEarlyTurnMessages(turnId);
      });
      binding.turns += 1;
      return result;
    } catch (error) {
      if (this.sessionThreads.get(params.sessionId) === binding) {
        this.sessionThreads.delete(params.sessionId);
        this.unsubscribeThread(binding.threadId);
      }
      throw error;
    }
  }

  private request(method: string, params: unknown, timeoutMs = this.rpcTimeoutMs): Promise<unknown> {
    const child = this.child;
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      return Promise.reject(new Error('Codex app-server 未运行'));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server RPC 超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (!error) return;
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        clearTimeout(request.timer);
        request.reject(normalizeError(error, `Codex app-server RPC 写入失败：${method}`));
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    const child = this.child;
    if (!child || child.exitCode !== null || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line) as JsonRecord);
      } catch (error) {
        this.resetAfterFailure(normalizeError(error, 'Codex app-server 返回了无效 NDJSON'));
      }
    }
  }

  private handleMessage(message: JsonRecord): void {
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(normalizeError(message.error, 'Codex app-server RPC 失败'));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      this.resetAfterFailure(new Error(`Codex app-server 受限回合触发了服务端请求：${message.method}`));
      return;
    }
    const method = typeof message.method === 'string' ? message.method : '';
    const params = getObject(message.params);
    if (!method || !params) return;

    this.handleNotification(method, params);
  }

  private handleNotification(method: string, params: JsonRecord, allowBuffer = true): void {

    if (method === 'item/agentMessage/delta') {
      const turnId = getString(params, 'turnId');
      const active = turnId ? this.activeTurns.get(turnId) : undefined;
      if (!active && turnId && allowBuffer) {
        this.bufferEarlyTurnMessage(turnId, method, params);
        return;
      }
      if (active && typeof params.delta === 'string') active.text += params.delta;
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const turnId = getString(params, 'turnId');
      const active = turnId ? this.activeTurns.get(turnId) : undefined;
      if (!active && turnId && allowBuffer) {
        this.bufferEarlyTurnMessage(turnId, method, params);
        return;
      }
      const tokenUsage = getObject(params.tokenUsage);
      const last = getObject(tokenUsage?.last);
      if (active && last) {
        active.usage = {
          input_tokens: Number(last.inputTokens || 0),
          output_tokens: Number(last.outputTokens || 0),
          cache_read_input_tokens: Number(last.cachedInputTokens || 0),
        };
      }
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const turnId = getString(params, 'turnId');
      const active = turnId ? this.activeTurns.get(turnId) : undefined;
      if (!active && turnId && allowBuffer) {
        this.bufferEarlyTurnMessage(turnId, method, params);
        return;
      }
      const item = getObject(params.item);
      const itemType = getString(item, 'type');
      if (active && itemType && FORBIDDEN_ITEM_TYPES.has(itemType)) {
        this.failActiveTurn(active, new Error(`Codex app-server 轻聊尝试了禁用工具：${itemType}`));
      }
      return;
    }
    if (method === 'turn/completed') {
      const turn = getObject(params.turn);
      const turnId = getString(turn, 'id');
      const active = turnId ? this.activeTurns.get(turnId) : undefined;
      if (!active && turnId && allowBuffer) {
        this.bufferEarlyTurnMessage(turnId, method, params);
        return;
      }
      if (!active) return;
      const status = getString(turn, 'status');
      if (status !== 'completed') {
        this.failActiveTurn(active, new Error(getTurnError(turn) || `Codex app-server 回合状态：${status || 'unknown'}`));
        return;
      }
      if (!active.text.trim()) {
        const items = Array.isArray(turn?.items) ? turn.items : [];
        const finalMessage = [...items].reverse()
          .map((item) => getObject(item))
          .find((item) => getString(item, 'type') === 'agentMessage');
        active.text = getString(finalMessage || null, 'text') || '';
      }
      this.activeTurns.delete(active.turnId);
      clearTimeout(active.timer);
      active.abortCleanup?.();
      if (!active.text.trim()) active.reject(new Error('Codex app-server 未返回轻聊裁决'));
      else active.resolve({ text: active.text.trim(), usage: active.usage });
      return;
    }
    if (method === 'error') {
      const turnId = getString(params, 'turnId');
      const active = turnId ? this.activeTurns.get(turnId) : undefined;
      if (!active && turnId && allowBuffer) {
        this.bufferEarlyTurnMessage(turnId, method, params);
        return;
      }
      if (active) this.failActiveTurn(active, normalizeError(params.error || params, 'Codex app-server 回合失败'));
    }
  }

  private bufferEarlyTurnMessage(turnId: string, method: string, params: JsonRecord): void {
    const queued = this.earlyTurnMessages.get(turnId) || [];
    queued.push({ method, params });
    this.earlyTurnMessages.set(turnId, queued.slice(-32));
  }

  private replayEarlyTurnMessages(turnId: string): void {
    const queued = this.earlyTurnMessages.get(turnId);
    if (!queued) return;
    this.earlyTurnMessages.delete(turnId);
    for (const message of queued) this.handleNotification(message.method, message.params, false);
  }

  private failActiveTurn(active: ActiveTurn, error: Error): void {
    this.activeTurns.delete(active.turnId);
    clearTimeout(active.timer);
    active.abortCleanup?.();
    void this.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }, 3_000).catch(() => {});
    active.reject(error);
  }

  private resetAfterFailure(error: Error): void {
    const child = this.child;
    this.child = null;
    this.initialized = false;
    this.warmThreadId = null;
    this.sessionThreads.clear();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const turn of this.activeTurns.values()) {
      clearTimeout(turn.timer);
      turn.reject(error);
    }
    this.activeTurns.clear();
    this.earlyTurnMessages.clear();
    if (child && child.exitCode === null && !child.killed) this.terminateProcess(child);
    if (!this.disposed && this.stderrTail.trim()) {
      console.warn(`[codex-app-server] ${error.message}; stderr=${this.stderrTail.trim().slice(-600)}`);
    }
    this.stderrTail = '';
  }

  private async waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) {
      const error = new Error('Codex app-server 轻聊已取消');
      error.name = 'AbortError';
      throw error;
    }
    return await new Promise<T>((resolve, reject) => {
      const abort = () => {
        const error = new Error('Codex app-server 轻聊已取消');
        error.name = 'AbortError';
        reject(error);
      };
      signal.addEventListener('abort', abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
}
