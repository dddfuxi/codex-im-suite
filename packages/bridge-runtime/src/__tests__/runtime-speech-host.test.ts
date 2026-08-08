import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { RuntimeSpeechHost, validateSidecarTranscriptResult } from '../speech/runtime-speech-host.js';
import { loadSpeechRuntimeConfig } from '../speech/runtime-config.js';
import { hashFileSha256 } from '../speech/media-pipeline.js';
import type { SpeechSidecarSupervisor } from '../speech/sidecar-supervisor.js';
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
