/**
 * Unit tests for bridge channel-router.
 *
 * Tests the routing logic with a mock BridgeStore, verifying:
 * - resolve() creates new binding when none exists
 * - resolve() returns existing binding when session exists
 * - resolve() recreates binding when session was deleted
 * - createBinding() uses default settings
 * - bindToSession() validates session existence
 * - listBindings() delegates to store
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import * as router from '../../lib/bridge/channel-router';
import type { BridgeStore, LLMProvider, PermissionGateway, LifecycleHooks } from '../../lib/bridge/host';
import type { ChannelBinding } from '../../lib/bridge/types';

// ── Mock Store ──────────────────────────────────────────────

function createMockStore(): BridgeStore & {
  bindings: Map<string, ChannelBinding>;
  sessions: Map<string, { id: string; working_directory: string; model: string }>;
  settings: Map<string, string>;
} {
  const bindings = new Map<string, ChannelBinding>();
  const sessions = new Map<string, { id: string; working_directory: string; model: string }>();
  const settings = new Map<string, string>([
    ['bridge_default_work_dir', '/tmp/test'],
    ['bridge_allowed_workspace_roots', '/tmp/test'],
    ['bridge_default_model', 'claude-3'],
    ['bridge_default_provider_id', ''],
    ['bridge_runtime_fingerprint', 'profile-old'],
    ['bridge_tooling_fingerprint', 'tooling-stable'],
  ]);
  let nextId = 1;

  return {
    bindings,
    sessions,
    settings,
    getSetting(key: string) {
      return settings.get(key) ?? null;
    },
    getChannelBinding(channelType: string, chatId: string) {
      return bindings.get(`${channelType}:${chatId}`) ?? null;
    },
    upsertChannelBinding(data) {
      const binding: ChannelBinding = {
        id: `binding-${nextId++}`,
        channelType: data.channelType,
        chatId: data.chatId,
        codepilotSessionId: data.codepilotSessionId,
        sdkSessionId: '',
        workingDirectory: data.workingDirectory,
        model: data.model,
        mode: 'code',
        active: true,
        bridgeFingerprint: data.bridgeFingerprint,
        toolingFingerprint: data.toolingFingerprint,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      bindings.set(`${data.channelType}:${data.chatId}`, binding);
      return binding;
    },
    updateChannelBinding(id: string, updates: Partial<ChannelBinding>) {
      for (const [key, b] of bindings) {
        if (b.id === id) {
          bindings.set(key, { ...b, ...updates });
          break;
        }
      }
    },
    listChannelBindings(channelType?: string) {
      const all = Array.from(bindings.values());
      return channelType ? all.filter(b => b.channelType === channelType) : all;
    },
    getSession(id: string) {
      return sessions.get(id) ?? null;
    },
    createSession(name: string, model: string, _systemPrompt?: string, cwd?: string) {
      const session = { id: `session-${nextId++}`, working_directory: cwd || '', model };
      sessions.set(session.id, session);
      return session;
    },
    updateSessionProviderId() {},
    addMessage() {},
    getMessages() { return { messages: [] }; },
    retrieveRelevantMemory() { return null; },
    acquireSessionLock() { return true; },
    renewSessionLock() {},
    releaseSessionLock() {},
    setSessionRuntimeStatus() {},
    updateSdkSessionId() {},
    updateSessionModel() {},
    syncSdkTasks() {},
    getProvider() { return undefined; },
    getDefaultProviderId() { return null; },
    insertAuditLog() {},
    checkDedup() { return false; },
    insertDedup() {},
    cleanupExpiredDedup() {},
    insertOutboundRef() {},
    insertPermissionLink() {},
    getPermissionLink() { return null; },
    markPermissionLinkResolved() { return false; },
    listPendingPermissionLinksByChat() { return []; },
    getChannelOffset() { return '0'; },
    setChannelOffset() {},
  };
}

const noopLLM: LLMProvider = { streamChat: () => new ReadableStream() };
const noopPerms: PermissionGateway = { resolvePendingPermission: () => false };
const noopLifecycle: LifecycleHooks = {};

function setupContext(store: BridgeStore) {
  // Force re-initialization by clearing the global
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  initBridgeContext({
    store,
    llm: noopLLM,
    permissions: noopPerms,
    lifecycle: noopLifecycle,
  });
}

// ── Tests ───────────────────────────────────────────────────

describe('channel-router', () => {
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    store = createMockStore();
    setupContext(store);
  });

  it('resolve() creates new binding when none exists', () => {
    const binding = router.resolve({
      channelType: 'telegram',
      chatId: '123',
      displayName: 'Test User',
    });

    assert.ok(binding.id);
    assert.equal(binding.channelType, 'telegram');
    assert.equal(binding.chatId, '123');
    assert.equal(binding.workingDirectory, '/tmp/test');
    assert.equal(binding.model, 'claude-3');
    assert.equal(store.bindings.size, 1);
    assert.equal(store.sessions.size, 1);
  });

  it('resolve() returns existing binding when session exists', () => {
    // Create initial binding
    const first = router.resolve({ channelType: 'telegram', chatId: '123' });
    const second = router.resolve({ channelType: 'telegram', chatId: '123' });

    assert.equal(first.id, second.id);
    assert.equal(store.bindings.size, 1);
  });

  it('clears only sdkSessionId when bridge fingerprint changes', () => {
    const first = router.resolve({ channelType: 'telegram', chatId: 'profile-chat' });
    store.bindings.set('telegram:profile-chat', {
      ...first,
      sdkSessionId: 'old-codex-thread',
      bridgeFingerprint: 'profile-old',
      toolingFingerprint: 'tooling-stable',
    });
    store.settings.set('bridge_runtime_fingerprint', 'profile-new');

    const refreshed = router.resolve({ channelType: 'telegram', chatId: 'profile-chat' });

    assert.equal(refreshed.sdkSessionId, '');
    assert.equal(refreshed.codepilotSessionId, first.codepilotSessionId);
    assert.equal(refreshed.workingDirectory, first.workingDirectory);
    assert.equal(refreshed.bridgeFingerprint, 'profile-new');
  });

  it('resolve() recreates binding when session was deleted', () => {
    const first = router.resolve({ channelType: 'telegram', chatId: '123' });
    // Delete the session
    store.sessions.delete(first.codepilotSessionId);

    const second = router.resolve({ channelType: 'telegram', chatId: '123' });
    assert.notEqual(first.codepilotSessionId, second.codepilotSessionId);
  });

  it('resolve() refreshes bindings whose cwd is outside the allowed workspace roots', () => {
    const first = router.resolve({ channelType: 'telegram', chatId: '123' });
    const session = store.sessions.get(first.codepilotSessionId);
    assert.ok(session);
    if (session) {
      session.working_directory = '/legacy/outside';
    }
    store.bindings.set('telegram:123', {
      ...first,
      workingDirectory: '/legacy/outside',
    });

    const second = router.resolve({ channelType: 'telegram', chatId: '123' });
    assert.notEqual(first.codepilotSessionId, second.codepilotSessionId);
    assert.equal(second.workingDirectory, '/tmp/test');
  });

  it('keeps bindings inside an enabled registered project even when the legacy allowlist is narrower', () => {
    const first = router.resolve({ channelType: 'telegram', chatId: 'registered-project' });
    const registeredRoot = '/registered/project';
    const session = store.sessions.get(first.codepilotSessionId);
    assert.ok(session);
    if (session) session.working_directory = registeredRoot;
    store.bindings.set('telegram:registered-project', {
      ...first,
      workingDirectory: registeredRoot,
    });
    store.settings.set('bridge_project_registry_json', JSON.stringify({
      schema: 'codex-im-suite/project-registry/v1',
      projects: [{
        id: 'registered-project',
        displayName: 'Registered Project',
        type: 'generic',
        workspaceRoot: registeredRoot,
        accessMode: 'read_only',
        enabled: true,
      }],
    }));

    const resolved = router.resolve({ channelType: 'telegram', chatId: 'registered-project' });

    assert.equal(resolved.codepilotSessionId, first.codepilotSessionId);
    assert.equal(resolved.workingDirectory, registeredRoot);
  });

  it('still rejects a binding when its matching registered project is disabled', () => {
    const first = router.resolve({ channelType: 'telegram', chatId: 'disabled-project' });
    const disabledRoot = '/registered/disabled';
    const session = store.sessions.get(first.codepilotSessionId);
    assert.ok(session);
    if (session) session.working_directory = disabledRoot;
    store.bindings.set('telegram:disabled-project', {
      ...first,
      workingDirectory: disabledRoot,
    });
    store.settings.set('bridge_project_registry_json', JSON.stringify({
      schema: 'codex-im-suite/project-registry/v1',
      projects: [{
        id: 'disabled-project',
        displayName: 'Disabled Project',
        type: 'generic',
        workspaceRoot: disabledRoot,
        accessMode: 'read_write',
        enabled: false,
      }],
    }));

    const resolved = router.resolve({ channelType: 'telegram', chatId: 'disabled-project' });

    assert.notEqual(resolved.codepilotSessionId, first.codepilotSessionId);
    assert.equal(resolved.workingDirectory, '/tmp/test');
  });

  it('resolve() rebinds to a fresh session after the binding has been idle too long', () => {
    const oldIdleMs = process.env.CTI_SESSION_IDLE_FRESH_MS;
    process.env.CTI_SESSION_IDLE_FRESH_MS = '3600000';
    try {
      const first = router.resolve({ channelType: 'telegram', chatId: 'idle-chat' });
      store.bindings.set('telegram:idle-chat', {
        ...first,
        sdkSessionId: 'old-sdk-session',
        updatedAt: new Date(Date.now() - 2 * 3600000).toISOString(),
      });

      const second = router.resolve({ channelType: 'telegram', chatId: 'idle-chat' });
      assert.notEqual(first.codepilotSessionId, second.codepilotSessionId);
      assert.equal(second.sdkSessionId, '');
    } finally {
      if (oldIdleMs === undefined) delete process.env.CTI_SESSION_IDLE_FRESH_MS;
      else process.env.CTI_SESSION_IDLE_FRESH_MS = oldIdleMs;
    }
  });

  it('createBinding() uses custom working directory', () => {
    const binding = router.createBinding(
      { channelType: 'telegram', chatId: '456' },
      '/custom/path',
    );
    assert.equal(binding.workingDirectory, '/custom/path');
  });

  it('bindToSession() returns null for non-existent session', () => {
    const result = router.bindToSession(
      { channelType: 'telegram', chatId: '789' },
      'non-existent',
    );
    assert.equal(result, null);
  });

  it('bindToSession() binds to existing session', () => {
    const session = store.createSession('Test', 'claude-3', undefined, '/test');
    const binding = router.bindToSession(
      { channelType: 'telegram', chatId: '789' },
      session.id,
    );
    assert.ok(binding);
    assert.equal(binding!.codepilotSessionId, session.id);
  });

  it('listBindings() filters by channel type', () => {
    router.createBinding({ channelType: 'telegram', chatId: '1' });
    router.createBinding({ channelType: 'discord', chatId: '2' });
    router.createBinding({ channelType: 'telegram', chatId: '3' });

    const telegramBindings = router.listBindings('telegram');
    assert.equal(telegramBindings.length, 2);

    const allBindings = router.listBindings();
    assert.equal(allBindings.length, 3);
  });

  it('updateBinding() updates binding properties', () => {
    const binding = router.createBinding({ channelType: 'telegram', chatId: '1' });
    router.updateBinding(binding.id, { mode: 'plan' });

    const updated = store.bindings.get('telegram:1');
    assert.equal(updated?.mode, 'plan');
  });
});
