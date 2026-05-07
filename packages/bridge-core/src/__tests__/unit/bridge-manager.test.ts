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
import { initBridgeContext } from '../../lib/bridge/context';
import type { BridgeStore, LifecycleHooks, UpsertChannelBindingInput } from '../../lib/bridge/host';
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

  it('routes pure small talk without turning it into a tool prompt', async () => {
    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    assert.match(_testOnly.buildSmallTalkReply('你好呀'), /闲聊/);
    assert.equal(_testOnly.buildSmallTalkReply('帮我看一下 Unity'), '');
    assert.equal(_testOnly.buildSmallTalkReply('你好呀，帮我发布'), '');
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

    assert.equal(_testOnly.parseNaturalReminderRequest('这个任务为什么卡住', now), null);
    assert.equal(_testOnly.parseNaturalReminderRequest('帮我写计划任务脚本，提醒我看电脑', now), null);
    assert.equal(_testOnly.parseNaturalReminderRequest('今天有什么待办', now), null);
  });
});

function createMinimalStore(settings: Record<string, string> = {}): BridgeStore {
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

function createInboundMessage(text: string) {
  return {
    messageId: 'm_1',
    address: { channelType: 'feishu', chatId: 'oc_123', userId: 'ou_1' },
    text,
    timestamp: new Date('2026-05-07T04:00:00.000Z').getTime(),
  };
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
