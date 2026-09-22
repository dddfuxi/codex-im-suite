import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

async function loadMemoryDocumentsModule() {
  try {
    return await import('../memory-documents.js');
  } catch {
    return null;
  }
}

describe('visible memory documents', () => {
  it('merges confirmed user facts into one readable 用户印象.md', async () => {
    const module = await loadMemoryDocumentsModule();
    assert.ok(module, 'memory documents module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-user-impression-'));

    try {
      const first = module.upsertConfirmedMemoryDocument({
        memoryRoot: root,
        scope: 'user',
        channelType: 'feishu',
        userId: 'ou_user_a',
        displayName: '刘丹',
        pairs: [{ key: '回复语言', value: '中文' }],
        evidenceText: '以后请用中文回复',
        createdAt: '2026-07-17T10:00:00.000Z',
      });
      const second = module.upsertConfirmedMemoryDocument({
        memoryRoot: root,
        scope: 'user',
        channelType: 'feishu',
        userId: 'ou_user_a',
        displayName: '刘丹',
        pairs: [{ key: '默认项目', value: 'ST4' }],
        evidenceText: '默认项目是 ST4',
        createdAt: '2026-07-17T11:00:00.000Z',
      });

      assert.equal(first.filePath, second.filePath);
      assert.equal(path.basename(first.filePath), '用户印象.md');
      const text = fs.readFileSync(first.filePath, 'utf-8');
      assert.match(text, /schema: codex-im-suite\/memory\/v3/);
      assert.match(text, /# 用户印象：刘丹/);
      assert.match(text, /## 已确认事实/);
      assert.match(text, /\| 回复语言 \| 中文 \|/);
      assert.match(text, /\| 默认项目 \| ST4 \|/);
      assert.match(text, /## 候选记忆（不参与索引）/);
      assert.match(text, /## 证据与更新时间/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps different users in different identity partitions', async () => {
    const module = await loadMemoryDocumentsModule();
    assert.ok(module, 'memory documents module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-user-isolation-'));

    try {
      const first = module.upsertConfirmedMemoryDocument({
        memoryRoot: root,
        scope: 'user',
        channelType: 'feishu',
        userId: 'ou_user_a',
        pairs: [{ key: '偏好', value: '简短回复' }],
        evidenceText: '简短回复',
      });
      const second = module.upsertConfirmedMemoryDocument({
        memoryRoot: root,
        scope: 'user',
        channelType: 'feishu',
        userId: 'ou_user_b',
        pairs: [{ key: '偏好', value: '详细回复' }],
        evidenceText: '详细回复',
      });

      assert.notEqual(first.filePath, second.filePath);
      assert.equal(fs.readFileSync(first.filePath, 'utf-8').includes('详细回复'), false);
      assert.equal(fs.readFileSync(second.filePath, 'utf-8').includes('简短回复'), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses one canonical document for group and public long-term memory', async () => {
    const module = await loadMemoryDocumentsModule();
    assert.ok(module, 'memory documents module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-scope-documents-'));

    try {
      const group = module.upsertConfirmedMemoryDocument({
        memoryRoot: root,
        scope: 'group',
        channelType: 'feishu',
        chatId: 'oc_group',
        displayName: '美术协作群',
        pairs: [{ key: '交付格式', value: '先图后说明' }],
        evidenceText: '群里统一先图后说明',
      });
      const longTerm = module.upsertConfirmedMemoryDocument({
        memoryRoot: root,
        scope: 'long_term',
        channelType: 'feishu',
        chatId: 'oc_source_chat',
        userId: 'ou_source_user',
        displayName: '来源用户',
        pairs: [{ key: '通用规则', value: '记忆库不作为工作区挂载' }],
        evidenceText: '通用规则',
      });

      assert.equal(path.basename(group.filePath), '群聊记忆.md');
      assert.equal(path.basename(longTerm.filePath), '公共长期记忆.md');
      const longTermText = fs.readFileSync(longTerm.filePath, 'utf8');
      assert.doesNotMatch(longTermText, /oc_source_chat|ou_source_user|来源用户/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes only repeated non-sensitive observations as candidate memories', async () => {
    const module = await loadMemoryDocumentsModule();
    assert.ok(module, 'memory documents module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-derived-impression-'));

    try {
      const result = module.materializeDerivedUserImpression({
        memoryRoot: root,
        channelType: 'feishu',
        userId: 'ou_user_a',
        displayName: '刘丹',
        observations: [
          { text: '偏好直接给出可执行结果', count: 3 },
          { text: '偶尔讨论 Unity', count: 2 },
          { text: 'API Token 是 secret-123', count: 5 },
        ],
        updatedAt: '2026-07-17T12:00:00.000Z',
      });

      assert.equal(result.updated, true);
      const text = fs.readFileSync(result.filePath, 'utf-8');
      assert.match(text, /偏好直接给出可执行结果/);
      assert.doesNotMatch(text, /偶尔讨论 Unity/);
      assert.doesNotMatch(text, /secret-123/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
