import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideWorkflowReplaySafety } from '../workflow-replay-safety.js';

describe('workflow replay safety', () => {
  it('allows turns without tools', () => {
    assert.equal(decideWorkflowReplaySafety({ tools: [] }).replaySafety, 'safe_no_tools');
  });

  it('allows explicit read-only tools and read-only shell commands', () => {
    assert.equal(decideWorkflowReplaySafety({
      tools: [
        { name: 'list_mcp_resources', input: {} },
        { name: 'shell_command', input: { command: 'git status --short' } },
      ],
    }).replaySafety, 'safe_read_only');
  });

  it('blocks mutating tools', () => {
    assert.equal(decideWorkflowReplaySafety({
      tools: [{ name: 'apply_patch', input: { patch: '...' } }],
    }).replaySafety, 'unsafe_side_effects');
  });

  it('blocks unknown tools by default', () => {
    assert.equal(decideWorkflowReplaySafety({
      tools: [{ name: 'third_party_magic', input: {} }],
    }).replaySafety, 'unsafe_unknown');
  });

  it('uses a read-only executor manifest as a trusted upper bound', () => {
    assert.equal(decideWorkflowReplaySafety({
      executorRiskLevel: 'read_only',
      tools: [{ name: 'third_party_query', input: {} }],
    }).replaySafety, 'safe_read_only');
  });
});
