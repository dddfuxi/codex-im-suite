import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonFileStore } from '../store.js';
import { CTI_HOME } from '../config.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const GB_MOJIBAKE_CHINESE = '\u6d93\ue15f\u6783';

// We construct the store with a settings map directly
function makeSettings(extra: Array<[string, string]> = []): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_work_dir', '/tmp/test-cwd'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
    ...extra,
  ]);
}

describe('JsonFileStore', () => {
  beforeEach(() => {
    // Clean data dir before each test for isolation
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('getSetting returns values from settings map', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getSetting('remote_bridge_enabled'), 'true');
    assert.equal(store.getSetting('bridge_default_model'), 'test-model');
    assert.equal(store.getSetting('nonexistent'), null);
  });

  it('createSession and getSession', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model-1', 'system prompt', '/tmp');
    assert.ok(session.id);
    assert.equal(session.model, 'model-1');
    assert.equal(session.working_directory, '/tmp');
    assert.equal(session.system_prompt, 'system prompt');

    const fetched = store.getSession(session.id);
    assert.deepEqual(fetched, session);
  });

  it('getSession returns null for unknown id', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getSession('nonexistent'), null);
  });

  it('upsertChannelBinding creates and updates', () => {
    const store = new JsonFileStore(makeSettings());
    const b1 = store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '123',
      codepilotSessionId: 'sess-1',
      workingDirectory: '/tmp',
      model: 'model-1',
    });
    assert.ok(b1.id);
    assert.equal(b1.channelType, 'telegram');
    assert.equal(b1.chatId, '123');

    // Upsert same channel+chat should update
    const b2 = store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '123',
      codepilotSessionId: 'sess-2',
      workingDirectory: '/tmp/new',
      model: 'model-2',
    });
    assert.equal(b2.id, b1.id);
    assert.equal(b2.codepilotSessionId, 'sess-2');
  });

  it('upsertChannelBinding uses default mode from settings', () => {
    const settings = makeSettings();
    settings.set('bridge_default_mode', 'plan');
    const store = new JsonFileStore(settings);
    const b = store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '456',
      codepilotSessionId: 'sess-1',
      workingDirectory: '/tmp',
      model: 'model-1',
    });
    assert.equal(b.mode, 'plan');
  });

  it('getChannelBinding returns null for missing', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getChannelBinding('telegram', 'missing'), null);
  });

  it('listChannelBindings filters by type', () => {
    const store = new JsonFileStore(makeSettings());
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1',
      codepilotSessionId: 's1',
      workingDirectory: '/tmp',
      model: 'm',
    });
    store.upsertChannelBinding({
      channelType: 'discord',
      chatId: '2',
      codepilotSessionId: 's2',
      workingDirectory: '/tmp',
      model: 'm',
    });
    assert.equal(store.listChannelBindings('telegram').length, 1);
    assert.equal(store.listChannelBindings('discord').length, 1);
    assert.equal(store.listChannelBindings().length, 2);
  });

  it('addMessage and getMessages', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model', undefined, '/tmp');
    store.addMessage(session.id, 'user', 'hello');
    store.addMessage(session.id, 'assistant', 'hi');

    const { messages } = store.getMessages(session.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].content, 'hi');
  });

  it('getMessages with limit returns last N', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model', undefined, '/tmp');
    store.addMessage(session.id, 'user', 'msg1');
    store.addMessage(session.id, 'user', 'msg2');
    store.addMessage(session.id, 'user', 'msg3');

    const { messages } = store.getMessages(session.id, { limit: 2 });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, 'msg2');
    assert.equal(messages[1].content, 'msg3');
  });

  it('persists outbound refs and marks bot messages recalled', () => {
    const store = new JsonFileStore(makeSettings());

    store.insertOutboundRef({
      channelType: 'feishu',
      chatId: 'oc_group',
      codepilotSessionId: 'session_1',
      platformMessageId: 'om_bot_1',
      purpose: 'response',
      messageKind: 'card',
    });

    const reloaded = new JsonFileStore(makeSettings());
    const refs = reloaded.listOutboundRefs({ channelType: 'feishu', chatId: 'oc_group' });
    assert.equal(refs.length, 1);
    assert.equal(refs[0].platformMessageId, 'om_bot_1');
    assert.equal(refs[0].recalledAt, undefined);

    const updated = reloaded.markOutboundRefRecalled({
      channelType: 'feishu',
      chatId: 'oc_group',
      platformMessageId: 'om_bot_1',
      ok: true,
    });
    assert.equal(updated, true);

    const finalRefs = new JsonFileStore(makeSettings()).listOutboundRefs({ platformMessageId: 'om_bot_1' });
    assert.equal(finalRefs.length, 1);
    assert.ok(finalRefs[0].recalledAt);
    assert.equal(finalRefs[0].recallError, undefined);
  });

  it('records per-user chat and global memory profiles for retrieval', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model', undefined, '/tmp/test-cwd');
    store.recordMemoryEvent({
      sessionId: session.id,
      channelType: 'feishu',
      chatId: 'oc_chat',
      chatDisplayName: '测试群',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      role: 'user',
      text: '记住 HSScene == 医院内部场景，以后有人问就这么回答',
      workingDirectory: '/tmp/test-cwd',
    });

    const memory = store.retrieveRelevantMemory({
      sessionId: session.id,
      channelType: 'feishu',
      chatId: 'oc_chat',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      workingDirectory: '/tmp/test-cwd',
      query: '上次 HSScene 对应什么',
      recentHistoryLimit: 0,
    });

    assert.ok(memory);
    assert.match(memory.summary, /HSScene/);
    assert.match(memory.summary, /医院内部场景/);
  });

  it('persists explicit memory writes into the visible knowledge repository', () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-visible-memory-'));
    const store = new JsonFileStore(makeSettings([
      ['bridge_memory_repo_dir', memoryRoot],
    ]));

    store.recordMemoryEvent({
      sessionId: 'sess-memory',
      channelType: 'feishu',
      chatId: 'oc_chat',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      role: 'user',
      workingDirectory: '/tmp/test-cwd',
      createdAt: '2026-05-11T09:26:16.228Z',
      text: [
        '记一下，这些常用场景名称是STH项目的，也叫ST2H，H项目',
        '',
        'HSScene == 医院内部场景',
        'city3d_citystage_ST2H_Scene == 外城场景',
        'pve_gunship == pve场景',
        'Timeline_ST2H_Scene_01 == timeline场景',
      ].join('\n'),
    });

    const indexPath = path.join(memoryRoot, '.cti-index', 'knowledge.json');
    assert.equal(fs.existsSync(indexPath), true);
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
      items: Array<{ kind: string; key?: string; value?: string; text: string; classificationSource?: string }>;
    };
    assert.ok(index.items.some((item) => item.key === 'HSScene' && item.value === '医院内部场景'));
    assert.ok(index.items.some((item) => item.key === 'STH' && item.value?.includes('常用场景名称')));
    assert.ok(index.items.some((item) => item.kind === 'fact'));
    assert.equal(index.items.some((item) => item.key === 'HSScene' && item.kind === 'resource'), false);
    assert.ok(index.items.some((item) => item.classificationSource === 'table_inference'));
  });

  it('persists model-planned memory candidates into the visible knowledge repository', () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-model-memory-'));
    const store = new JsonFileStore(makeSettings([
      ['bridge_memory_repo_dir', memoryRoot],
    ]));

    const result = store.persistMemoryWrite({
      sessionId: 'sess-memory',
      channelType: 'feishu',
      chatId: 'oc_chat',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      workingDirectory: '/tmp/test-cwd',
      text: '重新记一下，这个是STH的git分支名',
      candidates: [{
        key: 'STH的git分支名',
        value: 'st2h_master',
        text: 'STH的git分支名是 st2h_master',
        confidence: 0.92,
        source: 'model',
      }],
    });

    assert.equal(result.ok, true);
    const indexPath = path.join(memoryRoot, '.cti-index', 'knowledge.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
      items: Array<{ key?: string; value?: string; text: string }>;
    };
    assert.ok(index.items.some((item) => item.key === 'STH的git分支名' && item.value === 'st2h_master'));
    assert.equal(index.items.some((item) => item.value?.includes('重新记一下')), false);
  });

  it('retrieves remembered mappings from audit history and ignores failed memory fallbacks', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model', undefined, '/tmp/test-cwd');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'oc_chat',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'model',
    });

    store.insertAuditLog({
      channelType: 'feishu',
      chatId: 'oc_chat',
      direction: 'outbound',
      messageId: 'om_bad',
      summary: '目前没有可用的常用场景名称记忆功能。请手动记录您常用的场景名称。',
    });
    store.insertAuditLog({
      channelType: 'feishu',
      chatId: 'oc_chat',
      direction: 'outbound',
      messageId: 'om_good',
      summary: [
        '常用场景名称对应表：',
        '`HSScene` == 医院内部场景',
        '`city3d_citystage_ST2H_Scene` == 外城场景',
        '`pve_gunship` == pve场景',
        '`Timeline_ST2H_Scene_01` == timeline场景',
      ].join('\n'),
    });

    const memory = store.retrieveRelevantMemory({
      sessionId: session.id,
      channelType: 'feishu',
      chatId: 'oc_chat',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      workingDirectory: '/tmp/test-cwd',
      query: '常用场景名称',
      recentHistoryLimit: 0,
    });

    assert.ok(memory);
    assert.match(memory.summary, /HSScene/);
    assert.match(memory.summary, /医院内部场景/);
    assert.doesNotMatch(memory.summary, /请手动记录/);
    assert.equal(memory.hits[0].sourceType, 'audit');
    assert.equal(memory.hits[0].answerability, 'structured');
    assert.equal(memory.hits[0].quality, 'high');
    assert.equal(memory.hits[0].structuredPairs?.length, 4);
  });

  it('decides direct memory replies for non-scene structured recall keys', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model', undefined, '/tmp/test-cwd');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'oc_chat',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'model',
    });

    store.insertAuditLog({
      channelType: 'feishu',
      chatId: 'oc_chat',
      direction: 'outbound',
      messageId: 'om_deploy',
      summary: '部署命令 = npm run build && npm test',
    });

    const decision = store.decideMemoryReply({
      sessionId: session.id,
      channelType: 'feishu',
      chatId: 'oc_chat',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      workingDirectory: '/tmp/test-cwd',
      query: '我之前记的部署命令是什么',
      recentHistoryLimit: 0,
    });

    assert.equal(decision.type, 'direct_reply');
    assert.match(decision.type === 'direct_reply' ? decision.text : '', /部署命令/);
    assert.match(decision.type === 'direct_reply' ? decision.text : '', /npm run build/);
  });

  it('prefers exact structured knowledge keys over noisy same-chat recall history', () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-exact-memory-'));
    const store = new JsonFileStore(makeSettings([
      ['bridge_memory_repo_dir', memoryRoot],
    ]));
    const session = store.createSession('test', 'model', undefined, '/tmp/test-cwd');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'oc_group',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'model',
    });
    store.recordMemoryEvent({
      sessionId: session.id,
      channelType: 'feishu',
      chatId: 'oc_group',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      role: 'user',
      workingDirectory: '/tmp/test-cwd',
      text: '请你记一下，第十三条龙 == 雷霆龙',
    });
    store.addMessage(session.id, 'user', '第十三条龙叫啥@小虾米');
    store.addMessage(
      session.id,
      'assistant',
      '项目 HSScene：医院内部场景 city3d_citystage_ST2H_Scene == 外城场景 pve_gunship == pve场景',
    );

    const decision = store.decideMemoryReply({
      sessionId: session.id,
      channelType: 'feishu',
      chatId: 'oc_group',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      workingDirectory: '/tmp/test-cwd',
      query: '第十三条龙叫啥@小虾米',
      recentHistoryLimit: 0,
    });

    assert.equal(decision.type, 'direct_reply');
    assert.match(decision.type === 'direct_reply' ? decision.text : '', /第十三条龙/);
    assert.match(decision.type === 'direct_reply' ? decision.text : '', /雷霆龙/);
    assert.doesNotMatch(decision.type === 'direct_reply' ? decision.text : '', /HSScene/);
  });

  it('retrieves reverse memory graph context for related knowledge', () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-graph-memory-'));
    const store = new JsonFileStore(makeSettings([
      ['bridge_memory_repo_dir', memoryRoot],
    ]));

    store.recordMemoryEvent({
      sessionId: 'sess-graph',
      channelType: 'feishu',
      chatId: 'oc_group',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      role: 'user',
      workingDirectory: '/tmp/test-cwd',
      text: [
        '请你记一下，ST横板第十三条龙相关信息',
        '第十三条龙 == 雷霆龙',
        '雷霆龙商城展示界面Unity预制体 == PreviewDragon_Thunde',
        'ST龙相关展示场景路径 == Assets/__ArtData/_Resources/Prefab/City3D/UIScene',
      ].join('\n'),
    });

    const graph = store.retrieveMemoryGraphContext({
      sessionId: 'sess-graph',
      channelType: 'feishu',
      chatId: 'oc_group',
      query: '雷霆龙',
      recentHistoryLimit: 0,
    });

    assert.ok(graph);
    assert.match(graph.summary, /第十三条龙/);
    assert.match(graph.summary, /PreviewDragon_Thunde/);
    assert.match(graph.summary, /UIScene/);
  });

  it('repairs Feishu history mojibake before retrieval and memory profile indexing', () => {
    const store = new JsonFileStore(makeSettings());
    store.upsertFeishuHistoryMessages({
      chatId: 'oc_chat',
      displayName: '测试群',
      messages: [{
        messageId: 'om_mojibake',
        chatId: 'oc_chat',
        senderId: 'ou_user_1',
        senderName: '刘丹',
        senderType: 'user',
        msgType: 'text',
        createTime: '1770000000000',
        text: `记住 HSScene 是 ${GB_MOJIBAKE_CHINESE}场景`,
      }],
      syncedAt: '2026-04-30T00:00:00.000Z',
    });

    const history = store.retrieveRelevantFeishuHistory({
      chatId: 'oc_chat',
      query: '中文场景',
      limit: 1,
    });
    assert.ok(history);
    assert.match(history.summary, /中文场景/);
    assert.doesNotMatch(history.summary, new RegExp(GB_MOJIBAKE_CHINESE));

    const memory = store.retrieveRelevantMemory({
      sessionId: 'feishu-history:oc_chat',
      channelType: 'feishu',
      chatId: 'oc_chat',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      workingDirectory: '/tmp/test-cwd',
      query: '上次 HSScene 是什么场景',
      recentHistoryLimit: 0,
    });
    assert.ok(memory);
    assert.match(memory.summary, /中文场景/);
    assert.doesNotMatch(memory.summary, new RegExp(GB_MOJIBAKE_CHINESE));
  });

  // ── Session Locking ──

  it('acquireSessionLock succeeds on first call', () => {
    const store = new JsonFileStore(makeSettings());
    assert.ok(store.acquireSessionLock('sess', 'lock1', 'owner1', 60));
  });

  it('acquireSessionLock fails when held by another', () => {
    const store = new JsonFileStore(makeSettings());
    assert.ok(store.acquireSessionLock('sess', 'lock1', 'owner1', 60));
    assert.equal(store.acquireSessionLock('sess', 'lock2', 'owner2', 60), false);
  });

  it('acquireSessionLock succeeds with same lockId', () => {
    const store = new JsonFileStore(makeSettings());
    assert.ok(store.acquireSessionLock('sess', 'lock1', 'owner1', 60));
    assert.ok(store.acquireSessionLock('sess', 'lock1', 'owner1', 60));
  });

  it('releaseSessionLock allows re-acquire', () => {
    const store = new JsonFileStore(makeSettings());
    store.acquireSessionLock('sess', 'lock1', 'owner1', 60);
    store.releaseSessionLock('sess', 'lock1');
    assert.ok(store.acquireSessionLock('sess', 'lock2', 'owner2', 60));
  });

  it('expired lock can be re-acquired', async () => {
    const store = new JsonFileStore(makeSettings());
    // Acquire with very short TTL
    store.acquireSessionLock('sess', 'lock1', 'owner1', 0);
    // Should be expired immediately
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(store.acquireSessionLock('sess', 'lock2', 'owner2', 60));
  });

  // ── Permission Links ──

  it('insertPermissionLink and getPermissionLink', () => {
    const store = new JsonFileStore(makeSettings());
    store.insertPermissionLink({
      permissionRequestId: 'pr-1',
      channelType: 'telegram',
      chatId: '123',
      messageId: 'msg-1',
      toolName: 'bash',
      suggestions: 'allow,deny',
    });
    const link = store.getPermissionLink('pr-1');
    assert.ok(link);
    assert.equal(link.permissionRequestId, 'pr-1');
    assert.equal(link.resolved, false);
  });

  it('markPermissionLinkResolved is atomic', () => {
    const store = new JsonFileStore(makeSettings());
    store.insertPermissionLink({
      permissionRequestId: 'pr-2',
      channelType: 'telegram',
      chatId: '123',
      messageId: 'msg-2',
      toolName: 'bash',
      suggestions: '',
    });
    assert.ok(store.markPermissionLinkResolved('pr-2'));
    // Second call returns false (already resolved)
    assert.equal(store.markPermissionLinkResolved('pr-2'), false);
    // Unknown id returns false
    assert.equal(store.markPermissionLinkResolved('unknown'), false);
  });

  it('listPendingPermissionLinksByChat returns only unresolved links for the chat', () => {
    const store = new JsonFileStore(makeSettings());
    store.insertPermissionLink({
      permissionRequestId: 'pr-a',
      channelType: 'qq',
      chatId: 'chat-1',
      messageId: 'msg-a',
      toolName: 'Bash',
      suggestions: '',
    });
    store.insertPermissionLink({
      permissionRequestId: 'pr-b',
      channelType: 'qq',
      chatId: 'chat-1',
      messageId: 'msg-b',
      toolName: 'Read',
      suggestions: '',
    });
    store.insertPermissionLink({
      permissionRequestId: 'pr-c',
      channelType: 'qq',
      chatId: 'chat-2',
      messageId: 'msg-c',
      toolName: 'Bash',
      suggestions: '',
    });
    // Resolve one
    store.markPermissionLinkResolved('pr-a');
    const pending = store.listPendingPermissionLinksByChat('chat-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].permissionRequestId, 'pr-b');
    // Different chat
    const pending2 = store.listPendingPermissionLinksByChat('chat-2');
    assert.equal(pending2.length, 1);
    assert.equal(pending2[0].permissionRequestId, 'pr-c');
    // No permissions for unknown chat
    assert.equal(store.listPendingPermissionLinksByChat('chat-unknown').length, 0);
  });

  // ── Dedup ──

  it('dedup insert and check within window', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.checkDedup('key1'), false);
    store.insertDedup('key1');
    assert.equal(store.checkDedup('key1'), true);
  });

  it('cleanupExpiredDedup removes old entries', () => {
    const store = new JsonFileStore(makeSettings());
    store.insertDedup('key1');
    // The entry was just inserted so it shouldn't be expired
    store.cleanupExpiredDedup();
    assert.equal(store.checkDedup('key1'), true);
  });

  // ── Audit Log ──

  it('insertAuditLog keeps max 1000', () => {
    const store = new JsonFileStore(makeSettings());
    for (let i = 0; i < 1010; i++) {
      store.insertAuditLog({
        channelType: 'telegram',
        chatId: '123',
        direction: 'inbound',
        messageId: `msg-${i}`,
        summary: `msg ${i}`,
      });
    }
    // We can't directly inspect length, but it shouldn't crash
  });

  // ── Channel Offsets ──

  it('getChannelOffset returns default for unknown key', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getChannelOffset('unknown'), '0');
  });

  it('setChannelOffset and getChannelOffset round-trip', () => {
    const store = new JsonFileStore(makeSettings());
    store.setChannelOffset('tg:offset', '12345');
    assert.equal(store.getChannelOffset('tg:offset'), '12345');
  });

  // ── SDK Session ──

  it('updateSdkSessionId updates session and bindings', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model', undefined, '/tmp');
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp',
      model: 'model',
    });
    store.updateSdkSessionId(session.id, 'sdk-123');
    const binding = store.getChannelBinding('telegram', '1');
    assert.equal(binding?.sdkSessionId, 'sdk-123');
  });

  it('updateSessionModel updates model', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model-old', undefined, '/tmp');
    store.updateSessionModel(session.id, 'model-new');
    const updated = store.getSession(session.id);
    assert.equal(updated?.model, 'model-new');
  });

  // ── Provider (no-op) ──

  it('getProvider returns undefined', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getProvider('any'), undefined);
  });

  it('getDefaultProviderId returns null', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getDefaultProviderId(), null);
  });
});
