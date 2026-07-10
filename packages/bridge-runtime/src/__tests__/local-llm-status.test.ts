import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildLocalProfileHitPatch, makeDefaultLocalLlmStatus } from '../local-llm-status.js';
import type { Config } from '../config.js';

const baseConfig: Config = {
  runtime: 'codex',
  enabledChannels: [],
  defaultWorkDir: process.cwd(),
  defaultMode: 'code',
};

describe('local LLM status counters', () => {
  it('mirrors new local profile hit counter to the legacy localOnlyAnswers field', () => {
    const current = makeDefaultLocalLlmStatus(baseConfig);

    const patch = buildLocalProfileHitPatch(current, 1);

    assert.equal(patch.localProfileHits, 1);
    assert.equal(patch.localOnlyAnswers, 1);
  });

  it('preserves legacy-only counts while advancing the new local profile counter', () => {
    const current = { localProfileHits: 0, localOnlyAnswers: 4 };

    const patch = buildLocalProfileHitPatch(current, 1);

    assert.equal(patch.localProfileHits, 5);
    assert.equal(patch.localOnlyAnswers, 5);
  });
});
