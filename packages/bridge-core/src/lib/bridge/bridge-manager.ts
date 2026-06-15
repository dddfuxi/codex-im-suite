/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import type { BridgeStatus, ChannelBinding, InboundMessage, OutboundMessage, OutboundMention, StreamingPreviewState, ToolCallInfo, UploadedFileLink } from './types.js';
import type {
  AnswerReviewInput,
  ConversationMemoryEvent,
  DirectReminderCreateResult,
  ExtensionActionActor,
  ExtensionActionConfirmResult,
  ExtensionActionPrepareResult,
  ExtensionCatalogItemSummary,
  FeishuCloudLinkResolveResult,
  FeishuOAuthManualResumeRequest,
  FileAttachment,
  MemoryWriteCandidate,
  MemoryWriteIntentDecision,
  MemoryReplyDecision,
} from './host.js';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { AdapterAssistantIdentity, BaseChannelAdapter } from './channel-adapter.js';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters/index.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { deliver, deliverRendered } from './delivery-layer.js';
import { markdownToTelegramChunks } from './markdown/telegram.js';
import { markdownToDiscordChunks } from './markdown/discord.js';
import { formatVisibleToolName } from './markdown/feishu.js';
import {
  classifyExecutionRequirement,
  isFeishuStickerMessageKind,
  type ExecutionRequirement,
} from './execution-requirement.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';
import {
  splitWorkspacePathList,
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators.js';
import {
  getFeishuDocumentGuideMetaPath,
  getFeishuDocumentGuidePath,
  recordFeishuDocumentMemory,
  renderFeishuDocumentMemoryList,
} from './feishu-document-memory.js';
import { buildFeishuCapabilityReport } from './feishu-capabilities.js';
import {
  completeBridgeRuntimeRequest,
  failBridgeRuntimeRequest,
  makeInboundSummary,
  makeRequestSummary,
  markBridgeRuntimeStage,
  recordBridgeRuntimeInbound,
  updateBridgeRuntimeActiveRequest,
} from './runtime-audit.js';

const GLOBAL_KEY = '__bridge_manager__';
const execFileAsync = promisify(execFile);
const FINAL_REPLY_FENCE = 'cti-final';
const REMINDER_ACTION_FENCE = 'cti-reminder';
const BRIDGE_HOME = process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im');
const PERMISSIONS_PATH = path.join(BRIDGE_HOME, 'data', 'permissions.json');
const PENDING_SYSTEM_ACTIONS_KEY = '__bridge_pending_system_actions__';
const SYSTEM_ACTION_CONFIRM_TTL_MS = 2 * 60 * 1000;
const FINAL_ENVELOPE_STATUS_PATH = path.join(
  BRIDGE_HOME,
  'runtime',
  'final-envelope-status.json',
);
const FEISHU_FILE_UPLOAD_LIMIT_BYTES = 30 * 1024 * 1024;
const INBOUND_DEDUP_KEY_PREFIX = 'inbound:v1';

type ArtifactUploadMode = 'none' | 'local_http' | 'feishu_docx';

interface ArtifactDeliveryConfig {
  mode: ArtifactUploadMode;
  publicBaseUrl: string;
  publicDir: string;
  publicSubdir: string;
}

interface UploadedArtifactRecord {
  fileName: string;
  sourcePath: string;
  publicPath: string;
  url: string;
  sizeBytes: number;
}

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

interface ProgressPulseConfig {
  enabled: boolean;
  intervalMs: number;
}

interface UnityMcpHealthConfig {
  endpoints: string[];
  startCommand: string;
  probeTimeoutMs: number;
  startTimeoutMs: number;
  retryCount: number;
}

function getReplyEndMarker(): string {
  const { store } = getBridgeContext();
  const raw = (store.getSetting('bridge_reply_end_marker') || process.env.CTI_REPLY_END_MARKER || '✅').trim();
  return raw || '✅';
}

function appendReplyEndMarker(text: string): string {
  const marker = getReplyEndMarker();
  const trimmed = text.trimEnd();
  if (!trimmed) return marker;
  if (trimmed.endsWith(marker)) return text;
  return `${trimmed}\n\n${marker}`;
}

const TOOL_EXECUTION_REQUEST_PATTERN = /(unity\s*mcp|unitymcp|mcp\s*for\s*unity|unity|blender|hsscene|furniture_|prefab|timeline|场景|节点|截图|导入|导出|看一眼|查一下|分析一下|整理.*列表)/i;
const OUTSOURCED_TOOL_REPLY_PATTERN = /(请|可以|建议|需要).{0,16}(手动|自行|自己).{0,48}(检查|打开|查找|搜索|运行|分析)|打开你的\s*Unity\s*项目|在\s*Unity\s*编辑器中|使用\s*Unity\s*的搜索功能|将脚本添加到项目|运行脚本|示例列表草案/i;
const MCP_ENTRY_CLARIFICATION_REPLY_PATTERN = /(?:请(?:先)?(?:明确|指定).{0,12}(?:MCP|Unity MCP).{0,12}(?:入口|目标)|可用\s*MCP\s*入口|例如[:：].{0,80}(?:Unity MCP|Unity Prefab MCP|Blender MCP|Fetch MCP))/i;
const TASK_INTENT_PATTERN = /(帮我|麻烦|请|需要|能不能|可以帮|处理|执行|运行|启动|停止|重启|发布|同步|安装|升级|修|修复|改|修改|替换|检查|排查|诊断|看一下|看一眼|查一下|找一下|分析|整理|总结|汇总|生成|创建|写|删除|添加|上传|下载|截图|回溯|记忆|记得|历史|权限|报错|异常|失败|为什么|怎么回事|哪里|怎么|如何|unity|mcp|codex|claude|bridge|飞书|面板|文件|代码|仓库|commit|push|git)/i;

interface CtiReminderAction {
  title: string;
  dueAt: string;
  timezone?: string;
  target: 'current_chat';
  sourcePrompt?: string;
}

interface ExtractedReminderAction {
  action: CtiReminderAction | null;
  text: string;
}

interface ParsedReminderRequest {
  title: string;
  dueAt: string;
}

function isToolExecutionRequestText(text: string): boolean {
  return TOOL_EXECUTION_REQUEST_PATTERN.test(text);
}

function isMemoryRecallRequestText(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return /(记忆|还记得|你还记得|上次|之前|历史|对应表)/.test(normalized);
}

function isExplicitMemoryWriteRequestText(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return /(?:记住|记一下|记录一下|帮我记|写入记忆|保存到记忆|长期记忆|以后(?:就)?(?:叫|称呼|记作)|这个(?:表情包|表情|图|词|名字)?.{0,16}(?:表示|代表|意思是|叫|名称是|语气是|用来))/u.test(normalized);
}

function containsOutsourcedToolReply(text: string): boolean {
  return OUTSOURCED_TOOL_REPLY_PATTERN.test(text) || MCP_ENTRY_CLARIFICATION_REPLY_PATTERN.test(text);
}

function buildSmallTalkReply(_text: string, _identity?: AdapterAssistantIdentity | null): string {
  // Natural chat should go through the configured provider so identity, tone,
  // Feishu reaction/sticker hints, and current context stay model-driven.
  return '';
}

function hashDedupParts(parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex').slice(0, 32);
}

function normalizeInboundDedupText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function makeInboundMessageDedupKey(adapter: BaseChannelAdapter, msg: InboundMessage): string | null {
  const messageId = msg.messageId?.trim();
  if (!messageId) return null;
  return `${INBOUND_DEDUP_KEY_PREFIX}:message:${hashDedupParts([
    adapter.channelType,
    msg.address.chatId || '',
    messageId,
  ])}`;
}

function makeInboundTextDedupKey(adapter: BaseChannelAdapter, msg: InboundMessage, rawText: string): string | null {
  const normalizedText = normalizeInboundDedupText(rawText);
  if (normalizedText.length < 3) return null;
  return `${INBOUND_DEDUP_KEY_PREFIX}:text:${hashDedupParts([
    adapter.channelType,
    msg.address.chatId || '',
    msg.address.userId || '',
    normalizedText,
  ])}`;
}

function claimInboundForExecution(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  rawText: string,
  hasAttachments: boolean,
): { duplicate: boolean; key?: string; reason?: string } {
  const { store } = getBridgeContext();
  const messageKey = makeInboundMessageDedupKey(adapter, msg);
  const textKey = makeInboundTextDedupKey(adapter, msg, rawText);

  if (messageKey && store.checkDedup(messageKey)) {
    return { duplicate: true, key: messageKey, reason: 'message_id' };
  }
  if (textKey && store.checkDedup(textKey)) {
    return { duplicate: true, key: textKey, reason: 'text_fingerprint' };
  }

  if (messageKey) store.insertDedup(messageKey);
  // Feishu media captions can be recovered by history polling as a separate
  // text-only message id. Only media-backed turns seed the text fingerprint so
  // an intentional repeated text request is not suppressed by default.
  if (hasAttachments && textKey) store.insertDedup(textKey);
  return { duplicate: false };
}

function extractCtiReminderAction(text: string): ExtractedReminderAction {
  const fencePattern = new RegExp(`(^|\\n)\\s*\`\`\`${REMINDER_ACTION_FENCE}\\s*\\r?\\n([\\s\\S]*?)\\r?\\n\\s*\`\`\``, 'i');
  const match = text.match(fencePattern);
  if (!match) {
    return { action: null, text };
  }

  const cleaned = text.replace(fencePattern, '$1').replace(/\n{3,}/g, '\n\n').trim();
  try {
    const parsed = JSON.parse(match[2].trim()) as Partial<CtiReminderAction>;
    if (
      typeof parsed.title !== 'string'
      || !parsed.title.trim()
      || typeof parsed.dueAt !== 'string'
      || !parsed.dueAt.trim()
      || parsed.target !== 'current_chat'
    ) {
      return { action: null, text: cleaned };
    }
    return {
      action: {
        title: parsed.title.trim(),
        dueAt: parsed.dueAt.trim(),
        timezone: typeof parsed.timezone === 'string' ? parsed.timezone.trim() : undefined,
        target: 'current_chat',
        sourcePrompt: typeof parsed.sourcePrompt === 'string' ? parsed.sourcePrompt.trim() : undefined,
      },
      text: cleaned,
    };
  } catch {
    return { action: null, text: cleaned };
  }
}

function containsUnverifiedReminderCompletion(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const completionClaim = /(已|已经|成功|实际|真的).{0,16}(创建|设好|设置|登记|安排).{0,32}(系统计划任务|计划任务|提醒|消息提醒|定时提醒)/i;
  const schedulerArtifact = /(CodexFeishuReminder_|Register-ScheduledTask|schtasks\s+\/Create)/i;
  return completionClaim.test(normalized) || schedulerArtifact.test(normalized);
}

function parseChineseReminderAmount(token: string): number | null {
  if (/^\d{1,4}$/.test(token)) return Number(token);
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (digits[token] !== undefined) return digits[token];
  const tenIndex = token.indexOf('十');
  if (tenIndex >= 0) {
    const tensToken = token.slice(0, tenIndex);
    const onesToken = token.slice(tenIndex + 1);
    const tens = tensToken ? digits[tensToken] : 1;
    const ones = onesToken ? digits[onesToken] : 0;
    if (tens === undefined || ones === undefined) return null;
    return tens * 10 + ones;
  }
  return null;
}

function parseChineseClockHour(token: string): number | null {
  if (/^\d{1,2}$/.test(token)) {
    const value = Number(token);
    return value >= 0 && value <= 23 ? value : null;
  }
  const value = parseChineseReminderAmount(token);
  return value !== null && value >= 0 && value <= 23 ? value : null;
}

type ReminderDayToken = '今天' | '明天' | '后天';
type ReminderMeridiemToken = '凌晨' | '早上' | '上午' | '中午' | '下午' | '晚上' | '今晚';

interface ReminderClockParts {
  year?: number;
  month?: number;
  day?: number;
  dayToken?: ReminderDayToken;
  meridiem?: ReminderMeridiemToken;
  hour: number;
  minute: number;
  start: number;
  end: number;
  hasExplicitYear?: boolean;
}

const CLOCK_HOUR_PATTERN = String.raw`([01]?\d|2[0-3]|[一二两三四五六七八九十]{1,3})`;
const CLOCK_MINUTE_PATTERN = String.raw`(?:(?::|点|时)\s*([0-5]\d)|([点时])半|点\s*([一二三四五六七八九]刻)|点|时)`;
const DAY_TOKEN_PATTERN = String.raw`(今天|明天|后天)?`;
const MERIDIEM_PATTERN = String.raw`(凌晨|早上|上午|中午|下午|晚上|今晚)?`;
const TIME_PREFIX_BOUNDARY_PATTERN = String.raw`(?:^|[^\d一二两三四五六七八九十])`;

function parseClockMinute(minuteText?: string, halfMarker?: string, quarterText?: string): number | null {
  if (halfMarker) return 30;
  if (minuteText) return Number(minuteText);
  if (quarterText) {
    const quarter = parseChineseReminderAmount(quarterText.replace(/刻$/u, ''));
    return quarter !== null && quarter >= 1 && quarter <= 3 ? quarter * 15 : null;
  }
  return 0;
}

function applyReminderMeridiem(hour: number, meridiem?: ReminderMeridiemToken): number | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!meridiem) return hour;
  if (meridiem === '下午' || meridiem === '晚上' || meridiem === '今晚') {
    return hour >= 1 && hour <= 11 ? hour + 12 : hour;
  }
  if (meridiem === '中午') {
    return hour >= 1 && hour <= 10 ? hour + 12 : hour;
  }
  return hour;
}

function buildReminderDueDate(parts: ReminderClockParts, now: Date): Date | null {
  const hour = applyReminderMeridiem(parts.hour, parts.meridiem);
  if (hour === null || !Number.isInteger(parts.minute) || parts.minute < 0 || parts.minute > 59) return null;
  const due = new Date(now.getTime());

  if (parts.month !== undefined && parts.day !== undefined) {
    due.setFullYear(parts.year ?? now.getFullYear(), parts.month - 1, parts.day);
    due.setHours(hour, parts.minute, 0, 0);
    if (!Number.isFinite(due.getTime()) || due.getMonth() !== parts.month - 1 || due.getDate() !== parts.day) {
      return null;
    }
    if (!parts.hasExplicitYear && due.getTime() <= now.getTime()) {
      due.setFullYear(due.getFullYear() + 1);
    }
    return due;
  }

  due.setHours(hour, parts.minute, 0, 0);
  if (parts.dayToken === '明天') {
    due.setDate(due.getDate() + 1);
  } else if (parts.dayToken === '后天') {
    due.setDate(due.getDate() + 2);
  } else if (!parts.dayToken && !parts.meridiem && parts.hour >= 1 && parts.hour <= 11 && due.getTime() <= now.getTime()) {
    due.setHours(parts.hour + 12, parts.minute, 0, 0);
    if (due.getTime() <= now.getTime()) {
      due.setDate(due.getDate() + 1);
      due.setHours(parts.hour, parts.minute, 0, 0);
    }
  } else if (!parts.dayToken && due.getTime() <= now.getTime()) {
    due.setDate(due.getDate() + 1);
  } else if (parts.dayToken === '今天' && due.getTime() <= now.getTime()) {
    return null;
  }
  return due;
}

function extractNaturalReminderTitle(tail: string): string {
  let title = tail.replace(/^[\s,，。；;、:：]+/u, '').trim();
  for (let i = 0; i < 4; i += 1) {
    const before = title;
    title = title
      .replace(/^(?:给我|帮我|麻烦你?|请你?)\s*/u, '')
      .replace(/^(?:发|发送)(?:一条|一个|个)?(?:消息|信息|提醒)?\s*/u, '')
      .replace(/^(?:提醒我|提示我|通知我|告诉我|叫我)\s*/u, '')
      .replace(/^(?:说|内容是|内容为|为|：|:)\s*/u, '')
      .trim();
    if (title === before) break;
  }
  return title.replace(/[，,。！？!?\s]+$/u, '').trim();
}

function buildAbsoluteReminderDueAt(
  normalized: string,
  now: Date,
): { dueAt: string; start: number; end: number } | null {
  const dated = new RegExp(
    String.raw`(?:(\d{4})[年/-])?(\d{1,2})[月/-](\d{1,2})[日号]?\s*${MERIDIEM_PATTERN}\s*${CLOCK_HOUR_PATTERN}\s*${CLOCK_MINUTE_PATTERN}(?:\s*分)?`,
    'u',
  ).exec(normalized);
  if (dated && dated.index !== undefined) {
    const hour = parseChineseClockHour(dated[5]);
    const minute = parseClockMinute(dated[6], dated[7], dated[8]);
    if (hour === null || minute === null) return null;
    const due = buildReminderDueDate({
      year: dated[1] ? Number(dated[1]) : undefined,
      month: Number(dated[2]),
      day: Number(dated[3]),
      meridiem: dated[4] as ReminderMeridiemToken | undefined,
      hour,
      minute,
      start: dated.index,
      end: dated.index + dated[0].length,
      hasExplicitYear: Boolean(dated[1]),
    }, now);
    if (!due) return null;
    return {
      dueAt: due.toISOString(),
      start: dated.index,
      end: dated.index + dated[0].length,
    };
  }

  const absolute = new RegExp(
    String.raw`${TIME_PREFIX_BOUNDARY_PATTERN}\s*${DAY_TOKEN_PATTERN}\s*${MERIDIEM_PATTERN}\s*${CLOCK_HOUR_PATTERN}\s*${CLOCK_MINUTE_PATTERN}(?:\s*分)?`,
    'u',
  ).exec(normalized);
  if (!absolute || absolute.index === undefined) return null;
  const leading = absolute[0].match(/^[^\d一二两三四五六七八九十今明后]?/u)?.[0] || '';
  const dayToken = absolute[1] || '';
  const meridiem = absolute[2] as ReminderMeridiemToken | undefined;
  const hour = parseChineseClockHour(absolute[3]);
  const minute = parseClockMinute(absolute[4], absolute[5], absolute[6]);
  if (hour === null || minute === null) return null;
  const due = buildReminderDueDate({
    dayToken: dayToken as ReminderDayToken | undefined,
    meridiem,
    hour,
    minute,
    start: absolute.index + leading.length,
    end: absolute.index + absolute[0].length,
  }, now);
  if (!due) return null;

  return {
    dueAt: due.toISOString(),
    start: absolute.index + leading.length,
    end: absolute.index + absolute[0].length,
  };
}

function parseNaturalReminderRequest(text: string, now = new Date()): ParsedReminderRequest | null {
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!normalized) return null;
  if (/(为什么|怎么回事|解释|说明|脚本|代码|示例|怎么写|如何写|帮我写|今天有什么|有哪些|查看|列出|查询|搜索)/u.test(normalized)) {
    return null;
  }
  if (!/(提醒我|提示我|给我发.{0,8}(消息|提醒|信息)|发.{0,8}(消息|提醒|信息).{0,8}(提醒我|提示我|通知我)|设置.{0,8}(待办|提醒)|创建.{0,8}(待办|提醒)|安排.{0,8}(待办|提醒))/u.test(normalized)) {
    return null;
  }

  const relative = /([0-9]{1,4}|[一二两三四五六七八九十]{1,3})\s*(分钟|分|小时|时|天)后/u.exec(normalized);
  if (relative && relative.index !== undefined) {
    const amount = parseChineseReminderAmount(relative[1]);
    if (!amount || amount <= 0) return null;
    const unit = relative[2];
    const ms = unit.startsWith('分') ? amount * 60_000
      : unit.startsWith('小') || unit === '时' ? amount * 60 * 60_000
        : amount * 24 * 60 * 60_000;
    const title = extractNaturalReminderTitle(normalized.slice(relative.index + relative[0].length))
      || extractNaturalReminderTitle(normalized.slice(0, relative.index));
    if (!title || /^(提醒|消息|信息|待办)$/u.test(title)) return null;
    return { title, dueAt: new Date(now.getTime() + ms).toISOString() };
  }

  const absolute = buildAbsoluteReminderDueAt(normalized, now);
  if (!absolute) return null;
  const absoluteTitle = extractNaturalReminderTitle(normalized.slice(absolute.end))
    || extractNaturalReminderTitle(normalized.slice(0, absolute.start));
  if (!absoluteTitle || /^(提醒|消息|信息|待办)$/u.test(absoluteTitle)) return null;
  return { title: absoluteTitle, dueAt: absolute.dueAt };
}

function getInboundMessageDate(msg: InboundMessage): Date {
  if (Number.isFinite(msg.timestamp)) {
    const timestampMs = msg.timestamp! < 10_000_000_000 ? msg.timestamp! * 1000 : msg.timestamp!;
    const date = new Date(timestampMs);
    if (Number.isFinite(date.getTime())) return date;
  }
  return new Date();
}

function formatLocalReminderTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function buildReminderActionResultText(result: DirectReminderCreateResult): string {
  if (!result.ok) {
    return `未完成：提醒没有进入统一提醒系统。\n原因：${result.error || '未知错误'}`;
  }
  return [
    `提醒已进入统一提醒系统：${result.title || '未命名提醒'}`,
    result.dueAt ? `时间：${formatLocalReminderTime(result.dueAt)}` : '',
    result.target?.chatId ? `目标：当前 ${result.target.channelType} 会话 ${result.target.chatId}` : '',
    result.reminderId ? `Reminder ID：${result.reminderId}` : '',
    '到点后会走 bridge 的 Feishu 推送通道，并在 reminder-state.json 和面板里记录成功或失败。',
  ].filter(Boolean).join('\n');
}

async function executeReminderActionFromReply(
  rawReply: string,
  msg: InboundMessage,
  sessionId: string,
  rawPrompt: string,
): Promise<string> {
  const extracted = extractCtiReminderAction(rawReply);
  const reminders = getBridgeContext().reminders;
  if (extracted.action) {
    if (!reminders) {
      return '未完成：当前 bridge 没有加载统一提醒服务，不能创建提醒。';
    }
    const result = await reminders.createDirectReminder({
      title: extracted.action.title,
      dueAt: extracted.action.dueAt,
      timezone: extracted.action.timezone,
      target: msg.address,
      sourcePrompt: extracted.action.sourcePrompt || rawPrompt,
      createdByMessageId: msg.messageId,
      sessionId,
    });
    await reminders.tickReminders?.();
    return buildReminderActionResultText(result);
  }

  if (containsUnverifiedReminderCompletion(rawReply)) {
    const parsedPrompt = parseNaturalReminderRequest(rawPrompt, getInboundMessageDate(msg));
    if (parsedPrompt && reminders) {
      const result = await reminders.createDirectReminder({
        title: parsedPrompt.title,
        dueAt: parsedPrompt.dueAt,
        timezone: 'Asia/Shanghai',
        target: msg.address,
        sourcePrompt: rawPrompt,
        createdByMessageId: msg.messageId,
        sessionId,
      });
      await reminders.tickReminders?.();
      return buildReminderActionResultText(result);
    }
    return [
      '未完成：这条回复声称已经创建提醒或系统计划任务，但没有进入 bridge 的统一提醒系统。',
      '为避免伪完成，已拦截原回复。请重新发送明确提醒请求，让 Codex 产出 cti-reminder 动作，或使用 /remind 固定格式。',
    ].join('\n');
  }

  return rawReply;
}

async function tryHandleNaturalDirectReminder(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  binding: ChannelBinding,
  rawText: string,
): Promise<boolean> {
  const parsed = parseNaturalReminderRequest(rawText, getInboundMessageDate(msg));
  if (!parsed) return false;

  const reminders = getBridgeContext().reminders;
  let responseText: string;
  if (!reminders) {
    responseText = '未完成：当前 bridge 没有加载统一提醒服务，不能创建提醒。';
  } else {
    const result = await reminders.createDirectReminder({
      title: parsed.title,
      dueAt: parsed.dueAt,
      timezone: 'Asia/Shanghai',
      target: msg.address,
      sourcePrompt: rawText,
      createdByMessageId: msg.messageId,
      sessionId: binding.codepilotSessionId,
    });
    await reminders.tickReminders?.();
    responseText = buildReminderActionResultText(result);
  }

  const { store } = getBridgeContext();
  store.addMessage(binding.codepilotSessionId, 'user', rawText);
  store.addMessage(binding.codepilotSessionId, 'assistant', responseText);
  recordConversationMemoryEvent(msg, binding, 'user', rawText);
  recordConversationMemoryEvent(msg, binding, 'assistant', responseText);
  await deliverResponse(adapter, msg.address, responseText, binding.codepilotSessionId, msg.messageId);
  return true;
}

function parseSlashReminderArgs(args: string, now = new Date()): { title: string; dueAt: string } | null {
  const text = args.trim();
  if (!text) return null;
  const relative = text.match(/^(\d{1,4})\s*(分钟|分|小时|时|天)后\s+(.+)$/u);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const title = relative[3].trim();
    const ms = unit.startsWith('分') ? amount * 60_000
      : unit.startsWith('小') || unit === '时' ? amount * 60 * 60_000
        : amount * 24 * 60 * 60_000;
    return title ? { title, dueAt: new Date(now.getTime() + ms).toISOString() } : null;
  }
  const absolute = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})\s+(.+)$/u);
  if (absolute) {
    const date = new Date(`${absolute[1]}T${absolute[2].padStart(5, '0')}:00+08:00`);
    const title = absolute[3].trim();
    return title && Number.isFinite(date.getTime()) ? { title, dueAt: date.toISOString() } : null;
  }
  return null;
}

function buildExtensionActor(msg: InboundMessage): ExtensionActionActor {
  return {
    channelType: msg.address.channelType,
    chatId: msg.address.chatId,
    userId: msg.address.userId,
    messageId: msg.messageId,
  };
}

function formatExtensionItemLine(item: ExtensionCatalogItemSummary): string {
  const installed = item.installed ? ' · 已安装' : '';
  const removable = item.canRemove ? ' · 可移除记录' : '';
  const version = item.version ? ` ${item.version}` : '';
  const source = item.source ? ` · ${item.source}` : '';
  return `- ${item.displayName}${version} (${item.type}/${item.id})${installed}${removable}${source}`;
}

function renderExtensionSearchResults(query: string, items: ExtensionCatalogItemSummary[]): string {
  if (items.length === 0) {
    return `没有找到匹配的扩展：${query}`;
  }
  return [
    `扩展目录搜索：${query}`,
    '',
    ...items.slice(0, 8).map(formatExtensionItemLine),
    items.length > 8 ? `还有 ${items.length - 8} 个结果，请缩小关键词。` : '',
  ].filter(Boolean).join('\n');
}

function buildExtensionActionCard(
  title: string,
  body: string,
  buttonText: string,
  callbackData: string,
  buttonType: 'primary' | 'danger' = 'primary',
): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: buttonType === 'danger' ? 'red' : 'blue',
      title: { tag: 'plain_text', content: title },
    },
    body: {
      elements: [
        { tag: 'markdown', content: body },
        { tag: 'hr' },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: buttonText },
          type: buttonType,
          size: 'medium',
          value: { callback_data: callbackData },
        },
      ],
    },
  });
}

function renderExtensionPrepareText(action: 'install' | 'remove', result: ExtensionActionPrepareResult): string {
  const item = result.item;
  const title = action === 'install' ? '等待确认安装' : '等待确认移除记录';
  const lines = [
    result.message || title,
    item ? formatExtensionItemLine(item) : '',
    result.expiresAt ? `过期时间：${result.expiresAt}` : '',
    action === 'remove' ? '移除记录不会删除插件缓存、模型本体或外部包管理器内容。' : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function parseExtensionCallback(callbackData: string): { action: 'confirm' | 'remove'; nonce: string } | null {
  const parts = callbackData.split(':');
  if (parts.length < 3 || parts[0] !== 'extinstall') return null;
  const action = parts[1];
  if (action !== 'confirm' && action !== 'remove') return null;
  const nonce = parts.slice(2).join(':').trim();
  return nonce ? { action, nonce } : null;
}

function isHttpsText(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isUrlLike(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

async function handleExtensionCallback(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  parsed: { action: 'confirm' | 'remove'; nonce: string },
): Promise<void> {
  const { extensions } = getBridgeContext();
  if (!extensions) {
    await deliver(adapter, {
      address: msg.address,
      text: '面板未在线或扩展安装能力不可用。',
      parseMode: 'plain',
      replyToMessageId: msg.callbackMessageId,
    });
    return;
  }
  if (!isOwnerMessage(msg)) {
    await deliver(adapter, {
      address: msg.address,
      text: buildOwnerRequiredMessage(msg),
      parseMode: 'plain',
      replyToMessageId: msg.callbackMessageId,
    });
    return;
  }

  const actor = buildExtensionActor(msg);
  const result: ExtensionActionConfirmResult = parsed.action === 'confirm'
    ? await extensions.confirmInstallAction(parsed.nonce, actor)
    : await extensions.confirmRemoveAction(parsed.nonce, actor);
  const text = result.message || result.error || (
    result.ok
      ? (parsed.action === 'confirm' ? '安装已完成。' : '记录已移除。')
      : '扩展操作失败。'
  );
  await deliver(adapter, {
    address: msg.address,
    text,
    parseMode: 'plain',
    replyToMessageId: msg.callbackMessageId,
  });
}

function parseNaturalExtensionIntent(text: string): { action: 'search' | 'install'; query: string } | null {
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  const searchMatch = normalized.match(/(?:搜索|查找|找一下).{0,8}(model|模型|mcp|插件|plugin|skill|扩展)?\s*([a-zA-Z0-9_.:@/\-\s]{2,})/i);
  if (searchMatch) {
    return { action: 'search', query: searchMatch[2].trim() };
  }
  const installMatch = normalized.match(/(?:安装|装|加一下).{0,8}([a-zA-Z0-9_.:@/\-\s]{2,})(?:\s*(?:model|模型|mcp|插件|plugin|skill|扩展))?/i);
  if (installMatch && /(model|模型|mcp|插件|plugin|skill|扩展|qwen|browser|sequential|memory|fetch|ollama)/i.test(normalized)) {
    return { action: 'install', query: installMatch[1].trim() };
  }
  return null;
}

async function prepareExtensionInstall(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  queryOrUrl: string,
): Promise<void> {
  const { extensions } = getBridgeContext();
  if (!extensions) {
    await deliver(adapter, {
      address: msg.address,
      text: '面板未在线或扩展安装能力不可用。',
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }
  if (!isOwnerMessage(msg)) {
    await deliver(adapter, {
      address: msg.address,
      text: buildOwnerRequiredMessage(msg),
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let item: ExtensionCatalogItemSummary | null = null;
  let url = '';
  if (isUrlLike(queryOrUrl)) {
    if (!isHttpsText(queryOrUrl)) {
      await deliver(adapter, {
        address: msg.address,
        text: 'URL 安装只允许 HTTPS。',
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
      return;
    }
    url = queryOrUrl;
    item = await extensions.previewExtensionUrl(queryOrUrl);
  } else {
    const matches = await extensions.searchExtensions(queryOrUrl);
    if (matches.length === 0) {
      await deliver(adapter, {
        address: msg.address,
        text: `没有找到可安装扩展：${queryOrUrl}`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
      return;
    }
    if (matches.length > 1) {
      await deliver(adapter, {
        address: msg.address,
        text: renderExtensionSearchResults(queryOrUrl, matches),
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
      return;
    }
    item = matches[0];
  }

  const prepared = await extensions.prepareInstallAction({ item, url: url || undefined, actor: buildExtensionActor(msg) });
  if (!prepared.ok || !prepared.nonce) {
    await deliver(adapter, {
      address: msg.address,
      text: prepared.error || prepared.message || '扩展安装确认创建失败。',
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }
  const text = renderExtensionPrepareText('install', prepared);
  await deliver(adapter, {
    address: msg.address,
    text,
    parseMode: 'plain',
    replyToMessageId: msg.messageId,
    feishuCardJson: buildExtensionActionCard('扩展安装确认', text, '安装', `extinstall:confirm:${prepared.nonce}`),
  });
}

async function prepareExtensionRemove(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  query: string,
): Promise<void> {
  const { extensions } = getBridgeContext();
  if (!extensions) {
    await deliver(adapter, {
      address: msg.address,
      text: '面板未在线或扩展安装能力不可用。',
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }
  if (!isOwnerMessage(msg)) {
    await deliver(adapter, {
      address: msg.address,
      text: buildOwnerRequiredMessage(msg),
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }
  const matches = await extensions.searchExtensions(query);
  if (matches.length === 0) {
    await deliver(adapter, {
      address: msg.address,
      text: `没有找到可移除记录：${query}`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }
  if (matches.length > 1) {
    await deliver(adapter, {
      address: msg.address,
      text: renderExtensionSearchResults(query, matches),
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }
  const prepared = await extensions.prepareRemoveAction({ item: matches[0], actor: buildExtensionActor(msg) });
  if (!prepared.ok || !prepared.nonce) {
    await deliver(adapter, {
      address: msg.address,
      text: prepared.error || prepared.message || '扩展移除确认创建失败。',
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }
  const text = renderExtensionPrepareText('remove', prepared);
  await deliver(adapter, {
    address: msg.address,
    text,
    parseMode: 'plain',
    replyToMessageId: msg.messageId,
    feishuCardJson: buildExtensionActionCard('移除扩展记录确认', text, '移除记录', `extinstall:remove:${prepared.nonce}`, 'danger'),
  });
}

async function handleExtensionCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  args: string,
): Promise<string> {
  const { extensions } = getBridgeContext();
  if (!extensions) return '面板未在线或扩展安装能力不可用。';
  const [subcommandRaw, ...rest] = args.split(/\s+/);
  const subcommand = (subcommandRaw || 'search').toLowerCase();
  const query = rest.join(' ').trim();
  if (subcommand === 'search') {
    if (!query) return '用法：/ext search <关键词>';
    return renderExtensionSearchResults(query, await extensions.searchExtensions(query));
  }
  if (subcommand === 'install') {
    if (!query) return '用法：/ext install <关键词或https-url>';
    await prepareExtensionInstall(adapter, msg, query);
    return '';
  }
  if (subcommand === 'remove') {
    if (!query) return '用法：/ext remove <id或关键词>';
    await prepareExtensionRemove(adapter, msg, query);
    return '';
  }
  return '用法：/ext search|install|remove <关键词或URL>';
}

function recordConversationMemoryEvent(
  msg: InboundMessage,
  binding: ChannelBinding,
  role: 'user' | 'assistant',
  text: string,
): void {
  const { store } = getBridgeContext();
  if (typeof store.recordMemoryEvent !== 'function') return;
  const timestampMs = Number.isFinite(msg.timestamp)
    ? (msg.timestamp < 10_000_000_000 ? msg.timestamp * 1000 : msg.timestamp)
    : Date.now();
  const event: ConversationMemoryEvent = {
    sessionId: binding.codepilotSessionId,
    channelType: binding.channelType,
    chatId: binding.chatId,
    chatDisplayName: binding.displayName || msg.address.displayName || msg.address.chatId,
    userId: msg.address.userId,
    userDisplayName: msg.address.displayName,
    role,
    text,
    workingDirectory: binding.workingDirectory,
    createdAt: new Date(timestampMs).toISOString(),
  };
  try {
    store.recordMemoryEvent(event);
  } catch (error) {
    console.warn('[bridge-manager] Failed to record conversation memory event:', error instanceof Error ? error.message : error);
  }
}

function applyOutboundAnswerReview(input: AnswerReviewInput): string {
  const { store } = getBridgeContext();
  if (typeof store.reviewOutboundAnswer !== 'function') return input.answerText;
  try {
    const decision = store.reviewOutboundAnswer(input);
    if (decision.verdict === 'replace' && decision.replacementText?.trim()) {
      return decision.replacementText.trim();
    }
    if (
      decision.mode === 'block_or_replace'
      && decision.verdict === 'replace'
      && decision.replacementText?.trim()
    ) {
      return decision.replacementText.trim();
    }
    if (decision.mode === 'block_or_replace' && decision.verdict === 'block') {
      return decision.replacementText?.trim()
        || '这条回复未通过答案审查，已拦截。请换个说法重试，或让我重新按已检索到的记忆回答。';
    }
  } catch (error) {
    console.warn('[bridge-manager] Failed to review outbound answer:', error instanceof Error ? error.message : error);
  }
  return input.answerText;
}

function usableMemoryCandidates(candidates: MemoryWriteCandidate[] | undefined): MemoryWriteCandidate[] {
  return (candidates || [])
    .map((candidate) => ({
      ...candidate,
      key: candidate.key?.replace(/\s+/g, ' ').trim(),
      value: candidate.value?.replace(/\s+/g, ' ').trim(),
      text: candidate.text?.replace(/\s+/g, ' ').trim() || [candidate.key, candidate.value].filter(Boolean).join(' = '),
    }))
    .filter((candidate) => !!candidate.text && (!!candidate.value || !!candidate.key));
}

function formatMemoryWriteReply(ok: boolean, candidates: MemoryWriteCandidate[], error?: string): string {
  if (!ok) return `这条记忆没有写入成功：${error || '未知错误'}`;
  const pairs = candidates
    .filter((candidate) => candidate.key?.trim() && candidate.value?.trim())
    .slice(0, 6)
    .map((candidate) => `- ${candidate.key!.trim()}：${candidate.value!.trim()}`);
  if (pairs.length === 0) return '已记录到记忆仓库。';
  return ['已记录到记忆仓库：', '', ...pairs].join('\n');
}

function renderMemoryWriteProgress(steps: string[]): string {
  return [
    '### 思考路径',
    ...steps.map((step) => `- ${step}`),
  ].join('\n');
}

async function tryHandleModelPlannedMemoryWrite(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  binding: ChannelBinding,
  text: string,
  rawText: string,
): Promise<boolean> {
  if (!isExplicitMemoryWriteRequestText(text || rawText)) return false;

  const context = getBridgeContext();
  const { store } = context;
  const persistMemoryWrite = store.persistMemoryWrite?.bind(store);
  if (typeof persistMemoryWrite !== 'function') return false;

  const workingDirectory = binding.workingDirectory || store.getSession(binding.codepilotSessionId)?.working_directory || undefined;
  let decision: MemoryWriteIntentDecision | null = null;
  if (context.memoryIntents?.classifyMemoryWrite) {
    try {
      decision = await context.memoryIntents.classifyMemoryWrite({
        sessionId: binding.codepilotSessionId,
        channelType: binding.channelType,
        chatId: binding.chatId,
        userId: msg.address.userId,
        userDisplayName: msg.address.displayName,
        text: text || rawText,
        recentMessages: store.getMessages(binding.codepilotSessionId, { limit: 8 }).messages,
        workingDirectory,
      });
    } catch (error) {
      console.warn('[bridge-manager] Memory write intent classifier failed:', error instanceof Error ? error.message : error);
    }
  }

  if (decision && decision.action !== 'write') return false;

  const modelCandidates = decision?.action === 'write' && decision.confidence >= 0.55
    ? usableMemoryCandidates(decision.candidates)
    : [];
  const memoryWrite = persistMemoryWrite({
    sessionId: binding.codepilotSessionId,
    channelType: binding.channelType,
    chatId: binding.chatId,
    chatDisplayName: binding.displayName || msg.address.displayName || msg.address.chatId,
    userId: msg.address.userId,
    userDisplayName: msg.address.displayName,
    text: text || rawText,
    workingDirectory,
    candidates: modelCandidates.length > 0 ? modelCandidates : undefined,
  });
  if (memoryWrite.skipped) return false;

  const steps = [
    decision
      ? '已让模型判断这条消息属于记忆写入，并整理可保存的信息。'
      : '模型判定不可用，已使用保守结构化解析检查是否可以写入。',
    modelCandidates.length > 0
      ? `已整理 ${modelCandidates.length} 条候选记忆。`
      : '未拿到模型候选，使用原文中的结构化键值作为候选。',
    memoryWrite.ok
      ? '已写入可见记忆仓库并重建知识索引。'
      : '写入可见记忆仓库时失败，准备返回具体阻塞。',
  ];
  adapter.onMessageStart?.(msg.address.chatId);
  if (typeof adapter.onStreamText === 'function') {
    try { adapter.onStreamText(msg.address.chatId, renderMemoryWriteProgress(steps)); } catch { /* non-critical */ }
  }

  const reply = formatMemoryWriteReply(memoryWrite.ok, modelCandidates, memoryWrite.error);
  const reviewedText = applyOutboundAnswerReview({
    channelType: adapter.channelType,
    chatId: msg.address.chatId,
    userId: msg.address.userId,
    userDisplayName: msg.address.displayName,
    messageId: msg.messageId,
    sessionId: binding.codepilotSessionId,
    workingDirectory,
    userText: rawText,
    answerText: reply,
    source: 'system',
  });

  store.addMessage(binding.codepilotSessionId, 'user', text || rawText);
  store.addMessage(binding.codepilotSessionId, 'assistant', reviewedText);

  let cardFinalized = false;
  if (typeof adapter.onStreamEnd === 'function') {
    try {
      cardFinalized = await adapter.onStreamEnd(msg.address.chatId, memoryWrite.ok ? 'completed' : 'error', reviewedText);
    } catch (error) {
      console.warn('[bridge-manager] Memory write card finalize failed:', error instanceof Error ? error.message : error);
    }
  }
  if (!cardFinalized) {
    await deliverResponse(adapter, msg.address, reviewedText, binding.codepilotSessionId, msg.messageId, false, 'Markdown');
  }
  adapter.onMessageEnd?.(msg.address.chatId);
  return true;
}

function sanitizeOutsourcedToolReply(text: string, sourcePrompt = ''): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  if (!containsOutsourcedToolReply(trimmed)) return trimmed;
  if (isMemoryRecallRequestText(sourcePrompt)) return trimmed;
  if (!isToolExecutionRequestText(sourcePrompt) && !isToolExecutionRequestText(trimmed)) return trimmed;

  const lines = trimmed
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const blocker = lines.find((line) => /(未完成|失败|不可用|没有可用|无法执行|阻塞|报错|错误)/i.test(line));
  const domain = /unity|unitymcp|unity\s*mcp|hsscene|furniture_|prefab|timeline|场景|节点/i.test(`${sourcePrompt}\n${trimmed}`)
    ? 'Unity/MCP'
    : /blender/i.test(`${sourcePrompt}\n${trimmed}`)
      ? 'Blender/MCP'
      : '工具链';
  return [
    blocker || `未完成：这个请求需要实际 ${domain} 执行结果，本轮没有拿到可用工具输出。`,
    '已拦截通用手动排查步骤；这类请求必须由工具执行链完成，不能把任务退回给用户。',
  ].join('\n');
}

function sanitizeProgressCardDetail(text: string): string {
  const normalized = (text || '')
    .replace(/\r\n/g, '\n')
    .replace(/```cti-final[\s\S]*?```/gi, '')
    .replace(/^\s*#{1,6}\s*处理思路\s*$/gim, '')
    .replace(/^\s*#{1,6}\s*执行结果\s*$/gim, '')
    .trim();
  if (!normalized) return '';
  return normalized.length > 900 ? `${normalized.slice(0, 897)}...` : normalized;
}

function buildMemoryDecisionAgentPrompt(memoryDecision: MemoryReplyDecision): string {
  const plan = memoryDecision.plan;
  const query = plan.normalizedKey || plan.queryText || '';
  if (memoryDecision.type === 'direct_reply') {
    const hit = memoryDecision.hit;
    return [
      '本地记忆检索命中（作为 agent 上下文，不是最终回复）：',
      query ? `- 用户记忆查询：${query}` : '',
      '- 命中内容：',
      memoryDecision.text,
      hit.content?.trim() ? `- 原始片段：\n${hit.content.trim()}` : '',
      '',
      '回复要求：',
      '- 必须由 agent 按当前回复风格整理最终答复，不要把这段上下文原样当作快捷回复。',
      '- 根据用户实际询问意图回答：如果用户问所有、全部、完整列表或对应表，列出命中的全部结构化项；如果用户只问单个名称，再只回答匹配项。',
      '- 保留记忆里的原始键和值；不要补充记忆中没有的条目。',
      '- 如果证据不足，明确说明未找到可靠记忆，不要编造。',
    ].filter(Boolean).join('\n');
  }
  if (memoryDecision.type === 'no_memory_answer') {
    return [
      '本地记忆检索结果（作为 agent 上下文，不是最终回复）：',
      query ? `- 用户记忆查询：${query}` : '',
      `- 检索结论：${memoryDecision.text}`,
      '',
      '回复要求：',
      '- 必须由 agent 整理最终答复。',
      '- 根据用户实际询问意图回答，不能因为某个关键词命中就只答一个无关条目。',
      '- 如果没有可靠记忆命中，直接说明没找到，不要编造。',
    ].filter(Boolean).join('\n');
  }
  return memoryDecision.systemPrompt || '';
}

type ReplySurfaceMode = 'workflow_card' | 'light_status' | 'direct_reply';

interface ReplySurfaceModeInput {
  supportsStreamingCards: boolean;
  feishuDocRequest: boolean;
  messageKind?: string;
  hasMemoryProgress: boolean;
  textLength: number;
}

function selectReplySurfaceMode(input: ReplySurfaceModeInput): ReplySurfaceMode {
  if (isFeishuStickerMessageKind(input.messageKind)) {
    return input.supportsStreamingCards ? 'light_status' : 'direct_reply';
  }
  if (input.feishuDocRequest || input.hasMemoryProgress) {
    return input.supportsStreamingCards ? 'workflow_card' : 'direct_reply';
  }
  if (!input.supportsStreamingCards) return 'direct_reply';
  return input.textLength <= 280 ? 'light_status' : 'direct_reply';
}

function getInboundMessageKind(msg: InboundMessage, rawData: Record<string, any> | null | undefined): string | undefined {
  const direct = typeof msg.messageKind === 'string' ? msg.messageKind : '';
  if (direct) return direct;
  const rawKind = typeof rawData?.messageKind === 'string' ? rawData.messageKind : '';
  if (rawKind) return rawKind;
  const stickerKnown = rawData?.sticker?.known;
  if (stickerKnown === true) return 'feishu_sticker_known';
  if (stickerKnown === false) return 'feishu_sticker_unknown';
  return undefined;
}

function shouldAttachRecentConversationMedia(text: string): boolean {
  const normalized = text.normalize('NFKC').trim().toLowerCase();
  if (!normalized) return false;
  const hasMediaReference = /(这|那|上|刚|前|原|题目|图|图片|照片|截图|画面|表情包|附件|它|这个|那个|上一[张个条]|刚才|前面|上面|原图|题图|题目图|the|this|that|above|previous|last|image|picture|photo|screenshot|attachment)/iu.test(normalized);
  const hasFollowUpAction = /(继续|分析|看|读|识别|解|算|讲|说明|判断|推理|一步|步骤|思路|按|根据|基于|照着|再来|接着|continue|analy[sz]e|solve|explain|read|identify|based on|use)/iu.test(normalized);
  if (hasMediaReference && hasFollowUpAction) return true;
  return normalized.length <= 40
    && /(继续|接着|再来|一步一步|思路|怎么解|帮我看|看一下|分析一下|讲一下|这题|这个呢|它呢|what about this|continue)/iu.test(normalized);
}

function parseStoredFileAttachments(content: string): Array<{ id?: string; name?: string; type?: string; size?: number; filePath?: string }> {
  const match = content.match(/^<!--files:([\s\S]*?)-->/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadRecentConversationImageAttachments(
  messages: Array<{ role: string; content: string }>,
  limit = 1,
): FileAttachment[] {
  const files: FileAttachment[] = [];
  const seen = new Set<string>();
  for (let index = messages.length - 1; index >= 0 && files.length < limit; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    for (const item of parseStoredFileAttachments(message.content).reverse()) {
      if (files.length >= limit) break;
      const filePath = typeof item.filePath === 'string' ? item.filePath : '';
      const type = typeof item.type === 'string' ? item.type : '';
      if (!filePath || !type.toLowerCase().startsWith('image/')) continue;
      const resolved = path.resolve(filePath);
      if (seen.has(resolved) || !fs.existsSync(resolved)) continue;
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size <= 0 || stat.size > FEISHU_FILE_UPLOAD_LIMIT_BYTES) continue;
      files.push({
        id: typeof item.id === 'string' && item.id ? item.id : path.basename(resolved),
        name: typeof item.name === 'string' && item.name ? item.name : path.basename(resolved),
        type,
        size: stat.size,
        data: fs.readFileSync(resolved).toString('base64'),
        filePath: resolved,
      });
      seen.add(resolved);
    }
  }
  return files;
}

function buildStickerChatPrompt(rawText: string, hasVisualReference: boolean): string {
  const text = rawText.trim();
  return [
    text || '用户发送了一个飞书表情包。',
    '',
    '这是一条轻量聊天消息。请把表情包当作聊天语气信号来理解，再像普通聊天一样简短自然地回应。',
    hasVisualReference
      ? '可以根据表情包画面判断情绪、态度或玩笑语气，但最终回复要直接接话，不要写成“图片里是……”的说明报告。'
      : '如果没有可用图片或已学习语义，只能根据上下文轻量回应，不要凭 file_key 猜具体图案。',
    '只有用户明确要求解释表情包时，才展开说明图案、文字或含义。',
  ].join('\n');
}

function buildImageOnlyIntentPrompt(): string {
  return [
    'The user sent one or more images without a written instruction.',
    'Treat the image as a message carrier in the conversation, not as an object to describe by default.',
    'Infer the user\'s communicative intent and the likely action they expect from the image content plus chat context, then respond to that intent.',
    'Do not merely describe, caption, or OCR the image unless the user explicitly asks for description or transcription.',
    'If the intended action is genuinely ambiguous, ask one concise clarification question.',
  ].join('\n');
}

function buildAdapterAssistantIdentityPrompt(adapter: BaseChannelAdapter, address?: { chatId?: string; userId?: string }): string {
  const identity = adapter.getAssistantIdentity?.();
  const displayName = identity?.displayName?.trim();
  const emojiPrompt = adapter.getEmojiPresentationPrompt?.(address?.chatId, address?.userId);
  const stickerPrompt = adapter.getStickerPresentationPrompt?.(address?.chatId, address?.userId);
  const lines = [
    'Channel assistant identity:',
    displayName
      ? `- Your user-facing name in this channel is "${displayName}".`
      : '- Use the platform bot/app display name as your user-facing name if it is known from channel context.',
    identity?.platform ? `- Current platform: ${identity.platform}.` : `- Current platform: ${adapter.channelType}.`,
    displayName
      ? `- If the user asks who you are, asks for a self-introduction, or asks your name, answer that you are "${displayName}" in this chat. Do not replace that name with "Codex".`
      : '- If the user asks who you are, asks for a self-introduction, or asks your name, introduce yourself using the channel bot/app display name first when available. Do not lead with "Codex" as your name.',
    '- Mention Codex only when the user specifically asks about the underlying engine, implementation, or execution backend.',
    '- For light chat, confirmations, greetings, and sticker reactions on Feishu, you may start the final reply with a native reaction hint or sticker hint only when it matches the actual intent and improves the chat tone. Use `[表情包:alias]` only with aliases listed in the Feishu sticker library prompt; use bare `[表情包]` only when the user asks for any sticker or a different sticker and no listed alias fits. Choose reaction hints by actual intent; do not default to SMILE, and use no hint when none fits.',
    '- Do not put reaction or sticker hints on formal tool results, blockers, file paths, command output, or safety-sensitive replies.',
    emojiPrompt,
    stickerPrompt,
  ];
  return lines.filter((line): line is string => Boolean(line)).join('\n');
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const mib = bytes / (1024 * 1024);
  return `${mib.toFixed(mib >= 10 ? 1 : 2)} MB`;
}

function getArtifactDeliveryConfig(): ArtifactDeliveryConfig {
  const { store } = getBridgeContext();
  const modeRaw = (store.getSetting('bridge_artifact_upload_mode') || process.env.CTI_ARTIFACT_UPLOAD_MODE || 'none').trim().toLowerCase();
  const mode: ArtifactUploadMode = modeRaw === 'local_http'
    ? 'local_http'
    : (modeRaw === 'feishu_docx' || modeRaw === 'feishu_drive')
      ? 'feishu_docx'
      : 'none';
  const publicBaseUrl = (store.getSetting('bridge_artifact_public_base_url') || process.env.CTI_ARTIFACT_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  const publicDir = (store.getSetting('bridge_artifact_public_dir') || process.env.CTI_ARTIFACT_PUBLIC_DIR || '').trim();
  const publicSubdir = (store.getSetting('bridge_artifact_public_subdir') || process.env.CTI_ARTIFACT_PUBLIC_SUBDIR || 'bridge-artifacts').trim().replace(/^[/\\]+|[/\\]+$/g, '') || 'bridge-artifacts';
  return { mode, publicBaseUrl, publicDir, publicSubdir };
}

function joinArtifactUrl(baseUrl: string, relativePath: string): string {
  const encoded = relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${baseUrl}/${encoded}`;
}

function needsArtifactLinkDelivery(adapter: BaseChannelAdapter, filePath: string, sendError = ''): boolean {
  if (adapter.channelType === 'feishu') {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile() && stat.size > FEISHU_FILE_UPLOAD_LIMIT_BYTES) return true;
    } catch {
      // ignore
    }
  }
  return /exceeds .*upload limit|upload limit/i.test(sendError);
}

function uploadLocalArtifact(filePath: string): UploadedArtifactRecord {
  const config = getArtifactDeliveryConfig();
  if (config.mode !== 'local_http') {
    throw new Error('未配置可用的大文件上传服务。请设置 CTI_ARTIFACT_UPLOAD_MODE=local_http 或 feishu_docx。');
  }
  if (!config.publicBaseUrl) {
    throw new Error('缺少 CTI_ARTIFACT_PUBLIC_BASE_URL。');
  }
  if (!config.publicDir) {
    throw new Error('缺少 CTI_ARTIFACT_PUBLIC_DIR。');
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`不是文件：${filePath}`);
  const now = new Date();
  const dateDir = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const safeName = path.basename(filePath).replace(/[^a-zA-Z0-9._-]+/g, '-');
  const uniqueName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`;
  const relativePath = path.posix.join(config.publicSubdir.replace(/\\/g, '/'), dateDir, uniqueName);
  const targetPath = path.join(config.publicDir, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(filePath, targetPath);
  return {
    fileName: path.basename(filePath),
    sourcePath: filePath,
    publicPath: targetPath,
    url: joinArtifactUrl(config.publicBaseUrl, relativePath),
    sizeBytes: stat.size,
  };
}

function formatArtifactLinkNotice(uploaded: UploadedArtifactRecord): string {
  return [
    `${uploaded.fileName} 超过飞书单文件 30MB 限制，已改为下载链接。`,
    `大小：${formatBytes(uploaded.sizeBytes)}`,
    `下载：${uploaded.url}`,
    `本机文件：${uploaded.sourcePath}`,
  ].join('\n');
}

function formatPlatformFileLinkNotice(link: UploadedFileLink, filePath: string): string {
  return [
    `${link.title} 超过飞书单文件 30MB 限制，已改为飞书云文档附件交付。`,
    `文档：${link.url}`,
    ...(link.platform ? [`来源：${link.platform}`] : []),
    `本机文件：${filePath}`,
  ].join('\n');
}

type FinalReplyKind = 'text' | 'image' | 'file' | 'mixed';
type FinalReplyMode = 'plain' | 'markdown' | 'html';

interface FinalReplyEnvelope {
  kind: FinalReplyKind;
  text: string;
  images: string[];
  files: string[];
  reply_mode: FinalReplyMode;
  mentions?: OutboundMention[];
  reply_to?: string;
}

interface FinalEnvelopeStatusRecord {
  parsed: boolean;
  kind?: FinalReplyKind | null;
  usedRawFallback: boolean;
  usedLegacyCompactor: boolean;
  updatedAt: string;
}

interface PreparedBridgeReplyPayload {
  text: string;
  parseMode: 'plain' | 'Markdown' | 'HTML';
  images: string[];
  files: string[];
  mentions?: OutboundMention[];
  replyTo?: string;
}

type ExecutionEvidence = NonNullable<engine.ConversationResult['executionEvidence']>;

interface PendingSystemAction {
  type: 'shutdown';
  chatId: string;
  channelType: string;
  userId: string;
  sourceMessageId: string;
  requestedAt: number;
  expiresAt: number;
}

type PermissionRole = 'viewer' | 'operator' | 'owner';

interface PermissionSubject {
  channelType?: string;
  userId?: string;
  role?: string;
}

function parseReplyMode(mode: string | undefined | null): 'plain' | 'Markdown' | 'HTML' {
  switch ((mode || 'plain').trim().toLowerCase()) {
    case 'markdown':
      return 'Markdown';
    case 'html':
      return 'HTML';
    default:
      return 'plain';
  }
}

function getPendingSystemActions(): Map<string, PendingSystemAction> {
  const globalState = globalThis as Record<string, unknown>;
  if (!globalState[PENDING_SYSTEM_ACTIONS_KEY]) {
    globalState[PENDING_SYSTEM_ACTIONS_KEY] = new Map<string, PendingSystemAction>();
  }
  return globalState[PENDING_SYSTEM_ACTIONS_KEY] as Map<string, PendingSystemAction>;
}

function makeSystemActionKey(channelType: string, chatId: string, userId: string): string {
  return `${channelType}:${chatId}:${userId}`;
}

function writeFinalEnvelopeStatus(status: FinalEnvelopeStatusRecord): void {
  try {
    fs.mkdirSync(path.dirname(FINAL_ENVELOPE_STATUS_PATH), { recursive: true });
    fs.writeFileSync(FINAL_ENVELOPE_STATUS_PATH, JSON.stringify(status, null, 2), 'utf8');
  } catch {
    // best effort
  }
}

function extractVisibleAssistantText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  const blockPattern = /\[\{"type":"text","text":"([\s\S]*?)"}(?:,[\s\S]*?)?\]/g;
  const matches = Array.from(normalized.matchAll(blockPattern));
  if (matches.length > 0) {
    const last = matches[matches.length - 1]?.[1] || '';
    return last
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .trim();
  }
  return normalized;
}

function parseEnvelopeObject(candidate: unknown): FinalReplyEnvelope | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const raw = candidate as Record<string, unknown>;
  const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() as FinalReplyKind : null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  const images = Array.isArray(raw.images) ? raw.images.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  const files = Array.isArray(raw.files) ? raw.files.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
  const replyMode = typeof raw.reply_mode === 'string' ? raw.reply_mode.trim().toLowerCase() as FinalReplyMode : null;
  if (!kind || !['text', 'image', 'file', 'mixed'].includes(kind)) return null;
  if (!replyMode || !['plain', 'markdown', 'html'].includes(replyMode)) return null;
  if (!text.trim() && images.length === 0 && files.length === 0) return null;
  return {
    kind,
    text,
    images,
    files,
    reply_mode: replyMode,
    mentions: Array.isArray(raw.mentions) ? raw.mentions as OutboundMention[] : undefined,
    reply_to: typeof raw.reply_to === 'string' && raw.reply_to.trim() ? raw.reply_to.trim() : undefined,
  };
}

function extractFinalReplyEnvelope(text: string): FinalReplyEnvelope | null {
  const fencePattern = new RegExp(String.raw`(?:^|\n)\`\`\`${FINAL_REPLY_FENCE}\s*\n([\s\S]*?)\n\`\`\``, 'g');
  let lastMatch: RegExpExecArray | null = null;
  for (const match of text.matchAll(fencePattern)) {
    lastMatch = match;
  }
  if (lastMatch) {
    try {
      return parseEnvelopeObject(JSON.parse(lastMatch[1].trim()));
    } catch {
      // continue to raw JSON fallback
    }
  }
  const rawJsonPattern = /(\{[\s\S]*?"kind"\s*:\s*"(?:text|image|file|mixed)"[\s\S]*?"reply_mode"\s*:\s*"(?:plain|markdown|html)"[\s\S]*?\})/g;
  let rawJsonMatch: RegExpExecArray | null = null;
  for (const match of text.matchAll(rawJsonPattern)) {
    rawJsonMatch = match;
  }
  if (!rawJsonMatch) return null;
  try {
    return parseEnvelopeObject(JSON.parse(rawJsonMatch[1].trim()));
  } catch {
    return null;
  }
}

function stripFinalReplyProtocolArtifacts(text: string): string {
  return text
    .replace(new RegExp(String.raw`(?:^|\n)\s*\`\`\`${FINAL_REPLY_FENCE}\s*\n[\s\S]*?\n\s*\`\`\``, 'gi'), '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function resolveExplicitPaths(
  items: string[],
  workingDirectory: string,
  additionalDirectories: string[] = [],
): string[] {
  const resolved = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (path.isAbsolute(trimmed)) {
      resolved.add(trimmed);
      continue;
    }
    if (workingDirectory) {
      resolved.add(path.resolve(workingDirectory, trimmed));
    }
    for (const dir of additionalDirectories) {
      if (dir) resolved.add(path.resolve(dir, trimmed));
    }
  }
  return Array.from(resolved);
}

const CONCRETE_EXECUTION_REQUEST_RE = /(ignis|unity|blender|mcp|截图|图片|图像|关机|关闭电脑|shutdown|文件|文档|txt|\.txt|\.md|\.json|(?:看一眼|看一下|看看|查看|查一下|查询|列出|列一下|有哪些|有什么|读取|打开|搜索).{0,32}(本地|工作目录|目录|文件夹|文件|项目|仓库|路径|Game|Assets)|(?:生成|创建|新建|写入|保存|删除|移动|复制|上传|下载|导入|导出|安装|启动|停止|重启|运行|执行).{0,32}(文件|文档|图片|图像|截图|txt|项目|服务|bridge|mcp|命令|脚本|本机|电脑|工作区))/i;
const POSITIVE_EXECUTION_CLAIM_RE = /(已|已经|成功|完成|生成|创建|新建|写入|保存|上传|下载|导入|导出|安装|启动|停止|重启|执行|正在执行|已提交).{0,48}(文件|文档|图片|图像|截图|命令|脚本|操作|任务|请求|shutdown|关机|本地|工作区|路径|生成|创建|写入|保存|执行|完成|成功)/i;
const NEGATIVE_EXECUTION_RESULT_RE = /(未完成|失败|无法|不能|没有|未能|不可用|阻塞|报错|错误|找不到|不存在|未执行|已拦截)/i;

function requiresExecutionEvidenceForReply(userText: string, answerText: string): boolean {
  const combined = `${userText}\n${answerText}`;
  if (isMemoryRecallRequestText(userText)) return false;
  if (!CONCRETE_EXECUTION_REQUEST_RE.test(userText) && !isToolExecutionRequestText(userText)) return false;
  if (NEGATIVE_EXECUTION_RESULT_RE.test(answerText)) return false;
  return POSITIVE_EXECUTION_CLAIM_RE.test(combined);
}

function existingLocalFile(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function formatPathList(paths: string[], limit = 4): string {
  const listed = paths.slice(0, limit).map((item) => `- ${item}`);
  if (paths.length > limit) listed.push(`- 另外 ${paths.length - limit} 个路径`);
  return listed.join('\n');
}

function buildNoExecutionEvidenceReply(reason: string, evidence: ExecutionEvidence): string {
  const details = [
    `未完成：${reason}`,
    '我已拦截这条可能的假完成回复，没有把它当成真实结果发送。',
    `本轮工具证据：tool_use=${evidence.toolUseCount}，tool_result=${evidence.toolResultCount}，成功结果=${evidence.successfulToolResultCount}。`,
  ];
  if (evidence.toolNames.length > 0) {
    details.push(`工具：${evidence.toolNames.slice(0, 6).join('、')}`);
  }
  if (evidence.failedToolErrors?.length) {
    details.push(`失败原因：${evidence.failedToolErrors.slice(0, 3).join('；')}`);
  }
  return appendReplyEndMarker(details.join('\n'));
}

function verifyPreparedReplyExecution(
  payload: PreparedBridgeReplyPayload,
  context: {
    userText: string;
    executionEvidence: ExecutionEvidence;
    executionRequirement: ExecutionRequirement;
    messageKind?: string;
  },
): PreparedBridgeReplyPayload {
  const missingImages = payload.images.filter((item) => !existingLocalFile(item));
  const missingFiles = payload.files.filter((item) => !existingLocalFile(item));
  if (missingImages.length > 0 || missingFiles.length > 0) {
    const missing = [...missingImages, ...missingFiles];
    return {
      ...payload,
      text: buildNoExecutionEvidenceReply(`模型声称有本地产物，但这些路径不存在：\n${formatPathList(missing)}`, context.executionEvidence),
      parseMode: 'plain',
      images: payload.images.filter((item) => !missingImages.includes(item)),
      files: payload.files.filter((item) => !missingFiles.includes(item)),
    };
  }

  if (
    context.executionEvidence.requiredEvidenceKind
    && context.executionEvidence.requiredEvidenceKind !== 'none'
    && context.executionEvidence.evidenceSatisfied === false
    && !NEGATIVE_EXECUTION_RESULT_RE.test(payload.text)
  ) {
    return {
      ...payload,
      text: buildNoExecutionEvidenceReply('模型回答了需要本地工具证据的任务，但本轮没有检测到真实工具执行成功记录。', context.executionEvidence),
      parseMode: 'plain',
      images: [],
      files: [],
    };
  }

  if (
    !isFeishuStickerMessageKind(context.messageKind)
    && requiresExecutionEvidenceForReply(context.userText, payload.text)
    && context.executionEvidence.successfulToolResultCount <= 0
  ) {
    return {
      ...payload,
      text: buildNoExecutionEvidenceReply('模型声称已经执行或创建了结果，但本轮没有检测到真实工具执行成功记录。', context.executionEvidence),
      parseMode: 'plain',
      images: [],
      files: [],
    };
  }

  return payload;
}

async function prepareBridgeReplyPayload(
  text: string,
  workingDirectory: string,
  additionalDirectories: string[] = [],
  sourcePrompt = '',
): Promise<PreparedBridgeReplyPayload> {
  const envelope = extractFinalReplyEnvelope(text);
  if (envelope) {
    writeFinalEnvelopeStatus({
      parsed: true,
      kind: envelope.kind,
      usedRawFallback: false,
      usedLegacyCompactor: false,
      updatedAt: new Date().toISOString(),
    });
    return {
      text: appendReplyEndMarker(sanitizeOutsourcedToolReply(envelope.text || '', sourcePrompt)),
      parseMode: parseReplyMode(envelope.reply_mode),
      images: resolveExplicitPaths(envelope.images, workingDirectory, additionalDirectories),
      files: resolveExplicitPaths(envelope.files, workingDirectory, additionalDirectories),
      mentions: envelope.mentions,
      replyTo: envelope.reply_to,
    };
  }

  const visible = extractVisibleAssistantText(text);
  const visibleEnvelope = visible ? extractFinalReplyEnvelope(visible) : null;
  if (visibleEnvelope) {
    writeFinalEnvelopeStatus({
      parsed: true,
      kind: visibleEnvelope.kind,
      usedRawFallback: false,
      usedLegacyCompactor: false,
      updatedAt: new Date().toISOString(),
    });
    return {
      text: appendReplyEndMarker(sanitizeOutsourcedToolReply(visibleEnvelope.text || '', sourcePrompt)),
      parseMode: parseReplyMode(visibleEnvelope.reply_mode),
      images: resolveExplicitPaths(visibleEnvelope.images, workingDirectory, additionalDirectories),
      files: resolveExplicitPaths(visibleEnvelope.files, workingDirectory, additionalDirectories),
      mentions: visibleEnvelope.mentions,
      replyTo: visibleEnvelope.reply_to,
    };
  }
  const safeVisible = visible ? stripFinalReplyProtocolArtifacts(visible) : '';
  if (safeVisible) {
    writeFinalEnvelopeStatus({
      parsed: false,
      kind: null,
      usedRawFallback: true,
      usedLegacyCompactor: false,
      updatedAt: new Date().toISOString(),
    });
    return {
      text: appendReplyEndMarker(sanitizeOutsourcedToolReply(safeVisible, sourcePrompt)),
      parseMode: 'plain',
      images: [],
      files: [],
    };
  }

  const compacted = compactBridgeReplyForDelivery(stripFinalReplyProtocolArtifacts(text) || text);
  writeFinalEnvelopeStatus({
    parsed: false,
    kind: null,
    usedRawFallback: false,
    usedLegacyCompactor: true,
    updatedAt: new Date().toISOString(),
  });
  return {
    text: appendReplyEndMarker(sanitizeOutsourcedToolReply(compacted, sourcePrompt)),
    parseMode: 'plain',
    images: [],
    files: [],
  };
}

function isProcessNarrationLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) return false;
  return /^(我先|我会|我正在|我继续|我再|我开始|我已经找到|我确认到|下一步|接下来|现在我|当前我|先看|先查|我改用|我准备|我补查|我切到|我定位到|启动尝试|直连服务|刚确认|刚才|随后|Then |Next )/i.test(normalized);
}

function isOutcomeLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) return false;
  return /(已完成|已处理|已修复|已生成|已同步|已发送|已重启|已更新|运行中|成功|失败|报错|错误|文件在|图片在|文档在|链接|PID|channel|当前状态|结论|原因|结果|可用|不可用|命中|同步完成|请直接|你现在可以)/i.test(normalized);
}

function compactBridgeReplyForDelivery(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  const normalized = trimmed.replace(/\r\n/g, '\n');
  const blocks = normalized.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);

  const strongBlocks = blocks.filter((block) => isOutcomeLine(block) && !isProcessNarrationLine(block));
  if (strongBlocks.length > 0) {
    const compact = strongBlocks.slice(-3).join('\n\n').trim();
    return compact.length > 420 ? `${compact.slice(0, 417)}...` : compact;
  }

  const strongLines = lines.filter((line) => isOutcomeLine(line) && !isProcessNarrationLine(line));
  if (strongLines.length > 0) {
    const compact = strongLines.slice(-4).join('\n').trim();
    return compact.length > 420 ? `${compact.slice(0, 417)}...` : compact;
  }

  if (blocks.length >= 3 || lines.length >= 8) {
    const filtered = lines.filter((line) => !isProcessNarrationLine(line));
    const compact = (filtered.length > 0 ? filtered.slice(-4) : lines.slice(-3)).join('\n').trim();
    return compact.length > 420 ? `${compact.slice(0, 417)}...` : compact;
  }

  return trimmed.length > 420 ? `${trimmed.slice(0, 417)}...` : trimmed;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};

const PROGRESS_PULSE_DEFAULTS: ProgressPulseConfig = {
  enabled: false,
  intervalMs: 60000,
};

const UNITY_MCP_DEFAULT_ENDPOINTS = [
  'http://127.0.0.1:8081/mcp',
  'http://127.0.0.1:8080/mcp',
  'http://127.0.0.1:8080',
];

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

function getProgressPulseConfig(): ProgressPulseConfig {
  const { store } = getBridgeContext();
  const enabledRaw = (store.getSetting('bridge_progress_updates_enabled') || '').trim().toLowerCase();
  const enabled = enabledRaw
    ? enabledRaw === '1' || enabledRaw === 'true' || enabledRaw === 'yes' || enabledRaw === 'on'
    : PROGRESS_PULSE_DEFAULTS.enabled;

  const intervalCandidate = parseInt(store.getSetting('bridge_progress_update_interval_ms') || '', 10);
  const intervalMs = Number.isFinite(intervalCandidate) && intervalCandidate >= 8000
    ? intervalCandidate
    : PROGRESS_PULSE_DEFAULTS.intervalMs;

  return { enabled, intervalMs };
}

function parseEndpointList(raw: string | null | undefined): string[] {
  if (!raw) return [...UNITY_MCP_DEFAULT_ENDPOINTS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[,\n;|]/)) {
    const value = token.trim();
    if (!value) continue;
    if (!/^https?:\/\//i.test(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.length > 0 ? out : [...UNITY_MCP_DEFAULT_ENDPOINTS];
}

function getUnityMcpHealthConfig(): UnityMcpHealthConfig {
  const { store } = getBridgeContext();
  const endpointRaw = store.getSetting('bridge_unity_mcp_endpoint_list') || process.env.CTI_UNITY_MCP_ENDPOINTS || '';
  const startCommand = (store.getSetting('bridge_unity_mcp_start_command') || process.env.CTI_UNITY_MCP_START_COMMAND || '').trim();
  const probeTimeoutCandidate = parseInt(store.getSetting('bridge_unity_mcp_probe_timeout_ms') || '', 10);
  const startTimeoutCandidate = parseInt(store.getSetting('bridge_unity_mcp_start_timeout_ms') || '', 10);
  const retryCountCandidate = parseInt(store.getSetting('bridge_unity_mcp_retry_count') || '', 10);
  return {
    endpoints: parseEndpointList(endpointRaw),
    startCommand,
    probeTimeoutMs: Number.isFinite(probeTimeoutCandidate) && probeTimeoutCandidate >= 800 ? probeTimeoutCandidate : 2500,
    startTimeoutMs: Number.isFinite(startTimeoutCandidate) && startTimeoutCandidate >= 5000 ? startTimeoutCandidate : 40000,
    retryCount: Number.isFinite(retryCountCandidate) && retryCountCandidate >= 1 ? Math.min(retryCountCandidate, 6) : 3,
  };
}

async function probeUnityMcpEndpoint(endpoint: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
    });
    return { ok: true, detail: `${endpoint} -> HTTP ${response.status}` };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `${endpoint} -> ${errorMessage}` };
  } finally {
    clearTimeout(timer);
  }
}

async function executeUnityMcpStartCommand(
  command: string,
  workingDirectory: string,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const { store } = getBridgeContext();
  const cwd = workingDirectory && fs.existsSync(workingDirectory) ? workingDirectory : process.cwd();
  const runEnv = {
    ...process.env,
    CTI_DEFAULT_WORKDIR: store.getSetting('bridge_default_work_dir') || process.env.CTI_DEFAULT_WORKDIR || cwd,
    CTI_UNITY_PROJECT_PATH: store.getSetting('bridge_unity_project_path') || process.env.CTI_UNITY_PROJECT_PATH || path.join(cwd, 'Game'),
  };
  try {
    const run = process.platform === 'win32'
      ? await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        cwd,
        env: runEnv,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 4,
      })
      : await execFileAsync('sh', ['-lc', command], {
        cwd,
        env: runEnv,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 4,
      });
    const output = [run.stdout?.trim(), run.stderr?.trim()].filter(Boolean).join('\n');
    const shortOutput = output.length > 400 ? `${output.slice(0, 397)}...` : output;
    return { ok: true, detail: shortOutput ? `start command ok: ${shortOutput}` : 'start command ok' };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = [err.stdout?.trim(), err.stderr?.trim(), err.message?.trim()].filter(Boolean).join('\n');
    const shortOutput = output.length > 400 ? `${output.slice(0, 397)}...` : output;
    return { ok: false, detail: shortOutput || 'start command failed' };
  }
}

async function ensureUnityMcpReady(workingDirectory: string): Promise<{ ok: boolean; summary: string }> {
  const config = getUnityMcpHealthConfig();
  const lines: string[] = [];
  const retryEndpoints = [...config.endpoints];

  for (const endpoint of config.endpoints) {
    const probe = await probeUnityMcpEndpoint(endpoint, config.probeTimeoutMs);
    lines.push(`probe: ${probe.detail}`);
    if (probe.ok) {
      return { ok: true, summary: lines.join('\n') };
    }
  }

  if (!config.startCommand) {
    lines.push('start: skipped (bridge_unity_mcp_start_command 未配置)');
    return { ok: false, summary: lines.join('\n') };
  }

  const startResult = await executeUnityMcpStartCommand(config.startCommand, workingDirectory, config.startTimeoutMs);
  lines.push(`start: ${startResult.detail}`);
  const discoveredFromStart = Array.from(startResult.detail.matchAll(/https?:\/\/[^\s)]+/ig)).map((match) => match[0]);
  for (const endpoint of discoveredFromStart) {
    if (!retryEndpoints.some((item) => item.toLowerCase() === endpoint.toLowerCase())) {
      retryEndpoints.push(endpoint);
    }
  }
  if (startResult.ok && /mcp_ready/i.test(startResult.detail)) {
    return { ok: true, summary: lines.join('\n') };
  }

  for (let attempt = 1; attempt <= config.retryCount; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1600));
    for (const endpoint of retryEndpoints) {
      const probe = await probeUnityMcpEndpoint(endpoint, config.probeTimeoutMs);
      lines.push(`retry#${attempt}: ${probe.detail}`);
      if (probe.ok) {
        return { ok: true, summary: lines.join('\n') };
      }
    }
  }

  return { ok: false, summary: lines.join('\n') };
}

/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * feishu/qq channels WITH at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean {
  if (channelType !== 'feishu' && channelType !== 'qq' && channelType !== 'weixin') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0; // any pending → route to inline path
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

// ── Channel-aware rendering dispatch ──────────────────────────

import type { ChannelAddress, SendResult } from './types.js';

/**
 * Render response text and deliver via the appropriate channel format.
 * Telegram: Markdown → HTML chunks via deliverRendered.
 * Other channels: plain text via deliver (no HTML).
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
  alreadyPrepared = false,
  parseModeOverride?: 'plain' | 'Markdown' | 'HTML',
  mentions?: OutboundMention[],
): Promise<SendResult> {
  const prepared = alreadyPrepared
    ? {
      text: responseText,
      parseMode: parseModeOverride || 'plain',
      mentions,
    }
    : {
      text: appendReplyEndMarker(compactBridgeReplyForDelivery(responseText)),
      parseMode: parseModeOverride || 'plain',
      mentions,
    };
  const finalText = prepared.text;
  if (adapter.channelType === 'telegram') {
    const chunks = markdownToTelegramChunks(finalText, 4096);
    if (chunks.length > 0) {
      return deliverRendered(adapter, address, chunks, { sessionId, replyToMessageId });
    }
    return { ok: true };
  }
  if (adapter.channelType === 'discord') {
    // Discord: native markdown, chunk at 2000 chars with fence repair
    const chunks = markdownToDiscordChunks(finalText, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: chunks[i].text,
        parseMode: prepared.parseMode === 'HTML' ? 'Markdown' : prepared.parseMode,
        replyToMessageId,
        mentions: prepared.mentions,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (adapter.channelType === 'feishu') {
    // Feishu: pass markdown through for adapter to format as post/card
    return deliver(adapter, {
      address,
      text: finalText,
      parseMode: prepared.parseMode === 'plain' ? 'Markdown' : prepared.parseMode,
      replyToMessageId,
      mentions: prepared.mentions,
    }, { sessionId });
  }
  // Generic fallback: deliver as plain text (deliver() handles chunking internally)
  return deliver(adapter, {
    address,
    text: finalText,
    parseMode: prepared.parseMode,
    replyToMessageId,
    mentions: prepared.mentions,
  }, { sessionId });
}

interface DirectCommandRequest {
  command: string;
  args: string[];
  display: string;
  mutating: boolean;
}

interface DirectCommandResult {
  ok: boolean;
  text: string;
}

interface ProgressPulseController {
  stop: () => void;
}

function buildProgressMessage(step: 'started' | 'running'): string {
  if (step === 'started') {
    return '已收到，正在处理这条请求。我会分阶段回报进度。';
  }
  return '仍在处理中：正在执行当前步骤，完成后会继续同步结果。';
}

function buildProgressMessageForBridge(step: 'started' | 'running'): string {
  if (step === 'started') {
    return '已收到，开始执行。后续只发送有实际结果的阶段进度。';
  }
  return '仍在执行，但还没有新的可汇报结果。';
}

const providerErrorCircuit = new Map<string, { count: number; firstAt: number }>();
const PROVIDER_ERROR_CIRCUIT_WINDOW_MS = 60_000;
const PROVIDER_ERROR_CIRCUIT_MAX_NOTICES = 3;

function looksLikeInternalProviderPayload(raw: string): boolean {
  const text = raw || '';
  if (!text.trim()) return false;
  if (/^\s*data:\s*\{/.test(text) && /"type"\s*:\s*"(tool_result|tool_use|status|result)"/.test(text)) return true;
  if (/"tool_use_id"\s*:/.test(text) || /\btool_result\b/.test(text) || /\btool_use\b/.test(text)) return true;
  if (/[A-Z]:\\Users\\|\.claude-to-im\\data\\|feishu-history\\|CTI_HOME/i.test(text)) return true;
  if (/(\\\\[rnt]|\\")/.test(text) && text.length > 300) return true;
  const mojibakeHits = (text.match(/[\u951F\uFFFD]|[\uE000-\uF8FF]|\u9225|\u9286|\u6D93|\u9359|\u7A0B/g) || []).length;
  return mojibakeHits >= 4 && text.length > 80;
}

function compactProviderError(raw: string): string {
  const trimmed = (raw || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '未完成：模型执行中断，但没有返回可展示的错误原因。';
  if (looksLikeInternalProviderPayload(trimmed)) {
    return '未完成：模型执行中断，已拦截一条内部工具结果，避免把调试内容发到群里。请稍后重试。';
  }
  const withoutProtocol = trimmed
    .replace(/^data:\s*/i, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[{}[\]"\\]{2,}/g, ' ')
    .trim();
  const visible = withoutProtocol.length > 180 ? `${withoutProtocol.slice(0, 177)}...` : withoutProtocol;
  return `未完成：${visible || '模型执行中断。'}`;
}

function buildSafeProviderErrorMessage(
  raw: string,
  _options?: { cardFinalized?: boolean; channelType?: string },
): string {
  return compactProviderError(raw);
}

function shouldSendProviderErrorNotice(input: { channelType: string; chatId: string }): boolean {
  const key = `${input.channelType}:${input.chatId}`;
  const nowMs = Date.now();
  const current = providerErrorCircuit.get(key);
  if (!current || nowMs - current.firstAt > PROVIDER_ERROR_CIRCUIT_WINDOW_MS) {
    providerErrorCircuit.set(key, { count: 1, firstAt: nowMs });
    return true;
  }
  current.count += 1;
  providerErrorCircuit.set(key, current);
  return current.count <= PROVIDER_ERROR_CIRCUIT_MAX_NOTICES;
}

function resetProviderErrorCircuitBreaker(): void {
  providerErrorCircuit.clear();
}

function extractDelimitedSection(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  if (start < 0) return '';
  const contentStart = start + startMarker.length;
  const end = text.indexOf(endMarker, contentStart);
  return (end >= 0 ? text.slice(contentStart, end) : text.slice(contentStart)).trim();
}

function buildFeishuHistoryDirectReply(prompt: string): string {
  const history = extractDelimitedSection(prompt, '=== 群聊历史开始 ===', '=== 群聊历史结束 ===');
  if (!history) {
    if (/没有拿到可用于回答的有效消息|没有筛到/.test(prompt)) {
      return '我查了本地群聊历史索引，这次没有拿到可用于回答的有效消息。可以先同步群聊历史后再让我看。';
    }
    return '';
  }
  const lines = history
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-12);
  if (lines.length === 0) return '';
  return [
    '我看了今天群聊记录，主要是在聊这些：',
    ...lines.map((line) => `- ${line.replace(/^\[[^\]]+\]\s*/, '')}`),
  ].join('\n');
}

async function startProgressPulse(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  sessionId: string,
): Promise<ProgressPulseController | null> {
  const config = getProgressPulseConfig();
  if (!config.enabled) return null;
  if (adapter.channelType === 'qq' || adapter.channelType === 'weixin') return null;

  try {
    await deliver(adapter, {
      address: msg.address,
      text: buildProgressMessageForBridge('started'),
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    }, { sessionId });
  } catch {
    return null;
  }

  const timer = setInterval(() => {
    void deliver(adapter, {
      address: msg.address,
      text: buildProgressMessageForBridge('running'),
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    }, { sessionId }).catch(() => {
      // non-critical heartbeat failure
    });
  }, config.intervalMs);

  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

function extractLocalImagePaths(text: string, workingDirectory: string, additionalDirectories: string[] = []): string[] {
  const found = new Set<string>();
  const searchDirectories = Array.from(new Set([workingDirectory, ...additionalDirectories].filter(Boolean)));
  const markdownPathRe = /\[[^\]]+\]\(([^)]+\.(?:png|jpe?g|webp|gif))\)/ig;
  const absolutePathRe = /([A-Za-z]:\\[^\r\n"'<>|?*]+\.(?:png|jpe?g|webp|gif))/ig;
  const filenameRe = /\b([A-Za-z0-9._-]+\.(?:png|jpe?g|webp|gif))\b/ig;

  for (const match of text.matchAll(markdownPathRe)) {
    found.add(match[1]);
  }
  for (const match of text.matchAll(absolutePathRe)) {
    found.add(match[1]);
  }
  for (const match of text.matchAll(filenameRe)) {
    const candidate = match[1];
    if (candidate.includes('\\') || candidate.includes('/')) {
      found.add(candidate);
      continue;
    }
    for (const directory of searchDirectories) {
      found.add(path.join(directory, candidate));
    }
  }

  return Array.from(found)
    .map((candidate) => candidate.replace(/\//g, '\\'))
    .filter((candidate) => {
      if (path.isAbsolute(candidate)) return fs.existsSync(candidate);
      return searchDirectories.some((directory) => fs.existsSync(path.join(directory, candidate)));
    })
    .map((candidate) => {
      if (path.isAbsolute(candidate)) return candidate;
      for (const directory of searchDirectories) {
        const resolved = path.join(directory, candidate);
        if (fs.existsSync(resolved)) return resolved;
      }
      return path.join(workingDirectory, candidate);
    });
}

function getAutoReplyImageLimit(): number {
  const { store } = getBridgeContext();
  const raw = store.getSetting('bridge_auto_reply_image_limit')
    || process.env.CTI_AUTO_REPLY_IMAGE_LIMIT
    || '1';
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(parsed, 4);
}

interface WorkspaceCatalogEntry {
  label: string;
  path: string;
  kind: 'root' | 'project';
}

function getConfiguredWorkspaceRoots(): string[] {
  const { store } = getBridgeContext();
  const configured = splitWorkspacePathList(store.getSetting('bridge_allowed_workspace_roots'));
  if (configured.length > 0) return configured;

  const fallback = store.getSetting('bridge_default_work_dir');
  return fallback ? [fallback] : [];
}

function getSt3WorkspaceRoot(): string {
  const { store } = getBridgeContext();
  return path.normalize(
    store.getSetting('bridge_st3_workspace_root')
      || store.getSetting('bridge_default_work_dir')
      || process.env.CTI_DEFAULT_WORKDIR
      || 'C:\\unity\\ST3',
  );
}

function getSt3UnityProjectPath(): string {
  const { store } = getBridgeContext();
  return path.normalize(
    store.getSetting('bridge_unity_project_path')
      || process.env.CTI_UNITY_PROJECT_PATH
      || path.join(getSt3WorkspaceRoot(), 'Game'),
  );
}

function getConfiguredAdditionalDirectories(): string[] {
  const { store } = getBridgeContext();
  return splitWorkspacePathList(store.getSetting('bridge_default_additional_directories'));
}

function getAccessibleWorkspaceDirectories(primaryWorkingDirectory: string): string[] {
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const candidate of [primaryWorkingDirectory, ...getConfiguredAdditionalDirectories()]) {
    const validated = validateWorkingDirectory(candidate, getConfiguredWorkspaceRoots());
    if (!validated) continue;
    const dedupeKey = path.resolve(validated).toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    directories.push(validated);
  }
  return directories;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listWorkspaceCatalog(): WorkspaceCatalogEntry[] {
  const seenPaths = new Set<string>();
  const entries: WorkspaceCatalogEntry[] = [];

  const pushEntry = (label: string, targetPath: string, kind: 'root' | 'project') => {
    const dedupeKey = path.resolve(targetPath).toLowerCase();
    if (seenPaths.has(dedupeKey)) return;
    seenPaths.add(dedupeKey);
    entries.push({ label, path: targetPath, kind });
  };

  for (const root of getConfiguredWorkspaceRoots()) {
    if (!fs.existsSync(root)) continue;
    pushEntry(path.basename(root), root, 'root');

    try {
      const children = fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        pushEntry(child.name, path.join(root, child.name), 'project');
      }
    } catch {
      // Ignore unreadable roots; they simply won't be listed/resolved by name.
    }
  }

  return entries;
}

function resolveWorkspaceArgument(rawTarget: string): { path?: string; matches?: string[]; error?: string } {
  const allowedRoots = getConfiguredWorkspaceRoots();
  const trimmed = rawTarget.trim().replace(/^["']|["']$/g, '').trim();
  if (!trimmed) return { error: 'empty' };

  const absolute = validateWorkingDirectory(trimmed, allowedRoots);
  if (absolute) {
    if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
      return { path: absolute };
    }
    return { error: 'not_found' };
  }

  if (path.isAbsolute(trimmed)) {
    return { error: 'not_allowed' };
  }

  const catalog = listWorkspaceCatalog();
  const normalizedTarget = trimmed.toLowerCase();
  const matchedPaths = Array.from(new Set(
    catalog
      .filter((entry) => entry.label.toLowerCase() === normalizedTarget)
      .map((entry) => entry.path)
  ));

  for (const root of allowedRoots) {
    const candidate = validateWorkingDirectory(path.join(root, trimmed), allowedRoots);
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        matchedPaths.push(candidate);
      }
    } catch {
      // Ignore unreadable paths here and continue searching.
    }
  }

  const uniqueMatches = Array.from(new Set(matchedPaths.map((entry) => path.resolve(entry))));
  if (uniqueMatches.length === 1) {
    return { path: uniqueMatches[0] };
  }
  if (uniqueMatches.length > 1) {
    return { error: 'ambiguous', matches: uniqueMatches.sort() };
  }
  return { error: 'not_found' };
}

function resolveWorkspaceArgumentForMessage(
  rawTarget: string,
  msg: InboundMessage,
): { path?: string; matches?: string[]; error?: string } {
  const resolved = resolveWorkspaceArgument(rawTarget);
  if (resolved.path || resolved.error !== 'not_allowed' || !isOwnerMessage(msg)) {
    return resolved;
  }

  const normalized = validateWorkingDirectory(rawTarget.trim().replace(/^["']|["']$/g, '').trim(), []);
  if (normalized && fs.existsSync(normalized) && fs.statSync(normalized).isDirectory()) {
    return { path: normalized };
  }
  return resolved;
}

function detectWorkspaceOverrideFromText(text: string, allowOwnerOverride = false): string | null {
  const absoluteMatches = text.match(/[A-Za-z]:\\[^\s"'<>|?*]+/g) || [];
  for (const candidate of absoluteMatches) {
    const resolved = resolveWorkspaceArgument(candidate);
    if (resolved.path) return resolved.path;
    if (allowOwnerOverride) {
      const normalized = validateWorkingDirectory(candidate, []);
      if (normalized && fs.existsSync(normalized) && fs.statSync(normalized).isDirectory()) {
        return normalized;
      }
    }
  }

  const catalog = listWorkspaceCatalog();
  const lowerText = text.toLowerCase();
  const matched = new Set<string>();

  for (const entry of catalog) {
    const label = entry.label.trim();
    if (!label || label.length < 3) continue;
    const escaped = escapeRegex(label.toLowerCase());
    const patterns = [
      new RegExp(`(^|\\s)${escaped}(?=\\s+(git|npm|pnpm|yarn)\\b)`),
      new RegExp(`(在|到|切到|切换到|进入|使用|针对|绑定到)\\s*${escaped}(\\s|$)`),
      new RegExp(`${escaped}\\s*(工程|项目|仓库|目录)`),
    ];
    if (patterns.some((pattern) => pattern.test(lowerText))) {
      matched.add(entry.path);
    }
  }

  return matched.size === 1 ? Array.from(matched)[0] : null;
}

function renderWorkspaceSummaryLines(): string[] {
  const roots = getConfiguredWorkspaceRoots();
  const lines = ['<b>Available Workspaces</b>', ''];
  if (roots.length === 0) {
    lines.push('No workspace roots configured.');
    return lines;
  }

  const byRoot = new Map<string, string[]>();
  for (const root of roots) {
    byRoot.set(root, []);
  }

  for (const entry of listWorkspaceCatalog()) {
    if (entry.kind !== 'project') continue;
    const parent = path.dirname(entry.path);
    const projects = byRoot.get(parent);
    if (projects) {
      projects.push(entry.label);
    }
  }

  for (const root of roots) {
    const projects = (byRoot.get(root) || []).slice(0, 12);
    lines.push(`<code>${escapeHtml(root)}</code>`);
    if (projects.length > 0) {
      lines.push(`Projects: ${escapeHtml(projects.join(', '))}`);
    }
  }

  const additionalDirectories = getConfiguredAdditionalDirectories();
  if (additionalDirectories.length > 0) {
    lines.push('');
    lines.push(`Additional directories: <code>${escapeHtml(additionalDirectories.join(' | '))}</code>`);
  }

  return lines;
}

function isFeishuDocGenerationRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  const mentionsDoc = /(飞书文档|文档链接|回链接|发链接|在线文档)/.test(normalized);
  const asksToGenerate = /(生成|整理成|做成|输出成|输出到|保存成|创建)/.test(normalized);
  return mentionsDoc && asksToGenerate;
}

function isFeishuDocGenerationRequestStrict(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  const mentionsDoc = /(飞书文档|云文档|文档链接|在线文档|docx|document)/i.test(normalized);
  const asksToGenerate = /(生成|整理成|做成|输出到|保存|创建|重写|更新|修改|生成.*链接|回链接)/.test(normalized);
  return mentionsDoc && asksToGenerate;
}

function isFeishuDocumentListRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  return /(有哪些文档|文档有哪些|文档列表|生成过什么文档|之前.*文档|导览文档|文档导览|list.*docs|docs.*list)/i.test(normalized);
}

function parseDirectCommandRequest(text: string): DirectCommandRequest | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();
  if (!lower) return null;

  if (/\bgit pull --ff-only\b/.test(lower)) {
    return { command: 'git', args: ['pull', '--ff-only'], display: 'git pull --ff-only', mutating: true };
  }
  if (/\bgit pull\b/.test(lower)) {
    return { command: 'git', args: ['pull'], display: 'git pull', mutating: true };
  }
  if (/\bgit status -sb\b/.test(lower)) {
    return { command: 'git', args: ['status', '-sb'], display: 'git status -sb', mutating: false };
  }
  if (/\bgit status\b/.test(lower)) {
    return { command: 'git', args: ['status'], display: 'git status', mutating: false };
  }

  return null;
}

function formatDirectCommandResult(request: DirectCommandRequest, stdout: string, stderr: string): DirectCommandResult {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
  const text = combined || '(无输出)';
  return {
    ok: true,
    text: `${request.display} 执行成功。\n\n\`\`\`text\n${text}\n\`\`\``,
  };
}

function formatDirectCommandError(request: DirectCommandRequest, stdout: string, stderr: string, errorMessage: string): DirectCommandResult {
  const combined = [stderr.trim(), stdout.trim(), errorMessage.trim()].filter(Boolean).join('\n');
  const text = combined || '命令执行失败';
  return {
    ok: false,
    text: `${request.display} 失败。\n\n\`\`\`text\n${text}\n\`\`\``,
  };
}

async function executeDirectCommand(request: DirectCommandRequest, workingDirectory: string): Promise<DirectCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(request.command, request.args, {
      cwd: workingDirectory,
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 4,
    });
    return formatDirectCommandResult(request, stdout, stderr);
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return formatDirectCommandError(request, err.stdout || '', err.stderr || '', err.message || String(error));
  }
}

function shouldForceFreshThreadBeforeExecution(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  return /\b(git\s+(pull|status|fetch|rebase|merge|checkout|switch)|npm\s+(install|run)|pnpm\s+(install|run|add)|yarn\s+(install|add)|执行|运行|直接拉取|拉取到最新|先执行|马上执行)\b/i.test(normalized);
}

function shouldUseExecutionFirstPrompt(text: string): boolean {
  return shouldForceFreshThreadBeforeExecution(text);
}

function buildExecutionFirstPrompt(text: string): string {
  return [
    '你现在处于执行优先模式。',
    '规则：',
    '1. 对用户要求的命令先执行，再回复。',
    '2. 回复必须基于真实执行结果，不要编造权限限制、沙箱限制或预判失败。',
    '3. 不要输出“我先检查”“我准备”“我判断”“我再看看”这类过程描述。',
    '4. 如果命令成功，直接简要汇报结果。',
    '5. 如果命令失败，直接给出真实错误和下一步处理建议。',
    '6. 除非用户明确要求，不要把问题改写成让用户自己在本机执行。',
    '',
    `用户请求：${text}`,
  ].join('\n');
}

function shouldUseUnityQuickActionFastPath(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const hasUnityCue = /(unity|mcp|scene|inspector|hierarchy|gameobject|menuitem|editor window|unity editor|场景|层级|检查器|菜单|按钮|预览工具|解锁预览工具|全显|医院模拟|截图|选中|聚焦)/i.test(normalized);
  if (!hasUnityCue) return false;

  const hasActionCue = /(打开|点击|点开|调用|触发|执行|切换|显示|隐藏|全显|解锁|截图|选中|聚焦|定位|刷新|重试|直接)/i.test(normalized);
  if (!hasActionCue) return false;

  const looksAnalytical = /(分析|为什么|原因|诊断|排查|检查逻辑|看看脚本|看代码|搜一下|总结一下|解释一下)/i.test(normalized);
  return !looksAnalytical;
}

function extractUnityMenuPath(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const explicitMatch = normalized.match(/\b[A-Za-z0-9_\-.]+(?:\/[A-Za-z0-9_\-.一-龥（）()]+){2,}\b/);
  if (explicitMatch) {
    return explicitMatch[0];
  }

  return null;
}

function shouldUseUnityMenuActionFastPath(text: string): boolean {
  return !!extractUnityMenuPath(text) && shouldUseUnityQuickActionFastPath(text);
}

function shouldForceFreshThreadForFastPath(text: string): boolean {
  return shouldForceFreshThreadBeforeExecution(text) || shouldUseUnityQuickActionFastPath(text);
}

function buildExecutionFirstSystemInstructions(): string {
  return [
    'Execution-first mode:',
    '1. Execute the requested command first, then answer.',
    '2. Base the answer only on the real execution result.',
    '3. Do not output process narration like "我先检查/我再看看/我准备".',
    '4. If it fails, give the real error and one concrete next step.',
    '5. Do not rewrite the task into "please run this locally" unless execution is actually impossible.',
  ].join('\n');
}

function buildUnityQuickActionSystemInstructions(): string {
  return [
    'Unity quick-action mode:',
    '1. This is a simple Unity Editor action request. Prefer the most direct Unity MCP/editor action first.',
    '2. Mandatory attempt rule: before saying unavailable, execute at least one concrete attempt and show its result (Unity MCP tool call result OR launcher shell command output).',
    '3. If an existing Unity editor tool/menu/window already exists, use it directly. Do not create temporary scripts, temporary menu items, or project helper code unless the user explicitly asks for code changes.',
    '4. Do not begin with broad project search, repo-wide grep, long script archaeology, or log spelunking.',
    '5. First try one direct action path: menu invocation, window action, scene-object operation, or screenshot confirmation.',
    '6. If direct Unity MCP tools are missing, run one bootstrap attempt for Unity MCP connection/startup and report exact command + error.',
    '7. If MCP/bootstrap still cannot perform the operation, fall back to Codex CLI/local desktop automation to simulate the required Unity UI click or keyboard path when it is safe and the target is unambiguous.',
    '8. UI clicking is the final fallback only after MCP/editor invocation is unavailable or failed; do not skip directly to screenshots or refusal.',
    '9. For screenshot requests, the requested source is binding: if the user specifies a scene, camera, Game view, or PreviewCamera, do not substitute a Scene View/window crop as success. If exact capture fails, keep repairing via MCP/CLI/UI automation or report the exact failure.',
    '10. After any screenshot capture, verify the actual image content before declaring success. If the image is blank, black, transparent, mostly one color, or clearly the wrong viewport/camera, treat it as failure and continue repair.',
    '11. For a requested camera such as PreviewCamera, success requires: requested scene loaded, target camera found/enabled, output rendered from that camera or Game view, and non-blank image verified.',
    '12. If multiple Unity projects are open, operate only on the project bound to this turn. Do not switch to another open Unity window/project unless the owner explicitly requested that exact path.',
    '13. Send progress only when a real checkpoint is completed (for example: MCP connected, scene loaded, target camera found, screenshot saved and verified). Do not send repeated empty "still working" messages.',
    '14. If that direct path fails, do at most one narrow fallback to locate the exact menu/script/window.',
    '15. Keep the reply short and result-first. Do not narrate a long step-by-step thought chain.',
  ].join('\n');
}

function buildUnityMenuActionSystemInstructions(menuPath: string): string {
  return [
    'Unity menu-action mode:',
    `1. The user already provided an explicit Unity menu path: ${menuPath}`,
    '2. First action should be invoking that exact existing menu entry through Unity MCP/editor tooling.',
    '3. Do not search the whole project before trying the exact menu path.',
    '4. Do not create temporary scripts, temporary menu items, or helper code.',
    '5. If the menu opens an existing window/tool, continue using that existing editor tool.',
    '6. Only if the exact menu invocation fails should you do one narrow fallback to confirm the menu path or the existing window entry.',
    '7. If MCP cannot invoke the menu/window, use Codex CLI/local desktop automation to simulate the existing Unity UI click path when it is safe and unambiguous.',
    '8. UI clicking is only the final fallback when direct menu invocation is unavailable.',
    '9. If the user requested an exact camera/source screenshot, never mark a different viewport crop as completed.',
    '10. Verify captured screenshot content is non-blank and from the requested source before reporting success.',
  ].join('\n');
}

function buildUnityScreenshotPolicyInstructions(text: string): string {
  const wantsOverview = /(全览图|横屏|整体布局|全景|overview|panorama|landscape|16:9)/i.test(text);
  const wantsRunGame = /(运行游戏|跑游戏|进入游戏|play mode|game view|运行一下)/i.test(text);
  const defaultProjectPath = getSt3UnityProjectPath();
  return [
    'ST3 screenshot policy:',
    `1. Default Unity project path is ${defaultProjectPath}. Use it unless the owner explicitly names another project path.`,
    wantsOverview
      ? '2. The user requested an overview/landscape shot. Use a landscape 16:9 capture and adjust the camera/viewpoint to show the whole requested scene.'
      : '2. The user did not explicitly request an overview. Prefer Game view or the requested camera in portrait orientation.',
    wantsRunGame
      ? '3. "运行游戏" means entering the playable game entry flow, not opening an art-only preview scene. In ST3, default to the configured game entry scene such as FirstScene/build settings entry unless the user explicitly names another runtime scene.'
      : '3. If the request names PreviewCamera, Game view, or a scene camera, that source is binding. A Scene View crop or random editor viewport is not a valid success.',
    '4. Never capture from another already-open Unity project/window as a fallback. If the bound ST3 project is not the active Unity window, switch to the correct project or report the exact blocker.',
    '5. For Timeline scenes, set the PlayableDirector to the requested time, default to time=0 for first frame, call Evaluate(), then render the camera.',
    '6. Default deliverable is one verified screenshot. Only send multiple screenshots when the user explicitly asks for several, or one image cannot satisfy the requested comparison/coverage.',
    '7. Verify the screenshot is not blank, not mostly one color, and has the requested orientation before reporting completion.',
  ].join('\n');
}

function getFastPathOptions(text: string): { extraSystemPrompt?: string; historyLimit?: number } {
  const screenshotPolicy = /(截图|截一张|拍一下|预览图|全览图|横屏|竖屏|screenshot|capture|overview|previewcamera)/i.test(text)
    ? buildUnityScreenshotPolicyInstructions(text)
    : '';
  const menuPath = extractUnityMenuPath(text);
  if (menuPath && shouldUseUnityMenuActionFastPath(text)) {
    return {
      extraSystemPrompt: [
        buildUnityQuickActionSystemInstructions(),
        buildUnityMenuActionSystemInstructions(menuPath),
        screenshotPolicy,
      ].join('\n\n'),
      historyLimit: 6,
    };
  }

  if (shouldUseUnityQuickActionFastPath(text)) {
    return {
      extraSystemPrompt: [buildUnityQuickActionSystemInstructions(), screenshotPolicy].filter(Boolean).join('\n\n'),
      historyLimit: 8,
    };
  }

  if (shouldUseExecutionFirstPrompt(text)) {
    return {
      extraSystemPrompt: buildExecutionFirstSystemInstructions(),
      historyLimit: 12,
    };
  }

  return {};
}

function extractAssistantMarkdown(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('[')) {
    try {
      const blocks = JSON.parse(trimmed) as Array<{ type?: string; text?: string; content?: string }>;
      if (Array.isArray(blocks)) {
        return blocks
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text!.trim())
          .filter(Boolean)
          .join('\n\n')
          .trim();
      }
    } catch {
      // Fall through to raw content
    }
  }

  return trimmed;
}

function buildFeishuDocTitleFromSession(now = new Date()): string {
  const timeLabel = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now).replace(/[/:]/g, '-');
  return `Document Draft ${timeLabel}`;
}

function isGenericFeishuDocumentTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return /^(群聊总结|最近消息|会话整理|聊天记录|原始记录|document draft)/i.test(normalized)
    || /^(group chat summary|recent messages|conversation cleanup)/i.test(normalized);
}

function buildFeishuDocumentRewritePrompt(sourceMarkdown: string, userRequest: string): string {
  return [
    '请把下面的材料整理成一份适合直接写入飞书文档的 Markdown 正文。',
    '',
    '硬性要求：',
    '1. 第一行必须是有内容含义的一级标题，不要写“聊天记录”“原始记录”“以下是”“群聊总结”“最近消息”等流水账标题，也不要用时间戳当标题。',
    '2. 文档默认使用这些结构：结论摘要、关键事实、执行结果、问题与风险、后续待办。',
    '3. 如果材料来自群聊或执行日志，要提炼结论，不要按时间顺序逐条复述聊天记录。',
    '4. 如果材料里包含失败/空白截图/替代方案，必须在“问题与风险”里明确写出来，不要包装成成功。',
    '5. 如果是 Unity 场景类文档，需要附录时优先附“场景位置”，不要附截图文件路径清单，除非用户明确要求截图路径。',
    '6. 只输出文档正文，不要输出说明、客套话、代码块围栏或“已生成文档”。',
    '',
    `用户当前请求：${userRequest}`,
    '',
    '=== 待整理材料开始 ===',
    sourceMarkdown.trim(),
    '=== 待整理材料结束 ===',
  ].join('\n');
}

function parseIdList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n;|]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizePermissionRole(role: string | undefined | null): PermissionRole {
  const normalized = (role || '').trim().toLowerCase();
  if (normalized === 'owner') return 'owner';
  if (normalized === 'operator') return 'operator';
  return 'viewer';
}

function shouldTryFeishuCloudLinkResolve(adapter: BaseChannelAdapter, text: string): boolean {
  if (adapter.channelType !== 'feishu') return false;
  return /https?:\/\/[^\s<>"']*(?:feishu\.cn|larksuite\.com)\/(?:docx|docs|sheets|base|bitable)\//i.test(text);
}

function shouldTryFeishuOAuthManualCallback(adapter: BaseChannelAdapter, text: string): boolean {
  if (adapter.channelType !== 'feishu') return false;
  return /\bcode=[^&\s]+(?:&|&amp;)state=[^&\s]+|\bstate=[^&\s]+(?:&|&amp;)code=[^&\s]+/i.test(text);
}

function buildFeishuCloudBlockerMessage(result: FeishuCloudLinkResolveResult): string {
  const fallback = result.status === 'auth_required'
    ? '需要你登录飞书后，我才能安全读取这个云文档。'
    : result.status === 'permission_denied'
      ? '未完成：当前登录飞书用户也没有这个云文档权限，请让文档所有者分享给你或导出内容。'
      : '未完成：读取飞书云文档失败。';
  return result.userMessage?.trim() || result.error?.trim() || fallback;
}

function sanitizeFeishuCloudDocumentLinks(text: string): string {
  return text
    .replace(/https?:\/\/[^\s<>"')\]]*(?:feishu\.cn|larksuite\.com)\/(?:docx|docs|sheets|base|bitable)\/[^\s<>"')\]]*/gi, '[已读取的飞书云文档]')
    .trim();
}

function buildFeishuCloudResolvedPrompt(originalText: string, cloudSystemPrompt: string): string {
  const sanitizedRequest = sanitizeFeishuCloudDocumentLinks(originalText);
  const sanitizedCloudContext = sanitizeFeishuCloudDocumentLinks(cloudSystemPrompt);
  return [
    '=== 已读取的飞书云文档内容开始 ===',
    sanitizedCloudContext,
    '=== 已读取的飞书云文档内容结束 ===',
    '',
    '飞书云文档内容已由 bridge 预读取，并放在系统上下文的 "Feishu cloud document context" 中。',
    '请直接基于该上下文回答用户请求；不要再访问、抓取或测试原始飞书链接；不要要求用户公开链接、截图或导出内容，除非系统上下文明示读取失败。',
    '',
    '用户原始请求：',
    sanitizedRequest || '请总结已读取的飞书云文档内容。',
  ].join('\n');
}

function shouldUseFeishuCloudDirectSummary(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  return /(总结|归纳|整理|看一下|看看|提炼|概括|汇总)/.test(normalized)
    && !/(查找|搜索|筛选|第\d+行|指定|只看|导出|生成文档|写入|修改)/.test(normalized);
}

interface FeishuCloudTableRow {
  issueNo: string;
  author: string;
  type: string;
  description: string;
  suggestion: string;
  priority: string;
  status: string;
}

function parseFeishuCloudRows(cloudContext: string): FeishuCloudTableRow[] {
  const rows: FeishuCloudTableRow[] = [];
  for (const line of cloudContext.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\.\s+(.*)$/);
    if (!match) continue;
    const cells = match[1].split('|').map((cell) => cell.trim());
    if (cells.length < 8 || cells[0] === '问题序号') continue;
    rows.push({
      issueNo: cells[0] || '',
      author: cells[1] || '',
      type: cells[2] || '',
      description: cells[3] || '',
      suggestion: cells[4] || '',
      priority: cells[6] || '',
      status: cells[7] || '',
    });
  }
  return rows;
}

function topEntriesFromMap(map: Map<string, number>, limit = 5): string[] {
  return Array.from(map.entries())
    .filter(([key]) => key.trim())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .slice(0, limit)
    .map(([key, value]) => `${key} ${value}`);
}

function addCount(map: Map<string, number>, key: string): void {
  const normalized = key.trim() || '未填写';
  map.set(normalized, (map.get(normalized) || 0) + 1);
}

function classifyFeishuCloudIssue(row: FeishuCloudTableRow): string[] {
  const text = `${row.description} ${row.suggestion}`;
  const categories: Array<[string, RegExp]> = [
    ['引导/任务指引', /引导|任务|指引|引导线|教程|下一步|目标|跳转/],
    ['交互操作/点击反馈', /交互|点击|操作|按钮|气泡|环形菜单|触碰|靠近|派遣|收拾|整理/],
    ['表现包装/音效动画', /表现|动画|音效|震动|CG|ASMR|表演|镜头|爽快|视觉|变化|氛围/],
    ['数值收益/升级节奏', /升级|资源|收益|效率|费用|等待|读条|赚钱|数值|等级/],
    ['剧情角色/代入感', /剧情|角色|南希|莱拉|医生|病人|幸存者|对话|代入|人物/],
    ['玩法结构/长期目标', /SLG|模拟|医院|主城|玩法|房间|区域|格子间|持续目标|关联度/],
    ['UI/视角/文字', /UI|视角|文字|遮挡|编号|图标|气泡巨大|显示/],
  ];
  return categories.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function buildFeishuCloudDirectSummary(cloudContext: string): string | null {
  const rows = parseFeishuCloudRows(cloudContext);
  if (rows.length === 0) return null;

  const typeCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  const priorityCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  for (const row of rows) {
    addCount(typeCounts, row.type);
    addCount(statusCounts, row.status);
    addCount(priorityCounts, row.priority);
    const categories = classifyFeishuCloudIssue(row);
    if (categories.length === 0) addCount(categoryCounts, '其他/未归类');
    for (const category of categories) addCount(categoryCounts, category);
  }

  const highPriority = rows
    .filter((row) => row.priority === '5' || row.priority === '4')
    .slice(0, 10)
    .map((row) => `- #${row.issueNo || '?'} ${row.author || '未填写'}｜P${row.priority || '-'}｜${row.status || '未填写'}：${row.description.slice(0, 90)}`);

  return [
    `已读取飞书表格内容，当前可见数据约 ${rows.length} 条问题/建议记录。`,
    '',
    '总体结论：反馈主要集中在新手引导、交互反馈、表现包装、升级收益感、剧情角色代入和医院模拟玩法目标感上。高优先级项里，“引导线/任务目标不清”“治疗气泡等预操作提示不足”“角色/剧情表演缺失”“升级和收益传达弱”是最需要优先收敛的方向。',
    '',
    `问题类型分布：${topEntriesFromMap(typeCounts).join('，') || '无'}`,
    `排期状态分布：${topEntriesFromMap(statusCounts).join('，') || '无'}`,
    `优先级分布：${topEntriesFromMap(priorityCounts).join('，') || '无'}`,
    `主题归类 Top：${topEntriesFromMap(categoryCounts, 7).join('，') || '无'}`,
    '',
    '建议优先处理：',
    '1. 新手引导和任务目标：修正引导线和任务目标不一致、顶部任务消失后缺少承接、下一步操作提示不主动等问题。',
    '2. 交互反馈：补足治疗气泡、清理、派遣、靠近角色、刷新区域等操作的反馈，让玩家明确知道该点什么、点完发生了什么。',
    '3. 升级和经营收益：强化病房升级、护士升级、房间选择、费用/效率变化的表达，避免“花了钱但没感觉”。',
    '4. 表现包装：补充音效、动画、ASMR、CG 第一人称/镜头、角色表演和从坏到好的变化，提升爽感和代入感。',
    '5. 玩法结构：医院模拟与 SLG 主城的关联、长期目标、格子间后续新鲜感需要重新梳理，否则玩家容易觉得医院玩法目的不明确。',
    '',
    '高优先级样例：',
    ...(highPriority.length > 0 ? highPriority : ['- 暂无可解析的 P4/P5 样例。']),
  ].join('\n');
}

function permissionRank(role: PermissionRole): number {
  switch (role) {
    case 'owner':
      return 3;
    case 'operator':
      return 2;
    default:
      return 1;
  }
}

function normalizeChannelType(channelType: string | undefined | null): string {
  const normalized = (channelType || '').trim().toLowerCase();
  if (normalized === 'telegram') return 'telegram';
  if (normalized === 'discord') return 'discord';
  if (normalized === 'qq') return 'qq';
  if (normalized === 'weixin' || normalized === 'wechat') return 'weixin';
  return normalized || 'feishu';
}

function parseEnvIdList(name: string): string[] {
  return parseIdList(process.env[name] || '');
}

function getConfiguredOwnerIds(channelType: string): string[] {
  const { store } = getBridgeContext();
  const channel = normalizeChannelType(channelType);
  const ownerEnvByChannel: Record<string, string[]> = {
    telegram: ['CTI_TG_OWNER_USERS', 'CTI_TELEGRAM_OWNER_USERS'],
    discord: ['CTI_DISCORD_OWNER_USERS'],
    feishu: ['CTI_FEISHU_OWNER_USERS'],
    qq: ['CTI_QQ_OWNER_USERS'],
    weixin: ['CTI_WEIXIN_OWNER_USERS'],
  };
  const ownerStoreByChannel: Record<string, string[]> = {
    telegram: ['telegram_bridge_owner_users'],
    discord: ['bridge_discord_owner_users'],
    feishu: ['bridge_feishu_owner_users'],
    qq: ['bridge_qq_owner_users'],
    weixin: ['bridge_weixin_owner_users'],
  };
  const explicit = (ownerStoreByChannel[channel] || [])
    .flatMap((name) => parseIdList(store.getSetting(name)));
  if (explicit.length > 0) return explicit;
  const envOwners = (ownerEnvByChannel[channel] || [])
    .flatMap((name) => parseEnvIdList(name));
  if (envOwners.length > 0) return Array.from(new Set(envOwners));
  if (channel !== 'feishu') return [];
  const allowed = parseIdList(store.getSetting('bridge_feishu_allowed_users'));
  return allowed.length === 1 ? allowed : [];
}

function getConfiguredAllowedIds(channelType: string): string[] {
  const { store } = getBridgeContext();
  const channel = normalizeChannelType(channelType);
  switch (channel) {
    case 'feishu':
      return parseIdList(store.getSetting('bridge_feishu_allowed_users'));
    case 'telegram':
      return parseIdList(store.getSetting('telegram_bridge_allowed_users') || process.env.CTI_TG_ALLOWED_USERS || '');
    case 'discord':
      return parseIdList(store.getSetting('bridge_discord_allowed_users') || process.env.CTI_DISCORD_ALLOWED_USERS || '');
    case 'qq':
      return parseIdList(store.getSetting('bridge_qq_allowed_users') || process.env.CTI_QQ_ALLOWED_USERS || '');
    case 'weixin':
      return parseIdList(store.getSetting('bridge_weixin_allowed_users') || process.env.CTI_WEIXIN_ALLOWED_USERS || '');
    default:
      return [];
  }
}

function readPermissionSubjects(): PermissionSubject[] {
  try {
    if (!fs.existsSync(PERMISSIONS_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(PERMISSIONS_PATH, 'utf8')) as { subjects?: PermissionSubject[] };
    return Array.isArray(parsed.subjects) ? parsed.subjects : [];
  } catch {
    return [];
  }
}

function getPermissionRoleForMessage(msg: InboundMessage): PermissionRole | null {
  const userId = msg.address.userId?.trim();
  if (!userId) return null;
  const channel = normalizeChannelType(msg.address.channelType);
  const subjects = readPermissionSubjects();
  const match = subjects.find((subject) =>
    normalizeChannelType(subject.channelType) === channel
    && (subject.userId || '').trim() === userId
  );
  if (match) return normalizePermissionRole(match.role);
  if (getConfiguredOwnerIds(channel).includes(userId)) return 'owner';
  if (getConfiguredAllowedIds(channel).includes(userId)) return 'viewer';
  return null;
}

function hasRole(msg: InboundMessage, requiredRole: PermissionRole): boolean {
  const role = getPermissionRoleForMessage(msg);
  return !!role && permissionRank(role) >= permissionRank(requiredRole);
}

function isOwnerMessage(msg: InboundMessage): boolean {
  return hasRole(msg, 'owner');
}

function buildRoleRequiredMessage(msg: InboundMessage, role: PermissionRole): string {
  const userId = msg.address.userId || '(unknown)';
  const label = role === 'owner' ? 'owner' : 'operator 或 owner';
  const configHint = role === 'owner'
    ? '请在控制面板“权限”页把这个 ID 设为 Owner，或加入对应 CTI_*_OWNER_USERS 后重启桥接。'
    : '请在控制面板“权限”页把这个 ID 设为 Operator/Owner 后重启桥接。';
  return [
    `这类操作只允许 ${label} 本人发起或批准。`,
    `当前发送者 ID：${userId}`,
    configHint,
  ].join('\n');
}

function buildOwnerRequiredMessage(msg: InboundMessage): string {
  return buildRoleRequiredMessage(msg, 'owner');
}

function isDangerousUserRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  return /(删除|删掉|永久删除|物理删除|清空|删库|重置会话|清会话|清记忆|修改代码|改代码|写代码|提交|commit|push|pull|rebase|merge|checkout|switch|npm install|pnpm install|yarn add|rm -rf|del \/s|remove-item|icacls|takeown|chmod|chown|delete|drop database|truncate|关机|关闭电脑|重启电脑|重启机器|\bshutdown\b|shutdown\s*\/[srg])/i.test(normalized);
}

function isShutdownRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, '').toLowerCase();
  if (!normalized) return false;
  return /(关机|关闭电脑|shutdown(?:\/s)?(?:\/t0)?)/i.test(normalized);
}

function isShutdownConfirmation(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  return /^确认关机[。！!]?$/u.test(normalized);
}

function buildShutdownConfirmPrompt(): string {
  return [
    '执行关机指令会立即关闭这台电脑，并中断当前所有工作。',
    '如需继续，请直接回复：确认关机',
  ].join('\n');
}

async function executeConfirmedShutdown(msg: InboundMessage): Promise<void> {
  const { store } = getBridgeContext();
  const summary = '执行系统关机：shutdown /s /t 0';
  store.insertAuditLog({
    channelType: msg.address.channelType,
    chatId: msg.address.chatId,
    direction: 'outbound',
    messageId: msg.messageId,
    summary,
  });
  console.warn(`[bridge-manager] ${summary}; requested by ${msg.address.userId || '(unknown user)'}`);

  if (process.platform !== 'win32') {
    throw new Error(`当前平台不支持 Windows 关机命令：${process.platform}`);
  }

  await execFileAsync('shutdown', ['/s', '/t', '0']);
}

async function syncFeishuDocumentGuideBestEffort(
  adapter: BaseChannelAdapter,
  store: ReturnType<typeof getBridgeContext>['store'],
  ownerUserId?: string,
): Promise<{ title: string; url: string } | null> {
  const guidePath = getFeishuDocumentGuidePath(store);
  if (!fs.existsSync(guidePath)) return null;
  const markdown = fs.readFileSync(guidePath, 'utf-8').trim();
  if (!markdown) return null;

  const metaPath = getFeishuDocumentGuideMetaPath(store);
  let meta: { documentId?: string; url?: string; title?: string } = {};
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as typeof meta;
  } catch {
    // First guide sync; no local meta yet.
  }

  const configuredGuideId = store.getSetting('bridge_feishu_document_guide_doc_id') || '';
  const guideDocumentId = configuredGuideId || meta.documentId || '';
  const replaceDoc = (adapter as BaseChannelAdapter & {
    replaceDocumentFromMarkdown?: (documentId: string, markdown: string, options?: { title?: string; ownerUserId?: string }) => Promise<{ documentId?: string; title: string; url: string }>;
  }).replaceDocumentFromMarkdown;
  const createDoc = (adapter as BaseChannelAdapter & {
    createDocumentFromMarkdown?: (markdown: string, options?: { title?: string; ownerUserId?: string }) => Promise<{ documentId?: string; title: string; url: string }>;
  }).createDocumentFromMarkdown;

  try {
    let guideInfo: { documentId?: string; title: string; url: string } | null = null;
    if (guideDocumentId && typeof replaceDoc === 'function') {
      guideInfo = await replaceDoc.call(adapter, guideDocumentId, markdown, {
        title: '飞书文档导览',
        ownerUserId,
      });
    } else if (!guideDocumentId && typeof createDoc === 'function') {
      guideInfo = await createDoc.call(adapter, markdown, {
        title: '飞书文档导览',
        ownerUserId,
      });
    }

    if (!guideInfo) return null;
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(`${metaPath}.tmp`, JSON.stringify({
      documentId: guideInfo.documentId || guideDocumentId,
      title: guideInfo.title,
      url: guideInfo.url,
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf-8');
    fs.renameSync(`${metaPath}.tmp`, metaPath);
    return { title: guideInfo.title, url: guideInfo.url };
  } catch (err) {
    console.warn('[bridge-manager] Failed to sync Feishu document guide:', err instanceof Error ? err.message : err);
    return null;
  }
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  autoStartChecked: boolean;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      sessionLocks: new Map(),
      autoStartChecked: false,
    };
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  return g[GLOBAL_KEY];
}

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  state.sessionLocks.set(sessionId, current);
  // Cleanup when the chain completes.
  // Suppress rejection on the cleanup chain — callers handle errors on `current` directly.
  current.finally(() => {
    if (state.sessionLocks.get(sessionId) === current) {
      state.sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

async function notifyQueuedBehindActiveTurn(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<void> {
  try {
    await deliver(adapter, {
      address: msg.address,
      text: '已收到，上一条消息还在处理；我会按顺序继续回复这条。',
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
  } catch {
    // Queue acknowledgement is best-effort and must not block the real turn.
  }
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  // Iterate all registered adapter types and create those that are enabled
  for (const channelType of getRegisteredTypes()) {
    const settingKey = `bridge_${channelType}_enabled`;
    if (store.getSetting(settingKey) !== 'true') continue;

    const adapter = createAdapter(channelType);
    if (!adapter) continue;

    const configError = adapter.validateConfig();
    if (!configError) {
      registerAdapter(adapter);
    } else {
      console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
    }
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., suppress competing polling)
  lifecycle.onBridgeStart?.();

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
    }
  }

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  const { lifecycle } = getBridgeContext();

  state.running = false;

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  // Stop all adapters
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${type}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
    }
  }

  state.adapters.clear();
  state.adapterMeta.clear();
  state.startedAt = null;

  // Notify host that bridge stopped
  lifecycle.onBridgeStop?.();

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
}

export async function deliverProactiveMessage(input: {
  address: OutboundMessage['address'];
  text: string;
  parseMode?: OutboundMessage['parseMode'];
  replyToMessageId?: string;
  dedupKey?: string;
  sessionId?: string;
  feishuCardJson?: string;
  prepareFinalReply?: boolean;
  workingDirectory?: string;
  additionalDirectories?: string[];
  sourcePrompt?: string;
}): Promise<import('./types.js').SendResult> {
  const state = getState();
  const adapter = state.adapters.get(input.address.channelType);
  if (!adapter || !adapter.isRunning()) {
    return { ok: false, error: `adapter unavailable: ${input.address.channelType}` };
  }

  const prepared = input.prepareFinalReply
    ? await prepareBridgeReplyPayload(
      input.text,
      input.workingDirectory || '',
      input.additionalDirectories || [],
      input.sourcePrompt || '',
    )
    : null;
  const outboundText = prepared?.text || input.text;
  const outboundParseMode = prepared?.parseMode || input.parseMode || 'plain';
  const localImagePaths = input.prepareFinalReply
    ? Array.from(new Set([
      ...(prepared?.images || []),
      ...extractLocalImagePaths(input.text, input.workingDirectory || '', input.additionalDirectories || []),
    ]))
    : [];
  const localFilePaths = input.prepareFinalReply
    ? Array.from(new Set(prepared?.files || []))
    : [];

  const sent = await deliver(adapter, {
    address: input.address,
    text: outboundText,
    parseMode: outboundParseMode,
    replyToMessageId: prepared?.replyTo || input.replyToMessageId,
    mentions: prepared?.mentions,
    feishuCardJson: input.feishuCardJson,
  }, {
    dedupKey: input.dedupKey,
    sessionId: input.sessionId,
  });
  if (!sent.ok) return sent;

  for (const imagePath of localImagePaths.slice(0, getAutoReplyImageLimit())) {
    const imageSend = await adapter.sendLocalImage(input.address.chatId, imagePath, prepared?.replyTo || input.replyToMessageId);
    if (!imageSend.ok) {
      console.warn(`[bridge-manager] Failed to send proactive local image: ${imagePath}`, imageSend.error);
      return imageSend;
    }
  }
  for (const filePath of localFilePaths) {
    const fileSend = await adapter.sendLocalFile(input.address.chatId, filePath, prepared?.replyTo || input.replyToMessageId);
    if (!fileSend.ok) {
      console.warn(`[bridge-manager] Failed to send proactive local file: ${filePath}`, fileSend.error);
      return fileSend;
    }
  }
  return sent;
}

export async function resumeFeishuOAuthRequest(resume: FeishuOAuthManualResumeRequest): Promise<void> {
  const state = getState();
  const adapter = state.adapters.get(resume.channelType);
  if (!adapter || !adapter.isRunning()) {
    console.warn(`[bridge-manager] Cannot resume Feishu OAuth request; adapter unavailable: ${resume.channelType}`);
    return;
  }
  const address = {
    channelType: resume.channelType,
    chatId: resume.chatId,
    userId: resume.userId || resume.chatId,
    displayName: resume.userDisplayName || resume.userId || resume.chatId,
  };
  await deliver(adapter, {
    address,
    text: '已收到，正在处理中。',
    parseMode: 'plain',
    replyToMessageId: resume.messageId,
  });
  await handleMessage(adapter, {
    messageId: `${resume.messageId || `oauth-${Date.now()}`}:oauth-callback`,
    text: resume.text,
    address,
    timestamp: Date.now(),
    raw: {
      feishuSender: resume.userId ? { openId: resume.userId } : undefined,
    },
  });
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        markBridgeRuntimeStage('adapter_waiting');
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped
        markBridgeRuntimeStage('message_received');

        // Callback queries, commands, and numeric permission shortcuts are
        // lightweight — process inline (outside session lock).
        // Regular messages use per-session locking for concurrency.
        //
        // IMPORTANT: numeric shortcuts (1/2/3) for feishu/qq MUST run outside
        // the session lock. The current session is blocked waiting for the
        // permission to be resolved; if "1" enters the session lock queue it
        // deadlocks (permission waits for "1", "1" waits for lock release).
        if (
          msg.callbackData ||
          msg.text.trim().startsWith('/') ||
          isNumericPermissionShortcut(adapter.channelType, msg.text.trim(), msg.address.chatId)
        ) {
          await handleMessage(adapter, msg);
        } else {
          const binding = router.resolve(msg.address);
          if (state.sessionLocks.has(binding.codepilotSessionId)) {
            void notifyQueuedBehindActiveTurn(adapter, msg);
          }
          // Fire-and-forget into session lock — loop continues to accept
          // messages for other sessions immediately.
          processWithSessionLock(binding.codepilotSessionId, () =>
            handleMessage(adapter, msg),
          ).catch(err => {
            console.error(`[bridge-manager] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        failBridgeRuntimeRequest(err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
    }
  });
}

async function handleReminderCompleteCallback(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const reminderId = (msg.callbackData || '').replace(/^reminder:complete:/, '').trim();
  const reminders = getBridgeContext().reminders;
  if (!reminderId || !reminders?.completeReminder) {
    await deliver(adapter, {
      address: msg.address,
      text: '未完成：当前 bridge 没有加载统一提醒完成服务。',
      parseMode: 'plain',
      replyToMessageId: msg.callbackMessageId,
    });
    return;
  }

  const result = await reminders.completeReminder({
    reminderId,
    chatId: msg.address.chatId,
    completedByUserId: msg.address.userId,
    completionSource: 'feishu_card',
    callbackMessageId: msg.callbackMessageId,
  });
  const text = result.ok
    ? result.status === 'already_completed'
      ? `已完成：${result.title || reminderId} 此前已标记完成。`
      : `已完成：${result.title || reminderId}`
    : `未完成：${result.error || result.message || '提醒完成失败。'}`;

  await deliver(adapter, {
    address: msg.address,
    text,
    parseMode: 'plain',
    replyToMessageId: msg.callbackMessageId,
  });
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const { store } = getBridgeContext();
  recordBridgeRuntimeInbound(makeInboundSummary({
    messageId: msg.messageId,
    chatId: msg.address.chatId,
    channelType: adapter.channelType,
    displayName: msg.address.displayName || msg.address.userId || msg.address.chatId,
    text: msg.text,
    chatType: msg.address.chatType,
  }));
  let activeRequest = makeRequestSummary({
    messageId: msg.messageId,
    chatId: msg.address.chatId,
    channelType: adapter.channelType,
    displayName: msg.address.displayName || msg.address.userId || msg.address.chatId,
    text: msg.text,
    stage: 'message_received',
  });
  markBridgeRuntimeStage('message_received', { activeRequest });
  const rawData = msg.raw as {
    imageDownloadFailed?: boolean;
    attachmentDownloadFailed?: boolean;
    failedCount?: number;
    failedLabel?: string;
    userVisibleError?: string;
    feishuDocRequest?: {
      title: string;
      scopeText: string;
    };
    feishuConversationContext?: {
      prompt?: string;
      messageCount?: number;
      replyToMessageId?: string;
    };
    feishuHistoryContext?: {
      responseMode?: string;
      scopeText?: string;
      prompt?: string;
    };
    feishuSender?: {
      openId?: string;
      userId?: string;
      unionId?: string;
      chatType?: string;
    };
    messageKind?: string;
    sticker?: { known?: boolean };
  } | undefined;

  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);
  let auditTerminalState: 'completed' | 'failed' | null = null;

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (auditTerminalState !== 'failed') {
      completeBridgeRuntimeRequest(activeRequest);
      auditTerminalState = 'completed';
    }
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries (permission buttons)
  if (msg.callbackData) {
    if (msg.callbackData.startsWith('reminder:complete:')) {
      await handleReminderCompleteCallback(adapter, msg);
      ack();
      return;
    }
    const extensionCallback = parseExtensionCallback(msg.callbackData);
    if (extensionCallback) {
      await handleExtensionCallback(adapter, msg, extensionCallback);
      ack();
      return;
    }
    if (!hasRole(msg, 'operator')) {
      await deliver(adapter, {
        address: msg.address,
        text: buildRoleRequiredMessage(msg, 'operator'),
        parseMode: 'plain',
        replyToMessageId: msg.callbackMessageId,
      });
      ack();
      return;
    }
    const handled = broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId);
    if (handled) {
      // Send confirmation
      const confirmMsg: OutboundMessage = {
        address: msg.address,
        text: 'Permission response recorded.',
        parseMode: 'plain',
      };
      await deliver(adapter, confirmMsg);
    }
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = !!(msg.attachments && msg.attachments.length > 0);
  const ownerMessage = isOwnerMessage(msg);

  const inboundClaim = claimInboundForExecution(adapter, msg, rawText, hasAttachments);
  if (inboundClaim.duplicate) {
    console.warn('[bridge-manager] Duplicate inbound message ignored:', JSON.stringify({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      messageId: msg.messageId,
      reason: inboundClaim.reason,
    }));
    ack();
    return;
  }

  // Handle attachment-only download failures — surface error to user instead of silently dropping
  if (!rawText && !hasAttachments) {
    if (rawData?.userVisibleError) {
      await deliver(adapter, {
        address: msg.address,
        text: rawData.userVisibleError,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    } else if (rawData?.imageDownloadFailed || rawData?.attachmentDownloadFailed) {
      const failureLabel = rawData.failedLabel || (rawData.imageDownloadFailed ? 'image(s)' : 'attachment(s)');
      await deliver(adapter, {
        address: msg.address,
        text: `Failed to download ${rawData.failedCount ?? 1} ${failureLabel}. Please try sending again.`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  if (shouldTryFeishuOAuthManualCallback(adapter, rawText)) {
    const feishuOAuth = getBridgeContext().feishuOAuth;
    if (feishuOAuth) {
      const result = await feishuOAuth.handleManualCallbackText({
        text: rawText,
        channelType: adapter.channelType,
        chatId: msg.address.chatId,
        userId: msg.address.userId,
        userDisplayName: msg.address.displayName,
        messageId: msg.messageId,
      });
      if (result.status === 'bound' || result.status === 'error') {
        await deliver(adapter, {
          address: msg.address,
          text: result.userMessage?.trim() || result.error?.trim() || '飞书授权处理失败。',
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        });
        if (result.status === 'bound' && result.resume?.text?.trim()) {
          const resume = result.resume;
          const resumeMessage: InboundMessage = {
            messageId: `${resume.messageId || msg.messageId}:oauth-resume`,
            address: {
              ...msg.address,
              channelType: resume.channelType || adapter.channelType,
              chatId: resume.chatId || msg.address.chatId,
              userId: resume.userId || msg.address.userId,
              displayName: resume.userDisplayName || msg.address.displayName,
            },
            text: resume.text,
            timestamp: Date.now(),
          };
          await handleMessage(adapter, resumeMessage);
        }
        ack();
        return;
      }
    }
  }

  const shutdownActionKey = makeSystemActionKey(adapter.channelType, msg.address.chatId, msg.address.userId?.trim() || '');
  const pendingSystemActions = getPendingSystemActions();
  const pendingShutdown = pendingSystemActions.get(shutdownActionKey);
  if (pendingShutdown && pendingShutdown.expiresAt <= Date.now()) {
    pendingSystemActions.delete(shutdownActionKey);
  }

  if (isShutdownConfirmation(rawText)) {
    if (!ownerMessage) {
      await deliver(adapter, {
        address: msg.address,
        text: buildOwnerRequiredMessage(msg),
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }
    const currentPending = pendingSystemActions.get(shutdownActionKey);
    if (!currentPending || currentPending.type !== 'shutdown') {
      await deliver(adapter, {
        address: msg.address,
        text: '当前没有待确认的关机请求。请先发送“关机”。',
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }
    pendingSystemActions.delete(shutdownActionKey);
    await deliver(adapter, {
      address: msg.address,
      text: '确认关机。正在执行 shutdown /s /t 0。',
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    ack();
    setTimeout(() => {
      executeConfirmedShutdown(msg).catch((error) => {
        console.error('[bridge-manager] Failed to execute confirmed shutdown:', error);
        failBridgeRuntimeRequest(error, activeRequest);
      });
    }, 800);
    return;
  }

  if (isShutdownRequest(rawText)) {
    if (!ownerMessage) {
      await deliver(adapter, {
        address: msg.address,
        text: buildOwnerRequiredMessage(msg),
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }
    pendingSystemActions.set(shutdownActionKey, {
      type: 'shutdown',
      chatId: msg.address.chatId,
      channelType: adapter.channelType,
      userId: msg.address.userId?.trim() || '',
      sourceMessageId: msg.messageId,
      requestedAt: Date.now(),
      expiresAt: Date.now() + SYSTEM_ACTION_CONFIRM_TTL_MS,
    });
    store.insertAuditLog({
      channelType: msg.address.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: '收到关机请求，等待二次确认',
    });
    await deliver(adapter, {
      address: msg.address,
      text: buildShutdownConfirmPrompt(),
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    ack();
    return;
  }

  // ── Numeric shortcut for permission replies (feishu/qq/weixin only) ──
  // On mobile, typing `/perm allow <uuid>` is painful.
  // If the user sends "1", "2", or "3" and there is exactly one pending
  // permission for this chat, map it: 1→allow, 2→allow_session, 3→deny.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (
    adapter.channelType === 'feishu'
    || adapter.channelType === 'qq'
    || adapter.channelType === 'weixin'
  ) {
    // eslint-disable-next-line no-control-regex
    const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (/^[123]$/.test(normalized)) {
      const pendingLinks = store.listPendingPermissionLinksByChat(msg.address.chatId);
      if (pendingLinks.length === 1) {
        if (!hasRole(msg, 'operator')) {
          await deliver(adapter, {
            address: msg.address,
            text: buildRoleRequiredMessage(msg, 'operator'),
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
          ack();
          return;
        }
        const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
        const action = actionMap[normalized];
        const permId = pendingLinks[0].permissionRequestId;
        const callbackData = `perm:${action}:${permId}`;
        const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
        const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
        if (handled) {
          await deliver(adapter, {
            address: msg.address,
            text: `${label}: recorded.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        } else {
          await deliver(adapter, {
            address: msg.address,
            text: `Permission not found or already resolved.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        }
        ack();
        return;
      }
      if (pendingLinks.length > 1) {
        // Multiple pending permissions — numeric shortcut is ambiguous.
        await deliver(adapter, {
          address: msg.address,
          text: `Multiple pending permissions (${pendingLinks.length}). Please use the full command:\n/perm allow|allow_session|deny <id>`,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        });
        ack();
        return;
      }
      // pendingLinks.length === 0: no pending permissions, fall through as normal message
    } else if (rawText !== normalized && /^[123]$/.test(rawText) === false) {
      // Log when normalization changed the text — helps diagnose encoding issues
      const codePoints = [...rawText].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      console.log(`[bridge-manager] Shortcut candidate raw codepoints: ${codePoints.join(' ')} → normalized: "${normalized}"`);
    }
  }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (rawText.startsWith('/')) {
    await handleCommand(adapter, msg, rawText);
    ack();
    return;
  }

  if (adapter.channelType === 'feishu') {
    const extensionIntent = parseNaturalExtensionIntent(rawText);
    if (extensionIntent) {
      if (extensionIntent.action === 'search') {
        const { extensions } = getBridgeContext();
        const response = extensions
          ? renderExtensionSearchResults(extensionIntent.query, await extensions.searchExtensions(extensionIntent.query))
          : '面板未在线或扩展安装能力不可用。';
        await deliver(adapter, {
          address: msg.address,
          text: response,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        });
      } else {
        await prepareExtensionInstall(adapter, msg, extensionIntent.query);
      }
      ack();
      return;
    }
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  // Regular message — route to conversation engine
  if (adapter.channelType === 'feishu' && isFeishuDocumentListRequest(rawText)) {
    await deliver(adapter, {
      address: msg.address,
      text: renderFeishuDocumentMemoryList(store),
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    ack();
    return;
  }

  if (isDangerousUserRequest(rawText) && !ownerMessage) {
    await deliver(adapter, {
      address: msg.address,
      text: buildOwnerRequiredMessage(msg),
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    ack();
    return;
  }

  const binding = router.resolve(msg.address);
  const adapterIdentity = adapter.getAssistantIdentity?.() ?? null;
  const adapterIdentityPrompt = buildAdapterAssistantIdentityPrompt(adapter, msg.address);
  let processingCardStarted = false;
  const startProcessingCard = () => {
    if (processingCardStarted) return;
    processingCardStarted = true;
    adapter.onMessageStart?.(msg.address.chatId);
  };
  const endProcessingCard = () => {
    if (!processingCardStarted) return;
    processingCardStarted = false;
    adapter.onMessageEnd?.(msg.address.chatId);
  };
  if (!hasAttachments && await tryHandleNaturalDirectReminder(adapter, msg, binding, rawText)) {
    ack();
    return;
  }

  const smallTalkReply = !hasAttachments ? buildSmallTalkReply(rawText, adapterIdentity) : '';
  if (smallTalkReply) {
    store.addMessage(binding.codepilotSessionId, 'user', text || rawText);
    store.addMessage(binding.codepilotSessionId, 'assistant', smallTalkReply);
    recordConversationMemoryEvent(msg, binding, 'user', text || rawText);
    recordConversationMemoryEvent(msg, binding, 'assistant', smallTalkReply);
    await deliverResponse(adapter, msg.address, smallTalkReply, binding.codepilotSessionId, msg.messageId);
    ack();
    return;
  }

  if (!hasAttachments && await tryHandleModelPlannedMemoryWrite(adapter, msg, binding, text || rawText, rawText)) {
    ack();
    return;
  }

  let memoryRecallExtraSystemPrompt = '';
  let memoryReviewContext: Pick<AnswerReviewInput, 'memoryPlan' | 'memoryHits'> = {};
  const preExecutionProgressSteps: string[] = [];
  if (!hasAttachments && isMemoryRecallRequestText(rawText) && store.decideMemoryReply) {
    const memoryDecision = store.decideMemoryReply({
      sessionId: binding.codepilotSessionId,
      channelType: binding.channelType,
      chatId: binding.chatId,
      userId: msg.address.userId,
      userDisplayName: msg.address.displayName,
      workingDirectory: binding.workingDirectory || store.getSession(binding.codepilotSessionId)?.working_directory || undefined,
      query: rawText,
      recentHistoryLimit: 0,
    });
    memoryReviewContext = {
      memoryPlan: memoryDecision.plan,
      memoryHits: memoryDecision.type === 'direct_reply'
        ? [memoryDecision.hit]
        : memoryDecision.type === 'augment_codex'
          ? memoryDecision.memory?.hits || []
          : [],
    };
    memoryRecallExtraSystemPrompt = buildMemoryDecisionAgentPrompt(memoryDecision);
    if (memoryDecision.type === 'direct_reply') {
      preExecutionProgressSteps.push('检索到相关记忆，交给 agent 按记忆证据整理最终回复。');
    } else if (memoryDecision.type === 'no_memory_answer') {
      preExecutionProgressSteps.push('已检查本地记忆，没有找到可靠命中，交给 agent 明确收口。');
    } else if (memoryDecision.memory?.hits?.length) {
      preExecutionProgressSteps.push('检索到相关记忆上下文，交给 agent 结合当前问题整理。');
    }
  }

  const turnWorkspaceOverride = detectWorkspaceOverrideFromText(rawText, ownerMessage);
  if (turnWorkspaceOverride && turnWorkspaceOverride !== binding.workingDirectory && !ownerMessage) {
    endProcessingCard();
    await deliver(adapter, {
      address: msg.address,
      text: buildOwnerRequiredMessage(msg),
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    ack();
    return;
  }
  const effectiveBinding = turnWorkspaceOverride && turnWorkspaceOverride !== binding.workingDirectory
    ? { ...binding, workingDirectory: turnWorkspaceOverride, sdkSessionId: '' }
    : binding;
  activeRequest = {
    ...activeRequest,
    chatId: msg.address.chatId,
    displayName: msg.address.displayName || msg.address.userId || msg.address.chatId,
  };
  updateBridgeRuntimeActiveRequest(activeRequest, 'message_bound');
  const usesTransientWorkspaceOverride = effectiveBinding.workingDirectory !== binding.workingDirectory;
  const accessibleWorkspaceDirectories = getAccessibleWorkspaceDirectories(
    effectiveBinding.workingDirectory || store.getSession(effectiveBinding.codepilotSessionId)?.working_directory || '',
  );
  if (effectiveBinding.id && effectiveBinding.sdkSessionId && shouldForceFreshThreadForFastPath(rawText)) {
    try {
      store.updateChannelBinding(effectiveBinding.id, { sdkSessionId: '' });
      effectiveBinding.sdkSessionId = '';
    } catch {
      // best effort
    }
  }
  const directFeishuDocRequest =
    adapter.channelType === 'feishu'
    && (isFeishuDocGenerationRequest(rawText) || isFeishuDocGenerationRequestStrict(rawText))
    && !rawData?.feishuDocRequest;
  const directCommandRequest = parseDirectCommandRequest(rawText);
  let feishuCloudSystemPrompt = '';

  if (!directFeishuDocRequest && shouldTryFeishuCloudLinkResolve(adapter, rawText)) {
    const feishuCloudDocuments = getBridgeContext().feishuCloudDocuments;
    if (feishuCloudDocuments) {
      const feishuSender = rawData?.feishuSender;
      const resolved = await feishuCloudDocuments.resolveFeishuCloudLinks({
        text: rawText,
        channelType: adapter.channelType,
        chatId: msg.address.chatId,
        userId: feishuSender?.openId || msg.address.userId,
        userDisplayName: msg.address.displayName,
        messageId: msg.messageId,
      });
      if (resolved.status === 'resolved' && resolved.systemPrompt) {
        feishuCloudSystemPrompt = resolved.systemPrompt;
      } else if (resolved.status === 'auth_required' || resolved.status === 'permission_denied' || resolved.status === 'error') {
        endProcessingCard();
        await deliver(adapter, {
          address: msg.address,
          text: buildFeishuCloudBlockerMessage(resolved),
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
          feishuCardJson: resolved.feishuCardJson,
        }, { sessionId: effectiveBinding.codepilotSessionId });
        ack();
        return;
      }
    } else {
      console.warn('[bridge-manager] Feishu cloud link detected, but cloud document host is not configured.');
    }
  }

  if (directCommandRequest) {
    if (directCommandRequest.mutating && !isOwnerMessage(msg)) {
      endProcessingCard();
      await deliver(adapter, {
        address: msg.address,
        text: buildOwnerRequiredMessage(msg),
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }
    const workingDirectory = effectiveBinding.workingDirectory || store.getSession(effectiveBinding.codepilotSessionId)?.working_directory || '';
    const result = await executeDirectCommand(directCommandRequest, workingDirectory);
    store.addMessage(effectiveBinding.codepilotSessionId, 'user', rawText);
    store.addMessage(effectiveBinding.codepilotSessionId, 'assistant', result.text);
    recordConversationMemoryEvent(msg, effectiveBinding, 'user', rawText);
    recordConversationMemoryEvent(msg, effectiveBinding, 'assistant', result.text);
    if (effectiveBinding.id) {
      try {
        store.updateChannelBinding(effectiveBinding.id, { sdkSessionId: '' });
      } catch {
        // best effort
      }
    }
    endProcessingCard();
    await deliverResponse(adapter, msg.address, result.text, effectiveBinding.codepilotSessionId, msg.messageId);
    ack();
    return;
  }

  if (feishuCloudSystemPrompt && !directFeishuDocRequest && shouldUseFeishuCloudDirectSummary(rawText)) {
    const summary = buildFeishuCloudDirectSummary(feishuCloudSystemPrompt);
    if (summary) {
      store.addMessage(effectiveBinding.codepilotSessionId, 'user', rawText);
      store.addMessage(effectiveBinding.codepilotSessionId, 'assistant', summary);
      recordConversationMemoryEvent(msg, effectiveBinding, 'user', rawText);
      recordConversationMemoryEvent(msg, effectiveBinding, 'assistant', summary);
      endProcessingCard();
      await deliverResponse(
        adapter,
        msg.address,
        appendReplyEndMarker(summary),
        effectiveBinding.codepilotSessionId,
        msg.messageId,
        true,
        'Markdown',
      );
      ack();
      return;
    }
  }

  if (adapter.channelType === 'feishu' && rawData?.feishuHistoryContext?.responseMode === 'chat') {
    const directHistoryReply = buildFeishuHistoryDirectReply(rawData.feishuHistoryContext.prompt || text || '');
    if (directHistoryReply) {
      store.addMessage(effectiveBinding.codepilotSessionId, 'user', rawText);
      store.addMessage(effectiveBinding.codepilotSessionId, 'assistant', directHistoryReply);
      recordConversationMemoryEvent(msg, effectiveBinding, 'user', rawText);
      recordConversationMemoryEvent(msg, effectiveBinding, 'assistant', directHistoryReply);
      endProcessingCard();
      await deliverResponse(
        adapter,
        msg.address,
        appendReplyEndMarker(directHistoryReply),
        effectiveBinding.codepilotSessionId,
        msg.messageId,
        true,
        'Markdown',
      );
      ack();
      return;
    }
  }

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  const state = getState();
  state.activeTasks.set(effectiveBinding.codepilotSessionId, taskAbort);
  const progressPulse = await startProgressPulse(adapter, msg, effectiveBinding.codepilotSessionId);
  updateBridgeRuntimeActiveRequest(activeRequest, 'engine_started');
  const directFeishuDocSourceMarkdown = directFeishuDocRequest
    ? extractAssistantMarkdown(
      [...store.getMessages(effectiveBinding.codepilotSessionId, { limit: 20 }).messages]
        .reverse()
        .find((entry) => entry.role === 'assistant')?.content || '',
    )
    : '';
  const feishuDocRequest = rawData?.feishuDocRequest ?? (
    directFeishuDocRequest
      ? { title: undefined, scopeText: '上一条回复整理' }
      : undefined
  );
  const feishuConversationContextPrompt = rawData?.feishuConversationContext?.prompt?.trim() || '';
  const inboundMessageKind = getInboundMessageKind(msg, rawData);
  const isStickerMessage = isFeishuStickerMessageKind(inboundMessageKind);
  const currentMessageEvidenceAttachments = hasAttachments && !isStickerMessage ? msg.attachments : undefined;
  const recentConversationAttachments = !hasAttachments && shouldAttachRecentConversationMedia(text || rawText)
    ? loadRecentConversationImageAttachments(store.getMessages(effectiveBinding.codepilotSessionId, { limit: 12 }).messages, 1)
    : [];
  const executionEvidenceAttachments = currentMessageEvidenceAttachments ?? (
    recentConversationAttachments.length > 0 ? recentConversationAttachments : undefined
  );
  const providerAttachments = hasAttachments
    ? msg.attachments
    : recentConversationAttachments.length > 0
      ? recentConversationAttachments
      : undefined;
  const recentConversationMediaPrompt = recentConversationAttachments.length > 0
    ? [
      'Recent conversation media context:',
      '- The image attachment(s) on this turn were recovered from earlier messages in the same chat because the current user message appears to refer back to prior media.',
      '- Treat them as the referenced conversation context. Do not ask the user to resend the image unless the attached media is insufficient or unreadable.',
      '- If multiple interpretations are possible, state the assumption briefly and answer the user request.',
    ].join('\n')
    : '';
  const uiExecutionRequirement = classifyExecutionRequirement({
    userText: text || rawText,
    workingDirectory: effectiveBinding.workingDirectory || store.getSession(effectiveBinding.codepilotSessionId)?.working_directory || undefined,
    files: executionEvidenceAttachments,
    memoryPlan: memoryReviewContext.memoryPlan,
    messageKind: inboundMessageKind,
  });
  if (directFeishuDocRequest && !directFeishuDocSourceMarkdown) {
    progressPulse?.stop();
    await deliver(adapter, {
      address: msg.address,
      text: '当前会话里没有可整理成飞书文档的上一条有效回复。先让我产出一段总结或正文，再让我生成飞书文档。',
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    }, { sessionId: effectiveBinding.codepilotSessionId });
    ack();
    return;
  }

  // ── Streaming preview setup ──────────────────────────────────
  const supportsStreamingCards = !feishuDocRequest && typeof adapter.onStreamText === 'function';
  const replySurfaceMode = selectReplySurfaceMode({
    supportsStreamingCards,
    feishuDocRequest: Boolean(feishuDocRequest),
    messageKind: inboundMessageKind,
    hasMemoryProgress: preExecutionProgressSteps.length > 0,
    textLength: (text || rawText || '').length,
  });
  const hasStreamingCards = replySurfaceMode === 'workflow_card';
  const hasLightStatusCard = replySurfaceMode === 'light_status';
  let previewState: StreamingPreviewState | null = null;
  const caps = (feishuDocRequest || supportsStreamingCards) ? null : (adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null);
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;

  // Build the preview onPartialText callback (or undefined if preview not supported)
  const previewOnPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;

    // Truncate to maxChars + ellipsis
    ps.pendingText = fullText.length > cfg.maxChars
      ? fullText.slice(0, cfg.maxChars) + '...'
      : fullText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      // Not enough new content — schedule trailing-edge timer if not already set
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      // Too soon — schedule trailing-edge timer to ensure latest text is sent
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    // Clear any pending trailing-edge timer and flush immediately
    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  // ── Streaming card setup (Feishu CardKit v2) ──────────────────
  // If the adapter supports streaming cards (e.g. Feishu), wire up
  // onStreamText, onToolEvent, and onStreamEnd callbacks.
  // These run in parallel with the existing preview system — Feishu
  // uses cards instead of message edit for streaming.
  const toolCallTracker = new Map<string, ToolCallInfo>();
  const progressCardSteps: string[] = [];
  let providerProgressText = '';
  let lightStatusTimer: ReturnType<typeof setTimeout> | null = null;
  let lightStatusCardStarted = false;
  let workflowCardStarted = hasStreamingCards;
  const clearLightStatusTimer = () => {
    if (lightStatusTimer) {
      clearTimeout(lightStatusTimer);
      lightStatusTimer = null;
    }
  };
  if (hasLightStatusCard && typeof adapter.onStreamText === 'function') {
    lightStatusTimer = setTimeout(() => {
      lightStatusTimer = null;
      lightStatusCardStarted = true;
      try { adapter.onStreamText!(msg.address.chatId, '正在回复…'); } catch { /* non-critical */ }
    }, 1200);
  }

  const ensureWorkflowCard = (): boolean => {
    if (isFeishuStickerMessageKind(inboundMessageKind)) return false;
    if (!supportsStreamingCards || typeof adapter.onStreamText !== 'function') return false;
    clearLightStatusTimer();
    if (!workflowCardStarted) {
      workflowCardStarted = true;
      startProcessingCard();
    }
    return true;
  };

  const renderProgressCardText = (): string => {
    const detail = sanitizeProgressCardDetail(providerProgressText);
    return progressCardSteps[progressCardSteps.length - 1] || detail || '正在处理当前请求。';
  };

  const emitProgressCardStep = supportsStreamingCards ? (step: string) => {
    const normalized = step.replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    if (!ensureWorkflowCard()) return;
    if (progressCardSteps[progressCardSteps.length - 1] !== normalized) progressCardSteps.push(normalized);
    try { adapter.onStreamText!(msg.address.chatId, renderProgressCardText()); } catch { /* non-critical */ }
  } : undefined;

  const onStreamCardText = supportsStreamingCards ? (fullText: string) => {
    providerProgressText = fullText;
    if (!sanitizeProgressCardDetail(providerProgressText)) return;
    if (!ensureWorkflowCard()) return;
    try { adapter.onStreamText!(msg.address.chatId, renderProgressCardText()); } catch { /* non-critical */ }
  } : undefined;

  const onToolEvent = supportsStreamingCards ? (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => {
    if (!ensureWorkflowCard()) return;
    if (toolName) {
      toolCallTracker.set(toolId, { id: toolId, name: toolName, status });
    } else {
      // tool_result doesn't carry name — update existing entry's status
      const existing = toolCallTracker.get(toolId);
      if (existing) existing.status = status;
    }
    try {
      adapter.onToolEvent!(msg.address.chatId, Array.from(toolCallTracker.values()));
    } catch { /* non-critical */ }
    const visibleToolName = formatVisibleToolName(toolName || toolCallTracker.get(toolId)?.name || '') || '工具';
    const providerDetail = sanitizeProgressCardDetail(providerProgressText);
    if (providerDetail && /^(?:MCP 工具执行|工具执行)$/u.test(visibleToolName)) return;
    const statusText = status === 'running' ? '正在执行' : status === 'complete' ? '已返回结果' : '执行失败';
    emitProgressCardStep?.(`${visibleToolName} ${statusText}。`);
  } : undefined;

  // Combined partial text callback: streaming preview + streaming cards
  const onPartialText = (previewOnPartialText || onStreamCardText) ? (fullText: string) => {
    if (previewOnPartialText) previewOnPartialText(fullText);
    if (onStreamCardText) onStreamCardText(fullText);
  } : undefined;

  for (const step of preExecutionProgressSteps) emitProgressCardStep?.(step);

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use text or empty string for image-only messages (prompt is still required by streamClaude)
    const basePromptText = directFeishuDocRequest
      ? buildFeishuDocumentRewritePrompt(directFeishuDocSourceMarkdown, rawText)
      : isStickerMessage
        ? buildStickerChatPrompt(text || rawText, Boolean(providerAttachments?.length))
        : (text || (providerAttachments?.length ? buildImageOnlyIntentPrompt() : ''));
    let fastPathOptions = getFastPathOptions(rawText);
    const providerMemoryMode: engine.ConversationProcessOptions['memoryMode'] = memoryRecallExtraSystemPrompt
      ? 'recall'
      : uiExecutionRequirement.kind !== 'none'
        ? 'augment'
        : 'off';
    if (
      providerMemoryMode === 'off'
      && typeof fastPathOptions.historyLimit !== 'number'
      && !providerAttachments?.length
    ) {
      fastPathOptions = {
        ...fastPathOptions,
        historyLimit: 4,
      };
    }
    if (memoryRecallExtraSystemPrompt) {
      fastPathOptions = {
        ...fastPathOptions,
        historyLimit: 0,
        extraSystemPrompt: [fastPathOptions.extraSystemPrompt, memoryRecallExtraSystemPrompt].filter(Boolean).join('\n\n'),
      };
    }
    if (!feishuCloudSystemPrompt && !directFeishuDocRequest && shouldTryFeishuCloudLinkResolve(adapter, rawText)) {
      const feishuCloudDocuments = getBridgeContext().feishuCloudDocuments;
      if (feishuCloudDocuments) {
        const feishuSender = rawData?.feishuSender;
        const resolved = await feishuCloudDocuments.resolveFeishuCloudLinks({
          text: rawText,
          channelType: adapter.channelType,
          chatId: msg.address.chatId,
          userId: feishuSender?.openId || msg.address.userId,
          userDisplayName: msg.address.displayName,
          messageId: msg.messageId,
        });
        if (resolved.status === 'resolved' && resolved.systemPrompt) {
          feishuCloudSystemPrompt = resolved.systemPrompt;
        } else if (resolved.status === 'auth_required' || resolved.status === 'permission_denied' || resolved.status === 'error') {
          progressPulse?.stop();
          await deliver(adapter, {
            address: msg.address,
            text: buildFeishuCloudBlockerMessage(resolved),
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
            feishuCardJson: resolved.feishuCardJson,
          }, { sessionId: effectiveBinding.codepilotSessionId });
          ack();
          return;
        }
      }
    }
    if (shouldUseUnityQuickActionFastPath(rawText)) {
      const unityMcpCheck = await ensureUnityMcpReady(
        effectiveBinding.workingDirectory || store.getSession(effectiveBinding.codepilotSessionId)?.working_directory || process.cwd(),
      );
      const precheckPrompt = [
        'Unity MCP precheck (factual runtime diagnostics):',
        unityMcpCheck.summary,
        'Use these diagnostics as ground truth for this turn.',
        unityMcpCheck.ok
          ? 'Unity MCP endpoint is reachable; proceed with the requested Unity operation.'
          : 'Unity MCP precheck is not fully healthy, but do not stop here. Continue the turn, run concrete diagnostics or repair commands when safe, and only report failure after at least one additional actionable attempt.',
      ].join('\n');
      fastPathOptions = {
        ...fastPathOptions,
        extraSystemPrompt: [fastPathOptions.extraSystemPrompt, precheckPrompt].filter(Boolean).join('\n\n'),
      };
    }

    recordConversationMemoryEvent(msg, effectiveBinding, 'user', text || rawText);
    const providerPromptText = feishuCloudSystemPrompt && !directFeishuDocRequest
      ? buildFeishuCloudResolvedPrompt(rawText, feishuCloudSystemPrompt)
      : basePromptText;
    const result = await engine.processMessage(effectiveBinding, providerPromptText, async (perm) => {
      emitProgressCardStep?.(`等待 ${formatVisibleToolName(perm.toolName) || '工具'} 授权。`);
      updateBridgeRuntimeActiveRequest({
        permissionRequestId: perm.permissionRequestId,
        permissionType: perm.toolName,
        permissionStartedAt: new Date().toISOString(),
      }, 'permission_waiting');
      await broker.forwardPermissionRequest(
        adapter,
        msg.address,
        perm.permissionRequestId,
        perm.toolName,
        perm.toolInput,
        effectiveBinding.codepilotSessionId,
        perm.suggestions,
        msg.messageId,
      );
    }, taskAbort.signal, providerAttachments, onPartialText, onStreamCardText, onToolEvent, {
      storedUserText: text || rawText,
      historyLimit: fastPathOptions.historyLimit,
      memoryMode: providerMemoryMode,
      extraSystemPrompt: [adapterIdentityPrompt, fastPathOptions.extraSystemPrompt, feishuConversationContextPrompt, feishuCloudSystemPrompt, recentConversationMediaPrompt].filter(Boolean).join('\n\n'),
      memoryPlan: memoryReviewContext.memoryPlan,
      memoryUserId: msg.address.userId,
      memoryUserDisplayName: msg.address.displayName,
      sourceMessageId: msg.messageId,
      messageKind: inboundMessageKind,
    });
    updateBridgeRuntimeActiveRequest(activeRequest, 'provider_streaming');
    if (workflowCardStarted) {
      emitProgressCardStep?.('agent 已返回内容，正在核对证据和可展示结果。');
    }
    const resolvedWorkingDirectory =
      effectiveBinding.workingDirectory || store.getSession(effectiveBinding.codepilotSessionId)?.working_directory || '';
    const responseText = result.responseText
      ? await executeReminderActionFromReply(result.responseText, msg, effectiveBinding.codepilotSessionId, rawText)
      : '';
    let preparedReply = responseText
      ? await prepareBridgeReplyPayload(responseText, resolvedWorkingDirectory, accessibleWorkspaceDirectories, rawText)
      : null;
    if (preparedReply && !feishuDocRequest) {
      preparedReply = verifyPreparedReplyExecution(preparedReply, {
        userText: rawText,
        executionEvidence: result.executionEvidence,
        executionRequirement: uiExecutionRequirement,
        messageKind: inboundMessageKind,
      });
    }
    if (workflowCardStarted) {
      emitProgressCardStep?.('正在整理为最终回复。');
    }
    const userFacingResponseText = preparedReply?.text
      ? applyOutboundAnswerReview({
        channelType: adapter.channelType,
        chatId: msg.address.chatId,
        userId: msg.address.userId,
        userDisplayName: msg.address.displayName,
        messageId: msg.messageId,
        sessionId: effectiveBinding.codepilotSessionId,
        workingDirectory: resolvedWorkingDirectory,
        userText: rawText,
        answerText: preparedReply.text,
        ...memoryReviewContext,
        source: 'codex',
        executionEvidence: result.executionEvidence,
      })
      : '';
    const safeProviderErrorText = result.hasError
      ? buildSafeProviderErrorMessage(result.errorMessage || 'Unknown provider error', {
        cardFinalized: false,
        channelType: adapter.channelType,
      })
      : '';
    if (userFacingResponseText) {
      recordConversationMemoryEvent(msg, effectiveBinding, 'assistant', userFacingResponseText);
    } else if (safeProviderErrorText) {
      recordConversationMemoryEvent(msg, effectiveBinding, 'assistant', safeProviderErrorText);
    }

    // Finalize streaming card if adapter supports it.
    // onStreamEnd awaits any in-flight card creation and returns true if a card
    // was actually finalized (meaning content is already visible to the user).
    let cardFinalized = false;
    clearLightStatusTimer();
    if ((workflowCardStarted || lightStatusCardStarted) && adapter.onStreamEnd) {
      try {
        const status = result.hasError ? 'error' : 'completed';
        cardFinalized = await adapter.onStreamEnd(
          msg.address.chatId,
          status,
          userFacingResponseText || safeProviderErrorText,
          result.runSummary,
        );
      } catch (err) {
        console.warn('[bridge-manager] Card finalize failed:', err instanceof Error ? err.message : err);
      }
    }

    // Send response text — render via channel-appropriate format.
    // Skip if streaming card was finalized (content already in card).
    let handledAsDoc = false;
    if (feishuDocRequest && adapter.channelType === 'feishu' && responseText) {
      const createDoc = (adapter as BaseChannelAdapter & {
        createDocumentFromMarkdown?: (markdown: string, options?: { title?: string; ownerUserId?: string }) => Promise<{ documentId?: string; title: string; url: string }>;
      }).createDocumentFromMarkdown;

        if (typeof createDoc === 'function') {
          try {
            const docInfo = await createDoc.call(adapter, userFacingResponseText || responseText, {
              title: feishuDocRequest.title && !isGenericFeishuDocumentTitle(feishuDocRequest.title)
              ? feishuDocRequest.title
              : undefined,
            ownerUserId: getConfiguredOwnerIds(adapter.channelType)[0],
          });
          recordFeishuDocumentMemory(store, {
            title: docInfo.title,
            url: docInfo.url,
            documentId: docInfo.documentId,
            chatId: msg.address.chatId,
            requesterId: msg.address.userId,
            workspace: resolvedWorkingDirectory,
            sourceText: rawText,
            markdown: userFacingResponseText || responseText,
          });
          const guideInfo = await syncFeishuDocumentGuideBestEffort(
            adapter,
            store,
            getConfiguredOwnerIds(adapter.channelType)[0],
          );
          handledAsDoc = true;
          if (false) {
          await deliver(adapter, {
            address: msg.address,
            text: `已生成飞书文档《${docInfo.title}》\n${docInfo.url}`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          }, { sessionId: effectiveBinding.codepilotSessionId });
          }
          await deliver(adapter, {
            address: msg.address,
            text: guideInfo
              ? `已生成飞书文档《${docInfo.title}》\n${docInfo.url}\n\n文档导览已更新：${guideInfo.url}`
              : `已生成飞书文档《${docInfo.title}》\n${docInfo.url}`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          }, { sessionId: effectiveBinding.codepilotSessionId });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          await deliver(adapter, {
            address: msg.address,
            text: `飞书文档创建失败：${errorMessage}`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          }, { sessionId: effectiveBinding.codepilotSessionId });
        }
      }
    }

    if (responseText) {
      if (!cardFinalized && !handledAsDoc) {
        updateBridgeRuntimeActiveRequest(activeRequest, 'reply_sending');
        await deliverResponse(
          adapter,
          msg.address,
          userFacingResponseText,
          effectiveBinding.codepilotSessionId,
          preparedReply?.replyTo || msg.messageId,
          true,
          preparedReply?.parseMode,
          preparedReply?.mentions,
        );
      }
      const localImagePaths = Array.from(new Set([
        ...(preparedReply?.images || []),
        ...extractLocalImagePaths(
          responseText,
          resolvedWorkingDirectory,
          accessibleWorkspaceDirectories,
        ),
      ]));
      const localFilePaths = Array.from(new Set(preparedReply?.files || []));
      if (localImagePaths.length > 0 && typeof adapter.sendLocalImage === 'function') {
        for (const imagePath of localImagePaths.slice(0, getAutoReplyImageLimit())) {
          const imageSend = await adapter.sendLocalImage(msg.address.chatId, imagePath, msg.messageId);
          if (!imageSend.ok) {
            console.warn(`[bridge-manager] Failed to send local image: ${imagePath}`, imageSend.error);
          }
        }
      }
      if (localFilePaths.length > 0) {
        if (typeof (adapter as BaseChannelAdapter & { sendLocalFile?: (chatId: string, filePath: string, replyToMessageId?: string) => Promise<SendResult>; }).sendLocalFile === 'function') {
          const failedLocalFiles: Array<{ name: string; error: string }> = [];
          const uploadedFileNotices: string[] = [];
          for (const filePath of localFilePaths) {
            const fileSend = await (adapter as BaseChannelAdapter & { sendLocalFile: (chatId: string, filePath: string, replyToMessageId?: string) => Promise<SendResult>; }).sendLocalFile(msg.address.chatId, filePath, msg.messageId);
            if (!fileSend.ok) {
              if (needsArtifactLinkDelivery(adapter, filePath, fileSend.error || '')) {
                try {
                  const artifactMode = getArtifactDeliveryConfig().mode;
                  if (artifactMode === 'feishu_docx' && adapter.channelType === 'feishu') {
                    const platformLink = await adapter.uploadLocalFileForLink(filePath);
                    if (!platformLink) {
                      throw new Error('飞书云文档未返回文档链接');
                    }
                    uploadedFileNotices.push(formatPlatformFileLinkNotice(platformLink, filePath));
                    continue;
                  }
                  const uploaded = uploadLocalArtifact(filePath);
                  uploadedFileNotices.push(formatArtifactLinkNotice(uploaded));
                  continue;
                } catch (uploadError) {
                  console.warn(`[bridge-manager] Failed to upload oversized file: ${filePath}`, uploadError instanceof Error ? uploadError.message : uploadError);
                  failedLocalFiles.push({
                    name: path.basename(filePath),
                    error: `超过飞书上传限制，且自动上传失败：${uploadError instanceof Error ? uploadError.message : String(uploadError)}`,
                  });
                  continue;
                }
              }
              console.warn(`[bridge-manager] Failed to send local file: ${filePath}`, fileSend.error);
              failedLocalFiles.push({
                name: path.basename(filePath),
                error: fileSend.error || 'unknown error',
              });
            }
          }
          if (uploadedFileNotices.length > 0) {
            await deliver(adapter, {
              address: msg.address,
              text: appendReplyEndMarker(uploadedFileNotices.join('\n\n')),
              parseMode: 'plain',
              replyToMessageId: msg.messageId,
            }, { sessionId: effectiveBinding.codepilotSessionId });
          }
          if (failedLocalFiles.length > 0) {
            await deliver(adapter, {
              address: msg.address,
              text: appendReplyEndMarker(`部分文件未能直接发送：\n${failedLocalFiles.map((file) => `- ${file.name}: ${file.error}`).join('\n')}`),
              parseMode: 'plain',
              replyToMessageId: msg.messageId,
            }, { sessionId: effectiveBinding.codepilotSessionId });
          }
        } else {
          await deliver(adapter, {
            address: msg.address,
            text: appendReplyEndMarker(`文件输出：\n${localFilePaths.map((filePath) => `- ${filePath}`).join('\n')}`),
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          }, { sessionId: effectiveBinding.codepilotSessionId });
        }
      }
    } else if (result.hasError) {
      if (!cardFinalized && safeProviderErrorText && shouldSendProviderErrorNotice({
        channelType: adapter.channelType,
        chatId: msg.address.chatId,
      })) {
        await deliver(adapter, {
          address: msg.address,
          text: safeProviderErrorText,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        }, { sessionId: effectiveBinding.codepilotSessionId });
      } else if (!cardFinalized) {
        try {
          store.insertAuditLog({
            channelType: adapter.channelType,
            chatId: msg.address.chatId,
            direction: 'outbound',
            messageId: '',
            summary: '[SUPPRESSED] Provider error notice suppressed by circuit breaker',
          });
        } catch { /* best effort */ }
      }
    }

    // Persist the actual SDK session ID for future resume.
    // If the result has an error and no session ID was captured, clear the
    // stale ID so the next message starts fresh instead of retrying a broken resume.
    if (effectiveBinding.id) {
      try {
        if (usesTransientWorkspaceOverride) {
          store.updateChannelBinding(effectiveBinding.id, { sdkSessionId: '' });
        } else {
          const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError, result.shouldRefreshSession);
          if (update !== null) {
            store.updateChannelBinding(effectiveBinding.id, { sdkSessionId: update });
          }
        }
      } catch { /* best effort */ }
    }
    auditTerminalState = 'completed';
  } catch (err) {
    auditTerminalState = 'failed';
    failBridgeRuntimeRequest(err, activeRequest);
    throw err;
  } finally {
    progressPulse?.stop();
    clearLightStatusTimer();

    // Clean up preview state
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }

    // If task was aborted and streaming card is still active, finalize as interrupted
    if ((workflowCardStarted || lightStatusCardStarted) && adapter.onStreamEnd && taskAbort.signal.aborted) {
      try {
        await adapter.onStreamEnd(msg.address.chatId, 'interrupted', '');
      } catch { /* best effort */ }
    }

    state.activeTasks.delete(effectiveBinding.codepilotSessionId);
    // Notify adapter that message processing ended
    adapter.onMessageEnd?.(msg.address.chatId);
    // Commit the offset only after full processing (success or failure)
    ack();
  }
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const { store } = getBridgeContext();

  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: `Command rejected: invalid input detected.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let response = '';

  switch (command) {
    case '/start':
      response = [
        '<b>CodePilot Bridge</b>',
        '',
        'Send any message to interact with Claude.',
        '',
        '<b>Commands:</b>',
        '/new [project_or_path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd &lt;project_or_path&gt; - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/whoami - Show current Feishu sender IDs',
        '/feishu - Show Feishu developer platform capability and scope diagnostics',
        '/docs - List generated Feishu documents',
        '/projects - List available workspaces',
        '/sessions - List recent sessions',
        '/remind 10分钟后 内容 - Create a bridge-managed reminder',
        '/ext search|install|remove <关键词或URL> - Manage extension catalog',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission',
        '/help - Show this help',
      ].join('\n');
      break;

    case '/remind': {
      const parsed = parseSlashReminderArgs(args);
      const reminders = getBridgeContext().reminders;
      if (!parsed) {
        response = '用法：/remind 10分钟后 看电脑，或 /remind 2026-04-29 19:42 看电脑';
        break;
      }
      if (!reminders) {
        response = '未完成：当前 bridge 没有加载统一提醒服务。';
        break;
      }
      const binding = router.resolve(msg.address);
      const result = await reminders.createDirectReminder({
        title: parsed.title,
        dueAt: parsed.dueAt,
        timezone: 'Asia/Shanghai',
        target: msg.address,
        sourcePrompt: text,
        createdByMessageId: msg.messageId,
        sessionId: binding.codepilotSessionId,
      });
      await reminders.tickReminders?.();
      response = buildReminderActionResultText(result);
      break;
    }

    case '/ext': {
      response = await handleExtensionCommand(adapter, msg, args);
      break;
    }

    case '/new': {
      // Abort any running task on the current session before creating a new one
      const oldBinding = router.resolve(msg.address);
      const st = getState();
      const oldTask = st.activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        oldTask.abort();
        st.activeTasks.delete(oldBinding.codepilotSessionId);
      }

      let workDir: string | undefined;
      if (args) {
        const resolved = resolveWorkspaceArgumentForMessage(args, msg);
        if (!resolved.path) {
          if (resolved.error === 'ambiguous' && resolved.matches) {
            response = `Workspace is ambiguous. Use an absolute path.\n${resolved.matches.map((entry) => `<code>${escapeHtml(entry)}</code>`).join('\n')}`;
          } else if (resolved.error === 'not_allowed') {
            response = 'Path is outside the configured workspace roots.';
          } else {
            response = 'Workspace not found. Use /projects to list available workspaces.';
          }
          break;
        }
        workDir = resolved.path;
      }
      const binding = router.createBinding(msg.address, workDir);
      response = `New session created.\nSession: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>\nCWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`;
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind &lt;session_id&gt;';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format. Expected a 32-64 character hex/UUID string.';
        break;
      }
      const binding = router.bindToSession(msg.address, args);
      if (binding) {
        response = `Bound to session <code>${args.slice(0, 8)}...</code>`;
      } else {
        response = 'Session not found.';
      }
      break;
    }

    case '/cwd': {
      if (!args) {
        response = 'Usage: /cwd <project_name_or_absolute_path>';
        break;
      }
      const resolved = resolveWorkspaceArgumentForMessage(args, msg);
      if (!resolved.path) {
        if (resolved.error === 'ambiguous' && resolved.matches) {
          response = `Workspace is ambiguous. Use an absolute path.\n${resolved.matches.map((entry) => `<code>${escapeHtml(entry)}</code>`).join('\n')}`;
        } else if (resolved.error === 'not_allowed') {
          response = 'Path is outside the configured workspace roots.';
        } else {
          response = 'Workspace not found. Use /projects to list available workspaces.';
        }
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { workingDirectory: resolved.path, sdkSessionId: '' });
      response = `Working directory set to <code>${escapeHtml(resolved.path)}</code>`;
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { mode: args });
      response = `Mode set to <b>${args}</b>`;
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      response = [
        '<b>Bridge Status</b>',
        '',
        `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        `Model: <code>${binding.model || 'default'}</code>`,
        `Additional dirs: <code>${escapeHtml(getConfiguredAdditionalDirectories().join(' | ') || '(none)')}</code>`,
      ].join('\n');
      break;
    }

    case '/whoami': {
      const sender = (msg.raw as { feishuSender?: { openId?: string; userId?: string; unionId?: string; chatType?: string } } | undefined)?.feishuSender;
      response = [
        '<b>Current Sender</b>',
        '',
        `channel: <code>${escapeHtml(msg.address.channelType)}</code>`,
        `chatId: <code>${escapeHtml(msg.address.chatId)}</code>`,
        `address.userId: <code>${escapeHtml(msg.address.userId || '')}</code>`,
        `open_id: <code>${escapeHtml(sender?.openId || '')}</code>`,
        `user_id: <code>${escapeHtml(sender?.userId || '')}</code>`,
        `union_id: <code>${escapeHtml(sender?.unionId || '')}</code>`,
        `chat_type: <code>${escapeHtml(sender?.chatType || '')}</code>`,
        `role: <b>${escapeHtml(getPermissionRoleForMessage(msg) || 'none')}</b>`,
        `operator: <b>${hasRole(msg, 'operator') ? 'yes' : 'no'}</b>`,
        `owner: <b>${isOwnerMessage(msg) ? 'yes' : 'no'}</b>`,
      ].join('\n');
      break;
    }

    case '/feishu': {
      if (!isOwnerMessage(msg)) {
        response = escapeHtml(buildOwnerRequiredMessage(msg));
        break;
      }
      response = escapeHtml(buildFeishuCapabilityReport(store));
      break;
    }

    case '/docs': {
      response = escapeHtml(renderFeishuDocumentMemoryList(store));
      break;
    }

    case '/projects': {
      response = renderWorkspaceSummaryLines().join('\n');
      break;
    }

    case '/sessions': {
      const bindings = router.listBindings(adapter.channelType);
      if (bindings.length === 0) {
        response = 'No sessions found.';
      } else {
        const lines = ['<b>Sessions:</b>', ''];
        for (const b of bindings.slice(0, 10)) {
          const active = b.active ? 'active' : 'inactive';
          lines.push(`<code>${b.codepilotSessionId.slice(0, 8)}...</code> [${active}] ${escapeHtml(b.workingDirectory || '~')}`);
        }
        response = lines.join('\n');
      }
      break;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const st = getState();
      const taskAbort = st.activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        st.activeTasks.delete(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/perm': {
      if (!hasRole(msg, 'operator')) {
        response = escapeHtml(buildRoleRequiredMessage(msg, 'operator'));
        break;
      }
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage: /perm allow <id> | /perm allow_session <id> | /perm deny <id>
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny &lt;permission_id&gt;';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
      if (handled) {
        response = `Permission ${permAction}: recorded.`;
      } else {
        response = `Permission not found or already resolved.`;
      }
      break;
    }

    case '/help':
      response = [
        '<b>CodePilot Bridge Commands</b>',
        '',
        '/new [project_or_path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd &lt;project_or_path&gt; - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/whoami - Show current Feishu sender IDs',
        '/feishu - Show Feishu developer platform capability and scope diagnostics',
        '/docs - List generated Feishu documents',
        '/projects - List available workspaces',
        '/sessions - List recent sessions',
        '/remind 10分钟后 内容 - Create a bridge-managed reminder',
        '/ext search|install|remove &lt;关键词或URL&gt; - Manage extension catalog',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission request',
        '1/2/3 - Quick permission reply (Feishu/QQ/WeChat, single pending)',
        '/help - Show this help',
      ].join('\n');
      break;

    default:
      response = `Unknown command: ${escapeHtml(command)}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: 'HTML',
      replyToMessageId: msg.messageId,
    });
  }
}

// ── SDK Session Update Logic ─────────────────────────────────

/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Rules:
 * - If result has sdkSessionId AND no error → save the new ID
 * - If result has error (regardless of sdkSessionId) → clear to empty string
 * - Otherwise → no update needed
 */
export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
  shouldRefreshSession = false,
): string | null {
  if (hasError || shouldRefreshSession) {
    return '';
  }
  if (sdkSessionId) {
    return sdkSessionId;
  }
  return null;
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = {
  handleMessage,
  isDangerousUserRequest,
  isShutdownRequest,
  isShutdownConfirmation,
  hasRole,
  getPermissionRoleForMessage,
  isFeishuDocumentListRequest,
  isFeishuDocGenerationRequestStrict,
  selectReplySurfaceMode,
  notifyQueuedBehindActiveTurn,
  buildUnityScreenshotPolicyInstructions,
  sanitizeOutsourcedToolReply,
  buildSafeProviderErrorMessage,
  shouldSendProviderErrorNotice,
  resetProviderErrorCircuitBreaker,
  buildSmallTalkReply,
  extractCtiReminderAction,
  containsUnverifiedReminderCompletion,
  parseNaturalReminderRequest,
};
