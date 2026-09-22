import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideCollaborationEligibility } from '../../lib/bridge/agent-collaboration-policy.js';
import type { TurnFocusDecision } from '../../lib/bridge/turn-context.js';

function focus(overrides: Partial<TurnFocusDecision> = {}): TurnFocusDecision {
  return {
    protocol: 'cti-turn-focus/v1',
    mode: 'deterministic',
    focus: 'current_request',
    primaryEvidenceIds: ['current-message'],
    supportingEvidenceIds: [],
    conflictingEvidenceIds: [],
    confidence: 1,
    requiresAgentResolution: false,
    reason: 'test',
    ...overrides,
  };
}

describe('CollaborationEligibilityPolicy', () => {
  it('keeps simple chat on the zero-worker path', () => {
    assert.equal(decideCollaborationEligibility({
      mode: 'assist',
      text: '今天天气怎么样？',
      evidenceCount: 1,
      focus: focus(),
    }).eligible, false);
  });

  it('triggers on conflicting context evidence', () => {
    const decision = decideCollaborationEligibility({
      mode: 'shadow',
      text: '继续处理这个',
      evidenceCount: 3,
      focus: focus({ focus: 'ambiguous', confidence: 0.4, requiresAgentResolution: true }),
    });
    assert.equal(decision.eligible, true);
  });

  it('triggers on a multi-step architecture request', () => {
    const decision = decideCollaborationEligibility({
      mode: 'assist',
      text: '先判断当前架构的上下文和记忆边界，然后比较两个方案，并且给出性能风险与回退策略。',
      evidenceCount: 1,
      focus: focus(),
    });
    assert.equal(decision.eligible, true);
  });

  it('always skips when mode is off', () => {
    assert.equal(decideCollaborationEligibility({
      mode: 'off',
      text: '先分析再规划一个复杂工作流',
      evidenceCount: 10,
      focus: focus({ focus: 'ambiguous' }),
    }).eligible, false);
  });
});
