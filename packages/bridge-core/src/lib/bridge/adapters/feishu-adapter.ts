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
  UploadedFileLink,
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
  buildStreamingTypewriterContent,
  getStreamingCurrentStep,
  extractStreamingFinalResponse,
  buildFinalCardJson,
  buildPermissionButtonCard,
  formatElapsed,
} from '../markdown/feishu.js';
import {
  buildFeishuEmojiPrompt,
  normalizeFeishuEmojiType,
  resolveFeishuEmojiHint,
} from './feishu-emoji-catalog.js';

/** Max number of message_ids to keep for dedup. */
const DEDUP_MAX = 1000;

/** Max file download size (20 MB). */
const MAX_FILE_SIZE = 20 * 1024 * 1024;
/** Feishu IM file upload limit is 30 MB for bot file messages. */
const MAX_UPLOAD_FILE_SIZE = 30 * 1024 * 1024;
type FeishuUploadFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';

/** Feishu emoji type for typing indicator (same as Openclaw). */
const TYPING_EMOJI = 'Typing';

interface FeishuReactionHint {
  raw: string;
  emojiType: string;
  remainingText: string;
  fallbackEmoji?: string;
}

interface FeishuStickerHint {
  raw: string;
  target: string;
  remainingText: string;
}

function extractFeishuReactionHint(text: string): FeishuReactionHint | null {
  const match = /^\s*\[([^\]\r\n]{1,40})\]\s*([\s\S]*)$/u.exec(text || '');
  if (!match) return null;
  const raw = match[1].trim();
  if (/^(?:表情包|sticker|飞书表情包)(?::|：|$)/iu.test(raw)) return null;
  const catalogEntry = resolveFeishuEmojiHint(raw);
  if (catalogEntry) {
    return {
      raw,
      emojiType: catalogEntry.emojiType,
      remainingText: match[2].trimStart(),
      fallbackEmoji: catalogEntry.fallbackEmoji,
    };
  }
  const emojiType = normalizeFeishuEmojiType(raw);
  if (emojiType) return { raw, emojiType, remainingText: match[2].trimStart() };
  return null;
}

function extractFeishuStickerHint(text: string): FeishuStickerHint | null {
  const match = /^\s*\[((?:表情包|sticker|飞书表情包)(?:(?:[:：])([^\]\r\n]{1,180}))?)\]\s*([\s\S]*)$/iu.exec(text || '');
  if (!match) return null;
  return {
    raw: match[1].trim(),
    target: (match[2] || '最近').trim(),
    remainingText: match[3].trimStart(),
  };
}

function looksLikeFeishuStickerFileKey(value: string): boolean {
  const trimmed = value.trim();
  return /^(?:file_v\d+_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f-]{20,})$/i.test(trimmed);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripFeishuReactionHintText(text: string, hint: FeishuReactionHint): string {
  return hint.remainingText
    || text.replace(new RegExp(`^\\s*\\[${escapeRegExp(hint.raw)}\\]\\s*`, 'u'), '').trim();
}

function applyReactionFallbackText(originalText: string, hint: FeishuReactionHint, textWithoutHint: string): string {
  const body = textWithoutHint.trim();
  if (!hint.fallbackEmoji) return originalText;
  return `${hint.fallbackEmoji} ${body || '收到~'}`.trim();
}

/** State for an active CardKit v2 streaming card. */
interface FeishuCardState {
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

type FeishuCardKitCompat =
  | {
    version: 'v2';
    card: {
      create: (payload: unknown) => Promise<{ data?: { card_id?: string } }>;
      streamContent: (payload: unknown) => Promise<unknown>;
      update: (payload: unknown) => Promise<unknown>;
      settings?: {
        streamingMode?: {
          set?: (payload: unknown) => Promise<unknown>;
        };
      };
    };
  }
  | {
    version: 'v1';
    card: {
      create: (payload: unknown) => Promise<{ data?: { card_id?: string } }>;
      update: (payload: unknown) => Promise<unknown>;
      settings: (payload: unknown) => Promise<unknown>;
    };
    cardElement: {
      content: (payload: unknown) => Promise<unknown>;
    };
  };

/** Streaming card throttle interval (ms). */
const CARD_THROTTLE_MS = 200;
const CARD_TYPEWRITER_INTERVAL_MS = 70;
const CARD_TYPEWRITER_STEP_CHARS = 2;
const P2P_POLL_INTERVAL_MS = 5000;
const FEISHU_CHAT_INDEX_PATH = path.join(
  process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im'),
  'data',
  'feishu-chat-index.json',
);
function getFeishuStickerStorePath(): string {
  return path.join(
    process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im'),
    'data',
    'feishu-stickers.json',
  );
}

function getFeishuEmojiProfilePath(): string {
  return path.join(
    process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im'),
    'data',
    'feishu-emoji-profile.json',
  );
}

interface FeishuStickerRecord {
  fileKey: string;
  aliases: string[];
  label?: string;
  description?: string;
  intent?: string;
  tone?: string;
  usage?: string;
  avoidWhen?: string;
  examples?: string[];
  annotationConfidence?: number;
  annotationUpdatedAt?: string;
  learnedFromMessageId?: string;
  chatId?: string;
  userId?: string;
  messageId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  useCount: number;
}

interface FeishuStickerStore {
  version: 1;
  updatedAt: string;
  stickers: FeishuStickerRecord[];
}

interface ParsedFeishuStickerContent {
  fileKey: string | null;
  text: string;
  known: boolean;
  messageKind: 'feishu_sticker_unknown' | 'feishu_sticker_known' | 'feishu_sticker_image';
  imageAvailable?: boolean;
  label?: string;
  description?: string;
  intent?: string;
  tone?: string;
  usage?: string;
}

interface FeishuEmojiProfileEntry {
  emojiType: string;
  aliases: string[];
  chatId?: string;
  userId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  inboundCount: number;
  outboundSuccessCount: number;
  outboundFailureCount: number;
  disabled?: boolean;
}

interface FeishuEmojiProfileStore {
  version: 1;
  updatedAt: string;
  emojis: FeishuEmojiProfileEntry[];
}

function formatBytesForDocument(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  const mib = bytes / (1024 * 1024);
  return `${mib.toFixed(mib >= 10 ? 1 : 2)} MB`;
}

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
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    upper_message_id?: string;
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
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  upper_message_id?: string;
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

type FeishuLinkShareEntity =
  | 'tenant_readable'
  | 'tenant_editable'
  | 'anyone_readable'
  | 'anyone_editable'
  | 'closed';

type FeishuExternalAccessEntity = 'open' | 'closed' | 'allow_share_partner_tenant';

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'feishu';

  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private wsClient: lark.WSClient | null = null;
  private restClient: lark.Client | null = null;
  private seenMessageIds = new Map<string, boolean>();
  private botOpenId: string | null = null;
  private botDisplayName: string | null = null;
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
      || 'true';
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
  }

  getAssistantIdentity(): { displayName?: string; platform: string; appId?: string; botOpenId?: string } {
    const store = getBridgeContext().store;
    return {
      displayName: this.botDisplayName || store.getSetting('bridge_feishu_bot_name') || store.getSetting('bridge_feishu_app_name') || undefined,
      platform: 'Feishu',
      appId: store.getSetting('bridge_feishu_app_id') || undefined,
      botOpenId: this.botOpenId || undefined,
    };
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

  private readStickerStore(): FeishuStickerStore {
    try {
      const parsed = JSON.parse(fs.readFileSync(getFeishuStickerStorePath(), 'utf8')) as Partial<FeishuStickerStore>;
      const stickers = Array.isArray(parsed.stickers) ? parsed.stickers.filter((item) => item?.fileKey) : [];
      return {
        version: 1,
        updatedAt: parsed.updatedAt || '',
        stickers: stickers.map((item) => this.sanitizeStickerRecord(item as FeishuStickerRecord)),
      };
    } catch {
      return { version: 1, updatedAt: '', stickers: [] };
    }
  }

  private writeStickerStore(store: FeishuStickerStore): void {
    const storePath = getFeishuStickerStorePath();
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
  }

  private readEmojiProfileStore(): FeishuEmojiProfileStore {
    try {
      const parsed = JSON.parse(fs.readFileSync(getFeishuEmojiProfilePath(), 'utf8')) as Partial<FeishuEmojiProfileStore>;
      const emojis = Array.isArray(parsed.emojis) ? parsed.emojis : [];
      return {
        version: 1,
        updatedAt: parsed.updatedAt || '',
        emojis: emojis
          .map((item) => this.sanitizeEmojiProfileEntry(item as FeishuEmojiProfileEntry))
          .filter((item): item is FeishuEmojiProfileEntry => Boolean(item))
          .slice(0, 240),
      };
    } catch {
      return { version: 1, updatedAt: '', emojis: [] };
    }
  }

  private writeEmojiProfileStore(store: FeishuEmojiProfileStore): void {
    const storePath = getFeishuEmojiProfilePath();
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
  }

  private sanitizeEmojiProfileEntry(record: FeishuEmojiProfileEntry): FeishuEmojiProfileEntry | null {
    const emojiType = normalizeFeishuEmojiType(String(record.emojiType || ''));
    if (!emojiType) return null;
    return {
      emojiType,
      aliases: (Array.isArray(record.aliases) ? record.aliases : [])
        .map((item) => String(item || '').trim())
        .filter((item) => item && !this.isUnsafeStickerSemanticText(item))
        .slice(0, 20),
      chatId: typeof record.chatId === 'string' ? record.chatId : undefined,
      userId: typeof record.userId === 'string' ? record.userId : undefined,
      firstSeenAt: record.firstSeenAt || new Date().toISOString(),
      lastSeenAt: record.lastSeenAt || record.firstSeenAt || new Date().toISOString(),
      inboundCount: Math.max(0, Number(record.inboundCount) || 0),
      outboundSuccessCount: Math.max(0, Number(record.outboundSuccessCount) || 0),
      outboundFailureCount: Math.max(0, Number(record.outboundFailureCount) || 0),
      disabled: record.disabled === true,
    };
  }

  private rememberEmojiUsage(input: {
    emojiType: string;
    chatId?: string;
    userId?: string;
    alias?: string;
    direction: 'inbound' | 'outbound';
    outcome?: 'success' | 'failure';
  }): void {
    const emojiType = normalizeFeishuEmojiType(input.emojiType);
    if (!emojiType) return;
    const now = new Date().toISOString();
    const store = this.readEmojiProfileStore();
    let record = store.emojis.find((item) => item.emojiType === emojiType
      && (item.chatId || '') === (input.chatId || '')
      && (item.userId || '') === (input.userId || ''));
    if (!record) {
      record = {
        emojiType,
        aliases: [],
        chatId: input.chatId,
        userId: input.userId,
        firstSeenAt: now,
        lastSeenAt: now,
        inboundCount: 0,
        outboundSuccessCount: 0,
        outboundFailureCount: 0,
      };
      store.emojis.push(record);
    }
    if (input.alias?.trim()) {
      record.aliases = Array.from(new Set([...(record.aliases || []), input.alias.trim()])).slice(0, 20);
    }
    if (input.direction === 'inbound') record.inboundCount += 1;
    if (input.direction === 'outbound' && input.outcome === 'success') record.outboundSuccessCount += 1;
    if (input.direction === 'outbound' && input.outcome === 'failure') record.outboundFailureCount += 1;
    record.lastSeenAt = now;
    store.updatedAt = now;
    store.emojis = store.emojis
      .sort((a, b) => (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0))
      .slice(0, 240);
    try {
      this.writeEmojiProfileStore(store);
    } catch (err) {
      console.warn('[feishu-adapter] Failed to persist emoji profile:', err instanceof Error ? err.message : err);
    }
  }

  getEmojiPresentationPrompt(chatId?: string, userId?: string): string {
    const catalogHint = buildFeishuEmojiPrompt();
    const store = this.readEmojiProfileStore();
    const preferred = store.emojis
      .filter((item) => !item.disabled)
      .filter((item) => !chatId || !item.chatId || item.chatId === chatId)
      .filter((item) => !userId || !item.userId || item.userId === userId)
      .sort((a, b) => {
        const score = (entry: FeishuEmojiProfileEntry) => entry.inboundCount + entry.outboundSuccessCount - entry.outboundFailureCount;
        return score(b) - score(a) || (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0);
      })
      .slice(0, 6)
      .map((item) => {
        const alias = item.aliases?.[0] ? `/${item.aliases[0]}` : '';
        return `[${item.emojiType}${alias}]`;
      })
      .join(', ');
    return [
      'Feishu emoji presentation:',
      catalogHint ? `- Catalog examples: ${catalogHint}.` : '',
      preferred ? `- Learned preferences for this chat/user: ${preferred}. Prefer these in light chat when they fit.` : '',
      '- Choose reaction hints by actual intent. Do not default to SMILE; use no reaction hint when the tone is neutral, formal, blocked, or unclear.',
      '- Use reaction hints sparingly but naturally for greetings, acknowledgements, praise, jokes, and sticker-style banter.',
      '- If a reaction hint fails, the adapter will keep or fallback the visible text; never rely on the hint as the only meaning.',
    ].filter(Boolean).join('\n');
  }

  getStickerPresentationPrompt(chatId?: string): string {
    const store = this.readStickerStore();
    const annotated = store.stickers
      .filter((item) => this.hasStickerAnnotation(item))
      .filter((item) => !chatId || !item.chatId || item.chatId === chatId)
      .sort((a, b) => Number(b.chatId === chatId) - Number(a.chatId === chatId)
        || (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0))
      .slice(0, 8);
    if (annotated.length === 0) {
      return [
        'Feishu sticker library:',
        '- No semantically annotated stickers are available for this chat yet.',
        '- If the user explains a sticker meaning by replying to it, the adapter will store the meaning and usage for future selection.',
        '- Avoid bare `[表情包]` unless the user explicitly asks for any sticker; prefer text or a reaction hint when no matching sticker is known.',
      ].join('\n');
    }
    const lines = annotated.map((item) => {
      const alias = item.label?.trim() || item.aliases?.find((name) => !/^(?:最近|默认|表情包)$/u.test(name)) || '表情包';
      const parts = [
        item.intent?.trim() ? `meaning=${item.intent.trim()}` : '',
        item.tone?.trim() ? `tone=${item.tone.trim()}` : '',
        item.usage?.trim() ? `use=${item.usage.trim()}` : '',
      ].filter(Boolean).join('; ');
      return `- [表情包:${alias}] ${parts || item.description?.trim() || 'known sticker'}`;
    });
    return [
      'Feishu sticker library:',
      ...lines,
      '- Choose a sticker only when its meaning and usage match the reply. Prefer `[表情包:alias]` over bare `[表情包]`.',
      '- Do not mention sticker file keys to the user.',
    ].join('\n');
  }

  private isUnsafeStickerSemanticText(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (!text) return false;
    // cti-encoding-allow-start
    return /\uFFFD|�|\?{3,}|锟|Ã|Â|鈥|鐚|鐤|琛ㄦ儏|鎰忔|鍚嶇О|璇皵/u.test(text);
    // cti-encoding-allow-end
  }

  private sanitizeStickerRecord(record: FeishuStickerRecord): FeishuStickerRecord {
    const cleaned: FeishuStickerRecord = { ...record };
    for (const key of ['label', 'description', 'intent', 'tone', 'usage', 'avoidWhen'] as const) {
      if (this.isUnsafeStickerSemanticText(cleaned[key])) delete cleaned[key];
    }
    cleaned.examples = (Array.isArray(cleaned.examples) ? cleaned.examples : [])
      .map((item) => String(item || '').trim())
      .filter((item) => item && !this.isUnsafeStickerSemanticText(item))
      .slice(0, 8);
    cleaned.aliases = (Array.isArray(cleaned.aliases) ? cleaned.aliases : [])
      .map((item) => String(item || '').trim())
      .filter((item) => item && !this.isUnsafeStickerSemanticText(item))
      .slice(0, 20);
    return cleaned;
  }

  private rememberSticker(input: {
    fileKey: string;
    chatId: string;
    userId?: string;
    messageId: string;
    aliases?: string[];
  }): void {
    const fileKey = input.fileKey.trim();
    if (!fileKey) return;
    const now = new Date().toISOString();
    const store = this.readStickerStore();
    const aliases = new Set(['最近', '默认', '表情包', ...(input.aliases || [])].map((item) => item.trim()).filter(Boolean));
    let record = store.stickers.find((item) => item.fileKey === fileKey);
    if (!record) {
      record = {
        fileKey,
        aliases: [],
        chatId: input.chatId,
        userId: input.userId,
        messageId: input.messageId,
        firstSeenAt: now,
        lastSeenAt: now,
        useCount: 0,
      };
      store.stickers.push(record);
    }
    record.chatId = input.chatId;
    record.userId = input.userId;
    record.messageId = input.messageId;
    record.lastSeenAt = now;
    record.aliases = Array.from(new Set([...(record.aliases || []), ...aliases])).slice(0, 20);
    store.stickers = store.stickers
      .sort((a, b) => (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0))
      .slice(0, 80);
    store.updatedAt = now;
    try {
      this.writeStickerStore(store);
    } catch (err) {
      console.warn('[feishu-adapter] Failed to persist sticker store:', err instanceof Error ? err.message : err);
    }
  }

  private resolveStickerFileKey(target: string, chatId?: string): string | null {
    const normalized = target.trim();
    if (looksLikeFeishuStickerFileKey(normalized)) return normalized;
    const store = this.readStickerStore();
    const alias = normalized || '最近';
    const genericTarget = /^(?:最近|默认|表情包|sticker|飞书表情包)$/iu.test(alias);
    const compareStickerCandidate = (a: FeishuStickerRecord, b: FeishuStickerRecord): number =>
      Number(b.chatId === chatId) - Number(a.chatId === chatId)
      || (genericTarget ? Number(this.hasStickerAnnotation(b)) - Number(this.hasStickerAnnotation(a)) : 0)
      || (Number(b.useCount || 0) - Number(a.useCount || 0))
      || ((Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0));
    const byAlias = (genericTarget
      ? store.stickers
      : store.stickers.filter((item) => (item.aliases || []).some((name) => name.toLowerCase() === alias.toLowerCase())))
      .sort(compareStickerCandidate);
    const fallback = store.stickers
      .slice()
      .sort(compareStickerCandidate);
    return (byAlias[0] || fallback[0])?.fileKey || null;
  }

  private markStickerUsed(fileKey: string): void {
    const store = this.readStickerStore();
    const record = store.stickers.find((item) => item.fileKey === fileKey);
    if (!record) return;
    record.useCount = (record.useCount || 0) + 1;
    record.lastSeenAt = new Date().toISOString();
    store.updatedAt = record.lastSeenAt;
    try { this.writeStickerStore(store); } catch { /* best effort */ }
  }

  private extractStickerAnnotationFromText(text: string): Partial<FeishuStickerRecord> | null {
    const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length > 240 || /^[/?#]/.test(normalized)) return null;
    if (/[?？]$/.test(normalized)) return null;
    const labelMatch = /(?:表情包|表情|sticker|这个|刚才|上个|上一个|this|previous).{0,12}(?:叫|名称是|名字是|name|label)\s*[:：]?\s*([^，,。；;]{2,32})/iu.exec(normalized);
    const intentMatch = /(?:表示|代表|意思是|含义是|means?|meaning)\s*[:：]?\s*([^，,。；;]{2,80})/iu.exec(normalized);
    const toneMatch = /(?:语气是|tone)\s*[:：]?\s*([^，,。；;]{2,60})/iu.exec(normalized);
    const usageMatch = /(?:适合(?:在|用于)?|用于|用来|usage|use when)\s*[:：]?\s*(?:在)?([^。；;]{2,120})/iu.exec(normalized);
    if (labelMatch || intentMatch || toneMatch || usageMatch) {
      const label = labelMatch?.[1]?.trim();
      const intent = intentMatch?.[1]?.trim();
      const tone = toneMatch?.[1]?.trim();
      const usage = usageMatch?.[1]?.trim();
      return {
        label,
        description: intent || usage || label || normalized,
        intent: intent || usage || label,
        tone: tone || (usage && usage.length <= 40 ? usage : undefined),
        usage,
        annotationConfidence: 0.82,
      };
    }
    const match = normalized.match(/(?:表情包|表情|sticker).{0,12}(?:叫|名称是|名字是|是|表示|代表|意思是|含义是|语气是|用于|用来|means?|meaning|label|name)\s*[:：]?\s*(.+)$/iu)
      || normalized.match(/(?:这个|刚才|上个|上一个|this|previous).{0,12}(?:叫|名称是|名字是|是|表示|代表|意思是|含义是|语气是|用于|用来|means?|meaning|label|name)\s*[:：]?\s*(.+)$/iu);
    if (!match) return null;
    const value = match[1]?.trim().replace(/^["'“”‘’]+|["'“”‘’。.,，、]+$/g, '');
    if (!value || value.length < 2) return null;
    return {
      label: value.length <= 24 ? value : undefined,
      description: value,
      intent: value,
      tone: value.length <= 40 ? value : undefined,
      annotationConfidence: 0.72,
    };
  }

  private rememberStickerAnnotationFromText(input: {
    chatId: string;
    userId?: string;
    messageId: string;
    replyToMessageId?: string | null;
    text: string;
  }): boolean {
    const annotation = this.extractStickerAnnotationFromText(input.text);
    if (!annotation) return false;
    const store = this.readStickerStore();
    const now = new Date().toISOString();
    const target = store.stickers.find((item) => input.replyToMessageId && item.messageId === input.replyToMessageId)
      || store.stickers
        .filter((item) => item.chatId === input.chatId && !this.hasStickerAnnotation(item))
        .sort((a, b) => (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0))[0];
    if (!target) return false;
    const lastSeen = Date.parse(target.lastSeenAt || '');
    if (Number.isFinite(lastSeen) && Date.now() - lastSeen > 10 * 60 * 1000 && !input.replyToMessageId) return false;
    target.label = annotation.label || target.label;
    target.description = annotation.description || target.description;
    target.intent = annotation.intent || target.intent;
    target.tone = annotation.tone || target.tone;
    target.usage = annotation.usage || target.usage;
    target.avoidWhen = annotation.avoidWhen || target.avoidWhen;
    target.examples = Array.from(new Set([...(target.examples || []), ...(annotation.examples || [])])).slice(0, 8);
    target.annotationConfidence = annotation.annotationConfidence;
    target.annotationUpdatedAt = now;
    target.learnedFromMessageId = input.messageId;
    target.lastSeenAt = now;
    target.userId = input.userId || target.userId;
    const aliasSource = [target.label, target.intent, target.description, target.usage]
      .filter((item): item is string => !!item?.trim())
      .flatMap((item) => item.split(/[，,、;；\s]+/).map((part) => part.trim()).filter((part) => part.length >= 2 && part.length <= 24));
    target.aliases = Array.from(new Set([...(target.aliases || []), ...aliasSource])).slice(0, 20);
    store.updatedAt = now;
    try {
      this.writeStickerStore(store);
      return true;
    } catch (err) {
      console.warn('[feishu-adapter] Failed to persist sticker annotation:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  private getStickerRecord(fileKey: string | null): FeishuStickerRecord | null {
    if (!fileKey) return null;
    return this.readStickerStore().stickers.find((item) => item.fileKey === fileKey) || null;
  }

  private hasStickerAnnotation(record: FeishuStickerRecord | null): boolean {
    return !!record && Boolean(
      record.label?.trim()
      || record.description?.trim()
      || record.intent?.trim()
      || record.tone?.trim()
      || record.usage?.trim(),
    );
  }

  private buildStickerSemanticText(fileKey: string | null, record: FeishuStickerRecord | null): string {
    const keyPart = fileKey ? `，file_key=${fileKey}` : '';
    if (record && this.hasStickerAnnotation(record)) {
      const parts = [
        record.label?.trim() ? `图案/名称：${record.label.trim()}` : '',
        record.description?.trim() ? `描述：${record.description.trim()}` : '',
        record.intent?.trim() ? `通常意图：${record.intent.trim()}` : '',
        record.tone?.trim() ? `语气：${record.tone.trim()}` : '',
        record.usage?.trim() ? `适用场景：${record.usage.trim()}` : '',
      ].filter(Boolean).join('；');
      return [
        `用户发送了一个已记录语义的飞书表情包${keyPart}。`,
        `表情包语义：${parts}。`,
        '请按上述语义理解用户意图；不要把 file_key 当成图像内容。'
      ].join('\n');
    }
    return [
      `用户发送了一个尚未标注语义的飞书表情包${keyPart}。`,
      '飞书事件只提供 file_key，且不支持机器人下载表情包图片；当前不能可靠识别图案、文字和意图。',
      '请不要凭 file_key 猜测含义。若用户正在用表情表达态度，只能把它视为未知表情包；可以请用户说明这个表情包代表什么，以便后续记录。'
    ].join('\n');
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
        'im.message.reaction.created_v1': async (data) => {
          this.handleReactionCreatedEvent(data);
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

  private handleReactionCreatedEvent(data: unknown): void {
    const event = (data as { event?: unknown })?.event ?? data;
    const reactionType = this.readNestedString(event, [
      ['reaction', 'reaction_type', 'emoji_type'],
      ['reaction_type', 'emoji_type'],
      ['emoji_type'],
    ]);
    const emojiType = reactionType ? normalizeFeishuEmojiType(reactionType) : null;
    if (!emojiType) return;
    const chatId = this.readNestedString(event, [
      ['message', 'chat_id'],
      ['chat_id'],
    ]);
    const userId = this.readNestedString(event, [
      ['operator', 'operator_id', 'open_id'],
      ['operator', 'operator_id', 'user_id'],
      ['sender', 'sender_id', 'open_id'],
      ['user_id'],
      ['open_id'],
    ]);
    this.rememberEmojiUsage({
      emojiType,
      chatId,
      userId,
      direction: 'inbound',
    });
  }

  private readNestedString(value: unknown, paths: string[][]): string | undefined {
    for (const segments of paths) {
      let current: unknown = value;
      for (const segment of segments) {
        if (!current || typeof current !== 'object') {
          current = undefined;
          break;
        }
        current = (current as Record<string, unknown>)[segment];
      }
      if (typeof current === 'string' && current.trim()) return current.trim();
    }
    return undefined;
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
      const cardKit = this.getCardKitCompat();
      if (!cardKit) {
        console.warn('[feishu-adapter] CardKit API is unavailable in this SDK version');
        return false;
      }

      // Step 1: Create card via the CardKit API exposed by the installed SDK.
      const cardBody = {
        schema: '2.0',
        config: {
          streaming_mode: true,
          streaming_config: {
            print_frequency_ms: { default: 80, pc: 80, android: 80, ios: 80 },
            print_step: { default: 1, pc: 1, android: 1, ios: 1 },
          },
          wide_screen_mode: true,
          summary: { content: '正在思考' },
        },
        body: {
          elements: [{
            tag: 'markdown',
            content: buildStreamingContent('', []),
            text_align: 'left',
            text_size: 'normal',
            element_id: 'streaming_content',
          }],
        },
      };

      const createResp = await this.createCardKitCard(cardKit, cardBody);
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
        sourceMessageId: replyToMessageId,
        sequence: 0,
        startTime: Date.now(),
        toolCalls: [],
        thinking: true,
        pendingText: null,
        lastUpdateAt: 0,
        throttleTimer: null,
        typewriterTimer: null,
        typewriterKey: '',
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

    const sourceText = state.pendingText || '';
    const currentStep = getStreamingCurrentStep(sourceText, state.toolCalls);
    const toolKey = state.toolCalls.map((tool) => `${tool.id}:${tool.name}:${tool.status}`).join('|');
    const typewriterKey = `${currentStep}\u0000${toolKey}`;
    if (state.typewriterKey === typewriterKey && state.typewriterTimer) return;

    if (state.typewriterTimer) {
      clearTimeout(state.typewriterTimer);
      state.typewriterTimer = null;
    }
    state.typewriterKey = typewriterKey;

    const totalChars = [...currentStep].length;
    const runTypewriter = (visibleChars: number) => {
      const latest = this.activeCards.get(chatId);
      if (!latest || latest.typewriterKey !== typewriterKey) return;
      const content = buildStreamingTypewriterContent(sourceText, latest.toolCalls, visibleChars);
      this.flushCardContent(chatId, content);
      if (visibleChars < totalChars) {
        latest.typewriterTimer = setTimeout(
          () => runTypewriter(Math.min(totalChars, visibleChars + CARD_TYPEWRITER_STEP_CHARS)),
          CARD_TYPEWRITER_INTERVAL_MS,
        );
      } else {
        latest.typewriterTimer = null;
      }
    };

    runTypewriter(0);
  }

  private flushCardContent(chatId: string, content: string): void {
    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient) return;

    state.sequence++;
    const seq = state.sequence;
    const cardId = state.cardId;
    const cardKit = this.getCardKitCompat();
    if (!cardKit) return;

    // Fire-and-forget — streaming updates are non-critical
    this.updateCardKitStreamingContent(cardKit, cardId, content, seq).then(() => {
      state.lastUpdateAt = Date.now();
      if (seq === 1 || seq % 10 === 0) {
        console.log(`[feishu-adapter] Streaming card updated: cardId=${cardId}, sequence=${seq}`);
      }
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
    if (state.typewriterTimer) {
      clearTimeout(state.typewriterTimer);
      state.typewriterTimer = null;
    }

    try {
      const cardKit = this.getCardKitCompat();
      if (!cardKit) return false;

      // Step 1: Close streaming mode
      state.sequence++;
      await this.setCardKitStreamingMode(cardKit, state.cardId, false, state.sequence);

      // Step 2: Build and apply final card
      const statusLabels: Record<string, string> = {
        completed: '已完成',
        interrupted: '已中断',
        error: '未完成',
      };
      const elapsedMs = Date.now() - state.startTime;
      const footer = {
        status: statusLabels[status] || status,
        elapsed: formatElapsed(elapsedMs),
      };

      let finalResponseText = responseText;
      const visibleFinalText = extractStreamingFinalResponse(responseText);
      const stickerHint = extractFeishuStickerHint(visibleFinalText);
      if (stickerHint) {
        const fileKey = this.resolveStickerFileKey(stickerHint.target, chatId);
        if (fileKey) {
          const stickerResult = await this.sendStickerMessage(chatId, fileKey, state.sourceMessageId);
          if (stickerResult.ok) {
            finalResponseText = stickerHint.remainingText || '收到~';
          }
        }
      }
      const reactionHint = extractFeishuReactionHint(visibleFinalText);
      if (!stickerHint && reactionHint) {
        const textWithoutHint = stripFeishuReactionHintText(visibleFinalText, reactionHint);
        const reactionAdded = state.sourceMessageId
          ? await this.addMessageReaction(state.sourceMessageId, reactionHint.emojiType, {
            chatId,
            alias: reactionHint.raw,
          })
          : false;
        if (reactionAdded) {
          finalResponseText = textWithoutHint || '收到~';
        } else {
          finalResponseText = applyReactionFallbackText(visibleFinalText, reactionHint, textWithoutHint);
        }
      }
      const finalCardJson = buildFinalCardJson(finalResponseText, state.toolCalls, footer);

      state.sequence++;
      await this.updateCardKitCard(cardKit, state.cardId, finalCardJson, state.sequence);

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
    if (state.typewriterTimer) {
      clearTimeout(state.typewriterTimer);
    }
    this.activeCards.delete(chatId);
  }

  /**
   * Check if there is an active streaming card for a given chat.
   */
  hasActiveCard(chatId: string): boolean {
    return this.activeCards.has(chatId);
  }

  private getCardKitCompat(): FeishuCardKitCompat | null {
    const cardkit = (this.restClient as any)?.cardkit;
    if (cardkit?.v2?.card?.create && cardkit.v2.card.streamContent && cardkit.v2.card.update) {
      return { version: 'v2', card: cardkit.v2.card };
    }
    if (cardkit?.v1?.card?.create && cardkit.v1.card.update && cardkit.v1.card.settings && cardkit.v1.cardElement?.content) {
      return {
        version: 'v1',
        card: cardkit.v1.card,
        cardElement: cardkit.v1.cardElement,
      };
    }
    return null;
  }

  private createCardKitCard(cardKit: FeishuCardKitCompat, cardBody: Record<string, unknown>): Promise<{ data?: { card_id?: string } }> {
    return cardKit.card.create({
      data: { type: 'card_json', data: JSON.stringify(cardBody) },
    });
  }

  private updateCardKitStreamingContent(
    cardKit: FeishuCardKitCompat,
    cardId: string,
    content: string,
    sequence: number,
  ): Promise<unknown> {
    if (cardKit.version === 'v2') {
      return cardKit.card.streamContent({
        path: { card_id: cardId },
        data: { content, sequence },
      });
    }
    return cardKit.cardElement.content({
      path: { card_id: cardId, element_id: 'streaming_content' },
      data: { content, sequence },
    });
  }

  private setCardKitStreamingMode(
    cardKit: FeishuCardKitCompat,
    cardId: string,
    streamingMode: boolean,
    sequence: number,
  ): Promise<unknown> {
    if (cardKit.version === 'v2' && cardKit.card.settings?.streamingMode?.set) {
      return cardKit.card.settings.streamingMode.set({
        path: { card_id: cardId },
        data: { streaming_mode: streamingMode, sequence },
      });
    }
    if (cardKit.version === 'v1') {
      return cardKit.card.settings({
        path: { card_id: cardId },
        data: {
          settings: JSON.stringify({ streaming_mode: streamingMode }),
          sequence,
        },
      });
    }
    return Promise.resolve();
  }

  private updateCardKitCard(
    cardKit: FeishuCardKitCompat,
    cardId: string,
    finalCardJson: string,
    sequence: number,
  ): Promise<unknown> {
    if (cardKit.version === 'v2') {
      return cardKit.card.update({
        path: { card_id: cardId },
        data: { type: 'card_json', data: finalCardJson, sequence },
      });
    }
    return cardKit.card.update({
      path: { card_id: cardId },
      data: {
        card: { type: 'card_json', data: finalCardJson },
        sequence,
      },
    });
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
    const stickerHint = (
      !message.feishuCardJson
      && (!message.inlineButtons || message.inlineButtons.length === 0)
      && message.parseMode !== 'HTML'
    ) ? extractFeishuStickerHint(text) : null;
    if (stickerHint) {
      const fileKey = this.resolveStickerFileKey(stickerHint.target, message.address.chatId);
      if (fileKey) {
        const stickerResult = await this.sendStickerMessage(message.address.chatId, fileKey, message.replyToMessageId);
        if (stickerResult.ok) {
          text = stickerHint.remainingText;
          if (!text.trim()) return stickerResult;
        }
      }
    }
    const reactionHint = (
      !message.feishuCardJson
      && (!message.inlineButtons || message.inlineButtons.length === 0)
      && message.parseMode !== 'HTML'
    ) ? extractFeishuReactionHint(text) : null;

    if (reactionHint) {
      const textWithoutHint = stripFeishuReactionHintText(text, reactionHint);
      const reactionAdded = message.replyToMessageId
        ? await this.addMessageReaction(message.replyToMessageId, reactionHint.emojiType, {
          chatId: message.address.chatId,
          userId: message.address.userId,
          alias: reactionHint.raw,
        })
        : false;
      if (reactionAdded) {
        text = textWithoutHint || '收到~';
      } else {
        text = applyReactionFallbackText(text, reactionHint, textWithoutHint);
      }
    }

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

    if (message.feishuCardJson) {
      const result = await this.sendRawInteractiveCard(
        message.address.chatId,
        message.feishuCardJson,
        text,
        message.replyToMessageId,
      );
      if (result.ok) {
        console.log('[feishu-adapter] Interactive card send ok:', JSON.stringify({ chatId: message.address.chatId, messageId: result.messageId }));
      } else {
        console.warn('[feishu-adapter] Interactive card send failed:', JSON.stringify({ chatId: message.address.chatId, error: result.error }));
      }
      return result;
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

  private async addMessageReaction(
    messageId: string,
    emojiType: string,
    usage?: { chatId?: string; userId?: string; alias?: string },
  ): Promise<boolean> {
    try {
      const res = await this.restClient!.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      const ok = Boolean((res as any)?.data?.reaction_id) || !((res as any)?.code);
      this.rememberEmojiUsage({
        emojiType,
        chatId: usage?.chatId,
        userId: usage?.userId,
        alias: usage?.alias,
        direction: 'outbound',
        outcome: ok ? 'success' : 'failure',
      });
      return ok;
    } catch (err) {
      this.rememberEmojiUsage({
        emojiType,
        chatId: usage?.chatId,
        userId: usage?.userId,
        alias: usage?.alias,
        direction: 'outbound',
        outcome: 'failure',
      });
      const code = (err as { code?: number })?.code;
      if (code !== 99991400 && code !== 99991403) {
        console.warn('[feishu-adapter] Message reaction failed:', err instanceof Error ? err.message : err);
      }
      return false;
    }
  }

  private async sendStickerMessage(chatId: string, fileKey: string, replyToMessageId?: string): Promise<SendResult> {
    try {
      const content = JSON.stringify({ file_key: fileKey });
      const res = replyToMessageId
        ? await this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'sticker', content },
        })
        : await this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'sticker',
            content,
          },
        });
      if (res?.data?.message_id) {
        this.markStickerUsed(fileKey);
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Feishu sticker send failed' };
    } catch (err) {
      if (replyToMessageId && this.isInvalidReplyTargetError(err)) {
        return this.sendStickerMessage(chatId, fileKey);
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async sendRawInteractiveCard(
    chatId: string,
    cardJson: string,
    fallbackText: string,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    try {
      const res = replyToMessageId
        ? await this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'interactive', content: cardJson },
        })
        : await this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardJson,
          },
        });

      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id, cardId: (res.data as { card_id?: string }).card_id };
      }
      console.warn('[feishu-adapter] Raw interactive card send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu-adapter] Raw interactive card error, falling back to text:', err instanceof Error ? err.message : err);
    }

    return this.sendAsPlainText(chatId, fallbackText, replyToMessageId);
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
      if (replyToMessageId && this.isInvalidReplyTargetError(err)) {
        console.warn('[feishu-adapter] Card reply target missing, retrying as direct chat send');
        return this.sendAsCard(chatId, text);
      }
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
      if (replyToMessageId && this.isInvalidReplyTargetError(err)) {
        console.warn('[feishu-adapter] Post reply target missing, retrying as direct chat send');
        return this.sendAsPost(chatId, text);
      }
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
    void userId;
    void chatId;
    // Feishu inbound is role-driven: everyone can enter a conversation.
    // Sensitive actions are gated later by Viewer / Operator / Owner checks.
    // `bridge_feishu_allowed_users` stays only as a compatibility source that
    // maps configured ids to Viewer during permission-role resolution.
    return true;
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
      if (requireMention && !this.isBotMentionedFromMessage(msg)) {
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
    const replyTargetMessageId = this.getReplyTargetMessageId(msg);

    // Extract content based on message type
    const messageType = msg.message_type;
    let text = '';
    const attachments: FileAttachment[] = [];
    let stickerInfo: ParsedFeishuStickerContent | null = null;

    if (messageType === 'text') {
      text = this.parseTextContent(msg.content);
      this.rememberStickerAnnotationFromText({
        chatId,
        userId,
        messageId: msg.message_id,
        replyToMessageId: replyTargetMessageId,
        text,
      });
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
    } else if (messageType === 'sticker') {
      stickerInfo = this.parseStickerContent(msg.content);
      text = stickerInfo.text;
      if (stickerInfo.fileKey) {
        const stickerFileKey = stickerInfo.fileKey;
        const attachment = await this.downloadResource(msg.message_id, stickerFileKey, 'image');
        if (attachment) {
          attachment.name = `sticker-${stickerFileKey}.png`;
          attachments.push(attachment);
          stickerInfo = this.withStickerImageContext(stickerInfo);
          text = stickerInfo.text;
        }
        this.rememberSticker({
          fileKey: stickerFileKey,
          chatId,
          userId,
          messageId: msg.message_id,
        });
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
      ...(stickerInfo ? { sticker: stickerInfo } : {}),
      ...(stickerInfo ? { messageKind: stickerInfo.messageKind } : {}),
    };
    if (replyTargetMessageId) {
      rawMetadata = {
        ...(rawMetadata || {}),
        feishuReplyTo: {
          messageId: replyTargetMessageId,
        },
      };
      if (attachments.length === 0) {
        const replyAttachments = await this.downloadAttachmentsFromMessageId(replyTargetMessageId);
        if (replyAttachments.length > 0) {
          attachments.push(...replyAttachments);
          rawMetadata = {
            ...(rawMetadata || {}),
            feishuReplyTo: {
              messageId: replyTargetMessageId,
              attachmentCount: replyAttachments.length,
            },
          };
        }
      }
    }

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
      messageKind: stickerInfo?.messageKind,
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

  private parseStickerContent(content: string): ParsedFeishuStickerContent {
    const fileKey = this.extractFileKey(content);
    const record = this.getStickerRecord(fileKey);
    return {
      fileKey,
      text: this.buildStickerSemanticText(fileKey, record),
      known: this.hasStickerAnnotation(record),
      messageKind: this.hasStickerAnnotation(record) ? 'feishu_sticker_known' : 'feishu_sticker_unknown',
      label: record?.label,
      description: record?.description,
      intent: record?.intent,
      tone: record?.tone,
    };
  }

  private withStickerImageContext(stickerInfo: ParsedFeishuStickerContent): ParsedFeishuStickerContent {
    const parts = [
      stickerInfo.label?.trim() ? `历史名称：${stickerInfo.label.trim()}` : '',
      stickerInfo.description?.trim() ? `历史描述：${stickerInfo.description.trim()}` : '',
      stickerInfo.intent?.trim() ? `历史意图：${stickerInfo.intent.trim()}` : '',
      stickerInfo.tone?.trim() ? `历史语气：${stickerInfo.tone.trim()}` : '',
    ].filter(Boolean).join('；');
    return {
      ...stickerInfo,
      imageAvailable: true,
      messageKind: 'feishu_sticker_image',
      text: [
        `用户发送了一个飞书表情包，file_key=${stickerInfo.fileKey || 'unknown'}，表情包图片已作为本轮图片附件提供给模型。`,
        parts ? `已有语义档案可作为参考：${parts}。` : '',
        '请先根据图片附件识别图案、文字和表达意图；不要只凭 file_key 猜测。若图片无法识别，再说明不确定并可请用户补充含义。',
      ].filter(Boolean).join('\n'),
    };
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
    void this.pollP2pChatsForMissedMessages();
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
          root_id: item.root_id,
          parent_id: item.parent_id,
          thread_id: item.thread_id,
          upper_message_id: item.upper_message_id,
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
      if (replyToMessageId && this.isInvalidReplyTargetError(err)) {
        console.warn('[feishu-adapter] Text reply target missing, retrying as direct chat send');
        return this.sendAsPlainText(chatId, text, undefined, message);
      }
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  private isInvalidReplyTargetError(err: unknown): boolean {
    const code = Number((err as { response?: { data?: { code?: number | string } } })?.response?.data?.code);
    return code === 230011 || code === 231003;
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

  private getReplyTargetMessageId(msg: FeishuMessageEventData['message']): string | null {
    const raw = msg as FeishuMessageEventData['message'] & Record<string, unknown>;
    const candidates = [
      raw.parent_id,
      raw.upper_message_id,
      raw.root_id,
    ];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const value = candidate.trim();
      if (value && value !== msg.message_id) return value;
    }
    return null;
  }

  private async fetchMessageById(messageId: string): Promise<FeishuMessageListItem | null> {
    if (!this.restClient) return null;
    try {
      const res = await this.restClient.im.message.get({
        path: { message_id: messageId },
      });
      const item = res?.data?.items?.[0];
      if (!item?.message_id || !item.msg_type) return null;
      return {
        message_id: item.message_id,
        root_id: item.root_id,
        parent_id: item.parent_id,
        thread_id: item.thread_id,
        upper_message_id: item.upper_message_id,
        chat_id: item.chat_id || '',
        create_time: item.create_time || '',
        deleted: item.deleted,
        msg_type: item.msg_type,
        body: item.body,
        sender: item.sender,
      };
    } catch (err) {
      console.warn('[feishu-adapter] Failed to fetch replied message:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  private async downloadAttachmentsFromMessageId(messageId: string): Promise<FileAttachment[]> {
    const item = await this.fetchMessageById(messageId);
    if (!item || item.deleted) return [];
    return this.downloadAttachmentsFromMessageItem(item);
  }

  private async downloadAttachmentsFromMessageItem(item: FeishuMessageListItem): Promise<FileAttachment[]> {
    const attachments: FileAttachment[] = [];
    const content = item.body?.content || '';

    if (item.msg_type === 'image') {
      const fileKey = this.extractFileKey(content);
      if (fileKey) {
        const attachment = await this.downloadResource(item.message_id, fileKey, 'image');
        if (attachment) attachments.push(attachment);
      }
      return attachments;
    }

    if (item.msg_type === 'file' || item.msg_type === 'audio' || item.msg_type === 'video' || item.msg_type === 'media') {
      const fileKey = this.extractFileKey(content);
      if (fileKey) {
        const resourceType = item.msg_type === 'audio' || item.msg_type === 'video' || item.msg_type === 'media'
          ? item.msg_type
          : 'file';
        const attachment = await this.downloadResource(item.message_id, fileKey, resourceType);
        if (attachment) attachments.push(attachment);
      }
      return attachments;
    }

    if (item.msg_type === 'post') {
      const { imageKeys } = this.parsePostContent(content);
      for (const key of imageKeys) {
        const attachment = await this.downloadResource(item.message_id, key, 'image');
        if (attachment) attachments.push(attachment);
      }
    }

    return attachments;
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

  async sendLocalFile(chatId: string, filePath: string, replyToMessageId?: string): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    try {
      if (!fs.existsSync(filePath)) {
        return { ok: false, error: `File not found: ${filePath}` };
      }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return { ok: false, error: `Not a file: ${filePath}` };
      }
      if (stat.size <= 0) {
        return { ok: false, error: `File is empty: ${filePath}` };
      }
      if (stat.size > MAX_UPLOAD_FILE_SIZE) {
        return { ok: false, error: `File exceeds Feishu upload limit: ${filePath}` };
      }

      const uploadRes = await this.restClient.im.file.create({
        data: {
          file_type: this.inferFeishuUploadFileType(filePath),
          file_name: path.basename(filePath),
          file: fs.createReadStream(filePath),
        },
      });

      const fileKey = uploadRes?.file_key;
      if (!fileKey) {
        return { ok: false, error: 'Feishu file upload did not return file_key' };
      }

      const sendRes = replyToMessageId
        ? await this.restClient.im.message.reply({
            path: { message_id: replyToMessageId },
            data: {
              msg_type: 'file',
              content: JSON.stringify({ file_key: fileKey }),
            },
          })
        : await this.restClient.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'file',
              content: JSON.stringify({ file_key: fileKey }),
            },
          });

      if (sendRes?.data?.message_id) {
        return { ok: true, messageId: sendRes.data.message_id };
      }
      return { ok: false, error: `Feishu file send failed: ${sendRes?.msg || 'unknown error'}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async uploadLocalFileForLink(filePath: string): Promise<UploadedFileLink | null> {
    if (!this.restClient) {
      throw new Error('Feishu client not initialized');
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }
    if (stat.size <= 0) {
      throw new Error(`File is empty: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const deliveryDoc = await this.createFileDeliveryDocument(filePath, fileName, stat.size);
    await this.ensureDocumentPublicPermission(deliveryDoc.documentId);

    return {
      title: deliveryDoc.title,
      url: deliveryDoc.url,
      platform: 'feishu_docx',
      fileToken: deliveryDoc.fileToken,
      documentId: deliveryDoc.documentId,
    };
  }

  private inferFeishuUploadFileType(filePath: string): FeishuUploadFileType {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.opus') return 'opus';
    if (ext === '.mp4') return 'mp4';
    if (ext === '.pdf') return 'pdf';
    if (ext === '.doc' || ext === '.docx') return 'doc';
    if (ext === '.xls' || ext === '.xlsx') return 'xls';
    if (ext === '.ppt' || ext === '.pptx') return 'ppt';
    return 'stream';
  }

  private getDriveLinkShareEntity(): FeishuLinkShareEntity {
    const store = getBridgeContext().store;
    const raw = (
      store.getSetting('bridge_feishu_docx_link_share_entity')
      || store.getSetting('bridge_feishu_drive_link_share_entity')
      || process.env.CTI_FEISHU_DOCX_LINK_SHARE_ENTITY
      || process.env.CTI_FEISHU_DRIVE_LINK_SHARE_ENTITY
      || 'tenant_readable'
    ).trim().toLowerCase();
    const allowed = new Set<FeishuLinkShareEntity>([
      'tenant_readable',
      'tenant_editable',
      'anyone_readable',
      'anyone_editable',
      'closed',
    ]);
    return allowed.has(raw as FeishuLinkShareEntity)
      ? raw as FeishuLinkShareEntity
      : 'tenant_readable';
  }

  private getDriveExternalAccessEntity(): FeishuExternalAccessEntity | null {
    const store = getBridgeContext().store;
    const raw = (
      store.getSetting('bridge_feishu_docx_external_access_entity')
      || store.getSetting('bridge_feishu_drive_external_access_entity')
      || process.env.CTI_FEISHU_DOCX_EXTERNAL_ACCESS_ENTITY
      || process.env.CTI_FEISHU_DRIVE_EXTERNAL_ACCESS_ENTITY
      || ''
    ).trim().toLowerCase();
    if (!raw) return null;
    if (raw === 'open' || raw === 'closed' || raw === 'allow_share_partner_tenant') {
      return raw;
    }
    return null;
  }

  private async uploadDocxAttachmentSingleShot(
    filePath: string,
    fileName: string,
    documentId: string,
    size: number,
  ): Promise<string> {
    const uploadRes = await this.restClient!.drive.media.uploadAll({
      data: {
        file_name: fileName,
        parent_type: 'docx_file',
        parent_node: documentId,
        size,
        file: fs.createReadStream(filePath),
      },
    });
    const fileToken = uploadRes?.file_token;
    if (!fileToken) {
      throw new Error('飞书文档附件上传失败：未返回 file_token');
    }
    return fileToken;
  }

  private async uploadDocxAttachmentMultipart(
    filePath: string,
    fileName: string,
    documentId: string,
    size: number,
  ): Promise<string> {
    const prepareRes = await this.restClient!.drive.media.uploadPrepare({
      data: {
        file_name: fileName,
        parent_type: 'docx_file',
        parent_node: documentId,
        size,
      },
    });
    const uploadId = prepareRes?.data?.upload_id;
    const blockSize = prepareRes?.data?.block_size || 4 * 1024 * 1024;
    const blockNum = prepareRes?.data?.block_num || Math.ceil(size / blockSize);
    if (!uploadId || !blockNum) {
      throw new Error('飞书云空间预上传失败：未返回 upload_id');
    }

    const fd = fs.openSync(filePath, 'r');
    try {
      for (let seq = 0; seq < blockNum; seq += 1) {
        const offset = seq * blockSize;
        const partSize = Math.min(blockSize, size - offset);
        const buffer = Buffer.alloc(partSize);
        const bytesRead = fs.readSync(fd, buffer, 0, partSize, offset);
        if (bytesRead !== partSize) {
          throw new Error(`读取文件分片失败：seq=${seq}`);
        }
        await this.restClient!.drive.media.uploadPart({
          data: {
            upload_id: uploadId,
            seq,
            size: partSize,
            file: buffer,
          },
        });
      }
    } finally {
      fs.closeSync(fd);
    }

    const finishRes = await this.restClient!.drive.media.uploadFinish({
      data: {
        upload_id: uploadId,
        block_num: blockNum,
      },
    });
    const fileToken = finishRes?.data?.file_token;
    if (!fileToken) {
      throw new Error('飞书文档附件完成上传失败：未返回 file_token');
    }
    return fileToken;
  }

  private async createFileDeliveryDocument(
    filePath: string,
    fileName: string,
    size: number,
  ): Promise<{ documentId: string; fileToken: string; title: string; url: string }> {
    const title = this.deriveDeliveryDocumentTitle(fileName);
    const introMarkdown = [
      `# ${title}`,
      '',
      '此文档用于交付超过飞书单文件消息限制的本地结果文件。',
      '',
      `- 文件名：${fileName}`,
      `- 文件大小：${formatBytesForDocument(size)}`,
      `- 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      '',
      '附件如下：',
    ].join('\n');

    const doc = await this.createDocumentFromMarkdown(introMarkdown, { title });
    const fileToken = size <= 20 * 1024 * 1024
      ? await this.uploadDocxAttachmentSingleShot(filePath, fileName, doc.documentId, size)
      : await this.uploadDocxAttachmentMultipart(filePath, fileName, doc.documentId, size);

    await this.appendDocumentAttachmentBlock(doc.documentId, fileToken, fileName);
    return {
      documentId: doc.documentId,
      fileToken,
      title: doc.title,
      url: doc.url,
    };
  }

  private deriveDeliveryDocumentTitle(fileName: string): string {
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    return `文件交付 ${fileName} ${now}`.slice(0, 80);
  }

  private async appendDocumentAttachmentBlock(documentId: string, fileToken: string, fileName: string): Promise<void> {
    const { appId, appSecret, baseUrl } = this.getAuthContext();
    const tenantAccessToken = await this.fetchTenantAccessToken(appId, appSecret, baseUrl);
    const children = [
      {
        block_type: 2,
        text: {
          elements: [
            {
              text_run: {
                content: `${fileName}：`,
              },
            },
            {
              file: {
                file_token: fileToken,
              },
            },
          ],
        },
      },
    ];

    const blockResponse = await fetch(`${baseUrl}/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenantAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ children }),
      signal: AbortSignal.timeout(10_000),
    });
    const blockPayload = await blockResponse.json() as { code?: number; msg?: string };
    if (!blockResponse.ok || blockPayload.code !== 0) {
      throw new Error(`飞书文档附件块创建失败 [${blockPayload.code ?? blockResponse.status}]: ${blockPayload.msg || blockResponse.statusText}`);
    }
  }

  private async ensureDocumentPublicPermission(documentId: string): Promise<void> {
    const shareEntity = this.getDriveLinkShareEntity();
    const externalAccessEntity = this.getDriveExternalAccessEntity();
    try {
      await this.restClient!.drive.permissionPublic.patch({
        data: {
          link_share_entity: shareEntity,
          ...(externalAccessEntity ? { external_access_entity: externalAccessEntity } : {}),
        },
        params: {
          type: 'docx',
        },
        path: {
          token: documentId,
        },
      });
    } catch (err) {
      throw new Error(`飞书云文档分享权限设置失败：${err instanceof Error ? err.message : String(err)}`);
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
      const botInfo = botData?.data?.bot || botData?.bot || botData?.data || {};
      const displayName = [
        botInfo.name,
        botInfo.app_name,
        botInfo.i18n_name?.zh_cn,
        botInfo.i18n_name?.en_us,
        botInfo.bot_name,
        botData?.data?.app_name,
        botData?.app_name,
      ].map((item) => typeof item === 'string' ? item.trim() : '').find(Boolean);
      if (displayName) {
        this.botDisplayName = displayName;
      }
      const openId = botInfo.open_id || botInfo.openId || botData?.bot?.open_id;
      if (openId) {
        this.botOpenId = String(openId);
        this.botIds.add(String(openId));
      }
      // Also record app_id-based IDs if available
      const botId = botInfo.bot_id || botInfo.botId || botData?.bot?.bot_id;
      if (botId) {
        this.botIds.add(String(botId));
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

  private isBotMentionedFromMessage(
    message: Pick<FeishuMessageEventData['message'], 'content' | 'mentions'>,
  ): boolean {
    if (this.isBotMentioned(message.mentions)) return true;
    if (this.botIds.size === 0 || !message.content) return false;

    try {
      const parsed = JSON.parse(message.content) as {
        text?: string;
        content?: Array<Array<{ tag?: string; user_id?: string }>>;
      };

      const text = typeof parsed.text === 'string' ? parsed.text : '';
      const textMentionIds = Array.from(text.matchAll(/<at\s+user_id="([^"]+)"/gi))
        .map((match) => match[1]?.trim())
        .filter(Boolean) as string[];
      if (textMentionIds.some((id) => this.botIds.has(id))) {
        return true;
      }

      const paragraphs = Array.isArray(parsed.content) ? parsed.content : [];
      for (const paragraph of paragraphs) {
        if (!Array.isArray(paragraph)) continue;
        for (const element of paragraph) {
          if (element?.tag === 'at' && element.user_id && this.botIds.has(element.user_id)) {
            return true;
          }
        }
      }
    } catch {
      return false;
    }

    return false;
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
