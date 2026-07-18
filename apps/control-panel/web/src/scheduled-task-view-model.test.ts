import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildScheduledTaskStatus,
  describeScheduledTaskAction,
  describeScheduledTaskSchedule,
  getScheduledTaskCapability,
} from './scheduled-task-view-model.js';

describe('scheduled task view model', () => {
  it('marks failed execution or delivery as attention', () => {
    assert.deepEqual(
      buildScheduledTaskStatus({ enabled: true, running: false, lastRunStatus: 'error' }),
      { kind: 'attention', label: '失败' },
    );
    assert.deepEqual(
      buildScheduledTaskStatus({ enabled: true, running: false, lastDeliveryStatus: 'failed' }),
      { kind: 'attention', label: '投递失败' },
    );
  });

  it('distinguishes running, paused, and healthy tasks', () => {
    assert.deepEqual(buildScheduledTaskStatus({ enabled: true, running: true }), { kind: 'normal', label: '运行中' });
    assert.deepEqual(buildScheduledTaskStatus({ enabled: false, running: false }), { kind: 'disabled', label: '已暂停' });
    assert.deepEqual(buildScheduledTaskStatus({ enabled: true, running: false, lastRunStatus: 'ok' }), { kind: 'normal', label: '正常' });
  });

  it('formats schedule and action without leaking payload contents', () => {
    assert.equal(describeScheduledTaskSchedule({ kind: 'cron', expression: '30 10 * * 1-5', timezone: 'Asia/Shanghai' }), 'Cron 30 10 * * 1-5 · Asia/Shanghai');
    assert.equal(describeScheduledTaskAction({ kind: 'agent_turn' }), '动态 Agent 任务');
    assert.equal(describeScheduledTaskAction({ kind: 'controlled_tool', toolName: 'shell.exec' }), '受控工具 · shell.exec');
  });

  it('disables capabilities that the active runtime does not expose', () => {
    assert.deepEqual(getScheduledTaskCapability({ runNow: false }, 'runNow'), {
      enabled: false,
      reason: '当前计划任务 CLI 尚未连接运行中的 Bridge，暂不支持立即运行。',
    });
    assert.deepEqual(getScheduledTaskCapability({ runNow: true }, 'runNow'), { enabled: true, reason: '' });
  });
});
