import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SpeechModelBenchmarkStore } from '../speech/speech-model-benchmark-store.js';

test('参考音色 benchmark 按 profile 隔离，不能跨音色复用相似度结论', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-benchmark-profile-'));
  try {
    const store = new SpeechModelBenchmarkStore(root);
    const identity = {
      modelId: 'clone-model',
      providerId: 'clone-provider',
      revision: 'revision-1',
      hardwareId: 'a'.repeat(64),
    };
    store.write({
      ...identity,
      voiceProfileId: 'voice.reference.a',
      state: 'ready',
      speakerSimilarity: 0.84,
      speakerSimilarityThreshold: 0.72,
      speakerSimilarityPassed: true,
    });
    assert.equal(store.find({ ...identity, voiceProfileId: 'voice.reference.a' })?.state, 'ready');
    assert.equal(store.find({ ...identity, voiceProfileId: 'voice.reference.b' }), null);
    assert.equal(store.find(identity), null);
    store.write({
      ...identity,
      voiceProfileId: 'voice.reference.b',
      state: 'blocked',
      speakerSimilarity: 0.61,
      speakerSimilarityThreshold: 0.72,
      speakerSimilarityPassed: false,
      diagnosticCode: 'voice_clone_similarity_below_threshold',
    });
    assert.equal(store.find({ ...identity, voiceProfileId: 'voice.reference.b' })?.speakerSimilarityPassed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('删除参考音色时只清理该 Profile 的 benchmark 记录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-benchmark-delete-'));
  try {
    const store = new SpeechModelBenchmarkStore(root);
    const identity = {
      modelId: 'clone-model', providerId: 'clone-provider', revision: 'revision-1', hardwareId: 'b'.repeat(64),
    };
    store.write({ ...identity, voiceProfileId: 'voice.reference.a', state: 'ready', speakerSimilarityPassed: true });
    store.write({ ...identity, voiceProfileId: 'voice.reference.b', state: 'ready', speakerSimilarityPassed: true });
    store.write({ ...identity, state: 'ready' });

    assert.equal(store.findTiming({ ...identity, voiceProfileId: 'voice.reference.a' })?.voiceProfileId, 'voice.reference.a');
    assert.equal(store.findTiming({ ...identity, voiceProfileId: 'voice.reference.unknown' })?.voiceProfileId, undefined);

    assert.equal(store.deleteVoiceProfile('voice.reference.a'), 1);
    assert.equal(store.find({ ...identity, voiceProfileId: 'voice.reference.a' }), null);
    assert.equal(store.find({ ...identity, voiceProfileId: 'voice.reference.b' })?.state, 'ready');
    assert.equal(store.find(identity)?.state, 'ready');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
