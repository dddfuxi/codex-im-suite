import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

async function loadAgentHomeModule() {
  try {
    return await import('../agent-home.js');
  } catch {
    return null;
  }
}

describe('Agent Home', () => {
  it('creates the five visible Chinese entry documents without overwriting user edits', async () => {
    const module = await loadAgentHomeModule();
    assert.ok(module, 'agent home module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-agent-home-'));
    const identityPath = path.join(root, '机器人身份.md');
    fs.writeFileSync(identityPath, '# 自定义身份\n\n不要覆盖。\n', 'utf8');

    try {
      const result = module.ensureAgentHome(root);
      assert.deepEqual(result.files.map((item: string) => path.basename(item)).sort(), [
        '工具与环境.md',
        '机器人身份.md',
        '行为与安全规则.md',
        '记忆库说明.md',
        '记忆总索引.md',
      ].sort());
      assert.match(fs.readFileSync(identityPath, 'utf8'), /自定义身份/);
      assert.match(fs.readFileSync(path.join(root, '行为与安全规则.md'), 'utf8'), /允许根目录不等于已挂载目录/);
      const memoryGuide = fs.readFileSync(path.join(root, '记忆库说明.md'), 'utf8');
      assert.match(memoryGuide, /memory\/users/);
      assert.doesNotMatch(memoryGuide, /memory\/projects|memory\/topics/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('upgrades an untouched legacy memory guide while preserving custom Agent Home files', async () => {
    const module = await loadAgentHomeModule();
    assert.ok(module, 'agent home module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-agent-home-upgrade-'));
    const guidePath = path.join(root, '记忆库说明.md');
    fs.writeFileSync(guidePath, [
      '# 记忆库说明',
      '',
      '- `memory/users/<channel>/<userId>/用户印象.md`：当前用户的独立印象与已确认事实。',
      '- `memory/groups/<channel>/<chatId>/群聊记忆.md`：当前群的公共协作事实。',
      '- `memory/projects/<projectId>/项目记忆.md`：项目事实与约束。',
      '- `memory/topics/<topicId>/主题记忆.md`：跨项目主题知识。',
      '- `memory/long-term/公共长期记忆.md`：明确允许跨用户复用的非敏感事实。',
      '- `.cti-index`：机器生成索引，不是事实源。',
      '',
    ].join('\n'), 'utf8');

    try {
      const result = module.ensureAgentHome(root);
      const guide = fs.readFileSync(guidePath, 'utf8');

      assert.deepEqual(result.updated.map((item: string) => path.basename(item)), ['记忆库说明.md']);
      assert.doesNotMatch(guide, /memory\/projects|memory\/topics/);
      assert.match(guide, /cti-agent-home-template:v2/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a readable master index grouped by real source documents', async () => {
    const module = await loadAgentHomeModule();
    assert.ok(module, 'agent home module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-agent-home-index-'));
    const userPath = path.join(root, 'memory', 'users', 'feishu', 'ou_user_1', '用户印象.md');
    const groupPath = path.join(root, 'memory', 'groups', 'feishu', 'oc_group', '群聊记忆.md');
    const longTermPath = path.join(root, 'memory', 'long-term', '公共长期记忆.md');

    try {
      module.ensureAgentHome(root);
      const result = module.writeMemoryMasterIndex(root, {
        schema: 'codex-im-suite/knowledge-index/v1',
        memoryRoot: root,
        generatedAt: '2026-07-17T12:00:00.000Z',
        itemCount: 3,
        conflictCount: 0,
        items: [
          {
            id: 'user-1', kind: 'fact', key: '回复语言', value: '中文', text: '回复语言 = 中文', confidence: 0.95, conflict: false,
            source: { path: userPath, snippet: '回复语言 = 中文', metadata: { schema: 'codex-im-suite/memory/v3', memoryScope: 'user', channelType: 'feishu', userId: 'ou_user_1', displayName: '刘丹' } },
          },
          {
            id: 'group-1', kind: 'conclusion', key: '发布前检查', value: '完整测试', text: '发布前检查 = 完整测试', confidence: 0.95, conflict: false,
            source: { path: groupPath, snippet: '发布前检查 = 完整测试', metadata: { schema: 'codex-im-suite/memory/v3', memoryScope: 'group', channelType: 'feishu', chatId: 'oc_group', displayName: '美术协作群' } },
          },
          {
            id: 'long-1', kind: 'conclusion', key: '工作区规则', value: '记忆库不挂载', text: '工作区规则 = 记忆库不挂载', confidence: 0.95, conflict: false,
            source: { path: longTermPath, snippet: '工作区规则 = 记忆库不挂载', metadata: { schema: 'codex-im-suite/memory/v3', memoryScope: 'long_term' } },
          },
        ],
      });

      const text = fs.readFileSync(result.filePath, 'utf8');
      assert.match(text, /# 记忆总索引/);
      assert.match(text, /## 用户印象/);
      assert.match(text, /刘丹/);
      assert.match(text, /## 群聊记忆/);
      assert.match(text, /美术协作群/);
      assert.match(text, /## 公共长期记忆/);
      assert.doesNotMatch(text, /## 项目记忆|## 主题记忆/);
      assert.match(text, /memory\/users\/feishu\/ou_user_1\/用户印象\.md/);
      assert.doesNotMatch(text, /完整用户文件正文/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
