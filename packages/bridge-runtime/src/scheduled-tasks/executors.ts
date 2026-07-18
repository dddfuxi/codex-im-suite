import { setTimeout as delay } from 'node:timers/promises';

import {
  classifyScheduledTaskError,
  isRetryableScheduledTaskError,
  type ScheduledTaskErrorKind,
} from './errors.js';
import type { ScheduledTaskExecutionResult } from './service.js';
import type {
  ScheduledTaskDeliveryPayload,
  ScheduledTaskRun,
  VersionedScheduledTask,
} from './types.js';

export type ScheduledActionResult =
  | {
      ok: true;
      deliveryPayload?: ScheduledTaskDeliveryPayload;
      summary?: string;
      sessionId?: string;
      provider?: string;
      model?: string;
    }
  | {
      ok: false;
      error: string;
      errorKind?: ScheduledTaskErrorKind;
      executionStarted?: boolean;
    };

export type ScheduledDeliveryResult =
  | { ok: true; messageId?: string; cardId?: string }
  | { ok: false; error: string; errorKind?: ScheduledTaskErrorKind };

export type ExecuteScheduledTaskRunOptions = {
  task: VersionedScheduledTask;
  run: ScheduledTaskRun;
  executeAction: () => Promise<ScheduledActionResult>;
  deliver: (payload: ScheduledTaskDeliveryPayload) => Promise<ScheduledDeliveryResult>;
  sleep?: (ms: number) => Promise<void>;
};

function retryDelay(task: VersionedScheduledTask, retryIndex: number): number {
  const delays = task.retryPolicy.backoffMs;
  if (delays.length === 0) return 0;
  return Math.max(0, Math.floor(delays[Math.min(retryIndex, delays.length - 1)] ?? 0));
}

function canRetry(
  task: VersionedScheduledTask,
  kind: ScheduledTaskErrorKind,
  retryIndex: number,
): boolean {
  return retryIndex < task.retryPolicy.maxAttempts
    && isRetryableScheduledTaskError(kind)
    && task.retryPolicy.retryOn.includes(kind as VersionedScheduledTask['retryPolicy']['retryOn'][number]);
}

function canReplayAction(
  task: VersionedScheduledTask,
  result: Extract<ScheduledActionResult, { ok: false }>,
): boolean {
  if (result.executionStarted !== true) return true;
  return task.action.kind === 'controlled_tool' && task.action.idempotent === true;
}

export async function executeScheduledTaskRun(
  options: ExecuteScheduledTaskRunOptions,
): Promise<ScheduledTaskExecutionResult> {
  const sleep = options.sleep ?? (async (ms: number) => {
    await delay(ms);
  });

  let action: ScheduledActionResult;
  let actionRetryIndex = 0;
  while (true) {
    action = await options.executeAction();
    if (action.ok) break;
    const errorKind = action.errorKind ?? classifyScheduledTaskError(action.error);
    if (!canReplayAction(options.task, action) || !canRetry(options.task, errorKind, actionRetryIndex)) {
      return {
        executionStatus: 'error',
        deliveryStatus: 'not_requested',
        errorKind,
        error: action.error,
        executionStarted: action.executionStarted,
      };
    }
    await sleep(retryDelay(options.task, actionRetryIndex));
    actionRetryIndex += 1;
  }

  if (options.task.delivery.mode === 'none') {
    return {
      executionStatus: 'ok',
      deliveryStatus: 'not_requested',
      deliveryPayload: action.deliveryPayload,
      summary: action.summary,
      sessionId: action.sessionId,
      provider: action.provider,
      model: action.model,
      executionStarted: true,
    };
  }

  const payload = action.deliveryPayload;
  if (!payload) {
    return {
      executionStatus: 'ok',
      deliveryStatus: 'failed',
      errorKind: 'invalid_input',
      error: '计划任务执行成功，但没有生成可投递结果',
      summary: action.summary,
      sessionId: action.sessionId,
      provider: action.provider,
      model: action.model,
      executionStarted: true,
    };
  }

  let deliveryRetryIndex = 0;
  while (true) {
    const delivered = await options.deliver(payload);
    if (delivered.ok) {
      return {
        executionStatus: 'ok',
        deliveryStatus: 'delivered',
        deliveryPayload: payload,
        summary: action.summary,
        sessionId: action.sessionId,
        provider: action.provider,
        model: action.model,
        messageId: delivered.messageId,
        cardId: delivered.cardId,
        executionStarted: true,
      };
    }
    const errorKind = delivered.errorKind ?? classifyScheduledTaskError(delivered.error);
    if (!canRetry(options.task, errorKind, deliveryRetryIndex)) {
      return {
        executionStatus: 'ok',
        deliveryStatus: 'failed',
        deliveryPayload: payload,
        errorKind,
        error: delivered.error,
        summary: action.summary,
        sessionId: action.sessionId,
        provider: action.provider,
        model: action.model,
        executionStarted: true,
      };
    }
    await sleep(retryDelay(options.task, deliveryRetryIndex));
    deliveryRetryIndex += 1;
  }
}

export { classifyScheduledTaskError } from './errors.js';
