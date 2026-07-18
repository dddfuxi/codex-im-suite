/**
 * 统一计划任务的持久化协议。
 *
 * 这些类型不依赖飞书 SDK 或具体 Provider，确保调度内核可以被其他渠道复用。
 */

export const SCHEDULED_TASK_SCHEMA = 'codex-im-suite/scheduled-task/v1' as const;
export const SCHEDULED_TASK_RUN_SCHEMA = 'codex-im-suite/scheduled-task-run/v1' as const;

export type ScheduledTaskSchedule =
  | {
      kind: 'at';
      /** 归一化后始终是 UTC ISO 字符串。 */
      at: string;
      timezone: string;
    }
  | {
      kind: 'every';
      everyMs: number;
      /** 固定锚点，Bridge 重启后不能重新起算。 */
      anchorAt: string;
    }
  | {
      kind: 'cron';
      expression: string;
      timezone: string;
    };

export type ScheduledTaskAction =
  | {
      kind: 'notify';
      text: string;
    }
  | {
      kind: 'agent_turn';
      prompt: string;
      sessionMode: 'isolated' | 'bound';
      timeoutMs?: number;
    }
  | {
      kind: 'controlled_tool';
      toolName: string;
      input: unknown;
      timeoutMs?: number;
      /** 只有 Host 注册表确认幂等时才允许自动重试。 */
      idempotent?: boolean;
    };

export type ScheduledTaskExecutionContext = {
  sourceSessionId: string;
  workspaceMode: 'bound' | 'none';
  workspaceId?: string;
};

export type ScheduledTaskNotifyTarget = {
  userId?: string;
  name?: string;
  atAll?: boolean;
};

export type ScheduledTaskDelivery = {
  channelType: string;
  chatId: string;
  chatType?: string;
  threadId?: string;
  accountId?: string;
  notifyTargets?: ScheduledTaskNotifyTarget[];
  mode: 'result' | 'summary' | 'none';
};

export type ScheduledTaskMisfirePolicy = {
  mode: 'run_latest' | 'skip';
  maxLatenessMs: number;
};

export type ScheduledTaskRetryErrorKind =
  | 'rate_limit'
  | 'overloaded'
  | 'network'
  | 'timeout'
  | 'server_error';

export type ScheduledTaskRetryPolicy = {
  maxAttempts: number;
  backoffMs: number[];
  retryOn: ScheduledTaskRetryErrorKind[];
};

export type ScheduledTaskOwner = {
  channelType: string;
  userId: string;
  sourceMessageId?: string;
};

export type ScheduledTaskCreate = {
  name: string;
  schedule: ScheduledTaskSchedule;
  action: ScheduledTaskAction;
  executionContext: ScheduledTaskExecutionContext;
  delivery: ScheduledTaskDelivery;
  misfirePolicy: ScheduledTaskMisfirePolicy;
  retryPolicy: ScheduledTaskRetryPolicy;
  owner: ScheduledTaskOwner;
};

export type ScheduledTask = ScheduledTaskCreate & {
  schema: typeof SCHEDULED_TASK_SCHEMA;
  id: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type VersionedScheduledTask = ScheduledTask & {
  version: number;
};

export type ScheduledTaskExecutionStatus =
  | 'pending'
  | 'running'
  | 'ok'
  | 'error'
  | 'skipped'
  | 'cancelled';

export type ScheduledTaskDeliveryStatus =
  | 'not_requested'
  | 'pending'
  | 'delivered'
  | 'failed'
  | 'unknown';

export type ScheduledTaskRunTrigger = 'scheduled' | 'manual' | 'catch_up' | 'retry';

export type ScheduledTaskRun = {
  schema: typeof SCHEDULED_TASK_RUN_SCHEMA;
  taskId: string;
  runId: string;
  slotKey: string;
  scheduledFor: string;
  trigger: ScheduledTaskRunTrigger;
  attempt: number;
  queuedAt: string;
  startedAt?: string;
  endedAt?: string;
  executionStatus: ScheduledTaskExecutionStatus;
  deliveryStatus: ScheduledTaskDeliveryStatus;
  nextRetryAt?: string;
  errorKind?: string;
  error?: string;
  summary?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  messageId?: string;
  cardId?: string;
};

export type ScheduledTaskState = {
  taskId: string;
  nextRunAt?: string;
  queuedRunId?: string;
  runningRunId?: string;
  runningLeaseUntil?: string;
  lastRunAt?: string;
  lastRunStatus?: Exclude<ScheduledTaskExecutionStatus, 'pending' | 'running'>;
  lastExecutionStatus?: Exclude<ScheduledTaskExecutionStatus, 'pending' | 'running'>;
  lastDeliveryStatus?: ScheduledTaskDeliveryStatus;
  consecutiveErrors: number;
  consecutiveSkipped: number;
  lastError?: string;
};

export type VersionedScheduledTaskState = ScheduledTaskState & {
  version: number;
};
