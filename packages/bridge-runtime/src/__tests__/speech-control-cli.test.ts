import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { resolveSpeechSkillRoot } from '../speech/speech-control-cli.js';

describe('speech control CLI root resolution', () => {
  it('resolves both source and dist entrypoints to the package root', () => {
    const root = path.resolve(path.sep, 'tmp', 'claude-to-im-skill');
    assert.equal(resolveSpeechSkillRoot(path.join(root, 'src', 'speech', 'speech-control-cli.ts')), root);
    assert.equal(resolveSpeechSkillRoot(path.join(root, 'dist', 'speech-control-cli.mjs')), root);
  });
});
