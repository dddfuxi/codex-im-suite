import crypto from 'node:crypto';
import path from 'node:path';

import type { SingingSynthesisReceipt } from '../host.js';

export interface SingingReplyDirective {
  mode: 'song_only';
  prompt: string;
  lyrics: string;
  vocalLanguage: string;
  durationSeconds: number;
}

const ALLOWED_KEYS = new Set(['mode', 'prompt', 'lyrics', 'vocal_language', 'duration_seconds']);
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
  if (!prompt || !lyrics || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8}){0,2}$/u.test(vocalLanguage)
    || !Number.isFinite(durationSeconds) || durationSeconds < 10 || durationSeconds > 600) return undefined;
  return { mode: 'song_only', prompt, lyrics, vocalLanguage, durationSeconds };
}

export function singingRequestSha256(input: SingingReplyDirective): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    prompt: input.prompt,
    lyrics: input.lyrics,
    vocalLanguage: input.vocalLanguage,
    durationSeconds: input.durationSeconds,
  }), 'utf8').digest('hex');
}

export function parseSingingSynthesisReceipt(
  candidate: unknown,
  directive: SingingReplyDirective,
): SingingSynthesisReceipt | null {
  const raw = asRecord(candidate);
  const expectedRequestSha256 = singingRequestSha256(directive);
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
    || !SHA256_PATTERN.test(raw.fileSha256.toLowerCase())) return null;
  return {
    protocol: 'cti-singing-synthesis/v1',
    path: path.resolve(raw.path),
    mediaType: 'audio/ogg; codecs=opus',
    format: 'opus',
    durationMs: raw.durationMs,
    requestSha256: expectedRequestSha256,
    fileSha256: raw.fileSha256.toLowerCase(),
    validated: true,
    ...(typeof raw.voiceProfileId === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(raw.voiceProfileId)
      ? { voiceProfileId: raw.voiceProfileId }
      : {}),
  };
}

export function singingFailureMessage(): string {
  return '本地歌声合成当前未完成，已保留完整歌词与说明；不会用普通语音合成冒充唱歌。';
}
