import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readKnowledgeIndexStatus,
  rebuildKnowledgeIndex,
  startKnowledgeIndexWatcher,
} from '../knowledge-index-service.js';

describe('knowledge index service realtime status', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-knowledge-service-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists status next to the knowledge index after a rebuild', () => {
    fs.writeFileSync(path.join(tmpDir, 'notes.md'), '事实：默认只把记忆注入 Codex。', 'utf-8');

    const status = rebuildKnowledgeIndex(tmpDir);
    const statusPath = path.join(tmpDir, '.cti-index', 'status.json');

    assert.equal(status.itemCount, 1);
    assert.ok(status.memoryGraphPath?.endsWith(path.join('.cti-index', 'memory-graph.json')));
    assert.ok((status.memoryGraphNodeCount ?? 0) >= 1);
    assert.ok((status.memoryGraphEdgeCount ?? 0) >= 0);
    assert.ok(fs.existsSync(statusPath));
    assert.equal(fs.existsSync(status.memoryGraphPath || ''), true);

    const persisted = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as typeof status;
    assert.equal(persisted.schema, 'codex-im-suite/knowledge-index-status/v1');
    assert.equal(persisted.watching, false);
    assert.equal(persisted.itemCount, 1);
    assert.equal(persisted.memoryGraphPath, status.memoryGraphPath);
    assert.equal(persisted.memoryGraphNodeCount, status.memoryGraphNodeCount);
    assert.equal(persisted.memoryGraphEdgeCount, status.memoryGraphEdgeCount);
    assert.equal(persisted.markdownFileCount, 1);
    assert.ok(persisted.lastIndexedAt);

    const readBack = readKnowledgeIndexStatus(tmpDir);
    assert.equal(readBack.lastIndexedAt, persisted.lastIndexedAt);
    assert.equal(readBack.itemCount, 1);
  });

  it('persists watcher lifecycle status for panel visibility', async () => {
    const watcher = startKnowledgeIndexWatcher(tmpDir);
    const statusPath = path.join(tmpDir, '.cti-index', 'status.json');

    try {
      assert.ok(fs.existsSync(statusPath));
      const started = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as ReturnType<typeof watcher.status>;
      assert.equal(started.watching, true);
      assert.ok(started.watcherStartedAt);
      assert.ok(started.statusUpdatedAt);

      fs.writeFileSync(path.join(tmpDir, 'decision.md'), '结论：状态文件是面板判断实时监听的来源。', 'utf-8');
      const rebuilt = await watcher.rebuild();
      const persisted = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as typeof rebuilt;

      assert.equal(persisted.watching, true);
      assert.equal(persisted.itemCount, 1);
      assert.ok(persisted.lastIndexedAt);
      assert.equal(readKnowledgeIndexStatus(tmpDir).watching, true);
    } finally {
      watcher.close();
    }

    const closed = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as ReturnType<typeof watcher.status>;
    assert.equal(closed.watching, false);
    assert.ok(closed.statusUpdatedAt);
  });
});
