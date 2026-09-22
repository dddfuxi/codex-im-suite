import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { readKnowledgeIndex } from '../knowledge-indexer.js';
import {
  materializeDerivedUserImpression,
  upsertConfirmedMemoryDocument,
} from '../memory-documents.js';
import {
  createMemoryItemLifecycleService,
  type MemoryItemFileOperations,
} from '../memory-items/lifecycle.js';
import { readManagedMemoryDocument } from '../memory-items/managed-document.js';

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.test.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

describe('memory item lifecycle', () => {
  it('confirms, archives, restores and permanently deletes one memory item', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-lifecycle-'));

    try {
      materializeDerivedUserImpression({
        memoryRoot: root,
        channelType: 'feishu',
        userId: 'ou_user_a',
        displayName: '刘丹',
        observations: [{ text: '我更喜欢先给结论，再列验证证据。', count: 3 }],
        updatedAt: '2026-07-20T10:00:00.000Z',
      });
      const service = createMemoryItemLifecycleService({
        memoryRoot: root,
        now: () => '2026-07-20T11:00:00.000Z',
      });
      const candidate = service.listCandidates()[0];
      assert.ok(candidate);

      const confirmed = service.confirmCandidate(candidate.itemId, 'control-panel');
      assert.equal(confirmed.status, 'confirmed');
      assert.doesNotMatch(confirmed.key, /^暂定-/u);
      assert.deepEqual(readKnowledgeIndex(root)?.items.map((item) => item.key), [confirmed.key]);

      const archived = service.archive(confirmed.itemId, 'control-panel');
      assert.equal(archived.previousStatus, 'confirmed');
      assert.equal(readKnowledgeIndex(root)?.items.length, 0);
      assert.equal(service.listArchives().length, 1);

      const archiveIndex = fs.readFileSync(path.join(root, 'archive', 'memory-items', '记忆归档索引.md'), 'utf8');
      assert.match(archiveIndex, /# 记忆归档索引/u);
      assert.match(archiveIndex, /可还原/u);

      service.restore(archived.archiveId, 'control-panel');
      assert.equal(readKnowledgeIndex(root)?.items.length, 1);
      assert.equal(service.listArchives().length, 0);

      const restored = service.listConfirmed()[0];
      const archivedAgain = service.archive(restored.itemId, 'control-panel');
      const firstDelete = service.deleteArchive(archivedAgain.archiveId, 'control-panel');
      const secondDelete = service.deleteArchive(archivedAgain.archiveId, 'control-panel');
      assert.equal(firstDelete.deleted, true);
      assert.equal(secondDelete.deleted, false);
      assert.equal(service.listArchives().length, 0);

      const source = readManagedMemoryDocument(restored.sourcePath);
      assert.equal(Object.keys(source.state.deletedCandidateFingerprints).length, 1);

      materializeDerivedUserImpression({
        memoryRoot: root,
        channelType: 'feishu',
        userId: 'ou_user_a',
        displayName: '刘丹',
        observations: [{ text: '我更喜欢先给结论，再列验证证据。', count: 8 }],
        updatedAt: '2026-07-21T10:00:00.000Z',
      });
      assert.equal(Object.keys(readManagedMemoryDocument(restored.sourcePath).state.candidates).length, 0);

      const master = fs.readFileSync(path.join(root, '记忆总索引.md'), 'utf8');
      assert.match(master, /## 用户印象/u);
      assert.match(master, /memory\/users\/feishu\/ou_user_a\/用户印象\.md/u);
      assert.match(master, /已确认 0.*候选 0.*已归档 0/u);
      assert.doesNotMatch(master, /我更喜欢先给结论/u);

      const guide = fs.readFileSync(path.join(root, '记忆库说明.md'), 'utf8');
      assert.match(guide, /cti-memory-layout:start/u);
      assert.match(guide, /已确认：0/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rolls back machine state when a human-readable projection cannot be written', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-projection-rollback-'));

    try {
      const written = upsertConfirmedMemoryDocument({
        memoryRoot: root,
        scope: 'long_term',
        pairs: [{ key: '工作区规则', value: '记忆库不挂载' }],
        evidenceText: '记忆库不作为工作区挂载',
        createdAt: '2026-07-20T10:00:00.000Z',
      });
      const original = fs.readFileSync(written.filePath, 'utf8');
      const fileOps: MemoryItemFileOperations = {
        writeAtomic: (filePath, content) => {
          if (path.basename(filePath) === '记忆总索引.md') throw new Error('simulated projection failure');
          atomicWrite(filePath, content);
        },
        removeFile: (filePath) => fs.rmSync(filePath, { force: true }),
      };
      const service = createMemoryItemLifecycleService({ memoryRoot: root, fileOps });
      const item = service.listConfirmed()[0];

      assert.throws(() => service.archive(item.itemId, 'control-panel'), /projection_write_failed/u);
      assert.equal(fs.readFileSync(written.filePath, 'utf8'), original);
      assert.equal(service.listArchives().length, 0);
      assert.equal(readManagedMemoryDocument(written.filePath).state.confirmed['工作区规则']?.value, '记忆库不挂载');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rebuilds its managed index block without overwriting other human-readable projections', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-projection-compose-'));

    try {
      const written = upsertConfirmedMemoryDocument({
        memoryRoot: root,
        scope: 'long_term',
        pairs: [{ key: '工作区规则', value: '记忆库不挂载' }],
        evidenceText: '记忆库不作为工作区挂载',
        createdAt: '2026-07-20T10:00:00.000Z',
      });
      const masterPath = path.join(root, '记忆总索引.md');
      fs.writeFileSync(masterPath, [
        '# 记忆总索引',
        '',
        '用户手写导读，必须保留。',
        '',
        '<!-- cti-agent-home-index:start -->',
        '## Agent Home 自维护入口',
        '',
        '- 旧投影占位。',
        '<!-- cti-agent-home-index:end -->',
        '',
      ].join('\n'), 'utf8');

      const service = createMemoryItemLifecycleService({ memoryRoot: root });
      service.archive(service.listConfirmed()[0].itemId, 'control-panel');

      const master = fs.readFileSync(masterPath, 'utf8');
      assert.match(master, /用户手写导读，必须保留/u);
      assert.match(master, /cti-agent-home-index:start/u);
      assert.match(master, /## 公共长期记忆/u);
      assert.equal((master.match(/cti-memory-index:start/gu) || []).length, 1);
      assert.equal(readManagedMemoryDocument(written.filePath).state.confirmed['工作区规则'], undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects stale source hashes, path traversal and restore conflicts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-lifecycle-guards-'));

    try {
      upsertConfirmedMemoryDocument({
        memoryRoot: root,
        scope: 'long_term',
        pairs: [{ key: '默认规则', value: '先测试' }],
        evidenceText: '默认先测试',
      });
      const service = createMemoryItemLifecycleService({ memoryRoot: root });
      const item = service.listConfirmed()[0];

      assert.throws(
        () => service.archive(item.itemId, 'control-panel', { expectedBaseHash: 'stale' }),
        /source_changed/u,
      );
      assert.throws(() => service.restore('../outside', 'control-panel'), /invalid_archive_id/u);

      const archived = service.archive(item.itemId, 'control-panel');
      upsertConfirmedMemoryDocument({
        memoryRoot: root,
        scope: 'long_term',
        pairs: [{ key: '默认规则', value: '直接发布' }],
        evidenceText: '冲突写入',
      });
      assert.throws(() => service.restore(archived.archiveId, 'control-panel'), /restore_conflict/u);
      assert.equal(service.listArchives().length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not remove an old write lock while its owner process is still alive', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-live-lock-'));

    try {
      upsertConfirmedMemoryDocument({
        memoryRoot: root,
        scope: 'long_term',
        pairs: [{ key: '锁规则', value: '存活进程优先' }],
        evidenceText: '锁规则',
      });
      const service = createMemoryItemLifecycleService({ memoryRoot: root });
      const lockPath = path.join(root, '.cti-memory-items', 'write.lock');
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, acquiredAt: '2026-07-01T00:00:00.000Z' })}\n`, 'utf8');
      const old = new Date(Date.now() - 60 * 60_000);
      fs.utimesSync(lockPath, old, old);

      assert.throws(() => service.archive(service.listConfirmed()[0].itemId, 'control-panel'), /memory_item_write_locked/u);
      assert.equal(fs.existsSync(lockPath), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
