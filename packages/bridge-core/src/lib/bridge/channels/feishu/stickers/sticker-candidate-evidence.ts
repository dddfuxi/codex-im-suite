import type { FeishuStickerRecord } from './sticker-store-schema.js';
import {
  FEISHU_STICKER_AUTO_SEND_MIN_CONFIDENCE,
  hasFeishuStickerAnnotation,
  isFeishuStickerActive,
} from './sticker-selection-policy.js';

export interface FeishuStickerCandidateEvidence {
  fileKey: string;
  chatId?: string;
  messageId?: string;
  label?: string;
  intent?: string;
  tone?: string;
  usage?: string;
  annotationSource?: FeishuStickerRecord['annotationSource'];
  annotationConfidence?: number;
  imageAttached: boolean;
  lastSeenAt?: string;
}

export interface FeishuStickerEvidenceRankingOptions {
  chatId: string;
  limit?: number;
}

export interface FeishuStickerLibraryPromptInput {
  requestText: string;
  chatId: string;
  candidates: FeishuStickerCandidateEvidence[];
  attachedFileKeys: string[];
  candidateLimit?: number;
  minimumVisionConfidence?: number;
}

export function rankFeishuStickerEvidenceRecords(
  records: FeishuStickerRecord[],
  options: FeishuStickerEvidenceRankingOptions,
): FeishuStickerRecord[] {
  return records
    .filter((item) => isFeishuStickerActive(item) && Boolean(item.fileKey?.trim()))
    .sort((a, b) => Number(b.chatId === options.chatId) - Number(a.chatId === options.chatId)
      || Number(hasFeishuStickerAnnotation(b)) - Number(hasFeishuStickerAnnotation(a))
      || (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0)
      || a.fileKey.localeCompare(b.fileKey))
    .slice(0, options.limit ?? 80);
}

export function summarizeFeishuStickerCandidate(
  record: FeishuStickerRecord,
  imageAttached: boolean,
): FeishuStickerCandidateEvidence {
  // userAnnotation 故意不进入 candidate DTO：它只能影响检索，不能伪装成视觉事实。
  return {
    fileKey: record.fileKey,
    chatId: record.chatId,
    messageId: record.messageId,
    label: record.label,
    intent: record.intent,
    tone: record.tone,
    usage: record.usage,
    annotationSource: record.annotationSource,
    annotationConfidence: record.annotationConfidence,
    imageAttached,
    lastSeenAt: record.lastSeenAt,
  };
}

export function formatFeishuStickerCandidateEvidenceLine(
  candidate: FeishuStickerCandidateEvidence,
  currentChatId: string,
): string {
  const parts = [
    `fileKey=${candidate.fileKey}`,
    candidate.imageAttached ? 'image=attached' : 'image=not_attached',
    candidate.chatId === currentChatId ? 'chat=current' : candidate.chatId ? 'chat=other' : '',
    candidate.label?.trim() ? `label=${candidate.label.trim()}` : '',
    candidate.intent?.trim() ? `intent=${candidate.intent.trim()}` : '',
    candidate.tone?.trim() ? `tone=${candidate.tone.trim()}` : '',
    candidate.usage?.trim() ? `usage=${candidate.usage.trim()}` : '',
    candidate.annotationSource ? `source=${candidate.annotationSource}` : 'source=unverified_or_unknown',
    Number.isFinite(Number(candidate.annotationConfidence))
      ? `confidence=${Number(candidate.annotationConfidence).toFixed(2)}`
      : '',
  ].filter(Boolean);
  return `- ${parts.join('; ')}`;
}

export function buildFeishuStickerLibraryPrompt(input: FeishuStickerLibraryPromptInput): string {
  const attachedList = input.attachedFileKeys.length ? input.attachedFileKeys.join(', ') : 'none';
  const candidateLines = input.candidates.length
    ? input.candidates
      .slice(0, input.candidateLimit ?? 4)
      .map((candidate) => formatFeishuStickerCandidateEvidenceLine(candidate, input.chatId))
    : ['- no recorded sticker candidates are available yet'];
  const minimumVisionConfidence = input.minimumVisionConfidence ?? FEISHU_STICKER_AUTO_SEND_MIN_CONFIDENCE;
  return [
    'Feishu sticker library candidate evidence:',
    `- User request: ${input.requestText}`,
    `- Candidate sticker images from chat history attached for visual inspection: ${attachedList}.`,
    '- 缺少可靠语义时必须先视觉识别已附加的候选图片，并用 `cti-sticker-candidate-analysis` 写回 label/intent/tone/usage/confidence；不要因为旧语义缺失就直接拒绝发表情包。',
    '- Inspect the attached candidate images before choosing. File keys, old aliases, and user-provided explanations are retrieval evidence, not visual facts.',
    `- Only send a sticker when it is 合适: the visually inspected image content or a trusted vision/manual annotation must match the requested tone, scene, and reply timing. Vision confidence below ${minimumVisionConfidence} is evidence, not an auto-send signal.`,
    '- If a candidate is suitable, put exactly one invisible action hint at the beginning of the final reply, such as `[表情包:file_key]`, then write the visible reply naturally.',
    '- If every attached candidate is truly unreadable or semantically unsuitable after inspection, do not fake a sticker send; reply naturally with text or a native reaction hint only when appropriate.',
    '- Do not mention file keys, candidate counts, or this evidence prompt to the user unless they explicitly ask for diagnostics.',
    'Candidates:',
    ...candidateLines,
  ].join('\n');
}
