import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createCodexExecutionProfile,
  type CodexExecutionProfileInput,
} from '../codex-execution-profile.js';

const base: CodexExecutionProfileInput = {
  providerProfile: 'official',
  configuredModelSource: 'official',
  configuredModel: 'gpt-5.4',
  configuredReasoningEffort: 'xhigh',
};

describe('codex execution profile', () => {
  it('submits an explicit model for official Codex', () => {
    const profile = createCodexExecutionProfile(base);

    assert.equal(profile.modelSource, 'official');
    assert.equal(profile.modelMode, 'explicit');
    assert.equal(profile.requestedModel, 'gpt-5.4');
    assert.equal(profile.submittedModel, 'gpt-5.4');
    assert.equal(profile.submittedReasoningEffort, 'xhigh');
  });

  it('leaves model unset when source default is requested', () => {
    const profile = createCodexExecutionProfile({ ...base, configuredModel: '  ' });

    assert.equal(profile.modelMode, 'source_default');
    assert.equal(profile.submittedModel, undefined);
  });

  it('records restricted reasoning override without losing requested value', () => {
    const profile = createCodexExecutionProfile({ ...base, restrictedInteraction: true });

    assert.equal(profile.requestedReasoningEffort, 'xhigh');
    assert.equal(profile.submittedReasoningEffort, 'low');
    assert.equal(profile.overrideReason, 'restricted_interaction');
  });

  it('changes fingerprint when model or reasoning changes', () => {
    const original = createCodexExecutionProfile(base);
    const modelChanged = createCodexExecutionProfile({ ...base, configuredModel: 'gpt-5.5' });
    const effortChanged = createCodexExecutionProfile({ ...base, configuredReasoningEffort: 'high' });

    assert.notEqual(original.fingerprint, modelChanged.fingerprint);
    assert.notEqual(original.fingerprint, effortChanged.fingerprint);
  });

  it('does not expose query parameters in the endpoint fingerprint input', () => {
    const first = createCodexExecutionProfile({
      ...base,
      providerProfile: 'external',
      configuredModelSource: 'external_api',
      baseUrl: 'https://example.test/v1?token=secret-a',
    });
    const second = createCodexExecutionProfile({
      ...base,
      providerProfile: 'external',
      configuredModelSource: 'external_api',
      baseUrl: 'https://example.test/v1?token=secret-b',
    });

    assert.equal(first.fingerprint, second.fingerprint);
  });
});
