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
} from '../knowledge-archive.js';

describe('knowledge archive', () => {
  it('moves a knowledge item out of its source markdown into archive', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-knowledge-archive-'));
    try {
      const sourcePath = path.join(root, 'notes.md');
      fs.writeFileSync(sourcePath, [
        '# Notes',
        '',
        '待办: 清理面板 @2026-04-30 12:00 状态: 未完成',
        '结论: 保留当前架构。',
        '',
      ].join('\n'), 'utf-8');
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

  it('deletes an archived knowledge unit permanently', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-knowledge-archive-delete-'));
    try {
      const sourcePath = path.join(root, 'notes.md');
      fs.writeFileSync(sourcePath, '事实: 可删除归档。', 'utf-8');
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
