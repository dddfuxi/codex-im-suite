import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyAutomaticPatch,
  applyStickerFeedback,
  type VerifiedStickerFeedback,
} from '../sticker-semantics/revision-policy.js';
import type { StickerSemanticAsset, StickerSemanticRevisionV1 } from '../sticker-semantics/types.js';

function trial(): StickerSemanticRevisionV1 {
  return {
    schema: 'codex-im-suite/sticker-semantic-revision/v1',
    revisionId: 'revision-1',
    fileKey: 'file-1',
    scope: 'global',
    status: 'trial',
    versionId: 'version-1',
    previousConfirmedVersionId: 'version-0',
    baseHash: 'a'.repeat(64),
    patch: { usage: '用于轻松确认' },
    supportEvidenceHashes: [],
    contradictionEvidenceHashes: [],
    supportSessionIds: [],
    contradictionSessionIds: [],
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  };
}

function feedback(overrides: Partial<VerifiedStickerFeedback>): VerifiedStickerFeedback {
  return {
    evidenceHash: 'evidence-1',
    evidenceId: 'feedback-1',
    sessionId: 'session-1',
    kind: 'positive',
    strength: 'normal',
    confidence: 0.95,
    occurredAt: '2026-07-20T00:01:00.000Z',
    ...overrides,
  };
}

describe('sticker revision policy', () => {
  it('does not confirm from silence or a neutral turn', () => {
    const next = applyStickerFeedback(trial(), feedback({ kind: 'neutral' }));
    assert.equal(next.status, 'trial');
    assert.deepEqual(next.supportEvidenceHashes, []);
  });

  it('confirms only after support from independent sessions', () => {
    const support = [
      feedback({ evidenceHash: 'evidence-1', sessionId: 'session-1' }),
      feedback({ evidenceHash: 'evidence-2', evidenceId: 'feedback-2', sessionId: 'session-2' }),
      feedback({ evidenceHash: 'evidence-3', evidenceId: 'feedback-3', sessionId: 'session-3' }),
    ];
    const next = support.reduce((current, item) => applyStickerFeedback(current, item), trial());
    assert.equal(next.status, 'confirmed');

    const duplicateSession = applyStickerFeedback(
      applyStickerFeedback(trial(), support[0]),
      feedback({ evidenceHash: 'evidence-4', evidenceId: 'feedback-4', sessionId: 'session-1' }),
    );
    assert.equal(duplicateSession.supportSessionIds.length, 1);
  });

  it('regresses immediately on one strongly bound correction', () => {
    const current = { ...trial(), status: 'confirmed' as const };
    const next = applyStickerFeedback(current, feedback({
      kind: 'negative',
      strength: 'strong',
      evidenceHash: 'correction-1',
      sessionId: 'session-correction',
    }));
    assert.equal(next.status, 'regressed');
    assert.equal(next.restoredVersionId, 'version-0');
  });

  it('deduplicates evidence and never patches manual visual facts', () => {
    const once = applyStickerFeedback(trial(), feedback({}));
    const twice = applyStickerFeedback(once, feedback({}));
    assert.deepEqual(twice, once);

    const manualAsset: StickerSemanticAsset = {
      fileKey: 'file-1',
      aliases: [],
      archived: false,
      disabled: false,
      visual: { source: 'manual', description: '人工确认画面' },
    };
    assert.throws(() => applyAutomaticPatch(manualAsset, {
      visual: { description: '模型试图覆盖人工事实' },
    } as never), /manual_field_locked/u);
  });
});
