import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createScheduledTaskIsolatedWorkspacePlan,
  createBridgeScheduledTaskActionHost,
  createScheduledTaskHost,
  createScheduledTaskRunExecutor,
  createScheduledTaskScheduler,
  withScheduledTaskIsolatedWorkspace,
} from '../scheduled-task-host.js';
import {
  buildScheduledTaskCard,
  buildScheduledTaskCheckInCard,
  buildScheduledTaskFailureCard,
} from '../scheduled-tasks/presentation.js';
import { createScheduledTaskService } from '../scheduled-tasks/service.js';
import { createFileScheduledTaskStore } from '../scheduled-tasks/store.js';
import type { ScheduledTaskCreate } from '../scheduled-tasks/types.js';
import {
  makeScheduledRun,
  makeScheduledTask,
} from './scheduled-task-test-fixtures.js';

function makeTaskCreate(overrides: Partial<ScheduledTaskCreate> = {}): ScheduledTaskCreate {
  const task = makeScheduledTask();
  return {
    name: task.name,
    schedule: task.schedule,
    action: task.action,
    executionContext: task.executionContext,
    delivery: task.delivery,
    misfirePolicy: task.misfirePolicy,
    retryPolicy: task.retryPolicy,
    owner: task.owner,
    ...overrides,
  };
}

describe('scheduled task runtime host', () => {
  it('builds a read-only isolated workspace plan without mounting project directories', () => {
    const sandbox = path.join(os.tmpdir(), 'cti-scheduled-task-sandbox');
    const plan = createScheduledTaskIsolatedWorkspacePlan(sandbox, [
      { path: 'C:\\runtime\\cti-home', reason: 'bridge runtime data' },
      { path: 'C:\\memory', reason: 'memory repository' },
    ], '2026-07-18T08:00:00.000Z');

    assert.equal(plan.primaryWorkspace.path, path.resolve(sandbox));
    assert.equal(plan.primaryWorkspace.accessMode, 'read_only');
    assert.deepEqual(plan.primaryWorkspace.evidenceIds, ['scheduled_task_runtime']);
    assert.equal(plan.primaryWorkspace.expiresAfterTurn, true);
    assert.deepEqual(plan.temporaryMounts, []);
    assert.deepEqual(plan.deniedRoots, [
      { path: path.resolve('C:\\runtime\\cti-home'), reason: 'bridge runtime data' },
      { path: path.resolve('C:\\memory'), reason: 'memory repository' },
    ]);
    assert.equal(plan.resolvedFrom, 'default');
    assert.equal(plan.createdAt, '2026-07-18T08:00:00.000Z');
  });

  it('removes an isolated scheduled-task sandbox after the agent turn', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-task-parent-'));
    let sandboxPath = '';
    try {
      const result = await withScheduledTaskIsolatedWorkspace({ tempRoot, deniedRoots: [] }, async (plan) => {
        sandboxPath = plan.primaryWorkspace.path;
        assert.equal(fs.existsSync(sandboxPath), true);
        return 'done';
      });

      assert.equal(result, 'done');
      assert.equal(fs.existsSync(sandboxPath), false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('re-resolves a bound workspace and fails closed before an agent run', async () => {
    let agentRuns = 0;
    const execute = createScheduledTaskRunExecutor({
      resolveWorkspacePlan: async () => ({ ok: false, error: '绑定工作区已越界' }),
      runAgentTurn: async () => {
        agentRuns += 1;
        return { ok: true, deliveryPayload: { text: '不应执行' } };
      },
      deliver: async () => ({ ok: true }),
      tools: new Map(),
      sleep: async () => {},
    });

    const result = await execute({
      task: makeScheduledTask({
        executionContext: {
          sourceSessionId: 'session_bound',
          workspaceMode: 'bound',
          workspaceId: 'workspace_test',
        },
      }),
      run: makeScheduledRun(),
      mode: 'full',
    });

    assert.equal(result.executionStatus, 'error');
    assert.equal(result.errorKind, 'workspace_unavailable');
    assert.match(result.error || '', /工作区/u);
    assert.equal(agentRuns, 0);
  });

  it('delivers a fixed notification through the injected delivery boundary', async () => {
    const delivered: string[] = [];
    const execute = createScheduledTaskRunExecutor({
      resolveWorkspacePlan: async () => assert.fail('notify must not resolve a workspace'),
      runAgentTurn: async () => assert.fail('notify must not start an agent'),
      deliver: async ({ payload }) => {
        delivered.push(payload.text || '');
        return { ok: true, messageId: 'om_notify' };
      },
      tools: new Map(),
      sleep: async () => {},
    });

    const result = await execute({
      task: makeScheduledTask({
        action: { kind: 'notify', text: '该查看每日单子了' },
      }),
      run: makeScheduledRun(),
      mode: 'full',
    });

    assert.deepEqual(delivered, ['该查看每日单子了']);
    assert.equal(result.executionStatus, 'ok');
    assert.equal(result.deliveryStatus, 'delivered');
    assert.equal(result.messageId, 'om_notify');
  });

  it('rejects an unregistered controlled tool without executing arbitrary input', async () => {
    const execute = createScheduledTaskRunExecutor({
      resolveWorkspacePlan: async () => assert.fail('tool must not resolve a workspace'),
      runAgentTurn: async () => assert.fail('tool must not start an agent'),
      deliver: async () => assert.fail('failed tool must not deliver'),
      tools: new Map(),
      sleep: async () => {},
    });

    const result = await execute({
      task: makeScheduledTask({
        action: {
          kind: 'controlled_tool',
          toolName: 'shell.anything',
          input: { command: 'whoami' },
        },
      }),
      run: makeScheduledRun(),
      mode: 'full',
    });

    assert.equal(result.executionStatus, 'error');
    assert.equal(result.errorKind, 'tool_not_allowed');
  });

  it('uses registry idempotence instead of trusting the task payload', async () => {
    let toolRuns = 0;
    const execute = createScheduledTaskRunExecutor({
      resolveWorkspacePlan: async () => assert.fail('tool must not resolve a workspace'),
      runAgentTurn: async () => assert.fail('tool must not start an agent'),
      deliver: async () => assert.fail('failed tool must not deliver'),
      tools: new Map([[
        'tool.external_write',
        {
          name: 'tool.external_write',
          idempotent: false,
          requiredRole: 'owner',
          execute: async () => {
            toolRuns += 1;
            return {
              ok: false,
              error: '503 Service Unavailable',
              executionStarted: true,
            };
          },
        },
      ]]),
      sleep: async () => {},
    });

    const result = await execute({
      task: makeScheduledTask({
        action: {
          kind: 'controlled_tool',
          toolName: 'tool.external_write',
          input: {},
          idempotent: true,
        },
      }),
      run: makeScheduledRun(),
      mode: 'full',
    });

    assert.equal(toolRuns, 1);
    assert.equal(result.executionStatus, 'error');
  });

  it('aborts an active agent run when the runtime is stopping', async () => {
    const runtime = new AbortController();
    let childAbortSeen = false;
    const execute = createScheduledTaskRunExecutor({
      resolveWorkspacePlan: async () => assert.fail('isolated task must not resolve a workspace'),
      runAgentTurn: async ({ signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          childAbortSeen = true;
          resolve({ ok: false, error: 'runtime stopping', errorKind: 'unknown', executionStarted: true });
        }, { once: true });
      }),
      deliver: async () => assert.fail('cancelled task must not deliver'),
      tools: new Map(),
      runtimeSignal: runtime.signal,
      sleep: async () => {},
    });
    const pending = execute({
      task: makeScheduledTask({
        action: { kind: 'agent_turn', prompt: '后台运行', sessionMode: 'isolated' },
        executionContext: { sourceSessionId: 'session_1', workspaceMode: 'none' },
      }),
      run: makeScheduledRun(),
      mode: 'full',
    });

    runtime.abort('bridge shutdown');
    const result = await Promise.race([
      pending,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);

    assert.notEqual(result, 'timeout');
    assert.equal(childAbortSeen, true);
  });

  it('requires owner role to create a controlled tool task', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-host-'));
    try {
      const store = createFileScheduledTaskStore(root, {
        now: () => '2026-07-18T08:00:00.000Z',
        idFactory: () => 'task_host_001',
      });
      const service = createScheduledTaskService({
        store,
        now: () => '2026-07-18T08:00:00.000Z',
        execute: async () => ({ executionStatus: 'ok', deliveryStatus: 'not_requested' }),
      });
      const host = createScheduledTaskHost({ store, service });
      const controlled = makeTaskCreate({
        action: {
          kind: 'controlled_tool',
          toolName: 'tool.approved',
          input: {},
        },
      });

      await assert.rejects(
        () => host.create({
          task: controlled,
          actor: { role: 'operator', channelType: 'feishu', userId: 'ou_operator' },
        }),
        /Owner/u,
      );

      const created = await host.create({
        task: controlled,
        actor: { role: 'owner', channelType: 'feishu', userId: 'ou_owner' },
      });
      assert.equal(created.task.id, 'task_host_001');
      assert.equal(created.state.nextRunAt, '2026-07-20T02:30:00.000Z');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('adapts trusted bridge create inputs and lets a viewer manage their own low-risk task', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-bridge-host-'));
    try {
      const store = createFileScheduledTaskStore(root, {
        now: () => '2026-07-18T08:00:00.000Z',
        idFactory: () => 'task_bridge_001',
      });
      const service = createScheduledTaskService({
        store,
        now: () => '2026-07-18T08:00:00.000Z',
        execute: async () => ({ executionStatus: 'ok', deliveryStatus: 'not_requested' }),
      });
      const host = createBridgeScheduledTaskActionHost({ store, service });
      const created = await host.create({
        name: '每日单子',
        schedule: { kind: 'cron', expression: '30 10 * * 1-5', timezone: 'Asia/Shanghai' },
        taskAction: { kind: 'agent_turn', prompt: '查询并发送每日单子', sessionMode: 'bound' },
        executionContext: { sourceSessionId: 'session_1', workspaceMode: 'bound' },
        delivery: {
          target: { channelType: 'feishu', chatId: 'oc_123', userId: 'ou_1', chatType: 'group' },
          mode: 'result',
        },
        actor: { role: 'viewer', channelType: 'feishu', userId: 'ou_1', messageId: 'om_1' },
      });

      assert.equal(created.ok, true);
      assert.equal(created.taskId, 'task_bridge_001');
      assert.equal(created.nextRunAt, '2026-07-20T02:30:00.000Z');
      const stored = await store.getTask('task_bridge_001');
      assert.equal(stored?.delivery.chatId, 'oc_123');
      assert.equal(stored?.owner.userId, 'ou_1');
      assert.equal(stored?.executionContext.sourceSessionId, 'session_1');

      const paused = await host.pause({ taskId: 'task_bridge_001', actor: { role: 'viewer', channelType: 'feishu', userId: 'ou_1' } });
      assert.equal(paused.ok, true);
      assert.equal((await store.getTask('task_bridge_001'))?.enabled, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('records a verified member once per delivered check-in run and rebuilds the card count', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-check-in-host-'));
    try {
      const store = createFileScheduledTaskStore(root, {
        now: () => '2026-07-18T08:10:00.000Z',
        idFactory: () => 'task_check_in_001',
      });
      const service = createScheduledTaskService({
        store,
        now: () => '2026-07-18T08:10:00.000Z',
        execute: async () => ({ executionStatus: 'ok', deliveryStatus: 'not_requested' }),
      });
      const host = createBridgeScheduledTaskActionHost({
        store,
        service,
        now: () => '2026-07-18T08:10:00.000Z',
      });
      const created = await host.create({
        name: '喝水打卡',
        schedule: { kind: 'cron', expression: '0 8 * * *', timezone: 'Asia/Shanghai' },
        taskAction: {
          kind: 'check_in', text: '喝水后打卡', audience: 'chat_members',
          buttonText: '我喝水了', successText: '今天也要多喝水。', windowMs: 3_600_000,
        },
        executionContext: { sourceSessionId: 'session_1', workspaceMode: 'none' },
        delivery: {
          target: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_owner', chatType: 'group' },
          mode: 'result',
        },
        actor: { role: 'viewer', channelType: 'feishu', chatId: 'oc_group', userId: 'ou_owner', messageId: 'om_create' },
      });
      const run = makeScheduledRun({
        taskId: created.taskId!,
        runId: `${created.taskId}:2026-07-18T08:00:00.000Z:1`,
        slotKey: 'slot_check_in_host_001',
        queuedAt: '2026-07-18T08:00:00.000Z',
        startedAt: '2026-07-18T08:00:00.000Z',
        endedAt: '2026-07-18T08:00:01.000Z',
        executionStatus: 'ok',
        deliveryStatus: 'delivered',
        messageId: 'om_check_in_card',
      });
      await store.appendRun(run);

      const input = {
        taskId: created.taskId!, slotKey: run.slotKey,
        actor: { role: 'viewer' as const, channelType: 'feishu', chatId: 'oc_group', userId: 'ou_member' },
        callbackMessageId: 'om_check_in_card', verifiedChatMember: true,
      };
      const first = await host.checkIn!(input);
      const duplicate = await host.checkIn!(input);
      const history = await host.history({
        taskId: created.taskId!,
        actor: { role: 'viewer', channelType: 'feishu', chatId: 'oc_group', userId: 'ou_owner' },
      });

      assert.equal(first.checkInStatus, 'recorded');
      assert.equal(first.checkInCount, 1);
      assert.equal(first.message, '今天也要多喝水。');
      assert.match(first.feishuCardJson || '', /已打卡 1 人/u);
      assert.match(first.feishuCardJson || '', /scheduled-check-in:task_check_in_001:slot_check_in_host_001/u);
      assert.equal(duplicate.checkInStatus, 'already_recorded');
      assert.equal((history.runs[0] as { checkInCount?: number }).checkInCount, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers before polling and stops accepting scheduler ticks during shutdown', async () => {
    const calls: string[] = [];
    let intervalHandler: (() => void) | undefined;
    let cleared = false;
    const scheduler = createScheduledTaskScheduler({
      service: {
        recover: async () => { calls.push('recover'); return 0; },
        tick: async () => { calls.push('tick'); return 0; },
        ensureTaskState: async () => assert.fail('not used'),
        runNow: async () => assert.fail('not used'),
      },
      pollMs: 5000,
      setInterval: (handler: () => void) => {
        intervalHandler = handler;
        return 1 as unknown as NodeJS.Timeout;
      },
      clearInterval: () => { cleared = true; },
    });

    await scheduler.start();
    assert.deepEqual(calls, ['recover', 'tick']);
    intervalHandler?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['recover', 'tick', 'tick']);
    scheduler.stop();
    intervalHandler?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cleared, true);
    assert.deepEqual(calls, ['recover', 'tick', 'tick']);
  });

  it('builds Feishu task and failure cards from redacted summaries only', () => {
    const card = buildScheduledTaskCard({
      taskId: 'task_card_001',
      name: '每日单子',
      actionKind: 'agent_turn',
      scheduleKind: 'cron',
      timezone: 'Asia/Shanghai',
      nextRunAt: '2026-07-20T02:30:00.000Z',
      enabled: true,
    });
    for (const expected of [
      '每日单子', '动态 Agent 任务', 'Asia/Shanghai', '2026-07-20',
      'scheduled-task:pause:task_card_001',
      'scheduled-task:run:task_card_001',
      'scheduled-task:history:task_card_001',
      'scheduled-task:delete:task_card_001',
    ]) assert.match(card, new RegExp(expected));

    const failure = buildScheduledTaskFailureCard({
      taskId: 'task_card_001',
      runId: 'run_failed_001',
      name: '每日单子',
      error: '投递超时',
      executionStatus: 'ok',
      deliveryStatus: 'failed',
    });
    assert.match(failure, /scheduled-task:retry-delivery:run_failed_001/);
    assert.doesNotMatch(failure, /token|完整工具日志|file contents/iu);

    const checkIn = buildScheduledTaskCheckInCard({
      taskId: 'task_card_001', slotKey: 'slot_card_001', name: '喝水打卡', text: '请喝水',
      buttonText: '我喝水了', checkInCount: 2, closesAt: '2026-07-20T03:30:00.000Z',
    });
    assert.match(checkIn, /已打卡 2 人/u);
    assert.match(checkIn, /scheduled-check-in:task_card_001:slot_card_001/u);
    assert.doesNotMatch(checkIn, /ou_|open_id|userId/u);
  });
});
