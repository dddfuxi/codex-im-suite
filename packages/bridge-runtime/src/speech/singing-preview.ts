import crypto from 'node:crypto';
import fs from 'node:fs';

import { assertRegularNonSymlink } from './dependency-resolution.js';
import type { AceStepSingingHost, RuntimeSingingSynthesisReceipt } from './ace-step-singing-host.js';
import { RuntimeSpeechError } from './runtime-types.js';
import {
  MAX_SPEECH_PREVIEW_BYTES,
  SPEECH_PREVIEW_PROTOCOL,
  type SpeechPreviewReceipt,
} from './speech-preview.js';

/** 歌声试听固定短时长，避免面板误触发完整歌曲和长时间占用 GPU。 */
export async function createSingingVoicePreview(input: {
  host: AceStepSingingHost;
  lyrics: string;
  modelId: string;
  voiceProfileId: string;
  signal?: AbortSignal;
  benchmarkMode?: boolean;
  modelRevision?: string;
}): Promise<SpeechPreviewReceipt> {
  let synthesis: RuntimeSingingSynthesisReceipt | undefined;
  try {
    synthesis = await input.host.synthesizeSong({
      prompt: '清晰自然的中文流行人声，简洁伴奏，适合作为歌声音色试听',
      lyrics: input.lyrics,
      vocalLanguage: 'zh',
      durationSeconds: 10,
      signal: input.signal,
      ...(input.benchmarkMode ? { benchmarkMode: true } : {}),
    });
    if (synthesis.protocol !== 'cti-singing-synthesis/v1'
      || synthesis.mediaType !== 'audio/ogg; codecs=opus'
      || synthesis.format !== 'opus'
      || synthesis.validated !== true
      || (input.voiceProfileId === 'acestep.default'
        ? Boolean(synthesis.voiceProfileId)
        : synthesis.voiceProfileId !== input.voiceProfileId)) {
      throw new RuntimeSpeechError('singing_preview_receipt_invalid', 'blocked', '歌声试听回执无效');
    }
    const stat = assertRegularNonSymlink(synthesis.path);
    if (stat.size <= 0 || stat.size > MAX_SPEECH_PREVIEW_BYTES) {
      throw new RuntimeSpeechError('singing_preview_media_too_large', 'blocked', '歌声试听超过大小限制');
    }
    const bytes = fs.readFileSync(synthesis.path);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== stat.size || sha256 !== synthesis.fileSha256) {
      throw new RuntimeSpeechError('singing_preview_media_changed', 'blocked', '歌声试听产物已变化');
    }
    return {
      protocol: SPEECH_PREVIEW_PROTOCOL,
      mediaType: 'audio/ogg; codecs=opus',
      base64: bytes.toString('base64'),
      bytes: bytes.length,
      sha256,
      durationMs: synthesis.durationMs,
      modelId: input.modelId,
      voiceProfileId: input.voiceProfileId,
      ...(input.benchmarkMode ? {
        modelRevision: input.modelRevision,
        peakVramMiB: synthesis.peakVramMiB,
      } : {}),
      validated: true,
    };
  } finally {
    if (synthesis) {
      try { input.host.releaseSynthesis(synthesis); } catch { /* 清理失败不能覆盖试听主结果。 */ }
    }
  }
}
