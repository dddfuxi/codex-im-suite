import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AgentTaskRequest,
  AgentTaskResult,
  AgentWorkerMessage,
  AgentWorkerView,
} from '@codex-im-suite/contracts';

import type { Config } from '../config.js';
import type { AgentManifestRegistry } from './manifest-registry.js';
import { normalizeAgentTaskResult, validateAgentTaskRequest } from './protocol.js';
import type { RestrictedWorkerProviderConfig } from './restricted-provider.js';
import type { AgentCollaborationStateStore } from './state-store.js';

const HEARTBEAT_TIMEOUT_MS = 30_000;
const CIRCUIT_OPEN_MS = 5 * 60_000;
const RESTART_BACKOFF_MS = [1_000, 5_000, 30_000];

interface PendingTask {
  request: AgentTaskRequest;
  allowedEvidenceIds: ReadonlySet<string>;
  resolve: (result: AgentTaskResult) => void;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
  timeout?: ReturnType<typeof setTimeout>;
  workerId?: string;
  settled: boolean;
}

interface WorkerSlot {
  view: AgentWorkerView;
  child?: ChildProcessWithoutNullStreams;
  stdoutBuffer: string;
  consecutiveFailures: number;
  restartTimer?: ReturnType<typeof setTimeout>;
  pendingTask?: PendingTask;
  stopping: boolean;
}

export interface AgentWorkerSupervisorOptions {
  config: Config;
  registry: AgentManifestRegistry;
  stateStore: AgentCollaborationStateStore;
}

export function getWorkerRestartBackoffMs(consecutiveFailures: number): number {
  return RESTART_BACKOFF_MS[Math.min(RESTART_BACKOFF_MS.length - 1, Math.max(0, consecutiveFailures - 1))];
}

export function isWorkerHeartbeatExpired(lastHeartbeatAt: string | undefined, now = Date.now()): boolean {
  if (!lastHeartbeatAt) return true;
  const heartbeatAt = Date.parse(lastHeartbeatAt);
  return !Number.isFinite(heartbeatAt) || now - heartbeatAt > HEARTBEAT_TIMEOUT_MS;
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    });
    return;
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

function workerCommand(): { command: string; args: string[] } {
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDir = path.dirname(modulePath);
  const bundled = path.join(moduleDir, 'agent-worker.mjs');
  if (fs.existsSync(bundled)) return { command: process.execPath, args: [bundled] };
  const source = modulePath.endsWith('.ts')
    ? path.join(moduleDir, 'worker-entry.ts')
    : path.resolve(moduleDir, '..', 'src', 'agent-workers', 'worker-entry.ts');
  return { command: process.execPath, args: ['--import', 'tsx', source] };
}

function safeWorkerEnvironment(bootstrap: unknown): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (/^(?:ANTHROPIC_|OPENAI_|CODEX_)/u.test(key)) env[key] = value;
  }
  env.CTI_AGENT_WORKER_CONFIG_B64 = Buffer.from(JSON.stringify(bootstrap), 'utf8').toString('base64');
  return env;
}

export function buildRestrictedWorkerProviderConfig(config: Config, workerId: string): RestrictedWorkerProviderConfig {
  return {
    runtime: config.runtime,
    workerId,
    claudeExecutable: process.env.CTI_CLAUDE_CODE_EXECUTABLE,
    codexModelSource: config.codexModelSource,
    codexBaseUrl: config.codexBaseUrl,
    codexApiKey: config.codexApiKey,
    codexModel: config.codexModel,
    codexPassModel: config.codexPassModel,
    codexReasoningEffort: config.codexReasoningEffort,
    localAiKind: config.localAiKind,
    localAiBaseUrl: config.localAiBaseUrl,
    localAiModel: config.localAiModel,
    localAiApiKey: config.localAiApiKey,
    localAiTimeoutMs: config.localAiTimeoutMs,
  };
}

export class AgentWorkerSupervisor {
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: PendingTask[] = [];
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private stopping = false;

  constructor(private readonly options: AgentWorkerSupervisorOptions) {
    const size = Math.max(1, Math.min(4, options.config.agentWorkerPoolSize || 2));
    for (let index = 0; index < size; index += 1) {
      this.slots.push({
        view: {
          workerId: `agent-worker-${index + 1}`,
          health: 'stopped',
          restartCount: 0,
          timeoutCount: 0,
          circuitOpenCount: 0,
        },
        stdoutBuffer: '',
        consecutiveFailures: 0,
        stopping: false,
      });
    }
  }

  start(): void {
    if (this.options.config.agentCollaborationMode === 'off' || this.stopping) {
      this.publishWorkers();
      return;
    }
    for (const slot of this.slots) this.spawnSlot(slot);
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), 5_000);
    this.heartbeatTimer.unref();
  }

  async executeTask(
    request: AgentTaskRequest,
    allowedEvidenceIds: ReadonlySet<string>,
    abortSignal?: AbortSignal,
  ): Promise<AgentTaskResult> {
    const validation = validateAgentTaskRequest(request, this.options.registry);
    if (!validation.ok) return this.failedResult(request, validation.errorCode);
    if (this.stopping) return this.failedResult(request, 'supervisor_stopping', 'cancelled');
    return await new Promise<AgentTaskResult>((resolve) => {
      const task: PendingTask = { request, allowedEvidenceIds, resolve, abortSignal, settled: false };
      if (abortSignal?.aborted) {
        task.settled = true;
        resolve(this.failedResult(request, 'task_cancelled', 'cancelled'));
        return;
      }
      task.abortHandler = () => this.cancelTask(task, 'task_cancelled');
      abortSignal?.addEventListener('abort', task.abortHandler, { once: true });
      this.queue.push(task);
      this.dispatch();
    });
  }

  async stop(reason = 'bridge stopping'): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const task of [...this.queue]) this.settleTask(task, this.failedResult(task.request, 'supervisor_stopping', 'cancelled'));
    this.queue.length = 0;
    const exits = this.slots.map(async (slot) => {
      slot.stopping = true;
      if (slot.pendingTask) {
        this.settleTask(slot.pendingTask, this.failedResult(slot.pendingTask.request, 'supervisor_stopping', 'cancelled'));
      }
      if (!slot.child) return;
      try {
        slot.child.stdin.write(`${JSON.stringify({ protocol: 'codex-im-suite/agent-worker/v1', type: 'shutdown', reason })}\n`);
      } catch { /* process already closed */ }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (slot.child) terminateProcessTree(slot.child);
          resolve();
        }, 5_000);
        slot.child?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      slot.child = undefined;
      slot.view.health = 'stopped';
      slot.view.activeTaskId = undefined;
    });
    await Promise.all(exits);
    this.publishWorkers();
  }

  private spawnSlot(slot: WorkerSlot): void {
    if (this.stopping || slot.stopping) return;
    const circuitUntil = slot.view.circuitOpenUntil ? Date.parse(slot.view.circuitOpenUntil) : 0;
    if (circuitUntil > Date.now()) {
      slot.view.health = 'circuit_open';
      this.publishWorkers();
      const delay = circuitUntil - Date.now();
      slot.restartTimer = setTimeout(() => {
        slot.view.circuitOpenUntil = undefined;
        slot.consecutiveFailures = 0;
        this.spawnSlot(slot);
      }, delay);
      slot.restartTimer.unref();
      return;
    }
    const command = workerCommand();
    const bootstrap = {
      workerId: slot.view.workerId,
      provider: buildRestrictedWorkerProviderConfig(this.options.config, slot.view.workerId),
      manifests: this.options.registry.manifests,
    };
    slot.view.health = 'starting';
    slot.view.startedAt = new Date().toISOString();
    slot.view.lastHeartbeatAt = slot.view.startedAt;
    const child = spawn(command.command, command.args, {
      env: safeWorkerEnvironment(bootstrap),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    slot.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(slot, chunk));
    child.stderr.on('data', (chunk: string) => {
      const line = chunk.trim();
      if (line) console.warn(`[agent-worker:${slot.view.workerId}] ${line.slice(0, 2_000)}`);
    });
    child.on('error', (error) => {
      if (slot.child !== child) return;
      this.onWorkerFailure(slot, 'worker_spawn_failed', error);
    });
    child.on('exit', (code, signal) => {
      if (slot.child !== child) return;
      slot.child = undefined;
      if (slot.stopping || this.stopping) return;
      this.onWorkerFailure(slot, 'worker_exited', new Error(`code=${code ?? 'null'}, signal=${signal ?? 'none'}`));
    });
    this.publishWorkers();
  }

  private onStdout(slot: WorkerSlot, chunk: string): void {
    slot.stdoutBuffer += chunk;
    let newline = slot.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = slot.stdoutBuffer.slice(0, newline).trim();
      slot.stdoutBuffer = slot.stdoutBuffer.slice(newline + 1);
      if (line) this.handleWorkerLine(slot, line);
      newline = slot.stdoutBuffer.indexOf('\n');
    }
  }

  private handleWorkerLine(slot: WorkerSlot, line: string): void {
    let message: AgentWorkerMessage;
    try {
      message = JSON.parse(line) as AgentWorkerMessage;
    } catch (error) {
      this.onWorkerFailure(slot, 'invalid_worker_stdout', error);
      return;
    }
    if (message.protocol !== 'codex-im-suite/agent-worker/v1') {
      this.onWorkerFailure(slot, 'invalid_worker_protocol', new Error('protocol mismatch'));
      return;
    }
    if (message.type === 'hello') {
      slot.view.pid = message.pid;
      slot.view.health = 'online';
      slot.view.lastHeartbeatAt = message.at;
      this.publishWorkers();
      this.dispatch();
      return;
    }
    if (message.type === 'heartbeat') {
      slot.view.lastHeartbeatAt = message.at;
      slot.view.health = slot.pendingTask ? 'busy' : 'online';
      this.publishWorkers();
      return;
    }
    if (message.type !== 'result') return;
    const task = slot.pendingTask;
    if (!task || task.request.taskId !== message.result.taskId) {
      this.onWorkerFailure(slot, 'unexpected_worker_result', new Error(message.result.taskId));
      return;
    }
    const normalized = message.result.status === 'succeeded'
      ? normalizeAgentTaskResult(task.request, message.result.output, message.result.metrics, task.allowedEvidenceIds)
      : { ...message.result, evidenceRefs: [], promptSections: [], output: undefined };
    slot.pendingTask = undefined;
    slot.consecutiveFailures = 0;
    slot.view.activeTaskId = undefined;
    slot.view.health = 'online';
    this.settleTask(task, normalized);
    this.publishWorkers();
    this.dispatch();
  }

  private dispatch(): void {
    if (this.stopping) return;
    for (const slot of this.slots) {
      if (slot.pendingTask || slot.view.health !== 'online' || !slot.child) continue;
      const task = this.queue.shift();
      if (!task) break;
      if (task.abortSignal?.aborted) {
        this.settleTask(task, this.failedResult(task.request, 'task_cancelled', 'cancelled'));
        continue;
      }
      slot.pendingTask = task;
      task.workerId = slot.view.workerId;
      slot.view.activeTaskId = task.request.taskId;
      slot.view.health = 'busy';
      const manifest = this.options.registry.byId.get(task.request.agentId);
      const deadlineMs = Math.max(1, Date.parse(task.request.deadlineAt) - Date.now());
      const timeoutMs = Math.max(1, Math.min(
        deadlineMs,
        manifest?.timeoutMs || this.options.config.agentTaskTimeoutMs || 30_000,
        this.options.config.agentTaskTimeoutMs || 30_000,
      ));
      task.timeout = setTimeout(() => {
        slot.view.timeoutCount += 1;
        this.settleTask(task, this.failedResult(task.request, 'task_timed_out', 'timed_out'));
        slot.pendingTask = undefined;
        slot.view.activeTaskId = undefined;
        if (slot.child) terminateProcessTree(slot.child);
      }, timeoutMs);
      slot.child.stdin.write(`${JSON.stringify({
        protocol: 'codex-im-suite/agent-worker/v1',
        type: 'task',
        request: task.request,
      } satisfies AgentWorkerMessage)}\n`);
      this.publishWorkers();
    }
  }

  private cancelTask(task: PendingTask, errorCode: string): void {
    if (task.settled) return;
    const slot = this.slots.find((item) => item.pendingTask === task);
    if (slot?.child) {
      try {
        slot.child.stdin.write(`${JSON.stringify({
          protocol: 'codex-im-suite/agent-worker/v1',
          type: 'cancel',
          taskId: task.request.taskId,
          reason: errorCode,
        } satisfies AgentWorkerMessage)}\n`);
      } catch { /* worker already exited */ }
      slot.pendingTask = undefined;
      slot.view.activeTaskId = undefined;
      slot.view.health = 'online';
    } else {
      const index = this.queue.indexOf(task);
      if (index >= 0) this.queue.splice(index, 1);
    }
    this.settleTask(task, this.failedResult(task.request, errorCode, 'cancelled'));
    this.publishWorkers();
    this.dispatch();
  }

  private onWorkerFailure(slot: WorkerSlot, errorCode: string, error: unknown): void {
    if (slot.stopping || this.stopping) return;
    slot.consecutiveFailures += 1;
    slot.view.restartCount += 1;
    slot.view.lastErrorCode = errorCode;
    slot.view.health = 'restarting';
    if (slot.pendingTask) {
      this.settleTask(slot.pendingTask, this.failedResult(slot.pendingTask.request, errorCode));
      slot.pendingTask = undefined;
      slot.view.activeTaskId = undefined;
    }
    if (slot.child) {
      const child = slot.child;
      slot.child = undefined;
      terminateProcessTree(child);
    }
    console.warn(`[agent-worker-supervisor] ${slot.view.workerId} ${errorCode}: ${error instanceof Error ? error.message : String(error)}`);
    if (slot.consecutiveFailures >= 3) {
      slot.view.health = 'circuit_open';
      slot.view.circuitOpenCount += 1;
      slot.view.circuitOpenUntil = new Date(Date.now() + CIRCUIT_OPEN_MS).toISOString();
      this.publishWorkers();
      this.spawnSlot(slot);
      return;
    }
    const delay = getWorkerRestartBackoffMs(slot.consecutiveFailures);
    this.publishWorkers();
    slot.restartTimer = setTimeout(() => this.spawnSlot(slot), delay);
    slot.restartTimer.unref();
  }

  private checkHeartbeats(): void {
    for (const slot of this.slots) {
      if (!slot.child || !['online', 'busy', 'starting'].includes(slot.view.health)) continue;
      if (!isWorkerHeartbeatExpired(slot.view.lastHeartbeatAt)) continue;
      slot.view.health = 'unresponsive';
      this.publishWorkers();
      this.onWorkerFailure(slot, 'worker_heartbeat_timeout', new Error('30s without heartbeat'));
    }
  }

  private settleTask(task: PendingTask, result: AgentTaskResult): void {
    if (task.settled) return;
    task.settled = true;
    if (task.timeout) clearTimeout(task.timeout);
    if (task.abortHandler) task.abortSignal?.removeEventListener('abort', task.abortHandler);
    task.resolve(result);
  }

  private failedResult(
    request: AgentTaskRequest,
    errorCode: string,
    status: AgentTaskResult['status'] = 'failed',
  ): AgentTaskResult {
    const timestamp = new Date().toISOString();
    return {
      protocol: 'codex-im-suite/agent-worker/v1',
      runId: request.runId,
      turnId: request.turnId,
      taskId: request.taskId,
      agentId: request.agentId,
      capability: request.capability,
      status,
      findings: [],
      evidenceRefs: [],
      promptSections: [],
      metrics: { startedAt: timestamp, endedAt: timestamp, durationMs: 0 },
      errorCode,
      errorSummary: errorCode,
    };
  }

  private publishWorkers(): void {
    this.options.stateStore.setWorkers(this.slots.map((slot) => ({ ...slot.view })));
  }
}
