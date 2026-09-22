import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  materializeDerivedUserImpression,
  upsertConfirmedMemoryDocument,
} from '../memory-documents.js';
import { runMemoryItemCli } from '../memory-item-cli.js';

describe('memory item cli', () => {
  it('lists lifecycle state through JSON-safe result objects', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-item-cli-list-'));

    try {
      upsertConfirmedMemoryDocument({
        memoryRoot: root,
        scope: 'long_term',
        pairs: [{ key: '工作区规则', value: '记忆库不挂载' }],
        evidenceText: '工作区规则',
      });
      const result = runMemoryItemCli(['status', '--memory-root', root]);

      assert.equal(result.ok, true);
      assert.equal(result.data.confirmedCount, 1);
      assert.doesNotThrow(() => JSON.stringify(result));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unknown commands and arbitrary path payloads', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-item-cli-guard-'));
    try {
      assert.throws(() => runMemoryItemCli(['unknown', '--memory-root', root]), /unknown_command/u);
      assert.throws(() => runMemoryItemCli(['restore', '../outside', '--memory-root', root]), /invalid_archive_id/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a confirmation key that could corrupt the human-readable Markdown projection', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-item-cli-key-'));
    try {
      materializeDerivedUserImpression({
        memoryRoot: root,
        channelType: 'feishu',
        userId: 'ou_user_a',
        observations: [{ text: '我更喜欢所有技术报告先给结论。', count: 3 }],
      });
      const candidate = runMemoryItemCli(['list-candidates', '--memory-root', root]).data.items[0];

      assert.throws(
        () => runMemoryItemCli(['confirm', candidate.itemId, '--key', '非法\n标题', '--memory-root', root]),
        /invalid_memory_key/u,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('executes confirm, archive, restore and permanent delete by opaque ids', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-item-cli-lifecycle-'));

    try {
      materializeDerivedUserImpression({
        memoryRoot: root,
        channelType: 'feishu',
        userId: 'ou_user_a',
        observations: [{ text: '我更喜欢先给结论，再列验证证据。', count: 3 }],
        updatedAt: '2026-07-20T10:00:00.000Z',
      });
      const candidate = runMemoryItemCli(['list-candidates', '--memory-root', root]).data.items[0];
      assert.ok(candidate);

      const confirmed = runMemoryItemCli([
        'confirm',
        candidate.itemId,
        '--expected-base-hash',
        candidate.sourceBaseHash,
        '--memory-root',
        root,
      ]).data;
      assert.equal(confirmed.status, 'confirmed');

      const archived = runMemoryItemCli([
        'archive',
        confirmed.itemId,
        '--expected-base-hash',
        confirmed.sourceBaseHash,
        '--memory-root',
        root,
      ]).data;
      assert.equal(archived.previousStatus, 'confirmed');
      assert.equal(runMemoryItemCli(['list-archives', '--memory-root', root]).data.items.length, 1);

      const restored = runMemoryItemCli(['restore', archived.archiveId, '--memory-root', root]).data;
      assert.equal(restored.status, 'confirmed');

      const archivedAgain = runMemoryItemCli(['archive', restored.itemId, '--memory-root', root]).data;
      const deleted = runMemoryItemCli(['delete-archive', archivedAgain.archiveId, '--memory-root', root]).data;
      assert.equal(deleted.deleted, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('archives only the reviewed candidate ids from a base64 JSON array', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-item-cli-batch-'));

    try {
      materializeDerivedUserImpression({
        memoryRoot: root,
        channelType: 'feishu',
        userId: 'ou_user_a',
        observations: [
          { text: '我更喜欢技术报告先给结论，再列证据。', count: 3 },
          { text: '我更喜欢变更通知明确列出验证结果。', count: 3 },
        ],
        updatedAt: '2026-07-20T10:00:00.000Z',
      });
      const candidates = runMemoryItemCli(['list-candidates', '--memory-root', root]).data.items;
      const encodedIds = Buffer.from(JSON.stringify(candidates.map((item: { itemId: string }) => item.itemId)), 'utf8').toString('base64');
      const result = runMemoryItemCli([
        'archive-candidates',
        '--ids-base64',
        encodedIds,
        '--memory-root',
        root,
      ]);

      assert.equal(result.data.archived.length, 2);
      assert.equal(runMemoryItemCli(['list-candidates', '--memory-root', root]).data.items.length, 0);
      assert.equal(runMemoryItemCli(['list-archives', '--memory-root', root]).data.items.length, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a reviewed UTF-8 migration manifest and applies that exact file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-item-cli-migrate-'));
    const output = path.join(root, 'reports', '记忆候选迁移.json');
    const previousCtiHome = process.env.CTI_HOME;

    try {
      process.env.CTI_HOME = path.join(root, 'cti-home');
      const preview = runMemoryItemCli(['migrate', 'preview', '--memory-root', root, '--output', output]);
      assert.equal(preview.ok, true);
      assert.equal(fs.existsSync(output), true);
      assert.match(fs.readFileSync(output, 'utf8'), /memory-candidate-migration\/v1/u);

      const applied = runMemoryItemCli(['migrate', 'apply', '--memory-root', root, '--manifest', output]);
      assert.equal(applied.ok, true);
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
