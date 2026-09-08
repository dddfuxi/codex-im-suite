import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { startSpeechPreviewPlayback, type SpeechPreviewAudioTarget } from './speech-preview-playback.js';

describe('speech preview playback', () => {
  it('unmutes, restores full volume and starts the validated preview', async () => {
    const calls: string[] = [];
    const target: SpeechPreviewAudioTarget = {
      muted: true,
      volume: 0,
      load: () => calls.push('load'),
      play: async () => { calls.push('play'); },
    };

    assert.equal(await startSpeechPreviewPlayback(target), true);
    assert.equal(target.muted, false);
    assert.equal(target.volume, 1);
    assert.deepEqual(calls, ['load', 'play']);
  });

  it('returns a manual-play fallback instead of hiding autoplay rejection', async () => {
    const target: SpeechPreviewAudioTarget = {
      muted: false,
      volume: 1,
      load: () => undefined,
      play: async () => { throw new Error('NotAllowedError'); },
    };

    assert.equal(await startSpeechPreviewPlayback(target), false);
  });
});
