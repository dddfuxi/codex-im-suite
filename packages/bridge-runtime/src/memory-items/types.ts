export type VisibleMemoryScope = 'user' | 'group' | 'long_term';

export type MemoryItemStatus = 'confirmed' | 'candidate';

export type MemoryDocumentSourceKind = 'explicit' | 'candidate_observation' | 'migration';

export interface MemoryDocumentEntry {
  value: string;
  updatedAt: string;
  confidence: number;
  status: MemoryItemStatus;
  sourceKind: MemoryDocumentSourceKind;
  candidateFingerprint?: string;
  distinctSessionCount?: number;
  lastEvidenceAt?: string;
  sessionIds?: string[];
  sourceMessageHashes?: string[];
}

export interface MemoryEvidenceEntry {
  text?: string;
  textHash: string;
  createdAt: string;
  sessionId?: string;
}

export interface ManagedMemoryDocumentStateV2 {
  version: 2;
  confirmed: Record<string, MemoryDocumentEntry>;
  candidates: Record<string, MemoryDocumentEntry>;
  evidence: MemoryEvidenceEntry[];
  deletedCandidateFingerprints: Record<string, { deletedAt: string }>;
}

export interface ManagedMemoryDocumentMetadata {
  schema: 'codex-im-suite/memory/v3';
  scope: VisibleMemoryScope;
  channelType?: string;
  userId?: string;
  chatId?: string;
  displayName?: string;
  updatedAt: string;
}

export interface ManagedMemoryDocument {
  filePath: string;
  content: string;
  baseHash: string;
  metadata: ManagedMemoryDocumentMetadata;
  state: ManagedMemoryDocumentStateV2;
}

export type MemoryItemActor = 'control-panel' | 'migration';

export interface MemoryItemListRecord {
  itemId: string;
  key: string;
  entry: MemoryDocumentEntry;
  status: MemoryItemStatus;
  scope: VisibleMemoryScope;
  sourcePath: string;
  sourceRelativePath: string;
  sourceBaseHash: string;
}

export interface MemoryItemArchive {
  schema: 'codex-im-suite/memory-item-archive/v1';
  archiveId: string;
  itemId: string;
  previousStatus: MemoryItemStatus;
  scope: VisibleMemoryScope;
  sourceRelativePath: string;
  sourceBaseHash: string;
  key: string;
  entry: MemoryDocumentEntry;
  archivedAt: string;
  archivedBy: MemoryItemActor;
}
