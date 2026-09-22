import crypto from 'node:crypto';

import type { LLMProvider } from 'claude-to-im/host';
import type {
  StickerDeliveryEvidence,
  StickerFeedbackCandidate,
} from 'claude-to-im/policy';

import type { StickerAvoidRuleV1, StickerSemanticScopeName } from './types.js';

type FeedbackKind = 'positive' | 'negative' | 'neutral' | 'ambiguous';
type AvoidRuleDraft = Pick<StickerAvoidRuleV1, 'category' | 'condition'>;

export interface StickerFeedbackClassifierPatch {
  intent?: string;
  tone?: string;
  usage?: string;
  aliases?: string[];
  examples?: string[];
  avoidRules?: AvoidRuleDraft[];
}

export interface StickerFeedbackClassification {
  kind: FeedbackKind;
  confidence: number;
  scope: StickerSemanticScopeName;
  scopeId?: string;
  deliveryId: string;
  evidenceId: string;
  evidenceHash: string;
  strength: 'normal' | 'strong';
  reason: string;
  patch: StickerFeedbackClassifierPatch;
}

export interface StickerFeedbackClassifierInput {
  candidate: StickerFeedbackCandidate;
  delivery: StickerDeliveryEvidence;
}

export interface StickerFeedbackClassifier {
  classify(input: StickerFeedbackClassifierInput): Promise<StickerFeedbackClassification>;
}

export interface StickerFeedbackClassifierOptions {
  provider: LLMProvider;
  timeoutMs?: number;
}

const AVOID_CATEGORIES = new Set<StickerAvoidRuleV1['category']>([
  'formal_notice',
  'serious_incident',
  'user_distress',
  'complaint',
  'recent_repeat',
  'scope_preference',
]);

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['positive', 'negative', 'neutral', 'ambiguous'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    scope: { type: 'string', enum: ['global', 'chat', 'user'] },
    scopeId: { type: ['string', 'null'] },
    deliveryId: { type: 'string' },
    evidenceId: { type: 'string' },
    reason: { type: 'string' },
    patch: {
      type: 'object',
      additionalProperties: false,
      properties: {
        intent: { type: ['string', 'null'] },
        tone: { type: ['string', 'null'] },
        usage: { type: ['string', 'null'] },
        aliases: { type: 'array', items: { type: 'string' } },
        examples: { type: 'array', items: { type: 'string' } },
        avoidRules: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              category: { type: 'string', enum: [...AVOID_CATEGORIES] },
              condition: { type: 'string' },
            },
            required: ['category', 'condition'],
          },
        },
      },
      required: ['intent', 'tone', 'usage', 'aliases', 'examples', 'avoidRules'],
    },
  },
  required: ['kind', 'confidence', 'scope', 'scopeId', 'deliveryId', 'evidenceId', 'reason', 'patch'],
} as const;

function parseSseText(chunk: string): string {
  let result = '';
  for (const line of chunk.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    let event: unknown;
    try { event = JSON.parse(payload); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    const record = event as Record<string, unknown>;
    if (record.type === 'error') throw new Error(typeof record.data === 'string' ? record.data : 'provider error');
    if (record.type !== 'text') continue;
    result += typeof record.data === 'string' ? record.data : JSON.stringify(record.data ?? '');
  }
  return result;
}

async function collectClassifierText(provider: LLMProvider, input: StickerFeedbackClassifierInput, timeoutMs: number): Promise<string> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<string> | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortController.signal.addEventListener('abort', () => {
      void reader?.cancel('classifier aborted').catch(() => {});
      reject(new Error('classifier aborted'));
    }, { once: true });
  });
  const prompt = [
    '只输出一个符合 schema 的 JSON 对象；禁止工具、路径、Markdown 和解释文字。',
    '只可引用输入中真实 deliveryId/evidenceId，不能改写 delivery、fileKey、chatId 或 senderId。',
    'kind 只能是 positive、negative、neutral、ambiguous。沉默、无人反驳或自然继续只能是 neutral，不能生成确认 patch。',
    '视觉事实不可修改；patch 只允许 intent、tone、usage、aliases、examples、avoidRules。',
    'avoidRules 必须是结构化类别与条件。无法确定时 kind=ambiguous 且 patch 为空。',
    '',
    `delivery=${JSON.stringify(input.delivery)}`,
    `feedback=${JSON.stringify(input.candidate)}`,
  ].join('\n');
  try {
    reader = provider.streamChat({
      prompt,
      sessionId: `${input.delivery.sessionId}:sticker-feedback:${input.candidate.evidenceId}`,
      forceFreshThread: true,
      interactionMode: 'classifier',
      responseSchema: RESPONSE_SCHEMA,
      systemPrompt: 'You are a strict JSON classifier for verified sticker feedback. Return JSON only.',
      conversationHistory: [],
      replyPresentation: { replyStyleHint: '只输出 JSON' },
      executionRequirement: { kind: 'none', reason: 'sticker feedback classification', requiredToolFamilies: [] },
      abortController,
    }).getReader();
    let text = '';
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (abortController.signal.aborted) throw new Error('classifier aborted');
      if (done) break;
      text += parseSseText(value);
    }
    if (abortController.signal.aborted) throw new Error('classifier aborted');
    return text.trim();
  } finally {
    clearTimeout(timeout);
    if (reader) await reader.cancel().catch(() => {});
  }
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function boundedStrings(value: unknown, maxItems: number, maxChars: number): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
      const normalized = boundedString(item, maxChars);
      return normalized ? [normalized] : [];
    }).slice(0, maxItems)
    : [];
}

function normalizeClassification(payload: unknown, input: StickerFeedbackClassifierInput): StickerFeedbackClassification {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid_json');
  const record = payload as Record<string, unknown>;
  if (!['positive', 'negative', 'neutral', 'ambiguous'].includes(String(record.kind))) throw new Error('invalid_classifier_kind');
  if (record.deliveryId !== input.delivery.deliveryId || record.evidenceId !== input.candidate.evidenceId) {
    throw new Error('classifier_evidence_mismatch');
  }
  const scope = record.scope as StickerSemanticScopeName;
  const scopeId = boundedString(record.scopeId, 256);
  if (scope === 'chat' && scopeId !== input.delivery.chatId) throw new Error('classifier_evidence_mismatch');
  if (scope === 'user' && scopeId !== input.candidate.senderId) throw new Error('classifier_evidence_mismatch');
  if (scope === 'global' && scopeId) throw new Error('classifier_evidence_mismatch');
  if (!['global', 'chat', 'user'].includes(scope)) throw new Error('invalid_classifier_scope');
  const rawPatch = record.patch && typeof record.patch === 'object' && !Array.isArray(record.patch)
    ? record.patch as Record<string, unknown>
    : {};
  const avoidRules = Array.isArray(rawPatch.avoidRules)
    ? rawPatch.avoidRules.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const draft = item as Record<string, unknown>;
      const category = draft.category as StickerAvoidRuleV1['category'];
      const condition = boundedString(draft.condition, 240);
      return AVOID_CATEGORIES.has(category) && condition ? [{ category, condition }] : [];
    }).slice(0, 8)
    : [];
  const patch: StickerFeedbackClassifierPatch = {
    intent: boundedString(rawPatch.intent, 160),
    tone: boundedString(rawPatch.tone, 160),
    usage: boundedString(rawPatch.usage, 320),
    aliases: boundedStrings(rawPatch.aliases, 12, 80),
    examples: boundedStrings(rawPatch.examples, 8, 240),
    avoidRules,
  };
  const kind = record.kind as FeedbackKind;
  if (kind === 'neutral' || kind === 'ambiguous') {
    patch.intent = undefined;
    patch.tone = undefined;
    patch.usage = undefined;
    patch.aliases = [];
    patch.examples = [];
    patch.avoidRules = [];
  }
  const confidence = typeof record.confidence === 'number' && Number.isFinite(record.confidence)
    ? Math.max(0, Math.min(1, record.confidence))
    : 0;
  return {
    kind,
    confidence,
    scope,
    scopeId,
    deliveryId: input.delivery.deliveryId,
    evidenceId: input.candidate.evidenceId,
    evidenceHash: crypto.createHash('sha256').update(JSON.stringify({
      evidenceId: input.candidate.evidenceId,
      sourceMessageId: input.candidate.sourceMessageId,
      deliveryId: input.delivery.deliveryId,
      relation: input.candidate.relation,
    }), 'utf8').digest('hex'),
    strength: kind === 'negative' && confidence >= 0.9 && input.candidate.relation === 'reply' ? 'strong' : 'normal',
    reason: boundedString(record.reason, 400) || '',
    patch,
  };
}

export function createStickerFeedbackClassifier(options: StickerFeedbackClassifierOptions): StickerFeedbackClassifier {
  const timeoutMs = Math.max(10, Math.floor(options.timeoutMs ?? 8_000));
  return {
    async classify(input) {
      const text = await collectClassifierText(options.provider, input, timeoutMs);
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { throw new Error('invalid_json'); }
      return normalizeClassification(payload, input);
    },
  };
}
