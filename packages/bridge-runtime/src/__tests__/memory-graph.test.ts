import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildKnowledgeIndexFromMarkdown } from '../knowledge-indexer.js';
import {
  buildMemoryGraphFromKnowledgeIndex,
  searchMemoryGraph,
} from '../memory-graph.js';

describe('memory graph', () => {
  it('builds forward and reverse links from structured knowledge', () => {
    const index = buildKnowledgeIndexFromMarkdown({
      memoryRoot: 'E:\\cli-md',
      files: [{
        path: 'E:\\cli-md\\data\\explicit-memories\\dragon.md',
        updatedAt: '2026-05-12T00:00:00.000Z',
        content: [
          '# ST横板雷霆龙商城展示界面',
          '',
          'ST横板 也叫 ST。',
          '',
          '| key | value |',
          '| --- | --- |',
          '| 第十三条龙 | 雷霆龙 |',
          '| 雷霆龙商城展示界面Unity预制体 | PreviewDragon_Thunde |',
          '| ST龙相关展示场景路径 | Assets/__ArtData/_Resources/Prefab/City3D/UIScene |',
        ].join('\n'),
      }],
    });

    const graph = buildMemoryGraphFromKnowledgeIndex(index);
    const forward = searchMemoryGraph(graph, '第十三条龙', { limit: 8 });
    const reverse = searchMemoryGraph(graph, '雷霆龙', { limit: 8 });

    assert.equal(graph.schema, 'codex-im-suite/memory-graph/v1');
    assert.ok(forward.related.some((item) => item.label === '雷霆龙'));
    assert.ok(reverse.related.some((item) => item.label === '第十三条龙'));
    assert.ok(reverse.related.some((item) => item.label === 'PreviewDragon_Thunde'));
    assert.ok(reverse.related.some((item) => item.label.includes('UIScene')));
  });
});
