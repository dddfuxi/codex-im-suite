/**
 * Bridge system types — shared across all bridge modules.
 *
 * The bridge connects external IM channels (Telegram, Discord, Slack)
 * to CodePilot chat sessions, allowing users to interact with Claude
 * from their preferred messaging platform.
 */

// Re-export bridge-local types from host.ts so consumers can import from one place
export type { FileAttachment } from './host.js';

// ── Channel Types ──────────────────────────────────────────────

/**
 * Channel type identifier.
 * Extensible — any string is valid so new adapters can register without
 * modifying this definition. Well-known values: 'telegram', 'discord', 'slack'.
 */
export type ChannelType = string;

/** Unique address of a user within a channel */
export interface ChannelAddress {
  channelType: ChannelType;
  chatId: string;        // Platform-specific chat/channel identifier
  userId?: string;       // Platform-specific user identifier (optional for group chats)
  displayName?: string;  // Human-readable name for audit logs
  chatType?: string;     // Platform-specific chat type (group / p2p / etc.)
}

/** Composite key for routing: channelType + chatId */
export interface SessionKey {
  channelType: ChannelType;
  chatId: string;
}

export interface InboundLifecycleControl {
  /**
   * Platform lifecycle event that targets a previously received user message.
   * This is intentionally generic so adapters can map native recall/delete
   * events without bridge-manager depending on platform-specific payloads.
   */
  type: 'message_withdrawn';
  /** Original platform message ID that should no longer be processed. */
  targetMessageId: string;
  reason?: 'recalled' | 'deleted' | 'placeholder' | string;
  /**
   * If true, manager may send a pause notice even when the target was still in
   * an adapter-local queue and therefore has no manager task record yet.
   */
  notifyIfUnknown?: boolean;
}

// ── Messages ───────────────────────────────────────────────────

/** Inbound message from an IM channel */
export interface InboundMessage {
  /** Platform-specific message ID (for dedup and reference) */
  messageId: string;
  /** Address of the sender */
  address: ChannelAddress;
  /** Plain text content of the message */
  text: string;
  /** Structured adapter event kind for non-text messages that still need agent handling. */
  messageKind?: string;
  /** Timestamp of the message (ISO string or unix epoch ms) */
  timestamp: number;
  /** If this is a callback query (inline button press), the callback data */
  callbackData?: string;
  /** For callback queries: the message ID of the original message that triggered the callback */
  callbackMessageId?: string;
  /** Platform-specific raw update object (for adapter-specific handling) */
  raw?: unknown;
  /** Optional platform lifecycle control message, e.g. Feishu recalled event. */
  control?: InboundLifecycleControl;
  /** Adapter-specific update ID for deferred offset acknowledgement */
  updateId?: number;
  /** File attachments (images, documents) from the IM channel */
  attachments?: import('./host.js').FileAttachment[];
  /**
   * Optional second-stage adapter preparation for agent-only evidence.
   *
   * Adapters enqueue the accepted message first, then the bridge awaits this
   * hook after arming user-visible feedback. Implementations may enrich the
   * existing address/raw/attachments objects, but must not change the user's
   * original intent text.
   */
  prepareForAgent?: () => Promise<void>;
}

export interface OutboundMention {
  userId?: string;
  name?: string;
  atAll?: boolean;
}

/**
 * A bridge-owned authorization for one platform-native media delivery.
 *
 * This is deliberately separate from the user-visible reply text: adapters
 * must not treat a model-written marker such as `[表情包:file_key]` as proof
 * that the media is safe to send.
 */
export interface VerifiedMediaAction {
  kind: 'sticker';
  key: string;
  provenance: 'turn_attached_model_selection';
}

/** Outbound message to send to an IM channel */
export interface OutboundMessage {
  /** Target address */
  address: ChannelAddress;
  /** Message text (may contain HTML for Telegram) */
  text: string;
  /** Parse mode for the text */
  parseMode?: 'HTML' | 'Markdown' | 'plain';
  /** Inline keyboard buttons */
  inlineButtons?: InlineButton[][];
  /** If replying to a specific message */
  replyToMessageId?: string;
  /** Optional mentions for channels that support native mention formatting */
  mentions?: OutboundMention[];
  /** Feishu-specific interactive card payload. Non-Feishu adapters ignore it. */
  feishuCardJson?: string;
  /** Bridge-owned proof for an otherwise gated native-media delivery. */
  verifiedMediaAction?: VerifiedMediaAction;
}

/** Inline keyboard button for permission prompts */
export interface InlineButton {
  text: string;
  callbackData: string;
}

/** Result of sending a message via an adapter */
export interface SendResult {
  ok: boolean;
  /** Platform-specific message ID of the sent message */
  messageId?: string;
  /** Platform-specific card ID when the channel returns one. */
  cardId?: string;
  error?: string;
}

export interface UploadedFileLink {
  title: string;
  url: string;
  platform?: string;
  fileToken?: string;
  documentId?: string;
}

// ── Bindings ───────────────────────────────────────────────────

/** Links an IM chat to a CodePilot session */
export interface ChannelBinding {
  id: string;
  channelType: ChannelType;
  chatId: string;
  displayName?: string;
  chatType?: string;
  /** CodePilot session ID this chat is bound to */
  codepilotSessionId: string;
  /** SDK session ID for resume (cached from last conversation) */
  sdkSessionId: string;
  /** Working directory for this binding */
  workingDirectory: string;
  /** Model override for this binding */
  model: string;
  /** Chat mode */
  mode: 'code' | 'plan' | 'ask';
  /** Fingerprint of bridge/session-management code last applied to this binding. */
  bridgeFingerprint?: string;
  /** Fingerprint of tooling/MCP registration last applied to this binding. */
  toolingFingerprint?: string;
  /** Whether this binding is currently active */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Bridge Status ──────────────────────────────────────────────

/** Overall bridge system status */
export interface BridgeStatus {
  running: boolean;
  startedAt: string | null;
  adapters: AdapterStatus[];
}

/** Status of a single channel adapter */
export interface AdapterStatus {
  channelType: ChannelType;
  running: boolean;
  connectedAt: string | null;
  lastMessageAt: string | null;
  error: string | null;
}

// ── Audit & Dedup ──────────────────────────────────────────────

/** Audit log entry */
export interface AuditLogEntry {
  id: string;
  channelType: ChannelType;
  chatId: string;
  direction: 'inbound' | 'outbound';
  messageId: string;
  summary: string;
  createdAt: string;
}

/** Permission link: maps permissionRequestId to an IM message for callback handling */
export interface PermissionLink {
  id: string;
  permissionRequestId: string;
  channelType: ChannelType;
  chatId: string;
  messageId: string;
  createdAt: string;
}

// ── Streaming Preview ─────────────────────────────────────────

/** Capabilities of a channel adapter's streaming preview support */
export interface PreviewCapabilities {
  supported: boolean;
  privateOnly: boolean;
}

/** Mutable state for an in-flight streaming preview */
export interface StreamingPreviewState {
  draftId: number;           // non-zero 31-bit random integer, reused within one answer cycle
  chatId: string;
  lastSentText: string;      // last text actually sent as draft
  lastSentAt: number;        // timestamp (ms) of last sent draft
  degraded: boolean;         // set true after API failure → skip further previews
  throttleTimer: ReturnType<typeof setTimeout> | null;
  pendingText: string;       // latest accumulated text (may not yet be sent due to throttle)
}

// ── Tool Call Info ─────────────────────────────────────────────

/** Tool call tracking for streaming card progress display */
export interface ToolCallInfo {
  id: string;
  name: string;
  status: 'running' | 'complete' | 'error';
  /** Raw tool input used only for safe, user-visible progress summaries. */
  input?: unknown;
}

export interface RunTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_tokens?: number;
}

export interface RunSummary {
  executorId?: string;
  executorName?: string;
  executorKind?: string;
  provider?: string;
  modelSource?: string;
  selectedSource?: string;
  model?: string;
  codexProfile?: string;
  baseUrl?: string;
  tokenUsage?: RunTokenUsage;
}

/**
 * 流式卡片收尾时由 bridge-manager 交给 adapter 的本轮关联信息。
 * adapter 只将其用于按实际出站消息 ID 回填后续原生回复的上下文，
 * 不能据此直接执行请求或改变权限判断。
 */
export interface StreamingCardTurnContext {
  codepilotSessionId?: string;
  sourceMessageId?: string;
  sourceText?: string;
}

// ── Config ─────────────────────────────────────────────────────

/** Platform-specific message length limits */
export const PLATFORM_LIMITS: Record<string, number> = {
  telegram: 4096,
  discord: 2000,
  slack: 40000,
  feishu: 30000,
  qq: 2000,
  weixin: 4000,
};
