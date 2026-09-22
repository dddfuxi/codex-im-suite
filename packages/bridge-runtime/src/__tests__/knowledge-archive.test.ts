import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { rebuildKnowledgeIndex } from '../knowledge-index-service.js';
import { readKnowledgeIndex } from '../knowledge-indexer.js';
import {
  archiveKnowledgeItem,
  deleteKnowledgeArchive,
  listKnowledgeArchives,
  restoreKnowledgeArchive,
} from '../knowledge-archive.js';

function writeMemoryV2Markdown(
  root: string,
  relativeParts: string[],
  frontmatter: string[],
  bodyLines: string[],
): string {
  const sourcePath = path.join(root, 'data', 'memory', 'v2', ...relativeParts);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, [
    '---',
    'schema: codex-im-suite/memory/v2',
    ...frontmatter,
    '---',
    '',
    ...bodyLines,
    '',
  ].join('\n'), 'utf-8');
  return sourcePath;
}

describe('knowledge archive', () => {
  it('moves a knowledge item out of its source markdown into archive', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-knowledge-archive-'));
    try {
      const sourcePath = writeMemoryV2Markdown(root, ['groups', 'feishu', 'oc_123', 'notes.md'], [
        'memoryScope: group',
        'channelType: feishu',
        'chatId: oc_123',
      ], [
        '# Notes',
        '',
        '待办: 清理面板 @2026-04-30 12:00 状态: 未完成',
        '结论: 保留当前架构。',
      ]);
      rebuildKnowledgeIndex(root);
      const item = readKnowledgeIndex(root)?.items.find((entry) => entry.kind === 'todo');
      assert.ok(item);

      const archived = archiveKnowledgeItem(root, {
        itemId: item.id,
        archivedAt: '2026-04-30T03:30:00.000Z',
      });

      assert.equal(archived.ok, true);
      assert.ok(archived.archivePath);
      assert.match(fs.readFileSync(sourcePath, 'utf-8'), /结论: 保留当前架构/);
      assert.doesNotMatch(fs.readFileSync(sourcePath, 'utf-8'), /清理面板/);
      assert.match(fs.readFileSync(archived.archivePath!, 'utf-8'), /清理面板/);
      assert.equal(readKnowledgeIndex(root)?.items.some((entry) => entry.id === item.id), false);
      assert.equal(listKnowledgeArchives(root).items.length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores an archived knowledge unit to its source markdown', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-knowledge-archive-restore-'));
    try {
      const sourcePath = writeMemoryV2Markdown(root, ['long-term', 'notes.md'], [
        'memoryScope: long_term',
      ], [
        '事实: 可恢复归档',
      ]);
      rebuildKnowledgeIndex(root);
      const item = readKnowledgeIndex(root)?.items[0];
      assert.ok(item);
      const archived = archiveKnowledgeItem(root, {
        itemId: item.id,
        archivedAt: '2026-04-30T03:31:00.000Z',
      });
      assert.equal(archived.ok, true);
      assert.doesNotMatch(fs.readFileSync(sourcePath, 'utf-8'), /可恢复归档/);

      const restored = restoreKnowledgeArchive(root, { archivePath: archived.archivePath! });

      assert.equal(restored.ok, true);
      assert.match(fs.readFileSync(sourcePath, 'utf-8'), /事实: 可恢复归档/);
      assert.equal(fs.existsSync(archived.archivePath!), false);
      assert.equal(readKnowledgeIndex(root)?.items.some((entry) => entry.text.includes('可恢复归档')), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects restore paths outside the archive directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-knowledge-archive-escape-'));
    try {
      const outside = path.join(os.tmpdir(), 'outside-archive.md');
      fs.writeFileSync(outside, 'bad', 'utf-8');
      const restored = restoreKnowledgeArchive(root, { archivePath: outside });
      assert.equal(restored.ok, false);
      assert.match(restored.error || '', /归档文件不在知识归档目录/);
      fs.rmSync(outside, { force: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a source-missing restore blocker', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-knowledge-archive-missing-source-'));
    try {
      const sourcePath = writeMemoryV2Markdown(root, ['long-term', 'notes.md'], [
        'memoryScope: long_term',
      ], [
        '事实: 源文件会消失',
      ]);
      rebuildKnowledgeIndex(root);
      const item = readKnowledgeIndex(root)?.items[0];
      assert.ok(item);
      const archived = archiveKnowledgeItem(root, {
        itemId: item.id,
        archivedAt: '2026-04-30T03:32:00.000Z',
      });
      fs.rmSync(sourcePath, { force: true });

      const restored = restoreKnowledgeArchive(root, { archivePath: archived.archivePath! });

      assert.equal(restored.ok, false);
      assert.match(restored.error || '', /源文件不存在/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('deletes an archived knowledge unit permanently', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-knowledge-archive-delete-'));
    try {
      const sourcePath = writeMemoryV2Markdown(root, ['long-term', 'notes.md'], [
        'memoryScope: long_term',
      ], [
        '事实: 可删除归档',
      ]);
      rebuildKnowledgeIndex(root);
      const item = readKnowledgeIndex(root)?.items[0];
      assert.ok(item);
      const archived = archiveKnowledgeItem(root, {
        itemId: item.id,
        archivedAt: '2026-04-30T03:31:00.000Z',
      });
      assert.equal(fs.existsSync(archived.archivePath!), true);

      const deleted = deleteKnowledgeArchive(root, { archivePath: archived.archivePath! });

      assert.equal(deleted.ok, true);
      assert.equal(fs.existsSync(archived.archivePath!), false);
      assert.equal(listKnowledgeArchives(root).items.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
