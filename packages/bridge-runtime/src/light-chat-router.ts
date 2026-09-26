import type { StreamChatParams } from 'claude-to-im/host';

import {
  isLightChatCandidate,
  type LightConversationDecision,
} from './local-llm-router.js';
import type { Config } from './config.js';

/** Provider-neutral route labels. They deliberately describe routing only. */
export const LIGHT_CHAT_ROUTE_INTENTS = ['light_chat', 'task', 'ambiguous'] as const;
export type LightChatRouteIntent = (typeof LIGHT_CHAT_ROUTE_INTENTS)[number];

export type LightChatRouterProvider = 'coordinator' | 'jev' | (string & {});
export type LightChatRouterMode = 'off' | 'shadow' | 'assist';
export type LightChatRouteEffectivePath = 'coordinator' | 'primary' | 'skipped';

export const LIGHT_CHAT_ROUTE_MIN_PROBABILITY = 0.8;
export const LIGHT_CHAT_ROUTE_MIN_MARGIN = 0.15;

export interface LightChatRouterSettings {
  provider?: LightChatRouterProvider;
  mode?: LightChatRouterMode;
}

export interface LightChatRouteDistribution {
  light_chat: number;
  task: number;
  ambiguous: number;
}

export interface LightChatRouteDecision {
  provider: string;
  model?: string;
  intent: LightChatRouteIntent;
  probabilities: LightChatRouteDistribution;
  confidence: number;
  accepted: boolean;
  reason: string;
  /** Provider-reported usage is optional and never contains prompt content. */
  usage?: LightChatRouteUsage;
}

export interface LightChatRouteUsage {
  inputTokens?: number;
  outputTokens?: number;
  reportedCostUsd?: number;
}

export interface LightChatRouteProvider {
  readonly kind: string;
  classify(
    params: StreamChatParams,
    signal?: AbortSignal,
  ): Promise<LightChatRouteDecision | null>;
}

export interface CoordinatorRouteEvaluator {
  (params: StreamChatParams, signal?: AbortSignal): Promise<LightConversationDecision | null>;
}

export interface LightChatRouteOutcome {
  eligible: boolean;
  provider: string;
  mode: LightChatRouterMode;
  decision: LightChatRouteDecision | null;
  /** The effective downstream path. Shadow never changes this to Primary. */
  path: LightChatRouteEffectivePath;
  fallbackReason?: string;
}

function normalizeMode(value: unknown): LightChatRouterMode {
  return value === 'shadow' || value === 'assist' || value === 'off' ? value : 'off';
}

/** Normalize settings at the Runtime boundary; unknown values fail closed. */
export function normalizeLightChatRouterSettings(
  settings: LightChatRouterSettings = {},
): Required<LightChatRouterSettings> {
  const provider = typeof settings.provider === 'string' && settings.provider.trim()
    ? settings.provider.trim().toLowerCase()
    : 'coordinator';
  const mode = normalizeMode(settings.mode);
  return { provider, mode };
}

/**
 * This is intentionally a second gate in front of any remote classifier. The
 * Bridge-issued eligibility flag, attachment check and execution requirement
 * are all required before a route Provider can see a message.
 */
export function isLightChatRouteCandidate(params: StreamChatParams, config: Config): boolean {
  return isLightChatCandidate(params, config);
}

function emptyDistribution(): LightChatRouteDistribution {
  return { light_chat: 0, task: 0, ambiguous: 0 };
}

/**
 * Convert a coordinator's existing reply/delegate/clarify contract to the
 * provider-neutral routing contract. The coordinator remains the reply
 * generator; this adapter only exposes its route decision.
 */
export class CoordinatorLightChatRouteProvider implements LightChatRouteProvider {
  readonly kind = 'coordinator';

  constructor(private readonly evaluate: CoordinatorRouteEvaluator) {}

  async classify(params: StreamChatParams, signal?: AbortSignal): Promise<LightChatRouteDecision | null> {
    const result = await this.evaluate(params, signal);
    if (!result) return null;
    const intent: LightChatRouteIntent = result.action === 'reply'
      ? 'light_chat'
      : result.action === 'clarify'
        ? 'ambiguous'
        : 'task';
    const confidence = clampProbability(result.confidence);
    const probabilities = emptyDistribution();
    probabilities[intent] = confidence;
    return {
      provider: this.kind,
      intent,
      probabilities,
      confidence,
      accepted: confidence >= LIGHT_CHAT_ROUTE_MIN_PROBABILITY,
      reason: result.reason || 'coordinator_route',
    };
  }
}

/**
 * Apply the common confidence and margin policy. A failed/low-confidence Jev
 * result is represented as a normal coordinator fallback by the caller.
 */
export function selectConfidentLightChatRoute(
  decision: LightChatRouteDecision | null,
): LightChatRouteDecision | null {
  if (!decision) return null;
  const values = LIGHT_CHAT_ROUTE_INTENTS.map((intent) => decision.probabilities[intent]);
  const sorted = [...values].sort((a, b) => b - a);
  const top = sorted[0] || 0;
  const second = sorted[1] || 0;
  const confidence = clampProbability(decision.confidence);
  if (decision.intent !== LIGHT_CHAT_ROUTE_INTENTS[values.indexOf(top)]) return null;
  if (top < LIGHT_CHAT_ROUTE_MIN_PROBABILITY || top - second < LIGHT_CHAT_ROUTE_MIN_MARGIN) return null;
  return {
    ...decision,
    confidence: Math.max(confidence, top),
    accepted: true,
  };
}

/**
 * Provider-neutral orchestration used by HubLlmProvider. It does not execute
 * the coordinator or Primary; it only decides which downstream path should be
 * selected. The caller owns actual response generation and fallback handling.
 */
export async function evaluateLightChatRoute(input: {
  params: StreamChatParams;
  config: Config;
  settings?: LightChatRouterSettings;
  provider?: LightChatRouteProvider;
  signal?: AbortSignal;
}): Promise<LightChatRouteOutcome> {
  const settings = normalizeLightChatRouterSettings(input.settings);
  if (!isLightChatRouteCandidate(input.params, input.config)) {
    return {
      eligible: false,
      provider: settings.provider,
      mode: settings.mode,
      decision: null,
      path: 'skipped',
      fallbackReason: 'hard_gate',
    };
  }
  if (settings.mode === 'off' || !input.provider) {
    return {
      eligible: true,
      provider: settings.provider,
      mode: settings.mode,
      decision: null,
      path: 'coordinator',
      fallbackReason: settings.mode === 'off' ? 'router_off' : 'provider_unavailable',
    };
  }

  let decision: LightChatRouteDecision | null = null;
  let providerFailureReason: string | undefined;
  try {
    decision = await input.provider.classify(input.params, input.signal);
  } catch (error) {
    decision = null;
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    providerFailureReason = input.signal?.aborted
      ? (String(input.signal.reason || '').toLowerCase().includes('timeout') ? 'timeout' : 'cancelled')
      : message.includes('invalid')
        ? 'invalid_result'
        : 'provider_failed';
  }
  const accepted = selectConfidentLightChatRoute(decision);
  if (settings.mode === 'shadow' || !accepted) {
    return {
      eligible: true,
      provider: settings.provider,
      mode: settings.mode,
      decision,
      path: 'coordinator',
      ...(accepted ? {} : { fallbackReason: decision ? 'low_confidence_or_invalid' : (providerFailureReason || 'provider_failed') }),
    };
  }
  return {
    eligible: true,
    provider: settings.provider,
    mode: settings.mode,
    decision: accepted,
    path: accepted.intent === 'task' ? 'primary' : 'coordinator',
  };
}

function clampProbability(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
