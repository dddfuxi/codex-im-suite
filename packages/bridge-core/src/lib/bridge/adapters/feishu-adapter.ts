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
  RunSummary,
  UploadedFileLink,
} from '../types.js';
import type { FileAttachment } from '../types.js';
import type { ToolCallInfo } from '../types.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter.js';
import type {
  ConversationMessageRequest,
  ConversationMessageSendResult,
  ConversationTargetResolveRequest,
  ConversationTargetResolveResult,
  DirectMessageRequest,
  DirectMessageSendResult,
  OutboundMentionResolutionInspection,
  ResolvedConversationTarget,
} from '../channel-adapter.js';
import { getBridgeContext } from '../context.js';
import { MemoryArtifactStore, createBridgeMemoryArtifactStore } from '../memory-artifact-store.js';
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
import {
  containsFeishuCardCompatibilityPlaceholder,
  parseFeishuInteractiveCardEvidence,
  removeFeishuCardCompatibilityPlaceholder,
  type FeishuInteractiveCardEvidence,
  type FeishuInteractiveCardResourceRef,
} from '../feishu-interactive-card-evidence.js';

/** Max number of message_ids to keep for dedup. */
const DEDUP_MAX = 1000;

/** Max file download size (20 MB). */
const MAX_FILE_SIZE = 20 * 1024 * 1024;
/** Feishu IM file upload limit is 30 MB for bot file messages. */
const MAX_UPLOAD_FILE_SIZE = 30 * 1024 * 1024;
type FeishuUploadFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';

/** Feishu emoji type for typing indicator (same as Openclaw). */
const TYPING_EMOJI = 'Typing';
const FEISHU_BOT_TO_BOT_LOOP_TTL_MS = 5 * 60 * 1000;
const FEISHU_BOT_TO_BOT_MAX_TURNS_DEFAULT = 2;
const FEISHU_STICKER_AUTO_SEND_MIN_CONFIDENCE = 0.45;

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
    target: (match[2] || '表情包').trim(),
    remainingText: match[3].trimStart(),
  };
}

function looksLikeFeishuStickerFileKey(value: string): boolean {
  const trimmed = value.trim();
  return /^(?:file_v\d+_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f-]{20,})$/i.test(trimmed);
}

function isExplicitFeishuStickerSendRequest(text: string): boolean {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  if (!normalized || normalized.length > 80) return false;
  if (/(?:不要|别|不用|禁止|别发|不要发)(?:.*?)(?:表情包|表情|sticker|贴纸)/iu.test(normalized)) return false;
  if (/(?:为什么|为何|原因|问题|失败|不能|不会|识别|解释|含义|意思)/iu.test(normalized)) return false;
  const hasStickerNoun = /(?:表情包|表情|sticker|贴纸)/iu.test(normalized);
  const hasSendIntent = /(?:发|发送|回|回复|来|整|丢|贴|用|给|send|reply|post)/iu.test(normalized);
  return hasStickerNoun && hasSendIntent;
}

function hasSpecificStickerSemanticConstraint(text: string): boolean {
  const compact = text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  if (!compact) return false;
  // 这些是“用途/情绪/语气”约束，不是具体表情写死；命中后必须语义匹配才可发 sticker。
  return /(夸|夸奖|称赞|表扬|赞美|真棒|棒呀|厉害|优秀|鼓励|加油|安慰|抱抱|难过|委屈|生气|愤怒|吐槽|嘲讽|反讽|疑惑|迷惑|懵|尴尬|无语|震惊|惊讶|开心|快乐|高兴|笑|哈哈|感谢|谢谢|抱歉|对不起|庆祝|恭喜|告别|晚安|早安|可爱|撒娇|害羞|期待|拒绝|警告|严肃|催促|困|累|破防|离谱)/iu.test(compact);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BARE_AT_TARGET_RE = /(^|[\s([{（【])@([^\s@,，.。!！?？~～:：;；<>\])）】]{1,64})(?=$|[\s,，.。!！?？~～:：;；<>\])）】])/gu;
const BARE_AT_BOUNDARY_CLASS = '[\\s([{（【]';
const BARE_AT_END_BOUNDARY_CLASS = '[\\s,，.。!！?？~～:：;；<>\\])）】]';
const FEISHU_AT_ALL_ALIASES = new Set(['all', '所有人', '全体成员', '大家']);
const FEISHU_SENDER_ALIASES = new Set(['我', '俺', '本人', '你', '用户', '发起人', '提问人', '发送者']);

const BOT_NAME_WAKE_INVESTIGATE_RE = /(?:帮|看看|看一下|查|搜索|搜|找|总结|梳理|分析|解释|处理|排查|检查|修|改|写|生成|创建|读取|打开|截图|提醒|记录|记住|发给|转发|同步|部署|运行|测试|构建|发布|瞅|弄|搞|做)/iu;
const BOT_NAME_WAKE_CHAT_RE = /(?:你觉得|你看|怎么想|在吗|你好|哈喽|hi|hello|说说|聊聊|回复|回答|为什么|怎么|能不能|可不可以|可以|是否|是不是|吗|呢|\?|？)/iu;
const BOT_NAME_WAKE_MENTION_ACTION_RE = /(?:艾特|@|＠|mention|提到|点名|叫|喊|通知)/iu;
const BOT_NAME_WAKE_DONE_RE = /^(?:不用回|不用回复|别回|别回复|不用处理|不用管|没事|算了|好了|结束|先这样)/iu;
const BOT_NAME_WAKE_NARRATIVE_AFTER_RE = /^(?:说的|说过|讲的|讲过|提过|发的|回复的|给的|那个|这个|这些|那些|刚才|之前|上次|前面)/iu;
const BOT_NAME_WAKE_OTHER_PERSON_BEFORE_RE = /(?:问|问问|叫|喊|找|联系|通知)$/iu;
const BOT_NAME_WAKE_OTHER_PERSON_AFTER_RE = /^(?:了吗|了没|没有|没|过吗|一下|下)/iu;
const FEISHU_CARD_COMPATIBILITY_PLACEHOLDERS = [
  '请升级至最新版本客户端，以查看内容',
  '请升级到最新版本客户端，以查看内容',
];
const FEISHU_STICKER_LIBRARY_CANDIDATE_LIMIT = 24;

interface FeishuMentionCandidate {
  userId: string;
  name: string;
  aliases: string[];
}

const FEISHU_MENTION_SEARCH_SOURCES = [
  '本轮入站 @',
  '本地历史 @ 记录',
  '当前群成员',
  '当前群机器人',
];

interface FeishuMentionHistoryCache {
  signature: string;
  candidates: FeishuMentionCandidate[];
}

type FeishuBotWakeState = 'chat' | 'investigate' | 'need_info' | 'done';

interface FeishuBotNameWakeClassification {
  mode: 'name';
  state: FeishuBotWakeState;
  alias: string;
  reason: 'actionable_request' | 'direct_chat' | 'mention_target_missing' | 'done_ack' | 'non_actionable';
  shouldHandle: boolean;
}

function cleanMentionName(name: string | undefined, fallback = '用户'): string {
  const cleaned = (name || '').replace(/^@+/, '').replace(/[<>"]/g, '').trim();
  if (!cleaned || /^o[cu]_[A-Za-z0-9_-]+$/u.test(cleaned)) return fallback;
  return cleaned;
}

function normalizeMentionAlias(name: string | undefined): string {
  return (name || '').replace(/^@+/, '').replace(/\s+/g, '').trim().toLowerCase();
}

function isDefinitelyNonUserMentionId(id: string | undefined): boolean {
  const normalized = (id || '').trim().toLowerCase();
  return /^cli_/u.test(normalized)
    || /^app_/u.test(normalized)
    || /^bot_/u.test(normalized);
}

function inferDirectMessageReceiveIdType(id: string): 'open_id' | 'union_id' | 'user_id' {
  const normalized = id.trim();
  if (/^ou_/iu.test(normalized)) return 'open_id';
  if (/^on_/iu.test(normalized)) return 'union_id';
  return 'user_id';
}

function extractVerifiedMentionCandidatesFromText(text: string): FeishuMentionCandidate[] {
  const candidates: FeishuMentionCandidate[] = [];
  const seen = new Set<string>();
  const pattern = /<at\s+[^>]*\b(?:user_id|id)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/at>/giu;

  for (const match of text.matchAll(pattern)) {
    const userId = (match[1] || match[2] || match[3] || '').trim();
    if (!userId || userId.toLowerCase() === 'all' || isDefinitelyNonUserMentionId(userId)) continue;
    const name = cleanMentionName(match[4], '');
    if (!name) continue;
    const key = `${userId}\u0000${normalizeMentionAlias(name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ userId, name, aliases: [name] });
  }

  return candidates;
}

function extractBareAtTargets(text: string): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const match of String(text || '').matchAll(BARE_AT_TARGET_RE)) {
    const target = cleanMentionName(match[2], '').trim();
    const key = normalizeMentionAlias(target);
    if (!target || !key || seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

function replaceBareAtTarget(text: string, target: string, replacementName: string): string {
  const safeTarget = escapeRegExp(target);
  const pattern = new RegExp(`(^|${BARE_AT_BOUNDARY_CLASS})@${safeTarget}(?=$|${BARE_AT_END_BOUNDARY_CLASS})`, 'gu');
  return text.replace(pattern, (_match, prefix: string) => `${prefix}@${replacementName}`);
}

function getRawObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function uniqueCleanStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const cleaned = cleanMentionName(value, '');
    const key = normalizeMentionAlias(cleaned);
    if (!cleaned || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function pickFeishuMentionableMemberId(item: FeishuChatMemberListItem, allowLegacyMemberId = false): string {
  const raw = getRawObject(item);
  const id = getRawObject(item.id);
  const user = getRawObject(item.user);
  const bot = getRawObject(item.bot);
  const directId = firstNonEmptyString(
    item.open_id,
    item.openId,
    id.open_id,
    id.openId,
    user.open_id,
    user.openId,
    bot.open_id,
    bot.openId,
    item.user_id,
    item.userId,
    id.user_id,
    id.userId,
    user.user_id,
    user.userId,
    bot.user_id,
    bot.userId,
    item.union_id,
    item.unionId,
    id.union_id,
    id.unionId,
    user.union_id,
    user.unionId,
    bot.union_id,
    bot.unionId,
  );
  if (directId) return directId;

  const memberId = firstNonEmptyString(item.member_id, item.memberId, raw.memberId);
  const memberIdType = firstNonEmptyString(item.member_id_type, item.memberIdType, raw.memberIdType).toLowerCase();
  if (!memberId) return '';
  if (['open_id', 'user_id', 'union_id'].includes(memberIdType)) return memberId;
  // 旧 members 接口在请求 member_id_type=open_id 后只给 member_id，可继续作为普通成员候选；
  // 新 members/list 的 bots[] 若没有类型，只接受明显的 open_id/union_id，避免把 bot_id/app_id 误当原生 @ ID。
  if (allowLegacyMemberId || /^o[un]_/iu.test(memberId)) return memberId;
  return '';
}

function buildFeishuMentionCandidateFromMember(item: FeishuChatMemberListItem, allowLegacyMemberId = false): FeishuMentionCandidate | null {
  const raw = getRawObject(item);
  const user = getRawObject(item.user);
  const bot = getRawObject(item.bot);
  const i18nName = getRawObject(item.i18n_name);
  const localizedName = getRawObject(item.localized_name);
  const userId = pickFeishuMentionableMemberId(item, allowLegacyMemberId);
  if (!userId || isDefinitelyNonUserMentionId(userId)) return null;

  const aliases = uniqueCleanStrings([
    item.name,
    item.user_name,
    item.userName,
    item.display_name,
    item.displayName,
    item.nickname,
    item.en_name,
    item.enName,
    item.app_name,
    item.appName,
    item.bot_name,
    item.botName,
    raw.name,
    raw.displayName,
    raw.appName,
    raw.botName,
    user.name,
    user.display_name,
    user.displayName,
    user.user_name,
    user.userName,
    bot.name,
    bot.app_name,
    bot.appName,
    bot.bot_name,
    bot.botName,
    i18nName.zh_cn,
    i18nName.en_us,
    localizedName.zh_cn,
    localizedName.en_us,
  ]);
  const name = aliases[0] || '';
  if (!name) return null;
  return { userId, name, aliases };
}

function stripFeishuReactionHintText(text: string, hint: FeishuReactionHint): string {
  return hint.remainingText
    || text.replace(new RegExp(`^\\s*\\[${escapeRegExp(hint.raw)}\\]\\s*`, 'u'), '').trim();
}

function stripStandaloneStatusMarks(text: string): string {
  return String(text || '')
    .replace(/^\s*(?:✅|✔|☑|❌|×)\s*$/gmu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function meaningfulHintRemainder(text: string, fallback: string): string {
  const remaining = String(text || '').trim();
  return stripStandaloneStatusMarks(remaining) ? remaining : fallback;
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

function getFeishuHistoryDirPath(): string {
  return path.join(
    process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im'),
    'data',
    'feishu-history',
  );
}

function getFeishuStickerStorePath(): string {
  return createBridgeMemoryArtifactStore().feishuStickerStorePath();
}

function getFeishuStickerCacheDirPath(): string {
  return createBridgeMemoryArtifactStore().feishuStickerMediaDirPath();
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
  annotationSource?: 'vision' | 'manual' | 'user';
  annotationVerifiedAt?: string;
  annotationUpdatedAt?: string;
  userAnnotation?: FeishuStickerUserAnnotation;
  learnedFromMessageId?: string;
  disabled?: boolean;
  disabledReason?: string;
  lastEditedAt?: string;
  chatId?: string;
  userId?: string;
  messageId?: string;
  mediaCachedAt?: string;
  mediaDownloadFailedAt?: string;
  mediaDownloadError?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastUsedAt?: string;
  useCount: number;
}

interface FeishuStickerUserAnnotation {
  label?: string;
  description?: string;
  intent?: string;
  tone?: string;
  usage?: string;
  avoidWhen?: string;
  aliases?: string[];
  examples?: string[];
  annotationConfidence?: number;
  learnedFromMessageId?: string;
  userId?: string;
  updatedAt?: string;
}

interface FeishuStickerStore {
  version: 1;
  updatedAt: string;
  stickers: FeishuStickerRecord[];
  historyBackfills?: Record<string, FeishuStickerHistoryBackfillRecord>;
}

interface FeishuStickerHistoryBackfillRecord {
  chatId: string;
  latestMessageTime?: string;
  completedAt: string;
  candidateCount: number;
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
  userAnnotation?: FeishuStickerUserAnnotation;
}

interface FeishuStickerLibraryCandidateEvidence {
  fileKey: string;
  chatId?: string;
  messageId?: string;
  label?: string;
  intent?: string;
  tone?: string;
  usage?: string;
  annotationSource?: FeishuStickerRecord['annotationSource'];
  annotationConfidence?: number;
  imageAttached: boolean;
  lastSeenAt?: string;
}

interface FeishuStickerLibraryContextEvidence {
  prompt: string;
  candidateCount: number;
  attachedImageCount: number;
  fileKeys: string[];
  attachedFileKeys: string[];
  candidates: FeishuStickerLibraryCandidateEvidence[];
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
      app_id?: string;
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

interface FeishuLightContext {
  prompt: string;
  messageCount: number;
  replyToMessageId?: string;
}

interface ParsedFeishuInteractiveContent {
  text: string;
  rawText: string;
  imageKeys: string[];
  fileKeys: string[];
  resourceRefs: FeishuInteractiveCardResourceRef[];
  cardRefs: string[];
  textParts: string[];
  rawPreview: string;
  compatibilityPlaceholderRemoved: boolean;
  parseWarnings: string[];
  evidence: FeishuInteractiveCardEvidence;
}

interface FeishuResourceDownloadFailure {
  resourceType: string;
  key: string;
  endpoint: 'message_resource_sdk' | 'message_resource_http' | 'image_http';
  status?: number;
  code?: number | string;
  msg?: string;
  error?: string;
}

interface FeishuInteractiveResourceDownloadResult {
  attachments: FileAttachment[];
  failures: FeishuResourceDownloadFailure[];
}

interface FeishuLightContextMention {
  key?: string;
  name?: string;
  openId?: string;
  userId?: string;
  unionId?: string;
}

interface FeishuChatMemberItem {
  member_id?: string;
  member_id_type?: string;
  name?: string;
}

interface FeishuChatMemberListItem {
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
  id?: { open_id?: string; openId?: string; user_id?: string; userId?: string; union_id?: string; unionId?: string };
  user?: Record<string, unknown>;
  bot?: Record<string, unknown>;
  i18n_name?: Record<string, unknown>;
  localized_name?: Record<string, unknown>;
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
  private mentionHistoryCache: FeishuMentionHistoryCache | null = null;
  private botToBotLoopState = new Map<string, { count: number; updatedAt: number }>();
  private p2pPollTimer: ReturnType<typeof setInterval> | null = null;
  private p2pPollInFlight = false;

  private getLightContextMessageLimit(): number {
    const raw = getBridgeContext().store.getSetting('bridge_feishu_light_context_limit')
      || process.env.CTI_FEISHU_LIGHT_CONTEXT_LIMIT
      || '6';
    const parsed = Number.parseInt(raw, 10);
    return Math.max(0, Math.min(Number.isFinite(parsed) ? parsed : 6, 12));
  }

  private isStreamingCardEnabled(): boolean {
    const raw =
      getBridgeContext().store.getSetting('bridge_feishu_streaming_card_enabled')
      || process.env.CTI_FEISHU_STREAMING_CARD_ENABLED
      || 'true';
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
  }

  private isBotToBotReplyEnabled(): boolean {
    const raw =
      getBridgeContext().store.getSetting('bridge_feishu_bot_to_bot_enabled')
      || process.env.CTI_FEISHU_BOT_TO_BOT_ENABLED
      || 'true';
    return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
  }

  private getBotToBotMaxTurns(): number {
    const raw =
      getBridgeContext().store.getSetting('bridge_feishu_bot_to_bot_max_turns')
      || process.env.CTI_FEISHU_BOT_TO_BOT_MAX_TURNS
      || String(FEISHU_BOT_TO_BOT_MAX_TURNS_DEFAULT);
    const parsed = Number.parseInt(raw, 10);
    return Math.max(0, Math.min(Number.isFinite(parsed) ? parsed : FEISHU_BOT_TO_BOT_MAX_TURNS_DEFAULT, 8));
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
      const rawBackfills = parsed.historyBackfills && typeof parsed.historyBackfills === 'object' && !Array.isArray(parsed.historyBackfills)
        ? parsed.historyBackfills
        : {};
      const historyBackfills: Record<string, FeishuStickerHistoryBackfillRecord> = {};
      for (const [chatId, value] of Object.entries(rawBackfills)) {
        if (!value || typeof value !== 'object') continue;
        const record = value as Partial<FeishuStickerHistoryBackfillRecord>;
        const normalizedChatId = String(record.chatId || chatId).trim();
        if (!normalizedChatId) continue;
        historyBackfills[normalizedChatId] = {
          chatId: normalizedChatId,
          latestMessageTime: typeof record.latestMessageTime === 'string' ? record.latestMessageTime : undefined,
          completedAt: typeof record.completedAt === 'string' ? record.completedAt : '',
          candidateCount: Number.isFinite(Number(record.candidateCount)) ? Number(record.candidateCount) : 0,
        };
      }
      return {
        version: 1,
        updatedAt: parsed.updatedAt || '',
        stickers: stickers.map((item) => this.sanitizeStickerRecord(item as FeishuStickerRecord)),
        historyBackfills,
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

  private getStickerCachePath(fileKey: string): string {
    return path.join(getFeishuStickerCacheDirPath(), MemoryArtifactStore.stableFileName(fileKey, '.png'));
  }

  private readCachedStickerResource(fileKey: string): FileAttachment | null {
    if (!fileKey.trim()) return null;
    try {
      const cachePath = this.getStickerCachePath(fileKey);
      if (!fs.existsSync(cachePath)) return null;
      const stat = fs.statSync(cachePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_SIZE) return null;
      const buffer = fs.readFileSync(cachePath);
      return {
        id: fileKey,
        name: `sticker-${fileKey}.png`,
        type: 'image/png',
        size: buffer.length,
        data: buffer.toString('base64'),
        filePath: cachePath,
      };
    } catch (err) {
      console.warn('[feishu-adapter] Failed to read sticker cache:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  private writeCachedStickerResource(fileKey: string, attachment: FileAttachment): FileAttachment | null {
    if (!fileKey.trim() || !attachment.data) return null;
    try {
      const cachePath = this.getStickerCachePath(fileKey);
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const buffer = Buffer.from(attachment.data, 'base64');
      if (!buffer.length || buffer.length > MAX_FILE_SIZE) return null;
      fs.writeFileSync(cachePath, buffer);
      return this.readCachedStickerResource(fileKey);
    } catch (err) {
      console.warn('[feishu-adapter] Failed to write sticker cache:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  private updateStickerMediaState(fileKey: string, patch: Partial<Pick<FeishuStickerRecord,
    'mediaCachedAt' | 'mediaDownloadFailedAt' | 'mediaDownloadError'
  >>): void {
    const normalized = fileKey.trim();
    if (!normalized) return;
    const now = new Date().toISOString();
    const store = this.readStickerStore();
    let record = store.stickers.find((item) => item.fileKey === normalized);
    if (!record) {
      record = {
        fileKey: normalized,
        aliases: [],
        firstSeenAt: now,
        lastSeenAt: now,
        useCount: 0,
      };
      store.stickers.push(record);
    }
    Object.assign(record, patch);
    if (patch.mediaCachedAt) {
      delete record.mediaDownloadFailedAt;
      delete record.mediaDownloadError;
    }
    store.updatedAt = now;
    try {
      this.writeStickerStore(store);
    } catch (err) {
      console.warn('[feishu-adapter] Failed to update sticker media state:', err instanceof Error ? err.message : err);
    }
  }

  private shouldAttemptStickerMediaDownload(fileKey: string): boolean {
    const record = this.getStickerRecord(fileKey);
    return !record?.mediaDownloadFailedAt;
  }

  private async downloadAndCacheStickerResource(messageId: string, fileKey: string): Promise<FileAttachment | null> {
    if (!this.shouldAttemptStickerMediaDownload(fileKey)) return null;
    const attachment = await this.downloadResource(messageId, fileKey, 'image');
    if (!attachment) {
      this.updateStickerMediaState(fileKey, {
        mediaDownloadFailedAt: new Date().toISOString(),
        mediaDownloadError: 'Feishu message resource API did not return sticker media',
      });
      return null;
    }
    const cached = this.writeCachedStickerResource(fileKey, attachment);
    if (cached) {
      this.updateStickerMediaState(fileKey, { mediaCachedAt: new Date().toISOString() });
      return cached;
    }
    return attachment;
  }

  private getStoredStickerResource(fileKey: string): FileAttachment | null {
    // 已缓存的表情包图片优先来自记忆仓库，命中后直接给视觉模型，避免同一表情包反复下载。
    return this.readCachedStickerResource(fileKey);
  }

  private getCurrentFeishuHistoryLatestMessageTime(chatId: string): string {
    try {
      return this.getExtendedStore().getFeishuHistorySyncStatus?.(chatId)?.[0]?.latestMessageTime?.trim() || '';
    } catch {
      return '';
    }
  }

  private countStickerCandidatesForChat(chatId: string): number {
    return this.readStickerStore().stickers
      .filter((item) => !item.disabled && item.fileKey?.trim())
      .filter((item) => !item.chatId || item.chatId === chatId)
      .length;
  }

  private shouldBackfillStickerHistoryForChat(chatId: string): boolean {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) return false;
    const latestMessageTime = this.getCurrentFeishuHistoryLatestMessageTime(normalizedChatId);
    const record = this.readStickerStore().historyBackfills?.[normalizedChatId];
    if (!record) return true;
    if (latestMessageTime && record.latestMessageTime !== latestMessageTime) return true;
    return false;
  }

  private markStickerHistoryBackfilled(chatId: string): void {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) return;
    const store = this.readStickerStore();
    store.historyBackfills = store.historyBackfills || {};
    const now = new Date().toISOString();
    store.historyBackfills[normalizedChatId] = {
      chatId: normalizedChatId,
      latestMessageTime: this.getCurrentFeishuHistoryLatestMessageTime(normalizedChatId),
      completedAt: now,
      candidateCount: this.countStickerCandidatesForChat(normalizedChatId),
    };
    store.updatedAt = now;
    try {
      this.writeStickerStore(store);
    } catch (err) {
      console.warn('[feishu-adapter] Failed to persist sticker history backfill marker:', err instanceof Error ? err.message : err);
    }
  }

  private async ensureStickerHistoryBackfilledForRequest(
    chatId: string,
    chatType: string,
    displayName: string,
    requestText: string,
  ): Promise<void> {
    if (!isExplicitFeishuStickerSendRequest(requestText)) return;
    if (!this.getExtendedStore().upsertFeishuHistoryMessages) return;
    if (!this.shouldBackfillStickerHistoryForChat(chatId)) return;
    try {
      await this.syncIndexedChatHistory(chatId, chatType, displayName, true);
      this.markStickerHistoryBackfilled(chatId);
    } catch (err) {
      console.warn('[feishu-adapter] sticker history backfill failed:', err instanceof Error ? err.message : err);
    }
  }

  private summarizeStickerCandidate(record: FeishuStickerRecord, imageAttached: boolean): FeishuStickerLibraryCandidateEvidence {
    return {
      fileKey: record.fileKey,
      chatId: record.chatId,
      messageId: record.messageId,
      label: record.label,
      intent: record.intent,
      tone: record.tone,
      usage: record.usage,
      annotationSource: record.annotationSource,
      annotationConfidence: record.annotationConfidence,
      imageAttached,
      lastSeenAt: record.lastSeenAt,
    };
  }

  private formatStickerCandidateEvidenceLine(candidate: FeishuStickerLibraryCandidateEvidence, currentChatId: string): string {
    const parts = [
      `fileKey=${candidate.fileKey}`,
      candidate.imageAttached ? 'image=attached' : 'image=not_attached',
      candidate.chatId === currentChatId ? 'chat=current' : candidate.chatId ? 'chat=other' : '',
      candidate.label?.trim() ? `label=${candidate.label.trim()}` : '',
      candidate.intent?.trim() ? `intent=${candidate.intent.trim()}` : '',
      candidate.tone?.trim() ? `tone=${candidate.tone.trim()}` : '',
      candidate.usage?.trim() ? `usage=${candidate.usage.trim()}` : '',
      candidate.annotationSource ? `source=${candidate.annotationSource}` : 'source=unverified_or_unknown',
      Number.isFinite(Number(candidate.annotationConfidence)) ? `confidence=${Number(candidate.annotationConfidence).toFixed(2)}` : '',
    ].filter(Boolean);
    return `- ${parts.join('; ')}`;
  }

  private buildStickerLibraryContextPrompt(input: {
    requestText: string;
    chatId: string;
    candidates: FeishuStickerLibraryCandidateEvidence[];
    attachedFileKeys: string[];
  }): string {
    const attachedList = input.attachedFileKeys.length ? input.attachedFileKeys.join(', ') : 'none';
    const candidateLines = input.candidates.length
      ? input.candidates
        .slice(0, FEISHU_STICKER_LIBRARY_CANDIDATE_LIMIT)
        .map((candidate) => this.formatStickerCandidateEvidenceLine(candidate, input.chatId))
      : ['- no recorded sticker candidates are available yet'];
    return [
      'Feishu sticker library candidate evidence:',
      `- User request: ${input.requestText}`,
      `- Candidate sticker images from chat history attached for visual inspection: ${attachedList}.`,
      '- Inspect the attached candidate images before choosing. File keys, old aliases, and user-provided explanations are retrieval evidence, not visual facts.',
      `- Only send a sticker when it is 合适: the image content or a trusted vision/manual annotation must match the requested tone, scene, and reply timing. Vision confidence below ${FEISHU_STICKER_AUTO_SEND_MIN_CONFIDENCE} is evidence, not an auto-send signal.`,
      '- If a candidate is suitable, put exactly one invisible action hint at the beginning of the final reply, such as `[表情包:file_key]`, then write the visible reply naturally.',
      '- If no candidate is suitable or the images are unreadable, do not use `[表情包]`; reply with text or a native reaction hint only when appropriate.',
      '- Do not mention file keys, candidate counts, or this evidence prompt to the user unless they explicitly ask for diagnostics.',
      'Candidates:',
      ...candidateLines,
    ].join('\n');
  }

  private async buildStickerLibraryEvidenceForRequest(chatId: string, requestText: string): Promise<{
    context: FeishuStickerLibraryContextEvidence;
    attachments: FileAttachment[];
  } | null> {
    if (!isExplicitFeishuStickerSendRequest(requestText)) return null;
    const store = this.readStickerStore();
    const records = store.stickers
      .filter((item) => !item.disabled && item.fileKey?.trim())
      .sort((a, b) => Number(b.chatId === chatId) - Number(a.chatId === chatId)
        || Number(this.hasStickerAnnotation(b)) - Number(this.hasStickerAnnotation(a))
        || (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0))
      .slice(0, 80);

    const attachments: FileAttachment[] = [];
    const attachedFileKeys = new Set<string>();
    const candidates: FeishuStickerLibraryCandidateEvidence[] = [];

    for (const record of records) {
      let attachment: FileAttachment | null = null;
      if (attachments.length < FEISHU_STICKER_LIBRARY_CANDIDATE_LIMIT) {
        attachment = this.getStoredStickerResource(record.fileKey);
        if (!attachment && record.messageId) {
          attachment = await this.downloadAndCacheStickerResource(record.messageId, record.fileKey);
        }
        if (attachment?.type?.toLowerCase().startsWith('image/') && !attachedFileKeys.has(record.fileKey)) {
          attachments.push({
            ...attachment,
            id: record.fileKey,
            name: `sticker-candidate-${record.fileKey}.png`,
          });
          attachedFileKeys.add(record.fileKey);
        }
      }
      candidates.push(this.summarizeStickerCandidate(record, attachedFileKeys.has(record.fileKey)));
    }

    const attached = Array.from(attachedFileKeys);
    return {
      attachments,
      context: {
        prompt: this.buildStickerLibraryContextPrompt({
          requestText,
          chatId,
          candidates,
          attachedFileKeys: attached,
        }),
        candidateCount: candidates.length,
        attachedImageCount: attachments.length,
        fileKeys: candidates.map((candidate) => candidate.fileKey),
        attachedFileKeys: attached,
        candidates,
      },
    };
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
    const preferenceScore = (entry: FeishuEmojiProfileEntry): number => {
      const inboundPreference = entry.inboundCount * 4;
      const recentSuccessSignal = Math.min(entry.outboundSuccessCount, 2) * 0.25;
      const failurePenalty = entry.outboundFailureCount * 2;
      const smilePenalty = entry.emojiType === 'SMILE' && entry.inboundCount <= 0 ? 10 : 0;
      return inboundPreference + recentSuccessSignal - failurePenalty - smilePenalty;
    };
    const preferred = store.emojis
      .filter((item) => !item.disabled)
      .filter((item) => !chatId || !item.chatId || item.chatId === chatId)
      .filter((item) => !userId || !item.userId || item.userId === userId)
      .map((item) => ({ item, score: preferenceScore(item) }))
      .filter(({ item, score }) => score > 0 && (item.emojiType !== 'SMILE' || item.inboundCount > 0))
      .sort((a, b) => b.score - a.score || (Date.parse(b.item.lastSeenAt || '') || 0) - (Date.parse(a.item.lastSeenAt || '') || 0))
      .slice(0, 6)
      .map(({ item }) => {
        const alias = item.aliases?.[0] ? `/${item.aliases[0]}` : '';
        return `[${item.emojiType}${alias}]`;
      })
      .join(', ');
    return [
      'Feishu emoji presentation:',
      catalogHint ? `- Catalog examples: ${catalogHint}.` : '',
      preferred ? `- Learned preferences for this chat/user: ${preferred}. Treat these as weak tie-breakers after intent matching.` : '',
      '- Sticker hints have priority over reaction hints when a listed sticker semantically fits the light-chat reply.',
      '- Choose reaction hints by actual intent. Do not default to SMILE; use no reaction hint when the tone is neutral, formal, blocked, or unclear.',
      '- Use reaction hints as a fallback for greetings, acknowledgements, praise, jokes, and sticker-style banter when no sticker fits.',
      '- If a reaction hint fails, the adapter will keep or fallback the visible text; never rely on the hint as the only meaning.',
    ].filter(Boolean).join('\n');
  }

  getStickerPresentationPrompt(chatId?: string): string {
    const store = this.readStickerStore();
    const annotated = store.stickers
      .filter((item) => !item.disabled)
      .filter((item) => this.isStickerReliableForAutoSend(item))
      .filter((item) => !chatId || !item.chatId || item.chatId === chatId)
      .sort((a, b) => Number(b.chatId === chatId) - Number(a.chatId === chatId)
        || (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0))
      .slice(0, 8);
    if (annotated.length === 0) {
      return [
        'Feishu sticker library:',
        '- No semantically annotated stickers are available for this chat yet.',
        '- The adapter may know raw sticker file_keys, but raw file_keys are not reliable semantics and must not be used for generic sticker selection.',
        '- If the user explains a sticker meaning by replying to it, the adapter stores that as unverified user evidence and will prefer image/manual verification before future sticker selection.',
        '- Do not use sticker aliases because no sticker aliases are available yet.',
        '- Do not use bare `[表情包]` until at least one sticker has a reliable meaning, tone, or usage annotation for semantic matching.',
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
      '- Prefer a listed sticker for light chat when its meaning, tone, or usage matches the reply; use `[表情包:alias]` only with an alias listed above.',
      '- If no listed alias matches but the reply has a clear casual emotion, joke, acknowledgement, or banter tone, use bare `[表情包]` so the adapter can choose the best semantic match.',
      '- Sticker and reaction hints are invisible action hints. Do not explain that you are sending a sticker, and do not mention sticker file keys to the user.',
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
    const cleanText = (value: unknown, maxLength: number): string | undefined => {
      if (typeof value !== 'string') return undefined;
      const text = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
      if (!text || text.length > maxLength || this.isUnsafeStickerSemanticText(text)) return undefined;
      return text;
    };
    const cleanList = (values: unknown, maxItems: number, maxLength: number): string[] => (
      Array.isArray(values) ? values : []
    )
      .map((item) => cleanText(item, maxLength))
      .filter((item): item is string => Boolean(item))
      .slice(0, maxItems);
    const cleanUserAnnotation = (value: unknown): FeishuStickerUserAnnotation | undefined => {
      if (!value || typeof value !== 'object') return undefined;
      const source = value as Partial<FeishuStickerUserAnnotation>;
      const annotation: FeishuStickerUserAnnotation = {};
      const label = cleanText(source.label, 32);
      const description = cleanText(source.description, 180);
      const intent = cleanText(source.intent, 160);
      const tone = cleanText(source.tone, 80);
      const usage = cleanText(source.usage, 180);
      const avoidWhen = cleanText(source.avoidWhen, 180);
      const aliases = cleanList(source.aliases, 20, 32);
      const examples = cleanList(source.examples, 8, 120);
      if (label) annotation.label = label;
      if (description) annotation.description = description;
      if (intent) annotation.intent = intent;
      if (tone) annotation.tone = tone;
      if (usage) annotation.usage = usage;
      if (avoidWhen) annotation.avoidWhen = avoidWhen;
      if (aliases.length > 0) annotation.aliases = aliases;
      if (examples.length > 0) annotation.examples = examples;
      if (Number.isFinite(Number(source.annotationConfidence))) {
        annotation.annotationConfidence = Math.max(0, Math.min(1, Number(source.annotationConfidence)));
      }
      if (source.learnedFromMessageId) annotation.learnedFromMessageId = String(source.learnedFromMessageId);
      if (source.userId) annotation.userId = String(source.userId);
      if (source.updatedAt) annotation.updatedAt = String(source.updatedAt);
      return Object.keys(annotation).length > 0 ? annotation : undefined;
    };
    for (const key of ['label', 'description', 'intent', 'tone', 'usage', 'avoidWhen', 'disabledReason'] as const) {
      if (this.isUnsafeStickerSemanticText(cleaned[key])) delete cleaned[key];
    }
    cleaned.annotationSource = cleaned.annotationSource === 'vision' || cleaned.annotationSource === 'manual' || cleaned.annotationSource === 'user'
      ? cleaned.annotationSource
      : undefined;
    cleaned.disabled = cleaned.disabled === true;
    cleaned.annotationConfidence = Number.isFinite(Number(cleaned.annotationConfidence))
      ? Math.max(0, Math.min(1, Number(cleaned.annotationConfidence)))
      : cleaned.annotationConfidence;
    cleaned.examples = (Array.isArray(cleaned.examples) ? cleaned.examples : [])
      .map((item) => String(item || '').trim())
      .filter((item) => item && !this.isUnsafeStickerSemanticText(item))
      .slice(0, 8);
    cleaned.aliases = (Array.isArray(cleaned.aliases) ? cleaned.aliases : [])
      .map((item) => String(item || '').trim())
      .filter((item) => item && !this.isUnsafeStickerSemanticText(item))
      .slice(0, 20);
    const legacyUserTextAnnotation = !cleaned.annotationSource
      && Boolean(cleaned.learnedFromMessageId && cleaned.messageId && cleaned.learnedFromMessageId !== cleaned.messageId);
    if (legacyUserTextAnnotation) {
      const migratedUserAnnotation = cleanUserAnnotation({
        label: cleaned.label,
        description: cleaned.description,
        intent: cleaned.intent,
        tone: cleaned.tone,
        usage: cleaned.usage,
        avoidWhen: cleaned.avoidWhen,
        aliases: cleaned.aliases,
        examples: cleaned.examples,
        annotationConfidence: cleaned.annotationConfidence,
        learnedFromMessageId: cleaned.learnedFromMessageId,
        userId: cleaned.userId,
        updatedAt: cleaned.annotationUpdatedAt,
      });
      if (migratedUserAnnotation) cleaned.userAnnotation = migratedUserAnnotation;
      cleaned.annotationSource = 'user';
      delete cleaned.label;
      delete cleaned.description;
      delete cleaned.intent;
      delete cleaned.tone;
      delete cleaned.usage;
      delete cleaned.avoidWhen;
      delete cleaned.annotationConfidence;
      delete cleaned.annotationVerifiedAt;
    } else {
      cleaned.userAnnotation = cleanUserAnnotation(cleaned.userAnnotation);
    }
    return cleaned;
  }

  private tokenizeStickerSemanticText(value: string): Set<string> {
    const normalized = value.normalize('NFKC').toLowerCase();
    const tokens = new Set<string>();
    for (const token of normalized.split(/[^\p{L}\p{N}_+-]+/u)) {
      const trimmed = token.trim();
      if (trimmed.length >= 2) tokens.add(trimmed);
    }
    const compact = normalized.replace(/[^\p{L}\p{N}]/gu, '');
    const compactVariants = new Set([compact]);
    // 中文轻聊天里“了 / 啦 / 喽 / 咯”常只是语气差异；归一化后再做 n-gram，
    // 让“我来了”和“来啦来啦”这类同义表达先走语义匹配，而不是退到泛用候选。
    const colloquialParticleVariant = compact.replace(/[啦喽咯]/gu, '了');
    if (colloquialParticleVariant !== compact) compactVariants.add(colloquialParticleVariant);
    for (const variant of compactVariants) {
      for (let size = 2; size <= 4; size += 1) {
        for (let index = 0; index + size <= variant.length; index += 1) {
          tokens.add(variant.slice(index, index + size));
        }
      }
    }
    return tokens;
  }

  private stickerSemanticText(record: FeishuStickerRecord): string {
    return [
      record.label,
      record.description,
      record.intent,
      record.tone,
      record.usage,
      record.avoidWhen,
      ...(record.aliases || []),
      ...(record.examples || []),
    ].filter((item): item is string => Boolean(item?.trim())).join(' ');
  }

  private stickerUserAnnotationText(annotation?: FeishuStickerUserAnnotation): string {
    if (!annotation) return '';
    return [
      annotation.label,
      annotation.description,
      annotation.intent,
      annotation.tone,
      annotation.usage,
      annotation.avoidWhen,
      ...(annotation.aliases || []),
      ...(annotation.examples || []),
    ].filter((item): item is string => Boolean(item?.trim())).join(' ');
  }

  private hasSpecificStickerSemanticText(value: string): boolean {
    const compact = value
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s，,。.;；:：、"'“”‘’()[\]{}<>《》【】!！?？~～_-]+/gu, '')
      .replace(/(?:飞书|表情包|表情|sticker|贴纸|图片|图像|动图|一张|一个|这个|那个|用于|用来|使用|发送|回复|回话|聊天|消息|默认|随便|普通|轻量|发个|发|给你|来一个|来)/gu, '')
      .trim();
    return compact.length >= 2;
  }

  private stickerTextOverlapScore(left: string, right: string): number {
    const normalizedLeft = left.normalize('NFKC').toLowerCase().trim();
    const normalizedRight = right.normalize('NFKC').toLowerCase().trim();
    if (!normalizedLeft || !normalizedRight) return 0;
    if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return 80;
    const leftTokens = this.tokenizeStickerSemanticText(normalizedLeft);
    const rightTokens = this.tokenizeStickerSemanticText(normalizedRight);
    if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
    let score = 0;
    for (const token of leftTokens) {
      if (!rightTokens.has(token)) continue;
      score += token.length >= 4 ? 8 : token.length === 3 ? 5 : 3;
    }
    return score;
  }

  private stickerAvoidsContext(record: FeishuStickerRecord, contextText: string): boolean {
    return Boolean(record.avoidWhen?.trim() && this.stickerTextOverlapScore(contextText, record.avoidWhen) >= 12);
  }

  private stickerSemanticMatchScore(record: FeishuStickerRecord, contextText: string): number {
    if (!this.hasStickerAnnotation(record)) return 0;
    if (!contextText.trim() || this.stickerAvoidsContext(record, contextText)) return 0;
    return this.stickerTextOverlapScore(contextText, this.stickerSemanticText(record));
  }

  private stickerSemanticScore(record: FeishuStickerRecord, contextText: string, chatId?: string): number {
    if (record.disabled) return Number.NEGATIVE_INFINITY;
    if (contextText.trim() && this.stickerAvoidsContext(record, contextText)) return Number.NEGATIVE_INFINITY;
    const semanticText = this.stickerSemanticText(record);
    const semanticScore = contextText.trim() ? this.stickerTextOverlapScore(contextText, semanticText) : 0;
    return semanticScore
      + (record.chatId === chatId ? 20 : 0)
      + (this.hasStickerAnnotation(record) ? 16 : 0)
      + Math.round((Number(record.annotationConfidence) || 0) * 8)
      - Math.min(Number(record.useCount || 0), 20) * 0.25
      - Math.max(0, Date.now() - (Date.parse(record.lastUsedAt || '') || 0) < 60 * 60 * 1000 ? 3 : 0);
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

  private resolveStickerFileKey(target: string, chatId?: string, contextText = ''): string | null {
    const normalized = target.trim();
    const store = this.readStickerStore();
    if (looksLikeFeishuStickerFileKey(normalized)) {
      const record = store.stickers.find((item) => item.fileKey === normalized) || null;
      return this.isStickerReliableForAutoSend(record) ? normalized : null;
    }
    const alias = normalized || '最近';
    const genericTarget = /^(?:最近|默认|表情包|sticker|飞书表情包)$/iu.test(alias);
    const wantsRecent = /^最近$/u.test(alias);
    const compareCommon = (a: FeishuStickerRecord, b: FeishuStickerRecord): number =>
      Number(b.chatId === chatId) - Number(a.chatId === chatId)
      || Number(this.hasStickerAnnotation(b)) - Number(this.hasStickerAnnotation(a));
    const compareSemanticStickerCandidate = (a: FeishuStickerRecord, b: FeishuStickerRecord): number =>
      this.stickerSemanticScore(b, contextText, chatId) - this.stickerSemanticScore(a, contextText, chatId)
      || compareCommon(a, b)
      || (Number(a.useCount || 0) - Number(b.useCount || 0))
      || ((Date.parse(a.lastUsedAt || '') || 0) - (Date.parse(b.lastUsedAt || '') || 0))
      || ((Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0));
    const compareRecentStickerCandidate = (a: FeishuStickerRecord, b: FeishuStickerRecord): number =>
      compareCommon(a, b)
      || ((Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0));
    const compareRotatingStickerCandidate = (a: FeishuStickerRecord, b: FeishuStickerRecord): number =>
      compareCommon(a, b)
      || (Number(a.useCount || 0) - Number(b.useCount || 0))
      || ((Date.parse(a.lastUsedAt || '') || 0) - (Date.parse(b.lastUsedAt || '') || 0))
      || ((Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0));
    const compareSpecificStickerCandidate = (a: FeishuStickerRecord, b: FeishuStickerRecord): number =>
      compareCommon(a, b)
      || (Number(b.useCount || 0) - Number(a.useCount || 0))
      || ((Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0));
    const compareStickerCandidate = wantsRecent
      ? compareRecentStickerCandidate
      : genericTarget
        ? contextText.trim()
          ? compareSemanticStickerCandidate
          : compareRotatingStickerCandidate
        : compareSpecificStickerCandidate;
    const enabledStickers = store.stickers.filter((item) => !item.disabled);
    if (genericTarget) {
      const minimumSemanticScore = contextText.trim().length <= 8 ? 3 : 6;
      const genericCandidates = enabledStickers
        .filter((item) => this.isStickerReliableForAutoSend(item))
        .filter((item) => this.stickerSemanticMatchScore(item, contextText) >= minimumSemanticScore)
        .sort(compareSemanticStickerCandidate);
      if (genericCandidates[0]?.fileKey) return genericCandidates[0].fileKey;
      if (hasSpecificStickerSemanticConstraint(contextText)) return null;
      // 显式发表情包的轻量回复可能只剩“来啦~”这类低信息文本。
      // 没有文本重合时，仅允许从可信语义档案兜底选择，仍禁止无语义/低置信 file_key 轮换。
      const annotatedFallback = enabledStickers
        .filter((item) => this.isStickerReliableForAutoSend(item))
        .filter((item) => !contextText.trim() || !this.stickerAvoidsContext(item, contextText))
        .sort(compareSemanticStickerCandidate);
      return annotatedFallback[0]?.fileKey || null;
    }
    const byAlias = (genericTarget
      ? enabledStickers
      : enabledStickers
        .filter((item) => this.isStickerReliableForAutoSend(item))
        // 用户口头解释或旧快答残留可能写入 alias；只有已核验语义才能通过别名触发表情包发送。
        .filter((item) => (item.aliases || []).some((name) => name.toLowerCase() === alias.toLowerCase())))
      .filter((item) => !contextText.trim() || !this.stickerAvoidsContext(item, contextText))
      .sort(compareStickerCandidate);
    if (!genericTarget) return byAlias[0]?.fileKey || null;
    const fallback = enabledStickers
      .slice()
      .filter((item) => !contextText.trim() || !this.stickerAvoidsContext(item, contextText))
      .sort(compareStickerCandidate);
    return (byAlias[0] || fallback[0])?.fileKey || null;
  }

  private markStickerUsed(fileKey: string): void {
    const store = this.readStickerStore();
    const record = store.stickers.find((item) => item.fileKey === fileKey);
    if (!record) return;
    record.useCount = (record.useCount || 0) + 1;
    record.lastUsedAt = new Date().toISOString();
    store.updatedAt = record.lastUsedAt;
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
  }): { fileKey: string; annotation: FeishuStickerUserAnnotation } | null {
    const annotation = this.extractStickerAnnotationFromText(input.text);
    if (!annotation) return null;
    const target = this.findStickerAnnotationTarget(input);
    if (!target) return null;
    const lastSeen = Date.parse(target.lastSeenAt || '');
    if (Number.isFinite(lastSeen) && Date.now() - lastSeen > 10 * 60 * 1000 && !input.replyToMessageId) return null;
    const stored = this.recordStickerAnnotation({
      fileKey: target.fileKey,
      chatId: input.chatId,
      userId: input.userId,
      learnedFromMessageId: input.messageId,
      label: annotation.label,
      description: annotation.description,
      intent: annotation.intent,
      tone: annotation.tone,
      usage: annotation.usage,
      avoidWhen: annotation.avoidWhen,
      examples: annotation.examples,
      annotationConfidence: annotation.annotationConfidence,
      source: 'user',
    });
    if (!stored) return null;
    return {
      fileKey: target.fileKey,
      annotation: {
        label: annotation.label,
        description: annotation.description,
        intent: annotation.intent,
        tone: annotation.tone,
        usage: annotation.usage,
        avoidWhen: annotation.avoidWhen,
        aliases: annotation.aliases,
        examples: annotation.examples,
        annotationConfidence: annotation.annotationConfidence,
        learnedFromMessageId: input.messageId,
        userId: input.userId,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  private findStickerAnnotationTarget(input: {
    chatId: string;
    replyToMessageId?: string | null;
  }): FeishuStickerRecord | null {
    const store = this.readStickerStore();
    return store.stickers.find((item) => input.replyToMessageId && item.messageId === input.replyToMessageId)
      || store.stickers
        .filter((item) => item.chatId === input.chatId && !this.hasStickerAnnotation(item))
        .sort((a, b) => (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0))[0]
      || null;
  }

  recordStickerAnnotation(input: {
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
  }): boolean {
    const fileKey = input.fileKey?.trim();
    if (!fileKey) return false;
    const cleanText = (value: unknown, maxLength: number): string | undefined => {
      if (typeof value !== 'string') return undefined;
      const text = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
      if (!text || text.length > maxLength || this.isUnsafeStickerSemanticText(text)) return undefined;
      return text;
    };
    const cleanList = (values: unknown, maxItems: number, maxLength: number): string[] => (
      Array.isArray(values) ? values : []
    )
      .map((item) => cleanText(item, maxLength))
      .filter((item): item is string => Boolean(item))
      .slice(0, maxItems);
    const annotation = {
      label: cleanText(input.label, 32),
      description: cleanText(input.description, 180),
      intent: cleanText(input.intent, 160),
      tone: cleanText(input.tone, 80),
      usage: cleanText(input.usage, 180),
      avoidWhen: cleanText(input.avoidWhen, 180),
      aliases: cleanList(input.aliases, 20, 32),
      examples: cleanList(input.examples, 8, 120),
      annotationConfidence: Number.isFinite(Number(input.annotationConfidence))
        ? Math.max(0, Math.min(1, Number(input.annotationConfidence)))
        : undefined,
    };
    if (!annotation.label && !annotation.description && !annotation.intent && !annotation.tone && !annotation.usage) {
      return false;
    }
    const store = this.readStickerStore();
    const now = new Date().toISOString();
    let record = store.stickers.find((item) => item.fileKey === fileKey);
    if (!record) {
      record = {
        fileKey,
        aliases: [],
        chatId: input.chatId,
        userId: input.userId,
        messageId: input.learnedFromMessageId,
        firstSeenAt: now,
        lastSeenAt: now,
        useCount: 0,
      };
      store.stickers.push(record);
    }

    if (input.source === 'user') {
      record.userAnnotation = {
        label: annotation.label,
        description: annotation.description,
        intent: annotation.intent,
        tone: annotation.tone,
        usage: annotation.usage,
        avoidWhen: annotation.avoidWhen,
        aliases: annotation.aliases,
        examples: annotation.examples,
        annotationConfidence: annotation.annotationConfidence,
        learnedFromMessageId: input.learnedFromMessageId,
        userId: input.userId,
        updatedAt: now,
      };
      if (!record.annotationSource || record.annotationSource === 'user') {
        record.annotationSource = 'user';
      }
      record.annotationUpdatedAt = now;
      record.learnedFromMessageId = input.learnedFromMessageId || record.learnedFromMessageId;
      record.lastSeenAt = now;
      record.chatId = input.chatId || record.chatId;
      record.userId = input.userId || record.userId;
      store.updatedAt = now;
      store.stickers = store.stickers
        .sort((a, b) => (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0))
        .slice(0, 80);
      try {
        this.writeStickerStore(store);
        return true;
      } catch (err) {
        console.warn('[feishu-adapter] Failed to persist sticker user annotation:', err instanceof Error ? err.message : err);
        return false;
      }
    }

    const trustedSource: 'vision' | 'manual' = input.source === 'vision' ? 'vision' : 'manual';
    const canReplaceExisting = trustedSource === 'manual' || record.annotationSource !== 'manual';
    const assignTrustedText = <K extends 'label' | 'description' | 'intent' | 'tone' | 'usage' | 'avoidWhen'>(
      key: K,
      value: FeishuStickerRecord[K],
    ): void => {
      if (!value) return;
      if (canReplaceExisting || !record[key]) record[key] = value;
    };
    assignTrustedText('label', annotation.label);
    assignTrustedText('description', annotation.description);
    assignTrustedText('intent', annotation.intent);
    assignTrustedText('tone', annotation.tone);
    assignTrustedText('usage', annotation.usage);
    assignTrustedText('avoidWhen', annotation.avoidWhen);
    record.examples = Array.from(new Set([...(record.examples || []), ...annotation.examples])).slice(0, 8);
    record.annotationConfidence = annotation.annotationConfidence ?? record.annotationConfidence;
    record.annotationSource = trustedSource;
    record.annotationVerifiedAt = now;
    record.annotationUpdatedAt = now;
    record.learnedFromMessageId = input.learnedFromMessageId || record.learnedFromMessageId;
    record.lastSeenAt = now;
    record.chatId = input.chatId || record.chatId;
    record.userId = input.userId || record.userId;
    const aliasSource = [
      ...annotation.aliases,
      record.label,
      record.intent,
      record.description,
      record.usage,
    ]
      .filter((item): item is string => !!item?.trim())
      .flatMap((item) => item.split(/[，,、;；\s]+/).map((part) => part.trim()).filter((part) => part.length >= 2 && part.length <= 24));
    record.aliases = Array.from(new Set([...(record.aliases || []), ...aliasSource])).slice(0, 20);
    store.updatedAt = now;
    store.stickers = store.stickers
      .sort((a, b) => (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0))
      .slice(0, 80);
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
    const legacyTrusted = !!record
      && !record.annotationSource
      && !record.annotationVerifiedAt
      && !(
        record.learnedFromMessageId
        && record.messageId
        && record.learnedFromMessageId !== record.messageId
      );
    const trustedSource = record?.annotationSource === 'vision'
      || record?.annotationSource === 'manual'
      || Boolean(record?.annotationVerifiedAt)
      || legacyTrusted;
    return !!record && trustedSource && Boolean(
      record.label?.trim()
      || record.description?.trim()
      || record.intent?.trim()
      || record.tone?.trim()
      || record.usage?.trim(),
    );
  }

  private hasTrustedStickerSemanticSource(record: FeishuStickerRecord | null): boolean {
    return record?.annotationSource === 'vision'
      || record?.annotationSource === 'manual'
      || Boolean(record?.annotationVerifiedAt);
  }

  private hasReliableStickerSemantics(record: FeishuStickerRecord | null): boolean {
    if (!record || record.disabled || !this.hasStickerAnnotation(record)) return false;
    // 旧版无来源语义只作为 evidence 给 agent 参考，不能直接触发表情包发送。
    if (!this.hasTrustedStickerSemanticSource(record)) return false;
    // 只有“表情包 / 发一个 / 用于聊天”这类泛词时，说明还没有真正可用的语义。
    if (!this.hasSpecificStickerSemanticText(this.stickerSemanticText(record))) return false;
    const confidence = Number(record.annotationConfidence);
    // 低置信视觉读图仍可作为后续复核线索，但不能驱动自动发送，避免“看不懂也发”。
    if (record.annotationSource === 'vision') {
      if (!Number.isFinite(confidence)) return false;
      if (confidence < FEISHU_STICKER_AUTO_SEND_MIN_CONFIDENCE) return false;
    }
    return true;
  }

  private isStickerReliableForAutoSend(record: FeishuStickerRecord | null): boolean {
    return this.hasReliableStickerSemantics(record);
  }

  private buildStickerSemanticText(fileKey: string | null, record: FeishuStickerRecord | null): string {
    const keyPart = fileKey ? `，file_key=${fileKey}` : '';
    const parts = record && this.hasStickerAnnotation(record)
      ? [
        record.label?.trim() ? `图案/名称：${record.label.trim()}` : '',
        record.description?.trim() ? `描述：${record.description.trim()}` : '',
        record.intent?.trim() ? `通常意图：${record.intent.trim()}` : '',
        record.tone?.trim() ? `语气：${record.tone.trim()}` : '',
        record.usage?.trim() ? `适用场景：${record.usage.trim()}` : '',
      ].filter(Boolean).join('；')
      : '';
    if (record && this.hasReliableStickerSemantics(record)) {
      return [
        `用户发送了一个已记录语义的飞书表情包${keyPart}。`,
        `表情包语义：${parts}。`,
        '请按上述语义理解用户意图；不要把 file_key 当成图像内容。'
      ].join('\n');
    }
    if (parts) {
      return [
        `用户发送了一个飞书表情包${keyPart}。`,
        `历史语义线索待核验：${parts}。`,
        '这些线索缺少可信来源或置信度，不能直接当作图片事实；若没有图片附件，请不要凭 file_key 猜测含义。'
      ].join('\n');
    }
    return [
      `用户发送了一个尚未标注语义的飞书表情包${keyPart}。`,
      '当前没有可用的表情包图片附件，不能可靠识别图案、文字和意图。',
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
    summary?: RunSummary,
    mentions: OutboundMention[] = [],
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
        const fileKey = this.resolveStickerFileKey(stickerHint.target, chatId, stickerHint.remainingText);
        if (fileKey) {
          const stickerResult = await this.sendStickerMessage(chatId, fileKey, state.sourceMessageId);
          if (stickerResult.ok) {
            finalResponseText = meaningfulHintRemainder(stickerHint.remainingText, '表情包已发送。');
          }
        } else {
          finalResponseText = meaningfulHintRemainder(stickerHint.remainingText, '收到~');
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
          finalResponseText = meaningfulHintRemainder(textWithoutHint, '已回应。');
        } else {
          finalResponseText = applyReactionFallbackText(visibleFinalText, reactionHint, textWithoutHint);
        }
      }
      const finalCardJson = buildFinalCardJson(finalResponseText, state.toolCalls, footer, summary, mentions);

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

  async onStreamEnd(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
    summary?: RunSummary,
    mentions: OutboundMention[] = [],
  ): Promise<boolean> {
    if (!this.isStreamingCardEnabled()) return false;
    return this.finalizeCard(chatId, status, responseText, summary, mentions);
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
      const fileKey = this.resolveStickerFileKey(stickerHint.target, message.address.chatId, stickerHint.remainingText);
      if (fileKey) {
        const stickerResult = await this.sendStickerMessage(message.address.chatId, fileKey, message.replyToMessageId);
        if (stickerResult.ok) {
          text = stickerHint.remainingText;
          if (!stripStandaloneStatusMarks(text)) return stickerResult;
        }
      } else {
        text = meaningfulHintRemainder(stickerHint.remainingText, '收到~');
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
      const result = await this.sendAsCard(message.address.chatId, text, message.replyToMessageId, message.mentions);
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
    const content = JSON.stringify({ file_key: fileKey });
    const sendDirect = async (): Promise<SendResult> => {
      try {
        const res = await this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'sticker',
            content,
          },
        });
        if (res?.data?.message_id) {
          this.markStickerUsed(fileKey);
          console.log(`[feishu-adapter] Sticker send ok: {"chatId":"${chatId}","messageId":"${res.data.message_id}"}`);
          return { ok: true, messageId: res.data.message_id };
        }
        const error = res?.msg || 'Feishu sticker send failed';
        console.warn(`[feishu-adapter] Sticker direct send failed: ${error}`);
        return { ok: false, error };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.warn(`[feishu-adapter] Sticker direct send failed: ${error}`);
        return { ok: false, error };
      }
    };

    try {
      if (replyToMessageId) {
        const res = await this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'sticker', content },
        })
        if (res?.data?.message_id) {
          this.markStickerUsed(fileKey);
          console.log(`[feishu-adapter] Sticker reply send ok: {"chatId":"${chatId}","messageId":"${res.data.message_id}"}`);
          return { ok: true, messageId: res.data.message_id };
        }
        console.warn(`[feishu-adapter] Sticker reply send failed, retrying as direct chat send: ${res?.msg || 'Feishu sticker reply failed'}`);
        return sendDirect();
      }
      const res = await this.restClient!.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'sticker',
          content,
        },
      });
      if (res?.data?.message_id) {
        this.markStickerUsed(fileKey);
        console.log(`[feishu-adapter] Sticker send ok: {"chatId":"${chatId}","messageId":"${res.data.message_id}"}`);
        return { ok: true, messageId: res.data.message_id };
      }
      const error = res?.msg || 'Feishu sticker send failed';
      console.warn(`[feishu-adapter] Sticker send failed: ${error}`);
      return { ok: false, error };
    } catch (err) {
      if (replyToMessageId) {
        const error = err instanceof Error ? err.message : String(err);
        // Sticker is an independent expression payload; if Feishu rejects the reply-scoped call,
        // send the same real sticker into the source chat instead of silently degrading to text.
        console.warn(`[feishu-adapter] Sticker reply send failed, retrying as direct chat send: ${error}`);
        return sendDirect();
      }
      const error = err instanceof Error ? err.message : String(err);
      console.warn(`[feishu-adapter] Sticker send failed: ${error}`);
      return { ok: false, error };
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
  private async sendAsCard(
    chatId: string,
    text: string,
    replyToMessageId?: string,
    mentions: OutboundMention[] = [],
  ): Promise<SendResult> {
    const cardContent = buildCardContent(text, mentions);

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
        return this.sendAsCard(chatId, text, undefined, mentions);
      }
      console.warn('[feishu-adapter] Card send error, falling back to post:', err instanceof Error ? err.message : err);
    }

    // Fallback to post
    return this.sendAsPost(chatId, text, replyToMessageId, mentions);
  }

  /**
   * Send text as a post message (msg_type: 'post') with md tag.
   * Used for simple text — renders bold, italic, inline code, links.
   */
  private async sendAsPost(
    chatId: string,
    text: string,
    replyToMessageId?: string,
    mentions: OutboundMention[] = [],
  ): Promise<SendResult> {
    const postContent = buildPostContent(text, mentions);

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
        return this.sendAsPost(chatId, text, undefined, mentions);
      }
      console.warn('[feishu-adapter] Post send error, falling back to text:', err instanceof Error ? err.message : err);
    }

    // Final fallback: plain text
    try {
      const fallbackMessage: OutboundMessage = {
        address: { channelType: 'feishu', chatId },
        text,
        mentions,
      };
      const content = this.buildFeishuTextPayload(text, fallbackMessage);
      const res = replyToMessageId
        ? await this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'text', content },
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

  async recallMessage(_chatId: string, messageId: string): Promise<SendResult> {
    const trimmedMessageId = messageId.trim();
    if (!trimmedMessageId) {
      return { ok: false, error: '缺少要撤回的飞书消息 ID' };
    }

    try {
      if (this.restClient?.im?.message?.delete) {
        const res = await this.restClient.im.message.delete({
          path: { message_id: trimmedMessageId },
        });
        const code = Number((res as { code?: number | string })?.code ?? 0);
        if (code !== 0) {
          return { ok: false, error: String((res as { msg?: string })?.msg || 'Feishu message delete failed') };
        }
        return { ok: true, messageId: trimmedMessageId };
      }

      const { appId, appSecret, baseUrl } = this.getAuthContext();
      const tenantAccessToken = await this.fetchTenantAccessToken(appId, appSecret, baseUrl);
      const response = await fetch(`${baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(trimmedMessageId)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${tenantAccessToken}`,
          'Content-Type': 'application/json',
        },
      });
      const body = await response.json().catch(() => ({}));
      const code = Number((body as { code?: number | string })?.code ?? (response.ok ? 0 : response.status));
      if (!response.ok || code !== 0) {
        return { ok: false, error: String((body as { msg?: string })?.msg || `Feishu message delete failed: HTTP ${response.status}`) };
      }
      return { ok: true, messageId: trimmedMessageId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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

    // 先过滤当前 bot 自己、系统和没有明确 @ 当前 bot 的卡片事件；
    // 其他 bot/app 发送的原生 @ 会在群聊门禁里受控放行。
    if (this.shouldIgnoreInboundEvent(data)) return;

    // Dedup by message_id
    if (this.seenMessageIds.has(msg.message_id)) return;
    this.addToDedup(msg.message_id);

    const chatId = msg.chat_id;
    const replyTargetMessageId = this.getReplyTargetMessageId(msg);
    // [P2] Complete sender ID fallback chain: open_id > user_id > union_id
    const userId = sender.sender_id?.open_id
      || sender.sender_id?.user_id
      || sender.sender_id?.union_id
      || '';
    const isGroup = msg.chat_type === 'group';
    const isOtherBotSender = this.isInboundEventFromOtherBot(sender);
    let botToBotTurn: { chainCount: number; maxTurns: number; senderType: string } | null = null;
    let botNameWake: FeishuBotNameWakeClassification | null = null;

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

      if (isOtherBotSender) {
        if (!this.isBotToBotReplyEnabled()) {
          this.insertInboundFilterAudit(chatId, msg.message_id, '[FILTERED] Group message dropped: bot-to-bot replies disabled');
          return;
        }
        const nativeBotMentioned = this.isBotMentionedFromMessage(msg);
        if (!nativeBotMentioned) {
          this.insertInboundFilterAudit(chatId, msg.message_id, '[FILTERED] Group bot/app message dropped: current bot not natively mentioned');
          return;
        }
        botNameWake = this.classifyNativeBotMentionFromMessage(msg);
        if (botNameWake && !botNameWake.shouldHandle) {
          this.insertInboundFilterAudit(chatId, msg.message_id, '[FILTERED] Group bot/app message dropped: bot mention not actionable');
          return;
        }
        botToBotTurn = this.consumeBotToBotLoopBudget(chatId, msg.message_id, sender.sender_type);
        if (!botToBotTurn) return;
      } else {
        this.resetBotToBotLoop(chatId);
      }

      // Require @mention check
      const requireMention = getBridgeContext().store.getSetting('bridge_feishu_require_mention') !== 'false';
      if (requireMention && !isOtherBotSender) {
        const nativeBotMentioned = this.isBotMentionedFromMessage(msg);
        // 原生 @ 只证明消息关联到机器人；纠错、转述或让别人操作机器人名时仍可不入队。
        botNameWake = nativeBotMentioned
          ? this.classifyNativeBotMentionFromMessage(msg)
          : this.classifyBotNameWakeFromMessage(msg);
        const replyToKnownBotMessage = (!nativeBotMentioned && !botNameWake?.shouldHandle && replyTargetMessageId)
          ? await this.isReplyToKnownBotMessage(chatId, replyTargetMessageId)
          : false;
        if (!nativeBotMentioned && !botNameWake?.shouldHandle && !replyToKnownBotMessage) {
          const summary = botNameWake
            ? '[FILTERED] Group message dropped: bot name mention not actionable (require_mention=true)'
            : '[FILTERED] Group message dropped: bot not @mentioned (require_mention=true)';
          console.log('[feishu-adapter] Group message ignored (bot not @mentioned), chatId:', chatId, 'msgId:', msg.message_id);
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: 'feishu',
              chatId,
              direction: 'inbound',
              messageId: msg.message_id,
              summary,
            });
          } catch { /* best effort */ }
          return;
        }
        if (nativeBotMentioned && botNameWake && !botNameWake.shouldHandle) {
          console.log('[feishu-adapter] Group message ignored (bot mention not actionable), chatId:', chatId, 'msgId:', msg.message_id);
          try {
            getBridgeContext().store.insertAuditLog({
              channelType: 'feishu',
              chatId,
              direction: 'inbound',
              messageId: msg.message_id,
              summary: '[FILTERED] Group message dropped: bot mention not actionable (require_mention=true)',
            });
          } catch { /* best effort */ }
          return;
        }
      }
    } else if (isOtherBotSender) {
      this.insertInboundFilterAudit(chatId, msg.message_id, '[FILTERED] Non-group bot/app message dropped');
      return;
    }

    // Track last message ID per chat for typing indicator
    this.lastIncomingMessageId.set(chatId, msg.message_id);

    // Extract content based on message type
    const messageType = msg.message_type;
    let text = '';
    const attachments: FileAttachment[] = [];
    let stickerInfo: ParsedFeishuStickerContent | null = null;
    let interactiveInfo: ParsedFeishuInteractiveContent | null = null;
    let interactiveDownloadedAttachmentCount = 0;
    let interactiveResourceDownloadFailures: FeishuResourceDownloadFailure[] = [];

    if (messageType === 'text') {
      text = this.parseTextContent(msg.content);
      const stickerUserAnnotation = this.rememberStickerAnnotationFromText({
        chatId,
        userId,
        messageId: msg.message_id,
        replyToMessageId: replyTargetMessageId,
        text,
      });
      if (stickerUserAnnotation) {
        const attachment = this.getStoredStickerResource(stickerUserAnnotation.fileKey);
        if (attachment) attachments.push(attachment);
        stickerInfo = this.withStickerUserAnnotationEvidenceContext(
          stickerUserAnnotation.fileKey,
          stickerUserAnnotation.annotation,
          Boolean(attachment),
        );
        text = stickerInfo.text;
      }
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
        this.rememberSticker({
          fileKey: stickerFileKey,
          chatId,
          userId,
          messageId: msg.message_id,
        });
        const attachment = this.getStoredStickerResource(stickerFileKey)
          || await this.downloadAndCacheStickerResource(msg.message_id, stickerFileKey);
        if (attachment) {
          attachments.push(attachment);
          stickerInfo = this.withStickerImageContext(stickerInfo);
          text = stickerInfo.text;
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
    } else if (messageType === 'interactive') {
      interactiveInfo = this.parseInteractiveMessageContent(msg.content);
      const interactiveDownload = await this.downloadInteractiveCardResources(msg.message_id, interactiveInfo);
      if (interactiveDownload.attachments.length > 0) {
        attachments.push(...interactiveDownload.attachments);
      }
      interactiveDownloadedAttachmentCount = interactiveDownload.attachments.length;
      interactiveResourceDownloadFailures = interactiveDownload.failures;
      text = this.buildInteractiveInboundText(
        interactiveInfo,
        interactiveDownloadedAttachmentCount,
        interactiveResourceDownloadFailures,
      );
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
        appId: sender.sender_id?.app_id,
        senderType: sender.sender_type,
        chatType: msg.chat_type,
      },
      ...(botToBotTurn ? {
        feishuBotToBot: botToBotTurn,
      } : {}),
      ...(msg.mentions?.length ? {
        feishuMentions: msg.mentions.map((mention) => ({
          key: mention.key,
          name: mention.name,
          openId: mention.id.open_id,
          userId: mention.id.user_id,
          unionId: mention.id.union_id,
        })),
      } : {}),
      ...(botNameWake?.shouldHandle ? {
        feishuBotWake: {
          mode: botNameWake.mode,
          state: botNameWake.state,
          alias: botNameWake.alias,
          reason: botNameWake.reason,
        },
      } : {}),
      ...(stickerInfo ? { sticker: stickerInfo } : {}),
      ...(stickerInfo ? { messageKind: stickerInfo.messageKind } : {}),
      ...(interactiveInfo ? {
        feishuInteractiveCard: {
          visibleText: interactiveInfo.text,
          rawText: interactiveInfo.rawText,
          textParts: interactiveInfo.textParts,
          imageKeys: interactiveInfo.imageKeys,
          fileKeys: interactiveInfo.fileKeys,
          resourceRefs: interactiveInfo.resourceRefs,
          cardRefs: interactiveInfo.cardRefs,
          rawPreview: interactiveInfo.rawPreview,
          compatibilityPlaceholderRemoved: interactiveInfo.compatibilityPlaceholderRemoved,
          parseWarnings: interactiveInfo.parseWarnings,
          downloadedAttachmentCount: interactiveDownloadedAttachmentCount,
          resourceDownloadFailures: interactiveResourceDownloadFailures,
          textAvailable: Boolean(interactiveInfo.text),
        },
      } : {}),
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
          if (historyIntent.responseMode === 'chat') {
            rawMetadata = {
              ...(rawMetadata || {}),
              feishuHistoryContext: {
                responseMode: historyIntent.responseMode,
                scopeText: historyIntent.scopeText,
                originalPrompt: historyIntent.originalPrompt || trimmedUserText,
                prompt: text,
              },
            };
          }
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
      } else {
        const lightContext = await this.buildLightConversationContext(
          chatId,
          msg.message_id,
          replyTargetMessageId,
          trimmedUserText,
          msg.mentions,
        );
        if (lightContext) {
          rawMetadata = {
            ...(rawMetadata || {}),
            feishuConversationContext: lightContext,
          };
        }
      }
    }

    if (messageType === 'text' && trimmedUserText) {
      await this.ensureStickerHistoryBackfilledForRequest(chatId, msg.chat_type, displayName, trimmedUserText);
      const stickerLibraryEvidence = await this.buildStickerLibraryEvidenceForRequest(chatId, trimmedUserText);
      if (stickerLibraryEvidence) {
        const existingAttachmentIds = new Set(attachments.map((item) => item.id));
        for (const attachment of stickerLibraryEvidence.attachments) {
          if (existingAttachmentIds.has(attachment.id)) continue;
          attachments.push(attachment);
          existingAttachmentIds.add(attachment.id);
        }
        rawMetadata = {
          ...(rawMetadata || {}),
          feishuStickerLibraryContext: stickerLibraryEvidence.context,
        };
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

  private isBotOrAppSenderType(senderType: string | undefined): boolean {
    const normalized = (senderType || '').trim().toLowerCase();
    return normalized === 'app' || normalized === 'bot';
  }

  private isKnownBotSenderId(senderId: string | undefined): boolean {
    const normalized = (senderId || '').trim();
    return !!normalized && this.botIds.has(normalized);
  }

  private isInboundEventFromSelf(sender: FeishuMessageEventData['sender'] | undefined): boolean {
    if (!sender) return false;
    const senderId = sender.sender_id;
    if ([senderId?.open_id, senderId?.user_id, senderId?.union_id]
      .some((id) => this.isKnownBotSenderId(id))) {
      return true;
    }
    const appId = getBridgeContext().store.getSetting('bridge_feishu_app_id') || '';
    return !!appId && (senderId?.app_id || '').trim() === appId;
  }

  private isInboundEventFromOtherBot(sender: FeishuMessageEventData['sender'] | undefined): boolean {
    if (!sender || !this.isBotOrAppSenderType(sender.sender_type)) return false;
    return !this.isInboundEventFromSelf(sender);
  }

  private isKnownOutboundBotMessage(chatId: string, messageId: string): boolean {
    const platformMessageId = messageId.trim();
    if (!platformMessageId) return false;
    try {
      const refs = getBridgeContext().store.listOutboundRefs?.({
        channelType: this.channelType,
        chatId,
        platformMessageId,
      }) || [];
      return refs.some((ref) => ref.platformMessageId === platformMessageId);
    } catch {
      return false;
    }
  }

  private async isReplyToKnownBotMessage(chatId: string, replyTargetMessageId: string): Promise<boolean> {
    const target = replyTargetMessageId.trim();
    if (!target) return false;
    // 本地 outbound ref 是最稳的证据：即使用户回复的机器人消息后来被撤回，
    // 也能证明这条无 @ 群消息是在接本 bot 的上一条消息。
    if (this.isKnownOutboundBotMessage(chatId, target)) return true;

    const item = await this.fetchMessageById(target);
    if (!item || item.deleted) return false;
    return this.isHistoryItemFromSelf(item.sender);
  }

  private isHistoryItemFromSelf(sender: { id?: string; id_type?: string; sender_type?: string } | undefined): boolean {
    if (!sender) return false;
    return this.isBotOrAppSenderType(sender.sender_type) || this.isKnownBotSenderId(sender.id);
  }

  private insertInboundFilterAudit(chatId: string, messageId: string, summary: string): void {
    try {
      getBridgeContext().store.insertAuditLog({
        channelType: 'feishu',
        chatId,
        direction: 'inbound',
        messageId,
        summary,
      });
    } catch { /* best effort */ }
  }

  private consumeBotToBotLoopBudget(
    chatId: string,
    messageId: string,
    senderType: string | undefined,
  ): { chainCount: number; maxTurns: number; senderType: string } | null {
    const maxTurns = this.getBotToBotMaxTurns();
    if (maxTurns <= 0) {
      this.insertInboundFilterAudit(chatId, messageId, '[FILTERED] Group bot/app message dropped: bot-to-bot loop budget exhausted');
      return null;
    }

    const now = Date.now();
    const existing = this.botToBotLoopState.get(chatId);
    const currentCount = existing && now - existing.updatedAt <= FEISHU_BOT_TO_BOT_LOOP_TTL_MS
      ? existing.count
      : 0;
    if (currentCount >= maxTurns) {
      this.insertInboundFilterAudit(chatId, messageId, '[FILTERED] Group bot/app message dropped: bot-to-bot loop budget exhausted');
      return null;
    }

    const chainCount = currentCount + 1;
    this.botToBotLoopState.set(chatId, { count: chainCount, updatedAt: now });
    // 只记录抽象跳数，不把另一机器人正文或内部消息 ID 透传给模型。
    return {
      chainCount,
      maxTurns,
      senderType: (senderType || 'bot').trim().toLowerCase() || 'bot',
    };
  }

  private resetBotToBotLoop(chatId: string): void {
    if (chatId) this.botToBotLoopState.delete(chatId);
  }

  private shouldIgnoreInboundEvent(data: FeishuMessageEventData): boolean {
    const msg = data.message;
    const senderType = data.sender?.sender_type || '';
    const messageType = msg?.message_type || '';

    if (!msg?.message_id) return true;
    if (this.isInboundEventFromSelf(data.sender)) {
      try {
        getBridgeContext().store.insertAuditLog({
          channelType: 'feishu',
          chatId: msg.chat_id || '',
          direction: 'inbound',
          messageId: msg.message_id,
          summary: `[FILTERED] Ignored ${senderType || 'known_bot_id'} sender event (${messageType || 'unknown'})`,
        });
      } catch { /* best effort */ }
      return true;
    }
    if (messageType === 'system') {
      try {
        getBridgeContext().store.insertAuditLog({
          channelType: 'feishu',
          chatId: msg.chat_id || '',
          direction: 'inbound',
          messageId: msg.message_id,
          summary: '[FILTERED] Ignored system event',
        });
      } catch { /* best effort */ }
      return true;
    }
    if (messageType === 'interactive') {
      const allowMentionedBotCard = msg.chat_type === 'group'
        && this.isInboundEventFromOtherBot(data.sender)
        && this.isBotMentionedFromMessage(msg);
      if (allowMentionedBotCard) {
        return false;
      }
      try {
        getBridgeContext().store.insertAuditLog({
          channelType: 'feishu',
          chatId: msg.chat_id || '',
          direction: 'inbound',
          messageId: msg.message_id,
          summary: this.isInboundEventFromOtherBot(data.sender)
            ? '[FILTERED] Ignored inbound interactive card event: current bot not natively mentioned'
            : '[FILTERED] Ignored inbound interactive card event',
        });
      } catch { /* best effort */ }
      return true;
    }
    return false;
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

  private parseInteractiveContent(content: string): string {
    return this.parseInteractiveMessageContent(content).text;
  }

  private parseInteractiveMessageContent(content: string): ParsedFeishuInteractiveContent {
    const evidence = parseFeishuInteractiveCardEvidence(content);
    return {
      text: evidence.visibleText,
      rawText: evidence.rawText,
      imageKeys: evidence.imageKeys,
      fileKeys: evidence.fileKeys,
      resourceRefs: evidence.resourceRefs,
      cardRefs: evidence.cardRefs,
      textParts: evidence.textParts,
      rawPreview: evidence.rawPreview,
      compatibilityPlaceholderRemoved: evidence.compatibilityPlaceholderRemoved,
      parseWarnings: evidence.parseWarnings,
      evidence,
    };
  }

  private containsFeishuCardCompatibilityPlaceholder(text: string): boolean {
    return containsFeishuCardCompatibilityPlaceholder(text);
  }

  private removeFeishuCardCompatibilityPlaceholder(text: string): string {
    return removeFeishuCardCompatibilityPlaceholder(text);
  }

  private buildInteractiveInboundText(
    info: ParsedFeishuInteractiveContent,
    downloadedAttachmentCount: number,
    downloadFailures: FeishuResourceDownloadFailure[] = [],
  ): string {
    if (info.text) return info.text;

    if (downloadedAttachmentCount > 0) {
      return [
        '飞书 interactive 卡片正文未随事件返回；已将卡片内图片/附件作为本轮附件提供给模型。',
        '请优先识别附件内容并结合卡片边界作答。',
      ].join('');
    }

    const failedParts: string[] = [];
    if (info.imageKeys.length > 0) {
      failedParts.push(`图片资源暂时下载失败（key=${this.formatInteractiveResourceKeys(info.imageKeys)}）`);
    }
    if (info.fileKeys.length > 0) {
      failedParts.push(`文件资源暂时下载失败（key=${this.formatInteractiveResourceKeys(info.fileKeys)}）`);
    }
    if (failedParts.length > 0) {
      const failureCount = downloadFailures.length > 0 ? `；资源接口失败 ${downloadFailures.length} 次，详情已记录为审计证据` : '';
      return [
        `飞书 interactive 卡片正文未随事件返回；${failedParts.join('；')}${failureCount}。`,
        '请基于可见卡片边界、上下文和可用附件作答；不要把飞书客户端升级占位当作正文，也不要猜测不可读图片内容。',
      ].join('');
    }

    if (info.compatibilityPlaceholderRemoved) {
      return '飞书 interactive 卡片正文未随事件返回；飞书只返回了客户端兼容占位。';
    }
    return '飞书 interactive 卡片正文未随事件返回。';
  }

  private formatFeishuResourceFailure(failure: FeishuResourceDownloadFailure): string {
    const parts: string[] = [failure.endpoint];
    if (failure.status !== undefined) parts.push(`HTTP ${failure.status}`);
    if (failure.code !== undefined && failure.code !== '') parts.push(`code=${failure.code}`);
    if (failure.msg) parts.push(failure.msg);
    if (!failure.msg && failure.error) parts.push(failure.error);
    return parts.join(' ').trim();
  }

  private buildInteractiveHistoryBoundary(info: ParsedFeishuInteractiveContent): string {
    if (info.text) return info.text.replace(/\s+/g, ' ').trim();

    const resourceParts: string[] = [];
    if (info.imageKeys.length > 0) {
      resourceParts.push(`含图片资源 key=${this.formatInteractiveResourceKeys(info.imageKeys)}`);
    }
    if (info.fileKeys.length > 0) {
      resourceParts.push(`含文件资源 key=${this.formatInteractiveResourceKeys(info.fileKeys)}`);
    }
    if (resourceParts.length > 0) {
      return `[卡片消息：正文未随事件返回，${resourceParts.join('，')}]`;
    }
    if (info.compatibilityPlaceholderRemoved) {
      return '[卡片消息：正文未随事件返回，仅收到客户端兼容占位]';
    }
    return '[卡片消息]';
  }

  private formatInteractiveResourceKeys(keys: string[]): string {
    const uniqueKeys = [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
    const visible = uniqueKeys.slice(0, 3).join(', ');
    return uniqueKeys.length > 3 ? `${visible}, ... 共 ${uniqueKeys.length} 个` : visible;
  }

  private async downloadInteractiveCardResources(
    messageId: string,
    info: ParsedFeishuInteractiveContent,
  ): Promise<FeishuInteractiveResourceDownloadResult> {
    const attachments: FileAttachment[] = [];
    const failures: FeishuResourceDownloadFailure[] = [];
    for (const key of info.imageKeys) {
      const attachment = await this.downloadResource(messageId, key, 'image', failures);
      if (attachment) attachments.push(attachment);
    }
    for (const key of info.fileKeys) {
      const attachment = await this.downloadResource(messageId, key, 'file', failures);
      if (attachment) attachments.push(attachment);
    }
    return { attachments, failures };
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
      known: this.hasReliableStickerSemantics(record),
      messageKind: this.hasReliableStickerSemantics(record) ? 'feishu_sticker_known' : 'feishu_sticker_unknown',
      label: record?.label,
      description: record?.description,
      intent: record?.intent,
      tone: record?.tone,
      userAnnotation: record?.userAnnotation,
    };
  }

  private buildStickerHistoryBoundary(stickerInfo: ParsedFeishuStickerContent): string {
    const fileKey = stickerInfo.fileKey ? `，file_key=${stickerInfo.fileKey}` : '';
    if (stickerInfo.known) {
      const parts = [
        stickerInfo.label?.trim() ? `名称：${stickerInfo.label.trim()}` : '',
        stickerInfo.intent?.trim() ? `意图：${stickerInfo.intent.trim()}` : '',
        stickerInfo.tone?.trim() ? `语气：${stickerInfo.tone.trim()}` : '',
      ].filter(Boolean).join('；');
      return `[飞书表情包${fileKey}${parts ? `；${parts}` : ''}]`;
    }
    return `[飞书表情包${fileKey}；语义待图片或人工核验]`;
  }

  private async harvestStickerFromHistoryItem(item: FeishuMessageListItem, chatId: string): Promise<void> {
    if (!item || item.deleted || item.msg_type !== 'sticker') return;
    const content = item.body?.content || '';
    const stickerInfo = this.parseStickerContent(content);
    const fileKey = stickerInfo.fileKey?.trim() || '';
    if (!fileKey) return;
    this.rememberSticker({
      fileKey,
      chatId,
      userId: item.sender?.id,
      messageId: item.message_id,
    });
    if (this.getStoredStickerResource(fileKey)) return;
    await this.downloadAndCacheStickerResource(item.message_id, fileKey);
  }

  private async harvestStickersFromHistory(items: FeishuMessageListItem[], chatId: string): Promise<void> {
    for (const item of items) {
      try {
        await this.harvestStickerFromHistoryItem(item, chatId);
      } catch (err) {
        console.warn('[feishu-adapter] Failed to harvest sticker from history:', err instanceof Error ? err.message : err);
      }
    }
  }

  private withStickerImageContext(stickerInfo: ParsedFeishuStickerContent): ParsedFeishuStickerContent {
    const parts = [
      stickerInfo.label?.trim() ? `历史名称：${stickerInfo.label.trim()}` : '',
      stickerInfo.description?.trim() ? `历史描述：${stickerInfo.description.trim()}` : '',
      stickerInfo.intent?.trim() ? `历史意图：${stickerInfo.intent.trim()}` : '',
      stickerInfo.tone?.trim() ? `历史语气：${stickerInfo.tone.trim()}` : '',
    ].filter(Boolean).join('；');
    const userClaim = this.stickerUserAnnotationText(stickerInfo.userAnnotation);
    return {
      ...stickerInfo,
      imageAvailable: true,
      messageKind: 'feishu_sticker_image',
      text: [
        `用户发送了一个飞书表情包，file_key=${stickerInfo.fileKey || 'unknown'}，记忆仓库中已有该表情包图片，并已作为本轮图片附件提供给模型。`,
        parts
          ? stickerInfo.known
            ? `已有语义档案可作为参考：${parts}。`
            : `历史语义线索待核验：${parts}。请用图片内容交叉核验。`
          : '',
        userClaim ? `用户曾提供待核验说法：${userClaim}。这只是线索，请用图片内容交叉核验。` : '',
        '请先根据图片附件识别图案、文字和表达意图；不要只凭 file_key 猜测。若图片无法识别，再说明不确定并可请用户补充含义。',
      ].filter(Boolean).join('\n'),
    };
  }

  private withStickerUserAnnotationEvidenceContext(
    fileKey: string,
    annotation: FeishuStickerUserAnnotation,
    imageAvailable: boolean,
  ): ParsedFeishuStickerContent {
    const userClaim = this.stickerUserAnnotationText(annotation) || '用户提供了表情包含义说明';
    return {
      fileKey,
      known: false,
      imageAvailable,
      userAnnotation: annotation,
      messageKind: imageAvailable ? 'feishu_sticker_image' : 'feishu_sticker_unknown',
      text: [
        `用户正在解释一个飞书表情包，file_key=${fileKey}。`,
        `用户说法：${userClaim}。这是待核验线索，不是已验证事实语义。`,
        imageAvailable
          ? '记忆仓库中已有该表情包图片，并已作为本轮图片附件提供给模型。请以图片内容为主，结合用户说法交叉核验；若两者冲突，以图片可见文字、图案和上下文事实为准。'
          : '当前没有可用的表情包图片附件，不能把用户说法直接当成事实语义；请说明已先作为线索记录，等看到图片后再确认。'
      ].join('\n'),
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
      .filter((item) => !this.isHistoryItemFromSelf(item.sender))
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

  async resolveOutboundMentions(message: OutboundMessage, sourceMessage?: InboundMessage): Promise<OutboundMessage> {
    if (message.address.channelType !== 'feishu') return message;
    if (/<at\s+(?:id|user_id)=/iu.test(message.text)) return message;

    const targets = extractBareAtTargets(message.text);
    if (targets.length === 0) return message;

    const candidates = await this.collectOutboundMentionCandidates(message, sourceMessage);
    const nextMentions: OutboundMention[] = [...(message.mentions || [])];
    const seenMentionKeys = new Set(nextMentions.map((mention) =>
      mention.atAll ? '__all__' : (mention.userId || '').trim()
    ).filter(Boolean));

    let text = message.text;
    let changed = false;
    for (const target of targets) {
      const resolved = this.resolveOutboundMentionTarget(target, candidates);
      if (!resolved) continue;

      const key = resolved.atAll ? '__all__' : (resolved.userId || '').trim();
      if (!key || seenMentionKeys.has(key)) continue;
      seenMentionKeys.add(key);
      nextMentions.push(resolved);
      changed = true;

      const canonicalName = cleanMentionName(resolved.name, resolved.atAll ? '所有人' : target);
      if (normalizeMentionAlias(target) !== normalizeMentionAlias(canonicalName)) {
        text = replaceBareAtTarget(text, target, canonicalName);
      }
    }

    if (!changed && text === message.text) return message;
    return {
      ...message,
      text,
      mentions: nextMentions.length > 0 ? nextMentions : undefined,
    };
  }

  async inspectOutboundMentionTarget(
    message: OutboundMessage,
    sourceMessage: InboundMessage | undefined,
    target: string,
  ): Promise<OutboundMentionResolutionInspection> {
    const cleanedTarget = cleanMentionName(target, '');
    if (!cleanedTarget) {
      return {
        target,
        status: 'not_found',
        searchedSources: FEISHU_MENTION_SEARCH_SOURCES,
        candidates: [],
      };
    }

    try {
      const candidates = await this.collectOutboundMentionCandidates(message, sourceMessage);
      const exactMatches = this.findOutboundMentionCandidateMatches(cleanedTarget, candidates, 'exact');
      const uniqueExactIds = new Set(exactMatches.map((candidate) => candidate.userId));
      if (uniqueExactIds.size === 1) {
        return {
          target: cleanedTarget,
          status: 'resolved',
          searchedSources: FEISHU_MENTION_SEARCH_SOURCES,
          candidates: this.toMentionResolutionCandidates(exactMatches),
        };
      }
      if (uniqueExactIds.size > 1) {
        return {
          target: cleanedTarget,
          status: 'ambiguous',
          searchedSources: FEISHU_MENTION_SEARCH_SOURCES,
          candidates: this.toMentionResolutionCandidates(exactMatches),
        };
      }

      const relatedMatches = this.findOutboundMentionCandidateMatches(cleanedTarget, candidates, 'related');
      return {
        target: cleanedTarget,
        status: relatedMatches.length > 0 ? 'ambiguous' : 'not_found',
        searchedSources: FEISHU_MENTION_SEARCH_SOURCES,
        candidates: this.toMentionResolutionCandidates(relatedMatches),
      };
    } catch (err) {
      return {
        target: cleanedTarget,
        status: 'lookup_failed',
        searchedSources: FEISHU_MENTION_SEARCH_SOURCES,
        candidates: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async sendDirectMessage(request: DirectMessageRequest): Promise<DirectMessageSendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }
    if (request.sourceMessage.address.channelType !== 'feishu') {
      return { ok: false, error: '当前来源不是飞书会话，无法解析私发目标' };
    }

    const targetText = cleanMentionName(request.targetText, '');
    const body = (request.text || '').trim();
    if (!targetText || !body) {
      return { ok: false, error: '私发目标或正文为空' };
    }
    if (FEISHU_AT_ALL_ALIASES.has(normalizeMentionAlias(targetText))) {
      return { ok: false, error: '私发不能使用 @all，请指定单个成员' };
    }

    const candidates = await this.collectOutboundMentionCandidates({
      address: request.sourceMessage.address,
      text: `@${targetText}`,
      parseMode: 'plain',
    }, request.sourceMessage);
    const resolved = this.resolveOutboundMentionTarget(targetText, candidates);
    if (!resolved?.userId || resolved.atAll) {
      return { ok: false, error: '无法确认目标，请直接 @ TA 或提供准确显示名' };
    }

    const receiveIdType = inferDirectMessageReceiveIdType(resolved.userId);
    const messageText = request.parseMode === 'Markdown'
      ? preprocessFeishuMarkdown(body)
      : body;
    const data = request.parseMode === 'Markdown'
      ? {
        receive_id: resolved.userId,
        msg_type: 'interactive',
        content: buildCardContent(messageText),
      }
      : {
        receive_id: resolved.userId,
        msg_type: 'text',
        content: JSON.stringify({ text: messageText }),
      };

    try {
      // 官方 im.message.create 支持 receive_id_type=open_id/user_id/union_id；
      // 这里不复用当前群 chat_id，避免“私发”退化成群回复。
      const res = await this.restClient.im.message.create({
        params: { receive_id_type: receiveIdType },
        data,
      });
      if (res?.data?.message_id) {
        return {
          ok: true,
          messageId: res.data.message_id,
          targetUserId: resolved.userId,
          targetDisplayName: resolved.name || targetText,
        };
      }
      return { ok: false, error: res?.msg || 'Feishu direct message send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Feishu direct message send failed' };
    }
  }

  async resolveConversationTarget(request: ConversationTargetResolveRequest): Promise<ConversationTargetResolveResult> {
    if (request.sourceMessage.address.channelType !== 'feishu') {
      return { ok: false, error: '当前来源不是飞书会话，无法解析跨会话目标' };
    }
    const targetText = cleanMentionName(request.targetText, '');
    const targetId = (request.targetId || '').trim();
    const targetKind = request.targetKind || 'any';
    if (!targetText && !targetId) {
      return { ok: false, error: '缺少目标会话或用户' };
    }

    const bindings = getBridgeContext().store.listChannelBindings('feishu');
    const normalizeBindingName = (value: string | undefined) => normalizeMentionAlias(cleanMentionName(value, ''));
    const bindingCandidates = bindings
      .filter((binding) => {
        if (targetId && binding.chatId === targetId) return true;
        if (!targetText) return false;
        const normalizedTarget = normalizeMentionAlias(targetText);
        return normalizeBindingName(binding.displayName) === normalizedTarget
          || normalizeMentionAlias(binding.chatId) === normalizedTarget;
      })
      .map((binding) => ({
        id: binding.chatId,
        displayName: binding.displayName || binding.chatId,
        kind: 'chat' as const,
        chatType: binding.chatType,
      }));

    const wantsChat = targetKind === 'chat' || targetKind === 'any';
    if (wantsChat) {
      if (bindingCandidates.length === 1) {
        return { ok: true, target: bindingCandidates[0] };
      }
      if (bindingCandidates.length > 1) {
        return { ok: false, error: '目标会话匹配到多个结果，请提供准确群名或 chat_id', candidates: bindingCandidates };
      }
      if (targetId && (targetKind === 'chat' || /^oc_/i.test(targetId))) {
        const displayName = await this.resolveChatDisplayName(targetId, 'group');
        return {
          ok: true,
          target: {
            kind: 'chat',
            id: targetId,
            displayName: displayName || targetText || targetId,
            chatType: 'group',
          },
        };
      }
    }

    const wantsUser = targetKind === 'user' || targetKind === 'any';
    if (wantsUser) {
      if (targetId && !/^oc_/i.test(targetId)) {
        return {
          ok: true,
          target: {
            kind: 'user',
            id: targetId,
            userId: targetId,
            displayName: targetText || `用户 ${targetId}`,
          },
        };
      }
      if (targetText) {
        if (FEISHU_AT_ALL_ALIASES.has(normalizeMentionAlias(targetText))) {
          return { ok: false, error: '跨会话私聊不能使用 @all，请指定单个成员' };
        }
        const candidates = await this.collectOutboundMentionCandidates({
          address: request.sourceMessage.address,
          text: `@${targetText}`,
          parseMode: 'plain',
        }, request.sourceMessage);
        const resolved = this.resolveOutboundMentionTarget(targetText, candidates);
        if (resolved?.userId && !resolved.atAll) {
          return {
            ok: true,
            target: {
              kind: 'user',
              id: resolved.userId,
              userId: resolved.userId,
              displayName: resolved.name || targetText,
            },
          };
        }
      }
    }

    return { ok: false, error: '无法确认目标，请提供准确群名、chat_id、原生 @ 或用户 ID' };
  }

  async sendConversationMessage(request: ConversationMessageRequest): Promise<ConversationMessageSendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }
    const body = (request.text || '').trim();
    const targetId = (request.target.id || request.target.userId || '').trim();
    if (!body || !targetId) {
      return { ok: false, error: '发送目标或正文为空' };
    }

    const messageText = request.parseMode === 'Markdown'
      ? preprocessFeishuMarkdown(body)
      : body;
    const receiveIdType = request.target.kind === 'chat'
      ? 'chat_id'
      : inferDirectMessageReceiveIdType(targetId);
    const data = request.parseMode === 'Markdown'
      ? {
        receive_id: targetId,
        msg_type: 'interactive',
        content: buildCardContent(messageText),
      }
      : {
        receive_id: targetId,
        msg_type: 'text',
        content: JSON.stringify({ text: messageText }),
      };

    try {
      // 这里使用已确认的目标 ID，不复用 source chat_id，避免跨会话发送误回当前群。
      const res = await this.restClient.im.message.create({
        params: { receive_id_type: receiveIdType },
        data,
      });
      if (res?.data?.message_id) {
        return {
          ok: true,
          messageId: res.data.message_id,
          targetDisplayName: request.target.displayName,
          targetId,
          targetKind: request.target.kind,
        };
      }
      return { ok: false, error: res?.msg || 'Feishu cross-conversation message send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Feishu cross-conversation message send failed' };
    }
  }

  private async collectOutboundMentionCandidates(
    message: OutboundMessage,
    sourceMessage?: InboundMessage,
  ): Promise<FeishuMentionCandidate[]> {
    const byId = new Map<string, FeishuMentionCandidate>();
    const addCandidate = (userId: string | undefined, name: string | undefined, aliases: string[] = []) => {
      const id = (userId || '').trim();
      const displayName = cleanMentionName(name, '');
      // 飞书消息 @ 语法面向用户 ID；明显的 app/bot 标识不能进入原生 mention 候选。
      if (isDefinitelyNonUserMentionId(id)) return;
      if (!id || !displayName) return;
      const existing = byId.get(id);
      const mergedAliases = new Set([
        ...(existing?.aliases || []),
        displayName,
        ...aliases.map((item) => cleanMentionName(item, '')).filter(Boolean),
      ]);
      byId.set(id, {
        userId: id,
        name: existing?.name || displayName,
        aliases: [...mergedAliases],
      });
    };

    this.addInboundMentionCandidates(sourceMessage, addCandidate);
    this.addHistoryMentionCandidates(addCandidate);

    if (message.address.chatId) {
      try {
        const mentionCandidates = await this.fetchChatMentionCandidates(message.address.chatId);
        for (const candidate of mentionCandidates) {
          addCandidate(candidate.userId, candidate.name, candidate.aliases);
        }
      } catch (err) {
        console.warn('[feishu-adapter] chat member mention lookup skipped:', err instanceof Error ? err.message : err);
      }
    }

    const senderIds = this.getSourceSenderIds(sourceMessage);
    const rawSource = getRawObject(sourceMessage?.raw);
    const rawSender = getRawObject(rawSource.feishuSender);
    const senderType = firstNonEmptyString(rawSender.senderType, rawSender.sender_type);
    const canUseCurrentSenderAsDmTarget = !this.isBotOrAppSenderType(senderType);
    for (const senderId of senderIds) {
      const existing = byId.get(senderId);
      if (existing) {
        addCandidate(senderId, existing.name, [...FEISHU_SENDER_ALIASES]);
      } else if (canUseCurrentSenderAsDmTarget) {
        // 群消息里的 address.displayName 通常是群名；给“我/发起人”私发时，
        // 用本轮 sender ID 精确投递，显示名只在 p2p 或已解析成员名时采用。
        const senderDisplayName = sourceMessage?.address.chatType === 'group'
          ? '发起人'
          : sourceMessage?.address.displayName || '发起人';
        addCandidate(senderId, senderDisplayName, [...FEISHU_SENDER_ALIASES]);
      }
    }

    return [...byId.values()];
  }

  private findOutboundMentionCandidateMatches(
    target: string,
    candidates: FeishuMentionCandidate[],
    mode: 'exact' | 'related',
  ): FeishuMentionCandidate[] {
    const normalizedTarget = normalizeMentionAlias(target);
    if (!normalizedTarget) return [];
    const byId = new Map<string, FeishuMentionCandidate>();
    for (const candidate of candidates) {
      const aliases = [candidate.name, ...candidate.aliases]
        .map((alias) => normalizeMentionAlias(alias))
        .filter(Boolean);
      const matched = mode === 'exact'
        ? aliases.some((alias) => alias === normalizedTarget)
        : aliases.some((alias) => (
            alias === normalizedTarget
            || (normalizedTarget.length >= 2 && alias.includes(normalizedTarget))
            || (alias.length >= 2 && normalizedTarget.includes(alias))
          ));
      if (matched && !byId.has(candidate.userId)) {
        byId.set(candidate.userId, candidate);
      }
    }
    return [...byId.values()];
  }

  private toMentionResolutionCandidates(candidates: FeishuMentionCandidate[]): Array<{ name: string; aliases?: string[] }> {
    const byName = new Map<string, { name: string; aliases?: string[] }>();
    for (const candidate of candidates) {
      const name = cleanMentionName(candidate.name, '');
      if (!name || byName.has(name)) continue;
      const aliases = uniqueCleanStrings(candidate.aliases)
        .filter((alias) => normalizeMentionAlias(alias) !== normalizeMentionAlias(name))
        .slice(0, 3);
      byName.set(name, {
        name,
        aliases: aliases.length > 0 ? aliases : undefined,
      });
    }
    return [...byName.values()].slice(0, 8);
  }

  private addInboundMentionCandidates(
    sourceMessage: InboundMessage | undefined,
    addCandidate: (userId: string | undefined, name: string | undefined, aliases?: string[]) => void,
  ): void {
    const raw = getRawObject(sourceMessage?.raw);
    const mentionGroups = [
      Array.isArray(raw.feishuMentions) ? raw.feishuMentions : [],
      Array.isArray(raw.message?.mentions) ? raw.message.mentions : [],
    ];

    for (const mentions of mentionGroups) {
      for (const mention of mentions) {
        const item = getRawObject(mention);
        const id = getRawObject(item.id);
        const openId = item.openId || item.open_id || id.open_id;
        const userId = item.userId || item.user_id || id.user_id;
        const unionId = item.unionId || item.union_id || id.union_id;
        const name = item.name || item.user_name || item.key;
        addCandidate(openId || userId || unionId, name, [item.key, item.name, item.user_name].filter(Boolean));
      }
    }
  }

  private addHistoryMentionCandidates(
    addCandidate: (userId: string | undefined, name: string | undefined, aliases?: string[]) => void,
  ): void {
    for (const candidate of this.readHistoryMentionCandidates()) {
      addCandidate(candidate.userId, candidate.name, candidate.aliases);
    }
  }

  private readHistoryMentionCandidates(): FeishuMentionCandidate[] {
    const historyDir = getFeishuHistoryDirPath();
    let files: Array<{ path: string; mtimeMs: number; size: number }> = [];

    try {
      files = fs.readdirSync(historyDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.json$/i.test(entry.name))
        .map((entry) => {
          const filePath = path.join(historyDir, entry.name);
          const stat = fs.statSync(filePath);
          return { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size };
        })
        .sort((a, b) => a.path.localeCompare(b.path));
    } catch {
      return [];
    }

    const signature = files.map((file) => `${file.path}:${file.mtimeMs}:${file.size}`).join('|');
    if (this.mentionHistoryCache?.signature === signature) {
      return this.mentionHistoryCache.candidates;
    }

    const byIdAndName = new Map<string, FeishuMentionCandidate>();
    const add = (candidate: FeishuMentionCandidate) => {
      const userId = candidate.userId.trim();
      const name = cleanMentionName(candidate.name, '');
      if (!userId || !name) return;
      const key = `${userId}\u0000${normalizeMentionAlias(name)}`;
      if (byIdAndName.has(key)) return;
      byIdAndName.set(key, { userId, name, aliases: [name, ...candidate.aliases] });
    };

    for (const file of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file.path, 'utf8')) as unknown;
        const records = Array.isArray(parsed) ? parsed : [];
        for (const record of records) {
          const item = getRawObject(record);
          if (typeof item.text !== 'string' || !item.text.includes('<at')) continue;
          for (const candidate of extractVerifiedMentionCandidatesFromText(item.text)) {
            add(candidate);
          }
        }
      } catch {
        // 历史索引是辅助候选来源；单个旧文件损坏时跳过，不能影响消息发送。
      }
    }

    const candidates = [...byIdAndName.values()];
    this.mentionHistoryCache = { signature, candidates };
    return candidates;
  }

  private getSourceSenderIds(sourceMessage: InboundMessage | undefined): string[] {
    const raw = getRawObject(sourceMessage?.raw);
    const sender = getRawObject(raw.feishuSender);
    const ids = [
      sender.openId,
      sender.open_id,
      sender.userId,
      sender.user_id,
      sender.unionId,
      sender.union_id,
      sourceMessage?.address.userId,
    ].map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
    return [...new Set(ids)];
  }

  private resolveOutboundMentionTarget(target: string, candidates: FeishuMentionCandidate[]): OutboundMention | null {
    const normalizedTarget = normalizeMentionAlias(target);
    if (!normalizedTarget) return null;
    if (FEISHU_AT_ALL_ALIASES.has(normalizedTarget)) {
      return { atAll: true, name: '所有人' };
    }

    const matches = candidates.filter((candidate) => {
      const aliases = [candidate.name, ...candidate.aliases];
      return aliases.some((alias) => normalizeMentionAlias(alias) === normalizedTarget);
    });
    const uniqueById = new Map(matches.map((candidate) => [candidate.userId, candidate]));
    if (uniqueById.size !== 1) return null;
    const candidate = [...uniqueById.values()][0];
    return {
      userId: candidate.userId,
      name: candidate.name,
    };
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

    // Reply metadata is only a quote target; native Feishu mentions must be explicit.
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
    const wantsSummary = /(\u603b\u7ed3|\u6c47\u603b|\u6574\u7406|\u68b3\u7406|\u6982\u62ec|\u5f52\u7eb3|\u56de\u987e|\u63d0\u70bc|\u63d0\u53d6|\u770b\u4e00\u4e0b|\u770b\u770b|\u770b\u4e0b|\u5728\u8bf4\u4ec0\u4e48|\u8bf4\u4ec0\u4e48|\u5728\u804a\u4ec0\u4e48|\u804a\u4ec0\u4e48|\u4ec0\u4e48\u5185\u5bb9)/.test(normalized);
    // "群里/本群/这个群" 也是明确的群历史范围，不要求用户必须说成“群聊记录”。
    const mentionsHistory = /(\u7fa4\u804a|\u7fa4\u91cc|\u7fa4\u5185|\u672c\u7fa4|\u8fd9\u4e2a\u7fa4|\u804a\u5929|\u5bf9\u8bdd|\u6d88\u606f|\u8bb0\u5f55|\u8ba8\u8bba|\u5185\u5bb9)/.test(normalized);
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

    await this.harvestStickersFromHistory(collected, chatId);

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
      .filter((item) => !this.isHistoryItemFromSelf(item.sender))
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

  private hasFeishuAppCredentials(): boolean {
    const store = getBridgeContext().store;
    return !!(store.getSetting('bridge_feishu_app_id') && store.getSetting('bridge_feishu_app_secret'));
  }

  private async fetchChatMentionCandidates(chatId: string): Promise<FeishuMentionCandidate[]> {
    const byId = new Map<string, FeishuMentionCandidate>();
    const errors: unknown[] = [];
    const addCandidate = (candidate: FeishuMentionCandidate | null) => {
      if (!candidate) return;
      const id = (candidate.userId || '').trim();
      const name = cleanMentionName(candidate.name, '');
      if (!id || !name || isDefinitelyNonUserMentionId(id)) return;
      const existing = byId.get(id);
      const aliases = new Set([
        ...(existing?.aliases || []),
        name,
        ...candidate.aliases.map((item) => cleanMentionName(item, '')).filter(Boolean),
      ]);
      byId.set(id, {
        userId: id,
        name: existing?.name || name,
        aliases: [...aliases],
      });
    };

    try {
      const memberNames = await this.fetchChatMemberNames(chatId);
      for (const [memberId, memberName] of memberNames) {
        addCandidate({ userId: memberId, name: memberName, aliases: [memberName] });
      }
    } catch (err) {
      errors.push(err);
    }

    if (this.hasFeishuAppCredentials()) {
      try {
        for (const candidate of await this.fetchChatMemberListMentionCandidates(chatId)) {
          addCandidate(candidate);
        }
      } catch (err) {
        errors.push(err);
      }
    }

    if (byId.size === 0 && errors.length > 0) {
      const firstError = errors[0];
      throw firstError instanceof Error ? firstError : new Error(String(firstError));
    }
    return [...byId.values()];
  }

  private async fetchChatMemberListMentionCandidates(chatId: string): Promise<FeishuMentionCandidate[]> {
    const { appId, appSecret, baseUrl } = this.getAuthContext();
    const tenantAccessToken = await this.fetchTenantAccessToken(appId, appSecret, baseUrl);
    const candidates: FeishuMentionCandidate[] = [];
    let pageToken = '';

    while (true) {
      const url = new URL(`/open-apis/im/v1/chats/${chatId}/members/list`, baseUrl);
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
          users?: FeishuChatMemberListItem[];
          bots?: FeishuChatMemberListItem[];
          items?: FeishuChatMemberListItem[];
          members?: FeishuChatMemberListItem[];
          has_more?: boolean;
          page_token?: string;
        };
      };

      if (!response.ok || payload.code !== 0) {
        throw new Error(`Feishu chats.members.list failed [${payload.code ?? response.status}]: ${payload.msg || response.statusText}`);
      }

      // 飞书群成员新版列表会把普通用户和群机器人拆到不同桶；这里统一抽成 mention 候选。
      const data = payload.data || {};
      const buckets = [data.users, data.bots, data.items, data.members];
      for (const bucket of buckets) {
        if (!Array.isArray(bucket)) continue;
        for (const item of bucket) {
          const candidate = buildFeishuMentionCandidateFromMember(item);
          if (candidate) candidates.push(candidate);
        }
      }

      if (!payload.data?.has_more || !payload.data.page_token) {
        break;
      }
      pageToken = payload.data.page_token;
    }

    return candidates;
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
        const candidate = buildFeishuMentionCandidateFromMember(item, true);
        if (candidate) {
          names.set(candidate.userId, candidate.name);
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
    const isBotSender = this.isBotOrAppSenderType(senderType);
    const senderLabel = isBotSender
      ? '机器人'
      : `用户(${senderId.slice(-6) || 'unknown'})`;
    const resolvedSenderLabel = isBotSender
      ? (resolvedSenderName || senderLabel)
      : (resolvedSenderName || senderLabel);
    const messageText = this.extractHistoryText(item);

    if (!messageText) {
      return '';
    }

    return `[${timeLabel}] ${resolvedSenderLabel}: ${messageText}`;
  }

  private async buildLightConversationContext(
    chatId: string,
    currentMessageId: string,
    replyTargetMessageId: string | null,
    userText: string,
    nativeMentions: FeishuMessageEventData['message']['mentions'] = [],
  ): Promise<FeishuLightContext | null> {
    const limit = this.getLightContextMessageLimit();
    if (limit <= 0 || !userText.trim()) return null;
    const mentions = this.normalizeLightContextMentions(nativeMentions);
    const isShortContextualAsk = this.isShortContextualAskText(userText);
    if (!replyTargetMessageId && !isShortContextualAsk) return null;

    try {
      // Short Feishu replies may lose native quote metadata in receive_v1.
      // Pull a slightly wider bounded window so the agent can still see the nearby thread.
      const recentLimit = Math.max(limit + 12, 20);
      const [recentMessages, memberNames, repliedMessage] = await Promise.all([
        this.fetchRecentMessages(chatId, recentLimit),
        this.fetchChatMemberNames(chatId),
        replyTargetMessageId ? this.fetchMessageById(replyTargetMessageId) : Promise.resolve(null),
      ]);

      const isShortReplyCommand = this.isShortReplyContextCommand(userText);
      const includeBotMessages = isShortReplyCommand
        || mentions.length > 0
        || this.isDeicticLightContextAsk(userText);
      const selected = new Map<string, FeishuMessageListItem>();
      const selectionLimit = !replyTargetMessageId && isShortReplyCommand
        ? Math.max(limit + 8, 12)
        : limit + (repliedMessage ? 1 : 0);
      if (repliedMessage && !repliedMessage.deleted && repliedMessage.msg_type !== 'system') {
        selected.set(repliedMessage.message_id, repliedMessage);
      }
      for (const item of recentMessages) {
        if (selected.size >= selectionLimit) break;
        if (!this.isLightContextHistoryItem(item, currentMessageId, { includeBotMessages })) continue;
        selected.set(item.message_id, item);
      }

      const items = [...selected.values()]
        .filter((item) => this.extractHistoryText(item))
        .sort((a, b) => (Number.parseInt(a.create_time, 10) || 0) - (Number.parseInt(b.create_time, 10) || 0))
        .slice(-Math.max(limit, repliedMessage ? limit + 1 : isShortReplyCommand ? Math.min(selectionLimit, limit + 4) : limit));
      if (items.length === 0) return null;

      const likelyContextMessageId = !replyTargetMessageId && isShortReplyCommand
        ? this.findLikelyLightContextAnchor(items)?.message_id || ''
        : '';
      const formatted = items
        .map((item) => {
          const prefix = replyTargetMessageId && item.message_id === replyTargetMessageId
            ? '[被回复消息] '
            : likelyContextMessageId && item.message_id === likelyContextMessageId
              ? '[可能关联上文] '
              : '';
          return `${prefix}${this.formatHistoryItem(item, memberNames)}`;
        })
        .filter(Boolean)
        .join('\n');
      if (!formatted) return null;
      const referenceSignals = this.formatLightContextReferenceSignals(userText, mentions);

      return {
        prompt: [
          ...referenceSignals,
          'Feishu recent conversation context:',
          '- These are nearby messages from the same Feishu group, provided only to understand the current reply/mention.',
          '- Use them as chat context for tone, names, and references. Do not claim you searched all history.',
          '- If the current user asks for an opinion, naming, or a reaction, answer based on this nearby context.',
          mentions.length > 0 ? '- If the current text uses pronouns or deictic words, treat current native mentions as candidate referents and resolve them against the nearby context before asking the user to restate.' : '',
          includeBotMessages ? '- Nearby robot/app messages are included because short follow-up questions often point at bot replies or cards.' : '',
          likelyContextMessageId ? '- Lines marked [可能关联上文] are best-effort nearby anchors, not confirmed native reply metadata.' : '',
          '',
          formatted,
        ].filter(Boolean).join('\n'),
        messageCount: items.length,
        replyToMessageId: replyTargetMessageId || undefined,
      };
    } catch (err) {
      console.warn('[feishu-adapter] light conversation context skipped:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  private normalizeLightContextMentions(
    mentions: FeishuMessageEventData['message']['mentions'] = [],
  ): FeishuLightContextMention[] {
    if (!Array.isArray(mentions)) return [];
    return mentions
      .map((mention) => ({
        key: typeof mention.key === 'string' ? mention.key.trim() : '',
        name: typeof mention.name === 'string' ? mention.name.trim() : '',
        openId: typeof mention.id?.open_id === 'string' ? mention.id.open_id.trim() : '',
        userId: typeof mention.id?.user_id === 'string' ? mention.id.user_id.trim() : '',
        unionId: typeof mention.id?.union_id === 'string' ? mention.id.union_id.trim() : '',
      }))
      .filter((mention) => mention.name || mention.key || mention.openId || mention.userId || mention.unionId);
  }

  private formatLightContextReferenceSignals(userText: string, mentions: FeishuLightContextMention[]): string[] {
    if (mentions.length === 0 && !this.isDeicticLightContextAsk(userText)) return [];
    const mentionLines = mentions.map((mention) => {
      const ids = [
        mention.openId ? `open_id=${mention.openId}` : '',
        mention.userId ? `user_id=${mention.userId}` : '',
        mention.unionId ? `union_id=${mention.unionId}` : '',
      ].filter(Boolean).join(', ');
      const label = mention.name || mention.key || ids || 'unknown';
      return `  - ${label}${ids && label !== ids ? ` (${ids})` : ''}`;
    });
    return [
      'Current message reference signals:',
      `- current user text: ${userText.replace(/\s+/g, ' ').trim().slice(0, 180)}`,
      mentionLines.length > 0 ? '- native mentions in current message:' : '',
      ...mentionLines,
    ].filter(Boolean);
  }

  private isShortContextualAskText(userText: string): boolean {
    const normalized = userText.replace(/\s+/g, '').trim();
    return normalized.length <= 80
      || /(?:怎么看|咋看|怎么起|起名|这个|这个呢|那个|上面|刚刚|前面|上一条|前一条|回复|你觉得|帮.*想|咋回事|怎么回事|什么情况|啥情况|啥意思|什么意思)/u.test(userText);
  }

  private isDeicticLightContextAsk(userText: string): boolean {
    const normalized = userText.replace(/\s+/g, '').trim();
    if (!normalized || normalized.length > 40) return false;
    return /(?:^|[这那他她它]|ta|TA|上面|前面|刚才|刚刚|回复).*(?:咋回事|怎么回事|什么情况|啥情况|啥意思|什么意思|咋样|怎么看|是啥|是什么)/u.test(normalized)
      || /^(?:这|这个|那|那个|他|她|它|ta|TA)(?:呢|咋样|怎么看)?$/u.test(normalized);
  }

  private isLightContextHistoryItem(
    item: FeishuMessageListItem,
    currentMessageId: string,
    options: { includeBotMessages?: boolean } = {},
  ): boolean {
    if (!item || item.deleted) return false;
    if (item.message_id === currentMessageId) return false;
    if (item.msg_type === 'system') return false;
    if (!options.includeBotMessages && this.isHistoryItemFromSelf(item.sender)) return false;
    return Boolean(this.extractHistoryText(item));
  }

  private isShortReplyContextCommand(userText: string): boolean {
    const normalized = userText.replace(/\s+/g, '').trim();
    if (!normalized || normalized.length > 24) return false;
    return /^(?:回复(?:一下|下)?|回(?:一下|下)?|答(?:一下|下)?|说(?:一下|下)?|看(?:一下|下)?|[？?]+|(?:(?:他|她|它|ta|TA)?(?:这|这个|那|那个)?(?:是)?(?:咋回事|怎么回事|什么情况|啥情况|啥意思|什么意思|咋样|怎么看)|(?:这|这个|那|那个|他|她|它|ta|TA)(?:呢|咋样|怎么看)?)|怎么看|咋看|咋回|怎么回|你觉得)$/u.test(normalized);
  }

  private findLikelyLightContextAnchor(items: FeishuMessageListItem[]): FeishuMessageListItem | null {
    let best: { item: FeishuMessageListItem; score: number; time: number } | null = null;
    for (const item of items) {
      const text = this.extractHistoryText(item);
      if (!text || /^\[[^\]]+\]$/u.test(text)) continue;
      let score = 0;
      if (/[?？]/u.test(text)) score += 4;
      if (/(?:吗|么|嘛|是不是|是否|怎么|咋|如何|哪个|哪种|还是|能不能|可不可以|有没有|什么|啥|why|how|which|\bor\b)/iu.test(text)) score += 3;
      if (text.length >= 8) score += 1;
      if (/^(?:好|嗯|哦|行|可以|收到|哈哈|哈|ok|yes|no|[？?。.!！]+)$/iu.test(text.trim())) score -= 3;
      const time = Number.parseInt(item.create_time, 10) || 0;
      if (!best || score > best.score || (score === best.score && time > best.time)) {
        best = { item, score, time };
      }
    }
    return best && best.score > 0 ? best.item : null;
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
      return attachments;
    }

    if (item.msg_type === 'interactive') {
      const interactiveInfo = this.parseInteractiveMessageContent(content);
      const interactiveDownload = await this.downloadInteractiveCardResources(item.message_id, interactiveInfo);
      attachments.push(...interactiveDownload.attachments);
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
      case 'interactive': {
        return this.buildInteractiveHistoryBoundary(this.parseInteractiveMessageContent(content));
      }
      case 'sticker':
        return this.buildStickerHistoryBoundary(this.parseStickerContent(content));
      case 'image':
        return '[图片]';
      case 'file':
        return '[文件]';
      case 'audio':
        return '[语音]';
      case 'video':
      case 'media':
        return '[视频]';
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

  private getBotNameAliases(): string[] {
    const store = getBridgeContext().store;
    const rawAliases = [
      this.botDisplayName,
      store.getSetting('bridge_feishu_bot_name'),
      store.getSetting('bridge_feishu_app_name'),
      store.getSetting('bridge_feishu_bot_aliases'),
      process.env.CTI_FEISHU_BOT_ALIASES,
    ];
    const aliases: string[] = [];
    const seen = new Set<string>();
    for (const raw of rawAliases) {
      for (const item of String(raw || '').split(/[,，;；、\n\r|]+/u)) {
        const alias = item.replace(/^@+/, '').trim();
        // 名字唤醒只接受足够具体的别名，避免单字或空配置在群里误触发。
        if (Array.from(alias).length < 2) continue;
        const key = alias.toLocaleLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        aliases.push(alias);
      }
    }
    return aliases.sort((a, b) => Array.from(b).length - Array.from(a).length);
  }

  private extractBotNameWakeText(
    message: Pick<FeishuMessageEventData['message'], 'content' | 'message_type'>,
  ): string {
    if (!message.content) return '';
    if (message.message_type === 'text') {
      return this.parseTextContent(message.content);
    }
    if (message.message_type === 'post') {
      return this.parsePostContent(message.content).extractedText;
    }
    if (message.message_type === 'interactive') {
      return this.parseInteractiveContent(message.content);
    }
    return '';
  }

  private findBotNameAlias(text: string): { alias: string; index: number; length: number } | null {
    const aliases = this.getBotNameAliases();
    if (aliases.length === 0) return null;

    for (const alias of aliases) {
      if (/^[A-Za-z0-9_.-]+$/u.test(alias)) {
        const match = new RegExp(`(^|[^A-Za-z0-9_])(${escapeRegExp(alias)})(?=$|[^A-Za-z0-9_])`, 'iu').exec(text);
        if (match) {
          return {
            alias,
            index: match.index + match[1].length,
            length: match[2].length,
          };
        }
        continue;
      }

      const index = text.toLocaleLowerCase().indexOf(alias.toLocaleLowerCase());
      if (index >= 0) {
        return { alias, index, length: alias.length };
      }
    }

    return null;
  }

  private isDirectBotNameAddress(beforeAlias: string): boolean {
    const before = beforeAlias.trim();
    if (!before) return true;
    if (/[@＠,，:：;；。.!！?？、(（\[]$/u.test(before)) return true;
    return /(?:^|[\s,，])(?:hey|hi|hello|哈喽|你好|在吗)$/iu.test(before);
  }

  private isBotNameAsSubject(afterAlias: string): boolean {
    return /^(?:你|帮|能|可以|可不可以|要不要|来|看|查|搜|找|总结|分析|解释|处理|修|改|写|生成|创建|读取|打开|截图|检查|排查|回复|说|讲|评价|建议|提醒|记录|记住|艾特|@|＠|mention|提到|点名|叫|喊|问|回答|看看|弄|搞|做|发|转发|怎么|为什么|是否|是不是|吗|呢|\?|？)/iu.test(afterAlias);
  }

  private isBotNameWakeMissingMentionTarget(afterAlias: string): boolean {
    const remaining = afterAlias.replace(BOT_NAME_WAKE_MENTION_ACTION_RE, '').trim();
    if (!remaining) return true;
    return /^(?:一下|下|个人|别人|另一个人|某个人|谁|他|她|ta|TA|对方|那个人|一个人)/u.test(remaining);
  }

  private isBotNameUsedAsObject(beforeAlias: string): boolean {
    const before = beforeAlias.replace(/\s+/g, '');
    if (!before) return false;
    return /(?:让你|叫你|喊你|要你|问你|请你|你能|你可以|能不能|可不可以|帮我|帮忙|拜托你).{0,16}(?:@|＠|at|艾特|提到|点名|喷|骂|怼|叫|喊|联系|通知|找|问)$/iu.test(before);
  }

  private isNonActionableBotCorrection(text: string, aliases: string[]): boolean {
    const compact = text.replace(/\s+/g, '');
    if (/(?:不用|不要|别|别再|先别).{0,8}(?:回复|处理|管|说话)/u.test(compact)) return true;
    if (/(?:搞错|搞混|误判|误会|看清(?:楚)?(?:聊天)?记录|不是让你|没让你|不是叫你|没叫你|不是问你|没问你|不是at你|不是@你|不是艾特你)/iu.test(compact)) return true;
    return aliases.some((alias) => {
      const safeAlias = escapeRegExp(alias.replace(/\s+/g, ''));
      return new RegExp(`(?:你自己(?:就)?是|你就是|你已经是)${safeAlias}`, 'iu').test(compact);
    });
  }

  private classifyBotNameWakeFromMessage(
    message: Pick<FeishuMessageEventData['message'], 'content' | 'message_type'>,
  ): FeishuBotNameWakeClassification | null {
    return this.classifyBotNameWake(this.extractBotNameWakeText(message));
  }

  private classifyNativeBotMentionFromMessage(
    message: Pick<FeishuMessageEventData['message'], 'content' | 'message_type'>,
  ): FeishuBotNameWakeClassification | null {
    const aliases = this.getBotNameAliases();
    const alias = aliases[0] || this.botDisplayName || 'bot';
    const text = this.extractBotNameWakeText(message)
      .replace(/<at\b[^>]*>.*?<\/at>/giu, ' ')
      .replace(/@_user_\d+/giu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return null;
    if (this.isNonActionableBotCorrection(text, aliases)) {
      return {
        mode: 'name',
        state: 'done',
        alias,
        reason: 'non_actionable',
        shouldHandle: false,
      };
    }
    return null;
  }

  private classifyBotNameWake(text: string): FeishuBotNameWakeClassification | null {
    const normalized = (text || '')
      .replace(/<at\b[^>]*>.*?<\/at>/giu, ' ')
      .replace(/@_user_\d+/giu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return null;

    const match = this.findBotNameAlias(normalized);
    if (!match) return null;

    const beforeAlias = normalized.slice(0, match.index);
    const afterAlias = normalized.slice(match.index + match.length);
    const beforeCompact = beforeAlias.replace(/\s+/g, '');
    const afterLead = afterAlias.replace(/^[\s,，:：;；。.!！?？、]+/u, '').trim();
    const directAddress = this.isDirectBotNameAddress(beforeAlias);
    const nameAsSubject = this.isBotNameAsSubject(afterLead);

    if (this.isBotNameUsedAsObject(beforeCompact) || this.isNonActionableBotCorrection(normalized, [match.alias])) {
      return {
        mode: 'name',
        state: 'done',
        alias: match.alias,
        reason: 'non_actionable',
        shouldHandle: false,
      };
    }

    if (BOT_NAME_WAKE_DONE_RE.test(afterLead) && (directAddress || nameAsSubject)) {
      return {
        mode: 'name',
        state: 'done',
        alias: match.alias,
        reason: 'done_ack',
        shouldHandle: false,
      };
    }

    const thirdPersonReference = (!directAddress && BOT_NAME_WAKE_NARRATIVE_AFTER_RE.test(afterLead))
      || (BOT_NAME_WAKE_OTHER_PERSON_BEFORE_RE.test(beforeCompact) && BOT_NAME_WAKE_OTHER_PERSON_AFTER_RE.test(afterLead));
    if (thirdPersonReference || (!directAddress && !nameAsSubject)) {
      return {
        mode: 'name',
        state: 'done',
        alias: match.alias,
        reason: 'non_actionable',
        shouldHandle: false,
      };
    }

    const directedText = directAddress ? `${afterLead} ${normalized}` : afterLead;
    if (BOT_NAME_WAKE_MENTION_ACTION_RE.test(directedText) && this.isBotNameWakeMissingMentionTarget(afterLead)) {
      return {
        mode: 'name',
        state: 'need_info',
        alias: match.alias,
        reason: 'mention_target_missing',
        shouldHandle: true,
      };
    }

    if (BOT_NAME_WAKE_INVESTIGATE_RE.test(directedText)) {
      return {
        mode: 'name',
        state: 'investigate',
        alias: match.alias,
        reason: 'actionable_request',
        shouldHandle: true,
      };
    }

    if (BOT_NAME_WAKE_CHAT_RE.test(directedText) || directAddress) {
      return {
        mode: 'name',
        state: 'chat',
        alias: match.alias,
        reason: 'direct_chat',
        shouldHandle: true,
      };
    }

    return {
      mode: 'name',
      state: 'done',
      alias: match.alias,
      reason: 'non_actionable',
      shouldHandle: false,
    };
  }

  private isBotMentionedFromMessage(
    message: Pick<FeishuMessageEventData['message'], 'content' | 'mentions'>,
  ): boolean {
    if (this.isBotMentioned(message.mentions)) return true;
    if (this.botIds.size === 0 || !message.content) return false;

    try {
      const parsed = JSON.parse(message.content) as unknown;
      return this.isBotMentionedInStructuredContent(parsed);
    } catch {
      return false;
    }
  }

  private stripMentionMarkers(text: string): string {
    // Feishu text/post 使用 @_user_N，占位卡片 Markdown 使用 <at ...>。
    return text
      .replace(/<at\b[^>]*>(.*?)<\/at>/giu, '$1')
      .replace(/<at\b[^>]*\/>/giu, '')
      .replace(/<at\b[^>]*>/giu, '')
      .replace(/@_user_\d+/giu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isBotMentionedInStructuredContent(value: unknown): boolean {
    if (typeof value === 'string') {
      return this.extractMentionIdsFromAtMarkup(value).some((id) => this.botIds.has(id));
    }
    if (Array.isArray(value)) {
      return value.some((item) => this.isBotMentionedInStructuredContent(item));
    }
    if (!value || typeof value !== 'object') return false;

    const record = value as Record<string, unknown>;
    const tag = typeof record.tag === 'string' ? record.tag.trim().toLowerCase() : '';
    if (tag === 'at') {
      const ids = [
        record.user_id,
        record.userId,
        record.open_id,
        record.openId,
        record.union_id,
        record.unionId,
        record.id,
      ].filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
      if (ids.some((id) => this.botIds.has(id.trim()))) {
        return true;
      }
    }

    return Object.values(record).some((child) => this.isBotMentionedInStructuredContent(child));
  }

  private extractMentionIdsFromAtMarkup(text: string): string[] {
    return Array.from(text.matchAll(/<at\b[^>]*(?:user_id|open_id|union_id|id)=["']?([^"'\s>]+)["']?[^>]*>/giu))
      .map((match) => match[1]?.trim())
      .filter((id): id is string => Boolean(id));
  }

  // ── Resource download ───────────────────────────────────────

  /**
   * Download a message resource (image/file/audio/video). The SDK path is kept
   * first, but raw HTTP fallbacks preserve Feishu code/msg when SDK logging
   * wraps the real API error in a circular object.
   */
  private async downloadResource(
    messageId: string,
    fileKey: string,
    resourceType: string,
    failureCollector?: FeishuResourceDownloadFailure[],
  ): Promise<FileAttachment | null> {
    if (!this.restClient) return null;
    const sdkFailures: FeishuResourceDownloadFailure[] = [];

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
        sdkFailures.push({
          resourceType,
          key: fileKey,
          endpoint: 'message_resource_sdk',
          error: 'messageResource.get returned null/undefined',
        });
        const fallback = await this.downloadResourceViaHttp(messageId, fileKey, resourceType);
        if (fallback.attachment) return fallback.attachment;
        this.appendResourceDownloadFailures(failureCollector, fallback.failures.length ? fallback.failures : sdkFailures);
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
            this.appendResourceDownloadFailures(failureCollector, [{
              resourceType,
              key: fileKey,
              endpoint: 'message_resource_sdk',
              error: `resource too large > ${MAX_FILE_SIZE} bytes`,
            }]);
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
            this.appendResourceDownloadFailures(failureCollector, [{
              resourceType,
              key: fileKey,
              endpoint: 'message_resource_sdk',
              error: `resource too large > ${MAX_FILE_SIZE} bytes`,
            }]);
            return null;
          }
        } finally {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
        }
      }

      if (!buffer || buffer.length === 0) {
        console.warn('[feishu-adapter] Downloaded resource is empty, key:', fileKey);
        this.appendResourceDownloadFailures(failureCollector, [{
          resourceType,
          key: fileKey,
          endpoint: 'message_resource_sdk',
          error: 'downloaded resource is empty',
        }]);
        return null;
      }

      console.log(`[feishu-adapter] Resource downloaded: ${buffer.length} bytes, key=${fileKey}`);
      return this.buildDownloadedResourceAttachment(fileKey, resourceType, buffer);
    } catch (err) {
      const sdkFailure = this.summarizeFeishuResourceError(err, 'message_resource_sdk', resourceType, fileKey);
      sdkFailures.push(sdkFailure);
      console.error(`[feishu-adapter] Resource SDK download failed (type=${resourceType}, key=${fileKey}): ${this.formatFeishuResourceFailure(sdkFailure)}`);

      const fallback = await this.downloadResourceViaHttp(messageId, fileKey, resourceType);
      if (fallback.attachment) return fallback.attachment;
      this.appendResourceDownloadFailures(failureCollector, fallback.failures.length ? fallback.failures : sdkFailures);
      return null;
    }
  }

  private appendResourceDownloadFailures(
    collector: FeishuResourceDownloadFailure[] | undefined,
    failures: FeishuResourceDownloadFailure[],
  ): void {
    if (!collector) return;
    collector.push(...failures);
  }

  private async downloadResourceViaHttp(
    messageId: string,
    fileKey: string,
    resourceType: string,
  ): Promise<{ attachment: FileAttachment | null; failures: FeishuResourceDownloadFailure[] }> {
    const failures: FeishuResourceDownloadFailure[] = [];
    let tenantAccessToken = '';
    let baseUrl = '';

    try {
      const auth = this.getAuthContext();
      baseUrl = auth.baseUrl;
      tenantAccessToken = await this.fetchTenantAccessToken(auth.appId, auth.appSecret, auth.baseUrl);
    } catch (err) {
      failures.push(this.summarizeFeishuResourceError(err, 'message_resource_http', resourceType, fileKey));
      return { attachment: null, failures };
    }

    const resourceUrl = new URL(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`,
      baseUrl,
    );
    resourceUrl.searchParams.set('type', resourceType === 'image' ? 'image' : 'file');

    const messageResource = await this.fetchFeishuBinaryResource(
      resourceUrl,
      tenantAccessToken,
      resourceType,
      fileKey,
      'message_resource_http',
    );
    if (messageResource.attachment) return { attachment: messageResource.attachment, failures };
    if (messageResource.failure) failures.push(messageResource.failure);

    if (resourceType === 'image') {
      const imageUrl = new URL(`/open-apis/im/v1/images/${encodeURIComponent(fileKey)}`, baseUrl);
      const imageResource = await this.fetchFeishuBinaryResource(
        imageUrl,
        tenantAccessToken,
        resourceType,
        fileKey,
        'image_http',
      );
      if (imageResource.attachment) return { attachment: imageResource.attachment, failures };
      if (imageResource.failure) failures.push(imageResource.failure);
    }

    return { attachment: null, failures };
  }

  private async fetchFeishuBinaryResource(
    url: URL,
    tenantAccessToken: string,
    resourceType: string,
    fileKey: string,
    endpoint: FeishuResourceDownloadFailure['endpoint'],
  ): Promise<{ attachment: FileAttachment | null; failure?: FeishuResourceDownloadFailure }> {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tenantAccessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      const contentType = response.headers.get('content-type') || '';
      const looksJson = contentType.toLowerCase().includes('application/json');
      if (!response.ok || looksJson) {
        const text = await response.text().catch(() => '');
        const body = this.tryParseJsonRecord(text);
        const code = body ? this.readErrorCode(body) : undefined;
        const msg = body ? this.readErrorMessage(body) : undefined;
        return {
          attachment: null,
          failure: {
            resourceType,
            key: fileKey,
            endpoint,
            status: response.status,
            code,
            msg: msg || response.statusText || undefined,
            error: !msg && text ? text.slice(0, 300) : undefined,
          },
        };
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length > MAX_FILE_SIZE) {
        return {
          attachment: null,
          failure: {
            resourceType,
            key: fileKey,
            endpoint,
            status: response.status,
            error: `resource too large > ${MAX_FILE_SIZE} bytes`,
          },
        };
      }
      if (buffer.length === 0) {
        return {
          attachment: null,
          failure: {
            resourceType,
            key: fileKey,
            endpoint,
            status: response.status,
            error: 'downloaded resource is empty',
          },
        };
      }

      const mimeType = contentType.split(';')[0]?.trim() || undefined;
      return {
        attachment: this.buildDownloadedResourceAttachment(fileKey, resourceType, buffer, mimeType),
      };
    } catch (err) {
      return {
        attachment: null,
        failure: this.summarizeFeishuResourceError(err, endpoint, resourceType, fileKey),
      };
    }
  }

  private buildDownloadedResourceAttachment(
    fileKey: string,
    resourceType: string,
    buffer: Buffer,
    mimeTypeOverride?: string,
  ): FileAttachment {
    const mimeType = mimeTypeOverride || MIME_BY_TYPE[resourceType] || 'application/octet-stream';
    const ext = this.extensionForFeishuResource(resourceType, mimeType);
    return {
      id: crypto.randomUUID(),
      name: `${fileKey}.${ext}`,
      type: mimeType,
      size: buffer.length,
      data: buffer.toString('base64'),
    };
  }

  private extensionForFeishuResource(resourceType: string, mimeType: string): string {
    const normalized = mimeType.toLowerCase();
    if (normalized.includes('jpeg')) return 'jpg';
    if (normalized.includes('png')) return 'png';
    if (normalized.includes('webp')) return 'webp';
    if (normalized.includes('gif')) return 'gif';
    if (normalized.includes('ogg')) return 'ogg';
    if (normalized.includes('mp4')) return 'mp4';
    if (resourceType === 'image') return 'png';
    if (resourceType === 'audio') return 'ogg';
    if (resourceType === 'video') return 'mp4';
    return 'bin';
  }

  private summarizeFeishuResourceError(
    err: unknown,
    endpoint: FeishuResourceDownloadFailure['endpoint'],
    resourceType: string,
    key: string,
  ): FeishuResourceDownloadFailure {
    const record = this.asRecord(err);
    const response = this.asRecord(record?.response);
    const data = this.asRecord(response?.data) || this.asRecord(record?.data) || this.asRecord(record?.body);
    const statusValue = response?.status ?? record?.status ?? record?.statusCode;
    const code = (data ? this.readErrorCode(data) : undefined) ?? this.readErrorCode(record);
    const msg = (data ? this.readErrorMessage(data) : undefined) ?? this.readErrorMessage(record);
    const message = err instanceof Error ? err.message : undefined;

    return {
      resourceType,
      key,
      endpoint,
      status: typeof statusValue === 'number' ? statusValue : Number.isFinite(Number(statusValue)) ? Number(statusValue) : undefined,
      code,
      msg,
      error: msg ? undefined : (message || this.safeStringifyCompact(err)),
    };
  }

  private readErrorCode(record: Record<string, unknown> | null | undefined): number | string | undefined {
    if (!record) return undefined;
    const value = record.code ?? record.error_code ?? record.errcode;
    if (typeof value === 'number' || typeof value === 'string') return value;
    return undefined;
  }

  private readErrorMessage(record: Record<string, unknown> | null | undefined): string | undefined {
    if (!record) return undefined;
    const value = record.msg ?? record.message ?? record.error_description ?? record.error;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  }

  private tryParseJsonRecord(text: string): Record<string, unknown> | null {
    if (!text.trim()) return null;
    try {
      return this.asRecord(JSON.parse(text));
    } catch {
      return null;
    }
  }

  private safeStringifyCompact(value: unknown): string {
    if (typeof value === 'string') return value;
    const seen = new WeakSet<object>();
    try {
      return JSON.stringify(value, (_key, current) => {
        if (current && typeof current === 'object') {
          if (seen.has(current)) return '[Circular]';
          seen.add(current);
        }
        return current;
      }).slice(0, 300);
    } catch {
      try {
        return String(value).slice(0, 300);
      } catch {
        return 'unserializable error';
      }
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
