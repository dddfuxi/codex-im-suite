import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createBridgeScheduledTaskActionHost,
  createScheduledTaskHost,
  createScheduledTaskRunExecutor,
  createScheduledTaskScheduler,
} from '../scheduled-task-host.js';
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
});
