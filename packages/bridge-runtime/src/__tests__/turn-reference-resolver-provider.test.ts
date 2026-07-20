import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/host';
import {
  createTurnEvidenceEnvelope,
  resolveTurnFocus,
} from 'claude-to-im/evidence';

describe('ProviderTurnReferenceResolverHost', () => {
  it('returns a strict JSON focus decision without tools or conversation history', async () => {
    const { ProviderTurnReferenceResolverHost } = await import('../main.js');
    let captured: StreamChatParams | undefined;
    const provider: LLMProvider = {
      streamChat: (params) => new ReadableStream<string>({
        start(controller) {
          captured = params;
          controller.enqueue(`data: ${JSON.stringify({
            type: 'text',
            data: JSON.stringify({
              focus: 'continuation',
              primaryEvidenceIds: ['message:likely'],
              supportingEvidenceIds: ['current-message'],
              confidence: 0.88,
              reason: '当前消息延续推测的上一项任务。',
            }),
          })}\n\n`);
          controller.close();
        },
      }),
    };
    const envelope = createTurnEvidenceEnvelope({
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_current',
      currentText: '继续处理',
      evidence: [{
        id: 'message:likely',
        kind: 'message',
        relation: 'likely_context',
        source: 'adapter_inference',
        confidence: 0.55,
        content: '处理上一项未完成任务',
      }],
    });
    const host = new ProviderTurnReferenceResolverHost(provider, 1000);

    const result = await host.resolveTurnFocus({
      sessionId: 'session-1',
      channelType: 'feishu',
      chatId: 'oc_group',
      currentText: '继续处理',
      envelope,
      deterministicDecision: resolveTurnFocus(envelope),
    });

    assert.equal(result.focus, 'continuation');
    assert.deepEqual(result.primaryEvidenceIds, ['message:likely']);
    assert.ok(captured);
    const capturedParams = captured as StreamChatParams;
    assert.equal(capturedParams.sessionId, 'session-1:turn-reference-resolver');
    assert.equal(capturedParams.forceFreshThread, true);
    assert.equal(capturedParams.interactionMode, 'classifier');
    assert.deepEqual(capturedParams.conversationHistory, []);
    assert.equal(capturedParams.workingDirectory, undefined);
    assert.equal(capturedParams.additionalDirectories, undefined);
    assert.equal(capturedParams.executionRequirement?.kind, 'none');
    assert.ok(capturedParams.responseSchema && typeof capturedParams.responseSchema === 'object');
    assert.match(capturedParams.systemPrompt || '', /strict JSON/i);
    assert.match(capturedParams.prompt, /message:likely/);
    assert.match(capturedParams.prompt, /不能执行工具/);
    assert.doesNotMatch(capturedParams.prompt, /请直接回复用户/);
  });

  it('aborts a resolver call that exceeds its dedicated deadline', async () => {
    const { ProviderTurnReferenceResolverHost } = await import('../main.js');
    const provider: LLMProvider = {
      streamChat: (params) => new ReadableStream<string>({
        start(controller) {
          params.abortController?.signal.addEventListener('abort', () => {
            controller.error(new Error('turn resolver aborted'));
          }, { once: true });
        },
      }),
    };
    const envelope = createTurnEvidenceEnvelope({
      channelType: 'discord',
      chatId: 'channel-1',
      messageId: 'message-1',
      currentText: '继续',
      evidence: [{
        id: 'message:likely',
        kind: 'message',
        relation: 'likely_context',
        source: 'adapter_inference',
        confidence: 0.5,
        content: '可能相关上文',
      }],
    });
    const host = new ProviderTurnReferenceResolverHost(provider, 25);

    await assert.rejects(host.resolveTurnFocus({
      sessionId: 'session-timeout',
      channelType: 'discord',
      chatId: 'channel-1',
      currentText: '继续',
      envelope,
      deterministicDecision: resolveTurnFocus(envelope),
    }), /aborted/i);
  });

  it('cancels the resolver reader when the parent bridge task is aborted', async () => {
    const { ProviderTurnReferenceResolverHost } = await import('../main.js');
    let cancelSeen = false;
    const provider: LLMProvider = {
      streamChat: (params) => new ReadableStream<string>({
        start(controller) {
          params.abortController?.signal.addEventListener('abort', () => {
            controller.error(new Error('resolver provider aborted'));
          }, { once: true });
        },
        cancel() {
          cancelSeen = true;
        },
      }),
    };
    const envelope = createTurnEvidenceEnvelope({
      channelType: 'feishu',
      chatId: 'oc_abort',
      messageId: 'om_abort',
      currentText: '继续',
      evidence: [{
        id: 'message:likely',
        kind: 'message',
        relation: 'likely_context',
        source: 'adapter_inference',
        confidence: 0.5,
        content: '可能相关上文',
      }],
    });
    const parentAbort = new AbortController();
    const host = new ProviderTurnReferenceResolverHost(provider, 200);
    const resolving = host.resolveTurnFocus({
      sessionId: 'session-parent-abort',
      channelType: 'feishu',
      chatId: 'oc_abort',
      currentText: '继续',
      envelope,
      deterministicDecision: resolveTurnFocus(envelope),
      abortSignal: parentAbort.signal,
    });

    parentAbort.abort();

    await assert.rejects(resolving, /aborted/i);
    assert.equal(cancelSeen, true);
  });

  it('bounds long supporting evidence before sending it to the parser agent', async () => {
    const { ProviderTurnReferenceResolverHost } = await import('../main.js');
    let capturedPrompt = '';
    const provider: LLMProvider = {
      streamChat: (params) => new ReadableStream<string>({
        start(controller) {
          capturedPrompt = params.prompt;
          controller.enqueue(`data: ${JSON.stringify({
            type: 'text',
            data: JSON.stringify({
              focus: 'current_request',
              primaryEvidenceIds: ['current-message'],
              supportingEvidenceIds: ['history:long'],
              confidence: 0.7,
              reason: '长历史只作辅助。',
            }),
          })}\n\n`);
          controller.close();
        },
      }),
    };
    const envelope = createTurnEvidenceEnvelope({
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_current',
      currentText: '处理一下',
      evidence: [{
        id: 'history:long',
        kind: 'history',
        relation: 'likely_context',
        source: 'adapter_inference',
        confidence: 0.5,
        content: '超长历史'.repeat(10_000),
      }],
    });
    const host = new ProviderTurnReferenceResolverHost(provider, 1000);

    await host.resolveTurnFocus({
      sessionId: 'session-long',
      channelType: 'feishu',
      chatId: 'oc_group',
      currentText: '处理一下',
      envelope,
      deterministicDecision: resolveTurnFocus(envelope),
    });

    assert.match(capturedPrompt, /history:long/);
    assert.ok(capturedPrompt.length < 12_000, `解析 Agent prompt 过长：${capturedPrompt.length}`);
  });
});
