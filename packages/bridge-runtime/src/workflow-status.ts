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
import {
  diagnoseWorkflowFailures,
  mergeWorkflowFailureDiagnostics,
} from './workflow-failure-diagnostics.js';
import { writeUtf8TextAtomic } from './atomic-text-file.js';
import { normalizeWellFormedUtf16, truncateUtf16Safe } from './unicode-text.js';
import { recordWorkflowFailureLedgerEntryBestEffort } from './workflow-failure-ledger.js';

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

function getStatusPathInternal(): string {
  const ctiHome = process.env.CTI_HOME?.trim() || CTI_HOME;
  return path.join(ctiHome, 'runtime', 'workflow-runs.json');
}

function nowIso(): string {
  return new Date().toISOString();
}

function preview(text: string, limit = 180): string {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  return truncateUtf16Safe(normalized, limit, '...');
}

function truncateRecoveryText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return truncateUtf16Safe(text, MAX_RECOVERY_PROMPT_CHARS, '...');
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

function readModelMode(value: unknown): WorkflowExecutionSummary['modelMode'] | undefined {
  return value === 'source_default' || value === 'explicit' ? value : undefined;
}

function readReasoningEffort(value: unknown): WorkflowExecutionSummary['requestedReasoningEffort'] | undefined {
  return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh'
    ? value
    : undefined;
}

function readExecutionOverrideReason(value: unknown): WorkflowExecutionSummary['executionOverrideReason'] | undefined {
  return value === 'restricted_interaction' ? value : undefined;
}

function readThreadMode(value: unknown): WorkflowExecutionSummary['threadMode'] | undefined {
  return value === 'fresh' || value === 'resumed' || value === 'fresh_profile_changed' || value === 'fresh_resume_failed'
    ? value
    : undefined;
}

function readParameterEvidence(value: unknown): WorkflowExecutionSummary['parameterEvidence'] | undefined {
  return value === 'sdk_thread_options' ? value : undefined;
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

function readReplaySafety(value: unknown): WorkflowExecutionSummary['replaySafety'] | undefined {
  return value === 'safe_no_tools' || value === 'safe_read_only' || value === 'unsafe_side_effects' || value === 'unsafe_unknown'
    ? value
    : undefined;
}

function readRetryDisposition(value: unknown): WorkflowExecutionSummary['retryDisposition'] | undefined {
  return value === 'not_needed' || value === 'retry_in_turn' || value === 'artifact_recovery'
    || value === 'manual_retry_required' || value === 'exhausted' || value === 'not_retryable'
    ? value
    : undefined;
}

function readFailureDiagnostics(value: unknown): WorkflowExecutionSummary['failureDiagnostics'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const diagnostics = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const source = (item as Record<string, unknown>).source;
    const category = (item as Record<string, unknown>).category;
    const code = readStringField((item as Record<string, unknown>).code);
    const summary = readStringField((item as Record<string, unknown>).summary);
    if ((source !== 'provider' && source !== 'tool') || !code || !summary) return [];
    const allowedCategories = new Set([
      'authentication',
      'usage_limit',
      'provider_protocol',
      'invalid_request',
      'cancelled',
      'transient',
      'dependency_unavailable',
      'runtime_incompatible',
      'runtime_unavailable',
      'unknown',
    ]);
    if (typeof category !== 'string' || !allowedCategories.has(category)) return [];
    const autoRetry = readBooleanField((item as Record<string, unknown>).autoRetry);
    const diagnostic: NonNullable<WorkflowExecutionSummary['failureDiagnostics']>[number] = {
      source: source as NonNullable<WorkflowExecutionSummary['failureDiagnostics']>[number]['source'],
      category: category as NonNullable<WorkflowExecutionSummary['failureDiagnostics']>[number]['category'],
      code,
      summary,
      ...(autoRetry === undefined ? {} : { autoRetry }),
    };
    return [diagnostic];
  });
  return diagnostics.length > 0 ? mergeWorkflowFailureDiagnostics(diagnostics) : undefined;
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
    requestedModel: readStringField(source.requestedModel),
    submittedModel: readStringField(source.submittedModel),
    modelMode: readModelMode(source.modelMode),
    requestedReasoningEffort: readReasoningEffort(source.requestedReasoningEffort),
    submittedReasoningEffort: readReasoningEffort(source.submittedReasoningEffort),
    executionOverrideReason: readExecutionOverrideReason(source.executionOverrideReason),
    threadMode: readThreadMode(source.threadMode),
    parameterEvidence: readParameterEvidence(source.parameterEvidence),
    baseUrl: readStringField(source.baseUrl),
    requiredEvidenceKind: readEvidenceKind(source.requiredEvidenceKind),
    evidenceSatisfied: readBooleanField(source.evidenceSatisfied),
    noEvidenceRetryAttempted: readBooleanField(source.noEvidenceRetryAttempted),
    verifiedOutputArtifactCount: readNumberField(source.verifiedOutputArtifactCount),
    replaySafety: readReplaySafety(source.replaySafety),
    retryDisposition: readRetryDisposition(source.retryDisposition),
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
    failureDiagnostics: readFailureDiagnostics(source.failureDiagnostics),
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

function serializeWorkflowStatus(value: unknown): { serialized: string; replacementCount: number } {
  let replacementCount = 0;
  const serialized = JSON.stringify(
    value,
    (_key, item) => {
      if (typeof item !== 'string') return item;
      const normalized = normalizeWellFormedUtf16(item);
      if (normalized !== item) replacementCount += 1;
      return normalized;
    },
    2,
  );
  return { serialized, replacementCount };
}

export function readWorkflowStatus(): WorkflowStatusFile {
  const statusPath = getStatusPathInternal();
  try {
    if (!fs.existsSync(statusPath)) {
      return { protocol: 'workflow-runtime/v1', updatedAt: nowIso(), runs: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as Partial<WorkflowStatusFile>;
    const normalized = serializeWorkflowStatus(parsed);
    const safeParsed = normalized.replacementCount > 0
      ? JSON.parse(normalized.serialized) as Partial<WorkflowStatusFile>
      : parsed;
    if (normalized.replacementCount > 0) {
      // 只有检测到确凿的非法 UTF-16 才做一次迁移；先保留原始状态库备份，
      // 任何备份/写入失败都只放弃落盘自愈，不丢弃已经可供本轮使用的内存状态。
      try {
        const backupPath = `${statusPath}.unicode-repair-${Date.now()}.bak`;
        fs.copyFileSync(statusPath, backupPath, fs.constants.COPYFILE_EXCL);
        writeUtf8TextAtomic(statusPath, normalized.serialized);
      } catch {
        // best effort compatibility migration
      }
    }
    return {
      protocol: 'workflow-runtime/v1',
      updatedAt: safeParsed.updatedAt || nowIso(),
      runs: Array.isArray(safeParsed.runs) ? safeParsed.runs : [],
    };
  } catch {
    return { protocol: 'workflow-runtime/v1', updatedAt: nowIso(), runs: [] };
  }
}

function writeWorkflowStatus(next: WorkflowStatusFile): WorkflowStatusFile {
  const statusPath = getStatusPathInternal();
  // 防御所有 workflow 字段，而不只保护 promptPreview；Provider、工具和历史数据
  // 都可能携带外部生成的字符串，状态文件必须始终可被跨语言 JSON 消费者读取。
  const { serialized } = serializeWorkflowStatus(
    { ...next, updatedAt: nowIso() },
  );
  writeUtf8TextAtomic(statusPath, serialized);
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
        turnId: input.turnId,
        workingDirectory: input.workingDirectory,
        additionalDirectories: input.additionalDirectories,
        model: input.model,
        systemPrompt: truncateRecoveryText(input.systemPrompt),
        permissionMode: input.permissionMode,
        executionRequirement: input.executionRequirement,
        noEvidenceRetryAttempted: input.noEvidenceRetryAttempted,
        inputEvidenceRefs: input.inputEvidenceRefs,
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
  const ledgerEntries: Array<{ run: WorkflowRun; interruptedStage: WorkflowStage }> = [];
  const runs = current.runs.map((run) => {
    if (run.status !== 'running' && run.status !== 'retrying') return run;
    changed = true;
    const input = run.recovery?.input;
    const retryAttempts = run.retry?.attempts || 0;
    const maxAttempts = run.retry?.maxAttempts ?? DEFAULT_MAX_AUTO_ATTEMPTS;
    const interruptedBeforeExecution = run.status === 'running'
      && (run.stage === 'received' || run.stage === 'authorized' || run.stage === 'contextualized' || run.stage === 'routed');
    // executing/finalizing/retrying 可能已经产生外部副作用。Bridge 重启后不能
    // 仅凭原 prompt 自动重放；保留 recovery input 供用户显式手动重试即可。
    const recoverable = interruptedBeforeExecution
      && !!input?.prompt
      && !!input.turnId
      && !!input.executionRequirement
      && retryAttempts < maxAttempts;
    const interruptionReason = recoverable
      ? 'bridge 重启后可用持久化输入重试'
      : input?.prompt
        ? '任务已进入执行阶段，禁止跨重启自动重放'
        : '缺少 prompt 等最小恢复信息';
    const next: WorkflowRun = {
      ...run,
      stage: 'failed',
      status: recoverable ? 'retry_pending' : 'failed',
      error: recoverable
        ? 'bridge 重启时发现上一轮仍在处理中，已排队自动重试。'
        : input?.prompt
          ? 'bridge 重启时发现上一轮已进入执行阶段；为避免重复副作用，未自动重试。'
          : 'bridge 重启时发现上一轮仍在处理中，但缺少可重试输入。',
      updatedAt: timestamp,
      endedAt: timestamp,
      recovery: {
        kind: recoverable ? 'recoverable' : 'not_recoverable',
        reason: interruptionReason,
        input,
        runtimeRunId,
        markedAt: timestamp,
      },
      retry: recoverable
        ? makeRetryState('auto_pending', retryAttempts, maxAttempts, 'auto', 'bridge 重启自动重试')
        : makeRetryState('unavailable', retryAttempts, maxAttempts, undefined, interruptionReason),
      events: [
        ...run.events,
        event(run.id, 'failed', recoverable ? 'workflow.interrupted.recoverable' : 'workflow.interrupted.not_recoverable', recoverable ? 'bridge 重启，自动重试已排队' : 'bridge 重启，已阻止执行中任务自动重放', {
          runtimeRunId,
          retryable: recoverable,
          interruptedStage: run.stage,
          interruptedStatus: run.status,
        }),
      ].slice(-MAX_EVENTS_PER_RUN),
    };
    marked.push(next);
    ledgerEntries.push({ run: next, interruptedStage: run.stage });
    return next;
  });
  if (changed) {
    writeWorkflowStatus({ ...current, runs });
    for (const item of ledgerEntries) {
      recordWorkflowFailureLedgerEntryBestEffort({
        kind: 'restart_interrupted',
        stage: item.interruptedStage,
        workflowStatus: item.run.status,
        failureCodes: [item.interruptedStage === 'executing' || item.interruptedStage === 'finalizing' || item.run.status === 'retrying'
          ? 'runtime.restart_during_execution'
          : 'runtime.restart_before_execution'],
        replaySafety: item.run.execution?.replaySafety,
        retryDisposition: item.run.execution?.retryDisposition,
        occurredAt: timestamp,
      });
    }
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
  // 控制面板终止已经成为本轮唯一终态后，迟到的 Provider close 不能覆盖它。
  if (current.runs[index].status === 'cancelled') return current.runs[index];
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
  // Abort 后 Provider 往往还会抛出一个迟到错误；保留更准确的取消终态。
  if (current.runs[index].status === 'cancelled') return current.runs[index];
  const timestamp = nowIso();
  const message = error instanceof Error ? error.message : String(error);
  const existingRetry = current.runs[index].retry;
  const failureDiagnostics = mergeWorkflowFailureDiagnostics(
    current.runs[index].execution?.failureDiagnostics,
    diagnoseWorkflowFailures({ providerError: error }),
  );
  const run = {
    ...current.runs[index],
    execution: {
      ...(current.runs[index].execution || {}),
      failureDiagnostics,
    },
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
    events: [...current.runs[index].events, event(runId, 'failed', 'workflow.failed', message, {
      failureCodes: failureDiagnostics.map((item) => item.code),
    })].slice(MAX_EVENTS_PER_RUN * -1),
  };
  const runs = [...current.runs];
  runs[index] = run;
  writeWorkflowStatus({ ...current, runs });
  recordWorkflowFailureLedgerEntryBestEffort({
    kind: 'workflow_failed',
    stage: current.runs[index].stage,
    workflowStatus: run.status,
    failureCodes: failureDiagnostics.map((item) => item.code),
    replaySafety: run.execution?.replaySafety,
    retryDisposition: run.execution?.retryDisposition,
    occurredAt: timestamp,
  });
  return run;
}

export function cancelWorkflowRun(runId: string, message = '用户从控制面板终止了当前回复'): WorkflowRun | null {
  const current = readWorkflowStatus();
  const index = current.runs.findIndex((run) => run.id === runId);
  if (index < 0) return null;
  const existing = current.runs[index];
  if (existing.status === 'cancelled') return existing;
  const timestamp = nowIso();
  const run: WorkflowRun = {
    ...existing,
    stage: 'failed',
    status: 'cancelled',
    error: message,
    updatedAt: timestamp,
    endedAt: timestamp,
    execution: {
      ...(existing.execution || {}),
      retryDisposition: 'not_retryable',
      failureDiagnostics: mergeWorkflowFailureDiagnostics(
        existing.execution?.failureDiagnostics,
        [{
          source: 'provider',
          category: 'cancelled',
          code: 'provider.user_cancelled',
          summary: '当前回复已由用户终止。',
          autoRetry: false,
        }],
      ),
    },
    retry: existing.retry ? {
      ...existing.retry,
      status: 'unavailable',
      lastAttemptAt: timestamp,
      lastError: message,
    } : existing.retry,
    events: [
      ...existing.events,
      event(runId, 'failed', 'workflow.cancelled', message, { requestedBy: 'control_panel' }),
    ].slice(-MAX_EVENTS_PER_RUN),
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
  const retryable = !!input?.prompt && !!input.turnId && !!input.executionRequirement;
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
      lastError: retryable ? existing.retry?.lastError : '缺少 prompt、turnId 或原始执行要求',
    },
    events: [
      ...existing.events,
      event(runId, retryable ? existing.stage : 'failed', retryable ? 'workflow.retry.requested' : 'workflow.retry.unavailable', retryable ? '已请求 workflow 重试' : '缺少 prompt、turnId 或原始执行要求，无法重试', {
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
      && !!run.recovery?.input?.turnId
      && !!run.recovery?.input?.executionRequirement
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
  const failureDiagnostics = mergeWorkflowFailureDiagnostics(
    existing.execution?.failureDiagnostics,
    diagnoseWorkflowFailures({ providerError: error }),
  );
  const run: WorkflowRun = {
    ...existing,
    execution: {
      ...(existing.execution || {}),
      failureDiagnostics,
    },
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
        failureCodes: failureDiagnostics.map((item) => item.code),
      }),
    ].slice(-MAX_EVENTS_PER_RUN),
  };
  const runs = [...current.runs];
  runs[index] = run;
  writeWorkflowStatus({ ...current, runs });
  recordWorkflowFailureLedgerEntryBestEffort({
    kind: 'retry_failed',
    stage: existing.stage,
    workflowStatus: run.status,
    failureCodes: failureDiagnostics.map((item) => item.code),
    replaySafety: run.execution?.replaySafety,
    retryDisposition: run.execution?.retryDisposition,
    occurredAt: timestamp,
  });
  return run;
}
