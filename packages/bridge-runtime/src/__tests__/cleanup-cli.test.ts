import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

import { assertCleanupProcessesStopped, runWorkspaceCleanupCli } from '../cleanup-cli.js';
import { buildWorkspaceCleanupPlan, writeWorkspaceCleanupReports } from '../cleanup-plan.js';

it('blocks Apply while the live Bridge PID is active but ignores a stale PID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-cleanup-cli-'));
  const statusPath = path.join(root, 'runtime', 'status.json');
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify({ running: true, pid: 12345 }), 'utf8');

  try {
    assert.throws(
      () => assertCleanupProcessesStopped({ ctiHome: root, isProcessAlive: () => true }),
      /Bridge 仍在运行/u,
    );
    assert.doesNotThrow(
      () => assertCleanupProcessesStopped({ ctiHome: root, isProcessAlive: () => false }),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('applies the exact reviewed dry-run manifest instead of rebuilding a new plan', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-cleanup-cli-manifest-'));
  const ctiHome = path.join(root, 'cti-home');
  const target = path.join(root, 'project', '.codepilot-uploads');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'one.txt'), 'one');

  try {
    const plan = buildWorkspaceCleanupPlan({ targets: [target], ctiHome, now: '2026-07-18T12:34:56.000Z' });
    const reports = writeWorkspaceCleanupReports(plan);
    const applied = runWorkspaceCleanupCli(['--apply-manifest', reports.jsonPath, '--cti-home', ctiHome]);
    assert.equal(applied.mode, 'applied');
    assert.equal(applied.reportJsonPath, reports.jsonPath);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(applied.targets[0].backupPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
