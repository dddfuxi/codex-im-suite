import {
  SPEECH_PREVIEW_PROTOCOL,
  SPEECH_SETTINGS_SCHEMA,
  type SpeechActionContract,
  type SpeechComponentContract,
  type SpeechPanelStateContract,
  type SpeechPreviewReceiptContract,
  type SpeechSelectionContract,
  type SpeechSettingsContract,
  type SpeechState,
  type SpeechStatusContract,
} from '@codex-im-suite/contracts/speech';

export type SpeechDisplayState = SpeechState | 'unavailable';

export type SpeechReferenceVoiceDraft = {
  displayName: string;
  transcript: string;
  sourceLabel: string;
  license: string;
  authorizationConfirmed: boolean;
  cleanSingleSpeakerConfirmed: boolean;
};

const displayStateMeta: Record<SpeechDisplayState, { label: string; tone: 'ok' | 'warning' | 'error' | 'idle' }> = {
  ready: { label: 'ready', tone: 'ok' },
  optional_missing: { label: 'optional_missing', tone: 'warning' },
  blocked: { label: 'blocked', tone: 'error' },
  error: { label: 'error', tone: 'error' },
  unavailable: { label: 'unavailable', tone: 'idle' },
};

export function getSpeechDisplayState(panel: SpeechPanelStateContract): SpeechDisplayState {
  return panel.available && panel.status ? panel.status.state : 'unavailable';
}

export function describeSpeechDisplayState(panel: SpeechPanelStateContract) {
  return displayStateMeta[getSpeechDisplayState(panel)];
}

export function createSpeechSettingsDraft(status: SpeechStatusContract): SpeechSettingsContract {
  return {
    schema: SPEECH_SETTINGS_SCHEMA,
    inputEnabled: status.inputEnabled,
    outputEnabled: status.outputEnabled,
    singingEnabled: status.singingEnabled,
    channelIds: status.channels.filter((channel) => channel.selected).map((channel) => channel.id),
    replyPolicy: status.replyPolicy.value,
    deliveryMode: status.deliveryMode.value,
    asrProvider: status.asrProvider.value,
    ttsProvider: status.ttsProvider.value,
    ttsModelId: status.ttsModel.value,
    tonePolicy: status.tonePolicy.value,
    singingProvider: status.singingProvider.value,
    activeVoiceProfileId: status.activeVoiceProfileId,
    activeSingingVoiceProfileId: status.activeSingingVoiceProfileId,
  };
}

/** 保留已有渠道顺序，并以集合语义增删单个 Runtime 声明的 opaque ID。 */
export function updateSpeechChannelIds(channelIds: string[], channelId: string, selected: boolean): string[] {
  if (selected) return channelIds.includes(channelId) ? channelIds : [...channelIds, channelId];
  return channelIds.filter((id) => id !== channelId);
}

function selectionAccepts(selection: SpeechSelectionContract, value: string): boolean {
  if (!value && selection.options.length === 0) return true;
  return selection.options.some((option) => option.id === value && option.enabled);
}

/** 浏览器只允许提交本轮 Runtime status 已声明且 enabled 的 opaque ID。 */
export function canSaveSpeechSettings(status: SpeechStatusContract, draft: SpeechSettingsContract): boolean {
  const channelValid = (draft.channelIds.length === 0 && status.channels.length === 0)
    || (new Set(draft.channelIds).size === draft.channelIds.length
      && draft.channelIds.every((id) => status.channels.some((channel) => channel.id === id && channel.enabled)));
  const voiceProfileValid = !draft.activeVoiceProfileId
    || status.voiceProfiles.some((profile) => profile.id === draft.activeVoiceProfileId
      && profile.state === 'ready'
      && profile.capabilities.includes('speech')
      && profile.compatibleTtsModelIds.includes(draft.ttsModelId));
  const singingVoiceProfileValid = !draft.activeSingingVoiceProfileId
    || status.voiceProfiles.some((profile) => profile.id === draft.activeSingingVoiceProfileId && profile.state === 'ready' && profile.capabilities.includes('singing'));
  const model = status.ttsModel.options.find((option) => option.id === draft.ttsModelId && option.enabled);
  const modelValid = Boolean(model && model.providerId === draft.ttsProvider);
  return draft.schema === SPEECH_SETTINGS_SCHEMA
    && channelValid
    && selectionAccepts(status.replyPolicy, draft.replyPolicy)
    && selectionAccepts(status.deliveryMode, draft.deliveryMode)
    && (!draft.inputEnabled || selectionAccepts(status.asrProvider, draft.asrProvider))
    && (!draft.outputEnabled || selectionAccepts(status.ttsProvider, draft.ttsProvider))
    && (!draft.outputEnabled || modelValid)
    && (!draft.outputEnabled || selectionAccepts(status.tonePolicy, draft.tonePolicy))
    && (!draft.outputEnabled || voiceProfileValid)
    && (!draft.singingEnabled || selectionAccepts(status.singingProvider, draft.singingProvider))
    && (!draft.singingEnabled || singingVoiceProfileValid);
}

export function getSpeechAction(status: SpeechStatusContract, id: string): SpeechActionContract {
  return status.actions.find((action) => action.id === id) ?? {
    id,
    label: id,
    enabled: false,
    diagnosticCode: 'speech_action_unavailable',
  };
}

export function getSpeechPanelDiagnostic(panel: SpeechPanelStateContract): string {
  if (!panel.available || !panel.status) return panel.unavailableCode || 'speech_runtime_unavailable';
  return panel.status.diagnosticCode || '';
}

/** WebView 只把 C# 复验后的精确试听协议转换为内存媒体，不接受夹带字段。 */
export function decodeSpeechPreviewReceipt(value: unknown): {
  receipt: SpeechPreviewReceiptContract;
  media: Uint8Array;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('speech_preview_response_invalid');
  const receipt = value as Partial<SpeechPreviewReceiptContract>;
  const keys = Object.keys(receipt).sort();
  const expectedKeys = ['base64', 'bytes', 'durationMs', 'mediaType', 'modelId', 'protocol', 'sha256', 'validated', 'voiceProfileId'];
  if (
    keys.join('\n') !== expectedKeys.join('\n')
    || receipt.protocol !== SPEECH_PREVIEW_PROTOCOL
    || receipt.mediaType !== 'audio/ogg; codecs=opus'
    || receipt.validated !== true
    || typeof receipt.base64 !== 'string'
    || receipt.base64.length === 0
    || receipt.base64.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(receipt.base64)
    || !Number.isSafeInteger(receipt.bytes)
    || receipt.bytes! <= 0
    || receipt.bytes! > 4 * 1024 * 1024
    || typeof receipt.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(receipt.sha256)
    || !Number.isFinite(receipt.durationMs)
    || receipt.durationMs! <= 0
    || typeof receipt.modelId !== 'string'
    || !/^[A-Za-z0-9._-]{1,80}$/u.test(receipt.modelId)
    || typeof receipt.voiceProfileId !== 'string'
    || !/^[A-Za-z0-9._-]{1,80}$/u.test(receipt.voiceProfileId)
  ) {
    throw new Error('speech_preview_response_invalid');
  }
  let binary: string;
  try {
    binary = atob(receipt.base64);
  } catch {
    throw new Error('speech_preview_response_invalid');
  }
  const media = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    media.byteLength !== receipt.bytes
    || btoa(binary) !== receipt.base64
    || media.byteLength < 4
    || media[0] !== 0x4f
    || media[1] !== 0x67
    || media[2] !== 0x67
    || media[3] !== 0x53
  ) {
    throw new Error('speech_preview_response_invalid');
  }
  return { receipt: receipt as SpeechPreviewReceiptContract, media };
}

/** 组件级 installable 与 Runtime action 必须同时放行，避免展示无真实 manifest 的安装假入口。 */
export function canInstallSpeechComponent(
  component: SpeechComponentContract,
  installAction: SpeechActionContract,
): boolean {
  return component.installable && component.state !== 'ready' && installAction.enabled;
}

/** 两项安全确认和四项可审计元数据都齐全时，才允许打开参考音频选择器。 */
export function canImportSpeechReferenceVoice(draft: SpeechReferenceVoiceDraft): boolean {
  return draft.authorizationConfirmed
    && draft.cleanSingleSpeakerConfirmed
    && Boolean(draft.displayName.trim())
    && Boolean(draft.transcript.trim())
    && Boolean(draft.sourceLabel.trim())
    && Boolean(draft.license.trim());
}

/** 独立 CLI 的完成只表示磁盘写入成功；不得把尚未重载的 live Bridge 说成已生效。 */
export function getSpeechCommandNotice(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
  const receipt = result as { restartRequired?: unknown; notice?: unknown };
  if (receipt.restartRequired !== true) return '';
  return typeof receipt.notice === 'string' && receipt.notice.trim()
    ? receipt.notice.trim()
    : '语音配置已写入；请在服务页受控重启 Bridge 后再做现场验收。';
}
