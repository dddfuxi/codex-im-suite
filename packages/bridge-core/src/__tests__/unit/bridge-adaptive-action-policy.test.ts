import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decideAdaptiveActionPolicy,
  normalizeAdaptiveSafetyProfile,
} from '../../lib/bridge/adaptive-action-policy.js';

describe('adaptive action policy', () => {
  it('defaults unknown profiles to balanced', () => {
    assert.equal(normalizeAdaptiveSafetyProfile(undefined), 'balanced');
    assert.equal(normalizeAdaptiveSafetyProfile('unknown'), 'balanced');
    assert.equal(normalizeAdaptiveSafetyProfile('FLUENT'), 'fluent');
  });

  it('allows verified low-risk actions without confirmation', () => {
    assert.deepEqual(decideAdaptiveActionPolicy({
      profile: 'strict', risk: 'low', evidence: 'reliable', verification: 'verified',
    }), { decision: 'allow', reasonCode: 'verified_low_risk' });
  });

  it('lets balanced mode degrade only with strong evidence', () => {
    assert.equal(decideAdaptiveActionPolicy({
      profile: 'balanced', risk: 'low', evidence: 'strong', verification: 'failed',
    }).decision, 'allow_with_audit');
    assert.equal(decideAdaptiveActionPolicy({
      profile: 'balanced', risk: 'low', evidence: 'reliable', verification: 'failed',
    }).decision, 'clarify');
  });

  it('lets fluent mode degrade with reliable low-risk evidence', () => {
    assert.equal(decideAdaptiveActionPolicy({
      profile: 'fluent', risk: 'low', evidence: 'reliable', verification: 'unavailable',
    }).decision, 'allow_with_audit');
  });

  it('never lets a profile bypass conflicts, ambiguity or high-risk confirmation', () => {
    assert.equal(decideAdaptiveActionPolicy({
      profile: 'fluent', risk: 'low', evidence: 'strong', verification: 'conflict',
    }).decision, 'deny');
    assert.equal(decideAdaptiveActionPolicy({
      profile: 'fluent', risk: 'low', evidence: 'strong', verification: 'verified', ambiguous: true,
    }).decision, 'clarify');
    assert.equal(decideAdaptiveActionPolicy({
      profile: 'fluent', risk: 'high', evidence: 'strong', verification: 'verified',
    }).decision, 'confirm');
  });
});
