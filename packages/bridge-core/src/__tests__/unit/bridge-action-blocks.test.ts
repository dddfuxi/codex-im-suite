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
