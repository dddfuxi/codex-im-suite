import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/host';
import type {
  StickerDeliveryEvidence,
  StickerFeedbackCandidate,
} from 'claude-to-im/policy';

import { createStickerFeedbackClassifier } from '../sticker-semantics/feedback-classifier.js';

const delivery: StickerDeliveryEvidence = {
  schema: 'codex-im-suite/sticker-delivery-evidence/v1',
  deliveryId: 'delivery-1',
  channelType: 'feishu',
  chatId: 'chat-1',
  targetUserId: 'user-1',
  fileKey: 'file-1',
  outboundMessageId: 'om-1',
  semanticRevisionId: 'revision-1',
  contextHash: 'a'.repeat(64),
  sessionId: 'session-delivery',
  sentAt: '2026-07-20T00:00:00.000Z',
};

const candidate: StickerFeedbackCandidate = {
  evidenceId: 'feedback-1',
  channelType: 'feishu',
  chatId: 'chat-1',
  senderId: 'user-1',
  sourceMessageId: 'om-feedback',
  referencedOutboundMessageId: 'om-1',
  relation: 'reply',
  text: '这种正式通知不要发这个表情包',
  createdAt: '2026-07-20T00:01:00.000Z',
};

function providerReturning(payload: string, captured: StreamChatParams[]): LLMProvider {
  return {
    streamChat(params) {
      captured.push(params);
      return new ReadableStream<string>({
        start(controller) {
          controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: payload })}\n\n`);
          controller.close();
        },
      });
    },
  };
}

describe('sticker feedback classifier', () => {
  it('accepts one bounded JSON object in an isolated classifier turn', async () => {
    const calls: StreamChatParams[] = [];
    const classifier = createStickerFeedbackClassifier({
      provider: providerReturning(JSON.stringify({
        kind: 'negative',
        confidence: 0.96,
        scope: 'chat',
        scopeId: 'chat-1',
        deliveryId: 'delivery-1',
        evidenceId: 'feedback-1',
        reason: '正式通知语境不适合',
        patch: {
          intent: null,
          tone: null,
          usage: null,
          aliases: [],
          examples: [],
          avoidRules: [{ category: 'formal_notice', condition: '正式通知时避免' }],
        },
      }), calls),
      timeoutMs: 1000,
    });

    const result = await classifier.classify({ candidate, delivery });

    assert.equal(result.kind, 'negative');
    assert.equal(result.scope, 'chat');
    assert.equal(result.scopeId, 'chat-1');
    assert.equal(result.patch.avoidRules?.[0]?.category, 'formal_notice');
    assert.equal(calls[0].interactionMode, 'classifier');
    assert.equal(calls[0].workingDirectory, undefined);
    assert.equal(calls[0].workspacePlan, undefined);
    assert.deepEqual(calls[0].conversationHistory, []);
    assert.deepEqual(calls[0].executionRequirement?.requiredToolFamilies, []);
  });

  it('fails closed on prose and unknown evidence or scope ids', async () => {
    const prose = createStickerFeedbackClassifier({
      provider: providerReturning('我认为这是负反馈', []),
      timeoutMs: 1000,
    });
    await assert.rejects(prose.classify({ candidate, delivery }), /invalid_json/u);

    const unknown = createStickerFeedbackClassifier({
      provider: providerReturning(JSON.stringify({
        kind: 'negative', confidence: 0.99, scope: 'chat', scopeId: 'chat-other',
        deliveryId: 'delivery-other', evidenceId: 'feedback-other', reason: 'wrong ids',
        patch: { intent: null, tone: null, usage: null, aliases: [], examples: [], avoidRules: [] },
      }), []),
      timeoutMs: 1000,
    });
    await assert.rejects(unknown.classify({ candidate, delivery }), /classifier_evidence_mismatch/u);
  });

  it('aborts a classifier that exceeds its dedicated timeout', async () => {
    const provider: LLMProvider = {
      streamChat: (params) => new ReadableStream<string>({
        start(controller) {
          params.abortController?.signal.addEventListener('abort', () => {
            controller.error(new Error('classifier aborted'));
          }, { once: true });
        },
      }),
    };
    const classifier = createStickerFeedbackClassifier({ provider, timeoutMs: 20 });
    await assert.rejects(classifier.classify({ candidate, delivery }), /classifier aborted/u);
  });
});
