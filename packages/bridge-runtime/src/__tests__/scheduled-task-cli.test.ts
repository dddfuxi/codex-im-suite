import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { executeScheduledTaskCli } from '../scheduled-task-cli.js';
import { createFileScheduledTaskStore } from '../scheduled-tasks/store.js';
import { makeScheduledTask } from './scheduled-task-test-fixtures.js';

describe('scheduled task cli', () => {
  it('lists, pauses, resumes, and reports status through the runtime store', async () => {
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-cli-'));
    try {
      const store = createFileScheduledTaskStore(path.join(ctiHome, 'data', 'scheduled-tasks'), {
        now: () => '2026-07-18T08:00:00.000Z',
        idFactory: () => 'task_cli_001',
      });
      const fixture = makeScheduledTask();
      await store.createTask({
        name: fixture.name,
        schedule: fixture.schedule,
        action: fixture.action,
        executionContext: fixture.executionContext,
        delivery: fixture.delivery,
        misfirePolicy: fixture.misfirePolicy,
        retryPolicy: fixture.retryPolicy,
        owner: fixture.owner,
      });

      const listed = await executeScheduledTaskCli(['list', '--json'], { ctiHome });
      assert.equal(listed.exitCode, 0);
      assert.equal(JSON.parse(listed.stdout).tasks[0].id, 'task_cli_001');
      assert.equal(JSON.parse(listed.stdout).items[0].task.id, 'task_cli_001');
      assert.equal(Object.hasOwn(JSON.parse(listed.stdout).items[0], 'state'), true);

      const paused = await executeScheduledTaskCli(['pause', 'task_cli_001', '--expected-version', '1', '--json'], { ctiHome });
      assert.equal(paused.exitCode, 0);
      assert.equal(JSON.parse(paused.stdout).enabled, false);

      const resumed = await executeScheduledTaskCli(['resume', 'task_cli_001', '--expected-version', '2', '--json'], { ctiHome });
      assert.equal(resumed.exitCode, 0);
      assert.equal(JSON.parse(resumed.stdout).enabled, true);

      const status = await executeScheduledTaskCli(['status', '--json'], { ctiHome });
      assert.equal(status.exitCode, 0);
      assert.deepEqual(JSON.parse(status.stdout).counts, { total: 1, enabled: 1, paused: 0, running: 0, failed: 0, quarantined: 0 });
    } finally {
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });

  it('returns non-zero stderr for invalid commands and stale versions', async () => {
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-cli-error-'));
    try {
      const unknown = await executeScheduledTaskCli(['unknown', '--json'], { ctiHome });
      assert.notEqual(unknown.exitCode, 0);
      assert.match(unknown.stderr, /未知计划任务命令/);
    } finally {
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });

  it('previews direct reminder migration without mutating the task store', async () => {
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scheduled-cli-migration-'));
    const memoryRoot = path.join(ctiHome, 'memory');
    try {
      const sourceDir = path.join(memoryRoot, 'data', 'todos', 'direct-reminders');
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'pending.md'), [
        '---', 'channelType: feishu', 'chatId: oc_cli', 'sourceType: direct', '---',
        '待办: CLI 迁移 @2026-07-20 10:30 状态: 未完成',
      ].join('\n'), 'utf8');

      const result = await executeScheduledTaskCli([
        'migrate-direct-reminders', '--memory-root', memoryRoot, '--json',
      ], { ctiHome });

      assert.equal(result.exitCode, 0);
      assert.equal(JSON.parse(result.stdout).operations[0].action, 'create');
      assert.equal(fs.existsSync(path.join(ctiHome, 'data', 'scheduled-tasks')), false);
    } finally {
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });
});
