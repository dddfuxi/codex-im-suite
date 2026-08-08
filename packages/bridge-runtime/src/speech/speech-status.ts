import type {
  SpeechComponentContract,
  SpeechModelBenchmarkContract,
  SpeechModelOptionContract,
  SpeechSelectionContract,
  SpeechState,
  SpeechStatusContract,
} from '@codex-im-suite/contracts/speech';

import { RuntimeSpeechError, type SpeechRuntimeConfig } from './runtime-types.js';
import type { AceStepSingingHost } from './ace-step-singing-host.js';
import { RuntimeSpeechHost } from './runtime-speech-host.js';
import { SpeechVoiceRegistry } from './voice-registry.js';
import { MAX_SPEECH_PREVIEW_TEXT_CHARACTERS } from './speech-preview.js';
import type { SpeechModelBenchmarkStore } from './speech-model-benchmark-store.js';
import {
  DEFAULT_TONE_POLICY_ID,
  SPEECH_MODEL_CATALOG,
  findSpeechModel,
  listSpeechProviders,
} from './speech-model-catalog.js';

export interface ManagedSpeechComponentStatus {
  id: string;
  displayName: string;
  kind: string;
  state: SpeechState;
  version?: string;
  capabilities: string[];
  diagnosticCode?: string;
  installable: boolean;
}

function selection(
  value: string,
  options: Array<{ id: string; displayName: string; state: SpeechState; enabled: boolean; diagnosticCode?: string }>,
): SpeechSelectionContract {
  return { value, options };
}

function worstState(states: SpeechState[]): SpeechState {
  if (states.includes('error')) return 'error';
  if (states.includes('blocked')) return 'blocked';
  if (states.includes('optional_missing')) return 'optional_missing';
  return 'ready';
}

function unavailableCapabilityState(sidecarState: SpeechState, manifestState?: SpeechState): Exclude<SpeechState, 'ready'> {
  if (sidecarState === 'error' || manifestState === 'error') return 'error';
  if (sidecarState === 'blocked' || manifestState === 'blocked') return 'blocked';
  return 'optional_missing';
}

export class SpeechRuntimeStatusService {
  constructor(private readonly options: {
    config: SpeechRuntimeConfig;
    host: RuntimeSpeechHost;
    voiceRegistry: SpeechVoiceRegistry;
    listManagedComponents?: () => ManagedSpeechComponentStatus[];
    now?: () => Date;
    previewAvailable?: () => boolean;
    singingHost?: AceStepSingingHost;
    benchmarkStore?: SpeechModelBenchmarkStore;
    hardwareId?: string;
  }) {}

  async refresh(input: { probeSidecar?: boolean; signal?: AbortSignal } = {}): Promise<SpeechStatusContract> {
    const config = this.options.config;
    const dependencies = this.options.host.getDependencySnapshot();
    const dependencyComponents: SpeechComponentContract[] = [
      { ...dependencies.ffmpeg, kind: 'binary', capabilities: ['audio_probe', 'audio_convert'], installable: false },
      { ...dependencies.ffprobe, kind: 'binary', capabilities: ['audio_probe'], installable: false },
      { ...dependencies.python, kind: 'runtime', capabilities: ['sidecar_runtime'], installable: false },
      { ...dependencies.sidecar, kind: 'sidecar', capabilities: ['asr', 'tts'], installable: false },
    ].map(({ source: _source, path: _path, ...item }) => item);
    const managed = this.options.listManagedComponents?.() || [];
    const managedComponents: SpeechComponentContract[] = managed.map((item) => ({ ...item }));

    let sidecarState: SpeechState = 'optional_missing';
    let sidecarDiagnostic = 'speech_disabled';
    let asrReady = false;
    let ttsReady = false;
    let liveTtsProviderId = '';
    let liveTtsModelId = '';
    let liveTtsRevision = '';
    const speechEnabled = config.inputEnabled || config.outputEnabled;
    const anyAudioCapabilityEnabled = speechEnabled || config.singingEnabled;
    const dependenciesReady = Object.values(dependencies).every((item) => item.state === 'ready');
    if (speechEnabled && dependenciesReady && input.probeSidecar !== false) {
      try {
        const client = await this.options.host.sidecar.ensureClient(input.signal);
        const health = await client.health(input.signal);
        sidecarState = health.status;
        sidecarDiagnostic = health.diagnosticCode || '';
        asrReady = health.capabilities.asr;
        liveTtsProviderId = health.tts?.providerId || '';
        liveTtsModelId = health.tts?.modelId || '';
        liveTtsRevision = health.tts?.revision || '';
        ttsReady = health.capabilities.tts
          && liveTtsProviderId === config.ttsProvider
          && liveTtsModelId === config.ttsModelId
          && Boolean(liveTtsRevision);
        if (health.capabilities.tts && !ttsReady) sidecarDiagnostic = 'tts_live_model_identity_mismatch';
      } catch (error) {
        if (error instanceof RuntimeSpeechError) {
          sidecarState = error.status;
          sidecarDiagnostic = error.code;
        } else {
          sidecarState = 'error';
          sidecarDiagnostic = 'sidecar_health_failed';
        }
      }
    } else if (speechEnabled) {
      const dependencyState = worstState(Object.values(dependencies).map((item) => item.state));
      sidecarState = dependencyState === 'ready' ? 'optional_missing' : dependencyState;
      sidecarDiagnostic = dependencyState === 'ready'
        ? 'sidecar_probe_skipped'
        : Object.values(dependencies).find((item) => item.state !== 'ready')?.diagnosticCode || 'speech_dependency_missing';
    }

    const asrManifest = managed.find((item) => item.id === config.asrProvider || item.capabilities.includes('asr'));
    const selectedModel = findSpeechModel(config.ttsModelId);
    const ttsManifest = selectedModel
      ? managed.find((item) => item.id === selectedModel.componentId)
      : undefined;
    // manifest ready 只表示文件已安装；能力 ready 只能来自本轮真实 Sidecar health。
    const asrState: SpeechState = asrReady ? 'ready' : unavailableCapabilityState(sidecarState, asrManifest?.state);
    const ttsState: SpeechState = ttsReady ? 'ready' : unavailableCapabilityState(sidecarState, ttsManifest?.state);
    const asrDiagnostic = asrReady ? undefined : (asrManifest?.state !== 'ready' ? asrManifest?.diagnosticCode : undefined) || sidecarDiagnostic || 'asr_backend_missing';
    const ttsDiagnostic = ttsReady ? undefined : (ttsManifest?.state !== 'ready' ? ttsManifest?.diagnosticCode : undefined) || sidecarDiagnostic || 'tts_backend_missing';
    const hardwareId = this.options.hardwareId || '0'.repeat(64);
    const modelOptions: SpeechModelOptionContract[] = SPEECH_MODEL_CATALOG.map((model) => {
      const component = managed.find((item) => item.id === model.componentId);
      const isLive = liveTtsProviderId === model.providerId && liveTtsModelId === model.id && Boolean(liveTtsRevision);
      const modelState: SpeechState = isLive && ttsReady
        ? 'ready'
        : component?.state || 'optional_missing';
      const revision = isLive ? liveTtsRevision : component?.version || 'uninstalled';
      const benchmark = this.options.benchmarkStore?.find({
        modelId: model.id,
        providerId: model.providerId,
        revision,
        hardwareId,
      });
      const benchmarkStatus: SpeechModelBenchmarkContract = benchmark
        ? {
            state: benchmark.state,
            revision: benchmark.revision,
            ...(benchmark.testedAt ? { testedAt: benchmark.testedAt } : {}),
            ...(benchmark.coldStartMs !== undefined ? { coldStartMs: benchmark.coldStartMs } : {}),
            ...(benchmark.warmSynthesisMs !== undefined ? { warmSynthesisMs: benchmark.warmSynthesisMs } : {}),
            ...(benchmark.outputDurationMs !== undefined ? { outputDurationMs: benchmark.outputDurationMs } : {}),
            ...(benchmark.realTimeFactor !== undefined ? { realTimeFactor: benchmark.realTimeFactor } : {}),
            ...(benchmark.peakVramMiB !== undefined ? { peakVramMiB: benchmark.peakVramMiB } : {}),
            ...(benchmark.diagnosticCode ? { diagnosticCode: benchmark.diagnosticCode } : {}),
          }
        : {
            state: modelState === 'blocked' || modelState === 'error' ? modelState : 'optional_missing',
            revision,
            diagnosticCode: modelState === 'blocked' || modelState === 'error'
              ? component?.diagnosticCode || 'tts_model_unavailable'
              : 'tts_model_benchmark_not_run',
          };
      return {
        id: model.id,
        displayName: model.displayName,
        state: modelState,
        enabled: modelState !== 'blocked' && modelState !== 'error',
        providerId: model.providerId,
        variant: model.variant,
        sizeLabel: model.sizeLabel,
        componentId: model.componentId,
        capabilities: [...model.capabilities],
        defaultVoiceProfileId: model.defaultVoiceProfileId,
        benchmark: benchmarkStatus,
        ...(modelState !== 'ready' ? { diagnosticCode: component?.diagnosticCode || 'tts_model_not_loaded' } : {}),
      };
    });
    const configuredModelOption = modelOptions.find((item) => item.id === config.ttsModelId);
    const configuredModelBenchmarkReady = configuredModelOption?.benchmark.state === 'ready';
    const singingManifest = managed.find((item) => item.id === config.singingProvider || item.capabilities.includes('singing'));
    const singingHealth = config.singingEnabled && this.options.singingHost
      ? await this.options.singingHost.health(input.signal)
      : { state: 'blocked' as const, diagnosticCode: config.singingEnabled ? 'singing_host_unavailable' : 'singing_disabled' };
    const singingReady = singingHealth.state === 'ready' && config.singingBenchmarkPassed;
    const singingState: SpeechState = singingReady
      ? 'ready'
      : unavailableCapabilityState(singingHealth.state, singingManifest?.state);
    const singingDiagnostic = singingReady
      ? undefined
      : (singingManifest?.state !== 'ready' ? singingManifest?.diagnosticCode : undefined)
        || (!config.singingBenchmarkPassed ? 'singing_benchmark_not_verified' : singingHealth.diagnosticCode)
        || 'singing_backend_missing';

    const activeCapabilities: Array<{ state: SpeechState; diagnosticCode?: string }> = [];
    if (config.inputEnabled) activeCapabilities.push({ state: asrState, diagnosticCode: asrDiagnostic });
    if (config.outputEnabled) activeCapabilities.push({ state: ttsState, diagnosticCode: ttsDiagnostic });
    if (config.singingEnabled) activeCapabilities.push({ state: singingState, diagnosticCode: singingDiagnostic });
    const state = anyAudioCapabilityEnabled ? worstState(activeCapabilities.map((item) => item.state)) : 'optional_missing';
    const diagnosticCode = anyAudioCapabilityEnabled
      ? (state === 'ready'
        ? undefined
        : activeCapabilities.find((item) => item.state === state)?.diagnosticCode || 'speech_dependency_missing')
      : 'speech_disabled';
    const profiles = this.options.voiceRegistry.listSummaries(config.voiceProfileId).map((profile) => {
      const active = profile.id === config.voiceProfileId || profile.id === config.singingVoiceProfileId;
      if (!profile.compatibleTtsModelIds.includes(config.ttsModelId) && profile.capabilities.includes('speech')) {
        return { ...profile, active, state: 'blocked' as const, diagnosticCode: 'voice_profile_model_incompatible' };
      }
      if (profile.kind === 'reference' && !configuredModelBenchmarkReady) {
        return { ...profile, active, state: 'blocked' as const, diagnosticCode: 'voice_clone_benchmark_not_verified' };
      }
      if (profile.state === 'ready' && !ttsReady && !(profile.capabilities.includes('singing') && singingReady)) {
        return { ...profile, active, state: ttsState, ...(ttsDiagnostic ? { diagnosticCode: ttsDiagnostic } : {}) };
      }
      return { ...profile, active };
    });
    const knownChannels = [...new Set(['feishu', ...config.channels])];
    const hasInstallable = managed.some((item) => item.installable);
    const presetInstallEnabled = false;
    const presetInstallDiagnostic = 'preset_voice_is_model_capability';
    const previewTransportReady = this.options.previewAvailable?.() === true;
    const hasReadyVoiceProfile = profiles.some((item) => item.state === 'ready');
    const previewEnabled = ttsReady && hasReadyVoiceProfile && previewTransportReady;
    const previewDiagnostic = !ttsReady
      ? (ttsDiagnostic || 'tts_backend_missing')
      : !hasReadyVoiceProfile
        ? 'speech_preview_voice_profile_unavailable'
        : !previewTransportReady
          ? 'speech_preview_live_runtime_unavailable'
          : undefined;

    return {
      protocol: 'codex-im-suite/speech-status/v2',
      state,
      inputEnabled: config.inputEnabled,
      outputEnabled: config.outputEnabled,
      singingEnabled: config.singingEnabled,
      channels: knownChannels.map((id) => {
        const supported = id === 'feishu';
        return {
          id,
          displayName: id === 'feishu' ? '飞书' : id,
          state: supported ? 'ready' : 'optional_missing',
          enabled: supported,
          inputSupported: supported,
          outputSupported: supported,
          selected: config.channels.includes(id),
          ...(!supported ? { diagnosticCode: 'channel_speech_unsupported' } : {}),
        };
      }),
      replyPolicy: selection(config.replyPolicy, [
        { id: 'explicit_or_inbound_audio', displayName: '明确要求或收到语音时回复语音', state: 'ready', enabled: true },
        { id: 'explicit_only', displayName: '仅明确要求时回复语音', state: 'ready', enabled: true },
      ]),
      deliveryMode: selection(config.deliveryMode, [
        { id: 'voice_only', displayName: '语音回复', state: 'ready', enabled: true },
      ]),
      asrProvider: selection(config.asrProvider, [
        { id: 'sensevoice_gguf', displayName: 'SenseVoice GGUF', state: asrState, enabled: true, ...(asrDiagnostic ? { diagnosticCode: asrDiagnostic } : {}) },
      ]),
      ttsProvider: selection(config.ttsProvider, listSpeechProviders().map((provider) => {
        const providerModels = modelOptions.filter((model) => model.providerId === provider.id);
        const providerState = provider.id === liveTtsProviderId && ttsReady
          ? 'ready' as const
          : worstState(providerModels.map((model) => model.state));
        return {
          id: provider.id,
          displayName: provider.displayName,
          state: providerState,
          enabled: providerModels.some((model) => model.enabled),
          ...(providerState !== 'ready' ? { diagnosticCode: 'tts_provider_not_loaded' } : {}),
        };
      })),
      ttsModel: {
        value: config.ttsModelId,
        liveValue: liveTtsModelId,
        restartRequired: config.outputEnabled && liveTtsModelId !== config.ttsModelId,
        options: modelOptions,
      },
      tonePolicy: selection(config.tonePolicy, [
        {
          id: DEFAULT_TONE_POLICY_ID,
          displayName: '自适应自然语气',
          state: selectedModel?.capabilities.includes('instruction_control') ? 'ready' : 'blocked',
          enabled: selectedModel?.capabilities.includes('instruction_control') === true,
          ...(!selectedModel?.capabilities.includes('instruction_control') ? { diagnosticCode: 'tts_model_instruction_control_unsupported' } : {}),
        },
        { id: 'neutral_stable', displayName: '稳定中性语气', state: 'ready', enabled: true },
      ]),
      singingProvider: selection(config.singingProvider, [
        { id: 'ace_step_1_5', displayName: 'ACE-Step 1.5', state: singingState, enabled: true, ...(singingDiagnostic ? { diagnosticCode: singingDiagnostic } : {}) },
      ]),
      activeVoiceProfileId: config.voiceProfileId || '',
      activeSingingVoiceProfileId: config.singingVoiceProfileId || '',
      capabilities: [
        { id: 'speech.input', displayName: '语音输入', state: asrState, supported: asrReady, ...(asrDiagnostic ? { diagnosticCode: asrDiagnostic } : {}) },
        { id: 'speech.output', displayName: '语音输出', state: ttsState, supported: ttsReady, ...(ttsDiagnostic ? { diagnosticCode: ttsDiagnostic } : {}) },
        { id: 'speech.singing', displayName: '歌声合成', state: singingState, supported: singingReady, ...(singingDiagnostic ? { diagnosticCode: singingDiagnostic } : {}) },
      ],
      components: [...dependencyComponents, ...managedComponents],
      voiceProfiles: profiles,
      limits: {
        maxInputBytes: config.maxInputBytes,
        maxInputDurationSeconds: config.maxDurationMs / 1000,
        maxOutputCharacters: config.maxTextChars,
        maxPreviewCharacters: MAX_SPEECH_PREVIEW_TEXT_CHARACTERS,
        maxSongDurationSeconds: config.maxSongDurationSeconds,
      },
      actions: [
        { id: 'speech.refresh', label: '刷新语音状态', enabled: true },
        { id: 'speech.saveSettings', label: '保存语音设置', enabled: true },
        { id: 'speech.installComponent', label: '安装受管组件', enabled: hasInstallable, ...(!hasInstallable ? { diagnosticCode: 'manifest_incomplete' } : {}) },
        { id: 'speech.installPresetVoice', label: '安装预设音色', enabled: presetInstallEnabled, ...(presetInstallDiagnostic ? { diagnosticCode: presetInstallDiagnostic } : {}) },
        {
          id: 'speech.benchmarkTtsModel',
          label: '测试当前语音模型',
          enabled: ttsReady && liveTtsModelId === config.ttsModelId,
          ...(!(ttsReady && liveTtsModelId === config.ttsModelId)
            ? { diagnosticCode: 'tts_model_restart_or_load_required' } : {}),
        },
        { id: 'speech.importReferenceVoice', label: '导入参考音色', enabled: true },
        { id: 'speech.previewVoice', label: '试听音色', enabled: previewEnabled, ...(previewDiagnostic ? { diagnosticCode: previewDiagnostic } : {}) },
        { id: 'speech.previewSingingVoice', label: '试听歌声', enabled: singingReady && previewTransportReady, ...(!(singingReady && previewTransportReady) ? { diagnosticCode: singingDiagnostic || 'speech_preview_live_runtime_unavailable' } : {}) },
        { id: 'speech.activateVoiceProfile', label: '启用音色', enabled: profiles.some((item) => item.state === 'ready') },
      ],
      ...(diagnosticCode ? { diagnosticCode } : {}),
      lastCheckedAt: (this.options.now?.() || new Date()).toISOString(),
    };
  }
}
