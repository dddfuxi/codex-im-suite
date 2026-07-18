import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { LLMProvider } from 'claude-to-im/src/lib/bridge/host.js';

describe('ProviderMemoryIntentHost', () => {
  it('treats project-scoped mapping records as durable memory candidates even without a remember verb', async () => {
    const { ProviderMemoryIntentHost } = await import('../main.js');
    let capturedPrompt = '';
    const provider: LLMProvider = {
      streamChat: (params) => new ReadableStream<string>({
        start(controller) {
          capturedPrompt = params.prompt;
          controller.enqueue(`data: ${JSON.stringify({
            type: 'text',
            data: JSON.stringify({
              action: 'write',
              scope: 'long_term',
              confidence: 0.93,
              candidates: [
                { key: 'HSScene', value: '医院内部场景', text: 'HSScene == 医院内部场景', confidence: 0.95 },
              ],
            }),
          })}\n\n`);
          controller.close();
        },
      }),
    };
    const host = new ProviderMemoryIntentHost(provider, 1000);

    const decision = await host.classifyMemoryWrite({
      sessionId: 'project-scoped-memory',
      channelType: 'feishu',
      chatId: 'oc_memory',
      text: '以下这些常用场景名称是STH项目的，也叫ST2H，H项目。等号前面是固定场景名称，后面是代称，这些场景只在H项目里生效，不在其他项目记录里：HSScene == 医院内部场景',
      recentMessages: [],
    });

    assert.match(capturedPrompt, /项目限定映射/);
    assert.match(capturedPrompt, /即使没有.*记住/);
    assert.equal(decision.action, 'write');
    assert.equal(decision.scope, 'long_term');
    assert.equal(decision.candidates?.[0]?.key, 'HSScene');
  });

  it('aborts a classifier that exceeds its dedicated deadline', async () => {
    const { ProviderMemoryIntentHost } = await import('../main.js');
    const provider: LLMProvider = {
      streamChat: (params) => new ReadableStream<string>({
        start(controller) {
          params.abortController?.signal.addEventListener('abort', () => {
            controller.error(new Error('classifier aborted'));
          }, { once: true });
        },
      }),
    };
    const host = new ProviderMemoryIntentHost(provider, 25);

    await assert.rejects(host.classifyMemoryWrite({
      sessionId: 'memory-timeout',
      channelType: 'feishu',
      chatId: 'oc_memory',
      text: '请记住，项目代号是夜航',
      recentMessages: [],
    }), /classifier aborted/);
  });

  it('uses a strict structured-output schema accepted by current Codex models', async () => {
    const { ProviderMemoryIntentHost } = await import('../main.js');
    let capturedSchema: Record<string, any> | undefined;
    const provider: LLMProvider = {
      streamChat: (params) => new ReadableStream<string>({
        start(controller) {
          capturedSchema = params.responseSchema as Record<string, any>;
          controller.enqueue(`data: ${JSON.stringify({
            type: 'text',
            data: JSON.stringify({
              action: 'clarify',
              scope: 'group',
              confidence: 0.9,
              reason: 'scope needs confirmation',
              candidates: [],
              clarification: '保存到当前群吗？',
            }),
          })}\n\n`);
          controller.close();
        },
      }),
    };
    const host = new ProviderMemoryIntentHost(provider, 1000);

    await host.classifyMemoryWrite({
      sessionId: 'strict-memory-schema',
      channelType: 'feishu',
      chatId: 'oc_memory',
      text: '记住这个命名规则',
      recentMessages: [],
    });

    const candidateSchema = capturedSchema?.properties?.candidates?.items;
    assert.equal(candidateSchema?.additionalProperties, false);
    assert.deepEqual(candidateSchema?.required, ['key', 'value', 'text', 'confidence']);
    assert.deepEqual(capturedSchema?.required, [
      'action',
      'scope',
      'confidence',
      'reason',
      'candidates',
      'clarification',
    ]);
  });
});
