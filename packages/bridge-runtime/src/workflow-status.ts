import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME } from './config.js';

export type WorkflowStage =
  | 'received'
  | 'authorized'
  | 'contextualized'
  | 'routed'
  | 'executing'
  | 'finalizing'
  | 'delivered'
  | 'failed';

export interface WorkflowEvent {
  id: string;
  runId: string;
  stage: WorkflowStage;
  type: string;
  message: string;
  at: string;
  data?: Record<string, unknown>;
}

export interface WorkflowRun {
  id: string;
  sessionId: string;
  channelType?: string;
  chatId?: string;
  promptPreview: string;
  stage: WorkflowStage;
  status: 'running' | 'succeeded' | 'failed' | 'retry_pending' | 'retrying';
  executorId?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  error?: string;
  recovery?: WorkflowRecoveryState;
  retry?: WorkflowRetryState;
  events: WorkflowEvent[];
}

export interface WorkflowRecoveryInput {
  prompt: string;
  workingDirectory?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: string;
  channelType?: string;
  chatId?: string;
  userId?: string;
  userDisplayName?: string;
  messageId?: string;
}

export interface WorkflowRecoveryState {
  kind: 'recoverable' | 'not_recoverable';
  reason: string;
  input?: WorkflowRecoveryInput;
  runtimeRunId?: string;
  markedAt: string;
}

export interface WorkflowRetryState {
  status: 'none' | 'auto_pending' | 'manual_pending' | 'retrying' | 'succeeded' | 'failed' | 'exhausted' | 'unavailable';
  attempts: number;
  maxAttempts: number;
  requestedBy?: 'auto' | 'manual';
  requestedAt?: string;
  claimedBy?: string;
  claimedAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
}

export interface WorkflowStatusFile {
  protocol: 'workflow-runtime/v1';
  updatedAt: string;
  runs: WorkflowRun[];
}

const STATUS_PATH = path.join(CTI_HOME, 'runtime', 'workflow-runs.json');
const MAX_RUNS = 80;
const MAX_EVENTS_PER_RUN = 80;
const DEFAULT_MAX_AUTO_ATTEMPTS = 1;
const MAX_RECOVERY_PROMPT_CHARS = 12_000;

function nowIso(): string {
  return new Date().toISOString();
}

function preview(text: string, limit = 180): string {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized;
}

function truncateRecoveryText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.length > MAX_RECOVERY_PROMPT_CHARS
    ? `${text.slice(0, MAX_RECOVERY_PROMPT_CHARS - 3)}...`
    : text;
}

function getAutoRetryMaxAgeMs(): number {
  const fallback = 6 * 60 * 60 * 1000;
  return Math.max(1, Number.parseInt(process.env.CTI_WORKFLOW_AUTO_RETRY_MAX_AGE_MS || `${fallback}`, 10) || fallback);
}

function isAutoRetryStillFresh(run: WorkflowRun): boolean {
  const retry = run.retry;
  if (retry?.status !== 'auto_pending') return true;
  const requestedAt = retry.requestedAt || run.updatedAt || run.endedAt || run.startedAt;
  const requestedAtMs = Date.parse(requestedAt || '');
  if (!Number.isFinite(requestedAtMs)) return true;
  return (Date.now() - requestedAtMs) <= getAutoRetryMaxAgeMs();
}

function makeRetryState(
  status: WorkflowRetryState['status'],
  attempts: number,
  maxAttempts: number,
  requestedBy?: WorkflowRetryState['requestedBy'],
  reason?: string,
): WorkflowRetryState {
  const timestamp = nowIso();
  return {
    status,
    attempts,
    maxAttempts,
    requestedBy,
    requestedAt: status === 'auto_pending' || status === 'manual_pending' ? timestamp : undefined,
    lastError: reason,
  };
}

export function getWorkflowStatusPath(): string {
  return STATUS_PATH;
}

export function readWorkflowStatus(): WorkflowStatusFile {
  try {
    if (!fs.existsSync(STATUS_PATH)) {
      return { protocol: 'workflow-runtime/v1', updatedAt: nowIso(), runs: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf-8')) as Partial<WorkflowStatusFile>;
    return {
      protocol: 'workflow-runtime/v1',
      updatedAt: parsed.updatedAt || nowIso(),
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch {
    return { protocol: 'workflow-runtime/v1', updatedAt: nowIso(), runs: [] };
  }
}

function writeWorkflowStatus(next: WorkflowStatusFile): WorkflowStatusFile {
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
  const tmp = `${STATUS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...next, updatedAt: nowIso() }, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_PATH);
  return next;
}

function event(runId: string, stage: WorkflowStage, type: string, message: string, data?: Record<string, unknown>): WorkflowEvent {
  return {
    id: crypto.randomUUID(),
    runId,
    stage,
    type,
    message,
    at: nowIso(),
    data,
  };
}

export function startWorkflowRun(data: {
  sessionId: string;
  prompt: string;
  channelType?: string;
  chatId?: string;
}): WorkflowRun {
  const timestamp = nowIso();
  const run: WorkflowRun = {
    id: crypto.randomUUID(),
    sessionId: data.sessionId,
    channelType: data.channelType,
    chatId: data.chatId,
    promptPreview: preview(data.prompt),
    stage: 'received',
    status: 'running',
    startedAt: timestamp,
    updatedAt: timestamp,
    events: [],
  };
  run.events.push(event(run.id, 'received', 'workflow.received', '请求进入 workflow'));
  const current = readWorkflowStatus();
  writeWorkflowStatus({
    protocol: 'workflow-runtime/v1',
    updatedAt: timestamp,
    runs: [...current.runs, run].slice(-MAX_RUNS),
  });
  return run;
}

export function recordWorkflowRecoveryInfo(
  runId: string,
  input: WorkflowRecoveryInput & { maxAutoAttempts?: number },
): WorkflowRun | null {
  const current = readWorkflowStatus();
  const index = current.runs.findIndex((run) => run.id === runId);
  if (index < 0) return null;
  const timestamp = nowIso();
  const run = {
    ...current.runs[index],
    channelType: input.channelType || current.runs[index].channelType,
    chatId: input.chatId || current.runs[index].chatId,
    updatedAt: timestamp,
    recovery: {
      kind: 'recoverable' as const,
      reason: '运行时已持久化最小重试输入',
      input: {
        prompt: truncateRecoveryText(input.prompt) || '',
        workingDirectory: input.workingDirectory,
        model: input.model,
        systemPrompt: truncateRecoveryText(input.systemPrompt),
        permissionMode: input.permissionMode,
        channelType: input.channelType || current.runs[index].channelType,
        chatId: input.chatId || current.runs[index].chatId,
        userId: input.userId,
        userDisplayName: input.userDisplayName,
        messageId: input.messageId,
      },
      markedAt: timestamp,
    },
    retry: {
      status: 'none' as const,
      attempts: current.runs[index].retry?.attempts || 0,
      maxAttempts: Math.max(0, input.maxAutoAttempts ?? current.runs[index].retry?.maxAttempts ?? DEFAULT_MAX_AUTO_ATTEMPTS),
    },
  };
  const runs = [...current.runs];
  runs[index] = run;
  writeWorkflowStatus({ ...current, runs });
  return run;
}

export function markInterruptedWorkflowRuns(runtimeRunId: string): WorkflowRun[] {
  const current = readWorkflowStatus();
  const timestamp = nowIso();
  let changed = false;
  const marked: WorkflowRun[] = [];
  const runs = current.runs.map((run) => {
    if (run.status !== 'running') return run;
    changed = true;
    const input = run.recovery?.input;
    const retryAttempts = run.retry?.attempts || 0;
    const maxAttempts = run.retry?.maxAttempts ?? DEFAULT_MAX_AUTO_ATTEMPTS;
    const recoverable = !!input?.prompt && retryAttempts < maxAttempts;
    const next: WorkflowRun = {
      ...run,
      stage: 'failed',
      status: recoverable ? 'retry_pending' : 'failed',
      error: recoverable
        ? 'bridge 重启时发现上一轮仍在处理中，已排队自动重试。'
        : 'bridge 重启时发现上一轮仍在处理中，但缺少可重试输入。',
      updatedAt: timestamp,
      endedAt: timestamp,
      recovery: {
        kind: recoverable ? 'recoverable' : 'not_recoverable',
        reason: recoverable ? 'bridge 重启后可用持久化输入重试' : '缺少 prompt 等最小恢复信息',
        input,
        runtimeRunId,
        markedAt: timestamp,
      },
      retry: recoverable
        ? makeRetryState('auto_pending', retryAttempts, maxAttempts, 'auto', 'bridge 重启自动重试')
        : makeRetryState('unavailable', retryAttempts, maxAttempts, undefined, '缺少可重试输入'),
      events: [
        ...run.events,
        event(run.id, 'failed', recoverable ? 'workflow.interrupted.recoverable' : 'workflow.interrupted.not_recoverable', recoverable ? 'bridge 重启，自动重试已排队' : 'bridge 重启，但该 run 不可恢复', {
          runtimeRunId,
          retryable: recoverable,
        }),
      ].slice(-MAX_EVENTS_PER_RUN),
    };
    marked.push(next);
    return next;
  });
  if (changed) {
    writeWorkflowStatus({ ...current, runs });
  }
  return marked;
}

export function appendWorkflowEvent(
  runId: string,
  stage: WorkflowStage,
  type: string,
  message: string,
  data?: Record<string, unknown>,
): WorkflowRun | null {
  const current = readWorkflowStatus();
  const index = current.runs.findIndex((run) => run.id === runId);
  if (index < 0) return null;
  const nextEvent = event(runId, stage, type, message, data);
  const run = {
    ...current.runs[index],
    stage,
    updatedAt: nowIso(),
    events: [...current.runs[index].events, nextEvent].slice(-MAX_EVENTS_PER_RUN),
  };
  const runs = [...current.runs];
  runs[index] = run;
  writeWorkflowStatus({ ...current, runs });
  return run;
}

export function setWorkflowExecutor(runId: string, executorId: string, reason: string): WorkflowRun | null {
  const current = readWorkflowStatus();
  const index = current.runs.findIndex((run) => run.id === runId);
  if (index < 0) return null;
  const run = {
    ...current.runs[index],
    executorId,
    stage: 'routed' as WorkflowStage,
    updatedAt: nowIso(),
    events: [
      ...current.runs[index].events,
      event(runId, 'routed', 'executor.selected', reason, { executorId }),
    ].slice(-MAX_EVENTS_PER_RUN),
  };
  const runs = [...current.runs];
  runs[index] = run;
  writeWorkflowStatus({ ...current, runs });
  return run;
}

export function completeWorkflowRun(runId: string, message = 'workflow completed'): WorkflowRun | null {
  const current = readWorkflowStatus();
  const index = current.runs.findIndex((run) => run.id === runId);
  if (index < 0) return null;
  const timestamp = nowIso();
  const run = {
    ...current.runs[index],
    stage: 'delivered' as WorkflowStage,
    status: 'succeeded' as const,
    updatedAt: timestamp,
    endedAt: timestamp,
    events: [...current.runs[index].events, event(runId, 'delivered', 'workflow.completed', message)].slice(MAX_EVENTS_PER_RUN * -1),
  };
  const runs = [...current.runs];
  runs[index] = run;
  writeWorkflowStatus({ ...current, runs });
  return run;
}

export function failWorkflowRun(runId: string, error: unknown): WorkflowRun | null {
  const current = readWorkflowStatus();
  const index = current.runs.findIndex((run) => run.id === runId);
  if (index < 0) return null;
  const timestamp = nowIso();
  const message = error instanceof Error ? error.message : String(error);
  const existingRetry = current.runs[index].retry;
  const run = {
    ...current.runs[index],
    stage: 'failed' as WorkflowStage,
    status: 'failed' as const,
    error: message,
    updatedAt: timestamp,
    endedAt: timestamp,
    retry: existingRetry
      ? {
        ...existingRetry,
        status: existingRetry.status === 'retrying' ? 'failed' as const : existingRetry.status,
        lastAttemptAt: existingRetry.status === 'retrying' ? timestamp : existingRetry.lastAttemptAt,
        lastError: message,
      }
      : existingRetry,
    events: [...current.runs[index].events, event(runId, 'failed', 'workflow.failed', message)].slice(MAX_EVENTS_PER_RUN * -1),
  };
  const runs = [...current.runs];
  runs[index] = run;
  writeWorkflowStatus({ ...current, runs });
  return run;
}

export function requestWorkflowRetry(runId: string, requestedBy: 'auto' | 'manual' = 'manual'): WorkflowRun | null {
  const current = readWorkflowStatus();
  const index = current.runs.findIndex((run) => run.id === runId);
  if (index < 0) return null;
  const existing = current.runs[index];
  const input = existing.recovery?.input;
  const attempts = existing.retry?.attempts || 0;
  const maxAttempts = Math.max(1, existing.retry?.maxAttempts ?? DEFAULT_MAX_AUTO_ATTEMPTS);
  const timestamp = nowIso();
  const retryable = !!input?.prompt;
  const status: WorkflowRun['status'] = retryable ? 'retry_pending' : 'failed';
  const retryStatus: WorkflowRetryState['status'] = retryable
    ? requestedBy === 'auto' ? 'auto_pending' : 'manual_pending'
    : 'unavailable';
  const run: WorkflowRun = {
    ...existing,
    status,
    stage: retryable ? existing.stage : 'failed',
    updatedAt: timestamp,
    retry: {
      status: retryStatus,
      attempts,
      maxAttempts,
      requestedBy,
      requestedAt: timestamp,
      lastError: retryable ? existing.retry?.lastError : '缺少可重试输入',
    },
    events: [
      ...existing.events,
      event(runId, retryable ? existing.stage : 'failed', retryable ? 'workflow.retry.requested' : 'workflow.retry.unavailable', retryable ? '已请求 workflow 重试' : '缺少可重试输入，无法重试', {
        requestedBy,
      }),
    ].slice(-MAX_EVENTS_PER_RUN),
  };
  const runs = [...current.runs];
  runs[index] = run;
  writeWorkflowStatus({ ...current, runs });
  return run;
}

export function claimNextWorkflowRetry(workerId: string): WorkflowRun | null {
  const current = readWorkflowStatus();
  const candidates = current.runs
    .map((run, index) => ({ run, index }))
    .filter(({ run }) =>
      run.status === 'retry_pending'
      && (run.retry?.status === 'auto_pending' || run.retry?.status === 'manual_pending')
      && !!run.recovery?.input?.prompt
      && isAutoRetryStillFresh(run)
    )
    .sort((left, right) => {
      const leftManual = left.run.retry?.status === 'manual_pending' ? 1 : 0;
      const rightManual = right.run.retry?.status === 'manual_pending' ? 1 : 0;
      if (leftManual !== rightManual) return rightManual - leftManual;
      return Date.parse(left.run.retry?.requestedAt || left.run.updatedAt) - Date.parse(right.run.retry?.requestedAt || right.run.updatedAt);
    });
  const index = candidates[0]?.index ?? -1;
  if (index < 0) return null;
  const timestamp = nowIso();
  const existing = current.runs[index];
  const attempts = (existing.retry?.attempts || 0) + 1;
  const run: WorkflowRun = {
    ...existing,
    status: 'retrying',
    updatedAt: timestamp,
    retry: {
      ...(existing.retry || makeRetryState('retrying', 0, DEFAULT_MAX_AUTO_ATTEMPTS)),
      status: 'retrying',
      attempts,
      claimedBy: workerId,
      claimedAt: timestamp,
      lastAttemptAt: timestamp,
    },
    events: [
      ...existing.events,
      event(existing.id, existing.stage, 'workflow.retry.claimed', 'workflow 重试已被运行时领取', { workerId, attempts }),
    ].slice(-MAX_EVENTS_PER_RUN),
  };
  const runs = [...current.runs];
  runs[index] = run;
  writeWorkflowStatus({ ...current, runs });
  return run;
}

export function completeWorkflowRetry(runId: string, message = 'workflow retry completed'): WorkflowRun | null {
  const current = readWorkflowStatus();
  const index = current.runs.findIndex((run) => run.id === runId);
  if (index < 0) return null;
  const timestamp = nowIso();
  const existing = current.runs[index];
  const run: WorkflowRun = {
    ...existing,
    status: 'succeeded',
    stage: 'delivered',
    updatedAt: timestamp,
    endedAt: timestamp,
    retry: existing.retry
      ? {
        ...existing.retry,
        status: 'succeeded',
        lastAttemptAt: timestamp,
        lastError: undefined,
      }
      : existing.retry,
    events: [
      ...existing.events,
      event(runId, 'delivered', 'workflow.retry.completed', message),
    ].slice(-MAX_EVENTS_PER_RUN),
  };
  const runs = [...current.runs];
  runs[index] = run;
  writeWorkflowStatus({ ...current, runs });
  return run;
}

export function failWorkflowRetry(runId: string, error: unknown): WorkflowRun | null {
  const current = readWorkflowStatus();
  const index = current.runs.findIndex((run) => run.id === runId);
  if (index < 0) return null;
  const timestamp = nowIso();
  const message = error instanceof Error ? error.message : String(error);
  const existing = current.runs[index];
  const attempts = existing.retry?.attempts || 0;
  const maxAttempts = existing.retry?.maxAttempts ?? DEFAULT_MAX_AUTO_ATTEMPTS;
  const exhausted = attempts >= maxAttempts;
  const run: WorkflowRun = {
    ...existing,
    status: exhausted ? 'failed' : 'retry_pending',
    stage: 'failed',
    error: message,
    updatedAt: timestamp,
    endedAt: exhausted ? timestamp : existing.endedAt,
    retry: {
      ...(existing.retry || makeRetryState('failed', attempts, maxAttempts)),
      status: exhausted ? 'exhausted' : 'auto_pending',
      attempts,
      maxAttempts,
      requestedBy: exhausted ? existing.retry?.requestedBy : 'auto',
      requestedAt: exhausted ? existing.retry?.requestedAt : timestamp,
      lastAttemptAt: timestamp,
      lastError: message,
    },
    events: [
      ...existing.events,
      event(runId, 'failed', exhausted ? 'workflow.retry.exhausted' : 'workflow.retry.failed', exhausted ? 'workflow 重试次数已耗尽' : 'workflow 重试失败，等待下一次自动重试', {
        attempts,
        maxAttempts,
      }),
    ].slice(-MAX_EVENTS_PER_RUN),
  };
  const runs = [...current.runs];
  runs[index] = run;
  writeWorkflowStatus({ ...current, runs });
  return run;
}
