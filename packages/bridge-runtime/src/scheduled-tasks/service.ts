import crypto from 'node:crypto';

import { computeNextScheduledAt } from './schedule.js';
import type { ScheduledTaskStore } from './store.js';
import type {
  ScheduledTaskDeliveryStatus,
  ScheduledTaskExecutionStatus,
  ScheduledTaskRun,
  ScheduledTaskRunTrigger,
  ScheduledTaskState,
  VersionedScheduledTask,
  VersionedScheduledTaskState,
} from './types.js';
import { SCHEDULED_TASK_RUN_SCHEMA } from './types.js';

export type ScheduledTaskExecutionResult = {
  executionStatus: Exclude<ScheduledTaskExecutionStatus, 'pending' | 'running'>;
  deliveryStatus: ScheduledTaskDeliveryStatus;
  errorKind?: string;
  error?: string;
  summary?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  messageId?: string;
  cardId?: string;
  deliveryPayload?: ScheduledTaskRun['deliveryPayload'];
  executionStarted?: boolean;
};

export type ScheduledTaskExecuteInput = {
  task: VersionedScheduledTask;
  run: ScheduledTaskRun;
  mode: 'full' | 'delivery_only';
  previousRun?: ScheduledTaskRun;
};

export type ScheduledTaskServiceOptions = {
  store: ScheduledTaskStore;
  now?: () => string;
  leaseMs?: number;
  execute: (input: ScheduledTaskExecuteInput) => Promise<ScheduledTaskExecutionResult>;
};

export interface ScheduledTaskService {
  tick(): Promise<number>;
  recover(): Promise<number>;
  ensureTaskState(taskId: string): Promise<VersionedScheduledTaskState>;
  runNow(taskId: string): Promise<ScheduledTaskRun>;
}

export function createScheduledSlotKey(taskId: string, scheduledFor: string): string {
  return crypto.createHash('sha256').update(`${taskId}\0${scheduledFor}`).digest('hex');
}

function isDue(nextRunAt: string | undefined, now: string): boolean {
  if (!nextRunAt) return false;
  const nextMs = new Date(nextRunAt).getTime();
  const nowMs = new Date(now).getTime();
  return Number.isFinite(nextMs) && Number.isFinite(nowMs) && nextMs <= nowMs;
}

function hasActiveLease(state: VersionedScheduledTaskState, now: string): boolean {
  if (!state.runningRunId || !state.runningLeaseUntil) return false;
  const leaseMs = new Date(state.runningLeaseUntil).getTime();
  const nowMs = new Date(now).getTime();
  return Number.isFinite(leaseMs) && Number.isFinite(nowMs) && leaseMs > nowMs;
}

function nextStateCounters(
  state: VersionedScheduledTaskState,
  status: ScheduledTaskExecutionResult['executionStatus'],
): Pick<ScheduledTaskState, 'consecutiveErrors' | 'consecutiveSkipped'> {
  if (status === 'ok') return { consecutiveErrors: 0, consecutiveSkipped: 0 };
  if (status === 'error') {
    return {
      consecutiveErrors: state.consecutiveErrors + 1,
      consecutiveSkipped: 0,
    };
  }
  if (status === 'skipped') {
    return {
      consecutiveErrors: state.consecutiveErrors,
      consecutiveSkipped: state.consecutiveSkipped + 1,
    };
  }
  return {
    consecutiveErrors: state.consecutiveErrors,
    consecutiveSkipped: state.consecutiveSkipped,
  };
}

function createRun(
  task: VersionedScheduledTask,
  scheduledFor: string,
  trigger: ScheduledTaskRunTrigger,
  slotIdentity: string,
  queuedAt: string,
): ScheduledTaskRun {
  const slotKey = createScheduledSlotKey(task.id, slotIdentity);
  const runId = trigger === 'manual'
    ? `${task.id}:manual:${queuedAt}:${crypto.randomUUID()}`
    : `${task.id}:${scheduledFor}:1`;
  return {
    schema: SCHEDULED_TASK_RUN_SCHEMA,
    taskId: task.id,
    runId,
    slotKey,
    scheduledFor,
    trigger,
    attempt: 1,
    queuedAt,
    executionStatus: 'pending',
    deliveryStatus: task.delivery.mode === 'none' ? 'not_requested' : 'pending',
  };
}

export function createScheduledTaskService(
  options: ScheduledTaskServiceOptions,
): ScheduledTaskService {
  const now = options.now ?? (() => new Date().toISOString());
  const leaseMs = Math.max(5_000, Math.floor(options.leaseMs ?? 10 * 60_000));
  let runningTick: Promise<number> | null = null;

  const ensureTaskState = async (taskId: string): Promise<VersionedScheduledTaskState> => {
    const existing = await options.store.getState(taskId);
    if (existing) return existing;
    const task = await options.store.getTask(taskId);
    if (!task) throw new Error(`计划任务不存在：${taskId}`);
    const initial: ScheduledTaskState = {
      taskId,
      nextRunAt: computeNextScheduledAt(task.schedule, task.createdAt),
      consecutiveErrors: 0,
      consecutiveSkipped: 0,
    };
    try {
      return await options.store.compareAndSetState(taskId, 0, initial);
    } catch (error) {
      if (!/版本冲突/u.test(error instanceof Error ? error.message : String(error))) throw error;
      const raced = await options.store.getState(taskId);
      if (!raced) throw error;
      return raced;
    }
  };

  const finalizeRun = async (
    task: VersionedScheduledTask,
    run: ScheduledTaskRun,
    result: ScheduledTaskExecutionResult,
    preserveNextRun: boolean,
  ): Promise<ScheduledTaskRun> => {
    const endedAt = now();
    const finalized: ScheduledTaskRun = {
      ...run,
      endedAt,
      executionStatus: result.executionStatus,
      deliveryStatus: result.deliveryStatus,
      errorKind: result.errorKind,
      error: result.error,
      summary: result.summary,
      sessionId: result.sessionId,
      provider: result.provider,
      model: result.model,
      messageId: result.messageId,
      cardId: result.cardId,
      deliveryPayload: result.deliveryPayload,
      executionStarted: result.executionStarted,
    };
    await options.store.appendRun(finalized);

    const state = await options.store.getState(task.id);
    if (!state || state.runningRunId !== run.runId) return finalized;
    const counters = nextStateCounters(state, result.executionStatus);
    await options.store.compareAndSetState(task.id, state.version, {
      ...state,
      ...counters,
      nextRunAt: preserveNextRun
        ? state.nextRunAt
        : computeNextScheduledAt(task.schedule, run.scheduledFor),
      queuedRunId: undefined,
      runningRunId: undefined,
      runningLeaseUntil: undefined,
      lastRunAt: endedAt,
      lastRunStatus: result.executionStatus,
      lastExecutionStatus: result.executionStatus,
      lastDeliveryStatus: result.deliveryStatus,
      lastError: result.error,
    });
    return finalized;
  };

  const executeReservedRun = async (
    task: VersionedScheduledTask,
    reserved: VersionedScheduledTaskState,
    run: ScheduledTaskRun,
    preserveNextRun: boolean,
  ): Promise<ScheduledTaskRun> => {
    const startedAt = now();
    const runningState = await options.store.compareAndSetState(task.id, reserved.version, {
      ...reserved,
      queuedRunId: undefined,
      runningRunId: run.runId,
      runningLeaseUntil: new Date(new Date(startedAt).getTime() + leaseMs).toISOString(),
    });
    const runningRun: ScheduledTaskRun = {
      ...run,
      startedAt,
      executionStatus: 'running',
    };
    await options.store.appendRun(runningRun);

    let result: ScheduledTaskExecutionResult;
    try {
      result = await options.execute({ task, run: runningRun, mode: 'full' });
    } catch (error) {
      result = {
        executionStatus: 'error',
        deliveryStatus: 'unknown',
        errorKind: 'unknown',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    void runningState;
    return finalizeRun(task, runningRun, result, preserveNextRun);
  };

  const reserveAndExecute = async (
    task: VersionedScheduledTask,
    state: VersionedScheduledTaskState,
    scheduledFor: string,
    trigger: ScheduledTaskRunTrigger,
    preserveNextRun: boolean,
  ): Promise<ScheduledTaskRun | null> => {
    const queuedAt = now();
    const slotIdentity = trigger === 'manual'
      ? `manual:${queuedAt}:${crypto.randomUUID()}`
      : scheduledFor;
    const run = createRun(task, scheduledFor, trigger, slotIdentity, queuedAt);
    let reserved: VersionedScheduledTaskState;
    try {
      reserved = await options.store.compareAndSetState(task.id, state.version, {
        ...state,
        queuedRunId: run.runId,
      });
    } catch (error) {
      if (/版本冲突/u.test(error instanceof Error ? error.message : String(error))) return null;
      throw error;
    }
    await options.store.appendRun(run);
    return executeReservedRun(task, reserved, run, preserveNextRun);
  };

  const recordOverlap = async (
    task: VersionedScheduledTask,
    state: VersionedScheduledTaskState,
    scheduledFor: string,
  ): Promise<ScheduledTaskRun> => {
    const occurredAt = now();
    const run: ScheduledTaskRun = {
      ...createRun(task, scheduledFor, 'scheduled', scheduledFor, occurredAt),
      runId: `${task.id}:${scheduledFor}:overlap`,
      startedAt: occurredAt,
      endedAt: occurredAt,
      executionStatus: 'skipped',
      deliveryStatus: 'not_requested',
      errorKind: 'overlap_skipped',
      error: `前一运行 ${state.runningRunId} 仍持有有效租约`,
    };
    await options.store.appendRun(run);
    await options.store.compareAndSetState(task.id, state.version, {
      ...state,
      nextRunAt: computeNextScheduledAt(task.schedule, scheduledFor),
      lastRunAt: occurredAt,
      lastRunStatus: 'skipped',
      lastExecutionStatus: 'skipped',
      lastDeliveryStatus: 'not_requested',
      consecutiveErrors: state.consecutiveErrors,
      consecutiveSkipped: state.consecutiveSkipped + 1,
      lastError: run.error,
    });
    return run;
  };

  const tickOnce = async (): Promise<number> => {
    await recoverExpiredRuns();
    const tickNow = now();
    let handled = 0;
    for (const task of await options.store.listTasks()) {
      if (!task.enabled) continue;
      const state = await ensureTaskState(task.id);
      if (!isDue(state.nextRunAt, tickNow)) continue;
      const scheduledFor = state.nextRunAt!;
      if (hasActiveLease(state, tickNow)) {
        await recordOverlap(task, state, scheduledFor);
        handled += 1;
        continue;
      }
      const run = await reserveAndExecute(task, state, scheduledFor, 'scheduled', false);
      if (run) handled += 1;
    }
    return handled;
  };

  const recoverExpiredRuns = async (): Promise<number> => {
    const recoveryNow = now();
    const recoveryNowMs = new Date(recoveryNow).getTime();
    let recovered = 0;
    for (const task of await options.store.listTasks()) {
      const state = await options.store.getState(task.id);
      if (!state) continue;

      if (state.queuedRunId && !state.runningRunId) {
        await options.store.compareAndSetState(task.id, state.version, {
          ...state,
          queuedRunId: undefined,
        });
        recovered += 1;
        continue;
      }

      if (!state.runningRunId || !state.runningLeaseUntil) continue;
      const leaseMs = new Date(state.runningLeaseUntil).getTime();
      if (!Number.isFinite(leaseMs) || leaseMs > recoveryNowMs) continue;

      const previousRun = (await options.store.listRuns(task.id, 200))
        .find((run) => run.runId === state.runningRunId);
      if (
        previousRun
        && previousRun.executionStatus === 'ok'
        && previousRun.deliveryStatus === 'failed'
        && previousRun.deliveryPayload
      ) {
        const deliveryResult = await options.execute({
          task,
          run: previousRun,
          mode: 'delivery_only',
          previousRun,
        });
        await finalizeRun(task, previousRun, deliveryResult, false);
        recovered += 1;
        continue;
      }

      const scheduledFor = previousRun?.scheduledFor ?? state.nextRunAt ?? recoveryNow;
      const interrupted: ScheduledTaskRun = {
        ...(previousRun ?? createRun(task, scheduledFor, 'scheduled', scheduledFor, recoveryNow)),
        runId: state.runningRunId,
        startedAt: previousRun?.startedAt ?? recoveryNow,
        endedAt: recoveryNow,
        executionStatus: 'error',
        deliveryStatus: 'unknown',
        errorKind: 'interrupted_by_restart',
        error: '计划任务在 Bridge 重启前未留下终态结果',
        executionStarted: true,
      };
      await options.store.appendRun(interrupted);
      await options.store.compareAndSetState(task.id, state.version, {
        ...state,
        nextRunAt: computeNextScheduledAt(task.schedule, scheduledFor),
        queuedRunId: undefined,
        runningRunId: undefined,
        runningLeaseUntil: undefined,
        lastRunAt: recoveryNow,
        lastRunStatus: 'error',
        lastExecutionStatus: 'error',
        lastDeliveryStatus: 'unknown',
        consecutiveErrors: state.consecutiveErrors + 1,
        consecutiveSkipped: 0,
        lastError: interrupted.error,
      });
      recovered += 1;
    }
    return recovered;
  };

  return {
    ensureTaskState,

    recover: recoverExpiredRuns,

    async tick() {
      if (runningTick) return runningTick;
      runningTick = tickOnce().finally(() => {
        runningTick = null;
      });
      return runningTick;
    },

    async runNow(taskId) {
      const task = await options.store.getTask(taskId);
      if (!task) throw new Error(`计划任务不存在：${taskId}`);
      const state = await ensureTaskState(taskId);
      if (hasActiveLease(state, now())) throw new Error('计划任务已有运行中的实例');
      const scheduledFor = now();
      const run = await reserveAndExecute(task, state, scheduledFor, 'manual', true);
      if (!run) throw new Error('计划任务运行准入冲突');
      return run;
    },
  };
}
