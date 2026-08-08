import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractCtiArtifactPromotionAction,
  extractCtiBridgeControlAction,
  extractCtiDirectMessageAction,
  extractCtiReminderAction,
  extractCtiScheduledTaskAction,
} from '../../lib/bridge/application/action-blocks.js';

describe('bridge action block parsing', () => {
  it('extracts a reminder and delegates mention normalization without leaking the fence', () => {
    const input = [
      '已为你安排。',
      '```cti-reminder',
      JSON.stringify({
        title: '喝水',
        dueAt: '2026-07-20T10:00:00+08:00',
        timezone: 'Asia/Shanghai',
        target: 'current_chat',
        notify_targets: [{ open_id: 'ou_1', name: '刘丹' }],
      }),
      '```',
    ].join('\n');

    const result = extractCtiReminderAction(input, {
      parseMentions: () => [{ userId: 'ou_1', name: '刘丹' }],
    });

    assert.equal(result.text, '已为你安排。');
    assert.deepEqual(result.action?.notifyTargets, [{ userId: 'ou_1', name: '刘丹' }]);
  });

  it('parses a scheduled task while reporting caller-supplied trusted fields', () => {
    const result = extractCtiScheduledTaskAction([
      '```cti-scheduled-task',
      JSON.stringify({
        action: 'create',
        name: '每日检查',
        schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'Asia/Shanghai' },
        taskAction: { kind: 'agent_turn', prompt: '执行反思', sessionMode: 'isolated' },
        deliveryMode: 'summary',
        chatId: 'oc_untrusted',
        actor: { role: 'owner' },
      }),
      '```',
    ].join('\n'));

    assert.equal(result.action?.schedule.kind, 'cron');
    assert.equal(result.action?.taskAction.kind, 'agent_turn');
    assert.deepEqual(result.action?.ignoredTrustedFields, ['actor', 'chatId']);
  });

  it('normalizes a current-chat direct_message scheduled action without trusting its target id', () => {
    const result = extractCtiScheduledTaskAction([
      '```cti-scheduled-task',
      JSON.stringify({
        action: 'create',
        name: '工作日整点提醒',
        schedule: { kind: 'cron', expression: '0 10-12,14-19 * * 1-5', timezone: 'Asia/Shanghai' },
        taskAction: {
          kind: 'direct_message',
          targetType: 'chat',
          targetId: 'oc_model_supplied',
          text: '大家别忘了起来活动一下。',
        },
      }),
      '```',
    ].join('\n'));

    assert.deepEqual(result.action?.taskAction, {
      kind: 'notify',
      text: '大家别忘了起来活动一下。',
    });
    assert.deepEqual(result.action?.ignoredTrustedFields, [
      'taskAction.targetId',
      'taskAction.targetType',
    ]);
  });

  it('parses a per-run check-in action without accepting participant identities', () => {
    const result = extractCtiScheduledTaskAction([
      '```cti-scheduled-task',
      JSON.stringify({
        action: 'create',
        name: '每日喝水打卡',
        schedule: { kind: 'cron', expression: '0 10 * * 1-5', timezone: 'Asia/Shanghai' },
        taskAction: {
          kind: 'check_in',
          text: '喝水后请点击下方按钮打卡。',
          audience: 'chat_members',
          buttonText: '我喝水了',
          successText: '喝水打卡成功。',
          windowMs: 3_600_000,
          userId: 'ou_model_forged',
        },
      }),
      '```',
    ].join('\n'));

    assert.deepEqual(result.action?.taskAction, {
      kind: 'check_in',
      text: '喝水后请点击下方按钮打卡。',
      audience: 'chat_members',
      buttonText: '我喝水了',
      successText: '喝水打卡成功。',
      windowMs: 3_600_000,
    });
    assert.deepEqual(result.action?.ignoredTrustedFields, ['taskAction.userId']);
  });

  it('normalizes a CRON_TZ schedule string and defaults an omitted agent session to isolated', () => {
    const result = extractCtiScheduledTaskAction([
      '```cti-scheduled-task',
      JSON.stringify({
        action: 'create',
        name: '工作日整点提醒',
        schedule: 'CRON_TZ=Asia/Shanghai 0 10-12,14-19 * * 1-5',
        taskAction: { kind: 'agent_turn', prompt: '生成一条简短的群提醒。' },
      }),
      '```',
    ].join('\n'));

    assert.deepEqual(result.action?.schedule, {
      kind: 'cron',
      expression: '0 10-12,14-19 * * 1-5',
      timezone: 'Asia/Shanghai',
    });
    assert.deepEqual(result.action?.taskAction, {
      kind: 'agent_turn',
      prompt: '生成一条简短的群提醒。',
      sessionMode: 'isolated',
    });
  });

  it('normalizes the observed at plus datetime offset variant without guessing a region', () => {
    const result = extractCtiScheduledTaskAction([
      '```cti-scheduled-task',
      JSON.stringify({
        action: 'create',
        name: '今日补执行',
        schedule: { kind: 'at', datetime: '2026-08-08T11:40:00+08:00' },
        taskAction: { kind: 'agent_turn', prompt: '立即补执行。', sessionMode: 'bound' },
      }),
      '```',
    ].join('\n'));

    assert.deepEqual(result.action?.schedule, {
      kind: 'at',
      at: '2026-08-08T11:40:00+08:00',
      timezone: 'UTC',
    });
    assert.deepEqual(result.action?.normalizedFields, [
      'schedule.datetime->at',
      'schedule.explicit_offset->timezone:UTC',
    ]);
  });

  it('normalizes the observed once delay variant against the action parsing time', () => {
    const result = extractCtiScheduledTaskAction([
      '```cti-scheduled-task',
      JSON.stringify({
        action: 'create',
        name: '十秒倒计时',
        schedule: { type: 'once', delay_seconds: 10 },
        taskAction: { kind: 'notify', text: '时间到。' },
      }),
      '```',
    ].join('\n'), { referenceTime: '2026-08-08T03:00:00.000Z' });

    assert.deepEqual(result.action?.schedule, {
      kind: 'at',
      at: '2026-08-08T03:00:10.000Z',
      timezone: 'UTC',
    });
    assert.deepEqual(result.action?.normalizedFields, [
      'schedule.type->kind',
      'schedule.kind:once->at',
      'schedule.delay_seconds->at',
      'schedule.reference_time->timezone:UTC',
    ]);
  });

  it('normalizes the observed interval everyMinutes variant with a stable anchor', () => {
    const result = extractCtiScheduledTaskAction([
      '```cti-scheduled-task',
      JSON.stringify({
        action: 'create',
        name: '喝水活动提醒',
        schedule: { kind: 'interval', everyMinutes: 40, timezone: 'Asia/Shanghai' },
        taskAction: { kind: 'notify', text: '喝水活动一下。' },
      }),
      '```',
    ].join('\n'), { referenceTime: '2026-08-08T03:00:00.000Z' });

    assert.deepEqual(result.action?.schedule, {
      kind: 'every',
      everyMs: 2_400_000,
      anchorAt: '2026-08-08T03:00:00.000Z',
    });
    assert.deepEqual(result.action?.normalizedFields, [
      'schedule.kind:interval->every',
      'schedule.everyMinutes->everyMs',
      'schedule.reference_time->anchorAt',
    ]);
  });

  it('returns a precise timezone error for a local at datetime instead of a generic incomplete result', () => {
    const result = extractCtiScheduledTaskAction([
      '```cti-scheduled-task',
      JSON.stringify({
        action: 'create',
        name: '无时区单次任务',
        schedule: { kind: 'at', datetime: '2026-08-08T11:40:00' },
        taskAction: { kind: 'notify', text: '提醒内容' },
      }),
      '```',
    ].join('\n'));

    assert.equal(result.action, null);
    assert.match(result.error || '', /kind=at.+timezone.+不能安全解析/u);
  });

  it('does not guess a timezone for a bare cron schedule string', () => {
    const result = extractCtiScheduledTaskAction([
      '```cti-scheduled-task',
      JSON.stringify({
        action: 'create',
        name: '无时区任务',
        schedule: '0 10 * * 1-5',
        taskAction: { kind: 'notify', text: '提醒内容' },
      }),
      '```',
    ].join('\n'));

    assert.equal(result.action, null);
    assert.match(result.error || '', /schedule/u);
  });

  it('does not redirect a user-targeted direct_message scheduled action into the current chat', () => {
    const result = extractCtiScheduledTaskAction([
      '```cti-scheduled-task',
      JSON.stringify({
        action: 'create',
        name: '错误目标提醒',
        schedule: { kind: 'cron', expression: '0 10 * * 1-5', timezone: 'Asia/Shanghai' },
        taskAction: { kind: 'direct_message', targetType: 'user', targetId: 'ou_someone', text: '提醒内容' },
      }),
      '```',
    ].join('\n'));

    assert.equal(result.action, null);
    assert.match(result.error || '', /taskAction.+direct_message/u);
  });

  it('keeps a named direct-message target on resolver flow instead of trusting a model id', () => {
    const result = extractCtiDirectMessageAction([
      '```cti-direct-message',
      JSON.stringify({
        target: { displayName: '乔治', openId: 'ou_model_generated' },
        text: '请查看更新。',
        parseMode: 'markdown',
      }),
      '```',
    ].join('\n'));

    assert.equal(result.action?.targetText, '乔治');
    assert.equal(result.action?.targetId, '');
    assert.equal(result.action?.parseMode, 'Markdown');
  });

  it('accepts only the fixed live restart bridge action', () => {
    const accepted = extractCtiBridgeControlAction('```cti-bridge-control\n{"action":"restart_live"}\n```');
    const rejected = extractCtiBridgeControlAction('```cti-bridge-control\n{"action":"stop_machine"}\n```');

    assert.deepEqual(accepted.action, { action: 'restart_live' });
    assert.match(rejected.error || '', /不支持/u);
  });

  it('allows only the four managed artifact promotion fields', () => {
    const accepted = extractCtiArtifactPromotionAction([
      '```cti-artifact-promote',
      JSON.stringify({
        artifactId: `artifact-${'1'.repeat(24)}`,
        targetProjectId: 'suite',
        targetRelativePath: 'docs/report.md',
        expectedSha256: 'a'.repeat(64),
      }),
      '```',
    ].join('\n'));
    const rejected = extractCtiArtifactPromotionAction([
      '```cti-artifact-promote',
      JSON.stringify({
        artifactId: `artifact-${'1'.repeat(24)}`,
        targetProjectId: 'suite',
        targetRelativePath: 'docs/report.md',
        sourcePath: 'C:\\unsafe.txt',
      }),
      '```',
    ].join('\n'));

    assert.equal(accepted.action?.targetRelativePath, 'docs/report.md');
    assert.match(rejected.error || '', /sourcePath/u);
  });
});
