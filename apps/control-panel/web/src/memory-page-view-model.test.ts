import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildAgentHomeEntries,
  buildMemoryLayoutSummary,
  buildMemoryQueryRefreshKey,
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
});
