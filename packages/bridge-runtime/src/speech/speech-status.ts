import type {
  SpeechComponentContract,
  SpeechSelectionContract,
  SpeechState,
  SpeechStatusContract,
} from '@codex-im-suite/contracts/speech';

import { RuntimeSpeechError, type SpeechRuntimeConfig } from './runtime-types.js';
import { RuntimeSpeechHost } from './runtime-speech-host.js';
import { DEFAULT_PRESET_PROFILE_ID, DEFAULT_PRESET_VOICE, SpeechVoiceRegistry } from './voice-registry.js';

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
    const speechEnabled = config.inputEnabled || config.outputEnabled;
    const dependenciesReady = Object.values(dependencies).every((item) => item.state === 'ready');
    if (speechEnabled && dependenciesReady && input.probeSidecar !== false) {
      try {
        const client = await this.options.host.sidecar.ensureClient(input.signal);
        const health = await client.health(input.signal);
        sidecarState = health.status;
        sidecarDiagnostic = health.diagnosticCode || '';
        asrReady = health.capabilities.asr;
        ttsReady = health.capabilities.tts;
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
    const ttsManifest = managed.find((item) => item.id === config.ttsProvider || item.capabilities.includes('tts'));
    // manifest ready 只表示文件已安装；能力 ready 只能来自本轮真实 Sidecar health。
    const asrState: SpeechState = asrReady ? 'ready' : unavailableCapabilityState(sidecarState, asrManifest?.state);
    const ttsState: SpeechState = ttsReady ? 'ready' : unavailableCapabilityState(sidecarState, ttsManifest?.state);
    const asrDiagnostic = asrReady ? undefined : (asrManifest?.state !== 'ready' ? asrManifest?.diagnosticCode : undefined) || sidecarDiagnostic || 'asr_backend_missing';
    const ttsDiagnostic = ttsReady ? undefined : (ttsManifest?.state !== 'ready' ? ttsManifest?.diagnosticCode : undefined) || sidecarDiagnostic || 'tts_backend_missing';

    const activeStates: SpeechState[] = [];
    if (config.inputEnabled) activeStates.push(asrState);
    if (config.outputEnabled) activeStates.push(ttsState);
    const state = speechEnabled ? worstState(activeStates) : 'optional_missing';
    const diagnosticCode = speechEnabled
      ? (state === 'ready' ? undefined : (config.inputEnabled && asrState !== 'ready' ? asrDiagnostic : ttsDiagnostic))
      : 'speech_disabled';
    const profiles = this.options.voiceRegistry.listSummaries(config.voiceProfileId).map((profile) => {
      if (profile.kind === 'reference' && !config.voiceCloneBenchmarkPassed) {
        return { ...profile, state: 'blocked' as const, diagnosticCode: 'voice_clone_benchmark_not_verified' };
      }
      if (profile.state === 'ready' && !ttsReady) {
        return { ...profile, state: ttsState, ...(ttsDiagnostic ? { diagnosticCode: ttsDiagnostic } : {}) };
      }
      return profile;
    });
    const knownChannels = [...new Set(['feishu', ...config.channels])];
    const hasInstallable = managed.some((item) => item.installable);
    const presetRegistered = profiles.some((item) => item.id === DEFAULT_PRESET_PROFILE_ID);
    const presetInstallEnabled = ttsReady && !presetRegistered;
    const presetInstallDiagnostic = presetRegistered
      ? 'preset_voice_already_registered'
      : ttsReady ? undefined : (ttsDiagnostic || 'preset_voice_backend_unavailable');
    if (!presetRegistered) {
      profiles.push({
        id: DEFAULT_PRESET_VOICE.id,
        displayName: DEFAULT_PRESET_VOICE.displayName,
        kind: 'preset',
        state: ttsReady ? 'optional_missing' : ttsState,
        active: false,
        license: DEFAULT_PRESET_VOICE.license,
        sourceLabel: DEFAULT_PRESET_VOICE.sourceLabel,
        authorizationConfirmed: true,
        diagnosticCode: presetInstallDiagnostic || 'preset_voice_not_registered',
      });
    }
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
      protocol: 'codex-im-suite/speech-status/v1',
      state,
      inputEnabled: config.inputEnabled,
      outputEnabled: config.outputEnabled,
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
      ttsProvider: selection(config.ttsProvider, [
        { id: 'cosyvoice', displayName: 'CosyVoice', state: ttsState, enabled: true, ...(ttsDiagnostic ? { diagnosticCode: ttsDiagnostic } : {}) },
      ]),
      activeVoiceProfileId: config.voiceProfileId || '',
      capabilities: [
        { id: 'speech.input', displayName: '语音输入', state: asrState, supported: asrReady, ...(asrDiagnostic ? { diagnosticCode: asrDiagnostic } : {}) },
        { id: 'speech.output', displayName: '语音输出', state: ttsState, supported: ttsReady, ...(ttsDiagnostic ? { diagnosticCode: ttsDiagnostic } : {}) },
      ],
      components: [...dependencyComponents, ...managedComponents],
      voiceProfiles: profiles,
      limits: {
        maxInputBytes: config.maxInputBytes,
        maxInputDurationSeconds: config.maxDurationMs / 1000,
        maxOutputCharacters: config.maxTextChars,
      },
      actions: [
        { id: 'speech.refresh', label: '刷新语音状态', enabled: true },
        { id: 'speech.saveSettings', label: '保存语音设置', enabled: true },
        { id: 'speech.installComponent', label: '安装受管组件', enabled: hasInstallable, ...(!hasInstallable ? { diagnosticCode: 'manifest_incomplete' } : {}) },
        { id: 'speech.installPresetVoice', label: '安装预设音色', enabled: presetInstallEnabled, ...(presetInstallDiagnostic ? { diagnosticCode: presetInstallDiagnostic } : {}) },
        { id: 'speech.importReferenceVoice', label: '导入参考音色', enabled: true },
        { id: 'speech.previewVoice', label: '试听音色', enabled: previewEnabled, ...(previewDiagnostic ? { diagnosticCode: previewDiagnostic } : {}) },
        { id: 'speech.activateVoiceProfile', label: '启用音色', enabled: profiles.some((item) => item.state === 'ready') },
      ],
      ...(diagnosticCode ? { diagnosticCode } : {}),
      lastCheckedAt: (this.options.now?.() || new Date()).toISOString(),
    };
  }
}
