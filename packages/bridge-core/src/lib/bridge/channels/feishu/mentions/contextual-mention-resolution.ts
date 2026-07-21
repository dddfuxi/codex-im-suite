import {
  extractBareFeishuAtTargets,
  extractExplicitFeishuMentionTargetsFromRequest,
  isFeishuMentionExecutionRequest,
  normalizeFeishuMentionTargetKey,
  type FeishuMentionIntentOptions,
} from '../../../application/mentions.js';
import type { OutboundMention } from '../../../types.js';
import type { TurnEvidenceEnvelope, TurnEvidenceItem, TurnFocusDecision } from '../../../turn-context.js';

export type FeishuContextualMentionResolutionStatus =
  | 'not_applicable'
  | 'resolved'
  | 'ambiguous'
  | 'unresolved';

export interface FeishuContextualMentionCandidate {
  evidenceId: string;
  userId: string;
  name: string;
  relation: TurnEvidenceItem['relation'];
  source: TurnEvidenceItem['source'];
  confidence: number;
}

export interface FeishuContextualMentionResolution {
  status: FeishuContextualMentionResolutionStatus;
  reason: string;
  candidate?: FeishuContextualMentionCandidate;
  candidates: FeishuContextualMentionCandidate[];
}

export interface ResolveFeishuContextualMentionInput {
  userText: string;
  envelope: TurnEvidenceEnvelope;
  focus: TurnFocusDecision;
  modelMentions?: OutboundMention[];
  modelText?: string;
  mentionIntentOptions?: FeishuMentionIntentOptions;
}

const CONTEXTUAL_PERSON_TOKEN = '(?:他|她|它|ta|TA|对方|那个人|这个人|刚才(?:那个人|说话的人)?|刚刚(?:那个人|说话的人)?|上面(?:那个人|说话的人)?|前面(?:那个人|说话的人)?)';
const CONTEXTUAL_TARGET_RE = new RegExp(
  `(?:艾特|@|＠|\\bat\\b|mention|提到|点名|通知|叫|喊)(?:一下|下|一声|给|把|请|麻烦)?${CONTEXTUAL_PERSON_TOKEN}|(?:把|给)${CONTEXTUAL_PERSON_TOKEN}(?:艾特|@|＠|\\bat\\b|mention|提到|点名|通知|叫|喊)`,
  'iu',
);
const TRUSTED_CONTEXT_RELATIONS = new Set<TurnEvidenceItem['relation']>([
  'native_reply',
  'native_mention',
  'nearby',
  'likely_context',
  'continuation',
]);
const TRUSTED_CONTEXT_SOURCES = new Set<TurnEvidenceItem['source']>([
  'platform_event',
  'platform_api',
  'local_outbound_ref',
]);

function isMentionableEvidenceActor(item: TurnEvidenceItem): boolean {
  const id = item.actor?.id?.trim() || '';
  const name = item.actor?.displayName?.trim() || '';
  if (!id || !name || !TRUSTED_CONTEXT_RELATIONS.has(item.relation) || !TRUSTED_CONTEXT_SOURCES.has(item.source)) return false;
  if (!['human', 'bot', 'app', 'unknown'].includes(item.actor?.type || 'unknown')) return false;
  return !/^(?:cli_|app_|bot_)/iu.test(id);
}

function toCandidate(item: TurnEvidenceItem): FeishuContextualMentionCandidate {
  return {
    evidenceId: item.id,
    userId: item.actor?.id?.trim() || '',
    name: item.actor?.displayName?.trim() || '',
    relation: item.relation,
    source: item.source,
    confidence: item.confidence,
  };
}

function uniqueCandidates(items: TurnEvidenceItem[]): FeishuContextualMentionCandidate[] {
  const byId = new Map<string, FeishuContextualMentionCandidate>();
  for (const item of items) {
    if (!isMentionableEvidenceActor(item)) continue;
    const candidate = toCandidate(item);
    const existing = byId.get(candidate.userId);
    if (!existing || item.confidence > (items.find((entry) => entry.id === existing.evidenceId)?.confidence || 0)) {
      byId.set(candidate.userId, candidate);
    }
  }
  return [...byId.values()];
}

function selectedModelTargets(input: ResolveFeishuContextualMentionInput): Array<{ userId?: string; name: string }> {
  const selected = new Map<string, { userId?: string; name: string }>();
  for (const mention of input.modelMentions || []) {
    if (mention.atAll) continue;
    const userId = mention.userId?.trim() || '';
    const name = mention.name?.trim() || '';
    if (!userId && !name) continue;
    selected.set(`${userId}\u0000${normalizeFeishuMentionTargetKey(name)}`, { ...(userId ? { userId } : {}), name });
  }
  for (const name of extractBareFeishuAtTargets(input.modelText || '')) {
    const key = `\u0000${normalizeFeishuMentionTargetKey(name)}`;
    if (![...selected.values()].some((item) => normalizeFeishuMentionTargetKey(item.name) === normalizeFeishuMentionTargetKey(name))) {
      selected.set(key, { name });
    }
  }
  return [...selected.values()];
}

function findModelSelectedCandidate(
  selected: Array<{ userId?: string; name: string }>,
  candidates: FeishuContextualMentionCandidate[],
): FeishuContextualMentionCandidate[] {
  const matches = new Map<string, FeishuContextualMentionCandidate>();
  for (const target of selected) {
    const targetName = normalizeFeishuMentionTargetKey(target.name);
    for (const candidate of candidates) {
      if (target.userId) {
        if (target.userId !== candidate.userId) continue;
      } else if (!targetName || targetName !== normalizeFeishuMentionTargetKey(candidate.name)) {
        continue;
      }
      matches.set(candidate.userId, candidate);
    }
  }
  return [...matches.values()];
}

function affectionateStem(name: string): string {
  const normalized = name.normalize('NFKC').replace(/\s+/gu, '').trim();
  if (normalized.length <= 1) return normalized;
  return normalized.replace(/^(?:小|老|阿)/u, '');
}

function matchesAffectionateReference(content: string, name: string): boolean {
  const stem = affectionateStem(name);
  if (!stem) return false;
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?:姐姐|姐|哥哥|哥|老师|同学|总|老板)`, 'u').test(content.normalize('NFKC'));
}

/**
 * 只解析“本轮明确要求执行 mention，但目标使用代词/指代表达”的场景。
 * 模型最多选择真实 evidence，平台 ID 仍需由 Delivery 调用当前群官方成员接口复核。
 */
export function resolveFeishuContextualMention(
  input: ResolveFeishuContextualMentionInput,
): FeishuContextualMentionResolution {
  const explicitTargets = extractExplicitFeishuMentionTargetsFromRequest(input.userText, input.mentionIntentOptions);
  if (!isFeishuMentionExecutionRequest(input.userText, input.mentionIntentOptions)
    || explicitTargets.length > 0
    || !CONTEXTUAL_TARGET_RE.test(input.userText)) {
    return { status: 'not_applicable', reason: '当前请求不是需要上下文解析的 mention 指代。', candidates: [] };
  }

  const candidates = uniqueCandidates(input.envelope.evidence);
  if (candidates.length === 0) {
    return { status: 'unresolved', reason: '本轮没有带真实平台身份的人物 evidence。', candidates: [] };
  }

  const selected = selectedModelTargets(input);
  const selectedCandidates = findModelSelectedCandidate(selected, candidates);
  if (selectedCandidates.length === 1) {
    return {
      status: 'resolved',
      reason: '模型选择了本轮真实人物 evidence，等待当前群官方成员复核。',
      candidate: selectedCandidates[0],
      candidates: selectedCandidates,
    };
  }
  if (selectedCandidates.length > 1) {
    return { status: 'ambiguous', reason: '模型选择对应多个真实人物 evidence。', candidates: selectedCandidates };
  }

  const primaryActors = uniqueCandidates(input.envelope.evidence.filter((item) => input.focus.primaryEvidenceIds.includes(item.id)));
  if (primaryActors.length === 1) {
    return {
      status: 'resolved',
      reason: '代词唯一指向本轮主焦点消息的发送者，等待当前群官方成员复核。',
      candidate: primaryActors[0],
      candidates: primaryActors,
    };
  }

  const primaryText = input.envelope.evidence
    .filter((item) => input.focus.primaryEvidenceIds.includes(item.id))
    .map((item) => item.content)
    .join('\n');
  const affectionateMatches = candidates.filter((candidate) => matchesAffectionateReference(primaryText, candidate.name));
  if (affectionateMatches.length === 1) {
    return {
      status: 'resolved',
      reason: '主焦点内容中的称呼唯一匹配本轮人物 evidence，等待当前群官方成员复核。',
      candidate: affectionateMatches[0],
      candidates: affectionateMatches,
    };
  }
  if (affectionateMatches.length > 1) {
    return { status: 'ambiguous', reason: '主焦点称呼对应多个本轮人物 evidence。', candidates: affectionateMatches };
  }

  return {
    status: candidates.length > 1 ? 'ambiguous' : 'resolved',
    reason: candidates.length > 1
      ? '本轮存在多个可能人物，不能唯一解析代词。'
      : '本轮只有一个可 address 的人物 evidence，等待当前群官方成员复核。',
    ...(candidates.length === 1 ? { candidate: candidates[0] } : {}),
    candidates,
  };
}
