import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getWorkerRestartBackoffMs, isWorkerHeartbeatExpired } from '../agent-workers/supervisor.js';

describe('agent worker supervisor policy', () => {
  it('uses 1/5/30 second restart backoff', () => {
    assert.deepEqual([1, 2, 3, 4].map(getWorkerRestartBackoffMs), [1000, 5000, 30000, 30000]);
  });

  it('marks a worker lost after 30 seconds without heartbeat', () => {
    const now = Date.parse('2026-07-24T00:00:40.000Z');
    assert.equal(isWorkerHeartbeatExpired('2026-07-24T00:00:15.000Z', now), false);
    assert.equal(isWorkerHeartbeatExpired('2026-07-24T00:00:09.000Z', now), true);
    assert.equal(isWorkerHeartbeatExpired(undefined, now), true);
  });
});
