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
import type { SingingAudioContentPlanContract } from '@codex-im-suite/contracts/speech';

async function createSingingVoiceOutput(input: {
  host: AceStepSingingHost;
  plan: SingingAudioContentPlanContract;
  modelId: string;
  voiceProfileId: string;
  signal?: AbortSignal;
  benchmarkMode?: boolean;
  modelRevision?: string;
}): Promise<SpeechPreviewReceipt> {
  let synthesis: RuntimeSingingSynthesisReceipt | undefined;
  try {
    synthesis = await input.host.synthesizeSong({
      prompt: input.plan.stylePrompt,
      lyrics: input.plan.lyrics,
      vocalLanguage: input.plan.vocalLanguage,
      durationSeconds: input.plan.durationSeconds,
      ...(input.voiceProfileId !== 'acestep.default' ? { voiceRequirement: 'active_reference' as const } : {}),
      signal: input.signal,
      ...(input.benchmarkMode ? { benchmarkMode: true } : {}),
    });
    if (synthesis.protocol !== 'cti-singing-synthesis/v1'
      || synthesis.mediaType !== 'audio/ogg; codecs=opus'
      || synthesis.format !== 'opus'
      || synthesis.validated !== true
      || synthesis.generationStatus !== 'generated'
      || synthesis.deliveryStatus !== 'not_sent'
      || synthesis.lyricsAlignmentStatus !== 'passed'
      || synthesis.lyricsAlignmentPassed !== true
      || (input.voiceProfileId === 'acestep.default'
        ? synthesis.speakerSimilarityStatus !== 'not_applicable' || Boolean(synthesis.voiceProfileId)
        : synthesis.voiceProfileId !== input.voiceProfileId
          || synthesis.speakerSimilarityStatus !== 'passed'
          || synthesis.speakerSimilarityPassed !== true)) {
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
      generationStatus: 'generated',
      deliveryStatus: 'not_sent',
      speakerSimilarityStatus: synthesis.speakerSimilarityStatus,
      ...(synthesis.speakerSimilarityStatus === 'passed' ? {
        speakerSimilarity: synthesis.speakerSimilarity,
        speakerSimilarityThreshold: synthesis.speakerSimilarityThreshold,
        speakerSimilarityPassed: true,
      } : {}),
      lyricsAlignmentStatus: 'passed',
      lyricsAlignment: synthesis.lyricsAlignment,
      lyricsAlignmentThreshold: synthesis.lyricsAlignmentThreshold,
      lyricsAlignmentPassed: true,
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

/** 快速试听与完整生成复用同一受控计划和媒体验收，只在计划模式上区分。 */
export function createSingingVoicePreview(input: Omit<Parameters<typeof createSingingVoiceOutput>[0], 'plan'> & {
  plan: SingingAudioContentPlanContract;
}): Promise<SpeechPreviewReceipt> {
  if (input.plan.outputMode !== 'quick_preview' || input.plan.durationSeconds !== 10) {
    throw new RuntimeSpeechError('singing_preview_plan_invalid', 'blocked', '歌声快速试听计划无效');
  }
  return createSingingVoiceOutput(input);
}

export function createSingingVoiceGeneration(input: Omit<Parameters<typeof createSingingVoiceOutput>[0], 'plan'> & {
  plan: SingingAudioContentPlanContract;
}): Promise<SpeechPreviewReceipt> {
  if (input.plan.outputMode !== 'full_generation') {
    throw new RuntimeSpeechError('singing_generation_plan_invalid', 'blocked', '完整歌声生成计划无效');
  }
  return createSingingVoiceOutput(input);
}
