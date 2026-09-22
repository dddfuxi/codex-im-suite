import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

async function loadRetention() {
  try {
    return await import('../artifacts/artifact-retention.js');
  } catch {
    return null;
  }
}

describe('artifact retention', () => {
  it('removes only expired inactive turn directories', async () => {
    const module = await loadRetention();
    assert.ok(module, 'artifact retention should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-artifact-retention-'));
    const expired = path.join(root, 'old-session', 'old-turn');
    const active = path.join(root, 'active-session', 'active-turn');
    fs.mkdirSync(expired, { recursive: true });
    fs.mkdirSync(active, { recursive: true });
    fs.writeFileSync(path.join(expired, 'a.txt'), 'old');
    fs.writeFileSync(path.join(active, 'a.txt'), 'active');
    const old = new Date('2026-07-01T00:00:00.000Z');
    fs.utimesSync(expired, old, old);
    fs.utimesSync(active, old, old);

    try {
      const result = module.pruneExpiredArtifactTurns({
        artifactRoot: root,
        now: new Date('2026-07-20T00:00:00.000Z'),
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
        activeScopes: [{ sessionId: 'active-session', turnId: 'active-turn' }],
      });
      assert.deepEqual(result.removed, [expired]);
      assert.equal(fs.existsSync(expired), false);
      assert.equal(fs.existsSync(active), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
