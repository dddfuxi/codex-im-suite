import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveFeishuContextualMention } from '../../lib/bridge/channels/feishu/mentions/contextual-mention-resolution.js';
import { createTurnEvidenceEnvelope, type TurnFocusDecision } from '../../lib/bridge/turn-context.js';

const focus: TurnFocusDecision = {
  protocol: 'cti-turn-focus/v1',
  mode: 'deterministic',
  focus: 'reply_target',
  primaryEvidenceIds: ['message:card'],
  supportingEvidenceIds: ['message:xiaoming', 'message:lin'],
  conflictingEvidenceIds: [],
  confidence: 1,
  requiresAgentResolution: false,
  reason: 'test',
};

function incidentEnvelope() {
  return createTurnEvidenceEnvelope({
    channelType: 'feishu',
    chatId: 'oc_group',
    messageId: 'om_current',
    currentText: '知道是谁么，艾特她',
    currentActor: { id: 'ou_sender', displayName: '刘丹', type: 'human' },
    evidence: [
      {
        id: 'message:card',
        kind: 'message',
        relation: 'native_reply',
        source: 'platform_api',
        confidence: 1,
        content: '原始请求：准备好干活，你明姐姐又要来活了。',
        actor: { id: 'cli_bot', type: 'app' },
      },
      {
        id: 'message:xiaoming',
        kind: 'message',
        relation: 'nearby',
        source: 'platform_api',
        confidence: 0.7,
        content: '那个管不了，因为左边很远。',
        actor: { id: 'ou_xiaoming', displayName: '小明', type: 'human' },
      },
      {
        id: 'message:lin',
        kind: 'message',
        relation: 'nearby',
        source: 'platform_api',
        confidence: 0.7,
        content: '[赞]',
        actor: { id: 'ou_lin', displayName: '林惠中', type: 'human' },
      },
    ],
  });
}

describe('Feishu contextual mention resolution', () => {
  it('accepts the model-selected person only when the id and name bind to current turn evidence', () => {
    const result = resolveFeishuContextualMention({
      userText: '知道是谁么，艾特她',
      envelope: incidentEnvelope(),
      focus,
      modelText: '知道呀，是 @小明。',
      modelMentions: [{ userId: 'ou_xiaoming', name: '小明' }],
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.candidate?.evidenceId, 'message:xiaoming');
    assert.equal(result.candidate?.userId, 'ou_xiaoming');
  });

  it('rejects a model id that does not exist in the current turn evidence', () => {
    const result = resolveFeishuContextualMention({
      userText: '知道是谁么，艾特她',
      envelope: incidentEnvelope(),
      focus,
      modelText: '知道呀，是 @小明。',
      modelMentions: [{ userId: 'ou_invented', name: '小明' }],
    });

    assert.equal(result.status, 'resolved', 'a separate deterministic evidence rule may still resolve the real person');
    assert.notEqual(result.candidate?.userId, 'ou_invented');
    assert.equal(result.candidate?.userId, 'ou_xiaoming');
  });

  it('treats the model id only as an evidence selector and supports pronouns before the mention verb', () => {
    const result = resolveFeishuContextualMention({
      userText: '把她艾特一下',
      envelope: incidentEnvelope(),
      focus,
      modelText: '@另一个称呼 收到。',
      modelMentions: [{ userId: 'ou_xiaoming', name: '另一个称呼' }],
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.candidate?.userId, 'ou_xiaoming');
    assert.equal(result.candidate?.name, '小明');
  });

  it('uses an affectionate title in the replied content only when it uniquely matches evidence', () => {
    const result = resolveFeishuContextualMention({
      userText: '知道是谁么，艾特她',
      envelope: incidentEnvelope(),
      focus,
      modelText: '知道呀。',
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.candidate?.name, '小明');
  });

  it('keeps multiple unbound nearby people ambiguous', () => {
    const envelope = incidentEnvelope();
    envelope.evidence = envelope.evidence.map((item) => item.id === 'message:card'
      ? { ...item, content: '刚才有人说要来活了。' }
      : item);
    const result = resolveFeishuContextualMention({
      userText: '艾特她',
      envelope,
      focus,
      modelText: '收到。',
    });

    assert.equal(result.status, 'ambiguous');
    assert.deepEqual(result.candidates.map((item) => item.name).sort(), ['小明', '林惠中']);
  });

  it('does not activate for ordinary pronoun discussion without a mention command', () => {
    const result = resolveFeishuContextualMention({
      userText: '她刚才说得对吗',
      envelope: incidentEnvelope(),
      focus,
    });
    assert.equal(result.status, 'not_applicable');
  });
});
