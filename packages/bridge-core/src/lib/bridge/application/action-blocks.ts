import {
  parseArtifactPromotionRequest,
  type ArtifactPromotionRequest,
} from '@codex-im-suite/contracts';

import type { ConversationTargetKind } from '../channel-adapter.js';
import type { ScheduledTaskActionInput, ScheduledTaskScheduleInput } from '../host.js';
import type { OutboundMention, OutboundMessage } from '../types.js';

// 本模块只负责把模型动作块解析成候选数据；身份、权限、工作区、目标解析和真实执行
// 仍由 bridge-manager 与对应 Host 基于当前回合 evidence 重新裁决，不能信任动作块自带字段。
export const REMINDER_ACTION_FENCE = 'cti-reminder';
export const SCHEDULED_TASK_ACTION_FENCE = 'cti-scheduled-task';
export const DIRECT_MESSAGE_ACTION_FENCE = 'cti-direct-message';
export const BRIDGE_CONTROL_ACTION_FENCE = 'cti-bridge-control';
export const ARTIFACT_PROMOTION_ACTION_FENCE = 'cti-artifact-promote';

export interface CtiReminderAction {
  title: string;
  dueAt: string;
  timezone?: string;
  target: 'current_chat';
  notifyTargets?: OutboundMention[];
  sourcePrompt?: string;
}

export interface ExtractedReminderAction {
  action: CtiReminderAction | null;
  text: string;
}

export interface CtiScheduledTaskCreateAction {
  action: 'create';
  name: string;
  schedule: ScheduledTaskScheduleInput;
  taskAction: ScheduledTaskActionInput;
  deliveryMode: 'result' | 'summary' | 'none';
  ignoredTrustedFields: string[];
}

export interface ExtractedScheduledTaskAction {
  action: CtiScheduledTaskCreateAction | null;
  text: string;
  hadBlock: boolean;
  error?: string;
}

export interface CtiDirectMessageAction {
  targetText: string;
  targetId?: string;
  targetKind?: ConversationTargetKind | 'any';
  text: string;
  parseMode?: OutboundMessage['parseMode'];
}

export interface ExtractedDirectMessageAction {
  action: CtiDirectMessageAction | null;
  text: string;
  hadBlock: boolean;
  error?: string;
}

export interface CtiBridgeControlAction {
  action: 'restart_live';
}

export interface ExtractedBridgeControlAction {
  action: CtiBridgeControlAction | null;
  text: string;
  hadBlock: boolean;
  error?: string;
}

export interface ExtractedArtifactPromotionAction {
  action: ArtifactPromotionRequest | null;
  text: string;
  hadBlock: boolean;
  error?: string;
}

export interface ActionBlockParseOptions {
  parseMentions?: (value: unknown) => OutboundMention[] | undefined;
}

function buildFencePattern(fence: string): RegExp {
  return new RegExp(`(^|\\n)\\s*\`\`\`${fence}\\s*\\r?\\n([\\s\\S]*?)\\r?\\n\\s*\`\`\``, 'i');
}

function removeFence(text: string, pattern: RegExp): string {
  return text.replace(pattern, '$1').replace(/\n{3,}/gu, '\n\n').trim();
}

function getStringField(raw: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function getRecordField(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseScheduledTaskSchedule(value: unknown): ScheduledTaskScheduleInput | null {
  const raw = getRecordField(value);
  if (!raw) return null;
  const kind = getStringField(raw, ['kind']).toLowerCase();
  if (kind === 'at') {
    const at = getStringField(raw, ['at', 'dueAt', 'due_at']);
    const timezone = getStringField(raw, ['timezone', 'timeZone', 'tz']);
    return at && timezone ? { kind: 'at', at, timezone } : null;
  }
  if (kind === 'every') {
    const everyMs = Number(raw.everyMs ?? raw.every_ms);
    const anchorAt = getStringField(raw, ['anchorAt', 'anchor_at']);
    return Number.isFinite(everyMs) && everyMs > 0 && anchorAt
      ? { kind: 'every', everyMs: Math.floor(everyMs), anchorAt }
      : null;
  }
  if (kind === 'cron') {
    const expression = getStringField(raw, ['expression', 'cron']);
    const timezone = getStringField(raw, ['timezone', 'timeZone', 'tz']);
    return expression && timezone ? { kind: 'cron', expression, timezone } : null;
  }
  return null;
}

function parseScheduledTaskAction(value: unknown): ScheduledTaskActionInput | null {
  const raw = getRecordField(value);
  if (!raw) return null;
  const kind = getStringField(raw, ['kind']).toLowerCase();
  if (kind === 'notify') {
    const text = getStringField(raw, ['text', 'message', 'content']);
    return text ? { kind: 'notify', text } : null;
  }
  if (kind === 'agent_turn') {
    const prompt = getStringField(raw, ['prompt', 'text', 'request']);
    const sessionMode = getStringField(raw, ['sessionMode', 'session_mode']).toLowerCase();
    if (!prompt || (sessionMode !== 'isolated' && sessionMode !== 'bound')) return null;
    const timeoutMs = Number(raw.timeoutMs ?? raw.timeout_ms);
    return {
      kind: 'agent_turn',
      prompt,
      sessionMode,
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs: Math.floor(timeoutMs) } : {}),
    };
  }
  if (kind === 'controlled_tool') {
    const toolName = getStringField(raw, ['toolName', 'tool_name', 'name']);
    if (!toolName) return null;
    const timeoutMs = Number(raw.timeoutMs ?? raw.timeout_ms);
    return {
      kind: 'controlled_tool',
      toolName,
      input: raw.input ?? null,
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs: Math.floor(timeoutMs) } : {}),
    };
  }
  return null;
}

function collectIgnoredScheduledTaskFields(value: unknown): string[] {
  const ignoredNames = new Set([
    'actor', 'owner', 'role', 'userid', 'user_id', 'openid', 'open_id', 'chatid', 'chat_id',
    'target', 'delivery', 'sourcesessionid', 'source_session_id', 'workspaceid', 'workspace_id',
    'workspacemode', 'workspace_mode', 'workingdirectory', 'working_directory',
    'additionaldirectories', 'additional_directories', 'evidence', 'messageid', 'message_id',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>)
    .filter((key) => ignoredNames.has(key.replace(/[-\s]/gu, '_').toLowerCase()))
    .sort();
}

function parseDirectMessageParseMode(value: unknown): OutboundMessage['parseMode'] | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'markdown') return 'Markdown';
  if (normalized === 'html') return 'HTML';
  if (normalized === 'plain' || normalized === 'text') return 'plain';
  return undefined;
}

function parseConversationTargetKind(value: unknown): ConversationTargetKind | 'any' | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (/^(?:chat|group|channel|conversation|session|room|群|群聊|会话)$/u.test(normalized)) return 'chat';
  if (/^(?:user|person|member|private|p2p|dm|open_id|user_id|用户|成员|私聊|人)$/u.test(normalized)) return 'user';
  if (/^(?:any|auto|自动)$/u.test(normalized)) return 'any';
  return undefined;
}

export function extractCtiReminderAction(text: string, options: ActionBlockParseOptions = {}): ExtractedReminderAction {
  const fencePattern = buildFencePattern(REMINDER_ACTION_FENCE);
  const match = text.match(fencePattern);
  if (!match) return { action: null, text };
  const cleaned = removeFence(text, fencePattern);
  try {
    const parsed = JSON.parse(match[2].trim()) as Partial<CtiReminderAction> & { notify_targets?: unknown };
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
        notifyTargets: options.parseMentions?.(parsed.notifyTargets ?? parsed.notify_targets),
        sourcePrompt: typeof parsed.sourcePrompt === 'string' ? parsed.sourcePrompt.trim() : undefined,
      },
      text: cleaned,
    };
  } catch {
    return { action: null, text: cleaned };
  }
}

export function extractCtiScheduledTaskAction(text: string): ExtractedScheduledTaskAction {
  const fencePattern = buildFencePattern(SCHEDULED_TASK_ACTION_FENCE);
  const match = text.match(fencePattern);
  if (!match) return { action: null, text, hadBlock: false };
  const cleaned = removeFence(text, fencePattern);
  try {
    const parsed = JSON.parse(match[2].trim());
    const raw = getRecordField(parsed);
    if (!raw || getStringField(raw, ['action']).toLowerCase() !== 'create') {
      return { action: null, text: cleaned, hadBlock: true, error: '计划任务动作仅支持 create' };
    }
    const name = getStringField(raw, ['name', 'title']);
    const schedule = parseScheduledTaskSchedule(raw.schedule);
    const taskAction = parseScheduledTaskAction(raw.taskAction ?? raw.task_action);
    const requestedDeliveryMode = getStringField(raw, ['deliveryMode', 'delivery_mode']).toLowerCase();
    const deliveryMode = requestedDeliveryMode === 'summary' || requestedDeliveryMode === 'none'
      ? requestedDeliveryMode
      : 'result';
    if (!name || !schedule || !taskAction) {
      return { action: null, text: cleaned, hadBlock: true, error: '计划任务动作缺少 name、schedule 或 taskAction' };
    }
    return {
      action: {
        action: 'create',
        name,
        schedule,
        taskAction,
        deliveryMode,
        ignoredTrustedFields: collectIgnoredScheduledTaskFields(parsed),
      },
      text: cleaned,
      hadBlock: true,
    };
  } catch {
    return { action: null, text: cleaned, hadBlock: true, error: '计划任务动作 JSON 解析失败' };
  }
}

export function extractCtiDirectMessageAction(text: string): ExtractedDirectMessageAction {
  const fencePattern = buildFencePattern(DIRECT_MESSAGE_ACTION_FENCE);
  const match = text.match(fencePattern);
  if (!match) return { action: null, text, hadBlock: false };
  const cleaned = removeFence(text, fencePattern);
  try {
    const parsed = JSON.parse(match[2].trim()) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return { action: null, text: cleaned, hadBlock: true, error: '私发动作不是有效 JSON 对象' };
    }
    const raw = parsed as Record<string, unknown>;
    const nestedTarget = getRecordField(raw.target);
    const targetText = getStringField(raw, ['targetText', 'target', 'to', 'name', 'user', 'displayName'])
      || (nestedTarget ? getStringField(nestedTarget, ['displayName', 'display_name', 'name', 'label', 'targetText', 'text']) : '');
    const explicitTargetId = getStringField(raw, ['targetId', 'targetID', 'toId', 'toID', 'id', 'chatId', 'chat_id', 'sessionId', 'session_id', 'conversationId', 'conversation_id', 'receiveId', 'receive_id']);
    const nestedChatId = nestedTarget ? getStringField(nestedTarget, ['chatId', 'chat_id', 'sessionId', 'session_id', 'conversationId', 'conversation_id']) : '';
    const nestedUserId = nestedTarget ? getStringField(nestedTarget, ['openId', 'open_id', 'userId', 'user_id', 'unionId', 'union_id', 'id']) : '';
    // 模型同时给出显示名和 ID 时仍走当前回合 resolver，不能直接信任模型生成的 ID。
    const targetId = explicitTargetId || nestedChatId || (!targetText ? nestedUserId : '');
    const targetKind = parseConversationTargetKind(raw.targetKind ?? raw.target_type ?? raw.targetType ?? raw.kind ?? raw.type)
      || (nestedChatId ? 'chat' : (!targetText && nestedUserId ? 'user' : undefined));
    const body = getStringField(raw, ['text', 'message', 'content', 'body']);
    if ((!targetText && !targetId) || !body) {
      return { action: null, text: cleaned, hadBlock: true, error: '私发动作缺少 target 或 text' };
    }
    return {
      action: {
        targetText,
        targetId,
        targetKind,
        text: body,
        parseMode: parseDirectMessageParseMode(raw.parseMode ?? raw.parse_mode),
      },
      text: cleaned,
      hadBlock: true,
    };
  } catch {
    return { action: null, text: cleaned, hadBlock: true, error: '私发动作 JSON 解析失败' };
  }
}

export function extractCtiBridgeControlAction(text: string): ExtractedBridgeControlAction {
  const fencePattern = buildFencePattern(BRIDGE_CONTROL_ACTION_FENCE);
  const match = text.match(fencePattern);
  if (!match) return { action: null, text, hadBlock: false };
  const cleaned = removeFence(text, fencePattern);
  try {
    const parsed = JSON.parse(match[2].trim()) as Partial<CtiBridgeControlAction>;
    if (parsed.action !== 'restart_live') {
      return { action: null, text: cleaned, hadBlock: true, error: '不支持的 Bridge 控制动作' };
    }
    return { action: { action: 'restart_live' }, text: cleaned, hadBlock: true };
  } catch {
    return { action: null, text: cleaned, hadBlock: true, error: 'Bridge 控制动作 JSON 解析失败' };
  }
}

export function extractCtiArtifactPromotionAction(text: string): ExtractedArtifactPromotionAction {
  const fencePattern = buildFencePattern(ARTIFACT_PROMOTION_ACTION_FENCE);
  const match = text.match(fencePattern);
  if (!match) return { action: null, text, hadBlock: false };
  const cleaned = removeFence(text, fencePattern);
  try {
    const raw = getRecordField(JSON.parse(match[2].trim()) as unknown);
    if (!raw) return { action: null, text: cleaned, hadBlock: true, error: '产物提升动作不是有效 JSON 对象' };
    const allowedFields = new Set(['artifactId', 'targetProjectId', 'targetRelativePath', 'expectedSha256']);
    const unexpectedFields = Object.keys(raw).filter((key) => !allowedFields.has(key));
    if (unexpectedFields.length > 0) {
      return {
        action: null,
        text: cleaned,
        hadBlock: true,
        error: `产物提升动作包含不允许字段：${unexpectedFields.sort().join(', ')}`,
      };
    }
    return { action: parseArtifactPromotionRequest(raw), text: cleaned, hadBlock: true };
  } catch (error) {
    return {
      action: null,
      text: cleaned,
      hadBlock: true,
      error: `产物提升动作无效：${error instanceof Error ? error.message : 'JSON 解析失败'}`,
    };
  }
}
