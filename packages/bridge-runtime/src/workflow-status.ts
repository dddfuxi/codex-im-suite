import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  WorkflowExecutionSummaryContract,
  WorkflowPanelRunContract,
  WorkflowPanelStateContract,
  WorkflowRecoveryInputContract,
  WorkflowRecoveryStateContract,
  WorkflowRetryStateContract,
  WorkflowRuntimeEventContract,
  WorkflowStage,
  WorkflowTokenUsageContract,
} from '@codex-im-suite/contracts';

import { CTI_HOME } from './config.js';

export type WorkflowEvent = WorkflowRuntimeEventContract;
export type WorkflowExecutionSummary = WorkflowExecutionSummaryContract;
export type WorkflowTokenUsage = WorkflowTokenUsageContract;
export type WorkflowRun = WorkflowPanelRunContract;
export type WorkflowRecoveryInput = WorkflowRecoveryInputContract;
export type WorkflowRecoveryState = WorkflowRecoveryStateContract;
export type WorkflowRetryState = WorkflowRetryStateContract;
export type WorkflowStatusFile = WorkflowPanelStateContract;
export type { WorkflowStage } from '@codex-im-suite/contracts';

const MAX_RUNS = 80;
const MAX_EVENTS_PER_RUN = 80;
const DEFAULT_MAX_AUTO_ATTEMPTS = 1;
const MAX_RECOVERY_PROMPT_CHARS = 12_000;
const FILE_WRITE_RETRY_DELAYS_MS = [20, 50, 100, 200, 400];

function getStatusPathInternal(): string {
  const ctiHome = process.env.CTI_HOME?.trim() || CTI_HOME;
  return path.join(ctiHome, 'runtime', 'workflow-runs.json');
}

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

function readStringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumberField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function readSourceList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sources = value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter((item): item is 'local_api' | 'external_api' | 'official' => item === 'local_api' || item === 'external_api' || item === 'official');
  return sources.length > 0 ? Array.from(new Set(sources)) : undefined;
}

function readSelectedSource(value: unknown): 'local_api' | 'external_api' | 'official' | undefined {
  return value === 'local_api' || value === 'external_api' || value === 'official' ? value : undefined;
}

function readEvidenceKind(value: unknown): WorkflowExecutionSummary['requiredEvidenceKind'] | undefined {
  return value === 'none' || value === 'input_evidence_required' || value === 'local_read_required' || value === 'tool_required' || value === 'artifact_required'
    ? value
    : undefined;
}

function readBooleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
  return items.length > 0 ? Array.from(new Set(items)) : undefined;
}

function getFsErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : '';
}

function isRetryableWindowsFileLock(error: unknown): boolean {
  const code = getFsErrorCode(error);
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function retryLockedFileOperation<T>(operation: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt <= FILE_WRITE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (!isRetryableWindowsFileLock(error) || attempt >= FILE_WRITE_RETRY_DELAYS_MS.length) {
        throw error;
      }
      lastError = error;
      sleepSync(FILE_WRITE_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

function normalizeExecutionSummary(data?: Record<string, unknown>): WorkflowExecutionSummary | undefined {
  if (!data) return undefined;
  const source = data.execution && typeof data.execution === 'object'
    ? data.execution as Record<string, unknown>
    : data;
  const execution: WorkflowExecutionSummary = {
    executorId: readStringField(source.executorId),
    executorName: readStringField(source.executorName),
    executorKind: readStringField(source.executorKind),
    provider: readStringField(source.provider),
    codexProfile: readStringField(source.codexProfile),
    modelSource: readStringField(source.modelSource),
    attemptedSources: readSourceList(source.attemptedSources),
    selectedSource: readSelectedSource(source.selectedSource),
    model: readStringField(source.model),
    baseUrl: readStringField(source.baseUrl),
    requiredEvidenceKind: readEvidenceKind(source.requiredEvidenceKind),
    evidenceSatisfied: readBooleanField(source.evidenceSatisfied),
    noEvidenceRetryAttempted: readBooleanField(source.noEvidenceRetryAttempted),
    requiredToolFamilies: readStringList(source.requiredToolFamilies),
    requiredInputEvidenceKinds: readStringList(source.requiredInputEvidenceKinds),
    requiredInputEvidenceIds: readStringList(source.requiredInputEvidenceIds),
    acceptedInputEvidenceKinds: readStringList(source.acceptedInputEvidenceKinds),
    acceptedInputEvidenceIds: readStringList(source.acceptedInputEvidenceIds),
    inputEvidenceProvider: readStringField(source.inputEvidenceProvider),
    toolUseCount: readNumberField(source.toolUseCount),
    toolResultCount: readNumberField(source.toolResultCount),
    successfulToolResultCount: readNumberField(source.successfulToolResultCount),
    failedToolResultCount: readNumberField(source.failedToolResultCount),
    failedToolErrors: readStringList(source.failedToolErrors),
    toolNames: readStringList(source.toolNames),
    evidenceProtocol: readStringField(source.evidenceProtocol),
    requestedTool: readStringField(source.requestedTool),
    executedTool: readStringField(source.executedTool),
    jsonToolRetryAttempted: readBooleanField(source.jsonToolRetryAttempted),
    jsonToolFallbackUsed: readBooleanField(source.jsonToolFallbackUsed),
    shellExitCode: readNumberField(source.shellExitCode),
    shellDurationMs: readNumberField(source.shellDurationMs),
    progressCardCreated: readBooleanField(source.progressCardCreated),
    progressCardFinalized: readBooleanField(source.progressCardFinalized),
    progressCardFallbackReason: readStringField(source.progressCardFallbackReason),
    promptProfile: readStringField(source.promptProfile),
  };
  return Object.values(execution).some((value) => value !== undefined) ? execution : undefined;
}

function normalizeTokenUsage(data?: Record<string, unknown>): WorkflowTokenUsage | undefined {
  if (!data) return undefined;
  const source = data.tokenUsage && typeof data.tokenUsage === 'object'
    ? data.tokenUsage as Record<string, unknown>
    : data.usage && typeof data.usage === 'object'
      ? data.usage as Record<string, unknown>
      : data;
  const inputTokens = readNumberField(source.input_tokens);
  const outputTokens = readNumberField(source.output_tokens);
  const cacheReadInputTokens = readNumberField(source.cache_read_input_tokens);
  const cacheCreationInputTokens = readNumberField(source.cache_creation_input_tokens);
  if (
    inputTokens === undefined
    && outputTokens === undefined
    && cacheReadInputTokens === undefined
    && cacheCreationInputTokens === undefined
  ) {
    return undefined;
  }
  const tokenUsage: WorkflowTokenUsage = {};
  if (inputTokens !== undefined) tokenUsage.input_tokens = inputTokens;
  if (outputTokens !== undefined) tokenUsage.output_tokens = outputTokens;
  if (cacheReadInputTokens !== undefined) tokenUsage.cache_read_input_tokens = cacheReadInputTokens;
  if (cacheCreationInputTokens !== undefined) tokenUsage.cache_creation_input_tokens = cacheCreationInputTokens;
  if (inputTokens !== undefined || outputTokens !== undefined) {
    tokenUsage.total_tokens = (inputTokens || 0) + (outputTokens || 0);
  }
  return tokenUsage;
}

function mergeWorkflowTelemetry(run: WorkflowRun, data?: Record<string, unknown>): WorkflowRun {
  const execution = normalizeExecutionSummary(data);
  const tokenUsage = normalizeTokenUsage(data);
  if (!execution && !tokenUsage) return run;
  return {
    ...run,
    ...(execution ? { execution: { ...(run.execution || {}), ...execution } } : {}),
    ...(tokenUsage ? { tokenUsage: { ...(run.tokenUsage || {}), ...tokenUsage } } : {}),
  };
}

export function getWorkflowStatusPath(): string {
  return getStatusPathInternal();
}

export function readWorkflowStatus(): WorkflowStatusFile {
  const statusPath = getStatusPathInternal();
  try {
    if (!fs.existsSync(statusPath)) {
      return { protocol: 'workflow-runtime/v1', updatedAt: nowIso(), runs: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as Partial<WorkflowStatusFile>;
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
  const statusPath = getStatusPathInternal();
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  const tmp = `${statusPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const serialized = JSON.stringify({ ...next, updatedAt: nowIso() }, null, 2);
  retryLockedFileOperation(() => fs.writeFileSync(tmp, serialized, 'utf-8'));
  try {
    retryLockedFileOperation(() => fs.renameSync(tmp, statusPath));
  } catch (error) {
    if (!isRetryableWindowsFileLock(error)) {
      throw error;
    }
    retryLockedFileOperation(() => fs.writeFileSync(statusPath, serialized, 'utf-8'));
    try {
      retryLockedFileOperation(() => fs.unlinkSync(tmp));
    } catch {
      // ignore cleanup failure
    }
  }
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
  const run = mergeWorkflowTelemetry({
    ...current.runs[index],
    stage,
    updatedAt: nowIso(),
    events: [...current.runs[index].events, nextEvent].slice(-MAX_EVENTS_PER_RUN),
  }, data);
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
