import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasTrustedDirectMessageContinuationAuthorization,
  isCurrentConversationTargetId,
  isExplicitDirectMessageRequestText,
} from '../../lib/bridge/application/direct-message-policy';
import type { TurnEvidenceEnvelope, TurnFocusDecision } from '../../lib/bridge/turn-context';

function createTrustedContinuation() {
  const envelope: TurnEvidenceEnvelope = {
    protocol: 'cti-turn-context/v1',
    channelType: 'feishu',
    chatId: 'oc_current',
    messageId: 'm_current',
    currentText: '现在测试一次',
    evidence: [{
      id: 'message:om_result',
      kind: 'message',
      relation: 'native_reply',
      source: 'platform_api',
      confidence: 1,
      content: '本地已发送内容摘要：原始请求：每小时在群里提醒一次。上一轮状态：已完成。',
      actor: { id: 'cli_bot', type: 'app' },
      metadata: { contentRecovered: true, continuationContextRecovered: true },
    }],
  };
  const focus: TurnFocusDecision = {
    protocol: 'cti-turn-focus/v1',
    mode: 'deterministic',
    focus: 'reply_target',
    primaryEvidenceIds: ['message:om_result'],
    supportingEvidenceIds: [],
    conflictingEvidenceIds: [],
    confidence: 1,
    requiresAgentResolution: false,
    reason: '唯一可靠原生回复',
  };
  return { envelope, focus };
}

describe('direct-message policy', () => {
  it('distinguishes the exact current chat from a real cross-chat target', () => {
    assert.equal(isCurrentConversationTargetId('oc_current', 'oc_current'), true);
    assert.equal(isCurrentConversationTargetId('oc_other', 'oc_current'), false);
  });

  it('accepts explicit named group sends without treating the group as a user', () => {
    assert.equal(isExplicitDirectMessageRequestText('在项目讨论群里发一条消息', '项目讨论群', 'chat'), true);
  });

  it('inherits an action continuation only from a recovered bot result', () => {
    const { envelope, focus } = createTrustedContinuation();
    assert.equal(hasTrustedDirectMessageContinuationAuthorization({ userText: '现在测试一次', envelope, focus }), true);
    assert.equal(hasTrustedDirectMessageContinuationAuthorization({ userText: '你倒是发送啊，确认', envelope, focus }), true);
    assert.equal(hasTrustedDirectMessageContinuationAuthorization({ userText: '为什么会发送失败', envelope, focus }), false);
    assert.equal(hasTrustedDirectMessageContinuationAuthorization({ userText: '别发送了', envelope, focus }), false);
  });

  it('does not inherit authorization from ordinary nearby history', () => {
    const { envelope, focus } = createTrustedContinuation();
    envelope.evidence[0] = {
      ...envelope.evidence[0],
      relation: 'nearby',
      actor: { id: 'ou_user', type: 'human' },
      metadata: { contentRecovered: true, continuationContextRecovered: false },
    };
    assert.equal(hasTrustedDirectMessageContinuationAuthorization({ userText: '现在测试一次', envelope, focus }), false);
  });
});
