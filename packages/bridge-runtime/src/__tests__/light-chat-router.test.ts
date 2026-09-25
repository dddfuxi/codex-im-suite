import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DecisionProviderHost, DecisionRequest, DecisionResult, StreamChatParams } from 'claude-to-im/host';
import type { Config } from '../config.js';
import {
  evaluateLightChatRoute,
  isLightChatRouteCandidate,
  LIGHT_CHAT_ROUTE_MIN_MARGIN,
  LIGHT_CHAT_ROUTE_MIN_PROBABILITY,
  normalizeLightChatRouterSettings,
  selectConfidentLightChatRoute,
} from '../light-chat-router.js';
import { JevLightChatRouteProvider } from '../jev-light-chat-router.js';

const config: Config = {
  runtime: 'codex',
  enabledChannels: [],
  defaultWorkDir: process.cwd(),
  defaultMode: 'code',
  localLlmEnabled: true,
  localLlmAutoRoute: true,
  localLlmRouterEnabled: true,
  localLlmRouterMode: 'hybrid',
  localLlmForceHub: true,
  lightChatFastPathEnabled: true,
};

function params(prompt: string, patch: Partial<StreamChatParams> = {}): StreamChatParams {
  return {
    sessionId: 'route-test',
    prompt,
    systemPrompt: 'Channel assistant identity: bot; Feishu light chat',
    lightChatEligible: true,
    conversationHistory: [],
    ...patch,
  };
}

function jevResult(probabilities: Record<string, number>, choice = 'light_chat', confidence?: number): DecisionResult {
  return {
    provider: 'jev',
    model: 'typesafe/jev-1.13',
    generatedAt: new Date().toISOString(),
    answers: [{ id: 'light_chat_route', type: 'choice', choice, probabilities, ...(confidence === undefined ? {} : { confidence }) }],
  };
}

describe('light chat router policy', () => {
  it('normalizes provider and mode, failing closed for unknown values', () => {
    assert.deepEqual(normalizeLightChatRouterSettings({ provider: 'JEV', mode: 'assist' }), { provider: 'jev', mode: 'assist' });
    assert.deepEqual(normalizeLightChatRouterSettings({ provider: '', mode: 'bogus' as never }), { provider: 'coordinator', mode: 'off' });
  });

  it('retains the existing hard gate before a route provider is called', () => {
    assert.equal(isLightChatRouteCandidate(params('你好'), config), true);
    assert.equal(isLightChatRouteCandidate(params('请读取这个附件', { files: [{ id: 'f', name: 'x', type: 'text/plain', size: 1, data: 'eA==' }] }), config), false);
    assert.equal(isLightChatRouteCandidate(params('你好', { lightChatEligible: false }), config), false);
  });

  it('accepts only the configured probability and margin threshold', () => {
    const accepted = selectConfidentLightChatRoute({
      provider: 'jev', intent: 'task', confidence: .8, accepted: false,
      probabilities: { light_chat: .1, task: LIGHT_CHAT_ROUTE_MIN_PROBABILITY, ambiguous: .1 }, reason: 'test',
    });
    assert.equal(accepted?.intent, 'task');
    const low = selectConfidentLightChatRoute({
      provider: 'jev', intent: 'task', confidence: .9, accepted: true,
      probabilities: { light_chat: .2, task: .79, ambiguous: .01 }, reason: 'test',
    });
    assert.equal(low, null);
    const narrow = selectConfidentLightChatRoute({
      provider: 'jev', intent: 'task', confidence: .9, accepted: true,
      probabilities: { light_chat: .01, task: .81, ambiguous: .7 }, reason: 'test',
    });
    assert.ok(.81 - .7 < LIGHT_CHAT_ROUTE_MIN_MARGIN);
    assert.equal(narrow, null);
  });

  it('maps Jev choice probabilities to the provider-neutral route', async () => {
    let seen: DecisionRequest | undefined;
    const host: DecisionProviderHost = { evaluate: async (request) => {
      seen = request;
      return jevResult({ light_chat: .9, task: .05, ambiguous: .05 });
    } };
    const provider = new JevLightChatRouteProvider(host);
    const decision = await provider.classify(params('哈喽'));
    assert.equal(decision?.intent, 'light_chat');
    assert.equal(decision?.accepted, true);
    assert.equal(seen?.questions[0].type, 'choice');
    assert.deepEqual(seen?.questions[0].criteria, {
      light_chat: '无需工具、文件、外部状态或真实平台动作的问候、感谢、确认、情绪或轻量闲聊。',
      task: '需要 Primary 处理的任务、查询、执行、文件/路径/链接/附件、续办或外部动作。',
      ambiguous: '用户明显在求助或要求回复，但目标对象或意图不足以安全判断。',
    });
  });

  it('fails closed on missing or contradictory Jev distributions', async () => {
    const noDistribution = new JevLightChatRouteProvider({ evaluate: async () => jevResult({}) });
    assert.equal(await noDistribution.classify(params('你好')), null);
    const contradiction = new JevLightChatRouteProvider({ evaluate: async () => jevResult({ light_chat: .1, task: .85, ambiguous: .05 }, 'light_chat') });
    assert.equal(await contradiction.classify(params('你好')), null);
  });

  it('uses shadow as observation only and assist sends high-confidence tasks to Primary', async () => {
    const provider = new JevLightChatRouteProvider({ evaluate: async () => jevResult({ light_chat: .05, task: .9, ambiguous: .05 }, 'task') });
    const shadow = await evaluateLightChatRoute({ params: params('请帮我处理一下'), config, settings: { provider: 'jev', mode: 'shadow' }, provider });
    assert.equal(shadow.path, 'coordinator');
    assert.equal(shadow.decision?.intent, 'task');
    const assist = await evaluateLightChatRoute({ params: params('请帮我处理一下'), config, settings: { provider: 'jev', mode: 'assist' }, provider });
    assert.equal(assist.path, 'primary');
    assert.equal(assist.decision?.intent, 'task');
  });

  it('falls back to Coordinator for Jev timeout, invalid output, and low confidence', async () => {
    const failed = { classify: async () => null, kind: 'jev' };
    const output = await evaluateLightChatRoute({ params: params('你好'), config, settings: { provider: 'jev', mode: 'assist' }, provider: failed });
    assert.equal(output.path, 'coordinator');
    assert.equal(output.fallbackReason, 'provider_failed');
    const low = new JevLightChatRouteProvider({ evaluate: async () => jevResult({ light_chat: .55, task: .4, ambiguous: .05 }) });
    const lowOutput = await evaluateLightChatRoute({ params: params('你好'), config, settings: { provider: 'jev', mode: 'assist' }, provider: low });
    assert.equal(lowOutput.path, 'coordinator');
    assert.equal(lowOutput.fallbackReason, 'low_confidence_or_invalid');
  });

  it('does not call a disabled provider', async () => {
    let called = false;
    const provider = { kind: 'jev', classify: async () => { called = true; return null; } };
    const output = await evaluateLightChatRoute({ params: params('你好'), config, settings: { provider: 'jev', mode: 'off' }, provider });
    assert.equal(output.path, 'coordinator');
    assert.equal(called, false);
  });
});
