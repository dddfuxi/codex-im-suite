import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildKnowledgeIndexFromMarkdown,
  searchKnowledgeIndex,
} from '../knowledge-indexer.js';

describe('knowledge indexer', () => {
  it('extracts facts and resources from markdown tables with source snippets', () => {
    const index = buildKnowledgeIndexFromMarkdown({
      memoryRoot: 'E:\\cli-md',
      files: [
        {
          path: 'E:\\cli-md\\CodexNotes.md',
          updatedAt: '2026-04-23T10:00:00.000Z',
          content: [
            '# Codex Notes',
            '',
            '## Scene Common Names',
            '',
            '| Scene identifier | Common name |',
            '| --- | --- |',
            '| `HSScene` | 医院内部场景 |',
            '| `city3d_citystage_ST2H_Scene` | 外城场景 |',
          ].join('\n'),
        },
      ],
    });

    assert.equal(index.schema, 'codex-im-suite/knowledge-index/v1');
    assert.equal(index.items.length, 2);
    assert.equal(index.items[0].kind, 'resource');
    assert.equal(index.items[0].key, 'HSScene');
    assert.equal(index.items[0].value, '医院内部场景');
    assert.match(index.items[0].source.snippet, /HSScene/);
  });

  it('searches by keyword and type without requiring direct reply routing', () => {
    const index = buildKnowledgeIndexFromMarkdown({
      memoryRoot: 'E:\\cli-md',
      files: [{
        path: 'E:\\cli-md\\notes.md',
        updatedAt: '2026-04-23T10:00:00.000Z',
        content: '- 结论：记忆命中默认只注入 Codex，不直接回复。',
      }],
    });

    const hits = searchKnowledgeIndex(index, { query: '直接回复', kinds: ['conclusion'] });
    assert.equal(hits.length, 1);
    assert.match(hits[0].text, /只注入 Codex/);
  });
});
