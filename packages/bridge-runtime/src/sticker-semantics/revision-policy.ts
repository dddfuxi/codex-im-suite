import type { StickerSemanticPatch, StickerSemanticAsset, StickerSemanticRevisionV1 } from './types.js';

export interface VerifiedStickerFeedback {
  evidenceHash: string;
  evidenceId: string;
  sessionId: string;
  kind: 'positive' | 'negative' | 'neutral' | 'ambiguous';
  strength: 'normal' | 'strong';
  confidence: number;
  occurredAt: string;
}

export interface StickerRevisionPolicyOptions {
  confirmationThreshold?: number;
}

function hasSeenEvidence(current: StickerSemanticRevisionV1, evidenceHash: string): boolean {
  return current.supportEvidenceHashes.includes(evidenceHash)
    || current.contradictionEvidenceHashes.includes(evidenceHash);
}

function appendUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}

export function applyStickerFeedback(
  current: StickerSemanticRevisionV1,
  feedback: VerifiedStickerFeedback,
  options: StickerRevisionPolicyOptions = {},
): StickerSemanticRevisionV1 {
  if (hasSeenEvidence(current, feedback.evidenceHash)) return current;
  if (feedback.kind === 'neutral' || feedback.kind === 'ambiguous') return current;

  if (feedback.kind === 'negative') {
    const contradictionEvidenceHashes = appendUnique(current.contradictionEvidenceHashes, feedback.evidenceHash);
    const contradictionSessionIds = appendUnique(current.contradictionSessionIds, feedback.sessionId);
    if (feedback.strength === 'strong') {
      return {
        ...current,
        status: 'regressed',
        restoredVersionId: current.previousConfirmedVersionId,
        contradictionEvidenceHashes,
        contradictionSessionIds,
        updatedAt: feedback.occurredAt,
      };
    }
    return {
      ...current,
      contradictionEvidenceHashes,
      contradictionSessionIds,
      updatedAt: feedback.occurredAt,
    };
  }

  const supportEvidenceHashes = appendUnique(current.supportEvidenceHashes, feedback.evidenceHash);
  const supportSessionIds = appendUnique(current.supportSessionIds, feedback.sessionId);
  const confirmationThreshold = Math.max(1, Math.floor(options.confirmationThreshold ?? 3));
  return {
    ...current,
    status: current.status === 'trial' && supportSessionIds.length >= confirmationThreshold
      ? 'confirmed'
      : current.status,
    supportEvidenceHashes,
    supportSessionIds,
    updatedAt: feedback.occurredAt,
  };
}

const AUTOMATIC_PATCH_FIELDS = new Set(['intent', 'tone', 'usage', 'aliases', 'examples', 'avoidRules']);

export function applyAutomaticPatch(
  asset: StickerSemanticAsset,
  patch: StickerSemanticPatch & Record<string, unknown>,
): StickerSemanticPatch {
  const forbiddenFields = Object.keys(patch).filter((key) => !AUTOMATIC_PATCH_FIELDS.has(key));
  if (forbiddenFields.length > 0) {
    throw new Error(asset.visual.source === 'manual' ? 'manual_field_locked' : 'automatic_patch_field_forbidden');
  }
  return {
    intent: typeof patch.intent === 'string' ? patch.intent : undefined,
    tone: typeof patch.tone === 'string' ? patch.tone : undefined,
    usage: typeof patch.usage === 'string' ? patch.usage : undefined,
    aliases: Array.isArray(patch.aliases) ? [...patch.aliases] : undefined,
    examples: Array.isArray(patch.examples) ? [...patch.examples] : undefined,
    avoidRules: Array.isArray(patch.avoidRules) ? patch.avoidRules.map((item) => ({ ...item })) : undefined,
  };
}
