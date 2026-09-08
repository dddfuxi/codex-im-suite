import {
  createSingingAudioContentPlan,
  type SingingAudioContentPlanContract,
  type SpeechSettingsContract,
  type SpeechStatusContract,
} from '@codex-im-suite/contracts/speech';

import type { ManagedSpeechDependencyManager } from './managed-dependency-manager.js';
import type { SpeechRuntimeStatusService } from './speech-status.js';
import { RuntimeSpeechError, type SpeechRuntimeConfig } from './runtime-types.js';
import {
  MAX_SPEECH_PREVIEW_TEXT_CHARACTERS,
  type SpeechPreviewReceipt,
} from './speech-preview.js';
import { DEFAULT_PRESET_VOICE, type SpeechVoiceRegistry } from './voice-registry.js';
import type { SpeechModelBenchmarkStore } from './speech-model-benchmark-store.js';
import { findSpeechModel } from './speech-model-catalog.js';
import { speakerSimilarityAcceptanceRecorded } from './speaker-similarity-policy.js';
import type { RuntimeReferenceTranscriptVerificationReceipt } from './runtime-speech-host.js';

export const SPEECH_CONTROL_ACTIONS = [
  'speech.refresh',
  'speech.saveSettings',
  'speech.installComponent',
  'speech.installPresetVoice',
  'speech.benchmarkTtsModel',
  'speech.benchmarkSingingModel',
  'speech.importReferenceVoice',
  'speech.renameReferenceVoice',
  'speech.deleteReferenceVoice',
  'speech.previewVoice',
  'speech.previewSingingVoice',
  'speech.generateSinging',
  'speech.activateVoiceProfile',
] as const;

export type SpeechControlAction = typeof SPEECH_CONTROL_ACTIONS[number];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeSpeechError('speech_payload_invalid', 'blocked', '语音命令参数无效');
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string, allowEmpty = false, maxLength = 4_000): string {
  if (typeof value !== 'string') throw new RuntimeSpeechError(`speech_${field}_invalid`, 'blocked', '语音命令参数无效');
  const normalized = value.trim();
  if ((!normalized && !allowEmpty) || normalized.length > maxLength) throw new RuntimeSpeechError(`speech_${field}_invalid`, 'blocked', '语音命令参数无效');
  return normalized;
}

function hasOption(status: SpeechStatusContract, field: 'replyPolicy' | 'deliveryMode' | 'asrProvider' | 'ttsProvider' | 'tonePolicy' | 'singingProvider', value: string): boolean {
  return status[field].options.some((option) => option.id === value && option.enabled);
}

function buildSingingPlan(
  input: Record<string, unknown>,
  outputMode: 'quick_preview' | 'full_generation',
  config: SpeechRuntimeConfig,
  fallbackLyrics?: string,
): SingingAudioContentPlanContract {
  const lyrics = stringValue(input.lyrics ?? input.text ?? fallbackLyrics, 'singing_lyrics', false, 6_000);
  const stylePrompt = typeof input.stylePrompt === 'string' && input.stylePrompt.trim()
    ? stringValue(input.stylePrompt, 'singing_style_prompt', false, 500)
    : '清晰自然的中文演唱，准确表达歌词内容，保持稳定节奏与干净人声';
  const vocalLanguage = typeof input.vocalLanguage === 'string' && input.vocalLanguage.trim()
    ? stringValue(input.vocalLanguage, 'singing_vocal_language', false, 16)
    : 'zh';
  const melodyMode = input.melodyMode === undefined ? 'auto' : stringValue(input.melodyMode, 'singing_melody_mode');
  // 当前稳定 Provider 只支持自动旋律；其它模式必须等声明相应输入协议的 Provider，
  // 不能悄悄忽略用户选择。
  if (melodyMode !== 'auto') {
    throw new RuntimeSpeechError('singing_melody_mode_unsupported', 'blocked', '当前歌声 Provider 尚未接入该旋律输入模式');
  }
  const requestedDurationSeconds = input.durationSeconds === undefined || input.durationSeconds === null
    || input.durationSeconds === '' ? undefined : Number(input.durationSeconds);
  const plan = createSingingAudioContentPlan({
    outputMode,
    lyrics,
    stylePrompt,
    vocalLanguage,
    requestedDurationSeconds,
    maxDurationSeconds: config.maxSongDurationSeconds,
    maxLyricsCharacters: 6_000,
    melodyMode: 'auto',
    ...(typeof input.voiceProfileId === 'string' && input.voiceProfileId.trim() && input.voiceProfileId !== 'acestep.default'
      ? { voiceRequirement: 'active_reference' as const }
      : {}),
  });
  if (!plan) throw new RuntimeSpeechError('singing_content_plan_invalid', 'blocked', '歌词、风格、语言或时长不符合歌声生成限制');
  return plan;
}

export class SpeechControlService {
  constructor(private readonly options: {
    config: SpeechRuntimeConfig;
    status: SpeechRuntimeStatusService;
    voiceRegistry: SpeechVoiceRegistry;
    dependencies: ManagedSpeechDependencyManager;
    saveConfig: (speech: SpeechRuntimeConfig) => void;
    probeSidecar?: boolean;
    readLiveStatus?: () => SpeechStatusContract | null;
    previewVoice?: (input: {
      text: string;
      modelId: string;
      voiceProfileId: string;
    }) => Promise<SpeechPreviewReceipt>;
    benchmarkVoice?: (input: {
      text: string;
      modelId: string;
      voiceProfileId: string;
    }) => Promise<SpeechPreviewReceipt>;
    benchmarkSingingVoice?: (input: {
      plan: SingingAudioContentPlanContract;
      modelId: string;
      voiceProfileId: string;
    }) => Promise<SpeechPreviewReceipt>;
    previewSingingVoice?: (input: {
      plan: SingingAudioContentPlanContract;
      modelId: string;
      voiceProfileId: string;
    }) => Promise<SpeechPreviewReceipt>;
    generateSinging?: (input: {
      plan: SingingAudioContentPlanContract;
      modelId: string;
      voiceProfileId: string;
    }) => Promise<SpeechPreviewReceipt>;
    verifyReferenceTranscript?: (input: {
      sourcePath: string;
      confirmedTranscript: string;
    }) => Promise<RuntimeReferenceTranscriptVerificationReceipt>;
    benchmarkStore?: SpeechModelBenchmarkStore;
    hardwareId?: string;
    gpuMemoryMiB?: number;
  }) {}

  private refreshStatus(preferLiveSnapshot = true): Promise<SpeechStatusContract> {
    if (preferLiveSnapshot && this.options.probeSidecar === false) {
      const live = this.options.readLiveStatus?.();
      if (live) return Promise.resolve(live);
    }
    return this.options.status.refresh({ probeSidecar: this.options.probeSidecar !== false });
  }

  async execute(action: string, payload: unknown): Promise<SpeechStatusContract | SpeechPreviewReceipt> {
    if (!(SPEECH_CONTROL_ACTIONS as readonly string[]).includes(action)) throw new RuntimeSpeechError('speech_action_unknown', 'blocked', '未知语音命令');
    if (action === 'speech.refresh') return this.refreshStatus();
    const input = record(payload);
    if (action === 'speech.saveSettings') await this.saveSettings(input);
    else if (action === 'speech.installComponent') await this.options.dependencies.install(stringValue(input.componentId, 'component_id'));
    else if (action === 'speech.installPresetVoice') {
      const current = await this.refreshStatus();
      const installAction = current.actions.find((item) => item.id === action);
      if (!installAction?.enabled) {
        throw new RuntimeSpeechError(installAction?.diagnosticCode || 'preset_voice_unavailable', 'blocked', '当前没有可安全安装的预设音色');
      }
      this.options.voiceRegistry.registerPreset({
        ...DEFAULT_PRESET_VOICE,
      });
    }
    else if (action === 'speech.renameReferenceVoice') {
      this.options.voiceRegistry.renameReferenceVoice(
        stringValue(input.voiceProfileId, 'voice_profile_id'),
        stringValue(input.displayName, 'display_name'),
      );
    }
    else if (action === 'speech.benchmarkTtsModel') {
      const current = await this.refreshStatus();
      const modelId = stringValue(input.modelId, 'model_id');
      const model = current.ttsModel.options.find((item) => item.id === modelId);
      const benchmarkAction = current.actions.find((item) => item.id === action);
      if (!benchmarkAction?.enabled || !model || current.ttsModel.liveValue !== modelId || !this.options.benchmarkVoice
        || !this.options.benchmarkStore || !this.options.hardwareId) {
        throw new RuntimeSpeechError(
          benchmarkAction?.diagnosticCode || 'tts_model_benchmark_unavailable',
          'blocked',
          '当前模型尚未由 live Runtime 加载，不能执行真实性能测试',
        );
      }
      const requestedVoiceProfileId = typeof input.voiceProfileId === 'string' && input.voiceProfileId.trim()
        ? stringValue(input.voiceProfileId, 'voice_profile_id') : '';
      const configuredProfile = current.voiceProfiles.find((item) => item.id === this.options.config.voiceProfileId
        && item.compatibleTtsModelIds.includes(modelId));
      const voiceProfileId = requestedVoiceProfileId
        || model.defaultVoiceProfileId
        || configuredProfile?.id
        || current.voiceProfiles.find((item) => item.kind === 'reference' && item.compatibleTtsModelIds.includes(modelId))?.id
        || '';
      const profile = current.voiceProfiles.find((item) => item.id === voiceProfileId);
      if (!profile || !profile.compatibleTtsModelIds.includes(modelId)
        || (profile.state !== 'ready' && profile.diagnosticCode !== 'voice_clone_similarity_not_verified')) {
        throw new RuntimeSpeechError('tts_model_benchmark_voice_unavailable', 'blocked', '当前模型没有可用于测试的兼容音色');
      }
      const startedAt = Date.now();
      try {
        const receipt = await this.options.benchmarkVoice({
          modelId,
          voiceProfileId,
          text: '这是一次本地语音模型性能测试。我们会验证中文自然度、稳定性、生成速度和最终音频格式，确保真实使用时能够清晰、自然并可靠地完成回复。',
        });
        const warmSynthesisMs = Date.now() - startedAt;
        const realTimeFactor = warmSynthesisMs / receipt.durationMs;
        const referenceProfile = profile.kind === 'reference';
        const similarityReady = !referenceProfile || (
          receipt.speakerSimilarityPassed === true
          && typeof receipt.speakerSimilarity === 'number'
          && typeof receipt.speakerSimilarityThreshold === 'number'
          && receipt.speakerSimilarity >= receipt.speakerSimilarityThreshold
        );
        const ready = warmSynthesisMs <= 20_000 && similarityReady;
        this.options.benchmarkStore.write({
          modelId,
          providerId: model.providerId,
          revision: receipt.modelRevision || model.benchmark.revision,
          hardwareId: this.options.hardwareId,
          ...(referenceProfile ? { voiceProfileId } : {}),
          state: ready ? 'ready' : 'blocked',
          testedAt: new Date().toISOString(),
          warmSynthesisMs,
          outputDurationMs: receipt.durationMs,
          realTimeFactor,
          ...(receipt.peakVramMiB !== undefined ? { peakVramMiB: receipt.peakVramMiB } : {}),
          ...(receipt.speakerSimilarity !== undefined ? { speakerSimilarity: receipt.speakerSimilarity } : {}),
          ...(receipt.speakerSimilarityThreshold !== undefined ? { speakerSimilarityThreshold: receipt.speakerSimilarityThreshold } : {}),
          ...(receipt.speakerSimilarityPassed !== undefined ? { speakerSimilarityPassed: receipt.speakerSimilarityPassed } : {}),
          ...(ready ? {} : {
            diagnosticCode: similarityReady
              ? 'tts_model_warm_benchmark_too_slow'
              : 'voice_clone_similarity_below_threshold',
          }),
        });
      } catch (error) {
        this.options.benchmarkStore.write({
          modelId,
          providerId: model.providerId,
          revision: model.benchmark.revision,
          hardwareId: this.options.hardwareId,
          ...(profile.kind === 'reference' ? { voiceProfileId } : {}),
          state: 'blocked',
          testedAt: new Date().toISOString(),
          diagnosticCode: error instanceof RuntimeSpeechError ? error.code : 'tts_model_benchmark_failed',
        });
      }
    }
    else if (action === 'speech.benchmarkSingingModel') {
      const current = await this.refreshStatus();
      const benchmarkAction = current.actions.find((item) => item.id === action);
      const modelId = this.options.config.singingModel;
      const revision = current.singingBenchmark.revision;
      const voiceProfileId = this.options.config.singingVoiceProfileId || 'acestep.default';
      if (!benchmarkAction?.enabled || !this.options.benchmarkSingingVoice
        || !this.options.benchmarkStore || !this.options.hardwareId || revision === 'uninstalled') {
        throw new RuntimeSpeechError(
          benchmarkAction?.diagnosticCode || 'singing_benchmark_unavailable',
          'blocked',
          '当前歌声模型尚未由 live Runtime 安全加载，不能执行真实性能测试',
        );
      }
      const startedAt = Date.now();
      try {
        const benchmarkPlan = buildSingingPlan(
          { voiceProfileId },
          'quick_preview',
          this.options.config,
          '[Verse]\n晚风轻轻经过窗前，我把今天唱成温柔的纪念。',
        );
        const receipt = await this.options.benchmarkSingingVoice({
          plan: benchmarkPlan,
          modelId,
          voiceProfileId,
        });
        const warmSynthesisMs = Date.now() - startedAt;
        const realTimeFactor = warmSynthesisMs / receipt.durationMs;
        const peakVramMiB = receipt.peakVramMiB;
        const memoryReady = Number.isFinite(peakVramMiB)
          && peakVramMiB! > 0
          && Number.isFinite(this.options.gpuMemoryMiB)
          && peakVramMiB! <= this.options.gpuMemoryMiB!;
        const referenceVoice = voiceProfileId !== 'acestep.default';
        const lyricsReady = receipt.lyricsAlignmentPassed === true
          && typeof receipt.lyricsAlignment === 'number'
          && typeof receipt.lyricsAlignmentThreshold === 'number'
          && receipt.lyricsAlignment >= receipt.lyricsAlignmentThreshold;
        const similarityReady = !referenceVoice || (
          receipt.speakerSimilarityPassed === true
          && typeof receipt.speakerSimilarity === 'number'
          && typeof receipt.speakerSimilarityThreshold === 'number'
          && receipt.speakerSimilarity >= receipt.speakerSimilarityThreshold
        );
        const ready = warmSynthesisMs <= 180_000 && memoryReady && lyricsReady && similarityReady;
        const diagnosticCode = ready
          ? undefined
          : !lyricsReady
            ? 'singing_lyrics_alignment_below_threshold'
            : !similarityReady
              ? 'singing_voice_similarity_below_threshold'
              : memoryReady
                ? 'singing_warm_benchmark_too_slow'
                : 'singing_vram_benchmark_unavailable_or_exceeded';
        const commonRecord = {
          modelId,
          providerId: this.options.config.singingProvider,
          revision,
          hardwareId: this.options.hardwareId,
          state: ready ? 'ready' : 'blocked',
          testedAt: new Date().toISOString(),
          warmSynthesisMs,
          outputDurationMs: receipt.durationMs,
          realTimeFactor,
          ...(peakVramMiB !== undefined ? { peakVramMiB } : {}),
          ...(receipt.lyricsAlignment !== undefined ? { lyricsAlignment: receipt.lyricsAlignment } : {}),
          ...(receipt.lyricsAlignmentThreshold !== undefined ? { lyricsAlignmentThreshold: receipt.lyricsAlignmentThreshold } : {}),
          ...(receipt.lyricsAlignmentPassed !== undefined ? { lyricsAlignmentPassed: receipt.lyricsAlignmentPassed } : {}),
          ...(diagnosticCode ? { diagnosticCode } : {}),
        } as const;
        // 全局记录只代表模型性能与歌词能力；参考音色验收另写精确 Profile 记录。
        this.options.benchmarkStore.write(commonRecord);
        if (referenceVoice) {
          this.options.benchmarkStore.write({
            ...commonRecord,
            voiceProfileId,
            ...(receipt.speakerSimilarity !== undefined ? { speakerSimilarity: receipt.speakerSimilarity } : {}),
            ...(receipt.speakerSimilarityThreshold !== undefined ? { speakerSimilarityThreshold: receipt.speakerSimilarityThreshold } : {}),
            ...(receipt.speakerSimilarityPassed !== undefined ? { speakerSimilarityPassed: receipt.speakerSimilarityPassed } : {}),
          });
        }
      } catch (error) {
        const qualityMetrics = error instanceof RuntimeSpeechError ? error.qualityMetrics : undefined;
        const failureRecord = {
          modelId,
          providerId: this.options.config.singingProvider,
          revision,
          hardwareId: this.options.hardwareId,
          state: 'blocked',
          testedAt: new Date().toISOString(),
          ...(qualityMetrics?.lyricsAlignment !== undefined ? { lyricsAlignment: qualityMetrics.lyricsAlignment } : {}),
          ...(qualityMetrics?.lyricsAlignmentThreshold !== undefined ? { lyricsAlignmentThreshold: qualityMetrics.lyricsAlignmentThreshold } : {}),
          ...(qualityMetrics?.lyricsAlignmentPassed !== undefined ? { lyricsAlignmentPassed: qualityMetrics.lyricsAlignmentPassed } : {}),
          diagnosticCode: error instanceof RuntimeSpeechError ? error.code : 'singing_benchmark_failed',
        } as const;
        this.options.benchmarkStore.write(failureRecord);
        if (voiceProfileId !== 'acestep.default') {
          this.options.benchmarkStore.write({ ...failureRecord, voiceProfileId });
        }
      }
    }
    else if (action === 'speech.importReferenceVoice') {
      if (input.transcriptConfirmed !== true) {
        throw new RuntimeSpeechError('voice_reference_transcript_unconfirmed', 'blocked', '参考文本尚未逐字确认');
      }
      if (!this.options.verifyReferenceTranscript) {
        throw new RuntimeSpeechError(
          'speech_reference_transcript_live_runtime_unavailable',
          'blocked',
          '实时参考文本核对通道不可用',
        );
      }
      const sourcePath = stringValue(input.sourcePath, 'source_path');
      const confirmedTranscript = stringValue(input.transcript, 'transcript');
      const verification = await this.options.verifyReferenceTranscript({ sourcePath, confirmedTranscript });
      if (verification.protocol !== 'cti-speech-reference-transcript-verification/v1'
        || verification.transcriptStatus !== 'matched'
        || verification.validated !== true
        || !/^[a-f0-9]{64}$/u.test(verification.sourceSha256)) {
        throw new RuntimeSpeechError('speech_reference_transcript_response_invalid', 'error', '参考文本核对响应无效');
      }
      await this.options.voiceRegistry.importReferenceVoice({
        sourcePath,
        expectedSha256: verification.sourceSha256,
        displayName: stringValue(input.displayName, 'display_name'),
        transcript: confirmedTranscript,
        sourceLabel: stringValue(input.sourceLabel, 'source_label'),
        license: stringValue(input.license, 'license'),
        authorizationConfirmed: input.authorizationConfirmed === true,
        cleanSingleSpeakerConfirmed: input.cleanSingleSpeakerConfirmed === true,
      });
    } else if (action === 'speech.deleteReferenceVoice') {
      const voiceProfileId = stringValue(input.voiceProfileId, 'voice_profile_id');
      const profile = this.options.voiceRegistry.list().find((item) => item.id === voiceProfileId);
      if (!profile) {
        // Runtime 必须自己根据受管注册表重新解析身份，不能相信前端传入的 kind 或路径。
        this.options.voiceRegistry.resolveProfile(voiceProfileId);
        throw new RuntimeSpeechError('voice_preset_delete_forbidden', 'blocked', '预设音色不能从音色库删除');
      }
      if (profile.kind !== 'reference') {
        throw new RuntimeSpeechError('voice_preset_delete_forbidden', 'blocked', '预设音色不能从音色库删除');
      }
      if (!this.options.benchmarkStore) {
        throw new RuntimeSpeechError('speech_benchmark_store_unavailable', 'error', '音色验收记录存储不可用，未执行删除');
      }

      const activeForSpeech = this.options.config.voiceProfileId === voiceProfileId;
      const activeForSinging = this.options.config.singingVoiceProfileId === voiceProfileId;
      if (activeForSpeech || activeForSinging) {
        let fallbackVoiceProfileId: string | undefined;
        if (activeForSpeech) {
          const model = findSpeechModel(this.options.config.ttsModelId);
          const candidate = model?.defaultVoiceProfileId;
          if (candidate && candidate !== voiceProfileId) {
            try {
              const fallback = this.options.voiceRegistry.resolveProfile(candidate);
              if (fallback.kind === 'preset' && fallback.compatibleTtsModelIds.includes(model!.id)) {
                fallbackVoiceProfileId = candidate;
              }
            } catch {
              // 当前模型没有安全可用的默认预设时清空，让 Runtime 明确回到“未选择音色”。
            }
          }
        }
        const nextConfig: SpeechRuntimeConfig = {
          ...this.options.config,
          ...(activeForSpeech ? { voiceProfileId: fallbackVoiceProfileId } : {}),
          ...(activeForSinging ? { singingVoiceProfileId: undefined } : {}),
        };
        this.options.saveConfig(nextConfig);
        Object.assign(this.options.config, nextConfig);
      }

      // 先清除身份验收结论，再删除注册表与参考音频；失败时最多要求重新验收，不会复用旧结论。
      this.options.benchmarkStore.deleteVoiceProfile(voiceProfileId);
      this.options.voiceRegistry.deleteReferenceVoice(voiceProfileId);
    } else if (action === 'speech.previewVoice') {
      const current = await this.refreshStatus();
      const previewAction = current.actions.find((item) => item.id === action);
      if (!previewAction?.enabled) {
        throw new RuntimeSpeechError(
          previewAction?.diagnosticCode || 'speech_preview_unavailable',
          'blocked',
          '当前实时语音服务无法安全试听',
        );
      }
      if (!this.options.previewVoice) {
        throw new RuntimeSpeechError('speech_preview_live_runtime_unavailable', 'error', '实时 Bridge 试听通道不可用');
      }
      const text = stringValue(input.text, 'preview_text');
      if (Array.from(text).length > MAX_SPEECH_PREVIEW_TEXT_CHARACTERS) {
        throw new RuntimeSpeechError('speech_preview_text_too_long', 'blocked', '语音试听文本超过长度限制');
      }
      const voiceProfileId = stringValue(input.voiceProfileId, 'voice_profile_id');
      const modelId = stringValue(input.modelId, 'model_id');
      if (modelId !== current.ttsModel.value || modelId !== current.ttsModel.liveValue || current.ttsModel.restartRequired) {
        throw new RuntimeSpeechError('speech_preview_model_not_loaded', 'blocked', '所选模型尚未由 live Runtime 加载');
      }
      const profile = current.voiceProfiles.find((item) => item.id === voiceProfileId);
      if (!profile || profile.state !== 'ready' || !profile.compatibleTtsModelIds.includes(modelId)) {
        throw new RuntimeSpeechError(
          profile?.diagnosticCode || 'speech_preview_voice_profile_unavailable',
          'blocked',
          '所选音色当前不可试听',
        );
      }
      return this.options.previewVoice({ text, modelId, voiceProfileId });
    } else if (action === 'speech.previewSingingVoice' || action === 'speech.generateSinging') {
      const current = await this.refreshStatus();
      const generationAction = current.actions.find((item) => item.id === action);
      const generate = action === 'speech.generateSinging' ? this.options.generateSinging : this.options.previewSingingVoice;
      if (!generationAction?.enabled || !generate) {
        throw new RuntimeSpeechError(generationAction?.diagnosticCode || 'singing_preview_unavailable', 'blocked', '当前实时歌声服务无法安全生成');
      }
      const singingInputKeys = new Set([
        'providerId', 'voiceProfileId', 'lyrics', 'stylePrompt',
        'vocalLanguage', 'durationSeconds', 'melodyMode',
      ]);
      if (Object.keys(input).some((key) => !singingInputKeys.has(key))) {
        throw new RuntimeSpeechError('singing_generation_payload_invalid', 'blocked', '歌声生成参数包含未声明字段');
      }
      const providerId = stringValue(input.providerId, 'singing_provider_id');
      if (providerId !== current.singingProvider.value || providerId !== this.options.config.singingProvider) {
        throw new RuntimeSpeechError('singing_provider_not_active', 'blocked', '所选歌声 Provider 尚未由 live Runtime 激活');
      }
      const requestedVoiceProfileId = stringValue(input.voiceProfileId, 'singing_voice_profile_id', true);
      const voiceProfileId = requestedVoiceProfileId || 'acestep.default';
      const activeVoiceProfileId = this.options.config.singingVoiceProfileId || 'acestep.default';
      if (voiceProfileId !== activeVoiceProfileId) {
        throw new RuntimeSpeechError('singing_voice_profile_not_active', 'blocked', '所选歌声音色尚未由 live Runtime 激活');
      }
      if (voiceProfileId !== 'acestep.default') {
        const profile = current.voiceProfiles.find((item) => item.id === voiceProfileId);
        if (!profile || profile.state !== 'ready' || !profile.capabilities.includes('singing')) {
          throw new RuntimeSpeechError(profile?.diagnosticCode || 'singing_preview_voice_profile_unavailable', 'blocked', '所选歌声音色当前不可试听');
        }
        if (profile.singingAcceptance.state !== 'passed') {
          throw new RuntimeSpeechError(
            profile.singingAcceptance.diagnosticCode || 'singing_voice_similarity_not_verified',
            'blocked',
            '所选参考音色尚未通过歌声相似度与歌词对齐验收',
          );
        }
      }
      const plan = buildSingingPlan(
        { ...input, voiceProfileId },
        action === 'speech.generateSinging' ? 'full_generation' : 'quick_preview',
        this.options.config,
      );
      return generate({ plan, modelId: this.options.config.singingModel, voiceProfileId });
    } else if (action === 'speech.activateVoiceProfile') {
      const voiceProfileId = stringValue(input.voiceProfileId, 'voice_profile_id');
      const profile = this.options.voiceRegistry.resolveProfile(voiceProfileId);
      const current = await this.refreshStatus();
      const model = current.ttsModel.options.find((item) => item.id === current.ttsModel.value);
      if (!model || !profile.compatibleTtsModelIds.includes(model.id)) {
        throw new RuntimeSpeechError('voice_profile_model_incompatible', 'blocked', '所选音色与当前模型不兼容');
      }
      if (profile.kind === 'reference' && this.options.config.requireVoiceSimilarityAcceptance && !this.referenceBenchmarkReady(model, voiceProfileId)) {
        throw new RuntimeSpeechError('voice_clone_similarity_not_verified', 'blocked', '参考音色尚未通过本机说话人相似度门禁');
      }
      this.options.config.voiceProfileId = voiceProfileId;
      this.options.saveConfig({ ...this.options.config });
    }
    return this.refreshStatus(false);
  }

  private referenceBenchmarkReady(
    model: SpeechStatusContract['ttsModel']['options'][number],
    voiceProfileId: string,
  ): boolean {
    if (!this.options.benchmarkStore || !this.options.hardwareId || !voiceProfileId) return false;
    const benchmark = this.options.benchmarkStore.find({
      modelId: model.id,
      providerId: model.providerId,
      revision: model.benchmark.revision,
      hardwareId: this.options.hardwareId,
      voiceProfileId,
    });
    return speakerSimilarityAcceptanceRecorded(benchmark);
  }

  private async saveSettings(input: Record<string, unknown>): Promise<void> {
    const current = await this.refreshStatus();
    if (input.schema !== 'codex-im-suite/speech-settings/v2') throw new RuntimeSpeechError('speech_settings_schema_invalid', 'blocked', '语音设置协议版本不匹配');
    const canonical = input as unknown as SpeechSettingsContract & { channelIds?: string[]; channelId?: string };
    const requestedChannels = Array.isArray(canonical.channelIds)
      ? canonical.channelIds.map((item) => stringValue(item, 'channel_id'))
      : canonical.channelId ? [stringValue(canonical.channelId, 'channel_id')] : [];
    if (requestedChannels.length === 0 || requestedChannels.some((id) => !current.channels.some((channel) => channel.id === id && channel.enabled))) {
      throw new RuntimeSpeechError('speech_channel_invalid', 'blocked', '所选渠道不在 Runtime 能力列表中');
    }
    for (const field of ['replyPolicy', 'deliveryMode', 'asrProvider', 'ttsProvider', 'tonePolicy', 'singingProvider'] as const) {
      const requestedValue = stringValue(canonical[field], field);
      // 运行态配置可能保留一个已知 blocked 的旧选择（例如旧模型不支持的
      // tone policy）。编辑其它独立设置时允许原样保留它，但绝不允许把一个
      // 新的 disabled 选项写入配置；真实运行入口仍会报告该旧选择的诊断。
      const preservingCurrentValue = requestedValue === current[field].value;
      if (!hasOption(current, field, requestedValue) && !preservingCurrentValue) {
        throw new RuntimeSpeechError(`speech_${field}_invalid`, 'blocked', '所选语音能力不在 Runtime 声明列表中');
      }
    }
    const ttsModelId = stringValue(canonical.ttsModelId, 'tts_model_id');
    const ttsModel = current.ttsModel.options.find((item) => item.id === ttsModelId && item.enabled);
    if (!ttsModel || ttsModel.providerId !== canonical.ttsProvider || !findSpeechModel(ttsModelId)) {
      throw new RuntimeSpeechError('speech_tts_model_invalid', 'blocked', '所选语音模型不属于当前 Provider 或当前不可用');
    }
    const activeVoiceProfileId = stringValue(canonical.activeVoiceProfileId, 'voice_profile_id', true);
    const activeSingingVoiceProfileId = stringValue(canonical.activeSingingVoiceProfileId, 'singing_voice_profile_id', true);
    if (activeVoiceProfileId) {
      const profile = this.options.voiceRegistry.resolveProfile(activeVoiceProfileId);
      if (!profile.compatibleTtsModelIds.includes(ttsModelId)) {
        throw new RuntimeSpeechError('voice_profile_model_incompatible', 'blocked', '所选音色与语音模型不兼容');
      }
      // 保存歌声音色等相邻设置时，不能因为“当前已持久化的说话参考音色”
      // 的历史基准失败而阻断整次保存。该旧选择依然会在真正 TTS 合成时被
      // Runtime 门禁拦截；只有本次试图切换到一个新的参考音色时才签发新的
      // 说话音色准入，避免把无关设置改动误写成克隆验收通过。
      const selectingDifferentSpeechReference = activeVoiceProfileId !== (this.options.config.voiceProfileId || '');
      if (profile.kind === 'reference'
        && selectingDifferentSpeechReference
        && this.options.config.requireVoiceSimilarityAcceptance
        && !this.referenceBenchmarkReady(ttsModel, activeVoiceProfileId)) {
        throw new RuntimeSpeechError('voice_clone_similarity_not_verified', 'blocked', '参考音色尚未通过本机说话人相似度门禁');
      }
    }
    if (activeSingingVoiceProfileId) {
      const profile = current.voiceProfiles.find((item) => item.id === activeSingingVoiceProfileId);
      if (!profile || !profile.capabilities.includes('singing')) {
        throw new RuntimeSpeechError('singing_voice_profile_invalid', 'blocked', '所选音色不能用于歌声合成');
      }
    }
    const next: SpeechRuntimeConfig = {
      ...this.options.config,
      inputEnabled: canonical.inputEnabled === true,
      outputEnabled: canonical.outputEnabled === true,
      singingEnabled: canonical.singingEnabled === true,
      channels: [...new Set(requestedChannels)],
      replyPolicy: canonical.replyPolicy,
      deliveryMode: canonical.deliveryMode,
      asrProvider: canonical.asrProvider,
      ttsProvider: canonical.ttsProvider,
      ttsModelId,
      tonePolicy: canonical.tonePolicy,
      singingProvider: canonical.singingProvider,
      voiceProfileId: activeVoiceProfileId || undefined,
      singingVoiceProfileId: activeSingingVoiceProfileId || undefined,
    };
    Object.assign(this.options.config, next);
    this.options.saveConfig(next);
  }
}
