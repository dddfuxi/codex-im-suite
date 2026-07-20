export type StickerSemanticScope =
  | { scope: 'global'; scopeId?: undefined }
  | { scope: 'chat'; scopeId: string }
  | { scope: 'user'; scopeId: string };

export type StickerRevisionStatus = 'trial' | 'confirmed' | 'regressed' | 'rejected';

export interface StickerDeliveryEvidence {
  schema: 'codex-im-suite/sticker-delivery-evidence/v1';
  deliveryId: string;
  channelType: 'feishu';
  chatId: string;
  targetUserId?: string;
  fileKey: string;
  outboundMessageId: string;
  semanticRevisionId: string;
  contextHash: string;
  sessionId: string;
  sentAt: string;
}

export interface StickerFeedbackCandidate {
  evidenceId: string;
  channelType: 'feishu';
  chatId: string;
  senderId: string;
  sourceMessageId: string;
  referencedOutboundMessageId: string;
  relation: 'reply' | 'reaction';
  text?: string;
  reactionType?: string;
  createdAt: string;
}

export interface StickerExpressionPromptRequest {
  channelType: string;
  chatId: string;
  userId?: string;
  maxChars: number;
}

export interface StickerSelectionRequest {
  channelType: 'feishu';
  chatId: string;
  userId?: string;
  fileKey: string;
  contextText: string;
}

export interface StickerSelectionAuthorization {
  fileKey: string;
  semanticRevisionId: string;
  contextHash: string;
}

export interface StickerFeedbackResult {
  status: 'ignored' | 'recorded' | 'revision_created' | 'revision_updated' | 'regressed';
  reason?: string;
  revisionId?: string;
}

export interface StickerExpressionPromptSection {
  id: 'expression.sticker-semantics';
  content: string;
  truncated: boolean;
}

/**
 * 统一收紧 scope 表达，避免调用方用空 chat/user 标识创建跨边界语义。
 */
export function normalizeStickerScope(input: { scope: 'global' | 'chat' | 'user'; scopeId?: string }): StickerSemanticScope {
  if (input.scope === 'global') return { scope: 'global' };
  const scopeId = input.scopeId?.trim();
  if (!scopeId) throw new Error('scope_id_required');
  return { scope: input.scope, scopeId };
}
