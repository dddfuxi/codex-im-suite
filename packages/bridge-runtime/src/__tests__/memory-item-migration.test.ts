import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { readKnowledgeIndex } from '../knowledge-indexer.js';
import {
  applyMemoryCandidateMigrationPlan,
  buildMemoryCandidateMigrationPlan,
} from '../memory-items/migration.js';
import { readManagedMemoryDocument } from '../memory-items/managed-document.js';
import { writeManagedMemoryDocument } from '../memory-items/managed-document.js';

function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeLegacyCandidate(filePath: string): void {
  const state = {
    version: 1,
    confirmed: {},
    tentative: {
      '暂定-legacy': {
        value: '我偏好直接给出可执行结果',
        updatedAt: '2026-07-17T12:00:00.000Z',
        confidence: 0.71,
      },
    },
    evidence: [],
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    '---',
    'schema: codex-im-suite/memory/v3',
    'memoryScope: user',
    'channelType: "feishu"',
    'userId: "ou_user_a"',
    'displayName: "刘丹"',
    'updatedAt: 2026-07-17T12:00:00.000Z',
    '---',
    '',
    `<!-- cti-memory-state:${Buffer.from(JSON.stringify(state), 'utf8').toString('base64')} -->`,
    '',
    '## 暂定印象',
    '',
    '| key | value | 置信度 | 更新时间 |',
    '| --- | --- | --- | --- |',
    '| 暂定-legacy | 我偏好直接给出可执行结果 | 71% | 2026-07-17T12:00:00.000Z |',
    '',
  ].join('\n'), 'utf8');
}

describe('memory candidate migration', () => {
  it('previews legacy tentative migration without changing files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-candidate-preview-'));
    const sourcePath = path.join(root, 'memory', 'users', 'feishu', 'ou_user_a', '用户印象.md');

    try {
      writeLegacyCandidate(sourcePath);
      const originalHash = hashFile(sourcePath);
      const plan = buildMemoryCandidateMigrationPlan({ memoryRoot: root, now: '2026-07-20T12:00:00.000Z' });

      assert.equal(plan.operations.length, 1);
      assert.equal(plan.operations[0].candidateCount, 1);
      assert.equal(plan.operations[0].action, 'upgrade');
      assert.equal(hashFile(sourcePath), originalHash);
      assert.equal(fs.existsSync(path.join(root, '记忆总索引.md')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies reviewed hashes, refreshes human documents and stays idempotent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-candidate-apply-'));
    const sourcePath = path.join(root, 'memory', 'users', 'feishu', 'ou_user_a', '用户印象.md');

    try {
      writeLegacyCandidate(sourcePath);
      const plan = buildMemoryCandidateMigrationPlan({ memoryRoot: root, now: '2026-07-20T12:00:00.000Z' });
      const first = applyMemoryCandidateMigrationPlan(plan, { assertProcessesStopped: () => undefined });
      const second = applyMemoryCandidateMigrationPlan(plan, { assertProcessesStopped: () => undefined });

      assert.equal(first.migratedCandidates, 1);
      assert.equal(second.migratedCandidates, 0);
      assert.equal(readManagedMemoryDocument(sourcePath).state.version, 2);
      assert.match(fs.readFileSync(sourcePath, 'utf8'), /## 候选记忆（不参与索引）/u);
      assert.equal(readKnowledgeIndex(root)?.items.some((item) => item.key?.startsWith('暂定-')), false);
      assert.match(fs.readFileSync(path.join(root, '记忆总索引.md'), 'utf8'), /候选 1/u);
      assert.match(fs.readFileSync(path.join(root, '记忆库说明.md'), 'utf8'), /候选：1/u);
      assert.equal(fs.existsSync(first.backupRoot), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects apply when a reviewed source hash changed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-candidate-stale-'));
    const sourcePath = path.join(root, 'memory', 'users', 'feishu', 'ou_user_a', '用户印象.md');

    try {
      writeLegacyCandidate(sourcePath);
      const plan = buildMemoryCandidateMigrationPlan({ memoryRoot: root });
      fs.appendFileSync(sourcePath, '\n用户修改。\n', 'utf8');

      assert.throws(
        () => applyMemoryCandidateMigrationPlan(plan, { assertProcessesStopped: () => undefined }),
        /source_changed/u,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not treat an unrelated v2 rewrite as an idempotent reviewed apply', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-candidate-unreviewed-v2-'));
    const sourcePath = path.join(root, 'memory', 'users', 'feishu', 'ou_user_a', '用户印象.md');

    try {
      writeLegacyCandidate(sourcePath);
      const plan = buildMemoryCandidateMigrationPlan({ memoryRoot: root });
      const rewritten = readManagedMemoryDocument(sourcePath);
      rewritten.metadata.updatedAt = '2026-07-20T13:00:00.000Z';
      writeManagedMemoryDocument(rewritten, rewritten.baseHash);

      assert.throws(
        () => applyMemoryCandidateMigrationPlan(plan, { assertProcessesStopped: () => undefined }),
        /source_changed/u,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a ledger whose embedded plan does not match its reviewed filename', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-candidate-ledger-'));
    const sourcePath = path.join(root, 'memory', 'users', 'feishu', 'ou_user_a', '用户印象.md');

    try {
      writeLegacyCandidate(sourcePath);
      const plan = buildMemoryCandidateMigrationPlan({ memoryRoot: root });
      applyMemoryCandidateMigrationPlan(plan, { assertProcessesStopped: () => undefined });
      const ledgerDir = path.join(root, '.cti-memory-items', 'migrations');
      const ledgerPath = path.join(ledgerDir, fs.readdirSync(ledgerDir)[0]);
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as { plan: { createdAt: string } };
      ledger.plan.createdAt = '2026-07-20T00:00:00.000Z';
      fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');

      assert.throws(
        () => applyMemoryCandidateMigrationPlan(plan, { assertProcessesStopped: () => undefined }),
        /invalid_migration_ledger/u,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects apply while the live Bridge runtime is still active', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-candidate-running-'));
    const ctiHome = path.join(root, 'cti-home');
    const statusPath = path.join(ctiHome, 'runtime', 'status.json');
    const previousCtiHome = process.env.CTI_HOME;

    try {
      fs.mkdirSync(path.dirname(statusPath), { recursive: true });
      fs.writeFileSync(statusPath, JSON.stringify({ running: true, pid: process.pid }), 'utf8');
      process.env.CTI_HOME = ctiHome;
      const plan = buildMemoryCandidateMigrationPlan({ memoryRoot: root });

      assert.throws(() => applyMemoryCandidateMigrationPlan(plan), /Bridge 仍在运行/u);
    } finally {
      if (previousCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = previousCtiHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
