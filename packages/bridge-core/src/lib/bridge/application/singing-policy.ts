import crypto from 'node:crypto';
import path from 'node:path';

import type { SingingSynthesisReceipt } from '../host.js';

export interface SingingReplyDirective {
  mode: 'song_only';
  prompt: string;
  lyrics: string;
  vocalLanguage: string;
  durationSeconds: number;
  /** 类别要求；模型不能提供或选择具体音色 ID。 */
  voiceRequirement?: 'active_reference';
}

const ALLOWED_KEYS = new Set(['mode', 'prompt', 'lyrics', 'vocal_language', 'duration_seconds', 'voice_requirement']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown, maxChars: number, preserveLines = false): string {
  if (typeof value !== 'string') return '';
  const normalized = value.normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .replace(/\r\n?/gu, '\n');
  const text = preserveLines
    ? normalized.split('\n').map((line) => line.replace(/[\t ]+/gu, ' ').trim()).join('\n').trim()
    : normalized.replace(/\s+/gu, ' ').trim();
  return Array.from(text).length <= maxChars ? text : '';
}

/**
 * 模型只描述可见歌词与音乐风格；provider、模型、音色 ID、路径、URL、
 * token、平台身份均不在协议内。出现额外字段时整段失败关闭。
 */
export function parseSingingReplyDirective(candidate: unknown): SingingReplyDirective | undefined {
  const raw = asRecord(candidate);
  if (!raw || Object.keys(raw).some((key) => !ALLOWED_KEYS.has(key)) || raw.mode !== 'song_only') return undefined;
  const prompt = cleanText(raw.prompt, 500);
  const lyrics = cleanText(raw.lyrics, 6_000, true);
  const vocalLanguage = cleanText(raw.vocal_language ?? 'zh', 16).toLowerCase();
  const durationSeconds = raw.duration_seconds === undefined ? 15 : Number(raw.duration_seconds);
  const voiceRequirement = raw.voice_requirement === undefined
    ? undefined
    : raw.voice_requirement === 'active_reference'
      ? 'active_reference' as const
      : null;
  if (!prompt || !lyrics || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8}){0,2}$/u.test(vocalLanguage)
    || !Number.isFinite(durationSeconds) || durationSeconds < 10 || durationSeconds > 600
    || voiceRequirement === null) return undefined;
  return {
    mode: 'song_only', prompt, lyrics, vocalLanguage, durationSeconds,
    ...(voiceRequirement ? { voiceRequirement } : {}),
  };
}

export function singingRequestSha256(input: SingingReplyDirective): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    prompt: input.prompt,
    lyrics: input.lyrics,
    vocalLanguage: input.vocalLanguage,
    durationSeconds: input.durationSeconds,
    voiceRequirement: input.voiceRequirement || null,
  }), 'utf8').digest('hex');
}

export function parseSingingSynthesisReceipt(
  candidate: unknown,
  directive: SingingReplyDirective,
): SingingSynthesisReceipt | null {
  const raw = asRecord(candidate);
  const expectedRequestSha256 = singingRequestSha256(directive);
  const validScore = (value: unknown): value is number => typeof value === 'number'
    && Number.isFinite(value) && value >= 0 && value <= 1;
  const similarityFieldsPresent = raw?.speakerSimilarity !== undefined
    || raw?.speakerSimilarityThreshold !== undefined
    || raw?.speakerSimilarityPassed !== undefined;
  if (!raw
    || raw.protocol !== 'cti-singing-synthesis/v1'
    || raw.validated !== true
    || typeof raw.path !== 'string'
    || !path.isAbsolute(raw.path)
    || raw.mediaType !== 'audio/ogg; codecs=opus'
    || raw.format !== 'opus'
    || typeof raw.durationMs !== 'number'
    || !Number.isFinite(raw.durationMs)
    || raw.durationMs <= 0
    || raw.requestSha256 !== expectedRequestSha256
    || typeof raw.fileSha256 !== 'string'
    || !SHA256_PATTERN.test(raw.fileSha256.toLowerCase())
    || raw.generationStatus !== 'generated'
    || raw.deliveryStatus !== 'not_sent'
    || raw.lyricsAlignmentStatus !== 'passed'
    || raw.lyricsAlignmentPassed !== true
    || !validScore(raw.lyricsAlignment)
    || !validScore(raw.lyricsAlignmentThreshold)
    || raw.lyricsAlignment < raw.lyricsAlignmentThreshold
    || (raw.speakerSimilarityStatus !== 'passed' && raw.speakerSimilarityStatus !== 'not_applicable')
    || (raw.speakerSimilarityStatus === 'passed' && (
      raw.speakerSimilarityPassed !== true
      || !validScore(raw.speakerSimilarity)
      || !validScore(raw.speakerSimilarityThreshold)
      || raw.speakerSimilarity < raw.speakerSimilarityThreshold
    ))
    || (raw.speakerSimilarityStatus === 'not_applicable' && similarityFieldsPresent)
    || (directive.voiceRequirement === 'active_reference' && raw.speakerSimilarityStatus !== 'passed')) return null;
  const voiceProfileId = typeof raw.voiceProfileId === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(raw.voiceProfileId)
    ? raw.voiceProfileId
    : undefined;
  if (directive.voiceRequirement === 'active_reference' && !voiceProfileId) return null;
  const lyricsAlignment = raw.lyricsAlignment as number;
  const lyricsAlignmentThreshold = raw.lyricsAlignmentThreshold as number;
  const speakerSimilarity = raw.speakerSimilarity as number | undefined;
  const speakerSimilarityThreshold = raw.speakerSimilarityThreshold as number | undefined;
  return {
    protocol: 'cti-singing-synthesis/v1',
    path: path.resolve(raw.path),
    mediaType: 'audio/ogg; codecs=opus',
    format: 'opus',
    durationMs: raw.durationMs,
    requestSha256: expectedRequestSha256,
    fileSha256: raw.fileSha256.toLowerCase(),
    validated: true,
    generationStatus: 'generated',
    deliveryStatus: 'not_sent',
    ...(voiceProfileId ? { voiceProfileId } : {}),
    speakerSimilarityStatus: raw.speakerSimilarityStatus,
    ...(raw.speakerSimilarityStatus === 'passed' ? {
      speakerSimilarity: speakerSimilarity!,
      speakerSimilarityThreshold: speakerSimilarityThreshold!,
      speakerSimilarityPassed: true as const,
    } : {}),
    lyricsAlignmentStatus: 'passed',
    lyricsAlignment,
    lyricsAlignmentThreshold,
    lyricsAlignmentPassed: true,
  };
}

export function singingFailureMessage(error?: unknown): string {
  const raw = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : null;
  const code = raw?.errorCode ?? raw?.code;
  if (code === 'singing_reference_voice_not_active' || code === 'singing_voice_profile_incompatible') {
    return '歌声未生成：当前没有已激活且兼容的参考歌声音色；不会改用默认歌声冒充克隆音色。请先在语音面板选择参考歌声音色。';
  }
  if (code === 'singing_benchmark_not_verified') {
    return '歌声未生成：独立歌声模型尚未通过当前硬件性能门禁；不会用普通 TTS 冒充唱歌。';
  }
  if (code === 'singing_lyrics_alignment_below_threshold') {
    return '歌声已完成模型生成，但歌词逐字对齐未通过验收，因此未标记成功、也未发送。';
  }
  if (code === 'singing_voice_similarity_below_threshold') {
    return '歌声已完成模型生成，但克隆音色相似度未通过验收，因此未标记成功、也未发送。';
  }
  if (code === 'singing_similarity_model_unavailable' || code === 'singing_output_verifier_unavailable') {
    return '歌声未完成验收：歌词或音色验证器当前不可用，因此不会显示“克隆成功”，也不会发送未验收音频。';
  }
  if (code === 'singing_invalid_synthesis_receipt' || code === 'singing_output_acceptance_failed') {
    return '歌声未完成：Runtime 回执没有同时证明已生成、歌词通过及音色验收状态，音频未发送。';
  }
  return '本地歌声合成当前未完成，已保留完整歌词与说明；不会用普通语音合成冒充唱歌。';
}
