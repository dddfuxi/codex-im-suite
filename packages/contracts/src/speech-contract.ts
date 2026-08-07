export const SPEECH_STATUS_PROTOCOL = 'codex-im-suite/speech-status/v1' as const;
export const SPEECH_SETTINGS_SCHEMA = 'codex-im-suite/speech-settings/v1' as const;
export const SPEECH_PREVIEW_PROTOCOL = 'codex-im-suite/speech-preview/v1' as const;

export type SpeechState = 'ready' | 'optional_missing' | 'blocked' | 'error';
export type SpeechVoiceProfileKind = 'preset' | 'reference';

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

export interface SpeechVoiceProfileContract {
  id: string;
  displayName: string;
  kind: SpeechVoiceProfileKind;
  state: SpeechState;
  active: boolean;
  license: string;
  sourceLabel: string;
  authorizationConfirmed: boolean;
  diagnosticCode?: string;
}

export interface SpeechLimitsContract {
  maxInputBytes: number;
  maxInputDurationSeconds: number;
  maxOutputCharacters: number;
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
  channelIds: string[];
  replyPolicy: string;
  deliveryMode: string;
  asrProvider: string;
  ttsProvider: string;
  activeVoiceProfileId: string;
}

export interface SpeechStatusContract {
  protocol: typeof SPEECH_STATUS_PROTOCOL;
  state: SpeechState;
  inputEnabled: boolean;
  outputEnabled: boolean;
  channels: SpeechChannelContract[];
  replyPolicy: SpeechSelectionContract;
  deliveryMode: SpeechSelectionContract;
  asrProvider: SpeechSelectionContract;
  ttsProvider: SpeechSelectionContract;
  activeVoiceProfileId: string;
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
  voiceProfileId: string;
  validated: true;
}
