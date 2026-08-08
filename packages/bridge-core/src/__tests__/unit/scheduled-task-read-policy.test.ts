import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildScheduledTaskReadEvidencePrompt,
  resolveScheduledTaskReadIntent,
} from '../../lib/bridge/application/scheduled-task-read-policy.js';

describe('scheduled task read policy', () => {
  it('recognizes pure read requests without swallowing mutations or generic plans', () => {
    assert.equal(resolveScheduledTaskReadIntent('列出你的所有计划任务'), 'list');
    assert.equal(resolveScheduledTaskReadIntent('现在有哪些定时提醒？'), 'list');
    assert.equal(resolveScheduledTaskReadIntent('列出计划任务并删除失效项'), null);
    assert.equal(resolveScheduledTaskReadIntent('列出这个项目的后续计划'), null);
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
});
