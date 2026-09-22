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
  /** 可选质量门禁；关闭时保留测量结果但不阻止参考音色试听、生成或投递。 */
  requireVoiceSimilarityAcceptance: boolean;
  /** 唯一 Bridge Owner 本人音色可免重复授权确认；质量与文本门禁不受影响。 */
  ownerSelfVoiceAutoAuthorization: boolean;
  voiceProfileId?: string;
  singingEnabled: boolean;
  singingProvider: string;
  singingApiUrl?: string;
  singingApiToken?: string;
  singingVoiceProfileId?: string;
  singingBenchmarkPassed: boolean;
  singingModel: string;
  singingLmModel: string;
  /** 歌声生成后的歌词验收器；默认仍用现有 SenseVoice，FireRed 仅为可选 WSL Runtime。 */
  singingLyricsVerifier: string;
  singingLyricsVerifierWslDistro?: string;
  singingLyricsVerifierWslPython?: string;
  singingLyricsVerifierScriptPath?: string;
  singingLyricsVerifierModelPath?: string;
  singingTimeoutMs: number;
  maxSongDurationSeconds: number;
  ffmpegPath?: string;
  ffprobePath?: string;
  pythonPath?: string;
  sidecarPath?: string;
  requestTimeoutMs: number;
  /** 单次 TTS 生成的绝对上限；实际时限会结合当前模型 benchmark 动态收窄。 */
  synthesisTimeoutMs: number;
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
    /**
     * 仅携带可安全持久化的数值质量观测；不得放入文本、路径、身份或模型原始输出。
     * benchmark 失败也应保留这些指标，才能区分模型质量问题和执行链失败。
     */
    public readonly qualityMetrics?: {
      lyricsAlignment?: number;
      lyricsAlignmentThreshold?: number;
      lyricsAlignmentPassed?: false;
    },
  ) {
    super(message);
    this.name = 'RuntimeSpeechError';
  }
}

