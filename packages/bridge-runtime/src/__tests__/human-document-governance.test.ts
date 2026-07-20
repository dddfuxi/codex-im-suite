import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

async function loadModule() {
  try {
    return await import('../human-document-governance.js');
  } catch {
    return null;
  }
}

describe('人类阅读文档治理', () => {
  it('区分固定入口、未归类说明和可恢复归档，不读取文档正文作为事实', async () => {
    const module = await loadModule();
    assert.ok(module, 'human document governance module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-human-doc-governance-'));

    try {
      for (const name of module.AGENT_HOME_DOCUMENT_NAMES) {
        fs.writeFileSync(path.join(root, name), `# ${name}\n`, 'utf8');
      }
      fs.writeFileSync(path.join(root, 'CodexNotes.md'), '# 不应复制的旧笔记\nSECRET_BODY\n', 'utf8');
      fs.mkdirSync(path.join(root, 'docs', 'nested'), { recursive: true });
      fs.writeFileSync(path.join(root, 'docs', 'AI_BRIDGE_CONTEXT.md'), '# 旧桥接说明\nSTALE_BODY\n', 'utf8');
      fs.writeFileSync(path.join(root, 'docs', 'nested', '操作手册.md'), '# 操作手册\nMANUAL_BODY\n', 'utf8');
      fs.mkdirSync(path.join(root, 'archive', 'human-documents', 'batch-1'), { recursive: true });
      fs.writeFileSync(path.join(root, 'archive', 'human-documents', 'batch-1', '旧说明.md'), '# 旧说明\nARCHIVE_BODY\n', 'utf8');

      const inventory = module.scanHumanReadableDocuments(root);

      assert.deepEqual(inventory.managed.map((item: { relativePath: string }) => item.relativePath), [
        '机器人身份.md',
        '行为与安全规则.md',
        '工具与环境.md',
        '记忆总索引.md',
        '记忆库说明.md',
      ]);
      assert.deepEqual(inventory.unclassified.map((item: { relativePath: string }) => item.relativePath), [
        'CodexNotes.md',
        'docs/AI_BRIDGE_CONTEXT.md',
        'docs/nested/操作手册.md',
      ]);
      assert.deepEqual(inventory.archived.map((item: { relativePath: string }) => item.relativePath), [
        'archive/human-documents/batch-1/旧说明.md',
      ]);
      const projection = module.buildHumanDocumentGovernanceBlock(inventory);
      assert.match(projection, /受控自更新/u);
      assert.match(projection, /docs\/AI_BRIDGE_CONTEXT\.md/u);
      assert.match(projection, /archive\/human-documents\/batch-1\/旧说明\.md/u);
      assert.doesNotMatch(projection, /SECRET_BODY|STALE_BODY|MANUAL_BODY|ARCHIVE_BODY/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('刷新治理区块时保留用户正文，且内容不变时不重写文件', async () => {
    const module = await loadModule();
    assert.ok(module, 'human document governance module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-human-doc-projection-'));

    try {
      fs.writeFileSync(path.join(root, '记忆库说明.md'), '# 记忆库说明\n\n用户手写导读，必须保留。\n', 'utf8');
      fs.writeFileSync(path.join(root, 'CodexNotes.md'), '# 旧笔记\n', 'utf8');

      const first = module.refreshHumanDocumentGovernanceProjection(root);
      const firstStat = fs.statSync(path.join(root, '记忆库说明.md')).mtimeMs;
      const content = fs.readFileSync(path.join(root, '记忆库说明.md'), 'utf8');
      assert.equal(first.changed, true);
      assert.match(content, /用户手写导读，必须保留/u);
      assert.match(content, /cti-human-document-governance:start/u);
      assert.match(content, /CodexNotes\.md/u);

      const second = module.refreshHumanDocumentGovernanceProjection(root);
      const secondStat = fs.statSync(path.join(root, '记忆库说明.md')).mtimeMs;
      assert.equal(second.changed, false);
      assert.equal(secondStat, firstStat);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('把未归类文档事务性归档并可按清单还原，固定入口禁止归档', async () => {
    const module = await loadModule();
    assert.ok(module, 'human document governance module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-human-doc-archive-'));

    try {
      fs.writeFileSync(path.join(root, '记忆库说明.md'), '# 记忆库说明\n', 'utf8');
      fs.writeFileSync(path.join(root, 'CodexNotes.md'), '# 旧笔记\n', 'utf8');
      fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'docs', '旧桥接说明.md'), '# 旧桥接说明\n', 'utf8');

      assert.throws(
        () => module.archiveHumanReadableDocuments(root, ['记忆库说明.md']),
        /固定入口|managed/u,
      );

      const archived = module.archiveHumanReadableDocuments(
        root,
        ['CodexNotes.md', 'docs/旧桥接说明.md'],
        new Date('2026-07-20T10:30:00.000Z'),
      );
      assert.equal(fs.existsSync(path.join(root, 'CodexNotes.md')), false);
      assert.equal(fs.existsSync(path.join(root, 'docs', '旧桥接说明.md')), false);
      assert.equal(fs.existsSync(archived.manifestPath), true);
      assert.equal(archived.entries.length, 2);
      assert.equal(archived.entries.every((item: { sha256: string }) => /^[a-f0-9]{64}$/u.test(item.sha256)), true);
      assert.match(fs.readFileSync(path.join(root, '记忆库说明.md'), 'utf8'), /archive\/human-documents/u);

      const restored = module.restoreArchivedHumanDocument(root, archived.manifestPath, 'CodexNotes.md');
      assert.equal(restored.restored, true);
      assert.equal(fs.existsSync(path.join(root, 'CodexNotes.md')), true);
      assert.equal(fs.readFileSync(path.join(root, 'CodexNotes.md'), 'utf8'), '# 旧笔记\n');

      const tamperedManifestPath = path.join(root, 'archive', 'human-documents', 'tampered.json');
      const escapedArchivePath = path.join(root, 'archive', 'human-documents-escape', '伪归档.md');
      fs.mkdirSync(path.dirname(escapedArchivePath), { recursive: true });
      fs.writeFileSync(escapedArchivePath, '# 伪归档\n', 'utf8');
      const crypto = await import('node:crypto');
      fs.writeFileSync(tamperedManifestPath, JSON.stringify({
        schema: 'codex-im-suite/human-document-archive/v1',
        archivedAt: '2026-07-20T10:30:00.000Z',
        entries: [{
          originalRelativePath: '伪归档.md',
          archivedRelativePath: 'archive/human-documents-escape/伪归档.md',
          sha256: crypto.createHash('sha256').update(fs.readFileSync(escapedArchivePath)).digest('hex'),
        }],
      }), 'utf8');
      assert.throws(
        () => module.restoreArchivedHumanDocument(root, tamperedManifestPath, '伪归档.md'),
        /归档文件路径越界/u,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
