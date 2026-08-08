import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  containsUnverifiedReminderCompletion,
  hasSchedulingTimeHint,
  hasTaskSchedulingIntent,
  parseNaturalReminderRequest,
  parseSlashReminderArgs,
} from '../../lib/bridge/application/reminders.js';

describe('bridge reminder parsing', () => {
  it('parses relative and absolute one-shot reminders', () => {
    const now = new Date('2026-04-30T02:24:00.000Z');

    assert.deepEqual(parseNaturalReminderRequest('一分钟后提醒我看电脑', now), {
      title: '看电脑',
      dueAt: '2026-04-30T02:25:00.000Z',
    });
    assert.deepEqual(parseNaturalReminderRequest('明天上午九点提醒我看消息', now), {
      title: '看消息',
      dueAt: '2026-05-01T01:00:00.000Z',
    });
  });

  it('allows implicit time-only parsing only for an explicitly supplied wake alias', () => {
    const now = new Date('2026-04-30T02:24:00.000Z');

    assert.equal(parseNaturalReminderRequest('小虾米，五点半看公告', now), null);
    assert.deepEqual(parseNaturalReminderRequest('小虾米，五点半看公告', now, {
      allowImplicitTimeOnly: true,
      invocationAliases: ['小虾米'],
    }), {
      title: '看公告',
      dueAt: '2026-04-30T09:30:00.000Z',
    });
  });

  it('rejects recurring schedules and discussion-like reminder text', () => {
    const now = new Date('2026-07-09T06:19:11.000Z');

    assert.equal(parseNaturalReminderRequest('新建任务，每天8点叫刘丹起床', now), null);
    assert.equal(parseNaturalReminderRequest('帮我写计划任务脚本，提醒我看电脑', now), null);
    assert.equal(parseNaturalReminderRequest('今天有什么待办', now), null);
  });

  it('parses slash reminder arguments without accepting unsupported text', () => {
    const now = new Date('2026-07-20T08:00:00.000Z');

    assert.deepEqual(parseSlashReminderArgs('10分钟后 喝水', now), {
      title: '喝水',
      dueAt: '2026-07-20T08:10:00.000Z',
    });
    assert.deepEqual(parseSlashReminderArgs('2026-07-21 09:30 开会', now), {
      title: '开会',
      dueAt: '2026-07-21T01:30:00.000Z',
    });
    assert.equal(parseSlashReminderArgs('每天九点 喝水', now), null);
  });

  it('separates scheduling intent and time hints from fake completion claims', () => {
    assert.equal(hasTaskSchedulingIntent('新建任务，明天8点叫刘丹起床'), true);
    assert.equal(hasSchedulingTimeHint('新建任务，明天8点叫刘丹起床'), true);
    assert.equal(containsUnverifiedReminderCompletion('已实际创建系统计划任务：CodexFeishuReminder_20260429_1942。'), true);
    assert.equal(containsUnverifiedReminderCompletion('不能假装已经创建每日任务。'), false);
    assert.equal(containsUnverifiedReminderCompletion([
      '目前计划任务列表是空的哦～',
      '',
      '- 正在运行：无',
      '- 已安排待执行：无',
      '- 喝水休息提醒：未创建',
    ].join('\n')), false);
    assert.equal(containsUnverifiedReminderCompletion('已成功创建提醒：喝水。'), true);
    assert.equal(containsUnverifiedReminderCompletion('提醒已经设置好了。'), true);
    assert.equal(containsUnverifiedReminderCompletion('提醒尚未创建。'), false);
    assert.equal(containsUnverifiedReminderCompletion('计划任务列表为空。'), false);
    assert.equal(containsUnverifiedReminderCompletion('已安排待执行：无。'), false);
  });
});
