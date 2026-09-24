import assert from 'node:assert/strict';
import test from 'node:test';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/host';
import { ProviderDecisionQuestionPlannerHost } from '../main.js';

function providerReturning(payload: unknown): LLMProvider {
  return {
    streamChat: () => new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: JSON.stringify(payload) })}\n\n`);
        controller.close();
      },
    }),
  };
}

test('dynamic Jev planner returns a bounded question from strict JSON', async () => {
  const planner = new ProviderDecisionQuestionPlannerHost(providerReturning({
    type: 'choice',
    instructions: '判断这条短消息最可能代表的含义。',
    options: [
      { key: 'abbreviation', label: '缩写或代号' },
      { key: 'typo', label: '输入错误或未完成' },
      { key: 'unknown', label: '当前上下文不足' },
    ],
  }));
  const result = await planner.plan({ state: 'smk' });
  assert.deepEqual(result, {
    id: 'jev_dynamic',
    type: 'choice',
    instructions: '判断这条短消息最可能代表的含义。',
    criteria: {
      abbreviation: '缩写或代号',
      typo: '输入错误或未完成',
      unknown: '当前上下文不足',
    },
  });
});

test('pure-mode planner asks for 3 to 5 answer or solution candidates', async () => {
  let captured: StreamChatParams | undefined;
  const planner = new ProviderDecisionQuestionPlannerHost({ streamChat(params) {
    captured = params;
    return providerReturning({
      type: 'choice',
      instructions: '针对当前问题比较可行的处理方案。',
      options: [
        { key: 'direct', label: '直接按现有方案推进' },
        { key: 'clarify', label: '先补充关键信息再决定' },
        { key: 'alternative', label: '改用另一种实现路径' },
        { key: 'defer', label: '暂缓处理并观察后续变化' },
      ],
    }).streamChat(params);
  } });

  const result = await planner.plan({ state: '这个方案应该怎么落地？', purpose: 'answer_options' });
  assert.deepEqual(result, {
    id: 'jev_dynamic',
    type: 'choice',
    instructions: '针对当前问题比较可行的处理方案。',
    criteria: {
      direct: '直接按现有方案推进',
      clarify: '先补充关键信息再决定',
      alternative: '改用另一种实现路径',
      defer: '暂缓处理并观察后续变化',
    },
  });
  assert.match(captured?.prompt || '', /生成 3 到 5 个可能的答案或解决方案候选/u);
  assert.match(captured?.prompt || '', /不要输出意图分类/u);
});

test('pure-mode planner fails closed when answer candidate count is outside 3 to 5', async () => {
  for (const count of [2, 6]) {
    const options = Array.from({ length: count }, (_, index) => ({
      key: `candidate-${index}`,
      label: `候选方案 ${index + 1}`,
    }));
    const planner = new ProviderDecisionQuestionPlannerHost(providerReturning({
      type: 'choice',
      instructions: '比较答案或解决方案',
      options,
    }));
    assert.deepEqual(
      await planner.plan({ state: '请给出可行方案', purpose: 'answer_options' }),
      { errorCode: 'invalid_output' },
      `candidate count ${count} should be rejected`,
    );
  }
});

test('dynamic Jev planner fails closed on malformed criteria', async () => {
  const planner = new ProviderDecisionQuestionPlannerHost(providerReturning({
    type: 'choice',
    instructions: '判断消息',
    options: [{ key: 'only', label: '唯一候选' }],
  }));
  assert.deepEqual(await planner.plan({ state: 'smk' }), { errorCode: 'invalid_output' });
});

test('planner uses a closed schema without unsupported oneOf or dynamic object keys', async () => {
  let captured: StreamChatParams | undefined;
  const provider = providerReturning({ type: 'noul', instructions: '是否在打招呼？', options: [
    { key: 'true', label: '是' }, { key: 'false', label: '否' },
  ] });
  const planner = new ProviderDecisionQuestionPlannerHost({ streamChat(params) {
    captured = params;
    return provider.streamChat(params);
  } });
  const result = await planner.plan({ state: '哈喽' });
  assert.deepEqual(result, { id: 'jev_dynamic', type: 'noul', instructions: '是否在打招呼？', criteria: { true: '是', false: '否' } });
  assert.equal(captured?.interactionMode, 'classifier');
  assert.equal(captured?.workingDirectory, undefined);
  assert.equal(captured?.files, undefined);
  const schema = captured!.responseSchema as Record<string, any>;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['type', 'instructions', 'options']);
  assert.equal(schema.properties.options.items.additionalProperties, false);
  assert.equal(JSON.stringify(schema).includes('oneOf'), false);
});

test('planner projects score levels in order and rejects mismatched noul keys', async () => {
  const options = [{ key: 'low', label: '低' }, { key: 'high', label: '高' }];
  const score = await new ProviderDecisionQuestionPlannerHost(providerReturning({ type: 'score', instructions: '评估满意程度', options })).plan({ state: '很好' });
  assert.deepEqual(score, { id: 'jev_dynamic', type: 'score', instructions: '评估满意程度', criteria: ['低', '高'] });
  const noul = await new ProviderDecisionQuestionPlannerHost(providerReturning({ type: 'noul', instructions: '是否满意', options })).plan({ state: '很好' });
  assert.deepEqual(noul, { errorCode: 'invalid_output' });
});

test('planner rejects duplicate options and extra action fields', async () => {
  for (const options of [
    [{ key: 'a', label: '一' }, { key: 'a', label: '二' }],
    [{ key: 'a', label: '一' }, { key: 'b', label: '一' }],
    [{ key: 'a', label: '一', action: 'send' }, { key: 'b', label: '二' }],
  ]) {
    const planner = new ProviderDecisionQuestionPlannerHost(providerReturning({ type: 'choice', instructions: '判断消息', options }));
    assert.deepEqual(await planner.plan({ state: '测试' }), { errorCode: 'invalid_output' });
  }
});

test('planner distinguishes timeout and cancellation and releases the underlying stream', async () => {
  let cancelled = 0;
  let captured: StreamChatParams | undefined;
  const planner = new ProviderDecisionQuestionPlannerHost({ streamChat(params) {
    captured = params;
    return new ReadableStream<string>({ cancel() { cancelled += 1; } });
  } }, 20);
  const keepAlive = setInterval(() => {}, 50);
  try {
    assert.deepEqual(await planner.plan({ state: '哈喽' }), { errorCode: 'timeout' });
    assert.equal(captured?.abortController?.signal.aborted, true);
    assert.equal(cancelled, 1);
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await planner.plan({ state: '哈喽', signal: controller.signal }), { errorCode: 'cancelled' });
    assert.equal(cancelled, 1);
  } finally { clearInterval(keepAlive); }
});

test('planner reports provider errors without returning their sensitive text', async () => {
  const planner = new ProviderDecisionQuestionPlannerHost({ streamChat() {
    return new ReadableStream<string>({ start(controller) { controller.error(new Error('secret upstream error')); } });
  } });
  assert.deepEqual(await planner.plan({ state: '哈喽' }), { errorCode: 'provider_error' });
});
