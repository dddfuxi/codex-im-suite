export type StickerStatusFilter = 'asset' | 'all' | 'enabled' | 'disabled' | 'archived' | 'failed' | 'history';

export type StickerLifecycleAction = 'archive' | 'restore' | 'delete';
export type StickerRevisionStatus = 'trial' | 'confirmed' | 'regressed' | 'rejected';
export type StickerSemanticScope = 'global' | 'chat' | 'user';
export type StickerRevisionAction = 'accept' | 'reject' | 'rollback';

export type StickerRevisionView = {
  status: StickerRevisionStatus;
  manualLocked: boolean;
};

export type StickerEvolutionRevision = {
  status: StickerRevisionStatus;
  scope: StickerSemanticScope;
};

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

export function getStickerRevisionActions(item: StickerRevisionView): StickerRevisionAction[] {
  if (item.manualLocked) return [];
  if (item.status === 'trial') return ['accept', 'reject'];
  if (item.status === 'confirmed') return ['rollback'];
  return [];
}

export function buildStickerEvolutionSummary<T extends StickerEvolutionRevision>(revisions: T[]): {
  counts: Record<StickerRevisionStatus, number>;
  byScope: Record<StickerSemanticScope, T[]>;
} {
  const counts: Record<StickerRevisionStatus, number> = { trial: 0, confirmed: 0, regressed: 0, rejected: 0 };
  const byScope: Record<StickerSemanticScope, T[]> = { global: [], chat: [], user: [] };
  for (const revision of revisions) {
    counts[revision.status] += 1;
    byScope[revision.scope].push(revision);
  }
  return { counts, byScope };
}
