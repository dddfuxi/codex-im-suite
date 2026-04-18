/**
 * Feishu (Lark) Adapter — implements BaseChannelAdapter for Feishu Bot API.
 *
 * Uses the official @larksuiteoapi/node-sdk WSClient for real-time event
 * subscription and REST Client for message sending / resource downloading.
 * Routes messages through an internal async queue (same pattern as Telegram).
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 * - Permission prompts → interactive card with action buttons
 *
 * card.action.trigger events are handled via EventDispatcher (Openclaw pattern):
 * button clicks are converted to synthetic text messages and routed through
 * the normal /perm command processing pipeline.
 */

import crypto from 'crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import type {
  ChannelType,
  InboundMessage,
  OutboundMention,
  OutboundMessage,
  SendResult,
} from '../types.js';
import type { FileAttachment } from '../types.js';
import type { ToolCallInfo } from '../types.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter.js';
import { getBridgeContext } from '../context.js';
import { updateFeishuP2pPollAudit, updateFeishuWsAudit } from '../runtime-audit.js';
import {
  htmlToFeishuMarkdown,
  preprocessFeishuMarkdown,
  hasComplexMarkdown,
  buildCardContent,
  buildPostContent,
  buildStreamingContent,
  buildFinalCardJson,
  buildPermissionButtonCard,
  formatElapsed,
} from '../markdown/feishu.js';

/** Max number of message_ids to keep for dedup. */
const DEDUP_MAX = 1000;

/** Max file download size (20 MB). */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Feishu emoji type for typing indicator (same as Openclaw). */
const TYPING_EMOJI = 'Typing';

/** State for an active CardKit v2 streaming card. */
interface FeishuCardState {
  cardId: string;
  messageId: string;
  sequence: number;
  startTime: number;
  toolCalls: ToolCallInfo[];
  thinking: boolean;
  pendingText: string | null;
  lastUpdateAt: number;
  throttleTimer: ReturnType<typeof setTimeout> | null;
}

/** Streaming card throttle interval (ms). */
const CARD_THROTTLE_MS = 200;
const P2P_POLL_INTERVAL_MS = 15000;
const FEISHU_CHAT_INDEX_PATH = path.join(
  process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im'),
  'data',
  'feishu-chat-index.json',
);

/** Shape of the SDK's im.message.receive_v1 event data. */
type FeishuMessageEventData = {
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    create_time: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; union_id?: string; user_id?: string };
      name: string;
    }>;
  };
};


/** MIME type guesses by message_type. */
const MIME_BY_TYPE: Record<string, string> = {
  image: 'image/png',
  file: 'application/octet-stream',
  audio: 'audio/ogg',
  video: 'video/mp4',
  media: 'application/octet-stream',
};

interface FeishuHistoryIntent {
  originalPrompt: string;
  taskPrompt: string;
  limit: number;
  startTimeMs?: number;
  endTimeMs?: number;
  scopeText: string;
  responseMode: 'chat' | 'doc';
  docTitle?: string;
  purpose?: 'summary' | 'reference';
  targetSpeakerNames?: string[];
}

interface FeishuMessageListItem {
  message_id: string;
  chat_id: string;
  create_time: string;
  deleted?: boolean;
  msg_type: string;
  body?: { content?: string };
  sender?: {
    id?: string;
    id_type?: string;
    sender_type?: string;
  };
}

interface FeishuChatMemberItem {
  member_id?: string;
  member_id_type?: string;
  name?: string;
}

interface FeishuChatIndexRecord {
  chatId: string;
  chatType?: string;
  displayName?: string;
  lastMessageAt?: string;
  lastSenderId?: string;
  updatedAt?: string;
}

export interface FeishuDocRequest {
  title: string;
  scopeText: string;
}

interface FeishuDocumentOptions {
  title?: string;
  ownerUserId?: string;
}

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'feishu';

  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private wsClient: lark.WSClient | null = null;
  private restClient: lark.Client | null = null;
  private seenMessageIds = new Map<string, boolean>();
  private botOpenId: string | null = null;
  /** All known bot IDs (open_id, user_id, union_id) for mention matching. */
  private botIds = new Set<string>();
  /** Track last incoming message ID per chat for typing indicator. */
  private lastIncomingMessageId = new Map<string, string>();
  /** Track active typing reaction IDs per chat for cleanup. */
  private typingReactions = new Map<string, string>();
  /** Active streaming card state per chatId. */
  private activeCards = new Map<string, FeishuCardState>();
  /** In-flight card creation promises per chatId — prevents duplicate creation. */
  private cardCreatePromises = new Map<string, Promise<boolean>>();
  private chatMetaCache = new Map<string, { displayName: string; chatType?: string; cachedAt: number }>();
  private p2pPollTimer: ReturnType<typeof setInterval> | null = null;
  private p2pPollInFlight = false;

  private isStreamingCardEnabled(): boolean {
    const raw =
      getBridgeContext().store.getSetting('bridge_feishu_streaming_card_enabled')
      || process.env.CTI_FEISHU_STREAMING_CARD_ENABLED
      || 'false';
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
  }

  private async resolveChatDisplayName(chatId: string, fallbackChatType?: string): Promise<string> {
    const cached = this.chatMetaCache.get(chatId);
    if (cached && Date.now() - cached.cachedAt < 10 * 60 * 1000) {
      return cached.displayName;
    }

    try {
      const { appId, appSecret, baseUrl } = this.getAuthContext();
      const tenantAccessToken = await this.fetchTenantAccessToken(appId, appSecret, baseUrl);
      const response = await fetch(`${baseUrl}/open-apis/im/v1/chats/${chatId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tenantAccessToken}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      const payload = await response.json() as {
        code?: number;
        msg?: string;
        data?: { chat?: { name?: string; chat_type?: string } };
      };
      if (!response.ok || payload.code !== 0) {
        throw new Error(payload.msg || response.statusText);
      }

      const displayName = payload.data?.chat?.name?.trim() || chatId;
      this.chatMetaCache.set(chatId, {
        displayName,
        chatType: payload.data?.chat?.chat_type || fallbackChatType,
        cachedAt: Date.now(),
      });
      return displayName;
    } catch (err) {
      console.warn('[feishu-adapter] resolveChatDisplayName failed:', err instanceof Error ? err.message : err);
      return cached?.displayName || chatId;
    }
  }

  private persistChatIndex(
    chatId: string,
    chatType: string,
    displayName: string,
    sender: FeishuMessageEventData['sender'],
    createTime: string,
  ): void {
    const store = getBridgeContext().store as {
      upsertFeishuChatIndex?: (data: {
        chatId: string;
        chatType?: string;
        displayName?: string;
        lastMessageAt?: string;
        lastSenderId?: string;
      }) => void;
    };
    store.upsertFeishuChatIndex?.({
      chatId,
      chatType,
      displayName,
      lastMessageAt: createTime,
      lastSenderId: sender.sender_id?.open_id || sender.sender_id?.user_id || sender.sender_id?.union_id || '',
    });
  }

  private getPreferredPrivateUserId(sender: FeishuMessageEventData['sender']): string {
    return (
      sender.sender_id?.user_id
      || sender.sender_id?.open_id
      || sender.sender_id?.union_id
      || ''
    ).trim();
  }

  private reconcileP2pAliasBinding(chatId: string, userId: string, displayName: string): void {
    if (!userId || !chatId) return;
    const store = getBridgeContext().store;
    const alias = store.getFeishuP2pUserAlias?.(userId);
    const currentBinding = store.getChannelBinding('feishu', chatId);
    const canonicalChatId = alias?.canonicalChatId?.trim() || alias?.latestChatId?.trim() || chatId;
    const canonicalBinding = canonicalChatId ? store.getChannelBinding('feishu', canonicalChatId) : null;

    if (!currentBinding && canonicalBinding && canonicalBinding.chatType === 'p2p' && canonicalBinding.chatId !== chatId) {
      store.upsertChannelBinding({
        channelType: 'feishu',
        chatId,
        displayName,
        chatType: 'p2p',
        codepilotSessionId: canonicalBinding.codepilotSessionId,
        sdkSessionId: canonicalBinding.sdkSessionId || '',
        workingDirectory: canonicalBinding.workingDirectory || store.getSession(canonicalBinding.codepilotSessionId)?.working_directory || '',
        model: canonicalBinding.model || store.getSession(canonicalBinding.codepilotSessionId)?.model || '',
        mode: canonicalBinding.mode,
        bridgeFingerprint: canonicalBinding.bridgeFingerprint,
        toolingFingerprint: canonicalBinding.toolingFingerprint,
      });
    }

    store.upsertFeishuP2pUserAlias?.({
      userId,
      latestChatId: chatId,
      canonicalChatId: canonicalBinding?.chatId || canonicalChatId,
      displayName,
    });
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[feishu-adapter] Cannot start:', configError);
      return;
    }
    updateFeishuWsAudit({ state: 'starting', lastError: '', lastDisconnectReason: '' });

    const appId = getBridgeContext().store.getSetting('bridge_feishu_app_id') || '';
    const appSecret = getBridgeContext().store.getSetting('bridge_feishu_app_secret') || '';
    const domainSetting = getBridgeContext().store.getSetting('bridge_feishu_domain') || 'feishu';
    const domain = domainSetting === 'lark'
      ? lark.Domain.Lark
      : lark.Domain.Feishu;

    try {
      // Create REST client
      this.restClient = new lark.Client({
        appId,
        appSecret,
        domain,
      });

      // Resolve bot identity for @mention detection
      await this.resolveBotIdentity(appId, appSecret, domain);

      this.running = true;

      // Create EventDispatcher and register event handlers.
      const dispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          await this.handleIncomingEvent(data as FeishuMessageEventData);
        },
        'card.action.trigger': (async (data: unknown) => {
          return await this.handleCardAction(data);
        }) as any,
      });

      // Create and start WSClient
      this.wsClient = new lark.WSClient({
        appId,
        appSecret,
        domain,
      });

    // Monkey-patch WSClient.handleEventData to support card action events (type: "card").
    // The SDK's WSClient only processes type="event" messages. Card action callbacks
    // arrive as type="card" and would be silently dropped without this patch.
    const wsClientAny = this.wsClient as any;
    if (typeof wsClientAny.handleEventData === 'function') {
      const origHandleEventData = wsClientAny.handleEventData.bind(wsClientAny);
      wsClientAny.handleEventData = (data: any) => {
        const msgType = data.headers?.find?.((h: any) => h.key === 'type')?.value;
        if (msgType === 'card') {
          console.log('[feishu-adapter] handleEventData type: card (patched → event)');
          const patchedData = {
            ...data,
            headers: data.headers.map((h: any) =>
              h.key === 'type' ? { ...h, value: 'event' } : h,
            ),
          };
          return origHandleEventData(patchedData);
        }
        return origHandleEventData(data);
      };
    }

      this.wsClient.start({ eventDispatcher: dispatcher });
      updateFeishuWsAudit({ state: 'connected' });
      updateFeishuP2pPollAudit({ state: 'idle', lastError: '' });
      this.startP2pPollFallback();
      console.log('[feishu-adapter] Started (botOpenId:', this.botOpenId || 'unknown', ')');
    } catch (err) {
      updateFeishuWsAudit({
        state: 'error',
        lastError: err instanceof Error ? err.stack || err.message : String(err),
      });
      this.running = false;
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    updateFeishuWsAudit({ state: 'closed', lastDisconnectReason: 'adapter stop() called' });
    updateFeishuP2pPollAudit({ state: 'idle' });

    // Close WebSocket connection (SDK exposes close())
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
      } catch (err) {
        console.warn('[feishu-adapter] WSClient close error:', err instanceof Error ? err.message : err);
      }
      this.wsClient = null;
    }
    this.restClient = null;
    if (this.p2pPollTimer) {
      clearInterval(this.p2pPollTimer);
      this.p2pPollTimer = null;
    }
    this.p2pPollInFlight = false;

    // Reject all waiting consumers
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    // Clean up active cards
    for (const [, state] of this.activeCards) {
      if (state.throttleTimer) clearTimeout(state.throttleTimer);
    }
    this.activeCards.clear();
    this.cardCreatePromises.clear();

    // Clear state
    this.seenMessageIds.clear();
    this.lastIncomingMessageId.clear();
    this.typingReactions.clear();

    console.log('[feishu-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Queue ───────────────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    if (!this.running) return Promise.resolve(null);

    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  // ── Typing indicator (Openclaw-style reaction) ─────────────

  /**
   * Add a "Typing" emoji reaction to the user's message and create streaming card.
   * Called by bridge-manager via onMessageStart().
   */
  onMessageStart(chatId: string): void {
    const messageId = this.lastIncomingMessageId.get(chatId);

    // Create streaming card (fire-and-forget — fallback to traditional if fails)
    if (messageId && this.isStreamingCardEnabled()) {
      this.createStreamingCard(chatId, messageId).catch(() => {});
    }

    // Typing indicator (same as before)
    if (!messageId || !this.restClient) return;
    this.restClient.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: TYPING_EMOJI } },
    }).then((res) => {
      const reactionId = (res as any)?.data?.reaction_id;
      if (reactionId) {
        this.typingReactions.set(chatId, reactionId);
      }
    }).catch((err) => {
      const code = (err as { code?: number })?.code;
      if (code !== 99991400 && code !== 99991403) {
        console.warn('[feishu-adapter] Typing indicator failed:', err instanceof Error ? err.message : err);
      }
    });
  }

  /**
   * Remove the "Typing" emoji reaction and clean up card state.
   * Called by bridge-manager via onMessageEnd().
   */
  onMessageEnd(chatId: string): void {
    // Clean up any orphaned card state (normally cleaned by finalizeCard)
    this.cleanupCard(chatId);

    // Remove typing reaction (same as before)
    const reactionId = this.typingReactions.get(chatId);
    const messageId = this.lastIncomingMessageId.get(chatId);
    if (!reactionId || !messageId || !this.restClient) return;
    this.typingReactions.delete(chatId);
    this.restClient.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    }).catch(() => { /* ignore */ });
  }

  // ── Card Action Handler ─────────────────────────────────────

  /**
   * Handle card.action.trigger events (button clicks on permission cards).
   * Converts button clicks to synthetic InboundMessage with callbackData.
   * Must return within 3 seconds (Feishu timeout), so uses a 2.5s race.
   */
  private async handleCardAction(data: unknown): Promise<unknown> {
    const FALLBACK_TOAST = { toast: { type: 'info' as const, content: '已收到' } };

    try {
      const event = data as any;
      const value = event?.action?.value ?? {};
      const callbackData = value.callback_data;
      if (!callbackData) return FALLBACK_TOAST;

      // Extract chat/user context
      const chatId = event?.context?.open_chat_id || value.chatId || '';
      const messageId = event?.context?.open_message_id || event?.open_message_id || '';
      const userId = event?.operator?.open_id || event?.open_id || '';

      if (!chatId) return FALLBACK_TOAST;

      const callbackMsg: import('../types.js').InboundMessage = {
        messageId: messageId || `card_action_${Date.now()}`,
        address: {
          channelType: 'feishu',
          chatId,
          userId,
        },
        text: '',
        timestamp: Date.now(),
        callbackData,
        callbackMessageId: messageId,
      };
      this.enqueue(callbackMsg);

      return { toast: { type: 'info' as const, content: '已收到，正在处理...' } };
    } catch (err) {
      console.error('[feishu-adapter] Card action handler error:', err instanceof Error ? err.message : err);
      return FALLBACK_TOAST;
    }
  }

  // ── Streaming Card (CardKit v2) ────────────────────────────────

  /**
   * Create a new streaming card and send it as a message.
   * Returns true if card was created successfully.
   */
  private createStreamingCard(chatId: string, replyToMessageId?: string): Promise<boolean> {
    if (!this.restClient || this.activeCards.has(chatId)) return Promise.resolve(false);

    // In-flight guard: if creation is already in progress, return the existing promise
    const existing = this.cardCreatePromises.get(chatId);
    if (existing) return existing;

    const promise = this._doCreateStreamingCard(chatId, replyToMessageId);
    this.cardCreatePromises.set(chatId, promise);
    promise.finally(() => this.cardCreatePromises.delete(chatId));
    return promise;
  }

  private async _doCreateStreamingCard(chatId: string, replyToMessageId?: string): Promise<boolean> {
    if (!this.restClient) return false;

    try {
      // Step 1: Create card via CardKit v2
      const cardBody = {
        schema: '2.0',
        config: {
          streaming_mode: true,
          wide_screen_mode: true,
          summary: { content: '思考中...' },
        },
        body: {
          elements: [{
            tag: 'markdown',
            content: '💭 Thinking...',
            text_align: 'left',
            text_size: 'normal',
            element_id: 'streaming_content',
          }],
        },
      };

      const createResp = await (this.restClient as any).cardkit.v2.card.create({
        data: { type: 'card_json', data: JSON.stringify(cardBody) },
      });
      const cardId = createResp?.data?.card_id;
      if (!cardId) {
        console.warn('[feishu-adapter] Card create returned no card_id');
        return false;
      }

      // Step 2: Send card as IM message
      const cardContent = JSON.stringify({ type: 'card', data: { card_id: cardId } });
      let msgResp;
      if (replyToMessageId) {
        msgResp = await this.restClient.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: cardContent, msg_type: 'interactive' },
        });
      } else {
        msgResp = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardContent,
          },
        });
      }

      const messageId = msgResp?.data?.message_id;
      if (!messageId) {
        console.warn('[feishu-adapter] Card message send returned no message_id');
        return false;
      }

      // Store card state
      this.activeCards.set(chatId, {
        cardId,
        messageId,
        sequence: 0,
        startTime: Date.now(),
        toolCalls: [],
        thinking: true,
        pendingText: null,
        lastUpdateAt: 0,
        throttleTimer: null,
      });

      console.log(`[feishu-adapter] Streaming card created: cardId=${cardId}, msgId=${messageId}`);
      return true;
    } catch (err) {
      console.warn('[feishu-adapter] Failed to create streaming card:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  /**
   * Update streaming card content with throttling.
   */
  private updateCardContent(chatId: string, text: string): void {
    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient) return;

    // Clear thinking state once text arrives
    if (state.thinking && text.trim()) {
      state.thinking = false;
    }
    state.pendingText = text;

    const elapsed = Date.now() - state.lastUpdateAt;
    if (elapsed < CARD_THROTTLE_MS && state.lastUpdateAt > 0) {
      // Schedule trailing-edge flush
      if (!state.throttleTimer) {
        state.throttleTimer = setTimeout(() => {
          state.throttleTimer = null;
          this.flushCardUpdate(chatId);
        }, CARD_THROTTLE_MS - elapsed);
      }
      return;
    }

    // Clear pending timer and flush immediately
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }
    this.flushCardUpdate(chatId);
  }

  /**
   * Flush pending card update to Feishu API.
   */
  private flushCardUpdate(chatId: string): void {
    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient) return;

    const content = buildStreamingContent(state.pendingText || '', state.toolCalls);

    state.sequence++;
    const seq = state.sequence;
    const cardId = state.cardId;

    // Fire-and-forget — streaming updates are non-critical
    (this.restClient as any).cardkit.v2.card.streamContent({
      path: { card_id: cardId },
      data: { content, sequence: seq },
    }).then(() => {
      state.lastUpdateAt = Date.now();
    }).catch((err: unknown) => {
      console.warn('[feishu-adapter] streamContent failed:', err instanceof Error ? err.message : err);
    });
  }

  /**
   * Update tool progress in the streaming card.
   */
  private updateToolProgress(chatId: string, tools: ToolCallInfo[]): void {
    const state = this.activeCards.get(chatId);
    if (!state) return;
    state.toolCalls = tools;
    // Trigger a content flush with current text + updated tools
    this.updateCardContent(chatId, state.pendingText || '');
  }

  /**
   * Finalize the streaming card: close streaming mode, update with final content + footer.
   */
  private async finalizeCard(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
  ): Promise<boolean> {
    // Wait for in-flight card creation to complete before finalizing
    const pending = this.cardCreatePromises.get(chatId);
    if (pending) {
      try { await pending; } catch { /* creation failed — no card to finalize */ }
    }

    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient) return false;

    // Clear any pending throttle timer
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }

    try {
      // Step 1: Close streaming mode
      state.sequence++;
      await (this.restClient as any).cardkit.v2.card.settings.streamingMode.set({
        path: { card_id: state.cardId },
        data: { streaming_mode: false, sequence: state.sequence },
      });

      // Step 2: Build and apply final card
      const statusLabels: Record<string, string> = {
        completed: '✅ Completed',
        interrupted: '⚠️ Interrupted',
        error: '❌ Error',
      };
      const elapsedMs = Date.now() - state.startTime;
      const footer = {
        status: statusLabels[status] || status,
        elapsed: formatElapsed(elapsedMs),
      };

      const finalCardJson = buildFinalCardJson(responseText, state.toolCalls, footer);

      state.sequence++;
      await (this.restClient as any).cardkit.v2.card.update({
        path: { card_id: state.cardId },
        data: { type: 'card_json', data: finalCardJson, sequence: state.sequence },
      });

      console.log(`[feishu-adapter] Card finalized: cardId=${state.cardId}, status=${status}, elapsed=${formatElapsed(elapsedMs)}`);
      return true;
    } catch (err) {
      console.warn('[feishu-adapter] Card finalize failed:', err instanceof Error ? err.message : err);
      return false;
    } finally {
      this.activeCards.delete(chatId);
    }
  }

  /**
   * Clean up card state without finalizing (e.g. on unexpected errors).
   */
  private cleanupCard(chatId: string): void {
    this.cardCreatePromises.delete(chatId);
    const state = this.activeCards.get(chatId);
    if (!state) return;
    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
    }
    this.activeCards.delete(chatId);
  }

  /**
   * Check if there is an active streaming card for a given chat.
   */
  hasActiveCard(chatId: string): boolean {
    return this.activeCards.has(chatId);
  }

  // ── Streaming adapter interface ────────────────────────────────

  /**
   * Called by bridge-manager on each text SSE event.
   * Creates streaming card on first call, then updates content.
   */
  onStreamText(chatId: string, fullText: string): void {
    if (!this.isStreamingCardEnabled()) return;
    if (!this.activeCards.has(chatId)) {
      // Card should have been created by onMessageStart, but create lazily if not
      const messageId = this.lastIncomingMessageId.get(chatId);
      this.createStreamingCard(chatId, messageId).then((ok) => {
        if (ok) this.updateCardContent(chatId, fullText);
      }).catch(() => {});
      return;
    }
    this.updateCardContent(chatId, fullText);
  }

  onToolEvent(chatId: string, tools: ToolCallInfo[]): void {
    if (!this.isStreamingCardEnabled()) return;
    this.updateToolProgress(chatId, tools);
  }

  async onStreamEnd(chatId: string, status: 'completed' | 'interrupted' | 'error', responseText: string): Promise<boolean> {
    if (!this.isStreamingCardEnabled()) return false;
    return this.finalizeCard(chatId, status, responseText);
  }

  // ── Send ────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    let text = message.text;

    // Convert HTML to markdown for Feishu rendering (e.g. command responses)
    if (message.parseMode === 'HTML') {
      text = htmlToFeishuMarkdown(text);
    }

    // Preprocess markdown for Claude responses
    if (message.parseMode === 'Markdown') {
      text = preprocessFeishuMarkdown(text);
    }

    // If there are inline buttons (permission prompts), send card with action buttons
    if (message.inlineButtons && message.inlineButtons.length > 0) {
      return this.sendPermissionCard(message.address.chatId, text, message.inlineButtons);
    }

    if (message.parseMode === 'Markdown') {
      const result = await this.sendAsCard(message.address.chatId, text, message.replyToMessageId);
      if (result.ok) {
        console.log('[feishu-adapter] Markdown send ok:', JSON.stringify({ chatId: message.address.chatId, messageId: result.messageId }));
      } else {
        console.warn('[feishu-adapter] Markdown send failed:', JSON.stringify({ chatId: message.address.chatId, error: result.error }));
      }
      return result;
    }

    const result = await this.sendAsPlainText(
      message.address.chatId,
      text,
      message.replyToMessageId,
      message,
    );
    if (result.ok) {
      console.log('[feishu-adapter] Plain text send ok:', JSON.stringify({ chatId: message.address.chatId, messageId: result.messageId }));
    } else {
      console.warn('[feishu-adapter] Plain text send failed:', JSON.stringify({ chatId: message.address.chatId, error: result.error }));
    }
    return result;
  }

  /**
   * Send text as an interactive card (schema 2.0 markdown).
   * Used for code blocks and tables — card renders them properly.
   */
  private async sendAsCard(chatId: string, text: string, replyToMessageId?: string): Promise<SendResult> {
    const cardContent = buildCardContent(text);

    try {
      const res = replyToMessageId
        ? await this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'interactive', content: cardContent },
        })
        : await this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardContent,
          },
        });

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Card send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu-adapter] Card send error, falling back to post:', err instanceof Error ? err.message : err);
    }

    // Fallback to post
    return this.sendAsPost(chatId, text, replyToMessageId);
  }

  /**
   * Send text as a post message (msg_type: 'post') with md tag.
   * Used for simple text — renders bold, italic, inline code, links.
   */
  private async sendAsPost(chatId: string, text: string, replyToMessageId?: string): Promise<SendResult> {
    const postContent = buildPostContent(text);

    try {
      const res = replyToMessageId
        ? await this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'post', content: postContent },
        })
        : await this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'post',
            content: postContent,
          },
        });

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Post send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu-adapter] Post send error, falling back to text:', err instanceof Error ? err.message : err);
    }

    // Final fallback: plain text
    try {
      const res = replyToMessageId
        ? await this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'text', content: JSON.stringify({ text }) },
        })
        : await this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
        });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Permission card (with real action buttons) ─────────────

  /**
   * Send a permission card with real Feishu card action buttons.
   * Button clicks trigger card.action.trigger events handled by handleCardAction().
   * Falls back to text-based /perm commands if button card fails.
   */
  private async sendPermissionCard(
    chatId: string,
    text: string,
    inlineButtons: import('../types.js').InlineButton[][],
  ): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    // Convert HTML text from permission-broker to Feishu markdown.
    // permission-broker sends HTML (<b>, <code>, <pre>, &amp; entities)
    // but Feishu card markdown elements don't understand HTML.
    const mdText = text
      .replace(/<b>(.*?)<\/b>/gi, '**$1**')
      .replace(/<code>(.*?)<\/code>/gi, '`$1`')
      .replace(/<pre>([\s\S]*?)<\/pre>/gi, '```\n$1\n```')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');

    // Extract permissionRequestId from the first button's callback data
    const firstBtn = inlineButtons.flat()[0];
    const permId = firstBtn?.callbackData?.startsWith('perm:')
      ? firstBtn.callbackData.split(':').slice(2).join(':')
      : '';

    if (permId) {
      // Use real card action buttons
      const cardJson = buildPermissionButtonCard(mdText, permId, chatId);

      try {
        const res = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardJson,
          },
        });
        if (res?.data?.message_id) {
          return { ok: true, messageId: res.data.message_id };
        }
        console.warn('[feishu-adapter] Permission button card send failed:', JSON.stringify({ code: (res as any)?.code, msg: res?.msg }));
      } catch (err) {
        console.warn('[feishu-adapter] Permission button card error, falling back to text:', err instanceof Error ? err.message : err);
      }
    }

    // Fallback: text-based permission commands (same as before, for backward compat)
    const permCommands = inlineButtons.flat().map((btn) => {
      if (btn.callbackData.startsWith('perm:')) {
        const parts = btn.callbackData.split(':');
        const action = parts[1];
        const id = parts.slice(2).join(':');
        return `\`/perm ${action} ${id}\``;
      }
      return btn.text;
    });

    const cardContent = [
      mdText,
      '',
      '---',
      '**Reply:**',
      '`1` - Allow once',
      '`2` - Allow session',
      '`3` - Deny',
      '',
      'Or use full commands:',
      ...permCommands,
    ].join('\n');

    const cardJson = JSON.stringify({
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '🔐 Permission Required' },
      },
      body: {
        elements: [
          { tag: 'markdown', content: cardContent },
        ],
      },
    });

    try {
      const res = await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: cardJson,
        },
      });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu-adapter] Fallback card also failed:', res?.msg);
    } catch (err) {
      console.warn('[feishu-adapter] Fallback card error, sending plain text:', err instanceof Error ? err.message : err);
    }

    // Last resort: plain text message (works even without card permissions)
    const plainText = [
      mdText,
      '',
      '---',
      'Reply: 1 = Allow once | 2 = Allow session | 3 = Deny',
      '',
      ...permCommands,
    ].join('\n');

    try {
      const res = await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: plainText }),
        },
      });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Config & Auth ───────────────────────────────────────────

  validateConfig(): string | null {
    const enabled = getBridgeContext().store.getSetting('bridge_feishu_enabled');
    if (enabled !== 'true') return 'bridge_feishu_enabled is not true';

    const appId = getBridgeContext().store.getSetting('bridge_feishu_app_id');
    if (!appId) return 'bridge_feishu_app_id not configured';

    const appSecret = getBridgeContext().store.getSetting('bridge_feishu_app_secret');
    if (!appSecret) return 'bridge_feishu_app_secret not configured';

    return null;
  }

  isAuthorized(userId: string, chatId: string): boolean {
    const allowedUsers = getBridgeContext().store.getSetting('bridge_feishu_allowed_users') || '';
    if (!allowedUsers) {
      // No restriction configured — allow all
      return true;
    }

    const allowed = allowedUsers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (allowed.length === 0) return true;

    return allowed.includes(userId) || allowed.includes(chatId);
  }

  // ── Incoming event handler ──────────────────────────────────

  private async handleIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    console.log('[feishu-adapter] inbound event:', data.message?.message_id || '(unknown)', data.message?.chat_id || '(unknown)');
    updateFeishuWsAudit({
      lastEventType: 'im.message.receive_v1',
      lastEventAt: new Date().toISOString(),
    });
    try {
      await this.processIncomingEvent(data);
    } catch (err) {
      updateFeishuWsAudit({
        state: 'error',
        lastError: err instanceof Error ? err.stack || err.message : String(err),
      });
      console.error(
        '[feishu-adapter] Unhandled error in event handler:',
        err instanceof Error ? err.stack || err.message : err,
      );
    }
  }

  private async processIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    const msg = data.message;
    const sender = data.sender;

    // [P1] Filter out bot messages to prevent self-triggering loops
    if (sender.sender_type === 'bot') return;

    // Dedup by message_id
    if (this.seenMessageIds.has(msg.message_id)) return;
    this.addToDedup(msg.message_id);

    const chatId = msg.chat_id;
    // [P2] Complete sender ID fallback chain: open_id > user_id > union_id
    const userId = sender.sender_id?.open_id
      || sender.sender_id?.user_id
      || sender.sender_id?.union_id
      || '';
    const isGroup = msg.chat_type === 'group';

    // Authorization check
    if (!this.isAuthorized(userId, chatId)) {
      console.warn('[feishu-adapter] Unauthorized message from userId:', userId, 'chatId:', chatId);
      return;
    }

    // Group chat policy
    if (isGroup) {
      const policy = getBridgeContext().store.getSetting('bridge_feishu_group_policy') || 'open';

      if (policy === 'disabled') {
        console.log('[feishu-adapter] Group message ignored (policy=disabled), chatId:', chatId);
        return;
      }

      if (policy === 'allowlist') {
        const allowedGroups = (getBridgeContext().store.getSetting('bridge_feishu_group_allow_from') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!allowedGroups.includes(chatId)) {
          console.log('[feishu-adapter] Group message ignored (not in allowlist), chatId:', chatId);
          return;
        }
      }

      // Require @mention check
      const requireMention = getBridgeContext().store.getSetting('bridge_feishu_require_mention') !== 'false';
      if (requireMention && !this.isBotMentioned(msg.mentions)) {
        console.log('[feishu-adapter] Group message ignored (bot not @mentioned), chatId:', chatId, 'msgId:', msg.message_id);
        try {
          getBridgeContext().store.insertAuditLog({
            channelType: 'feishu',
            chatId,
            direction: 'inbound',
            messageId: msg.message_id,
            summary: '[FILTERED] Group message dropped: bot not @mentioned (require_mention=true)',
          });
        } catch { /* best effort */ }
        return;
      }
    }

    // Track last message ID per chat for typing indicator
    this.lastIncomingMessageId.set(chatId, msg.message_id);

    // Extract content based on message type
    const messageType = msg.message_type;
    let text = '';
    const attachments: FileAttachment[] = [];

    if (messageType === 'text') {
      text = this.parseTextContent(msg.content);
    } else if (messageType === 'image') {
      // [P1] Download image with failure fallback
      console.log('[feishu-adapter] Image message received, content:', msg.content);
      const fileKey = this.extractFileKey(msg.content);
      console.log('[feishu-adapter] Extracted fileKey:', fileKey);
      if (fileKey) {
        const attachment = await this.downloadResource(msg.message_id, fileKey, 'image');
        if (attachment) {
          attachments.push(attachment);
        } else {
          text = '[image download failed]';
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: 'feishu',
              chatId,
              direction: 'inbound',
              messageId: msg.message_id,
              summary: `[ERROR] Image download failed for key: ${fileKey}`,
            });
          } catch { /* best effort */ }
        }
      }
    } else if (messageType === 'file' || messageType === 'audio' || messageType === 'video' || messageType === 'media') {
      // [P2] Support file/audio/video/media downloads
      const fileKey = this.extractFileKey(msg.content);
      if (fileKey) {
        const resourceType = messageType === 'audio' || messageType === 'video' || messageType === 'media'
          ? messageType
          : 'file';
        const attachment = await this.downloadResource(msg.message_id, fileKey, resourceType);
        if (attachment) {
          attachments.push(attachment);
        } else {
          text = `[${messageType} download failed]`;
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: 'feishu',
              chatId,
              direction: 'inbound',
              messageId: msg.message_id,
              summary: `[ERROR] ${messageType} download failed for key: ${fileKey}`,
            });
          } catch { /* best effort */ }
        }
      }
    } else if (messageType === 'post') {
      // [P2] Extract text and image keys from rich text (post) messages
      const { extractedText, imageKeys } = this.parsePostContent(msg.content);
      text = extractedText;
      for (const key of imageKeys) {
        const attachment = await this.downloadResource(msg.message_id, key, 'image');
        if (attachment) {
          attachments.push(attachment);
        }
        // Don't add fallback text for individual post images — the text already carries context
      }
    } else {
      // Unsupported type — log and skip
      console.log(`[feishu-adapter] Unsupported message type: ${messageType}, msgId: ${msg.message_id}`);
      return;
    }

    // Strip @mention markers from text
    text = this.stripMentionMarkers(text);

    const timestamp = parseInt(msg.create_time, 10) || Date.now();
    const displayName = await this.resolveChatDisplayName(chatId, msg.chat_type);
    this.persistChatIndex(chatId, msg.chat_type, displayName, sender, msg.create_time);
    if (msg.chat_type === 'p2p') {
      this.reconcileP2pAliasBinding(chatId, this.getPreferredPrivateUserId(sender), displayName);
    }
    try {
      await this.syncIndexedChatHistory(chatId, msg.chat_type, displayName, false);
    } catch (err) {
      console.warn('[feishu-adapter] incremental history sync failed:', err instanceof Error ? err.message : err);
    }
    const address = {
      channelType: 'feishu' as const,
      chatId,
      userId,
      displayName,
      chatType: msg.chat_type,
    };
    let rawMetadata: Record<string, unknown> | undefined = {
      feishuSender: {
        openId: sender.sender_id?.open_id,
        userId: sender.sender_id?.user_id,
        unionId: sender.sender_id?.union_id,
        chatType: msg.chat_type,
      },
    };

    const trimmedUserText = text.trim();
    if (isGroup && trimmedUserText) {
      const historyIntent = this.parseHistoryIntentV2(trimmedUserText);
      if (historyIntent) {
        try {
          text = await this.buildHistoryAugmentedPromptV2(chatId, msg.message_id, historyIntent);
          if (historyIntent.responseMode === 'doc' && historyIntent.docTitle) {
            rawMetadata = {
              ...(rawMetadata || {}),
              feishuDocRequest: {
                title: historyIntent.docTitle,
                scopeText: historyIntent.scopeText,
              } satisfies FeishuDocRequest,
            };
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          console.warn('[feishu-adapter] Failed to augment prompt with chat history:', errorMessage);

          const inbound: InboundMessage = {
            messageId: msg.message_id,
            address,
            text: '',
            timestamp,
            raw: {
              userVisibleError: this.toHistoryReadErrorMessage(errorMessage),
            },
          };
          this.enqueue(inbound);
          return;
        }
      }
    }

    if (!text.trim() && attachments.length === 0) return;

    // [P1] Check for /perm text command (permission approval fallback)
    const trimmedText = text.trim();
    if (trimmedText.startsWith('/perm ')) {
      const permParts = trimmedText.split(/\s+/);
      // /perm <action> <permId>
      if (permParts.length >= 3) {
        const action = permParts[1]; // allow / allow_session / deny
        const permId = permParts.slice(2).join(' ');
        const callbackData = `perm:${action}:${permId}`;

        const inbound: InboundMessage = {
          messageId: msg.message_id,
          address,
          text: trimmedText,
          timestamp,
          callbackData,
        };
        this.enqueue(inbound);
        return;
      }
    }

    const inbound: InboundMessage = {
      messageId: msg.message_id,
      address,
      text: text.trim(),
      timestamp,
      raw: rawMetadata,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    // Audit log
    try {
      const summary = attachments.length > 0
        ? `[${attachments.length} attachment(s)] ${text.slice(0, 150)}`
        : text.slice(0, 200);
      getBridgeContext().store.insertAuditLog({
        channelType: 'feishu',
        chatId,
        direction: 'inbound',
        messageId: msg.message_id,
        summary,
      });
    } catch { /* best effort */ }

    this.enqueue(inbound);
  }

  // ── Content parsing ─────────────────────────────────────────

  private parseTextContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      return parsed.text || '';
    } catch {
      return content;
    }
  }

  /**
   * Extract file key from message content JSON.
   * Handles multiple key names: image_key, file_key, imageKey, fileKey.
   */
  private extractFileKey(content: string): string | null {
    try {
      const parsed = JSON.parse(content);
      return parsed.image_key || parsed.file_key || parsed.imageKey || parsed.fileKey || null;
    } catch {
      return null;
    }
  }

  /**
   * Parse rich text (post) content.
   * Extracts plain text from text elements and image keys from img elements.
   */
  private parsePostContent(content: string): { extractedText: string; imageKeys: string[] } {
    const imageKeys: string[] = [];
    const textParts: string[] = [];

    try {
      const parsed = JSON.parse(content);
      // Post content structure: { title, content: [[{tag, text/image_key}]] }
      const title = parsed.title;
      if (title) textParts.push(title);

      const paragraphs = parsed.content;
      if (Array.isArray(paragraphs)) {
        for (const paragraph of paragraphs) {
          if (!Array.isArray(paragraph)) continue;
          for (const element of paragraph) {
            if (element.tag === 'text' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'a' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'at' && element.user_id) {
              // Mention in post — handled by isBotMentioned for group policy
            } else if (element.tag === 'img') {
              const key = element.image_key || element.file_key || element.imageKey;
              if (key) imageKeys.push(key);
            }
          }
          textParts.push('\n');
        }
      }
    } catch {
      // Failed to parse post content
    }

    return { extractedText: textParts.join('').trim(), imageKeys };
  }

  private startP2pPollFallback(): void {
    if (this.p2pPollTimer) clearInterval(this.p2pPollTimer);
    this.p2pPollTimer = setInterval(() => {
      void this.pollP2pChatsForMissedMessages();
    }, P2P_POLL_INTERVAL_MS);
  }

  private readIndexedP2pChats(): FeishuChatIndexRecord[] {
    try {
      const raw = fs.readFileSync(FEISHU_CHAT_INDEX_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, FeishuChatIndexRecord>;
      return Object.values(parsed).filter((item) => item?.chatId && item.chatType === 'p2p');
    } catch {
      return [];
    }
  }

  private async pollP2pChatsForMissedMessages(): Promise<void> {
    if (!this.running || this.p2pPollInFlight) return;
    this.p2pPollInFlight = true;
    updateFeishuP2pPollAudit({
      state: 'polling',
      lastPollAt: new Date().toISOString(),
      lastError: '',
    });
    try {
      const chats = this.readIndexedP2pChats();
      for (const chat of chats) {
        await this.pollSingleP2pChat(chat);
      }
      updateFeishuP2pPollAudit({ state: 'idle' });
    } catch (err) {
      console.warn('[feishu-adapter] p2p poll fallback failed:', err instanceof Error ? err.message : err);
      updateFeishuP2pPollAudit({
        state: 'failed',
        lastError: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.p2pPollInFlight = false;
    }
  }

  private async pollSingleP2pChat(chat: FeishuChatIndexRecord): Promise<void> {
    const latestKnownTime = Number.parseInt(chat.lastMessageAt || '0', 10) || 0;
    const { items } = await this.fetchMessagePage(chat.chatId, '', 10);
    const candidates = items
      .filter((item) => !item.deleted)
      .filter((item) => item.msg_type !== 'system')
      .filter((item) => item.sender?.sender_type !== 'app')
      .filter((item) => !this.seenMessageIds.has(item.message_id))
      .filter((item) => (Number.parseInt(item.create_time, 10) || 0) > latestKnownTime)
      .sort((a, b) => (Number.parseInt(a.create_time, 10) || 0) - (Number.parseInt(b.create_time, 10) || 0));

    for (const item of candidates) {
      console.log('[feishu-adapter] recovered p2p event via history poll:', item.message_id, chat.chatId);
      updateFeishuP2pPollAudit({
        state: 'recovered',
        lastPollAt: new Date().toISOString(),
        lastRecoveredMessageId: item.message_id,
        lastRecoveredChatId: chat.chatId,
        lastError: '',
      });
      await this.handleIncomingEvent({
        sender: {
          sender_type: item.sender?.sender_type || 'user',
          sender_id: item.sender?.id
            ? { [item.sender.id_type === 'user_id' ? 'user_id' : item.sender.id_type === 'union_id' ? 'union_id' : 'open_id']: item.sender.id }
            : undefined,
        },
        message: {
          message_id: item.message_id,
          chat_id: item.chat_id,
          chat_type: chat.chatType || 'p2p',
          message_type: item.msg_type,
          content: item.body?.content || '',
          create_time: item.create_time,
        },
      });
    }
  }

  private buildOutboundMentionTags(message?: OutboundMessage): string[] {
    if (!message) return [];
    if (/<at\s+user_id=/i.test(message.text)) return [];

    const resolvedMentions: OutboundMention[] = [];
    const seen = new Set<string>();
    const pushMention = (mention?: OutboundMention | null) => {
      if (!mention) return;
      const key = mention.atAll ? '__all__' : (mention.userId || '').trim();
      if (!key || seen.has(key)) return;
      seen.add(key);
      resolvedMentions.push(mention);
    };

    for (const mention of message.mentions || []) {
      pushMention(mention);
    }

    const isGroup = message.address.chatType === 'group';
    if (isGroup && message.replyToMessageId && message.address.userId) {
      pushMention({
        userId: message.address.userId,
        name: message.address.displayName,
      });
    }

    return resolvedMentions.map((mention) => {
      if (mention.atAll) {
        return '<at user_id="all">所有人</at>';
      }
      const userId = (mention.userId || '').trim();
      if (!userId) return '';
      const name = (mention.name || '你').replace(/[<>"]/g, '').trim() || '你';
      return `<at user_id="${userId}">${name}</at>`;
    }).filter(Boolean);
  }

  private buildFeishuTextPayload(text: string, message?: OutboundMessage): string {
    const mentionTags = this.buildOutboundMentionTags(message);
    const body = mentionTags.length > 0
      ? `${mentionTags.join(' ')}${text.trim() ? `\n${text}` : ''}`
      : text;
    return JSON.stringify({ text: body });
  }

  private async sendAsPlainText(
    chatId: string,
    text: string,
    replyToMessageId?: string,
    message?: OutboundMessage,
  ): Promise<SendResult> {
    try {
      const content = this.buildFeishuTextPayload(text, message);
      const res = replyToMessageId
        ? await this.restClient!.im.message.reply({
            path: { message_id: replyToMessageId },
            data: {
              msg_type: 'text',
              content,
            },
          })
        : await this.restClient!.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content,
            },
          });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  private parseHistoryIntentV2(text: string): FeishuHistoryIntent | null {
    const normalized = text.replace(/\s+/g, '');
    const wantsSummary = /(\u603b\u7ed3|\u6c47\u603b|\u6574\u7406|\u68b3\u7406|\u6982\u62ec|\u5f52\u7eb3|\u56de\u987e|\u63d0\u70bc|\u63d0\u53d6)/.test(normalized);
    const mentionsHistory = /(\u7fa4\u804a|\u804a\u5929|\u5bf9\u8bdd|\u6d88\u606f|\u8bb0\u5f55|\u8ba8\u8bba|\u5185\u5bb9)/.test(normalized);
    const mentionsTime = /(\u6700\u8fd1\d{1,3}\u6761|\u6700\u8fd1|\u4eca\u5929|\u4eca\u65e5|\u6628\u5929|\u6628\u65e5|\u524d\u5929|\u4e0a\u5348|\u4e0b\u5348|\u665a\u4e0a|\u5b8c\u6574|\u5168\u90e8)/.test(normalized);
    const wantsDoc = /(\u98de\u4e66\u6587\u6863|\u6587\u6863\u94fe\u63a5|\u751f\u6210.*\u6587\u6863|\u6574\u7406\u6210.*\u6587\u6863|\u8f93\u51fa\u5230.*\u6587\u6863|\u53d1\u94fe\u63a5|\u56de\u94fe\u63a5)/.test(normalized);
    const actionVerbMatched = /(\u6807\u6ce8|\u91cd\u6807|\u6539\u6807|\u5224\u65ad|\u4fee\u6539|\u7ea0\u6b63|\u6838\u5bf9|\u6821\u5bf9|\u547d\u540d|\u5bf9\u7167)/.test(normalized);
    const targetSpeakerNames = this.extractTargetSpeakerNamesV2(text);
    const wantsReferenceAction = (
      /(\u6839\u636e|\u6309|\u53c2\u8003|\u7ed3\u5408).*(\u804a\u5929\u8bb0\u5f55|\u7fa4\u804a\u8bb0\u5f55|\u6d88\u606f|\u5bf9\u8bdd)/.test(normalized)
      || (/(\u6839\u636e|\u6309|\u53c2\u8003|\u7ed3\u5408).*(\u8bf4\u7684|\u63d0\u5230\u7684|\u804a\u8fc7\u7684)/.test(normalized) && targetSpeakerNames.length > 0)
    ) && actionVerbMatched;

    if ((!wantsSummary && !wantsDoc && !wantsReferenceAction) || (!mentionsHistory && !mentionsTime && !wantsDoc && !wantsReferenceAction)) {
      return null;
    }

    const countMatch = text.match(/(\d{1,3})\s*(\u6761|\u5219|\u6bb5|\u4e2a)?/);
    const requestedCount = countMatch ? Number.parseInt(countMatch[1], 10) : undefined;
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTomorrow = new Date(startOfToday);
    startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    const startOfDayBeforeYesterday = new Date(startOfToday);
    startOfDayBeforeYesterday.setDate(startOfDayBeforeYesterday.getDate() - 2);

    let startTimeMs: number | undefined;
    let endTimeMs: number | undefined;
    let scopeText = '\u672c\u7fa4\u6700\u8fd1\u6d88\u606f';

    if (/(\u6628\u5929|\u6628\u65e5)/.test(normalized)) {
      startTimeMs = startOfYesterday.getTime();
      endTimeMs = startOfToday.getTime();
      scopeText = '\u672c\u7fa4\u6628\u5929\u7684\u804a\u5929\u8bb0\u5f55';
    } else if (/\u524d\u5929/.test(normalized)) {
      startTimeMs = startOfDayBeforeYesterday.getTime();
      endTimeMs = startOfYesterday.getTime();
      scopeText = '\u672c\u7fa4\u524d\u5929\u7684\u804a\u5929\u8bb0\u5f55';
    } else if (/(\u4eca\u5929|\u4eca\u65e5)/.test(normalized)) {
      startTimeMs = startOfToday.getTime();
      endTimeMs = startOfTomorrow.getTime();
      scopeText = '\u672c\u7fa4\u4eca\u5929\u7684\u804a\u5929\u8bb0\u5f55';
    }

    if (startTimeMs !== undefined && /(\u4e0a\u5348|\u65e9\u4e0a|\u6e05\u6668)/.test(normalized)) {
      const end = new Date(startTimeMs);
      end.setHours(12, 0, 0, 0);
      endTimeMs = end.getTime();
      scopeText = scopeText.replace('\u804a\u5929\u8bb0\u5f55', '\u4e0a\u5348\u804a\u5929\u8bb0\u5f55');
    } else if (startTimeMs !== undefined && /\u4e0b\u5348/.test(normalized)) {
      const start = new Date(startTimeMs);
      start.setHours(12, 0, 0, 0);
      startTimeMs = start.getTime();
      const end = new Date(start);
      end.setHours(18, 0, 0, 0);
      endTimeMs = end.getTime();
      scopeText = scopeText.replace('\u804a\u5929\u8bb0\u5f55', '\u4e0b\u5348\u804a\u5929\u8bb0\u5f55');
    } else if (startTimeMs !== undefined && /(\u665a\u4e0a|\u665a\u95f4)/.test(normalized)) {
      const start = new Date(startTimeMs);
      start.setHours(18, 0, 0, 0);
      startTimeMs = start.getTime();
      scopeText = scopeText.replace('\u804a\u5929\u8bb0\u5f55', '\u665a\u95f4\u804a\u5929\u8bb0\u5f55');
    }

    const wantsFull = /(\u5b8c\u6574|\u5168\u90e8|\u6240\u6709)/.test(normalized);
    const defaultLimit = wantsReferenceAction ? 50 : (startTimeMs !== undefined ? 100 : 30);
    const limit = Math.max(5, Math.min(requestedCount ?? (wantsFull ? 100 : defaultLimit), 100));
    const responseMode: 'chat' | 'doc' = wantsDoc ? 'doc' : 'chat';
    const docTitle = undefined;

    return {
      originalPrompt: text,
      taskPrompt: text,
      limit,
      startTimeMs,
      endTimeMs,
      scopeText,
      responseMode,
      docTitle,
      purpose: wantsReferenceAction ? 'reference' : 'summary',
      targetSpeakerNames,
    };
  }

  private extractTargetSpeakerNamesV2(text: string): string[] {
    const names = new Set<string>();
    const patterns = [
      /(?:\u6839\u636e|\u6309|\u53c2\u8003|\u7ed3\u5408)([^\uFF0C\u3002\uFF1B\uFF1A\s]{1,12}?)(?:\u7684)?(?:\u804a\u5929\u8bb0\u5f55|\u7fa4\u804a\u8bb0\u5f55|\u6d88\u606f|\u5bf9\u8bdd)/g,
      /(?:\u53c2\u8003|\u6309)([^\uFF0C\u3002\uFF1B\uFF1A\s]{1,12}?)(?:\u8bf4\u7684|\u63d0\u5230\u7684|\u804a\u8fc7\u7684)/g,
      /@([^\s\uFF0C\u3002\uFF1B\uFF1A]{1,24})/g,
    ];

    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const raw = (match[1] || '').trim();
        const cleaned = raw
          .replace(/^(\u7fa4\u91cc|\u672c\u7fa4|\u8fd9\u4e2a\u7fa4|\u7fa4\u804a|\u804a\u5929)/, '')
          .replace(/(\u804a\u5929\u8bb0\u5f55|\u7fa4\u804a\u8bb0\u5f55|\u6d88\u606f|\u5bf9\u8bdd|\u8bf4\u7684|\u63d0\u5230\u7684)$/g, '')
          .trim();
        if (cleaned.length >= 2 && cleaned.length <= 12) {
          names.add(cleaned);
        }
      }
    }

    return [...names];
  }

  private getExtendedStore(): {
    upsertFeishuHistoryMessages?: (data: {
      chatId: string;
      displayName?: string;
      chatType?: string;
      messages: Array<{
        messageId: string;
        chatId: string;
        createTime: string;
        msgType: string;
        senderId?: string;
        senderType?: string;
        senderName?: string;
        text: string;
      }>;
      syncedAt?: string;
    }) => unknown;
    getFeishuHistorySyncStatus?: (chatId?: string) => Array<{ latestMessageTime?: string }>;
    retrieveRelevantFeishuHistory?: (query: {
      chatId: string;
      query: string;
      limit: number;
      startTimeMs?: number;
      endTimeMs?: number;
      targetSpeakerNames?: string[];
    }) => { summary: string; items: Array<{ messageId: string }>; syncStatus?: { lastSyncAt?: string; messageCount?: number } } | null;
  } {
    return getBridgeContext().store as unknown as ReturnType<FeishuAdapter['getExtendedStore']>;
  }

  private async syncIndexedChatHistory(chatId: string, chatType: string, displayName: string, full = false): Promise<void> {
    const store = this.getExtendedStore();
    if (!store.upsertFeishuHistoryMessages) return;

    const latestKnownTime = full
      ? 0
      : Number.parseInt(store.getFeishuHistorySyncStatus?.(chatId)?.[0]?.latestMessageTime || '0', 10) || 0;
    const memberNames = await this.fetchChatMemberNames(chatId);
    const collected: FeishuMessageListItem[] = [];
    let pageToken = '';

    while (true) {
      const { items, nextPageToken, hasMore } = await this.fetchMessagePage(chatId, pageToken, 50);
      if (items.length === 0) break;
      collected.push(...items);

      if (!full) {
        const pageHasNewer = items.some((item) => (Number.parseInt(item.create_time, 10) || 0) > latestKnownTime);
        if (!pageHasNewer) break;
      }

      if (!hasMore || !nextPageToken) break;
      pageToken = nextPageToken;
    }

    const prepared = collected
      .filter((item) => !item.deleted)
      .filter((item) => item.msg_type !== 'system')
      .map((item) => {
        const senderId = item.sender?.id?.trim() || '';
        const senderName = senderId ? memberNames.get(senderId)?.trim() || '' : '';
        return {
          messageId: item.message_id,
          chatId,
          createTime: item.create_time,
          msgType: item.msg_type,
          senderId,
          senderType: item.sender?.sender_type,
          senderName,
          text: this.extractHistoryText(item),
        };
      })
      .filter((item) => item.text);

    if (prepared.length === 0 && !full) return;
    store.upsertFeishuHistoryMessages({
      chatId,
      displayName,
      chatType,
      messages: prepared,
      syncedAt: new Date().toISOString(),
    });
  }

  private async buildHistoryAugmentedPromptV2(
    chatId: string,
    currentMessageId: string,
    intent: FeishuHistoryIntent,
  ): Promise<string> {
    const displayName = await this.resolveChatDisplayName(chatId);
    await this.syncIndexedChatHistory(chatId, 'group', displayName, false);
    const retrieved = this.getExtendedStore().retrieveRelevantFeishuHistory?.({
      chatId,
      query: intent.taskPrompt,
      limit: intent.limit,
      startTimeMs: intent.startTimeMs,
      endTimeMs: intent.endTimeMs,
      targetSpeakerNames: intent.targetSpeakerNames,
    });

    const formattedHistory = retrieved?.summary || '';

    if (!formattedHistory) {
      return [
        `\u7528\u6237\u5f53\u524d\u8bf7\u6c42\uff1a${intent.taskPrompt}`,
        '',
        (intent.targetSpeakerNames ?? []).length > 0
          ? `\u8bf4\u660e\uff1a\u672c\u5730\u5386\u53f2\u7d22\u5f15\u91cc\u6ca1\u6709\u7b5b\u5230\u4e0e ${(intent.targetSpeakerNames ?? []).join('\u3001')} \u76f8\u5173\u7684\u6709\u6548\u6d88\u606f\u3002\u8bf7\u76f4\u63a5\u8bf4\u660e\u8fd9\u4e00\u70b9\uff0c\u5e76\u7ed9\u51fa\u6700\u77ed\u4e0b\u4e00\u6b65\u5efa\u8bae\u3002`
          : '\u8bf4\u660e\uff1a\u6211\u5df2\u5c1d\u8bd5\u8bfb\u53d6\u7fa4\u804a\u5386\u53f2\uff0c\u4f46\u5f53\u524d\u6ca1\u6709\u62ff\u5230\u53ef\u7528\u4e8e\u56de\u7b54\u7684\u6709\u6548\u6d88\u606f\u3002\u8bf7\u76f4\u63a5\u8bf4\u660e\u8fd9\u6b21\u6ca1\u8bfb\u5230\u5185\u5bb9\uff0c\u5e76\u7ed9\u51fa\u6700\u77ed\u4e0b\u4e00\u6b65\u5efa\u8bae\u3002',
      ].join('\n');
    }

    const selectedCount = retrieved?.items.length ?? 0;
    const targetSpeakerNames = intent.targetSpeakerNames ?? [];
    const speakerScope = targetSpeakerNames.length > 0
      ? `\u4e0e ${targetSpeakerNames.join('\u3001')} \u76f8\u5173\u7684`
      : '';
    const syncInfo = retrieved?.syncStatus?.messageCount ? `\uFF08\u672C\u5730\u7D22\u5F15\u5DF2\u540C\u6B65 ${retrieved.syncStatus.messageCount} \u6761\uFF09` : '';
    const scopeText = `${intent.scopeText}\u4E2D\u7D22\u5F15\u547D\u4E2D\u7684${speakerScope}${selectedCount}\u6761\u76F8\u5173\u6D88\u606F${syncInfo}`;

    if (intent.responseMode === 'doc') {
      return [
        `\u8bf7\u57fa\u4e8e\u4e0b\u9762\u63d0\u4f9b\u7684 ${scopeText}\uff0c\u751f\u6210\u4e00\u4efd\u9002\u5408\u76f4\u63a5\u5199\u5165\u98de\u4e66\u6587\u6863\u7684 Markdown \u6b63\u6587\u3002`,
        '\u8981\u6c42\uff1a',
        '1. \u7b2c\u4e00\u884c\u5fc5\u987b\u662f\u4e00\u7ea7\u6807\u9898\u3002',
        '2. \u6b63\u6587\u9ed8\u8ba4\u5305\u542b\u201c\u7ed3\u8bba\u6458\u8981\u201d\u201c\u91cd\u70b9\u4fe1\u606f\u201d\u201c\u5f85\u529e\u4e8b\u9879\u201d\u4e09\u4e2a\u90e8\u5206\uff1b\u5982\u679c\u67d0\u90e8\u5206\u786e\u5b9e\u4e3a\u7a7a\uff0c\u4e5f\u8981\u5982\u5b9e\u5199\u660e\u3002',
        '3. \u53ea\u8f93\u51fa\u6587\u6863\u6b63\u6587\u672c\u8eab\uff0c\u4e0d\u8981\u5199\u201c\u4e0b\u9762\u662f\u201d\u201c\u5df2\u4e3a\u4f60\u751f\u6210\u201d\u201c\u8bf7\u67e5\u6536\u201d\u7b49\u5ba2\u5957\u53e5\u3002',
        '4. \u4e0d\u8981\u8f93\u51fa\u4ee3\u7801\u5757\uff0c\u4e0d\u8981\u7f16\u9020\u7fa4\u91cc\u6ca1\u6709\u51fa\u73b0\u7684\u4fe1\u606f\u3002',
        '',
        '=== \u7fa4\u804a\u5386\u53f2\u5f00\u59cb ===',
        formattedHistory,
        '=== \u7fa4\u804a\u5386\u53f2\u7ed3\u675f ===',
        '',
        `\u7528\u6237\u5f53\u524d\u8bf7\u6c42\uff1a${intent.taskPrompt}`,
      ].join('\n');
    }

    if (intent.purpose === 'reference' && targetSpeakerNames.length > 0) {
      return [
        `\u8bf7\u4f18\u5148\u4f9d\u636e\u4e0b\u9762\u63d0\u4f9b\u7684 ${scopeText} \u6765\u5b8c\u6210\u7528\u6237\u8bf7\u6c42\u3002`,
        '\u8981\u6c42\uff1a\u76f4\u63a5\u7ed9\u51fa\u7ed3\u8bba\u6216\u4fee\u6539\u7ed3\u679c\uff0c\u4e0d\u8981\u5148\u8bf4\u201c\u6211\u53bb\u627e\u8bb0\u5f55\u201d\u6216\u201c\u6211\u6ca1\u770b\u5230\u804a\u5929\u8bb0\u5f55\u201d\u3002',
        `\u5982\u679c\u8fd9\u4e9b\u8bb0\u5f55\u4e0d\u8db3\u4ee5\u652f\u6491\u6700\u7ec8\u5224\u65ad\uff0c\u518d\u7528\u4e00\u53e5\u8bdd\u8bf4\u660e\u201c\u5f53\u524d\u53ea\u8bfb\u5230\u4e86 ${targetSpeakerNames.join('\u3001')} \u7684\u8fd9\u4e9b\u76f8\u5173\u8bb0\u5f55\uff0c\u4ecd\u7f3a\u5c11\u54ea\u7c7b\u4fe1\u606f\u201d\u3002`,
        '\u4e0d\u8981\u628a\u672c\u5730\u6587\u4ef6\u641c\u7d22\u7ed3\u679c\u8bef\u5f53\u6210\u7fa4\u804a\u8bb0\u5f55\uff0c\u4e0d\u8981\u7f16\u9020\u804a\u5929\u5185\u5bb9\u3002',
        '\u5982\u679c\u7fa4\u804a\u5386\u53f2\u4e2d\u5df2\u7ecf\u51fa\u73b0\u4e86\u660e\u786e\u7684\u82f1\u6587\u6807\u8bc6\u3001\u8d44\u6e90\u540d\u3001\u914d\u7f6e\u540d\u3001ID\u3001token \u6216\u4ee3\u7801\u98ce\u683c\u547d\u540d\uff0c\u5fc5\u987b\u4f18\u5148\u539f\u6837\u4fdd\u7559\uff0c\u4e0d\u8981\u81ea\u5df1\u6539\u5199\u6210\u53e6\u4e00\u79cd\u683c\u5f0f\u3002',
        '',
        '=== \u76f8\u5173\u7fa4\u804a\u8bb0\u5f55\u5f00\u59cb ===',
        formattedHistory,
        '=== \u76f8\u5173\u7fa4\u804a\u8bb0\u5f55\u7ed3\u675f ===',
        '',
        `\u7528\u6237\u5f53\u524d\u8bf7\u6c42\uff1a${intent.taskPrompt}`,
      ].join('\n');
    }

    return [
      `\u8bf7\u57fa\u4e8e\u4e0b\u9762\u63d0\u4f9b\u7684 ${scopeText} \u56de\u7b54\u7528\u6237\u8bf7\u6c42\u3002`,
      '\u8981\u6c42\uff1a\u76f4\u63a5\u7ed9\u51fa\u7ed3\u8bba\u548c\u6458\u8981\uff0c\u5c11\u8bb2\u8fc7\u7a0b\uff0c\u4e0d\u8981\u8ba9\u7528\u6237\u91cd\u590d\u8d34\u8bb0\u5f55\u3002',
      '\u5982\u679c\u4fe1\u606f\u4e0d\u5b8c\u6574\uff0c\u53ef\u4ee5\u5728\u7ed3\u5c3e\u7528\u4e00\u53e5\u8bdd\u7b80\u77ed\u8bf4\u660e\u8fb9\u754c\uff0c\u4f46\u4e0d\u8981\u628a\u6574\u6bb5\u56de\u7b54\u5199\u6210\u62d2\u7b54\u6216\u514d\u8d23\u58f0\u660e\u3002',
      '\u4e0d\u8981\u7f16\u9020\u672a\u51fa\u73b0\u7684\u5185\u5bb9\uff0c\u4e5f\u4e0d\u8981\u8bf4\u201c\u6211\u73b0\u5728\u770b\u4e0d\u5230\u672c\u7fa4\u8bb0\u5f55\u201d\u4e4b\u7c7b\u7684\u6cdb\u5316\u5e9f\u8bdd\uff1b\u4f60\u73b0\u5728\u770b\u5230\u7684\u5c31\u662f\u4e0b\u9762\u8fd9\u6bb5\u5386\u53f2\u3002',
      '',
      '=== \u7fa4\u804a\u5386\u53f2\u5f00\u59cb ===',
      formattedHistory,
      '=== \u7fa4\u804a\u5386\u53f2\u7ed3\u675f ===',
      '',
      `\u7528\u6237\u5f53\u524d\u8bf7\u6c42\uff1a${intent.taskPrompt}`,
    ].join('\n');
  }

  private matchesHistorySpeakerV2(
    item: FeishuMessageListItem,
    memberNames: Map<string, string>,
    targetSpeakerNames: string[],
  ): boolean {
    const senderId = item.sender?.id?.trim() || '';
    const senderName = (senderId && memberNames.get(senderId)?.trim()) || '';
    const speakerCandidates = [senderName, senderId].filter(Boolean);
    return targetSpeakerNames.some((target) =>
      speakerCandidates.some((candidate) => candidate === target || candidate.includes(target) || target.includes(candidate)),
    );
  }

  private isNamingContextItemV2(item: FeishuMessageListItem): boolean {
    const content = item.body?.content || '';
    const namingHints = /(\u82f1\u6587\u540d|\u547d\u540d|\u8d77\u540d|\u683c\u5f0f|\u6807\u8bc6|\u914d\u7f6e\u540d|\u8d44\u6e90\u540d|token|id)/i.test(content);
    const codeLikeTokens = this.extractCodeLikeTokensV2(content);
    return namingHints || codeLikeTokens.length > 0;
  }

  private extractCodeLikeTokensV2(text: string): string[] {
    const tokens = new Set<string>();
    const patterns = [
      /\b[A-Za-z]+(?:_[A-Za-z0-9]+){1,}\b/g,
      /\b[A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+){1,}\b/g,
      /\b[a-z]+(?:[A-Z][A-Za-z0-9]+){1,}\b/g,
      /`([^`\r\n]{2,80})`/g,
    ];

    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const token = (match[1] || match[0] || '').trim();
        if (token.length >= 3 && token.length <= 80) {
          tokens.add(token);
        }
      }
    }

    return [...tokens];
  }

  private mergeHistoryItemsV2(
    primary: FeishuMessageListItem[],
    secondary: FeishuMessageListItem[],
  ): FeishuMessageListItem[] {
    const merged = new Map<string, FeishuMessageListItem>();
    for (const item of [...primary, ...secondary]) {
      merged.set(item.message_id, item);
    }
    return [...merged.values()].sort((a, b) => Number.parseInt(a.create_time, 10) - Number.parseInt(b.create_time, 10));
  }

  private parseHistoryIntent(text: string): FeishuHistoryIntent | null {
    const normalized = text.replace(/\s+/g, '');
    const wantsSummary = /(总结|汇总|整理|梳理|概括|归纳|回顾|提炼|提取)/.test(normalized);
    const mentionsHistory = /(群聊|聊天|对话|消息|记录|讨论|内容)/.test(normalized);
    const timeScoped = /(最近|近\d+条|近\d+则|今天|今日|昨天|昨日|前天|上午|下午|晚上|完整|全部)/.test(normalized);
    const wantsDoc = /(飞书文档|文档链接|生成.*文档|整理成.*文档|输出到.*文档|发链接|回链接)/.test(normalized);

    if ((!wantsSummary && !wantsDoc) || (!mentionsHistory && !timeScoped && !wantsDoc)) {
      return null;
    }

    const countMatch = text.match(/(\d{1,3})\s*(条|则|段|个)/);
    const requestedCount = countMatch ? Number.parseInt(countMatch[1], 10) : undefined;
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTomorrow = new Date(startOfToday);
    startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    const startOfDayBeforeYesterday = new Date(startOfToday);
    startOfDayBeforeYesterday.setDate(startOfDayBeforeYesterday.getDate() - 2);

    let startTimeMs: number | undefined;
    let endTimeMs: number | undefined;
    let scopeText = '本群最近消息';

    if (/(昨天|昨日)/.test(normalized)) {
      startTimeMs = startOfYesterday.getTime();
      endTimeMs = startOfToday.getTime();
      scopeText = '本群昨天的聊天记录';
    } else if (/前天/.test(normalized)) {
      startTimeMs = startOfDayBeforeYesterday.getTime();
      endTimeMs = startOfYesterday.getTime();
      scopeText = '本群前天的聊天记录';
    } else if (/(今天|今日)/.test(normalized)) {
      startTimeMs = startOfToday.getTime();
      endTimeMs = startOfTomorrow.getTime();
      scopeText = '本群今天的聊天记录';
    }

    if (startTimeMs !== undefined && /(上午|早上|清晨)/.test(normalized)) {
      const end = new Date(startTimeMs);
      end.setHours(12, 0, 0, 0);
      endTimeMs = end.getTime();
      scopeText = scopeText.replace('聊天记录', '上午聊天记录');
    } else if (startTimeMs !== undefined && /(下午)/.test(normalized)) {
      const start = new Date(startTimeMs);
      start.setHours(12, 0, 0, 0);
      startTimeMs = start.getTime();
      const end = new Date(start);
      end.setHours(18, 0, 0, 0);
      endTimeMs = end.getTime();
      scopeText = scopeText.replace('聊天记录', '下午聊天记录');
    } else if (startTimeMs !== undefined && /(晚上|晚间)/.test(normalized)) {
      const start = new Date(startTimeMs);
      start.setHours(18, 0, 0, 0);
      startTimeMs = start.getTime();
      scopeText = scopeText.replace('聊天记录', '晚上聊天记录');
    }

    const wantsFull = /(完整|全部|所有)/.test(normalized);
    const defaultLimit = startTimeMs !== undefined ? 100 : 30;
    const limit = Math.max(5, Math.min(requestedCount ?? (wantsFull ? 100 : defaultLimit), 100));
    const responseMode: 'chat' | 'doc' = wantsDoc ? 'doc' : 'chat';
    const docTitle = undefined;

    return {
      originalPrompt: text,
      taskPrompt: text,
      limit,
      startTimeMs,
      endTimeMs,
      scopeText,
      responseMode,
      docTitle,
    };
  }

  private async buildHistoryAugmentedPrompt(
    chatId: string,
    currentMessageId: string,
    intent: FeishuHistoryIntent,
  ): Promise<string> {
    const [recentMessages, memberNames] = await Promise.all([
      this.fetchRecentMessages(chatId, 100),
      this.fetchChatMemberNames(chatId),
    ]);

    const historyItems = recentMessages
      .filter((item) => !item.deleted)
      .filter((item) => item.msg_type !== 'system')
      .filter((item) => item.sender?.sender_type !== 'app')
      .filter((item) => item.message_id !== currentMessageId)
      .filter((item) => {
        const ts = Number.parseInt(item.create_time, 10);
        if (intent.startTimeMs !== undefined && ts < intent.startTimeMs) return false;
        if (intent.endTimeMs !== undefined && ts >= intent.endTimeMs) return false;
        return true;
      })
      .slice(0, intent.limit)
      .reverse();

    const formattedHistory = historyItems
      .map((item) => this.formatHistoryItem(item, memberNames))
      .filter(Boolean)
      .join('\n');

    if (!formattedHistory) {
      return [
        `用户当前请求：${intent.taskPrompt}`,
        '',
        '说明：我已尝试读取群聊历史，但当前没有拿到可用于总结的有效消息。请直接告诉用户这次没读到内容，并给出最短下一步建议。',
      ].join('\n');
    }

    const scopeText = `${intent.scopeText}中最近筛出的 ${historyItems.length} 条可读消息`;

    if (intent.responseMode === 'doc') {
      return [
        `请基于下面提供的 ${scopeText}，生成一份适合直接写入飞书文档的 Markdown 正文。`,
        '要求：',
        '1. 第一行必须是一级标题。',
        '2. 正文默认包含“结论摘要”“关键事实”“执行结果”“问题与风险”“后续待办”五个部分；如果某部分确实为空，也要如实写明。',
        '3. 这是飞书文档正文，不是聊天记录导出。不要按时间线逐条复述，不要保留“用户A：...”这种原始聊天流水，除非它是必要证据。',
        '4. 如果历史里出现失败、空白截图、错误替代方案或未完成事项，必须写入“问题与风险”，不能包装成成功。',
        '5. 只输出文档正文本身，不要写“下面是”“已为你生成”“请查收”等客套句。',
        '6. 不要输出代码块，不要编造群里没有出现的信息。',
        '',
        '=== 群聊历史开始 ===',
        formattedHistory,
        '=== 群聊历史结束 ===',
        '',
        `用户当前请求：${intent.taskPrompt}`,
      ].join('\n');
    }

    return [
      `请基于下面提供的 ${scopeText} 回答用户请求。`,
      '要求：直接给出结论和摘要，少讲过程，不要让用户重复贴记录。',
      '如果信息不完整，可以在结尾用一句话简短说明边界，但不要把整段回答写成拒答或免责声明。',
      '不要编造未出现的内容，也不要说“我现在看不到本群记录”之类的泛化废话；你现在看到的就是下面这段历史。',
      '',
      '=== 群聊历史开始 ===',
      formattedHistory,
      '=== 群聊历史结束 ===',
      '',
      `用户当前请求：${intent.taskPrompt}`,
    ].join('\n');
  }

  private buildHistoryDocumentTitle(scopeText: string, now: Date): string {
    const timeLabel = new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now).replace(/[/:]/g, '-');
    const scopeLabel = scopeText.replace(/^本群/, '').replace(/的聊天记录$/, '').replace(/最近消息$/, '最近消息');
    return `群聊总结-${scopeLabel}-${timeLabel}`;
  }

  private async fetchRecentMessages(chatId: string, limit: number): Promise<FeishuMessageListItem[]> {
    const allItems: FeishuMessageListItem[] = [];
    let pageToken = '';

    while (allItems.length < limit) {
      const { items, hasMore, nextPageToken } = await this.fetchMessagePage(
        chatId,
        pageToken,
        Math.max(1, Math.min(limit - allItems.length, 50)),
      );
      allItems.push(...items);
      if (!hasMore || !nextPageToken || items.length === 0) {
        break;
      }
      pageToken = nextPageToken;
    }

    return allItems.slice(0, limit);
  }

  private async fetchMessagePage(
    chatId: string,
    pageToken: string,
    pageSize: number,
  ): Promise<{ items: FeishuMessageListItem[]; hasMore: boolean; nextPageToken: string }> {
    const { appId, appSecret, baseUrl } = this.getAuthContext();
    const tenantAccessToken = await this.fetchTenantAccessToken(appId, appSecret, baseUrl);
    const url = new URL('/open-apis/im/v1/messages', baseUrl);
    url.searchParams.set('container_id_type', 'chat');
    url.searchParams.set('container_id', chatId);
    url.searchParams.set('page_size', String(Math.max(1, Math.min(pageSize, 50))));
    url.searchParams.set('sort_type', 'ByCreateTimeDesc');
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    const payload = await response.json() as {
      code?: number;
      msg?: string;
      data?: {
        items?: FeishuMessageListItem[];
        has_more?: boolean;
        page_token?: string;
      };
    };

    if (!response.ok || payload.code !== 0) {
      throw new Error(`Feishu message.list failed [${payload.code ?? response.status}]: ${payload.msg || response.statusText}`);
    }

    return {
      items: payload.data?.items ?? [],
      hasMore: !!payload.data?.has_more,
      nextPageToken: payload.data?.page_token || '',
    };
  }

  private async fetchChatMemberNames(chatId: string): Promise<Map<string, string>> {
    const { appId, appSecret, baseUrl } = this.getAuthContext();
    const tenantAccessToken = await this.fetchTenantAccessToken(appId, appSecret, baseUrl);
    const names = new Map<string, string>();
    let pageToken = '';

    while (true) {
      const url = new URL(`/open-apis/im/v1/chats/${chatId}/members`, baseUrl);
      url.searchParams.set('member_id_type', 'open_id');
      url.searchParams.set('page_size', '50');
      if (pageToken) {
        url.searchParams.set('page_token', pageToken);
      }

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tenantAccessToken}`,
        },
        signal: AbortSignal.timeout(10_000),
      });

      const payload = await response.json() as {
        code?: number;
        msg?: string;
        data?: {
          items?: FeishuChatMemberItem[];
          has_more?: boolean;
          page_token?: string;
        };
      };

      if (!response.ok || payload.code !== 0) {
        throw new Error(`Feishu chats.members failed [${payload.code ?? response.status}]: ${payload.msg || response.statusText}`);
      }

      for (const item of payload.data?.items ?? []) {
        const memberId = item.member_id?.trim();
        const memberName = item.name?.trim();
        if (memberId && memberName) {
          names.set(memberId, memberName);
        }
      }

      if (!payload.data?.has_more || !payload.data.page_token) {
        break;
      }
      pageToken = payload.data.page_token;
    }

    return names;
  }

  private getAuthContext(): { appId: string; appSecret: string; baseUrl: string } {
    const store = getBridgeContext().store;
    const appId = store.getSetting('bridge_feishu_app_id') || '';
    const appSecret = store.getSetting('bridge_feishu_app_secret') || '';
    const domainSetting = store.getSetting('bridge_feishu_domain') || 'https://open.feishu.cn';
    const baseUrl = domainSetting.includes('larksuite')
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';

    if (!appId || !appSecret) {
      throw new Error('Feishu app credentials are not configured');
    }

    return { appId, appSecret, baseUrl };
  }

  private async fetchTenantAccessToken(appId: string, appSecret: string, baseUrl: string): Promise<string> {
    const tokenRes = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenData = await tokenRes.json() as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
    };

    if (!tokenRes.ok || !tokenData.tenant_access_token) {
      throw new Error(`Failed to get tenant access token: ${tokenData.msg || tokenRes.statusText}`);
    }

    return tokenData.tenant_access_token;
  }

  async createDocumentFromMarkdown(
    markdown: string,
    options?: FeishuDocumentOptions,
  ): Promise<{ documentId: string; title: string; url: string }> {
    const normalizedMarkdown = markdown.trim();
    if (!normalizedMarkdown) {
      throw new Error('没有可写入飞书文档的正文内容');
    }
    this.assertDocumentTextEncodingSafe(normalizedMarkdown);

    const { appId, appSecret, baseUrl } = this.getAuthContext();
    const tenantAccessToken = await this.fetchTenantAccessToken(appId, appSecret, baseUrl);
    const title = options?.title?.trim() || this.deriveDocumentTitleFromMarkdown(normalizedMarkdown);

    const createResponse = await fetch(`${baseUrl}/open-apis/docx/v1/documents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(10_000),
    });

    const createPayload = await createResponse.json() as {
      code?: number;
      msg?: string;
      data?: { document?: { document_id?: string; title?: string } };
    };

    const documentId = createPayload.data?.document?.document_id;
    if (!createResponse.ok || createPayload.code !== 0 || !documentId) {
      throw new Error(`Feishu docx.document.create failed [${createPayload.code ?? createResponse.status}]: ${createPayload.msg || createResponse.statusText}`);
    }

    const children = this.markdownToDocumentBlocks(normalizedMarkdown);
    const chunkSize = 20;
    for (let index = 0; index < children.length; index += chunkSize) {
      const chunk = children.slice(index, index + chunkSize);
      const blockResponse = await fetch(`${baseUrl}/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ children: chunk }),
        signal: AbortSignal.timeout(10_000),
      });

      const blockPayload = await blockResponse.json() as {
        code?: number;
        msg?: string;
      };

      if (!blockResponse.ok || blockPayload.code !== 0) {
        throw new Error(`Feishu docx.document.block.children.create failed [${blockPayload.code ?? blockResponse.status}]: ${blockPayload.msg || blockResponse.statusText}`);
      }
    }

    const url = baseUrl.includes('larksuite')
      ? `https://www.larksuite.com/docx/${documentId}`
      : `https://www.feishu.cn/docx/${documentId}`;

    if (options?.ownerUserId) {
      await this.grantDocumentEditPermissionBestEffort(documentId, options.ownerUserId, tenantAccessToken, baseUrl);
    }

    return {
      documentId,
      title: createPayload.data?.document?.title || title,
      url,
    };
  }

  async replaceDocumentFromMarkdown(
    documentId: string,
    markdown: string,
    options?: FeishuDocumentOptions,
  ): Promise<{ documentId: string; title: string; url: string }> {
    const normalizedMarkdown = markdown.trim();
    if (!documentId.trim()) {
      throw new Error('Missing Feishu document ID');
    }
    if (!normalizedMarkdown) {
      throw new Error('没有可写入飞书文档的正文内容');
    }
    this.assertDocumentTextEncodingSafe(normalizedMarkdown);

    const { appId, appSecret, baseUrl } = this.getAuthContext();
    const tenantAccessToken = await this.fetchTenantAccessToken(appId, appSecret, baseUrl);

    const listResponse = await fetch(`${baseUrl}/open-apis/docx/v1/documents/${documentId}/blocks`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tenantAccessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const listPayload = await listResponse.json() as {
      code?: number;
      msg?: string;
      data?: { items?: Array<{ block_id?: string; children?: string[] }> };
    };
    if (!listResponse.ok || listPayload.code !== 0) {
      throw new Error(`Feishu docx.document.blocks.list failed [${listPayload.code ?? listResponse.status}]: ${listPayload.msg || listResponse.statusText}`);
    }

    const rootBlock = (listPayload.data?.items || []).find((item) => item.block_id === documentId)
      || listPayload.data?.items?.[0];
    const childCount = rootBlock?.children?.length || 0;
    if (childCount > 0) {
      const deleteResponse = await fetch(`${baseUrl}/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children/batch_delete`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${tenantAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ start_index: 0, end_index: childCount }),
        signal: AbortSignal.timeout(10_000),
      });
      const deletePayload = await deleteResponse.json() as { code?: number; msg?: string };
      if (!deleteResponse.ok || deletePayload.code !== 0) {
        throw new Error(`Feishu docx.document.block.children.batch_delete failed [${deletePayload.code ?? deleteResponse.status}]: ${deletePayload.msg || deleteResponse.statusText}`);
      }
    }

    const children = this.markdownToDocumentBlocks(normalizedMarkdown);
    const chunkSize = 20;
    for (let index = 0; index < children.length; index += chunkSize) {
      const chunk = children.slice(index, index + chunkSize);
      const blockResponse = await fetch(`${baseUrl}/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ children: chunk }),
        signal: AbortSignal.timeout(10_000),
      });
      const blockPayload = await blockResponse.json() as { code?: number; msg?: string };
      if (!blockResponse.ok || blockPayload.code !== 0) {
        throw new Error(`Feishu docx.document.block.children.create failed [${blockPayload.code ?? blockResponse.status}]: ${blockPayload.msg || blockResponse.statusText}`);
      }
    }

    if (options?.ownerUserId) {
      await this.grantDocumentEditPermissionBestEffort(documentId, options.ownerUserId, tenantAccessToken, baseUrl);
    }

    const title = options?.title?.trim() || this.deriveDocumentTitleFromMarkdown(normalizedMarkdown);
    const url = baseUrl.includes('larksuite')
      ? `https://www.larksuite.com/docx/${documentId}`
      : `https://www.feishu.cn/docx/${documentId}`;
    return { documentId, title, url };
  }

  private deriveDocumentTitleFromMarkdown(markdown: string): string {
    const heading = markdown
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^#\s+/.test(line));
    if (heading) {
      return heading.replace(/^#\s+/, '').slice(0, 80);
    }
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    return `群聊总结 ${now}`;
  }

  private async grantDocumentEditPermissionBestEffort(
    documentId: string,
    ownerUserId: string,
    tenantAccessToken: string,
    baseUrl: string,
  ): Promise<void> {
    const memberId = ownerUserId.trim();
    if (!memberId) return;

    try {
      const response = await fetch(`${baseUrl}/open-apis/drive/v1/permissions/${documentId}/members?type=docx`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          member_type: 'openid',
          member_id: memberId,
          perm: 'edit',
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const payload = await response.json() as { code?: number; msg?: string };
      if (!response.ok || payload.code !== 0) {
        console.warn(`[feishu-adapter] Document permission grant skipped [${payload.code ?? response.status}]: ${payload.msg || response.statusText}`);
      }
    } catch (err) {
      console.warn('[feishu-adapter] Document permission grant skipped:', err instanceof Error ? err.message : err);
    }
  }

  private markdownToDocumentBlocks(markdown: string): Array<Record<string, unknown>> {
    const lines = markdown
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd());
    const blocks: Array<Record<string, unknown>> = [];
    let paragraphBuffer: string[] = [];

    const flushParagraph = () => {
      const merged = paragraphBuffer
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' ');
      paragraphBuffer = [];
      if (!merged) return;
      blocks.push(this.buildDocumentTextBlock(this.normalizeDocumentText(merged)));
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        flushParagraph();
        continue;
      }

      const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
      if (headingMatch) {
        flushParagraph();
        const level = headingMatch[1].length;
        const content = this.normalizeDocumentText(headingMatch[2]);
        blocks.push(this.buildDocumentHeadingBlock(level, content));
        continue;
      }

      const bulletMatch = line.match(/^[-*]\s+(.*)$/);
      if (bulletMatch) {
        flushParagraph();
        blocks.push(this.buildDocumentTextBlock(`• ${this.normalizeDocumentText(bulletMatch[1])}`));
        continue;
      }

      const orderedMatch = line.match(/^(\d+)\.\s+(.*)$/);
      if (orderedMatch) {
        flushParagraph();
        blocks.push(this.buildDocumentTextBlock(`${orderedMatch[1]}. ${this.normalizeDocumentText(orderedMatch[2])}`));
        continue;
      }

      paragraphBuffer.push(line);
    }

    flushParagraph();

    if (blocks.length === 0) {
      blocks.push(this.buildDocumentTextBlock(this.normalizeDocumentText(markdown)));
    }

    return blocks;
  }

  private buildDocumentHeadingBlock(level: number, content: string): Record<string, unknown> {
    const normalizedLevel = Math.max(1, Math.min(level, 3));
    const blockKey = normalizedLevel === 1 ? 'heading1' : normalizedLevel === 2 ? 'heading2' : 'heading3';
    const blockType = normalizedLevel === 1 ? 3 : normalizedLevel === 2 ? 4 : 5;
    return {
      block_type: blockType,
      [blockKey]: {
        elements: [
          {
            text_run: {
              content,
            },
          },
        ],
      },
    };
  }

  private buildDocumentTextBlock(content: string): Record<string, unknown> {
    return {
      block_type: 2,
      text: {
        elements: [
          {
            text_run: {
              content,
            },
          },
        ],
      },
    };
  }

  private normalizeDocumentText(text: string): string {
    return text
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)')
      .replace(/[`*_~>#]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private assertDocumentTextEncodingSafe(text: string): void {
    const hasQuestionReplacementRun = /\?{4,}/.test(text);
    const hasMojibakeRun = /(?:鈥|鉁|涓|竴|缇|鎬|妗|鍐|櫒|鐢|鏈|棿|啓|涔|堕){2,}/.test(text);

    if (hasQuestionReplacementRun || hasMojibakeRun) {
      throw new Error(
        '飞书文档正文疑似已发生编码损坏。请使用 UTF-8 文件或 Buffer 输入，不要把中文 JSON 通过 PowerShell 命令字符串或 stdin 传入。',
      );
    }
  }

  private formatHistoryItem(item: FeishuMessageListItem, memberNames?: Map<string, string>): string {
    const timestamp = Number.parseInt(item.create_time, 10);
    const timeLabel = Number.isFinite(timestamp)
      ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '未知时间';
    const senderType = item.sender?.sender_type || 'unknown';
    const senderId = item.sender?.id || '';
    const resolvedSenderName = senderId ? memberNames?.get(senderId) : '';
    const senderLabel = senderType === 'app'
      ? '机器人'
      : `用户(${senderId.slice(-6) || 'unknown'})`;
    const resolvedSenderLabel = senderType === 'app'
      ? '机器人'
      : (resolvedSenderName || senderLabel);
    const messageText = this.extractHistoryText(item);

    if (!messageText) {
      return '';
    }

    return `[${timeLabel}] ${resolvedSenderLabel}: ${messageText}`;
  }

  private extractHistoryText(item: FeishuMessageListItem): string {
    const content = item.body?.content || '';
    switch (item.msg_type) {
      case 'text':
        return this.parseTextContent(content).replace(/\s+/g, ' ').trim();
      case 'post':
        return this.parsePostContent(content).extractedText.replace(/\s+/g, ' ').trim();
      case 'image':
        return '[图片]';
      case 'file':
        return '[文件]';
      case 'audio':
        return '[语音]';
      case 'video':
      case 'media':
        return '[视频]';
      case 'interactive':
        return '[卡片消息]';
      default:
        return `[${item.msg_type}]`;
    }
  }

  async sendLocalImage(chatId: string, filePath: string, replyToMessageId?: string): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    try {
      if (!fs.existsSync(filePath)) {
        return { ok: false, error: `Image file not found: ${filePath}` };
      }

      const uploadRes = await this.restClient.im.image.create({
        data: {
          image_type: 'message',
          image: fs.createReadStream(filePath),
        },
      });

      const imageKey = uploadRes?.image_key;
      if (!imageKey) {
        return { ok: false, error: 'Feishu image upload did not return image_key' };
      }

      const sendRes = replyToMessageId
        ? await this.restClient.im.message.reply({
            path: { message_id: replyToMessageId },
            data: {
              msg_type: 'image',
              content: JSON.stringify({ image_key: imageKey }),
            },
          })
        : await this.restClient.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'image',
              content: JSON.stringify({ image_key: imageKey }),
            },
          });

      if (sendRes?.data?.message_id) {
        return { ok: true, messageId: sendRes.data.message_id };
      }
      return { ok: false, error: `Feishu image send failed: ${sendRes?.msg || 'unknown error'}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private toHistoryReadErrorMessage(errorMessage: string): string {
    if (errorMessage.includes('im:message.group_msg')) {
      return '读取本群历史失败：缺少飞书权限 `im:message.group_msg`。请在应用权限里添加该 scope，并重新发布审核通过后再试。';
    }
    return `读取本群历史失败：${errorMessage}`;
  }

  // ── Bot identity ────────────────────────────────────────────

  /**
   * Resolve bot identity via the Feishu REST API /bot/v3/info/.
   * Collects all available bot IDs for comprehensive mention matching.
   */
  private async resolveBotIdentity(
    appId: string,
    appSecret: string,
    domain: lark.Domain,
  ): Promise<void> {
    try {
      const baseUrl = domain === lark.Domain.Lark
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn';

      const tokenRes = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(10_000),
      });
      const tokenData: any = await tokenRes.json();
      if (!tokenData.tenant_access_token) {
        console.warn('[feishu-adapter] Failed to get tenant access token');
        return;
      }

      const botRes = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const botData: any = await botRes.json();
      if (botData?.bot?.open_id) {
        this.botOpenId = botData.bot.open_id;
        this.botIds.add(botData.bot.open_id);
      }
      // Also record app_id-based IDs if available
      if (botData?.bot?.bot_id) {
        this.botIds.add(botData.bot.bot_id);
      }
      if (!this.botOpenId) {
        console.warn('[feishu-adapter] Could not resolve bot open_id');
      }
    } catch (err) {
      console.warn(
        '[feishu-adapter] Failed to resolve bot identity:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── @Mention detection ──────────────────────────────────────

  /**
   * [P2] Check if bot is mentioned — matches against open_id, user_id, union_id.
   */
  private isBotMentioned(
    mentions?: FeishuMessageEventData['message']['mentions'],
  ): boolean {
    if (!mentions || this.botIds.size === 0) return false;
    return mentions.some((m) => {
      const ids = [m.id.open_id, m.id.user_id, m.id.union_id].filter(Boolean) as string[];
      return ids.some((id) => this.botIds.has(id));
    });
  }

  private stripMentionMarkers(text: string): string {
    // Feishu uses @_user_N placeholders for mentions
    return text.replace(/@_user_\d+/g, '').trim();
  }

  // ── Resource download ───────────────────────────────────────

  /**
   * Download a message resource (image/file/audio/video) via SDK.
   * Returns null on failure (caller decides fallback behavior).
   */
  private async downloadResource(
    messageId: string,
    fileKey: string,
    resourceType: string,
  ): Promise<FileAttachment | null> {
    if (!this.restClient) return null;

    try {
      console.log(`[feishu-adapter] Downloading resource: type=${resourceType}, key=${fileKey}, msgId=${messageId}`);

      const res = await this.restClient.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type: resourceType === 'image' ? 'image' : 'file',
        },
      });

      if (!res) {
        console.warn('[feishu-adapter] messageResource.get returned null/undefined');
        return null;
      }

      // SDK returns { writeFile, getReadableStream, headers }
      // Try stream approach first, fall back to writeFile + read if stream fails
      let buffer: Buffer;

      try {
        const readable = res.getReadableStream();
        const chunks: Buffer[] = [];
        let totalSize = 0;

        for await (const chunk of readable) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalSize += buf.length;
          if (totalSize > MAX_FILE_SIZE) {
            console.warn(`[feishu-adapter] Resource too large (>${MAX_FILE_SIZE} bytes), key: ${fileKey}`);
            return null;
          }
          chunks.push(buf);
        }
        buffer = Buffer.concat(chunks);
      } catch (streamErr) {
        // Stream approach failed — fall back to writeFile + read
        console.warn('[feishu-adapter] Stream read failed, falling back to writeFile:', streamErr instanceof Error ? streamErr.message : streamErr);

        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        const tmpPath = path.join(os.tmpdir(), `feishu-dl-${crypto.randomUUID()}`);
        try {
          await res.writeFile(tmpPath);
          buffer = fs.readFileSync(tmpPath);
          if (buffer.length > MAX_FILE_SIZE) {
            console.warn(`[feishu-adapter] Resource too large (>${MAX_FILE_SIZE} bytes), key: ${fileKey}`);
            return null;
          }
        } finally {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
        }
      }

      if (!buffer || buffer.length === 0) {
        console.warn('[feishu-adapter] Downloaded resource is empty, key:', fileKey);
        return null;
      }

      const base64 = buffer.toString('base64');
      const id = crypto.randomUUID();
      const mimeType = MIME_BY_TYPE[resourceType] || 'application/octet-stream';
      const ext = resourceType === 'image' ? 'png'
        : resourceType === 'audio' ? 'ogg'
        : resourceType === 'video' ? 'mp4'
        : 'bin';

      console.log(`[feishu-adapter] Resource downloaded: ${buffer.length} bytes, key=${fileKey}`);

      return {
        id,
        name: `${fileKey}.${ext}`,
        type: mimeType,
        size: buffer.length,
        data: base64,
      };
    } catch (err) {
      console.error(
        `[feishu-adapter] Resource download failed (type=${resourceType}, key=${fileKey}):`,
        err instanceof Error ? err.stack || err.message : err,
      );
      return null;
    }
  }

  // ── Utilities ───────────────────────────────────────────────

  private addToDedup(messageId: string): void {
    this.seenMessageIds.set(messageId, true);

    // LRU eviction: remove oldest entries when exceeding limit
    if (this.seenMessageIds.size > DEDUP_MAX) {
      const excess = this.seenMessageIds.size - DEDUP_MAX;
      let removed = 0;
      for (const key of this.seenMessageIds.keys()) {
        if (removed >= excess) break;
        this.seenMessageIds.delete(key);
        removed++;
      }
    }
  }
}

// Self-register so bridge-manager can create FeishuAdapter via the registry.
registerAdapterFactory('feishu', () => new FeishuAdapter());
