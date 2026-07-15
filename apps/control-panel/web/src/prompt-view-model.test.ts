import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPromptSectionRows, type PromptSnapshotRecord } from './prompt-view-model.js';

describe('prompt snapshot view model', () => {
  it('orders prompt sections and exposes truncation risk', () => {
    const snapshot: PromptSnapshotRecord = {
      protocol: 'cti-prompt-snapshot/v1',
      sessionId: 'session-1',
      createdAt: '2026-07-15T00:00:00.000Z',
      totalChars: 120,
      sections: [
        section('memory', 40, { truncated: true, truncationReason: 'section_limit' }),
        section('protocol', 70),
        section('identity', 10),
        section('style', 60),
        section('skills', 30),
        section('policy', 20),
      ],
    };

    const rows = buildPromptSectionRows(snapshot);

    assert.deepEqual(rows.map((row) => row.kind), ['identity', 'policy', 'skills', 'memory', 'style', 'protocol']);
    assert.equal(rows.find((row) => row.kind === 'memory')?.warning, '已截断');
    assert.equal(rows[0].shortHash, 'aaaaaaaaaaaa');
  });

  it('marks redacted and skipped sections without exposing raw policy guesses', () => {
    const snapshot: PromptSnapshotRecord = {
      protocol: 'cti-prompt-snapshot/v1',
      sessionId: 'session-2',
      createdAt: '2026-07-15T01:00:00.000Z',
      totalChars: 20,
      sections: [
        section('policy', 20, { truncationReason: 'redacted' }),
        section('memory', 30, { injected: false }),
      ],
    };

    const rows = buildPromptSectionRows(snapshot);

    assert.equal(rows[0].warning, '已脱敏');
    assert.equal(rows[1].warning, '未注入');
  });
});

function section(
  kind: PromptSnapshotRecord['sections'][number]['kind'],
  priority: number,
  overrides: Partial<PromptSnapshotRecord['sections'][number]> = {},
): PromptSnapshotRecord['sections'][number] {
  return {
    id: `${kind}-${priority}`,
    kind,
    source: `bridge.${kind}`,
    priority,
    charCount: 20,
    hash: 'a'.repeat(64),
    injected: true,
    truncated: false,
    content: `${kind} content`,
    ...overrides,
  };
}
