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
  normalizedFields: string[];
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

export interface ScheduledTaskActionParseOptions {
  /** 相对时间只能在真实动作解析时刻落成绝对时间，测试可注入固定时钟。 */
  referenceTime?: string | number | Date;
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

interface ParsedScheduledTaskSchedule {
  schedule: ScheduledTaskScheduleInput | null;
  normalizedFields: string[];
  error?: string;
}

const EXPLICIT_OFFSET_SUFFIX_RE = /(?:Z|[+-]\d{2}:?\d{2})$/iu;

function getPositiveNumberField(
  raw: Record<string, unknown>,
  candidates: Array<{ key: string; multiplier: number }>,
): { valueMs: number; key: string } | null {
  for (const candidate of candidates) {
    const value = Number(raw[candidate.key]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const valueMs = value * candidate.multiplier;
    if (Number.isFinite(valueMs) && valueMs > 0) return { valueMs, key: candidate.key };
  }
  return null;
}

function resolveReferenceTime(value: ScheduledTaskActionParseOptions['referenceTime']): Date | null {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  return Number.isFinite(date.getTime()) ? date : null;
}

function parseScheduledTaskSchedule(
  value: unknown,
  options: ScheduledTaskActionParseOptions = {},
): ParsedScheduledTaskSchedule {
  if (typeof value === 'string') {
    // Codex occasionally emits the standard crontab inline timezone form instead
    // of the canonical object. Normalize only an explicit TZ assignment; a bare
    // cron string remains invalid because the Bridge must not guess a timezone.
    const match = /^(?:CRON_TZ|TZ)\s*=\s*([^\s]+)\s+([^\r\n]+)$/iu.exec(value.trim());
    if (!match) {
      return {
        schedule: null,
        normalizedFields: [],
        error: '计划任务 schedule 字符串缺少显式 CRON_TZ/TZ',
      };
    }
    const timezone = match[1].replace(/^["']|["']$/gu, '').trim();
    const expression = match[2].trim().replace(/\s+/gu, ' ');
    return timezone && expression
      ? {
          schedule: { kind: 'cron', expression, timezone },
          normalizedFields: ['schedule:string_cron->cron'],
        }
      : {
          schedule: null,
          normalizedFields: [],
          error: '计划任务 cron schedule 缺少 expression 或 timezone',
        };
  }
  const raw = getRecordField(value);
  if (!raw) {
    return { schedule: null, normalizedFields: [], error: '计划任务 schedule 必须是对象' };
  }
  const normalizedFields: string[] = [];
  const rawKind = getStringField(raw, ['kind', 'type']).toLowerCase();
  if (!getStringField(raw, ['kind']) && getStringField(raw, ['type'])) {
    normalizedFields.push('schedule.type->kind');
  }
  const kind = rawKind === 'once' || rawKind === 'one_time' || rawKind === 'one-time'
    ? 'at'
    : rawKind === 'interval'
      ? 'every'
      : rawKind;
  if (kind !== rawKind && rawKind) normalizedFields.push(`schedule.kind:${rawKind}->${kind}`);
  if (kind === 'at') {
    const atKeys = ['at', 'dueAt', 'due_at', 'datetime', 'dateTime', 'date_time', 'runAt', 'run_at'];
    const at = getStringField(raw, atKeys);
    if (at) {
      const sourceKey = atKeys.find((key) => typeof raw[key] === 'string' && String(raw[key]).trim()) || 'at';
      if (sourceKey !== 'at') normalizedFields.push(`schedule.${sourceKey}->at`);
      let timezone = getStringField(raw, ['timezone', 'timeZone', 'tz']);
      if (!timezone && EXPLICIT_OFFSET_SUFFIX_RE.test(at)) {
        // RFC3339 偏移已经唯一确定执行时刻；内部统一用 UTC 展示，避免猜测用户所在地区。
        timezone = 'UTC';
        normalizedFields.push('schedule.explicit_offset->timezone:UTC');
      }
      if (!timezone) {
        return {
          schedule: null,
          normalizedFields,
          error: '计划任务 schedule.kind=at 缺少 timezone；无偏移本地时间不能安全解析',
        };
      }
      if (EXPLICIT_OFFSET_SUFFIX_RE.test(at) && !Number.isFinite(new Date(at).getTime())) {
        return {
          schedule: null,
          normalizedFields,
          error: `计划任务 schedule.kind=at 的时间字段无效：${sourceKey}`,
        };
      }
      return { schedule: { kind: 'at', at, timezone }, normalizedFields };
    }

    const delay = getPositiveNumberField(raw, [
      { key: 'delayMs', multiplier: 1 },
      { key: 'delay_ms', multiplier: 1 },
      { key: 'delaySeconds', multiplier: 1_000 },
      { key: 'delay_seconds', multiplier: 1_000 },
      { key: 'delayMinutes', multiplier: 60_000 },
      { key: 'delay_minutes', multiplier: 60_000 },
      { key: 'delayHours', multiplier: 3_600_000 },
      { key: 'delay_hours', multiplier: 3_600_000 },
    ]);
    const reference = resolveReferenceTime(options.referenceTime);
    if (delay && reference) {
      const atMs = reference.getTime() + delay.valueMs;
      const atDate = new Date(atMs);
      if (Number.isFinite(atDate.getTime())) {
        normalizedFields.push(`schedule.${delay.key}->at`);
        normalizedFields.push('schedule.reference_time->timezone:UTC');
        return {
          schedule: { kind: 'at', at: atDate.toISOString(), timezone: 'UTC' },
          normalizedFields,
        };
      }
    }
    return {
      schedule: null,
      normalizedFields,
      error: delay
        ? '计划任务相对延时无法转换为有效绝对时间'
        : '计划任务 schedule.kind=at 缺少 at/datetime 或正数 delay',
    };
  }
  if (kind === 'every') {
    const interval = getPositiveNumberField(raw, [
      { key: 'everyMs', multiplier: 1 },
      { key: 'every_ms', multiplier: 1 },
      { key: 'everySeconds', multiplier: 1_000 },
      { key: 'every_seconds', multiplier: 1_000 },
      { key: 'everyMinutes', multiplier: 60_000 },
      { key: 'every_minutes', multiplier: 60_000 },
      { key: 'everyHours', multiplier: 3_600_000 },
      { key: 'every_hours', multiplier: 3_600_000 },
    ]);
    if (!interval) {
      return {
        schedule: null,
        normalizedFields,
        error: '计划任务 schedule.kind=every 缺少正数 everyMs/everySeconds/everyMinutes/everyHours',
      };
    }
    if (interval.key !== 'everyMs') normalizedFields.push(`schedule.${interval.key}->everyMs`);
    let anchorAt = getStringField(raw, ['anchorAt', 'anchor_at']);
    if (!anchorAt) {
      const reference = resolveReferenceTime(options.referenceTime);
      if (!reference) {
        return {
          schedule: null,
          normalizedFields,
          error: '计划任务 schedule.kind=every 缺少 anchorAt，且当前参考时间无效',
        };
      }
      anchorAt = reference.toISOString();
      normalizedFields.push('schedule.reference_time->anchorAt');
    }
    return {
      schedule: { kind: 'every', everyMs: Math.floor(interval.valueMs), anchorAt },
      normalizedFields,
    };
  }
  if (kind === 'cron') {
    const expression = getStringField(raw, ['expression', 'cron']);
    const timezone = getStringField(raw, ['timezone', 'timeZone', 'tz']);
    return expression && timezone
      ? { schedule: { kind: 'cron', expression, timezone }, normalizedFields }
      : {
          schedule: null,
          normalizedFields,
          error: '计划任务 schedule.kind=cron 缺少 expression 或 timezone',
        };
  }
  return {
    schedule: null,
    normalizedFields,
    error: rawKind
      ? `计划任务 schedule.kind=${rawKind} 不受支持；仅支持 at/every/cron`
      : '计划任务 schedule 缺少 kind/type',
  };
}

function parseScheduledTaskAction(value: unknown): ScheduledTaskActionInput | null {
  const raw = getRecordField(value);
  if (!raw) return null;
  const kind = getStringField(raw, ['kind']).toLowerCase();
  if (kind === 'notify') {
    const text = getStringField(raw, ['text', 'message', 'content']);
    return text ? { kind: 'notify', text } : null;
  }
  if (kind === 'check_in' || kind === 'check-in' || kind === 'checkin') {
    const text = getStringField(raw, ['text', 'message', 'content']);
    if (!text) return null;
    const requestedAudience = getStringField(raw, ['audience']).toLowerCase();
    const audience = requestedAudience === 'owner' ? 'owner' : 'chat_members';
    const buttonText = getStringField(raw, ['buttonText', 'button_text', 'label']);
    const successText = getStringField(raw, ['successText', 'success_text', 'confirmation']);
    const windowMs = Number(raw.windowMs ?? raw.window_ms);
    return {
      kind: 'check_in',
      text,
      audience,
      ...(buttonText ? { buttonText } : {}),
      ...(successText ? { successText } : {}),
      ...(Number.isFinite(windowMs) && windowMs > 0 ? { windowMs: Math.floor(windowMs) } : {}),
    };
  }
  if (kind === 'direct_message' || kind === 'direct-message') {
    const text = getStringField(raw, ['text', 'message', 'content']);
    const targetType = getStringField(raw, ['targetType', 'target_type', 'targetKind', 'target_kind']).toLowerCase();
    // 计划任务的真实投递目标始终由当前入站会话绑定。这里只兼容模型常见的
    // “向当前群发消息”协议变体；指定用户的私发不能静默降级为当前群通知。
    const targetsCurrentChat = /^(?:chat|group|channel|conversation|current_chat|current-chat|群|群聊|当前群|当前会话)$/u.test(targetType);
    return text && targetsCurrentChat ? { kind: 'notify', text } : null;
  }
  if (kind === 'agent_turn') {
    const prompt = getStringField(raw, ['prompt', 'text', 'request']);
    const requestedSessionMode = getStringField(raw, ['sessionMode', 'session_mode']).toLowerCase();
    // Missing mode defaults to the least-privileged empty workspace. Only an
    // explicit `bound` may attach the scheduled turn to the trusted workspace
    // resolved later by the Host; unknown values still fail closed.
    const sessionMode = requestedSessionMode || 'isolated';
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

function collectIgnoredScheduledTaskActionFields(value: unknown): string[] {
  const raw = getRecordField(value);
  if (!raw) return [];
  const ignoredNames = new Set([
    'target', 'targetid', 'target_id', 'targettype', 'target_type', 'targetkind', 'target_kind',
    'chatid', 'chat_id', 'userid', 'user_id', 'openid', 'open_id', 'receiveid', 'receive_id',
    'channeltype', 'channel_type', 'sessionid', 'session_id', 'messageid', 'message_id',
  ]);
  return Object.keys(raw)
    .filter((key) => ignoredNames.has(key.replace(/[-\s]/gu, '_').toLowerCase()))
    .map((key) => `taskAction.${key}`)
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

export function extractCtiScheduledTaskAction(
  text: string,
  options: ScheduledTaskActionParseOptions = {},
): ExtractedScheduledTaskAction {
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
    const scheduleResult = parseScheduledTaskSchedule(raw.schedule, options);
    const schedule = scheduleResult.schedule;
    const rawTaskAction = raw.taskAction ?? raw.task_action;
    const taskAction = parseScheduledTaskAction(rawTaskAction);
    const requestedDeliveryMode = getStringField(raw, ['deliveryMode', 'delivery_mode']).toLowerCase();
    const deliveryMode = requestedDeliveryMode === 'summary' || requestedDeliveryMode === 'none'
      ? requestedDeliveryMode
      : 'result';
    if (!name) return { action: null, text: cleaned, hadBlock: true, error: '计划任务动作缺少 name' };
    if (!schedule) {
      return {
        action: null,
        text: cleaned,
        hadBlock: true,
        error: scheduleResult.error || '计划任务 schedule 无效或缺少必要字段',
      };
    }
    if (!taskAction) {
      const taskActionKind = getStringField(getRecordField(rawTaskAction) || {}, ['kind']);
      return {
        action: null,
        text: cleaned,
        hadBlock: true,
        error: taskActionKind
          ? `计划任务 taskAction 无效或不支持 kind=${taskActionKind}`
          : '计划任务动作缺少 taskAction',
      };
    }
    return {
      action: {
        action: 'create',
        name,
        schedule,
        taskAction,
        deliveryMode,
        normalizedFields: scheduleResult.normalizedFields,
        ignoredTrustedFields: [
          ...collectIgnoredScheduledTaskFields(parsed),
          ...collectIgnoredScheduledTaskActionFields(rawTaskAction),
        ],
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
