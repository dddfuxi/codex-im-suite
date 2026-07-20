import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { runStickerSemanticCli } from '../sticker-semantic-cli.js';
import { createStickerSemanticStore } from '../sticker-semantics/store.js';
import type { StickerSemanticRevisionV1 } from '../sticker-semantics/types.js';

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-sticker-cli-'));
  const stickerRoot = path.join(root, 'data', 'im', 'feishu', 'stickers');
  fs.mkdirSync(stickerRoot, { recursive: true });
  fs.writeFileSync(path.join(stickerRoot, 'stickers.json'), `${JSON.stringify({
    version: 1,
    stickers: [{ fileKey: 'file-1', label: '庆祝猫', aliases: ['庆祝'], annotationSource: 'vision', description: '猫咪庆祝' }],
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(root, '记忆总索引.md'), '# 记忆总索引\n', 'utf8');
  fs.writeFileSync(path.join(root, '记忆库说明.md'), '# 记忆库说明\n', 'utf8');
  const store = createStickerSemanticStore({ memoryRoot: root, now: () => '2026-07-20T00:00:00.000Z' });
  const initial = store.readSnapshot();
  const revision: StickerSemanticRevisionV1 = {
    schema: 'codex-im-suite/sticker-semantic-revision/v1',
    revisionId: 'revision-1',
    fileKey: 'file-1',
    scope: 'global',
    status: 'trial',
    versionId: 'version-1',
    baseHash: initial.baseHash,
    patch: { usage: '用于轻松庆祝' },
    supportEvidenceHashes: [],
    contradictionEvidenceHashes: [],
    supportSessionIds: [],
    contradictionSessionIds: [],
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  };
  store.applyRevision(revision, 'migration');
  return root;
}

describe('sticker semantic CLI', () => {
  it('returns stable JSON data for status and list commands', () => {
    const root = makeRoot();
    const status = runStickerSemanticCli(['status', '--memory-root', root]);
    const list = runStickerSemanticCli(['list', '--status', 'trial', '--memory-root', root]);

    assert.equal(status.ok, true);
    assert.equal(status.data.counts.trial, 1);
    assert.equal(list.data.revisions.length, 1);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(status)));
  });

  it('requires expected base hash for accept reject rollback and manual mutations', () => {
    const root = makeRoot();
    for (const args of [
      ['accept-revision', 'revision-1'],
      ['reject-revision', 'revision-1'],
      ['rollback', 'revision-1'],
      ['update-manual', 'file-1', '--payload-base64', Buffer.from('{}').toString('base64')],
      ['archive', 'file-1'],
    ]) {
      assert.throws(() => runStickerSemanticCli([...args, '--memory-root', root]), /expected_base_hash_required/u);
    }
  });

  it('accepts a trial revision and refreshes the human-readable archive', () => {
    const root = makeRoot();
    const baseHash = createStickerSemanticStore({ memoryRoot: root }).readSnapshot().baseHash;
    const result = runStickerSemanticCli([
      'accept-revision', 'revision-1',
      '--expected-base-hash', baseHash,
      '--memory-root', root,
    ]);

    assert.equal(result.data.revision.status, 'confirmed');
    const archive = fs.readFileSync(path.join(root, 'data', 'im', 'feishu', 'stickers', '表情包语义档案.md'), 'utf8');
    assert.match(archive, /已确认/u);
  });
});
