import type {
  ScheduledTaskRun,
  VersionedScheduledTask,
} from '../scheduled-tasks/types.js';

export function makeScheduledTask(
  overrides: Partial<VersionedScheduledTask> = {},
): VersionedScheduledTask {
  return {
    schema: 'codex-im-suite/scheduled-task/v1',
    id: 'task_test_001',
    version: 1,
    name: '每日单子',
    enabled: true,
    schedule: {
      kind: 'cron',
      expression: '30 10 * * 1-5',
      timezone: 'Asia/Shanghai',
    },
    action: {
      kind: 'agent_turn',
      prompt: '查询并发送每日单子',
      sessionMode: 'isolated',
    },
    executionContext: {
      sourceSessionId: 'session_test',
      workspaceMode: 'none',
    },
    delivery: {
      channelType: 'feishu',
      chatId: 'oc_test',
      mode: 'result',
    },
    misfirePolicy: {
      mode: 'run_latest',
      maxLatenessMs: 86_400_000,
    },
    retryPolicy: {
      maxAttempts: 3,
      backoffMs: [30_000, 60_000, 300_000],
      retryOn: ['network', 'timeout', 'server_error', 'rate_limit', 'overloaded'],
    },
    owner: {
      channelType: 'feishu',
      userId: 'ou_owner',
      sourceMessageId: 'om_create',
    },
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

export function makeScheduledRun(
  overrides: Partial<ScheduledTaskRun> = {},
): ScheduledTaskRun {
  return {
    schema: 'codex-im-suite/scheduled-task-run/v1',
    taskId: 'task_test_001',
    runId: 'task_test_001:2026-07-20T02:30:00.000Z:1',
    slotKey: 'slot_test_001',
    scheduledFor: '2026-07-20T02:30:00.000Z',
    trigger: 'scheduled',
    attempt: 1,
    queuedAt: '2026-07-20T02:30:00.000Z',
    executionStatus: 'pending',
    deliveryStatus: 'not_requested',
    ...overrides,
  };
}
