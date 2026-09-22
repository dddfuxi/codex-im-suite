import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JevDecisionProvider } from '../jev-decision-provider.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('JevDecisionProvider', () => {
  it('short-circuits when the provider has no API key', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch;
    const result = await new JevDecisionProvider().evaluate({
      state: '是否需要执行？',
      questions: [{ id: 'is_task', type: 'noul', instructions: '判断是否为任务', criteria: { true: '是', false: '否' } }],
    });
    assert.equal(result, null);
    assert.equal(called, false);
  });

  it('uses the Decisions endpoint and preserves noul/choice/score distributions', async () => {
    let request: { url: string; body: Record<string, unknown>; headers: Headers } | undefined;
    globalThis.fetch = (async (input, init) => {
      request = {
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: new Headers(init?.headers),
      };
      return new Response(JSON.stringify({
        id: 'gen-dec-test',
        model: 'typesafe/jev-1.13',
        answers: {
          is_task: { type: 'noul', noul: 0.9 },
          category: { type: 'choice', choice: 'task', confidence: 0.8, probabilities: { chat: 0.1, task: 0.8, clarify: 0.1 } },
          risk: { type: 'score', score: 1.2, probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 }, legend: { '0': '低', '1': '中', '2': '高' } },
        },
        usage: { input_tokens: 12, output_tokens: 8, cost: 0.0001 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const result = await new JevDecisionProvider({ apiKey: 'test-key' }).evaluate({
      state: '用户要求选择一个方案',
      questions: [
        { id: 'is_task', type: 'noul', instructions: '判断是否为任务', criteria: { true: '是', false: '否' } },
        { id: 'category', type: 'choice', instructions: '选择类别', criteria: { chat: '闲聊', task: '任务', clarify: '澄清' } },
        { id: 'risk', type: 'score', instructions: '评分', criteria: ['低', '中', '高'] },
      ],
    });

    assert.ok(request);
    assert.equal(request.url, 'https://openrouter.ai/api/alpha/decisions');
    assert.equal(request.headers.get('authorization'), 'Bearer test-key');
    assert.equal(request.body.model, 'typesafe/jev-1.13');
    assert.deepEqual(Object.keys(request.body.questions as object), ['is_task', 'category', 'risk']);
    assert.deepEqual((request.body.questions as Record<string, { criteria?: unknown }>).is_task?.criteria, { true: '是', false: '否' });
    assert.ok(result);
    assert.equal(result.answers[0]?.noul, 0.9);
    assert.deepEqual(result.answers[1]?.probabilities, { chat: 0.1, task: 0.8, clarify: 0.1 });
    assert.equal(result.answers[2]?.legend?.['2'], '高');
    assert.equal(result.usage?.inputTokens, 12);
  });

  it('fails closed for non-success responses', async () => {
    globalThis.fetch = (async () => new Response('no', { status: 503 })) as typeof fetch;
    const result = await new JevDecisionProvider({ apiKey: 'test-key' }).evaluate({
      state: 'state',
      questions: [{ id: 'q', type: 'noul', instructions: 'q', criteria: { true: 'yes', false: 'no' } }],
    });
    assert.equal(result, null);
  });

  it('fails closed for malformed answers instead of inventing a result', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ answers: { q: { type: 'unknown', value: true } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const result = await new JevDecisionProvider({ apiKey: 'test-key' }).evaluate({
      state: 'state',
      questions: [{ id: 'q', type: 'choice', instructions: 'q', criteria: { a: 'A', b: 'B' } }],
    });
    assert.equal(result, null);
  });
});
