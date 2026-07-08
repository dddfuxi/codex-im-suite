import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { initBridgeContext } from '../../lib/bridge/context.js';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter.js';
import type { BridgeStore } from '../../lib/bridge/host.js';

function createMockStore(settings: Record<string, string> = {}) {
  return {
    getSetting: (key: string) => settings[key] ?? null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    createSession: () => ({ id: '1', working_directory: '', model: '' }),
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: () => {},
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

function setupContext(settings: Record<string, string> = {}) {
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  initBridgeContext({
    store: createMockStore(settings) as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
}

function createFeishuTextEvent(messageId: string, text: string) {
  return {
    sender: {
      sender_type: 'user',
      sender_id: { open_id: 'ou_user', user_id: 'u_user', union_id: 'on_user' },
    },
    message: {
      message_id: messageId,
      chat_id: 'oc_group',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  };
}

function useTempCtiHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-test-'));
  process.env.CTI_HOME = dir;
  return dir;
}

describe('FeishuAdapter authorization', () => {
  beforeEach(() => {
    setupContext();
  });

  it('allows inbound chat even when bridge_feishu_allowed_users does not include sender', () => {
    setupContext({ bridge_feishu_allowed_users: 'ou_owner_only' });
    const adapter = new FeishuAdapter();

    assert.equal(adapter.isAuthorized('ou_random_user', 'oc_group'), true);
  });

  it('allows inbound chat even when bridge_feishu_allowed_users includes unrelated chat ids', () => {
    setupContext({ bridge_feishu_allowed_users: 'oc_other_group,ou_owner_only' });
    const adapter = new FeishuAdapter();

    assert.equal(adapter.isAuthorized('ou_random_user', 'oc_target_group'), true);
  });
});

describe('FeishuAdapter mention detection fallback', () => {
  beforeEach(() => {
    setupContext();
  });

  it('detects bot mention from text content when mentions array is missing', () => {
    const adapter = new FeishuAdapter() as any;
    adapter.botIds.add('ou_bot');

    const mentioned = adapter.isBotMentionedFromMessage({
      content: JSON.stringify({
        text: '<at user_id="ou_bot">Codex</at> 帮我看一下',
      }),
      mentions: undefined,
    });

    assert.equal(mentioned, true);
  });

  it('detects bot mention from post content when mentions array is missing', () => {
    const adapter = new FeishuAdapter() as any;
    adapter.botIds.add('ou_bot');

    const mentioned = adapter.isBotMentionedFromMessage({
      content: JSON.stringify({
        title: '',
        content: [[
          { tag: 'at', user_id: 'ou_bot', user_name: 'Codex' },
          { tag: 'text', text: ' 帮我看一下' },
        ]],
      }),
      mentions: undefined,
    });

    assert.equal(mentioned, true);
  });
});

describe('FeishuAdapter bot name wake classification', () => {
  it('accepts actionable group messages that wake the bot by configured alias', async () => {
    const store = createMockStore({
      bridge_feishu_require_mention: 'true',
      bridge_feishu_bot_name: 'BridgeBot',
      bridge_feishu_bot_aliases: '小桥, 桥助手',
    }) as any;
    const auditLogs: Array<{ summary?: string }> = [];
    store.insertAuditLog = (entry: { summary?: string }) => auditLogs.push(entry);
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = new FeishuAdapter() as any;
    const queued: unknown[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);

    await adapter.processIncomingEvent(createFeishuTextEvent('om_alias_wake', '小桥 帮我看看这个问题'));

    assert.equal(queued.length, 1);
    assert.equal((queued[0] as any).text, '小桥 帮我看看这个问题');
    assert.deepEqual((queued[0] as any).raw?.feishuBotWake, {
      mode: 'name',
      state: 'investigate',
      alias: '小桥',
      reason: 'actionable_request',
    });
    assert.ok(auditLogs.every((entry) => !entry.summary?.includes('not @mentioned')));
  });

  it('drops third-person bot name mentions that do not ask the bot to respond', async () => {
    const store = createMockStore({
      bridge_feishu_require_mention: 'true',
      bridge_feishu_bot_aliases: '小桥',
    }) as any;
    const auditLogs: Array<{ summary?: string }> = [];
    store.insertAuditLog = (entry: { summary?: string }) => auditLogs.push(entry);
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = new FeishuAdapter() as any;
    const queued: unknown[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);

    await adapter.processIncomingEvent(createFeishuTextEvent('om_third_person', '刚才小桥说的那个方案挺好'));

    assert.equal(queued.length, 0);
    assert.ok(auditLogs.some((entry) => entry.summary?.includes('bot name mention not actionable')));
  });

  it('drops corrective native bot mentions that do not need a reply', async () => {
    const store = createMockStore({
      bridge_feishu_require_mention: 'true',
      bridge_feishu_bot_aliases: '小虾米',
    }) as any;
    const auditLogs: Array<{ summary?: string }> = [];
    store.insertAuditLog = (entry: { summary?: string }) => auditLogs.push(entry);
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = new FeishuAdapter() as any;
    adapter.botIds.add('ou_bot');
    const queued: unknown[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);
    const event = createFeishuTextEvent(
      'om_corrective_native_bot_mention',
      '@_user_1 你自己是小虾米啊，干啥呢，以后看清聊天记录再回复',
    ) as any;
    event.message.mentions = [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小虾米' },
    ];

    await adapter.processIncomingEvent(event);

    assert.equal(queued.length, 0);
    assert.ok(auditLogs.some((entry) => entry.summary?.includes('bot mention not actionable')));
  });

  it('drops bot names used as the object of another mention request', async () => {
    const store = createMockStore({
      bridge_feishu_require_mention: 'true',
      bridge_feishu_bot_aliases: '小虾米',
    }) as any;
    const auditLogs: Array<{ summary?: string }> = [];
    store.insertAuditLog = (entry: { summary?: string }) => auditLogs.push(entry);
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = new FeishuAdapter() as any;
    const queued: unknown[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);
    const event = createFeishuTextEvent('om_name_as_object', '@_user_1 你能at小虾米吗智障') as any;
    event.message.mentions = [
      { key: '@_user_1', id: { open_id: 'ou_other_bot' }, name: '乔治' },
    ];

    await adapter.processIncomingEvent(event);

    assert.equal(queued.length, 0);
    assert.ok(auditLogs.some((entry) => entry.summary?.includes('bot name mention not actionable')));
  });

  it('allows actionable native mentions from another Feishu bot or app sender', async () => {
    const store = createMockStore({
      bridge_feishu_require_mention: 'true',
      bridge_feishu_bot_aliases: '小虾米',
    }) as any;
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = new FeishuAdapter() as any;
    adapter.botIds.add('ou_current_bot');
    const queued: unknown[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);
    const event = createFeishuTextEvent('om_bot_to_bot', '@_user_1 请继续检查这个问题') as any;
    event.sender = {
      sender_type: 'app',
      sender_id: { open_id: 'ou_george_bot' },
    };
    event.message.mentions = [
      { key: '@_user_1', id: { open_id: 'ou_current_bot' }, name: '小虾米' },
    ];

    await adapter.processIncomingEvent(event);

    assert.equal(queued.length, 1);
    assert.equal((queued[0] as any).text, '请继续检查这个问题');
    assert.equal((queued[0] as any).raw?.feishuSender?.senderType, 'app');
    assert.equal((queued[0] as any).raw?.feishuBotToBot?.senderType, 'app');
  });

  it('drops native mentions from bot senders after the bot-to-bot loop budget is exhausted', async () => {
    const store = createMockStore({
      bridge_feishu_require_mention: 'true',
      bridge_feishu_bot_aliases: '小虾米',
      bridge_feishu_bot_to_bot_max_turns: '1',
    }) as any;
    const auditLogs: Array<{ summary?: string }> = [];
    store.insertAuditLog = (entry: { summary?: string }) => auditLogs.push(entry);
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = new FeishuAdapter() as any;
    adapter.botIds.add('ou_current_bot');
    const queued: unknown[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);
    const makeBotEvent = (messageId: string, text: string) => {
      const event = createFeishuTextEvent(messageId, `@_user_1 ${text}`) as any;
      event.sender = {
        sender_type: 'app',
        sender_id: { open_id: 'ou_george_bot' },
      };
      event.message.mentions = [
        { key: '@_user_1', id: { open_id: 'ou_current_bot' }, name: '小虾米' },
      ];
      return event;
    };

    await adapter.processIncomingEvent(makeBotEvent('om_bot_loop_1', '第一轮继续'));
    await adapter.processIncomingEvent(makeBotEvent('om_bot_loop_2', '第二轮继续'));

    assert.equal(queued.length, 1);
    assert.equal((queued[0] as any).messageId, 'om_bot_loop_1');
    assert.ok(auditLogs.some((entry) => entry.summary?.includes('bot-to-bot loop budget exhausted')));
  });
});

describe('FeishuAdapter assistant identity', () => {
  beforeEach(() => {
    setupContext({
      bridge_feishu_app_id: 'cli_app_test',
      bridge_feishu_app_secret: 'secret',
    });
  });

  it('uses bot info app name as the assistant display name', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const text = String(url);
      calls.push(text);
      if (text.includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (text.includes('/bot/v3/info')) {
        return new Response(JSON.stringify({
          code: 0,
          bot: {
            open_id: 'ou_bot',
            bot_id: 'bot_id',
            app_name: '小虾米',
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ code: 404, msg: 'not found' }), { status: 404 });
    }) as typeof fetch;
    try {
      const adapter = new FeishuAdapter() as any;
      await adapter.resolveBotIdentity('cli_app_test', 'secret', 'feishu');

      assert.equal(adapter.getAssistantIdentity().displayName, '小虾米');
      assert.equal(adapter.getAssistantIdentity().botOpenId, 'ou_bot');
      assert.ok(calls.some((item) => item.includes('/bot/v3/info')));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('FeishuAdapter reply fallback', () => {
  beforeEach(() => {
    setupContext();
  });

  it('retries as plain chat send when reply target was withdrawn', async () => {
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      im: {
        message: {
          reply: async () => {
            calls.push('reply');
            const error: any = new Error('Request failed with status code 400');
            error.response = {
              data: {
                code: 230011,
                msg: 'The message was withdrawn.',
              },
            };
            throw error;
          },
          create: async () => {
            calls.push('create');
            return { data: { message_id: 'om_new' } };
          },
        },
      },
    };

    const result = await adapter.sendAsPlainText('oc_group', '测试回复', 'om_old');

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'om_new');
    assert.deepStrictEqual(calls, ['reply', 'create']);
  });

  it('retries card send as plain chat send when reply target was withdrawn', async () => {
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      im: {
        message: {
          reply: async () => {
            calls.push('reply');
            const error: any = new Error('Request failed with status code 400');
            error.response = {
              data: {
                code: 230011,
                msg: 'The message was withdrawn.',
              },
            };
            throw error;
          },
          create: async () => {
            calls.push('create');
            return { data: { message_id: 'om_new' } };
          },
        },
      },
    };

    const result = await adapter.sendAsCard('oc_group', '测试回复', 'om_old');

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'om_new');
    assert.deepStrictEqual(calls, ['reply', 'create']);
  });
});

describe('FeishuAdapter outbound mentions', () => {
  beforeEach(() => {
    setupContext();
  });

  it('renders structured mentions in markdown cards instead of plain @ text', async () => {
    const adapter = new FeishuAdapter() as any;
    const sent: Array<{ msg_type: string; content: string }> = [];

    adapter.restClient = {
      im: {
        message: {
          create: async (payload: any) => {
            sent.push(payload.data);
            return { data: { message_id: 'om_card' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group' },
      text: '@张三 哈喽呀',
      parseMode: 'Markdown',
      mentions: [{ userId: 'ou_target', name: '张三' }],
    });

    assert.equal(result.ok, true);
    assert.equal(sent[0]?.msg_type, 'interactive');
    const card = JSON.parse(sent[0]!.content);
    const content = card.body.elements[0].content;
    assert.match(content, /<at id="ou_target"><\/at>/);
    assert.doesNotMatch(content, /@张三/);
  });

  it('renders structured mentions in post fallback as native at nodes', async () => {
    const adapter = new FeishuAdapter() as any;
    const sent: Array<{ msg_type: string; content: string }> = [];

    adapter.restClient = {
      im: {
        message: {
          create: async (payload: any) => {
            sent.push(payload.data);
            return { data: { message_id: 'om_post' } };
          },
        },
      },
    };

    const result = await adapter.sendAsPost('oc_group', '@张三 哈喽呀', undefined, [
      { userId: 'ou_target', name: '张三' },
    ]);

    assert.equal(result.ok, true);
    assert.equal(sent[0]?.msg_type, 'post');
    const post = JSON.parse(sent[0]!.content);
    const row = post.zh_cn.content[0];
    assert.deepEqual(row[0], { tag: 'at', user_id: 'ou_target', user_name: '张三' });
    assert.equal(row[1].text, ' 哈喽呀');
  });

  it('renders explicit mentions in plain text payloads', () => {
    const adapter = new FeishuAdapter() as any;

    const content = adapter.buildFeishuTextPayload('hello', {
      address: { channelType: 'feishu', chatId: 'oc_group', chatType: 'group' },
      text: 'hello',
      mentions: [{ userId: 'ou_target', name: 'Alice' }],
    });

    assert.equal(JSON.parse(content).text, '<at user_id="ou_target">Alice</at>\nhello');
  });

  it('resolves bare at-name text from current chat members', async () => {
    const adapter = new FeishuAdapter() as any;
    adapter.fetchChatMemberNames = async (chatId: string) => {
      assert.equal(chatId, 'oc_group');
      return new Map([
        ['ou_liudan', '刘丹'],
        ['ou_zhangsan', '张三'],
      ]);
    };

    const resolved = await adapter.resolveOutboundMentions({
      address: { channelType: 'feishu', chatId: 'oc_group', chatType: 'group' },
      text: '@刘丹 哈喽呀',
      parseMode: 'Markdown',
    });

    assert.deepEqual(resolved.mentions, [{ userId: 'ou_liudan', name: '刘丹' }]);
    assert.equal(resolved.text, '@刘丹 哈喽呀');
  });

  it('resolves bare at-name text from Feishu chat bot members when the bot has a mentionable open_id', async () => {
    setupContext({
      bridge_feishu_app_id: 'cli_app_test',
      bridge_feishu_app_secret: 'secret',
    });
    const adapter = new FeishuAdapter() as any;
    const originalFetch = globalThis.fetch;
    const calledUrls: string[] = [];

    globalThis.fetch = (async (url: string | URL | Request) => {
      const text = String(url);
      calledUrls.push(text);
      if (text.includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (text.includes('/open-apis/im/v1/chats/oc_group/members/list')) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            users: [],
            bots: [
              { open_id: 'ou_george_bot', name: '乔治', app_name: 'codex小助手' },
            ],
            has_more: false,
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (text.includes('/open-apis/im/v1/chats/oc_group/members')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { items: [], has_more: false },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ code: 404, msg: 'not found' }), { status: 404 });
    }) as typeof fetch;

    try {
      const resolved = await adapter.resolveOutboundMentions({
        address: { channelType: 'feishu', chatId: 'oc_group', chatType: 'group' },
        text: '@乔治 打工仔',
        parseMode: 'Markdown',
      });

      assert.deepEqual(resolved.mentions, [{ userId: 'ou_george_bot', name: '乔治' }]);
      assert.ok(calledUrls.some((item) => item.includes('/members/list')));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not resolve Feishu chat bots when members/list only exposes app or bot identifiers', async () => {
    setupContext({
      bridge_feishu_app_id: 'cli_app_test',
      bridge_feishu_app_secret: 'secret',
    });
    const adapter = new FeishuAdapter() as any;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: string | URL | Request) => {
      const text = String(url);
      if (text.includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (text.includes('/open-apis/im/v1/chats/oc_group/members/list')) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            users: [],
            bots: [
              { app_id: 'cli_george', bot_id: 'bot_george', name: '乔治' },
            ],
            has_more: false,
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (text.includes('/open-apis/im/v1/chats/oc_group/members')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { items: [], has_more: false },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ code: 404, msg: 'not found' }), { status: 404 });
    }) as typeof fetch;

    try {
      const resolved = await adapter.resolveOutboundMentions({
        address: { channelType: 'feishu', chatId: 'oc_group', chatType: 'group' },
        text: '@乔治 打工仔',
        parseMode: 'Markdown',
      });

      assert.equal(resolved.mentions, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not invent a structured mention when an at-name has multiple chat member matches', async () => {
    const adapter = new FeishuAdapter() as any;
    adapter.fetchChatMemberNames = async () => new Map([
      ['ou_a', '刘丹'],
      ['ou_b', '刘丹'],
    ]);

    const resolved = await adapter.resolveOutboundMentions({
      address: { channelType: 'feishu', chatId: 'oc_group', chatType: 'group' },
      text: '@刘丹 哈喽呀',
      parseMode: 'Markdown',
    });

    assert.equal(resolved.mentions, undefined);
  });

  it('resolves at-name text from verified Feishu history mention ids when chat members omit the bot', async () => {
    const adapter = new FeishuAdapter() as any;
    const home = useTempCtiHome();
    const historyDir = path.join(home, 'data', 'feishu-history');
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, 'oc_other.json'), JSON.stringify([
      {
        messageId: 'om_history',
        chatId: 'oc_other',
        createTime: '1',
        msgType: 'interactive',
        senderId: 'cli_sender',
        senderType: 'app',
        senderName: '',
        text: '<at user_id=ou_george>乔治</at> 你好',
      },
    ]), 'utf8');
    adapter.fetchChatMemberNames = async () => new Map([
      ['ou_liudan', '刘丹'],
    ]);

    const resolved = await adapter.resolveOutboundMentions({
      address: { channelType: 'feishu', chatId: 'oc_group', chatType: 'group' },
      text: '@乔治 乔治在不在',
      parseMode: 'Markdown',
    });

    assert.deepEqual(resolved.mentions, [{ userId: 'ou_george', name: '乔治' }]);
  });

  it('does not resolve bot or app member ids as native user mentions', async () => {
    const adapter = new FeishuAdapter() as any;
    adapter.fetchChatMemberNames = async () => new Map([
      ['cli_agent_app', '小桥'],
    ]);

    const resolved = await adapter.resolveOutboundMentions({
      address: { channelType: 'feishu', chatId: 'oc_group', chatType: 'group' },
      text: '@小桥 帮我看一下',
      parseMode: 'Markdown',
    });

    assert.equal(resolved.mentions, undefined);
  });

  it('does not infer a sender mention from group reply metadata', () => {
    const adapter = new FeishuAdapter() as any;

    const content = adapter.buildFeishuTextPayload('hello', {
      address: {
        channelType: 'feishu',
        chatId: 'oc_group',
        chatType: 'group',
        userId: 'ou_sender',
        displayName: 'Sender',
      },
      text: 'hello',
      replyToMessageId: 'om_source',
    });

    assert.equal(JSON.parse(content).text, 'hello');
  });

  it('sends direct messages to resolved open_id targets without using the current group chat_id', async () => {
    const adapter = new FeishuAdapter() as any;
    const sent: any[] = [];
    adapter.fetchChatMemberNames = async (chatId: string) => {
      assert.equal(chatId, 'oc_group');
      return new Map([
        ['ou_sumu', '苏木'],
        ['ou_other', '其他人'],
      ]);
    };
    adapter.restClient = {
      im: {
        message: {
          create: async (payload: any) => {
            sent.push(payload);
            return { data: { message_id: 'om_direct' } };
          },
        },
      },
    };

    const result = await adapter.sendDirectMessage({
      sourceMessage: {
        messageId: 'om_source',
        address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_sender', chatType: 'group' },
        text: '给苏木私发一条消息：暗号是 12345',
        timestamp: Date.now(),
      },
      targetText: '苏木',
      text: '暗号是 12345',
    });

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'om_direct');
    assert.equal(result.targetDisplayName, '苏木');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].params.receive_id_type, 'open_id');
    assert.equal(sent[0].data.receive_id, 'ou_sumu');
    assert.equal(sent[0].data.msg_type, 'text');
    assert.equal(JSON.parse(sent[0].data.content).text, '暗号是 12345');
  });

  it('does not send direct messages when a display name resolves to multiple users', async () => {
    const adapter = new FeishuAdapter() as any;
    const sent: any[] = [];
    adapter.fetchChatMemberNames = async () => new Map([
      ['ou_a', '苏木'],
      ['ou_b', '苏木'],
    ]);
    adapter.restClient = {
      im: {
        message: {
          create: async (payload: any) => {
            sent.push(payload);
            return { data: { message_id: 'om_direct' } };
          },
        },
      },
    };

    const result = await adapter.sendDirectMessage({
      sourceMessage: {
        messageId: 'om_source',
        address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_sender', chatType: 'group' },
        text: '给苏木私发一条消息：不要泄露',
        timestamp: Date.now(),
      },
      targetText: '苏木',
      text: '不要泄露',
    });

    assert.equal(result.ok, false);
    assert.match(result.error || '', /无法确认目标|not resolve/i);
    assert.equal(sent.length, 0);
  });
});

describe('FeishuAdapter light conversation context', () => {
  beforeEach(() => {
    setupContext({ bridge_feishu_light_context_limit: '4' });
  });

  it('builds short group context from the replied message and recent nearby messages', async () => {
    const adapter = new FeishuAdapter() as any;
    const now = Date.now();
    const makeItem = (messageId: string, text: string, senderId: string, offset: number) => ({
      message_id: messageId,
      chat_id: 'oc_group',
      create_time: String(now + offset),
      msg_type: 'text',
      body: { content: JSON.stringify({ text }) },
      sender: { id: senderId, sender_type: 'user' },
    });

    adapter.fetchChatMemberNames = async () => new Map([
      ['ou_su', '苏庆华'],
      ['ou_liu', '刘丹'],
    ]);
    adapter.fetchMessageById = async (messageId: string) => (
      messageId === 'om_reply'
        ? makeItem('om_reply', '将群名称“万能区域什么都能改小分队”修改为“万能区域什么都能改小王分队”', 'ou_su', -3000)
        : null
    );
    adapter.fetchRecentMessages = async () => [
      makeItem('om_current', '@小虾米 你怎么看，怎么起名', 'ou_liu', 0),
      makeItem('om_reply', '将群名称“万能区域什么都能改小分队”修改为“万能区域什么都能改小王分队”', 'ou_su', -3000),
      makeItem('om_other', '我真服了', 'ou_su', -1000),
    ];

    const context = await adapter.buildLightConversationContext(
      'oc_group',
      'om_current',
      'om_reply',
      '小虾米你怎么看，怎么起名',
    );

    assert.ok(context);
    assert.equal(context.replyToMessageId, 'om_reply');
    assert.match(context.prompt, /Feishu recent conversation context/);
    assert.match(context.prompt, /被回复消息/);
    assert.match(context.prompt, /万能区域什么都能改小王分队/);
    assert.doesNotMatch(context.prompt, /@小虾米 你怎么看/);
  });
});

describe('FeishuAdapter history intent and bot event guards', () => {
  beforeEach(() => {
    setupContext();
  });

  it('recognizes casual requests to look at what today group chat was about', () => {
    const adapter = new FeishuAdapter() as any;

    const intent = adapter.parseHistoryIntentV2('蠢死了，你看一下今天群聊天记录在说什么再回我');

    assert.ok(intent);
    assert.equal(intent.responseMode, 'chat');
    assert.equal(intent.purpose, 'summary');
    assert.match(intent.scopeText, /今天/);
  });

  it('recognizes group-locative chat summary requests as history intent', () => {
    const adapter = new FeishuAdapter() as any;

    const intent = adapter.parseHistoryIntentV2('看看群里都在聊什么');

    assert.ok(intent);
    assert.equal(intent.responseMode, 'chat');
    assert.equal(intent.purpose, 'summary');
    assert.equal(intent.limit, 30);
    assert.match(intent.scopeText, /本群最近消息/);
  });

  it('ignores app interactive events so bot cards cannot trigger another LLM turn', async () => {
    const adapter = new FeishuAdapter() as any;
    const queued: unknown[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);
    adapter.running = true;

    await adapter.handleIncomingEvent({
      sender: {
        sender_type: 'app',
        sender_id: { app_id: 'cli_app_test' },
      },
      message: {
        message_id: 'om_card',
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'interactive',
        content: JSON.stringify({ title: '未完成', elements: [] }),
        create_time: String(Date.now()),
      },
    });

    assert.equal(queued.length, 0);
  });
});

describe('FeishuAdapter recall message', () => {
  beforeEach(() => {
    setupContext({
      bridge_feishu_app_id: 'cli_app_test',
      bridge_feishu_app_secret: 'secret',
    });
  });

  it('recalls a Feishu message through the message delete API', async () => {
    const adapter = new FeishuAdapter() as any;
    const deleted: string[] = [];
    adapter.restClient = {
      im: {
        message: {
          delete: async (input: any) => {
            deleted.push(input.path.message_id);
            return { code: 0, msg: 'ok' };
          },
        },
      },
    };

    const result = await adapter.recallMessage('oc_group', 'om_bot');

    assert.equal(result.ok, true);
    assert.deepStrictEqual(deleted, ['om_bot']);
  });
});

describe('FeishuAdapter CardKit compatibility', () => {
  beforeEach(() => {
    useTempCtiHome();
    setupContext({ bridge_feishu_streaming_card_enabled: 'true' });
  });

  it('uses CardKit v1 endpoints when the SDK does not expose v2', async () => {
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async (payload: unknown) => {
              calls.push(`card.create:${JSON.stringify(payload)}`);
              return { data: { card_id: 'card_v1' } };
            },
            settings: async (payload: unknown) => {
              calls.push(`card.settings:${JSON.stringify(payload)}`);
              return { data: {} };
            },
            update: async (payload: unknown) => {
              calls.push(`card.update:${JSON.stringify(payload)}`);
              return { data: {} };
            },
          },
          cardElement: {
            content: async (payload: unknown) => {
              calls.push(`cardElement.content:${JSON.stringify(payload)}`);
              return { data: {} };
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'om_card' } }),
        },
      },
    };

    const created = await adapter._doCreateStreamingCard('oc_card');
    adapter.onStreamText('oc_card', '### 处理进度\n- 正在执行');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const finalized = await adapter.finalizeCard('oc_card', 'completed', '已完成');

    assert.equal(created, true);
    assert.equal(finalized, true);
    assert.ok(calls.some((item) => item.startsWith('card.create:')));
    assert.ok(calls.some((item) => item.startsWith('cardElement.content:')));
    assert.ok(calls.some((item) => item.startsWith('card.settings:')));
    assert.ok(calls.some((item) => item.startsWith('card.update:')));
    assert.doesNotThrow(() => JSON.stringify(calls));
  });

  it('turns a final card emoji hint into a reaction and removes it from the card body', async () => {
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card_v1' } }),
            settings: async (payload: unknown) => {
              calls.push(`card.settings:${JSON.stringify(payload)}`);
              return { data: {} };
            },
            update: async (payload: unknown) => {
              calls.push(`card.update:${JSON.stringify(payload)}`);
              return { data: {} };
            },
          },
          cardElement: {
            content: async (payload: unknown) => {
              calls.push(`cardElement.content:${JSON.stringify(payload)}`);
              return { data: {} };
            },
          },
        },
      },
      im: {
        messageReaction: {
          create: async (payload: unknown) => {
            calls.push(`reaction:${JSON.stringify(payload)}`);
            return { data: { reaction_id: 'react_1' } };
          },
        },
        message: {
          reply: async () => ({ data: { message_id: 'om_card' } }),
        },
      },
    };

    const created = await adapter._doCreateStreamingCard('oc_card', 'om_user');
    const finalized = await adapter.finalizeCard('oc_card', 'completed', '[微笑] 收到~');

    assert.equal(created, true);
    assert.equal(finalized, true);
    assert.ok(calls.some((item) => /reaction:.*"emoji_type":"SMILE"/.test(item)));
    const cardUpdate = calls.find((item) => item.startsWith('card.update:')) || '';
    assert.match(cardUpdate, /收到~/);
    assert.doesNotMatch(cardUpdate, /\[微笑\]/);
  });

  it('falls back to visible emoji when final card reaction cannot be added', async () => {
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card_v1' } }),
            settings: async () => ({ data: {} }),
            update: async (payload: unknown) => {
              calls.push(`card.update:${JSON.stringify(payload)}`);
              return { data: {} };
            },
          },
          cardElement: { content: async () => ({ data: {} }) },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'om_card' } }),
          reply: async () => ({ data: { message_id: 'om_card' } }),
        },
      },
    };

    const created = await adapter._doCreateStreamingCard('oc_card');
    const finalized = await adapter.finalizeCard('oc_card', 'completed', '[微笑] 收到~');

    assert.equal(created, true);
    assert.equal(finalized, true);
    const cardUpdate = calls.find((item) => item.startsWith('card.update:')) || '';
    assert.match(cardUpdate, new RegExp('\\u{1F642}', 'u'));
    assert.match(cardUpdate, /收到~/);
    assert.doesNotMatch(cardUpdate, /\[微笑\]/);
  });

  it('does not turn a final card bare sticker hint into an arbitrary unannotated sticker', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(path.join(ctiHome, 'data', 'feishu-stickers.json'), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [{
        fileKey: 'sticker_file_key',
        aliases: ['最近', '默认', '表情包'],
        chatId: 'oc_card',
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        useCount: 0,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card_v1' } }),
            settings: async () => ({ data: {} }),
            update: async (payload: unknown) => {
              calls.push(`card.update:${JSON.stringify(payload)}`);
              return { data: {} };
            },
          },
          cardElement: { content: async () => ({ data: {} }) },
        },
      },
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(`message.reply:${JSON.stringify(payload)}`);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const created = await adapter._doCreateStreamingCard('oc_card', 'om_user');
    const finalized = await adapter.finalizeCard('oc_card', 'completed', '[表情包] 收到~');

    assert.equal(created, true);
    assert.equal(finalized, true);
    assert.ok(!calls.some((item) => /"msg_type":"sticker"/.test(item)));
    assert.ok(!calls.some((item) => /\\"file_key\\":\\"sticker_file_key\\"/.test(item)));
    const cardUpdate = calls.find((item) => item.startsWith('card.update:')) || '';
    assert.match(cardUpdate, /收到~/);
    assert.doesNotMatch(cardUpdate, /\[表情包\]/);
  });

  it('finalizes unresolved sticker-only card replies as readable text instead of sending an arbitrary sticker', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(path.join(ctiHome, 'data', 'feishu-stickers.json'), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [{
        fileKey: 'sticker_file_key',
        aliases: ['最近', '默认', '表情包'],
        chatId: 'oc_card',
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        useCount: 0,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card_v1' } }),
            settings: async () => ({ data: {} }),
            update: async (payload: unknown) => {
              calls.push(`card.update:${JSON.stringify(payload)}`);
              return { data: {} };
            },
          },
          cardElement: { content: async () => ({ data: {} }) },
        },
      },
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(`message.reply:${JSON.stringify(payload)}`);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const created = await adapter._doCreateStreamingCard('oc_card', 'om_user');
    const finalized = await adapter.finalizeCard('oc_card', 'completed', '[表情包]\n✅');

    assert.equal(created, true);
    assert.equal(finalized, true);
    assert.ok(!calls.some((item) => /"msg_type":"sticker"/.test(item)));
    const cardUpdate = calls.find((item) => item.startsWith('card.update:')) || '';
    assert.match(cardUpdate, /收到~/);
    assert.doesNotMatch(cardUpdate, /模型没有返回可展示结果/);
    assert.doesNotMatch(cardUpdate, /\[表情包\]/);
  });

  it('does not rotate bare sticker hints across unannotated Feishu stickers', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(path.join(ctiHome, 'data', 'feishu-stickers.json'), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [
        {
          fileKey: 'sticker_often_used',
          aliases: ['最近', '默认', '表情包'],
          chatId: 'oc_card',
          firstSeenAt: '2026-06-06T07:00:00.000Z',
          lastSeenAt: '2026-06-06T07:10:00.000Z',
          lastUsedAt: '2026-06-06T07:20:00.000Z',
          useCount: 5,
        },
        {
          fileKey: 'sticker_fresh_choice',
          aliases: ['最近', '默认', '表情包'],
          chatId: 'oc_card',
          firstSeenAt: '2026-06-06T06:00:00.000Z',
          lastSeenAt: '2026-06-06T06:10:00.000Z',
          useCount: 0,
        },
      ],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card_v1' } }),
            settings: async () => ({ data: {} }),
            update: async () => ({ data: {} }),
          },
          cardElement: { content: async () => ({ data: {} }) },
        },
      },
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(`message.reply:${JSON.stringify(payload)}`);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const created = await adapter._doCreateStreamingCard('oc_card', 'om_user');
    const finalized = await adapter.finalizeCard('oc_card', 'completed', '[表情包] 换一个~');

    assert.equal(created, true);
    assert.equal(finalized, true);
    assert.ok(!calls.some((item) => /"msg_type":"sticker"/.test(item)));
  });

  it('chooses the semantically best sticker for bare sticker hints with reply text', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(path.join(ctiHome, 'data', 'feishu-stickers.json'), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [
        {
          fileKey: 'sticker_praise',
          aliases: ['表情包', '鼓励'],
          chatId: 'oc_group',
          label: '鼓励',
          intent: '称赞、认可、夸奖',
          tone: 'positive',
          usage: '别人完成任务或做得很好时使用',
          firstSeenAt: '2026-06-06T06:00:00.000Z',
          lastSeenAt: '2026-06-06T06:10:00.000Z',
          useCount: 0,
        },
        {
          fileKey: 'sticker_confused',
          aliases: ['表情包', '疑惑', '吐槽'],
          chatId: 'oc_group',
          label: '疑惑吐槽',
          intent: '表达疑惑、吐槽突然的奇怪需求',
          tone: 'playful skeptical',
          usage: '别人突然丢奇怪需求时接话',
          examples: ['这需求有点突然', '你这是要干嘛'],
          firstSeenAt: '2026-06-06T05:00:00.000Z',
          lastSeenAt: '2026-06-06T05:10:00.000Z',
          lastUsedAt: '2026-06-06T07:20:00.000Z',
          useCount: 8,
        },
      ],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(`reply:${JSON.stringify(payload)}`);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[表情包] 这需求有点突然',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.equal(result.ok, true);
    const stickerCall = calls
      .map((item) => JSON.parse(item.slice('reply:'.length)) as { data?: { content?: string; msg_type?: string } })
      .find((item) => item.data?.msg_type === 'sticker');
    const stickerContent = JSON.parse(String(stickerCall?.data?.content || '{}')) as { file_key?: string };
    assert.equal(stickerContent.file_key, 'sticker_confused');
  });

  it('excludes disabled and avoidWhen-matched stickers from bare hint selection', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(path.join(ctiHome, 'data', 'feishu-stickers.json'), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [
        {
          fileKey: 'sticker_disabled',
          aliases: ['表情包', '疑惑'],
          chatId: 'oc_group',
          label: '疑惑',
          intent: '疑惑、吐槽',
          usage: '别人突然丢需求时',
          disabled: true,
          disabledReason: '误学语义',
          firstSeenAt: '2026-06-06T05:00:00.000Z',
          lastSeenAt: '2026-06-06T05:10:00.000Z',
          useCount: 0,
        },
        {
          fileKey: 'sticker_avoid',
          aliases: ['表情包', '吐槽'],
          chatId: 'oc_group',
          label: '吐槽',
          intent: '吐槽奇怪需求',
          usage: '别人突然丢需求时',
          avoidWhen: '正式确认',
          firstSeenAt: '2026-06-06T05:00:00.000Z',
          lastSeenAt: '2026-06-06T05:10:00.000Z',
          useCount: 0,
        },
        {
          fileKey: 'sticker_ok',
          aliases: ['表情包', '确认'],
          chatId: 'oc_group',
          label: '确认',
          intent: '确认、收到',
          usage: '轻量确认时',
          firstSeenAt: '2026-06-06T04:00:00.000Z',
          lastSeenAt: '2026-06-06T04:10:00.000Z',
          useCount: 3,
        },
      ],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const prompt = adapter.getStickerPresentationPrompt('oc_group');
    assert.doesNotMatch(prompt, /\[表情包:疑惑\]/);

    const calls: string[] = [];
    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(`reply:${JSON.stringify(payload)}`);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[表情包] 正式确认，收到',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.equal(result.ok, true);
    const stickerCall = calls
      .map((item) => JSON.parse(item.slice('reply:'.length)) as { data?: { content?: string; msg_type?: string } })
      .find((item) => item.data?.msg_type === 'sticker');
    const stickerContent = JSON.parse(String(stickerCall?.data?.content || '{}')) as { file_key?: string };
    assert.equal(stickerContent.file_key, 'sticker_ok');
  });

  it('does not send an arbitrary sticker when a final card requests an unknown sticker alias', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(path.join(ctiHome, 'data', 'feishu-stickers.json'), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [{
        fileKey: 'sticker_known_only',
        aliases: ['最近', '默认', '表情包'],
        chatId: 'oc_card',
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        useCount: 6,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card_v1' } }),
            settings: async () => ({ data: {} }),
            update: async (payload: unknown) => {
              calls.push(`card.update:${JSON.stringify(payload)}`);
              return { data: {} };
            },
          },
          cardElement: { content: async () => ({ data: {} }) },
        },
      },
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(`message.reply:${JSON.stringify(payload)}`);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const created = await adapter._doCreateStreamingCard('oc_card', 'om_user');
    const finalized = await adapter.finalizeCard('oc_card', 'completed', '[表情包:微笑] 换一个~');

    assert.equal(created, true);
    assert.equal(finalized, true);
    assert.ok(!calls.some((item) => /"msg_type":"sticker"/.test(item)));
    const cardUpdate = calls.find((item) => item.startsWith('card.update:')) || '';
    assert.match(cardUpdate, /换一个~/);
    assert.doesNotMatch(cardUpdate, /\[表情包:微笑\]/);
  });

  it('streams thinking text as incremental typewriter updates', async () => {
    const adapter = new FeishuAdapter() as any;
    const contents: string[] = [];

    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card_v1' } }),
            settings: async () => ({ data: {} }),
            update: async () => ({ data: {} }),
          },
          cardElement: {
            content: async (payload: any) => {
              contents.push(String(payload?.data?.content || ''));
              return { data: {} };
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'om_card' } }),
        },
      },
    };

    const created = await adapter._doCreateStreamingCard('oc_card');
    adapter.onStreamText('oc_card', '正在确认需要截图证据。');
    await new Promise((resolve) => setTimeout(resolve, 180));
    await adapter.finalizeCard('oc_card', 'completed', '已完成');

    assert.equal(created, true);
    assert.ok(contents.length >= 2);
    assert.match(contents[0], /<font color="grey"><\/font>/);
    assert.ok(contents.some((content) => /正在/.test(content)));
    assert.ok(contents.some((content) => !/正在确认需要截图证据。/.test(content)));
  });
});

describe('FeishuAdapter sticker inbound', () => {
  beforeEach(() => {
    useTempCtiHome();
    setupContext();
  });

  it('converts unknown sticker messages into non-hallucinated user-visible text', async () => {
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user' },
      },
      message: {
        message_id: 'om_sticker',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: 'sticker_file_key' }),
        create_time: '1710000000000',
      },
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.match(inbound?.text || '', /尚未标注语义的飞书表情包/);
    assert.match(inbound?.text || '', /不能可靠识别图案、文字和意图/);
    assert.match(inbound?.text || '', /不要凭 file_key 猜测含义/);
    assert.equal((inbound?.raw as any)?.sticker?.fileKey, 'sticker_file_key');
    assert.equal((inbound?.raw as any)?.sticker?.known, false);
    assert.equal(inbound?.messageKind, 'feishu_sticker_unknown');
    assert.equal((inbound?.raw as any)?.messageKind, 'feishu_sticker_unknown');
    const store = JSON.parse(fs.readFileSync(path.join(process.env.CTI_HOME!, 'data', 'feishu-stickers.json'), 'utf8'));
    assert.equal(store.stickers[0].fileKey, 'sticker_file_key');
  });

  it('downloads sticker resources as image attachments before falling back to semantic profiles', async () => {
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.restClient = {
      im: {
        messageResource: {
          get: async () => ({
            getReadableStream: () => Readable.from([Buffer.from([0x89, 0x50, 0x4e, 0x47])]),
          }),
        },
      },
    };

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user' },
      },
      message: {
        message_id: 'om_sticker',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: 'sticker_file_key' }),
        create_time: '1710000000000',
      },
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.messageKind, 'feishu_sticker_image');
    assert.equal((inbound?.raw as any)?.sticker?.imageAvailable, true);
    assert.match(inbound?.text || '', /图片已作为本轮图片附件提供给模型/);
    assert.equal(inbound?.attachments?.length, 1);
    assert.equal(inbound?.attachments?.[0]?.type, 'image/png');
    assert.match(inbound?.attachments?.[0]?.name || '', /^sticker-sticker_file_key\.png$/);
  });

  it('uses learned sticker semantics when a sticker file_key has a profile', async () => {
    fs.mkdirSync(path.join(process.env.CTI_HOME!, 'data'), { recursive: true });
    fs.writeFileSync(path.join(process.env.CTI_HOME!, 'data', 'feishu-stickers.json'), JSON.stringify({
      version: 1,
      updatedAt: '2026-06-04T00:00:00.000Z',
      stickers: [{
        fileKey: 'sticker_file_key',
        aliases: ['疑问猫'],
        label: '疑问猫',
        description: '猫脸旁边带“干嘛……”文字',
        intent: '表达疑惑、询问对方要做什么',
        tone: '轻松、吐槽',
        firstSeenAt: '2026-06-04T00:00:00.000Z',
        lastSeenAt: '2026-06-04T00:00:00.000Z',
        useCount: 0,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user' },
      },
      message: {
        message_id: 'om_sticker',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: 'sticker_file_key' }),
        create_time: '1710000000000',
      },
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.match(inbound?.text || '', /已记录语义的飞书表情包/);
    assert.match(inbound?.text || '', /图案\/名称：疑问猫/);
    assert.match(inbound?.text || '', /通常意图：表达疑惑、询问对方要做什么/);
    assert.equal((inbound?.raw as any)?.sticker?.known, true);
    assert.equal(inbound?.messageKind, 'feishu_sticker_known');
    assert.equal((inbound?.raw as any)?.messageKind, 'feishu_sticker_known');
    assert.equal((inbound?.raw as any)?.sticker?.label, '疑问猫');
    assert.equal((inbound?.raw as any)?.sticker?.intent, '表达疑惑、询问对方要做什么');
  });

  it('drops mojibake sticker profile fields instead of injecting unsafe semantics', async () => {
    fs.mkdirSync(path.join(process.env.CTI_HOME!, 'data'), { recursive: true });
    fs.writeFileSync(path.join(process.env.CTI_HOME!, 'data', 'feishu-stickers.json'), JSON.stringify({
      version: 1,
      updatedAt: '2026-06-04T00:00:00.000Z',
      stickers: [{
        fileKey: 'sticker_file_key',
        aliases: ['???', '鐤戦棶鐚?'],
        label: '???',
        description: '鐚劯鏃佽竟甯︽枃瀛?',
        intent: '???',
        tone: '鐤戞儜',
        firstSeenAt: '2026-06-04T00:00:00.000Z',
        lastSeenAt: '2026-06-04T00:00:00.000Z',
        useCount: 0,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user' },
      },
      message: {
        message_id: 'om_sticker',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: 'sticker_file_key' }),
        create_time: '1710000000000',
      },
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    assert.equal(inbound?.messageKind, 'feishu_sticker_unknown');
    assert.equal((inbound?.raw as any)?.sticker?.known, false);
    assert.doesNotMatch(inbound?.text || '', /\?\?\?|鐤戦棶|鐚劯/);
  });

  it('learns sticker semantics from a user explanation replying to the sticker', async () => {
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user' },
      },
      message: {
        message_id: 'om_sticker',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: 'sticker_file_key' }),
        create_time: '1710000000000',
      },
    });
    await adapter.consumeOne();

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user' },
      },
      message: {
        message_id: 'om_annotation',
        parent_id: 'om_sticker',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '这个表情包表示疑惑、问对方干嘛' }),
        create_time: '1710000001000',
      },
    });
    await adapter.consumeOne();

    const store = JSON.parse(fs.readFileSync(path.join(process.env.CTI_HOME!, 'data', 'feishu-stickers.json'), 'utf8'));
    assert.equal(store.stickers[0].fileKey, 'sticker_file_key');
    assert.equal(store.stickers[0].description, '疑惑、问对方干嘛');
    assert.equal(store.stickers[0].intent, '疑惑、问对方干嘛');

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user' },
      },
      message: {
        message_id: 'om_sticker_again',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: 'sticker_file_key' }),
        create_time: '1710000002000',
      },
    });

    const inbound = await adapter.consumeOne();
    assert.match(inbound?.text || '', /已记录语义的飞书表情包/);
    assert.match(inbound?.text || '', /通常意图：疑惑、问对方干嘛/);
  });

  it('stores sticker usage guidance from a user explanation', async () => {
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user' },
      },
      message: {
        message_id: 'om_sticker',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: 'sticker_file_key' }),
        create_time: '1710000000000',
      },
    });
    await adapter.consumeOne();

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user' },
      },
      message: {
        message_id: 'om_annotation',
        parent_id: 'om_sticker',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '这个表情包叫干嘛猫，表示疑惑，适合在别人突然丢奇怪需求时吐槽用' }),
        create_time: '1710000001000',
      },
    });
    await adapter.consumeOne();

    const store = JSON.parse(fs.readFileSync(path.join(process.env.CTI_HOME!, 'data', 'feishu-stickers.json'), 'utf8'));
    assert.equal(store.stickers[0].label, '干嘛猫');
    assert.equal(store.stickers[0].intent, '疑惑');
    assert.equal(store.stickers[0].usage, '别人突然丢奇怪需求时吐槽用');
    assert.ok(store.stickers[0].aliases.includes('干嘛猫'));
  });

  it('builds a sticker presentation prompt from learned meanings and usage', () => {
    fs.mkdirSync(path.join(process.env.CTI_HOME!, 'data'), { recursive: true });
    fs.writeFileSync(path.join(process.env.CTI_HOME!, 'data', 'feishu-stickers.json'), JSON.stringify({
      version: 1,
      updatedAt: '2026-06-05T00:00:00.000Z',
      stickers: [{
        fileKey: 'sticker_file_key',
        aliases: ['干嘛猫'],
        label: '干嘛猫',
        description: '白猫配字“干嘛……”',
        intent: '表达疑惑或轻微吐槽',
        tone: '轻松吐槽',
        usage: '别人突然丢奇怪需求时使用',
        chatId: 'oc_chat',
        firstSeenAt: '2026-06-05T00:00:00.000Z',
        lastSeenAt: '2026-06-05T00:00:00.000Z',
        useCount: 0,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;

    const prompt = adapter.getStickerPresentationPrompt('oc_chat');

    assert.match(prompt, /干嘛猫/);
    assert.match(prompt, /表达疑惑或轻微吐槽/);
    assert.match(prompt, /别人突然丢奇怪需求时使用/);
    assert.match(prompt, /\[表情包:干嘛猫\]/);
    assert.doesNotMatch(prompt, /sticker_file_key/);
  });

  it('does not suggest bare generic stickers when no semantic sticker is available for the current chat', () => {
    fs.mkdirSync(path.join(process.env.CTI_HOME!, 'data'), { recursive: true });
    fs.writeFileSync(path.join(process.env.CTI_HOME!, 'data', 'feishu-stickers.json'), JSON.stringify({
      version: 1,
      updatedAt: '2026-06-05T00:00:00.000Z',
      stickers: [{
        fileKey: 'sticker_file_key',
        aliases: ['最近', '默认', '表情包'],
        chatId: 'oc_other_chat',
        firstSeenAt: '2026-06-05T00:00:00.000Z',
        lastSeenAt: '2026-06-05T00:00:00.000Z',
        useCount: 0,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;

    const prompt = adapter.getStickerPresentationPrompt('oc_current_chat');

    assert.match(prompt, /No semantically annotated stickers are available/);
    assert.match(prompt, /Do not use bare/);
    assert.doesNotMatch(prompt, /reusable generic stickers/i);
    assert.doesNotMatch(prompt, /start with bare/);
    assert.doesNotMatch(prompt, /\[表情包:[^\]]+\]/);
  });
});

describe('FeishuAdapter p2p reply media recovery', () => {
  beforeEach(() => {
    setupContext();
    useTempCtiHome();
  });

  it('keeps reply metadata from history-polled p2p messages so replied images are attached', async () => {
    const adapter = new FeishuAdapter() as any;

    adapter.running = true;
    adapter.resolveChatDisplayName = async () => 'private chat';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.fetchMessagePage = async () => ({
      items: [
        {
          message_id: 'om_followup',
          parent_id: 'om_image',
          chat_id: 'oc_p2p',
          create_time: '2000',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: '一步一步分析给我解题思路' }) },
          sender: { id: 'ou_user', id_type: 'open_id', sender_type: 'user' },
        },
      ],
      hasMore: false,
      nextPageToken: '',
    });
    adapter.restClient = {
      im: {
        message: {
          get: async ({ path: requestPath }: any) => {
            assert.equal(requestPath.message_id, 'om_image');
            return {
              data: {
                items: [
                  {
                    message_id: 'om_image',
                    chat_id: 'oc_p2p',
                    create_time: '1000',
                    msg_type: 'image',
                    body: { content: JSON.stringify({ image_key: 'img_previous' }) },
                  },
                ],
              },
            };
          },
        },
        messageResource: {
          get: async ({ path: requestPath }: any) => {
            assert.equal(requestPath.message_id, 'om_image');
            assert.equal(requestPath.file_key, 'img_previous');
            return {
              getReadableStream: () => Readable.from([Buffer.from('previous-image')]),
            };
          },
        },
      },
    };

    await adapter.pollSingleP2pChat({
      chatId: 'oc_p2p',
      chatType: 'p2p',
      displayName: 'private chat',
      lastMessageAt: '1000',
      updatedAt: '1000',
    });

    const inbound = await adapter.consumeOne();

    assert.ok(inbound);
    assert.equal(inbound.text, '一步一步分析给我解题思路');
    assert.equal(inbound.attachments?.length, 1);
    assert.equal(inbound.attachments?.[0]?.name, 'img_previous.png');
    assert.equal(inbound.raw?.feishuReplyTo?.messageId, 'om_image');
    assert.equal(inbound.raw?.feishuReplyTo?.attachmentCount, 1);
  });

  it('skips history-polled p2p messages sent by the bot identity even when sender_type is missing', async () => {
    const adapter = new FeishuAdapter() as any;

    adapter.running = true;
    adapter.botIds.add('ou_bot');
    adapter.resolveChatDisplayName = async () => 'private chat';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.fetchMessagePage = async () => ({
      items: [
        {
          message_id: 'om_bot_reply',
          chat_id: 'oc_p2p',
          create_time: '2000',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'The user sent one or more images without a written instruction.' }) },
          sender: { id: 'ou_bot', id_type: 'open_id' },
        },
      ],
      hasMore: false,
      nextPageToken: '',
    });

    await adapter.pollSingleP2pChat({
      chatId: 'oc_p2p',
      chatType: 'p2p',
      displayName: 'private chat',
      lastMessageAt: '1000',
      updatedAt: '1000',
    });

    assert.equal(adapter.queue.length, 0);
  });
});

describe('FeishuAdapter message reactions', () => {
  beforeEach(() => {
    useTempCtiHome();
    setupContext();
  });

  it('does not turn a bare sticker hint into an arbitrary unannotated Feishu sticker message', async () => {
    fs.mkdirSync(path.join(process.env.CTI_HOME!, 'data'), { recursive: true });
    fs.writeFileSync(path.join(process.env.CTI_HOME!, 'data', 'feishu-stickers.json'), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [{
        fileKey: 'sticker_file_key',
        aliases: ['最近', '默认', '表情包'],
        chatId: 'oc_group',
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        useCount: 0,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(`reply:${JSON.stringify(payload)}`);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[表情包] 收到~',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0], /"msg_type":"sticker"/);
    assert.match(calls[0], /\\"text\\":\\"收到~\\"/);
  });

  it('falls back to readable text for unresolved sticker-only plain replies', async () => {
    fs.mkdirSync(path.join(process.env.CTI_HOME!, 'data'), { recursive: true });
    fs.writeFileSync(path.join(process.env.CTI_HOME!, 'data', 'feishu-stickers.json'), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [{
        fileKey: 'sticker_file_key',
        aliases: ['最近', '默认', '表情包'],
        chatId: 'oc_group',
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        useCount: 0,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(`reply:${JSON.stringify(payload)}`);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[表情包]\n✅',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0], /"msg_type":"sticker"/);
    assert.doesNotMatch(calls[0], /\\"text\\":\\"✅\\"/);
  });

  it('does not let bare sticker hints prefer a newer unannotated sticker over a learned one', async () => {
    fs.mkdirSync(path.join(process.env.CTI_HOME!, 'data'), { recursive: true });
    fs.writeFileSync(path.join(process.env.CTI_HOME!, 'data', 'feishu-stickers.json'), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [
        {
          fileKey: 'unannotated_recent',
          aliases: ['最近', '默认', '表情包'],
          chatId: 'oc_group',
          firstSeenAt: '2026-06-05T00:00:00.000Z',
          lastSeenAt: '2026-06-05T00:02:00.000Z',
          useCount: 0,
        },
        {
          fileKey: 'learned_sticker',
          aliases: ['干嘛猫'],
          label: '干嘛猫',
          intent: '表达疑惑',
          usage: '别人突然丢奇怪需求时使用',
          chatId: 'oc_group',
          firstSeenAt: '2026-06-05T00:00:00.000Z',
          lastSeenAt: '2026-06-05T00:01:00.000Z',
          useCount: 0,
        },
      ],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(`reply:${JSON.stringify(payload)}`);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[表情包] 这需求有点突然',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.equal(result.ok, true);
    assert.match(calls[0], /\\"file_key\\":\\"learned_sticker\\"/);
    assert.doesNotMatch(calls[0], /unannotated_recent/);
  });

  it('does not send an arbitrary sticker for unknown sticker aliases in plain replies', async () => {
    fs.mkdirSync(path.join(process.env.CTI_HOME!, 'data'), { recursive: true });
    fs.writeFileSync(path.join(process.env.CTI_HOME!, 'data', 'feishu-stickers.json'), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [{
        fileKey: 'sticker_known_only',
        aliases: ['最近', '默认', '表情包'],
        chatId: 'oc_group',
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        useCount: 9,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(`reply:${JSON.stringify(payload)}`);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[表情包:大笑] 换一个~',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0], /"msg_type":"sticker"/);
    assert.match(calls[0], /\\"text\\":\\"换一个~\\"/);
    assert.doesNotMatch(calls[0], /\[表情包:大笑\]/);
  });

  it('turns a leading bracketed Feishu emoji hint into a message reaction and strips it from text', async () => {
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      im: {
        messageReaction: {
          create: async (payload: unknown) => {
            calls.push(`reaction:${JSON.stringify(payload)}`);
            return { data: { reaction_id: 'react_1' } };
          },
        },
        message: {
          reply: async (payload: unknown) => {
            calls.push(`reply:${JSON.stringify(payload)}`);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[牛] 收到~',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'om_reply');
    assert.match(calls[0], /"emoji_type":"BULL"/);
    assert.match(calls[1], /\\"text\\":\\"收到~\\"/);
    assert.doesNotMatch(calls[1], /\[牛\]/);
  });

  it('resolves data-driven Feishu emoji aliases and records outbound profile usage', async () => {
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      im: {
        messageReaction: {
          create: async (payload: unknown) => {
            calls.push(`reaction:${JSON.stringify(payload)}`);
            return { data: { reaction_id: 'react_1' } };
          },
        },
        message: {
          reply: async (payload: unknown) => {
            calls.push(`reply:${JSON.stringify(payload)}`);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[火] 这个方案可以',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.equal(result.ok, true);
    assert.match(calls[0], /"emoji_type":"FIRE"/);
    assert.match(calls[1], /\\"text\\":\\"这个方案可以\\"/);

    const profile = JSON.parse(fs.readFileSync(path.join(process.env.CTI_HOME!, 'data', 'feishu-emoji-profile.json'), 'utf8'));
    assert.equal(profile.emojis[0].emojiType, 'FIRE');
    assert.equal(profile.emojis[0].chatId, 'oc_group');
    assert.equal(profile.emojis[0].userId, 'ou_user');
    assert.equal(profile.emojis[0].outboundSuccessCount, 1);
  });

  it('learns inbound Feishu reaction events without routing a chat message', async () => {
    const adapter = new FeishuAdapter() as any;

    adapter.handleReactionCreatedEvent({
      event: {
        message: { chat_id: 'oc_group' },
        operator: { operator_id: { open_id: 'ou_user' } },
        reaction: { reaction_type: { emoji_type: 'THUMBSUP' } },
      },
    });

    const profile = JSON.parse(fs.readFileSync(path.join(process.env.CTI_HOME!, 'data', 'feishu-emoji-profile.json'), 'utf8'));
    assert.equal(profile.emojis[0].emojiType, 'THUMBSUP');
    assert.equal(profile.emojis[0].chatId, 'oc_group');
    assert.equal(profile.emojis[0].userId, 'ou_user');
    assert.equal(profile.emojis[0].inboundCount, 1);
    assert.equal(await adapter.consumeOne(), null);
  });

  it('builds reaction presentation prompt without defaulting to smile', () => {
    const adapter = new FeishuAdapter() as any;

    const prompt = adapter.getEmojiPresentationPrompt('oc_group', 'ou_user');

    assert.match(prompt, /Do not default to SMILE/);
    assert.match(prompt, /Choose reaction hints by actual intent/);
    assert.doesNotMatch(prompt, /Catalog examples:.*\[微笑/s);
  });

  it('does not let SMILE dominate learned reaction preferences from outbound counts', () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(path.join(ctiHome, 'data', 'feishu-emoji-profile.json'), JSON.stringify({
      version: 1,
      updatedAt: '2026-06-06T08:00:00.000Z',
      emojis: [
        {
          emojiType: 'SMILE',
          aliases: ['微笑'],
          chatId: 'oc_group',
          userId: 'ou_user',
          firstSeenAt: '2026-06-06T01:00:00.000Z',
          lastSeenAt: '2026-06-06T08:00:00.000Z',
          inboundCount: 0,
          outboundSuccessCount: 99,
          outboundFailureCount: 0,
        },
        {
          emojiType: 'THUMBSUP',
          aliases: ['赞'],
          chatId: 'oc_group',
          userId: 'ou_user',
          firstSeenAt: '2026-06-06T02:00:00.000Z',
          lastSeenAt: '2026-06-06T07:00:00.000Z',
          inboundCount: 2,
          outboundSuccessCount: 1,
          outboundFailureCount: 0,
        },
      ],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;

    const prompt = adapter.getEmojiPresentationPrompt('oc_group', 'ou_user');
    const learnedLine = prompt.split('\n').find((line: string) => line.includes('Learned preferences')) || '';

    assert.match(prompt, /THUMBSUP/);
    assert.doesNotMatch(learnedLine, /SMILE/);
  });

  it('strips a Markdown Feishu emoji hint and uses visible emoji fallback when reaction fails', async () => {
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      im: {
        messageReaction: {
          create: async () => {
            calls.push('reaction');
            throw new Error('reaction type is invalid');
          },
        },
        message: {
          reply: async (payload: unknown) => {
            calls.push(`reply:${JSON.stringify(payload)}`);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[微笑] **收到**',
      parseMode: 'Markdown',
      replyToMessageId: 'om_user',
    });

    assert.equal(result.ok, true);
    assert.equal(calls[0], 'reaction');
    assert.match(calls[1], new RegExp('\\u{1F642}', 'u'));
    assert.match(calls[1], /收到/);
    assert.doesNotMatch(calls[1], /\[微笑\]/);
  });

  it('falls back to visible text when a requested Feishu reaction cannot be added', async () => {
    const adapter = new FeishuAdapter() as any;
    const calls: string[] = [];

    adapter.restClient = {
      im: {
        messageReaction: {
          create: async () => {
            calls.push('reaction');
            throw new Error('reaction type is invalid');
          },
        },
        message: {
          reply: async (payload: unknown) => {
            calls.push(`reply:${JSON.stringify(payload)}`);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[UNKNOWN_EMOJI] 收到~',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.equal(result.ok, true);
    assert.equal(calls[0], 'reaction');
    assert.match(calls[1], /\[UNKNOWN_EMOJI\] 收到~/);
  });
});
