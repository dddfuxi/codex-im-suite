import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  requestReferenceTranscriptVerification,
  requestSingingGeneration,
  requestSingingVoicePreview,
  requestSpeechVoiceBenchmark,
  requestSpeechVoicePreview,
  startSpeechPreviewControlService,
} from '../speech/speech-preview-control.js';
import { SPEECH_PREVIEW_PROTOCOL, type SpeechPreviewReceipt } from '../speech/speech-preview.js';
import { createSingingAudioContentPlan } from '@codex-im-suite/contracts/speech';

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
    generationStatus: 'generated',
    deliveryStatus: 'not_sent',
    speakerSimilarityStatus: 'not_applicable',
    validated: true,
    ...extra,
  };
}

describe('speech preview benchmark control', () => {
  it('routes reference transcript verification through the single live Runtime without returning paths or ASR text', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-reference-mailbox-'));
    const sourcePath = path.join(root, 'reference.wav');
    fs.writeFileSync(sourcePath, 'reference-audio', 'utf8');
    const sourceSha256 = crypto.createHash('sha256').update('reference-audio').digest('hex');
    let captured: { sourcePath: string; confirmedTranscript: string } | undefined;
    const service = startSpeechPreviewControlService({
      runtimeStateRoot: root,
      pollMs: 10,
      previewVoice: async () => receipt(),
      verifyReferenceTranscript: async (input) => {
        captured = input;
        return {
          protocol: 'cti-speech-reference-transcript-verification/v1',
          sourceSha256,
          transcriptStatus: 'matched',
          validated: true,
        };
      },
    });
    try {
      const result = await requestReferenceTranscriptVerification({
        runtimeStateRoot: root,
        sourcePath,
        confirmedTranscript: '这是准确文本。',
        timeoutMs: 2_000,
      });
      assert.equal(captured?.sourcePath, sourcePath);
      assert.equal(captured?.confirmedTranscript, '这是准确文本。');
      assert.deepEqual(result, {
        protocol: 'cti-speech-reference-transcript-verification/v1',
        sourceSha256,
        transcriptStatus: 'matched',
        validated: true,
      });
      assert.equal('sourcePath' in result, false);
      assert.equal('transcript' in result, false);
    } finally {
      service.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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

  it('keeps quick preview and full lyrics generation on distinct v4 plans with strict acceptance receipts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-singing-generation-mailbox-'));
    const captured: Array<{ outputMode: string; lyrics: string; durationSeconds: number }> = [];
    const singingReceipt = () => receipt({
      modelId: 'acestep-v15-turbo',
      voiceProfileId: 'acestep.default',
      lyricsAlignmentStatus: 'passed',
      lyricsAlignment: 0.94,
      lyricsAlignmentThreshold: 0.8,
      lyricsAlignmentPassed: true,
    });
    const service = startSpeechPreviewControlService({
      runtimeStateRoot: root,
      pollMs: 10,
      previewVoice: async () => receipt(),
      previewSingingVoice: async ({ plan }) => {
        captured.push({ outputMode: plan.outputMode, lyrics: plan.lyrics, durationSeconds: plan.durationSeconds });
        return singingReceipt();
      },
      generateSinging: async ({ plan }) => {
        captured.push({ outputMode: plan.outputMode, lyrics: plan.lyrics, durationSeconds: plan.durationSeconds });
        return singingReceipt();
      },
    });
    const fullLyrics = '[Verse]\n第一句完整歌词。\n第二句也必须保留。\n[Chorus]\n这是副歌完整内容。';
    const quickPlan = createSingingAudioContentPlan({
      outputMode: 'quick_preview', lyrics: fullLyrics, stylePrompt: '中文流行', vocalLanguage: 'zh',
    });
    const fullPlan = createSingingAudioContentPlan({
      outputMode: 'full_generation', lyrics: fullLyrics, stylePrompt: '中文流行', vocalLanguage: 'zh',
    });
    assert.ok(quickPlan);
    assert.ok(fullPlan);
    try {
      const quick = await requestSingingVoicePreview({
        runtimeStateRoot: root,
        plan: quickPlan,
        modelId: 'acestep-v15-turbo',
        voiceProfileId: 'acestep.default',
        timeoutMs: 2_000,
      });
      const full = await requestSingingGeneration({
        runtimeStateRoot: root,
        plan: fullPlan,
        modelId: 'acestep-v15-turbo',
        voiceProfileId: 'acestep.default',
        timeoutMs: 2_000,
      });
      assert.equal(quick.lyricsAlignmentPassed, true);
      assert.equal(full.lyricsAlignmentPassed, true);
      assert.deepEqual(captured.map((item) => item.outputMode), ['quick_preview', 'full_generation']);
      assert.equal(captured[0]?.durationSeconds, 10);
      assert.equal(captured[1]?.lyrics, fullLyrics);
      assert.ok((captured[1]?.lyrics.length || 0) >= (captured[0]?.lyrics.length || 0));
    } finally {
      service.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
