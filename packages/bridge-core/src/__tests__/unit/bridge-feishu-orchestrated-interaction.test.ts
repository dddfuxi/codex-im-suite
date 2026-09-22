import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveFeishuOrchestratedInteraction } from '../../lib/bridge/channels/feishu/mentions/orchestrated-interaction.js';

const request = '你们俩开始用成语吵架，必须 at 对方，小虾米先开始';
const participants = [
  { userId: 'ou_george', name: '乔治' },
  { userId: 'ou_shrimp', name: '小虾米' },
];

describe('Feishu orchestrated interaction', () => {
  it('understands the current assistant as starter and resolves the other native participant as counterparty', () => {
    const plan = resolveFeishuOrchestratedInteraction({
      userText: request,
      nativeMentions: participants,
      assistantIdentity: { displayName: '小虾米', botOpenId: 'ou_shrimp' },
    });

    assert.equal(plan.status, 'self_turn');
    assert.equal(plan.selfParticipant?.userId, 'ou_shrimp');
    assert.equal(plan.counterparty?.userId, 'ou_george');
  });

  it('understands that the other mentioned assistant must wait for the named starter', () => {
    const plan = resolveFeishuOrchestratedInteraction({
      userText: request,
      nativeMentions: participants,
      assistantIdentity: { displayName: '乔治', botOpenId: 'ou_george' },
    });

    assert.equal(plan.status, 'wait_turn');
    assert.equal(plan.starterName, '小虾米');
  });

  it('uses stable platform identity when the assistant display name changes', () => {
    const plan = resolveFeishuOrchestratedInteraction({
      userText: request,
      nativeMentions: participants,
      assistantIdentity: { displayName: '新的展示名', botOpenId: 'ou_shrimp' },
    });

    assert.equal(plan.status, 'self_turn');
    assert.equal(plan.counterparty?.name, '乔治');
  });

  it('keeps multiple counterparties and same-name starters ambiguous instead of guessing', () => {
    const multiple = resolveFeishuOrchestratedInteraction({
      userText: request,
      nativeMentions: [...participants, { userId: 'ou_third', name: '第三位' }],
      assistantIdentity: { botOpenId: 'ou_shrimp' },
    });
    assert.equal(multiple.status, 'ambiguous');

    const sameName = resolveFeishuOrchestratedInteraction({
      userText: request,
      nativeMentions: [...participants, { userId: 'ou_same_name', name: '小虾米' }],
      assistantIdentity: { botOpenId: 'ou_shrimp' },
    });
    assert.equal(sameName.status, 'ambiguous');
  });

  it('leaves legacy name resolution in place when the original message did not natively mention both participants', () => {
    const plan = resolveFeishuOrchestratedInteraction({
      userText: request,
      nativeMentions: [{ userId: 'ou_shrimp', name: '小虾米' }],
      assistantIdentity: { botOpenId: 'ou_shrimp' },
    });
    assert.equal(plan.status, 'not_applicable');
  });
});
