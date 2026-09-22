import crypto from 'node:crypto';

import type {
  StickerDeliveryEvidence,
  StickerFeedbackCandidate,
} from './sticker-semantic-evolution.js';

export interface StickerFeedbackInbound {
  eventId: string;
  channelType: 'feishu';
  chatId: string;
  senderId: string;
  sourceMessageId: string;
  nativeReplyMessageId?: string;
  reactionTargetMessageId?: string;
  text?: string;
  reactionType?: string;
  createdAt: string;
}

export interface StickerFeedbackBindingInput {
  inbound: StickerFeedbackInbound;
  deliveries: StickerDeliveryEvidence[];
  seenEvidenceIds?: ReadonlySet<string>;
}

function feedbackEvidenceId(inbound: StickerFeedbackInbound, referencedId: string, relation: 'reply' | 'reaction'): string {
  return crypto.createHash('sha256')
    .update(`${inbound.eventId.trim()}\n${referencedId}\n${inbound.senderId.trim()}\n${relation}`, 'utf8')
    .digest('hex');
}

/** 只把原生 reply/reaction 绑定到同 chat 的真实出站表情包 delivery。 */
export function bindStickerFeedbackCandidate(input: StickerFeedbackBindingInput): StickerFeedbackCandidate | null {
  const inbound = input.inbound;
  const nativeReplyMessageId = inbound.nativeReplyMessageId?.trim();
  const reactionTargetMessageId = inbound.reactionTargetMessageId?.trim();
  const relation = nativeReplyMessageId ? 'reply' : reactionTargetMessageId ? 'reaction' : null;
  const referencedId = nativeReplyMessageId || reactionTargetMessageId;
  if (!relation || !referencedId || !inbound.eventId.trim() || !inbound.senderId.trim()) return null;
  const delivery = input.deliveries.find((item) =>
    item.channelType === 'feishu'
    && item.chatId === inbound.chatId
    && item.outboundMessageId === referencedId);
  if (!delivery) return null;
  const evidenceId = feedbackEvidenceId(inbound, referencedId, relation);
  if (input.seenEvidenceIds?.has(evidenceId)) return null;
  return {
    evidenceId,
    channelType: 'feishu',
    chatId: inbound.chatId,
    senderId: inbound.senderId.trim(),
    sourceMessageId: inbound.sourceMessageId.trim(),
    referencedOutboundMessageId: delivery.outboundMessageId,
    relation,
    text: inbound.text?.trim() || undefined,
    reactionType: inbound.reactionType?.trim() || undefined,
    createdAt: inbound.createdAt,
  };
}
