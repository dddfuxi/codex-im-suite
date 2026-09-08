import assert from 'node:assert/strict';
import test from 'node:test';

import { SPEECH_MODEL_CATALOG } from '../speech/speech-model-catalog.js';
import { projectSpeechProviders } from '../speech/speech-provider-catalog.js';

test('音色复刻模型明确把高质量档位排在低显存档之前', () => {
  const cloneModels = SPEECH_MODEL_CATALOG
    .filter((item) => item.capabilities.includes('voice_clone'))
    .sort((left, right) => right.qualityRank - left.qualityRank);
  assert.equal(cloneModels[0]?.id, 'qwen3-tts-12hz-1.7b-base');
  assert.equal(cloneModels[0]?.qualityTier, 'high_quality');
  assert.equal(cloneModels.at(-1)?.qualityTier, 'low_resource');
});

test('Provider 总览复用当前 TTS 联合门禁，不把身份匹配误报为 ready', () => {
  const providers = projectSpeechProviders({
    componentStates: new Map([
      ['qwen3_tts_runtime', { state: 'ready' }],
      ['qwen3-tts-12hz-1.7b-custom-voice', { state: 'ready' }],
      ['ace_step_1_5', { state: 'ready' }],
      ['ace_step_1_5_models', { state: 'ready' }],
      ['vevo2_poc', { state: 'blocked', diagnosticCode: 'vevo2_fileset_not_locked' }],
    ]),
    liveTtsProviderId: 'qwen3_tts',
    liveTtsState: 'blocked',
    liveTtsDiagnostic: 'tts_model_warm_benchmark_too_slow',
    activeSingingProviderId: 'ace_step_1_5',
    singingState: 'ready',
  });

  assert.deepEqual(
    providers.find((provider) => provider.id === 'qwen3_tts'),
    {
      id: 'qwen3_tts',
      displayName: 'Qwen3-TTS',
      state: 'blocked',
      enabled: false,
      experimental: false,
      license: 'Apache-2.0',
      capabilities: ['speech.text', 'speech.emotion', 'voice.zero_shot_clone'],
      diagnosticCode: 'tts_model_warm_benchmark_too_slow',
    },
  );
  assert.equal(providers.find((provider) => provider.id === 'ace_step_1_5')?.enabled, true);
  assert.equal(providers.find((provider) => provider.id === 'vevo2')?.diagnosticCode, 'vevo2_fileset_not_locked');
});
