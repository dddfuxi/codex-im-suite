import crypto from 'node:crypto';

export const CHOICE_CALLBACK_PREFIX = 'choice:select:';
export const MAX_CHOICE_OPTIONS = 8;

export interface ChoicePromptOption {
  label: string;
  description?: string;
}

export interface ChoicePrompt {
  title?: string;
  options: ChoicePromptOption[];
}

export interface RegisteredChoiceOption extends ChoicePromptOption {
  callbackData: string;
}

export interface RegisteredChoicePrompt {
  nonce: string;
  title?: string;
  prompt: string;
  options: RegisteredChoiceOption[];
}

interface PendingChoiceEntry {
  channelType: string;
  chatId: string;
  userId?: string;
  sessionId: string;
  prompt: string;
  title?: string;
  options: ChoicePromptOption[];
  expiresAt: number;
}

export type ChoiceSelectionResult =
  | { kind: 'resolved'; sessionId: string; prompt: string; title?: string; option: ChoicePromptOption }
  | { kind: 'expired' }
  | { kind: 'forbidden' }
  | { kind: 'invalid' };

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

/**
 * 模型只负责给出可见选项，不允许提供 callback、平台 ID 或任意动作参数。
 * 至少两个有效且不重复的选项才构成真正的选择请求。
 */
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

export function parseChoiceSelectionCallback(callbackData: string): { nonce: string; optionIndex: number } | null {
  const match = /^choice:select:([a-z0-9_-]{8,64}):(\d{1,2})$/iu.exec(callbackData.trim());
  if (!match) return null;
  return { nonce: match[1], optionIndex: Number.parseInt(match[2], 10) };
}

export function buildChoiceSelectionText(option: ChoicePromptOption): string {
  return option.description
    ? `我选择：${option.label}\n选项说明：${option.description}`
    : `我选择：${option.label}`;
}

/**
 * 通用选择回调只在内存中短期存在，并绑定原聊天与原点击人。
 * 点击值由 Bridge 签发，避免把模型生成的 callback_data 当作可信动作。
 */
export class ChoicePromptRegistry {
  private readonly entries = new Map<string, PendingChoiceEntry>();

  constructor(private readonly options: {
    ttlMs?: number;
    now?: () => number;
    nonceFactory?: () => string;
  } = {}) {}

  register(input: {
    channelType: string;
    chatId: string;
    userId?: string;
    sessionId: string;
    prompt: string;
    choicePrompt: ChoicePrompt;
  }): RegisteredChoicePrompt {
    const now = this.now();
    this.pruneExpired(now);
    const nonce = (this.options.nonceFactory?.() || crypto.randomBytes(12).toString('hex'))
      .replace(/[^a-z0-9_-]/giu, '')
      .slice(0, 64);
    if (nonce.length < 8) throw new Error('choice nonce is too short');
    const expiresAt = now + Math.max(30_000, this.options.ttlMs ?? 15 * 60_000);
    this.entries.set(nonce, {
      channelType: input.channelType,
      chatId: input.chatId,
      userId: input.userId?.trim() || undefined,
      sessionId: input.sessionId,
      prompt: normalizeChoiceText(input.prompt, 800),
      title: input.choicePrompt.title,
      options: input.choicePrompt.options.map((option) => ({ ...option })),
      expiresAt,
    });
    return {
      nonce,
      title: input.choicePrompt.title,
      prompt: normalizeChoiceText(input.prompt, 800),
      options: input.choicePrompt.options.map((option, index) => ({
        ...option,
        callbackData: `${CHOICE_CALLBACK_PREFIX}${nonce}:${index}`,
      })),
    };
  }

  consume(callbackData: string, actor: { channelType: string; chatId: string; userId?: string }): ChoiceSelectionResult {
    const parsed = parseChoiceSelectionCallback(callbackData);
    if (!parsed) return { kind: 'invalid' };
    const entry = this.entries.get(parsed.nonce);
    if (!entry) return { kind: 'expired' };
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(parsed.nonce);
      return { kind: 'expired' };
    }
    if (entry.channelType !== actor.channelType || entry.chatId !== actor.chatId) return { kind: 'forbidden' };
    if (entry.userId && entry.userId !== actor.userId?.trim()) return { kind: 'forbidden' };
    const option = entry.options[parsed.optionIndex];
    if (!option) return { kind: 'invalid' };
    this.entries.delete(parsed.nonce);
    return {
      kind: 'resolved',
      sessionId: entry.sessionId,
      prompt: entry.prompt,
      title: entry.title,
      option: { ...option },
    };
  }

  clear(): void {
    this.entries.clear();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private pruneExpired(now: number): void {
    for (const [nonce, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(nonce);
    }
  }
}
