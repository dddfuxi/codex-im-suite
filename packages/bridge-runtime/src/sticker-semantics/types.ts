import type {
  StickerDeliveryEvidence,
  StickerRevisionStatus,
} from 'claude-to-im/policy';

export type StickerSemanticActor = 'control-panel' | 'feedback' | 'manual' | 'migration';
export type StickerSemanticScopeName = 'global' | 'chat' | 'user';

export interface StickerAvoidRuleV1 {
  id: string;
  condition: string;
  category: 'formal_notice' | 'serious_incident' | 'user_distress' | 'complaint' | 'recent_repeat' | 'scope_preference';
  scope: StickerSemanticScopeName;
  scopeId?: string;
  status: Exclude<StickerRevisionStatus, 'rejected'>;
  confidence: number;
  supportCount: number;
  contradictionCount: number;
  evidenceHashes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StickerSemanticPatch {
  intent?: string;
  tone?: string;
  usage?: string;
  aliases?: string[];
  examples?: string[];
  avoidRules?: StickerAvoidRuleV1[];
}

export interface StickerSemanticRevisionV1 {
  schema: 'codex-im-suite/sticker-semantic-revision/v1';
  revisionId: string;
  fileKey: string;
  scope: StickerSemanticScopeName;
  scopeId?: string;
  status: StickerRevisionStatus;
  versionId: string;
  previousConfirmedVersionId?: string;
  restoredVersionId?: string;
  baseHash: string;
  patch: StickerSemanticPatch;
  supportEvidenceHashes: string[];
  contradictionEvidenceHashes: string[];
  supportSessionIds: string[];
  contradictionSessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StickerSemanticAsset {
  fileKey: string;
  label?: string;
  aliases: string[];
  archived: boolean;
  disabled: boolean;
  visual: {
    source: 'vision' | 'manual' | 'unverified';
    description?: string;
    confidence?: number;
  };
}

export interface StickerSemanticSnapshot {
  schema: 'codex-im-suite/sticker-semantic-snapshot/v1';
  generatedAt: string;
  baseHash: string;
  assets: StickerSemanticAsset[];
  revisions: StickerSemanticRevisionV1[];
  deliveries: StickerDeliveryEvidence[];
}

export interface StickerSemanticRevisionFileV1 {
  schema: 'codex-im-suite/sticker-semantic-revisions/v1';
  updatedAt: string;
  revisions: StickerSemanticRevisionV1[];
}

export interface StickerSemanticDeliveryFileV1 {
  schema: 'codex-im-suite/sticker-semantic-deliveries/v1';
  updatedAt: string;
  deliveries: StickerDeliveryEvidence[];
}

export interface StickerSemanticFeedbackRecordV1 {
  schema: 'codex-im-suite/sticker-semantic-feedback/v1';
  feedbackId: string;
  deliveryId: string;
  evidenceId: string;
  evidenceHash: string;
  fileKey: string;
  sessionId: string;
  kind: 'positive' | 'negative' | 'neutral' | 'ambiguous';
  scope: StickerSemanticScopeName;
  scopeId?: string;
  confidence: number;
  strength: 'normal' | 'strong';
  reason: string;
  createdAt: string;
}
