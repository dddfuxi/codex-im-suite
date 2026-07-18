import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createScheduledSlotKey,
  createScheduledTaskService,
} from '../scheduled-tasks/service.js';
import { createFileScheduledTaskStore } from '../scheduled-tasks/store.js';
import type {
  ScheduledTaskCreate,
  ScheduledTaskRun,
} from '../scheduled-tasks/types.js';
import { makeScheduledTask } from './scheduled-task-test-fixtures.js';

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

describe('scheduled task service', () => {
  it('admits one run for one scheduled slot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-service-'));
    try {
      const store = createFileScheduledTaskStore(root, {
        now: () => '2026-07-18T08:00:00.000Z',
        idFactory: () => 'task_service_001',
      });
      const task = await store.createTask(makeTaskCreate());
      const executions: ScheduledTaskRun[] = [];
      const service = createScheduledTaskService({
        store,
        now: () => '2026-07-20T02:30:00.000Z',
        execute: async ({ run }) => {
          executions.push(run);
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { executionStatus: 'ok', deliveryStatus: 'delivered' };
        },
      });

      await Promise.all([service.tick(), service.tick()]);

      assert.equal(executions.length, 1);
      assert.equal(
        executions[0]?.slotKey,
        createScheduledSlotKey(task.id, '2026-07-20T02:30:00.000Z'),
      );
      assert.equal((await store.listRuns(task.id, 10)).length, 1);
      const state = await store.getState(task.id);
      assert.equal(state?.lastRunStatus, 'ok');
      assert.equal(state?.nextRunAt, '2026-07-21T02:30:00.000Z');
      assert.equal(state?.queuedRunId, undefined);
      assert.equal(state?.runningRunId, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs manually without changing the natural next run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-manual-'));
    try {
      const store = createFileScheduledTaskStore(root, {
        now: () => '2026-07-18T08:00:00.000Z',
        idFactory: () => 'task_manual_001',
      });
      const task = await store.createTask(makeTaskCreate());
      const service = createScheduledTaskService({
        store,
        now: () => '2026-07-18T09:00:00.000Z',
        execute: async () => ({ executionStatus: 'ok', deliveryStatus: 'not_requested' }),
      });

      const before = await service.ensureTaskState(task.id);
      assert.equal(before.nextRunAt, '2026-07-20T02:30:00.000Z');

      const run = await service.runNow(task.id);

      assert.equal(run.trigger, 'manual');
      const after = await store.getState(task.id);
      assert.equal(after?.nextRunAt, before.nextRunAt);
      assert.equal(after?.lastRunStatus, 'ok');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips an overlapping slot and advances the schedule', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-overlap-'));
    try {
      const store = createFileScheduledTaskStore(root, {
        now: () => '2026-07-18T08:00:00.000Z',
        idFactory: () => 'task_overlap_001',
      });
      const task = await store.createTask(makeTaskCreate());
      await store.compareAndSetState(task.id, 0, {
        taskId: task.id,
        nextRunAt: '2026-07-20T02:30:00.000Z',
        runningRunId: 'run_existing',
        runningLeaseUntil: '2026-07-20T03:00:00.000Z',
        consecutiveErrors: 0,
        consecutiveSkipped: 0,
      });
      let executed = false;
      const service = createScheduledTaskService({
        store,
        now: () => '2026-07-20T02:30:00.000Z',
        execute: async () => {
          executed = true;
          return { executionStatus: 'ok', deliveryStatus: 'delivered' };
        },
      });

      await service.tick();

      assert.equal(executed, false);
      const runs = await store.listRuns(task.id, 10);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.executionStatus, 'skipped');
      assert.equal(runs[0]?.errorKind, 'overlap_skipped');
      const state = await store.getState(task.id);
      assert.equal(state?.nextRunAt, '2026-07-21T02:30:00.000Z');
      assert.equal(state?.consecutiveSkipped, 1);
      assert.equal(state?.runningRunId, 'run_existing');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('marks an expired unknown run interrupted without replaying it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-recovery-'));
    try {
      const store = createFileScheduledTaskStore(root, {
        now: () => '2026-07-18T08:00:00.000Z',
        idFactory: () => 'task_recovery_001',
      });
      const task = await store.createTask(makeTaskCreate());
      await store.compareAndSetState(task.id, 0, {
        taskId: task.id,
        nextRunAt: '2026-07-20T02:30:00.000Z',
        runningRunId: 'run_interrupted',
        runningLeaseUntil: '2026-07-20T02:20:00.000Z',
        consecutiveErrors: 0,
        consecutiveSkipped: 0,
      });
      await store.appendRun({
        schema: 'codex-im-suite/scheduled-task-run/v1',
        taskId: task.id,
        runId: 'run_interrupted',
        slotKey: 'slot_interrupted',
        scheduledFor: '2026-07-20T02:30:00.000Z',
        trigger: 'scheduled',
        attempt: 1,
        queuedAt: '2026-07-20T02:10:00.000Z',
        startedAt: '2026-07-20T02:11:00.000Z',
        executionStatus: 'running',
        deliveryStatus: 'pending',
      });
      let executed = false;
      const service = createScheduledTaskService({
        store,
        now: () => '2026-07-20T02:30:00.000Z',
        execute: async () => {
          executed = true;
          return { executionStatus: 'ok', deliveryStatus: 'delivered' };
        },
      });

      const recovered = await service.recover();

      assert.equal(recovered, 1);
      assert.equal(executed, false);
      const run = (await store.listRuns(task.id, 10))[0];
      assert.equal(run?.executionStatus, 'error');
      assert.equal(run?.errorKind, 'interrupted_by_restart');
      const state = await store.getState(task.id);
      assert.equal(state?.runningRunId, undefined);
      assert.equal(state?.lastRunStatus, 'error');
      assert.equal(state?.consecutiveErrors, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers a successful execution by retrying delivery only', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-delivery-recovery-'));
    try {
      const store = createFileScheduledTaskStore(root, {
        now: () => '2026-07-18T08:00:00.000Z',
        idFactory: () => 'task_delivery_001',
      });
      const task = await store.createTask(makeTaskCreate());
      await store.compareAndSetState(task.id, 0, {
        taskId: task.id,
        nextRunAt: '2026-07-20T02:30:00.000Z',
        runningRunId: 'run_delivery_failed',
        runningLeaseUntil: '2026-07-20T02:20:00.000Z',
        consecutiveErrors: 0,
        consecutiveSkipped: 0,
      });
      await store.appendRun({
        schema: 'codex-im-suite/scheduled-task-run/v1',
        taskId: task.id,
        runId: 'run_delivery_failed',
        slotKey: 'slot_delivery_failed',
        scheduledFor: '2026-07-20T02:30:00.000Z',
        trigger: 'scheduled',
        attempt: 1,
        queuedAt: '2026-07-20T02:10:00.000Z',
        startedAt: '2026-07-20T02:11:00.000Z',
        endedAt: '2026-07-20T02:12:00.000Z',
        executionStatus: 'ok',
        deliveryStatus: 'failed',
        deliveryPayload: { text: '已经生成的每日单子' },
        error: '503 Service Unavailable',
      });
      const modes: string[] = [];
      const service = createScheduledTaskService({
        store,
        now: () => '2026-07-20T02:30:00.000Z',
        execute: async ({ mode, previousRun }) => {
          modes.push(mode);
          assert.equal(previousRun?.deliveryPayload?.text, '已经生成的每日单子');
          return {
            executionStatus: 'ok',
            deliveryStatus: 'delivered',
            deliveryPayload: previousRun?.deliveryPayload,
            messageId: 'om_recovered',
          };
        },
      });

      const recovered = await service.recover();

      assert.equal(recovered, 1);
      assert.deepEqual(modes, ['delivery_only']);
      const run = (await store.listRuns(task.id, 10))[0];
      assert.equal(run?.deliveryStatus, 'delivered');
      assert.equal(run?.messageId, 'om_recovered');
      const state = await store.getState(task.id);
      assert.equal(state?.runningRunId, undefined);
      assert.equal(state?.nextRunAt, '2026-07-21T02:30:00.000Z');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
