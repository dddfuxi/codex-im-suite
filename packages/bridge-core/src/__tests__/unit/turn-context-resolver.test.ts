import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createTurnEvidenceEnvelope,
  formatStructuredTurnContext,
  resolveTurnFocus,
  validateAgentTurnFocusDecision,
  type TurnEvidenceItem,
} from '../../lib/bridge/turn-context.js';
import { formatPriorityTurnContext } from '../../lib/bridge/host.js';
import { resolveStructuredTurnContext } from '../../lib/bridge/turn-context-broker.js';

function evidence(input: Partial<TurnEvidenceItem> & Pick<TurnEvidenceItem, 'id' | 'kind' | 'relation'>): TurnEvidenceItem {
  return {
    source: 'platform_event',
    confidence: 1,
    content: '',
    ...input,
  };
}

describe('turn context resolver', () => {
  it('counts normalized mentions and attachments as platform evidence', async () => {
    const resolved = await resolveStructuredTurnContext({
      sessionId: 'session-platform-evidence',
      channelType: 'feishu',
      chatId: 'oc_platform_evidence',
      messageId: 'om_current',
      currentText: '看一下',
      mentions: [{ name: '刘丹', openId: 'ou_liudan' }],
      attachments: [{
        id: 'image-1',
        name: '截图.png',
        type: 'image/png',
        size: 4,
        data: 'AAAA',
      }],
    });

    assert.equal(resolved.hasPlatformEvidence, true);
    assert.ok(resolved.envelope.evidence.some((item) => item.relation === 'native_mention'));
    assert.ok(resolved.envelope.evidence.some((item) => item.relation === 'current_attachment'));
  });

  it('uses the current message when no stronger reference exists', () => {
    const envelope = createTurnEvidenceEnvelope({
      channelType: 'telegram',
      chatId: 'chat-1',
      messageId: 'msg-current',
      currentText: '检查当前状态',
      evidence: [],
    });

    const decision = resolveTurnFocus(envelope);

    assert.equal(decision.mode, 'deterministic');
    assert.equal(decision.focus, 'current_request');
    assert.deepEqual(decision.primaryEvidenceIds, ['current-message']);
    assert.equal(decision.requiresAgentResolution, false);
  });

  it('selects one confirmed native reply over unrelated nearby and memory evidence', () => {
    const envelope = createTurnEvidenceEnvelope({
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_current',
      currentText: '你应该说什么',
      evidence: [
        evidence({
          id: 'reply-1',
          kind: 'message',
          relation: 'native_reply',
          source: 'platform_api',
          messageId: 'om_reply',
          actor: { displayName: '小明' },
          content: '我庆华哥已经忙得焦头烂额了',
        }),
        evidence({
          id: 'nearby-1',
          kind: 'message',
          relation: 'nearby',
          confidence: 0.8,
          content: '以后回答完问题要艾特对方',
        }),
        evidence({
          id: 'memory-1',
          kind: 'memory',
          relation: 'retrieved',
          source: 'memory_retrieval',
          confidence: 0.9,
          content: '回复可以卖萌',
        }),
      ],
    });

    const decision = resolveTurnFocus(envelope);

    assert.equal(decision.focus, 'reply_target');
    assert.deepEqual(decision.primaryEvidenceIds, ['reply-1']);
    assert.ok(decision.supportingEvidenceIds.includes('nearby-1'));
    assert.ok(decision.supportingEvidenceIds.includes('memory-1'));
    assert.equal(decision.requiresAgentResolution, false);
  });

  it('requests the parser agent when multiple confirmed reply targets compete', () => {
    const envelope = createTurnEvidenceEnvelope({
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_current',
      currentText: '处理一下',
      evidence: [
        evidence({ id: 'reply-1', kind: 'message', relation: 'native_reply', content: '任务一' }),
        evidence({ id: 'reply-2', kind: 'message', relation: 'native_reply', content: '任务二' }),
      ],
    });

    const decision = resolveTurnFocus(envelope);

    assert.equal(decision.focus, 'ambiguous');
    assert.equal(decision.requiresAgentResolution, true);
    assert.deepEqual(decision.conflictingEvidenceIds, ['reply-1', 'reply-2']);
  });

  it('requests the parser agent when the only reference is inferred rather than native', () => {
    const envelope = createTurnEvidenceEnvelope({
      channelType: 'discord',
      chatId: 'channel-1',
      messageId: 'msg-current',
      currentText: '继续',
      evidence: [
        evidence({
          id: 'likely-1',
          kind: 'message',
          relation: 'likely_context',
          source: 'adapter_inference',
          confidence: 0.55,
          content: '上一个可能相关的任务',
        }),
      ],
    });

    const decision = resolveTurnFocus(envelope);

    assert.equal(decision.focus, 'ambiguous');
    assert.equal(decision.requiresAgentResolution, true);
    assert.deepEqual(decision.conflictingEvidenceIds, ['likely-1']);
  });

  it('treats a low-information reply shell as unresolved until reply media is available', () => {
    const unresolvedEnvelope = createTurnEvidenceEnvelope({
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_current',
      currentText: '看这个',
      evidence: [
        evidence({
          id: 'reply-image',
          kind: 'message',
          relation: 'native_reply',
          source: 'platform_api',
          confidence: 0.45,
          content: '[图片]',
          messageId: 'om_reply_image',
          metadata: { contentRecovered: false },
        }),
      ],
    });

    assert.equal(resolveTurnFocus(unresolvedEnvelope).requiresAgentResolution, true);

    const recoveredEnvelope = createTurnEvidenceEnvelope({
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_current',
      currentText: '看这个',
      evidence: [
        ...unresolvedEnvelope.evidence.filter((item) => item.id !== 'current-message'),
        evidence({
          id: 'attachment:reply-image',
          kind: 'attachment',
          relation: 'reply_attachment',
          source: 'platform_api',
          confidence: 1,
          content: 'reply.png',
          metadata: { replyMessageId: 'om_reply_image' },
        }),
      ],
    });

    const recoveredDecision = resolveTurnFocus(recoveredEnvelope);
    assert.equal(recoveredDecision.focus, 'reply_target');
    assert.equal(recoveredDecision.requiresAgentResolution, false);
    assert.equal(recoveredDecision.confidence, 1);
    assert.match(recoveredDecision.reason, /正文或附件/);
  });

  it('falls back to one reliable nearby message when an unrecovered native reply cannot be resolved', async () => {
    const resolved = await resolveStructuredTurnContext({
      sessionId: 'session-unrecovered-reply-fallback',
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_current',
      currentText: '你猜',
      platformEvidence: [
        evidence({
          id: 'reply-shell',
          kind: 'message',
          relation: 'native_reply',
          source: 'platform_api',
          confidence: 0.45,
          content: '[卡片消息：正文未随事件返回]',
          messageId: 'om_reply_card',
          timestamp: 200,
          metadata: { contentRecovered: false, messageType: 'interactive' },
        }),
        evidence({
          id: 'nearby-human-message',
          kind: 'message',
          relation: 'nearby',
          source: 'platform_api',
          confidence: 0.7,
          content: '酒吧只能点酒，她要水，酒保拿枪驱离，她说谢谢后跑了。',
          messageId: 'om_nearby',
          timestamp: 100,
          metadata: { contentRecovered: true, messageType: 'text' },
        }),
      ],
      resolver: {
        resolveTurnFocus: async () => {
          throw new Error('classifier aborted');
        },
      },
    });

    assert.equal(resolved.decision.focus, 'continuation');
    assert.deepEqual(resolved.decision.primaryEvidenceIds, ['nearby-human-message']);
    assert.deepEqual(resolved.decision.conflictingEvidenceIds, ['reply-shell']);
    assert.equal(resolved.decision.requiresAgentResolution, false);
    assert.match(resolved.decision.reason, /近邻.*不是.*引用正文/);
    assert.match(resolved.prompt, /不代表原生引用正文已恢复/);
  });

  it('keeps the turn ambiguous when multiple reliable nearby messages compete', async () => {
    const resolved = await resolveStructuredTurnContext({
      sessionId: 'session-multiple-nearby-fallback',
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_current',
      currentText: '你猜',
      platformEvidence: [
        evidence({
          id: 'reply-shell',
          kind: 'message',
          relation: 'native_reply',
          source: 'platform_api',
          confidence: 0.45,
          content: '[卡片消息：正文未随事件返回]',
          messageId: 'om_reply_card',
          metadata: { contentRecovered: false },
        }),
        evidence({
          id: 'nearby-1',
          kind: 'message',
          relation: 'nearby',
          source: 'platform_api',
          confidence: 0.7,
          content: '第一条可能相关的真实消息',
          metadata: { contentRecovered: true },
        }),
        evidence({
          id: 'nearby-2',
          kind: 'message',
          relation: 'nearby',
          source: 'platform_api',
          confidence: 0.7,
          content: '第二条也可能相关的真实消息',
          metadata: { contentRecovered: true },
        }),
      ],
    });

    assert.equal(resolved.decision.focus, 'ambiguous');
    assert.equal(resolved.decision.requiresAgentResolution, true);
  });

  it('does not use nearby fallback for a side-effecting request', async () => {
    const resolved = await resolveStructuredTurnContext({
      sessionId: 'session-side-effecting-reply-fallback',
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_current',
      currentText: '你猜，顺便把文件删了',
      platformEvidence: [
        evidence({
          id: 'reply-shell',
          kind: 'message',
          relation: 'native_reply',
          source: 'platform_api',
          confidence: 0.45,
          content: '[卡片消息：正文未随事件返回]',
          messageId: 'om_reply_card',
          metadata: { contentRecovered: false },
        }),
        evidence({
          id: 'nearby-1',
          kind: 'message',
          relation: 'nearby',
          source: 'platform_api',
          confidence: 0.7,
          content: '这是一条普通的群聊消息',
          metadata: { contentRecovered: true },
        }),
      ],
    });

    assert.equal(resolved.decision.focus, 'ambiguous');
    assert.equal(resolved.decision.requiresAgentResolution, true);
  });

  it('does not use a nearby resource shell as fallback evidence', async () => {
    const resolved = await resolveStructuredTurnContext({
      sessionId: 'session-nearby-shell-fallback',
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_current',
      currentText: '什么意思',
      platformEvidence: [
        evidence({
          id: 'reply-shell',
          kind: 'message',
          relation: 'native_reply',
          source: 'platform_api',
          confidence: 0.45,
          content: '[卡片消息：正文未随事件返回]',
          messageId: 'om_reply_card',
          metadata: { contentRecovered: false },
        }),
        evidence({
          id: 'nearby-shell',
          kind: 'message',
          relation: 'nearby',
          source: 'platform_api',
          confidence: 0.7,
          content: '[图片]',
          messageId: 'om_nearby_image',
          metadata: { contentRecovered: false, messageType: 'image' },
        }),
      ],
    });

    assert.equal(resolved.decision.focus, 'ambiguous');
    assert.equal(resolved.decision.requiresAgentResolution, true);
  });

  it('uses the last readable message before card shells and excludes future nearby evidence', async () => {
    const resolved = await resolveStructuredTurnContext({
      sessionId: 'session-card-adjacent-fallback',
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_current',
      currentText: '你猜',
      currentTimestamp: 250,
      platformEvidence: [
        evidence({
          id: 'reply-shell',
          kind: 'message',
          relation: 'native_reply',
          source: 'platform_api',
          confidence: 0.45,
          content: '[卡片消息：正文未随事件返回]',
          messageId: 'om_reply_card',
          timestamp: 50,
          metadata: { contentRecovered: false, messageType: 'interactive' },
        }),
        evidence({
          id: 'older-nearby',
          kind: 'message',
          relation: 'nearby',
          source: 'platform_api',
          confidence: 0.7,
          content: '较早的闲聊',
          timestamp: 100,
          metadata: { contentRecovered: true, messageType: 'text' },
        }),
        evidence({
          id: 'card-prompt',
          kind: 'message',
          relation: 'nearby',
          source: 'platform_api',
          confidence: 0.7,
          content: '酒吧只能点酒，她要水，酒保拿枪驱离，她说谢谢后跑了。',
          timestamp: 200,
          metadata: { contentRecovered: true, messageType: 'text' },
        }),
        evidence({
          id: 'nearby-card-shell',
          kind: 'message',
          relation: 'nearby',
          source: 'platform_api',
          confidence: 0.7,
          content: '[卡片消息：正文未随事件返回]',
          timestamp: 220,
          metadata: { contentRecovered: false, messageType: 'interactive' },
        }),
        evidence({
          id: 'future-distractor',
          kind: 'message',
          relation: 'nearby',
          source: 'platform_api',
          confidence: 0.7,
          content: '这是当前消息之后才发出的内容',
          timestamp: 300,
          metadata: { contentRecovered: true, messageType: 'text' },
        }),
      ],
    });

    assert.equal(resolved.decision.focus, 'continuation');
    assert.deepEqual(resolved.decision.primaryEvidenceIds, ['card-prompt']);
    assert.equal(resolved.envelope.evidence.some((item) => item.id === 'future-distractor'), false);
  });

  it('renders the selected focus separately from supporting evidence', () => {
    const envelope = createTurnEvidenceEnvelope({
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_current',
      currentText: '你应该说什么',
      evidence: [
        evidence({
          id: 'reply-1',
          kind: 'message',
          relation: 'native_reply',
          content: '我庆华哥已经忙得焦头烂额了',
        }),
        evidence({
          id: 'nearby-1',
          kind: 'message',
          relation: 'nearby',
          confidence: 0.8,
          content: '以后回答完问题要艾特对方',
        }),
      ],
    });
    const decision = resolveTurnFocus(envelope);

    const prompt = formatStructuredTurnContext(envelope, decision);

    assert.match(prompt, /cti-turn-context\/v1/);
    assert.match(prompt, /cti-turn-focus\/v1/);
    assert.match(prompt, /"primaryEvidenceIds":\s*\[\s*"reply-1"/);
    assert.match(prompt, /我庆华哥已经忙得焦头烂额了/);
    assert.match(prompt, /supportingEvidence/);
    assert.match(prompt, /当前正文若明确改变任务，可以覆盖引用焦点/);
  });

  it('keeps generic continuation and media-metadata guardrails in structured context', () => {
    const envelope = createTurnEvidenceEnvelope({
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_current',
      currentText: '继续按刚才那样处理这张图',
      evidence: [
        evidence({
          id: 'likely-1',
          kind: 'message',
          relation: 'likely_context',
          source: 'adapter_inference',
          confidence: 0.55,
          content: '上一项图片处理任务',
        }),
      ],
    });
    const decision = validateAgentTurnFocusDecision(envelope, {
      focus: 'continuation',
      primaryEvidenceIds: ['likely-1'],
      supportingEvidenceIds: ['current-message'],
      confidence: 0.8,
    });
    assert.ok(decision);

    const prompt = formatStructuredTurnContext(envelope, decision);

    assert.match(prompt, /先恢复被继承的任务目标/);
    assert.match(prompt, /附件或资源元数据/);
    assert.match(prompt, /不要直接当作要写到图片上的文字/);
  });

  it('rejects parser-agent decisions that invent evidence ids', () => {
    const envelope = createTurnEvidenceEnvelope({
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_current',
      currentText: '处理一下',
      evidence: [
        evidence({ id: 'reply-1', kind: 'message', relation: 'native_reply', content: '真实任务' }),
      ],
    });

    const decision = validateAgentTurnFocusDecision(envelope, {
      focus: 'reply_target',
      primaryEvidenceIds: ['invented-id'],
      supportingEvidenceIds: [],
      confidence: 0.99,
      reason: '模型编造了不存在的证据',
    });

    assert.equal(decision, null);
  });

  it('rejects parser-agent decisions whose focus contradicts primary evidence relations', () => {
    const envelope = createTurnEvidenceEnvelope({
      channelType: 'feishu',
      chatId: 'oc_relation_guard',
      messageId: 'om_current',
      currentText: '继续',
      evidence: [
        evidence({ id: 'reply-1', kind: 'message', relation: 'native_reply', content: '被回复正文' }),
      ],
    });

    assert.equal(validateAgentTurnFocusDecision(envelope, {
      focus: 'reply_target',
      primaryEvidenceIds: ['current-message'],
      supportingEvidenceIds: ['reply-1'],
      confidence: 0.9,
    }), null);
    assert.equal(validateAgentTurnFocusDecision(envelope, {
      focus: 'current_request',
      primaryEvidenceIds: ['reply-1'],
      supportingEvidenceIds: ['current-message'],
      confidence: 0.9,
    }), null);
  });

  it('rejects parser-agent reply focus when the native reply content was not recovered', () => {
    const envelope = createTurnEvidenceEnvelope({
      channelType: 'feishu',
      chatId: 'oc_unrecovered_reply',
      messageId: 'om_current',
      currentText: '这是什么情况',
      evidence: [
        evidence({
          id: 'reply-shell',
          kind: 'message',
          relation: 'native_reply',
          source: 'platform_api',
          confidence: 0.45,
          content: '[图片]',
          messageId: 'om_reply_image',
          metadata: { contentRecovered: false },
        }),
      ],
    });

    assert.equal(validateAgentTurnFocusDecision(envelope, {
      focus: 'reply_target',
      primaryEvidenceIds: ['reply-shell'],
      supportingEvidenceIds: ['current-message'],
      confidence: 0.9,
      reason: '错误地选择了不可读资源壳。',
    }), null);
  });

  it('keeps focus and primary evidence intact when supporting evidence exceeds the provider budget', () => {
    const envelope = createTurnEvidenceEnvelope({
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_current',
      currentText: '继续处理',
      evidence: [
        evidence({
          id: 'reply-1',
          kind: 'message',
          relation: 'native_reply',
          content: '这是必须保留的主焦点正文',
        }),
        evidence({
          id: 'history-1',
          kind: 'history',
          relation: 'retrieved',
          source: 'local_history',
          confidence: 0.9,
          content: '很长的辅助历史'.repeat(3_000),
        }),
      ],
    });
    const decision = resolveTurnFocus(envelope);

    const bounded = formatPriorityTurnContext(formatStructuredTurnContext(envelope, decision));

    assert.match(bounded, /cti-turn-focus\/v1/);
    assert.match(bounded, /"primaryEvidenceIds":\s*\[\s*"reply-1"/);
    assert.match(bounded, /这是必须保留的主焦点正文/);
    assert.ok(bounded.length <= 8_200);
  });
});
