import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createStickerSemanticStore } from '../sticker-semantics/store.js';
import type { StickerSemanticRevisionV1 } from '../sticker-semantics/types.js';

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-sticker-semantics-'));
  const stickerRoot = path.join(root, 'data', 'im', 'feishu', 'stickers');
  fs.mkdirSync(stickerRoot, { recursive: true });
  fs.writeFileSync(path.join(stickerRoot, 'stickers.json'), `${JSON.stringify({
    version: 1,
    updatedAt: '2026-07-20T00:00:00.000Z',
    stickers: [{
      fileKey: 'file-1',
      aliases: ['真棒'],
      label: '真棒猫',
      description: '猫咪配字真棒',
      intent: '夸奖',
      tone: '可爱',
      usage: '用于轻松确认',
      annotationSource: 'vision',
      annotationConfidence: 0.95,
      firstSeenAt: '2026-07-19T00:00:00.000Z',
      lastSeenAt: '2026-07-20T00:00:00.000Z',
      useCount: 1,
    }],
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(root, '记忆总索引.md'), '# 记忆总索引\n\n用户内容。\n', 'utf8');
  fs.writeFileSync(path.join(root, '记忆库说明.md'), '# 记忆库说明\n\n用户说明。\n', 'utf8');
  return root;
}

function revision(baseHash: string): StickerSemanticRevisionV1 {
  return {
    schema: 'codex-im-suite/sticker-semantic-revision/v1',
    revisionId: 'revision-1',
    fileKey: 'file-1',
    scope: 'global',
    status: 'trial',
    versionId: 'version-1',
    baseHash,
    patch: { usage: '用于轻松确认' },
    supportEvidenceHashes: [],
    contradictionEvidenceHashes: [],
    supportSessionIds: [],
    contradictionSessionIds: [],
    createdAt: '2026-07-20T00:01:00.000Z',
    updatedAt: '2026-07-20T00:01:00.000Z',
  };
}

describe('sticker semantic store', () => {
  it('stores revisions separately from immutable visual facts', () => {
    const root = makeRoot();
    const store = createStickerSemanticStore({ memoryRoot: root, now: () => '2026-07-20T00:01:00.000Z' });
    const initial = store.readSnapshot();
    store.applyRevision(revision(initial.baseHash), 'control-panel');
    const snapshot = store.readSnapshot();

    assert.equal(snapshot.assets[0].visual.source, 'vision');
    assert.equal(snapshot.assets[0].visual.description, '猫咪配字真棒');
    assert.equal(snapshot.revisions[0].status, 'trial');
    assert.equal(snapshot.revisions[0].patch.usage, '用于轻松确认');
  });

  it('rolls back all machine files when 表情包语义档案 cannot be written', () => {
    const root = makeRoot();
    const defaultStore = createStickerSemanticStore({ memoryRoot: root });
    const initial = defaultStore.readSnapshot();
    const tracked = [
      path.join(root, 'data', 'im', 'feishu', 'stickers', 'stickers.json'),
      path.join(root, '记忆总索引.md'),
      path.join(root, '记忆库说明.md'),
    ];
    const before = new Map(tracked.map((filePath) => [filePath, fs.readFileSync(filePath, 'utf8')]));
    const store = createStickerSemanticStore({
      memoryRoot: root,
      fileOps: {
        writeAtomic(filePath, content) {
          if (filePath.endsWith('表情包语义档案.md')) throw new Error('disk_locked');
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, content, 'utf8');
        },
        removeFile(filePath) { fs.rmSync(filePath, { force: true }); },
      },
    });

    assert.throws(() => store.applyRevision(revision(initial.baseHash), 'control-panel'), /projection_write_failed/u);
    for (const [filePath, content] of before) assert.equal(fs.readFileSync(filePath, 'utf8'), content);
    assert.equal(fs.existsSync(path.join(root, 'data', 'im', 'feishu', 'stickers', 'semantic-revisions.json')), false);
  });

  it('rolls back machine and earlier projections when the final human document write fails', () => {
    const root = makeRoot();
    const initial = createStickerSemanticStore({ memoryRoot: root }).readSnapshot();
    const tracked = [
      path.join(root, '记忆总索引.md'),
      path.join(root, '记忆库说明.md'),
    ];
    const before = new Map(tracked.map((filePath) => [filePath, fs.readFileSync(filePath, 'utf8')]));
    const store = createStickerSemanticStore({
      memoryRoot: root,
      fileOps: {
        writeAtomic(filePath, content) {
          if (filePath.endsWith('记忆库说明.md')) throw new Error('guide_locked');
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, content, 'utf8');
        },
        removeFile(filePath) { fs.rmSync(filePath, { force: true }); },
      },
    });

    assert.throws(() => store.applyRevision(revision(initial.baseHash), 'control-panel'), /projection_write_failed/u);
    for (const [filePath, content] of before) assert.equal(fs.readFileSync(filePath, 'utf8'), content);
    assert.equal(fs.existsSync(path.join(root, 'data', 'im', 'feishu', 'stickers', 'semantic-revisions.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'data', 'im', 'feishu', 'stickers', 'semantic-versions', 'file-1', 'revision-1.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'data', 'im', 'feishu', 'stickers', '表情包语义档案.md')), false);
  });
});
