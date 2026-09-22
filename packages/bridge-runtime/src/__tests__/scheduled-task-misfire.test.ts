import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createScheduledTaskService } from '../scheduled-tasks/service.js';
import { createFileScheduledTaskStore } from '../scheduled-tasks/store.js';
import { makeScheduledTask, makeScheduledRun } from './scheduled-task-test-fixtures.js';

function createInput(overrides: Partial<ReturnType<typeof makeScheduledTask>> = {}) {
  const task = makeScheduledTask(overrides);
  return {
    name: task.name, schedule: task.schedule, action: task.action,
    executionContext: task.executionContext, delivery: task.delivery,
    misfirePolicy: task.misfirePolicy, retryPolicy: task.retryPolicy, owner: task.owner,
  };
}

describe('scheduled task misfire recovery', () => {
  for (const scenario of [
    { name: 'drops old hourly notifications', action: 'notify', clock: '2026-09-18T07:19:00.000Z', mode: 'run_latest', count: 0 },
    { name: 'drops old hourly check-in cards', action: 'check_in', clock: '2026-09-18T07:19:00.000Z', mode: 'run_latest', count: 0 },
    { name: 'catches up only the latest eligible occurrence', action: 'notify', clock: '2026-09-18T07:10:00.000Z', mode: 'run_latest', count: 1 },
    { name: 'skip policy discards accumulated occurrences', action: 'notify', clock: '2026-09-18T07:10:00.000Z', mode: 'skip', count: 0 },
    { name: 'queued recovery applies the same expiry gate', action: 'check_in', clock: '2026-09-18T07:19:00.000Z', mode: 'run_latest', count: 0, queued: true },
    { name: 'missing state does not replay task creation history', action: 'notify', clock: '2026-09-18T07:19:00.000Z', mode: 'run_latest', count: 0, missing: true },
  ] as const) {
    it(scenario.name, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-misfire-'));
      try {
        const store = createFileScheduledTaskStore(root, { now: () => '2026-07-20T00:00:00.000Z' });
        const task = await store.createTask(createInput({
          schedule: { kind: 'cron', expression: '0 10-12,14-19 * * 1-5', timezone: 'Asia/Shanghai' },
          action: scenario.action === 'notify' ? { kind: 'notify', text: '提醒' } : {
            kind: 'check_in', text: '打卡', buttonText: '完成', successText: '成功', audience: 'chat_members', windowMs: 86_400_000,
          },
          misfirePolicy: { mode: scenario.mode, maxLatenessMs: 900_000 },
        }));
        if (!('missing' in scenario)) await store.compareAndSetState(task.id, 0, {
          taskId: task.id, nextRunAt: '2026-07-20T02:00:00.000Z',
          queuedRunId: 'queued' in scenario ? 'old_queued' : undefined,
          consecutiveErrors: 0, consecutiveSkipped: 0,
        });
        let clock: string = scenario.clock;
        const executions: string[] = [];
        const service = createScheduledTaskService({ store, now: () => clock, execute: async ({ run }) => {
          executions.push(run.scheduledFor);
          return { executionStatus: 'ok', deliveryStatus: 'delivered' };
        } });
        await service.recover();
        await service.tick();
        // Repeated 15-second polls and a fresh service must not drain historical slots.
        for (let i = 0; i < 4; i++) {
          clock = new Date(new Date(clock).getTime() + 15_000).toISOString();
          assert.equal(await service.tick(), 0);
        }
        const restarted = createScheduledTaskService({ store, now: () => clock, execute: async () => {
          assert.fail('restart replayed a consumed window');
        } });
        await restarted.recover();
        assert.equal(await restarted.tick(), 0);
        assert.equal(executions.length, scenario.count);
        if (scenario.count) assert.deepEqual(executions, ['2026-09-18T07:00:00.000Z']);
        assert.equal((await store.getState(task.id))?.nextRunAt, '2026-09-18T08:00:00.000Z');
        assert.equal((await store.listRuns(task.id)).length, 1);
        clock = '2026-09-18T08:00:12.000Z';
        await service.tick();
        assert.equal(executions.length, scenario.count + 1);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }

  it('expires a one-shot without sending it and never re-admits it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-misfire-once-'));
    try {
      const store = createFileScheduledTaskStore(root, { now: () => '2026-07-20T00:00:00.000Z' });
      const task = await store.createTask(createInput({
        schedule: { kind: 'at', at: '2026-07-20T02:00:00.000Z', timezone: 'UTC' },
      }));
      const service = createScheduledTaskService({ store, now: () => '2026-09-18T07:19:00.000Z', execute: async () => assert.fail('stale one-shot executed') });
      assert.equal(await service.tick(), 1);
      assert.equal(await service.tick(), 0);
      assert.equal((await store.getState(task.id))?.nextRunAt, undefined);
      assert.equal((await store.listRuns(task.id))[0]?.errorKind, 'misfire_skipped');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  for (const status of ['running', 'ok'] as const) {
    it(`recovers stale ${status} runs without executing or delivering their backlog`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-misfire-recovery-'));
      try {
        const store = createFileScheduledTaskStore(root, { now: () => '2026-07-20T00:00:00.000Z' });
        const task = await store.createTask(createInput());
        const run = makeScheduledRun({ taskId: task.id, executionStatus: status, deliveryStatus: 'failed', deliveryPayload: { text: '旧结果' } });
        await store.appendRun(run);
        await store.compareAndSetState(task.id, 0, {
          taskId: task.id, nextRunAt: run.scheduledFor, runningRunId: run.runId,
          runningLeaseUntil: '2026-07-20T03:00:00.000Z', consecutiveErrors: 0, consecutiveSkipped: 0,
        });
        const service = createScheduledTaskService({ store, now: () => '2026-09-18T07:19:00.000Z', execute: async () => assert.fail('stale recovery executed') });
        assert.equal(await service.recover(), 1);
        assert.equal(await service.tick(), 0);
        assert.equal((await store.getState(task.id))?.nextRunAt, '2026-09-21T02:30:00.000Z');
        const result = (await store.listRuns(task.id))[0];
        assert.equal(result?.errorKind, status === 'ok' ? 'misfire_delivery_skipped' : 'interrupted_by_restart');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }

  it('advances past intervals missed while execution was in progress', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-misfire-slow-'));
    try {
      const store = createFileScheduledTaskStore(root, { now: () => '2026-09-18T07:00:00.000Z' });
      const task = await store.createTask(createInput({ schedule: {
        kind: 'every', everyMs: 60_000, anchorAt: '2026-09-18T07:00:00.000Z',
      } }));
      let clock = '2026-09-18T07:01:00.000Z';
      const service = createScheduledTaskService({ store, now: () => clock, execute: async () => {
        clock = '2026-09-18T07:11:12.000Z';
        return { executionStatus: 'ok', deliveryStatus: 'delivered' };
      } });
      await service.tick();
      assert.equal((await store.getState(task.id))?.nextRunAt, '2026-09-18T07:12:00.000Z');
      assert.equal(await service.tick(), 0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
