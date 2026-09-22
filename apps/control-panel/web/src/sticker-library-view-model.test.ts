import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildStickerEvolutionSummary,
  getStickerLifecycleActions,
  getStickerRevisionActions,
  matchesStickerStatusFilter,
} from './sticker-library-view-model.js';

describe('sticker library lifecycle view model', () => {
  it('shows one-click archive for active stickers', () => {
    assert.deepEqual(getStickerLifecycleActions({ archived: false }), ['archive']);
  });

  it('shows restore and permanent delete only after archiving', () => {
    assert.deepEqual(getStickerLifecycleActions({ archived: true }), ['restore', 'delete']);
  });

  it('keeps archived stickers out of the default asset filter', () => {
    const archived = {
      archived: true,
      disabled: false,
      isLibraryAsset: true,
      isHistoryOnly: false,
      hasMediaDownloadFailure: false,
      mediaDownloadFailedAt: '',
      mediaDownloadError: '',
    };

    assert.equal(matchesStickerStatusFilter(archived, 'asset'), false);
    assert.equal(matchesStickerStatusFilter(archived, 'archived'), true);
  });
});

describe('sticker semantic evolution view model', () => {
  it('groups revisions by lifecycle state and scope', () => {
    const summary = buildStickerEvolutionSummary([
      { status: 'trial', scope: 'chat' },
      { status: 'trial', scope: 'user' },
      { status: 'confirmed', scope: 'global' },
      { status: 'regressed', scope: 'chat' },
      { status: 'rejected', scope: 'global' },
    ]);
    assert.deepEqual(summary.counts, { trial: 2, confirmed: 1, regressed: 1, rejected: 1 });
    assert.equal(summary.byScope.chat.length, 2);
    assert.equal(summary.byScope.user.length, 1);
  });

  it('exposes only valid actions for each state', () => {
    assert.deepEqual(getStickerRevisionActions({ status: 'trial', manualLocked: false }), ['accept', 'reject']);
    assert.deepEqual(getStickerRevisionActions({ status: 'confirmed', manualLocked: false }), ['rollback']);
    assert.deepEqual(getStickerRevisionActions({ status: 'regressed', manualLocked: true }), []);
  });
});
