/**
 * Unit tests for bridge-manager.
 *
 * Tests cover:
 * - Session lock concurrency: same-session serialization
 * - Session lock concurrency: different-session parallelism
 * - Bridge start/stop lifecycle
 * - Auto-start idempotency
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initBridgeContext } from '../../lib/bridge/context';
import { buildFeishuCapabilityReport } from '../../lib/bridge/feishu-capabilities';
import type {
  BridgeStore,
  ExtensionActionActor,
  ExtensionCatalogHost,
  FeishuCloudDocumentHost,
  FeishuOAuthManualHost,
  LifecycleHooks,
  StreamChatParams,
  UpsertChannelBindingInput,
} from '../../lib/bridge/host';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { ChannelBinding, OutboundMessage, SendResult } from '../../lib/bridge/types';

// ── Test the session lock mechanism directly ────────────────
// We test the processWithSessionLock pattern by extracting its logic.

function createSessionLocks() {
  const locks = new Map<string, Promise<void>>();

  function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = locks.get(sessionId) || Promise.resolve();
    const current = prev.then(fn, fn);
    locks.set(sessionId, current);
    // Suppress unhandled rejection on the cleanup chain — callers handle the error on `current` directly
    current.finally(() => {
      if (locks.get(sessionId) === current) {
        locks.delete(sessionId);
      }
    }).catch(() => {});
    return current;
  }

  return { locks, processWithSessionLock };
}

async function withStrictToolRouting<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.CTI_STRICT_TOOL_ROUTING;
  process.env.CTI_STRICT_TOOL_ROUTING = 'true';
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CTI_STRICT_TOOL_ROUTING;
    } else {
      process.env.CTI_STRICT_TOOL_ROUTING = previous;
    }
  }
}

describe('bridge-manager session locks', () => {
  it('serializes same-session operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    assert.deepStrictEqual(order, [1, 2], 'Same-session operations should be serialized');
  });

  it('allows different-session operations to run concurrently', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const started: string[] = [];
    const completed: string[] = [];

    const p1 = processWithSessionLock('session-A', async () => {
      started.push('A');
      await new Promise(r => setTimeout(r, 50));
      completed.push('A');
    });

    const p2 = processWithSessionLock('session-B', async () => {
      started.push('B');
      await new Promise(r => setTimeout(r, 10));
      completed.push('B');
    });

    await Promise.all([p1, p2]);
    // Both should start before either completes (concurrent)
    assert.equal(started.length, 2);
    // B should complete first since it has shorter delay
    assert.equal(completed[0], 'B');
    assert.equal(completed[1], 'A');
  });

  it('continues after errors in locked operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      order.push(1);
      throw new Error('test error');
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await p1.catch(() => {});
    await p2;
    assert.deepStrictEqual(order, [1, 2], 'Should continue after error');
  });

  it('sends a visible queued acknowledgement before a locked turn starts', async () => {
    const sent: OutboundMessage[] = [];
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: { streamChat: () => createTextStream('ok') },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `queued-${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.notifyQueuedBehindActiveTurn(adapter, {
      ...createInboundMessage('下一条', 'ou_1', 'oc_group'),
      messageId: 'om_queued',
      address: { channelType: 'feishu', chatId: 'oc_group', userId: 'ou_1', chatType: 'group' },
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].replyToMessageId, 'om_queued');
    assert.match(sent[0].text, /已收到/);
    assert.match(sent[0].text, /按顺序/);
  });

  it('cleans up completed locks', async () => {
    const { locks, processWithSessionLock } = createSessionLocks();

    await processWithSessionLock('session-1', async () => {});

    // Allow microtask to complete for finally() cleanup
    await new Promise(r => setTimeout(r, 0));
    assert.equal(locks.size, 0, 'Lock should be cleaned up after completion');
  });
});

// ── Lifecycle tests ─────────────────────────────────────────

describe('bridge-manager lifecycle', () => {
  beforeEach(() => {
    // Clear bridge manager state
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('getStatus returns not running when bridge has not started', async () => {
    const store = createMinimalStore({ remote_bridge_enabled: 'false' });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    // Import dynamically to get fresh module state
    const { getStatus } = await import('../../lib/bridge/bridge-manager');
    const status = getStatus();
    assert.equal(status.running, false);
    assert.equal(status.adapters.length, 0);
  });

  it('delivers proactive messages through a registered running adapter', async () => {
    const auditLogs: Array<{ direction: string; chatId: string; summary: string }> = [];
    const dedupKeys = new Set<string>();
    const store = {
      ...createMinimalStore({ remote_bridge_enabled: 'true' }),
      insertAuditLog: (entry: any) => { auditLogs.push(entry); },
      checkDedup: (key: string) => dedupKeys.has(key),
      insertDedup: (key: string) => { dedupKeys.add(key); },
    } as BridgeStore;
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const sent: OutboundMessage[] = [];
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: 'om_1' };
    });
    const { registerAdapter, deliverProactiveMessage } = await import('../../lib/bridge/bridge-manager');
    registerAdapter(adapter);

    const result = await deliverProactiveMessage({
      address: { channelType: 'feishu', chatId: 'oc_123' },
      text: '待办提醒：整理主动推送',
      dedupKey: 'todo-reminder:1',
    });

    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].address.chatId, 'oc_123');
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].direction, 'outbound');
    assert.equal(dedupKeys.has('todo-reminder:1'), true);
  });

  it('delivers proactive cti-final images as clean text plus local image attachments', async () => {
    const auditLogs: Array<{ direction: string; chatId: string; summary: string }> = [];
    const store = {
      ...createMinimalStore({ remote_bridge_enabled: 'true' }),
      insertAuditLog: (entry: any) => { auditLogs.push(entry); },
    } as BridgeStore;
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-proactive-image-'));
    const imagePath = path.join(tempDir, 'game-view.png');
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const sent: OutboundMessage[] = [];
    const sentImages: Array<{ chatId: string; filePath: string; replyTo?: string }> = [];
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: 'om_text' };
    });
    adapter.sendLocalImage = async (chatId, filePath, replyToMessageId) => {
      sentImages.push({ chatId, filePath, replyTo: replyToMessageId });
      return { ok: true, messageId: 'om_image' };
    };
    const { registerAdapter, deliverProactiveMessage } = await import('../../lib/bridge/bridge-manager');
    registerAdapter(adapter);

    try {
      const result = await deliverProactiveMessage({
        address: { channelType: 'feishu', chatId: 'oc_123' },
        text: [
          '中间过程：已截取 Game 视角。',
          '',
          '```cti-final',
          JSON.stringify({
            kind: 'image',
            text: 'Unity Game 视角截图如下。',
            images: [imagePath],
            files: [],
            reply_mode: 'plain',
          }),
          '```',
        ].join('\n'),
        replyToMessageId: 'om_source',
        sessionId: 'session-1',
        prepareFinalReply: true,
        workingDirectory: tempDir,
      });

      assert.equal(result.ok, true);
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /^Unity Game 视角截图如下。/);
      assert.doesNotMatch(sent[0].text, /cti-final|中间过程|"kind"/);
      assert.equal(sentImages.length, 1);
      assert.deepEqual(sentImages[0], { chatId: 'oc_123', filePath: imagePath, replyTo: 'om_source' });
      assert.equal(auditLogs.length, 1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects proactive delivery when the channel adapter is unavailable', async () => {
    const store = createMinimalStore({ remote_bridge_enabled: 'true' });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const { deliverProactiveMessage } = await import('../../lib/bridge/bridge-manager');
    const result = await deliverProactiveMessage({
      address: { channelType: 'feishu', chatId: 'oc_123' },
      text: '待办提醒：整理主动推送',
    });

    assert.equal(result.ok, false);
    assert.match(result.error || '', /adapter unavailable/i);
  });

  it('routes reminder complete card callbacks to the reminder host without Codex', async () => {
    const completed: unknown[] = [];
    initBridgeContext({
      store: createMinimalStore({ remote_bridge_enabled: 'true' }),
      llm: {
        streamChat: () => {
          throw new Error('LLM should not be called for reminder callbacks');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      reminders: {
        createDirectReminder: async () => ({ ok: false, error: 'not used' }),
        completeReminder: async (input) => {
          completed.push(input);
          return {
            ok: true,
            reminderId: input.reminderId,
            title: '看电脑',
            status: 'completed',
            message: '已完成',
          };
        },
      },
      lifecycle: {},
    });
    const sent: OutboundMessage[] = [];
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `reply-${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      messageId: 'card_action_1',
      address: { channelType: 'feishu', chatId: 'oc_123', userId: 'ou_1' },
      text: '',
      timestamp: Date.now(),
      callbackData: 'reminder:complete:rem_1',
      callbackMessageId: 'om_card',
    });

    assert.equal(completed.length, 1);
    assert.deepEqual(completed[0], {
      reminderId: 'rem_1',
      chatId: 'oc_123',
      completedByUserId: 'ou_1',
      completionSource: 'feishu_card',
      callbackMessageId: 'om_card',
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /已完成/);
    assert.equal(sent[0].replyToMessageId, 'om_card');
  });

  it('streams progress card text for tool-required turns without polluting final response', async () => {
    const store = createStatefulStore({ remote_bridge_enabled: 'true' });
    initBridgeContext({
      store,
      llm: {
        streamChat: () => createEventStream([
          { type: 'progress', data: '### 处理思路\n正在规划工具调用。\n' },
          {
            type: 'tool_use',
            data: JSON.stringify({ id: 'tool-1', name: 'JsonTool:shell', input: { command: 'node --version' } }),
          },
          {
            type: 'tool_result',
            data: JSON.stringify({ tool_use_id: 'tool-1', content: '{"ok":true}', is_error: false }),
          },
          { type: 'progress', data: '工具返回成功，正在整理最终结果。\n' },
          { type: 'text', data: '最终结果：已完成。' },
          { type: 'status', data: JSON.stringify({ provider: 'codex', modelSource: 'official', model: 'gpt-5' }) },
          { type: 'result', data: JSON.stringify({ usage: { input_tokens: 100, output_tokens: 20 } }) },
        ]),
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const session = store.createSession('progress-test', '', undefined, process.cwd());
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'oc_progress',
      displayName: 'progress-user',
      codepilotSessionId: session.id,
      model: '',
      workingDirectory: process.cwd(),
    });
    const previews: string[] = [];
    const { processMessage } = await import('../../lib/bridge/conversation-engine');

    const result = await processMessage(
      binding,
      '运行 node --version',
      undefined,
      undefined,
      undefined,
      undefined,
      (text) => previews.push(text),
      undefined,
      { storedUserText: '运行 node --version' },
    );

    assert.equal(result.runSummary.model, 'gpt-5');
    assert.equal(result.runSummary.modelSource, 'official');
    assert.equal(result.runSummary.tokenUsage?.input_tokens, 100);
    assert.equal(result.runSummary.tokenUsage?.output_tokens, 20);
    assert.equal(result.responseText, '最终结果：已完成。');
    assert.match(previews.join('\n'), /处理思路/);
    assert.match(previews.join('\n'), /工具返回成功/);
    assert.doesNotMatch(result.responseText, /处理思路/);
  });

  it('deduplicates repeated inbound message ids before invoking Codex', async () => {
    let streamCalls = 0;
    const sent: OutboundMessage[] = [];
    const dedupKeys = new Set<string>();
    const store = {
      ...createStatefulStore({ remote_bridge_enabled: 'true' }),
      checkDedup: (key: string) => dedupKeys.has(key),
      insertDedup: (key: string) => { dedupKeys.add(key); },
      cleanupExpiredDedup: () => {},
    } as BridgeStore;
    initBridgeContext({
      store,
      llm: {
        streamChat: () => {
          streamCalls++;
          return createTextStream('只应该处理一次');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const inbound = createInboundMessage('帮我给这张图起名');

    await _testOnly.handleMessage(adapter, inbound);
    await _testOnly.handleMessage(adapter, inbound);

    assert.equal(streamCalls, 1);
    assert.equal(sent.length, 1);
  });

  it('deduplicates recovered media captions even when Feishu gives a new message id', async () => {
    let streamCalls = 0;
    const sent: OutboundMessage[] = [];
    const dedupKeys = new Set<string>();
    const store = {
      ...createStatefulStore({ remote_bridge_enabled: 'true' }),
      checkDedup: (key: string) => dedupKeys.has(key),
      insertDedup: (key: string) => { dedupKeys.add(key); },
      cleanupExpiredDedup: () => {},
    } as BridgeStore;
    initBridgeContext({
      store,
      llm: {
        streamChat: () => {
          streamCalls++;
          return createTextStream('媒体说明只应该处理一次');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const first = {
      ...createInboundMessage('帮我给上面的制药机起个名'),
      attachments: [{
        id: 'img_1',
        name: 'scene.png',
        type: 'image/png',
        size: 8,
        data: Buffer.from('image').toString('base64'),
      }],
    };
    const recovered = {
      ...createInboundMessage('帮我给上面的制药机起个名'),
      messageId: 'm_2',
    };

    await _testOnly.handleMessage(adapter, first);
    await _testOnly.handleMessage(adapter, recovered);

    assert.equal(streamCalls, 1);
    assert.equal(sent.length, 1);
  });

  it('uses a finalized streaming card as the only Feishu reply surface', async () => {
    await withStrictToolRouting(async () => {
    const sent: OutboundMessage[] = [];
    const cardUpdates: string[] = [];
    const finalized: Array<{ status: string; text: string }> = [];
    let previewCapabilityCalls = 0;
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: { streamChat: () => createTextStream('最终结果：可以命名为 Asset_CapsuleMachine') },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    adapter.getPreviewCapabilities = () => {
      previewCapabilityCalls++;
      return { supported: true, privateOnly: false };
    };
    adapter.sendPreview = async () => {
      throw new Error('streaming card turns should not use legacy preview');
    };
    adapter.onStreamText = (_chatId, text) => {
      cardUpdates.push(text);
    };
    adapter.onStreamEnd = async (_chatId, status, responseText) => {
      finalized.push({ status, text: responseText });
      return true;
    };
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('unity game视角截个图'));

    assert.equal(sent.length, 0);
    assert.equal(previewCapabilityCalls, 0);
    assert.ok(cardUpdates.length > 0);
    const progressText = cardUpdates.join('\n');
    assert.doesNotMatch(progressText, /处理进度/);
    assert.doesNotMatch(progressText, /已收到请求/);
    assert.doesNotMatch(progressText, /会话、权限/);
    assert.doesNotMatch(progressText, /正在选择执行器/);
    assert.equal(finalized.length, 1);
    assert.equal(finalized[0].status, 'completed');
    assert.ok(finalized[0].text.length > 0);
    });
  });

  it('upgrades to workflow cards when real provider progress arrives even when strict routing is disabled', async () => {
    delete process.env.CTI_STRICT_TOOL_ROUTING;
    const sent: OutboundMessage[] = [];
    const cardUpdates: string[] = [];
    const finalized: Array<{ status: string; text: string }> = [];
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: {
        streamChat: () => createEventStream([
          { type: 'progress', data: '正在连接 Unity MCP 并准备 Game view 截图。' },
          {
            type: 'tool_use',
            data: JSON.stringify({ id: 'tool-1', name: 'Unity MCP 截图', input: {} }),
          },
          {
            type: 'tool_result',
            data: JSON.stringify({ tool_use_id: 'tool-1', content: '{"ok":true,"path":"C:/tmp/game.png"}', is_error: false }),
          },
          { type: 'text', data: '```cti-final\n{"kind":"text","text":"截图完成。","images":[],"files":[],"reply_mode":"plain"}\n```' },
          { type: 'result', data: '{}' },
        ]),
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    adapter.onStreamText = (_chatId, text) => {
      cardUpdates.push(text);
    };
    adapter.onStreamEnd = async (_chatId, status, responseText) => {
      finalized.push({ status, text: responseText });
      return true;
    };
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('unitygame视角截个图'));

    assert.equal(sent.length, 0);
    assert.ok(cardUpdates.length > 0);
    assert.match(cardUpdates.join('\n'), /Unity|截图|工具/);
    assert.equal(finalized.length, 1);
    assert.equal(finalized[0].status, 'completed');
  });

  it('does not pre-create workflow cards from tool-like wording without real progress events', async () => {
    delete process.env.CTI_STRICT_TOOL_ROUTING;
    const sent: OutboundMessage[] = [];
    const cardUpdates: string[] = [];
    const finalized: Array<{ status: string; text: string }> = [];
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: {
        streamChat: () => createEventStream([
          { type: 'text', data: '```cti-final\n{"kind":"text","text":"我现在没有拿到截图结果。","images":[],"files":[],"reply_mode":"plain"}\n```' },
          { type: 'result', data: '{}' },
        ]),
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    adapter.onStreamText = (_chatId, text) => {
      cardUpdates.push(text);
    };
    adapter.onStreamEnd = async (_chatId, status, responseText) => {
      finalized.push({ status, text: responseText });
      return true;
    };
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('unitygame视角截个图'));

    assert.equal(cardUpdates.length, 0);
    assert.equal(finalized.length, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /没有拿到截图结果/);
  });

  it('returns a visible blocker when the provider stream completes without final text', async () => {
    const store = createStatefulStore({ remote_bridge_enabled: 'true' });
    initBridgeContext({
      store,
      llm: {
        streamChat: () => createEventStream([
          { type: 'result', data: '{}' },
        ]),
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const session = store.createSession('empty-result-test', '', undefined, process.cwd());
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'oc_empty_result',
      displayName: 'empty-result-user',
      codepilotSessionId: session.id,
      model: '',
      workingDirectory: process.cwd(),
    });
    const { processMessage } = await import('../../lib/bridge/conversation-engine');

    const result = await processMessage(binding, '普通问题', undefined, undefined, undefined);

    assert.equal(result.hasError, true);
    assert.equal(result.responseText, '未完成：模型没有返回可展示结果。');
    assert.equal(result.errorMessage, '模型没有返回可展示结果。');
  });
});

describe('bridge-manager safe error delivery', () => {
  it('converts raw tool_result stream errors into a short user-safe message', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const raw = 'data: {"type":"tool_result","data":"{\\"tool_use_id\\":\\"item_13\\",\\"content\\":\\"C:\\\\\\\\Users\\\\\\\\admin\\\\\\\\.claude-to-im\\\\\\\\data\\\\\\\\feishu-history\\\\\\\\oc_x.json\\\\n乱码锟斤拷\\"}"}';

    const safe = _testOnly.buildSafeProviderErrorMessage(raw, {
      cardFinalized: false,
      channelType: 'feishu',
    });

    assert.match(safe, /未完成/);
    assert.match(safe, /内部工具结果/);
    assert.doesNotMatch(safe, /tool_result/);
    assert.doesNotMatch(safe, /tool_use_id/);
    assert.doesNotMatch(safe, /Users/);
    assert.ok(safe.length < 160);
  });

  it('suppresses duplicate provider error sends after repeated failures in one chat', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    _testOnly.resetProviderErrorCircuitBreaker();

    const key = { channelType: 'feishu', chatId: 'oc_repeat' };
    assert.equal(_testOnly.shouldSendProviderErrorNotice(key), true);
    assert.equal(_testOnly.shouldSendProviderErrorNotice(key), true);
    assert.equal(_testOnly.shouldSendProviderErrorNotice(key), true);
    assert.equal(_testOnly.shouldSendProviderErrorNotice(key), false);
  });
});

describe('bridge-manager extension install commands', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('searches the extension catalog from /ext search without installing', async () => {
    const sent: OutboundMessage[] = [];
    const extensionHost = createExtensionHost();
    initBridgeContext({
      store: createMinimalStore({ bridge_feishu_owner_users: 'ou_owner' }),
      llm: { streamChat: () => { throw new Error('LLM should not be called for /ext search'); } },
      permissions: { resolvePendingPermission: () => false },
      extensions: extensionHost,
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('/ext search qwen'));

    assert.equal(extensionHost.installs.length, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Qwen3 8B/);
    assert.match(sent[0].text, /ollama-qwen3-8b/);
  });

  it('prepares an install confirmation card for a unique /ext install match', async () => {
    const sent: OutboundMessage[] = [];
    const extensionHost = createExtensionHost();
    initBridgeContext({
      store: createMinimalStore({ bridge_feishu_owner_users: 'ou_owner' }),
      llm: { streamChat: () => { throw new Error('LLM should not be called for /ext install'); } },
      permissions: { resolvePendingPermission: () => false },
      extensions: extensionHost,
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('/ext install qwen3', 'ou_owner'));

    assert.equal(extensionHost.installs.length, 0);
    assert.equal(extensionHost.preparedInstalls.length, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /等待确认安装/);
    assert.ok(sent[0].feishuCardJson);
    assert.match(sent[0].feishuCardJson || '', /extinstall:confirm:nonce-install-1/);
  });

  it('rejects install confirmation callbacks from non-owner users', async () => {
    const sent: OutboundMessage[] = [];
    const extensionHost = createExtensionHost();
    initBridgeContext({
      store: createMinimalStore({ bridge_feishu_owner_users: 'ou_owner' }),
      llm: { streamChat: () => { throw new Error('LLM should not be called for extension callback'); } },
      permissions: { resolvePendingPermission: () => false },
      extensions: extensionHost,
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      ...createInboundMessage('', 'ou_viewer'),
      callbackData: 'extinstall:confirm:nonce-install-1',
      callbackMessageId: 'om_card',
    });

    assert.equal(extensionHost.installs.length, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /只允许 owner/);
    assert.equal(sent[0].replyToMessageId, 'om_card');
  });

  it('rejects expired install confirmation callbacks', async () => {
    const sent: OutboundMessage[] = [];
    const extensionHost = createExtensionHost({ expiredConfirm: true });
    initBridgeContext({
      store: createMinimalStore({ bridge_feishu_owner_users: 'ou_owner' }),
      llm: { streamChat: () => { throw new Error('LLM should not be called for extension callback'); } },
      permissions: { resolvePendingPermission: () => false },
      extensions: extensionHost,
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      ...createInboundMessage('', 'ou_owner'),
      callbackData: 'extinstall:confirm:expired',
      callbackMessageId: 'om_card',
    });

    assert.equal(extensionHost.installs.length, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /确认已过期/);
  });

  it('confirms install callbacks through the extension host for owner users', async () => {
    const sent: OutboundMessage[] = [];
    const extensionHost = createExtensionHost();
    initBridgeContext({
      store: createMinimalStore({ bridge_feishu_owner_users: 'ou_owner' }),
      llm: { streamChat: () => { throw new Error('LLM should not be called for extension callback'); } },
      permissions: { resolvePendingPermission: () => false },
      extensions: extensionHost,
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, {
      ...createInboundMessage('', 'ou_owner'),
      callbackData: 'extinstall:confirm:nonce-install-1',
      callbackMessageId: 'om_card',
    });

    assert.deepEqual(extensionHost.installs[0], {
      nonce: 'nonce-install-1',
      actor: { channelType: 'feishu', chatId: 'oc_123', userId: 'ou_owner', messageId: 'm_1' },
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /安装已完成/);
  });

  it('previews https URL installs and rejects non-https URLs', async () => {
    const sent: OutboundMessage[] = [];
    const extensionHost = createExtensionHost();
    initBridgeContext({
      store: createMinimalStore({ bridge_feishu_owner_users: 'ou_owner' }),
      llm: { streamChat: () => { throw new Error('LLM should not be called for URL extension install'); } },
      permissions: { resolvePendingPermission: () => false },
      extensions: extensionHost,
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('/ext install http://example.test/ext.json', 'ou_owner'));
    await _testOnly.handleMessage(adapter, createInboundMessage('/ext install https://example.test/ext.json', 'ou_owner'));

    assert.equal(extensionHost.previews.length, 1);
    assert.equal(extensionHost.previews[0], 'https://example.test/ext.json');
    assert.match(sent[0].text, /只允许 HTTPS/);
    assert.match(sent[1].text, /等待确认安装/);
    assert.match(sent[1].feishuCardJson || '', /extinstall:confirm:nonce-install-1/);
  });

  it('prepares browser remove confirmation without deleting bundled plugin cache directly', async () => {
    const sent: OutboundMessage[] = [];
    const extensionHost = createExtensionHost();
    initBridgeContext({
      store: createMinimalStore({ bridge_feishu_owner_users: 'ou_owner' }),
      llm: { streamChat: () => { throw new Error('LLM should not be called for /ext remove'); } },
      permissions: { resolvePendingPermission: () => false },
      extensions: extensionHost,
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('/ext remove browser-use', 'ou_owner'));
    await _testOnly.handleMessage(adapter, {
      ...createInboundMessage('', 'ou_owner'),
      callbackData: 'extinstall:remove:nonce-remove-1',
      callbackMessageId: 'om_card',
    });

    assert.equal(extensionHost.preparedRemoves.length, 1);
    assert.equal(extensionHost.removes.length, 1);
    assert.match(sent[0].text, /移除记录/);
    assert.match(sent[0].text, /不删除插件缓存/);
    assert.match(sent[1].text, /记录已移除/);
  });
});

describe('bridge-manager result block delivery', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('delivers cti-final plain text through the Feishu outbound path without protocol artifacts', async () => {
    const sent: OutboundMessage[] = [];
    const response = [
      '过程说明不应该出现在最终消息里。',
      '',
      '```cti-final',
      JSON.stringify({
        kind: 'text',
        text: '任务已完成：纯文本结果',
        reply_mode: 'plain',
      }),
      '```',
    ].join('\n');
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: { streamChat: () => createTextStream(response) },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('请输出纯文本结果'));

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /任务已完成：纯文本结果/);
    assert.doesNotMatch(sent[0].text, /cti-final|"kind"|"reply_mode"|过程说明/);
    assert.equal(sent[0].parseMode, 'Markdown');
  });

  it('delivers cti-final markdown through the Feishu outbound path as markdown', async () => {
    const sent: OutboundMessage[] = [];
    const response = [
      '```cti-final',
      JSON.stringify({
        kind: 'text',
        text: '## 结果\n\n- 已完成 **Markdown** 输出',
        reply_mode: 'markdown',
      }),
      '```',
    ].join('\n');
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: { streamChat: () => createTextStream(response) },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('请输出 markdown 结果'));

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /## 结果/);
    assert.match(sent[0].text, /\*\*Markdown\*\*/);
    assert.doesNotMatch(sent[0].text, /cti-final|"kind"|"reply_mode"/);
    assert.equal(sent[0].parseMode, 'Markdown');
  });

  it('falls back to readable text when cti-final JSON is malformed instead of sending raw JSON fragments', async () => {
    const sent: OutboundMessage[] = [];
    const response = [
      '我会先整理结果。',
      '',
      '```cti-final',
      '{"kind":"text","text":"这个 JSON 被截断了","reply_mode":"markdown"',
      '```',
      '',
      '最终可读结果：已完成兜底发送。',
    ].join('\n');
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: { streamChat: () => createTextStream(response) },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('请输出一个最终结果'));

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /最终可读结果：已完成兜底发送。/);
    assert.doesNotMatch(sent[0].text, /cti-final|"kind"|"reply_mode"|这个 JSON 被截断了/);
  });

  it('blocks fake file creation success when the stream has no tool evidence', async () => {
    const sent: OutboundMessage[] = [];
    const response = [
      '```cti-final',
      JSON.stringify({
        kind: 'text',
        text: '已成功在工作区新建了一个名为“测试”的txt文档，并在其中写入了数字1。',
        images: [],
        files: [],
        reply_mode: 'plain',
      }),
      '```',
    ].join('\n');
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: { streamChat: () => createTextStream(response) },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('在工作区新建一个txt文档并在里面写一个1，命名为测试'));

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /未完成/);
    assert.match(sent[0].text, /没有检测到真实工具执行成功记录/);
    assert.doesNotMatch(sent[0].text, /已成功在工作区新建/);
  });

  it('blocks fake image success when the declared image path does not exist', async () => {
    const sent: OutboundMessage[] = [];
    const response = [
      '```cti-final',
      JSON.stringify({
        kind: 'image',
        text: '我已生成一张卡通小猫的图片，并将其保存在本地。',
        images: ['C:\\definitely-missing\\cartoon_cat.png'],
        files: [],
        reply_mode: 'plain',
      }),
      '```',
    ].join('\n');
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: { streamChat: () => createTextStream(response) },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('Ignis 生成一个卡通小猫的图片'));

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /未完成/);
    assert.match(sent[0].text, /路径不存在/);
    assert.doesNotMatch(sent[0].text, /我已生成一张卡通小猫/);
  });

  it('executes cti-reminder through the real reminder host and only sends the host result', async () => {
    const sent: OutboundMessage[] = [];
    const created: unknown[] = [];
    let ticked = false;
    const dueAt = '2026-05-07T04:30:00.000Z';
    const response = [
      '我会交给 bridge 创建提醒。',
      '',
      '```cti-reminder',
      JSON.stringify({
        title: '看电脑',
        dueAt,
        timezone: 'Asia/Shanghai',
        target: 'current_chat',
        sourcePrompt: '半小时后提醒我看电脑',
      }),
      '```',
    ].join('\n');
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: { streamChat: () => createTextStream(response) },
      permissions: { resolvePendingPermission: () => false },
      reminders: {
        createDirectReminder: async (input) => {
          created.push(input);
          return {
            ok: true,
            reminderId: 'rem_real_1',
            title: input.title,
            dueAt: input.dueAt,
            target: input.target,
          };
        },
        tickReminders: async () => {
          ticked = true;
        },
      },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('半小时后提醒我看电脑'));

    assert.equal(created.length, 1);
    assert.deepEqual(created[0], {
      title: '看电脑',
      dueAt,
      timezone: 'Asia/Shanghai',
      target: { channelType: 'feishu', chatId: 'oc_123', userId: 'ou_1' },
      sourcePrompt: '半小时后提醒我看电脑',
      createdByMessageId: 'm_1',
      sessionId: 'session_1',
    });
    assert.equal(ticked, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /提醒已进入统一提醒系统：看电脑/);
    assert.match(sent[0].text, /Reminder ID：rem_real_1/);
    assert.doesNotMatch(sent[0].text, /cti-reminder|"target":"current_chat"|我会交给 bridge 创建提醒/);
  });

  it('blocks fake reminder completion claims and avoids leaking the original pseudo-success text', async () => {
    const sent: OutboundMessage[] = [];
    const response = '已成功创建系统计划任务：CodexFeishuReminder_20260507_1230，稍后会提醒你。';
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: { streamChat: () => createTextStream(response) },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('提醒我看电脑'));

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /未完成：这条回复声称已经创建提醒或系统计划任务/);
    assert.match(sent[0].text, /没有进入 bridge 的统一提醒系统/);
    assert.doesNotMatch(sent[0].text, /CodexFeishuReminder_20260507_1230|稍后会提醒你/);
  });
  it('creates a direct reminder for send-message prompt wording without invoking Codex', async () => {
    const sent: OutboundMessage[] = [];
    const created: any[] = [];
    let ticked = false;
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: {
        streamChat: () => {
          throw new Error('LLM should not be called for high-confidence natural reminders');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      reminders: {
        createDirectReminder: async (input) => {
          created.push(input);
          return {
            ok: true,
            reminderId: 'rem_prompt_1',
            title: input.title,
            dueAt: input.dueAt,
            target: input.target,
          };
        },
        tickReminders: async () => {
          ticked = true;
        },
      },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('一分钟后发消息提示我看一下unity'));

    assert.equal(created.length, 1);
    assert.equal(created[0].title, '看一下unity');
    assert.equal(created[0].dueAt, '2026-05-07T04:01:00.000Z');
    assert.equal(created[0].sourcePrompt, '一分钟后发消息提示我看一下unity');
    assert.equal(ticked, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /提醒已进入统一提醒系统：看一下unity/);
    assert.match(sent[0].text, /Reminder ID：rem_prompt_1/);
  });

  it('creates a same-day direct reminder for absolute time wording without invoking Codex', async () => {
    const sent: OutboundMessage[] = [];
    const created: any[] = [];
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: {
        streamChat: () => {
          throw new Error('LLM should not be called for high-confidence absolute-time reminders');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      reminders: {
        createDirectReminder: async (input) => {
          created.push(input);
          return {
            ok: true,
            reminderId: 'rem_absolute_1',
            title: input.title,
            dueAt: input.dueAt,
            target: input.target,
          };
        },
      },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(
      adapter,
      createInboundMessage('11：30提醒我看消息', 'ou_1', 'oc_123', new Date('2026-05-12T03:24:06.000Z').getTime()),
    );

    assert.equal(created.length, 1);
    assert.equal(created[0].title, '看消息');
    assert.equal(created[0].dueAt, '2026-05-12T03:30:00.000Z');
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /提醒已进入统一提醒系统：看消息/);
    assert.match(sent[0].text, /Reminder ID：rem_absolute_1/);
  });

  it('creates direct reminders when the reminder content appears before the time', async () => {
    const sent: OutboundMessage[] = [];
    const created: any[] = [];
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: {
        streamChat: () => {
          throw new Error('LLM should not be called for deterministic reminder parsing');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      reminders: {
        createDirectReminder: async (input) => {
          created.push(input);
          return {
            ok: true,
            reminderId: 'rem_before_time_1',
            title: input.title,
            dueAt: input.dueAt,
            target: input.target,
          };
        },
      },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(
      adapter,
      createInboundMessage('提醒我看消息，明天9点半', 'ou_1', 'oc_123', new Date('2026-05-12T03:24:06.000Z').getTime()),
    );

    assert.equal(created.length, 1);
    assert.equal(created[0].title, '看消息');
    assert.equal(created[0].dueAt, '2026-05-13T01:30:00.000Z');
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /提醒已进入统一提醒系统：看消息/);
  });
});

describe('bridge-manager Feishu cloud documents', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('continues the original Feishu cloud document request after a manual OAuth callback succeeds', async () => {
    const sent: OutboundMessage[] = [];
    let streamParams: StreamChatParams | null = null;
    const feishuOAuth: FeishuOAuthManualHost = {
      handleManualCallbackText: async (input) => {
        assert.equal(input.text, 'http://127.0.0.1:17321/feishu/oauth/callback?code=auth-code&state=nonce-1');
        assert.equal(input.userId, 'ou_1');
        assert.equal(input.chatId, 'oc_oauth_resume');
        return {
          status: 'bound',
          userMessage: '已收到，正在处理中。',
          resume: {
            text: 'summarize https://example.feishu.cn/docx/doc_abc',
            channelType: 'feishu',
            chatId: 'oc_oauth_resume',
            userId: 'ou_1',
            userDisplayName: 'Liu Dan',
            messageId: 'm_original',
          },
        };
      },
    };
    const feishuCloudDocuments: FeishuCloudDocumentHost = {
      resolveFeishuCloudLinks: async (input) => {
        assert.equal(input.text, 'summarize https://example.feishu.cn/docx/doc_abc');
        assert.equal(input.userId, 'ou_1');
        assert.equal(input.chatId, 'oc_oauth_resume');
        assert.equal(input.messageId, 'm_original:oauth-resume');
        return {
          status: 'resolved',
          linkCount: 1,
          systemPrompt: [
            'Feishu cloud document context:',
            'Source: https://example.feishu.cn/docx/doc_abc',
            'raw content from authorized Feishu document',
          ].join('\n'),
        };
      },
    };
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: {
        streamChat: (params) => {
          streamParams = params;
          return createTextStream('summary generated from authorized document');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      feishuOAuth,
      feishuCloudDocuments,
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage(
      'http://127.0.0.1:17321/feishu/oauth/callback?code=auth-code&state=nonce-1',
      'ou_1',
      'oc_oauth_resume',
    ));

    assert.equal(sent.length, 2);
    assert.equal(sent[0].text, '已收到，正在处理中。');
    assert.equal(sent[0].replyToMessageId, 'm_1');
    assert.match(sent[1].text, /summary generated from authorized document/);
    assert.equal(sent[1].replyToMessageId, 'm_original');
    assert.match((streamParams as StreamChatParams | null)?.systemPrompt || '', /authorized Feishu document/);
  });

  it('binds Feishu OAuth user tokens from a manually pasted callback URL without invoking the LLM', async () => {
    const sent: OutboundMessage[] = [];
    const feishuOAuth: FeishuOAuthManualHost = {
      handleManualCallbackText: async (input) => {
        assert.equal(input.text, 'http://127.0.0.1:17321/feishu/oauth/callback?code=auth-code&state=nonce-1');
        assert.equal(input.userId, 'ou_1');
        assert.equal(input.chatId, 'oc_123');
        return {
          status: 'bound',
          userMessage: '飞书授权成功，请重新发送原问题。',
        };
      },
    };
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: {
        streamChat: () => {
          throw new Error('LLM should not be called for Feishu OAuth callback binding');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      feishuOAuth,
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('http://127.0.0.1:17321/feishu/oauth/callback?code=auth-code&state=nonce-1'));

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /授权成功/);
  });

  it('injects resolved Feishu cloud document content into the provider system prompt', async () => {
    const sent: OutboundMessage[] = [];
    let streamParams: StreamChatParams | null = null;
    const feishuCloudDocuments: FeishuCloudDocumentHost = {
      resolveFeishuCloudLinks: async (input) => {
        assert.equal(input.text, '总结 https://example.feishu.cn/docx/doc_abc');
        assert.equal(input.userId, 'ou_1');
        assert.equal(input.chatId, 'oc_123');
        return {
          status: 'resolved',
          linkCount: 1,
          systemPrompt: [
            'Feishu cloud document context:',
            'Source: https://example.feishu.cn/docx/doc_abc',
            '正文：这里是飞书文档真实内容。',
          ].join('\n'),
        };
      },
    };
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: {
        streamChat: (params) => {
          streamParams = params;
          return createTextStream('已基于飞书文档总结。');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      feishuCloudDocuments,
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('总结 https://example.feishu.cn/docx/doc_abc'));

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /已基于飞书文档总结/);
    assert.match((streamParams as StreamChatParams | null)?.systemPrompt || '', /飞书文档真实内容/);
    assert.match((streamParams as StreamChatParams | null)?.prompt || '', /Feishu cloud document context/);
    assert.match((streamParams as StreamChatParams | null)?.prompt || '', /飞书文档真实内容/);
    assert.match((streamParams as StreamChatParams | null)?.prompt || '', /bridge/);
    assert.doesNotMatch((streamParams as StreamChatParams | null)?.prompt || '', /https:\/\/example\.feishu\.cn\/docx\/doc_abc/);
  });
  it('summarizes resolved Feishu cloud Sheets directly when the request only asks for a summary', async () => {
    const sent: OutboundMessage[] = [];
    const feishuCloudDocuments: FeishuCloudDocumentHost = {
      resolveFeishuCloudLinks: async () => ({
        status: 'resolved',
        linkCount: 1,
        systemPrompt: [
          'Feishu cloud document context:',
          '### Sheet: 建议收集 (415299)',
          'Rows read: 3',
          '1. 问题序号 | 建议人 | 问题类型 | 问题描述 | 问题解决的建议（如果有） | 图示（如果有） | 优先度等级判断（1-5） | 排期状态 | 任务链接',
          '2. 1 | carr | 建议（问题+建议） | 玩家下一步操作的图标是死的，不会主动提示玩家 | 增加预操作提示 |  | 5 | 等方案 | ',
          '3. 2 | 小明 | 吐槽（模糊问题、无建议） | 病房升级体验感不足，花了钱就完事了 | 增强收益表达 |  | 4 | 已排期 | ',
        ].join('\n'),
      }),
    };
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: {
        streamChat: () => {
          throw new Error('LLM should not be called for a resolved Sheets summary fallback');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      feishuCloudDocuments,
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('看一下并总结 https://example.feishu.cn/sheets/sht_abc', 'ou_1', 'oc_cloud_summary'));

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /已读取飞书表格内容/);
    assert.match(sent[0].text, /问题类型分布/);
    assert.match(sent[0].text, /高优先级样例/);
  });

  it('asks the Feishu user to authorize when cloud document access needs login', async () => {
    const sent: OutboundMessage[] = [];
    const feishuCloudDocuments: FeishuCloudDocumentHost = {
      resolveFeishuCloudLinks: async () => ({
        status: 'auth_required',
        linkCount: 1,
        loginUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?state=nonce',
        userMessage: '需要你登录飞书后，我才能安全读取这个云文档。',
        feishuCardJson: '{"config":{"wide_screen_mode":true}}',
      }),
    };
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: {
        streamChat: () => {
          throw new Error('LLM should wait until Feishu authorization succeeds');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      feishuCloudDocuments,
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('看一下 https://example.feishu.cn/sheets/sht_abc'));

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /登录飞书/);
    assert.equal(sent[0].feishuCardJson, '{"config":{"wide_screen_mode":true}}');
  });

  it('reports a clear blocker when the logged-in Feishu user still lacks document permission', async () => {
    const sent: OutboundMessage[] = [];
    const feishuCloudDocuments: FeishuCloudDocumentHost = {
      resolveFeishuCloudLinks: async () => ({
        status: 'permission_denied',
        linkCount: 1,
        userMessage: '未完成：当前登录飞书用户也没有这个云文档权限，请让文档所有者分享给你或导出内容。',
      }),
    };
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: {
        streamChat: () => {
          throw new Error('LLM should not be called after Feishu permission denial');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      feishuCloudDocuments,
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('总结 https://example.feishu.cn/base/bascn123'));

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /当前登录飞书用户也没有这个云文档权限/);
    assert.match(sent[0].text, /文档所有者分享/);
  });
});

describe('bridge-manager Feishu capability diagnostics', () => {
  it('renders Feishu developer platform scope gaps for owners', () => {
    const report = buildFeishuCapabilityReport(createStatefulStore({
        remote_bridge_enabled: 'true',
        bridge_feishu_app_id: 'cli_xxx',
        bridge_feishu_app_secret: 'secret',
        bridge_feishu_oauth_mode: 'manual',
        bridge_feishu_oauth_manual_redirect_uri: 'http://127.0.0.1:17321/feishu/oauth/callback',
        bridge_feishu_oauth_public_base_url: 'https://bot.example.com',
        bridge_feishu_oauth_callback_path: '/feishu/oauth/callback',
        bridge_feishu_oauth_scopes: 'offline_access,auth:user.id:read,docx:document:readonly,sheets:spreadsheet:readonly',
        bridge_feishu_granted_scopes: 'im:message,im:message:receive_v1,docx:document:readonly,sheets:spreadsheet:readonly',
        bridge_feishu_owner_users: 'ou_owner',
    }));

    assert.match(report, /Feishu Developer Platform Capabilities/);
    assert.match(report, /应用 token 直读云文档/);
    assert.match(report, /用户 OAuth fallback/);
    assert.match(report, /OAuth mode: manual/);
    assert.match(report, /CTI_FEISHU_GRANTED_SCOPES/);
    assert.match(report, /Missing declared scopes:/);
    assert.match(report, /base:record:retrieve/);
    assert.doesNotMatch(report, /app-secret/);
  });
});

describe('bridge-manager policy helpers', () => {
  it('detects generated document list requests without needing full history', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    assert.equal(_testOnly.isFeishuDocumentListRequest('之前生成过哪些飞书文档'), true);
    assert.equal(_testOnly.isFeishuDocumentListRequest('帮我截一张图'), false);
  });

  it('classifies dangerous Feishu requests that require owner identity', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    assert.equal(_testOnly.isDangerousUserRequest('删掉刚才创建的飞书文档'), true);
    assert.equal(_testOnly.isDangerousUserRequest('git pull 拉到最新'), true);
    assert.equal(_testOnly.isDangerousUserRequest('现在关机'), true);
    assert.equal(_testOnly.isDangerousUserRequest('截一张场景图'), false);
  });

  it('detects shutdown requests and confirmation phrases', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    assert.equal(_testOnly.isShutdownRequest('关机'), true);
    assert.equal(_testOnly.isShutdownRequest('shutdown /s /t 0'), true);
    assert.equal(_testOnly.isShutdownRequest('帮我总结日志'), false);
    assert.equal(_testOnly.isShutdownConfirmation('确认关机'), true);
    assert.equal(_testOnly.isShutdownConfirmation('确认关机。'), true);
    assert.equal(_testOnly.isShutdownConfirmation('确认'), false);
  });

  it('applies permission role hierarchy across channels', async () => {
    const store = createMinimalStore({
      bridge_feishu_allowed_users: 'feishu_viewer',
      bridge_feishu_owner_users: 'feishu_owner',
      telegram_bridge_allowed_users: 'tg_viewer',
      telegram_bridge_owner_users: 'tg_owner',
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const message = (channelType: string, userId: string) => ({
      text: '/whoami',
      messageId: 'm1',
      address: { channelType, chatId: 'chat', userId },
    }) as any;

    assert.equal(_testOnly.hasRole(message('feishu', 'feishu_owner'), 'owner'), true);
    assert.equal(_testOnly.hasRole(message('feishu', 'feishu_owner'), 'operator'), true);
    assert.equal(_testOnly.hasRole(message('feishu', 'feishu_viewer'), 'viewer'), true);
    assert.equal(_testOnly.hasRole(message('feishu', 'feishu_viewer'), 'operator'), false);
    assert.equal(_testOnly.hasRole(message('telegram', 'tg_owner'), 'owner'), true);
    assert.equal(_testOnly.hasRole(message('telegram', 'tg_viewer'), 'operator'), false);
  });

  it('blocks manual handoff replies for Unity tool execution requests', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sanitized = _testOnly.sanitizeOutsourcedToolReply(
      [
        '未完成：当前没有可用的 Unity 或 MCP 工具来执行此操作。',
        '请手动检查 Unity 项目中的 HSScene 场景，查找所有以 Furniture_ 前缀命名的节点。',
      ].join('\n'),
      '帮我用unitymcp看一眼unity里，HSScene的Furniture_前缀的家具节点都代表什么，分析一下整理一份列表发我',
    );
    assert.match(sanitized, /未完成/);
    assert.match(sanitized, /已拦截通用手动排查步骤/);
    assert.doesNotMatch(sanitized, /请手动检查|打开你的Unity项目|示例列表/);
  });

  it('blocks MCP entry clarification replies for concrete Unity prefab requests', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sourcePrompt = 'unitymcp看一下STH_AreaView这个prefab的结构是怎样的';

    const sanitized = _testOnly.sanitizeOutsourcedToolReply(
      '请指定要使用的 Unity MCP 入口。例如：Blender MCP、Ignis MCP、Picture MCP、Unity MCP、Unity Prefab MCP、Fetch MCP。',
      sourcePrompt,
    );

    assert.match(sanitized, /未完成/);
    assert.match(sanitized, /需要实际 Unity\/MCP 执行结果/);
    assert.doesNotMatch(sanitized, /请指定要使用的 Unity MCP 入口|Blender MCP、Ignis MCP/);
  });

  it('blocks short follow-up MCP entry clarification after a Unity tool prompt', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sanitized = _testOnly.sanitizeOutsourcedToolReply(
      '请指定要使用的 Unity MCP 入口。',
      'unity',
    );

    assert.match(sanitized, /未完成/);
    assert.doesNotMatch(sanitized, /请指定要使用的 Unity MCP 入口/);
  });

  it('does not use hardcoded small-talk replies', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    assert.equal(_testOnly.buildSmallTalkReply('你好呀'), '');
    assert.equal(_testOnly.buildSmallTalkReply('帮我看一下 Unity'), '');
    assert.equal(_testOnly.buildSmallTalkReply('你好呀，帮我发布'), '');
    assert.equal(_testOnly.buildSmallTalkReply('你是谁', { displayName: '小虾米', platform: 'Feishu' }), '');
  });

  it('injects Feishu app identity and expression hints into provider turns', async () => {
    const sent: OutboundMessage[] = [];
    const streamParams: StreamChatParams[] = [];
    let memoryDecisionCalls = 0;
    let memoryWriteClassifierCalls = 0;
    const store = {
      ...createStatefulStore({ remote_bridge_enabled: 'true' }),
      decideMemoryReply: () => {
        memoryDecisionCalls += 1;
        throw new Error('ordinary chat should not prefetch memory');
      },
    };
    initBridgeContext({
      store,
      llm: {
        streamChat: (params) => {
          streamParams.push(params);
          return createTextStream('我是小虾米，可以陪你聊天，也可以帮你处理项目里的实际任务。');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
      memoryIntents: {
        classifyMemoryWrite: async () => {
          memoryWriteClassifierCalls += 1;
          return { action: 'ignore', confidence: 1 };
        },
      },
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    adapter.getAssistantIdentity = () => ({
      displayName: '小虾米',
      platform: 'Feishu',
      appId: 'cli_app_x',
      botOpenId: 'ou_bot',
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    await _testOnly.handleMessage(adapter, createInboundMessage('请自然一点介绍下你自己', 'ou_1', 'oc_intro'));

    assert.equal(sent.length, 1);
    assert.equal(streamParams.length, 1);
    assert.match(streamParams[0].systemPrompt || '', /小虾米/);
    assert.match(streamParams[0].systemPrompt || '', /Do not replace that name with "Codex"/);
    assert.match(streamParams[0].systemPrompt || '', /Do not default to SMILE/);
    assert.match(streamParams[0].systemPrompt || '', /Choose reaction hints by actual intent/);
    assert.doesNotMatch(streamParams[0].systemPrompt || '', /\[微笑\]/);
    assert.match(streamParams[0].systemPrompt || '', /\[表情包:alias\]/);
    assert.equal(memoryDecisionCalls, 0);
    assert.equal(memoryWriteClassifierCalls, 0);
  });

  it('keeps provider progress visible alongside the workflow card step', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const text = _testOnly.buildProgressCardTextForTest(
      '正在整理回复。',
      '处理思路：正在识别图片里的题目。',
    );
    assert.equal(text, '正在整理回复。\n\n处理思路：正在识别图片里的题目。');
  });

  it('selects light status by default and reserves workflow cards for real bridge progress', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    assert.equal(_testOnly.selectReplySurfaceMode({
      supportsStreamingCards: true,
      feishuDocRequest: false,
      messageKind: 'feishu_sticker_unknown',
      hasMemoryProgress: false,
      textLength: 120,
    }), 'light_status');
    assert.equal(_testOnly.selectReplySurfaceMode({
      supportsStreamingCards: true,
      feishuDocRequest: false,
      messageKind: 'feishu_sticker_image',
      hasMemoryProgress: false,
      textLength: 120,
    }), 'light_status');
    assert.equal(_testOnly.selectReplySurfaceMode({
      supportsStreamingCards: true,
      feishuDocRequest: false,
      hasMemoryProgress: false,
      textLength: 20,
    }), 'light_status');
    assert.equal(_testOnly.selectReplySurfaceMode({
      supportsStreamingCards: true,
      feishuDocRequest: false,
      hasMemoryProgress: true,
      textLength: 20,
    }), 'workflow_card');
  });

  it('does not start a workflow card before lightweight sticker replies finish', async () => {
    const sent: OutboundMessage[] = [];
    const store = createStatefulStore({ remote_bridge_enabled: 'true' });
    initBridgeContext({
      store,
      llm: { streamChat: () => createTextStream('收到~') },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    }) as BaseChannelAdapter & {
      onMessageStart?: (chatId: string) => void;
      onStreamText?: (chatId: string, text: string) => void;
    };
    let startCount = 0;
    let streamTextCount = 0;
    adapter.onMessageStart = () => { startCount++; };
    adapter.onStreamText = () => { streamTextCount++; };

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    await _testOnly.handleMessage(adapter, {
      ...createInboundMessage('用户发送了一个飞书表情包，file_key=sticker_file_key，尚未标注语义。', 'ou_1', 'oc_sticker'),
      messageKind: 'feishu_sticker_unknown',
      raw: {
        messageKind: 'feishu_sticker_unknown',
        sticker: { fileKey: 'sticker_file_key', known: false },
      },
    });

    assert.equal(startCount, 0);
    assert.equal(streamTextCount, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /收到/);
  });

  it('uses downloaded sticker images as chat tone references without workflow cards', async () => {
    const sent: OutboundMessage[] = [];
    const streamParams: StreamChatParams[] = [];
    const store = createStatefulStore({ remote_bridge_enabled: 'true' });
    initBridgeContext({
      store,
      llm: {
        streamChat: (params) => {
          streamParams.push(params);
          return createTextStream('收到~');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    }) as BaseChannelAdapter & {
      onMessageStart?: (chatId: string) => void;
      onStreamText?: (chatId: string, text: string) => void;
    };
    let startCount = 0;
    let streamTextCount = 0;
    adapter.onMessageStart = () => { startCount++; };
    adapter.onStreamText = () => { streamTextCount++; };

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    await _testOnly.handleMessage(adapter, {
      ...createInboundMessage('用户发送了一个飞书表情包，file_key=sticker_file_key，表情包图片已作为本轮图片附件提供给模型。', 'ou_1', 'oc_sticker_image'),
      messageKind: 'feishu_sticker_image',
      raw: {
        messageKind: 'feishu_sticker_image',
        sticker: { fileKey: 'sticker_file_key', known: false, imageAvailable: true },
      },
      attachments: [{
        id: 'sticker_file_key',
        name: 'sticker-sticker_file_key.png',
        type: 'image/png',
        size: 4,
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      }],
    });

    assert.equal(startCount, 0);
    assert.equal(streamTextCount, 0);
    assert.equal(sent.length, 1);
    assert.equal(streamParams.length, 1);
    assert.equal(streamParams[0].files?.length, 1);
    assert.doesNotMatch(streamParams[0].prompt, /Describe this image/);
    assert.match(streamParams[0].prompt, /轻量聊天消息/);
    assert.match(streamParams[0].prompt, /聊天语气信号/);
    assert.match(streamParams[0].prompt, /不要写成“图片里是/);
  });

  it('treats image-only messages as implicit user requests instead of image descriptions', async () => {
    const sent: OutboundMessage[] = [];
    const streamParams: StreamChatParams[] = [];
    initBridgeContext({
      store: createStatefulStore({ remote_bridge_enabled: 'true' }),
      llm: {
        streamChat: (params) => {
          streamParams.push(params);
          return createTextStream('解：设最小正方形边长为 2。');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    await _testOnly.handleMessage(adapter, {
      ...createInboundMessage('', 'ou_1', 'oc_image_math'),
      attachments: [{
        id: 'img_math',
        name: 'math-question.png',
        type: 'image/png',
        size: 4,
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      }],
    });

    assert.equal(streamParams.length, 1);
    assert.equal(streamParams[0].files?.length, 1);
    assert.doesNotMatch(streamParams[0].prompt, /Describe this image/);
    assert.match(streamParams[0].prompt, /message carrier/i);
    assert.match(streamParams[0].prompt, /communicative intent/i);
    assert.match(streamParams[0].prompt, /likely action/i);
    assert.match(streamParams[0].prompt, /Do not merely describe, caption, or OCR/i);
  });

  it('reattaches recent conversation images for follow-up messages that refer back to prior media', async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-recent-media-'));
    const previousIdleFreshMs = process.env.CTI_SESSION_IDLE_FRESH_MS;
    process.env.CTI_SESSION_IDLE_FRESH_MS = String(365 * 24 * 60 * 60 * 1000);
    t.after(() => {
      if (previousIdleFreshMs === undefined) delete process.env.CTI_SESSION_IDLE_FRESH_MS;
      else process.env.CTI_SESSION_IDLE_FRESH_MS = previousIdleFreshMs;
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
    const sent: OutboundMessage[] = [];
    const streamParams: StreamChatParams[] = [];
    const store = createStatefulStore({ remote_bridge_enabled: 'true' });
    initBridgeContext({
      store,
      llm: {
        streamChat: (params) => {
          streamParams.push(params);
          return createTextStream('按上一张图继续分析。');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    await _testOnly.handleMessage(adapter, {
      ...createInboundMessage('', 'ou_1', 'oc_recent_media'),
      address: { channelType: 'feishu', chatId: 'oc_recent_media', userId: 'ou_1', chatType: 'p2p' },
      attachments: [{
        id: 'img_math',
        name: 'math-question.png',
        type: 'image/png',
        size: 4,
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      }],
    });

    await _testOnly.handleMessage(adapter, {
      ...createInboundMessage('继续一步一步分析给我解题思路', 'ou_1', 'oc_recent_media'),
      address: { channelType: 'feishu', chatId: 'oc_recent_media', userId: 'ou_1', chatType: 'p2p' },
    });

    assert.equal(streamParams.length, 2);
    assert.equal(streamParams[1].files?.length, 1);
    assert.equal(streamParams[1].files?.[0]?.name, 'math-question.png');
    assert.match(streamParams[1].prompt, /继续一步一步分析/);
    assert.match(streamParams[1].systemPrompt || '', /recent conversation media/i);
  });

  it('does not apply no-tool-evidence interception to sticker chat replies', async () => {
    const sent: OutboundMessage[] = [];
    const store = createStatefulStore({ remote_bridge_enabled: 'true' });
    initBridgeContext({
      store,
      llm: {
        streamChat: () => createTextStream('已经收到这个图片啦~'),
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    }) as BaseChannelAdapter & {
      onMessageStart?: (chatId: string) => void;
      onStreamText?: (chatId: string, text: string) => void;
    };
    let startCount = 0;
    let streamTextCount = 0;
    adapter.onMessageStart = () => { startCount++; };
    adapter.onStreamText = () => { streamTextCount++; };

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    await _testOnly.handleMessage(adapter, {
      ...createInboundMessage('用户发送了一个飞书表情包，file_key=sticker_file_key，表情包图片已作为本轮图片附件提供给模型。', 'ou_1', 'oc_sticker_evidence'),
      messageKind: 'feishu_sticker_image',
      raw: {
        messageKind: 'feishu_sticker_image',
        sticker: { fileKey: 'sticker_file_key', known: false, imageAvailable: true },
      },
      attachments: [{
        id: 'sticker_file_key',
        name: 'sticker-sticker_file_key.png',
        type: 'image/png',
        size: 4,
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      }],
    });

    assert.equal(startCount, 0);
    assert.equal(streamTextCount, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /已经收到这个图片/);
    assert.doesNotMatch(sent[0].text, /未完成/);
    assert.doesNotMatch(sent[0].text, /tool_use/);
  });

  it('routes high-confidence memory decisions through the agent with visible progress', async () => {
    const sent: OutboundMessage[] = [];
    const progressCards: string[] = [];
    const streamParams: any[] = [];
    const store = {
      ...createStatefulStore({ remote_bridge_enabled: 'true' }),
      decideMemoryReply: () => ({
        type: 'direct_reply' as const,
        text: [
          '常用场景名称对应表：',
          '',
          '`HSScene` == 医院内部场景',
          '`city3d_citystage_ST2H_Scene` == 外城场景',
        ].join('\n'),
        hit: {
          sessionId: 'audit:1',
          role: 'assistant' as const,
          source: 'message' as const,
          sourceType: 'audit' as const,
          score: 16,
          confidence: 0.92,
          answerability: 'structured' as const,
          quality: 'high' as const,
          structuredKey: '常用场景名称',
          structuredValue: 'HSScene == 医院内部场景',
          content: '常用场景名称对应表： `HSScene` == 医院内部场景',
        },
        plan: {
          intent: 'explicit_recall' as const,
          queryText: '常用场景名称',
          normalizedKey: '常用场景名称',
          answerMode: 'direct_if_confident' as const,
          minConfidence: 0.78,
          allowDirectAnswer: true,
        },
      }),
    };
    initBridgeContext({
      store,
      llm: {
        streamChat: (params) => {
          streamParams.push(params);
          return createTextStream('agent 整理后的记忆结果：\n`HSScene` == 医院内部场景\n`city3d_citystage_ST2H_Scene` == 外城场景');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    (adapter as any).onStreamText = (_chatId: string, text: string) => {
      progressCards.push(text);
    };
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('你还记得常用场景名称吗', 'ou_1', 'oc_memory'));

    assert.equal(sent.length, 1);
    assert.equal(streamParams.length, 1);
    assert.equal(streamParams[0].executionRequirement?.kind, 'none');
    assert.match(streamParams[0].systemPrompt || '', /本地记忆检索命中/);
    assert.match(streamParams[0].systemPrompt || '', /HSScene/);
    assert.match(progressCards.join('\n'), /检索到相关记忆/);
    assert.match(progressCards.join('\n'), /交给 agent/);
    assert.match(sent[0].text, /HSScene/);
    assert.match(sent[0].text, /医院内部场景/);
  });

  it('uses answer review replacement when enforcement is enabled', async () => {
    const sent: OutboundMessage[] = [];
    const streamParams: any[] = [];
    const store = {
      ...createStatefulStore({ remote_bridge_enabled: 'true' }),
      decideMemoryReply: () => ({
        type: 'direct_reply' as const,
        text: '项目 HSScene：医院内部场景',
        hit: {
          sessionId: 'audit:bad',
          role: 'assistant' as const,
          source: 'message' as const,
          sourceType: 'audit' as const,
          score: 16,
          confidence: 0.92,
          answerability: 'structured' as const,
          quality: 'high' as const,
          structuredKey: '项目 HSScene',
          structuredValue: '医院内部场景',
          content: '项目 HSScene：医院内部场景',
        },
        plan: {
          intent: 'explicit_recall' as const,
          queryText: '第十三条龙叫啥',
          normalizedKey: '第十三条龙',
          answerMode: 'direct_if_confident' as const,
          minConfidence: 0.78,
          allowDirectAnswer: true,
        },
      }),
      reviewOutboundAnswer: () => ({
        verdict: 'replace' as const,
        reasonCodes: ['memory_key_mismatch'],
        replacementText: '第十三条龙：雷霆龙',
        mode: 'block_or_replace' as const,
        createdAt: '2026-05-12T00:00:00.000Z',
      }),
    };
    initBridgeContext({
      store,
      llm: {
        streamChat: (params) => {
          streamParams.push(params);
          return createTextStream('项目 HSScene：医院内部场景');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createRunningAdapter('feishu', async (message) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    });
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');

    await _testOnly.handleMessage(adapter, createInboundMessage('你还记得第十三条龙叫啥吗', 'ou_1', 'oc_memory'));

    assert.equal(sent.length, 1);
    assert.equal(streamParams.length, 1);
    assert.match(streamParams[0].systemPrompt || '', /本地记忆检索命中/);
    assert.match(sent[0].text, /第十三条龙：雷霆龙/);
    assert.doesNotMatch(sent[0].text, /HSScene/);
  });

  it('extracts cti-reminder action blocks without treating normal task text as reminders', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const extracted = _testOnly.extractCtiReminderAction([
      '我会交给 bridge 创建提醒。',
      '',
      '```cti-reminder',
      '{"title":"看电脑","dueAt":"2026-04-29T11:42:00.000Z","timezone":"Asia/Shanghai","target":"current_chat","sourcePrompt":"两分钟后提醒我看电脑"}',
      '```',
    ].join('\n'));

    assert.equal(extracted.action?.title, '看电脑');
    assert.equal(extracted.action?.target, 'current_chat');
    assert.doesNotMatch(extracted.text, /cti-reminder/);

    const normal = _testOnly.extractCtiReminderAction('这个任务为什么卡住，帮我分析一下');
    assert.equal(normal.action, null);
    assert.equal(normal.text, '这个任务为什么卡住，帮我分析一下');
  });

  it('detects fake reminder completion claims that lack bridge action records', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    assert.equal(
      _testOnly.containsUnverifiedReminderCompletion('已实际创建系统计划任务：CodexFeishuReminder_20260429_1942。'),
      true,
    );
    assert.equal(
      _testOnly.containsUnverifiedReminderCompletion('帮我写一个 Windows 计划任务脚本，用来提醒我看电脑。'),
      false,
    );
  });

  it('parses only high-confidence natural direct reminder requests', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const now = new Date('2026-04-30T02:24:00.000Z');
    const parsed = _testOnly.parseNaturalReminderRequest('帮我设置个待办，1分钟后给我发一条消息说时间到了', now);
    assert.deepEqual(parsed, {
      title: '时间到了',
      dueAt: '2026-04-30T02:25:00.000Z',
    });

    const chineseMinute = _testOnly.parseNaturalReminderRequest('帮我设置个待办，一分钟后提醒我看电脑', now);
    assert.deepEqual(chineseMinute, {
      title: '看电脑',
      dueAt: '2026-04-30T02:25:00.000Z',
    });

    const chineseClock = _testOnly.parseNaturalReminderRequest('五点半提醒我替换pve场景的背景图', now);
    assert.deepEqual(chineseClock, {
      title: '替换pve场景的背景图',
      dueAt: '2026-04-30T09:30:00.000Z',
    });

    assert.deepEqual(_testOnly.parseNaturalReminderRequest('下午五点半提醒我替换pve场景的背景图', now), {
      title: '替换pve场景的背景图',
      dueAt: '2026-04-30T09:30:00.000Z',
    });
    assert.deepEqual(_testOnly.parseNaturalReminderRequest('提醒我看消息，明天上午九点', now), {
      title: '看消息',
      dueAt: '2026-05-01T01:00:00.000Z',
    });
    assert.deepEqual(_testOnly.parseNaturalReminderRequest('晚上8点15分提醒我看公告', now), {
      title: '看公告',
      dueAt: '2026-04-30T12:15:00.000Z',
    });
    assert.deepEqual(_testOnly.parseNaturalReminderRequest('2026年5月19日下午五点半提醒我替换pve场景的背景图', now), {
      title: '替换pve场景的背景图',
      dueAt: '2026-05-19T09:30:00.000Z',
    });

    assert.equal(_testOnly.parseNaturalReminderRequest('这个任务为什么卡住', now), null);
    assert.equal(_testOnly.parseNaturalReminderRequest('帮我写计划任务脚本，提醒我看电脑', now), null);
    assert.equal(_testOnly.parseNaturalReminderRequest('今天有什么待办', now), null);
  });
});

function createMinimalStore(settings: Record<string, string> = {}): BridgeStore {
  const mergedSettings: Record<string, string> = {
    bridge_delivery_rate_limit_max_messages: '0',
    ...settings,
  };
  return {
    getSetting: (key: string) => mergedSettings[key] ?? null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    createSession: () => ({ id: '1', working_directory: '', model: '' }),
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    retrieveRelevantMemory: () => null,
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

function createStatefulStore(settings: Record<string, string> = {}): BridgeStore {
  const sessions = new Map<string, any>();
  const bindings = new Map<string, ChannelBinding>();
  const messages = new Map<string, Array<{ role: string; content: string }>>();
  let sessionCounter = 0;

  const store = {
    ...createMinimalStore({
      bridge_default_work_dir: process.cwd(),
      ...settings,
    }),
    getChannelBinding: (channelType: string, chatId: string) => bindings.get(`${channelType}:${chatId}`) ?? null,
    upsertChannelBinding: (input: UpsertChannelBindingInput) => {
      const key = `${input.channelType}:${input.chatId}`;
      const existing = bindings.get(key);
      const now = new Date('2026-05-07T00:00:00.000Z').toISOString();
      const mode = input.mode === 'plan' || input.mode === 'ask' || input.mode === 'code'
        ? input.mode
        : existing?.mode ?? 'code';
      const binding: ChannelBinding = {
        id: existing?.id || `binding_${bindings.size + 1}`,
        channelType: input.channelType,
        chatId: input.chatId,
        displayName: input.displayName,
        chatType: input.chatType,
        codepilotSessionId: input.codepilotSessionId,
        sdkSessionId: input.sdkSessionId ?? existing?.sdkSessionId ?? '',
        workingDirectory: input.workingDirectory ?? existing?.workingDirectory ?? process.cwd(),
        model: input.model ?? existing?.model ?? '',
        mode,
        bridgeFingerprint: input.bridgeFingerprint ?? existing?.bridgeFingerprint,
        toolingFingerprint: input.toolingFingerprint ?? existing?.toolingFingerprint,
        active: existing?.active ?? true,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      bindings.set(key, binding);
      return binding;
    },
    updateChannelBinding: (id: string, updates: Partial<ChannelBinding>) => {
      for (const [key, binding] of bindings) {
        if (binding.id === id) {
          bindings.set(key, { ...binding, ...updates, updatedAt: new Date('2026-05-07T00:00:00.000Z').toISOString() });
          return;
        }
      }
    },
    listChannelBindings: (channelType?: string) => Array.from(bindings.values()).filter((binding) => !channelType || binding.channelType === channelType),
    createSession: (_title: string, model = '', systemPrompt?: string, workingDirectory = process.cwd()) => {
      sessionCounter += 1;
      const session = {
        id: `session_${sessionCounter}`,
        working_directory: workingDirectory,
        model,
        system_prompt: systemPrompt,
        provider_id: '',
      };
      sessions.set(session.id, session);
      return session;
    },
    getSession: (sessionId: string) => sessions.get(sessionId) ?? null,
    addMessage: (sessionId: string, role: string, content: string) => {
      const current = messages.get(sessionId) ?? [];
      current.push({ role, content });
      messages.set(sessionId, current);
    },
    getMessages: (sessionId: string) => ({ messages: messages.get(sessionId) ?? [] }),
  } satisfies BridgeStore;

  return store;
}

function createTextStream(text: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: text })}\n\n`);
      controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: '{}' })}\n\n`);
      controller.close();
    },
  });
}

function createEventStream(events: Array<{ type: string; data: string }>): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(`data: ${JSON.stringify(event)}\n\n`);
      }
      controller.close();
    },
  });
}

function createInboundMessage(
  text: string,
  userId = 'ou_1',
  chatId = 'oc_123',
  timestamp = new Date('2026-05-07T04:00:00.000Z').getTime(),
) {
  return {
    messageId: 'm_1',
    address: { channelType: 'feishu', chatId, userId },
    text,
    timestamp,
  };
}

function createExtensionHost(options: { expiredConfirm?: boolean } = {}) {
  const items = [
    {
      id: 'ollama-qwen3-8b',
      type: 'model',
      displayName: 'Qwen3 8B',
      version: '8b',
      category: 'model.ollama',
      description: 'Ollama 本地模型',
      installHandler: 'ollama.pull',
      installed: false,
      canRemove: false,
    },
    {
      id: 'browser-use',
      type: 'plugin',
      displayName: 'Browser',
      version: '0.1.0-alpha2',
      category: 'plugin.bundled',
      description: 'OpenAI bundled Browser 插件记录',
      installHandler: 'codex-plugin.record',
      installed: true,
      canRemove: true,
    },
  ];
  const preparedInstalls: unknown[] = [];
  const preparedRemoves: unknown[] = [];
  const installs: unknown[] = [];
  const removes: unknown[] = [];
  const previews: string[] = [];
  const host: ExtensionCatalogHost & {
    preparedInstalls: unknown[];
    preparedRemoves: unknown[];
    installs: unknown[];
    removes: unknown[];
    previews: string[];
  } = {
    preparedInstalls,
    preparedRemoves,
    installs,
    removes,
    previews,
    searchExtensions: async (query) => items.filter((item) =>
      `${item.id} ${item.displayName} ${item.description}`.toLowerCase().includes(query.toLowerCase())
    ),
    previewExtensionUrl: async (url) => {
      previews.push(url);
      return {
        id: 'remote-demo',
        type: 'skill',
        displayName: 'Remote Demo',
        version: '1.0.0',
        category: 'skill.remote',
        description: '远程扩展',
        installHandler: 'manifest.record',
        source: url,
        trusted: false,
      };
    },
    prepareInstallAction: async (input) => {
      preparedInstalls.push(input);
      return {
        ok: true,
        nonce: 'nonce-install-1',
        expiresAt: '2026-05-07T04:10:00.000Z',
        item: input.item,
        message: '等待确认安装',
      };
    },
    confirmInstallAction: async (nonce: string, actor: ExtensionActionActor) => {
      installs.push({ nonce, actor });
      if (options.expiredConfirm) {
        return { ok: false, status: 'expired', message: '确认已过期' };
      }
      return {
        ok: true,
        status: 'installed',
        message: '安装已完成：Qwen3 8B',
        item: items[0],
      };
    },
    prepareRemoveAction: async (input) => {
      preparedRemoves.push(input);
      return {
        ok: true,
        nonce: 'nonce-remove-1',
        expiresAt: '2026-05-07T04:10:00.000Z',
        item: items[1],
        message: '移除记录，不删除插件缓存。',
      };
    },
    confirmRemoveAction: async (nonce: string, actor: ExtensionActionActor) => {
      removes.push({ nonce, actor });
      return {
        ok: true,
        status: 'removed',
        message: '记录已移除：Browser',
        item: items[1],
      };
    },
  };
  return host;
}

function createRunningAdapter(
  channelType: string,
  sendFn: (message: OutboundMessage) => Promise<SendResult>,
): BaseChannelAdapter {
  return {
    channelType,
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send: sendFn,
    validateConfig: () => null,
    isAuthorized: () => true,
  } as unknown as BaseChannelAdapter;
}
