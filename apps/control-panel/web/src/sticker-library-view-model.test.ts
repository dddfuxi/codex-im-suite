import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getStickerLifecycleActions,
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
