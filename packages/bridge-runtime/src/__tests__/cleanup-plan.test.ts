import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  applyWorkspaceCleanupPlan,
  buildWorkspaceCleanupPlan,
  classifyCleanupPath,
  restoreWorkspaceCleanupPlan,
  writeWorkspaceCleanupReports,
} from '../cleanup-plan.js';

describe('workspace cleanup plan', () => {
  it('classifies automatic caches separately from Unity assets and unknown output', () => {
    const ctiHome = path.join(os.tmpdir(), 'cti-home');
    assert.equal(classifyCleanupPath(path.join('C:\\project', '.codepilot-uploads'), ctiHome), 'legacy_upload_cache');
    assert.equal(classifyCleanupPath(path.join(ctiHome, 'runtime', 'uploads', 'session-1'), ctiHome), 'runtime_upload_cache');
    assert.equal(classifyCleanupPath(path.join('C:\\project', 'Assets', 'Screenshots'), ctiHome), 'unity_asset');
    assert.equal(classifyCleanupPath(path.join('C:\\project', 'captures'), ctiHome), 'explicit_artifact');
    assert.equal(classifyCleanupPath(path.join('C:\\project', 'misc'), ctiHome), 'unknown');
  });

  it('creates UTF-8 dry-run reports with hashes without moving the target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-cleanup-plan-'));
    const ctiHome = path.join(root, 'cti-home');
    const target = path.join(root, 'project', '.codepilot-uploads');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '图片.png'), Buffer.from('image-data'));

    try {
      const plan = buildWorkspaceCleanupPlan({
        targets: [target],
        ctiHome,
        now: '2026-07-18T12:34:56.000Z',
      });
      const reports = writeWorkspaceCleanupReports(plan);

      assert.equal(plan.mode, 'dry-run');
      assert.equal(plan.targets[0].classification, 'legacy_upload_cache');
      assert.equal(plan.targets[0].automaticCleanupAllowed, true);
      assert.equal(plan.targets[0].files.length, 1);
      assert.match(plan.targets[0].files[0].sha256, /^[a-f0-9]{64}$/);
      assert.equal(fs.existsSync(target), true);
      assert.match(path.basename(reports.jsonPath), /^工作区污染清理清单-/u);
      assert.match(path.basename(reports.markdownPath), /^工作区污染清理清单-/u);
      assert.match(fs.readFileSync(reports.markdownPath, 'utf8'), /默认仅生成计划，不会永久删除/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('moves an approved cache into quarantine and restores it from the same manifest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-cleanup-apply-'));
    const ctiHome = path.join(root, 'cti-home');
    const target = path.join(root, 'project', '.codepilot-uploads');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.join(target, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(target, 'one.txt'), 'one');
    fs.writeFileSync(path.join(target, 'nested', 'two.txt'), 'two', { flag: 'w' });

    try {
      const plan = buildWorkspaceCleanupPlan({
        targets: [target],
        ctiHome,
        now: '2026-07-18T12:34:56.000Z',
      });
      const applied = applyWorkspaceCleanupPlan(plan, { assertProcessesStopped: () => undefined });

      assert.equal(applied.mode, 'applied');
      assert.equal(fs.existsSync(target), false);
      assert.equal(fs.existsSync(applied.targets[0].backupPath), true);
      assert.equal(fs.readFileSync(path.join(applied.targets[0].backupPath, 'nested', 'two.txt'), 'utf8'), 'two');

      const restored = restoreWorkspaceCleanupPlan(applied, { assertProcessesStopped: () => undefined });
      assert.equal(restored.mode, 'restored');
      assert.equal(fs.existsSync(target), true);
      assert.equal(fs.existsSync(applied.targets[0].backupPath), false);
      assert.equal(fs.readFileSync(path.join(target, 'one.txt'), 'utf8'), 'one');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses automatic apply for Unity assets and unknown directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-cleanup-refuse-'));
    const ctiHome = path.join(root, 'cti-home');
    const unityAssets = path.join(root, 'project', 'Assets', 'Screenshots');
    fs.mkdirSync(unityAssets, { recursive: true });
    fs.writeFileSync(path.join(unityAssets, 'shot.png'), 'shot');

    try {
      const plan = buildWorkspaceCleanupPlan({ targets: [unityAssets], ctiHome });
      assert.throws(
        () => applyWorkspaceCleanupPlan(plan, { assertProcessesStopped: () => undefined }),
        /不允许自动清理/u,
      );
      assert.equal(fs.existsSync(unityAssets), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
