import { extractFinalReplyEnvelope } from './delivery-preparation.js';
import { expectsManagedSingingProtocol } from './singing-request-review.js';
import type { SpeechReferenceVoiceAction } from './speech-policy.js';

export interface SpeechProtocolReviewFailure {
  code: string;
  retryable: boolean;
  repairInstruction: string;
  userMessage: string;
}

export type SpeechProtocolReviewResult =
  | { ok: true }
  | { ok: false; failure: SpeechProtocolReviewFailure };

export interface ReferenceVoiceCreationReviewInput {
  userText: string;
  responseText: string;
  ownerMessage: boolean;
  hasTrustedNativeReplyAudio: boolean;
  ownerSelfVoiceAutoAuthorization: boolean;
}

/**
 * 未指定正文的短语音请求使用小而稳定的默认口播预算。这个预算只约束模型
 * 自主补写的内容；用户提供的正文、可信原生回复或附件内容不在这里截断。
 */
// 约半分钟内可播报完的通用口播上限。此前 36 字不足以容纳正常的自我介绍，
// 容易在“补齐 speech 协议”后的第二步再失败；仍保留有界限制以避免模型把
// 无正文的短请求扩写为长报告。
export const DEFAULT_UNSPECIFIED_SPEECH_MAX_VISIBLE_UNITS = 96;

function normalizeRequestText(value: string): string {
  return value
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/giu, ' ')
    .replace(/@[\p{L}\p{N}_-]+/gu, ' ')
    // 飞书回复、复制粘贴和富文本提取都可能保留正文外层引号。引号不是语义
    // 边界的一部分；先归一化，才能让“用音频回复我”这类明确请求稳定命中
    // 后续通用意图规则，而不是退化为普通文本聊天。
    .replace(/[“”"'‘’«»「」『』]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * 识别“创建一个可持久使用的参考音色”这一语义动作。单独的“克隆/复刻”只在
 * 本轮确有可信原生回复音频时成立，避免把代码克隆、文件复制等普通请求误路由。
 */
export function expectsReferenceVoiceCreation(
  userText: string,
  hasTrustedNativeReplyAudio = false,
): boolean {
  const normalized = normalizeRequestText(userText);
  if (!normalized) return false;
  if (/(?:不要|别|不用|无需|停止|取消)(?:再|继续|给我|帮我)?[^，。！？\n]{0,10}(?:克隆|复刻|复制|创建|登记|保存)[^，。！？\n]{0,12}(?:音色|声音|语音|录音)/u.test(normalized)
    || /\b(?:do\s+not|don't|dont|stop|cancel)\b[^.!?]{0,28}\b(?:clone|copy|create)\b[^.!?]{0,24}\bvoice\b/iu.test(normalized)) {
    return false;
  }

  // “用刚刚克隆的音色说话”是在消费既有音色，不是创建动作。
  if (/(?:刚刚|已经|已|之前|上次|先前)[^，。！？\n]{0,10}(?:克隆|复刻|复制)(?:出来|得到)?的(?:音色|声音)/u.test(normalized)) {
    return false;
  }

  const explicitVoiceObject = /(?:克隆|复刻|复制)[^，。！？\n]{0,18}(?:音色|声音|语音|录音)|(?:音色|声音|语音|录音)[^，。！？\n]{0,18}(?:克隆|复刻|复制)|(?:创建|生成|登记|保存|导入)[^，。！？\n]{0,18}参考(?:音色|声音)|参考(?:音色|声音)[^，。！？\n]{0,18}(?:创建|生成|登记|保存|导入)/u.test(normalized)
    || /\b(?:clone|copy)\b[^.!?]{0,32}\b(?:voice|speaker|recording)\b|\b(?:create|import|register|save)\b[^.!?]{0,24}\breference\s+(?:voice|speaker)\b/iu.test(normalized);
  if (explicitVoiceObject) return true;

  return hasTrustedNativeReplyAudio
    && (/^(?:请|麻烦|帮我|给我|现在|直接|再|重新)?\s*(?:克隆|复刻)(?:一下|这个|它|吧|啊|呀|～|~|。|！|!)?$/u.test(normalized)
      || /^(?:please\s+)?(?:clone|copy)(?:\s+it|\s+this)?[.!]?$/iu.test(normalized));
}

/**
 * 解析用户显式提供的逐字参考文本。普通对话与 ASR 结果不会被当作用户确认；
 * Owner 的“克隆这条录音”路径走独立 runtime_revalidated 协议，由 Runtime 二次 ASR。
 */
export function extractExplicitReferenceTranscript(userText: string): string | undefined {
  const normalized = userText.replace(/\r\n?/gu, '\n').trim();
  if (!normalized) return undefined;
  const label = /(?:^|[\n；;。！？])\s*(?:参考文本|逐字文本|准确文本|录音文本|录音内容|语音内容|实际说的是|音频说的是)\s*(?:为|是|如下)?\s*[:：]\s*([\s\S]+)$/u.exec(normalized);
  if (!label?.[1]) return undefined;
  const transcript = label[1]
    .replace(/^\s*[“”"'‘’]+/u, '')
    .replace(/[“”"'‘’]+\s*$/u, '')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim();
  return transcript && transcript.length <= 1_000 ? transcript : undefined;
}

/**
 * 自动授权策略只补权利/用途/单人录音三项声明；参考文本由 Runtime 二次 ASR 核验。
 * 返回的仍是受限语义动作，平台身份、路径和音色 ID 继续由 Bridge/Runtime 绑定。
 */
export function buildOwnerAutoAuthorizedReferenceVoiceAction(input: {
  userText: string;
  ownerMessage: boolean;
  hasTrustedNativeReplyAudio: boolean;
  ownerSelfVoiceAutoAuthorization: boolean;
}): SpeechReferenceVoiceAction | undefined {
  if (!input.ownerMessage
    || !input.hasTrustedNativeReplyAudio
    || !input.ownerSelfVoiceAutoAuthorization
    || !expectsReferenceVoiceCreation(input.userText, true)) return undefined;
  return {
    action: 'create_reference_voice',
    rightsBasis: 'self_or_authorized',
    usageScope: 'local_tts_only',
    cleanSingleSpeakerConfirmed: true,
    referenceTranscriptSource: 'runtime_revalidated',
    referenceTranscriptConfirmed: true,
  };
}

/**
 * 明确克隆请求必须进入受管动作，不能让 Primary 用 Bash/附件或一段口头承诺旁路。
 * 自动授权开启时不再要求用户填写固定参考文本格式；逐字质量门禁仍由 Runtime 保留。
 */
export function reviewReferenceVoiceCreationProtocol(
  input: ReferenceVoiceCreationReviewInput,
): SpeechProtocolReviewResult {
  if (!expectsReferenceVoiceCreation(input.userText, input.hasTrustedNativeReplyAudio)) return { ok: true };
  if (!input.ownerMessage) {
    return {
      ok: false,
      failure: {
        code: 'reference_voice_owner_required',
        retryable: false,
        repairInstruction: '',
        userMessage: '参考音色未创建：该动作只允许当前 Bridge Owner 使用自己的录音发起。',
      },
    };
  }
  if (!input.hasTrustedNativeReplyAudio) {
    return {
      ok: false,
      failure: {
        code: 'reference_voice_native_audio_required',
        retryable: false,
        repairInstruction: '',
        userMessage: '参考音色未创建：没有找到当前请求绑定的可读取音频附件；请直接回复或附加一条真实录音后重试。',
      },
    };
  }

  if (input.ownerSelfVoiceAutoAuthorization) {
    // Bridge 会基于同一当前消息构造确定性动作，Runtime 负责二次 ASR 核验。
    return { ok: true };
  }

  const envelope = extractFinalReplyEnvelope(input.responseText);
  if (envelope?.speech_action) return { ok: true };

  return {
    ok: false,
    failure: {
      code: 'missing_managed_reference_voice_protocol',
      retryable: true,
      repairInstruction: [
        'The user explicitly requested creation of a local reference voice from the trusted native-reply audio, but the response omitted speech_action.',
        'Only if the user explicitly confirmed recording rights, local-TTS-only use, and clean single-speaker audio, return one cti-final envelope with speech_action.action="create_reference_voice" and a user_confirmed reference transcript.',
        'For the Owner auto-authorized path, the Bridge supplies a runtime_revalidated ASR candidate and the Runtime performs the second ASR check. Never use Bash, a local path, a file attachment, a provider/model/profile ID, or a claim of success.',
      ].join(' '),
      userMessage: '参考音色未创建：当前请求没有形成可由受管 SpeechHost 验证的参考音色动作。',
    },
  };
}

/**
 * 把“当前交付未按语音完成”拆成媒介、交付动作、未完成状态三个独立信号，
 * 避免为某一句现场原文维护整句匹配。这里仍只决定是否要求 Primary 补协议，
 * 不直接启动 TTS。
 */
function describesUnmetSpeechDelivery(value: string): boolean {
  const mentionsSpeechMedium = /(?:语音|音频|声音)(?:消息|回复|结果)?/u.test(value)
    || /\b(?:voice|audio)(?:\s+(?:message|reply|response|result))?\b/iu.test(value);
  if (!mentionsSpeechMedium) return false;

  const mentionsDeliveryAction = /(?:发(?:送|出|出来|给)?|回(?:复)?|答复|响应|送达|播报|朗读|念|读|说|收到|听到)/u.test(value)
    || /\b(?:send|sent|deliver|delivered|reply|respond|response|speak|read|receive|received|hear|heard)\b/iu.test(value);
  const mentionsUnmetState = /(?:还没|没有|没能|没收到|没听到|未|不曾|不再|漏发|失败|未成功|未完成|未送达)/u.test(value)
    || /\b(?:not|never|missing|failed|failure|didn'?t|hasn'?t|haven'?t|wasn'?t|weren'?t)\b/iu.test(value);
  return mentionsDeliveryAction && mentionsUnmetState;
}

/** 抽象能力、其他窗口或一般配置咨询不能被提升成本轮语音交付授权。 */
function isSpeechCapabilityConsultation(value: string): boolean {
  const remoteScope = /(?:别的|其他|其它|另一个|所有|每个)[^，。！？\n]{0,12}(?:窗口|会话|聊天|机器人|账号|设备)/u.test(value)
    || /\b(?:other|another|every|all)\b[^.!?]{0,24}\b(?:window|session|chat|bot|account|device)s?\b/iu.test(value);
  const capabilityQuestion = /(?:语音|音频|声音|音色)(?:能力|功能|配置|开关|问题|可用吗|能用吗|支持吗)/u.test(value)
    || /(?:会|能|可以|支持)(?:不会|不能)?[^，。！？\n]{0,18}(?:语音|音频|声音)/u.test(value)
    || /\b(?:can|does|do|support|capability|feature|setting|configuration)\b[^.!?]{0,36}\b(?:voice|audio|speak)\b/iu.test(value);
  return remoteScope || capabilityQuestion;
}

/**
 * 当前回合明确要求停止语音时，绝不能因为它刚好回复了一条旧语音请求而把旧
 * 请求重新继承回来。该判断与普通语音请求共用同一归一化边界，避免不同入口
 * 对“不要发语音”出现相反结论。
 */
function hasExplicitSpeechOptOut(value: string): boolean {
  return /(?:不要|别|不用|无需|不需要|停止|取消)(?:再|继续|给我|帮我|用[^，。！？\n]{0,12})?(?:发|发送|回|回复|播报|朗读|念|读|说)?(?:语音|声音|音色)/u.test(value)
    || /\b(?:do\s+not|don't|dont|stop)\b[^.!?]{0,24}\b(?:voice|audio|speak|read)\b/iu.test(value);
}

/**
 * 这里只识别必须由 Primary 补齐受管语音呈现协议的明确请求，不直接授权 TTS。
 * `/voice off`、Runtime 身份、音色可用性和平台交付仍由 Bridge/Host 的真实门禁裁决。
 */
export function expectsManagedSpeechProtocol(userText: string): boolean {
  const normalized = normalizeRequestText(userText);
  if (!normalized || expectsManagedSingingProtocol(normalized)) return false;

  if (hasExplicitSpeechOptOut(normalized)) return false;

  // 先排除抽象能力/跨窗口咨询，避免其中偶然出现“发送”就被当作本轮授权。
  if (isSpeechCapabilityConsultation(normalized)) return false;

  // 当前回复已明确出现“语音媒介 + 交付动作 + 未完成状态”时视为交付纠正。
  // 三类信号可以按不同自然语序组合，不依赖一条固定问题句。
  if (describesUnmetSpeechDelivery(normalized)) return true;

  // 生成报错、音色问题等描述若没有本轮交付动作，不是“现在生成一条语音”的授权。
  if (/(?:语音|声音|音色)(?:问题|失败|报错)/u.test(normalized)) return false;

  const directVoiceDelivery = /(?:^|[，。！？；,;]\s*)(?:(?:你|您|请你|麻烦你)\s*)?(?:(?:请|麻烦|帮我|给我|为我|现在|直接|再|重新)\s*)?(?:发|发送|回|回复|播报|朗读|念|读|说)(?:一条|一段|一句|个|一下|出来|给我|给大家|给他|给她|给他们)?[^，。！？\n]{0,24}(?:语音|音频|声音)/u;
  const voiceFirstDelivery = /(?:^|[，。！？；,;]\s*)(?:(?:你|您|请你|麻烦你)\s*)?(?:(?:请|麻烦|帮我|给我|为我|现在|直接|再|重新)\s*)?(?:用|以|通过)?(?:一条|一段|一句|个)?(?:语音|音频|声音)(?:来|去|形式)?(?:发|发送|回|回复|播报|朗读|念|读|说)/u;
  const namedVoiceAction = /(?:^|[，。！？；,;]\s*)(?:(?:请|麻烦|帮我|给我|为我|现在|直接|再|重新)\s*)?用[^，。！？\n]{0,28}(?:音色|语音|音频|声音)(?:来|去|给我|给大家|给他|给她|给他们)?(?:发|发送|打(?:个)?招呼|问候|介绍|播报|朗读|念|读|说|回复|回)/u;
  const englishVoiceDelivery = /\b(?:send|reply|respond|say|speak|read|announce|greet)\b[^.!?]{0,40}\b(?:voice|audio|voice\s+message)\b|\b(?:in|with|as)\b[^.!?]{0,20}\b(?:voice|audio|voice\s+message)\b/iu;
  return directVoiceDelivery.test(normalized)
    || voiceFirstDelivery.test(normalized)
    || namedVoiceAction.test(normalized)
    || englishVoiceDelivery.test(normalized);
}

/**
 * 飞书中“只 @ 机器人并原生回复”的入站文本会被平台层还原成一条通用续办
 * 描述。它只说明用户要继续处理被回复项，本身不应覆盖其中已经明确的语音
 * 交付要求。这里严格限制为无新业务语义的续办动作，且调用方还必须先证明
 * 被回复正文唯一、可信并已恢复；普通引用、模糊上下文和任何新指令均不继承。
 */
function isGenericReplyContinuationRequest(value: string): boolean {
  if (!value) return true;
  if (/^请处理我在本条(?:飞书)?话题中回复或引用的消息[。！!]?$/u.test(value)) return true;
  return /^(?:(?:请|麻烦|帮我|给我|现在|直接)\s*)?(?:(?:继续|接着|照旧|重试|再试|重新)(?:处理|执行|发送|发|回复|来|做)?|(?:再|重新)(?:处理|执行|发送|发|回复|来|做)(?:一下|下)?|按(?:这条|上一条|前一条|刚才|原来|之前)(?:继续|处理|执行|发送|发|回复)?)(?:一下|下|吧|啊|呀|。|！|!|？|\?)?$/u.test(value);
}

export interface EffectiveSpeechRequest {
  /** 统一交给协议 expectation / review 的文本；绝不包含平台 ID、路径或模型字段。 */
  userText: string;
  /** 是否由唯一可信的原生回复目标继承而来，供调用方建立审计级呈现语义。 */
  inheritedFromTrustedReply: boolean;
}

/**
 * 决定本轮语音协议究竟以当前请求还是被回复的明确语音请求为准。原生回复
 * 续办只继承“需要受管语音交付”这一受限意图，Runtime 可用性、会话 /voice
 * 开关、音色和真实投递仍由原有 Bridge/Host 门禁处理。
 */
export function resolveEffectiveSpeechRequest(input: {
  currentText: string;
  trustedNativeReplyText?: string;
}): EffectiveSpeechRequest {
  const currentText = input.currentText.trim();
  const normalizedCurrent = normalizeRequestText(currentText);
  // 当前消息自己的明确语音请求或明确关闭语音，永远优先于历史请求。
  if (expectsManagedSpeechProtocol(currentText) || hasExplicitSpeechOptOut(normalizedCurrent)) {
    return { userText: currentText, inheritedFromTrustedReply: false };
  }

  const trustedNativeReplyText = input.trustedNativeReplyText?.trim() || '';
  if (!trustedNativeReplyText
    || !expectsManagedSpeechProtocol(trustedNativeReplyText)
    || !isGenericReplyContinuationRequest(normalizedCurrent)) {
    return { userText: currentText, inheritedFromTrustedReply: false };
  }

  return { userText: trustedNativeReplyText, inheritedFromTrustedReply: true };
}

/** 指定“克隆/复刻/参考音色”时，只签发类别要求，不解析或信任模型音色 ID。 */
export function expectsActiveReferenceVoice(userText: string): boolean {
  const normalized = normalizeRequestText(userText);
  if (!normalized || !expectsManagedSpeechProtocol(normalized)) return false;
  return /(?:克隆|复刻|复制|参考)(?:的|出来的|得到的)?(?:音色|声音)|(?:音色|声音)(?:克隆|复刻|复制)/u.test(normalized)
    || /\b(?:cloned|clone|reference)\s+voice\b/iu.test(normalized);
}

/**
 * 明确语音请求若缺少 speech 协议，只允许无副作用地修复一次；Conversation
 * Engine 会在已经调用工具或请求权限时失败关闭，避免 Shell/TTS 文件旁路。
 */
export function reviewSpeechReplyProtocol(input: {
  userText: string;
  responseText: string;
  sessionVoiceDisabled?: boolean;
  /** 当前回合是否已有唯一且可靠的原生回复/附件正文可供朗读。 */
  hasReferencedContent?: boolean;
}): SpeechProtocolReviewResult {
  if (input.sessionVoiceDisabled || !expectsManagedSpeechProtocol(input.userText)) return { ok: true };
  const envelope = extractFinalReplyEnvelope(input.responseText);
  const referenceVoiceRequired = expectsActiveReferenceVoice(input.userText);
  const validEnvelope = envelope?.speech?.mode === 'voice_only'
    && (!referenceVoiceRequired || envelope.speech.voiceRequirement === 'active_reference')
    && envelope.kind === 'text'
    && envelope.images.length === 0
    && envelope.files.length === 0
    && !envelope.speech_action
    && !envelope.singing
    && !envelope.choice_prompt
    && !envelope.choice_flow
    && !envelope.choice_session
    && !envelope.analysis_view;
  if (validEnvelope) {
    const normalizedRequest = normalizeRequestText(input.userText);
    const requestUnits = Array.from(normalizedRequest).length;
    const visibleResponseUnits = Array.from(envelope.text.normalize('NFKC').replace(/\s+/gu, ' ').trim()).length;
    // 短请求且没有可信引用内容时，长篇正文只能来自模型自行扩写。先做一次
    // response-only 修复，避免把无正文的短语音请求扩成长故事后交给慢模型跑数分钟。
    if (!input.hasReferencedContent
      && requestUnits <= 24
      && visibleResponseUnits > DEFAULT_UNSPECIFIED_SPEECH_MAX_VISIBLE_UNITS) {
      return {
        ok: false,
        failure: {
          code: 'speech_default_content_budget_exceeded',
          retryable: true,
          repairInstruction: [
            'The user requested a spoken result but did not supply or reference long content.',
            `Keep the cti-final speech directive unchanged and rewrite only the visible text to at most ${DEFAULT_UNSPECIFIED_SPEECH_MAX_VISIBLE_UNITS} Unicode characters.`,
            'Preserve the user-requested meaning. Do not invent a story, report, list, or other long-form material merely to fill the voice reply.',
            'Return one complete cti-final envelope. Do not call tools or claim that audio was generated or sent.',
          ].join(' '),
          userMessage: '未完成：默认语音回复内容过长，已停止进入本地合成；请补充要朗读的正文或明确需要的内容长度。',
        },
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    failure: {
      code: 'missing_managed_speech_protocol',
      retryable: true,
      repairInstruction: [
        'The original request explicitly asks for a spoken voice result, but the previous response did not include a valid cti-final speech directive.',
        referenceVoiceRequired
          ? 'Return one complete cti-final envelope with a complete useful text fallback, empty images/files, speech.mode="voice_only", and speech.voice_requirement="active_reference". Do not select a voice ID.'
          : 'Return one complete cti-final envelope with a complete useful text fallback, empty images/files, and exactly speech.mode="voice_only".',
        'Do not decide or claim that the current chat/session lacks speech capability; the Bridge-owned Runtime verifies actual availability and performs synthesis and native audio delivery.',
        ...(!input.hasReferencedContent && Array.from(normalizeRequestText(input.userText)).length <= 24
          ? [`The user did not provide long content. Keep the visible spoken text at most ${DEFAULT_UNSPECIFIED_SPEECH_MAX_VISIBLE_UNITS} Unicode characters; do not invent a long story or report.`]
          : []),
        'Do not call tools, run TTS or edge-tts, create MP3/WAV files, include local paths, select a provider/model/profile ID, or claim that audio was generated or sent.',
      ].join(' '),
      userMessage: '未完成：明确语音请求没有形成可由受管 SpeechHost 验证的语音指令；普通 TTS、MP3 或文件附件不会被当作原生语音发送。',
    },
  };
}
