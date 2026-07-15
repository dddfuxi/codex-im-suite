import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyMemoryOptimizationDraft,
  createMemoryOptimizationDraft,
  discardMemoryOptimizationDraft,
  getMemoryOptimizationDraftsDir,
  readMemoryOptimizationStatus,
  undoMemoryOptimizationDraft,
  updateMemoryOptimizerSchedule,
  type MemoryOptimizationDraft,
} from '../memory-optimizer.js';
import { writeKnowledgeIndex, type KnowledgeIndex } from '../knowledge-indexer.js';

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-optimizer-'));
}

function memoryMetadata(): Record<string, string> {
  return {
    schema: 'codex-im-suite/memory/v2',
    memoryScope: 'user',
    channelType: 'feishu',
    userId: 'ou_user_1',
  };
}

function memoryFrontmatter(): string {
  return [
    '---',
    'schema: codex-im-suite/memory/v2',
    'memoryScope: user',
    'channelType: feishu',
    'userId: ou_user_1',
    '---',
    '',
  ].join('\n');
}

function writeFixtureIndex(root: string): { index: KnowledgeIndex; duplicateId: string; docDuplicateId: string } {
  const fileA = path.join(root, 'data', 'memory', 'v2', 'users', 'feishu', 'ou_user_1', 'a.md');
  const fileB = path.join(root, 'data', 'memory', 'v2', 'users', 'feishu', 'ou_user_1', 'b.md');
  const fileC = path.join(root, 'data', 'memory', 'v2', 'users', 'feishu', 'ou_user_1', 'c.md');
  const docFile = path.join(root, 'docs', 'AI_BRIDGE_CONTEXT.md');
  fs.mkdirSync(path.dirname(fileA), { recursive: true });
  fs.mkdirSync(path.dirname(docFile), { recursive: true });
  fs.writeFileSync(fileA, `${memoryFrontmatter()}- fact: favorite_color: blue\n- conclusion: keep Codex primary\n`, 'utf-8');
  fs.writeFileSync(fileB, `${memoryFrontmatter()}- fact: favorite_color: blue\n`, 'utf-8');
  fs.writeFileSync(fileC, `${memoryFrontmatter()}- fact: favorite_color: blue\n`, 'utf-8');
  fs.writeFileSync(docFile, '- fact: favorite_color: blue\n', 'utf-8');
  const index: KnowledgeIndex = {
    schema: 'codex-im-suite/knowledge-index/v1',
    memoryRoot: root,
    generatedAt: '2026-05-16T00:00:00.000Z',
    itemCount: 5,
    conflictCount: 0,
    items: [
      {
        id: 'fact-a',
        kind: 'fact',
        key: 'favorite_color',
        value: 'blue',
        text: 'favorite_color: blue',
        confidence: 0.9,
        conflict: false,
        source: { path: fileA, snippet: '- fact: favorite_color: blue', updatedAt: '2026-05-16T00:00:00.000Z', metadata: memoryMetadata() },
      },
      {
        id: 'fact-b',
        kind: 'fact',
        key: 'favorite_color',
        value: 'blue',
        text: 'favorite_color: blue',
        confidence: 0.8,
        conflict: false,
        source: { path: fileB, snippet: '- fact: favorite_color: blue', updatedAt: '2026-05-15T00:00:00.000Z', metadata: memoryMetadata() },
      },
      {
        id: 'fact-doc',
        kind: 'fact',
        key: 'favorite_color',
        value: 'blue',
        text: 'favorite_color: blue',
        confidence: 0.7,
        conflict: false,
        source: { path: docFile, snippet: '- fact: favorite_color: blue', updatedAt: '2026-05-14T00:00:00.000Z' },
      },
      {
        id: 'fact-c',
        kind: 'fact',
        key: 'favorite_color',
        value: 'blue',
        text: 'favorite_color: blue',
        confidence: 0.7,
        conflict: false,
        source: { path: fileC, snippet: '- fact: favorite_color: blue', updatedAt: '2026-05-14T12:00:00.000Z', metadata: memoryMetadata() },
      },
      {
        id: 'conclusion-a',
        kind: 'conclusion',
        text: 'keep Codex primary',
        confidence: 0.9,
        conflict: false,
        source: { path: fileA, snippet: '- conclusion: keep Codex primary', updatedAt: '2026-05-16T00:00:00.000Z', metadata: memoryMetadata() },
      },
    ],
  };
  writeKnowledgeIndex(root, index);
  return { index, duplicateId: 'fact-b', docDuplicateId: 'fact-doc' };
}

describe('memory optimizer', () => {
  it('generates source-aware drafts and does not archive generated summary items', () => {
    const root = makeTempRoot();
    try {
      writeFixtureIndex(root);
      const draft = createMemoryOptimizationDraft(root);
      assert.equal(draft.schema, 'codex-im-suite/memory-optimization-draft/v1');
      assert.equal(draft.status, 'draft');
      assert.ok(draft.sourceSummary?.some((item) => item.sourceGroup === 'memory_user' && item.autoSelectable));
      assert.equal(draft.sourceSummary?.some((item) => String(item.sourceGroup) === 'context_doc'), false);
      assert.equal(draft.actions.some((action) => action.type === 'update' && String(action.sourceGroup) === 'generated_summary'), false);
      assert.ok(draft.actions.some((action) => action.type === 'archive' && action.source?.itemId === 'fact-b' && action.defaultSelected === true));
      assert.equal(draft.actions.some((action) => action.type === 'archive' && action.source?.itemId === 'fact-doc'), false);
      const status = readMemoryOptimizationStatus(root);
      assert.equal(status.draftCount, 1);
      assert.equal(status.drafts[0].draftId, draft.draftId);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies only explicitly selected actions', () => {
    const root = makeTempRoot();
    try {
      writeFixtureIndex(root);
      const draft = createMemoryOptimizationDraft(root);
      const archiveAction = draft.actions.find((action) => action.type === 'archive' && action.source?.itemId === 'fact-b');
      assert.ok(archiveAction);

      const result = applyMemoryOptimizationDraft(root, { draftId: draft.draftId, selectedActionIds: [archiveAction!.id] });
      assert.equal(result.draft.status, 'applied');
      assert.equal(fs.existsSync(path.join(root, 'data', 'explicit-memories', 'memory-summary.md')), false);
      assert.doesNotMatch(fs.readFileSync(path.join(root, 'data', 'memory', 'v2', 'users', 'feishu', 'ou_user_1', 'b.md'), 'utf-8'), /favorite_color/);
      assert.deepEqual(result.appliedActionIds, [archiveAction!.id]);
      assert.ok(result.skippedActionIds.length >= 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects stale drafts when the knowledge index changed', () => {
    const root = makeTempRoot();
    try {
      const { index } = writeFixtureIndex(root);
      const draft = createMemoryOptimizationDraft(root);
      writeKnowledgeIndex(root, { ...index, generatedAt: '2026-05-17T00:00:00.000Z' });
      assert.throws(
        () => applyMemoryOptimizationDraft(root, { draftId: draft.draftId, selectedActionIds: draft.actions.map((action) => action.id) }),
        /记忆索引已变化/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('undoes applied archive actions', () => {
    const root = makeTempRoot();
    try {
      writeFixtureIndex(root);
      const draft = createMemoryOptimizationDraft(root);
      const archiveAction = draft.actions.find((action) => action.type === 'archive' && action.source?.itemId === 'fact-b');
      assert.ok(archiveAction);
      applyMemoryOptimizationDraft(root, { draftId: draft.draftId, selectedActionIds: [archiveAction!.id] });

      const result = undoMemoryOptimizationDraft(root, draft.draftId);

      assert.equal(result.draft.status, 'undone');
      assert.ok(result.restoredActionIds.includes(archiveAction!.id));
      assert.equal(result.manualActionIds.length, 0);
      assert.match(fs.readFileSync(path.join(root, 'data', 'memory', 'v2', 'users', 'feishu', 'ou_user_1', 'b.md'), 'utf-8'), /favorite_color/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects draft actions that target files outside the memory repo', () => {
    const root = makeTempRoot();
    try {
      writeFixtureIndex(root);
      const draftId = 'bad-draft';
      const draft: MemoryOptimizationDraft = {
        schema: 'codex-im-suite/memory-optimization-draft/v1',
        draftId,
        generatedAt: new Date().toISOString(),
        generatedBy: 'manual',
        status: 'draft',
        sourceIndexGeneratedAt: '2026-05-16T00:00:00.000Z',
        summary: 'bad',
        actions: [{
          id: 'bad-action',
          type: 'add',
          title: 'bad',
          reason: 'bad',
          confidence: 1,
          risk: 'high',
          targetPath: path.join(os.tmpdir(), 'outside-memory.md'),
          after: 'bad',
        }],
      };
      const draftsDir = getMemoryOptimizationDraftsDir(root);
      fs.mkdirSync(draftsDir, { recursive: true });
      fs.writeFileSync(path.join(draftsDir, `${draftId}.json`), JSON.stringify(draft, null, 2), 'utf-8');
      assert.throws(() => applyMemoryOptimizationDraft(root, { draftId, selectedActionIds: ['bad-action'] }), /目标文件不在记忆仓库/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('updates schedule state and discards drafts without applying them', () => {
    const root = makeTempRoot();
    try {
      writeFixtureIndex(root);
      const draft = createMemoryOptimizationDraft(root);
      const state = updateMemoryOptimizerSchedule(root, { enabled: true, intervalDays: 7, modelSource: 'codex_primary' });
      assert.equal(state.enabled, true);
      assert.equal(state.intervalDays, 7);
      const discarded = discardMemoryOptimizationDraft(root, draft.draftId);
      assert.equal(discarded.status, 'discarded');
      assert.equal(readMemoryOptimizationStatus(root).draftCount, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
