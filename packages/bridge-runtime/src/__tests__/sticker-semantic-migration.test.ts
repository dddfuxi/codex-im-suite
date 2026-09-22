import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  applyStickerSemanticMigrationPlan,
  buildStickerSemanticMigrationPlan,
} from '../sticker-semantics/migration.js';
import { createStickerSemanticStore } from '../sticker-semantics/store.js';

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-sticker-migration-'));
  const stickerRoot = path.join(root, 'data', 'im', 'feishu', 'stickers');
  fs.mkdirSync(stickerRoot, { recursive: true });
  fs.writeFileSync(path.join(stickerRoot, 'stickers.json'), `${JSON.stringify({
    version: 1,
    stickers: [
      {
        fileKey: 'vision-1',
        label: '庆祝猫',
        aliases: ['庆祝'],
        intent: '庆祝成功',
        tone: '轻松',
        usage: '完成任务时',
        avoidWhen: '正式通知时避免',
        annotationSource: 'vision',
        annotationConfidence: 0.96,
      },
      {
        fileKey: 'manual-1',
        label: '人工确认猫',
        usage: '人工确认的用法',
        annotationSource: 'manual',
      },
      {
        fileKey: 'user-1',
        label: '用户解释猫',
        intent: '用户说它很开心',
        annotationSource: 'user',
        userAnnotation: { intent: '开心' },
      },
    ],
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(root, '记忆总索引.md'), '# 记忆总索引\n', 'utf8');
  fs.writeFileSync(path.join(root, '记忆库说明.md'), '# 记忆库说明\n', 'utf8');
  return root;
}

function hashSemanticFiles(root: string): string {
  const stickerRoot = path.join(root, 'data', 'im', 'feishu', 'stickers');
  const files = fs.existsSync(stickerRoot)
    ? fs.readdirSync(stickerRoot, { recursive: true, withFileTypes: true })
      .filter((item) => item.isFile())
      .map((item) => path.join(item.parentPath, item.name))
      .sort()
    : [];
  return crypto.createHash('sha256').update(files.map((file) => `${file}:${fs.readFileSync(file).toString('base64')}`).join('\n')).digest('hex');
}

describe('sticker semantic migration', () => {
  it('previews legacy migration without changing source files', () => {
    const root = makeRoot();
    const before = hashSemanticFiles(root);
    const plan = buildStickerSemanticMigrationPlan({ memoryRoot: root, now: () => '2026-07-20T00:00:00.000Z' });

    assert.equal(plan.operations.some((item) => item.action === 'seed_confirmed_revision' && item.fileKey === 'vision-1'), true);
    assert.equal(plan.operations.some((item) => item.action === 'convert_free_text_avoid_when' && item.fileKey === 'vision-1'), true);
    assert.equal(plan.operations.some((item) => item.action === 'preserve_manual' && item.fileKey === 'manual-1'), true);
    assert.equal(plan.operations.some((item) => item.action === 'blocked' && item.fileKey === 'user-1'), true);
    assert.equal(hashSemanticFiles(root), before);
  });

  it('applies reviewed hashes, backs up source, and remains idempotent', () => {
    const root = makeRoot();
    const plan = buildStickerSemanticMigrationPlan({ memoryRoot: root, now: () => '2026-07-20T00:00:00.000Z' });
    const first = applyStickerSemanticMigrationPlan(plan, {
      now: () => '2026-07-20T00:01:00.000Z',
      assertProcessesStopped: () => undefined,
    });
    const second = applyStickerSemanticMigrationPlan(plan, {
      now: () => '2026-07-20T00:02:00.000Z',
      assertProcessesStopped: () => undefined,
    });
    const snapshot = createStickerSemanticStore({ memoryRoot: root }).readSnapshot();

    assert.equal(first.convertedRules, 1);
    assert.equal(first.seededConfirmed, 2);
    assert.equal(second.convertedRules, 0);
    assert.equal(second.seededConfirmed, 0);
    assert.equal(snapshot.revisions.filter((item) => item.status === 'confirmed').length, 2);
    assert.equal(snapshot.revisions.filter((item) => item.status === 'trial').length, 1);
    assert.equal(snapshot.revisions.some((item) => item.fileKey === 'user-1'), false);
    assert.equal(fs.existsSync(first.backupPath), true);
    assert.match(fs.readFileSync(path.join(root, 'data', 'im', 'feishu', 'stickers', '表情包语义档案.md'), 'utf8'), /正式通知时避免/u);
  });

  it('rejects apply while the live Bridge runtime is still active', () => {
    const root = makeRoot();
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-sticker-migration-home-'));
    const statusPath = path.join(ctiHome, 'runtime', 'status.json');
    const previousCtiHome = process.env.CTI_HOME;

    try {
      fs.mkdirSync(path.dirname(statusPath), { recursive: true });
      fs.writeFileSync(statusPath, JSON.stringify({ running: true, pid: process.pid }), 'utf8');
      process.env.CTI_HOME = ctiHome;
      const plan = buildStickerSemanticMigrationPlan({ memoryRoot: root });

      assert.throws(() => applyStickerSemanticMigrationPlan(plan), /Bridge 仍在运行/u);
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });

  it('rejects apply while the memory watcher is still active', () => {
    const root = makeRoot();
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-sticker-migration-watcher-home-'));
    const statusPath = path.join(root, '.cti-index', 'status.json');
    const previousCtiHome = process.env.CTI_HOME;

    try {
      process.env.CTI_HOME = ctiHome;
      fs.mkdirSync(path.dirname(statusPath), { recursive: true });
      fs.writeFileSync(statusPath, JSON.stringify({ watching: true, watcherPid: process.pid }), 'utf8');
      const plan = buildStickerSemanticMigrationPlan({ memoryRoot: root });

      assert.throws(() => applyStickerSemanticMigrationPlan(plan), /记忆索引 watcher 仍在运行/u);
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });
});
