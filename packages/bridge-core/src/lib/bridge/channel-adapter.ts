/**
 * Abstract base class for IM channel adapters.
 *
 * Each adapter (Telegram, Discord, Slack, ...) extends this class to provide
 * platform-specific message consumption and delivery.
 */

import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
  UploadedFileLink,
  VerifiedMediaAction,
} from './types.js';

export interface AdapterAssistantIdentity {
  displayName?: string;
  platform?: string;
  appId?: string;
  botOpenId?: string;
  /** 官方平台返回的当前机器人头像地址，仅用于构造受控视觉证据。 */
  avatarUrl?: string;
}

export interface DirectMessageRequest {
  sourceMessage: InboundMessage;
  targetText: string;
  text: string;
  parseMode?: OutboundMessage['parseMode'];
  /** 本轮 bridge 基于真实附件和模型精确选择签发的媒体许可。 */
  verifiedMediaAction?: VerifiedMediaAction;
}

export interface DirectMessageSendResult extends SendResult {
  targetDisplayName?: string;
  targetUserId?: string;
}

export type ConversationTargetKind = 'chat' | 'user';

export interface ConversationTargetResolveRequest {
  sourceMessage: InboundMessage;
  targetText?: string;
  targetId?: string;
  targetKind?: ConversationTargetKind | 'any';
}

export interface ResolvedConversationTarget {
  kind: ConversationTargetKind;
  id: string;
  displayName: string;
  chatType?: string;
  userId?: string;
}

export interface ConversationTargetResolveResult {
  ok: boolean;
  target?: ResolvedConversationTarget;
  error?: string;
  candidates?: Array<{ id: string; displayName: string; kind: ConversationTargetKind; chatType?: string }>;
}

export interface ConversationMessageRequest {
  sourceMessage: InboundMessage;
  target: ResolvedConversationTarget;
  text: string;
  parseMode?: OutboundMessage['parseMode'];
}

export interface ConversationMessageSendResult extends SendResult {
  targetDisplayName?: string;
  targetId?: string;
  targetKind?: ConversationTargetKind;
}

export interface OutboundMentionResolutionCandidate {
  name: string;
  aliases?: string[];
}

export interface OutboundMentionResolutionInspection {
  target: string;
  status: 'resolved' | 'ambiguous' | 'not_found' | 'lookup_failed';
  searchedSources: string[];
  candidates: OutboundMentionResolutionCandidate[];
  error?: string;
}

export interface OutboundMentionIdentityVerification {
  status: 'verified' | 'not_found' | 'lookup_failed' | 'unavailable';
  /** 平台确认后的最新显示名；身份仍以 caller 提供的真实 evidence ID 为准。 */
  name?: string;
  error?: string;
}

export abstract class BaseChannelAdapter {
  /** Which channel type this adapter handles */
  abstract readonly channelType: ChannelType;

  /**
   * Start the adapter (connect, begin polling/websocket, etc.).
   * Must be idempotent — calling start() on an already-running adapter is a no-op.
   */
  abstract start(): Promise<void>;

  /**
   * Stop the adapter gracefully.
   * Must be idempotent — calling stop() on an already-stopped adapter is a no-op.
   */
  abstract stop(): Promise<void>;

  /** Whether the adapter is currently running and consuming messages */
  abstract isRunning(): boolean;

  /**
   * Consume the next inbound message from the internal queue.
   * Blocks until a message is available or the adapter is stopped.
   * Returns null if the adapter was stopped while waiting.
   */
  abstract consumeOne(): Promise<InboundMessage | null>;

  /**
   * Send an outbound message to the channel.
   * Handles platform-specific formatting and API calls.
   */
  abstract send(message: OutboundMessage): Promise<SendResult>;

  /**
   * Send a local image file to the channel when the adapter supports outbound media.
   * Default implementation is unsupported.
   */
  async sendLocalImage(_chatId: string, _filePath: string, _replyToMessageId?: string): Promise<SendResult> {
    return { ok: false, error: 'Local image sending is not supported by this adapter' };
  }

  /**
   * Send a local file to the channel when the adapter supports outbound files.
   * Default implementation is unsupported.
   */
  async sendLocalFile(_chatId: string, _filePath: string, _replyToMessageId?: string): Promise<SendResult> {
    return { ok: false, error: 'Local file sending is not supported by this adapter' };
  }

  /**
   * Upload a local file to a platform-native cloud space and return a share link.
   * Used when the channel cannot deliver the file directly due to size limits.
   */
  async uploadLocalFileForLink(_filePath: string): Promise<UploadedFileLink | null> {
    return null;
  }

  /**
   * Recall/delete a previously sent platform message when the channel supports it.
   * Implementations must only act on platform message IDs already known to belong
   * to this bot; callers are responsible for that ownership check.
   */
  async recallMessage(_chatId: string, _messageId: string): Promise<SendResult> {
    return { ok: false, error: 'Message recall is not supported by this adapter' };
  }

  /**
   * Answer a callback query (e.g. Telegram inline button press).
   * Not all platforms support this — default implementation is a no-op.
   */
  async answerCallback(_callbackQueryId: string, _text?: string): Promise<void> {
    // No-op by default; override in adapters that support callback queries
  }

  /**
   * Validate that the adapter's configuration is complete.
   * Returns null if valid, or an error message string if invalid.
   */
  abstract validateConfig(): string | null;

  /**
   * Check whether a user is authorized to use this bridge.
   * Returns true if authorized, false otherwise.
   */
  abstract isAuthorized(userId: string, chatId: string): boolean;

  /**
   * Return platform-native assistant identity when known.
   * Used only as user-visible persona context; adapters may return partial data.
   */
  getAssistantIdentity?(): AdapterAssistantIdentity | null;

  /** Optional channel-specific presentation hints for model prompts. */
  getEmojiPresentationPrompt?(chatId?: string, userId?: string): string;

  /** Optional channel-specific sticker library hints for model prompts. */
  getStickerPresentationPrompt?(chatId?: string, userId?: string): string;

  /**
   * Store channel-native sticker semantics learned from a model or user.
   * Adapters should treat user-supplied explanations as evidence, not as
   * trusted sendable semantics, until a vision/manual source verifies them.
   * The adapter owns platform identifiers and persistence; callers should pass
   * only sanitized meaning fields plus the source message context.
   */
  recordStickerAnnotation?(_input: {
    fileKey: string;
    chatId: string;
    userId?: string;
    learnedFromMessageId?: string;
    label?: string;
    description?: string;
    intent?: string;
    tone?: string;
    usage?: string;
    avoidWhen?: string;
    aliases?: string[];
    examples?: string[];
    annotationConfidence?: number;
    source?: 'vision' | 'user' | 'manual';
    visionMediaFileKey?: string;
  }): boolean;

  /**
   * Resolve channel-native mentions before final delivery.
   * Adapters can turn user-visible text such as "@name" into structured mention
   * metadata using platform APIs or cached inbound context.
   */
  resolveOutboundMentions?(_message: OutboundMessage, _sourceMessage?: InboundMessage): Promise<OutboundMessage>;

  /**
   * 按本轮真实 evidence 中的平台 ID 验证同群 mention 身份。
   * 该入口避免把强 ID 证据降级成姓名后再反查，也不接受模型自行生成的 ID。
   */
  verifyOutboundMentionIdentity?(
    _message: OutboundMessage,
    _sourceMessage: InboundMessage | undefined,
    _candidate: { userId: string; name: string },
  ): Promise<OutboundMentionIdentityVerification>;

  /**
   * Resolve a return mention to the verified bot/app that sent the current
   * inbound message. This narrow path must not resolve unrelated model names.
   */
  resolveOutboundReplyToSenderMention?(
    _message: OutboundMessage,
    _sourceMessage?: InboundMessage,
  ): Promise<OutboundMessage>;

  /**
   * Explain how a channel-native mention target was resolved or why it was not.
   * Used after normal resolution fails so blockers can say what was searched
   * without exposing platform IDs or raw API payloads.
   */
  inspectOutboundMentionTarget?(
    _message: OutboundMessage,
    _sourceMessage: InboundMessage | undefined,
    _target: string,
  ): Promise<OutboundMentionResolutionInspection>;

  /**
   * Send a controlled one-to-one message resolved from channel context.
   * The model only declares intent; adapters own identity resolution and the
   * platform API call so group replies cannot fake a private delivery.
   */
  sendDirectMessage?(_request: DirectMessageRequest): Promise<DirectMessageSendResult>;

  /**
   * Resolve a cross-conversation target before sending. This lets bridge-manager
   * show the human-readable name and platform ID to the owner for confirmation.
   */
  resolveConversationTarget?(_request: ConversationTargetResolveRequest): Promise<ConversationTargetResolveResult>;

  /**
   * Send to a previously resolved and owner-confirmed conversation target.
   * Callers must not invoke this before confirmation.
   */
  sendConversationMessage?(_request: ConversationMessageRequest): Promise<ConversationMessageSendResult>;

  /** Called when message processing starts (e.g., typing indicator). */
  onMessageStart?(_chatId: string): void;

  /** Called when message processing ends. */
  onMessageEnd?(_chatId: string): void;

  /**
   * Acknowledge that an update has been fully processed.
   * Adapters that defer offset commits until after handleMessage should implement this.
   * Default is a no-op; override in adapters that need deferred offset tracking.
   */
  acknowledgeUpdate?(_updateId: number): void;

  /**
   * Return preview capabilities for a given chat.
   * Returning null means streaming preview is not available for this chat.
   */
  getPreviewCapabilities?(_chatId: string): PreviewCapabilities | null;

  /**
   * Send (or update) a streaming preview draft.
   * Returns 'sent' on success, 'skip' for transient failures (caller should
   * retry later), or 'degrade' for permanent failures (caller should stop).
   */
  sendPreview?(_chatId: string, _text: string, _draftId: number): Promise<'sent' | 'skip' | 'degrade'>;

  /**
   * Signal the end of a preview cycle. The final message is sent via the
   * normal delivery path, so this is typically a no-op.
   */
  endPreview?(_chatId: string, _draftId: number): void;

  /**
   * Called on each text SSE event during streaming. Adapter can use this
   * to update a streaming card in real-time. Only called for adapters
   * that support streaming cards (e.g. Feishu CardKit v2).
   */
  onStreamText?(_chatId: string, _fullText: string): void;

  /**
   * Called when tool_use / tool_result events arrive during streaming.
   * Adapter can use this to display tool progress in the streaming card.
   */
  onToolEvent?(_chatId: string, _tools: import('./types.js').ToolCallInfo[]): void;

  /**
   * Called when streaming ends. Adapter should finalize the streaming card
   * (close streaming mode, add footer, etc.).
   * Returns true if a card was finalized (caller should skip normal delivery).
   */
  onStreamEnd?(
    _chatId: string,
    _status: 'completed' | 'interrupted' | 'error',
    _responseText: string,
    _summary?: import('./types.js').RunSummary,
    _mentions?: import('./types.js').OutboundMention[],
    _verifiedMediaAction?: import('./types.js').VerifiedMediaAction,
    _turnContext?: import('./types.js').StreamingCardTurnContext,
  ): Promise<boolean>;
}

// ── Adapter Registry ────────────────────────────────────────────

const adapterFactories = new Map<string, () => BaseChannelAdapter>();

export function registerAdapterFactory(channelType: string, factory: () => BaseChannelAdapter): void {
  adapterFactories.set(channelType, factory);
}

export function createAdapter(channelType: string): BaseChannelAdapter | null {
  const factory = adapterFactories.get(channelType);
  return factory ? factory() : null;
}

export function getRegisteredTypes(): string[] {
  return Array.from(adapterFactories.keys());
}
