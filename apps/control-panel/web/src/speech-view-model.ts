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
      && profile.capabilities.includes('speech')
      && profile.compatibleTtsModelIds.includes(draft.ttsModelId));
  const singingVoiceProfileValid = !draft.activeSingingVoiceProfileId
    || status.voiceProfiles.some((profile) => profile.id === draft.activeSingingVoiceProfileId && profile.capabilities.includes('singing'));
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

const speechDiagnosticMessages: Record<string, string> = {
  speech_disabled: '语音输入、输出和唱歌当前都处于关闭状态；可先开启需要的能力并保存。',
  speech_action_unavailable: '当前 Runtime 没有提供这个动作，请先更新并重启控制面板。',
  speech_preview_unavailable: '当前语音试听链尚未就绪。',
  speech_preview_live_runtime_unavailable: 'Bridge 尚未运行或未加载试听 mailbox；请受控重启 Bridge 后重新检查。',
  speech_preview_voice_profile_unavailable: '所选音色尚未 ready；请先安装兼容模型并完成模型加载。',
  tts_backend_missing: 'TTS 运行环境或当前模型尚未安装。请先安装当前模型，并配置受管 Python/CUDA 与 FFmpeg。',
  tts_model_not_loaded: '模型文件尚未安装或尚未由 live Runtime 加载。',
  tts_model_restart_or_load_required: '请先保存当前模型并受控重启 Bridge，确认 live 模型加载后再执行。',
  tts_provider_not_loaded: '当前 TTS Provider 尚未由 live Runtime 加载。',
  voice_profile_model_incompatible: '该音色与当前 TTS 模型不兼容，请切换到兼容模型。',
  voice_clone_benchmark_not_verified: '参考音色需先通过当前模型与硬件绑定的克隆性能门禁。',
  preset_voice_is_model_capability: 'Qwen 预设音色随兼容模型提供，不需要单独下载音色；请安装对应模型。',
  manifest_incomplete: '该组件缺少完整固定来源、版本、大小与 SHA-256 清单，暂不能安全自动安装。',
  component_not_installed: '该受管组件尚未安装。',
  executable_not_found: '未找到可执行文件；请安装受管组件或在 Runtime 配置中指定有效路径。',
  backend_dependency_not_installed: '本机受管依赖尚未安装。',
  singing_backend_missing: '独立歌声 Runtime/模型尚未安装或未通过门禁。',
  singing_benchmark_not_verified: '歌声模型尚未通过当前硬件性能门禁。',
};

/** 灰色协议码对普通用户不可行动；面板统一投影为中文处理建议，同时保留原始码供诊断。 */
export function describeSpeechDiagnostic(code?: string): string {
  const normalized = code?.trim() || 'speech_action_unavailable';
  return `${speechDiagnosticMessages[normalized] || `语音能力尚未就绪（${normalized}）。`} [${normalized}]`;
}

export function describeReferenceVoiceMissing(draft: SpeechReferenceVoiceDraft): string {
  const missing: string[] = [];
  if (!draft.displayName.trim()) missing.push('Profile 名称');
  if (!draft.sourceLabel.trim()) missing.push('来源标签');
  if (!draft.license.trim()) missing.push('许可证/授权依据');
  if (!draft.transcript.trim()) missing.push('准确转写');
  if (!draft.authorizationConfirmed) missing.push('音频及音色使用授权确认');
  if (!draft.cleanSingleSpeakerConfirmed) missing.push('3–30 秒单人干净录音确认');
  return missing.length > 0 ? `请先补齐：${missing.join('、')}。` : '';
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
