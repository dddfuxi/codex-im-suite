import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { resolveSpeechControlTtsTimeoutMs, resolveSpeechSkillRoot } from '../speech/speech-control-cli.js';

describe('speech control CLI root resolution', () => {
  it('resolves both source and dist entrypoints to the package root', () => {
    const root = path.resolve(path.sep, 'tmp', 'claude-to-im-skill');
    assert.equal(resolveSpeechSkillRoot(path.join(root, 'src', 'speech', 'speech-control-cli.ts')), root);
    assert.equal(resolveSpeechSkillRoot(path.join(root, 'dist', 'speech-control-cli.mjs')), root);
  });

  it('uses the independent TTS synthesis ceiling instead of the short request timeout', () => {
    assert.equal(resolveSpeechControlTtsTimeoutMs({ synthesisTimeoutMs: 600_000 }), 610_000);
    assert.equal(resolveSpeechControlTtsTimeoutMs({ synthesisTimeoutMs: 900_000 }), 14 * 60_000);
  });
});
