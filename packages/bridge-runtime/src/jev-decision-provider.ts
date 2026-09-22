import type {
  DecisionAnswer,
  DecisionProviderHost,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
} from 'claude-to-im/host';

export interface JevDecisionProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_MODEL = 'typesafe/jev-1.13';

function clampProbability(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function normalizeQuestion(question: DecisionQuestion): Record<string, unknown> {
  return {
    type: question.type,
    instructions: question.instructions,
    criteria: question.criteria,
  };
}

function normalizeAnswer(id: string, raw: unknown): DecisionAnswer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const type = item.type === 'noul' || item.type === 'choice' || item.type === 'score' ? item.type : null;
  if (!type) return null;
  const probabilities = item.probabilities && typeof item.probabilities === 'object' && !Array.isArray(item.probabilities)
    ? Object.fromEntries(Object.entries(item.probabilities as Record<string, unknown>)
      .map(([key, value]) => [key, clampProbability(value)])
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
    : undefined;
  const answer: DecisionAnswer = {
    id,
    type,
    ...(typeof item.noul === 'number' && Number.isFinite(item.noul) ? { noul: Math.max(0, Math.min(1, item.noul)) } : {}),
    ...(typeof item.choice === 'string' && item.choice.trim() ? { choice: item.choice.trim().slice(0, 160) } : {}),
    ...(typeof item.score === 'number' && Number.isFinite(item.score) ? { score: item.score } : {}),
    ...(clampProbability(item.confidence) !== undefined ? { confidence: clampProbability(item.confidence) } : {}),
    ...(probabilities && Object.keys(probabilities).length > 0 ? { probabilities } : {}),
    ...(item.legend && typeof item.legend === 'object' && !Array.isArray(item.legend)
      ? { legend: Object.fromEntries(Object.entries(item.legend as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string').slice(0, 32)) }
      : {}),
  };
  return answer;
}

function buildAbortSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('jev_decision_timeout')), timeoutMs);
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

/** OpenRouter Decisions API 适配器；它不是 LLMProvider，也不生成自然语言。 */
export class JevDecisionProvider implements DecisionProviderHost {
  readonly kind = 'jev' as const;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: JevDecisionProviderOptions = {}) {
    this.apiKey = options.apiKey?.trim() || '';
    this.endpoint = (options.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/$/u, '');
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.timeoutMs = Math.max(500, Math.min(60_000, Math.floor(options.timeoutMs || 8000)));
  }

  async evaluate(input: DecisionRequest): Promise<DecisionResult | null> {
    if (!this.apiKey || !input.state.trim() || input.questions.length === 0) return null;
    const questions = Object.fromEntries(input.questions.map((question) => [question.id, normalizeQuestion(question)]));
    const abort = buildAbortSignal(input.signal, this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: this.model, state: input.state.slice(0, 16_000), questions }),
        signal: abort.signal,
      });
      if (!response.ok) return null;
      const payload = await response.json() as Record<string, unknown>;
      const rawAnswers = payload.answers && typeof payload.answers === 'object' && !Array.isArray(payload.answers)
        ? payload.answers as Record<string, unknown>
        : {};
      const answers = Object.entries(rawAnswers)
        .map(([id, raw]) => normalizeAnswer(id, raw))
        .filter((answer): answer is DecisionAnswer => Boolean(answer));
      if (answers.length === 0) return null;
      const usage = payload.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage)
        ? payload.usage as Record<string, unknown>
        : undefined;
      return {
        provider: 'jev',
        model: typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : this.model,
        answers,
        generatedAt: new Date().toISOString(),
        ...(typeof payload.id === 'string' && payload.id.trim() ? { requestId: payload.id.trim() } : {}),
        ...(usage ? {
          usage: {
            ...(nonNegative(usage.input_tokens) !== undefined ? { inputTokens: nonNegative(usage.input_tokens) } : {}),
            ...(nonNegative(usage.output_tokens) !== undefined ? { outputTokens: nonNegative(usage.output_tokens) } : {}),
            ...(nonNegative(usage.cost) !== undefined ? { cost: nonNegative(usage.cost) } : {}),
          },
        } : {}),
      };
    } catch {
      return null;
    } finally {
      abort.cleanup();
    }
  }
}

export const JEV_DEFAULT_BASE_URL = DEFAULT_BASE_URL;
export const JEV_DEFAULT_MODEL = DEFAULT_MODEL;

export function createJevDecisionProvider(options: JevDecisionProviderOptions = {}): DecisionProviderHost {
  return new JevDecisionProvider(options);
}
