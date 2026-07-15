import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPromptSnapshotStore } from '../prompt-snapshot-store.js';

function snapshot(id: string, createdAt: string) {
  return {
    protocol: 'cti-prompt-snapshot/v1' as const,
    sessionId: id,
    createdAt,
    totalChars: 1,
    sections: [],
  };
}

describe('PromptSnapshotStore', () => {
  it('prunes snapshots by age and count', () => {
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-prompt-store-'));
    try {
      const store = createPromptSnapshotStore({
        ctiHome,
        maxItems: 2,
        maxAgeDays: 2,
        now: () => new Date('2026-07-15T06:00:00.000Z'),
      });
      store.record(snapshot('old', '2026-07-10T06:00:00.000Z'));
      store.record(snapshot('keep-1', '2026-07-14T06:00:00.000Z'));
      store.record(snapshot('keep-2', '2026-07-15T05:00:00.000Z'));
      store.record(snapshot('keep-3', '2026-07-15T05:30:00.000Z'));

      const state = store.read();
      assert.deepEqual(state.snapshots.map((item) => item.sessionId), ['keep-2', 'keep-3']);
      assert.equal(state.policy.maxItems, 2);
      assert.equal(state.policy.maxAgeDays, 2);
    } finally {
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });

  it('recovers from a corrupt primary file using the backup', () => {
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-prompt-store-'));
    try {
      const store = createPromptSnapshotStore({ ctiHome, now: () => new Date('2026-07-15T06:00:00.000Z') });
      store.record(snapshot('first', '2026-07-15T05:00:00.000Z'));
      store.record(snapshot('second', '2026-07-15T05:30:00.000Z'));
      fs.writeFileSync(store.filePath, '{broken', 'utf8');

      assert.equal(store.read().snapshots.some((item) => item.sessionId === 'first'), true);
    } finally {
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });
});
