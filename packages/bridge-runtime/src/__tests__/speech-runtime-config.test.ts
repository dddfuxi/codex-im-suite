import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadSpeechRuntimeConfig } from '../speech/runtime-config.js';

describe('speech runtime config', () => {
  it('uses safe disabled defaults and the formal provider/policy values', () => {
    const config = loadSpeechRuntimeConfig(new Map());
    assert.equal(config.inputEnabled, false);
    assert.equal(config.outputEnabled, false);
    assert.equal(config.replyPolicy, 'explicit_or_inbound_audio');
    assert.equal(config.deliveryMode, 'voice_only');
    assert.equal(config.asrProvider, 'sensevoice_gguf');
    assert.equal(config.ttsProvider, 'cosyvoice');
    assert.equal(config.voiceCloneBenchmarkPassed, false);
    assert.equal(config.maxInputBytes, 20 * 1024 * 1024);
    assert.equal(config.maxDurationMs, 300_000);
  });

  it('keeps reference voice cloning blocked until the operator records a passed benchmark', () => {
    const config = loadSpeechRuntimeConfig(new Map([
      ['CTI_SPEECH_VOICE_CLONE_BENCHMARK_PASSED', 'true'],
    ]));
    assert.equal(config.voiceCloneBenchmarkPassed, true);
  });

  it('reads the formal voice profile key before the legacy alias', () => {
    const config = loadSpeechRuntimeConfig(new Map([
      ['CTI_SPEECH_VOICE_PROFILE', 'formal-voice'],
      ['CTI_SPEECH_ACTIVE_VOICE_PROFILE_ID', 'legacy-voice'],
    ]));
    assert.equal(config.voiceProfileId, 'formal-voice');
  });

  it('allows limits to be lowered but never raised above the shared defaults', () => {
    const lowered = loadSpeechRuntimeConfig(new Map([
      ['CTI_SPEECH_MAX_INPUT_BYTES', '1048576'],
      ['CTI_SPEECH_MAX_DURATION_MS', '120000'],
    ]));
    assert.equal(lowered.maxInputBytes, 1_048_576);
    assert.equal(lowered.maxDurationMs, 120_000);
    const raised = loadSpeechRuntimeConfig(new Map([
      ['CTI_SPEECH_MAX_INPUT_BYTES', '999999999'],
      ['CTI_SPEECH_MAX_DURATION_MS', '999999999'],
    ]));
    assert.equal(raised.maxInputBytes, 20 * 1024 * 1024);
    assert.equal(raised.maxDurationMs, 300_000);
  });
});
