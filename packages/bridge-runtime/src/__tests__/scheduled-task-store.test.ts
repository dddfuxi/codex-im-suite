import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createFileScheduledTaskStore,
  type FileScheduledTaskStoreOptions,
} from '../scheduled-tasks/store.js';
import type {
  ScheduledTaskCreate,
  ScheduledTaskState,
} from '../scheduled-tasks/types.js';
import {
  makeScheduledRun,
  makeScheduledTask,
} from './scheduled-task-test-fixtures.js';

function makeTaskCreate(): ScheduledTaskCreate {
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
  };
}

function makeStore(root: string, overrides: Partial<FileScheduledTaskStoreOptions> = {}) {
  return createFileScheduledTaskStore(root, {
    now: () => '2026-07-18T08:00:00.000Z',
    idFactory: () => 'task_store_001',
    ...overrides,
  });
}

describe('file scheduled task store', () => {
  it('creates, lists, and updates tasks with optimistic versions', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-store-'));
    try {
      const store = makeStore(root);
      const created = await store.createTask(makeTaskCreate());
      assert.equal(created.id, 'task_store_001');
      assert.equal(created.version, 1);
      assert.equal(created.enabled, true);

      const listed = await store.listTasks();
      assert.deepEqual(listed.map((task) => task.id), ['task_store_001']);

      const updated = await store.updateTask(created.id, created.version, {
        enabled: false,
        name: '暂停的每日单子',
      });
      assert.equal(updated.version, 2);
      assert.equal(updated.enabled, false);
      assert.equal(updated.name, '暂停的每日单子');

      await assert.rejects(
        () => store.updateTask(created.id, created.version, { enabled: true }),
        /版本冲突/u,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('isolates malformed tasks without dropping valid tasks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-quarantine-'));
    try {
      const store = makeStore(root);
      await store.createTask(makeTaskCreate());
      const malformedPath = path.join(root, 'tasks', 'broken.json');
      fs.writeFileSync(malformedPath, '{bad', 'utf8');

      const listed = await store.listTasks();
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.id, 'task_store_001');
      assert.equal(fs.existsSync(malformedPath), false);

      const quarantineFiles = fs.readdirSync(path.join(root, 'quarantine'));
      assert.equal(quarantineFiles.length, 2);
      assert.ok(quarantineFiles.some((name) => name.endsWith('.invalid.json')));
      assert.ok(quarantineFiles.some((name) => name.endsWith('.error.json')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('compares and sets task state without overwriting newer state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-state-'));
    try {
      const store = makeStore(root);
      const task = await store.createTask(makeTaskCreate());
      const initial: ScheduledTaskState = {
        taskId: task.id,
        nextRunAt: '2026-07-20T02:30:00.000Z',
        consecutiveErrors: 0,
        consecutiveSkipped: 0,
      };
      const state1 = await store.compareAndSetState(task.id, 0, initial);
      assert.equal(state1.version, 1);

      const state2 = await store.compareAndSetState(task.id, state1.version, {
        ...state1,
        queuedRunId: 'run_1',
      });
      assert.equal(state2.version, 2);
      assert.equal(state2.queuedRunId, 'run_1');

      await assert.rejects(
        () => store.compareAndSetState(task.id, state1.version, initial),
        /版本冲突/u,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('appends run records and returns newest runs first', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-runs-'));
    try {
      const store = makeStore(root);
      const task = await store.createTask(makeTaskCreate());
      await store.appendRun(makeScheduledRun({
        taskId: task.id,
        runId: 'run_older',
        queuedAt: '2026-07-18T08:00:00.000Z',
      }));
      await store.appendRun(makeScheduledRun({
        taskId: task.id,
        runId: 'run_newer',
        queuedAt: '2026-07-18T09:00:00.000Z',
      }));

      const runs = await store.listRuns(task.id, 1);
      assert.deepEqual(runs.map((run) => run.runId), ['run_newer']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not leave temporary files after successful writes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-temp-'));
    try {
      const store = makeStore(root);
      const task = await store.createTask(makeTaskCreate());
      await store.updateTask(task.id, task.version, { enabled: false });
      const files = fs.readdirSync(path.join(root, 'tasks'));
      assert.equal(files.some((name) => name.endsWith('.tmp')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
