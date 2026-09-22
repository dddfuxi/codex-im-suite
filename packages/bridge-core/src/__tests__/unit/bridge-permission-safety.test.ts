/**
 * Regression tests for role-based permission safety.
 *
 * These tests use a temporary CTI_HOME so bridge-manager reads a controlled
 * permissions.json before the module is first imported in this test process.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initBridgeContext } from '../../lib/bridge/context';
import type { BridgeStore, PermissionLinkInput, PermissionResolution, StreamChatParams, UpsertChannelBindingInput } from '../../lib/bridge/host';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { ChannelBinding, OutboundMessage } from '../../lib/bridge/types';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-permission-safety-'));
fs.mkdirSync(path.join(TEST_HOME, 'data'), { recursive: true });
fs.writeFileSync(
  path.join(TEST_HOME, 'data', 'permissions.json'),
  JSON.stringify({
    subjects: [
      { channelType: 'feishu', userId: 'ou_operator', role: 'operator', displayName: 'Operator' },
      { channelType: 'feishu', userId: 'ou_owner', role: 'owner', displayName: 'Owner' },
    ],
  }),
  'utf8',
);
process.env.CTI_HOME = TEST_HOME;

interface TestPermissionLink {
  permissionRequestId: string;
  channelType?: string;
  chatId: string;
  messageId: string;
  resolved: boolean;
  suggestions: string;
  toolName?: string;
  toolInputJson?: string;
}

function createPermissionStore(settings: Record<string, string> = {}) {
  const links = new Map<string, TestPermissionLink>();
  const bindings = new Map<string, ChannelBinding>();
  let sessionCounter = 0;
  const mergedSettings: Record<string, string> = {
    bridge_delivery_rate_limit_max_messages: '0',
    bridge_default_work_dir: process.cwd(),
    ...settings,
  };

  const store = {
    links,
    getSetting: (key: string) => mergedSettings[key] ?? '',
    getChannelBinding: (channelType: string, chatId: string) => bindings.get(`${channelType}:${chatId}`) ?? null,
    upsertChannelBinding: (input: UpsertChannelBindingInput) => {
      const key = `${input.channelType}:${input.chatId}`;
      const binding: ChannelBinding = {
        id: bindings.get(key)?.id || `binding_${bindings.size + 1}`,
        channelType: input.channelType,
        chatId: input.chatId,
        displayName: input.displayName,
        chatType: input.chatType,
        codepilotSessionId: input.codepilotSessionId,
        sdkSessionId: input.sdkSessionId || '',
        workingDirectory: input.workingDirectory ?? process.cwd(),
        model: input.model ?? '',
        mode: input.mode === 'plan' || input.mode === 'ask' || input.mode === 'code' ? input.mode : 'code',
        active: true,
        createdAt: new Date('2026-07-10T00:00:00.000Z').toISOString(),
        updatedAt: new Date('2026-07-10T00:00:00.000Z').toISOString(),
      };
      bindings.set(key, binding);
      return binding;
    },
    updateChannelBinding: () => {},
    listChannelBindings: () => Array.from(bindings.values()),
    getSession: () => null,
    createSession: (_title: string, model = '', systemPrompt?: string, workingDirectory = process.cwd()) => {
      sessionCounter += 1;
      return { id: `session_${sessionCounter}`, working_directory: workingDirectory, model, system_prompt: systemPrompt, provider_id: '' };
    },
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
    insertPermissionLink: (link: PermissionLinkInput) => {
      links.set(link.permissionRequestId, { ...link, resolved: false });
    },
    getPermissionLink: (id: string) => links.get(id) ?? null,
    markPermissionLinkResolved: (id: string) => {
      const link = links.get(id);
      if (!link || link.resolved) return false;
      link.resolved = true;
      return true;
    },
    listPendingPermissionLinksByChat: (chatId: string) => [...links.values()].filter((link) => link.chatId === chatId && !link.resolved),
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  } satisfies BridgeStore & { links: Map<string, TestPermissionLink> };

  return store;
}

function createAdapter(sent: OutboundMessage[]): BaseChannelAdapter {
  return {
    channelType: 'feishu',
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send: async (message: OutboundMessage) => {
      sent.push(message);
      return { ok: true, messageId: `om_${sent.length}` };
    },
    validateConfig: () => null,
    isAuthorized: () => true,
  } as unknown as BaseChannelAdapter;
}

function createInboundMessage(text: string, userId: string, chatId = 'oc_group') {
  return {
    messageId: 'm_1',
    address: { channelType: 'feishu' as const, chatId, userId },
    text,
    timestamp: new Date('2026-07-10T12:00:00.000Z').getTime(),
  };
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

async function importBridgeManager() {
  return import('../../lib/bridge/bridge-manager');
}

describe('bridge-manager permission safety', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('requires owner before an operator can approve a high-risk permission card', async () => {
    const sent: OutboundMessage[] = [];
    const resolved: Array<{ id: string; resolution: PermissionResolution }> = [];
    const store = createPermissionStore();
    store.links.set('perm-danger', {
      permissionRequestId: 'perm-danger',
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_perm',
      resolved: false,
      suggestions: '',
      toolName: 'Bash',
      toolInputJson: JSON.stringify({ command: 'Remove-Item -Recurse C:\\important' }),
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: {
        resolvePendingPermission: (id, resolution) => {
          resolved.push({ id, resolution });
          return true;
        },
      },
      lifecycle: {},
    });
    const adapter = createAdapter(sent);
    const { _testOnly } = await importBridgeManager();

    await _testOnly.handleMessage(adapter, {
      ...createInboundMessage('', 'ou_operator'),
      callbackData: 'perm:allow:perm-danger',
      callbackMessageId: 'om_perm',
    });

    assert.equal(resolved.length, 0);
    assert.equal(store.links.get('perm-danger')?.resolved, false);
    assert.match(sent[0].text, /只允许 owner/);
  });

  it('allows owner to approve a high-risk permission card', async () => {
    const sent: OutboundMessage[] = [];
    const resolved: Array<{ id: string; resolution: PermissionResolution }> = [];
    const store = createPermissionStore();
    store.links.set('perm-danger', {
      permissionRequestId: 'perm-danger',
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_perm',
      resolved: false,
      suggestions: '',
      toolName: 'Bash',
      toolInputJson: JSON.stringify({ command: 'git push origin codex/dev' }),
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: {
        resolvePendingPermission: (id, resolution) => {
          resolved.push({ id, resolution });
          return true;
        },
      },
      lifecycle: {},
    });
    const adapter = createAdapter(sent);
    const { _testOnly } = await importBridgeManager();

    await _testOnly.handleMessage(adapter, {
      ...createInboundMessage('', 'ou_owner'),
      callbackData: 'perm:allow:perm-danger',
      callbackMessageId: 'om_perm',
    });

    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].id, 'perm-danger');
    assert.equal(resolved[0].resolution.behavior, 'allow');
    assert.equal(store.links.get('perm-danger')?.resolved, true);
  });

  it('keeps low-risk read permissions available to operators', async () => {
    const sent: OutboundMessage[] = [];
    const resolved: Array<{ id: string; resolution: PermissionResolution }> = [];
    const store = createPermissionStore();
    store.links.set('perm-read', {
      permissionRequestId: 'perm-read',
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_perm',
      resolved: false,
      suggestions: '',
      toolName: 'Read',
      toolInputJson: JSON.stringify({ file_path: 'README.md' }),
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: {
        resolvePendingPermission: (id, resolution) => {
          resolved.push({ id, resolution });
          return true;
        },
      },
      lifecycle: {},
    });
    const adapter = createAdapter(sent);
    const { _testOnly } = await importBridgeManager();

    await _testOnly.handleMessage(adapter, {
      ...createInboundMessage('', 'ou_operator'),
      callbackData: 'perm:allow:perm-read',
      callbackMessageId: 'om_perm',
    });

    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].id, 'perm-read');
    assert.equal(sent[0].text, 'Permission response recorded.');
  });

  it('requires owner for high-risk /perm text approvals', async () => {
    const sent: OutboundMessage[] = [];
    const resolved: Array<{ id: string; resolution: PermissionResolution }> = [];
    const store = createPermissionStore();
    store.links.set('perm-danger', {
      permissionRequestId: 'perm-danger',
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_perm',
      resolved: false,
      suggestions: '',
      toolName: 'Write',
      toolInputJson: JSON.stringify({ file_path: 'src/index.ts', content: 'mutating write' }),
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: {
        resolvePendingPermission: (id, resolution) => {
          resolved.push({ id, resolution });
          return true;
        },
      },
      lifecycle: {},
    });
    const adapter = createAdapter(sent);
    const { _testOnly } = await importBridgeManager();

    await _testOnly.handleMessage(adapter, createInboundMessage('/perm allow perm-danger', 'ou_operator'));

    assert.equal(resolved.length, 0);
    assert.equal(store.links.get('perm-danger')?.resolved, false);
    assert.match(sent[0].text, /只允许 owner/);
  });

  it('requires owner for high-risk numeric shortcut approvals', async () => {
    const sent: OutboundMessage[] = [];
    const resolved: Array<{ id: string; resolution: PermissionResolution }> = [];
    const store = createPermissionStore();
    store.links.set('perm-danger', {
      permissionRequestId: 'perm-danger',
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_perm',
      resolved: false,
      suggestions: '',
      toolName: 'Bash',
      toolInputJson: JSON.stringify({ command: 'shutdown /s /t 0' }),
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: {
        resolvePendingPermission: (id, resolution) => {
          resolved.push({ id, resolution });
          return true;
        },
      },
      lifecycle: {},
    });
    const adapter = createAdapter(sent);
    const { _testOnly } = await importBridgeManager();

    await _testOnly.handleMessage(adapter, createInboundMessage('1', 'ou_operator'));

    assert.equal(resolved.length, 0);
    assert.equal(store.links.get('perm-danger')?.resolved, false);
    assert.match(sent[0].text, /只允许 owner/);
  });

  it('blocks cti-reminder from being used as a scheduled system-action shortcut for ordinary users', async () => {
    const sent: OutboundMessage[] = [];
    const created: unknown[] = [];
    const response = [
      '```cti-reminder',
      JSON.stringify({
        title: '关闭屏幕',
        dueAt: '2026-07-10T12:10:00.000Z',
        timezone: 'Asia/Shanghai',
        target: 'current_chat',
        sourcePrompt: '帮我安排一个后续动作',
      }),
      '```',
    ].join('\n');
    const store = createPermissionStore({ bridge_feishu_owner_users: 'ou_owner' });
    initBridgeContext({
      store,
      llm: { streamChat: (_params: StreamChatParams) => createTextStream(response) },
      permissions: { resolvePendingPermission: () => false },
      reminders: {
        createDirectReminder: async (input) => {
          created.push(input);
          return { ok: true, reminderId: 'rem_danger', title: input.title, dueAt: input.dueAt, target: input.target };
        },
      },
      lifecycle: {},
    });
    const adapter = createAdapter(sent);
    const { _testOnly } = await importBridgeManager();

    await _testOnly.handleMessage(adapter, createInboundMessage('帮我安排一个后续动作', 'ou_viewer'));

    assert.equal(created.length, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /只允许 owner/);
  });

  it('blocks /remind from storing system-affecting commands as ordinary low-risk reminders', async () => {
    const sent: OutboundMessage[] = [];
    const created: unknown[] = [];
    const store = createPermissionStore({ bridge_feishu_owner_users: 'ou_owner' });
    initBridgeContext({
      store,
      llm: {
        streamChat: () => {
          throw new Error('LLM should not run for /remind command');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      reminders: {
        createDirectReminder: async (input) => {
          created.push(input);
          return { ok: true, reminderId: 'rem_command', title: input.title, dueAt: input.dueAt, target: input.target };
        },
      },
      lifecycle: {},
    });
    const adapter = createAdapter(sent);
    const { _testOnly } = await importBridgeManager();

    await _testOnly.handleMessage(adapter, createInboundMessage('/remind 10分钟后 关闭屏幕', 'ou_viewer'));

    assert.equal(created.length, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /只允许 owner/);
  });

  it('blocks session and runtime management slash commands for ordinary users', async () => {
    const commands = ['/new', '/bind 1234567890abcdef1234567890abcdef', '/cwd .', '/mode plan', '/status', '/docs', '/projects', '/sessions', '/stop'];

    for (const command of commands) {
      const sent: OutboundMessage[] = [];
      const store = createPermissionStore();
      initBridgeContext({
        store,
        llm: {
          streamChat: () => {
            throw new Error('LLM should not run for blocked slash commands');
          },
        },
        permissions: { resolvePendingPermission: () => false },
        lifecycle: {},
      });
      const adapter = createAdapter(sent);
      const { _testOnly } = await importBridgeManager();

      await _testOnly.handleMessage(adapter, createInboundMessage(command, 'ou_viewer'));

      assert.equal(sent.length, 1, command);
      assert.match(sent[0].text, /operator 或 owner/, command);
      assert.doesNotMatch(sent[0].text, /New session|Bound to session|Working directory set|Mode set|Bridge Status|Sessions|No task/, command);
    }
  });

  it('keeps whoami and ordinary chat available to ordinary users', async () => {
    const sent: OutboundMessage[] = [];
    const streamParams: StreamChatParams[] = [];
    const store = createPermissionStore();
    initBridgeContext({
      store,
      llm: {
        streamChat: (params) => {
          streamParams.push(params);
          return createTextStream('普通聊天可以继续。');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createAdapter(sent);
    const { _testOnly } = await importBridgeManager();

    await _testOnly.handleMessage(adapter, createInboundMessage('/whoami', 'ou_viewer'));
    await _testOnly.handleMessage(adapter, createInboundMessage('帮我解释一下权限模型是什么', 'ou_viewer'));

    assert.match(sent[0].text, /role: <b>none<\/b>/);
    assert.equal(streamParams.length, 1);
    assert.match(sent[1].text, /普通聊天可以继续/);
  });

  it('allows operators to use session management slash commands', async () => {
    const sent: OutboundMessage[] = [];
    const store = createPermissionStore();
    initBridgeContext({
      store,
      llm: {
        streamChat: () => {
          throw new Error('LLM should not run for slash command handling');
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
    const adapter = createAdapter(sent);
    const { _testOnly } = await importBridgeManager();

    await _testOnly.handleMessage(adapter, createInboundMessage('/mode plan', 'ou_operator'));
    await _testOnly.handleMessage(adapter, createInboundMessage('/status', 'ou_operator'));

    assert.match(sent[0].text, /Mode set/);
    assert.match(sent[1].text, /Bridge Status/);
  });
});
