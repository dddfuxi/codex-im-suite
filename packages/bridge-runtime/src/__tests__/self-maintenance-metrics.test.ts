import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

async function loadModule() {
  try {
    return await import('../self-maintenance-metrics.js');
  } catch {
    return null;
  }
}

describe('自维护运行指标', () => {
  it('聚合 classifier 结果、耗时和并发冲突原因', async () => {
    const module = await loadModule();
    assert.ok(module, 'self-maintenance-metrics module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-self-maintenance-metrics-'));

    try {
      module.recordSelfMaintenanceMetric(root, {
        phase: 'correction',
        outcome: 'applied',
        durationMs: 120,
        reason: '规则已更新。',
        timestamp: '2026-07-18T10:00:00.000Z',
      });
      module.recordSelfMaintenanceMetric(root, {
        phase: 'outcome',
        outcome: 'rejected',
        durationMs: 80,
        reason: '核心文档 baseHash 已过期，拒绝覆盖并发更新',
        timestamp: '2026-07-18T10:01:00.000Z',
      });
      module.recordSelfMaintenanceMetric(root, {
        phase: 'outcome',
        outcome: 'rejected',
        durationMs: 100,
        reason: '自维护写锁正被其他回合占用',
        timestamp: '2026-07-18T10:02:00.000Z',
      });

      const metrics = module.readSelfMaintenanceMetrics(root);
      assert.equal(metrics.totalCalls, 3);
      assert.equal(metrics.applied, 1);
      assert.equal(metrics.rejected, 2);
      assert.equal(metrics.byPhase.correction.calls, 1);
      assert.equal(metrics.byPhase.outcome.calls, 2);
      assert.equal(metrics.hashConflicts, 1);
      assert.equal(metrics.lockConflicts, 1);
      assert.equal(metrics.averageDurationMs, 100);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
