import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { ManagedSpeechDependencyManager } from '../speech/managed-dependency-manager.js';
import { hashFileSha256 } from '../speech/media-pipeline.js';
import { loadSpeechRuntimeConfig } from '../speech/runtime-config.js';
import type { RuntimeSpeechHost } from '../speech/runtime-speech-host.js';
import { SpeechControlService } from '../speech/speech-control-service.js';
import { SpeechModelBenchmarkStore } from '../speech/speech-model-benchmark-store.js';
import type { SpeechPreviewReceipt } from '../speech/speech-preview.js';
import { SpeechRuntimeStatusService } from '../speech/speech-status.js';
import { SpeechVoiceRegistry } from '../speech/voice-registry.js';

type ObjectSchema = { required?: string[]; properties?: Record<string, unknown> };

function assertObjectShape(value: Record<string, unknown>, schema: ObjectSchema): void {
  for (const field of schema.required || []) assert.ok(Object.hasOwn(value, field), `缺少 schema 必填字段 ${field}`);
  for (const field of Object.keys(value)) assert.ok(Object.hasOwn(schema.properties || {}, field), `出现 schema 未声明字段 ${field}`);
}

function fakeHost(ttsReady: boolean, modelId = 'qwen3-tts-12hz-1.7b-custom-voice'): RuntimeSpeechHost {
  const readyDependency = (id: string) => ({ id, displayName: id, state: 'ready' as const, path: `C:\\fake\\${id}.exe` });
  return {
    getDependencySnapshot: () => ({
      ffmpeg: readyDependency('ffmpeg'), ffprobe: readyDependency('ffprobe'),
      python: readyDependency('python'), sidecar: readyDependency('sidecar'),
    }),
    sidecar: {
      ensureClient: async () => ({
        health: async () => ({
          protocol: 'cti-speech-sidecar/v1' as const,
          status: ttsReady ? 'ready' as const : 'optional_missing' as const,
          version: 'test', capabilities: { asr: false, tts: ttsReady },
          ...(ttsReady ? { tts: {
            providerId: 'qwen3_tts',
            modelId,
            revision: 'a'.repeat(64),
          } } : {}),
          ...(ttsReady ? {} : { diagnosticCode: 'cosyvoice_dependency_missing' }),
        }),
      }),
    },
  } as unknown as RuntimeSpeechHost;
}

function writeMinimalWav(filePath: string): void {
  const bytes = Buffer.alloc(44);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(0, 40);
  fs.writeFileSync(filePath, bytes);
}

describe('speech status and control actions', () => {
  it('never promotes ASR to ready from an installed model when the runtime capability is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-status-asr-'));
    try {
      const config = loadSpeechRuntimeConfig(new Map([['CTI_SPEECH_INPUT_ENABLED', 'true']]));
      const status = new SpeechRuntimeStatusService({
        config, host: fakeHost(false), voiceRegistry: new SpeechVoiceRegistry(path.join(root, 'voices')),
        listManagedComponents: () => [{
          id: 'sensevoice_gguf', displayName: 'SenseVoice Q8', kind: 'model', state: 'ready',
          capabilities: ['asr'], installable: false,
        }, {
          id: 'sensevoice_runtime', displayName: 'SenseVoice Runtime', kind: 'binary', state: 'optional_missing',
          capabilities: ['asr_runtime'], diagnosticCode: 'component_not_installed', installable: true,
        }],
      });
      const value = await status.refresh();
      assert.notEqual(value.asrProvider.options[0]?.state, 'ready');
      // enabled 表示配置项可选择；真实可用性必须由 state/capability 表达。
      assert.equal(value.asrProvider.options[0]?.enabled, true);
      assert.notEqual(value.state, 'ready');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not enable preset installation merely because an unrelated component is installable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-status-blocked-'));
    try {
      const config = loadSpeechRuntimeConfig(new Map([['CTI_SPEECH_OUTPUT_ENABLED', 'true']]));
      const registry = new SpeechVoiceRegistry(path.join(root, 'voices'));
      const status = new SpeechRuntimeStatusService({
        config, host: fakeHost(false), voiceRegistry: registry,
        listManagedComponents: () => [{
          id: 'other_component', displayName: '其他组件', kind: 'binary', state: 'optional_missing',
          capabilities: ['asr'], diagnosticCode: 'component_not_installed', installable: true,
        }],
      });
      const value = await status.refresh();
      assert.equal(value.actions.find((item) => item.id === 'speech.installComponent')?.enabled, true);
      assert.equal(value.actions.find((item) => item.id === 'speech.installPresetVoice')?.enabled, false);
      assert.equal(value.actions.find((item) => item.id === 'speech.previewVoice')?.diagnosticCode, 'cosyvoice_dependency_missing');
      const preset = value.voiceProfiles.find((item) => item.id === 'qwen3.serena');
      assert.ok(preset, '未注册 preset 仍需投影为可见 catalog 卡片');
      assert.notEqual(preset.state, 'ready');
      assert.equal(value.components.find((item) => item.id === 'ffmpeg')?.installable, false);
      assert.equal(value.components.find((item) => item.id === 'other_component')?.installable, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('projects built-in model voices after a real TTS probe and keeps preview blocked without live transport', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-status-ready-'));
    try {
      const config = loadSpeechRuntimeConfig(new Map([['CTI_SPEECH_OUTPUT_ENABLED', 'true']]));
      const registry = new SpeechVoiceRegistry(path.join(root, 'voices'));
      const status = new SpeechRuntimeStatusService({ config, host: fakeHost(true), voiceRegistry: registry });
      const before = await status.refresh();
      assert.equal(before.actions.find((item) => item.id === 'speech.installPresetVoice')?.enabled, false);
      assert.equal(before.actions.find((item) => item.id === 'speech.deleteReferenceVoice')?.enabled, false);
      assert.equal(before.voiceProfiles.find((item) => item.id === 'qwen3.serena')?.state, 'ready');
      const service = new SpeechControlService({
        config, status, voiceRegistry: registry,
        dependencies: { install: async () => undefined } as unknown as ManagedSpeechDependencyManager,
        saveConfig: () => undefined,
      });
      const after = before;
      assert.equal(after.protocol, 'codex-im-suite/speech-status/v2');
      await assert.rejects(
        service.execute('speech.previewVoice', {}),
        (error: unknown) => Boolean(error && typeof error === 'object'
          && (error as { code?: string; status?: string }).code === 'speech_preview_live_runtime_unavailable'
          && (error as { status?: string }).status === 'blocked'),
      );

      const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../contracts/schemas/speech.schema.json');
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as { $defs: Record<string, ObjectSchema> };
      assertObjectShape(after as unknown as Record<string, unknown>, schema.$defs.SpeechStatusContract);
      for (const channel of after.channels) assertObjectShape(channel as unknown as Record<string, unknown>, schema.$defs.SpeechChannelContract);
      for (const selection of [after.replyPolicy, after.deliveryMode, after.asrProvider, after.ttsProvider, after.tonePolicy]) {
        assertObjectShape(selection as unknown as Record<string, unknown>, schema.$defs.SpeechSelectionContract);
        for (const option of selection.options) assertObjectShape(option as unknown as Record<string, unknown>, schema.$defs.SpeechSelectionOptionContract);
      }
      for (const action of after.actions) assertObjectShape(action as unknown as Record<string, unknown>, schema.$defs.SpeechActionContract);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps loaded-model state separate from a blocked hardware performance benchmark', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-status-performance-'));
    try {
      const config = loadSpeechRuntimeConfig(new Map([['CTI_SPEECH_OUTPUT_ENABLED', 'true']]));
      const hardwareId = 'b'.repeat(64);
      const benchmarks = new SpeechModelBenchmarkStore(path.join(root, 'runtime'));
      benchmarks.write({
        modelId: config.ttsModelId,
        providerId: config.ttsProvider,
        revision: 'a'.repeat(64),
        hardwareId,
        state: 'blocked',
        warmSynthesisMs: 86_707,
        outputDurationMs: 16_567,
        realTimeFactor: 5.2337,
        diagnosticCode: 'tts_model_warm_benchmark_too_slow',
      });
      const status = new SpeechRuntimeStatusService({
        config,
        host: fakeHost(true),
        voiceRegistry: new SpeechVoiceRegistry(path.join(root, 'voices')),
        benchmarkStore: benchmarks,
        hardwareId,
      });
      const value = await status.refresh();
      const model = value.ttsModel.options.find((item) => item.id === config.ttsModelId);
      const output = value.capabilities.find((item) => item.id === 'speech.output');
      assert.equal(model?.state, 'ready', 'Sidecar 已真实加载模型');
      assert.equal(model?.benchmark.state, 'blocked');
      assert.equal(output?.supported, true, '能力存在不等于性能已通过');
      // 性能门禁只表示“较慢”，不再把已加载且可真实生成的 TTS 标成不可用。
      assert.equal(output?.state, 'ready');
      assert.equal(output?.diagnosticCode, 'tts_model_warm_benchmark_too_slow');
      assert.equal(value.state, 'ready');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a reference voice identity when similarity passes even if the high-quality model is slow', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-reference-similarity-'));
    const source = path.join(root, 'source.wav');
    writeMinimalWav(source);
    try {
      const modelId = 'qwen3-tts-12hz-1.7b-base';
      const config = loadSpeechRuntimeConfig(new Map([
        ['CTI_SPEECH_OUTPUT_ENABLED', 'true'],
        ['CTI_SPEECH_TTS_MODEL_ID', modelId],
      ]));
      const hardwareId = 'b'.repeat(64);
      const registry = new SpeechVoiceRegistry(path.join(root, 'voices'), undefined, async (sourcePath) => ({
        format: 'wav', durationMs: 5_000, sha256: hashFileSha256(sourcePath),
      }));
      const profile = await registry.importReferenceVoice({
        sourcePath: source,
        displayName: '高质量复刻音色',
        transcript: '参考文本',
        sourceLabel: '用户导入',
        license: '用户已授权',
        authorizationConfirmed: true,
        cleanSingleSpeakerConfirmed: true,
      });
      const benchmarks = new SpeechModelBenchmarkStore(path.join(root, 'runtime'));
      benchmarks.write({
        modelId,
        providerId: config.ttsProvider,
        revision: 'a'.repeat(64),
        hardwareId,
        voiceProfileId: profile.id,
        state: 'blocked',
        warmSynthesisMs: 34_735,
        speakerSimilarity: 0.9888,
        speakerSimilarityThreshold: 0.72,
        speakerSimilarityPassed: true,
        diagnosticCode: 'tts_model_warm_benchmark_too_slow',
      });
      const status = new SpeechRuntimeStatusService({
        config,
        host: fakeHost(true, modelId),
        voiceRegistry: registry,
        benchmarkStore: benchmarks,
        hardwareId,
      });
      const value = await status.refresh();
      const accepted = value.voiceProfiles.find((item) => item.id === profile.id);
      const model = value.ttsModel.options.find((item) => item.id === modelId);

      assert.equal(accepted?.state, 'ready');
      assert.equal(accepted?.diagnosticCode, undefined);
      assert.equal(model?.benchmark.state, 'blocked');
      assert.equal(model?.benchmark.diagnosticCode, 'tts_model_warm_benchmark_too_slow');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('managed singing status is derived from pinned components without starting the heavy runtime', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-status-singing-'));
    let healthCalls = 0;
    try {
      const config = loadSpeechRuntimeConfig(new Map([['CTI_SINGING_ENABLED', 'true']]));
      const status = new SpeechRuntimeStatusService({
        config,
        host: fakeHost(false),
        voiceRegistry: new SpeechVoiceRegistry(path.join(root, 'voices')),
        previewAvailable: () => true,
        singingHost: {
          health: async () => { healthCalls += 1; return { state: 'ready' as const }; },
        } as never,
        listManagedComponents: () => [{
          id: 'ace_step_1_5', displayName: 'ACE Runtime', kind: 'runtime', state: 'ready',
          version: 'runtime-v1', capabilities: ['singing'], installable: false,
        }, {
          id: 'ace_step_1_5_models', displayName: 'ACE Models', kind: 'model', state: 'ready',
          version: 'models-v1', capabilities: ['singing'], installable: false,
        }],
      });
      const value = await status.refresh();
      assert.equal(healthCalls, 0);
      assert.equal(value.actions.find((item) => item.id === 'speech.benchmarkSingingModel')?.enabled, true);
      assert.equal(value.actions.find((item) => item.id === 'speech.previewSingingVoice')?.enabled, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('full singing generation keeps the complete plan and rejects stale provider or unverified reference identities', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-generate-singing-'));
    try {
      const config = loadSpeechRuntimeConfig(new Map([['CTI_SINGING_ENABLED', 'true']]));
      const hardwareId = 'c'.repeat(64);
      const benchmarkStore = new SpeechModelBenchmarkStore(path.join(root, 'runtime'));
      benchmarkStore.write({
        modelId: config.singingModel,
        providerId: config.singingProvider,
        revision: 'runtime-v1.models-v1',
        hardwareId,
        state: 'ready',
        warmSynthesisMs: 12_000,
        outputDurationMs: 10_000,
        realTimeFactor: 1.2,
        peakVramMiB: 6_000,
        lyricsAlignment: 0.94,
        lyricsAlignmentThreshold: 0.8,
        lyricsAlignmentPassed: true,
      });
      const registry = new SpeechVoiceRegistry(path.join(root, 'voices'));
      const status = new SpeechRuntimeStatusService({
        config,
        host: fakeHost(false),
        voiceRegistry: registry,
        benchmarkStore,
        hardwareId,
        previewAvailable: () => true,
        singingHost: { health: async () => ({ state: 'ready' as const }) } as never,
        listManagedComponents: () => [{
          id: 'ace_step_1_5', displayName: 'Singing Runtime', kind: 'runtime', state: 'ready',
          version: 'runtime-v1', capabilities: ['singing'], installable: false,
        }, {
          id: 'ace_step_1_5_models', displayName: 'Singing Models', kind: 'model', state: 'ready',
          version: 'models-v1', capabilities: ['singing'], installable: false,
        }],
      });
      const live = await status.refresh({ probeSidecar: false });
      assert.equal(live.actions.find((item) => item.id === 'speech.generateSinging')?.enabled, true);
      let capturedPlan: { outputMode: string; lyrics: string } | undefined;
      let generateCalls = 0;
      const generatedReceipt = {
        protocol: 'codex-im-suite/speech-preview/v2',
        mediaType: 'audio/ogg; codecs=opus',
        base64: 'T2dnUw==', bytes: 4, sha256: 'a'.repeat(64), durationMs: 10_000,
        modelId: config.singingModel, voiceProfileId: 'acestep.default',
        generationStatus: 'generated', deliveryStatus: 'not_sent',
        speakerSimilarityStatus: 'not_applicable', lyricsAlignmentStatus: 'passed',
        lyricsAlignment: 0.94, lyricsAlignmentThreshold: 0.8, lyricsAlignmentPassed: true,
        validated: true,
      } satisfies SpeechPreviewReceipt;
      const service = new SpeechControlService({
        config,
        status,
        voiceRegistry: registry,
        dependencies: { install: async () => undefined } as unknown as ManagedSpeechDependencyManager,
        saveConfig: () => undefined,
        probeSidecar: false,
        readLiveStatus: () => live,
        generateSinging: async ({ plan }) => {
          generateCalls += 1;
          capturedPlan = { outputMode: plan.outputMode, lyrics: plan.lyrics };
          return generatedReceipt;
        },
      });
      const lyrics = '[Verse]\n第一句歌词。\n第二句歌词。\n[Chorus]\n完整副歌。';
      await service.execute('speech.generateSinging', {
        providerId: config.singingProvider,
        voiceProfileId: '',
        lyrics,
        stylePrompt: '中文流行',
        vocalLanguage: 'zh',
        durationSeconds: null,
        melodyMode: 'auto',
      });
      assert.deepEqual(capturedPlan, { outputMode: 'full_generation', lyrics });
      assert.equal(generateCalls, 1);
      await assert.rejects(
        service.execute('speech.generateSinging', {
          providerId: 'stale-provider', voiceProfileId: '', lyrics, stylePrompt: '中文流行',
          vocalLanguage: 'zh', durationSeconds: null, melodyMode: 'auto',
        }),
        (error: unknown) => Boolean(error && typeof error === 'object'
          && (error as { code?: string }).code === 'singing_provider_not_active'),
      );
      await assert.rejects(
        service.execute('speech.generateSinging', {
          providerId: config.singingProvider, voiceProfileId: '', lyrics, stylePrompt: '中文流行',
          vocalLanguage: 'zh', durationSeconds: null, melodyMode: 'auto', modelId: 'untrusted-extra',
        }),
        (error: unknown) => Boolean(error && typeof error === 'object'
          && (error as { code?: string }).code === 'singing_generation_payload_invalid'),
      );

      config.singingVoiceProfileId = 'reference.voice';
      const unverifiedLive = {
        ...live,
        activeSingingVoiceProfileId: 'reference.voice',
        voiceProfiles: [...live.voiceProfiles, {
          id: 'reference.voice', displayName: '待验收参考音色', kind: 'reference' as const,
          state: 'ready' as const, active: true, license: '授权', sourceLabel: '测试',
          authorizationConfirmed: true, capabilities: ['singing' as const], compatibleTtsModelIds: [],
          speechAcceptance: { state: 'not_applicable' as const },
          singingAcceptance: { state: 'not_verified' as const, diagnosticCode: 'singing_voice_similarity_not_verified' },
        }],
      };
      const referenceService = new SpeechControlService({
        config,
        status,
        voiceRegistry: registry,
        dependencies: { install: async () => undefined } as unknown as ManagedSpeechDependencyManager,
        saveConfig: () => undefined,
        probeSidecar: false,
        readLiveStatus: () => unverifiedLive,
        generateSinging: async () => generatedReceipt,
      });
      await assert.rejects(
        referenceService.execute('speech.generateSinging', {
          providerId: config.singingProvider, voiceProfileId: 'reference.voice', lyrics,
          stylePrompt: '中文流行', vocalLanguage: 'zh', durationSeconds: null, melodyMode: 'auto',
        }),
        (error: unknown) => Boolean(error && typeof error === 'object'
          && (error as { code?: string }).code === 'singing_voice_similarity_not_verified'),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('deletes an active persistent reference voice, clears its acceptance record and falls back safely', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-delete-reference-'));
    const source = path.join(root, 'source.wav');
    writeMinimalWav(source);
    try {
      const config = loadSpeechRuntimeConfig(new Map([['CTI_SPEECH_OUTPUT_ENABLED', 'true']]));
      const registry = new SpeechVoiceRegistry(path.join(root, 'voices'), undefined, async (sourcePath) => ({
        format: 'wav', durationMs: 5_000, sha256: hashFileSha256(sourcePath),
      }));
      const profile = await registry.importReferenceVoice({
        sourcePath: source,
        displayName: '待删除音色',
        transcript: '参考文本',
        sourceLabel: '用户导入',
        license: '用户已授权',
        authorizationConfirmed: true,
        cleanSingleSpeakerConfirmed: true,
      });
      config.voiceProfileId = profile.id;
      config.singingVoiceProfileId = profile.id;
      const benchmarks = new SpeechModelBenchmarkStore(path.join(root, 'runtime'));
      const identity = {
        modelId: config.ttsModelId,
        providerId: config.ttsProvider,
        revision: 'a'.repeat(64),
        hardwareId: 'b'.repeat(64),
        voiceProfileId: profile.id,
      };
      benchmarks.write({
        ...identity,
        state: 'ready',
        speakerSimilarity: 0.9,
        speakerSimilarityThreshold: 0.72,
        speakerSimilarityPassed: true,
      });
      let savedVoiceProfileId: string | undefined;
      let savedSingingVoiceProfileId: string | undefined;
      const status = new SpeechRuntimeStatusService({ config, host: fakeHost(true), voiceRegistry: registry });
      const service = new SpeechControlService({
        config,
        status,
        voiceRegistry: registry,
        benchmarkStore: benchmarks,
        dependencies: { install: async () => undefined } as unknown as ManagedSpeechDependencyManager,
        saveConfig: (next) => {
          savedVoiceProfileId = next.voiceProfileId;
          savedSingingVoiceProfileId = next.singingVoiceProfileId;
        },
      });

      const before = await status.refresh();
      assert.equal(before.actions.find((item) => item.id === 'speech.deleteReferenceVoice')?.enabled, true);
      assert.equal(before.actions.find((item) => item.id === 'speech.renameReferenceVoice')?.enabled, true);
      await service.execute('speech.renameReferenceVoice', { voiceProfileId: profile.id, displayName: '已重命名音色' });
      assert.equal(registry.list().find((item) => item.id === profile.id)?.displayName, '已重命名音色');
      await service.execute('speech.deleteReferenceVoice', { voiceProfileId: profile.id });

      assert.equal(savedVoiceProfileId, 'qwen3.serena');
      assert.equal(savedSingingVoiceProfileId, undefined);
      assert.equal(registry.list().some((item) => item.id === profile.id), false);
      assert.equal(benchmarks.find(identity), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
