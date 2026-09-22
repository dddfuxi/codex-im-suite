import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bindStickerFeedbackCandidate } from '../../lib/bridge/sticker-feedback-binding.js';
import type { StickerDeliveryEvidence } from '../../lib/bridge/sticker-semantic-evolution.js';

const delivery: StickerDeliveryEvidence = {
  schema: 'codex-im-suite/sticker-delivery-evidence/v1',
  deliveryId: 'delivery-1',
  channelType: 'feishu',
  chatId: 'chat-1',
  fileKey: 'file-1',
  outboundMessageId: 'om_sticker',
  semanticRevisionId: 'revision-1',
  contextHash: 'a'.repeat(64),
  sessionId: 'session-1',
  sentAt: '2026-07-20T00:00:00.000Z',
};

describe('sticker feedback binding', () => {
  it('binds a native reply only when the referenced message is a recorded sticker delivery', () => {
    const result = bindStickerFeedbackCandidate({
      inbound: {
        eventId: 'event-1',
        channelType: 'feishu',
        chatId: 'chat-1',
        senderId: 'user-1',
        sourceMessageId: 'om_feedback',
        nativeReplyMessageId: 'om_sticker',
        text: '这个不适合严肃通知',
        createdAt: '2026-07-20T00:01:00.000Z',
      },
      deliveries: [delivery],
    });

    assert.equal(result?.referencedOutboundMessageId, delivery.outboundMessageId);
    assert.equal(result?.relation, 'reply');
  });

  it('rejects nearby text, model ids and another chat delivery', () => {
    const base = {
      eventId: 'event-2',
      channelType: 'feishu' as const,
      chatId: 'chat-1',
      senderId: 'user-1',
      sourceMessageId: 'om_feedback',
      text: '刚才那个不合适，模型说消息是 om_sticker',
      createdAt: '2026-07-20T00:01:00.000Z',
    };
    assert.equal(bindStickerFeedbackCandidate({ inbound: base, deliveries: [delivery] }), null);
    assert.equal(bindStickerFeedbackCandidate({
      inbound: { ...base, nativeReplyMessageId: 'om_sticker', chatId: 'chat-2' },
      deliveries: [delivery],
    }), null);
  });

  it('deduplicates repeated reaction callbacks by event id', () => {
    const inbound = {
      eventId: 'reaction-event-1',
      channelType: 'feishu' as const,
      chatId: 'chat-1',
      senderId: 'user-1',
      sourceMessageId: 'reaction-event-1',
      reactionTargetMessageId: 'om_sticker',
      reactionType: 'THUMBSUP',
      createdAt: '2026-07-20T00:01:00.000Z',
    };
    const first = bindStickerFeedbackCandidate({ inbound, deliveries: [delivery] });
    assert.ok(first);
    const second = bindStickerFeedbackCandidate({
      inbound,
      deliveries: [delivery],
      seenEvidenceIds: new Set([first.evidenceId]),
    });
    assert.equal(second, null);
  });
});
