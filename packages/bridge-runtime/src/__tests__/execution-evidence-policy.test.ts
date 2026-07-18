import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeRuntimeExecutionEvidenceSatisfied } from '../execution-evidence-policy.js';

describe('runtime execution evidence policy', () => {
  it('does not mark Bash as satisfying a Unity MCP requirement', () => {
    assert.equal(computeRuntimeExecutionEvidenceSatisfied({
      requirement: {
        kind: 'tool_required',
        reason: 'current Unity state requires Unity MCP',
        requiredToolFamilies: ['unity-mcp'],
        strictToolEvidence: true,
      },
      successfulToolResultCount: 4,
      toolNames: ['Bash'],
    }), false);
  });

  it('accepts a matching Unity MCP tool result', () => {
    assert.equal(computeRuntimeExecutionEvidenceSatisfied({
      requirement: {
        kind: 'tool_required',
        reason: 'current Unity state requires Unity MCP',
        requiredToolFamilies: ['unity-mcp'],
        strictToolEvidence: true,
      },
      successfulToolResultCount: 1,
      toolNames: ['manage_scene'],
    }), true);
  });
});
