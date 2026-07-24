import type {
  OutboundMention,
  RunSummary,
  ToolCallInfo,
} from '../../../types.js';
import {
  buildFinalCardJson,
  buildStreamingTypewriterContent,
  extractStreamingFinalResponse,
  formatElapsed,
  getStreamingCurrentStep,
} from '../../../markdown/feishu.js';
import {
  FeishuStreamingCardRegistry,
  type FeishuStreamingCardState,
} from './streaming-card-registry.js';

export type FeishuStreamingCardStatus = 'completed' | 'interrupted' | 'error';

type TimerHandle = ReturnType<typeof setTimeout>;

export interface FeishuStreamingCardLifecycleOptions {
  registry: FeishuStreamingCardRegistry;
  pushStreamingContent: (
    state: FeishuStreamingCardState,
    content: string,
    sequence: number,
  ) => Promise<void>;
  now?: () => number;
  setTimer?: (run: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  throttleMs?: number;
  typewriterIntervalMs?: number;
  typewriterStepChars?: number;
  getCurrentStep?: (text: string, tools: ToolCallInfo[]) => string;
  renderStreamingContent?: (text: string, tools: ToolCallInfo[], visibleChars: number) => string;
  extractFinalResponse?: (text: string) => string;
  renderFinalCard?: (
    responseText: string,
    tools: ToolCallInfo[],
    footer: { status: string; elapsed: string },
    summary?: RunSummary,
    mentions?: OutboundMention[],
  ) => string;
  formatElapsed?: (elapsedMs: number) => string;
  onStreamingUpdate?: (state: FeishuStreamingCardState, sequence: number) => void;
  onStreamingError?: (error: unknown) => void;
}

export interface FeishuStreamingCardFinalizationHooks {
  closeStreaming: (state: FeishuStreamingCardState, sequence: number) => Promise<void>;
  resolveFinalResponse: (
    state: FeishuStreamingCardState,
    visibleText: string,
    originalText: string,
  ) => Promise<string>;
  updateFinalCard: (
    state: FeishuStreamingCardState,
    cardJson: string,
    sequence: number,
  ) => Promise<void>;
  persistContinuation?: (
    state: FeishuStreamingCardState,
    status: FeishuStreamingCardStatus,
    finalText: string,
  ) => void;
  onFinalized?: (
    state: FeishuStreamingCardState,
    status: FeishuStreamingCardStatus,
    finalText: string,
    elapsedMs: number,
  ) => void;
  onError?: (error: unknown) => void;
}

export interface FinalizeFeishuStreamingCardInput {
  chatId: string;
  status: FeishuStreamingCardStatus;
  responseText: string;
  summary?: RunSummary;
  mentions?: OutboundMention[];
  hooks: FeishuStreamingCardFinalizationHooks;
}

const STATUS_LABELS: Record<FeishuStreamingCardStatus, string> = {
  completed: '已完成',
  interrupted: '已中断',
  error: '未完成',
};

/**
 * 管理流式卡片的节流、打字机推进、sequence 与最终清理。
 * 真实 CardKit/IM 调用和表情包、reaction 等平台动作通过回调注入。
 */
export class FeishuStreamingCardLifecycle {
  private readonly registry: FeishuStreamingCardRegistry;
  private readonly pushStreamingContent: FeishuStreamingCardLifecycleOptions['pushStreamingContent'];
  private readonly now: () => number;
  private readonly setTimer: NonNullable<FeishuStreamingCardLifecycleOptions['setTimer']>;
  private readonly clearTimer: NonNullable<FeishuStreamingCardLifecycleOptions['clearTimer']>;
  private readonly throttleMs: number;
  private readonly typewriterIntervalMs: number;
  private readonly typewriterStepChars: number;
  private readonly getCurrentStep: NonNullable<FeishuStreamingCardLifecycleOptions['getCurrentStep']>;
  private readonly renderStreamingContent: NonNullable<FeishuStreamingCardLifecycleOptions['renderStreamingContent']>;
  private readonly extractFinalResponse: NonNullable<FeishuStreamingCardLifecycleOptions['extractFinalResponse']>;
  private readonly renderFinalCard: NonNullable<FeishuStreamingCardLifecycleOptions['renderFinalCard']>;
  private readonly formatElapsed: NonNullable<FeishuStreamingCardLifecycleOptions['formatElapsed']>;
  private readonly onStreamingUpdate?: FeishuStreamingCardLifecycleOptions['onStreamingUpdate'];
  private readonly onStreamingError?: FeishuStreamingCardLifecycleOptions['onStreamingError'];

  constructor(options: FeishuStreamingCardLifecycleOptions) {
    this.registry = options.registry;
    this.pushStreamingContent = options.pushStreamingContent;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.throttleMs = options.throttleMs ?? 200;
    this.typewriterIntervalMs = options.typewriterIntervalMs ?? 70;
    this.typewriterStepChars = options.typewriterStepChars ?? 2;
    this.getCurrentStep = options.getCurrentStep ?? getStreamingCurrentStep;
    this.renderStreamingContent = options.renderStreamingContent ?? buildStreamingTypewriterContent;
    this.extractFinalResponse = options.extractFinalResponse ?? extractStreamingFinalResponse;
    this.renderFinalCard = options.renderFinalCard ?? buildFinalCardJson;
    this.formatElapsed = options.formatElapsed ?? formatElapsed;
    this.onStreamingUpdate = options.onStreamingUpdate;
    this.onStreamingError = options.onStreamingError;
  }

  updateText(chatId: string, text: string): void {
    const state = this.registry.get(chatId);
    if (!state) return;

    if (state.thinking && text.trim()) state.thinking = false;
    state.pendingText = text;

    const elapsed = this.now() - state.lastUpdateAt;
    if (state.lastUpdateAt > 0 && elapsed < this.throttleMs) {
      if (!state.throttleTimer) {
        state.throttleTimer = this.setTimer(() => {
          const latest = this.registry.get(chatId);
          if (!latest || latest !== state) return;
          latest.throttleTimer = null;
          this.flush(chatId);
        }, this.throttleMs - elapsed);
      }
      return;
    }

    if (state.throttleTimer) {
      this.clearTimer(state.throttleTimer);
      state.throttleTimer = null;
    }
    this.flush(chatId);
  }

  updateTools(chatId: string, tools: ToolCallInfo[]): void {
    const state = this.registry.get(chatId);
    if (!state) return;
    const observedAt = this.now();
    const previousById = new Map(state.toolCalls.map((tool) => [tool.id, tool]));
    // 时间字段由 Bridge 生命周期生成，不能信任模型文本，也不要求上游 Provider
    // 提供平台时间；这样流式卡片和最终卡片始终复用同一份真实工具轨迹。
    state.toolCalls = tools.map((tool) => {
      const previous = previousById.get(tool.id);
      const startedAt = previous?.startedAt ?? tool.startedAt ?? observedAt;
      const completedAt = tool.status === 'running'
        ? undefined
        : previous?.status === 'running'
          ? observedAt
          : previous?.completedAt ?? tool.completedAt ?? observedAt;
      return {
        ...tool,
        startedAt,
        completedAt,
      };
    });
    this.updateText(chatId, state.pendingText ?? '');
  }

  async finalize(input: FinalizeFeishuStreamingCardInput): Promise<boolean> {
    const pending = this.registry.getCreation(input.chatId);
    if (pending) {
      try {
        await pending;
      } catch {
        // 创建失败时仍继续检查 registry；若没有 active state 会自然返回 false。
      }
    }

    const state = this.registry.get(input.chatId);
    if (!state) return false;
    this.registry.clearTimers(input.chatId);

    try {
      state.sequence += 1;
      await input.hooks.closeStreaming(state, state.sequence);

      const visibleText = this.extractFinalResponse(input.responseText);
      const finalText = await input.hooks.resolveFinalResponse(state, visibleText, input.responseText);
      const elapsedMs = this.now() - state.startTime;
      const finalCardJson = this.renderFinalCard(
        finalText,
        state.toolCalls,
        {
          status: STATUS_LABELS[input.status],
          elapsed: this.formatElapsed(elapsedMs),
        },
        input.summary,
        input.mentions ?? [],
      );

      state.sequence += 1;
      await input.hooks.updateFinalCard(state, finalCardJson, state.sequence);
      input.hooks.persistContinuation?.(state, input.status, finalText);
      input.hooks.onFinalized?.(state, input.status, finalText, elapsedMs);
      return true;
    } catch (error) {
      input.hooks.onError?.(error);
      return false;
    } finally {
      this.registry.remove(input.chatId);
    }
  }

  private flush(chatId: string): void {
    const state = this.registry.get(chatId);
    if (!state) return;

    const sourceText = state.pendingText ?? '';
    const currentStep = this.getCurrentStep(sourceText, state.toolCalls);
    const toolKey = state.toolCalls.map((tool) => `${tool.id}:${tool.name}:${tool.status}`).join('|');
    const typewriterKey = `${currentStep}\u0000${toolKey}`;
    if (state.typewriterKey === typewriterKey && state.typewriterTimer) return;

    if (state.typewriterTimer) {
      this.clearTimer(state.typewriterTimer);
      state.typewriterTimer = null;
    }
    state.typewriterKey = typewriterKey;

    const totalChars = [...currentStep].length;
    const runTypewriter = (visibleChars: number) => {
      const latest = this.registry.get(chatId);
      if (!latest || latest.typewriterKey !== typewriterKey) return;
      const content = this.renderStreamingContent(sourceText, latest.toolCalls, visibleChars);
      this.push(chatId, latest, content);
      if (visibleChars < totalChars) {
        latest.typewriterTimer = this.setTimer(
          () => runTypewriter(Math.min(totalChars, visibleChars + this.typewriterStepChars)),
          this.typewriterIntervalMs,
        );
      } else {
        latest.typewriterTimer = null;
      }
    };

    runTypewriter(0);
  }

  private push(chatId: string, state: FeishuStreamingCardState, content: string): void {
    state.sequence += 1;
    const sequence = state.sequence;
    void this.pushStreamingContent(state, content, sequence).then(() => {
      if (this.registry.get(chatId) !== state) return;
      state.lastUpdateAt = this.now();
      this.onStreamingUpdate?.(state, sequence);
    }).catch((error: unknown) => {
      this.onStreamingError?.(error);
    });
  }
}
