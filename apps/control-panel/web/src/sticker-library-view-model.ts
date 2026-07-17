export type StickerStatusFilter = 'asset' | 'all' | 'enabled' | 'disabled' | 'archived' | 'failed' | 'history';

export type StickerLifecycleAction = 'archive' | 'restore' | 'delete';

type StickerLifecycleState = {
  archived: boolean;
};

type StickerFilterState = StickerLifecycleState & {
  disabled: boolean;
  isLibraryAsset: boolean;
  isHistoryOnly: boolean;
  hasMediaDownloadFailure: boolean;
  mediaDownloadFailedAt: string;
  mediaDownloadError: string;
};

export function getStickerLifecycleActions(item: StickerLifecycleState): StickerLifecycleAction[] {
  return item.archived ? ['restore', 'delete'] : ['archive'];
}

export function matchesStickerStatusFilter(item: StickerFilterState, filter: StickerStatusFilter): boolean {
  const hasMediaFailure = item.hasMediaDownloadFailure
    || Boolean(item.mediaDownloadFailedAt || item.mediaDownloadError);
  if (filter === 'asset') return item.isLibraryAsset && !item.archived;
  if (filter === 'enabled') return item.isLibraryAsset && !item.archived && !item.disabled;
  if (filter === 'disabled') return item.disabled && !item.archived;
  if (filter === 'archived') return item.archived;
  if (filter === 'failed') return hasMediaFailure;
  if (filter === 'history') return item.isHistoryOnly;
  return true;
}
