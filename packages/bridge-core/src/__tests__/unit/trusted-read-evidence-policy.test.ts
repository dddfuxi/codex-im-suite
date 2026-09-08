import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { requiresResponseOnlyForTrustedLocalReadEvidence } from '../../lib/bridge/application/trusted-read-evidence-policy.js';

describe('trusted local read evidence boundary', () => {
  it('locks a successful local read snapshot to response-only mode', () => {
    assert.equal(requiresResponseOnlyForTrustedLocalReadEvidence([
      { available: true, readOnly: true },
    ]), true);
  });

  it('does not lock unavailable evidence or a write-capable request', () => {
    assert.equal(requiresResponseOnlyForTrustedLocalReadEvidence([
      { available: false, readOnly: true },
      { available: true, readOnly: false },
    ]), false);
  });
});
