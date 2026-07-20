import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonFileStore } from '../store.js';
import { CTI_HOME } from '../config.js';
import { writeKnowledgeIndex, type KnowledgeIndex } from '../knowledge-indexer.js';

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

  it('records per-user and per-chat temporary profiles for bounded retrieval', () => {
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

  it('never promotes ordinary conversation into a global memory profile', () => {
    const store = new JsonFileStore(makeSettings());
    store.recordMemoryEvent({
      sessionId: 'sess-no-global',
      channelType: 'feishu',
      chatId: 'oc_chat',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      role: 'user',
      text: '这是普通群聊内容，不是跨会话公共事实。',
    });

    const profiles = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'memory-profiles.json'), 'utf-8')) as Record<string, { scope: string }>;
    assert.equal(Object.values(profiles).some((profile) => profile.scope === 'global'), false);
  });

  it('drops legacy global memory profiles when persisting bounded profiles', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'memory-profiles.json'), JSON.stringify({
      'global:all:all': {
        scope: 'global',
        key: 'global:all:all',
        facts: ['旧全局画像不应继续保留'],
        topics: [],
        pending: [],
        messageCount: 1,
        updatedAt: '2026-07-01T00:00:00.000Z',
        lastEventAt: '2026-07-01T00:00:00.000Z',
      },
    }), 'utf-8');

    const store = new JsonFileStore(makeSettings());
    store.recordMemoryEvent({
      sessionId: 'sess-profile-cleanup',
      channelType: 'feishu',
      chatId: 'oc_chat',
      userId: 'ou_user_1',
      role: 'user',
      text: '这是一次新的有界群聊上下文。',
    });

    const profiles = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'memory-profiles.json'), 'utf-8')) as Record<string, { scope: string; facts?: string[] }>;
    assert.equal(Object.values(profiles).some((profile) => profile.scope === 'global'), false);
    assert.equal(JSON.stringify(profiles).includes('旧全局画像'), false);
  });

  it('keeps conversation events out of durable memory until an intent decision promotes them', () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-unclassified-memory-'));
    const store = new JsonFileStore(makeSettings([
      ['bridge_memory_repo_dir', memoryRoot],
    ]));

    store.recordMemoryEvent({
      sessionId: 'sess-unclassified',
      channelType: 'feishu',
      chatId: 'oc_chat',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      role: 'user',
      text: '请你记住，项目代号是夜航',
    });

    assert.equal(
      fs.existsSync(path.join(memoryRoot, 'data', 'explicit-memories')),
      false,
      'ordinary conversation capture must not become durable memory without a classified promotion',
    );
  });

  it('persists explicit memory writes into the visible knowledge repository', () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-visible-memory-'));
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
      createdAt: '2026-05-11T09:26:16.228Z',
      text: [
        '记一下，这些常用场景名称是STH项目的，也叫ST2H，H项目',
        '',
        'HSScene == 医院内部场景',
        'city3d_citystage_ST2H_Scene == 外城场景',
        'pve_gunship == pve场景',
        'Timeline_ST2H_Scene_01 == timeline场景',
      ].join('\n'),
      candidates: [
        { key: 'HSScene', value: '医院内部场景', text: 'HSScene = 医院内部场景', confidence: 0.95, source: 'model' },
        { key: 'city3d_citystage_ST2H_Scene', value: '外城场景', text: 'city3d_citystage_ST2H_Scene = 外城场景', confidence: 0.95, source: 'model' },
        { key: 'pve_gunship', value: 'pve场景', text: 'pve_gunship = pve场景', confidence: 0.95, source: 'model' },
        { key: 'Timeline_ST2H_Scene_01', value: 'timeline场景', text: 'Timeline_ST2H_Scene_01 = timeline场景', confidence: 0.95, source: 'model' },
      ],
      classification: { scope: 'user', actorKind: 'human', confidence: 0.95 },
    });

    assert.equal(result.ok, true);
    assert.match(result.filePath || '', /memory[\\/]users[\\/]feishu[\\/]ou_user_1[\\/]用户印象\.md$/u);
    assert.match(fs.readFileSync(result.filePath || '', 'utf-8'), /schema: codex-im-suite\/memory\/v3/);
    const indexPath = path.join(memoryRoot, '.cti-index', 'knowledge.json');
    assert.equal(fs.existsSync(indexPath), true);
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
      items: Array<{ kind: string; key?: string; value?: string; text: string; classificationSource?: string }>;
    };
    assert.ok(index.items.some((item) => item.key === 'HSScene' && item.value === '医院内部场景'));
    assert.ok(index.items.some((item) => item.kind === 'fact'));
    assert.equal(index.items.some((item) => item.key === 'HSScene' && item.kind === 'resource'), false);
    assert.ok(index.items.some((item) => item.classificationSource === 'managed_state'));
  });

  it('writes repeated confirmed user memories into one v3 用户印象.md', () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-v3-user-memory-'));
    const store = new JsonFileStore(makeSettings([
      ['bridge_memory_repo_dir', memoryRoot],
    ]));
    const classification = { scope: 'user' as const, actorKind: 'human' as const, confidence: 0.95 };

    const first = store.persistMemoryWrite({
      sessionId: 'sess-v3-user', channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user_1', userDisplayName: '刘丹',
      text: '以后请用中文回复',
      candidates: [{ key: '回复语言', value: '中文', text: '回复语言是中文', confidence: 0.95, source: 'model' }],
      classification,
    });
    const second = store.persistMemoryWrite({
      sessionId: 'sess-v3-user', channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user_1', userDisplayName: '刘丹',
      text: '默认项目是 ST4',
      candidates: [{ key: '默认项目', value: 'ST4', text: '默认项目是 ST4', confidence: 0.95, source: 'model' }],
      classification,
    });

    assert.equal(first.ok, true);
    assert.equal(first.filePath, second.filePath);
    assert.match(first.filePath || '', /memory[\\/]users[\\/]feishu[\\/]ou_user_1[\\/]用户印象\.md$/u);
    const text = fs.readFileSync(first.filePath || '', 'utf8');
    assert.match(text, /schema: codex-im-suite\/memory\/v3/);
    assert.match(text, /\| 回复语言 \| 中文 \|/);
    assert.match(text, /\| 默认项目 \| ST4 \|/);
  });

  it('keeps repeated stable observations in bounded profiles until a classifier authorizes persistence', () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-derived-user-memory-'));
    const store = new JsonFileStore(makeSettings([
      ['bridge_memory_repo_dir', memoryRoot],
    ]));
    const event = {
      sessionId: 'sess-profile',
      channelType: 'feishu',
      chatId: 'oc_group',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      role: 'user' as const,
      text: '我偏好直接给出可执行结果，不要只给教程',
    };

    store.recordMemoryEvent(event);
    store.recordMemoryEvent(event);
    assert.equal(fs.existsSync(path.join(memoryRoot, 'memory', 'users', 'feishu', 'ou_user_1', '用户印象.md')), false);
    store.recordMemoryEvent(event);

    const impressionPath = path.join(memoryRoot, 'memory', 'users', 'feishu', 'ou_user_1', '用户印象.md');
    assert.equal(fs.existsSync(impressionPath), false);
    const profiles = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'memory-profiles.json'), 'utf8')) as Record<string, {
      sessionId?: string;
      userId?: string;
      facts?: string[];
      observationCounts?: Record<string, number>;
    }>;
    const userProfile = Object.values(profiles).find((profile) =>
      profile.sessionId === 'sess-profile' && profile.userId === 'ou_user_1');
    assert.ok(userProfile);
    assert.match(JSON.stringify(userProfile.facts), /我偏好直接给出可执行结果/u);
    assert.equal(Object.values(userProfile.observationCounts || {})[0], 1, 'same session replay counts once');
  });

  it('never materializes repeated commands questions links or mentions into memory v3', () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-rejected-derived-memory-'));
    const store = new JsonFileStore(makeSettings([
      ['bridge_memory_repo_dir', memoryRoot],
    ]));
    const texts = [
      'Unity MCP 截一张 game 图',
      'pve 关卡场景叫啥',
      'https://example.com 看一下并总结',
      '@_user_1 按这个格式回复',
      'powershell -File doctor.ps1 检查工具',
    ];

    for (let round = 0; round < 4; round += 1) {
      for (const text of texts) {
        store.recordMemoryEvent({
          sessionId: `session-${round}`,
          channelType: 'feishu',
          chatId: 'oc_group',
          userId: 'ou_user_1',
          role: 'user',
          text,
        });
      }
    }

    assert.equal(fs.existsSync(path.join(memoryRoot, 'memory')), false);
    const profiles = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'memory-profiles.json'), 'utf8')) as Record<string, { userId?: string; facts?: string[] }>;
    const userProfiles = Object.values(profiles).filter((profile) => profile.userId === 'ou_user_1');
    assert.equal(userProfiles.every((profile) => (profile.facts || []).length === 0), true);
  });

  it('does not retrieve a bounded conversation profile from another session', () => {
    const store = new JsonFileStore(makeSettings());
    store.recordMemoryEvent({
      sessionId: 'session-a',
      channelType: 'feishu',
      chatId: 'oc_group',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      role: 'user',
      text: '我更喜欢先给结论，再列验证证据。',
    });

    const memory = store.retrieveRelevantMemory({
      sessionId: 'session-b',
      channelType: 'feishu',
      chatId: 'oc_group',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      query: '我之前偏好什么回复方式',
      recentHistoryLimit: 0,
    });

    assert.doesNotMatch(memory?.summary || '', /先给结论/u);
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
      classification: { scope: 'user', actorKind: 'human', confidence: 0.92 },
    });

    assert.equal(result.ok, true);
    assert.match(result.filePath || '', /memory[\\/]users[\\/]feishu[\\/]ou_user_1[\\/]用户印象\.md$/u);
    const indexPath = path.join(memoryRoot, '.cti-index', 'knowledge.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
      items: Array<{ key?: string; value?: string; text: string }>;
    };
    assert.ok(index.items.some((item) => item.key === 'STH的git分支名' && item.value === 'st2h_master'));
    assert.equal(index.items.some((item) => item.value?.includes('重新记一下')), false);
  });

  it('writes a classified human memory into that user partition only', () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-user-memory-partition-'));
    const store = new JsonFileStore(makeSettings([
      ['bridge_memory_repo_dir', memoryRoot],
    ]));

    const result = store.persistMemoryWrite({
      sessionId: 'sess-memory',
      channelType: 'feishu',
      chatId: 'oc_group',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      text: '请你记住，项目代号是夜航',
      candidates: [{
        key: '项目代号',
        value: '夜航',
        text: '项目代号是夜航',
        confidence: 0.95,
        source: 'model',
      }],
      classification: {
        scope: 'user',
        actorKind: 'human',
        confidence: 0.95,
      },
    } as any);

    assert.equal(result.ok, true);
    assert.match(result.filePath || '', /memory[\\/]users[\\/]feishu[\\/]ou_user_1[\\/]用户印象\.md$/u);
    assert.equal(fs.existsSync(path.join(memoryRoot, 'data', 'explicit-memories')), false);
  });

  it('writes classified group memory into only that group partition', () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-group-memory-partition-'));
    const store = new JsonFileStore(makeSettings([
      ['bridge_memory_repo_dir', memoryRoot],
    ]));

    const result = store.persistMemoryWrite({
      sessionId: 'sess-group-memory',
      channelType: 'feishu',
      chatId: 'oc_group_1',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      text: '保存本群约定：发布前必须跑完整测试',
      candidates: [{ key: '发布前检查', value: '运行完整测试', text: '发布前检查是运行完整测试', confidence: 0.95, source: 'model' }],
      classification: { scope: 'group', actorKind: 'human', confidence: 0.95 },
    });

    assert.equal(result.ok, true);
    assert.match(result.filePath || '', /memory[\\/]groups[\\/]feishu[\\/]oc_group_1[\\/]群聊记忆\.md$/u);

    const otherGroupMemory = store.retrieveRelevantMemory({
      sessionId: 'sess-group-memory', channelType: 'feishu', chatId: 'oc_group_2', userId: 'ou_user_1',
      query: '发布前检查', recentHistoryLimit: 0,
    });
    assert.ok(!otherGroupMemory?.summary.includes('运行完整测试'));
  });

  it('retrieves a user partition without exposing another user\'s memory', () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-user-memory-isolation-'));
    const store = new JsonFileStore(makeSettings([
      ['bridge_memory_repo_dir', memoryRoot],
    ]));
    const classification = { scope: 'user' as const, actorKind: 'human' as const, confidence: 0.95 };

    store.persistMemoryWrite({
      sessionId: 'sess-user-1', channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user_1',
      text: '请你记住我的部署偏好',
      candidates: [{ key: '部署偏好', value: '先运行测试', text: '部署偏好是先运行测试', confidence: 0.95, source: 'model' }],
      classification,
    });
    store.persistMemoryWrite({
      sessionId: 'sess-user-2', channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user_2',
      text: '请你记住我的部署偏好',
      candidates: [{ key: '部署偏好', value: '直接发布', text: '部署偏好是直接发布', confidence: 0.95, source: 'model' }],
      classification,
    });

    const memory = store.retrieveRelevantMemory({
      sessionId: 'sess-user-1', channelType: 'feishu', chatId: 'oc_group', userId: 'ou_user_1',
      query: '部署偏好', recentHistoryLimit: 0,
    });

    assert.ok(memory);
    assert.match(memory.summary, /先运行测试/);
    assert.doesNotMatch(memory.summary, /直接发布/);
  });

  it('ignores stale non-v2 knowledge index entries even when the old path matches the user', () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-ignore-stale-memory-'));
    const store = new JsonFileStore(makeSettings([
      ['bridge_memory_repo_dir', memoryRoot],
    ]));
    const oldPath = path.join(memoryRoot, 'data', 'memory', 'users', 'feishu', 'ou_user_1', 'deploy.md');
    const newPath = path.join(memoryRoot, 'data', 'memory', 'v2', 'users', 'feishu', 'ou_user_1', 'deploy.md');
    const index: KnowledgeIndex = {
      schema: 'codex-im-suite/knowledge-index/v1',
      memoryRoot,
      generatedAt: '2026-07-13T00:00:00.000Z',
      itemCount: 2,
      conflictCount: 0,
      stats: { confirmedCount: 0, candidateCount: 0, archivedCount: 0, legacyCount: 2, conflictCount: 0 },
      items: [
        {
          id: 'old-memory',
          kind: 'fact',
          key: '部署偏好',
          value: '直接发布',
          text: '部署偏好: 直接发布',
          confidence: 0.95,
          conflict: false,
          source: {
            path: oldPath,
            snippet: '部署偏好: 直接发布',
            metadata: {
              schema: 'codex-im-suite/partitioned-memory/v1',
              memoryScope: 'user',
              channelType: 'feishu',
              userId: 'ou_user_1',
            },
          },
        },
        {
          id: 'new-memory',
          kind: 'fact',
          key: '部署偏好',
          value: '先运行测试',
          text: '部署偏好: 先运行测试',
          confidence: 0.95,
          conflict: false,
          source: {
            path: newPath,
            snippet: '部署偏好: 先运行测试',
            metadata: {
              schema: 'codex-im-suite/memory/v2',
              memoryScope: 'user',
              channelType: 'feishu',
              userId: 'ou_user_1',
            },
          },
        },
      ],
    };
    writeKnowledgeIndex(memoryRoot, index);

    const memory = store.retrieveRelevantMemory({
      sessionId: 'sess-user-1',
      channelType: 'feishu',
      chatId: 'oc_group',
      userId: 'ou_user_1',
      query: '部署偏好',
      recentHistoryLimit: 0,
    });

    assert.ok(memory);
    assert.match(memory.summary, /先运行测试/);
    assert.doesNotMatch(memory.summary, /直接发布/);
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

  it('decides high-confidence memory evidence for non-scene structured recall keys', () => {
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

    assert.equal(decision.type, 'high_confidence_evidence');
    assert.match(decision.type === 'high_confidence_evidence' ? decision.text : '', /部署命令/);
    assert.match(decision.type === 'high_confidence_evidence' ? decision.text : '', /npm run build/);
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

    assert.equal(decision.type, 'high_confidence_evidence');
    assert.match(decision.type === 'high_confidence_evidence' ? decision.text : '', /第十三条龙/);
    assert.match(decision.type === 'high_confidence_evidence' ? decision.text : '', /雷霆龙/);
    assert.doesNotMatch(decision.type === 'high_confidence_evidence' ? decision.text : '', /HSScene/);
  });

  it('retrieves reverse memory graph context for related knowledge', () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-graph-memory-'));
    const store = new JsonFileStore(makeSettings([
      ['bridge_memory_repo_dir', memoryRoot],
    ]));

    const result = store.persistMemoryWrite({
      sessionId: 'sess-graph',
      channelType: 'feishu',
      chatId: 'oc_group',
      userId: 'ou_user_1',
      userDisplayName: '刘丹',
      workingDirectory: '/tmp/test-cwd',
      text: [
        '请你记一下，ST横板第十三条龙相关信息',
        '第十三条龙 == 雷霆龙',
        '雷霆龙商城展示界面Unity预制体 == PreviewDragon_Thunde',
        'ST龙相关展示场景路径 == Assets/__ArtData/_Resources/Prefab/City3D/UIScene',
      ].join('\n'),
      candidates: [
        { key: '第十三条龙', value: '雷霆龙', text: '第十三条龙 = 雷霆龙', confidence: 0.95, source: 'model' },
        { key: '雷霆龙商城展示界面Unity预制体', value: 'PreviewDragon_Thunde', text: '雷霆龙商城展示界面Unity预制体 = PreviewDragon_Thunde', confidence: 0.95, source: 'model' },
        { key: 'ST龙相关展示场景路径', value: 'Assets/__ArtData/_Resources/Prefab/City3D/UIScene', text: 'ST龙相关展示场景路径 = Assets/__ArtData/_Resources/Prefab/City3D/UIScene', confidence: 0.95, source: 'model' },
      ],
      classification: { scope: 'user', actorKind: 'human', confidence: 0.95 },
    });

    assert.equal(result.ok, true);

    const graph = store.retrieveMemoryGraphContext({
      sessionId: 'sess-graph',
      channelType: 'feishu',
      chatId: 'oc_group',
      userId: 'ou_user_1',
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

  it('retrieves the adjacent assistant answer when a historical user request matches', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model-1', '', '/tmp/test-cwd');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'oc_chat',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'model-1',
    });

    const archiveDir = path.join(DATA_DIR, 'message-archives', session.id);
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, '1000.json'), JSON.stringify([
      {
        role: 'user',
        content: '给红圈的这几个区域取名 以A2_开头 格式参考： A3_Run A3_MRI A4_Warm 等',
      },
      {
        role: 'assistant',
        content: JSON.stringify([
          { type: 'text', text: '我先确认格式。' },
          {
            type: 'tool_result',
            content: `C:\\unity\\ST3\\Game\\Assets\\Noise_A2_Path.png\n${'无关工具输出 '.repeat(200)}`,
          },
          {
            type: 'text',
            text: [
              '```cti-final',
              JSON.stringify({
                kind: 'text',
                text: [
                  '可以，名字如下：',
                  '- 左上儿童休闲区：`A2_Play`',
                  '- 中下护士站：`A2_Nurse`',
                  '- 右中总控室：`A2_Control`',
                ].join('\n'),
                images: [],
                files: [],
                reply_mode: 'markdown',
              }),
              '```',
            ].join('\n'),
          },
        ]),
      },
    ]), 'utf8');

    const memory = store.retrieveRelevantMemory({
      sessionId: session.id,
      channelType: 'feishu',
      chatId: 'oc_chat',
      userId: 'ou_user_1',
      query: '红圈区域取名 A3_Run',
      recentHistoryLimit: 0,
      workingDirectory: '/tmp/test-cwd',
    });

    assert.ok(memory);
    assert.match(memory.summary, /相邻助手回复/);
    assert.match(memory.summary, /A2_Play/);
    assert.match(memory.summary, /A2_Nurse/);
    assert.doesNotMatch(memory.summary, /Noise_A2_Path/);
    assert.doesNotMatch(memory.summary, /无关工具输出/);
  });

  it('extracts raw cti-final text when adjacent historical assistant answer is not structured JSON', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model-1', '', '/tmp/test-cwd');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'oc_chat',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'model-1',
    });

    const archiveDir = path.join(DATA_DIR, 'message-archives', session.id);
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, '1001.json'), JSON.stringify([
      {
        role: 'user',
        content: '给红圈的这几个区域取名 以A2_开头 格式参考： A3_Run A3_MRI A4_Warm 等 并标记在下图上',
      },
      {
        role: 'assistant',
        content: [
          '```cti-final',
          JSON.stringify({
            kind: 'text',
            text: '我这边还没收到“下图”图片，暂时没法确认红圈区域并标注。',
            images: [],
            files: [],
            reply_mode: 'plain',
          }),
          '```',
        ].join('\n'),
      },
    ]), 'utf8');

    const memory = store.retrieveRelevantMemory({
      sessionId: session.id,
      channelType: 'feishu',
      chatId: 'oc_chat',
      userId: 'ou_user_1',
      query: '红圈区域 A3_Run 下图',
      recentHistoryLimit: 0,
      workingDirectory: '/tmp/test-cwd',
    });

    assert.ok(memory);
    assert.match(memory.summary, /没收到“下图”图片/);
    assert.doesNotMatch(memory.summary, /cti-final/);
    assert.doesNotMatch(memory.summary, /"kind"/);
  });

  it('keeps tool logs out of historical assistant memory summaries when no final block exists', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model-1', '', '/tmp/test-cwd');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'oc_chat',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'model-1',
    });

    const archiveDir = path.join(DATA_DIR, 'message-archives', session.id);
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, '1002.json'), JSON.stringify([
      {
        role: 'user',
        content: '给红圈区域取名并标记到下图上',
      },
      {
        role: 'assistant',
        content: JSON.stringify([
          { type: 'text', text: '我会直接按红圈位置做一版 A2_ 命名标注图。' },
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'Get-ChildItem C:\\unity\\ST3\\.codepilot-uploads -Recurse' },
          },
          {
            type: 'tool_result',
            content: `C:\\unity\\ST3\\.codepilot-uploads\\Noise_A2_Path.png\n${'无关工具输出 '.repeat(80)}`,
          },
        ]),
      },
    ]), 'utf8');

    const memory = store.retrieveRelevantMemory({
      sessionId: session.id,
      channelType: 'feishu',
      chatId: 'oc_chat',
      userId: 'ou_user_1',
      query: '红圈区域 下图',
      recentHistoryLimit: 0,
      workingDirectory: '/tmp/test-cwd',
    });

    assert.ok(memory);
    assert.match(memory.summary, /A2_ 命名标注图/);
    assert.doesNotMatch(memory.summary, /执行命令/);
    assert.doesNotMatch(memory.summary, /工具结果/);
    assert.doesNotMatch(memory.summary, /Noise_A2_Path/);
    assert.doesNotMatch(memory.summary, /无关工具输出/);
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
