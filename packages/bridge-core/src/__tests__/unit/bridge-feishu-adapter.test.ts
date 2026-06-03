import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
});
