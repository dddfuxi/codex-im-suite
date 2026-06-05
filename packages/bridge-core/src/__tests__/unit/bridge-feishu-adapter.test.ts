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

  it('turns a final card sticker hint into a real sticker message and removes it from the card body', async () => {
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
    assert.ok(calls.some((item) => /"msg_type":"sticker"/.test(item)));
    assert.ok(calls.some((item) => /\\"file_key\\":\\"sticker_file_key\\"/.test(item)));
    const cardUpdate = calls.find((item) => item.startsWith('card.update:')) || '';
    assert.match(cardUpdate, /收到~/);
    assert.doesNotMatch(cardUpdate, /\[表情包\]/);
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
});

describe('FeishuAdapter message reactions', () => {
  beforeEach(() => {
    useTempCtiHome();
    setupContext();
  });

  it('turns a sticker hint into a real Feishu sticker message', async () => {
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
    assert.match(calls[0], /"msg_type":"sticker"/);
    assert.match(calls[0], /\\"file_key\\":\\"sticker_file_key\\"/);
    assert.match(calls[1], /\\"text\\":\\"收到~\\"/);
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
