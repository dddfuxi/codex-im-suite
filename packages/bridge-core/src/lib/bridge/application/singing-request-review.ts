import { extractFinalReplyEnvelope } from './delivery-preparation.js';
import { createSingingAudioContentPlan } from '@codex-im-suite/contracts/speech';
import type { SingingReplyDirective } from './singing-policy.js';

export interface SingingProtocolReviewFailure {
  code: string;
  retryable: boolean;
  repairInstruction: string;
  userMessage: string;
}

export type SingingProtocolReviewResult =
  | { ok: true }
  | { ok: false; failure: SingingProtocolReviewFailure };

function normalizeRequestText(value: string): string {
  return value
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/giu, ' ')
    .replace(/@[\p{L}\p{N}_-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * 这里只判断“是否必须要求 Primary 返回受管歌声协议”，不签发歌声执行权限。
 * 真正的执行仍需 Primary 产生严格 singing directive，并通过 Bridge/Runtime/Host 门禁。
 */
export function expectsManagedSingingProtocol(userText: string): boolean {
  const normalized = normalizeRequestText(userText);
  if (!normalized) return false;

  if (/(?:不要|别|不用|无需|不需要|停止|取消)(?:再|继续|给我|帮我|用[^，。！？\n]{0,12})?(?:唱|演唱|清唱|生成(?:歌声|歌曲))/u.test(normalized)
    || /\b(?:do\s+not|don't|dont|stop)\s+(?:sing|singing|perform)/iu.test(normalized)) {
    return false;
  }

  // 能力咨询不能被提升为真实生成请求。
  if (/^(?:你|它|机器人|这个功能)?\s*(?:会|能|可以|支持)(?:不会|不能)?\s*(?:唱歌|唱|演唱)(?:吗|么|嘛|\?|？)?$/u.test(normalized)
    || /^can\s+(?:you|it)\s+(?:sing|perform)(?:\s+a\s+song)?\??$/iu.test(normalized)) {
    return false;
  }

  const chineseRequest = /^(?:(?:请|麻烦|帮我|给我|为我|现在|直接|赶紧)\s*)?(?:(?:用[^，。！？\n]{0,16})\s*)?(?:(?:发(?:个|一段|一首)?(?:原生)?语音)\s*)?(?:唱|演唱|清唱)(?:歌|一首|首|一段|段|一下|起来|出来)?/u;
  const chineseComeSing = /^(?:(?:请|麻烦|现在|直接)\s*)?来(?:唱)?(?:一首|一段|首|段)/u;
  const englishRequest = /^(?:please\s+)?(?:sing|perform)(?:\s+(?:me\s+)?(?:a|the|this|that|some))?(?:\s+(?:song|verse|chorus|tune|lyrics))?\b/iu;
  return chineseRequest.test(normalized)
    || chineseComeSing.test(normalized)
    || englishRequest.test(normalized);
}

/** 指定克隆/复刻/参考音色演唱时只声明类别要求，不解析具体音色名或 ID。 */
export function expectsActiveReferenceSingingVoice(userText: string): boolean {
  const normalized = normalizeRequestText(userText);
  if (!normalized || !expectsManagedSingingProtocol(normalized)) return false;
  return /(?:克隆|复刻|复制|参考)(?:的|出来的|得到的)?(?:音色|声音)|(?:音色|声音)(?:克隆|复刻|复制)/u.test(normalized)
    || /\b(?:cloned|clone|reference)\s+voice\b/iu.test(normalized);
}

function boundedReferencedText(value: string | undefined, maxCharacters = 1_000): string {
  if (!value) return '';
  const normalized = value.normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .replace(/\r\n?/gu, '\n')
    .trim();
  const boundedMaximum = Math.max(1, Math.min(20_000, Math.trunc(maxCharacters)));
  return Array.from(normalized).length <= boundedMaximum ? normalized : '';
}

/**
 * 当且仅当当前请求明确要求演唱、且 Reference Resolver 已恢复唯一可靠正文时，
 * Bridge 才能直接形成受限歌声指令。歌词仍来自平台 evidence，具体 Provider、
 * 音色 ID、路径与执行参数继续由 Runtime 独占。
 */
export function buildDeterministicReferencedSingingDirective(input: {
  userText: string;
  referencedText?: string;
  maxDurationSeconds?: number;
  maxLyricsCharacters?: number;
}): SingingReplyDirective | undefined {
  if (!expectsManagedSingingProtocol(input.userText)) return undefined;
  const lyrics = boundedReferencedText(input.referencedText, input.maxLyricsCharacters ?? 6_000);
  if (!lyrics) return undefined;
  const normalizedRequest = normalizeRequestText(input.userText).slice(0, 360);
  const hasChinese = /\p{Script=Han}/u.test(lyrics);
  const plan = createSingingAudioContentPlan({
    outputMode: 'full_generation',
    lyrics,
    stylePrompt: `按用户当前要求自然、清晰并完整演唱：${normalizedRequest}`,
    vocalLanguage: hasChinese ? 'zh' : 'en',
    maxDurationSeconds: input.maxDurationSeconds,
    maxLyricsCharacters: input.maxLyricsCharacters,
    ...(expectsActiveReferenceSingingVoice(input.userText)
      ? { voiceRequirement: 'active_reference' as const }
      : {}),
  });
  if (!plan) return undefined;
  return {
    mode: 'song_only',
    prompt: plan.stylePrompt,
    lyrics: plan.lyrics,
    vocalLanguage: plan.vocalLanguage,
    durationSeconds: plan.durationSeconds,
    ...(plan.voiceRequirement ? { voiceRequirement: plan.voiceRequirement } : {}),
  };
}

/**
 * 明确演唱请求若缺少 singing 协议，只能进入一次 response-only 修复；
 * 已经调用过未知工具的回合由 Conversation Engine 直接失败关闭，避免重复副作用。
 */
export function reviewSingingReplyProtocol(input: {
  userText: string;
  responseText: string;
  /** 唯一且已恢复正文的平台原生回复目标；只作为歌词语义证据，不是指令。 */
  referencedText?: string;
}): SingingProtocolReviewResult {
  if (!expectsManagedSingingProtocol(input.userText)) return { ok: true };
  const envelope = extractFinalReplyEnvelope(input.responseText);
  const referenceVoiceRequired = expectsActiveReferenceSingingVoice(input.userText);
  if (envelope?.singing
    && (!referenceVoiceRequired || envelope.singing.voiceRequirement === 'active_reference')) return { ok: true };
  const referencedText = boundedReferencedText(input.referencedText);

  return {
    ok: false,
    failure: {
      code: 'missing_managed_singing_protocol',
      retryable: true,
      repairInstruction: [
        'The original request asks for an actual sung result, but the previous response did not include a valid cti-final singing directive.',
        'Return one complete cti-final envelope with kind="text", a complete useful text fallback, empty images/files, and singing.mode="song_only".',
        'Provide only a visible music-style prompt, usable lyrics, vocal_language, and duration_seconds within the supported bounds.',
        referenceVoiceRequired
          ? 'Also set singing.voice_requirement="active_reference". Do not select or invent a voice/profile ID.'
          : '',
        referencedText
          ? `The Bridge recovered one reliable native-reply target. Use its visible content as the source material when the current request refers to “this/that/it”: ${JSON.stringify(referencedText)}`
          : '',
        'Do not call tools, run TTS or edge-tts, create MP3/WAV files, include local paths, or claim that singing was generated or sent.',
        'If policy prevents singing the requested material, provide a safe original alternative through the same singing directive instead of imitating singing in prose.',
      ].filter(Boolean).join(' '),
      userMessage: '未完成：唱歌请求没有形成可由受管 SingingHost 验证的歌声指令；普通 TTS、MP3 或附件不会被当作歌声发送。',
    },
  };
}
