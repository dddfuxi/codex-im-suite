import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type {
  StickerDeliveryEvidence,
  StickerFeedbackCandidate,
} from 'claude-to-im/policy';

import { createStickerSemanticEvolutionHost } from '../sticker-semantics/host.js';
import { createStickerSemanticStore } from '../sticker-semantics/store.js';
import type { StickerFeedbackClassifier } from '../sticker-semantics/feedback-classifier.js';

function makeRoot(archived = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-sticker-host-'));
  const stickerRoot = path.join(root, 'data', 'im', 'feishu', 'stickers');
  fs.mkdirSync(stickerRoot, { recursive: true });
  fs.writeFileSync(path.join(stickerRoot, 'stickers.json'), `${JSON.stringify({
    version: 1,
    stickers: [{
      fileKey: 'file-1',
      label: '庆祝猫',
      aliases: ['庆祝'],
      archived,
      disabled: false,
      annotationSource: 'vision',
      annotationConfidence: 0.96,
      description: '猫咪举杯庆祝',
    }],
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(root, '记忆总索引.md'), '# 记忆总索引\n', 'utf8');
  fs.writeFileSync(path.join(root, '记忆库说明.md'), '# 记忆库说明\n', 'utf8');
  return root;
}

const delivery: StickerDeliveryEvidence = {
  schema: 'codex-im-suite/sticker-delivery-evidence/v1',
  deliveryId: 'delivery-1',
  channelType: 'feishu',
  chatId: 'chat-1',
  fileKey: 'file-1',
  outboundMessageId: 'om-sticker-1',
  semanticRevisionId: 'baseline-revision',
  contextHash: 'a'.repeat(64),
  sessionId: 'session-delivery',
  sentAt: '2026-07-20T00:00:00.000Z',
};

const correction: StickerFeedbackCandidate = {
  evidenceId: 'feedback-1',
  channelType: 'feishu',
  chatId: 'chat-1',
  senderId: 'user-1',
  sourceMessageId: 'om-feedback-1',
  referencedOutboundMessageId: 'om-sticker-1',
  relation: 'reply',
  text: '这种正式通知不要发这个表情包',
  createdAt: '2026-07-20T00:01:00.000Z',
};

function correctionClassifier(calls: StickerFeedbackCandidate[]): StickerFeedbackClassifier {
  return {
    async classify(input) {
      calls.push(input.candidate);
      return {
        kind: 'negative',
        confidence: 0.97,
        scope: 'chat',
        scopeId: 'chat-1',
        deliveryId: 'delivery-1',
        evidenceId: 'feedback-1',
        evidenceHash: 'feedback-hash-1',
        strength: 'strong',
        reason: '正式通知不适合庆祝表情',
        patch: {
          avoidRules: [{ category: 'formal_notice', condition: '正式通知时避免' }],
        },
      };
    },
  };
}

describe('sticker semantic evolution host', () => {
  it('records delivery and creates a scoped avoid-rule trial from verified feedback', async () => {
    const root = makeRoot();
    const store = createStickerSemanticStore({ memoryRoot: root, now: () => '2026-07-20T00:01:00.000Z' });
    const calls: StickerFeedbackCandidate[] = [];
    const host = createStickerSemanticEvolutionHost({ store, classifier: correctionClassifier(calls) });

    await host.recordDelivery(delivery);
    const result = await host.processFeedback(correction);
    const snapshot = store.readSnapshot();

    assert.equal(result.status, 'revision_created');
    assert.equal(calls.length, 1);
    assert.equal(snapshot.revisions.length, 1);
    assert.equal(snapshot.revisions[0].scope, 'chat');
    assert.equal(snapshot.revisions[0].scopeId, 'chat-1');
    assert.equal(snapshot.revisions[0].status, 'trial');
    assert.equal(snapshot.revisions[0].patch.avoidRules?.[0]?.category, 'formal_notice');
    assert.equal(snapshot.revisions[0].patch.avoidRules?.[0]?.status, 'trial');
    assert.deepEqual(snapshot.revisions[0].supportSessionIds, ['session-delivery']);
    assert.match(fs.readFileSync(path.join(root, 'data', 'im', 'feishu', 'stickers', '表情包语义档案.md'), 'utf8'), /正式通知/u);
  });

  it('fails closed without learning when the sticker is archived', async () => {
    const root = makeRoot(true);
    const store = createStickerSemanticStore({ memoryRoot: root });
    const calls: StickerFeedbackCandidate[] = [];
    const host = createStickerSemanticEvolutionHost({ store, classifier: correctionClassifier(calls) });

    await host.recordDelivery(delivery);
    const result = await host.processFeedback(correction);

    assert.deepEqual(result, { status: 'ignored', reason: 'sticker_archived' });
    assert.equal(calls.length, 0);
    assert.equal(store.readSnapshot().revisions.length, 0);
  });

  it('authorizes only an active scoped revision and binds the context hash', async () => {
    const root = makeRoot();
    const store = createStickerSemanticStore({ memoryRoot: root, now: () => '2026-07-20T00:01:00.000Z' });
    const host = createStickerSemanticEvolutionHost({ store, classifier: correctionClassifier([]) });
    await host.recordDelivery(delivery);
    await host.processFeedback(correction);

    const authorization = await host.authorizeSelection({
      channelType: 'feishu',
      chatId: 'chat-1',
      userId: 'user-1',
      fileKey: 'file-1',
      contextText: '大家完成得很好，一起轻松庆祝',
    });
    const otherChat = await host.authorizeSelection({
      channelType: 'feishu',
      chatId: 'chat-other',
      userId: 'user-1',
      fileKey: 'file-1',
      contextText: '大家完成得很好，一起轻松庆祝',
    });

    assert.equal(authorization?.semanticRevisionId, store.readSnapshot().revisions[0].revisionId);
    assert.match(authorization?.contextHash || '', /^[a-f0-9]{64}$/u);
    assert.equal(otherChat, null);
  });
});
