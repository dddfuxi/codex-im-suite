import fs from 'node:fs';
import path from 'node:path';

import type {
  ChoicePromptFinalizationSnapshot,
  ChoicePromptStateEntrySnapshot,
  ChoicePromptStateHost,
  ChoicePromptStateSnapshot,
} from 'claude-to-im/host';

import { cleanupStaleAtomicWriteTemps, writeUtf8TextAtomic } from './atomic-text-file.js';

const MAX_ENTRIES = 256;
const MAX_OPTIONS = 8;
const MAX_FUTURE_TTL_MS = 24 * 60 * 60_000;

function boundedString(value: unknown, maxChars: number, required = false): string | undefined {
  if (typeof value !== 'string') return required ? undefined : undefined;
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > maxChars) return required ? undefined : undefined;
  return normalized;
}

function opaqueId(value: unknown): string | undefined {
  const normalized = boundedString(value, 64, true);
  return normalized && /^[a-z0-9_-]{8,64}$/iu.test(normalized) ? normalized : undefined;
}

function validExpiry(value: unknown, now: number): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > now
    && value <= now + MAX_FUTURE_TTL_MS;
}

function normalizeEntry(value: unknown, now: number): ChoicePromptStateEntrySnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const nonce = opaqueId(raw.nonce);
  const channelType = boundedString(raw.channelType, 32, true);
  const chatId = boundedString(raw.chatId, 160, true);
  const sessionId = boundedString(raw.sessionId, 160, true);
  if (!nonce || !channelType || !chatId || !sessionId || !validExpiry(raw.expiresAt, now)) return null;
  if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > MAX_OPTIONS) return null;
  const options = raw.options.map((item) => {
    if (!item || typeof item !== 'object') return null;
    const option = item as Record<string, unknown>;
    const label = boundedString(option.label, 48, true);
    if (!label) return null;
    const description = boundedString(option.description, 160);
    return { label, ...(description ? { description } : {}) };
  });
  if (options.some((item) => !item)) return null;
  const userId = boundedString(raw.userId, 160);
  const prompt = boundedString(raw.prompt, 800) || '';
  const title = boundedString(raw.title, 48);
  const flowId = opaqueId(raw.flowId);
  const flowMode = raw.flowMode === 'continuous' && flowId ? 'continuous' as const : undefined;
  const continuationGroupMode = ['vote', 'claim', 'parallel'].includes(String(raw.continuationGroupMode))
    ? raw.continuationGroupMode as 'vote' | 'claim' | 'parallel'
    : undefined;
  const continuationParticipantKey = opaqueId(raw.continuationParticipantKey);
  const rawSession = raw.choiceSession && typeof raw.choiceSession === 'object'
    ? raw.choiceSession as Record<string, unknown>
    : null;
  const mode = rawSession && ['single_user', 'vote', 'claim', 'parallel'].includes(String(rawSession.mode))
    ? rawSession.mode as 'single_user' | 'vote' | 'claim' | 'parallel'
    : 'single_user';
  const audience = mode === 'single_user' ? 'initiator' as const : 'chat_members' as const;
  const durationSeconds = Number.isInteger(rawSession?.durationSeconds)
    && Number(rawSession?.durationSeconds) >= 10
    && Number(rawSession?.durationSeconds) <= 3_600
    ? Number(rawSession?.durationSeconds)
    : undefined;
  if (mode === 'vote' && durationSeconds === undefined) return null;
  const openedAt = typeof raw.openedAt === 'number' && Number.isFinite(raw.openedAt) ? raw.openedAt : now;
  const closesAt = typeof raw.closesAt === 'number' && Number.isFinite(raw.closesAt) ? raw.closesAt : undefined;
  if (mode === 'vote' && (!closesAt || closesAt <= openedAt || closesAt > raw.expiresAt)) return null;
  const selections = Array.isArray(raw.selections) ? raw.selections.slice(0, 512).map((item) => {
    if (!item || typeof item !== 'object') return null;
    const selection = item as Record<string, unknown>;
    const participantKey = boundedString(selection.participantKey, 180, true);
    const optionIndex = Number.isInteger(selection.optionIndex) ? Number(selection.optionIndex) : -1;
    const selectedAt = typeof selection.selectedAt === 'number' && Number.isFinite(selection.selectedAt)
      ? selection.selectedAt
      : openedAt;
    return participantKey && optionIndex >= 0 && optionIndex < options.length
      ? { participantKey, optionIndex, selectedAt }
      : null;
  }) : [];
  if (selections.some((item) => !item)) return null;
  const eligibleParticipantKeys = Array.isArray(raw.eligibleParticipantKeys)
    ? Array.from(new Set(raw.eligibleParticipantKeys.slice(0, 512)
      .map((item) => boundedString(item, 180, true))
      .filter((item): item is string => Boolean(item))))
    : [];
  const cardMessageId = boundedString(raw.cardMessageId, 180);
  const rawHero = raw.cardHero && typeof raw.cardHero === 'object' ? raw.cardHero as Record<string, unknown> : null;
  const heroImageKey = boundedString(rawHero?.imageKey, 256);
  const heroAlt = boundedString(rawHero?.alt, 120);
  return {
    nonce,
    channelType,
    chatId,
    sessionId,
    ...(userId ? { userId } : {}),
    prompt,
    ...(title ? { title } : {}),
    options: options as ChoicePromptStateEntrySnapshot['options'],
    ...(flowMode && flowId ? { flowMode, flowId } : {}),
    ...(flowMode && continuationGroupMode ? { continuationGroupMode } : {}),
    ...(flowMode && continuationGroupMode === 'parallel' && continuationParticipantKey
      ? { continuationParticipantKey }
      : {}),
    choiceSession: {
      mode,
      audience,
      state: 'active',
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(mode === 'vote' ? { allowChange: rawSession?.allowChange !== false } : {}),
    },
    openedAt,
    ...(closesAt ? { closesAt } : {}),
    selections: selections as NonNullable<ChoicePromptStateEntrySnapshot['selections']>,
    ...(eligibleParticipantKeys.length > 0 ? { eligibleParticipantKeys } : {}),
    ...(cardMessageId ? { cardMessageId } : {}),
    ...(heroImageKey ? { cardHero: { imageKey: heroImageKey, alt: heroAlt || '卡片头图' } } : {}),
    expiresAt: raw.expiresAt,
  };
}

function normalizeFinalization(value: unknown): ChoicePromptFinalizationSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const nonce = opaqueId(raw.nonce);
  const sessionId = boundedString(raw.sessionId, 160, true);
  const channelType = boundedString(raw.channelType, 32, true);
  const chatId = boundedString(raw.chatId, 160, true);
  const prompt = boundedString(raw.prompt, 800) || '';
  const finalizedAt = typeof raw.finalizedAt === 'number' && Number.isFinite(raw.finalizedAt) ? raw.finalizedAt : 0;
  const normalizeTally = (items: unknown): ChoicePromptFinalizationSnapshot['tally'] | null => {
    if (!Array.isArray(items) || items.length < 2 || items.length > MAX_OPTIONS) return null;
    const normalized = items.map((item) => {
      if (!item || typeof item !== 'object') return null;
      const entry = item as Record<string, unknown>;
      const label = boundedString(entry.label, 48, true);
      const description = boundedString(entry.description, 160);
      const count = Number.isInteger(entry.count) && Number(entry.count) >= 0 ? Number(entry.count) : -1;
      return label && count >= 0 ? { label, ...(description ? { description } : {}), count } : null;
    });
    return normalized.some((item) => !item) ? null : normalized as ChoicePromptFinalizationSnapshot['tally'];
  };
  const tally = normalizeTally(raw.tally);
  const winningOptions = Array.isArray(raw.winningOptions)
    ? raw.winningOptions.map((winner) => {
      if (!winner || typeof winner !== 'object') return null;
      const label = boundedString((winner as Record<string, unknown>).label, 48, true);
      return label ? tally?.find((item) => item.label === label) || null : null;
    }).filter((item): item is ChoicePromptFinalizationSnapshot['winningOptions'][number] => Boolean(item))
    : [];
  if (!nonce || !sessionId || !channelType || !chatId || !finalizedAt || !tally) return null;
  const participantCount = Number.isInteger(raw.participantCount) && Number(raw.participantCount) >= 0
    ? Number(raw.participantCount) : 0;
  const eligibleParticipantCount = Number.isInteger(raw.eligibleParticipantCount)
    && Number(raw.eligibleParticipantCount) > 0
    ? Number(raw.eligibleParticipantCount)
    : undefined;
  const finalizationReason = raw.finalizationReason === 'all_participants_selected'
    ? 'all_participants_selected' as const
    : 'deadline' as const;
  const rawHero = raw.cardHero && typeof raw.cardHero === 'object' ? raw.cardHero as Record<string, unknown> : null;
  const imageKey = boundedString(rawHero?.imageKey, 256);
  return {
    nonce,
    sessionId,
    channelType,
    chatId,
    userId: boundedString(raw.userId, 160),
    choiceMode: 'vote',
    prompt,
    title: boundedString(raw.title, 48),
    participantCount,
    eligibleParticipantCount,
    tally,
    winningOptions,
    finalizationReason,
    finalizedAt,
    cardMessageId: boundedString(raw.cardMessageId, 180),
    ...(imageKey ? { cardHero: { imageKey, alt: boundedString(rawHero?.alt, 120) || '卡片头图' } } : {}),
  };
}

export class RuntimeChoicePromptStateHost implements ChoicePromptStateHost {
  readonly statePath: string;

  constructor(runtimeRoot: string) {
    this.statePath = path.join(path.resolve(runtimeRoot), 'choice-prompts.json');
  }

  readSnapshot(): ChoicePromptStateSnapshot | null {
    cleanupStaleAtomicWriteTemps(this.statePath);
    if (!fs.existsSync(this.statePath)) return null;
    const stat = fs.lstatSync(this.statePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as Record<string, unknown>;
      if (parsed.protocol !== 'cti-choice-prompts/v1' && parsed.protocol !== 'cti-choice-prompts/v2') return null;
      if (!Array.isArray(parsed.entries) || !Array.isArray(parsed.consumed)) return null;
      if (parsed.entries.length > MAX_ENTRIES || parsed.consumed.length > MAX_ENTRIES) return null;
      const now = Date.now();
      const currentEntries = parsed.entries.filter((item) => {
        if (!item || typeof item !== 'object') return true;
        const expiresAt = (item as Record<string, unknown>).expiresAt;
        return typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt > now;
      });
      const entries = currentEntries.map((item) => normalizeEntry(item, now));
      if (entries.some((item) => !item)) return null;
      const currentConsumed = parsed.consumed.filter((item) => {
        if (!item || typeof item !== 'object') return true;
        const expiresAt = (item as Record<string, unknown>).expiresAt;
        return typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt > now;
      });
      const consumed = currentConsumed.map((item) => {
        if (!item || typeof item !== 'object') return null;
        const raw = item as Record<string, unknown>;
        const nonce = opaqueId(raw.nonce);
        return nonce && validExpiry(raw.expiresAt, now) ? { nonce, expiresAt: raw.expiresAt } : null;
      });
      if (consumed.some((item) => !item)) return null;
      const finalizations = Array.isArray(parsed.finalizations)
        ? parsed.finalizations.slice(0, MAX_ENTRIES).map(normalizeFinalization)
        : [];
      if (finalizations.some((item) => !item)) return null;
      return {
        protocol: parsed.protocol,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(now).toISOString(),
        entries: entries as ChoicePromptStateEntrySnapshot[],
        consumed: consumed as ChoicePromptStateSnapshot['consumed'],
        finalizations: finalizations as ChoicePromptFinalizationSnapshot[],
      };
    } catch {
      return null;
    }
  }

  writeSnapshot(snapshot: ChoicePromptStateSnapshot): void {
    const now = Date.now();
    const entries = snapshot.entries
      .slice(0, MAX_ENTRIES)
      .map((item) => normalizeEntry(item, now))
      .filter((item): item is ChoicePromptStateEntrySnapshot => Boolean(item));
    const consumed = snapshot.consumed
      .slice(0, MAX_ENTRIES)
      .filter((item) => Boolean(opaqueId(item.nonce)) && validExpiry(item.expiresAt, now));
    const finalizations = (snapshot.finalizations || [])
      .slice(0, MAX_ENTRIES)
      .map(normalizeFinalization)
      .filter((item): item is ChoicePromptFinalizationSnapshot => Boolean(item));
    writeUtf8TextAtomic(this.statePath, `${JSON.stringify({
      protocol: 'cti-choice-prompts/v2',
      updatedAt: new Date(now).toISOString(),
      entries,
      consumed,
      finalizations,
    }, null, 2)}\n`);
  }
}
