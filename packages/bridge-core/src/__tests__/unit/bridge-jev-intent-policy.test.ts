import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeJevIntent,
  buildJevDecisionQuestion,
  inferJevIntentQuestion,
  isJevGreeting,
  JEV_INTENT_CRITERIA,
  normalizeJevDecisionQuestion,
  renderJevPlannerFailure,
} from '../../lib/bridge/application/jev-intent-policy.js';

test('planner failures distinguish timeout from invalid questions and never display raw provider text', () => {
  assert.match(renderJevPlannerFailure({ errorCode: 'timeout' }), /超时/u);
  assert.match(renderJevPlannerFailure({ errorCode: 'provider_error' }), /服务暂时不可用/u);
  assert.match(renderJevPlannerFailure({ errorCode: 'invalid_output' }), /格式不符合/u);
  assert.match(renderJevPlannerFailure({ errorCode: 'cancelled' }), /已取消/u);
  assert.doesNotMatch(renderJevPlannerFailure({ errorCode: 'upstream-secret', message: 'sensitive' }), /upstream|sensitive/u);
});

test('问候消息识别为 greeting，并组织意图 choice 题而非 irrelevant', () => {
  const result = analyzeJevIntent('哈喽');
  assert.equal(result.kind, 'greeting');
  assert.equal(result.decisionQuestion?.type, 'choice');
  assert.equal((result.decisionQuestion?.criteria as Record<string, string>).greeting, JEV_INTENT_CRITERIA.greeting);
  assert.equal((result.decisionQuestion?.criteria as Record<string, string>).unclear, JEV_INTENT_CRITERIA.unclear);
});

test('普通陈述和反馈也进入一次意图识别', () => {
  const statement = analyzeJevIntent('我觉得这个方案挺好');
  assert.equal(statement.kind, 'feedback');
  assert.equal(statement.decisionQuestion?.type, 'choice');
  assert.match(statement.decisionQuestion?.instructions || '', /这个方案挺好/u);

  const casual = inferJevIntentQuestion('今天天气不错');
  assert.equal(casual?.type, 'choice');
  assert.equal(analyzeJevIntent('谢谢你的帮助').kind, 'thanks');
});

test('显式是非、选择和评分问题组织对应问题类型', () => {
  const noul = inferJevIntentQuestion('这个方案可以吗？');
  assert.equal(noul?.type, 'noul');
  assert.deepEqual(noul?.criteria, { true: '是', false: '否' });

  const choice = inferJevIntentQuestion('应该选择哪一个方案？');
  assert.equal(choice?.type, 'choice');
  assert.equal((choice?.criteria as Record<string, string>).question, '提问、求解释或表达疑惑');

  const score = inferJevIntentQuestion('请给这次体验打分，0-10 分');
  assert.equal(score?.type, 'score');
  assert.deepEqual(score?.criteria, ['极低', '低', '中', '高', '极高']);
});

test('一次 debug 可指定问题类型，但纯函数不访问 provider 或平台', () => {
  const question = buildJevDecisionQuestion('今天怎么样', undefined, { requestedType: 'score', replyText: '上一条上下文' });
  assert.equal(question?.type, 'score');
  assert.match(question?.instructions || '', /今天怎么样/u);
  assert.equal(analyzeJevIntent('', {}).decisionQuestion, null);
  assert.equal(isJevGreeting('哈喽！'), true);
  assert.equal(isJevGreeting('哈喽，帮我查一下'), false);
});

test('动态题目允许按当前消息生成有限分类，不再强制使用固定意图表', () => {
  const result = normalizeJevDecisionQuestion({
    type: 'choice',
    instructions: '判断“smk”在当前对话中最可能代表什么。',
    criteria: {
      abbreviation: '缩写、代号或内部简称',
      typo: '输入错误或未完成的文字',
      unknown: '仅凭当前消息无法确定含义',
    },
  });
  assert.deepEqual(result, {
    id: 'jev_dynamic',
    type: 'choice',
    instructions: '判断“smk”在当前对话中最可能代表什么。',
    criteria: {
      abbreviation: '缩写、代号或内部简称',
      typo: '输入错误或未完成的文字',
      unknown: '仅凭当前消息无法确定含义',
    },
  });
});

test('动态题目拒绝无界、动作或凭据字段，失败关闭', () => {
  assert.equal(normalizeJevDecisionQuestion({
    type: 'choice',
    instructions: '请执行这个命令并选择结果',
    criteria: { a: '一个选项', b: '另一个选项' },
  }), null);
  assert.equal(normalizeJevDecisionQuestion({
    type: 'choice',
    instructions: '判断当前消息',
    criteria: { only: '只有一个候选' },
  }), null);
});

test('纯 Jev 答案候选题只接受 3 到 5 个 choice 候选', () => {
  const result = normalizeJevDecisionQuestion({
    type: 'choice',
    instructions: '比较当前问题的可行答案或解决方案',
    criteria: {
      direct: '直接按当前方案推进',
      clarify: '先补充信息再决定',
      alternative: '改用替代方案',
      defer: '暂缓处理并观察',
    },
  }, { purpose: 'answer_options' });
  assert.deepEqual(result, {
    id: 'jev_dynamic',
    type: 'choice',
    instructions: '比较当前问题的可行答案或解决方案',
    criteria: {
      direct: '直接按当前方案推进',
      clarify: '先补充信息再决定',
      alternative: '改用替代方案',
      defer: '暂缓处理并观察',
    },
  });

  for (const criteria of [
    { a: '方案 A', b: '方案 B' },
    { a: '方案 A', b: '方案 B', c: '方案 C', d: '方案 D', e: '方案 E', f: '方案 F' },
  ]) {
    assert.equal(normalizeJevDecisionQuestion({
      type: 'choice',
      instructions: '候选方案',
      criteria,
    }, { purpose: 'answer_options' }), null);
  }
});

test('纯 Jev 答案候选题拒绝 noul 和 score', () => {
  assert.equal(normalizeJevDecisionQuestion({
    type: 'noul',
    instructions: '方案是否可行',
    criteria: { true: '可行', false: '不可行' },
  }, { purpose: 'answer_options' }), null);
  assert.equal(normalizeJevDecisionQuestion({
    type: 'score',
    instructions: '方案质量评分',
    criteria: ['低', '中', '高'],
  }, { purpose: 'answer_options' }), null);
});
