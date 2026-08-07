import crypto from 'node:crypto';
import type {
  ChoicePromptStateEntrySnapshot,
  ChoicePromptStateHost,
  ChoicePromptStateSnapshot,
} from '../host.js';

export const CHOICE_CALLBACK_PREFIX = 'choice:select:';
export const MAX_CHOICE_OPTIONS = 8;
const MAX_TRACKED_CHOICE_PARTICIPANTS = 512;
export const MIN_GROUP_CHOICE_DURATION_SECONDS = 10;
export const MAX_GROUP_CHOICE_DURATION_SECONDS = 60 * 60;

export interface ChoicePromptOption {
  label: string;
  description?: string;
}

export interface ChoicePrompt {
  title?: string;
  options: ChoicePromptOption[];
}

export interface ChoiceFlowDirective {
  mode: 'continuous';
  state: 'active' | 'complete';
}

export type ChoiceSessionMode = 'single_user' | 'vote' | 'claim' | 'parallel';
export type ChoiceSessionAudience = 'initiator' | 'chat_members';

/**
 * 模型只能声明低风险的参与语义；参与者身份、callback、会话与截止时间均由 Bridge 签发。
 * 未声明时保持旧版 single_user，避免普通权限/工作区按钮意外开放给全群。
 */
export interface ChoiceSessionDirective {
  mode: ChoiceSessionMode;
  audience: ChoiceSessionAudience;
  state: 'active' | 'complete';
  durationSeconds?: number;
  allowChange?: boolean;
}

export interface ActiveChoiceContinuation {
  flowId: string;
  mode: 'continuous';
  choicesRequired: true;
  groupMode?: Exclude<ChoiceSessionMode, 'single_user'>;
  participantKey?: string;
}

export interface RegisteredChoiceOption extends ChoicePromptOption {
  callbackData: string;
}

export interface RegisteredChoicePrompt {
  nonce: string;
  flowId?: string;
  flowMode?: 'continuous';
  title?: string;
  prompt: string;
  options: RegisteredChoiceOption[];
  choiceSession: ChoiceSessionDirective;
  closesAt?: number;
}

interface ChoiceParticipantSelection {
  participantKey: string;
  optionIndex: number;
  selectedAt: number;
}

interface PendingChoiceEntry {
  channelType: string;
  chatId: string;
  userId?: string;
  sessionId: string;
  prompt: string;
  title?: string;
  options: ChoicePromptOption[];
  flowId?: string;
  flowMode?: 'continuous';
  /**
   * 连续多人分线进入个人分支后，按钮权限会降为 single_user；这里保留原始群体语义
   * 与匿名分支键，供下一轮 Provider 协议和重启恢复使用，绝不保存为模型可执行参数。
   */
  continuationGroupMode?: Exclude<ChoiceSessionMode, 'single_user'>;
  continuationParticipantKey?: string;
  choiceSession: ChoiceSessionDirective;
  openedAt: number;
  closesAt?: number;
  expiresAt: number;
  selections: ChoiceParticipantSelection[];
  /**
   * 第一次成功的官方群成员复核结果。冻结快照可避免投票过程中成员变化导致目标人数漂移；
   * 若无法取得快照则保持 undefined，并继续由截止时间兜底。
   */
  eligibleParticipantKeys?: string[];
  cardMessageId?: string;
  cardHero?: { imageKey: string; alt: string };
}

export interface ChoiceTallyOption extends ChoicePromptOption {
  count: number;
}

export interface ChoicePromptView {
  nonce: string;
  channelType: string;
  chatId: string;
  sessionId: string;
  prompt: string;
  title?: string;
  options: RegisteredChoiceOption[];
  choiceSession: ChoiceSessionDirective;
  openedAt: number;
  closesAt?: number;
  expiresAt: number;
  participantCount: number;
  eligibleParticipantCount?: number;
  tally: ChoiceTallyOption[];
  cardMessageId?: string;
  cardHero?: { imageKey: string; alt: string };
}

export type ChoiceSelectionResult =
  | {
    kind: 'resolved';
    sessionId: string;
    prompt: string;
    title?: string;
    option: ChoicePromptOption;
    participantKey?: string;
    choiceMode: ChoiceSessionMode;
    continuation?: ActiveChoiceContinuation;
    view: ChoicePromptView;
  }
  | { kind: 'recorded'; changed: boolean; allParticipantsSelected: boolean; view: ChoicePromptView }
  | { kind: 'already_participated'; view: ChoicePromptView }
  | { kind: 'consumed' }
  | { kind: 'expired' }
  | { kind: 'forbidden' }
  | { kind: 'invalid' };

export interface FinalizedChoiceSession {
  nonce: string;
  sessionId: string;
  channelType: string;
  chatId: string;
  userId?: string;
  choiceMode: 'vote';
  prompt: string;
  title?: string;
  participantCount: number;
  eligibleParticipantCount?: number;
  tally: ChoiceTallyOption[];
  winningOptions: ChoiceTallyOption[];
  finalizationReason: 'deadline' | 'all_participants_selected';
  finalizedAt: number;
  cardMessageId?: string;
  cardHero?: { imageKey: string; alt: string };
}

function normalizeChoiceText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxChars)
    .trim();
}

function normalizeParticipantKey(value: unknown): string {
  const normalized = normalizeChoiceText(value, 180);
  return normalized && /^[^\u0000-\u001f]{1,180}$/u.test(normalized) ? normalized : '';
}

/** 模型只负责给出可见选项，不允许提供 callback、平台 ID 或任意动作参数。 */
export function parseChoicePrompt(value: unknown, rawTitle?: unknown): ChoicePrompt | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: ChoicePromptOption[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    const label = normalizeChoiceText(typeof item === 'string' ? item : record?.label ?? record?.text, 48);
    if (!label) continue;
    const key = label.toLocaleLowerCase('zh-CN');
    if (seen.has(key)) continue;
    seen.add(key);
    const description = normalizeChoiceText(record?.description ?? record?.detail, 160);
    options.push({ label, ...(description ? { description } : {}) });
    if (options.length >= MAX_CHOICE_OPTIONS) break;
  }

  if (options.length < 2) return undefined;
  const title = normalizeChoiceText(rawTitle, 48);
  return { ...(title ? { title } : {}), options };
}

export function parseChoiceFlowDirective(value: unknown): ChoiceFlowDirective | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.mode !== 'continuous') return undefined;
  if (record.state !== 'active' && record.state !== 'complete') return undefined;
  return { mode: 'continuous', state: record.state };
}

export function parseChoiceSessionDirective(value: unknown): ChoiceSessionDirective | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!['single_user', 'vote', 'claim', 'parallel'].includes(String(record.mode))) return undefined;
  if (record.state !== undefined && record.state !== 'active' && record.state !== 'complete') return undefined;
  const mode = record.mode as ChoiceSessionMode;
  const state = (record.state || 'active') as 'active' | 'complete';
  const audience: ChoiceSessionAudience = mode === 'single_user' ? 'initiator' : 'chat_members';
  const rawDuration = typeof record.duration_seconds === 'number'
    ? record.duration_seconds
    : typeof record.durationSeconds === 'number' ? record.durationSeconds : undefined;
  const durationSeconds = rawDuration === undefined ? undefined : Math.round(rawDuration);
  if (durationSeconds !== undefined
    && (!Number.isFinite(durationSeconds)
      || durationSeconds < MIN_GROUP_CHOICE_DURATION_SECONDS
      || durationSeconds > MAX_GROUP_CHOICE_DURATION_SECONDS)) return undefined;
  if (mode === 'vote' && state === 'active' && durationSeconds === undefined) return undefined;
  return {
    mode,
    audience,
    state,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(mode === 'vote' ? { allowChange: record.allow_change !== false && record.allowChange !== false } : {}),
  };
}

export function parseChoiceSelectionCallback(callbackData: string): { nonce: string; optionIndex: number } | null {
  const match = /^choice:select:([a-z0-9_-]{8,64}):(\d{1,2})$/iu.exec(callbackData.trim());
  if (!match) return null;
  return { nonce: match[1], optionIndex: Number.parseInt(match[2], 10) };
}

export function buildChoiceSelectionText(option: ChoicePromptOption, input?: {
  mode?: ChoiceSessionMode;
  participantKey?: string;
}): string {
  const modeLine = input?.mode === 'claim'
    ? '群体选择结果：一名参与者抢选成功。'
    : input?.mode === 'parallel'
      ? `多人分线选择：参与者分支 ${input.participantKey || '已验证参与者'}。`
      : '';
  return [
    modeLine,
    `我选择：${option.label}`,
    option.description ? `选项说明：${option.description}` : '',
  ].filter(Boolean).join('\n');
}

export function buildVoteFinalizationText(result: FinalizedChoiceSession): string {
  const lines = result.tally.map((item) => `- ${item.label}: ${item.count} 票`);
  const closeLead = result.finalizationReason === 'all_participants_selected'
    ? '所有参与成员均已完成选择'
    : '倒计时结束';
  const outcome = result.participantCount === 0
    ? `${closeLead}，本轮无人投票。`
    : result.winningOptions.length === 1
      ? `${closeLead}，最高票选项：${result.winningOptions[0].label}。`
      : `${closeLead}，出现并列最高票：${result.winningOptions.map((item) => item.label).join('、')}。请根据当前上下文处理平票。`;
  return [
    '群体投票已收口。',
    result.prompt ? `原问题：${result.prompt}` : '',
    `参与人数：${result.participantCount}`,
    ...lines,
    outcome,
  ].filter(Boolean).join('\n');
}

/** 最终卡片使用结构化计票结果生成展示，不让 Provider 从自然语言票数反推赢家。 */
export function buildChoiceSessionFinalizationFooter(
  view: Pick<ChoicePromptView, 'choiceSession' | 'participantCount' | 'tally'>,
): string {
  if (view.choiceSession.mode !== 'vote') return '本轮群体选择已收口。';
  if (view.participantCount === 0) return '截止时无人参与。';
  const maxCount = Math.max(0, ...view.tally.map((item) => item.count));
  const winners = view.tally.filter((item) => item.count === maxCount);
  return winners.length === 1
    ? `结果：${winners[0].label}（${maxCount} 票）`
    : `平票：${winners.map((item) => item.label).join('、')}（各 ${maxCount} 票）`;
}

/**
 * Registry 是群体选择的唯一状态机。Node 单事件循环中的同步 consume/finalize
 * 形成原子临界区，抢选不会在两个异步 Provider 回合之间产生双赢家。
 */
export class ChoicePromptRegistry {
  private readonly entries = new Map<string, PendingChoiceEntry>();
  private readonly consumed = new Map<string, number>();
  private readonly finalizations = new Map<string, FinalizedChoiceSession>();
  private stateHost?: ChoicePromptStateHost;

  constructor(private readonly options: {
    ttlMs?: number;
    now?: () => number;
    nonceFactory?: () => string;
    flowIdFactory?: () => string;
    consumedTtlMs?: number;
  } = {}) {}

  setStateHost(host?: ChoicePromptStateHost): void {
    if (this.stateHost === host) return;
    this.stateHost = host;
    if (!host) {
      this.entries.clear();
      this.consumed.clear();
      this.finalizations.clear();
      return;
    }
    try {
      this.hydrate(host.readSnapshot());
    } catch {
      // 恢复链不得阻断正常选择交付；后续写入会重建合法快照。
    }
  }

  register(input: {
    channelType: string;
    chatId: string;
    userId?: string;
    sessionId: string;
    prompt: string;
    choicePrompt: ChoicePrompt;
    choiceSession?: ChoiceSessionDirective;
    flow?: {
      mode: 'continuous';
      flowId?: string;
      groupMode?: Exclude<ChoiceSessionMode, 'single_user'>;
      participantKey?: string;
    };
    cardHero?: { imageKey: string; alt: string };
  }): RegisteredChoicePrompt {
    const now = this.now();
    this.pruneExpired(now);
    const nonce = (this.options.nonceFactory?.() || crypto.randomBytes(12).toString('hex'))
      .replace(/[^a-z0-9_-]/giu, '')
      .slice(0, 64);
    if (nonce.length < 8) throw new Error('choice nonce is too short');
    const requestedFlowId = normalizeOpaqueId(input.flow?.flowId);
    const flowId = input.flow?.mode === 'continuous'
      ? requestedFlowId || normalizeOpaqueId(this.options.flowIdFactory?.() || crypto.randomBytes(12).toString('hex'))
      : undefined;
    if (input.flow?.mode === 'continuous' && !flowId) throw new Error('choice flow id is invalid');
    const continuationGroupMode = input.flow?.groupMode && ['vote', 'claim', 'parallel'].includes(input.flow.groupMode)
      ? input.flow.groupMode
      : undefined;
    const continuationParticipantKey = normalizeOpaqueId(input.flow?.participantKey);
    const choiceSession = input.choiceSession?.state === 'active'
      ? input.choiceSession
      : { mode: 'single_user', audience: 'initiator', state: 'active' } as const;
    const closesAt = choiceSession.mode === 'vote' && choiceSession.durationSeconds
      ? now + choiceSession.durationSeconds * 1_000
      : undefined;
    const expiresAt = closesAt
      ? closesAt + Math.max(2 * 60_000, this.options.consumedTtlMs ?? 2 * 60_000)
      : now + Math.max(30_000, this.options.ttlMs ?? 15 * 60_000);
    this.entries.set(nonce, {
      channelType: input.channelType,
      chatId: input.chatId,
      userId: input.userId?.trim() || undefined,
      sessionId: input.sessionId,
      prompt: normalizeChoiceText(input.prompt, 800),
      title: input.choicePrompt.title,
      options: input.choicePrompt.options.map((option) => ({ ...option })),
      ...(flowId ? { flowId, flowMode: 'continuous' as const } : {}),
      ...(flowId && continuationGroupMode ? { continuationGroupMode } : {}),
      ...(flowId && continuationGroupMode === 'parallel' && continuationParticipantKey
        ? { continuationParticipantKey }
        : {}),
      choiceSession,
      openedAt: now,
      ...(closesAt ? { closesAt } : {}),
      expiresAt,
      selections: [],
      ...(input.cardHero ? { cardHero: { ...input.cardHero } } : {}),
    });
    this.persist();
    return {
      nonce,
      ...(flowId ? { flowId, flowMode: 'continuous' as const } : {}),
      title: input.choicePrompt.title,
      prompt: normalizeChoiceText(input.prompt, 800),
      options: input.choicePrompt.options.map((option, index) => ({
        ...option,
        callbackData: `${CHOICE_CALLBACK_PREFIX}${nonce}:${index}`,
      })),
      choiceSession,
      ...(closesAt ? { closesAt } : {}),
    };
  }

  inspect(callbackData: string): Pick<ChoicePromptView, 'nonce' | 'channelType' | 'chatId' | 'choiceSession'> | null {
    const parsed = parseChoiceSelectionCallback(callbackData);
    if (!parsed) return null;
    const entry = this.entries.get(parsed.nonce);
    if (!entry) return null;
    return { nonce: parsed.nonce, channelType: entry.channelType, chatId: entry.chatId, choiceSession: { ...entry.choiceSession } };
  }

  consume(callbackData: string, actor: {
    channelType: string;
    chatId: string;
    userId?: string;
    chatMemberVerified?: boolean;
    eligibleParticipantKeys?: string[];
  }): ChoiceSelectionResult {
    const parsed = parseChoiceSelectionCallback(callbackData);
    if (!parsed) return { kind: 'invalid' };
    const entry = this.entries.get(parsed.nonce);
    if (!entry) return this.consumed.has(parsed.nonce) ? { kind: 'consumed' } : { kind: 'expired' };
    const now = this.now();
    if (entry.expiresAt <= now || (entry.closesAt !== undefined && entry.closesAt <= now)) {
      return { kind: 'expired' };
    }
    if (entry.channelType !== actor.channelType || entry.chatId !== actor.chatId) return { kind: 'forbidden' };
    const participantKey = normalizeParticipantKey(actor.userId);
    if (entry.choiceSession.audience === 'initiator') {
      if (entry.userId && entry.userId !== participantKey) return { kind: 'forbidden' };
    } else if (!participantKey || actor.chatMemberVerified !== true) {
      return { kind: 'forbidden' };
    }
    const option = entry.options[parsed.optionIndex];
    if (!option) return { kind: 'invalid' };

    if (entry.choiceSession.mode === 'vote') {
      const verifiedEligibleKeys = Array.from(new Set((actor.eligibleParticipantKeys || [])
        .map(normalizeParticipantKey)
        .filter(Boolean)));
      if (!entry.eligibleParticipantKeys
        && verifiedEligibleKeys.length > 0
        && verifiedEligibleKeys.length <= MAX_TRACKED_CHOICE_PARTICIPANTS) {
        // 只接受包含当前合法点击者的完整快照，防止不完整名单触发提前收口。
        if (!verifiedEligibleKeys.includes(participantKey)) return { kind: 'forbidden' };
        entry.eligibleParticipantKeys = verifiedEligibleKeys;
      }
      if (entry.eligibleParticipantKeys && !entry.eligibleParticipantKeys.includes(participantKey)) {
        return { kind: 'forbidden' };
      }
      const previousIndex = entry.selections.findIndex((item) => item.participantKey === participantKey);
      if (previousIndex >= 0 && entry.choiceSession.allowChange === false) {
        return { kind: 'already_participated', view: this.toView(parsed.nonce, entry) };
      }
      const changed = previousIndex >= 0 && entry.selections[previousIndex].optionIndex !== parsed.optionIndex;
      const next = { participantKey, optionIndex: parsed.optionIndex, selectedAt: now };
      if (previousIndex >= 0) entry.selections[previousIndex] = next;
      else entry.selections.push(next);
      this.persist();
      const selectedParticipants = new Set(entry.selections.map((item) => item.participantKey));
      const allParticipantsSelected = Boolean(entry.eligibleParticipantKeys?.length)
        && entry.eligibleParticipantKeys!.every((key) => selectedParticipants.has(key));
      return { kind: 'recorded', changed, allParticipantsSelected, view: this.toView(parsed.nonce, entry) };
    }

    if (entry.choiceSession.mode === 'parallel') {
      if (entry.selections.some((item) => item.participantKey === participantKey)) {
        return { kind: 'already_participated', view: this.toView(parsed.nonce, entry) };
      }
      entry.selections.push({ participantKey, optionIndex: parsed.optionIndex, selectedAt: now });
      this.persist();
      return this.resolved(parsed.nonce, entry, option, participantKey, false);
    }

    if (entry.choiceSession.mode === 'claim') {
      entry.selections.push({ participantKey, optionIndex: parsed.optionIndex, selectedAt: now });
      return this.resolved(parsed.nonce, entry, option, participantKey, true);
    }

    return this.resolved(parsed.nonce, entry, option, participantKey || undefined, true);
  }

  bindCardMessage(nonce: string, messageId: string): ChoicePromptView | null {
    const entry = this.entries.get(normalizeOpaqueId(nonce));
    const normalizedMessageId = normalizeChoiceText(messageId, 180);
    if (!entry || !normalizedMessageId) return null;
    entry.cardMessageId = normalizedMessageId;
    this.persist();
    return this.toView(nonce, entry);
  }

  cancel(nonce: string): void {
    if (this.entries.delete(normalizeOpaqueId(nonce))) this.persist();
  }

  listPendingVotes(): ChoicePromptView[] {
    return [...this.entries.entries()]
      .filter(([, entry]) => entry.choiceSession.mode === 'vote' && entry.closesAt !== undefined)
      .map(([nonce, entry]) => this.toView(nonce, entry));
  }

  listPendingFinalizations(): FinalizedChoiceSession[] {
    return [...this.finalizations.values()].map((item) => structuredClone(item));
  }

  acknowledgeFinalization(nonce: string): void {
    if (this.finalizations.delete(normalizeOpaqueId(nonce))) this.persist();
  }

  finalizeVote(nonce: string, now = this.now()): FinalizedChoiceSession | null {
    const normalizedNonce = normalizeOpaqueId(nonce);
    const entry = this.entries.get(normalizedNonce);
    if (!entry || entry.choiceSession.mode !== 'vote' || entry.closesAt === undefined || entry.closesAt > now) return null;
    return this.finalizeVoteEntry(normalizedNonce, entry, now, 'deadline');
  }

  /** 只有冻结的真实成员集合已被逐一覆盖时才允许提前收口。 */
  finalizeVoteIfAllSelected(nonce: string, now = this.now()): FinalizedChoiceSession | null {
    const normalizedNonce = normalizeOpaqueId(nonce);
    const entry = this.entries.get(normalizedNonce);
    if (!entry || entry.choiceSession.mode !== 'vote' || !entry.eligibleParticipantKeys?.length) return null;
    const selectedParticipants = new Set(entry.selections.map((item) => item.participantKey));
    if (!entry.eligibleParticipantKeys.every((key) => selectedParticipants.has(key))) return null;
    return this.finalizeVoteEntry(normalizedNonce, entry, now, 'all_participants_selected');
  }

  private finalizeVoteEntry(
    normalizedNonce: string,
    entry: PendingChoiceEntry,
    now: number,
    finalizationReason: FinalizedChoiceSession['finalizationReason'],
  ): FinalizedChoiceSession {
    const view = this.toView(normalizedNonce, entry);
    const max = Math.max(0, ...view.tally.map((item) => item.count));
    const winningOptions = max > 0 ? view.tally.filter((item) => item.count === max) : [];
    this.entries.delete(normalizedNonce);
    this.consumed.set(normalizedNonce, now + Math.max(30_000, this.options.consumedTtlMs ?? 2 * 60_000));
    const finalized: FinalizedChoiceSession = {
      nonce: normalizedNonce,
      sessionId: entry.sessionId,
      channelType: entry.channelType,
      chatId: entry.chatId,
      userId: entry.userId,
      choiceMode: 'vote',
      prompt: entry.prompt,
      title: entry.title,
      participantCount: view.participantCount,
      eligibleParticipantCount: view.eligibleParticipantCount,
      tally: view.tally,
      winningOptions,
      finalizationReason,
      finalizedAt: now,
      cardMessageId: entry.cardMessageId,
      cardHero: entry.cardHero,
    };
    this.finalizations.set(normalizedNonce, finalized);
    this.persist();
    return structuredClone(finalized);
  }

  clear(): void {
    this.entries.clear();
    this.consumed.clear();
    this.finalizations.clear();
    this.persist();
  }

  private resolved(
    nonce: string,
    entry: PendingChoiceEntry,
    option: ChoicePromptOption,
    participantKey: string | undefined,
    terminal: boolean,
  ): Extract<ChoiceSelectionResult, { kind: 'resolved' }> {
    const view = this.toView(nonce, entry);
    const continuationGroupMode = entry.continuationGroupMode
      || (entry.choiceSession.mode !== 'single_user' ? entry.choiceSession.mode : undefined);
    const continuationParticipantKey = entry.continuationParticipantKey
      || (continuationGroupMode === 'parallel' && participantKey
        ? crypto.createHash('sha256').update(participantKey).digest('hex').slice(0, 12)
        : undefined);
    if (terminal) {
      this.entries.delete(nonce);
      this.consumed.set(nonce, this.now() + Math.max(30_000, this.options.consumedTtlMs ?? 2 * 60_000));
    }
    this.persist();
    return {
      kind: 'resolved',
      sessionId: entry.sessionId,
      prompt: entry.prompt,
      title: entry.title,
      option: { ...option },
      participantKey,
      choiceMode: entry.choiceSession.mode,
      ...(entry.flowMode === 'continuous' && entry.flowId ? {
        continuation: {
          flowId: entry.flowId,
          mode: 'continuous' as const,
          choicesRequired: true as const,
          ...(continuationGroupMode ? { groupMode: continuationGroupMode } : {}),
          ...(continuationGroupMode === 'parallel' && continuationParticipantKey
            ? { participantKey: continuationParticipantKey }
            : {}),
        },
      } : {}),
      view,
    };
  }

  private toView(nonce: string, entry: PendingChoiceEntry): ChoicePromptView {
    const tally = entry.options.map((option, optionIndex) => ({
      ...option,
      count: entry.selections.filter((item) => item.optionIndex === optionIndex).length,
    }));
    return {
      nonce,
      channelType: entry.channelType,
      chatId: entry.chatId,
      sessionId: entry.sessionId,
      prompt: entry.prompt,
      title: entry.title,
      options: entry.options.map((option, index) => ({
        ...option,
        callbackData: `${CHOICE_CALLBACK_PREFIX}${nonce}:${index}`,
      })),
      choiceSession: { ...entry.choiceSession },
      openedAt: entry.openedAt,
      closesAt: entry.closesAt,
      expiresAt: entry.expiresAt,
      participantCount: new Set(entry.selections.map((item) => item.participantKey)).size,
      eligibleParticipantCount: entry.eligibleParticipantKeys?.length,
      tally,
      cardMessageId: entry.cardMessageId,
      cardHero: entry.cardHero ? { ...entry.cardHero } : undefined,
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private pruneExpired(now: number): void {
    let changed = false;
    for (const [nonce, entry] of this.entries) {
      // 已到投票截止时间的 entry 留给 finalizeVote，不能在普通 prune 中静默丢失。
      if (entry.expiresAt <= now) {
        this.entries.delete(nonce);
        changed = true;
      }
    }
    for (const [nonce, expiresAt] of this.consumed) {
      if (expiresAt <= now) {
        this.consumed.delete(nonce);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private hydrate(snapshot: ChoicePromptStateSnapshot | null): void {
    this.entries.clear();
    this.consumed.clear();
    this.finalizations.clear();
    if (!snapshot || !['cti-choice-prompts/v1', 'cti-choice-prompts/v2'].includes(snapshot.protocol)) return;
    const now = this.now();
    for (const raw of snapshot.entries.slice(0, 256)) {
      const entry = normalizeSnapshotEntry(raw);
      if (entry && entry.expiresAt > now) this.entries.set(entry.nonce, entry);
    }
    for (const raw of snapshot.consumed.slice(0, 256)) {
      const nonce = normalizeOpaqueId(raw?.nonce);
      if (nonce && Number.isFinite(raw?.expiresAt) && raw.expiresAt > now) this.consumed.set(nonce, raw.expiresAt);
    }
    for (const raw of (snapshot.finalizations || []).slice(0, 256)) {
      const finalized = normalizeFinalizationSnapshot(raw);
      if (finalized) this.finalizations.set(finalized.nonce, finalized);
    }
  }

  private persist(): void {
    if (!this.stateHost) return;
    const snapshot: ChoicePromptStateSnapshot = {
      protocol: 'cti-choice-prompts/v2',
      updatedAt: new Date(this.now()).toISOString(),
      entries: [...this.entries.entries()].map(([nonce, entry]) => ({ nonce, ...entry })),
      consumed: [...this.consumed.entries()].map(([nonce, expiresAt]) => ({ nonce, expiresAt })),
      finalizations: [...this.finalizations.values()].map((item) => structuredClone(item)),
    };
    try {
      this.stateHost.writeSnapshot(snapshot);
    } catch {
      // 短期状态持久化是恢复增强，不能阻断当前回合按钮发送或消费。
    }
  }
}

function normalizeFinalizationSnapshot(value: unknown): FinalizedChoiceSession | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const nonce = normalizeOpaqueId(raw.nonce);
  const sessionId = normalizeChoiceText(raw.sessionId, 160);
  const channelType = normalizeChoiceText(raw.channelType, 32);
  const chatId = normalizeChoiceText(raw.chatId, 160);
  const prompt = normalizeChoiceText(raw.prompt, 800);
  const finalizedAt = typeof raw.finalizedAt === 'number' && Number.isFinite(raw.finalizedAt) ? raw.finalizedAt : 0;
  const tally = Array.isArray(raw.tally) ? raw.tally.slice(0, MAX_CHOICE_OPTIONS).map((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    const label = normalizeChoiceText(record?.label, 48);
    const description = normalizeChoiceText(record?.description, 160);
    const count = typeof record?.count === 'number' && Number.isInteger(record.count) && record.count >= 0 ? record.count : -1;
    return label && count >= 0 ? { label, ...(description ? { description } : {}), count } : null;
  }).filter((item): item is ChoiceTallyOption => Boolean(item)) : [];
  if (!nonce || !sessionId || !channelType || !chatId || !finalizedAt || tally.length < 2) return null;
  const winners = new Set(Array.isArray(raw.winningOptions)
    ? raw.winningOptions.map((item) => normalizeChoiceText((item as Record<string, unknown>)?.label, 48)).filter(Boolean)
    : []);
  const participantCount = typeof raw.participantCount === 'number' && Number.isInteger(raw.participantCount) && raw.participantCount >= 0
    ? raw.participantCount : 0;
  const eligibleParticipantCount = typeof raw.eligibleParticipantCount === 'number'
    && Number.isInteger(raw.eligibleParticipantCount)
    && raw.eligibleParticipantCount > 0
    ? raw.eligibleParticipantCount
    : undefined;
  const finalizationReason = raw.finalizationReason === 'all_participants_selected'
    ? 'all_participants_selected' as const
    : 'deadline' as const;
  const cardHeroRecord = raw.cardHero && typeof raw.cardHero === 'object' ? raw.cardHero as Record<string, unknown> : null;
  const imageKey = normalizeChoiceText(cardHeroRecord?.imageKey, 256);
  return {
    nonce,
    sessionId,
    channelType,
    chatId,
    userId: normalizeChoiceText(raw.userId, 160) || undefined,
    choiceMode: 'vote',
    prompt,
    title: normalizeChoiceText(raw.title, 48) || undefined,
    participantCount,
    eligibleParticipantCount,
    tally,
    winningOptions: tally.filter((item) => winners.has(item.label)),
    finalizationReason,
    finalizedAt,
    cardMessageId: normalizeChoiceText(raw.cardMessageId, 180) || undefined,
    ...(imageKey ? { cardHero: { imageKey, alt: normalizeChoiceText(cardHeroRecord?.alt, 120) || '卡片头图' } } : {}),
  };
}

function normalizeOpaqueId(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_-]{8,64}$/iu.test(value.trim()) ? value.trim() : '';
}

function normalizeSnapshotEntry(raw: ChoicePromptStateEntrySnapshot): PendingChoiceEntry & { nonce: string } | null {
  const nonce = normalizeOpaqueId(raw?.nonce);
  const flowId = normalizeOpaqueId(raw?.flowId);
  const choicePrompt = parseChoicePrompt(raw?.options, raw?.title);
  if (!nonce || !choicePrompt || !Number.isFinite(raw?.expiresAt)) return null;
  if (typeof raw.channelType !== 'string' || typeof raw.chatId !== 'string' || typeof raw.sessionId !== 'string') return null;
  const parsedSession = parseChoiceSessionDirective(raw.choiceSession) || {
    mode: 'single_user', audience: 'initiator', state: 'active',
  } as const;
  const continuationGroupMode = raw.continuationGroupMode
    && ['vote', 'claim', 'parallel'].includes(raw.continuationGroupMode)
    ? raw.continuationGroupMode
    : undefined;
  const continuationParticipantKey = normalizeOpaqueId(raw.continuationParticipantKey);
  const openedAt = Number.isFinite(raw.openedAt) ? raw.openedAt as number : Math.max(0, raw.expiresAt - 15 * 60_000);
  const closesAt = Number.isFinite(raw.closesAt) ? raw.closesAt as number : undefined;
  const selections = Array.isArray(raw.selections)
    ? raw.selections.slice(0, 512).map((item) => {
      const participantKey = normalizeParticipantKey(item?.participantKey);
      const optionIndex = Number.isInteger(item?.optionIndex) ? item.optionIndex : -1;
      const selectedAt = Number.isFinite(item?.selectedAt) ? item.selectedAt : openedAt;
      return participantKey && optionIndex >= 0 && optionIndex < choicePrompt.options.length
        ? { participantKey, optionIndex, selectedAt }
        : null;
    }).filter((item): item is ChoiceParticipantSelection => Boolean(item))
    : [];
  const eligibleParticipantKeys = Array.isArray(raw.eligibleParticipantKeys)
    ? Array.from(new Set(raw.eligibleParticipantKeys
      .slice(0, MAX_TRACKED_CHOICE_PARTICIPANTS)
      .map(normalizeParticipantKey)
      .filter(Boolean)))
    : [];
  const cardMessageId = normalizeChoiceText(raw.cardMessageId, 180);
  const cardHero = raw.cardHero && typeof raw.cardHero === 'object'
    ? {
      imageKey: normalizeChoiceText(raw.cardHero.imageKey, 256),
      alt: normalizeChoiceText(raw.cardHero.alt, 120) || '卡片头图',
    }
    : undefined;
  return {
    nonce,
    channelType: normalizeChoiceText(raw.channelType, 32),
    chatId: normalizeChoiceText(raw.chatId, 160),
    userId: normalizeChoiceText(raw.userId, 160) || undefined,
    sessionId: normalizeChoiceText(raw.sessionId, 160),
    prompt: normalizeChoiceText(raw.prompt, 800),
    title: choicePrompt.title,
    options: choicePrompt.options,
    ...(raw.flowMode === 'continuous' && flowId ? { flowMode: 'continuous' as const, flowId } : {}),
    ...(raw.flowMode === 'continuous' && flowId && continuationGroupMode ? { continuationGroupMode } : {}),
    ...(raw.flowMode === 'continuous' && flowId && continuationGroupMode === 'parallel' && continuationParticipantKey
      ? { continuationParticipantKey }
      : {}),
    choiceSession: parsedSession,
    openedAt,
    ...(closesAt ? { closesAt } : {}),
    expiresAt: raw.expiresAt,
    selections,
    ...(eligibleParticipantKeys.length > 0 ? { eligibleParticipantKeys } : {}),
    ...(cardMessageId ? { cardMessageId } : {}),
    ...(cardHero?.imageKey ? { cardHero } : {}),
  };
}
