import crypto from 'node:crypto';

import type { StickerSemanticEvolutionHost } from 'claude-to-im/src/lib/bridge/host.js';
import type {
  StickerExpressionPromptSection,
  StickerFeedbackCandidate,
  StickerFeedbackResult,
  StickerSelectionRequest,
} from 'claude-to-im/src/lib/bridge/sticker-semantic-evolution.js';

import type { StickerFeedbackClassification, StickerFeedbackClassifier } from './feedback-classifier.js';
import { applyAutomaticPatch, applyStickerFeedback } from './revision-policy.js';
import type { StickerSemanticStore } from './store.js';
import type {
  StickerAvoidRuleV1,
  StickerSemanticAsset,
  StickerSemanticFeedbackRecordV1,
  StickerSemanticRevisionV1,
  StickerSemanticScopeName,
} from './types.js';

export interface StickerSemanticPromptBuilder {
  build(input: { channelType: string; chatId: string; userId?: string; maxChars: number }): Promise<StickerExpressionPromptSection | null> | StickerExpressionPromptSection | null;
}

export interface StickerSemanticHostOptions {
  store: StickerSemanticStore;
  classifier: StickerFeedbackClassifier;
  promptBuilder?: StickerSemanticPromptBuilder;
  confirmationThreshold?: number;
  now?: () => string;
  randomId?: () => string;
}

function scopePriority(scope: StickerSemanticScopeName): number {
  return scope === 'user' ? 3 : scope === 'chat' ? 2 : 1;
}

function scopeMatches(revision: StickerSemanticRevisionV1, input: StickerSelectionRequest): boolean {
  if (revision.scope === 'global') return true;
  if (revision.scope === 'chat') return revision.scopeId === input.chatId;
  return Boolean(input.userId) && revision.scopeId === input.userId;
}

function effectiveRevision(revisions: StickerSemanticRevisionV1[], input: StickerSelectionRequest): StickerSemanticRevisionV1 | null {
  return revisions
    .filter((item) => item.fileKey === input.fileKey)
    .filter((item) => item.status === 'confirmed' || item.status === 'trial')
    .filter((item) => scopeMatches(item, input))
    .sort((left, right) => {
      const scopeDifference = scopePriority(right.scope) - scopePriority(left.scope);
      if (scopeDifference !== 0) return scopeDifference;
      if (left.status !== right.status) return left.status === 'confirmed' ? -1 : 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    })[0] || null;
}

function deterministicReaction(candidate: StickerFeedbackCandidate): Pick<StickerFeedbackClassification, 'kind' | 'confidence' | 'strength' | 'reason' | 'patch'> | null {
  if (candidate.relation !== 'reaction') return null;
  const reaction = candidate.reactionType?.trim().toLowerCase();
  if (!reaction) return null;
  if (['thumbsup', 'like', 'heart', 'smile', 'applause'].includes(reaction)) {
    return { kind: 'positive', confidence: 1, strength: 'normal', reason: 'positive_native_reaction', patch: {} };
  }
  if (['thumbsdown', 'dislike', 'angry'].includes(reaction)) {
    return { kind: 'negative', confidence: 1, strength: 'normal', reason: 'negative_native_reaction', patch: {} };
  }
  return { kind: 'neutral', confidence: 1, strength: 'normal', reason: 'neutral_native_reaction', patch: {} };
}

function feedbackRecord(
  candidate: StickerFeedbackCandidate,
  delivery: { deliveryId: string; fileKey: string; sessionId: string },
  decision: StickerFeedbackClassification,
): StickerSemanticFeedbackRecordV1 {
  return {
    schema: 'codex-im-suite/sticker-semantic-feedback/v1',
    feedbackId: decision.evidenceHash,
    deliveryId: delivery.deliveryId,
    evidenceId: candidate.evidenceId,
    evidenceHash: decision.evidenceHash,
    fileKey: delivery.fileKey,
    sessionId: delivery.sessionId,
    kind: decision.kind,
    scope: decision.scope,
    scopeId: decision.scopeId,
    confidence: decision.confidence,
    strength: decision.strength,
    reason: decision.reason,
    createdAt: candidate.createdAt,
  };
}

function buildAvoidRules(input: {
  decision: StickerFeedbackClassification;
  now: string;
  randomId: () => string;
}): StickerAvoidRuleV1[] | undefined {
  if (!input.decision.patch.avoidRules?.length) return undefined;
  return input.decision.patch.avoidRules.map((draft) => ({
    id: input.randomId(),
    category: draft.category,
    condition: draft.condition,
    scope: input.decision.scope,
    scopeId: input.decision.scopeId,
    status: 'trial',
    confidence: input.decision.confidence,
    supportCount: 1,
    contradictionCount: 0,
    evidenceHashes: [input.decision.evidenceHash],
    createdAt: input.now,
    updatedAt: input.now,
  }));
}

function newRevision(input: {
  asset: StickerSemanticAsset;
  decision: StickerFeedbackClassification;
  baseHash: string;
  now: string;
  randomId: () => string;
  previousConfirmedVersionId?: string;
  supportSessionId: string;
}): StickerSemanticRevisionV1 {
  const revisionId = input.randomId();
  const patch = applyAutomaticPatch(input.asset, {
    intent: input.decision.patch.intent,
    tone: input.decision.patch.tone,
    usage: input.decision.patch.usage,
    aliases: input.decision.patch.aliases,
    examples: input.decision.patch.examples,
    avoidRules: buildAvoidRules({ decision: input.decision, now: input.now, randomId: input.randomId }),
  });
  return {
    schema: 'codex-im-suite/sticker-semantic-revision/v1',
    revisionId,
    fileKey: input.asset.fileKey,
    scope: input.decision.scope,
    scopeId: input.decision.scopeId,
    status: 'trial',
    versionId: input.randomId(),
    previousConfirmedVersionId: input.previousConfirmedVersionId,
    baseHash: input.baseHash,
    patch,
    supportEvidenceHashes: [input.decision.evidenceHash],
    contradictionEvidenceHashes: [],
    supportSessionIds: [input.supportSessionId],
    contradictionSessionIds: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function createStickerSemanticEvolutionHost(options: StickerSemanticHostOptions): StickerSemanticEvolutionHost {
  const now = options.now || (() => new Date().toISOString());
  const randomId = options.randomId || (() => crypto.randomUUID());
  return {
    async authorizeSelection(input) {
      const snapshot = options.store.readSnapshot();
      const asset = snapshot.assets.find((item) => item.fileKey === input.fileKey);
      if (!asset || asset.archived || asset.disabled) return null;
      const revision = effectiveRevision(snapshot.revisions, input);
      if (!revision) return null;
      const contextHash = crypto.createHash('sha256').update(JSON.stringify({
        fileKey: input.fileKey,
        revisionId: revision.revisionId,
        chatId: input.chatId,
        userId: input.userId || '',
        contextText: input.contextText.replace(/\s+/gu, ' ').trim(),
      }), 'utf8').digest('hex');
      return { fileKey: input.fileKey, semanticRevisionId: revision.revisionId, contextHash };
    },
    async recordDelivery(evidence) {
      options.store.recordDelivery(evidence);
    },
    async findDeliveriesByOutboundMessageIds(messageIds) {
      return options.store.findDeliveries(messageIds);
    },
    async processFeedback(candidate): Promise<StickerFeedbackResult> {
      const delivery = options.store.findDeliveries([candidate.referencedOutboundMessageId])
        .find((item) => item.chatId === candidate.chatId && item.channelType === candidate.channelType);
      if (!delivery) return { status: 'ignored', reason: 'delivery_not_found' };
      const snapshot = options.store.readSnapshot();
      const asset = snapshot.assets.find((item) => item.fileKey === delivery.fileKey);
      if (!asset) return { status: 'ignored', reason: 'sticker_not_found' };
      if (asset.archived || asset.disabled) return { status: 'ignored', reason: 'sticker_archived' };

      const deterministic = deterministicReaction(candidate);
      const classified = deterministic
        ? {
            ...deterministic,
            scope: 'chat' as const,
            scopeId: delivery.chatId,
            deliveryId: delivery.deliveryId,
            evidenceId: candidate.evidenceId,
            evidenceHash: crypto.createHash('sha256').update(`${delivery.deliveryId}:${candidate.evidenceId}`, 'utf8').digest('hex'),
          }
        : await options.classifier.classify({ candidate, delivery });
      const record = feedbackRecord(candidate, delivery, classified);
      if (classified.kind === 'neutral' || classified.kind === 'ambiguous') {
        options.store.recordFeedback(record);
        return { status: classified.kind === 'ambiguous' ? 'ignored' : 'recorded', reason: classified.reason };
      }

      const matching = snapshot.revisions
        .filter((item) => item.fileKey === delivery.fileKey)
        .filter((item) => item.scope === classified.scope && item.scopeId === classified.scopeId)
        .filter((item) => item.status === 'trial' || item.status === 'confirmed')
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (!matching) {
        const hasPatch = Boolean(
          classified.patch.intent
          || classified.patch.tone
          || classified.patch.usage
          || classified.patch.aliases?.length
          || classified.patch.examples?.length
          || classified.patch.avoidRules?.length,
        );
        if (!hasPatch) {
          options.store.recordFeedback(record);
          return { status: 'recorded', reason: 'feedback_without_patch' };
        }
        const previousConfirmed = snapshot.revisions
          .filter((item) => item.fileKey === delivery.fileKey && item.status === 'confirmed')
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        const revision = newRevision({
          asset,
          decision: classified,
          baseHash: snapshot.baseHash,
          now: now(),
          randomId,
          previousConfirmedVersionId: previousConfirmed?.versionId,
          supportSessionId: delivery.sessionId,
        });
        options.store.saveRevision({ revision, expectedBaseHash: snapshot.baseHash, actor: 'feedback', feedback: record });
        return { status: 'revision_created', revisionId: revision.revisionId };
      }

      const next = applyStickerFeedback(matching, {
        evidenceHash: classified.evidenceHash,
        evidenceId: classified.evidenceId,
        sessionId: delivery.sessionId,
        kind: classified.kind,
        strength: classified.strength,
        confidence: classified.confidence,
        occurredAt: candidate.createdAt,
      }, { confirmationThreshold: options.confirmationThreshold });
      if (next === matching) {
        options.store.recordFeedback(record);
        return { status: 'recorded', reason: 'duplicate_or_neutral_feedback', revisionId: matching.revisionId };
      }
      const versioned = { ...next, versionId: randomId() };
      options.store.saveRevision({ revision: versioned, expectedBaseHash: snapshot.baseHash, actor: 'feedback', feedback: record });
      return {
        status: versioned.status === 'regressed' ? 'regressed' : 'revision_updated',
        revisionId: versioned.revisionId,
      };
    },
    async buildExpressionPromptSection(input) {
      return options.promptBuilder ? options.promptBuilder.build(input) : null;
    },
  };
}
