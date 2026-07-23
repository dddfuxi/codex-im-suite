import type { OutboundMention, OutboundMessage } from '../../../types.js';

export const FEISHU_AT_ALL_ALIASES = new Set(['all', '所有人', '全体成员', '大家']);
export const FEISHU_SENDER_ALIASES = new Set(['我', '俺', '本人', '你', '用户', '发起人', '提问人', '发送者']);

export type FeishuMentionCandidateEvidence = 'native_inbound' | 'current_chat' | 'current_sender' | 'history';

export interface FeishuMentionCandidate {
  userId: string;
  name: string;
  aliases: string[];
  /** 群机器人 sender 事件使用 app_id，原生 mention 使用 member open_id。 */
  appIds?: string[];
  /** 除可 mention userId 外，平台成员 payload 中可用于同一身份求交的 open/user/union ID。 */
  platformIds?: string[];
  /** 证据来源只在一次出站解析期间使用，不进入长期事实。 */
  evidenceSources?: FeishuMentionCandidateEvidence[];
}

export interface FeishuChatMemberListItem {
  member_id?: string;
  memberId?: string;
  member_id_type?: string;
  memberIdType?: string;
  open_id?: string;
  openId?: string;
  user_id?: string;
  userId?: string;
  union_id?: string;
  unionId?: string;
  name?: string;
  user_name?: string;
  userName?: string;
  display_name?: string;
  displayName?: string;
  nickname?: string;
  en_name?: string;
  enName?: string;
  app_name?: string;
  appName?: string;
  bot_name?: string;
  botName?: string;
  app_id?: string;
  appId?: string;
  id?: unknown;
  user?: unknown;
  bot?: unknown;
  i18n_name?: unknown;
  localized_name?: unknown;
}

export interface AddFeishuMentionCandidateInput {
  userId?: string;
  name?: string;
  aliases?: string[];
  appIds?: string[];
  platformIds?: string[];
  evidenceSource?: FeishuMentionCandidateEvidence;
}

export interface ResolveFeishuBotSenderMentionCandidateInput {
  appIds?: string[];
  platformIds?: string[];
}

function getObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

export function cleanFeishuMentionName(name: string | undefined, fallback = '用户'): string {
  const cleaned = (name || '').replace(/^@+/, '').replace(/[<>"]/g, '').trim();
  if (!cleaned || /^o[cu]_[A-Za-z0-9_-]+$/u.test(cleaned)) return fallback;
  return cleaned;
}

export function normalizeFeishuMentionAlias(name: string | undefined): string {
  return (name || '').replace(/^@+/, '').replace(/\s+/g, '').trim().toLowerCase();
}

export function isDefinitelyNonUserFeishuMentionId(id: string | undefined): boolean {
  const normalized = (id || '').trim().toLowerCase();
  return /^cli_/u.test(normalized) || /^app_/u.test(normalized) || /^bot_/u.test(normalized);
}

export function inferFeishuDirectMessageReceiveIdType(id: string): 'open_id' | 'union_id' | 'user_id' {
  const normalized = id.trim();
  if (/^ou_/iu.test(normalized)) return 'open_id';
  if (/^on_/iu.test(normalized)) return 'union_id';
  return 'user_id';
}

export function uniqueFeishuMentionAliases(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const cleaned = cleanFeishuMentionName(value, '');
    const key = normalizeFeishuMentionAlias(cleaned);
    if (!cleaned || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function uniqueFeishuIdentityIds(values: unknown[]): string[] {
  return Array.from(new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)));
}

export function pickFeishuMentionableMemberId(
  item: FeishuChatMemberListItem,
  allowLegacyMemberId = false,
): string {
  const raw = getObject(item);
  const id = getObject(item.id);
  const user = getObject(item.user);
  const bot = getObject(item.bot);
  const memberId = firstNonEmptyString(item.member_id, item.memberId, raw.memberId);
  const memberIdType = firstNonEmptyString(item.member_id_type, item.memberIdType, raw.memberIdType).toLowerCase();
  // members/list 会按请求的 member_id_type 返回真正可用于原生 @ 的 member_id；
  // payload 同时出现 union_id 等辅助身份时，不能让辅助字段抢占 mentionable ID。
  if (memberId && ['open_id', 'user_id', 'union_id'].includes(memberIdType)) return memberId;

  const directId = firstNonEmptyString(
    item.open_id, item.openId, id.open_id, id.openId, user.open_id, user.openId, bot.open_id, bot.openId,
    item.user_id, item.userId, id.user_id, id.userId, user.user_id, user.userId, bot.user_id, bot.userId,
    item.union_id, item.unionId, id.union_id, id.unionId, user.union_id, user.unionId, bot.union_id, bot.unionId,
  );
  if (directId) return directId;

  if (!memberId) return '';
  if (allowLegacyMemberId || /^o[un]_/iu.test(memberId)) return memberId;
  return '';
}

export function buildFeishuMentionCandidateFromMember(
  item: FeishuChatMemberListItem,
  allowLegacyMemberId = false,
): FeishuMentionCandidate | null {
  const raw = getObject(item);
  const id = getObject(item.id);
  const user = getObject(item.user);
  const bot = getObject(item.bot);
  const i18nName = getObject(item.i18n_name);
  const localizedName = getObject(item.localized_name);
  const userId = pickFeishuMentionableMemberId(item, allowLegacyMemberId);
  if (!userId || isDefinitelyNonUserFeishuMentionId(userId)) return null;

  const aliases = uniqueFeishuMentionAliases([
    item.name, item.user_name, item.userName, item.display_name, item.displayName, item.nickname,
    item.en_name, item.enName, item.app_name, item.appName, item.bot_name, item.botName,
    raw.name, raw.displayName, raw.appName, raw.botName,
    user.name, user.display_name, user.displayName, user.user_name, user.userName,
    bot.name, bot.app_name, bot.appName, bot.bot_name, bot.botName,
    i18nName.zh_cn, i18nName.en_us, localizedName.zh_cn, localizedName.en_us,
  ]);
  const appIds = Array.from(new Set([
    item.app_id, item.appId, raw.app_id, raw.appId,
    bot.app_id, bot.appId,
  ].filter((value): value is string => typeof value === 'string' && !!value.trim())
    .map((value) => value.trim())));
  const platformIds = uniqueFeishuIdentityIds([
    item.open_id, item.openId, id.open_id, id.openId, user.open_id, user.openId, bot.open_id, bot.openId,
    item.user_id, item.userId, id.user_id, id.userId, user.user_id, user.userId, bot.user_id, bot.userId,
    item.union_id, item.unionId, id.union_id, id.unionId, user.union_id, user.unionId, bot.union_id, bot.unionId,
  ]).filter((value) => value !== userId && !isDefinitelyNonUserFeishuMentionId(value));
  const name = aliases[0] || '';
  return name ? {
    userId,
    name,
    aliases,
    ...(appIds.length > 0 ? { appIds } : {}),
    ...(platformIds.length > 0 ? { platformIds } : {}),
  } : null;
}

export function addFeishuMentionCandidate(
  candidates: Map<string, FeishuMentionCandidate>,
  input: AddFeishuMentionCandidateInput,
): void {
  const userId = (input.userId || '').trim();
  const name = cleanFeishuMentionName(input.name, '');
  if (!userId || !name || isDefinitelyNonUserFeishuMentionId(userId)) return;

  const existing = candidates.get(userId);
  const aliases = uniqueFeishuMentionAliases([
    ...(existing?.aliases || []),
    name,
    ...(input.aliases || []),
  ]);
  const evidenceSources = Array.from(new Set([
    ...(existing?.evidenceSources || []),
    ...(input.evidenceSource ? [input.evidenceSource] : []),
  ]));
  const appIds = Array.from(new Set([
    ...(existing?.appIds || []),
    ...(input.appIds || []),
  ].map((value) => value.trim()).filter(Boolean)));
  const platformIds = uniqueFeishuIdentityIds([
    ...(existing?.platformIds || []),
    ...(input.platformIds || []),
  ]).filter((value) => value !== userId && !isDefinitelyNonUserFeishuMentionId(value));
  candidates.set(userId, {
    userId,
    name: existing?.name || name,
    aliases,
    ...(appIds.length > 0 ? { appIds } : {}),
    ...(platformIds.length > 0 ? { platformIds } : {}),
    ...(evidenceSources.length > 0 ? { evidenceSources } : {}),
  });
}

/**
 * 将真实 bot/app 入站 sender 身份与当前群官方成员候选求交。
 * 飞书不同事件会给 app_id，或只给 open_id/user_id/union_id；两类证据都可用，
 * 但只要它们指向不同的可 mention 成员就失败关闭，避免按显示名猜机器人。
 */
export function resolveFeishuBotSenderMentionCandidate(
  candidates: FeishuMentionCandidate[],
  input: ResolveFeishuBotSenderMentionCandidateInput,
): FeishuMentionCandidate | null {
  const senderAppIds = new Set(uniqueFeishuIdentityIds(input.appIds || []));
  const senderPlatformIds = new Set(uniqueFeishuIdentityIds(input.platformIds || [])
    .filter((value) => !isDefinitelyNonUserFeishuMentionId(value)));
  if (senderAppIds.size === 0 && senderPlatformIds.size === 0) return null;

  const matches = candidates.filter((candidate) => {
    const appMatched = (candidate.appIds || []).some((value) => senderAppIds.has(value));
    const platformMatched = [candidate.userId, ...(candidate.platformIds || [])]
      .some((value) => senderPlatformIds.has(value));
    return appMatched || platformMatched;
  });
  const uniqueByMentionableId = new Map(matches.map((candidate) => [candidate.userId, candidate]));
  return uniqueByMentionableId.size === 1 ? [...uniqueByMentionableId.values()][0] : null;
}

export function findFeishuMentionCandidateMatches(
  target: string,
  candidates: FeishuMentionCandidate[],
  mode: 'exact' | 'related',
): FeishuMentionCandidate[] {
  const normalizedTarget = normalizeFeishuMentionAlias(target);
  if (!normalizedTarget) return [];
  const byId = new Map<string, FeishuMentionCandidate>();
  for (const candidate of candidates) {
    const aliases = [candidate.name, ...candidate.aliases]
      .map(normalizeFeishuMentionAlias)
      .filter(Boolean);
    const matched = mode === 'exact'
      ? aliases.some((alias) => alias === normalizedTarget)
      : aliases.some((alias) => alias === normalizedTarget
        || (normalizedTarget.length >= 2 && alias.includes(normalizedTarget))
        || (alias.length >= 2 && normalizedTarget.includes(alias)));
    if (matched && !byId.has(candidate.userId)) byId.set(candidate.userId, candidate);
  }
  return [...byId.values()];
}

export function preferHighestEvidenceFeishuMentionCandidates(
  candidates: FeishuMentionCandidate[],
): FeishuMentionCandidate[] {
  const evidenceRank = (candidate: FeishuMentionCandidate): number => {
    const sources = candidate.evidenceSources || [];
    if (sources.includes('native_inbound')) return 40;
    if (sources.includes('current_chat')) return 30;
    if (sources.includes('current_sender')) return 20;
    if (sources.includes('history')) return 10;
    return 0;
  };
  const highestRank = Math.max(...candidates.map(evidenceRank), Number.NEGATIVE_INFINITY);
  return candidates.filter((candidate) => evidenceRank(candidate) === highestRank);
}

export function resolveFeishuOutboundMentionTarget(
  target: string,
  candidates: FeishuMentionCandidate[],
): OutboundMention | null {
  const normalizedTarget = normalizeFeishuMentionAlias(target);
  if (!normalizedTarget) return null;
  if (FEISHU_AT_ALL_ALIASES.has(normalizedTarget)) return { atAll: true, name: '所有人' };

  const matches = preferHighestEvidenceFeishuMentionCandidates(
    findFeishuMentionCandidateMatches(target, candidates, 'exact'),
  );
  const uniqueById = new Map(matches.map((candidate) => [candidate.userId, candidate]));
  if (uniqueById.size !== 1) return null;
  const candidate = [...uniqueById.values()][0];
  return { userId: candidate.userId, name: candidate.name };
}

export function toFeishuMentionResolutionCandidates(
  candidates: FeishuMentionCandidate[],
): Array<{ name: string; aliases?: string[] }> {
  const byName = new Map<string, { name: string; aliases?: string[] }>();
  for (const candidate of candidates) {
    const name = cleanFeishuMentionName(candidate.name, '');
    if (!name || byName.has(name)) continue;
    const aliases = uniqueFeishuMentionAliases(candidate.aliases)
      .filter((alias) => normalizeFeishuMentionAlias(alias) !== normalizeFeishuMentionAlias(name))
      .slice(0, 3);
    byName.set(name, { name, aliases: aliases.length > 0 ? aliases : undefined });
  }
  return [...byName.values()].slice(0, 8);
}

export function buildFeishuOutboundMentionTags(
  message?: Pick<OutboundMessage, 'text' | 'mentions'>,
): string[] {
  if (!message || /<at\s+user_id=/iu.test(message.text)) return [];
  const mentions: OutboundMention[] = [];
  const seen = new Set<string>();
  for (const mention of message.mentions || []) {
    const key = mention.atAll ? '__all__' : (mention.userId || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    mentions.push(mention);
  }
  return mentions.map((mention) => {
    if (mention.atAll) return '<at user_id="all">所有人</at>';
    const userId = (mention.userId || '').trim();
    if (!userId) return '';
    const name = cleanFeishuMentionName(mention.name, '你') || '你';
    return `<at user_id="${userId}">${name}</at>`;
  }).filter(Boolean);
}

export function extractVerifiedFeishuMentionCandidatesFromText(text: string): FeishuMentionCandidate[] {
  const candidates: FeishuMentionCandidate[] = [];
  const seen = new Set<string>();
  const pattern = /<at\s+[^>]*\b(?:user_id|id)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/at>/giu;
  for (const match of text.matchAll(pattern)) {
    const userId = (match[1] || match[2] || match[3] || '').trim();
    if (!userId || userId.toLowerCase() === 'all' || isDefinitelyNonUserFeishuMentionId(userId)) continue;
    const name = cleanFeishuMentionName(match[4], '');
    if (!name) continue;
    const key = `${userId}\u0000${normalizeFeishuMentionAlias(name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ userId, name, aliases: [name] });
  }
  return candidates;
}
