import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildScheduledTaskCheckInHistoryEvidencePrompt,
  buildScheduledTaskReadEvidencePrompt,
  resolveCheckInHistoryWindow,
  resolveScheduledTaskReadIntent,
} from '../../lib/bridge/application/scheduled-task-read-policy.js';

describe('scheduled task read policy', () => {
  it('recognizes pure read requests without swallowing mutations or generic plans', () => {
    assert.equal(resolveScheduledTaskReadIntent('列出你的所有计划任务'), 'list');
    assert.equal(resolveScheduledTaskReadIntent('现在有哪些定时提醒？'), 'list');
    assert.equal(resolveScheduledTaskReadIntent('列出计划任务并删除失效项'), null);
    assert.equal(resolveScheduledTaskReadIntent('列出这个项目的后续计划'), null);
  });

  it('routes local interactive check-in comparisons to the local history reader, not Feishu attendance', () => {
    assert.equal(resolveScheduledTaskReadIntent('对比一下两周的喝水打卡'), 'check_in_history');
    assert.equal(resolveScheduledTaskReadIntent('统计最近两周的签到情况'), 'check_in_history');
    assert.equal(resolveScheduledTaskReadIntent('谁参加了喝水打卡？'), 'check_in_history');
    assert.equal(resolveScheduledTaskReadIntent('对比两周飞书考勤打卡'), null);
    assert.equal(resolveScheduledTaskReadIntent('创建两周喝水打卡统计'), null);
  });

  it('projects Host data into bounded evidence without prompts, paths, or identities', () => {
    const prompt = buildScheduledTaskReadEvidencePrompt({
      ok: true,
      tasks: [],
      items: [{
        task: {
          id: 'task_001',
          name: '每日汇总',
          enabled: true,
          version: 3,
          schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
          action: { kind: 'agent_turn', prompt: '不得进入 evidence 的敏感正文' },
          owner: { userId: 'ou_secret' },
          executionContext: { workspaceId: 'C:\\secret\\workspace' },
        },
        state: {
          nextRunAt: '2026-08-10T01:00:00.000Z',
          runningRunId: null,
          lastRunStatus: 'ok',
          lastDeliveryStatus: 'delivered',
        },
      }],
    });
    assert.match(prompt, /cti-scheduled-task-list-evidence\/v1/u);
    assert.match(prompt, /每日汇总/u);
    assert.match(prompt, /2026-08-10T01:00:00.000Z/u);
    assert.doesNotMatch(prompt, /敏感正文/u);
    assert.doesNotMatch(prompt, /ou_secret/u);
    assert.doesNotMatch(prompt, /C:\\secret/u);
  });

  it('keeps Host failures distinct from an empty successful list', () => {
    const prompt = buildScheduledTaskReadEvidencePrompt({ ok: false, tasks: [], error: 'C:\\secret\\state.json locked' });
    assert.match(prompt, /"status":"error"/u);
    assert.match(prompt, /scheduled_task_list_unavailable/u);
    assert.doesNotMatch(prompt, /state\.json/u);
  });

  it('projects local check-in history with verified member names and without task IDs or paths', () => {
    const prompt = buildScheduledTaskCheckInHistoryEvidencePrompt({
      ok: true,
      items: [{
        task: {
          id: 'task_private',
          name: '工作日喝水打卡',
          action: { kind: 'check_in' },
          owner: { userId: 'ou_secret' },
        },
        runs: [{
          taskId: 'task_private',
          queuedAt: '2026-08-10T01:00:00.000Z',
          executionStatus: 'ok',
          deliveryStatus: 'delivered',
          checkInCount: 4,
          participants: [{ userId: 'ou_secret', name: '张三', checkedInAt: '2026-08-10T01:01:00.000Z' }],
        }],
      }],
    });
    assert.match(prompt, /cti-scheduled-check-in-history-evidence\/v1/u);
    assert.match(prompt, /工作日喝水打卡/u);
    assert.match(prompt, /"checkInCount":4/u);
    assert.match(prompt, /"name":"张三"/u);
    assert.match(prompt, /Do not call lark-cli, request Feishu user authorization/u);
    assert.doesNotMatch(prompt, /task_private|ou_secret|userId/u);
  });

  it('resolves relative windows in a supplied task timezone and projects a bounded aggregate instead of raw runs', () => {
    const now = new Date('2026-08-31T01:00:00.000Z'); // 2026-08-31 09:00 Asia/Shanghai
    assert.deepEqual(resolveCheckInHistoryWindow('上周打卡统计', now, 'Asia/Shanghai'), {
      label: '上周', startDate: '2026-08-24', endDateExclusive: '2026-08-31',
    });
    assert.deepEqual(resolveCheckInHistoryWindow('近 2 周签到趋势', now, 'Asia/Shanghai'), {
      label: '近 2 周', startDate: '2026-08-18', endDateExclusive: '2026-09-01',
    });

    const prompt = buildScheduledTaskCheckInHistoryEvidencePrompt({
      ok: true,
      items: [{
        task: { name: '任意互动任务', schedule: { timezone: 'Asia/Shanghai' }, action: { kind: 'check_in' } },
        runs: [
          { queuedAt: '2026-08-24T01:00:00.000Z', executionStatus: 'ok', deliveryStatus: 'delivered', checkInCount: 2 },
          { queuedAt: '2026-08-30T01:00:00.000Z', executionStatus: 'ok', deliveryStatus: 'delivered', checkInCount: 3 },
          { queuedAt: '2026-08-31T01:00:00.000Z', executionStatus: 'ok', deliveryStatus: 'delivered', checkInCount: 9 },
        ],
      }],
    }, { requestText: '上周任意互动任务打卡排行榜', now });
    assert.match(prompt, /"scheduledRuns":2/u);
    assert.match(prompt, /"checkInCount":5/u);
    assert.match(prompt, /"date":"2026-08-24"/u);
    assert.doesNotMatch(prompt, /2026-08-31T01:00:00.000Z|"checkInCount":9/u);
    assert.doesNotMatch(prompt, /"runs"/u);
  });
});
