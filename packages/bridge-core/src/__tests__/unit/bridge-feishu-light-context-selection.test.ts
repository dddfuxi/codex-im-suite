import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function loadModule() {
  try {
    return await import('../../lib/bridge/channels/feishu/history/light-context-selection.js');
  } catch {
    return null;
  }
}

function message(
  id: string,
  time: number,
  text: string,
  options: Record<string, unknown> = {},
) {
  return {
    message_id: id,
    chat_id: 'oc_chat',
    create_time: String(time),
    msg_type: 'text',
    body: { content: text },
    sender: { id: `ou_${id}`, sender_type: 'user' },
    ...options,
  };
}

const extractText = (item: { body?: { content?: string } }) => item.body?.content || '';
const isFromSelf = (sender?: { id?: string }) => sender?.id === 'ou_bot';

describe('Feishu light context selection', () => {
  it('keeps the replied message while excluding current, future, deleted, system, and self messages', async () => {
    const module = await loadModule();
    assert.ok(module, 'Feishu light context selection module should exist');

    const result = module.selectFeishuLightContextItems({
      recentMessages: [
        message('future', 5000, '未来消息'),
        message('current', 4000, '当前消息'),
        message('valid', 3000, '有效上文'),
        message('self', 2500, '机器人回复', { sender: { id: 'ou_bot', sender_type: 'bot' } }),
        message('deleted', 2000, '已删除', { deleted: true }),
        message('system', 1500, '系统消息', { msg_type: 'system' }),
      ],
      repliedMessage: message('reply', 1000, '被回复消息', { sender: { id: 'ou_bot', sender_type: 'bot' } }),
      currentMessageId: 'current',
      currentMessageTimestamp: 4000,
      limit: 4,
      isShortReplyCommand: false,
      includeBotMessages: false,
      extractText,
      isFromSelf,
    });

    assert.deepEqual(result.items.map((item: any) => item.message_id), ['reply', 'valid']);
    assert.equal(result.likelyContextMessageId, '');
  });

  it('includes bot messages for contextual asks and keeps only the newest bounded window', async () => {
    const module = await loadModule();
    assert.ok(module, 'Feishu light context selection module should exist');

    const result = module.selectFeishuLightContextItems({
      recentMessages: [
        message('newest', 5000, '你觉得选 A 还是 B？'),
        message('bot', 4000, '机器人之前的结论', { sender: { id: 'ou_bot', sender_type: 'bot' } }),
        message('older', 3000, '较早消息'),
        message('oldest', 2000, '最早消息'),
      ],
      repliedMessage: null,
      currentMessageId: 'current',
      limit: 2,
      isShortReplyCommand: false,
      includeBotMessages: true,
      extractText,
      isFromSelf,
    });

    assert.deepEqual(result.items.map((item: any) => item.message_id), ['bot', 'newest']);
  });

  it('uses a question-like nearby message as the best-effort anchor for short reply commands', async () => {
    const module = await loadModule();
    assert.ok(module, 'Feishu light context selection module should exist');

    const result = module.selectFeishuLightContextItems({
      recentMessages: [
        message('ack', 4000, '收到'),
        message('question', 3000, '这个资源名用 HospitalWall_A 还是 HospitalWall_B？'),
        message('statement', 2000, '这里是医院墙面资源'),
      ],
      repliedMessage: null,
      currentMessageId: 'current',
      limit: 3,
      isShortReplyCommand: true,
      includeBotMessages: false,
      extractText,
      isFromSelf,
    });

    assert.equal(result.likelyContextMessageId, 'question');
    assert.deepEqual(result.items.map((item: any) => item.message_id), ['statement', 'question', 'ack']);
  });
});
