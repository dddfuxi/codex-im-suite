import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildAgentHomeEntries,
  buildMemoryLayoutSummary,
  buildMemoryQueryRefreshKey,
  buildSelfMaintenanceMetrics,
  buildWorkspacePathSections,
  runPanelRefresh,
} from './memory-page-view-model.js';

describe('memory page refresh view model', () => {
  it('invalidates the current memory query when the global refresh revision changes', () => {
    const before = buildMemoryQueryRefreshKey('all', 'all', 3);
    const after = buildMemoryQueryRefreshKey('all', 'all', 4);

    assert.notEqual(before, after);
  });

  it('invalidates the memory query when a filter changes', () => {
    assert.notEqual(
      buildMemoryQueryRefreshKey('all', 'all', 4),
      buildMemoryQueryRefreshKey('fact', 'all', 4),
    );
  });

  it('refreshes global state before invalidating page-local data', async () => {
    const calls: string[] = [];

    await runPanelRefresh({
      refreshState: async () => { calls.push('state'); },
      refreshRuntimeUnits: async () => { calls.push('runtime'); },
      invalidatePageData: () => { calls.push('page'); },
    });

    assert.deepEqual(calls, ['state', 'runtime', 'page']);
  });

  it('keeps legacy additional directories in read-only diagnostics', () => {
    const sections = buildWorkspacePathSections({
      defaultWorkDir: 'F:\\unity\\ST4',
      allowedRoots: 'F:\\unity\\ST4;C:\\unity\\ST3',
      memoryRepo: 'E:\\cli-md',
      additionalDirs: 'F:\\legacy',
    });

    assert.deepEqual(sections.editable.map((item) => item.key), ['defaultWorkDir', 'allowedRoots', 'memoryRepo']);
    assert.equal(sections.diagnostics[0].editable, false);
    assert.match(sections.diagnostics[0].note, /不再自动挂载/u);
  });

  it('provides the five visible Agent Home entries from the memory root', () => {
    const entries = buildAgentHomeEntries('E:\\cli-md');

    assert.deepEqual(entries.map((item) => item.name), [
      '机器人身份.md',
      '行为与安全规则.md',
      '工具与环境.md',
      '记忆总索引.md',
      '记忆库说明.md',
    ]);
    assert.equal(entries[3].path, 'E:\\cli-md\\记忆总索引.md');
  });

  it('keeps unclassified root markdown visible as a warning instead of hiding or moving it', () => {
    const summary = buildMemoryLayoutSummary({
      layoutVersion: 'v3',
      migrationState: 'v3_only',
      v3SourceCount: 2,
      legacySourceCount: 0,
      unclassifiedRootDocuments: [
        { name: 'CodexNotes.md', path: 'E:\\cli-md\\CodexNotes.md' },
      ],
    });

    assert.equal(summary.migrationLabel, '已使用 v3 可见布局');
    assert.equal(summary.unclassifiedCount, 1);
    assert.deepEqual(summary.unclassifiedRootDocuments, [
      { name: 'CodexNotes.md', path: 'E:\\cli-md\\CodexNotes.md' },
    ]);
  });

  it('exposes self-maintenance archives, backups, and the last update time as observable metrics', () => {
    const metrics = buildSelfMaintenanceMetrics({
      dailyReflectionCount: 2,
      workProfileCount: 3,
      correctionDocumentCount: 4,
      versionBackupCount: 5,
      classifierCalls: 12,
      classifierSkips: 8,
      classifierRejected: 2,
      averageDurationMs: 95,
      lockConflicts: 1,
      hashConflicts: 1,
      trialRuleCount: 2,
      confirmedRuleCount: 3,
      regressedRuleCount: 1,
      lastUpdatedAt: '2026-07-18T08:00:00.000Z',
      statusPath: 'E:\\cli-md\\.cti-self-history\\status.json',
    });

    assert.deepEqual(metrics.map((item) => [item.label, item.value]), [
      ['工作档案', '3'],
      ['每日反思', '2'],
      ['纠错档案', '4'],
      ['可回滚版本', '5'],
      ['分类器调用', '12 / 跳过 8'],
      ['平均耗时', '95 ms'],
      ['规则状态', '试用 2 / 已确认 3 / 回归 1'],
      ['并发冲突', '锁 1 / 哈希 1'],
    ]);
    assert.equal(metrics[0].updatedAt, '2026-07-18T08:00:00.000Z');
  });
});
