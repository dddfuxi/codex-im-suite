import crypto from 'node:crypto';
import fs from 'node:fs';

import { assertRegularNonSymlink } from './dependency-resolution.js';
import {
  RuntimeSpeechError,
} from './runtime-types.js';
import type {
  RuntimeSpeechSynthesisReceipt,
} from './runtime-speech-host.js';

export const SPEECH_PREVIEW_PROTOCOL = 'codex-im-suite/speech-preview/v2' as const;
export const MAX_SPEECH_PREVIEW_BYTES = 4 * 1024 * 1024;
export const MAX_SPEECH_PREVIEW_TEXT_CHARACTERS = 240;

export interface SpeechPreviewReceipt {
  protocol: typeof SPEECH_PREVIEW_PROTOCOL;
  mediaType: 'audio/ogg; codecs=opus';
  base64: string;
  bytes: number;
  sha256: string;
  durationMs: number;
  modelId: string;
  voiceProfileId: string;
  /** 仅 benchmark mailbox 使用，不进入浏览器试听协议。 */
  modelRevision?: string;
  peakVramMiB?: number;
  validated: true;
}

export interface SpeechPreviewHost {
  synthesize(input: {
    text: string;
    voiceProfileId?: string;
    benchmarkMode?: boolean;
    trustedPreviewMode?: boolean;
    signal?: AbortSignal;
  }): Promise<RuntimeSpeechSynthesisReceipt>;
  releaseSynthesis(receipt: RuntimeSpeechSynthesisReceipt): void;
}

function validateSynthesisReceipt(
  receipt: RuntimeSpeechSynthesisReceipt,
  ttsModelId: string,
  voiceProfileId: string,
): void {
  if (
    receipt.protocol !== 'cti-speech-synthesis/v1'
    || receipt.validated !== true
    || receipt.mediaType !== 'audio/ogg; codecs=opus'
    || receipt.format !== 'opus'
    || receipt.voiceProfileId !== voiceProfileId
    || receipt.ttsModelId !== ttsModelId
    || !Number.isFinite(receipt.durationMs)
    || receipt.durationMs <= 0
    || !/^[a-f0-9]{64}$/u.test(receipt.fileSha256)
  ) {
    throw new RuntimeSpeechError(
      'speech_preview_receipt_invalid',
      'blocked',
      '语音试听产物回执无效',
    );
  }
}

/**
 * 试听只把已经过 Host 校验的 Ogg/Opus 编码进受限回执。
 * 文件路径始终留在 Runtime 内，并在构造回执后立即释放。
 */
export async function createSpeechVoicePreview(input: {
  host: SpeechPreviewHost;
  text: string;
  ttsModelId: string;
  voiceProfileId: string;
  benchmarkMode?: boolean;
  signal?: AbortSignal;
}): Promise<SpeechPreviewReceipt> {
  let synthesis: RuntimeSpeechSynthesisReceipt | undefined;
  try {
    synthesis = await input.host.synthesize({
      text: input.text,
      voiceProfileId: input.voiceProfileId,
      trustedPreviewMode: true,
      ...(input.benchmarkMode ? { benchmarkMode: true } : {}),
      signal: input.signal,
    });
    validateSynthesisReceipt(synthesis, input.ttsModelId, input.voiceProfileId);

    let stat: fs.Stats;
    try {
      stat = assertRegularNonSymlink(synthesis.path);
    } catch {
      throw new RuntimeSpeechError(
        'speech_preview_media_unsafe',
        'blocked',
        '语音试听产物不是安全的普通文件',
      );
    }
    if (
      !Number.isSafeInteger(stat.size)
      || stat.size <= 0
      || stat.size > MAX_SPEECH_PREVIEW_BYTES
    ) {
      throw new RuntimeSpeechError(
        'speech_preview_media_too_large',
        'blocked',
        '语音试听产物超过安全大小限制',
      );
    }

    const bytes = fs.readFileSync(synthesis.path);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== stat.size || sha256 !== synthesis.fileSha256) {
      throw new RuntimeSpeechError(
        'speech_preview_media_changed',
        'blocked',
        '语音试听产物在读取时发生变化',
      );
    }

    return {
      protocol: SPEECH_PREVIEW_PROTOCOL,
      mediaType: 'audio/ogg; codecs=opus',
      base64: bytes.toString('base64'),
      bytes: bytes.length,
      sha256,
      durationMs: synthesis.durationMs,
      modelId: input.ttsModelId,
      voiceProfileId: input.voiceProfileId,
      ...(input.benchmarkMode ? {
        modelRevision: synthesis.modelRevision,
        ...(synthesis.peakVramMiB !== undefined ? { peakVramMiB: synthesis.peakVramMiB } : {}),
      } : {}),
      validated: true,
    };
  } finally {
    // 无论编码、Hash 或大小门禁是否通过，试听临时文件都不能跨请求保留。
    if (synthesis) {
      try {
        input.host.releaseSynthesis(synthesis);
      } catch {
        // 清理属于观察链；不得覆盖已经完成并验证的试听结果或原始失败原因。
      }
    }
  }
}
