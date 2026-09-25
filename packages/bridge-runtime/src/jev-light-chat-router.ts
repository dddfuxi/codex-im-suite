import type {
  DecisionProviderHost,
  DecisionRequest,
  DecisionAnswer,
} from 'claude-to-im/host';
import type { StreamChatParams } from 'claude-to-im/host';

import {
  LIGHT_CHAT_ROUTE_INTENTS,
  LIGHT_CHAT_ROUTE_MIN_MARGIN,
  LIGHT_CHAT_ROUTE_MIN_PROBABILITY,
  type LightChatRouteDecision,
  type LightChatRouteDistribution,
  type LightChatRouteProvider,
} from './light-chat-router.js';

const ROUTE_QUESTION_ID = 'light_chat_route';
const MAX_STATE_CHARS = 8_000;

function clamp(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function compactState(params: StreamChatParams): string {
  const history = (params.conversationHistory || [])
    .slice(-2)
    .map((item) => ({ role: item.role, content: String(item.content || '').slice(0, 500) }));
  // Deliberately omit systemPrompt, files, workspace and execution metadata.
  // Jev is a route classifier, not an execution or context provider.
  return JSON.stringify({
    current_request: String(params.prompt || '').slice(0, 3_000),
    recent_conversation: history,
  }).slice(0, MAX_STATE_CHARS);
}

function normalizeProbabilities(answer: DecisionAnswer): LightChatRouteDistribution | null {
  const raw = answer.probabilities;
  if (!raw || typeof raw !== 'object') return null;
  const values = LIGHT_CHAT_ROUTE_INTENTS.map((intent) => clamp(raw[intent]) ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  const normalized = values.map((value) => value / total);
  return {
    light_chat: normalized[0],
    task: normalized[1],
    ambiguous: normalized[2],
  };
}

function maxIntent(probabilities: LightChatRouteDistribution): { intent: typeof LIGHT_CHAT_ROUTE_INTENTS[number]; top: number; second: number } {
  const ranked = LIGHT_CHAT_ROUTE_INTENTS
    .map((intent) => ({ intent, value: probabilities[intent] }))
    .sort((a, b) => b.value - a.value);
  return { intent: ranked[0].intent, top: ranked[0].value, second: ranked[1].value };
}

/**
 * Jev Decisions API route adapter. It submits one restricted `choice` question
 * and returns only route probabilities; it never generates a visible reply or
 * a Feishu choice callback.
 */
export class JevLightChatRouteProvider implements LightChatRouteProvider {
  readonly kind = 'jev';

  constructor(private readonly decisions: DecisionProviderHost) {}

  async classify(params: StreamChatParams, signal?: AbortSignal): Promise<LightChatRouteDecision | null> {
    const request: DecisionRequest = {
      state: compactState(params),
      questions: [{
        id: ROUTE_QUESTION_ID,
        type: 'choice',
        instructions: '判断当前消息应进入轻聊回复、Primary 任务处理，还是需要澄清。只依据当前请求与极短上下文，不执行任何动作。',
        criteria: {
          light_chat: '无需工具、文件、外部状态或真实平台动作的问候、感谢、确认、情绪或轻量闲聊。',
          task: '需要 Primary 处理的任务、查询、执行、文件/路径/链接/附件、续办或外部动作。',
          ambiguous: '用户明显在求助或要求回复，但目标对象或意图不足以安全判断。',
        },
      }],
      signal,
    };
    const result = await this.decisions.evaluate(request);
    const answer = result?.answers.find((item) => item.id === ROUTE_QUESTION_ID && item.type === 'choice');
    if (!answer) return null;
    const probabilities = normalizeProbabilities(answer);
    if (!probabilities) return null;
    const ranked = maxIntent(probabilities);
    const requestedChoice = typeof answer.choice === 'string' ? answer.choice.trim() : '';
    // A contradictory selected label is an invalid provider result. Failing
    // closed here is safer than silently sending a task to light chat.
    if (requestedChoice && !LIGHT_CHAT_ROUTE_INTENTS.includes(requestedChoice as typeof LIGHT_CHAT_ROUTE_INTENTS[number])) {
      return null;
    }
    if (requestedChoice && requestedChoice !== ranked.intent) return null;
    const confidence = clamp(answer.confidence) ?? ranked.top;
    const accepted = ranked.top >= LIGHT_CHAT_ROUTE_MIN_PROBABILITY
      && ranked.top - ranked.second >= LIGHT_CHAT_ROUTE_MIN_MARGIN;
    return {
      provider: 'jev',
      intent: ranked.intent,
      probabilities,
      confidence,
      accepted,
      reason: accepted ? 'jev_choice_route' : 'jev_low_confidence_route',
    };
  }
}

export function createJevLightChatRouteProvider(decisions: DecisionProviderHost): LightChatRouteProvider {
  return new JevLightChatRouteProvider(decisions);
}

export { ROUTE_QUESTION_ID as JEV_LIGHT_CHAT_ROUTE_QUESTION_ID };

