import type { ToolCallInfo } from '../../../types.js';

export interface FeishuStreamingCardState {
  cardId: string;
  messageId: string;
  sourceMessageId?: string;
  sequence: number;
  startTime: number;
  toolCalls: ToolCallInfo[];
  thinking: boolean;
  pendingText: string | null;
  lastUpdateAt: number;
  throttleTimer: ReturnType<typeof setTimeout> | null;
  typewriterTimer: ReturnType<typeof setTimeout> | null;
  typewriterKey: string;
}

export interface ActivateFeishuStreamingCardInput {
  cardId: string;
  messageId: string;
  sourceMessageId?: string;
  startTime?: number;
}

type ClearTimer = (timer: ReturnType<typeof setTimeout>) => void;

/**
 * 统一管理每个 chat 的流式卡片状态、创建中 promise 与计时器生命周期。
 * 平台调用、内容构造和发送策略仍由 adapter 负责。
 */
export class FeishuStreamingCardRegistry {
  private readonly active = new Map<string, FeishuStreamingCardState>();
  private readonly creating = new Map<string, Promise<boolean>>();

  constructor(private readonly clearTimer: ClearTimer = clearTimeout) {}

  has(chatId: string): boolean {
    return this.active.has(chatId);
  }

  get(chatId: string): FeishuStreamingCardState | undefined {
    return this.active.get(chatId);
  }

  getCreation(chatId: string): Promise<boolean> | undefined {
    return this.creating.get(chatId);
  }

  trackCreation(chatId: string, create: () => Promise<boolean>): Promise<boolean> {
    if (this.active.has(chatId)) return Promise.resolve(false);
    const existing = this.creating.get(chatId);
    if (existing) return existing;

    const promise = create();
    this.creating.set(chatId, promise);
    void promise.finally(() => {
      if (this.creating.get(chatId) === promise) this.creating.delete(chatId);
    }).catch(() => {
      // 原 promise 的失败由调用方处理；这里只吸收 finally 派生 promise 的拒绝。
    });
    return promise;
  }

  activate(chatId: string, input: ActivateFeishuStreamingCardInput): FeishuStreamingCardState {
    const state: FeishuStreamingCardState = {
      cardId: input.cardId,
      messageId: input.messageId,
      sourceMessageId: input.sourceMessageId,
      sequence: 0,
      startTime: input.startTime ?? Date.now(),
      toolCalls: [],
      thinking: true,
      pendingText: null,
      lastUpdateAt: 0,
      throttleTimer: null,
      typewriterTimer: null,
      typewriterKey: '',
    };
    this.active.set(chatId, state);
    return state;
  }

  clearTimers(chatId: string): FeishuStreamingCardState | undefined {
    const state = this.active.get(chatId);
    if (!state) return undefined;
    if (state.throttleTimer) {
      this.clearTimer(state.throttleTimer);
      state.throttleTimer = null;
    }
    if (state.typewriterTimer) {
      this.clearTimer(state.typewriterTimer);
      state.typewriterTimer = null;
    }
    return state;
  }

  remove(chatId: string): FeishuStreamingCardState | undefined {
    this.creating.delete(chatId);
    const state = this.clearTimers(chatId);
    this.active.delete(chatId);
    return state;
  }

  clear(): void {
    for (const chatId of this.active.keys()) this.clearTimers(chatId);
    this.active.clear();
    this.creating.clear();
  }
}
