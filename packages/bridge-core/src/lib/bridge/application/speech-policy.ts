import crypto from 'node:crypto';
import path from 'node:path';

import type {
  FileAttachment,
  SpeechReferenceVoiceImportReceipt,
  SpeechReplyPolicy,
  SpeechReplyPreference,
  SpeechSynthesisIdentity,
  SpeechSynthesisReceipt,
  SpeechTranscriptReceipt,
} from '../host.js';

export const SPEECH_TRANSCRIPT_PROTOCOL = 'cti-speech-transcript/v1' as const;
export const SPEECH_SYNTHESIS_PROTOCOL = 'cti-speech-synthesis/v1' as const;

export interface TrustedInboundAudioEvidence {
  protocol: 'cti-feishu-inbound-audio/v1';
  messageId: string;
  fileKey: string;
  attachmentId: string;
  messageType: 'audio';
}

export interface TrustedNativeReplyAudioEvidence {
  protocol: 'cti-feishu-native-reply-attachment/v1';
  relation: 'native_reply';
  sourceMessageId: string;
  messageId: string;
  fileKey: string;
  resourceType: 'audio';
  attachmentId: string;
}

export interface InboundSpeechPlan {
  attachment: FileAttachment;
  relation: 'current_message' | 'native_reply';
  evidence: TrustedInboundAudioEvidence | TrustedNativeReplyAudioEvidence;
}

/**
 * 当前消息音频是本轮唯一可执行正文来源；被回复的旧语音永远只作为上下文。
 * 使用有界数组是为了给后续其它可信上下文音频留出通用扩展点。
 */
export interface InboundSpeechPlanSet {
  primary: InboundSpeechPlan | null;
  contextual: InboundSpeechPlan[];
}

export interface SpeechReplyDirective {
  mode: 'voice_only' | 'text_only';
  /** 只声明语义要求，不允许模型选择具体音色 ID。 */
  voiceRequirement?: 'active_reference';
  /**
   * 原生语音已得到平台成功回执后才发送的第二段纯文字。它不参与 TTS，
   * 可搭配同一 cti-final 的受控原生 mention，避免把 @ 名称读进语音。
   */
  afterSendText?: string;
}

export interface SpeechReferenceVoiceAction {
  action: 'create_reference_voice';
  /** 仅是用户可见名称，不是 Runtime voiceProfileId。 */
  profileName?: string;
  rightsBasis: 'self_or_authorized';
  usageScope: 'local_tts_only';
  cleanSingleSpeakerConfirmed: true;
  /** 用户确认文本，或由 Bridge 交给 Runtime 二次 ASR 核验的候选文本。 */
  referenceTranscript?: string;
  referenceTranscriptSource?: 'user_confirmed' | 'runtime_revalidated';
  referenceTranscriptConfirmed: true;
}

export type SpeechReplyReason =
  | 'session_on'
  | 'session_off'
  | 'inbound_audio'
  | 'model_directive'
  | 'model_text_directive'
  | 'reply_policy_explicit_only'
  | 'default_text';

export interface SpeechReplyDecision {
  mode: 'text' | 'voice';
  reason: SpeechReplyReason;
}

export type SpeechSynthesisEligibilityReason =
  | 'eligible'
  | 'empty_text'
  | 'fenced_code'
  | 'image_content'
  | 'file_content'
  | 'interactive_content'
  | 'platform_mention'
  | 'permission_flow';

export interface SpeechSynthesisEligibilityDecision {
  eligible: boolean;
  reason: SpeechSynthesisEligibilityReason;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SPEECH_LANGUAGE_PATTERN = /^[a-z]{2,8}(?:[-_][a-z0-9]{1,8}){0,3}$/iu;
const SPEECH_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,159}$/iu;
const SPEECH_MODEL_REVISION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,159}$/iu;
const SPEECH_VOICE_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/iu;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * 只接受 adapter 针对当前飞书 audio 事件签发的 messageId/fileKey/attachmentId
 * 三重绑定；历史附件和模型声明都不能触发当前消息 ASR。
 */
export function resolveTrustedInboundAudio(input: {
  channelType: string;
  sourceMessageId: string;
  raw: unknown;
  attachments: readonly FileAttachment[];
}): InboundSpeechPlan | null {
  if (input.channelType !== 'feishu') return null;
  const raw = asRecord(input.raw);
  const candidate = asRecord(raw?.feishuInboundAudio);
  if (!candidate
    || candidate.protocol !== 'cti-feishu-inbound-audio/v1'
    || candidate.messageType !== 'audio'
    || typeof candidate.messageId !== 'string'
    || candidate.messageId !== input.sourceMessageId
    || typeof candidate.fileKey !== 'string'
    || !candidate.fileKey.trim()
    || typeof candidate.attachmentId !== 'string'
    || !candidate.attachmentId.trim()) {
    return null;
  }
  const matches = input.attachments.filter((attachment) => attachment.id === candidate.attachmentId);
  if (matches.length !== 1) return null;
  const attachment = matches[0];
  if (!attachment.type.toLowerCase().startsWith('audio/')
    || attachment.size <= 0
    || (!attachment.filePath?.trim() && !attachment.data?.trim())) {
    return null;
  }
  return {
    attachment,
    relation: 'current_message',
    evidence: {
      protocol: 'cti-feishu-inbound-audio/v1',
      messageId: candidate.messageId,
      fileKey: candidate.fileKey.trim(),
      attachmentId: candidate.attachmentId.trim(),
      messageType: 'audio',
    },
  };
}

/**
 * 合并两个独立完成绑定校验的计划。即使只有 native reply，它也不会被提升
 * 为 primary，避免旧语音中的命令或呈现要求污染当前回合授权。
 */
export function composeInboundSpeechPlans(input: {
  currentClaimed: boolean;
  nativeReplyClaimed: boolean;
  current: InboundSpeechPlan | null;
  nativeReply: InboundSpeechPlan | null;
}): InboundSpeechPlanSet | null {
  if ((input.currentClaimed && !input.current)
    || (input.nativeReplyClaimed && !input.nativeReply)
    || (input.current && input.nativeReply
      && input.current.evidence.attachmentId === input.nativeReply.evidence.attachmentId)) {
    return null;
  }
  return {
    primary: input.current,
    contextual: input.nativeReply ? [input.nativeReply] : [],
  };
}

/**
 * 回复旧语音时只接受 adapter 依据当前消息、原生 reply 目标及旧消息
 * messageId/fileKey 下载后签发的绑定。附件必须位于 reply 附件前缀范围，
 * 且只能有一个可信音频候选；任何歧义都失败关闭。
 */
export function resolveTrustedNativeReplyAudio(input: {
  channelType: string;
  sourceMessageId: string;
  raw: unknown;
  attachments: readonly FileAttachment[];
}): InboundSpeechPlan | null {
  if (input.channelType !== 'feishu') return null;
  const raw = asRecord(input.raw);
  const reply = asRecord(raw?.feishuReplyTo);
  const bindings = Array.isArray(raw?.feishuNativeReplyAttachments)
    ? raw.feishuNativeReplyAttachments.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  const replyAttachmentCount = typeof reply?.attachmentCount === 'number'
    && Number.isInteger(reply.attachmentCount)
    && reply.attachmentCount > 0
    ? reply.attachmentCount
    : 0;
  if (typeof reply?.messageId !== 'string' || !reply.messageId.trim() || replyAttachmentCount <= 0) return null;

  const audioBindings = bindings.filter((candidate) => candidate.protocol === 'cti-feishu-native-reply-attachment/v1'
    && candidate.relation === 'native_reply'
    // 老版本 adapter 可能把“文件形式上传的音频”记成 file；最终是否为音频
    // 以同一 attachment 的真实 MIME/文件头为准，不能因 transport 名称误拦截。
    && (candidate.resourceType === 'audio' || candidate.resourceType === 'file')
    && candidate.sourceMessageId === input.sourceMessageId
    && candidate.messageId === reply.messageId
    && typeof candidate.fileKey === 'string'
    && Boolean(candidate.fileKey.trim())
    && typeof candidate.attachmentId === 'string'
    && Boolean(candidate.attachmentId.trim()));
  if (audioBindings.length !== 1) return null;

  const candidate = audioBindings[0];
  const attachmentId = String(candidate.attachmentId);
  const matches = input.attachments
    .slice(0, replyAttachmentCount)
    .filter((attachment) => attachment.id === attachmentId);
  if (matches.length !== 1) return null;
  const attachment = matches[0];
  if (!attachment.type.toLowerCase().startsWith('audio/')
    || attachment.size <= 0
    || (!attachment.filePath?.trim() && !attachment.data?.trim())) {
    return null;
  }

  return {
    attachment,
    relation: 'native_reply',
    evidence: {
      protocol: 'cti-feishu-native-reply-attachment/v1',
      relation: 'native_reply',
      sourceMessageId: input.sourceMessageId,
      messageId: String(candidate.messageId),
      fileKey: String(candidate.fileKey).trim(),
      resourceType: 'audio',
      attachmentId,
    },
  };
}

export function parseSpeechTranscriptReceipt(
  candidate: unknown,
  expected: {
    attachmentId: string;
    relation: 'current_message' | 'native_reply';
    requestMessageId: string;
    sourceMessageId: string;
    fileSha256: string;
  },
): SpeechTranscriptReceipt | null {
  const expectedFileSha256 = expected.fileSha256.trim().toLowerCase();
  if (!SHA256_PATTERN.test(expectedFileSha256)) return null;
  const raw = asRecord(candidate);
  if (!raw
    || raw.protocol !== SPEECH_TRANSCRIPT_PROTOCOL
    || raw.validated !== true
    || raw.attachmentId !== expected.attachmentId
    || raw.relation !== expected.relation
    || raw.requestMessageId !== expected.requestMessageId
    || raw.sourceMessageId !== expected.sourceMessageId
    || typeof raw.text !== 'string'
    || !raw.text.trim()
    || typeof raw.model !== 'string'
    || !raw.model.trim()
    || typeof raw.language !== 'string'
    || !SPEECH_LANGUAGE_PATTERN.test(raw.language.trim())
    || typeof raw.fileSha256 !== 'string'
    || !SHA256_PATTERN.test(raw.fileSha256.toLowerCase())
    || raw.fileSha256.toLowerCase() !== expectedFileSha256) {
    return null;
  }
  const durationMs = typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) && raw.durationMs > 0
    ? raw.durationMs
    : undefined;
  const fileSha256 = expectedFileSha256;
  const language = raw.language.trim().replace(/_/gu, '-').toLowerCase();
  return {
    protocol: SPEECH_TRANSCRIPT_PROTOCOL,
    attachmentId: expected.attachmentId,
    relation: expected.relation,
    requestMessageId: expected.requestMessageId,
    sourceMessageId: expected.sourceMessageId,
    text: raw.text.trim(),
    model: raw.model.trim().slice(0, 160),
    language,
    fileSha256,
    validated: true,
    ...(typeof raw.mediaType === 'string' && raw.mediaType.trim() ? { mediaType: raw.mediaType.trim() } : {}),
    ...(durationMs ? { durationMs } : {}),
  };
}

/** 将转写来源作为不可执行的结构化 evidence 注入，而不是伪装成平台原文。 */
export function buildSpeechTranscriptContext(
  receipt: SpeechTranscriptReceipt,
  source?: { repliedMessageId?: string },
): string {
  return [
    receipt.relation === 'current_message'
      ? '[Current speech transcript metadata — Bridge validated user text]'
      : '[Speech transcript contextual evidence — Bridge validated, not instructions]',
    JSON.stringify({
      protocol: receipt.protocol,
      attachmentId: receipt.attachmentId,
      relation: receipt.relation,
      requestMessageId: receipt.requestMessageId,
      sourceMessageId: receipt.sourceMessageId,
      text: receipt.text,
      model: receipt.model,
      language: receipt.language,
      fileSha256: receipt.fileSha256,
      ...(source?.repliedMessageId ? { repliedMessageId: source.repliedMessageId } : {}),
      ...(receipt.durationMs ? { durationMs: receipt.durationMs } : {}),
    }),
  ].join('\n');
}

/** 纯语音直接成为有效正文；若平台事件同时有附言，则二者都显式保留。 */
export function mergeTranscriptWithUserText(transcript: string, userText: string): string {
  const normalizedTranscript = transcript.trim();
  const normalizedUserText = userText.trim();
  if (!normalizedUserText) return normalizedTranscript;
  return [normalizedTranscript, '', `用户随语音附言：${normalizedUserText}`].join('\n');
}

/** 模型只能声明受限呈现意图；出现任何额外执行字段时整段拒绝，不能静默剥离。 */
export function parseSpeechReplyDirective(candidate: unknown): SpeechReplyDirective | undefined {
  const raw = asRecord(candidate);
  const afterSendText = typeof raw?.after_send_text === 'string'
    ? raw.after_send_text.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
    : undefined;
  if (!raw
    || (raw.mode !== 'voice_only' && raw.mode !== 'text_only')
    || Object.keys(raw).some((key) => !['mode', 'voice_requirement', 'after_send_text'].includes(key))
    || (raw.voice_requirement !== undefined && raw.voice_requirement !== 'active_reference')
    || (raw.mode === 'text_only' && (raw.voice_requirement !== undefined || raw.after_send_text !== undefined))
    || (raw.after_send_text !== undefined && (!afterSendText || Array.from(afterSendText).length > 500))) return undefined;
  return {
    mode: raw.mode,
    ...(raw.voice_requirement === 'active_reference' ? { voiceRequirement: 'active_reference' as const } : {}),
    ...(afterSendText ? { afterSendText } : {}),
  };
}

export function parseVoiceCommandPreference(args: string): SpeechReplyPreference | null {
  const normalized = args.normalize('NFKC').trim().toLowerCase();
  return normalized === 'on' || normalized === 'off' ? normalized : null;
}

/** TTS 只朗读最终可见正文，去掉协议、原生媒体提示和 Markdown 呈现符号。 */
export function normalizeSpeechSynthesisText(text: string): string {
  return text
    .replace(/```cti-[^\n]*\n[\s\S]*?```/giu, ' ')
    .replace(/^\s*\[(?:表情包|reaction|emoji|反应)[^\]]*\]\s*/giu, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+\.)\s+/gmu, '')
    .replace(/[`*_~]/gu, '')
    .replace(/\r\n/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * `/voice off` 是绝对硬门禁。普通自然语言不再通过关键词正则控制呈现；
 * “明确语音”只能来自严格结构化 Primary intent，或显式 `/voice on`。
 */
export function decideSpeechReply(input: {
  sessionPreference: SpeechReplyPreference | null;
  inboundAudio: boolean;
  modelDirective?: SpeechReplyDirective;
  replyPolicy?: SpeechReplyPolicy;
}): SpeechReplyDecision {
  if (input.sessionPreference === 'off') return { mode: 'text', reason: 'session_off' };
  if (input.modelDirective?.mode === 'text_only') return { mode: 'text', reason: 'model_text_directive' };
  if (input.modelDirective?.mode === 'voice_only') return { mode: 'voice', reason: 'model_directive' };
  if (input.sessionPreference === 'on') return { mode: 'voice', reason: 'session_on' };
  if (input.replyPolicy === 'explicit_only') {
    return { mode: 'text', reason: 'reply_policy_explicit_only' };
  }
  if (input.inboundAudio) return { mode: 'voice', reason: 'inbound_audio' };
  return { mode: 'text', reason: 'default_text' };
}

/**
 * 模型只声明受限语义动作、可见名称和三项精确的用户确认。平台 ID、
 * file_key、路径、Provider、模型及授权时间只允许由 Bridge/Runtime 从
 * 真实回合证据生成；缺少或改写任一确认字段时整项动作失败关闭。
 */
export function parseSpeechReferenceVoiceAction(candidate: unknown): SpeechReferenceVoiceAction | undefined {
  const raw = asRecord(candidate);
  if (!raw || raw.action !== 'create_reference_voice') return undefined;
  if (Object.keys(raw).some((key) => ![
    'action',
    'profile_name',
    'rights_basis',
    'usage_scope',
    'clean_single_speaker_confirmed',
    'reference_transcript',
    'reference_transcript_confirmed',
    'reference_transcript_source',
  ].includes(key))) return undefined;
  if (raw.rights_basis !== 'self_or_authorized'
    || raw.usage_scope !== 'local_tts_only'
    || raw.clean_single_speaker_confirmed !== true
    || raw.reference_transcript_confirmed !== true
    || typeof raw.reference_transcript !== 'string'
    || (raw.reference_transcript_source !== undefined && raw.reference_transcript_source !== 'user_confirmed')) {
    return undefined;
  }
  const referenceTranscript = typeof raw.reference_transcript === 'string' ? raw.reference_transcript
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim() : undefined;
  if (!referenceTranscript || referenceTranscript.length > 1_000) return undefined;
  const baseAction: SpeechReferenceVoiceAction = {
    action: 'create_reference_voice',
    rightsBasis: 'self_or_authorized',
    usageScope: 'local_tts_only',
    cleanSingleSpeakerConfirmed: true,
    referenceTranscriptSource: 'user_confirmed',
    ...(referenceTranscript ? { referenceTranscript } : {}),
    referenceTranscriptConfirmed: true,
  };
  if (raw.profile_name === undefined) return baseAction;
  if (typeof raw.profile_name !== 'string') return undefined;
  const profileName = raw.profile_name.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim();
  if (!profileName || profileName.length > 80) return undefined;
  return { ...baseAction, profileName };
}

/**
 * 语音只能替代“单一、纯文本”的最终呈现。代码、附件、卡片、平台点名或
 * 权限确认都含有无法可靠朗读/替代的信息，因此必须保留原始文字与结构化交付。
 */
export function evaluateSpeechSynthesisEligibility(input: {
  text: string;
  imageCount?: number;
  fileCount?: number;
  hasInteractiveContent?: boolean;
  mentionCount?: number;
  permissionRequested?: boolean;
}): SpeechSynthesisEligibilityDecision {
  if (input.permissionRequested) return { eligible: false, reason: 'permission_flow' };
  if (input.hasInteractiveContent) return { eligible: false, reason: 'interactive_content' };
  if ((input.mentionCount || 0) > 0) return { eligible: false, reason: 'platform_mention' };
  if (/(?:^|\n)\s{0,3}(?:`{3,}|~{3,})[^\n]*(?:\n|$)|<pre(?:\s|>)/iu.test(input.text)) {
    return { eligible: false, reason: 'fenced_code' };
  }
  if ((input.imageCount || 0) > 0 || /!\[[^\]]*\]\([^)]*\)|<img(?:\s|>)/iu.test(input.text)) {
    return { eligible: false, reason: 'image_content' };
  }
  if ((input.fileCount || 0) > 0) return { eligible: false, reason: 'file_content' };
  if (!normalizeSpeechSynthesisText(input.text)) return { eligible: false, reason: 'empty_text' };
  return { eligible: true, reason: 'eligible' };
}

/** Runtime 身份快照也按不透明安全 ID 校验，Core 不硬编码具体 Provider 或模型名。 */
export function parseSpeechSynthesisIdentity(candidate: unknown): SpeechSynthesisIdentity | null {
  const raw = asRecord(candidate);
  if (!raw
    || typeof raw.ttsModelId !== 'string'
    || !SPEECH_MODEL_ID_PATTERN.test(raw.ttsModelId.trim())
    || typeof raw.modelRevision !== 'string'
    || !SPEECH_MODEL_REVISION_PATTERN.test(raw.modelRevision.trim())
    || (raw.voiceProfileId !== null
      && (typeof raw.voiceProfileId !== 'string'
        || !SPEECH_VOICE_PROFILE_ID_PATTERN.test(raw.voiceProfileId.trim())))
    || Object.keys(raw).some((key) => !['ttsModelId', 'modelRevision', 'voiceProfileId'].includes(key))) {
    return null;
  }
  return {
    ttsModelId: raw.ttsModelId.trim(),
    modelRevision: raw.modelRevision.trim(),
    voiceProfileId: typeof raw.voiceProfileId === 'string' ? raw.voiceProfileId.trim() : null,
  };
}

export function parseSpeechReferenceVoiceImportReceipt(
  candidate: unknown,
  expected: {
    requestMessageId: string;
    sourceMessageId: string;
    fileKey: string;
    attachmentId: string;
    fileSha256: string;
    authorizationExpiresAt: string;
  },
): SpeechReferenceVoiceImportReceipt | null {
  const raw = asRecord(candidate);
  if (!raw
    || raw.protocol !== 'cti-speech-reference-voice-import/v1'
    || raw.validated !== true
    || typeof raw.voiceProfileId !== 'string'
    || !SPEECH_VOICE_PROFILE_ID_PATTERN.test(raw.voiceProfileId.trim())
    || raw.requestMessageId !== expected.requestMessageId
    || raw.sourceMessageId !== expected.sourceMessageId
    || raw.fileKey !== expected.fileKey
    || raw.attachmentId !== expected.attachmentId
    || raw.fileSha256 !== expected.fileSha256
    || raw.authorizationExpiresAt !== expected.authorizationExpiresAt
    || raw.registrationStatus !== 'registered'
    || raw.speakerSimilarityStatus !== 'not_verified') {
    return null;
  }
  return {
    protocol: 'cti-speech-reference-voice-import/v1',
    voiceProfileId: raw.voiceProfileId.trim(),
    requestMessageId: expected.requestMessageId,
    sourceMessageId: expected.sourceMessageId,
    fileKey: expected.fileKey,
    attachmentId: expected.attachmentId,
    fileSha256: expected.fileSha256,
    authorizationExpiresAt: expected.authorizationExpiresAt,
    registrationStatus: 'registered',
    speakerSimilarityStatus: 'not_verified',
    validated: true,
  };
}

/** Core 只接受与完整请求身份精确绑定、适合飞书原生上传的 Opus 受管产物。 */
export function parseSpeechSynthesisReceipt(
  candidate: unknown,
  expected: { text: string; expectedIdentity: SpeechSynthesisIdentity },
): SpeechSynthesisReceipt | null {
  const raw = asRecord(candidate);
  const expectedIdentity = expected.expectedIdentity;
  if (!raw
    || raw.protocol !== SPEECH_SYNTHESIS_PROTOCOL
    || raw.validated !== true
    || typeof raw.path !== 'string'
    || !path.isAbsolute(raw.path)
    || typeof raw.mediaType !== 'string'
    || !/^audio\/(?:ogg|opus)(?:\s*;|$)/iu.test(raw.mediaType.trim())
    || typeof raw.format !== 'string'
    || raw.format.trim().toLowerCase() !== 'opus'
    || typeof raw.durationMs !== 'number'
    || !Number.isFinite(raw.durationMs)
    || raw.durationMs <= 0
    || typeof raw.textSha256 !== 'string'
    || !SHA256_PATTERN.test(raw.textSha256.toLowerCase())
    || typeof raw.fileSha256 !== 'string'
    || !SHA256_PATTERN.test(raw.fileSha256.toLowerCase())
    || raw.ttsModelId !== expectedIdentity.ttsModelId
    || raw.modelRevision !== expectedIdentity.modelRevision
    || !Object.prototype.hasOwnProperty.call(raw, 'voiceProfileId')
    || raw.voiceProfileId !== expectedIdentity.voiceProfileId
    || raw.generationStatus !== 'generated'
    || raw.deliveryStatus !== 'not_sent'
    || (raw.speakerSimilarityStatus !== 'passed' && raw.speakerSimilarityStatus !== 'not_verified' && raw.speakerSimilarityStatus !== 'not_applicable')) {
    return null;
  }
  const similarityFieldsPresent = ['speakerSimilarity', 'speakerSimilarityThreshold', 'speakerSimilarityPassed']
    .some((key) => Object.prototype.hasOwnProperty.call(raw, key));
  if ((raw.speakerSimilarityStatus === 'passed' && (!similarityFieldsPresent
    || typeof raw.speakerSimilarity !== 'number'
    || !Number.isFinite(raw.speakerSimilarity)
    || raw.speakerSimilarity < -1
    || raw.speakerSimilarity > 1
    || typeof raw.speakerSimilarityThreshold !== 'number'
    || !Number.isFinite(raw.speakerSimilarityThreshold)
    || raw.speakerSimilarityThreshold < 0
    || raw.speakerSimilarityThreshold > 1
    || raw.speakerSimilarity < raw.speakerSimilarityThreshold
    || raw.speakerSimilarityPassed !== true))
    || ((raw.speakerSimilarityStatus === 'not_applicable' || raw.speakerSimilarityStatus === 'not_verified') && similarityFieldsPresent)) return null;
  if (similarityFieldsPresent && (
    typeof raw.speakerSimilarity !== 'number'
    || !Number.isFinite(raw.speakerSimilarity)
    || raw.speakerSimilarity < -1
    || raw.speakerSimilarity > 1
    || typeof raw.speakerSimilarityThreshold !== 'number'
    || !Number.isFinite(raw.speakerSimilarityThreshold)
    || raw.speakerSimilarityThreshold < 0
    || raw.speakerSimilarityThreshold > 1
    || raw.speakerSimilarity < raw.speakerSimilarityThreshold
    || raw.speakerSimilarityPassed !== true
  )) return null;
  const expectedTextSha256 = crypto.createHash('sha256').update(expected.text, 'utf8').digest('hex');
  if (raw.textSha256.toLowerCase() !== expectedTextSha256) return null;
  return {
    protocol: SPEECH_SYNTHESIS_PROTOCOL,
    path: path.normalize(raw.path),
    mediaType: raw.mediaType.trim().toLowerCase(),
    format: 'opus',
    durationMs: raw.durationMs,
    textSha256: raw.textSha256.toLowerCase(),
    fileSha256: raw.fileSha256.toLowerCase(),
    validated: true,
    ttsModelId: expectedIdentity.ttsModelId,
    modelRevision: expectedIdentity.modelRevision,
    voiceProfileId: expectedIdentity.voiceProfileId,
    generationStatus: 'generated',
    deliveryStatus: 'not_sent',
    speakerSimilarityStatus: raw.speakerSimilarityStatus,
    ...(similarityFieldsPresent ? {
      speakerSimilarity: raw.speakerSimilarity as number,
      speakerSimilarityThreshold: raw.speakerSimilarityThreshold as number,
      speakerSimilarityPassed: true as const,
    } : {}),
  };
}

/** 参考音色导入失败只对外暴露可操作的稳定结论。 */
export function referenceVoiceImportFailureMessage(error: unknown): string {
  const raw = asRecord(error);
  const code = raw?.errorCode ?? raw?.code;
  if (code === 'voice_reference_transcript_unconfirmed') {
    return '参考音色未登记：请先明确提供或确认录音中的准确文本。';
  }
  if (code === 'voice_reference_transcript_mismatch') {
    return '参考音色未登记：确认文本与本次语音识别结果不一致，已停止后续合成。请修正文本或换一段清晰录音。';
  }
  return '参考音色未登记：Runtime 导入失败，请检查参考文本、录音质量和本地依赖状态。';
}

export function speechFailureDiagnosticCode(error: unknown, phase: 'transcribe' | 'synthesize'): string {
  const record = asRecord(error);
  const rawCode = record?.errorCode ?? record?.code;
  return typeof rawCode === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(rawCode)
    ? rawCode.toLowerCase()
    : phase === 'transcribe' ? 'speech_transcription_failed' : 'speech_synthesis_failed';
}

export function speechFailureMessage(error: unknown, phase: 'transcribe' | 'synthesize'): string {
  const code = speechFailureDiagnosticCode(error, phase);
  if (phase === 'transcribe') {
    if (code === 'speech_input_too_large' || code === 'audio_too_large') {
      return '这条语音超过了本地转写上限，请缩短语音后重试。';
    }
    if (code === 'speech_input_too_long' || code === 'audio_too_long') {
      return '这条语音时长超过了本地转写上限，请分段发送后重试。';
    }
    if (code === 'speech_no_speech'
      || code === 'speech_empty_transcript'
      || code === 'asr_no_speech'
      || code === 'asr_empty_transcript') {
      return '这条语音里没有识别到可用内容，请靠近麦克风后重试，或直接发送文字。';
    }
    if (code === 'speech_timeout' || code === 'sensevoice_timeout' || code === 'sidecar_request_timeout') {
      return '本地语音转写超时了，请稍后重试，或直接发送文字。';
    }
    if (code === 'speech_reply_instruction_missing') {
      return '已识别被回复的旧语音，但当前消息没有新的问题或操作要求，请补充一条文字说明。';
    }
    if (code === 'speech_input_unavailable') return '这条语音未能从飞书完整获取，请重新发送语音，或直接发送文字。';
    if (code === 'speech_optional_missing' || code === 'speech_not_ready' || code === 'speech_input_disabled') {
      return '本地语音转写尚未就绪，请先在控制面板完成语音依赖检查，或直接发送文字。';
    }
    return '这条语音暂时无法完成本地转写，请重试或直接发送文字。';
  }
  if (code === 'voice_clone_similarity_below_threshold') {
    return '语音已停止：说话人相似度未通过阈值，未发送音频。';
  }
  if (code === 'voice_clone_similarity_not_verified') {
    return '语音已停止：当前音色尚未完成说话人相似度验收，未发送音频。';
  }
  if (code === 'voice_reference_not_active') {
    return '语音已停止：当前没有已激活并通过验收的复刻音色；未使用预设音色冒充。请先在控制面板完成参考音色登记、相似度验收并激活。';
  }
  if (code === 'tts_synthesis_timeout' || code === 'sidecar_request_timeout' || code === 'speech_timeout') {
    return '语音生成超时：生成状态为“未完成”，发送状态为“未发送”；已改为发送完整文字结果（仅一次）。';
  }
  if (code === 'speech_delivery_failed') {
    return '语音已生成，但飞书原生语音发送失败：发送状态为“未发送”；已改为发送完整文字结果（仅一次）。';
  }
  if (code === 'tts_output_not_opus' || code === 'speech_invalid_synthesis_receipt' || code === 'tts_model_identity_mismatch') {
    return '语音生成结果未通过格式或身份验收：发送状态为“未发送”；已改为发送完整文字结果（仅一次）。';
  }
  if (code === 'speech_not_ready' || code === 'speech_synthesis_identity_unavailable' || code === 'speech_output_disabled') {
    return '语音 Runtime 尚未就绪：生成状态为“未开始”，发送状态为“未发送”；已改为发送完整文字结果（仅一次）。';
  }
  return '语音未生成或未通过验收：发送状态为“未发送”；已改为发送完整文字结果（仅一次）。';
}
