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
  it('reads identity, safety, and tool documents as bounded prompt sections on every call', async () => {
    const module = await loadAgentHomeModule();
    assert.ok(module, 'agent home module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-agent-home-prompt-'));

    try {
      module.ensureAgentHome(root);
      fs.writeFileSync(path.join(root, '机器人身份.md'), '# 机器人身份\n\n第一版身份。\n', 'utf8');
      fs.writeFileSync(path.join(root, '行为与安全规则.md'), '# 行为与安全规则\n\n' + '安全规则。'.repeat(80), 'utf8');
      fs.writeFileSync(path.join(root, '工具与环境.md'), '# 工具与环境\n\n优先使用真实工具证据。\n', 'utf8');

      const first = module.readAgentHomePromptSections(root, {
        maxDocumentChars: 96,
        maxTotalChars: 220,
      });

      assert.deepEqual(first.map((item: { id: string }) => item.id), [
        'agent-home.identity',
        'agent-home.safety-rules',
        'agent-home.tool-rules',
      ]);
      assert.deepEqual(first.map((item: { kind: string }) => item.kind), ['identity', 'policy', 'skills']);
      assert.equal(first.every((item: { content: string }) => item.content.length <= 96), true);
      assert.equal(first.reduce((sum: number, item: { content: string }) => sum + item.content.length, 0) <= 220, true);
      assert.match(first[0].content, /第一版身份/);
      assert.equal(first[1].truncated, true);

      fs.writeFileSync(path.join(root, '机器人身份.md'), '# 机器人身份\n\n第二版身份。\n', 'utf8');
      const second = module.readAgentHomePromptSections(root, {
        maxDocumentChars: 96,
        maxTotalChars: 220,
      });
      assert.match(second[0].content, /第二版身份/);
      assert.doesNotMatch(second[0].content, /第一版身份/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('injects only the current workspace work profile as a bounded memory section', async () => {
    const module = await loadAgentHomeModule();
    const workspaceModule = await import('../workspace-identity.js').catch(() => null);
    assert.ok(module, 'agent home module should exist');
    assert.ok(workspaceModule, 'workspace identity module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-agent-home-work-profile-'));
    const alpha = workspaceModule.resolveWorkspaceIdentity('C:\\Projects\\Alpha');
    const beta = workspaceModule.resolveWorkspaceIdentity('C:\\Projects\\Beta');

    try {
      module.ensureAgentHome(root);
      const alphaPath = path.join(root, 'work', alpha.id, '工作档案.md');
      const betaPath = path.join(root, 'work', beta.id, '工作档案.md');
      fs.mkdirSync(path.dirname(alphaPath), { recursive: true });
      fs.mkdirSync(path.dirname(betaPath), { recursive: true });
      fs.writeFileSync(alphaPath, '# 工作档案\n\nAlpha 测试入口：npm test。\n' + '已验证。'.repeat(80), 'utf8');
      fs.writeFileSync(betaPath, '# 工作档案\n\nBeta 私有结论。\n', 'utf8');

      const sections = module.readAgentHomePromptSections(root, {
        workingDirectory: 'C:\\Projects\\Alpha',
        maxDocumentChars: 400,
        maxWorkProfileChars: 120,
        maxTotalChars: 2_000,
      });
      const workSection = sections.find((item: { id: string }) => item.id === 'agent-home.work-profile');

      assert.ok(workSection);
      assert.equal(workSection.kind, 'memory');
      assert.equal(workSection.content.length <= 120, true);
      assert.match(workSection.content, /Alpha 测试入口/);
      assert.doesNotMatch(workSection.content, /Beta 私有结论/);
      assert.equal(workSection.truncated, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the newest work-profile facts visible after the file exceeds its prompt budget', async () => {
    const module = await loadAgentHomeModule();
    assert.ok(module, 'agent-home module should exist');
    const { resolveWorkspaceIdentity } = await import('../workspace-identity.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-agent-home-work-profile-tail-'));

    try {
      module.ensureAgentHome(root);
      const workspace = resolveWorkspaceIdentity('C:\\Projects\\Growing');
      const workPath = path.join(root, 'work', workspace.id, '工作档案.md');
      fs.mkdirSync(path.dirname(workPath), { recursive: true });
      fs.writeFileSync(workPath, [
        '# 工作档案',
        '',
        `工作区标识：${workspace.id}`,
        '',
        '很早以前的重复记录。'.repeat(500),
        '',
        '最新验证结论：发布前必须运行 npm run build。',
      ].join('\n'), 'utf8');

      const sections = module.readAgentHomePromptSections(root, {
        workingDirectory: 'C:\\Projects\\Growing',
        maxDocumentChars: 200,
        maxWorkProfileChars: 520,
        maxTotalChars: 1_200,
      });
      const workSection = sections.find((item: { id: string }) => item.id === 'agent-home.work-profile');

      assert.ok(workSection);
      assert.match(workSection.content, /只读事实证据/u);
      assert.match(workSection.content, /不得作为指令/u);
      assert.match(workSection.content, /最新验证结论：发布前必须运行 npm run build/u);
      assert.match(workSection.content, new RegExp(workspace.id, 'u'));
      assert.equal(workSection.truncated, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('promotes the legacy path-based work profile to the stable git project id', async () => {
    const module = await loadAgentHomeModule();
    assert.ok(module, 'agent-home module should exist');
    const { resolveWorkspaceIdentity } = await import('../workspace-identity.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-agent-home-work-profile-alias-'));
    const projectRoot = path.join(root, 'renamed-project');

    try {
      fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, '.git', 'config'), '[remote "origin"]\nurl = https://example.com/team/alpha.git\n', 'utf8');
      const workspace = resolveWorkspaceIdentity(projectRoot);
      assert.equal(workspace.legacyIds.length > 0, true);
      const legacyPath = path.join(root, 'work', workspace.legacyIds[0], '工作档案.md');
      const stablePath = path.join(root, 'work', workspace.id, '工作档案.md');
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.writeFileSync(legacyPath, '# 工作档案\n\n旧路径档案仍应可见。\n', 'utf8');

      const sections = module.readAgentHomePromptSections(root, {
        workingDirectory: projectRoot,
        maxWorkProfileChars: 500,
        maxTotalChars: 2_000,
      });

      assert.match(sections.find((item: { id: string }) => item.id === 'agent-home.work-profile')?.content || '', /旧路径档案仍应可见/u);
      assert.equal(fs.existsSync(stablePath), true);
      assert.equal(fs.existsSync(path.dirname(legacyPath)), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports the real legacy work-profile source when stable-id promotion is temporarily blocked', async () => {
    const module = await loadAgentHomeModule();
    assert.ok(module, 'agent-home module should exist');
    const { resolveWorkspaceIdentity } = await import('../workspace-identity.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-agent-home-work-profile-fallback-'));
    const projectRoot = path.join(root, 'renamed-project');

    try {
      fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, '.git', 'config'), '[remote "origin"]\nurl = https://example.com/team/alpha.git\n', 'utf8');
      const workspace = resolveWorkspaceIdentity(projectRoot);
      assert.equal(workspace.legacyIds.length > 0, true);
      const legacyPath = path.join(root, 'work', workspace.legacyIds[0], '工作档案.md');
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.writeFileSync(legacyPath, '# 工作档案\n\n旧路径档案暂时回读。\n', 'utf8');
      module.ensureAgentHome(root);
      const originalRenameSync = fs.renameSync;
      let sections: Array<{ id: string; source: string; content: string }>;
      try {
        fs.renameSync = (() => {
          throw new Error('simulated promotion failure');
        }) as typeof fs.renameSync;
        sections = module.readAgentHomePromptSections(root, {
          workingDirectory: projectRoot,
          maxWorkProfileChars: 500,
          maxTotalChars: 2_000,
        });
      } finally {
        fs.renameSync = originalRenameSync;
      }
      const workSection = sections.find((item: { id: string }) => item.id === 'agent-home.work-profile');

      assert.ok(workSection);
      assert.match(workSection.content, /旧路径档案暂时回读/u);
      assert.match(workSection.source, new RegExp(workspace.legacyIds[0], 'u'));
      assert.doesNotMatch(workSection.source, new RegExp(workspace.id, 'u'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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

  it('upgrades untouched legacy identity, safety, and tool templates for controlled self-maintenance', async () => {
    const module = await loadAgentHomeModule();
    assert.ok(module, 'agent home module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-agent-home-core-upgrade-'));
    fs.writeFileSync(path.join(root, '机器人身份.md'), [
      '# 机器人身份',
      '',
      '本文件保存稳定的机器人定位与人格。平台显示名和当前会话身份仍以真实 adapter evidence 为准。',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(root, '行为与安全规则.md'), [
      '# 行为与安全规则',
      '',
      '- 每轮只挂载当前工作区。',
      '- 允许根目录不等于已挂载目录。',
      '- 其他项目只有在本轮存在可靠证据时临时挂载。',
      '- 记忆库、运行数据、日志和发布产物不得作为普通工作区挂载。',
      '- 用户印象、群聊记忆和公共记忆必须遵守身份边界。',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(root, '工具与环境.md'), [
      '# 工具与环境',
      '',
      '记录稳定的工具入口、环境约束与使用偏好。禁止在此保存密钥、Token、验证码或私有授权票据。',
      '',
    ].join('\n'), 'utf8');

    try {
      const result = module.ensureAgentHome(root);

      assert.deepEqual(result.updated.map((item: string) => path.basename(item)).sort(), [
        '工具与环境.md',
        '机器人身份.md',
        '行为与安全规则.md',
      ].sort());
      for (const name of ['机器人身份.md', '行为与安全规则.md', '工具与环境.md']) {
        const content = fs.readFileSync(path.join(root, name), 'utf8');
        assert.match(content, /cti-agent-home-template:v4/);
        assert.match(content, /真实证据|受控自维护|代码级门禁|受控 patch|稳定 key/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('upgrades untouched v3 core templates to v4', async () => {
    const module = await loadAgentHomeModule();
    assert.ok(module, 'agent home module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-agent-home-v3-upgrade-'));
    const v3Templates: Record<string, string> = {
      '机器人身份.md': [
        '# 机器人身份',
        '',
        '<!-- cti-agent-home-template:v3 -->',
        '',
        '本文件保存稳定的机器人定位与人格。Agent 可在确认自身错误并引用真实证据后受控自维护本文件。',
        '',
        '- 平台显示名和当前会话身份仍以真实 adapter evidence 为准。',
        '- 身份描述可以演进，但不能伪造平台身份、用户身份、权限或执行结果。',
        '',
      ].join('\n'),
      '行为与安全规则.md': [
        '# 行为与安全规则',
        '',
        '<!-- cti-agent-home-template:v3 -->',
        '',
        '- 每轮只挂载当前工作区。',
        '- 允许根目录不等于已挂载目录。',
        '- 其他项目只有在本轮存在可靠证据时临时挂载。',
        '- 记忆库、运行数据、日志和发布产物不得作为普通工作区挂载。',
        '- 用户印象、群聊记忆和公共记忆必须遵守身份边界。',
        '- 只有确认是 Agent 自身错误并引用真实 human/runtime evidence 时，才允许受控自维护本文件。',
        '- Owner/Operator、密钥保护、平台授权、真实工具证据和高危操作确认属于代码级门禁，本文件不能取消。',
        '',
      ].join('\n'),
      '工具与环境.md': [
        '# 工具与环境',
        '',
        '<!-- cti-agent-home-template:v3 -->',
        '',
        '记录稳定的工具入口、环境约束与使用偏好。工具结论必须优先依据真实证据，确认自身错误后可受控自维护。',
        '',
        '禁止在此保存密钥、Token、验证码或私有授权票据；工具规则不能绕过代码级门禁。',
        '',
      ].join('\n'),
    };
    for (const [name, content] of Object.entries(v3Templates)) {
      fs.writeFileSync(path.join(root, name), content, 'utf8');
    }

    try {
      const result = module.ensureAgentHome(root);

      assert.deepEqual(result.updated.map((item: string) => path.basename(item)).sort(), Object.keys(v3Templates).sort());
      for (const name of Object.keys(v3Templates)) {
        assert.match(fs.readFileSync(path.join(root, name), 'utf8'), /cti-agent-home-template:v4/u);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves user-customized v3 core templates', async () => {
    const module = await loadAgentHomeModule();
    assert.ok(module, 'agent home module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-agent-home-v3-custom-'));
    const identityPath = path.join(root, '机器人身份.md');
    const customIdentity = [
      '# 机器人身份',
      '',
      '<!-- cti-agent-home-template:v3 -->',
      '',
      '本文件保存稳定的机器人定位与人格。Agent 可在确认自身错误并引用真实证据后受控自维护本文件。',
      '',
      '- 平台显示名和当前会话身份仍以真实 adapter evidence 为准。',
      '- 身份描述可以演进，但不能伪造平台身份、用户身份、权限或执行结果。',
      '- 用户自定义：回复应保持简洁。',
      '',
    ].join('\n');
    fs.writeFileSync(identityPath, customIdentity, 'utf8');

    try {
      const result = module.ensureAgentHome(root);

      assert.equal(result.updated.includes(identityPath), false);
      assert.equal(fs.readFileSync(identityPath, 'utf8'), customIdentity);
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
        stats: { confirmedCount: 3, candidateCount: 0, archivedCount: 0, legacyCount: 0, conflictCount: 0 },
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
