import type { SpeechSettingsContract, SpeechStatusContract } from '@codex-im-suite/contracts/speech';

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

export const SPEECH_CONTROL_ACTIONS = [
  'speech.refresh',
  'speech.saveSettings',
  'speech.installComponent',
  'speech.installPresetVoice',
  'speech.benchmarkTtsModel',
  'speech.importReferenceVoice',
  'speech.previewVoice',
  'speech.previewSingingVoice',
  'speech.activateVoiceProfile',
] as const;

export type SpeechControlAction = typeof SPEECH_CONTROL_ACTIONS[number];

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeSpeechError('speech_payload_invalid', 'blocked', '语音命令参数无效');
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string') throw new RuntimeSpeechError(`speech_${field}_invalid`, 'blocked', '语音命令参数无效');
  const normalized = value.trim();
  if ((!normalized && !allowEmpty) || normalized.length > 4_000) throw new RuntimeSpeechError(`speech_${field}_invalid`, 'blocked', '语音命令参数无效');
  return normalized;
}

function hasOption(status: SpeechStatusContract, field: 'replyPolicy' | 'deliveryMode' | 'asrProvider' | 'ttsProvider' | 'tonePolicy' | 'singingProvider', value: string): boolean {
  return status[field].options.some((option) => option.id === value && option.enabled);
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
    previewSingingVoice?: (input: {
      text: string;
      modelId: string;
      voiceProfileId: string;
    }) => Promise<SpeechPreviewReceipt>;
    benchmarkStore?: SpeechModelBenchmarkStore;
    hardwareId?: string;
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
      const configuredProfile = current.voiceProfiles.find((item) => item.id === this.options.config.voiceProfileId
        && item.compatibleTtsModelIds.includes(modelId));
      const voiceProfileId = model.defaultVoiceProfileId
        || configuredProfile?.id
        || current.voiceProfiles.find((item) => item.kind === 'reference' && item.compatibleTtsModelIds.includes(modelId))?.id
        || '';
      const profile = current.voiceProfiles.find((item) => item.id === voiceProfileId);
      if (!profile || !profile.compatibleTtsModelIds.includes(modelId)
        || (profile.state !== 'ready' && profile.diagnosticCode !== 'voice_clone_benchmark_not_verified')) {
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
        const ready = warmSynthesisMs <= 20_000;
        this.options.benchmarkStore.write({
          modelId,
          providerId: model.providerId,
          revision: receipt.modelRevision || model.benchmark.revision,
          hardwareId: this.options.hardwareId,
          state: ready ? 'ready' : 'blocked',
          testedAt: new Date().toISOString(),
          warmSynthesisMs,
          outputDurationMs: receipt.durationMs,
          realTimeFactor,
          ...(receipt.peakVramMiB !== undefined ? { peakVramMiB: receipt.peakVramMiB } : {}),
          ...(ready ? {} : { diagnosticCode: 'tts_model_warm_benchmark_too_slow' }),
        });
      } catch (error) {
        this.options.benchmarkStore.write({
          modelId,
          providerId: model.providerId,
          revision: model.benchmark.revision,
          hardwareId: this.options.hardwareId,
          state: 'blocked',
          testedAt: new Date().toISOString(),
          diagnosticCode: error instanceof RuntimeSpeechError ? error.code : 'tts_model_benchmark_failed',
        });
      }
    }
    else if (action === 'speech.importReferenceVoice') {
      await this.options.voiceRegistry.importReferenceVoice({
        sourcePath: stringValue(input.sourcePath, 'source_path'),
        displayName: stringValue(input.displayName, 'display_name'),
        transcript: stringValue(input.transcript, 'transcript'),
        sourceLabel: stringValue(input.sourceLabel, 'source_label'),
        license: stringValue(input.license, 'license'),
        authorizationConfirmed: input.authorizationConfirmed === true,
        cleanSingleSpeakerConfirmed: input.cleanSingleSpeakerConfirmed === true,
      });
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
    } else if (action === 'speech.previewSingingVoice') {
      const current = await this.refreshStatus();
      const previewAction = current.actions.find((item) => item.id === action);
      if (!previewAction?.enabled || !this.options.previewSingingVoice) {
        throw new RuntimeSpeechError(previewAction?.diagnosticCode || 'singing_preview_unavailable', 'blocked', '当前实时歌声服务无法安全试听');
      }
      const text = stringValue(input.text, 'singing_preview_text');
      if (Array.from(text).length > MAX_SPEECH_PREVIEW_TEXT_CHARACTERS) {
        throw new RuntimeSpeechError('singing_preview_text_too_long', 'blocked', '歌声试听歌词超过长度限制');
      }
      const voiceProfileId = stringValue(input.voiceProfileId, 'singing_voice_profile_id');
      if (voiceProfileId !== 'acestep.default') {
        const profile = current.voiceProfiles.find((item) => item.id === voiceProfileId);
        if (!profile || profile.state !== 'ready' || !profile.capabilities.includes('singing')) {
          throw new RuntimeSpeechError(profile?.diagnosticCode || 'singing_preview_voice_profile_unavailable', 'blocked', '所选歌声音色当前不可试听');
        }
      }
      return this.options.previewSingingVoice({ text, modelId: this.options.config.singingModel, voiceProfileId });
    } else if (action === 'speech.activateVoiceProfile') {
      const voiceProfileId = stringValue(input.voiceProfileId, 'voice_profile_id');
      const profile = this.options.voiceRegistry.resolveProfile(voiceProfileId);
      const current = await this.refreshStatus();
      const model = current.ttsModel.options.find((item) => item.id === current.ttsModel.value);
      if (!model || !profile.compatibleTtsModelIds.includes(model.id)) {
        throw new RuntimeSpeechError('voice_profile_model_incompatible', 'blocked', '所选音色与当前模型不兼容');
      }
      if (profile.kind === 'reference' && model.benchmark.state !== 'ready') {
        throw new RuntimeSpeechError('voice_clone_benchmark_not_verified', 'blocked', '参考音色尚未通过本机性能门禁');
      }
      this.options.config.voiceProfileId = voiceProfileId;
      this.options.saveConfig({ ...this.options.config });
    }
    return this.refreshStatus(false);
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
      if (!hasOption(current, field, stringValue(canonical[field], field))) {
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
      if (profile.kind === 'reference' && ttsModel.benchmark.state !== 'ready') {
        throw new RuntimeSpeechError('voice_clone_benchmark_not_verified', 'blocked', '参考音色尚未通过本机性能门禁');
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
