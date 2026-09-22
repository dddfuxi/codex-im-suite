import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inferNestedMcpToolEvidenceNames } from 'claude-to-im/evidence';

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

  it('accepts a verified nested MCP action without treating ordinary Bash as Unity', () => {
    const nestedNames = inferNestedMcpToolEvidenceNames({
      outerToolName: 'Bash',
      toolInput: {
        command: "Invoke-RestMethod http://localhost:8081/mcp -Method Post -Body '{\"method\":\"tools/call\",\"params\":{\"name\":\"batch_execute\"}}'",
      },
      toolResultContent: 'BATCH 0-24 success=True SAVE=True Scene saved successfully.',
    });
    assert.deepEqual(nestedNames, ['nested-mcp:jsonrpc', 'nested-mcp:batch_execute']);
    assert.equal(computeRuntimeExecutionEvidenceSatisfied({
      requirement: {
        kind: 'tool_required',
        reason: 'current Unity state requires Unity MCP',
        requiredToolFamilies: ['unity-mcp'],
        strictToolEvidence: true,
      },
      successfulToolResultCount: 1,
      toolNames: ['Bash', ...nestedNames],
    }), true);
  });
});
