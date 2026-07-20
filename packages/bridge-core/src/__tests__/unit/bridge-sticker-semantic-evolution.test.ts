import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeStickerScope,
  type StickerDeliveryEvidence,
  type StickerFeedbackCandidate,
} from '../../lib/bridge/sticker-semantic-evolution.js';

describe('sticker semantic evolution protocol', () => {
  it('requires real outbound message id and file key for sticker delivery evidence', () => {
    const evidence: StickerDeliveryEvidence = {
      schema: 'codex-im-suite/sticker-delivery-evidence/v1',
      deliveryId: 'delivery-1',
      channelType: 'feishu',
      chatId: 'chat-1',
      fileKey: 'img_v2_key',
      outboundMessageId: 'om_1',
      semanticRevisionId: 'revision-1',
      contextHash: 'a'.repeat(64),
      sessionId: 'session-1',
      sentAt: '2026-07-20T00:00:00.000Z',
    };

    assert.equal(evidence.outboundMessageId, 'om_1');
    assert.equal(evidence.fileKey, 'img_v2_key');
  });

  it('normalizes scoped feedback without leaking another chat or user', () => {
    assert.deepEqual(normalizeStickerScope({ scope: 'chat', scopeId: ' chat-1 ' }), {
      scope: 'chat',
      scopeId: 'chat-1',
    });
    assert.deepEqual(normalizeStickerScope({ scope: 'global' }), { scope: 'global' });
    assert.throws(() => normalizeStickerScope({ scope: 'user' }), /scope_id_required/u);
  });

  it('feedback candidates reference one real delivery', () => {
    const candidate: StickerFeedbackCandidate = {
      evidenceId: 'feedback-1',
      channelType: 'feishu',
      chatId: 'chat-1',
      senderId: 'user-1',
      sourceMessageId: 'om_feedback',
      referencedOutboundMessageId: 'om_1',
      relation: 'reply',
      text: '这个不适合严肃通知',
      createdAt: '2026-07-20T00:01:00.000Z',
    };

    assert.equal(candidate.referencedOutboundMessageId, 'om_1');
  });
});
