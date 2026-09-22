import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyScheduledTaskMigrationPlan,
  buildScheduledTaskMigrationPlan,
} from '../scheduled-tasks/migration.js';
import { createFileScheduledTaskStore } from '../scheduled-tasks/store.js';

function writeReminder(root: string, name: string, body: string): string {
  const directory = path.join(root, 'data', 'todos', 'direct-reminders');
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

describe('scheduled task direct reminder migration', () => {
  it('builds a dry-run plan without writing the scheduled task store', () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-reminder-migration-plan-'));
    const scheduledTasksRoot = path.join(memoryRoot, '..', `scheduled-${path.basename(memoryRoot)}`);
    try {
      writeReminder(memoryRoot, 'pending.md', [
        '---', 'channelType: feishu', 'chatId: oc_pending', 'createdByMessageId: om_pending', 'sourceType: direct', '---',
        '待办: 每日单子 @2026-07-20 10:30 状态: 未完成',
      ].join('\n'));
      writeReminder(memoryRoot, 'done.md', [
        '---', 'channelType: feishu', 'chatId: oc_done', 'sourceType: direct', '---',
        '待办: 已完成事项 @2026-07-20 10:30 状态: 完成',
      ].join('\n'));
      writeReminder(memoryRoot, 'broken.md', '这不是可识别的 direct reminder');

      const plan = buildScheduledTaskMigrationPlan({ memoryRoot, scheduledTasksRoot, now: '2026-07-18T08:00:00.000Z' });

      assert.equal(plan.schema, 'codex-im-suite/scheduled-task-migration/v1');
      assert.deepEqual(plan.operations.map((operation) => operation.action).sort(), ['blocked', 'create', 'skip']);
      const create = plan.operations.find((operation) => operation.action === 'create');
      assert.equal(create?.task?.schedule.kind, 'at');
      assert.equal(create?.task?.action.kind, 'notify');
      assert.equal(create?.task?.delivery.chatId, 'oc_pending');
      assert.equal(fs.existsSync(scheduledTasksRoot), false);
    } finally {
      fs.rmSync(memoryRoot, { recursive: true, force: true });
      fs.rmSync(scheduledTasksRoot, { recursive: true, force: true });
    }
  });

  it('backs up reviewed sources, creates tasks once, and records source hashes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-reminder-migration-apply-'));
    const memoryRoot = path.join(root, 'memory');
    const scheduledTasksRoot = path.join(root, 'scheduled-tasks');
    try {
      writeReminder(memoryRoot, 'pending.md', [
        '---', 'channelType: feishu', 'chatId: oc_pending', 'chatType: group', 'createdByMessageId: om_pending', 'sourceType: direct', '---',
        '待办: 每日单子 @2026-07-20 10:30 状态: 未完成',
      ].join('\n'));
      const plan = buildScheduledTaskMigrationPlan({ memoryRoot, scheduledTasksRoot, now: '2026-07-18T08:00:00.000Z' });
      const store = createFileScheduledTaskStore(scheduledTasksRoot, { now: () => '2026-07-18T08:00:00.000Z', idFactory: () => 'task_migrated_001' });
      let safetyChecks = 0;

      const applied = await applyScheduledTaskMigrationPlan(plan, {
        store,
        assertProcessesStopped: () => { safetyChecks += 1; },
        now: () => '2026-07-18T08:01:00.000Z',
      });

      assert.equal(safetyChecks, 1);
      assert.equal(applied.created, 1);
      assert.equal((await store.listTasks()).length, 1);
      assert.equal(fs.existsSync(applied.manifestPath), true);
      assert.equal(applied.entries[0].taskId, 'task_migrated_001');
      assert.equal(fs.existsSync(applied.entries[0].backupPath), true);

      const secondPlan = buildScheduledTaskMigrationPlan({ memoryRoot, scheduledTasksRoot, now: '2026-07-18T08:02:00.000Z' });
      assert.equal(secondPlan.operations[0].action, 'skip');
      assert.match(secondPlan.operations[0].reason, /已迁移/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses apply when the reviewed source changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-reminder-migration-conflict-'));
    const memoryRoot = path.join(root, 'memory');
    const scheduledTasksRoot = path.join(root, 'scheduled-tasks');
    try {
      const sourcePath = writeReminder(memoryRoot, 'pending.md', [
        '---', 'channelType: feishu', 'chatId: oc_pending', 'sourceType: direct', '---',
        '待办: 每日单子 @2026-07-20 10:30 状态: 未完成',
      ].join('\n'));
      const plan = buildScheduledTaskMigrationPlan({ memoryRoot, scheduledTasksRoot });
      fs.appendFileSync(sourcePath, '\n已被修改', 'utf8');

      await assert.rejects(
        () => applyScheduledTaskMigrationPlan(plan, {
          store: createFileScheduledTaskStore(scheduledTasksRoot),
          assertProcessesStopped: () => undefined,
        }),
        /源文件已变化/,
      );
      assert.equal((await createFileScheduledTaskStore(scheduledTasksRoot).listTasks()).length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
