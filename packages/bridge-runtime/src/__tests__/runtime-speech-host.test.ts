import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { RuntimeSpeechHost, validateSidecarTranscriptResult, type RuntimeSpeechMediaPipeline } from '../speech/runtime-speech-host.js';
import { loadSpeechRuntimeConfig } from '../speech/runtime-config.js';
import { hashFileSha256 } from '../speech/media-pipeline.js';
import type { SpeechSidecarSupervisor } from '../speech/sidecar-supervisor.js';
import { SpeechModelBenchmarkStore } from '../speech/speech-model-benchmark-store.js';
import { SpeechVoiceRegistry } from '../speech/voice-registry.js';

const TEST_TTS_IDENTITY = {
  providerId: 'qwen3_tts',
  modelId: 'qwen3-tts-12hz-1.7b-custom-voice',
  revision: 'a'.repeat(64),
};

function testVoiceRegistry(ctiHome: string): SpeechVoiceRegistry {
  return new SpeechVoiceRegistry(path.join(ctiHome, 'runtime', 'speech', 'voices'));
}

function writeMinimalWav(filePath: string): void {
  fs.writeFileSync(filePath, Buffer.concat([
    Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WAVEfmt ', 'ascii'), Buffer.alloc(24), Buffer.from('data', 'ascii'), Buffer.alloc(8),
  ]));
}

describe('RuntimeSpeechHost', () => {
  it('exposes only the supported read-only reply policy values', async () => {
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-policy-'));
    try {
      for (const [configured, expected] of [
        ['explicit_or_inbound_audio', 'explicit_or_inbound_audio'],
        ['explicit_only', 'explicit_only'],
        ['future_policy', 'explicit_or_inbound_audio'],
      ] as const) {
        const config = loadSpeechRuntimeConfig(new Map([['CTI_SPEECH_REPLY_POLICY', configured]]));
        const host = new RuntimeSpeechHost({ config, ctiHome, runtimeDepsRoot: path.join(ctiHome, 'deps'), bundledSidecarCandidates: [] });
        assert.equal(host.getReplyPolicy(), expected);
        await host.stop();
      }
    } finally {
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });

  it('keeps Owner self-voice auto authorization default-off and exposes only the bounded policy', async () => {
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-owner-policy-'));
    try {
      const defaultHost = new RuntimeSpeechHost({
        config: loadSpeechRuntimeConfig(new Map()),
        ctiHome,
        runtimeDepsRoot: path.join(ctiHome, 'deps-default'),
        bundledSidecarCandidates: [],
      });
      assert.deepEqual(defaultHost.getReferenceVoiceImportPolicy(), {
        ownerSelfVoiceAutoAuthorization: false,
      });
      await defaultHost.stop();

      const enabledHost = new RuntimeSpeechHost({
        config: loadSpeechRuntimeConfig(new Map([
          ['CTI_SPEECH_OWNER_SELF_VOICE_AUTO_AUTHORIZATION', 'true'],
        ])),
        ctiHome,
        runtimeDepsRoot: path.join(ctiHome, 'deps-enabled'),
        bundledSidecarCandidates: [],
      });
      assert.deepEqual(enabledHost.getReferenceVoiceImportPolicy(), {
        ownerSelfVoiceAutoAuthorization: true,
      });
      await enabledHost.stop();
    } finally {
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });

  it('requires a real model and spoken-language identity before issuing a transcript receipt', () => {
    assert.deepEqual(validateSidecarTranscriptResult({
      text: ' 你好 ', model: 'sensevoice-small-q8.gguf', language: 'ZH',
    }), {
      text: '你好', model: 'sensevoice-small-q8.gguf', language: 'zh',
    });
    for (const result of [
      { text: '你好', model: 'sensevoice-small-q8.gguf', language: '' },
      { text: '你好', model: 'sensevoice-small-q8.gguf' },
      { text: '你好', model: 'sensevoice-small-q8.gguf', language: 'nospeech' },
    ]) {
      assert.throws(
        () => validateSidecarTranscriptResult(result as never),
        (error: unknown) => Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'asr_language_identity_invalid'),
      );
    }
  });

  it('将 ACE-Step 原始歌声归一化为 ASR 协议 WAV 后再做歌词验收，并清理临时副本', async () => {
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-singing-asr-normalize-'));
    const ffmpegPath = path.join(ctiHome, 'ffmpeg.exe');
    const ffprobePath = path.join(ctiHome, 'ffprobe.exe');
    const candidatePath = path.join(ctiHome, 'ace-step-output.wav');
    const referencePath = path.join(ctiHome, 'reference.wav');
    fs.writeFileSync(ffmpegPath, 'fake', 'utf8');
    fs.writeFileSync(ffprobePath, 'fake', 'utf8');
    writeMinimalWav(candidatePath);
    writeMinimalWav(referencePath);
    const identity = { providerId: 'qwen3_tts', modelId: 'qwen3-tts-12hz-1.7b-base', revision: 'a'.repeat(64) };
    let normalizedAsrPath = '';
    const sidecar = {
      ensureClient: async () => ({
        health: async () => ({ protocol: 'cti-speech-sidecar/v1', state: 'ready', capabilities: { asr: true, tts: true }, tts: identity }),
        transcribe: async (input: { audioPath: string }) => {
          normalizedAsrPath = input.audioPath;
          return { text: '今天开始认真唱歌', model: 'sensevoice-small-q8.gguf', language: 'zh' };
        },
        compareSpeakers: async () => ({
          provider: identity.providerId,
          model: identity.modelId,
          revision: identity.revision,
          speakerSimilarity: 0.91,
          speakerSimilarityThreshold: 0.72,
          speakerSimilarityPassed: true,
        }),
      }),
      resolveDependencies: () => ({
        python: { id: 'python', displayName: 'Python', state: 'ready', path: ffmpegPath },
        sidecar: { id: 'sidecar', displayName: 'Sidecar', state: 'ready', path: ffprobePath },
      }),
      stop: async () => undefined,
    } as unknown as SpeechSidecarSupervisor;
    const host = new RuntimeSpeechHost({
      config: loadSpeechRuntimeConfig(new Map([
        ['CTI_SPEECH_TTS_MODEL_ID', identity.modelId],
        ['CTI_SPEECH_FFMPEG_PATH', ffmpegPath],
        ['CTI_SPEECH_FFPROBE_PATH', ffprobePath],
      ])),
      ctiHome,
      runtimeDepsRoot: path.join(ctiHome, 'runtime-deps'),
      bundledSidecarCandidates: [],
      sidecar,
      mediaPipeline: {
        validateAudio: async (input) => ({ path: input.filePath, format: 'wav', size: 64, sha256: 'a'.repeat(64), durationMs: 10_000, codec: 'pcm_s16le', channels: 1, sampleRate: 16_000 }),
        normalizeForAsr: async (input) => { fs.copyFileSync(candidatePath, input.outputPath); },
        normalizeForVoiceClone: async () => undefined,
        wavToMonoOpus: async () => undefined,
        hashFileSha256,
      },
    });
    try {
      const receipt = await host.verifySingingOutput({
        lyrics: '今天开始认真唱歌', candidatePath, referenceAudioPath: referencePath,
      });
      assert.equal(receipt.lyrics.passed, true);
      assert.equal(receipt.speakerSimilarityPassed, true);
      assert.match(normalizedAsrPath, /singing-asr-.+candidate\.wav$/u);
      assert.equal(fs.existsSync(normalizedAsrPath), false);
    } finally {
      await host.stop();
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });

  it('启用独立演唱验收器时不回退普通 ASR，仍继续执行克隆音色相似度门禁', async () => {
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-singing-firered-verifier-'));
    const ffmpegPath = path.join(ctiHome, 'ffmpeg.exe');
    const ffprobePath = path.join(ctiHome, 'ffprobe.exe');
    const candidatePath = path.join(ctiHome, 'ace-step-output.wav');
    const referencePath = path.join(ctiHome, 'reference.wav');
    fs.writeFileSync(ffmpegPath, 'fake', 'utf8');
    fs.writeFileSync(ffprobePath, 'fake', 'utf8');
    writeMinimalWav(candidatePath);
    writeMinimalWav(referencePath);
    const identity = { providerId: 'qwen3_tts', modelId: 'qwen3-tts-12hz-1.7b-base', revision: 'b'.repeat(64) };
    let ordinaryAsrCalls = 0;
    let verifierPath = '';
    const sidecar = {
      ensureClient: async () => ({
        health: async () => ({ protocol: 'cti-speech-sidecar/v1', state: 'ready', capabilities: { asr: true, tts: true }, tts: identity }),
        transcribe: async () => { ordinaryAsrCalls += 1; throw new Error('ordinary ASR must not run'); },
        compareSpeakers: async () => ({
          provider: identity.providerId, model: identity.modelId, revision: identity.revision,
          speakerSimilarity: 0.91, speakerSimilarityThreshold: 0.72, speakerSimilarityPassed: true,
        }),
      }),
      resolveDependencies: () => ({
        python: { id: 'python', displayName: 'Python', state: 'ready', path: ffmpegPath },
        sidecar: { id: 'sidecar', displayName: 'Sidecar', state: 'ready', path: ffprobePath },
      }),
      stop: async () => undefined,
    } as unknown as SpeechSidecarSupervisor;
    const host = new RuntimeSpeechHost({
      config: loadSpeechRuntimeConfig(new Map([
        ['CTI_SPEECH_TTS_MODEL_ID', identity.modelId],
        ['CTI_SPEECH_FFMPEG_PATH', ffmpegPath],
        ['CTI_SPEECH_FFPROBE_PATH', ffprobePath],
      ])),
      ctiHome,
      runtimeDepsRoot: path.join(ctiHome, 'runtime-deps'),
      bundledSidecarCandidates: [],
      sidecar,
      singingLyricsVerifier: {
        transcribe: async ({ candidatePath: normalizedPath }) => {
          verifierPath = normalizedPath;
          return { text: '今天开始认真唱歌', language: 'zh', model: 'fireredasr2-aed', provider: 'fireredasr2_aed_wsl' };
        },
      },
      mediaPipeline: {
        validateAudio: async (input) => ({ path: input.filePath, format: 'wav', size: 64, sha256: 'a'.repeat(64), durationMs: 10_000, codec: 'pcm_s16le', channels: 1, sampleRate: 16_000 }),
        normalizeForAsr: async (input) => { fs.copyFileSync(candidatePath, input.outputPath); },
        normalizeForVoiceClone: async () => undefined,
        wavToMonoOpus: async () => undefined,
        hashFileSha256,
      },
    });
    try {
      const receipt = await host.verifySingingOutput({ lyrics: '今天开始认真唱歌', candidatePath, referenceAudioPath: referencePath });
      assert.equal(receipt.lyrics.passed, true);
      assert.equal(receipt.speakerSimilarityPassed, true);
      assert.equal(ordinaryAsrCalls, 0);
      assert.match(verifierPath, /singing-asr-.+candidate\.wav$/u);
      assert.equal(fs.existsSync(verifierPath), false);
    } finally {
      await host.stop();
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });

  it('keeps missing optional speech dependencies from blocking text-only runtime', async () => {
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-host-'));
    const host = new RuntimeSpeechHost({
      config: loadSpeechRuntimeConfig(new Map()),
      ctiHome,
      runtimeDepsRoot: path.join(ctiHome, 'runtime-deps'),
      bundledSidecarCandidates: [],
    });
    try {
      await assert.rejects(
        host.transcribe({
          attachmentId: 'a1',
          path: path.join(ctiHome, 'missing.wav'),
          sha256: '0'.repeat(64),
          sourceMessageId: 'm1',
        }),
        (error: unknown) => Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'speech_input_disabled'),
      );
      await assert.rejects(
        host.synthesize({ text: 'hello' }),
        (error: unknown) => Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'speech_output_disabled'),
      );
    } finally {
      await host.stop();
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });

  it('verifies panel reference text with live ASR even when ordinary speech input is disabled', async () => {
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-panel-reference-'));
    const sourcePath = path.join(ctiHome, 'reference.wav');
    const ffmpegPath = path.join(ctiHome, 'ffmpeg.exe');
    const ffprobePath = path.join(ctiHome, 'ffprobe.exe');
    writeMinimalWav(sourcePath);
    fs.writeFileSync(ffmpegPath, 'fake', 'utf8');
    fs.writeFileSync(ffprobePath, 'fake', 'utf8');
    const sidecar = {
      ensureClient: async () => ({
        transcribe: async () => ({ text: '这是准确参考文本。', model: 'sensevoice', language: 'zh' }),
      }),
      resolveDependencies: () => ({
        python: { id: 'python', displayName: 'Python', state: 'ready', path: ffmpegPath },
        sidecar: { id: 'sidecar', displayName: 'Sidecar', state: 'ready', path: ffprobePath },
      }),
      stop: async () => undefined,
    } as unknown as SpeechSidecarSupervisor;
    const mediaPipeline = {
      hashFileSha256,
      validateAudio: async ({ filePath }: { filePath: string }) => ({
        path: filePath,
        format: 'wav',
        durationMs: 5_000,
        sha256: hashFileSha256(filePath),
      }),
      normalizeForAsr: async ({ sourcePath: source, outputPath }: { sourcePath: string; outputPath: string }) => {
        fs.copyFileSync(source, outputPath);
      },
      wavToMonoOpus: async () => undefined,
    } as unknown as RuntimeSpeechMediaPipeline;
    const config = loadSpeechRuntimeConfig(new Map([
      ['CTI_SPEECH_INPUT_ENABLED', 'false'],
      ['CTI_SPEECH_FFMPEG_PATH', ffmpegPath],
      ['CTI_SPEECH_FFPROBE_PATH', ffprobePath],
      ['CTI_SPEECH_ASR_MODEL', path.join(ctiHome, 'sensevoice.gguf')],
    ]));
    const host = new RuntimeSpeechHost({
      config,
      ctiHome,
      runtimeDepsRoot: path.join(ctiHome, 'runtime-deps'),
      bundledSidecarCandidates: [],
      sidecar,
      mediaPipeline,
    });
    try {
      const receipt = await host.verifyLocalReferenceTranscript({
        path: sourcePath,
        confirmedTranscript: '这是准确参考文本',
        confirmedTranscriptAccepted: true,
      });
      assert.equal(receipt.transcriptStatus, 'matched');
      assert.equal(receipt.sourceSha256, hashFileSha256(sourcePath));
      await assert.rejects(host.verifyLocalReferenceTranscript({
        path: sourcePath,
        confirmedTranscript: '这是错误文本',
        confirmedTranscriptAccepted: true,
      }), (error: unknown) => Boolean(error && typeof error === 'object'
        && (error as { code?: string }).code === 'voice_reference_transcript_mismatch'));
    } finally {
      await host.stop();
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });

  it('imports only a currently authorized native-reply voice and stores bounded source metadata', async () => {
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-reference-import-'));
    const sourcePath = path.join(ctiHome, 'reply.wav');
    writeMinimalWav(sourcePath);
    const sourceSha256 = hashFileSha256(sourcePath);
    const registry = new SpeechVoiceRegistry(
      path.join(ctiHome, 'runtime', 'speech', 'voices'),
      undefined,
      async (candidate) => ({ format: 'wav', durationMs: 5_000, sha256: hashFileSha256(candidate) }),
    );
    const host = new RuntimeSpeechHost({
      config: loadSpeechRuntimeConfig(new Map()),
      ctiHome,
      runtimeDepsRoot: path.join(ctiHome, 'runtime-deps'),
      bundledSidecarCandidates: [],
      voiceRegistry: registry,
    });
    const authorizedAt = new Date();
    const expiresAt = new Date(authorizedAt.getTime() + 5 * 60_000);
    try {
      const receipt = await host.importReferenceVoice({
        profileName: '飞书测试音色',
        path: sourcePath,
        mediaType: 'audio/wav',
        sha256: sourceSha256,
        requestMessageId: 'om_request',
        sourceMessageId: 'om_voice',
        fileKey: 'file_key',
        attachmentId: 'attachment_voice',
        transcript: {
          protocol: 'cti-speech-transcript/v1',
          attachmentId: 'attachment_voice',
          text: '这是参考音色文本。',
          model: 'sensevoice-small-q8.gguf',
          language: 'zh',
          relation: 'native_reply',
          requestMessageId: 'om_request',
          sourceMessageId: 'om_voice',
          fileSha256: sourceSha256,
          validated: true,
        },
        confirmedTranscript: '这是参考音色文本。',
        confirmedTranscriptAccepted: true,
        authorization: {
          protocol: 'cti-speech-reference-voice-authorization/v1',
          scope: 'current_native_reply_audio',
          ownerUserId: 'owner_user',
          authorizedAt: authorizedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          rightsBasis: 'self_or_authorized',
          usageScope: 'local_tts_only',
          cleanSingleSpeakerConfirmed: true,
        },
      });
      assert.equal(receipt.validated, true);
      assert.equal(receipt.fileSha256, sourceSha256);
      const record = registry.list().find((item) => item.id === receipt.voiceProfileId);
      assert.equal(record?.source, 'feishu_native_reply');
      assert.equal(record?.authorization?.scope, 'local_tts_only');
      assert.match(record?.authorization?.ownerIdHash || '', /^[a-f0-9]{64}$/u);

      await assert.rejects(host.importReferenceVoice({
        ...{
          profileName: '过期音色', path: sourcePath, mediaType: 'audio/wav', sha256: sourceSha256,
          requestMessageId: 'om_request', sourceMessageId: 'om_voice', fileKey: 'file_key', attachmentId: 'attachment_voice',
          transcript: {
            protocol: 'cti-speech-transcript/v1' as const, attachmentId: 'attachment_voice', text: '参考文本',
            model: 'sensevoice-small-q8.gguf', language: 'zh', relation: 'native_reply' as const,
            requestMessageId: 'om_request', sourceMessageId: 'om_voice', fileSha256: sourceSha256, validated: true as const,
          },
          confirmedTranscript: '参考文本',
          confirmedTranscriptAccepted: true as const,
        },
        authorization: {
          protocol: 'cti-speech-reference-voice-authorization/v1', scope: 'current_native_reply_audio', ownerUserId: 'owner_user',
          authorizedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
          expiresAt: new Date(Date.now() - 10 * 60_000).toISOString(),
          rightsBasis: 'self_or_authorized', usageScope: 'local_tts_only', cleanSingleSpeakerConfirmed: true,
        },
      }), (error: unknown) => Boolean(error && typeof error === 'object'
        && (error as { code?: string }).code === 'voice_authorization_invalid'));
    } finally {
      await host.stop();
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });

  it('fails closed when reference-voice authorization, transcript binding, or source bytes are changed', async () => {
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-reference-reject-'));
    const sourcePath = path.join(ctiHome, 'reply.wav');
    writeMinimalWav(sourcePath);
    const sourceSha256 = hashFileSha256(sourcePath);
    const registry = new SpeechVoiceRegistry(
      path.join(ctiHome, 'runtime', 'speech', 'voices'),
      undefined,
      async (candidate) => ({ format: 'wav', durationMs: 5_000, sha256: hashFileSha256(candidate) }),
    );
    const host = new RuntimeSpeechHost({
      config: loadSpeechRuntimeConfig(new Map()),
      ctiHome,
      runtimeDepsRoot: path.join(ctiHome, 'runtime-deps'),
      bundledSidecarCandidates: [],
      voiceRegistry: registry,
    });
    const authorizedAt = new Date();
    const baseInput = {
      profileName: '应被拒绝的音色',
      path: sourcePath,
      mediaType: 'audio/wav',
      sha256: sourceSha256,
      requestMessageId: 'om_request',
      sourceMessageId: 'om_voice',
      fileKey: 'file_key',
      attachmentId: 'attachment_voice',
      transcript: {
        protocol: 'cti-speech-transcript/v1' as const,
        attachmentId: 'attachment_voice',
        text: '这是参考音色文本。',
        model: 'sensevoice-small-q8.gguf',
        language: 'zh',
        relation: 'native_reply' as const,
        requestMessageId: 'om_request',
        sourceMessageId: 'om_voice',
        fileSha256: sourceSha256,
        validated: true as const,
      },
      confirmedTranscript: '这是参考音色文本。',
      confirmedTranscriptAccepted: true as const,
      authorization: {
        protocol: 'cti-speech-reference-voice-authorization/v1' as const,
        scope: 'current_native_reply_audio' as const,
        ownerUserId: 'owner_user',
        authorizedAt: authorizedAt.toISOString(),
        expiresAt: new Date(authorizedAt.getTime() + 5 * 60_000).toISOString(),
        rightsBasis: 'self_or_authorized' as const,
        usageScope: 'local_tts_only' as const,
        cleanSingleSpeakerConfirmed: true as const,
      },
    };
    const rejectsWithCode = async (input: Parameters<RuntimeSpeechHost['importReferenceVoice']>[0], code: string) => {
      await assert.rejects(
        host.importReferenceVoice(input),
        (error: unknown) => Boolean(error && typeof error === 'object' && (error as { code?: string }).code === code),
      );
    };
    try {
      for (const authorization of [
        { ...baseInput.authorization, ownerUserId: '' },
        { ...baseInput.authorization, rightsBasis: undefined },
        { ...baseInput.authorization, usageScope: undefined },
        { ...baseInput.authorization, cleanSingleSpeakerConfirmed: undefined },
      ]) {
        await rejectsWithCode({ ...baseInput, authorization }, 'voice_authorization_invalid');
      }

      for (const transcript of [
        { ...baseInput.transcript, relation: 'current_message' as const },
        { ...baseInput.transcript, requestMessageId: 'om_other_request' },
        { ...baseInput.transcript, sourceMessageId: 'om_other_voice' },
        { ...baseInput.transcript, attachmentId: 'other_attachment' },
        { ...baseInput.transcript, fileSha256: 'f'.repeat(64) },
        { ...baseInput.transcript, text: '   ' },
      ]) {
        await rejectsWithCode({ ...baseInput, transcript }, 'voice_transcript_binding_invalid');
      }

      await rejectsWithCode({
        ...baseInput,
        confirmedTranscriptAccepted: false as never,
      }, 'voice_reference_transcript_unconfirmed');
      await rejectsWithCode({
        ...baseInput,
        confirmedTranscript: '这是另一段参考文本。',
      }, 'voice_reference_transcript_mismatch');

      await rejectsWithCode({ ...baseInput, mediaType: 'image/png' }, 'voice_source_binding_invalid');
      fs.appendFileSync(sourcePath, 'changed-after-authorization', 'utf8');
      await rejectsWithCode(baseInput, 'voice_source_sha256_mismatch');
      assert.equal(registry.list().filter((item) => item.source === 'feishu_native_reply').length, 0);
    } finally {
      await host.stop();
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });

  it('removes both intermediate WAV and partial Ogg after a media pipeline failure', async () => {
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-cleanup-'));
    const ffmpegPath = path.join(ctiHome, 'ffmpeg.exe');
    const ffprobePath = path.join(ctiHome, 'ffprobe.exe');
    fs.writeFileSync(ffmpegPath, 'fake', 'utf8');
    fs.writeFileSync(ffprobePath, 'fake', 'utf8');
    let wavPath = '';
    let opusPath = '';
    const sidecar = {
      ensureClient: async () => ({
        health: async () => ({
          protocol: 'cti-speech-sidecar/v1',
          state: 'ready',
          capabilities: { asr: false, tts: true },
          tts: TEST_TTS_IDENTITY,
        }),
        synthesize: async (input: { outputPath: string }) => {
          wavPath = input.outputPath;
          fs.writeFileSync(wavPath, 'partial-wav', 'utf8');
          return { provider: TEST_TTS_IDENTITY.providerId, model: TEST_TTS_IDENTITY.modelId, revision: TEST_TTS_IDENTITY.revision };
        },
      }),
      resolveDependencies: () => ({
        python: { id: 'python', displayName: 'Python', state: 'ready', path: ffmpegPath },
        sidecar: { id: 'sidecar', displayName: 'Sidecar', state: 'ready', path: ffprobePath },
      }),
      stop: async () => undefined,
    } as unknown as SpeechSidecarSupervisor;
    const config = loadSpeechRuntimeConfig(new Map([
      ['CTI_SPEECH_OUTPUT_ENABLED', 'true'],
      ['CTI_SPEECH_FFMPEG_PATH', ffmpegPath],
      ['CTI_SPEECH_FFPROBE_PATH', ffprobePath],
    ]));
    const host = new RuntimeSpeechHost({
      config,
      ctiHome,
      runtimeDepsRoot: path.join(ctiHome, 'runtime-deps'),
      bundledSidecarCandidates: [],
      sidecar,
      voiceRegistry: testVoiceRegistry(ctiHome),
      mediaPipeline: {
        validateAudio: async (input) => ({
          path: input.filePath,
          format: 'wav',
          size: 11,
          sha256: '1'.repeat(64),
          durationMs: 100,
        }),
        normalizeForAsr: async () => undefined,
        normalizeForVoiceClone: async () => undefined,
        wavToMonoOpus: async (input) => {
          opusPath = input.outputPath;
          fs.writeFileSync(opusPath, 'partial-ogg', 'utf8');
          throw new Error('ffmpeg_opus_encode_failed');
        },
        hashFileSha256: () => '2'.repeat(64),
      },
    });
    try {
      await assert.rejects(host.synthesize({
        text: '测试失败清理',
        expectedIdentity: {
          ttsModelId: TEST_TTS_IDENTITY.modelId,
          modelRevision: TEST_TTS_IDENTITY.revision,
          voiceProfileId: 'qwen3.serena',
        },
      }), /语音编码失败/);
      assert.ok(wavPath);
      assert.ok(opusPath);
      assert.equal(fs.existsSync(wavPath), false);
      assert.equal(fs.existsSync(opusPath), false);
    } finally {
      await host.stop();
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });

  it('refuses an active preset when Core requires an accepted reference voice', async () => {
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-reference-required-'));
    const ffmpegPath = path.join(ctiHome, 'ffmpeg.exe');
    const ffprobePath = path.join(ctiHome, 'ffprobe.exe');
    fs.writeFileSync(ffmpegPath, 'fake', 'utf8');
    fs.writeFileSync(ffprobePath, 'fake', 'utf8');
    let synthesizeCalls = 0;
    const sidecar = {
      ensureClient: async () => ({
        health: async () => ({
          protocol: 'cti-speech-sidecar/v1',
          state: 'ready',
          capabilities: { asr: false, tts: true },
          tts: TEST_TTS_IDENTITY,
        }),
        synthesize: async () => {
          synthesizeCalls += 1;
          throw new Error('preset synthesis must not start');
        },
      }),
      resolveDependencies: () => ({
        python: { id: 'python', displayName: 'Python', state: 'ready', path: ffmpegPath },
        sidecar: { id: 'sidecar', displayName: 'Sidecar', state: 'ready', path: ffprobePath },
      }),
      stop: async () => undefined,
    } as unknown as SpeechSidecarSupervisor;
    const host = new RuntimeSpeechHost({
      config: loadSpeechRuntimeConfig(new Map([
        ['CTI_SPEECH_OUTPUT_ENABLED', 'true'],
        ['CTI_SPEECH_FFMPEG_PATH', ffmpegPath],
        ['CTI_SPEECH_FFPROBE_PATH', ffprobePath],
      ])),
      ctiHome,
      runtimeDepsRoot: path.join(ctiHome, 'runtime-deps'),
      bundledSidecarCandidates: [],
      sidecar,
      voiceRegistry: testVoiceRegistry(ctiHome),
    });
    try {
      await assert.rejects(host.synthesize({
        text: '必须使用已验收的复刻音色',
        expectedIdentity: {
          ttsModelId: TEST_TTS_IDENTITY.modelId,
          modelRevision: TEST_TTS_IDENTITY.revision,
          voiceProfileId: 'qwen3.serena',
        },
        voiceRequirement: 'active_reference',
      }), (error: unknown) => Boolean(error && typeof error === 'object'
        && (error as { code?: string }).code === 'voice_reference_not_active'));
      assert.equal(synthesizeCalls, 0);
    } finally {
      await host.stop();
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });

  it('accepts a verified reference voice even when only the model speed benchmark is blocked', async () => {
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-reference-slow-model-'));
    const ffmpegPath = path.join(ctiHome, 'ffmpeg.exe');
    const ffprobePath = path.join(ctiHome, 'ffprobe.exe');
    const referencePath = path.join(ctiHome, 'reference.wav');
    fs.writeFileSync(ffmpegPath, 'fake', 'utf8');
    fs.writeFileSync(ffprobePath, 'fake', 'utf8');
    writeMinimalWav(referencePath);
    const identity = {
      providerId: 'qwen3_tts',
      modelId: 'qwen3-tts-12hz-1.7b-base',
      revision: 'a'.repeat(64),
    };
    const hardwareId = 'b'.repeat(64);
    const registry = new SpeechVoiceRegistry(
      path.join(ctiHome, 'runtime', 'speech', 'voices'),
      undefined,
      async (sourcePath) => ({
        format: 'wav',
        durationMs: 5_000,
        sha256: hashFileSha256(sourcePath),
      }),
    );
    const profile = await registry.importReferenceVoice({
      sourcePath: referencePath,
      displayName: '慢模型已验收音色',
      transcript: '这是一段准确参考文本',
      sourceLabel: '测试授权录音',
      license: '测试授权',
      authorizationConfirmed: true,
      cleanSingleSpeakerConfirmed: true,
    });
    const benchmarkStore = new SpeechModelBenchmarkStore(path.join(ctiHome, 'runtime', 'speech'));
    let normalizedReferencePath = '';
    benchmarkStore.write({
      ...identity,
      hardwareId,
      voiceProfileId: profile.id,
      state: 'blocked',
      diagnosticCode: 'tts_model_warm_benchmark_too_slow',
      speakerSimilarity: 0.91,
      speakerSimilarityThreshold: 0.72,
      speakerSimilarityPassed: true,
    });
    const sidecar = {
      ensureClient: async () => ({
        health: async () => ({
          protocol: 'cti-speech-sidecar/v1',
          state: 'ready',
          capabilities: { asr: false, tts: true },
          tts: identity,
        }),
        synthesize: async (input: { outputPath: string; voiceReferencePath?: string }) => {
          normalizedReferencePath = input.voiceReferencePath || '';
          fs.writeFileSync(input.outputPath, 'managed-reference-wav', 'utf8');
          return {
            provider: identity.providerId,
            model: identity.modelId,
            revision: identity.revision,
            speakerSimilarity: 0.91,
            speakerSimilarityThreshold: 0.72,
            speakerSimilarityPassed: true,
          };
        },
      }),
      resolveDependencies: () => ({
        python: { id: 'python', displayName: 'Python', state: 'ready', path: ffmpegPath },
        sidecar: { id: 'sidecar', displayName: 'Sidecar', state: 'ready', path: ffprobePath },
      }),
      stop: async () => undefined,
    } as unknown as SpeechSidecarSupervisor;
    const host = new RuntimeSpeechHost({
      config: loadSpeechRuntimeConfig(new Map([
        ['CTI_SPEECH_OUTPUT_ENABLED', 'true'],
        ['CTI_SPEECH_TTS_MODEL_ID', identity.modelId],
        ['CTI_SPEECH_VOICE_PROFILE', profile.id],
        ['CTI_SPEECH_FFMPEG_PATH', ffmpegPath],
        ['CTI_SPEECH_FFPROBE_PATH', ffprobePath],
      ])),
      ctiHome,
      runtimeDepsRoot: path.join(ctiHome, 'runtime-deps'),
      bundledSidecarCandidates: [],
      sidecar,
      voiceRegistry: registry,
      benchmarkStore,
      hardwareId,
      mediaPipeline: {
        validateAudio: async (input) => {
          const isOgg = input.filePath.endsWith('.ogg');
          return {
            path: path.resolve(input.filePath),
            format: isOgg ? 'ogg' : 'wav',
            size: fs.statSync(input.filePath).size,
            sha256: hashFileSha256(input.filePath),
            durationMs: 120,
            ...(isOgg ? { codec: 'opus' } : { codec: 'pcm_s16le' }),
          };
        },
        normalizeForAsr: async () => undefined,
        normalizeForVoiceClone: async (input) => {
          fs.copyFileSync(referencePath, input.outputPath);
        },
        wavToMonoOpus: async (input) => {
          fs.writeFileSync(input.outputPath, Buffer.from('OggS-reference-opus', 'utf8'));
        },
        hashFileSha256,
      },
    });
    try {
      const receipt = await host.synthesize({
        text: '即使高质量模型较慢也应允许已验收音色生成',
        expectedIdentity: {
          ttsModelId: identity.modelId,
          modelRevision: identity.revision,
          voiceProfileId: profile.id,
        },
        voiceRequirement: 'active_reference',
      });
      assert.equal(receipt.speakerSimilarityStatus, 'passed');
      assert.equal(receipt.speakerSimilarityPassed, true);
      assert.equal(receipt.voiceProfileId, profile.id);
      assert.match(normalizedReferencePath, /\.reference\.wav$/u);
      assert.notEqual(path.resolve(normalizedReferencePath), path.resolve(referencePath));
      assert.equal(fs.existsSync(normalizedReferencePath), false);
    } finally {
      await host.stop();
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });

  it('releases only this host instance managed synthesis output and keeps cleanup idempotent', async () => {
    const ctiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-release-'));
    const ffmpegPath = path.join(ctiHome, 'ffmpeg.exe');
    const ffprobePath = path.join(ctiHome, 'ffprobe.exe');
    fs.writeFileSync(ffmpegPath, 'fake', 'utf8');
    fs.writeFileSync(ffprobePath, 'fake', 'utf8');
    const sidecar = {
      ensureClient: async () => ({
        health: async () => ({
          protocol: 'cti-speech-sidecar/v1',
          state: 'ready',
          capabilities: { asr: false, tts: true },
          tts: TEST_TTS_IDENTITY,
        }),
        synthesize: async (input: { outputPath: string }) => {
          fs.writeFileSync(input.outputPath, 'managed-wav', 'utf8');
          return { provider: TEST_TTS_IDENTITY.providerId, model: TEST_TTS_IDENTITY.modelId, revision: TEST_TTS_IDENTITY.revision };
        },
      }),
      resolveDependencies: () => ({
        python: { id: 'python', displayName: 'Python', state: 'ready', path: ffmpegPath },
        sidecar: { id: 'sidecar', displayName: 'Sidecar', state: 'ready', path: ffprobePath },
      }),
      stop: async () => undefined,
    } as unknown as SpeechSidecarSupervisor;
    const host = new RuntimeSpeechHost({
      config: loadSpeechRuntimeConfig(new Map([
        ['CTI_SPEECH_OUTPUT_ENABLED', 'true'],
        ['CTI_SPEECH_FFMPEG_PATH', ffmpegPath],
        ['CTI_SPEECH_FFPROBE_PATH', ffprobePath],
      ])),
      ctiHome,
      runtimeDepsRoot: path.join(ctiHome, 'runtime-deps'),
      bundledSidecarCandidates: [],
      sidecar,
      voiceRegistry: testVoiceRegistry(ctiHome),
      mediaPipeline: {
        validateAudio: async (input) => {
          const isOgg = input.filePath.endsWith('.ogg');
          return {
            path: path.resolve(input.filePath),
            format: isOgg ? 'ogg' : 'wav',
            size: fs.statSync(input.filePath).size,
            sha256: hashFileSha256(input.filePath),
            durationMs: 120,
            ...(isOgg ? { codec: 'opus' } : {}),
          };
        },
        normalizeForAsr: async () => undefined,
        normalizeForVoiceClone: async () => undefined,
        wavToMonoOpus: async (input) => {
          fs.writeFileSync(input.outputPath, Buffer.from('OggS-managed-opus', 'utf8'));
        },
        hashFileSha256,
      },
    });
    try {
      const scratchDir = path.join(ctiHome, 'runtime', 'workspaces', 'session-a', 'turn-a', 'scratch');
      const identity = {
        ttsModelId: TEST_TTS_IDENTITY.modelId,
        modelRevision: TEST_TTS_IDENTITY.revision,
        voiceProfileId: 'qwen3.serena',
      };
      const receipt = await host.synthesize({ text: '交付后清理', scratchDir, expectedIdentity: identity });
      assert.equal(fs.existsSync(receipt.path), true);
      host.releaseSynthesis(receipt);
      assert.equal(fs.existsSync(receipt.path), false);
      assert.doesNotThrow(() => host.releaseSynthesis(receipt));

      const changed = await host.synthesize({ text: '哈希变化拒绝', scratchDir, expectedIdentity: identity });
      fs.appendFileSync(changed.path, 'changed', 'utf8');
      assert.throws(
        () => host.releaseSynthesis(changed),
        (error: unknown) => Boolean(error && typeof error === 'object'
          && (error as { code?: string }).code === 'speech_synthesis_release_hash_mismatch'),
      );
      assert.equal(fs.existsSync(changed.path), true);
      assert.throws(
        () => host.releaseSynthesis({ ...changed, path: path.join(ctiHome, 'outside.ogg') }),
        (error: unknown) => Boolean(error && typeof error === 'object'
          && (error as { code?: string }).code === 'speech_synthesis_release_out_of_bounds'),
      );
      await assert.rejects(
        host.synthesize({ text: '越界目录', scratchDir: path.join(os.tmpdir(), 'cti-unmanaged-speech-output'), expectedIdentity: identity }),
        (error: unknown) => Boolean(error && typeof error === 'object'
          && (error as { code?: string }).code === 'speech_synthesis_root_out_of_bounds'),
      );
    } finally {
      await host.stop();
      fs.rmSync(ctiHome, { recursive: true, force: true });
    }
  });
});
