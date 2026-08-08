export type SpeechRuntimeState = 'ready' | 'optional_missing' | 'blocked' | 'error';

export interface SpeechSelectionOption {
  id: string;
  label: string;
  available: boolean;
  diagnosticCode?: string;
}
export interface SpeechSelection {
  value: string;
  options: SpeechSelectionOption[];
}

export interface SpeechRuntimeConfig {
  inputEnabled: boolean;
  outputEnabled: boolean;
  channels: string[];
  replyPolicy: string;
  deliveryMode: string;
  asrProvider: string;
  ttsProvider: string;
  ttsModelId: string;
  tonePolicy: string;
  modelRoot?: string;
  senseVoiceBinaryPath?: string;
  asrModel?: string;
  ttsModelPath?: string;
  ttsReferenceModelPath?: string;
  voiceCloneBenchmarkPassed: boolean;
  voiceProfileId?: string;
  singingEnabled: boolean;
  singingProvider: string;
  singingApiUrl?: string;
  singingApiToken?: string;
  singingVoiceProfileId?: string;
  singingBenchmarkPassed: boolean;
  singingModel: string;
  singingLmModel: string;
  singingTimeoutMs: number;
  maxSongDurationSeconds: number;
  ffmpegPath?: string;
  ffprobePath?: string;
  pythonPath?: string;
  sidecarPath?: string;
  requestTimeoutMs: number;
  startupTimeoutMs: number;
  maxInputBytes: number;
  maxDurationMs: number;
  maxTextChars: number;
}

export interface SpeechComponentStatus {
  id: string;
  displayName: string;
  state: SpeechRuntimeState;
  source?: 'explicit' | 'managed' | 'path' | 'bundled';
  version?: string;
  diagnosticCode?: string;
}

/** 面板只看摘要；转写、SHA、相对文件路径和原始来源永不进入状态 DTO。 */
export interface SpeechVoiceProfileSummary {
  id: string;
  displayName: string;
  kind: 'preset' | 'reference';
  state: SpeechRuntimeState;
  active: boolean;
  license: string;
  sourceLabel: string;
  authorizationConfirmed: boolean;
}

export interface SpeechVoiceProfileRecord {
  id: string;
  displayName: string;
  kind: 'preset' | 'reference';
  relativePath: string;
  sha256: string;
  transcript: string;
  source: string;
  sourceLabel: string;
  license: string;
  authorizationConfirmed: true;
  createdAt: string;
}

export interface SpeechRuntimeStatus {
  protocol: 'codex-im-suite/speech-status/v1';
  state: SpeechRuntimeState;
  inputEnabled: boolean;
  outputEnabled: boolean;
  channels: string[];
  replyPolicy: SpeechSelection;
  deliveryMode: SpeechSelection;
  asrProvider: SpeechSelection;
  ttsProvider: SpeechSelection;
  activeVoiceProfileId?: string;
  components: SpeechComponentStatus[];
  voiceProfiles: SpeechVoiceProfileSummary[];
  limits: {
    maxInputBytes: number;
    maxDurationMs: number;
    maxTextChars: number;
    maxConcurrentRequests: 1;
  };
  actions: Array<{
    id: string;
    label: string;
    enabled: boolean;
    diagnosticCode?: string;
  }>;
  diagnosticCode?: string;
  lastCheckedAt: string;
}

export interface SpeechSidecarHealth {
  protocol: 'cti-speech-sidecar/v1';
  status: SpeechRuntimeState;
  version: string;
  capabilities: { asr: boolean; tts: boolean };
  tts?: {
    providerId: string;
    modelId: string;
    revision: string;
  };
  diagnosticCode?: string;
}

export class RuntimeSpeechError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: Exclude<SpeechRuntimeState, 'ready'>,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeSpeechError';
  }
}

