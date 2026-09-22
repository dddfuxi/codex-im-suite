export const SPEECH_STATUS_PROTOCOL = 'codex-im-suite/speech-status/v2' as const;
export const SPEECH_SETTINGS_SCHEMA = 'codex-im-suite/speech-settings/v2' as const;
export const SPEECH_PREVIEW_PROTOCOL = 'codex-im-suite/speech-preview/v2' as const;

export type SpeechState = 'ready' | 'optional_missing' | 'blocked' | 'error';
export type SpeechVoiceProfileKind = 'preset' | 'reference';
export type SpeechVoiceCapability = 'speech' | 'singing';
export type SpeechModelCapability = 'preset_voice' | 'voice_clone' | 'instruction_control';
export type SpeechProviderCapability =
  | 'speech.text'
  | 'speech.emotion'
  | 'speech.prosody_reference'
  | 'singing.text_to_singing'
  | 'singing.melody'
  | 'singing.voice_conversion'
  | 'voice.zero_shot_clone'
  | 'voice.cross_mode_identity';
export type SpeechAcceptanceState = 'not_applicable' | 'not_verified' | 'passed' | 'failed';
export type SingingMelodyMode = 'auto' | 'reference_audio' | 'midi_or_f0';
export type SingingOutputMode = 'quick_preview' | 'full_generation';

export const SINGING_AUDIO_CONTENT_PLAN_SCHEMA = 'codex-im-suite/singing-audio-content-plan/v1' as const;

/**
 * provider、策略和渠道的 ID 均由 Runtime 声明；面板只回传 options 中的
 * opaque ID，不在 React 或 C# 侧复制 provider/component 业务枚举。
 */
export interface SpeechSelectionOptionContract {
  id: string;
  displayName: string;
  state: SpeechState;
  enabled: boolean;
  diagnosticCode?: string;
}

export interface SpeechSelectionContract {
  value: string;
  options: SpeechSelectionOptionContract[];
}

/**
 * benchmark 结果必须绑定具体模型版本与本机硬件；面板只接收脱敏指标，
 * 不接收模型路径、命令、原始日志或设备序列号。
 */
export interface SpeechModelBenchmarkContract {
  state: SpeechState;
  revision: string;
  testedAt?: string;
  coldStartMs?: number;
  warmSynthesisMs?: number;
  outputDurationMs?: number;
  realTimeFactor?: number;
  peakVramMiB?: number;
  /** 参考音色 benchmark 必须绑定具体 Profile，不能被其它音色复用。 */
  voiceProfileId?: string;
  speakerSimilarity?: number;
  speakerSimilarityThreshold?: number;
  speakerSimilarityPassed?: boolean;
  /** 歌声 benchmark 的歌词验收必须来自真实 ASR 对齐，不能用时长或文件名替代。 */
  lyricsAlignment?: number;
  lyricsAlignmentThreshold?: number;
  lyricsAlignmentPassed?: boolean;
  diagnosticCode?: string;
}

export interface SpeechModelOptionContract extends SpeechSelectionOptionContract {
  providerId: string;
  variant: string;
  sizeLabel: string;
  qualityTier: 'high_quality' | 'balanced' | 'low_resource';
  qualityRank: number;
  componentId: string;
  capabilities: SpeechModelCapability[];
  defaultVoiceProfileId: string;
  benchmark: SpeechModelBenchmarkContract;
}

export interface SpeechModelSelectionContract {
  /** 已保存配置中的模型 ID。 */
  value: string;
  /** 当前 live Sidecar 实际加载的模型 ID；未加载时为空字符串。 */
  liveValue: string;
  restartRequired: boolean;
  options: SpeechModelOptionContract[];
}

export interface SpeechChannelContract extends SpeechSelectionOptionContract {
  inputSupported: boolean;
  outputSupported: boolean;
  selected: boolean;
}

export interface SpeechCapabilityContract {
  id: string;
  displayName: string;
  state: SpeechState;
  supported: boolean;
  diagnosticCode?: string;
}

export interface SpeechComponentContract {
  id: string;
  displayName: string;
  kind: string;
  state: SpeechState;
  /** Runtime 仅在存在固定来源、版本、SHA 与安全解压目标的受管安装项时置为 true。 */
  installable: boolean;
  version?: string;
  capabilities: string[];
  diagnosticCode?: string;
}

/** Provider 能力来自 Runtime Manifest；面板不按模型名称猜测功能。 */
export interface SpeechProviderContract {
  id: string;
  displayName: string;
  state: SpeechState;
  enabled: boolean;
  experimental: boolean;
  license: string;
  capabilities: SpeechProviderCapability[];
  diagnosticCode?: string;
}

/** 说话与歌声验收分别绑定真实 Provider/模型/版本，禁止复用一个成功布尔值。 */
export interface SpeechVoiceAcceptanceContract {
  state: SpeechAcceptanceState;
  providerId?: string;
  modelId?: string;
  revision?: string;
  testedAt?: string;
  similarity?: number;
  similarityThreshold?: number;
  lyricsAlignment?: number;
  lyricsAlignmentThreshold?: number;
  diagnosticCode?: string;
}

export interface SpeechVoiceProfileContract {
  id: string;
  displayName: string;
  kind: SpeechVoiceProfileKind;
  state: SpeechState;
  active: boolean;
  license: string;
  sourceLabel: string;
  authorizationConfirmed: boolean;
  capabilities: SpeechVoiceCapability[];
  compatibleTtsModelIds: string[];
  speechAcceptance: SpeechVoiceAcceptanceContract;
  singingAcceptance: SpeechVoiceAcceptanceContract;
  diagnosticCode?: string;
}

export interface SpeechLimitsContract {
  maxInputBytes: number;
  maxInputDurationSeconds: number;
  maxOutputCharacters: number;
  maxPreviewCharacters: number;
  maxSongLyricsCharacters: number;
  maxSongDurationSeconds: number;
}

export interface SpeechActionContract {
  id: string;
  label: string;
  enabled: boolean;
  diagnosticCode?: string;
}

/** 保存设置命令的版本化 payload；所有 ID 必须来自同一份 SpeechStatus。 */
export interface SpeechSettingsContract {
  schema: typeof SPEECH_SETTINGS_SCHEMA;
  inputEnabled: boolean;
  outputEnabled: boolean;
  singingEnabled: boolean;
  channelIds: string[];
  replyPolicy: string;
  deliveryMode: string;
  asrProvider: string;
  ttsProvider: string;
  ttsModelId: string;
  tonePolicy: string;
  singingProvider: string;
  activeVoiceProfileId: string;
  activeSingingVoiceProfileId: string;
}

export interface SpeechStatusContract {
  protocol: typeof SPEECH_STATUS_PROTOCOL;
  state: SpeechState;
  inputEnabled: boolean;
  outputEnabled: boolean;
  singingEnabled: boolean;
  channels: SpeechChannelContract[];
  replyPolicy: SpeechSelectionContract;
  deliveryMode: SpeechSelectionContract;
  asrProvider: SpeechSelectionContract;
  ttsProvider: SpeechSelectionContract;
  ttsModel: SpeechModelSelectionContract;
  tonePolicy: SpeechSelectionContract;
  singingProvider: SpeechSelectionContract;
  /** 当前歌声模型、受管版本与本机硬件绑定的真实性能门禁。 */
  singingBenchmark: SpeechModelBenchmarkContract;
  activeVoiceProfileId: string;
  activeSingingVoiceProfileId: string;
  providers: SpeechProviderContract[];
  capabilities: SpeechCapabilityContract[];
  components: SpeechComponentContract[];
  voiceProfiles: SpeechVoiceProfileContract[];
  limits: SpeechLimitsContract;
  actions: SpeechActionContract[];
  diagnosticCode?: string;
  lastCheckedAt: string;
}

/**
 * Runtime CLI 尚不可用时只返回 available=false 与稳定代码；不伪造
 * SpeechStatus，也不外发原始异常、绝对路径、参考音频或密钥。
 */
export interface SpeechPanelStateContract {
  available: boolean;
  unavailableCode?: string;
  status: SpeechStatusContract | null;
}

/**
 * 控制面板唯一允许接收的试听媒体投影。Runtime 与 C# 已验证媒体后才可
 * 产生该回执；不包含文件路径、参考音频、模型参数或原始错误。
 */
export interface SpeechPreviewReceiptContract {
  protocol: typeof SPEECH_PREVIEW_PROTOCOL;
  mediaType: 'audio/ogg; codecs=opus';
  base64: string;
  bytes: number;
  sha256: string;
  durationMs: number;
  modelId: string;
  voiceProfileId: string;
  generationStatus: 'generated';
  deliveryStatus: 'not_sent';
  speakerSimilarityStatus: 'passed' | 'not_applicable';
  speakerSimilarity?: number;
  speakerSimilarityThreshold?: number;
  speakerSimilarityPassed?: boolean;
  lyricsAlignment?: number;
  lyricsAlignmentThreshold?: number;
  lyricsAlignmentPassed?: boolean;
  lyricsAlignmentStatus?: 'passed';
  validated: true;
}

/** Core、Runtime 与面板正式生成复用的稳定歌声内容计划。 */
export interface SingingAudioContentPlanContract {
  schema: typeof SINGING_AUDIO_CONTENT_PLAN_SCHEMA;
  outputMode: SingingOutputMode;
  lyrics: string;
  stylePrompt: string;
  vocalLanguage: string;
  durationSeconds: number;
  melodyMode: SingingMelodyMode;
  voiceRequirement?: 'active_reference';
}

function normalizePlannedText(value: unknown, maxCharacters: number, preserveLines = false): string {
  if (typeof value !== 'string') return '';
  const normalized = value.normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .replace(/\r\n?/gu, '\n');
  const text = preserveLines
    ? normalized.split('\n').map((line) => line.replace(/[\t ]+/gu, ' ').trim()).join('\n').trim()
    : normalized.replace(/\s+/gu, ' ').trim();
  return Array.from(text).length <= maxCharacters ? text : '';
}

/**
 * 段落标记用于引导编曲，却不是需要发声的歌词。快速试听按可演唱正文截取，
 * 以免 `[Verse]` 等元数据挤占本就有限的歌词对齐验证窗口；正式生成仍保留
 * 原标记，供歌声模型理解段落结构。
 */
function extractSingableLyrics(value: string): string {
  return value
    .replace(/\[[^\]\n]{1,40}\]/gu, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * 时长由实际歌词规模估算；快速试听只截取可在 10 秒内观察的开头片段，
 * 正式生成保留完整歌词。该纯函数不识别固定句子、模型名或平台身份。
 */
export function createSingingAudioContentPlan(input: {
  outputMode: SingingOutputMode;
  lyrics: string;
  stylePrompt: string;
  vocalLanguage?: string;
  requestedDurationSeconds?: number;
  maxDurationSeconds?: number;
  maxLyricsCharacters?: number;
  melodyMode?: SingingMelodyMode;
  voiceRequirement?: 'active_reference';
}): SingingAudioContentPlanContract | null {
  const maxLyricsCharacters = Math.max(1, Math.min(20_000, Math.trunc(input.maxLyricsCharacters ?? 6_000)));
  const sourceLyrics = normalizePlannedText(input.lyrics, maxLyricsCharacters, true);
  const stylePrompt = normalizePlannedText(input.stylePrompt, 500);
  const vocalLanguage = normalizePlannedText(input.vocalLanguage || 'zh', 16).toLowerCase();
  const melodyMode = input.melodyMode || 'auto';
  const maxDurationSeconds = Math.max(10, Math.min(600, Math.trunc(input.maxDurationSeconds ?? 600)));
  if (!sourceLyrics || !stylePrompt || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8}){0,2}$/u.test(vocalLanguage)
    || !['auto', 'reference_audio', 'midi_or_f0'].includes(melodyMode)) return null;

  const singableLyrics = extractSingableLyrics(sourceLyrics);
  const visibleCharacters = Array.from(singableLyrics.replace(/\s+/gu, '')).length;
  const lineCount = singableLyrics.split('\n').length;
  const estimatedDuration = Math.ceil(visibleCharacters / 3.2 + Math.max(0, lineCount - 1) * 0.45);
  const requestedDuration = Number(input.requestedDurationSeconds);
  const durationSeconds = input.outputMode === 'quick_preview'
    ? 10
    : Math.max(10, Math.min(
      maxDurationSeconds,
      Number.isFinite(requestedDuration) && requestedDuration > 0 ? Math.round(requestedDuration) : estimatedDuration,
    ));
  const lyrics = input.outputMode === 'quick_preview'
    ? Array.from(singableLyrics).slice(0, Math.max(20, Math.ceil(durationSeconds * 3.2))).join('').trim()
    : sourceLyrics;
  if (!lyrics) return null;
  return {
    schema: SINGING_AUDIO_CONTENT_PLAN_SCHEMA,
    outputMode: input.outputMode,
    lyrics,
    stylePrompt,
    vocalLanguage,
    durationSeconds,
    melodyMode,
    ...(input.voiceRequirement ? { voiceRequirement: input.voiceRequirement } : {}),
  };
}
