import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

async function loadModule() {
  try {
    return await import('../self-maintenance-retention.js');
  } catch {
    return null;
  }
}

describe('自维护档案轮转', () => {
  it('把超出活跃窗口的版本、审计和日期档案移动到统一 archive', async () => {
    const module = await loadModule();
    assert.ok(module, 'self-maintenance-retention module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-self-maintenance-retention-'));

    try {
      const versions = path.join(root, '.cti-self-history', 'versions');
      for (const name of ['2026-07-01', '2026-07-02', '2026-07-03']) {
        fs.mkdirSync(path.join(versions, name), { recursive: true });
        fs.writeFileSync(path.join(versions, name, '机器人身份.md'), name, 'utf8');
      }
      const auditPath = path.join(root, '.cti-self-history', '自维护审计.jsonl');
      fs.mkdirSync(path.dirname(auditPath), { recursive: true });
      fs.writeFileSync(auditPath, ['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}'].join('\n') + '\n', 'utf8');
      fs.mkdirSync(path.join(root, 'daily-reflection'), { recursive: true });
      fs.mkdirSync(path.join(root, 'corrections'), { recursive: true });
      fs.writeFileSync(path.join(root, 'daily-reflection', '每日反思-2026-01-01.md'), '# 旧反思', 'utf8');
      fs.writeFileSync(path.join(root, 'corrections', '纠错记录-2026-01-01.md'), '# 旧纠错', 'utf8');

      const result = module.rotateSelfMaintenanceHistory(root, {
        maxActiveVersionDirectories: 2,
        maxActiveAuditLines: 2,
        archiveAfterDays: 90,
        now: new Date('2026-07-18T00:00:00.000Z'),
      });

      assert.equal(result.archivedVersionDirectories, 1);
      assert.equal(result.archivedAuditLines, 2);
      assert.equal(result.archivedDailyReflections, 1);
      assert.equal(result.archivedCorrections, 1);
      assert.equal(fs.readdirSync(versions).length, 2);
      assert.equal(fs.readFileSync(auditPath, 'utf8').trim().split(/\r?\n/u).length, 2);
      assert.equal(fs.existsSync(path.join(root, 'archive', 'self-maintenance', 'versions', '2026-07-01')), true);
      assert.equal(fs.existsSync(path.join(root, 'archive', 'self-maintenance', 'daily-reflection', '每日反思-2026-01-01.md')), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
