import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function loadModule() {
  try {
    return await import('../../lib/bridge/channels/feishu/history/indexed-history-sync.js');
  } catch {
    return null;
  }
}

function message(id: string, time: string, text: string, options: Record<string, unknown> = {}) {
  return {
    message_id: id,
    chat_id: 'oc_chat',
    create_time: time,
    msg_type: 'text',
    body: { content: text },
    sender: { id: `ou_${id}`, sender_type: 'user' },
    ...options,
  };
}

describe('Feishu indexed history sync', () => {
  it('incrementally paginates until a page has no newer messages and writes normalized records once', async () => {
    const module = await loadModule();
    assert.ok(module, 'Feishu indexed history sync module should exist');
    const pageCalls: string[] = [];
    const harvested: string[][] = [];
    const writes: unknown[] = [];
    const pages = new Map([
      ['', { items: [message('new', '300', '新消息')], nextPageToken: 'p2', hasMore: true }],
      ['p2', { items: [message('old', '100', '旧消息')], nextPageToken: 'p3', hasMore: true }],
      ['p3', { items: [message('never', '50', '不应继续读取')], nextPageToken: '', hasMore: false }],
    ]);

    const result = await module.syncFeishuIndexedHistory({
      chatId: 'oc_chat',
      chatType: 'group',
      displayName: '测试群',
      full: false,
      store: {
        getFeishuHistorySyncStatus: () => [{ latestMessageTime: '200' }],
        upsertFeishuHistoryMessages: (data: unknown) => writes.push(data),
      },
      fetchMemberNames: async () => new Map([['ou_new', '小新'], ['ou_old', '小旧']]),
      fetchPage: async (_chatId: string, token: string) => {
        pageCalls.push(token);
        return pages.get(token)!;
      },
      harvestStickers: async (items: Array<{ message_id: string }>) => harvested.push(items.map((item) => item.message_id)),
      extractText: (item: { body?: { content?: string } }) => item.body?.content || '',
      now: () => new Date('2026-07-20T11:00:00.000Z'),
    });

    assert.deepEqual(pageCalls, ['', 'p2']);
    assert.deepEqual(harvested, [['new', 'old']]);
    assert.equal(result.collectedCount, 2);
    assert.equal(result.preparedCount, 2);
    assert.equal(writes.length, 1);
    assert.deepEqual((writes[0] as any).messages.map((item: any) => [item.messageId, item.senderName]), [
      ['new', '小新'],
      ['old', '小旧'],
    ]);
    assert.equal((writes[0] as any).syncedAt, '2026-07-20T11:00:00.000Z');
  });

  it('full sync reads all pages, filters non-readable items, and still records an empty completed snapshot', async () => {
    const module = await loadModule();
    assert.ok(module, 'Feishu indexed history sync module should exist');
    const writes: any[] = [];
    const pageCalls: string[] = [];
    const pages = new Map([
      ['', {
        items: [
          message('deleted', '400', '删除', { deleted: true }),
          message('system', '300', '系统', { msg_type: 'system' }),
        ],
        nextPageToken: 'p2',
        hasMore: true,
      }],
      ['p2', { items: [message('empty', '200', '')], nextPageToken: '', hasMore: false }],
    ]);

    const result = await module.syncFeishuIndexedHistory({
      chatId: 'oc_chat',
      chatType: 'group',
      displayName: '测试群',
      full: true,
      store: { upsertFeishuHistoryMessages: (data: unknown) => writes.push(data) },
      fetchMemberNames: async () => new Map(),
      fetchPage: async (_chatId: string, token: string) => {
        pageCalls.push(token);
        return pages.get(token)!;
      },
      harvestStickers: async () => {},
      extractText: (item: { body?: { content?: string } }) => item.body?.content || '',
    });

    assert.deepEqual(pageCalls, ['', 'p2']);
    assert.equal(result.preparedCount, 0);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].messages, []);
  });

  it('does nothing when the history store does not expose an upsert capability', async () => {
    const module = await loadModule();
    assert.ok(module, 'Feishu indexed history sync module should exist');
    let fetched = false;

    const result = await module.syncFeishuIndexedHistory({
      chatId: 'oc_chat',
      chatType: 'group',
      displayName: '测试群',
      store: {},
      fetchMemberNames: async () => new Map(),
      fetchPage: async () => {
        fetched = true;
        return { items: [], nextPageToken: '', hasMore: false };
      },
      harvestStickers: async () => {},
      extractText: () => '',
    });

    assert.equal(result.skipped, true);
    assert.equal(fetched, false);
  });
});
