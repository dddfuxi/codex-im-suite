import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { assertRegularNonSymlink } from './dependency-resolution.js';
import { runNoShell } from './subprocess.js';

export type AudioFormat = 'wav' | 'ogg' | 'mp3' | 'flac' | 'm4a' | 'webm';

export interface ValidatedAudio {
  path: string;
  format: AudioFormat;
  size: number;
  sha256: string;
  durationMs: number;
  codec?: string;
  sampleRate?: number;
  channels?: number;
}
export function sniffAudioHeader(header: Buffer): AudioFormat | null {
  if (header.length >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav';
  if (header.length >= 4 && header.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  if (header.length >= 4 && header.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac';
  if (header.length >= 3 && header.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3';
  if (header.length >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0) return 'mp3';
  if (header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp') return 'm4a';
  if (header.length >= 4 && header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) return 'webm';
  return null;
}

export function hashFileSha256(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count = 0;
    do {
      count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count > 0) hash.update(buffer.subarray(0, count));
    } while (count > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

interface ProbePayload {
  format?: { duration?: string };
  streams?: Array<{ codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number }>;
}

export async function validateAudio(input: {
  filePath: string;
  ffprobePath: string;
  maxBytes: number;
  maxDurationMs: number;
  expectedSha256?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ValidatedAudio> {
  const absolutePath = path.resolve(input.filePath);
  const stat = assertRegularNonSymlink(absolutePath);
  if (stat.size <= 0) throw new Error('audio_empty');
  if (stat.size > input.maxBytes) throw new Error('audio_too_large');
  const descriptor = fs.openSync(absolutePath, 'r');
  const header = Buffer.alloc(32);
  let length = 0;
  try {
    length = fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const format = sniffAudioHeader(header.subarray(0, length));
  if (!format) throw new Error('audio_header_unsupported');
  const sha256 = hashFileSha256(absolutePath);
  if (input.expectedSha256 && sha256 !== input.expectedSha256.trim().toLowerCase()) throw new Error('audio_sha256_mismatch');
  const probe = await runNoShell(input.ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,channels',
    '-of', 'json', absolutePath,
  ], { signal: input.signal, timeoutMs: input.timeoutMs });
  if (probe.code !== 0) throw new Error('ffprobe_failed');
  let payload: ProbePayload;
  try { payload = JSON.parse(probe.stdout) as ProbePayload; } catch { throw new Error('ffprobe_invalid_json'); }
  const seconds = Number(payload.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('audio_duration_invalid');
  const durationMs = Math.round(seconds * 1000);
  if (durationMs > input.maxDurationMs) throw new Error('audio_too_long');
  const stream = payload.streams?.find((item) => item.codec_type === 'audio');
  if (!stream) throw new Error('audio_stream_missing');
  return {
    path: absolutePath,
    format,
    size: stat.size,
    sha256,
    durationMs,
    codec: stream.codec_name,
    sampleRate: Number(stream.sample_rate) || undefined,
    channels: stream.channels,
  };
}

export async function normalizeForAsr(input: {
  ffmpegPath: string;
  sourcePath: string;
  outputPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  const result = await runNoShell(input.ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input.sourcePath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', input.outputPath,
  ], { signal: input.signal, timeoutMs: input.timeoutMs });
  if (result.code !== 0) throw new Error('ffmpeg_asr_normalize_failed');
}

/** Sidecar 统一产出 WAV；Runtime 再转 16kHz 单声道 Opus 供渠道交付。 */
export async function wavToMonoOpus(input: {
  ffmpegPath: string;
  sourcePath: string;
  outputPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  const result = await runNoShell(input.ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input.sourcePath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '32k',
    '-vbr', 'on', '-application', 'voip', '-f', 'ogg', input.outputPath,
  ], { signal: input.signal, timeoutMs: input.timeoutMs });
  if (result.code !== 0) throw new Error('ffmpeg_opus_encode_failed');
}
