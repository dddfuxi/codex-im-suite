import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDecisionResult, renderDecisionView } from '../../lib/bridge/application/decision-view.js';
import { buildFeishuDecisionCard } from '../../lib/bridge/channels/feishu/cards/decision-card.js';
import type { DecisionQuestion } from '../../lib/bridge/host.js';

const noul: DecisionQuestion = {
  id: 'intent',
  type: 'noul',
  instructions: '这项方案是否可行？',
  criteria: { yes: '是', no: '否' },
};

test('decision view rejects mismatched answer types and clamps probabilities', () => {
  const result = normalizeDecisionResult({
    provider: 'jev',
    model: 'typesafe/jev-1.13',
    generatedAt: new Date().toISOString(),
    answers: [
      { id: 'intent', type: 'choice', choice: 'yes' },
      { id: 'intent', type: 'noul', noul: 1.4, confidence: -1, probabilities: { yes: 1.4, no: -0.2 } },
    ],
  }, [noul]);
  assert.ok(result);
  assert.equal(result.answers.length, 1);
  assert.equal(result.answers[0]?.noul, 1);
  assert.equal(result.answers[0]?.confidence, 0);
  assert.deepEqual(result.answers[0]?.probabilities, { yes: 1, no: 0 });
});

test('decision view renders noul probabilities as a read-only table', () => {
  const text = renderDecisionView({
    title: 'Jev 调试结果',
    state: '这项方案是否可行？',
    questions: [noul],
    result: {
      provider: 'jev',
      model: 'typesafe/jev-1.13',
      generatedAt: new Date().toISOString(),
      answers: [{ id: 'intent', type: 'noul', noul: 0.73 }],
    },
  });
  assert.match(text, /是概率 \*\*73%\*\*/u);
  assert.match(text, /\| 是 \| 73% \|/u);
  assert.match(text, /\| 否 \| 27% \|/u);
  assert.doesNotMatch(text, /callback|button|choice-card/iu);
});

test('decision view does not repeat a state that is already the question and keeps state spacing', () => {
  const question: DecisionQuestion = {
    id: 'intent',
    type: 'choice',
    instructions: '哈喽',
    criteria: { greeting: '问候' },
  };
  const duplicateState = renderDecisionView({
    title: 'Jev 纯模式判断',
    state: '哈喽',
    questions: [question],
    result: {
      provider: 'jev',
      model: 'typesafe/jev-1.13',
      generatedAt: new Date().toISOString(),
      answers: [{ id: 'intent', type: 'choice', choice: 'greeting', probabilities: { greeting: 1 } }],
    },
  });
  assert.equal((duplicateState.match(/哈喽/gu) || []).length, 1);

  const contextualState = renderDecisionView({
    title: 'Jev 调试结果',
    state: '当前对话主题：问候',
    questions: [question],
    result: {
      provider: 'jev',
      model: 'typesafe/jev-1.13',
      generatedAt: new Date().toISOString(),
      answers: [{ id: 'intent', type: 'choice', choice: 'greeting', probabilities: { greeting: 1 } }],
    },
  });
  assert.match(contextualState, /\*\*状态：\*\* 当前对话主题：问候/u);
});

test('decision view keeps the original message as the visible label for organized intent prompts', () => {
  const text = renderDecisionView({
    title: 'Jev 纯模式判断',
    state: '哈喽',
    questions: [{
      id: 'intent',
      type: 'choice',
      instructions: '识别这条消息在当前对话中的主要意图：哈喽',
      criteria: { greeting: '问候或打招呼' },
    }],
    result: {
      provider: 'jev',
      model: 'typesafe/jev-1.13',
      generatedAt: new Date().toISOString(),
      answers: [{ id: 'intent', type: 'choice', choice: 'greeting', probabilities: { greeting: 1 } }],
    },
  });
  assert.match(text, /\*\*哈喽\*\*/u);
  assert.doesNotMatch(text, /识别这条消息在当前对话中的主要意图/u);
  assert.doesNotMatch(text, /\*\*状态：\*\*/u);
});

test('Feishu decision card is read-only and does not expose choice callbacks', () => {
  const card = buildFeishuDecisionCard({
    title: 'Jev 调试结果',
    questions: [noul],
    result: {
      provider: 'jev',
      model: 'typesafe/jev-1.13',
      generatedAt: new Date().toISOString(),
      answers: [{ id: 'intent', type: 'noul', noul: 0.5 }],
    },
  });
  const parsed = JSON.parse(card) as { schema?: string; body?: { elements?: Array<Record<string, unknown>> } };
  assert.equal(parsed.schema, '2.0');
  assert.equal(parsed.body?.elements?.some((element) => element.tag === 'action'), false);
});

test('choice distributions use the question criteria labels', () => {
  const question: DecisionQuestion = {
    id: 'kind',
    type: 'choice',
    instructions: '消息意图',
    criteria: { support: '支持', oppose: '反对' },
  };
  const text = renderDecisionView({
    questions: [question],
    result: {
      provider: 'jev',
      model: 'typesafe/jev-1.13',
      generatedAt: new Date().toISOString(),
      answers: [{ id: 'kind', type: 'choice', choice: 'support', probabilities: { support: 0.8, oppose: 0.2 } }],
    },
  });
  assert.match(text, /\| 支持 \| 80% \|/u);
  assert.match(text, /\| 反对 \| 20% \|/u);
  assert.match(text, /选择 \*\*支持\*\*/u);
  assert.doesNotMatch(text, /选择 \*\*support\*\*/u);
});

test('Feishu decision cards use the native header as the only title', () => {
  const card = JSON.parse(buildFeishuDecisionCard({
    title: 'Jev 纯模式判断',
    state: '哈喽',
    questions: [{
      id: 'intent',
      type: 'choice',
      instructions: '哈喽',
      criteria: { irrelevant: '无关' },
    }],
    result: {
      provider: 'jev',
      model: 'typesafe/jev-1.13',
      generatedAt: new Date().toISOString(),
      answers: [{ id: 'intent', type: 'choice', choice: 'irrelevant', probabilities: { irrelevant: 1 } }],
    },
  })) as { header?: { title?: { content?: string } }; body?: { elements?: Array<{ tag?: string; content?: string }> } };
  const markdown = card.body?.elements?.find((element) => element.tag === 'markdown')?.content || '';
  assert.equal(card.header?.title?.content, 'Jev 纯模式判断');
  assert.doesNotMatch(markdown, /^# /mu);
  assert.doesNotMatch(markdown, /\*\*状态：\*\*/u);
});

test('Feishu decision cards render sorted visual probability bars for every candidate', () => {
  const card = JSON.parse(buildFeishuDecisionCard({
    title: 'Jev 纯模式判断',
    questions: [{
      id: 'intent',
      type: 'choice',
      instructions: '当前消息的主要意图',
      criteria: { a: '需要确认', b: '直接执行', c: '补充说明' },
    }],
    result: {
      provider: 'jev',
      model: 'typesafe/jev-1.13',
      generatedAt: new Date().toISOString(),
      answers: [{
        id: 'intent',
        type: 'choice',
        choice: 'b',
        probabilities: { a: 0.12, b: 0.87, c: 0.01 },
      }],
    },
  })) as { body?: { elements?: Array<{ tag?: string; content?: string }> } };
  const markdown = card.body?.elements?.find((element) => element.tag === 'markdown')?.content || '';
  assert.match(markdown, /\| 候选 \| 概率 \| 分布 \|/u);
  assert.match(markdown, /🥇 直接执行 \| \*\*87%\*\* \|/u);
  assert.match(markdown, /🟦/u);
  assert.match(markdown, /⬜/u);
  assert.match(markdown, /需要确认/u);
  assert.match(markdown, /补充说明/u);
  assert.doesNotMatch(markdown, /tag['"]?\s*:\s*['"]action/iu);
});
