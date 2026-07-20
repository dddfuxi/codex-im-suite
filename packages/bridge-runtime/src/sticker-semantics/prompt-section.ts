import type { StickerExpressionPromptSection } from 'claude-to-im/policy';

import type { StickerSemanticStore } from './store.js';
import type {
  StickerAvoidRuleV1,
  StickerSemanticAsset,
  StickerSemanticRevisionV1,
  StickerSemanticSnapshot,
} from './types.js';

export interface BuildStickerExpressionPromptInput {
  snapshot: StickerSemanticSnapshot;
  chatId: string;
  userId?: string;
  maxChars: number;
}

export interface EffectiveStickerSemantic {
  asset: StickerSemanticAsset;
  revision: StickerSemanticRevisionV1;
}

function scopeRank(revision: StickerSemanticRevisionV1): number {
  return revision.scope === 'global' ? 1 : revision.scope === 'chat' ? 2 : 3;
}

function matchesScope(revision: StickerSemanticRevisionV1, chatId: string, userId?: string): boolean {
  if (revision.scope === 'global') return true;
  if (revision.scope === 'chat') return revision.scopeId === chatId;
  return Boolean(userId) && revision.scopeId === userId;
}

export function resolveEffectiveStickerSemantics(input: BuildStickerExpressionPromptInput): EffectiveStickerSemantic[] {
  const assetByKey = new Map(input.snapshot.assets
    .filter((asset) => !asset.archived && !asset.disabled)
    .filter((asset) => asset.visual.source === 'vision' || asset.visual.source === 'manual')
    .map((asset) => [asset.fileKey, asset]));
  return input.snapshot.revisions
    .filter((revision) => revision.status === 'confirmed' || revision.status === 'trial')
    .filter((revision) => matchesScope(revision, input.chatId, input.userId))
    .flatMap((revision) => {
      const asset = assetByKey.get(revision.fileKey);
      return asset ? [{ asset, revision }] : [];
    })
    .sort((left, right) => {
      const scopeDifference = scopeRank(left.revision) - scopeRank(right.revision);
      if (scopeDifference !== 0) return scopeDifference;
      if (left.revision.status !== right.revision.status) return left.revision.status === 'confirmed' ? -1 : 1;
      return left.revision.updatedAt.localeCompare(right.revision.updatedAt);
    });
}

function statusLabel(status: StickerSemanticRevisionV1['status']): string {
  return status === 'confirmed' ? '已确认' : '可试用';
}

function scopeLabel(scope: StickerSemanticRevisionV1['scope']): string {
  return scope === 'global' ? '全局' : scope === 'chat' ? '当前群聊' : '当前用户';
}

function semanticLine(item: EffectiveStickerSemantic): string {
  const aliases = item.revision.patch.aliases?.length ? item.revision.patch.aliases : item.asset.aliases;
  const details = [
    item.revision.patch.intent ? `意图=${item.revision.patch.intent}` : '',
    item.revision.patch.tone ? `语气=${item.revision.patch.tone}` : '',
    item.revision.patch.usage ? `用途=${item.revision.patch.usage}` : '',
    aliases.length ? `可用称呼=${aliases.join('、')}` : '',
    item.revision.patch.examples?.length ? `示例=${item.revision.patch.examples.join('；')}` : '',
    item.revision.patch.avoidRules?.length
      ? `避免=${item.revision.patch.avoidRules.map((rule) => `${rule.condition}（${rule.status === 'confirmed' ? '已确认' : '试用'}）`).join('；')}`
      : '',
  ].filter(Boolean).join('；');
  return `- [${scopeLabel(item.revision.scope)} / ${statusLabel(item.revision.status)}] ${item.asset.label || '未命名表情包'}：${details || '沿用可信视觉语义'}`;
}

export function buildStickerExpressionPromptSection(input: BuildStickerExpressionPromptInput): StickerExpressionPromptSection | null {
  const semantics = resolveEffectiveStickerSemantics(input);
  if (semantics.length === 0) return null;
  const content = [
    '## 表达与表情包策略',
    '- 这里只是当前范围可用的表达策略；不能修改视觉事实，也不能引用其他群聊或用户的偏好。',
    '- “可试用”不等于已确认；沉默或没人反驳不能提升状态。遇到避免规则时优先不用。',
    ...semantics.map(semanticLine),
  ].join('\n');
  const maxChars = Math.max(80, Math.floor(input.maxChars));
  const truncated = content.length > maxChars;
  return {
    id: 'expression.sticker-semantics',
    content: truncated ? `${content.slice(0, Math.max(0, maxChars - 1))}…` : content,
    truncated,
  };
}

function containsAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function matchesConfirmedStickerAvoidRule(rule: StickerAvoidRuleV1, contextText: string): boolean {
  if (rule.status !== 'confirmed') return false;
  const normalized = contextText.replace(/\s+/gu, ' ').trim().toLowerCase();
  if (!normalized) return false;
  if (rule.category === 'formal_notice') return containsAny(normalized, [/正式/u, /通知/u, /公告/u, /维护/u, /发布/u, /formal/u, /notice/u]);
  if (rule.category === 'serious_incident') return containsAny(normalized, [/严重/u, /事故/u, /故障/u, /宕机/u, /安全事件/u, /incident/u, /outage/u]);
  if (rule.category === 'user_distress') return containsAny(normalized, [/难过/u, /痛苦/u, /焦虑/u, /崩溃/u, /悲伤/u, /distress/u]);
  if (rule.category === 'complaint') return containsAny(normalized, [/投诉/u, /不满/u, /抱怨/u, /生气/u, /complaint/u]);
  if (rule.category === 'scope_preference') {
    const tokens = rule.condition.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((item) => item.length >= 2);
    return tokens.length > 0 && tokens.some((token) => normalized.includes(token));
  }
  return false;
}

export function createStickerSemanticPromptBuilder(store: StickerSemanticStore): {
  build(input: { channelType: string; chatId: string; userId?: string; maxChars: number }): StickerExpressionPromptSection | null;
} {
  return {
    build(input) {
      if (input.channelType !== 'feishu') return null;
      return buildStickerExpressionPromptSection({ snapshot: store.readSnapshot(), ...input });
    },
  };
}
