import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { initBridgeContext } from '../../lib/bridge/context.js';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter.js';
import type { BridgeStore, StickerSemanticEvolutionHost } from '../../lib/bridge/host.js';
import { MemoryArtifactStore } from '../../lib/bridge/memory-artifact-store.js';

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

function setupContext(settings: Record<string, string> = {}, stickerSemantics?: StickerSemanticEvolutionHost) {
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  initBridgeContext({
    store: createMockStore(settings) as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
    stickerSemantics,
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

function createFeishuInteractiveEvent(messageId: string, content: unknown) {
  return {
    sender: {
      sender_type: 'app',
      sender_id: { open_id: 'ou_other_bot', app_id: 'cli_other_bot' },
    },
    message: {
      message_id: messageId,
      chat_id: 'oc_group',
      chat_type: 'group',
      message_type: 'interactive',
      content: JSON.stringify(content),
      create_time: String(Date.now()),
    },
  };
}

function useTempCtiHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-test-'));
  process.env.CTI_HOME = dir;
  process.env.CTI_MEMORY_REPO_DIR = path.join(dir, 'memory-repo');
  fs.mkdirSync(path.join(dir, 'memory-repo', 'data', 'im', 'feishu', 'stickers'), { recursive: true });
  return dir;
}

function getTestFeishuStickerStorePath(ctiHome = process.env.CTI_HOME!): string {
  return path.join(ctiHome, 'memory-repo', 'data', 'im', 'feishu', 'stickers', 'stickers.json');
}

function writeTestStickerMedia(fileKey: string, data: Buffer): string {
  const mediaDir = path.join(process.env.CTI_MEMORY_REPO_DIR!, 'data', 'im', 'feishu', 'stickers', 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const mediaPath = path.join(mediaDir, MemoryArtifactStore.stableFileName(fileKey, '.png'));
  fs.writeFileSync(mediaPath, data);
  return mediaPath;
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

describe('FeishuAdapter deferred agent preparation', () => {
  beforeEach(() => {
    setupContext({ bridge_feishu_require_mention: 'false' });
  });

  it('drops platform recalled-message placeholders before they enter the bridge queue', async () => {
    const auditLogs: Array<{ summary?: string; messageId?: string }> = [];
    const store = createMockStore({ bridge_feishu_require_mention: 'false' }) as any;
    store.insertAuditLog = (entry: { summary?: string; messageId?: string }) => auditLogs.push(entry);
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new FeishuAdapter() as any;
    const queued: any[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);

    await adapter.processIncomingEvent(createFeishuTextEvent('om_recalled_placeholder', '此消息已撤回'));

    assert.equal(queued.length, 0);
    assert.ok(auditLogs.some((entry) =>
      entry.messageId === 'om_recalled_placeholder'
      && /\[FILTERED\].*撤回/.test(entry.summary || '')
    ));
  });

  it('turns a Feishu recall event into lifecycle control and removes the still-queued original message', async () => {
    const adapter = new FeishuAdapter() as any;

    await adapter.processIncomingEvent(createFeishuTextEvent('om_queued_before_recall', '帮我处理一个排队任务'));
    await adapter.handleMessageRecalledEvent({
      event: {
        message_id: 'om_queued_before_recall',
        chat_id: 'oc_group',
      },
    });

    const control = await adapter.consumeOne();

    assert.ok(control);
    assert.equal(control.messageId, 'om_queued_before_recall:recalled');
    assert.equal(control.raw?.bridgeControl?.type, 'message_withdrawn');
    assert.equal(control.raw?.bridgeControl?.targetMessageId, 'om_queued_before_recall');
    assert.equal(control.raw?.bridgeControl?.notifyIfUnknown, true);

    const leftover = await adapter.consumeOne();
    assert.equal(leftover, null);
  });

  it('discards queued inbound work when the adapter stops', async () => {
    const adapter = new FeishuAdapter() as any;
    adapter.running = true;
    adapter.inboundQueue.enqueue({
      messageId: 'om_queued_before_stop',
      address: { channelType: 'feishu', chatId: 'oc_group' },
      text: 'queued before stop',
      timestamp: new Date('2026-07-21T00:00:00.000Z'),
    });

    await adapter.stop();

    assert.equal(await adapter.consumeOne(), null);
  });

  it('submits a native reply as sticker feedback only when runtime finds the referenced delivery', async () => {
    const processed: any[] = [];
    setupContext({ bridge_feishu_require_mention: 'false' }, {
      authorizeSelection: async () => null,
      recordDelivery: async () => {},
      findDeliveriesByOutboundMessageIds: async (ids) => ids.includes('om_sticker_delivery') ? [{
        schema: 'codex-im-suite/sticker-delivery-evidence/v1',
        deliveryId: 'delivery-1',
        channelType: 'feishu',
        chatId: 'oc_p2p',
        fileKey: 'sticker-key',
        outboundMessageId: 'om_sticker_delivery',
        semanticRevisionId: 'revision-1',
        contextHash: 'a'.repeat(64),
        sessionId: 'session-1',
        sentAt: '2026-07-20T00:00:00.000Z',
      }] : [],
      processFeedback: async (candidate) => {
        processed.push(candidate);
        return { status: 'revision_created', revisionId: 'revision-2' };
      },
      buildExpressionPromptSection: async () => null,
    });
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};

    await adapter.processIncomingEvent({
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
      message: {
        message_id: 'om_feedback',
        parent_id: 'om_sticker_delivery',
        chat_id: 'oc_p2p',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '这个不适合严肃通知' }),
        create_time: '1784515260000',
      },
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    await inbound.prepareForAgent?.();
    assert.equal(processed.length, 1);
    assert.equal(processed[0].referencedOutboundMessageId, 'om_sticker_delivery');
    assert.equal((inbound.raw as any).feishuStickerFeedback.status, 'revision_created');
  });

  it('enqueues accepted text before slow chat and history evidence is prepared', async () => {
    const adapter = new FeishuAdapter() as any;
    let resolveDisplayName!: (value: string) => void;
    const displayName = new Promise<string>((resolve) => {
      resolveDisplayName = resolve;
    });
    adapter.resolveChatDisplayName = async () => displayName;
    adapter.persistChatIndex = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.buildLightConversationContext = async () => ({
      prompt: 'recent context',
      messageCount: 1,
    });
    adapter.ensureStickerHistoryBackfilledForRequest = async () => {};
    adapter.buildStickerLibraryEvidenceForRequest = async () => null;
    const queued: any[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);

    const processing = adapter.processIncomingEvent(
      createFeishuTextEvent('om_deferred_prepare', '请结合最近群聊回答这个问题'),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      assert.equal(queued.length, 1, 'accepted message must be queued before network evidence completes');
      assert.equal(typeof queued[0].prepareForAgent, 'function');

      let preparationCompleted = false;
      const preparation = queued[0].prepareForAgent().then(() => {
        preparationCompleted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(preparationCompleted, false);

      resolveDisplayName('性能验收群');
      await preparation;
      assert.equal(queued[0].address.displayName, '性能验收群');
      assert.equal(queued[0].raw.feishuConversationContext.prompt, 'recent context');
      await processing;
    } finally {
      resolveDisplayName('性能验收群');
      await processing;
    }
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

  it('detects bot mention from interactive card markdown when mentions array is missing', () => {
    const adapter = new FeishuAdapter() as any;
    adapter.botIds.add('ou_bot');

    const mentioned = adapter.isBotMentionedFromMessage({
      content: JSON.stringify({
        schema: '2.0',
        body: {
          elements: [
            { tag: 'markdown', content: '<at id="ou_bot"></at> 帮我看一下' },
          ],
        },
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
  it('drops actionable text aliases when the current bot is not natively mentioned', async () => {
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

    assert.equal(queued.length, 0);
    assert.ok(auditLogs.some((entry) => entry.summary?.includes('bot not @mentioned')));
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
    assert.ok(auditLogs.some((entry) => entry.summary?.includes('bot not @mentioned')));
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

  it('allows native bot instructions that describe what to do when other people reply', async () => {
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
    adapter.botIds.add('ou_bot');
    const queued: unknown[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);
    const event = createFeishuTextEvent(
      'om_native_bot_host_rule',
      '@_user_1 你作为主持人，当别人回复你的时候你应该艾特对方再说答案。并且严格遵守规则，只能说是、不是',
    ) as any;
    event.message.mentions = [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小虾米' },
    ];

    await adapter.processIncomingEvent(event);

    assert.equal(queued.length, 1);
    assert.match((queued[0] as any).text, /当别人回复你的时候/);
  });

  it('does not let negative wording in separate rule items suppress a native mention command', async () => {
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
    adapter.botIds.add('ou_bot');
    const queued: unknown[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);
    const event = createFeishuTextEvent(
      'om_native_bot_long_skill_rule',
      [
        '## 回复规范',
        '- 简单判断用纯文本，别套卡片刷屏',
        '- 每次回复只针对当前问题，不扩展、不引申',
        '- 主持人只回应被 @ 的提问，未被 @ 的群聊消息默认忽略',
        '@_user_1 记录成skill',
      ].join('\n'),
    ) as any;
    event.message.mentions = [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小虾米' },
    ];

    await adapter.processIncomingEvent(event);

    assert.equal(queued.length, 1);
    assert.match((queued[0] as any).text, /记录成skill/);
  });

  it('keeps native mention rules actionable when separate markdown items contain negative and reply words', async () => {
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
    adapter.botIds.add('ou_bot');
    const queued: unknown[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);
    const event = createFeishuTextEvent(
      'om_native_bot_markdown_boundaries',
      [
        '@_user_1 请采用下面的主持规则',
        '- 别套卡片刷屏',
        '- 每次回复只针对当前问题',
      ].join('\n'),
    ) as any;
    event.message.mentions = [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小虾米' },
    ];

    await adapter.processIncomingEvent(event);

    assert.equal(queued.length, 1);
    assert.match((queued[0] as any).text, /主持规则/);
  });

  it('still drops native bot mentions that explicitly ask the bot not to reply', async () => {
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
    adapter.botIds.add('ou_bot');
    const queued: unknown[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);
    const event = createFeishuTextEvent('om_native_bot_do_not_reply', '@_user_1 先别回复，这条不用处理') as any;
    event.message.mentions = [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小虾米' },
    ];

    await adapter.processIncomingEvent(event);

    assert.equal(queued.length, 0);
  });

  it('turns a mention-only topic reply into an implicit request for the replied root message', async () => {
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
    adapter.botIds.add('ou_bot');
    adapter.resolveChatDisplayName = async () => '项目群';
    adapter.persistChatIndex = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    const lightContextInput: { current?: { replyTargetMessageId?: string; userText?: string } } = {};
    adapter.buildLightConversationContext = async (
      _chatId: string,
      _messageId: string,
      replyTargetMessageId: string | null,
      userText: string,
    ) => {
      lightContextInput.current = { replyTargetMessageId: replyTargetMessageId || undefined, userText };
      return { prompt: '话题根消息：优化回复格式' };
    };
    const queued: any[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);
    const event = createFeishuTextEvent('om_topic_mention_only', '@_user_1') as any;
    event.message.root_id = 'om_topic_root';
    event.message.thread_id = 'omt_topic';
    event.message.mentions = [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小虾米' },
    ];

    await adapter.processIncomingEvent(event);

    assert.equal(queued.length, 1);
    assert.match(queued[0].text, /原生回复|话题/);
    assert.equal(queued[0].raw?.feishuReplyTo?.messageId, 'om_topic_root');
    assert.equal(queued[0].raw?.feishuImplicitReplyMention?.reason, 'native_mention_only_reply');
    await queued[0].prepareForAgent();
    assert.equal(lightContextInput.current?.replyTargetMessageId, 'om_topic_root');
    assert.match(lightContextInput.current?.userText || '', /原生回复|话题/);
    assert.equal(queued[0].raw?.feishuConversationContext?.prompt, '话题根消息：优化回复格式');
  });

  it('keeps a mention-only group message without a reply target silent', async () => {
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
    adapter.botIds.add('ou_bot');
    const queued: unknown[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);
    const event = createFeishuTextEvent('om_plain_mention_only', '@_user_1') as any;
    event.message.mentions = [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小虾米' },
    ];

    await adapter.processIncomingEvent(event);

    assert.equal(queued.length, 0);
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
    assert.ok(auditLogs.some((entry) => entry.summary?.includes('bot not @mentioned')));
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

  it('allows actionable interactive cards from another Feishu bot when they mention the current bot', async () => {
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
    const event = createFeishuInteractiveEvent('om_bot_card_mention', {
      schema: '2.0',
      body: {
        elements: [
          {
            tag: 'markdown',
            content: '<at id="ou_current_bot"></at> 跟乔治说句话，尽量发普通文本，别发卡片。',
          },
          { tag: 'markdown', content: '已完成 · 3.4s' },
        ],
      },
    });

    await adapter.processIncomingEvent(event);

    assert.equal(queued.length, 1);
    assert.equal((queued[0] as any).text, '跟乔治说句话，尽量发普通文本，别发卡片。 已完成 · 3.4s');
    assert.equal((queued[0] as any).raw?.feishuSender?.senderType, 'app');
    assert.equal((queued[0] as any).raw?.feishuBotToBot?.senderType, 'app');
  });

  it('passes interactive card image resources to the agent when Feishu only returns an upgrade placeholder', async () => {
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
    adapter.restClient = {
      im: {
        messageResource: {
          get: async () => ({
            getReadableStream: () => Readable.from([Buffer.from('card-image')]),
          }),
        },
      },
    };
    const queued: unknown[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);
    const event = createFeishuInteractiveEvent('om_bot_card_image', {
      title: null,
      elements: [[
        { tag: 'img', image_key: 'img_card_preview' },
        { tag: 'text', text: '请升级至最新版本客户端，以查看内容' },
      ]],
    }) as any;
    event.message.mentions = [
      { key: '@_user_1', id: { open_id: 'ou_current_bot' }, name: '小虾米' },
    ];

    await adapter.processIncomingEvent(event);

    assert.equal(queued.length, 1);
    assert.doesNotMatch((queued[0] as any).text, /请升级/);
    assert.match((queued[0] as any).text, /卡片正文未随事件返回/);
    assert.equal((queued[0] as any).attachments?.length, 1);
    assert.equal((queued[0] as any).attachments?.[0]?.name, 'img_card_preview.png');
    assert.deepEqual((queued[0] as any).raw?.feishuInteractiveCard?.imageKeys, ['img_card_preview']);
    assert.equal((queued[0] as any).raw?.feishuInteractiveCard?.downloadedAttachmentCount, 1);
  });

  it('keeps a readable card boundary when interactive card image resources cannot be downloaded', async () => {
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
    adapter.restClient = {
      im: {
        messageResource: {
          get: async () => {
            throw new Error('resource not available');
          },
        },
      },
    };
    const queued: unknown[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);
    const event = createFeishuInteractiveEvent('om_bot_card_image_failed', {
      title: null,
      elements: [[
        { tag: 'img', image_key: 'img_card_preview' },
        { tag: 'text', text: '请升级至最新版本客户端，以查看内容' },
      ]],
    }) as any;
    event.message.mentions = [
      { key: '@_user_1', id: { open_id: 'ou_current_bot' }, name: '小虾米' },
    ];

    await adapter.processIncomingEvent(event);

    assert.equal(queued.length, 1);
    assert.doesNotMatch((queued[0] as any).text, /请升级/);
    assert.match((queued[0] as any).text, /卡片正文未随事件返回/);
    assert.match((queued[0] as any).text, /图片资源暂时下载失败/);
    assert.equal((queued[0] as any).attachments?.length ?? 0, 0);
    assert.deepEqual((queued[0] as any).raw?.feishuInteractiveCard?.imageKeys, ['img_card_preview']);
    assert.equal((queued[0] as any).raw?.feishuInteractiveCard?.downloadedAttachmentCount, 0);
  });

  it('records Feishu resource API errors when another app card image cannot be downloaded', async () => {
    setupContext({
      bridge_feishu_require_mention: 'true',
      bridge_feishu_bot_aliases: '小虾米',
      bridge_feishu_app_id: 'cli_current_bot',
      bridge_feishu_app_secret: 'secret',
    });
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
      if (text.includes('/open-apis/im/v1/messages/om_bot_card_cross_app/resources/img_cross_app_preview')) {
        return new Response(JSON.stringify({ code: 14005, msg: 'Resource Has Been Deleted' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (text.includes('/open-apis/im/v1/images/img_cross_app_preview')) {
        return new Response(JSON.stringify({ code: 234008, msg: 'The app is not the resource sender.' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ code: 404, msg: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const adapter = new FeishuAdapter() as any;
      adapter.botIds.add('ou_current_bot');
      adapter.resolveChatDisplayName = async () => '群聊';
      adapter.persistChatIndex = () => {};
      adapter.syncIndexedChatHistory = async () => {};
      adapter.restClient = {
        im: {
          messageResource: {
            get: async () => {
              const error: Record<string, unknown> = {
                code: 14005,
                msg: 'Resource Has Been Deleted',
              };
              error.self = error;
              throw error;
            },
          },
        },
      };
      const queued: unknown[] = [];
      adapter.enqueue = (message: unknown) => queued.push(message);
      const event = createFeishuInteractiveEvent('om_bot_card_cross_app', {
        elements: [[
          { tag: 'img', image_key: 'img_cross_app_preview' },
          { tag: 'text', text: '请升级至最新版本客户端，以查看内容' },
        ]],
      }) as any;
      event.message.mentions = [
        { key: '@_user_1', id: { open_id: 'ou_current_bot' }, name: '小虾米' },
      ];

      await adapter.processIncomingEvent(event);

      assert.equal(queued.length, 1);
      assert.match((queued[0] as any).text, /卡片正文未随事件返回/);
      assert.match((queued[0] as any).text, /图片资源暂时下载失败/);
      assert.doesNotMatch((queued[0] as any).text, /Resource Has Been Deleted/);
      assert.doesNotMatch((queued[0] as any).text, /The app is not the resource sender/);
      assert.equal((queued[0] as any).attachments?.length ?? 0, 0);
      assert.ok(calledUrls.some((item) => item.includes('/messages/om_bot_card_cross_app/resources/img_cross_app_preview')));
      assert.ok(calledUrls.some((item) => item.includes('/images/img_cross_app_preview')));
      const failures = (queued[0] as any).raw?.feishuInteractiveCard?.resourceDownloadFailures;
      assert.equal(failures?.[0]?.code, 14005);
      assert.equal(failures?.[0]?.msg, 'Resource Has Been Deleted');
      assert.equal(failures?.[1]?.code, 234008);
      assert.equal(failures?.[1]?.msg, 'The app is not the resource sender.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('parses escaped interactive body content before building the agent evidence', async () => {
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
    adapter.resolveChatDisplayName = async () => '群聊';
    adapter.persistChatIndex = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.restClient = {
      im: {
        messageResource: {
          get: async () => {
            throw new Error('resource not available');
          },
        },
      },
    };
    const queued: unknown[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);
    const nestedCard = {
      title: '表情回复',
      elements: [[
        { tag: 'markdown', content: '真正正文：请三个机器人各回一句确认。' },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '查看详情' },
          value: { trace: 'not user visible' },
        },
        { tag: 'img', image_key: 'img_nested_preview', alt: { tag: 'plain_text', content: '图片说明：疑惑表情' } },
        { tag: 'text', text: '请升级至最新版本客户端，以查看内容' },
      ]],
      summary: { content: '机器人确认请求' },
    };
    const event = createFeishuInteractiveEvent('om_bot_card_nested_body', {
      body: {
        content: JSON.stringify(nestedCard),
      },
    }) as any;
    event.message.mentions = [
      { key: '@_user_1', id: { open_id: 'ou_current_bot' }, name: '小虾米' },
    ];

    await adapter.processIncomingEvent(event);

    assert.equal(queued.length, 1);
    assert.match((queued[0] as any).text, /表情回复/);
    assert.match((queued[0] as any).text, /真正正文：请三个机器人各回一句确认/);
    assert.match((queued[0] as any).text, /查看详情/);
    assert.match((queued[0] as any).text, /机器人确认请求/);
    assert.match((queued[0] as any).text, /图片说明：疑惑表情/);
    assert.doesNotMatch((queued[0] as any).text, /\{\"title\"/);
    assert.doesNotMatch((queued[0] as any).text, /请升级/);
    assert.deepEqual((queued[0] as any).raw?.feishuInteractiveCard?.imageKeys, ['img_nested_preview']);
    assert.match((queued[0] as any).raw?.feishuInteractiveCard?.visibleText, /真正正文/);
    assert.match((queued[0] as any).raw?.feishuInteractiveCard?.rawPreview, /body/);
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
            avatar_url: 'https://avatar.example.com/current-bot.png',
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
      assert.equal(adapter.getAssistantIdentity().avatarUrl, 'https://avatar.example.com/current-bot.png');
      assert.ok(calls.some((item) => item.includes('/bot/v3/info')));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('FeishuAdapter avatar evidence', () => {
  beforeEach(() => {
    setupContext({
      bridge_feishu_require_mention: 'false',
      bridge_feishu_app_id: 'cli_current_bot',
      bridge_feishu_app_secret: 'secret',
    });
    // 单元测试隔离真实 DNS；生产实现仍默认解析并拒绝私网地址。
    (FeishuAdapter.prototype as any).resolveAvatarHostAddresses = async () => ['93.184.216.34'];
  });

  it('attaches official user and bot avatars with stable display-name mapping', async () => {
    const originalFetch = globalThis.fetch;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
            users: [{ member_id: 'ou_user', member_id_type: 'open_id', name: '刘丹' }],
            bots: [{ member_id: 'ou_other_bot', member_id_type: 'open_id', name: '乔治', app_id: 'cli_george' }],
            has_more: false,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (text.includes('/open-apis/contact/v3/users/ou_user')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { user: { avatar: { avatar_240: 'https://avatar.example.com/liudan.png' } } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (text.includes('/open-apis/application/v6/applications/cli_george')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { app: { avatar_url: 'https://avatar.example.com/george.png' } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (text.startsWith('https://avatar.example.com/')) {
        return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return new Response(JSON.stringify({ code: 404, msg: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const adapter = new FeishuAdapter() as any;
      adapter.resolveChatDisplayName = async () => '头像测试群';
      adapter.persistChatIndex = () => {};
      adapter.syncIndexedChatHistory = async () => {};
      adapter.buildLightConversationContext = async () => null;
      adapter.ensureStickerHistoryBackfilledForRequest = async () => {};
      adapter.buildStickerLibraryEvidenceForRequest = async () => null;
      const queued: any[] = [];
      adapter.enqueue = (message: unknown) => queued.push(message);

      await adapter.processIncomingEvent(createFeishuTextEvent('om_avatar_request', '查看群里成员和机器人的头像并分别描述'));
      assert.equal(queued.length, 1);
      await queued[0].prepareForAgent();

      const attachmentNames = queued[0].attachments.map((item: { name: string }) => item.name);
      assert.match(attachmentNames[0], /^飞书头像-用户-刘丹-[a-f0-9]{8}\.png$/u);
      assert.match(attachmentNames[1], /^飞书头像-机器人-乔治-[a-f0-9]{8}\.png$/u);
      const evidence = queued[0].raw.feishuAvatarEvidence;
      assert.equal(evidence.successfulCount, 2);
      assert.equal(evidence.failedCount, 0);
      assert.deepEqual(
        evidence.items.map((item: any) => ({ name: item.displayName, type: item.actorType, attachmentName: item.attachmentName })),
        [
          { name: '刘丹', type: 'user', attachmentName: attachmentNames[0] },
          { name: '乔治', type: 'bot', attachmentName: attachmentNames[1] },
        ],
      );
      assert.match(evidence.prompt, new RegExp(`刘丹.*${attachmentNames[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'));
      assert.match(evidence.prompt, new RegExp(`乔治.*${attachmentNames[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps successful bot avatars when user avatar scope is missing and forbids user OAuth fallback', async () => {
    const originalFetch = globalThis.fetch;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
            users: [{ member_id: 'ou_user', member_id_type: 'open_id', name: '刘丹' }],
            bots: [{ member_id: 'ou_other_bot', member_id_type: 'open_id', name: '乔治', app_id: 'cli_george' }],
            has_more: false,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (text.includes('/open-apis/contact/v3/users/ou_user')) {
        return new Response(JSON.stringify({
          code: 99991672,
          msg: 'Access denied. One of the following scopes is required: contact:contact.base:readonly',
        }), { status: 403, headers: { 'content-type': 'application/json' } });
      }
      if (text.includes('/open-apis/application/v6/applications/cli_george')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { app: { avatar_url: 'https://avatar.example.com/george.png' } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (text === 'https://avatar.example.com/george.png') {
        return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return new Response(JSON.stringify({ code: 404, msg: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const adapter = new FeishuAdapter() as any;
      const result = await adapter.buildAvatarEvidenceForRequest('oc_group', '查看群成员头像');

      assert.equal(result.attachments.length, 1);
      assert.equal(result.context.successfulCount, 1);
      assert.equal(result.context.failedCount, 1);
      assert.equal(result.context.items[0].displayName, '刘丹');
      assert.equal(result.context.items[0].status, 'blocked');
      assert.equal(result.context.items[0].reasonCode, 'missing_app_scope');
      assert.equal(result.context.items[0].userOAuthRequired, false);
      assert.ok(result.context.items[0].missingScopes.includes('contact:user.base:readonly'));
      assert.match(result.context.items[0].consoleUrl, /open\.feishu\.cn\/page\/scope-apply/);
      assert.match(decodeURIComponent(result.context.items[0].consoleUrl), /contact:user\.base:readonly/);
      assert.match(result.context.prompt, /不要向普通用户申请 user OAuth/u);
      assert.equal(result.context.items[1].displayName, '乔治');
      assert.equal(result.context.items[1].status, 'attached');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects an avatar download that redirects from an official URL to a private target', async () => {
    const originalFetch = globalThis.fetch;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    globalThis.fetch = (async () => {
      const response = new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
      Object.defineProperty(response, 'url', { value: 'https://127.0.0.1/private-avatar.png' });
      return response;
    }) as typeof fetch;

    try {
      const adapter = new FeishuAdapter() as any;
      await assert.rejects(
        adapter.downloadAvatarAttachment({
          actorType: 'user',
          displayName: '刘丹',
          platformId: 'ou_user',
        }, 'https://avatar.example.com/liudan.png'),
        /重定向|公网域名/u,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('validates every avatar redirect before issuing the next request', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let redirectMode = '';
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      redirectMode = String(init?.redirect || '');
      return new Response(null, {
        status: 302,
        headers: { location: 'https://127.0.0.1/private-avatar.png' },
      });
    }) as typeof fetch;

    try {
      const adapter = new FeishuAdapter() as any;
      await assert.rejects(
        adapter.downloadAvatarAttachment({ actorType: 'user', displayName: '刘丹', platformId: 'ou_user' }, 'https://avatar.example.com/liudan.png'),
        /重定向|公网域名/u,
      );
      assert.equal(redirectMode, 'manual');
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects avatar hosts that resolve to private, mapped-private, or non-public reserved addresses', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    try {
      const adapter = new FeishuAdapter() as any;
      for (const address of ['10.0.0.8', '::ffff:c0a8:101', '203.0.113.7']) {
        adapter.resolveAvatarHostAddresses = async () => [address];
        await assert.rejects(
          adapter.downloadAvatarAttachment({ actorType: 'user', displayName: '刘丹', platformId: 'ou_user' }, 'https://avatar.example.com/liudan.png'),
          /DNS|私网|公网/u,
        );
      }
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('passes the validated DNS addresses into the dispatcher used by the actual avatar fetch', async () => {
    const originalFetch = globalThis.fetch;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dispatcher = { dispatch: () => true };
    let dispatcherSeen: unknown;
    let pinnedAddresses: string[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      dispatcherSeen = (init as RequestInit & { dispatcher?: unknown })?.dispatcher;
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;

    try {
      const adapter = new FeishuAdapter() as any;
      adapter.resolveAvatarHostAddresses = async () => ['93.184.216.34'];
      adapter.createAvatarFetchDispatcher = (_hostname: string, addresses: string[]) => {
        pinnedAddresses = addresses;
        return dispatcher;
      };

      await adapter.downloadAvatarAttachment(
        { actorType: 'user', displayName: '刘丹', platformId: 'ou_user' },
        'https://avatar.example.com/liudan.png',
      );

      assert.deepEqual(pinnedAddresses, ['93.184.216.34']);
      assert.equal(dispatcherSeen, dispatcher);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports the avatar field scope when Contact succeeds but omits the avatar object', async () => {
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
            users: [{ member_id: 'ou_user', member_id_type: 'open_id', name: '刘丹' }],
            bots: [],
            has_more: false,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (text.includes('/open-apis/contact/v3/users/ou_user')) {
        return new Response(JSON.stringify({ code: 0, data: { user: { name: '刘丹' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ code: 404, msg: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const adapter = new FeishuAdapter() as any;
      const result = await adapter.buildAvatarEvidenceForRequest('oc_group', '查看群成员头像');
      assert.equal(result.context.items[0].reasonCode, 'missing_app_scope');
      assert.deepEqual(result.context.items[0].missingScopes, ['contact:user.base:readonly']);
      assert.match(decodeURIComponent(result.context.items[0].consoleUrl), /contact:user\.base:readonly/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('classifies Contact 41050 as a data-range blocker before generic permission text', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const text = String(url);
      if (text.includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_token' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (text.includes('/open-apis/im/v1/chats/oc_group/members/list')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { users: [{ member_id: 'ou_user', member_id_type: 'open_id', name: '刘丹' }], bots: [], has_more: false },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (text.includes('/open-apis/contact/v3/users/ou_user')) {
        return new Response(JSON.stringify({ code: 41050, msg: 'Permission denied: user is outside the app contact data scope' }), { status: 403, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 404, msg: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const adapter = new FeishuAdapter() as any;
      const result = await adapter.buildAvatarEvidenceForRequest('oc_group', '查看群成员头像');
      assert.equal(result.context.items[0].reasonCode, 'contact_data_scope_denied');
      assert.equal(result.context.items[0].missingScopes, undefined);
      assert.match(result.context.items[0].reason, /通讯录数据权限范围/u);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps other member avatars when one profile lookup throws a transport error', async () => {
    const originalFetch = globalThis.fetch;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
            users: [
              { member_id: 'ou_failed', member_id_type: 'open_id', name: '失败成员' },
              { member_id: 'ou_ok', member_id_type: 'open_id', name: '成功成员' },
            ],
            bots: [],
            has_more: false,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (text.includes('/open-apis/contact/v3/users/ou_failed')) throw new Error('socket reset');
      if (text.includes('/open-apis/contact/v3/users/ou_ok')) {
        return new Response(JSON.stringify({
          code: 0,
          data: { user: { avatar: { avatar_240: 'https://avatar.example.com/ok.png' } } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (text === 'https://avatar.example.com/ok.png') {
        return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return new Response(JSON.stringify({ code: 404, msg: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const adapter = new FeishuAdapter() as any;
      const result = await adapter.buildAvatarEvidenceForRequest('oc_group', '查看群成员头像');
      assert.equal(result.attachments.length, 1);
      assert.equal(result.context.successfulCount, 1);
      assert.equal(result.context.failedCount, 1);
      assert.equal(result.context.blockers.length, 0);
      assert.equal(result.context.items[0].displayName, '失败成员');
      assert.equal(result.context.items[0].reasonCode, 'avatar_lookup_failed');
      assert.equal(result.context.items[1].displayName, '成功成员');
      assert.equal(result.context.items[1].status, 'attached');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not misreport a member-list server error as a missing scope', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const text = String(url);
      if (text.includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_token' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (text.includes('/open-apis/im/v1/chats/oc_group/members/list')) {
        return new Response(JSON.stringify({ code: 50001, msg: 'internal server error' }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 404, msg: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const adapter = new FeishuAdapter() as any;
      const result = await adapter.buildAvatarEvidenceForRequest('oc_group', '查看群成员头像');
      assert.equal(result.context.blockers[0].reasonCode, 'member_list_unavailable');
      assert.equal(result.context.blockers[0].missingScopes, undefined);
      assert.equal(result.context.blockers[0].consoleUrl, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses unique attachment names for same-type members with the same display name', async () => {
    const originalFetch = globalThis.fetch;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
            users: [
              { member_id: 'ou_same_1', member_id_type: 'open_id', name: '小明' },
              { member_id: 'ou_same_2', member_id_type: 'open_id', name: '小明' },
            ],
            bots: [],
            has_more: false,
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (text.includes('/open-apis/contact/v3/users/ou_same_1')) {
        return new Response(JSON.stringify({ code: 0, data: { user: { avatar: { avatar_240: 'https://avatar.example.com/1.png' } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (text.includes('/open-apis/contact/v3/users/ou_same_2')) {
        return new Response(JSON.stringify({ code: 0, data: { user: { avatar: { avatar_240: 'https://avatar.example.com/2.png' } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (text.startsWith('https://avatar.example.com/')) {
        return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return new Response(JSON.stringify({ code: 404, msg: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const adapter = new FeishuAdapter() as any;
      const result = await adapter.buildAvatarEvidenceForRequest('oc_group', '分别查看群成员头像');
      const names = result.attachments.map((item: { name: string }) => item.name);
      assert.equal(names.length, 2);
      assert.notEqual(names[0], names[1]);
      assert.match(names[0], /^飞书头像-用户-小明-[a-f0-9]{8}\.png$/u);
      assert.match(names[1], /^飞书头像-用户-小明-[a-f0-9]{8}\.png$/u);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('cancels avatar streaming reads as soon as the two-megabyte limit is exceeded', async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    let chunkIndex = 0;
    const megabyte = new Uint8Array(1024 * 1024);
    megabyte.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        chunkIndex += 1;
        controller.enqueue(megabyte);
        if (chunkIndex >= 5) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;

    try {
      const adapter = new FeishuAdapter() as any;
      await assert.rejects(
        adapter.downloadAvatarAttachment({
          actorType: 'user',
          displayName: '刘丹',
          platformId: 'ou_user',
        }, 'https://avatar.example.com/liudan.png'),
        /超过 2 MB/u,
      );
      assert.equal(cancelled, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('cancels an unread avatar body before closing the dispatcher on early rejection', async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        // 保持响应体未完成，验证 early rejection 不能依赖服务端主动结束。
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = (async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String((2 * 1024 * 1024) + 1) },
    })) as typeof fetch;

    try {
      const adapter = new FeishuAdapter() as any;
      adapter.resolveAvatarHostAddresses = async () => ['93.184.216.34'];
      adapter.createAvatarFetchDispatcher = () => ({
        dispatch: () => true,
        close: async () => { closed = true; },
      });

      await assert.rejects(
        adapter.downloadAvatarAttachment({ actorType: 'user', displayName: '刘丹', platformId: 'ou_user' }, 'https://avatar.example.com/liudan.png'),
        /超过 2 MB/u,
      );
      assert.equal(cancelled, true);
      assert.equal(closed, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not hydrate avatar evidence for unrelated chat text', async () => {
    const adapter = new FeishuAdapter() as any;
    let calls = 0;
    adapter.buildAvatarEvidenceForRequest = async () => {
      calls += 1;
      return { attachments: [], context: null };
    };
    adapter.resolveChatDisplayName = async () => '普通群';
    adapter.persistChatIndex = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.buildLightConversationContext = async () => null;
    adapter.ensureStickerHistoryBackfilledForRequest = async () => {};
    adapter.buildStickerLibraryEvidenceForRequest = async () => null;
    const queued: any[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);

    await adapter.processIncomingEvent(createFeishuTextEvent('om_normal_request', '总结一下今天讨论的内容'));
    await adapter.processIncomingEvent(createFeishuTextEvent('om_change_bot_avatar', '给机器人换个头像'));
    await adapter.processIncomingEvent(createFeishuTextEvent('om_group_avatar_design', '这个群头像是谁设计的'));
    await adapter.processIncomingEvent(createFeishuTextEvent('om_negated_avatar_read', '不用查看群成员头像，直接生成新头像'));
    await adapter.processIncomingEvent(createFeishuTextEvent('om_quoted_avatar_read', '把“查看群成员头像”翻译成英文'));
    await adapter.processIncomingEvent(createFeishuTextEvent('om_avatar_capability_question', '你能查看群成员头像吗？'));
    await adapter.processIncomingEvent(createFeishuTextEvent('om_avatar_tutorial_question', '怎么查看群成员头像？'));
    await adapter.processIncomingEvent(createFeishuTextEvent('om_avatar_reason_question', '为什么不能查看群成员头像？'));
    await adapter.processIncomingEvent(createFeishuTextEvent('om_avatar_name_only', '不要查看群成员头像，只要列出成员名字'));
    await adapter.processIncomingEvent(createFeishuTextEvent('om_avatar_unrelated_analysis', '不用查看群成员头像，然后分析今天聊天内容'));
    await adapter.processIncomingEvent(createFeishuTextEvent('om_avatar_unrelated_analysis_no_punctuation', '不要查看群成员头像这个事情先放一边然后分析今天聊天内容'));
    for (const item of queued) await item.prepareForAgent();

    assert.equal(calls, 0);
    assert.equal(queued.length, 11);
    assert.ok(queued.every((item) => item.raw.feishuAvatarEvidence === undefined));
  });

  it('hydrates avatar evidence when a later positive clause replaces an earlier negative action', async () => {
    const adapter = new FeishuAdapter() as any;
    let calls = 0;
    adapter.buildAvatarEvidenceForRequest = async () => {
      calls += 1;
      return {
        attachments: [],
        context: { prompt: 'avatar evidence', requestedCount: 0, successfulCount: 0, failedCount: 1, truncated: false, items: [], blockers: [] },
      };
    };
    adapter.resolveChatDisplayName = async () => '普通群';
    adapter.persistChatIndex = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.buildLightConversationContext = async () => null;
    adapter.ensureStickerHistoryBackfilledForRequest = async () => {};
    adapter.buildStickerLibraryEvidenceForRequest = async () => null;
    const queued: any[] = [];
    adapter.enqueue = (message: unknown) => queued.push(message);

    await adapter.processIncomingEvent(createFeishuTextEvent('om_avatar_mixed_polarity', '不要描述群成员头像，只要展示出来'));
    await adapter.processIncomingEvent(createFeishuTextEvent('om_avatar_mixed_polarity_no_punctuation', '不要描述群成员头像只要展示出来'));
    await adapter.processIncomingEvent(createFeishuTextEvent('om_avatar_polite_execution', '能不能帮我查看群成员头像并分别描述'));
    for (const item of queued) await item.prepareForAgent();

    assert.equal(calls, 3);
    assert.equal(queued[0].raw.feishuAvatarEvidence.prompt, 'avatar evidence');
    assert.equal(queued[1].raw.feishuAvatarEvidence.prompt, 'avatar evidence');
    assert.equal(queued[2].raw.feishuAvatarEvidence.prompt, 'avatar evidence');
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
    // Mention history is a deliberate resolver source in production. Give each
    // unit case an empty runtime home so local live history cannot add a second
    // candidate or make an app/bot-only response look mentionable.
    useTempCtiHome();
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

  it('prefers a unique current-chat mention over a stale history candidate with the same display name', async () => {
    const adapter = new FeishuAdapter() as any;
    // A renamed/reinstalled app can leave an old platform ID in history. The
    // current group's candidate is authoritative for a same-chat native @.
    adapter.readHistoryMentionCandidates = () => [
      { userId: 'ou_stale_target', name: '同名目标', aliases: ['同名目标'] },
    ];
    adapter.fetchChatMentionCandidates = async () => [
      { userId: 'ou_current_target', name: '同名目标', aliases: ['同名目标'] },
    ];

    const resolved = await adapter.resolveOutboundMentions({
      address: { channelType: 'feishu', chatId: 'oc_group', chatType: 'group' },
      text: '@同名目标 看一下',
      parseMode: 'plain',
    });

    assert.deepEqual(resolved.mentions, [{ userId: 'ou_current_target', name: '同名目标' }]);
  });

  it('reports the current-chat candidate as resolved instead of calling it ambiguous against stale history', async () => {
    const adapter = new FeishuAdapter() as any;
    adapter.readHistoryMentionCandidates = () => [
      { userId: 'ou_stale_target', name: '同名目标', aliases: ['同名目标'] },
    ];
    adapter.fetchChatMentionCandidates = async () => [
      { userId: 'ou_current_target', name: '同名目标', aliases: ['同名目标'] },
    ];

    const inspection = await adapter.inspectOutboundMentionTarget({
      address: { channelType: 'feishu', chatId: 'oc_group', chatType: 'group' },
      text: '@同名目标 看一下',
      parseMode: 'plain',
    }, undefined, '同名目标');

    assert.equal(inspection.status, 'resolved');
    assert.deepEqual(inspection.candidates, [{ name: '同名目标', aliases: undefined }]);
  });

  it('inspects unresolved mention targets with related group member candidates', async () => {
    const adapter = new FeishuAdapter() as any;
    adapter.fetchChatMentionCandidates = async (chatId: string) => {
      assert.equal(chatId, 'oc_group');
      return [
        { userId: 'ou_liudan', name: '刘丹', aliases: ['刘丹'] },
        { userId: 'ou_liudan_bot', name: '刘丹助手', aliases: ['刘丹机器人'] },
      ];
    };

    const inspection = await adapter.inspectOutboundMentionTarget({
      address: { channelType: 'feishu', chatId: 'oc_group', chatType: 'group' },
      text: '@刘丹起床',
      parseMode: 'Markdown',
    }, undefined, '刘丹起床');

    assert.equal(inspection.status, 'ambiguous');
    assert.deepEqual(inspection.candidates.map((item: any) => item.name), ['刘丹']);
    assert.ok(inspection.searchedSources.some((item: string) => item.includes('群成员')));
    assert.ok(inspection.searchedSources.some((item: string) => item.includes('群机器人')));
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

  it('sends a verified direct-message sticker as a native sticker payload', async () => {
    const adapter = new FeishuAdapter() as any;
    const sent: any[] = [];
    adapter.fetchChatMemberNames = async () => new Map([['ou_george', '乔治']]);
    adapter.restClient = {
      im: {
        message: {
          create: async (payload: any) => {
            sent.push(payload);
            return { data: { message_id: 'om_direct_sticker' } };
          },
        },
      },
    };

    const result = await adapter.sendDirectMessage({
      sourceMessage: {
        messageId: 'om_source',
        address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_sender', chatType: 'group' },
        text: '给乔治发个表情包',
        timestamp: Date.now(),
      },
      targetText: '乔治',
      text: '[表情包:v3_0011f_f57bd3a8-cb9d-41f3-8e9f-6bd21ab4be8g] 辛苦了～',
      verifiedMediaAction: {
        kind: 'sticker',
        key: 'v3_0011f_f57bd3a8-cb9d-41f3-8e9f-6bd21ab4be8g',
        provenance: 'turn_attached_model_selection',
        semanticRevisionId: 'revision-direct-1',
        contextHash: 'b'.repeat(64),
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'om_direct_sticker');
    assert.equal(result.targetDisplayName, '乔治');
    assert.deepEqual(result.verifiedMediaDelivery, {
      kind: 'sticker',
      fileKey: 'v3_0011f_f57bd3a8-cb9d-41f3-8e9f-6bd21ab4be8g',
      semanticRevisionId: 'revision-direct-1',
      contextHash: 'b'.repeat(64),
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].params.receive_id_type, 'open_id');
    assert.equal(sent[0].data.receive_id, 'ou_george');
    assert.equal(sent[0].data.msg_type, 'sticker');
    assert.deepEqual(JSON.parse(sent[0].data.content), {
      file_key: 'v3_0011f_f57bd3a8-cb9d-41f3-8e9f-6bd21ab4be8g',
    });
  });

  it('sends direct messages to the current group sender when target is me and member lookup is unavailable', async () => {
    const adapter = new FeishuAdapter() as any;
    const sent: any[] = [];
    adapter.fetchChatMemberNames = async (chatId: string) => {
      assert.equal(chatId, 'oc_group');
      return new Map();
    };
    adapter.restClient = {
      im: {
        message: {
          create: async (payload: any) => {
            sent.push(payload);
            return { data: { message_id: 'om_direct_me' } };
          },
        },
      },
    };

    const result = await adapter.sendDirectMessage({
      sourceMessage: {
        messageId: 'om_source',
        address: {
          channelType: 'feishu',
          chatId: 'oc_group',
          userId: 'ou_sender',
          displayName: '项目群',
          chatType: 'group',
        },
        text: '小虾米，给我私发一句测试',
        timestamp: Date.now(),
        raw: {
          feishuSender: { openId: 'ou_sender', senderType: 'user' },
        },
      },
      targetText: '我',
      text: '测试消息',
    });

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'om_direct_me');
    assert.equal(result.targetDisplayName, '发起人');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].params.receive_id_type, 'open_id');
    assert.equal(sent[0].data.receive_id, 'ou_sender');
    assert.equal(sent[0].data.msg_type, 'text');
    assert.equal(JSON.parse(sent[0].data.content).text, '测试消息');
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

  it('resolves cross-chat targets from known Feishu channel bindings', async () => {
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: {
        ...createMockStore(),
        listChannelBindings: (channelType?: string) => channelType === 'feishu' || !channelType
          ? [
            {
              id: 'binding_target',
              channelType: 'feishu',
              chatId: 'oc_target_group',
              displayName: '项目讨论群',
              chatType: 'group',
              codepilotSessionId: 'session_target',
              sdkSessionId: '',
              workingDirectory: process.cwd(),
              model: '',
              mode: 'code',
              active: true,
              createdAt: '2026-07-10T00:00:00.000Z',
              updatedAt: '2026-07-10T00:00:00.000Z',
            },
          ] as any
          : [],
      } as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = new FeishuAdapter() as any;

    const byId = await adapter.resolveConversationTarget({
      sourceMessage: {
        messageId: 'om_source',
        address: { channelType: 'feishu', chatId: 'oc_source', userId: 'ou_owner', chatType: 'group' },
        text: '发到会话 oc_target_group',
        timestamp: Date.now(),
      },
      targetId: 'oc_target_group',
      targetKind: 'chat',
    });
    const byName = await adapter.resolveConversationTarget({
      sourceMessage: {
        messageId: 'om_source',
        address: { channelType: 'feishu', chatId: 'oc_source', userId: 'ou_owner', chatType: 'group' },
        text: '发到项目讨论群',
        timestamp: Date.now(),
      },
      targetText: '项目讨论群',
      targetKind: 'chat',
    });

    assert.equal(byId.ok, true);
    assert.equal(byId.target.displayName, '项目讨论群');
    assert.equal(byId.target.id, 'oc_target_group');
    assert.equal(byId.target.kind, 'chat');
    assert.equal(byName.ok, true);
    assert.equal(byName.target.id, 'oc_target_group');
  });

  it('sends cross-chat messages by chat_id without using the source chat id', async () => {
    const adapter = new FeishuAdapter() as any;
    const sent: any[] = [];
    adapter.restClient = {
      im: {
        message: {
          create: async (payload: any) => {
            sent.push(payload);
            return { data: { message_id: 'om_cross_chat' } };
          },
        },
      },
    };

    const result = await adapter.sendConversationMessage({
      sourceMessage: {
        messageId: 'om_source',
        address: { channelType: 'feishu', chatId: 'oc_source', userId: 'ou_owner', chatType: 'group' },
        text: '发到会话 oc_target_group',
        timestamp: Date.now(),
      },
      target: {
        kind: 'chat',
        id: 'oc_target_group',
        displayName: '项目讨论群',
        chatType: 'group',
      },
      text: '跨群正文',
    });

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'om_cross_chat');
    assert.equal(result.targetDisplayName, '项目讨论群');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].params.receive_id_type, 'chat_id');
    assert.equal(sent[0].data.receive_id, 'oc_target_group');
    assert.equal(sent[0].data.msg_type, 'text');
    assert.equal(JSON.parse(sent[0].data.content).text, '跨群正文');
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
    const replyEvidence = context.evidence.find((item: any) => item.relation === 'native_reply');
    assert.ok(replyEvidence);
    assert.equal(replyEvidence.id, 'message:om_reply');
    assert.equal(replyEvidence.source, 'platform_api');
    assert.equal(replyEvidence.actor.displayName, '苏庆华');
    assert.match(replyEvidence.content, /万能区域什么都能改小王分队/);
    assert.ok(context.evidence.some((item: any) => item.id === 'message:om_other' && item.relation === 'nearby'));
  });

  it('excludes messages created after the current inbound message from light context', async () => {
    const adapter = new FeishuAdapter() as any;
    const now = Date.now();
    const makeItem = (messageId: string, text: string, offset: number) => ({
      message_id: messageId,
      chat_id: 'oc_group',
      create_time: String(now + offset),
      msg_type: 'text',
      body: { content: JSON.stringify({ text }) },
      sender: { id: 'ou_sender', sender_type: 'user' },
    });

    adapter.fetchChatMemberNames = async () => new Map([['ou_sender', '刘丹']]);
    adapter.fetchMessageById = async () => makeItem('om_reply', '被回复消息', -2000);
    adapter.fetchRecentMessages = async () => [
      makeItem('om_current', '@小虾米 你猜', 0),
      makeItem('om_reply', '被回复消息', -2000),
      makeItem('om_past', '当前消息之前的上下文', -1000),
      makeItem('om_future', '当前消息之后才出现的内容', 1000),
    ];

    const context = await adapter.buildLightConversationContext(
      'oc_group',
      'om_current',
      'om_reply',
      '你猜',
      [],
      now,
    );

    assert.ok(context);
    assert.match(context.prompt, /当前消息之前的上下文/);
    assert.doesNotMatch(context.prompt, /当前消息之后才出现的内容/);
    assert.equal(context.evidence.some((item: any) => item.id === 'message:om_future'), false);
  });

  it('marks native reply resource shells as low-confidence until their content is recovered', async () => {
    const adapter = new FeishuAdapter() as any;
    const imageReply = {
      message_id: 'om_reply_image',
      chat_id: 'oc_group',
      create_time: String(Date.now() - 1000),
      msg_type: 'image',
      body: { content: JSON.stringify({ image_key: 'img_reply' }) },
      sender: { id: 'ou_sender', sender_type: 'user' },
    };
    adapter.fetchChatMemberNames = async () => new Map([['ou_sender', '刘丹']]);
    adapter.fetchMessageById = async () => imageReply;
    adapter.fetchRecentMessages = async () => [imageReply];

    const context = await adapter.buildLightConversationContext(
      'oc_group',
      'om_current',
      'om_reply_image',
      '看这个',
    );

    const replyEvidence = context?.evidence.find((item: any) => item.id === 'message:om_reply_image');
    assert.ok(replyEvidence);
    assert.equal(replyEvidence.metadata.contentRecovered, false);
    assert.ok(replyEvidence.confidence < 0.8);
  });

  it('marks a likely nearby context message for short reply commands without native reply metadata', async () => {
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
    adapter.fetchMessageById = async () => null;
    adapter.fetchRecentMessages = async () => [
      makeItem('om_current', '@小虾米 回复一下', 'ou_liu', 0),
      makeItem('om_question', '你后台连的 Codex 客户端还是 CLI？', 'ou_su', -1000),
      makeItem('om_note', '那玩意是装在 Codex 里的', 'ou_liu', -4000),
    ];

    const context = await adapter.buildLightConversationContext(
      'oc_group',
      'om_current',
      null,
      '回复一下',
    );

    assert.ok(context);
    assert.equal(context.replyToMessageId, undefined);
    assert.match(context.prompt, /可能关联上文/);
    assert.match(context.prompt, /你后台连的 Codex 客户端还是 CLI/);
    assert.doesNotMatch(context.prompt, /@小虾米 回复一下/);
    const likelyEvidence = context.evidence.find((item: any) => item.relation === 'likely_context');
    assert.ok(likelyEvidence);
    assert.equal(likelyEvidence.id, 'message:om_question');
    assert.equal(likelyEvidence.source, 'adapter_inference');
    assert.ok(likelyEvidence.confidence < 0.8);
  });

  it('keeps nearby bot messages and native mention signals for short deictic questions', async () => {
    const adapter = new FeishuAdapter() as any;
    const now = Date.now();
    const makeItem = (messageId: string, text: string, senderId: string, senderType: string, offset: number) => ({
      message_id: messageId,
      chat_id: 'oc_group',
      create_time: String(now + offset),
      msg_type: 'text',
      body: { content: JSON.stringify({ text }) },
      sender: { id: senderId, sender_type: senderType },
    });

    adapter.fetchChatMemberNames = async () => new Map([
      ['ou_liu', '刘丹'],
      ['cli_other_bot', '大虾米'],
    ]);
    adapter.fetchMessageById = async () => null;
    adapter.fetchRecentMessages = async () => [
      makeItem('om_current', '@大虾米 @小虾米 他这是咋回事', 'ou_liu', 'user', 0),
      makeItem('om_bot_result', '我重新查了一遍，还是没有“大世界分支”。', 'cli_other_bot', 'app', -1000),
      makeItem('om_human_note', '显然他不想出来', 'ou_liu', 'user', -3000),
    ];

    const context = await adapter.buildLightConversationContext(
      'oc_group',
      'om_current',
      null,
      '他这是咋回事',
      [
        { key: '@_user_1', name: '大虾米', id: { open_id: 'ou_big' } },
        { key: '@_user_2', name: '小虾米', id: { open_id: 'ou_small' } },
      ],
    );

    assert.ok(context);
    assert.match(context.prompt, /Current message reference signals/);
    assert.match(context.prompt, /native mentions in current message/);
    assert.match(context.prompt, /大虾米/);
    assert.match(context.prompt, /小虾米/);
    assert.match(context.prompt, /可能关联上文/);
    assert.match(context.prompt, /大世界分支/);
    const mentionEvidence = context.evidence.filter((item: any) => item.relation === 'native_mention');
    assert.deepEqual(mentionEvidence.map((item: any) => item.actor.displayName), ['大虾米', '小虾米']);
    assert.ok(mentionEvidence.every((item: any) => item.source === 'platform_event'));
  });

  it('extracts visible interactive card text for short light context', async () => {
    const adapter = new FeishuAdapter() as any;
    const now = Date.now();
    const makeItem = (
      messageId: string,
      msgType: string,
      content: unknown,
      senderId: string,
      senderType: string,
      offset: number,
    ) => ({
      message_id: messageId,
      chat_id: 'oc_group',
      create_time: String(now + offset),
      msg_type: msgType,
      body: { content: typeof content === 'string' ? JSON.stringify({ text: content }) : JSON.stringify(content) },
      sender: { id: senderId, sender_type: senderType },
    });

    adapter.fetchChatMemberNames = async () => new Map([
      ['ou_liu', '刘丹'],
      ['cli_other_bot', '乔治'],
    ]);
    adapter.fetchMessageById = async () => null;
    adapter.fetchRecentMessages = async () => [
      makeItem('om_current', 'text', '@小虾米 这是什么情况', 'ou_liu', 'user', 0),
      makeItem('om_card', 'interactive', {
        schema: '2.0',
        body: {
          elements: [
            { tag: 'markdown', content: '构建失败：缺少飞书消息读取权限' },
            { tag: 'markdown', content: '已完成 · 3.4s' },
          ],
        },
      }, 'cli_other_bot', 'app', -1000),
    ];

    const context = await adapter.buildLightConversationContext(
      'oc_group',
      'om_current',
      null,
      '这是什么情况',
      [
        { key: '@_user_1', name: '小虾米', id: { open_id: 'ou_small' } },
      ],
    );

    assert.ok(context);
    assert.match(context.prompt, /构建失败：缺少飞书消息读取权限/);
    assert.doesNotMatch(context.prompt, /\[卡片消息\]/);
  });

  it('uses a card resource boundary instead of Feishu upgrade placeholder in short light context', async () => {
    const adapter = new FeishuAdapter() as any;
    const now = Date.now();
    const makeItem = (
      messageId: string,
      msgType: string,
      content: unknown,
      senderId: string,
      senderType: string,
      offset: number,
    ) => ({
      message_id: messageId,
      chat_id: 'oc_group',
      create_time: String(now + offset),
      msg_type: msgType,
      body: { content: typeof content === 'string' ? JSON.stringify({ text: content }) : JSON.stringify(content) },
      sender: { id: senderId, sender_type: senderType },
    });

    adapter.fetchChatMemberNames = async () => new Map([
      ['ou_liu', '刘丹'],
      ['cli_other_bot', '乔治'],
    ]);
    adapter.fetchMessageById = async () => null;
    adapter.fetchRecentMessages = async () => [
      makeItem('om_current', 'text', '@小虾米 这是什么情况', 'ou_liu', 'user', 0),
      makeItem('om_card', 'interactive', {
        title: null,
        elements: [[
          { tag: 'img', image_key: 'img_card_preview' },
          { tag: 'text', text: '请升级至最新版本客户端，以查看内容' },
        ]],
      }, 'cli_other_bot', 'app', -1000),
    ];

    const context = await adapter.buildLightConversationContext(
      'oc_group',
      'om_current',
      null,
      '这是什么情况',
      [
        { key: '@_user_1', name: '小虾米', id: { open_id: 'ou_small' } },
      ],
    );

    assert.ok(context);
    assert.doesNotMatch(context.prompt, /请升级至最新版本客户端/);
    assert.match(context.prompt, /卡片消息/);
    assert.match(context.prompt, /图片资源/);
  });

  it('recovers durable streaming-card continuation context when cloud history only has a card shell', async () => {
    const store = createMockStore({ bridge_feishu_light_context_limit: '4' }) as any;
    store.listAuditLogs = () => [];
    store.listOutboundRefs = (filter: any = {}) => [
      {
        channelType: 'feishu',
        chatId: 'oc_group',
        platformMessageId: 'om_streaming_card',
        codepilotSessionId: 'session_original_task',
        purpose: 'streaming_card',
        messageKind: 'interactive',
        continuationContext: [
          '原始请求：查看当前群里的机器人。',
          '上一轮结果：未完成，成员接口没有返回可提及的机器人身份。',
        ].join('\n'),
      },
    ].filter((entry) => (!filter.channelType || entry.channelType === filter.channelType)
      && (!filter.chatId || entry.chatId === filter.chatId)
      && (!filter.platformMessageId || entry.platformMessageId === filter.platformMessageId));
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new FeishuAdapter() as any;
    const now = Date.now();
    const makeItem = (messageId: string, msgType: string, content: unknown, senderType: string, offset: number) => ({
      message_id: messageId,
      chat_id: 'oc_group',
      create_time: String(now + offset),
      msg_type: msgType,
      body: { content: typeof content === 'string' ? JSON.stringify({ text: content }) : JSON.stringify(content) },
      sender: { id: senderType === 'app' ? 'cli_bot' : 'ou_liu', sender_type: senderType },
    });

    adapter.fetchChatMemberNames = async () => new Map([
      ['ou_liu', '刘丹'],
      ['cli_bot', '小虾米'],
    ]);
    adapter.fetchMessageById = async (messageId: string) => (
      messageId === 'om_streaming_card'
        ? makeItem('om_streaming_card', 'interactive', { type: 'card', data: { image_key: 'img_result' } }, 'app', -1_000)
        : null
    );
    adapter.fetchRecentMessages = async () => [
      makeItem('om_current', 'text', '@小虾米 继续，想办法尝试调用', 'user', 0),
      makeItem('om_streaming_card', 'interactive', { type: 'card', data: { image_key: 'img_result' } }, 'app', -1_000),
    ];

    const context = await adapter.buildLightConversationContext(
      'oc_group',
      'om_current',
      'om_streaming_card',
      '继续，想办法尝试调用',
      [{ name: '小虾米', id: { open_id: 'ou_bot' } }] as any,
    );

    assert.ok(context);
    assert.match(context.prompt, /原始请求：查看当前群里的机器人/);
    assert.match(context.prompt, /上一轮结果：未完成/);
    const replyEvidence = context.evidence.find((item: any) => item.relation === 'native_reply');
    assert.ok(replyEvidence);
    assert.match(replyEvidence.content, /原始请求：查看当前群里的机器人/);
    assert.match(replyEvidence.content, /上一轮结果：未完成/);
  });

  it('enriches bot card shells from local outbound audit for continuation image tasks', async () => {
    const store = createMockStore({ bridge_feishu_light_context_limit: '4' }) as any;
    store.listAuditLogs = (filter: any = {}) => [
      {
        channelType: 'feishu',
        chatId: 'oc_group',
        direction: 'outbound',
        messageId: 'om_prev_card',
        summary: [
          '标好了，输出图：`C:\\unity\\ST3\\A2_yellow_area_named_map.png`',
          '',
          '命名对应：',
          '1 `A2_Lobby`',
          '3/4/5 `A2_KidsWard1/2/3`',
        ].join('\n'),
        id: 'audit_prev_card',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ].filter((entry) => (!filter.channelType || entry.channelType === filter.channelType)
      && (!filter.chatId || entry.chatId === filter.chatId)
      && (!filter.direction || entry.direction === filter.direction)
      && (!filter.messageId || entry.messageId === filter.messageId));
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new FeishuAdapter() as any;
    const now = Date.now();
    const makeItem = (
      messageId: string,
      msgType: string,
      content: unknown,
      senderId: string,
      senderType: string,
      offset: number,
    ) => ({
      message_id: messageId,
      chat_id: 'oc_group',
      create_time: String(now + offset),
      msg_type: msgType,
      body: { content: typeof content === 'string' ? JSON.stringify({ text: content }) : JSON.stringify(content) },
      sender: { id: senderId, sender_type: senderType },
    });

    adapter.fetchChatMemberNames = async () => new Map([
      ['ou_liu', '刘丹'],
      ['cli_bot', '小虾米'],
    ]);
    adapter.fetchMessageById = async (messageId: string) => (
      messageId === 'om_reply_image'
        ? makeItem('om_reply_image', 'image', { image_key: 'img_original' }, 'cli_bot', 'app', -10_000)
        : null
    );
    adapter.fetchRecentMessages = async () => [
      makeItem('om_current', 'post', { content: [[{ tag: 'text', text: '@小虾米 乖孩子，在这张图上也标记一下，这是原画' }]] }, 'ou_liu', 'user', 0),
      makeItem('om_prev_card', 'interactive', { type: 'card', data: { image_key: 'img_prev_result' } }, 'cli_bot', 'app', -70_000),
      makeItem('om_reply_image', 'image', { image_key: 'img_original' }, 'cli_bot', 'app', -10_000),
    ];

    const context = await adapter.buildLightConversationContext(
      'oc_group',
      'om_current',
      'om_reply_image',
      '乖孩子，在这张图上也标记一下，这是原画',
      [{ name: '小虾米', id: { open_id: 'ou_bot' } }] as any,
    );

    assert.ok(context);
    assert.match(context.prompt, /Feishu recent conversation context/);
    assert.match(context.prompt, /本地已发送内容摘要/);
    assert.match(context.prompt, /A2_yellow_area_named_map/);
    assert.match(context.prompt, /A2_Lobby/);
    assert.match(context.prompt, /“这是原画”/);
    assert.match(context.prompt, /不要直接当作要写到图片上的文字/);
  });

  it('keeps nearby bot audit summaries for continuation tasks even without native mentions', async () => {
    const store = createMockStore({ bridge_feishu_light_context_limit: '3' }) as any;
    store.listAuditLogs = (filter: any = {}) => [
      {
        channelType: 'feishu',
        chatId: 'oc_group',
        direction: 'outbound',
        messageId: 'om_prev_card',
        summary: '标好了，命名对应：A2_Lobby、A2_PlayRoom。',
        id: 'audit_prev_card',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ].filter((entry) => (!filter.channelType || entry.channelType === filter.channelType)
      && (!filter.chatId || entry.chatId === filter.chatId)
      && (!filter.direction || entry.direction === filter.direction)
      && (!filter.messageId || entry.messageId === filter.messageId));
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new FeishuAdapter() as any;
    const now = Date.now();
    const makeItem = (messageId: string, msgType: string, content: unknown, senderType: string, offset: number) => ({
      message_id: messageId,
      chat_id: 'oc_group',
      create_time: String(now + offset),
      msg_type: msgType,
      body: { content: typeof content === 'string' ? JSON.stringify({ text: content }) : JSON.stringify(content) },
      sender: { id: senderType === 'app' ? 'cli_bot' : 'ou_liu', sender_type: senderType },
    });

    adapter.fetchChatMemberNames = async () => new Map([
      ['ou_liu', '刘丹'],
      ['cli_bot', '小虾米'],
    ]);
    adapter.fetchMessageById = async () => null;
    adapter.fetchRecentMessages = async () => [
      makeItem('om_current', 'text', '继续标记这张图', 'user', 0),
      makeItem('om_prev_card', 'interactive', { type: 'card', data: { image_key: 'img_prev_result' } }, 'app', -30_000),
    ];

    const context = await adapter.buildLightConversationContext(
      'oc_group',
      'om_current',
      null,
      '继续标记这张图',
      [],
    );

    assert.ok(context);
    assert.match(context.prompt, /Continuation task guardrails/);
    assert.match(context.prompt, /本地已发送内容摘要/);
    assert.match(context.prompt, /A2_Lobby/);
  });
});

describe('FeishuAdapter replied sticker attachments', () => {
  it('downloads the exact sticker image from a replied message', async () => {
    const adapter = new FeishuAdapter() as any;
    const calls: Array<{ messageId: string; fileKey: string; resourceType: string }> = [];
    adapter.downloadResource = async (messageId: string, fileKey: string, resourceType: string) => {
      calls.push({ messageId, fileKey, resourceType });
      return {
        id: fileKey,
        name: `${fileKey}.png`,
        type: 'image/png',
        size: 4,
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      };
    };

    const attachments = await adapter.downloadAttachmentsFromMessageItem({
      message_id: 'om_original_sticker',
      chat_id: 'oc_group',
      create_time: String(Date.now()),
      msg_type: 'sticker',
      body: { content: JSON.stringify({ file_key: 'sticker_original_key' }) },
      sender: { id: 'ou_other', sender_type: 'user' },
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      messageId: 'om_original_sticker',
      fileKey: 'sticker_original_key',
      resourceType: 'image',
    });
    assert.equal(attachments[0]?.id, 'sticker_original_key');
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

  it('recognizes upward message references as cloud history intent instead of light context', () => {
    const adapter = new FeishuAdapter() as any;

    const intent = adapter.parseHistoryIntentV2('小虾米，蠢比，看我上面消息');

    assert.ok(intent);
    assert.equal(intent.responseMode, 'chat');
    assert.equal(intent.purpose, 'summary');
    assert.match(intent.scopeText, /上方|最近/);
  });

  it('ignores app interactive events without a native mention so bot cards cannot trigger another LLM turn', async () => {
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

  it('indexes escaped interactive card body as visible card evidence for history summaries', async () => {
    const store = createMockStore() as any;
    const upserts: Array<{ messages: Array<{ text: string; msgType: string }> }> = [];
    store.getFeishuHistorySyncStatus = () => [];
    store.upsertFeishuHistoryMessages = (data: { messages: Array<{ text: string; msgType: string }> }) => {
      upserts.push(data);
      return null;
    };
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = new FeishuAdapter() as any;
    adapter.fetchChatMemberNames = async () => new Map([['cli_other_bot', '乔治']]);
    adapter.fetchMessagePage = async () => ({
      items: [{
        message_id: 'om_history_card',
        chat_id: 'oc_group',
        create_time: '1710000000000',
        msg_type: 'interactive',
        body: {
          content: JSON.stringify({
            body: {
              content: JSON.stringify({
                title: '表情回复',
                elements: [[
                  { tag: 'markdown', content: '真正正文：机器人确认请求' },
                  { tag: 'button', text: { tag: 'plain_text', content: '查看详情' } },
                  { tag: 'text', text: '请升级至最新版本客户端，以查看内容' },
                ]],
              }),
            },
          }),
        },
        sender: { id: 'cli_other_bot', sender_type: 'app' },
      }],
      hasMore: false,
      nextPageToken: '',
    });

    await adapter.syncIndexedChatHistory('oc_group', 'group', '群聊', true);

    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].messages[0].msgType, 'interactive');
    assert.match(upserts[0].messages[0].text, /表情回复/);
    assert.match(upserts[0].messages[0].text, /真正正文：机器人确认请求/);
    assert.match(upserts[0].messages[0].text, /查看详情/);
    assert.doesNotMatch(upserts[0].messages[0].text, /\{\"title\"/);
    assert.doesNotMatch(upserts[0].messages[0].text, /请升级/);
  });

  it('records sticker history by file key without downloading every image', async () => {
    const ctiHome = useTempCtiHome();
    const store = createMockStore() as any;
    const upserts: Array<{ messages: Array<{ text: string; msgType: string }> }> = [];
    store.getFeishuHistorySyncStatus = () => [];
    store.upsertFeishuHistoryMessages = (data: { messages: Array<{ text: string; msgType: string }> }) => {
      upserts.push(data);
      return null;
    };
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = new FeishuAdapter() as any;
    const downloaded: string[] = [];
    adapter.fetchChatMemberNames = async () => new Map([['ou_sender', '刘丹']]);
    adapter.downloadResource = async (_messageId: string, fileKey: string) => {
      downloaded.push(fileKey);
      return {
        id: fileKey,
        name: `${fileKey}.png`,
        type: 'image/png',
        size: 4,
        data: Buffer.from(fileKey).toString('base64'),
      };
    };
    adapter.fetchMessagePage = async () => ({
      items: [
        {
          message_id: 'om_history_sticker_1',
          chat_id: 'oc_group',
          create_time: '1710000000000',
          msg_type: 'sticker',
          body: { content: JSON.stringify({ file_key: 'sticker_history_1' }) },
          sender: { id: 'ou_sender', sender_type: 'user' },
        },
        {
          message_id: 'om_history_sticker_2',
          chat_id: 'oc_group',
          create_time: '1710000001000',
          msg_type: 'sticker',
          body: { content: JSON.stringify({ file_key: 'sticker_history_2' }) },
          sender: { id: 'ou_sender', sender_type: 'user' },
        },
      ],
      hasMore: false,
      nextPageToken: '',
    });

    await adapter.syncIndexedChatHistory('oc_group', 'group', '群聊', true);

    const stickerStore = JSON.parse(fs.readFileSync(getTestFeishuStickerStorePath(ctiHome), 'utf8'));
    assert.deepEqual(stickerStore.stickers.map((item: any) => item.fileKey).sort(), ['sticker_history_1', 'sticker_history_2']);
    assert.deepEqual(downloaded, []);
    assert.equal(fs.existsSync(path.join(
      ctiHome,
      'memory-repo',
      'data',
      'im',
      'feishu',
      'stickers',
      'media',
      MemoryArtifactStore.stableFileName('sticker_history_1', '.png'),
    )), false);
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].messages[0].msgType, 'sticker');
    assert.match(upserts[0].messages[0].text, /飞书表情包/);
  });

  it('downloads only the semantically best trusted candidate for an explicit sticker send request', async () => {
    useTempCtiHome();
    const store = createMockStore({ bridge_feishu_bot_aliases: '小虾米' }) as any;
    store.getFeishuHistorySyncStatus = () => [];
    store.upsertFeishuHistoryMessages = () => null;
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = new FeishuAdapter() as any;
    adapter.botIds.add('ou_bot');
    adapter.resolveChatDisplayName = async () => '群聊';
    adapter.persistChatIndex = () => {};
    adapter.fetchChatMemberNames = async () => new Map([['ou_sender', '刘丹']]);
    adapter.downloadResource = async (_messageId: string, fileKey: string) => ({
      id: fileKey,
      name: `${fileKey}.png`,
      type: 'image/png',
      size: 4,
      data: Buffer.from(fileKey).toString('base64'),
    });
    adapter.fetchMessagePage = async () => ({
      items: [
        {
          message_id: 'om_history_sticker_1',
          chat_id: 'oc_group',
          create_time: '1710000000000',
          msg_type: 'sticker',
          body: { content: JSON.stringify({ file_key: 'sticker_praise_candidate' }) },
          sender: { id: 'ou_sender', sender_type: 'user' },
        },
        {
          message_id: 'om_history_sticker_2',
          chat_id: 'oc_group',
          create_time: '1710000001000',
          msg_type: 'sticker',
          body: { content: JSON.stringify({ file_key: 'sticker_confused_candidate' }) },
          sender: { id: 'ou_sender', sender_type: 'user' },
        },
      ],
      hasMore: false,
      nextPageToken: '',
    });
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
      version: 1,
      updatedAt: '2026-07-11T00:00:00.000Z',
      stickers: [
        {
          fileKey: 'sticker_praise_candidate',
          aliases: ['表情包', '夸人'],
          chatId: 'oc_group',
          messageId: 'om_history_sticker_1',
          label: '点赞夸奖',
          intent: '表达认可和夸奖',
          tone: '开心肯定',
          usage: '夸奖别人时使用',
          annotationSource: 'vision',
          visionMediaFileKey: 'sticker_praise_candidate',
          annotationConfidence: 0.9,
          firstSeenAt: '2026-07-11T00:00:00.000Z',
          lastSeenAt: '2026-07-11T00:00:00.000Z',
          useCount: 0,
        },
        {
          fileKey: 'sticker_confused_candidate',
          aliases: ['表情包', '懵了'],
          chatId: 'oc_group',
          messageId: 'om_history_sticker_2',
          label: '晕乎震惊',
          intent: '表达困惑、震惊或反应不过来',
          tone: '夸张困惑',
          usage: '遇到离谱信息或突然被震住时使用',
          annotationSource: 'vision',
          visionMediaFileKey: 'sticker_confused_candidate',
          annotationConfidence: 0.95,
          firstSeenAt: '2026-07-11T00:00:01.000Z',
          lastSeenAt: '2026-07-11T00:00:01.000Z',
          useCount: 0,
        },
      ],
    }), 'utf8');

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user', user_id: 'u_user', union_id: 'on_user' },
      },
      message: {
        message_id: 'om_explicit_sticker_request',
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 发一个夸人的表情包' }),
        create_time: String(Date.now()),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小虾米' },
        ],
      },
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    await inbound.prepareForAgent?.();
    assert.equal(inbound.attachments?.length, 1);
    assert.equal(inbound.attachments?.[0]?.id, 'sticker_praise_candidate');
    assert.equal((inbound.raw as any)?.feishuStickerLibraryContext?.attachedImageCount, 1);
    assert.equal((inbound.raw as any)?.feishuStickerLibraryContext?.preferredFileKey, 'sticker_praise_candidate');
    assert.match((inbound.raw as any)?.feishuStickerLibraryContext?.prompt || '', /candidate sticker images/i);
    assert.match((inbound.raw as any)?.feishuStickerLibraryContext?.prompt || '', /sticker_praise_candidate/);
    assert.match((inbound.raw as any)?.feishuStickerLibraryContext?.prompt || '', /合适/);
  });

  it('records older sticker history pages without downloading send candidates', async () => {
    useTempCtiHome();
    const store = createMockStore({ bridge_feishu_bot_aliases: '小虾米' }) as any;
    store.getFeishuHistorySyncStatus = () => [{ latestMessageTime: '2000', messageCount: 2 }];
    store.upsertFeishuHistoryMessages = () => null;
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = new FeishuAdapter() as any;
    adapter.botIds.add('ou_bot');
    adapter.resolveChatDisplayName = async () => '群聊';
    adapter.persistChatIndex = () => {};
    adapter.fetchChatMemberNames = async () => new Map([['ou_sender', '刘丹']]);
    adapter.downloadResource = async (_messageId: string, fileKey: string) => ({
      id: fileKey,
      name: `${fileKey}.png`,
      type: 'image/png',
      size: 4,
      data: Buffer.from(fileKey).toString('base64'),
    });
    adapter.fetchMessagePage = async (_chatId: string, pageToken: string) => {
      if (pageToken === 'older') {
        return {
          items: [{
            message_id: 'om_older_sticker',
            chat_id: 'oc_group',
            create_time: '1000',
            msg_type: 'sticker',
            body: { content: JSON.stringify({ file_key: 'sticker_older_candidate' }) },
            sender: { id: 'ou_sender', sender_type: 'user' },
          }],
          hasMore: false,
          nextPageToken: '',
        };
      }
      return {
        items: [{
          message_id: 'om_recent_text',
          chat_id: 'oc_group',
          create_time: '1500',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: '旧文本' }) },
          sender: { id: 'ou_sender', sender_type: 'user' },
        }],
        hasMore: true,
        nextPageToken: 'older',
      };
    };

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user', user_id: 'u_user', union_id: 'on_user' },
      },
      message: {
        message_id: 'om_explicit_older_sticker_request',
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 发一个合适的表情包' }),
        create_time: String(Date.now()),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小虾米' },
        ],
      },
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    await inbound.prepareForAgent?.();
    assert.equal(inbound.attachments?.length || 0, 0);
    assert.equal((inbound.raw as any)?.feishuStickerLibraryContext?.attachedImageCount, 0);
    assert.match((inbound.raw as any)?.feishuStickerLibraryContext?.prompt || '', /sticker_older_candidate/);
  });

  it('uses the sticker history backfill marker until the indexed history watermark changes', async () => {
    const ctiHome = useTempCtiHome();
    let latestMessageTime = '2000';
    const store = createMockStore({ bridge_feishu_bot_aliases: '小虾米' }) as any;
    store.getFeishuHistorySyncStatus = () => [{ latestMessageTime, messageCount: 2 }];
    store.upsertFeishuHistoryMessages = () => null;
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = new FeishuAdapter() as any;
    adapter.botIds.add('ou_bot');
    adapter.resolveChatDisplayName = async () => '群聊';
    adapter.persistChatIndex = () => {};
    adapter.fetchChatMemberNames = async () => new Map([['ou_sender', '刘丹']]);
    adapter.downloadResource = async (_messageId: string, fileKey: string) => ({
      id: fileKey,
      name: `${fileKey}.png`,
      type: 'image/png',
      size: 4,
      data: Buffer.from(fileKey).toString('base64'),
    });
    let fullSyncCalls = 0;
    let activeSyncIsFull = false;
    const originalSyncIndexedChatHistory = adapter.syncIndexedChatHistory.bind(adapter);
    adapter.syncIndexedChatHistory = async (...args: any[]) => {
      activeSyncIsFull = args[3] === true;
      if (activeSyncIsFull) fullSyncCalls += 1;
      try {
        return await originalSyncIndexedChatHistory(...args);
      } finally {
        activeSyncIsFull = false;
      }
    };
    let fetchPageCalls = 0;
    adapter.fetchMessagePage = async () => {
      fetchPageCalls += 1;
      if (!activeSyncIsFull) {
        return {
          items: [{
            message_id: `om_text_${fetchPageCalls}`,
            chat_id: 'oc_group',
            create_time: String(1000 + fetchPageCalls),
            msg_type: 'text',
            body: { content: JSON.stringify({ text: '普通聊天上下文' }) },
            sender: { id: 'ou_sender', sender_type: 'user' },
          }],
          hasMore: false,
          nextPageToken: '',
        };
      }
      return {
        items: [{
          message_id: `om_sticker_${fetchPageCalls}`,
          chat_id: 'oc_group',
          create_time: String(1000 + fetchPageCalls),
          msg_type: 'sticker',
          body: { content: JSON.stringify({ file_key: `sticker_backfill_${fetchPageCalls}` }) },
          sender: { id: 'ou_sender', sender_type: 'user' },
        }],
        hasMore: false,
        nextPageToken: '',
      };
    };
    const sendExplicitStickerRequest = (messageId: string) => adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user', user_id: 'u_user', union_id: 'on_user' },
      },
      message: {
        message_id: messageId,
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 发一个合适的表情包' }),
        create_time: String(Date.now()),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小虾米' },
        ],
      },
    });

    await sendExplicitStickerRequest('om_explicit_backfill_once_1');
    await (await adapter.consumeOne())?.prepareForAgent?.();
    assert.equal(fullSyncCalls, 1);
    let stickerStore = JSON.parse(fs.readFileSync(getTestFeishuStickerStorePath(ctiHome), 'utf8'));
    assert.equal(stickerStore.historyBackfills?.oc_group?.latestMessageTime, '2000');
    assert.equal(stickerStore.historyBackfills?.oc_group?.candidateCount, 1);

    await sendExplicitStickerRequest('om_explicit_backfill_once_2');
    await (await adapter.consumeOne())?.prepareForAgent?.();
    assert.equal(fullSyncCalls, 1);

    latestMessageTime = '3000';
    await sendExplicitStickerRequest('om_explicit_backfill_changed_3');
    await (await adapter.consumeOne())?.prepareForAgent?.();
    assert.equal(fullSyncCalls, 2);
    stickerStore = JSON.parse(fs.readFileSync(getTestFeishuStickerStorePath(ctiHome), 'utf8'));
    assert.equal(stickerStore.historyBackfills?.oc_group?.latestMessageTime, '3000');
    assert.equal(stickerStore.historyBackfills?.oc_group?.candidateCount, 2);
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

  it('persists original task and final result for a finalized streaming card', async () => {
    const storedRefs: any[] = [];
    const store = createMockStore({ bridge_feishu_streaming_card_enabled: 'true' }) as any;
    store.insertOutboundRef = (ref: unknown) => storedRefs.push(ref);
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card_v1' } }),
            settings: async () => ({ data: {} }),
            update: async () => ({ data: {} }),
          },
          cardElement: {
            content: async () => ({ data: {} }),
          },
        },
      },
      im: {
        message: {
          create: async () => ({ data: { message_id: 'om_streaming_card' } }),
          reply: async () => ({ data: { message_id: 'om_streaming_card' } }),
        },
      },
    };

    assert.equal(await adapter._doCreateStreamingCard('oc_group', 'om_user'), true);
    assert.equal(await adapter.finalizeCard(
      'oc_group',
      'error',
      '未完成：当前接口缺少机器人身份证据。',
      undefined,
      [],
      undefined,
      {
        codepilotSessionId: 'session_original_task',
        sourceMessageId: 'om_user',
        sourceText: '查看当前群里的机器人。',
      },
    ), true);

    assert.equal(storedRefs.length, 1);
    assert.equal(storedRefs[0].platformMessageId, 'om_streaming_card');
    assert.equal(storedRefs[0].codepilotSessionId, 'session_original_task');
    assert.match(storedRefs[0].continuationContext, /查看当前群里的机器人/);
    assert.match(storedRefs[0].continuationContext, /当前接口缺少机器人身份证据/);
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
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
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
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
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
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
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
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
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
          annotationSource: 'manual',
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
          annotationSource: 'manual',
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

  it('uses an annotated sticker for a bare sticker hint even when the reply text is lightweight', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [
        {
          fileKey: 'sticker_unknown',
          aliases: ['表情包'],
          chatId: 'oc_group',
          firstSeenAt: '2026-06-06T05:00:00.000Z',
          lastSeenAt: '2026-06-06T05:10:00.000Z',
          useCount: 0,
        },
        {
          fileKey: 'sticker_welcome',
          aliases: ['表情包', '来啦'],
          chatId: 'oc_group',
          label: '来啦',
          intent: '轻松回应、打招呼、表示我来了',
          tone: 'friendly playful',
          usage: '用户让发个表情或轻松接话时使用',
          annotationSource: 'manual',
          annotationConfidence: 0.9,
          firstSeenAt: '2026-06-06T06:00:00.000Z',
          lastSeenAt: '2026-06-06T06:10:00.000Z',
          useCount: 0,
        },
      ],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: any[] = [];

    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(payload);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[表情包] 来啦~',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.equal(result.ok, true);
    const stickerCall = calls.find((item) => item.data?.msg_type === 'sticker');
    const stickerContent = JSON.parse(String(stickerCall?.data?.content || '{}')) as { file_key?: string };
    assert.equal(stickerContent.file_key, 'sticker_welcome');
  });

  it('uses an annotated sticker for explicit generic light replies even without text overlap', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [
        {
          fileKey: 'sticker_unannotated_recent',
          aliases: ['\u8868\u60c5\u5305'],
          chatId: 'oc_group',
          firstSeenAt: '2026-06-06T07:00:00.000Z',
          lastSeenAt: '2026-06-06T07:10:00.000Z',
          useCount: 0,
        },
        {
          fileKey: 'sticker_generic_annotated',
          aliases: ['\u8868\u60c5\u5305', 'hello'],
          chatId: 'oc_group',
          label: 'friendly wave',
          intent: 'friendly greeting and casual acknowledgement',
          tone: 'friendly playful',
          usage: 'use for light chat and casual replies',
          annotationSource: 'manual',
          annotationConfidence: 0.86,
          firstSeenAt: '2026-06-06T06:00:00.000Z',
          lastSeenAt: '2026-06-06T06:10:00.000Z',
          useCount: 0,
        },
      ],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: any[] = [];

    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card_v1' } }),
            settings: async () => ({ data: {} }),
            update: async (payload: unknown) => {
              calls.push({ kind: 'card.update', payload });
              return { data: {} };
            },
          },
          cardElement: { content: async () => ({ data: {} }) },
        },
      },
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push({ kind: 'message.reply', payload });
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const created = await adapter._doCreateStreamingCard('oc_group', 'om_user');
    const finalized = await adapter.finalizeCard('oc_group', 'completed', '[\u8868\u60c5\u5305] \u6765\u5566\u6765\u5566~');

    assert.equal(created, true);
    assert.equal(finalized, true);
    const stickerCall = calls
      .map((item) => item.payload as { data?: { content?: string; msg_type?: string } })
      .find((item) => item.data?.msg_type === 'sticker');
    const stickerContent = JSON.parse(String(stickerCall?.data?.content || '{}')) as { file_key?: string };
    assert.equal(stickerContent.file_key, 'sticker_generic_annotated');
  });

  it('sends an unannotated sticker in a streaming card only when bridge supplies a matching verified action', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [{
        fileKey: 'v3_00hg_c4f0b103-b57a-4d49-8bed-19993e36aadg',
        aliases: ['表情包'],
        chatId: 'oc_group',
        firstSeenAt: '2026-07-11T00:00:00.000Z',
        lastSeenAt: '2026-07-11T00:00:00.000Z',
        useCount: 0,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: Array<{ kind: string; payload: any }> = [];
    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card_v1' } }),
            settings: async () => ({ data: {} }),
            update: async (payload: unknown) => {
              calls.push({ kind: 'card.update', payload });
              return { data: {} };
            },
          },
          cardElement: { content: async () => ({ data: {} }) },
        },
      },
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push({ kind: 'message.reply', payload });
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    assert.equal(await adapter._doCreateStreamingCard('oc_group', 'om_user'), true);
    assert.equal(await adapter.finalizeCard(
      'oc_group',
      'completed',
      '[表情包:v3_00hg_c4f0b103-b57a-4d49-8bed-19993e36aadg] 来啦～',
      undefined,
      [],
      {
        kind: 'sticker',
        key: 'v3_00hg_c4f0b103-b57a-4d49-8bed-19993e36aadg',
        provenance: 'turn_attached_model_selection',
      },
    ), true);

    const stickerCall = calls
      .map((item) => item.payload as { data?: { content?: string; msg_type?: string } })
      .find((item) => item.data?.msg_type === 'sticker');
    const stickerContent = JSON.parse(String(stickerCall?.data?.content || '{}')) as { file_key?: string };
    assert.equal(stickerContent.file_key, 'v3_00hg_c4f0b103-b57a-4d49-8bed-19993e36aadg');
  });

  it('does not use a mismatched annotated fallback when the reply has a clear sticker meaning', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [{
        fileKey: 'sticker_mocking_clown',
        aliases: ['表情包', '小丑'],
        chatId: 'oc_group',
        label: '小丑吐槽',
        intent: '嘲讽、尴尬、反讽、整活',
        tone: 'mocking sarcastic',
        usage: '别人自嘲或吐槽离谱场面时使用',
        annotationConfidence: 0.9,
        firstSeenAt: '2026-06-06T06:00:00.000Z',
        lastSeenAt: '2026-06-06T06:10:00.000Z',
        useCount: 0,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: any[] = [];

    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(payload);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[表情包] 真棒呀',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.equal(result.ok, true);
    assert.ok(!calls.some((item) => item.data?.msg_type === 'sticker'));
  });

  it('does not let exact sticker file keys bypass trusted semantic records', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [
        {
          fileKey: 'file_v2_user_claim_only',
          aliases: ['表情包', '真棒'],
          chatId: 'oc_group',
          label: '真棒',
          intent: '用户口头说是真棒',
          annotationSource: 'user',
          firstSeenAt: '2026-06-06T06:00:00.000Z',
          lastSeenAt: '2026-06-06T06:10:00.000Z',
          useCount: 0,
        },
        {
          fileKey: 'file_v2_low_confidence',
          aliases: ['表情包', '不确定'],
          chatId: 'oc_group',
          label: '不确定',
          intent: '画面太模糊，无法确认语义',
          annotationSource: 'vision',
          visionMediaFileKey: 'file_v2_low_confidence',
          annotationConfidence: 0.2,
          firstSeenAt: '2026-06-06T06:00:00.000Z',
          lastSeenAt: '2026-06-06T06:10:00.000Z',
          useCount: 0,
        },
      ],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: any[] = [];

    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(payload);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const userOnlyResult = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[表情包:file_v2_user_claim_only] 不拿未核验解释乱发。',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });
    const lowConfidenceResult = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[表情包:file_v2_low_confidence] 看不清就先文字回复。',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.equal(userOnlyResult.ok, true);
    assert.equal(lowConfidenceResult.ok, true);
    assert.ok(!calls.some((item) => item.data?.msg_type === 'sticker'));
  });

  it('does not auto-send legacy source-less sticker semantics without verification', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [{
        fileKey: 'file_v2_legacy_source_less',
        aliases: ['表情包', '真棒'],
        chatId: 'oc_group',
        label: '真棒',
        intent: '表示真棒、点赞',
        tone: 'positive playful',
        usage: '夸人时使用',
        annotationConfidence: 0.9,
        firstSeenAt: '2026-06-06T06:00:00.000Z',
        lastSeenAt: '2026-06-06T06:10:00.000Z',
        useCount: 0,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: any[] = [];

    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(payload);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[表情包:file_v2_legacy_source_less] 这个旧语义没有来源，先不自动发。',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.equal(result.ok, true);
    assert.ok(!calls.some((item) => item.data?.msg_type === 'sticker'));
  });

  it('does not auto-send vision sticker semantics when confidence is missing', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [{
        fileKey: 'file_v2_vision_without_confidence',
        aliases: ['表情包', '轻松'],
        chatId: 'oc_group',
        label: '轻松表情',
        intent: '轻松回应',
        tone: 'casual',
        usage: '轻松接话时使用',
        annotationSource: 'vision',
        visionMediaFileKey: 'file_v2_vision_without_confidence',
        firstSeenAt: '2026-06-06T06:00:00.000Z',
        lastSeenAt: '2026-06-06T06:10:00.000Z',
        useCount: 0,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: any[] = [];

    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(payload);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const prompt = adapter.getStickerPresentationPrompt('oc_group');
    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[表情包:file_v2_vision_without_confidence] 缺置信度不自动发。',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.match(prompt, /No semantically annotated stickers are available/);
    assert.equal(result.ok, true);
    assert.ok(!calls.some((item) => item.data?.msg_type === 'sticker'));
  });

  it('does not auto-send stored sticker semantics that are only generic words', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [{
        fileKey: 'file_v2_generic_words',
        aliases: ['表情包'],
        chatId: 'oc_group',
        label: '表情包',
        description: '一张表情包',
        intent: '发个表情包',
        usage: '用于回复聊天',
        annotationSource: 'manual',
        firstSeenAt: '2026-06-06T06:00:00.000Z',
        lastSeenAt: '2026-06-06T06:10:00.000Z',
        useCount: 0,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: any[] = [];

    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(payload);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const prompt = adapter.getStickerPresentationPrompt('oc_group');
    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[表情包:file_v2_generic_words] 泛泛语义不自动发。',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.match(prompt, /No semantically annotated stickers are available/);
    assert.equal(result.ok, true);
    assert.ok(!calls.some((item) => item.data?.msg_type === 'sticker'));
  });

  it('allows exact sticker file keys only after trusted visual or manual semantics exist', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [{
        fileKey: 'file_v2_trusted_sticker',
        aliases: ['表情包', '来啦'],
        chatId: 'oc_group',
        label: '轻松出现',
        intent: '轻松回应、打招呼、表示我来了',
        tone: 'friendly playful',
        usage: '用户让随便发个表情包或轻松接话时使用',
        annotationSource: 'vision',
        visionMediaFileKey: 'file_v2_trusted_sticker',
        annotationConfidence: 0.82,
        firstSeenAt: '2026-06-06T06:00:00.000Z',
        lastSeenAt: '2026-06-06T06:10:00.000Z',
        useCount: 0,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: any[] = [];

    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(payload);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[表情包:file_v2_trusted_sticker] 来啦~',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.equal(result.ok, true);
    const stickerCall = calls.find((item) => item.data?.msg_type === 'sticker');
    const stickerContent = JSON.parse(String(stickerCall?.data?.content || '{}')) as { file_key?: string };
    assert.equal(stickerContent.file_key, 'file_v2_trusted_sticker');
  });

  it('treats a model legacy 表情 hint as a sticker action when its alias has trusted semantics', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [{
        fileKey: 'file_v2_trusted_laugh',
        aliases: ['表情包', '大笑'],
        chatId: 'oc_group',
        label: '开心大笑',
        intent: '轻松回应开心的消息',
        tone: '开心轻松',
        usage: '轻松闲聊时使用',
        annotationSource: 'vision',
        visionMediaFileKey: 'file_v2_trusted_laugh',
        annotationConfidence: 0.86,
        firstSeenAt: '2026-06-06T06:00:00.000Z',
        lastSeenAt: '2026-06-06T06:10:00.000Z',
        useCount: 0,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: any[] = [];
    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(payload);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[表情:大笑] 表情包发射~',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.equal(result.ok, true);
    const stickerCall = calls.find((item) => item.data?.msg_type === 'sticker');
    const stickerContent = JSON.parse(String(stickerCall?.data?.content || '{}')) as { file_key?: string };
    assert.equal(stickerContent.file_key, 'file_v2_trusted_laugh');
  });

  it('falls back to direct chat sticker send when reply-scoped sticker send fails during card finalization', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [{
        fileKey: 'sticker_generic_annotated',
        aliases: ['表情包', 'hello'],
        chatId: 'oc_group',
        label: 'friendly wave',
        intent: 'friendly greeting and casual acknowledgement',
        tone: 'friendly playful',
        usage: 'use for light chat and casual replies',
        annotationSource: 'manual',
        annotationConfidence: 0.86,
        firstSeenAt: '2026-06-06T06:00:00.000Z',
        lastSeenAt: '2026-06-06T06:10:00.000Z',
        useCount: 0,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: any[] = [];

    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'card_v1' } }),
            settings: async () => ({ data: {} }),
            update: async (payload: unknown) => {
              calls.push({ kind: 'card.update', payload });
              return { data: {} };
            },
          },
          cardElement: { content: async () => ({ data: {} }) },
        },
      },
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push({ kind: 'message.reply', payload });
            if ((payload as { data?: { msg_type?: string } })?.data?.msg_type !== 'sticker') {
              return { data: { message_id: 'om_card' } };
            }
            throw Object.assign(new Error('reply sticker not accepted'), { code: 230001 });
          },
          create: async (payload: unknown) => {
            calls.push({ kind: 'message.create', payload });
            return { data: { message_id: 'om_sticker_direct' } };
          },
        },
      },
    };

    const created = await adapter._doCreateStreamingCard('oc_group', 'om_user');
    const finalized = await adapter.finalizeCard('oc_group', 'completed', '[表情包] 好呀，给你一个~');

    assert.equal(created, true);
    assert.equal(finalized, true);
    const replyStickerCall = calls.find((item) =>
      item.kind === 'message.reply' && item.payload?.data?.msg_type === 'sticker'
    );
    assert.equal(replyStickerCall?.payload?.data?.msg_type, 'sticker');
    const directStickerCall = calls.find((item) => item.kind === 'message.create');
    assert.equal(directStickerCall?.payload?.data?.receive_id, 'oc_group');
    assert.equal(directStickerCall?.payload?.data?.msg_type, 'sticker');
    const stickerContent = JSON.parse(String(directStickerCall?.payload?.data?.content || '{}')) as { file_key?: string };
    assert.equal(stickerContent.file_key, 'sticker_generic_annotated');
  });

  it('matches colloquial Chinese particles before falling back to generic annotated stickers', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [
        {
          fileKey: 'sticker_high_confidence_party',
          aliases: ['表情包', '开心', '应援'],
          chatId: 'oc_group',
          label: '开心应援',
          intent: '表达开心、加油、庆祝、赞同或活跃气氛',
          tone: '兴奋、可爱、热闹',
          usage: '对方完成好事、需要鼓励、想活跃气氛或表达支持时使用',
          annotationSource: 'vision',
          visionMediaFileKey: 'sticker_high_confidence_party',
          annotationConfidence: 0.95,
          firstSeenAt: '2026-06-06T06:00:00.000Z',
          lastSeenAt: '2026-06-06T06:10:00.000Z',
          useCount: 0,
        },
        {
          fileKey: 'sticker_arrived_wave',
          aliases: ['表情包', '挥手', '打招呼', '我来了'],
          chatId: 'oc_group',
          label: '挥手打招呼',
          intent: '打招呼、表示我来了、轻松回应或缓和气氛',
          tone: '可爱、友好、轻松',
          usage: '开场问候、轻松接话、表示收到或弱弱出现时使用',
          annotationSource: 'vision',
          visionMediaFileKey: 'sticker_arrived_wave',
          annotationConfidence: 0.78,
          firstSeenAt: '2026-06-06T05:00:00.000Z',
          lastSeenAt: '2026-06-06T05:10:00.000Z',
          useCount: 0,
        },
      ],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;
    const calls: any[] = [];

    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: unknown) => {
            calls.push(payload);
            return { data: { message_id: 'om_reply' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user' },
      text: '[表情包] 来啦来啦~',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.equal(result.ok, true);
    const stickerCall = calls.find((item) => item.data?.msg_type === 'sticker');
    const stickerContent = JSON.parse(String(stickerCall?.data?.content || '{}')) as { file_key?: string };
    assert.equal(stickerContent.file_key, 'sticker_arrived_wave');
  });

  it('excludes disabled and avoidWhen-matched stickers from bare hint selection', async () => {
    const ctiHome = useTempCtiHome();
    fs.mkdirSync(path.join(ctiHome, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
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
          annotationSource: 'manual',
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
          annotationSource: 'manual',
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
          annotationSource: 'manual',
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
    fs.writeFileSync(getTestFeishuStickerStorePath(ctiHome), JSON.stringify({
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
    const store = JSON.parse(fs.readFileSync(getTestFeishuStickerStorePath(), 'utf8'));
    assert.equal(store.stickers[0].fileKey, 'sticker_file_key');
  });

  it('preserves enriched sticker records when history-only keys exceed the store cap', () => {
    const storePath = getTestFeishuStickerStorePath();
    fs.writeFileSync(storePath, JSON.stringify({
      version: 1,
      updatedAt: '2026-07-14T00:00:00.000Z',
      stickers: [
        {
          fileKey: 'trusted_old_sticker',
          aliases: ['表情包', '挥手'],
          chatId: 'oc_group',
          messageId: 'om_trusted_old',
          label: '挥手打招呼',
          intent: '打招呼、来啦',
          annotationSource: 'vision',
          visionMediaFileKey: 'trusted_old_sticker',
          annotationConfidence: 0.88,
          annotationVerifiedAt: '2026-07-13T00:00:00.000Z',
          firstSeenAt: '2026-07-13T00:00:00.000Z',
          lastSeenAt: '2026-07-13T00:00:00.000Z',
          useCount: 0,
        },
        {
          fileKey: 'cached_old_sticker',
          aliases: ['表情包'],
          chatId: 'oc_group',
          messageId: 'om_cached_old',
          mediaCachedAt: '2026-07-13T00:00:00.000Z',
          mediaMimeType: 'image/png',
          mediaSize: 1024,
          firstSeenAt: '2026-07-13T00:00:00.000Z',
          lastSeenAt: '2026-07-13T00:00:00.000Z',
          useCount: 0,
        },
        {
          fileKey: 'user_evidence_old_sticker',
          aliases: ['表情包'],
          chatId: 'oc_group',
          messageId: 'om_user_evidence_old',
          annotationSource: 'user',
          userAnnotation: {
            intent: '用户说这是疑惑',
            updatedAt: '2026-07-13T00:00:00.000Z',
          },
          firstSeenAt: '2026-07-13T00:00:00.000Z',
          lastSeenAt: '2026-07-13T00:00:00.000Z',
          useCount: 0,
        },
      ],
    }, null, 2), 'utf8');

    const adapter = new FeishuAdapter() as any;
    for (let index = 0; index < 120; index += 1) {
      adapter.rememberSticker({
        fileKey: `history_only_${index}`,
        chatId: 'oc_group',
        userId: 'ou_user',
        messageId: `om_history_only_${index}`,
      });
    }

    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const keys = new Set(store.stickers.map((item: any) => item.fileKey));
    assert.equal(store.stickers.length, 80);
    assert.ok(keys.has('trusted_old_sticker'), 'trusted sticker semantics must not be evicted by history-only keys');
    assert.ok(keys.has('cached_old_sticker'), 'cached sticker media must not be evicted by history-only keys');
    assert.ok(keys.has('user_evidence_old_sticker'), 'user evidence awaiting visual verification must not be evicted by history-only keys');
  });

  it('does not re-register a permanently deleted sticker from later history or inbound events', () => {
    const storePath = getTestFeishuStickerStorePath();
    fs.writeFileSync(storePath, JSON.stringify({
      version: 1,
      updatedAt: '2026-07-16T00:00:00.000Z',
      stickers: [],
      deletedStickers: {
        sticker_deleted: {
          deletedAt: '2026-07-16T00:00:00.000Z',
          source: 'control-panel',
        },
      },
    }, null, 2), 'utf8');
    const adapter = new FeishuAdapter() as any;

    adapter.rememberSticker({
      fileKey: 'sticker_deleted',
      chatId: 'oc_group',
      userId: 'ou_user',
      messageId: 'om_history_replay',
    });

    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(store.stickers.length, 0);
    assert.equal(store.deletedStickers.sticker_deleted.source, 'control-panel');
  });

  it('excludes archived stickers from prompts and exact or generic send selection', () => {
    const storePath = getTestFeishuStickerStorePath();
    fs.writeFileSync(storePath, JSON.stringify({
      version: 1,
      updatedAt: '2026-07-16T00:00:00.000Z',
      stickers: [
        {
          fileKey: 'sticker_archived',
          aliases: ['表情包', '归档候选'],
          chatId: 'oc_group',
          label: '归档候选',
          intent: '确认、收到',
          usage: '轻量确认时',
          annotationSource: 'manual',
          annotationVerifiedAt: '2026-07-16T00:00:00.000Z',
          archived: true,
          archivedAt: '2026-07-16T00:00:00.000Z',
          firstSeenAt: '2026-07-15T00:00:00.000Z',
          lastSeenAt: '2026-07-16T00:00:00.000Z',
          useCount: 0,
        },
        {
          fileKey: 'sticker_active',
          aliases: ['表情包', '可用候选'],
          chatId: 'oc_group',
          label: '可用候选',
          intent: '确认、收到',
          usage: '轻量确认时',
          annotationSource: 'manual',
          annotationVerifiedAt: '2026-07-16T00:00:00.000Z',
          firstSeenAt: '2026-07-15T00:00:00.000Z',
          lastSeenAt: '2026-07-15T23:00:00.000Z',
          useCount: 0,
        },
      ],
    }, null, 2), 'utf8');
    const adapter = new FeishuAdapter() as any;

    const prompt = adapter.getStickerPresentationPrompt('oc_group');

    assert.doesNotMatch(prompt, /sticker_archived|归档候选/);
    assert.equal(adapter.resolveStickerFileKey('sticker_archived', 'oc_group', '收到'), null);
    assert.equal(adapter.resolveStickerFileKey('表情包', 'oc_group', '收到'), 'sticker_active');
  });

  it('downloads a newly seen sticker once into memory and reuses it by file key', async () => {
    let downloadCount = 0;
    const mediaData = Buffer.from('downloaded-sticker-image');
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.restClient = {
      im: {
        messageResource: {
          get: async (payload: any) => {
            downloadCount += 1;
            assert.equal(payload.params.type, 'image');
            return {
              getReadableStream: () => Readable.from([mediaData]),
            };
          },
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
    assert.equal(downloadCount, 1);
    assert.equal(inbound?.messageKind, 'feishu_sticker_image');
    assert.equal((inbound?.raw as any)?.sticker?.imageAvailable, true);
    assert.equal(inbound?.attachments?.[0]?.data, mediaData.toString('base64'));

    const mediaPath = path.join(
      process.env.CTI_MEMORY_REPO_DIR!,
      'data',
      'im',
      'feishu',
      'stickers',
      'media',
      MemoryArtifactStore.stableFileName('sticker_file_key', '.png'),
    );
    assert.equal(fs.readFileSync(mediaPath).toString('utf8'), mediaData.toString('utf8'));

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
        create_time: '1710000001000',
      },
    });
    const second = await adapter.consumeOne();
    assert.equal(downloadCount, 1);
    assert.equal(second?.messageKind, 'feishu_sticker_image');
    assert.equal(second?.attachments?.[0]?.data, mediaData.toString('base64'));
    const store = JSON.parse(fs.readFileSync(getTestFeishuStickerStorePath(), 'utf8'));
    assert.equal(store.stickers.length, 1);
    assert.equal(store.stickers[0].fileKey, 'sticker_file_key');
  });

  it('recovers sticker semantics from the latest valid backup when the store is transiently corrupted', async () => {
    const fileKey = 'sticker_file_key';
    writeTestStickerMedia(fileKey, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const storePath = getTestFeishuStickerStorePath();
    fs.writeFileSync(`${storePath}.bak`, JSON.stringify({
      version: 1,
      updatedAt: '2026-07-13T00:00:00.000Z',
      stickers: [{
        fileKey,
        aliases: ['最近', '默认', '表情包', '挥手'],
        chatId: 'oc_chat',
        label: '挥手打招呼',
        description: '一张小动物挥手的表情包',
        intent: '打招呼、表示我来了',
        tone: '可爱、轻松',
        usage: '开场问候或轻松接话时使用',
        annotationSource: 'vision',
        visionMediaFileKey: fileKey,
        annotationConfidence: 0.86,
        annotationVerifiedAt: '2026-07-13T00:00:00.000Z',
        firstSeenAt: '2026-07-13T00:00:00.000Z',
        lastSeenAt: '2026-07-13T00:00:00.000Z',
        useCount: 0,
      }],
    }), 'utf8');
    fs.writeFileSync(storePath, '{ "version": 1, "stickers": [', 'utf8');
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.restClient = {
      im: {
        messageResource: {
          get: async () => {
            throw new Error('cached sticker media should be reused from memory');
          },
        },
      },
    };

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user' },
      },
      message: {
        message_id: 'om_sticker_after_partial_write',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: fileKey }),
        create_time: '1710000001000',
      },
    });

    const inbound = await adapter.consumeOne();
    assert.equal(inbound?.messageKind, 'feishu_sticker_image');
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(store.stickers.length, 1);
    assert.equal(store.stickers[0].fileKey, fileKey);
    assert.equal(store.stickers[0].label, '挥手打招呼');
    assert.equal(store.stickers[0].annotationSource, 'vision');
    assert.equal(store.stickers[0].annotationConfidence, 0.86);
    assert.deepEqual(store.stickers[0].aliases, ['最近', '默认', '表情包', '挥手']);
  });

  it('avoids repeated inbound sticker downloads during the resource-error cooldown', async () => {
    let downloadCount = 0;
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.restClient = {
      im: {
        messageResource: {
          get: async () => {
            downloadCount += 1;
            throw new Error('Feishu rejected sticker resource');
          },
        },
      },
    };

    const createStickerEvent = (messageId: string) => ({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user' },
      },
      message: {
        message_id: messageId,
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: 'sticker_file_key' }),
        create_time: '1710000000000',
      },
    });

    await adapter.processIncomingEvent(createStickerEvent('om_sticker_1'));
    await adapter.processIncomingEvent(createStickerEvent('om_sticker_2'));

    const first = await adapter.consumeOne();
    const second = await adapter.consumeOne();
    assert.equal(downloadCount, 1);
    assert.equal(first?.messageKind, 'feishu_sticker_unknown');
    assert.equal(second?.messageKind, 'feishu_sticker_unknown');
    assert.equal(first?.attachments?.length || 0, 0);
    assert.equal(second?.attachments?.length || 0, 0);
    const store = JSON.parse(fs.readFileSync(getTestFeishuStickerStorePath(), 'utf8'));
    assert.equal(store.stickers.length, 1);
    assert.match(store.stickers[0].mediaDownloadFailedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('retries a sticker media download after the retry window expires', async () => {
    const fileKey = 'sticker_file_key';
    const failedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
      version: 1,
      updatedAt: failedAt,
      stickers: [{
        fileKey,
        aliases: ['最近', '默认', '表情包'],
        chatId: 'oc_chat',
        messageId: 'om_deleted_resource',
        firstSeenAt: failedAt,
        lastSeenAt: failedAt,
        useCount: 0,
        mediaDownloadFailedAt: failedAt,
        mediaDownloadError: 'Feishu message resource API did not return sticker media',
      }],
    }), 'utf8');
    let downloadCount = 0;
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.restClient = {
      im: {
        messageResource: {
          get: async () => {
            downloadCount += 1;
            return { getReadableStream: () => Readable.from([Buffer.from('should-not-download')]) };
          },
        },
      },
    };

    await adapter.processIncomingEvent({
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
      message: {
        message_id: 'om_sticker_recovered',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: fileKey }),
        create_time: String(Date.now()),
      },
    });

    const inbound = await adapter.consumeOne();
    assert.equal(inbound?.messageKind, 'feishu_sticker_image');
    assert.equal(inbound?.attachments?.[0]?.data, Buffer.from('should-not-download').toString('base64'));
    assert.equal(downloadCount, 1);
    const store = JSON.parse(fs.readFileSync(getTestFeishuStickerStorePath(), 'utf8'));
    assert.equal(store.stickers[0].mediaDownloadFailedAt, undefined);
  });

  it('uses stored memory sticker media as image attachments', async () => {
    const mediaData = Buffer.from('stored-sticker-image');
    writeTestStickerMedia('sticker_file_key', mediaData);
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.restClient = {
      im: {
        messageResource: {
          get: async () => {
            throw new Error('sticker resources should come from memory media');
          },
        },
      },
    };

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user', user_id: 'u_user', union_id: 'on_user' },
      },
      message: {
        message_id: 'om_sticker_file_fallback',
        chat_id: 'oc_p2p',
        chat_type: 'p2p',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: 'sticker_file_key' }),
        create_time: String(Date.now()),
      },
    });

    const inbound = await adapter.consumeOne();
    assert.equal(inbound?.messageKind, 'feishu_sticker_image');
    assert.match(inbound?.text || '', /记忆仓库中已有该表情包图片/);
    assert.equal(inbound?.attachments?.[0]?.type, 'image/png');
    assert.equal(inbound?.attachments?.[0]?.data, mediaData.toString('base64'));
  });

  it('sniffs legacy sticker cache bytes instead of trusting the .png extension', async () => {
    const jpegData = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
      Buffer.from('legacy-jpeg-sticker'),
    ]);
    writeTestStickerMedia('legacy_jpeg_sticker', jpegData);
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.restClient = {
      im: {
        messageResource: {
          get: async () => {
            throw new Error('legacy sticker media should be reused from memory');
          },
        },
      },
    };

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user', user_id: 'u_user', union_id: 'on_user' },
      },
      message: {
        message_id: 'om_legacy_jpeg_sticker',
        chat_id: 'oc_p2p',
        chat_type: 'p2p',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: 'legacy_jpeg_sticker' }),
        create_time: String(Date.now()),
      },
    });

    const inbound = await adapter.consumeOne();

    assert.equal(inbound?.messageKind, 'feishu_sticker_image');
    assert.equal(inbound?.attachments?.[0]?.type, 'image/jpeg');
    assert.equal(inbound?.attachments?.[0]?.name, 'sticker-legacy_jpeg_sticker.jpg');
    assert.equal(inbound?.attachments?.[0]?.data, jpegData.toString('base64'));
  });

  it('does not import workspace upload-cache images into the sticker memory library', async () => {
    const fileKey = 'v3_00cache_11111111-2222-4333-8444-55555555555g';
    const mediaData = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(2048, 7),
    ]);
    const workspace = path.join(process.env.CTI_HOME!, 'workspace');
    const uploadsDir = path.join(workspace, '.codepilot-uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, `1783000000000-sticker-candidate-${fileKey}.png`), mediaData);
    setupContext({ bridge_default_work_dir: workspace });
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
      version: 1,
      updatedAt: '2026-07-10T00:00:00.000Z',
      stickers: [{
        fileKey,
        aliases: ['最近', '默认', '表情包'],
        chatId: 'oc_chat',
        userId: 'ou_user',
        messageId: 'om_sticker',
        firstSeenAt: '2026-07-10T00:00:00.000Z',
        lastSeenAt: '2026-07-10T00:00:00.000Z',
        useCount: 0,
        mediaDownloadFailedAt: '2026-07-10T00:01:00.000Z',
        mediaDownloadError: 'previous platform rejection',
      }],
    }), 'utf8');

    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    let downloadCount = 0;
    adapter.restClient = {
      im: {
        messageResource: {
          get: async () => {
            downloadCount += 1;
            throw new Error('sticker selection must not download unverified history media');
          },
        },
      },
    };

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user' },
      },
      message: {
        message_id: 'om_request_sticker',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '随便发个表情包' }),
        create_time: '1710000001000',
      },
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    await inbound.prepareForAgent?.();
    assert.equal(inbound?.attachments?.length || 0, 0);
    assert.equal((inbound?.raw as any)?.feishuStickerLibraryContext?.attachedImageCount, 0);
    assert.equal(downloadCount, 0);

    const mediaPath = path.join(
      process.env.CTI_MEMORY_REPO_DIR!,
      'data',
      'im',
      'feishu',
      'stickers',
      'media',
      MemoryArtifactStore.stableFileName(fileKey, '.png'),
    );
    assert.equal(fs.existsSync(mediaPath), false);
    const store = JSON.parse(fs.readFileSync(getTestFeishuStickerStorePath(), 'utf8'));
    assert.equal(store.stickers.length, 1);
    assert.equal(store.stickers[0].fileKey, fileKey);
  });

  it('ignores tiny placeholder files when importing sticker candidate upload cache', async () => {
    const fileKey = 'v3_00cache_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeeg';
    const workspace = path.join(process.env.CTI_HOME!, 'workspace');
    const uploadsDir = path.join(workspace, '.codepilot-uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, `1783000000000-sticker-candidate-${fileKey}.png`), Buffer.from('nope'));
    setupContext({ bridge_default_work_dir: workspace });
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
      version: 1,
      updatedAt: '2026-07-10T00:00:00.000Z',
      stickers: [{
        fileKey,
        aliases: ['最近', '默认', '表情包'],
        chatId: 'oc_chat',
        userId: 'ou_user',
        messageId: 'om_sticker',
        firstSeenAt: '2026-07-10T00:00:00.000Z',
        lastSeenAt: '2026-07-10T00:00:00.000Z',
        useCount: 0,
        mediaDownloadFailedAt: '2026-07-10T00:01:00.000Z',
        mediaDownloadError: 'previous platform rejection',
      }],
    }), 'utf8');

    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.restClient = {
      im: {
        messageResource: {
          get: async () => null,
        },
      },
    };

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user' },
      },
      message: {
        message_id: 'om_request_sticker',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '随便发个表情包' }),
        create_time: '1710000001000',
      },
    });

    const inbound = await adapter.consumeOne();
    assert.ok(inbound);
    await inbound.prepareForAgent?.();
    assert.equal(inbound?.attachments?.length || 0, 0);
    assert.equal((inbound?.raw as any)?.feishuStickerLibraryContext?.attachedImageCount, 0);
  });

  it('accepts group sticker replies to this bot without a native mention', async () => {
    const store = createMockStore({
      bridge_feishu_require_mention: 'true',
      bridge_feishu_group_policy: 'open',
    }) as unknown as BridgeStore & {
      listOutboundRefs: BridgeStore['listOutboundRefs'];
    };
    store.listOutboundRefs = (filter = {}) => {
      if (
        filter.channelType === 'feishu'
        && filter.chatId === 'oc_group'
        && filter.platformMessageId === 'om_bot_reply'
      ) {
        return [{
          channelType: 'feishu',
          chatId: 'oc_group',
          codepilotSessionId: 'session_1',
          platformMessageId: 'om_bot_reply',
          purpose: 'reply',
          messageKind: 'assistant',
          createdAt: '2026-07-10T00:00:00.000Z',
        }];
      }
      return [];
    };
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '项目群';
    adapter.persistChatIndex = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.restClient = {
      im: {
        message: {
          get: async () => ({ data: { items: [] } }),
        },
        messageResource: {
          get: async () => {
            throw new Error('sticker media unavailable');
          },
        },
      },
    };

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user', user_id: 'u_user', union_id: 'on_user' },
      },
      message: {
        message_id: 'om_sticker_reply',
        parent_id: 'om_bot_reply',
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: 'sticker_file_key' }),
        create_time: String(Date.now()),
      },
    });

    const inbound = await Promise.race([
      adapter.consumeOne(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);

    assert.ok(inbound);
    assert.equal(inbound.messageId, 'om_sticker_reply');
    assert.equal(inbound.address.chatId, 'oc_group');
    assert.equal((inbound.raw as any)?.feishuReplyTo?.messageId, 'om_bot_reply');
    assert.match(inbound.text, /sticker_file_key|表情包/u);
  });

  it('accepts group image replies to this bot without a native mention', async () => {
    const store = createMockStore({
      bridge_feishu_require_mention: 'true',
      bridge_feishu_group_policy: 'open',
    }) as unknown as BridgeStore & {
      listOutboundRefs: BridgeStore['listOutboundRefs'];
    };
    store.listOutboundRefs = (filter = {}) => {
      if (
        filter.channelType === 'feishu'
        && filter.chatId === 'oc_group'
        && filter.platformMessageId === 'om_bot_card'
      ) {
        return [{
          channelType: 'feishu',
          chatId: 'oc_group',
          codepilotSessionId: 'session_1',
          platformMessageId: 'om_bot_card',
          purpose: 'reply',
          messageKind: 'assistant',
          createdAt: '2026-07-10T00:00:00.000Z',
        }];
      }
      return [];
    };
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '项目群';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.restClient = {
      im: {
        message: {
          get: async () => ({ data: { items: [] } }),
        },
        messageResource: {
          get: async ({ path: requestPath }: any) => {
            assert.equal(requestPath.message_id, 'om_image_reply');
            assert.equal(requestPath.file_key, 'img_reply_key');
            return {
              getReadableStream: () => Readable.from([Buffer.from('reply-image')]),
            };
          },
        },
      },
    };

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user', user_id: 'u_user', union_id: 'on_user' },
      },
      message: {
        message_id: 'om_image_reply',
        parent_id: 'om_bot_card',
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_reply_key' }),
        create_time: String(Date.now()),
      },
    });

    const inbound = await Promise.race([
      adapter.consumeOne(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);

    assert.ok(inbound);
    assert.equal(inbound.messageId, 'om_image_reply');
    assert.equal((inbound.raw as any)?.feishuReplyTo?.messageId, 'om_bot_card');
    assert.equal(inbound.attachments?.length, 1);
    assert.equal(inbound.attachments?.[0]?.name, 'img_reply_key.png');
  });

  it('keeps downloaded reply media when the current reply also has an attachment', async () => {
    const store = createMockStore({
      bridge_feishu_require_mention: 'true',
      bridge_feishu_group_policy: 'open',
    }) as unknown as BridgeStore & {
      listOutboundRefs: BridgeStore['listOutboundRefs'];
    };
    store.listOutboundRefs = (filter = {}) => filter.platformMessageId === 'om_bot_image'
      ? [{
        channelType: 'feishu',
        chatId: 'oc_group',
        codepilotSessionId: 'session_1',
        platformMessageId: 'om_bot_image',
        purpose: 'reply',
        messageKind: 'assistant',
        createdAt: '2026-07-10T00:00:00.000Z',
      }]
      : [];
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '项目群';
    adapter.persistChatIndex = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.restClient = {
      im: {
        message: {
          get: async ({ path: requestPath }: any) => ({
            data: {
              items: requestPath.message_id === 'om_bot_image' ? [{
                message_id: 'om_bot_image',
                chat_id: 'oc_group',
                create_time: String(Date.now() - 1000),
                msg_type: 'image',
                body: { content: JSON.stringify({ image_key: 'img_parent' }) },
                sender: { id: 'ou_bot', sender_type: 'bot' },
              }] : [],
            },
          }),
        },
        messageResource: {
          get: async ({ path: requestPath }: any) => ({
            getReadableStream: () => Readable.from([Buffer.from(requestPath.file_key)]),
          }),
        },
      },
    };

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user', user_id: 'u_user', union_id: 'on_user' },
      },
      message: {
        message_id: 'om_current_image',
        parent_id: 'om_bot_image',
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_current' }),
        create_time: String(Date.now()),
      },
    });

    const inbound = await adapter.consumeOne();

    assert.deepEqual(inbound?.attachments?.map((item: { name: string }) => item.name), ['img_parent.png', 'img_current.png']);
    assert.equal((inbound?.raw as any)?.feishuReplyTo?.attachmentCount, 1);
  });

  it('drops group text replies to this bot without a native mention', async () => {
    const store = createMockStore({
      bridge_feishu_require_mention: 'true',
      bridge_feishu_group_policy: 'open',
    }) as unknown as BridgeStore & {
      listOutboundRefs: BridgeStore['listOutboundRefs'];
    };
    store.listOutboundRefs = (filter = {}) => {
      if (
        filter.channelType === 'feishu'
        && filter.chatId === 'oc_group'
        && filter.platformMessageId === 'om_bot_reply'
      ) {
        return [{
          channelType: 'feishu',
          chatId: 'oc_group',
          codepilotSessionId: 'session_1',
          platformMessageId: 'om_bot_reply',
          purpose: 'reply',
          messageKind: 'assistant',
          createdAt: '2026-07-10T00:00:00.000Z',
        }];
      }
      return [];
    };
    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '项目群';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user', user_id: 'u_user', union_id: 'on_user' },
      },
      message: {
        message_id: 'om_text_reply',
        parent_id: 'om_bot_reply',
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '哈哈' }),
        create_time: String(Date.now()),
      },
    });

    const inbound = await Promise.race([
      adapter.consumeOne(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);

    assert.equal(inbound, null);
  });

  it('drops group sticker replies when the reply target is not this bot', async () => {
    setupContext({
      bridge_feishu_require_mention: 'true',
      bridge_feishu_group_policy: 'open',
    });

    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '项目群';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.restClient = {
      im: {
        message: {
          get: async () => ({
            data: {
              items: [{
                message_id: 'om_other_message',
                chat_id: 'oc_group',
                create_time: '1710000000000',
                msg_type: 'text',
                body: { content: JSON.stringify({ text: '别人发的消息' }) },
                sender: { id: 'ou_other_user', id_type: 'open_id', sender_type: 'user' },
              }],
            },
          }),
        },
        messageResource: {
          get: async () => {
            throw new Error('non-bot reply sticker should not be downloaded');
          },
        },
      },
    };

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user', user_id: 'u_user', union_id: 'on_user' },
      },
      message: {
        message_id: 'om_sticker_reply_to_other',
        parent_id: 'om_other_message',
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: 'sticker_file_key' }),
        create_time: String(Date.now()),
      },
    });

    const inbound = await Promise.race([
      adapter.consumeOne(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);

    assert.equal(inbound, null);
  });

  it('drops group sticker replies to another bot app without a native mention', async () => {
    setupContext({
      bridge_feishu_require_mention: 'true',
      bridge_feishu_group_policy: 'open',
      bridge_feishu_app_id: 'cli_current_bot',
    });

    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '项目群';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.restClient = {
      im: {
        message: {
          get: async () => ({
            data: {
              items: [{
                message_id: 'om_other_bot_card',
                chat_id: 'oc_group',
                create_time: '1710000000000',
                msg_type: 'interactive',
                body: { content: JSON.stringify({ text: '另一个机器人发的卡片' }) },
                sender: { id: 'cli_other_bot', id_type: 'app_id', sender_type: 'app' },
              }],
            },
          }),
        },
        messageResource: {
          get: async () => {
            throw new Error('reply sticker to another bot must not be downloaded');
          },
        },
      },
    };

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user', user_id: 'u_user', union_id: 'on_user' },
      },
      message: {
        message_id: 'om_sticker_reply_to_other_bot',
        parent_id: 'om_other_bot_card',
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: 'sticker_file_key' }),
        create_time: String(Date.now()),
      },
    });

    const inbound = await Promise.race([
      adapter.consumeOne(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);

    assert.equal(inbound, null);
  });

  it('accepts group sticker replies when cloud history identifies the current bot app', async () => {
    setupContext({
      bridge_feishu_require_mention: 'true',
      bridge_feishu_group_policy: 'open',
      bridge_feishu_app_id: 'cli_current_bot',
    });

    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '项目群';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.restClient = {
      im: {
        message: {
          get: async () => ({
            data: {
              items: [{
                message_id: 'om_current_bot_card',
                chat_id: 'oc_group',
                create_time: '1710000000000',
                msg_type: 'interactive',
                body: { content: JSON.stringify({ text: '当前机器人发的卡片' }) },
                sender: { id: 'cli_current_bot', id_type: 'app_id', sender_type: 'app' },
              }],
            },
          }),
        },
        messageResource: {
          get: async () => {
            throw new Error('sticker media unavailable');
          },
        },
      },
    };

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user', user_id: 'u_user', union_id: 'on_user' },
      },
      message: {
        message_id: 'om_sticker_reply_to_current_bot',
        parent_id: 'om_current_bot_card',
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: 'sticker_file_key' }),
        create_time: String(Date.now()),
      },
    });

    const inbound = await Promise.race([
      adapter.consumeOne(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);

    assert.ok(inbound);
    assert.equal(inbound.messageId, 'om_sticker_reply_to_current_bot');
  });

  it('reuses stored sticker media for repeated sticker file keys without Feishu downloads', async () => {
    let downloadCount = 0;
    writeTestStickerMedia('sticker_file_key', Buffer.from('cached-sticker-image'));
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '群聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.restClient = {
      im: {
        messageResource: {
          get: async () => {
            downloadCount += 1;
            throw new Error('sticker resources should not be downloaded');
          },
        },
      },
    };

    const createStickerEvent = (messageId: string) => ({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user', user_id: 'u_user', union_id: 'on_user' },
      },
      message: {
        message_id: messageId,
        chat_id: 'oc_p2p',
        chat_type: 'p2p',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: 'sticker_file_key' }),
        create_time: String(Date.now()),
      },
    });

    await adapter.processIncomingEvent(createStickerEvent('om_sticker_1'));
    await adapter.processIncomingEvent(createStickerEvent('om_sticker_2'));

    const first = await adapter.consumeOne();
    const second = await adapter.consumeOne();

    assert.equal(downloadCount, 0);
    assert.equal(first?.messageKind, 'feishu_sticker_image');
    assert.equal(second?.messageKind, 'feishu_sticker_image');
    assert.equal(first?.attachments?.[0]?.data, second?.attachments?.[0]?.data);
  });

  it('uses learned sticker semantics when a sticker file_key has a profile', async () => {
    fs.mkdirSync(path.join(process.env.CTI_HOME!, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
      version: 1,
      updatedAt: '2026-06-04T00:00:00.000Z',
      stickers: [{
        fileKey: 'sticker_file_key',
        aliases: ['疑问猫'],
        label: '疑问猫',
        description: '猫脸旁边带“干嘛……”文字',
        intent: '表达疑惑、询问对方要做什么',
        tone: '轻松、吐槽',
        annotationSource: 'manual',
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

  it('treats source-less sticker profiles as unverified inbound evidence', async () => {
    fs.mkdirSync(path.join(process.env.CTI_HOME!, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
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
    assert.equal(inbound?.messageKind, 'feishu_sticker_unknown');
    assert.equal((inbound?.raw as any)?.sticker?.known, false);
    assert.match(inbound?.text || '', /待核验/);
    assert.doesNotMatch(inbound?.text || '', /已记录语义的飞书表情包/);
  });

  it('drops mojibake sticker profile fields instead of injecting unsafe semantics', async () => {
    fs.mkdirSync(path.join(process.env.CTI_HOME!, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
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

  it('stores sticker semantics from a user explanation as unverified evidence', async () => {
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

    const store = JSON.parse(fs.readFileSync(getTestFeishuStickerStorePath(), 'utf8'));
    assert.equal(store.stickers[0].fileKey, 'sticker_file_key');
    assert.equal(store.stickers[0].annotationSource, 'user');
    assert.equal(store.stickers[0].description, undefined);
    assert.equal(store.stickers[0].intent, undefined);
    assert.equal(store.stickers[0].userAnnotation.description, '疑惑、问对方干嘛');
    assert.equal(store.stickers[0].userAnnotation.intent, '疑惑、问对方干嘛');

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
    assert.match(inbound?.text || '', /尚未标注语义的飞书表情包/);
    assert.doesNotMatch(inbound?.text || '', /通常意图：疑惑、问对方干嘛/);
  });

  it('keeps user sticker explanations as evidence and asks the agent to inspect cached media', async () => {
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    writeTestStickerMedia('sticker_file_key', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
      version: 1,
      updatedAt: '2026-07-10T00:00:00.000Z',
      stickers: [{
        fileKey: 'sticker_file_key',
        aliases: ['最近', '默认', '表情包'],
        chatId: 'oc_chat',
        userId: 'ou_user',
        messageId: 'om_sticker',
        mediaCachedAt: '2026-07-10T00:00:00.000Z',
        firstSeenAt: '2026-07-10T00:00:00.000Z',
        lastSeenAt: '2026-07-10T00:00:00.000Z',
        useCount: 0,
      }],
    }), 'utf8');

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
        content: JSON.stringify({ text: '这个表情包表示真棒' }),
        create_time: '1710000001000',
      },
    });

    const inbound = await adapter.consumeOne();
    const store = JSON.parse(fs.readFileSync(getTestFeishuStickerStorePath(), 'utf8'));
    assert.equal(store.stickers[0].intent, undefined);
    assert.equal(store.stickers[0].userAnnotation.intent, '真棒');
    assert.equal(store.stickers[0].annotationSource, 'user');
    assert.equal(inbound?.messageKind, 'feishu_sticker_image');
    assert.equal(inbound?.attachments?.length, 1);
    assert.match(inbound?.text || '', /用户说法/);
    assert.match(inbound?.text || '', /以图片内容为主/);
    assert.equal((inbound?.raw as any)?.sticker?.fileKey, 'sticker_file_key');
    assert.equal((inbound?.raw as any)?.sticker?.imageAvailable, true);
    assert.equal((inbound?.raw as any)?.sticker?.userAnnotation?.intent, '真棒');
  });

  it('does not treat replies to non-sticker messages as sticker annotations', async () => {
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
      version: 1,
      updatedAt: '2026-07-13T00:00:00.000Z',
      stickers: [{
        fileKey: 'recent_unannotated_sticker',
        aliases: [],
        chatId: 'oc_chat',
        userId: 'ou_user',
        messageId: 'om_real_sticker',
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        useCount: 0,
      }],
    }), 'utf8');

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user' },
      },
      message: {
        message_id: 'om_normal_reply',
        parent_id: 'om_bot_card',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '跟小明说，她刚进群，总结所有聊天记录告诉她这个群是干啥的' }),
        create_time: '1710000003000',
      },
    });

    const inbound = await adapter.consumeOne();
    const store = JSON.parse(fs.readFileSync(getTestFeishuStickerStorePath(), 'utf8'));

    assert.ok(inbound);
    assert.notEqual(inbound?.messageKind, 'feishu_sticker_unknown');
    assert.match(inbound?.text || '', /总结所有聊天记录/);
    assert.doesNotMatch(inbound?.text || '', /用户正在解释一个飞书表情包/);
    assert.equal((inbound?.raw as any)?.sticker, undefined);
    assert.equal(store.stickers[0].userAnnotation, undefined);
  });

  it('does not treat ordinary task text with 这个群是 as a recent sticker annotation', async () => {
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
      version: 1,
      updatedAt: '2026-07-13T00:00:00.000Z',
      stickers: [{
        fileKey: 'recent_unannotated_sticker',
        aliases: [],
        chatId: 'oc_chat',
        userId: 'ou_user',
        messageId: 'om_real_sticker',
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        useCount: 0,
      }],
    }), 'utf8');

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user' },
      },
      message: {
        message_id: 'om_group_summary_request',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '艾特小明，她刚进群，还不知道群里发生了什么，总结所有聊天记录告诉她这个群是干啥的' }),
        create_time: '1710000003000',
      },
    });

    const inbound = await adapter.consumeOne();
    const store = JSON.parse(fs.readFileSync(getTestFeishuStickerStorePath(), 'utf8'));

    assert.ok(inbound);
    assert.notEqual(inbound?.messageKind, 'feishu_sticker_unknown');
    assert.match(inbound?.text || '', /这个群是干啥的/);
    assert.doesNotMatch(inbound?.text || '', /用户正在解释一个飞书表情包/);
    assert.equal((inbound?.raw as any)?.sticker, undefined);
    assert.equal(store.stickers[0].userAnnotation, undefined);
  });

  it('does not present user-only sticker annotations as trusted sendable semantics', () => {
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
      version: 1,
      updatedAt: '2026-07-10T00:00:00.000Z',
      stickers: [{
        fileKey: 'sticker_file_key',
        aliases: ['真棒'],
        label: '真棒',
        description: '用户说这是表示真棒的表情包',
        intent: '真棒',
        annotationSource: 'user',
        chatId: 'oc_chat',
        firstSeenAt: '2026-07-10T00:00:00.000Z',
        lastSeenAt: '2026-07-10T00:00:00.000Z',
        useCount: 0,
      }],
    }), 'utf8');
    const adapter = new FeishuAdapter() as any;

    const prompt = adapter.getStickerPresentationPrompt('oc_chat');

    assert.match(prompt, /No semantically annotated stickers are available/);
    assert.doesNotMatch(prompt, /真棒/);
    assert.doesNotMatch(prompt, /\[表情包:真棒\]/);
  });

  it('downgrades legacy text-taught sticker records to user evidence', async () => {
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => '私聊';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    writeTestStickerMedia('legacy_sticker_file_key', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
      version: 1,
      updatedAt: '2026-07-10T00:00:00.000Z',
      stickers: [{
        fileKey: 'legacy_sticker_file_key',
        aliases: ['最近', '默认', '表情包', '真棒的意思'],
        label: '真棒的意思',
        description: '真棒的意思',
        intent: '真棒的意思',
        tone: '真棒的意思',
        annotationConfidence: 0.72,
        chatId: 'oc_chat',
        userId: 'ou_user',
        messageId: 'om_original_sticker',
        learnedFromMessageId: 'om_user_claim',
        mediaCachedAt: '2026-07-10T00:00:00.000Z',
        firstSeenAt: '2026-07-10T00:00:00.000Z',
        lastSeenAt: '2026-07-10T00:00:00.000Z',
        useCount: 0,
      }],
    }), 'utf8');

    const prompt = adapter.getStickerPresentationPrompt('oc_chat');
    assert.match(prompt, /No semantically annotated stickers are available/);
    assert.doesNotMatch(prompt, /真棒/);

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
        content: JSON.stringify({ file_key: 'legacy_sticker_file_key' }),
        create_time: '1710000002000',
      },
    });

    const inbound = await adapter.consumeOne();
    assert.equal(inbound?.messageKind, 'feishu_sticker_image');
    assert.equal(inbound?.attachments?.length, 1);
    assert.match(inbound?.text || '', /用户曾提供待核验说法：真棒的意思/);
    assert.match(inbound?.text || '', /用图片内容交叉核验/);
    assert.doesNotMatch(inbound?.text || '', /已有语义档案可作为参考：历史名称：真棒/);
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

    const store = JSON.parse(fs.readFileSync(getTestFeishuStickerStorePath(), 'utf8'));
    assert.equal(store.stickers[0].annotationSource, 'user');
    assert.equal(store.stickers[0].label, undefined);
    assert.equal(store.stickers[0].intent, undefined);
    assert.equal(store.stickers[0].usage, undefined);
    assert.equal(store.stickers[0].userAnnotation.label, '干嘛猫');
    assert.equal(store.stickers[0].userAnnotation.intent, '疑惑');
    assert.equal(store.stickers[0].userAnnotation.usage, '别人突然丢奇怪需求时吐槽用');
  });

  it('builds a sticker presentation prompt from learned meanings and usage', () => {
    fs.mkdirSync(path.join(process.env.CTI_HOME!, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
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
        annotationSource: 'manual',
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
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
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

    assert.equal(adapter.inboundQueue.size, 0);
  });
});

describe('FeishuAdapter message reactions', () => {
  beforeEach(() => {
    useTempCtiHome();
    setupContext();
  });

  it('does not turn a bare sticker hint into an arbitrary unannotated Feishu sticker message', async () => {
    fs.mkdirSync(path.join(process.env.CTI_HOME!, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
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
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
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
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
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
          annotationSource: 'manual',
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
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
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

  it('does not send stickers from user-only semantic aliases in plain replies', async () => {
    fs.mkdirSync(path.join(process.env.CTI_HOME!, 'data'), { recursive: true });
    fs.writeFileSync(getTestFeishuStickerStorePath(), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      stickers: [{
        fileKey: 'sticker_user_claim_only',
        aliases: ['最近', '默认', '表情包', '真棒'],
        description: '用户说这是表示真棒的表情包',
        intent: '真棒',
        annotationSource: 'user',
        chatId: 'oc_group',
        messageId: 'om_original_sticker',
        learnedFromMessageId: 'om_user_claim',
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
      text: '[表情包:真棒] 可以，先按事实核对',
      parseMode: 'plain',
      replyToMessageId: 'om_user',
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0], /"msg_type":"sticker"/);
    assert.match(calls[0], /\\"text\\":\\"可以，先按事实核对\\"/);
    assert.doesNotMatch(calls[0], /\[表情包:真棒\]/);
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

  it('binds a reaction to the exact recorded sticker delivery once', async () => {
    let resolveProcessed!: () => void;
    const processed = new Promise<void>((resolve) => { resolveProcessed = resolve; });
    const candidates: any[] = [];
    setupContext({}, {
      authorizeSelection: async () => null,
      recordDelivery: async () => {},
      findDeliveriesByOutboundMessageIds: async (ids) => ids.includes('om_sticker_delivery') ? [{
        schema: 'codex-im-suite/sticker-delivery-evidence/v1',
        deliveryId: 'delivery-1',
        channelType: 'feishu',
        chatId: 'oc_group',
        fileKey: 'sticker-key',
        outboundMessageId: 'om_sticker_delivery',
        semanticRevisionId: 'revision-1',
        contextHash: 'a'.repeat(64),
        sessionId: 'session-1',
        sentAt: '2026-07-20T00:00:00.000Z',
      }] : [],
      processFeedback: async (candidate) => {
        candidates.push(candidate);
        resolveProcessed();
        return { status: 'recorded' };
      },
      buildExpressionPromptSection: async () => null,
    });
    const adapter = new FeishuAdapter() as any;

    adapter.handleReactionCreatedEvent({
      event: {
        event_id: 'evt_reaction_1',
        message: { message_id: 'om_sticker_delivery', chat_id: 'oc_group' },
        operator: { operator_id: { open_id: 'ou_user' } },
        reaction: { reaction_type: { emoji_type: 'THUMBSUP' } },
        create_time: '1784515260000',
      },
    });
    await processed;

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].relation, 'reaction');
    assert.equal(candidates[0].referencedOutboundMessageId, 'om_sticker_delivery');
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
