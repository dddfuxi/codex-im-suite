import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function loadInboundMentionWake() {
  return await import('../../lib/bridge/channels/feishu/mentions/inbound-mention-wake.js');
}

describe('Feishu inbound mention wake', () => {
  it('normalizes configured bot aliases without accepting vague one-character names', async () => {
    const { normalizeFeishuBotNameAliases } = await loadInboundMentionWake();

    assert.deepEqual(normalizeFeishuBotNameAliases([
      '小虾米',
      '@桥助手, bridge-bot',
      '小虾米；桥助手',
      '桥',
      undefined,
    ]), ['bridge-bot', '小虾米', '桥助手']);
  });

  it('matches native event mentions only against verified bot ids', async () => {
    const { isFeishuBotMentioned } = await loadInboundMentionWake();
    const botIds = new Set(['ou_bot', 'user_bot']);

    assert.equal(isFeishuBotMentioned([
      { id: { open_id: 'ou_other', user_id: 'user_bot' } },
    ], botIds), true);
    assert.equal(isFeishuBotMentioned([
      { id: { open_id: 'ou_other' } },
    ], botIds), false);
    assert.equal(isFeishuBotMentioned(undefined, botIds), false);
  });

  it('recovers bot mentions recursively from card and post structured content', async () => {
    const { isFeishuBotMentionedFromMessage } = await loadInboundMentionWake();
    const botIds = new Set(['ou_bot']);

    assert.equal(isFeishuBotMentionedFromMessage({
      content: JSON.stringify({ body: { elements: [{ tag: 'markdown', content: '<at id="ou_bot"></at> 检查' }] } }),
    }, botIds), true);
    assert.equal(isFeishuBotMentionedFromMessage({
      content: JSON.stringify({ content: [[{ tag: 'at', user_id: 'ou_bot' }]] }),
    }, botIds), true);
    assert.equal(isFeishuBotMentionedFromMessage({
      content: '{invalid json',
    }, botIds), false);
  });

  it('keeps the native mentions array authoritative before structured fallback', async () => {
    const { isFeishuBotMentionedFromMessage } = await loadInboundMentionWake();
    const botIds = new Set(['ou_bot']);

    assert.equal(isFeishuBotMentionedFromMessage({
      mentions: [{ id: { union_id: 'ou_bot' } }],
      content: '',
    }, botIds), true);
  });

  it('strips Feishu placeholder markers while preserving visible mention labels', async () => {
    const { stripFeishuMentionMarkers } = await loadInboundMentionWake();

    assert.equal(
      stripFeishuMentionMarkers('  <at id="ou_bot">小虾米</at> @_user_2   请检查  '),
      '小虾米 请检查',
    );
    assert.equal(stripFeishuMentionMarkers('<at id="ou_bot"/> 请继续'), '请继续');
  });

  it('normalizes a human native mention-only wake without deciding the final reply', async () => {
    const { resolveFeishuNativeMentionOnlyWake } = await loadInboundMentionWake();

    assert.deepEqual(resolveFeishuNativeMentionOnlyWake({
      isGroup: true,
      isOtherBotSender: false,
      messageType: 'text',
      nativeBotMentioned: true,
      hasVisibleText: false,
      hasAttachments: false,
    }), {
      kind: 'light_chat',
      reason: 'native_mention_only_light_chat',
      text: '在吗？',
    });
  });

  it('keeps reply targets ahead of light chat and does not broaden bot-to-bot wake', async () => {
    const { resolveFeishuNativeMentionOnlyWake } = await loadInboundMentionWake();
    const base = {
      isGroup: true,
      messageType: 'text',
      nativeBotMentioned: true,
      hasVisibleText: false,
      hasAttachments: false,
    };

    assert.deepEqual(resolveFeishuNativeMentionOnlyWake({
      ...base,
      isOtherBotSender: false,
      replyTargetMessageId: 'om_reply',
    }), {
      kind: 'reply_target',
      reason: 'native_mention_only_reply',
      text: '请处理我在本条飞书话题中回复或引用的消息。',
    });
    assert.equal(resolveFeishuNativeMentionOnlyWake({
      ...base,
      isOtherBotSender: true,
    }), null);
    assert.equal(resolveFeishuNativeMentionOnlyWake({
      ...base,
      isOtherBotSender: false,
      nativeBotMentioned: false,
    }), null);
  });

  it('rejects corrective native mentions but leaves actionable instructions unclassified', async () => {
    const { classifyFeishuNativeBotMentionText } = await loadInboundMentionWake();
    const aliases = ['小虾米'];

    assert.deepEqual(classifyFeishuNativeBotMentionText(
      '@_user_1 你自己是小虾米啊，以后看清聊天记录再回复',
      aliases,
      '小虾米',
    ), {
      mode: 'name',
      state: 'done',
      alias: '小虾米',
      reason: 'non_actionable',
      shouldHandle: false,
    });
    assert.equal(classifyFeishuNativeBotMentionText(
      '@_user_1 当别人回复时分别处理，不要把规则混在一起',
      aliases,
      '小虾米',
    ), null);
  });

  it('classifies direct name wake requests without treating third-person references as commands', async () => {
    const { classifyFeishuBotNameWake } = await loadInboundMentionWake();
    const aliases = ['小虾米'];

    assert.deepEqual(classifyFeishuBotNameWake('小虾米，帮我检查一下', aliases), {
      mode: 'name',
      state: 'investigate',
      alias: '小虾米',
      reason: 'actionable_request',
      shouldHandle: true,
    });
    assert.deepEqual(classifyFeishuBotNameWake('刚才小虾米说的方案挺好', aliases), {
      mode: 'name',
      state: 'done',
      alias: '小虾米',
      reason: 'non_actionable',
      shouldHandle: false,
    });
    assert.deepEqual(classifyFeishuBotNameWake('小虾米，艾特一下', aliases), {
      mode: 'name',
      state: 'need_info',
      alias: '小虾米',
      reason: 'mention_target_missing',
      shouldHandle: true,
    });
  });
});
