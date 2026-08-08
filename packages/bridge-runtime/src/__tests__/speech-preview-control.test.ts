import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

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

  it('keeps a standalone CLI-style client alive until the Runtime response is written', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-preview-child-'));
    const service = startSpeechPreviewControlService({
      runtimeStateRoot: root,
      pollMs: 10,
      previewVoice: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        return receipt();
      },
      benchmarkVoice: async () => receipt({ modelRevision: 'revision_1', peakVramMiB: 2048 }),
    });
    const moduleUrl = pathToFileURL(path.resolve('src/speech/speech-preview-control.ts')).href;
    const childScript = [
      `import { requestSpeechVoicePreview } from ${JSON.stringify(moduleUrl)};`,
      `requestSpeechVoicePreview(${JSON.stringify({
        runtimeStateRoot: root,
        text: '独立进程试听',
        modelId: 'qwen3-tts-12hz-1.7b-custom-voice',
        voiceProfileId: 'qwen3.serena',
        timeoutMs: 2_000,
      })}).then(`,
      "  (value) => process.stdout.write(JSON.stringify({ ok: true, value }) + '\\n'),",
      "  (error) => { process.stdout.write(JSON.stringify({ ok: false, error: String(error) }) + '\\n'); process.exitCode = 1; },",
      ');',
    ].join('\n');

    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childScript], {
          cwd: path.resolve('.'),
          env: process.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
      });

      assert.equal(result.code, 0, result.stderr);
      const outputLines = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
      assert.equal(outputLines.length, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
      const output = JSON.parse(outputLines[0]) as { ok?: boolean; value?: SpeechPreviewReceipt };
      assert.equal(output.ok, true);
      assert.equal(output.value?.protocol, SPEECH_PREVIEW_PROTOCOL);
      assert.equal(output.value?.voiceProfileId, 'qwen3.serena');
    } finally {
      service.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
