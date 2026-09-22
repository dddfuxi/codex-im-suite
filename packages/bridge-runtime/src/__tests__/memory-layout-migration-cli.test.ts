import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

async function loadCliModule() {
  try {
    return await import('../memory-layout-migration-cli.js');
  } catch {
    return null;
  }
}

describe('memory layout migration cli', () => {
  it('uses dry-run unless --apply is explicitly provided', async () => {
    const module = await loadCliModule();
    assert.ok(module, 'memory migration cli module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-cli-dry-'));
    try {
      const report = module.runMemoryLayoutMigrationCli(['--memory-root', root, '--now', '2026-07-17T12:00:00.000Z']);
      assert.equal(report.applied, false);
      assert.equal(report.memoryRoot, root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses apply while the memory watcher is still active', async () => {
    const module = await loadCliModule();
    assert.ok(module, 'memory migration cli module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-cli-running-'));
    const indexDir = path.join(root, '.cti-index');
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(path.join(indexDir, 'status.json'), JSON.stringify({
      schema: 'codex-im-suite/knowledge-index-status/v1',
      memoryRoot: root,
      indexPath: path.join(indexDir, 'knowledge.json'),
      watching: true,
      exists: false,
      markdownFileCount: 0,
      itemCount: 0,
      conflictCount: 0,
      watcherPid: process.pid,
      statusUpdatedAt: new Date().toISOString(),
    }), 'utf8');

    try {
      assert.throws(
        () => module.runMemoryLayoutMigrationCli(['--memory-root', root, '--apply']),
        /仍在运行/u,
      );
      assert.equal(fs.existsSync(path.join(root, 'backups', 'memory-layout')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows apply after the watcher process exited even if the last status still says watching', async () => {
    const module = await loadCliModule();
    assert.ok(module, 'memory migration cli module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-cli-stopped-'));
    const indexDir = path.join(root, '.cti-index');
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(path.join(indexDir, 'status.json'), JSON.stringify({
      schema: 'codex-im-suite/knowledge-index-status/v1',
      memoryRoot: root,
      indexPath: path.join(indexDir, 'knowledge.json'),
      watching: true,
      exists: false,
      markdownFileCount: 0,
      itemCount: 0,
      conflictCount: 0,
      watcherPid: 2147483000,
      statusUpdatedAt: new Date().toISOString(),
    }), 'utf8');

    try {
      const report = module.runMemoryLayoutMigrationCli([
        '--memory-root', root,
        '--apply',
        '--now', '2026-07-17T12:00:00.000Z',
      ]);
      assert.equal(report.applied, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes the structured report as UTF-8 JSON when --report is provided', async () => {
    const module = await loadCliModule();
    assert.ok(module, 'memory migration cli module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-cli-report-'));
    const reportPath = path.join(root, 'reports', '记忆迁移预览.json');
    try {
      module.runMemoryLayoutMigrationCli([
        '--memory-root', root,
        '--report', reportPath,
        '--now', '2026-07-17T12:00:00.000Z',
      ]);
      const text = fs.readFileSync(reportPath, 'utf8');
      assert.match(text, /memory-layout-migration\/v1/u);
      assert.equal(JSON.parse(text).applied, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
