import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reviewDeferredBridgeActionProtocol } from '../../lib/bridge/application/deferred-action-review.js';

describe('deferred bridge action review', () => {
  it('does not treat an empty scheduled-task list as a completion claim', () => {
    const result = reviewDeferredBridgeActionProtocol([
      '目前计划任务列表是空的哦～',
      '- 正在运行：无',
      '- 已安排待执行：无',
      '- 喝水休息提醒：未创建',
    ].join('\n'));
    assert.deepEqual(result, { ok: true });
  });

  it('requests one protocol repair for an unverified completion claim', () => {
    const result = reviewDeferredBridgeActionProtocol('已成功创建提醒：十分钟后喝水。');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, 'unverified_reminder_completion');
    assert.equal(result.failure.retryable, true);
    assert.match(result.failure.repairInstruction, /query, create, or modify/i);
  });

  it('requests protocol repair for an invalid deferred action block', () => {
    const result = reviewDeferredBridgeActionProtocol([
      '```cti-reminder',
      '{"title":"喝水","target":"current_chat"}',
      '```',
    ].join('\n'));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, 'invalid_deferred_action:cti-reminder');
  });

  it('accepts a valid deferred reminder even when prose anticipates completion', () => {
    const result = reviewDeferredBridgeActionProtocol([
      '已设置提醒。',
      '```cti-reminder',
      '{"title":"喝水","dueAt":"2026-08-10T01:00:00.000Z","target":"current_chat"}',
      '```',
    ].join('\n'));
    assert.deepEqual(result, { ok: true });
  });
});
