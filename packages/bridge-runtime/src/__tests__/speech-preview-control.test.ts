import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  requestSpeechVoiceBenchmark,
  requestSpeechVoicePreview,
  startSpeechPreviewControlService,
} from '../speech/speech-preview-control.js';
import { SPEECH_PREVIEW_PROTOCOL, type SpeechPreviewReceipt } from '../speech/speech-preview.js';

const media = Buffer.from('OggSbenchmark');

function receipt(extra: Partial<SpeechPreviewReceipt> = {}): SpeechPreviewReceipt {
  return {
    protocol: SPEECH_PREVIEW_PROTOCOL,
    mediaType: 'audio/ogg; codecs=opus',
    base64: media.toString('base64'),
    bytes: media.length,
    sha256: crypto.createHash('sha256').update(media).digest('hex'),
    durationMs: 1_000,
    modelId: 'qwen3-tts-12hz-1.7b-custom-voice',
    voiceProfileId: 'qwen3.serena',
    validated: true,
    ...extra,
  };
}

describe('speech preview benchmark control', () => {
  it('keeps benchmark metrics on the authenticated Runtime mailbox only', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-benchmark-mailbox-'));
    const service = startSpeechPreviewControlService({
      runtimeStateRoot: root,
      pollMs: 10,
      previewVoice: async () => receipt(),
      benchmarkVoice: async () => receipt({ modelRevision: 'revision_1', peakVramMiB: 2048 }),
    });
    try {
      const benchmark = await requestSpeechVoiceBenchmark({
        runtimeStateRoot: root,
        text: '真实性能测试',
        modelId: 'qwen3-tts-12hz-1.7b-custom-voice',
        voiceProfileId: 'qwen3.serena',
        timeoutMs: 2_000,
      });
      assert.equal(benchmark.modelRevision, 'revision_1');
      assert.equal(benchmark.peakVramMiB, 2048);

      const preview = await requestSpeechVoicePreview({
        runtimeStateRoot: root,
        text: '普通试听',
        modelId: 'qwen3-tts-12hz-1.7b-custom-voice',
        voiceProfileId: 'qwen3.serena',
        timeoutMs: 2_000,
      });
      assert.equal(preview.modelRevision, undefined);
      assert.equal(preview.peakVramMiB, undefined);
    } finally {
      service.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
