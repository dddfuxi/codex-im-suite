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
});
