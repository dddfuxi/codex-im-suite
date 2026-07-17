import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

async function loadMigrationModule() {
  try {
    return await import('../memory-layout-migration.js');
  } catch {
    return null;
  }
}

function writeLegacyUserMemory(root: string, name: string, key: string, value: string): string {
  const dir = path.join(root, 'data', 'memory', 'v2', 'users', 'feishu', 'ou_user_1');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, [
    '---',
    'schema: codex-im-suite/memory/v2',
    'memoryScope: user',
    'channelType: feishu',
    'userId: ou_user_1',
    'displayName: 刘丹',
    '---',
    '',
    '| key | value |',
    '| --- | --- |',
    `| ${key} | ${value} |`,
  ].join('\n'), 'utf8');
  return filePath;
}

describe('memory layout migration', () => {
  it('defaults to dry-run and leaves the old and new layouts untouched', async () => {
    const module = await loadMigrationModule();
    assert.ok(module, 'memory migration module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-migration-dry-'));
    const legacyFile = writeLegacyUserMemory(root, 'language.md', '回复语言', '中文');

    try {
      const report = module.migrateMemoryLayout(root, { apply: false, now: '2026-07-17T12:00:00.000Z' });

      assert.equal(report.applied, false);
      assert.equal(report.actions.length, 1);
      assert.equal(fs.existsSync(legacyFile), true);
      assert.equal(fs.existsSync(path.join(root, 'memory')), false);
      assert.equal(fs.existsSync(path.join(root, 'backups', 'memory-layout', '20260717-120000')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('merges legacy user files into one v3 document and archives the old source', async () => {
    const module = await loadMigrationModule();
    assert.ok(module, 'memory migration module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-migration-apply-'));
    writeLegacyUserMemory(root, 'language.md', '回复语言', '中文');
    writeLegacyUserMemory(root, 'project.md', '默认项目', 'ST4');

    try {
      const report = module.migrateMemoryLayout(root, { apply: true, now: '2026-07-17T12:00:00.000Z' });
      const impressionPath = path.join(root, 'memory', 'users', 'feishu', 'ou_user_1', '用户印象.md');

      assert.equal(report.applied, true);
      assert.equal(report.actions.length, 2);
      assert.equal(fs.existsSync(impressionPath), true);
      const text = fs.readFileSync(impressionPath, 'utf8');
      assert.match(text, /\| 回复语言 \| 中文 \|/);
      assert.match(text, /\| 默认项目 \| ST4 \|/);
      assert.equal(fs.existsSync(path.join(root, 'data', 'memory', 'v2')), false);
      assert.equal(fs.existsSync(path.join(root, 'archive', 'memory-v2-20260717-120000')), true);
      assert.equal(fs.existsSync(path.join(root, 'backups', 'memory-layout', '20260717-120000', 'data', 'memory', 'v2')), true);
      assert.equal(fs.existsSync(path.join(root, '.cti-index', 'knowledge.json')), true);
      assert.equal(fs.existsSync(path.join(root, '记忆总索引.md')), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not overwrite an existing confirmed value without reporting a conflict', async () => {
    const module = await loadMigrationModule();
    assert.ok(module, 'memory migration module should exist');
    const memoryDocuments = await import('../memory-documents.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-migration-conflict-'));
    writeLegacyUserMemory(root, 'legacy.md', '默认项目', 'ST3');
    memoryDocuments.upsertConfirmedMemoryDocument({
      memoryRoot: root,
      scope: 'user',
      channelType: 'feishu',
      userId: 'ou_user_1',
      displayName: '刘丹',
      pairs: [{ key: '默认项目', value: 'ST4' }],
      evidenceText: '当前已确认值',
      createdAt: '2026-07-17T11:00:00.000Z',
    });

    try {
      const report = module.migrateMemoryLayout(root, { apply: true, now: '2026-07-17T12:00:00.000Z' });
      const text = fs.readFileSync(path.join(root, 'memory', 'users', 'feishu', 'ou_user_1', '用户印象.md'), 'utf8');

      assert.equal(report.conflicts.length, 1);
      assert.match(text, /\| 默认项目 \| ST4 \|/);
      assert.doesNotMatch(text, /\| 默认项目 \| ST3 \|/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
