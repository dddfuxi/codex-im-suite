import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { KnowledgeIndex, KnowledgeItem } from './knowledge-indexer.js';
import { rebuildKnowledgeIndex } from './knowledge-index-service.js';
import { repairLikelyMojibakeText } from './mojibake.js';

export type ReminderStatus = 'pending' | 'sent' | 'failed' | 'skipped';
export type ReminderProviderState = 'ok' | 'disabled' | 'unsupported' | 'error';

export interface ReminderTarget {
  channelType: string;
  chatId: string;
  chatType?: string;
  displayName?: string;
  messageId?: string;
}

export interface ReminderNotifyTarget {
  userId?: string;
  name?: string;
  atAll?: boolean;
}

export interface TodoReminder {
  id: string;
  sourceKnowledgeId: string;
  title: string;
  dueAt?: string;
  todoStatus: 'pending' | 'done' | 'cancelled';
  status: ReminderStatus;
  sourceType?: 'memory' | 'direct';
  createdAt?: string;
  createdByMessageId?: string;
  skipReason?: string;
  target: ReminderTarget;
  notifyTargets?: ReminderNotifyTarget[];
  source: {
    path: string;
    snippet: string;
    updatedAt?: string;
  };
  createdFromText: string;
}

export interface ReminderIndex {
  schema: 'codex-im-suite/reminders/v1';
  memoryRoot: string;
  generatedAt: string;
  reminderCount: number;
  pendingCount: number;
  skippedCount: number;
  reminders: TodoReminder[];
}

export interface ReminderDeliveryRecord {
  reminderId: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  channelType: string;
  chatId: string;
  chatType?: string;
  dueAt?: string;
  messageId?: string;
  cardId?: string;
  lastAttemptAt?: string;
  error?: string;
  completedAt?: string;
  completedByUserId?: string;
  completionSource?: 'feishu_card' | 'panel';
  completionError?: string;
  attempts: number;
}

export interface ReminderDeliveryState {
  schema: 'codex-im-suite/reminder-state/v1';
  updatedAt: string;
  deliveries: Record<string, ReminderDeliveryRecord>;
}

export interface ReminderPushStatus {
  channelType: string;
  state: ReminderProviderState;
  detail: string;
}

export interface ReminderCanSendResult {
  ok: boolean;
  reason?: string;
}

export interface ReminderSendResult {
  ok: boolean;
  messageId?: string;
  cardId?: string;
  error?: string;
}

export interface ReminderPushProvider {
  channelType: string;
  status: () => ReminderPushStatus;
  canSend: (target: ReminderTarget) => ReminderCanSendResult;
  sendReminder: (reminder: TodoReminder) => Promise<ReminderSendResult>;
}

export interface ReminderDeliverInput {
  address: ReminderTarget;
  text: string;
  parseMode?: 'HTML' | 'Markdown' | 'plain';
  replyToMessageId?: string;
  dedupKey?: string;
  sessionId?: string;
  feishuCardJson?: string;
  mentions?: ReminderNotifyTarget[];
}

export interface FeishuPushProviderOptions {
  enabled: boolean;
  deliver: (input: ReminderDeliverInput) => Promise<ReminderSendResult>;
}

export interface TodoReminderServiceOptions {
  memoryRoot: string;
  enabled: boolean;
  enabledSourceTypes?: Array<'memory' | 'direct'>;
  pollMs: number;
  windowMs: number;
  enabledChannels: string[];
  providers: ReminderPushProvider[];
}

export interface TodoReminderService {
  close: () => void;
  tick: () => Promise<ReminderIndex | null>;
}

export interface ReminderBuildOptions {
  enabledChannels?: string[];
  generatedAt?: string;
}

export interface ReminderEvaluationOptions {
  now?: string;
  windowMs?: number;
  enabledSourceTypes?: Array<'memory' | 'direct'>;
  providers: ReminderPushProvider[];
}

export interface DirectReminderInput {
  title: string;
  dueAt: string;
  timezone?: string;
  target: ReminderTarget;
  notifyTargets?: ReminderNotifyTarget[];
  sourcePrompt?: string;
  createdAt?: string;
  createdByMessageId?: string;
}

export interface DirectReminderCreateResult {
  reminder: TodoReminder;
  filePath: string;
  index: ReminderIndex;
}

export interface ReminderCompleteInput {
  reminderId: string;
  chatId?: string;
  completedAt?: string;
  completedByUserId?: string;
  completionSource: 'feishu_card' | 'panel';
  callbackMessageId?: string;
}

export interface ReminderCompleteResult {
  ok: boolean;
  reminderId?: string;
  title?: string;
  status?: 'completed' | 'already_completed' | 'not_found' | 'forbidden' | 'state_only' | 'failed';
  message?: string;
  error?: string;
  sourceUpdated?: boolean;
}

export function getReminderIndexPath(memoryRoot: string): string {
  return path.join(memoryRoot, '.cti-index', 'reminders.json');
}

export function getReminderStatePath(memoryRoot: string): string {
  return path.join(memoryRoot, '.cti-index', 'reminder-state.json');
}

export function readReminderIndex(memoryRoot: string): ReminderIndex | null {
  return readJsonFile<ReminderIndex>(getReminderIndexPath(memoryRoot));
}

export function writeReminderIndex(memoryRoot: string, index: ReminderIndex): void {
  writeJsonFile(getReminderIndexPath(memoryRoot), index);
}

export function readReminderDeliveryState(memoryRoot: string): ReminderDeliveryState {
  return readJsonFile<ReminderDeliveryState>(getReminderStatePath(memoryRoot)) ?? createEmptyReminderState();
}

export function writeReminderDeliveryState(memoryRoot: string, state: ReminderDeliveryState): void {
  writeJsonFile(getReminderStatePath(memoryRoot), state);
}

export function createEmptyReminderState(): ReminderDeliveryState {
  return {
    schema: 'codex-im-suite/reminder-state/v1',
    updatedAt: '',
    deliveries: {},
  };
}

export function buildReminderIndexFromKnowledge(index: KnowledgeIndex, options: ReminderBuildOptions = {}): ReminderIndex {
  const enabledChannels = new Set((options.enabledChannels || ['feishu']).map((item) => item.toLowerCase()));
  const reminders = index.items
    .filter((item) => item.kind === 'todo')
    .map((item) => buildReminderFromTodo(item, enabledChannels))
    .filter((item): item is TodoReminder => !!item);
  return {
    schema: 'codex-im-suite/reminders/v1',
    memoryRoot: index.memoryRoot,
    generatedAt: options.generatedAt || new Date().toISOString(),
    reminderCount: reminders.length,
    pendingCount: reminders.filter((item) => item.status === 'pending').length,
    skippedCount: reminders.filter((item) => item.status === 'skipped').length,
    reminders,
  };
}

export function rebuildReminderIndexFromKnowledge(memoryRoot: string, knowledgeIndex: KnowledgeIndex, options: ReminderBuildOptions = {}): ReminderIndex {
  const reminderIndex = buildReminderIndexFromKnowledge(knowledgeIndex, options);
  writeReminderIndex(memoryRoot, reminderIndex);
  return reminderIndex;
}

export async function evaluateDueReminders(
  index: ReminderIndex,
  state: ReminderDeliveryState,
  options: ReminderEvaluationOptions,
): Promise<{ state: ReminderDeliveryState; results: ReminderSendResult[] }> {
  const now = new Date(options.now || new Date().toISOString());
  const windowMs = Math.max(0, options.windowMs ?? 5 * 60 * 1000);
  const enabledSourceTypes = new Set((options.enabledSourceTypes || ['memory']).map((item) => item.toLowerCase()));
  const providerByType = new Map(options.providers.map((provider) => [provider.channelType.toLowerCase(), provider]));
  const nextState: ReminderDeliveryState = {
    schema: 'codex-im-suite/reminder-state/v1',
    updatedAt: new Date().toISOString(),
    deliveries: { ...state.deliveries },
  };
  const results: ReminderSendResult[] = [];

  for (const reminder of index.reminders) {
    if (reminder.status !== 'pending' || !reminder.dueAt) continue;
    const sourceType = reminder.sourceType || 'memory';
    if (!enabledSourceTypes.has(sourceType)) continue;
    if (nextState.deliveries[reminder.id]?.status === 'sent') continue;
    const dueAt = new Date(reminder.dueAt);
    if (!Number.isFinite(dueAt.getTime())) continue;
    if (dueAt.getTime() > now.getTime()) continue;
    if (windowMs > 0 && dueAt.getTime() < now.getTime() - windowMs) continue;

    const provider = providerByType.get(reminder.target.channelType.toLowerCase());
    const attemptAt = new Date().toISOString();
    if (!provider) {
      const error = `渠道未接入：${reminder.target.channelType}`;
      nextState.deliveries[reminder.id] = makeDeliveryRecord(reminder, 'skipped', attemptAt, undefined, undefined, error, nextState);
      continue;
    }

    const canSend = provider.canSend(reminder.target);
    if (!canSend.ok) {
      nextState.deliveries[reminder.id] = makeDeliveryRecord(reminder, 'skipped', attemptAt, undefined, undefined, canSend.reason, nextState);
      continue;
    }

    const result = await provider.sendReminder(reminder);
    results.push(result);
    nextState.deliveries[reminder.id] = makeDeliveryRecord(
      reminder,
      result.ok ? 'sent' : 'failed',
      attemptAt,
      result.messageId,
      result.cardId,
      result.error,
      nextState,
    );
  }

  return { state: nextState, results };
}

export function startTodoReminderService(options: TodoReminderServiceOptions): TodoReminderService {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const tick = async (): Promise<ReminderIndex | null> => {
    if (running) return readReminderIndex(options.memoryRoot);
    running = true;
    try {
      const knowledgeIndex = readJsonFile<KnowledgeIndex>(path.join(options.memoryRoot, '.cti-index', 'knowledge.json'));
      if (!knowledgeIndex) return null;
      const reminderIndex = buildReminderIndexFromKnowledge(knowledgeIndex, {
        enabledChannels: options.enabledChannels,
      });
      writeReminderIndex(options.memoryRoot, reminderIndex);
      if (options.enabled) {
        const state = readReminderDeliveryState(options.memoryRoot);
        const result = await evaluateDueReminders(reminderIndex, state, {
          windowMs: options.windowMs,
          enabledSourceTypes: options.enabledSourceTypes,
          providers: options.providers,
        });
        writeReminderDeliveryState(options.memoryRoot, result.state);
      }
      return reminderIndex;
    } finally {
      running = false;
    }
  };

  void tick().catch(() => {});
  timer = setInterval(() => {
    void tick().catch(() => {});
  }, Math.max(5000, options.pollMs));
  timer.unref?.();

  return {
    close: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}

export function createFeishuPushProvider(options: FeishuPushProviderOptions): ReminderPushProvider {
  return {
    channelType: 'feishu',
    status: () => ({
      channelType: 'feishu',
      state: options.enabled ? 'ok' : 'disabled',
      detail: options.enabled ? 'Feishu reminder push is enabled.' : 'Feishu reminder push is disabled.',
    }),
    canSend: (target) => {
      if (!options.enabled) return { ok: false, reason: '飞书主动推送未启用。' };
      if (target.channelType.toLowerCase() !== 'feishu') return { ok: false, reason: `渠道不匹配：${target.channelType}` };
      if (!target.chatId) return { ok: false, reason: '缺少飞书 chatId。' };
      return { ok: true };
    },
    sendReminder: async (reminder) => {
      const text = formatReminderMessage(reminder);
      const result = await options.deliver({
        address: reminder.target,
        text,
        parseMode: 'plain',
        dedupKey: `todo-reminder:${reminder.id}`,
        feishuCardJson: buildFeishuReminderCardJson(reminder),
        mentions: reminder.notifyTargets,
      });
      return result;
    },
  };
}

export function createDirectReminder(memoryRoot: string, input: DirectReminderInput): DirectReminderCreateResult {
  const root = path.resolve(memoryRoot);
  const createdAt = input.createdAt || new Date().toISOString();
  const dueAt = normalizeDueAt(input.dueAt);
  if (!dueAt) {
    throw new Error(`无效提醒时间：${input.dueAt}`);
  }
  if (!input.title.trim()) {
    throw new Error('提醒标题不能为空');
  }
  if (!input.target.channelType || !input.target.chatId) {
    throw new Error('缺少提醒目标会话');
  }

  const idSeed = `${input.target.channelType}:${input.target.chatId}:${dueAt}:${input.title}:${createdAt}`;
  const reminderSlug = crypto.createHash('sha1').update(idSeed).digest('hex').slice(0, 12);
  const filePath = path.join(root, 'data', 'todos', 'direct-reminders', `${formatFileTimestamp(dueAt)}-${reminderSlug}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const localDue = formatLocalDateTime(dueAt);
  const markdown = [
    '---',
    'channelType: ' + input.target.channelType,
    'chatId: ' + input.target.chatId,
    input.target.chatType ? 'chatType: ' + input.target.chatType : '',
    input.target.messageId ? 'messageId: ' + input.target.messageId : '',
    input.target.displayName ? 'displayName: ' + input.target.displayName : '',
    input.notifyTargets?.length ? 'notifyTargets: ' + encodeURIComponent(JSON.stringify(input.notifyTargets)) : '',
    'createdBy: agent-action',
    input.createdByMessageId ? 'createdByMessageId: ' + input.createdByMessageId : '',
    'createdAt: ' + createdAt,
    'sourceType: direct',
    '---',
    '',
    `待办: ${input.title.trim()} @${localDue} 状态: 未完成`,
    input.sourcePrompt ? `来源请求: ${input.sourcePrompt.trim()}` : '',
    '',
  ].filter((line) => line !== '').join('\n');
  fs.writeFileSync(filePath, markdown, 'utf-8');

  const knowledgeStatus = rebuildKnowledgeIndex(root);
  if (knowledgeStatus.lastError) {
    throw new Error(knowledgeStatus.lastError);
  }
  const knowledgeIndex = readJsonFile<KnowledgeIndex>(path.join(root, '.cti-index', 'knowledge.json'));
  if (!knowledgeIndex) {
    throw new Error('知识索引生成失败');
  }
  const index = rebuildReminderIndexFromKnowledge(root, knowledgeIndex, {
    enabledChannels: [input.target.channelType],
  });
  const reminder = index.reminders.find((item) => path.resolve(item.source.path) === path.resolve(filePath));
  if (!reminder) {
    throw new Error('直接提醒未进入提醒索引');
  }

  const state = readReminderDeliveryState(root);
  state.updatedAt = new Date().toISOString();
  state.deliveries[reminder.id] = {
    reminderId: reminder.id,
    status: 'pending',
    channelType: reminder.target.channelType,
    chatId: reminder.target.chatId,
    chatType: reminder.target.chatType,
    dueAt: reminder.dueAt,
    attempts: 0,
  };
  writeReminderDeliveryState(root, state);
  return { reminder, filePath, index };
}

export function createWeixinPushProvider(): ReminderPushProvider {
  return {
    channelType: 'weixin',
    status: () => ({
      channelType: 'weixin',
      state: 'unsupported',
      detail: '微信主动推送 v1 未接入，仅预留多渠道接口。',
    }),
    canSend: () => ({ ok: false, reason: '微信主动推送 v1 未接入。' }),
    sendReminder: async () => ({ ok: false, error: '微信主动推送 v1 未接入。' }),
  };
}

export function completeReminder(memoryRoot: string, input: ReminderCompleteInput): ReminderCompleteResult {
  const root = path.resolve(memoryRoot);
  const index = readReminderIndex(root);
  const reminder = index?.reminders.find((item) => item.id === input.reminderId);
  if (!reminder) {
    return {
      ok: false,
      reminderId: input.reminderId,
      status: 'not_found',
      error: '未找到待办提醒。',
    };
  }

  if (input.chatId && reminder.target.chatId && input.chatId !== reminder.target.chatId) {
    recordCompletionState(root, reminder, input, {
      completionError: `会话不匹配：${input.chatId}`,
    });
    return {
      ok: false,
      reminderId: reminder.id,
      title: reminder.title,
      status: 'forbidden',
      error: '当前会话不是该提醒的目标会话。',
    };
  }

  const state = readReminderDeliveryState(root);
  const previous = state.deliveries[reminder.id];
  if (reminder.todoStatus === 'done' || previous?.completedAt) {
    recordCompletionState(root, reminder, input, { preserveCompletedAt: true });
    return {
      ok: true,
      reminderId: reminder.id,
      title: reminder.title,
      status: 'already_completed',
      message: '待办此前已标记完成。',
      sourceUpdated: false,
    };
  }

  const sourceResult = updateReminderSourceStatus(root, reminder);
  if (sourceResult.updated) {
    const knowledgeStatus = rebuildKnowledgeIndex(root);
    if (knowledgeStatus.lastError) {
      recordCompletionState(root, reminder, input, { completionError: knowledgeStatus.lastError });
      return {
        ok: false,
        reminderId: reminder.id,
        title: reminder.title,
        status: 'failed',
        error: knowledgeStatus.lastError,
        sourceUpdated: true,
      };
    }
    const knowledgeIndex = readJsonFile<KnowledgeIndex>(path.join(root, '.cti-index', 'knowledge.json'));
    if (knowledgeIndex) {
      rebuildReminderIndexFromKnowledge(root, knowledgeIndex, {
        enabledChannels: [reminder.target.channelType || 'feishu'],
      });
    }
  }

  recordCompletionState(root, reminder, input, {
    completionError: sourceResult.updated ? undefined : sourceResult.reason,
  });
  return {
    ok: true,
    reminderId: reminder.id,
    title: reminder.title,
    status: sourceResult.updated ? 'completed' : 'state_only',
    message: sourceResult.updated ? '待办已完成。' : '待办状态已记录，源文件需手动确认。',
    sourceUpdated: sourceResult.updated,
  };
}

function formatReminderMessage(reminder: TodoReminder): string {
  const snippet = cleanReminderDisplaySnippet(reminder.source.snippet);
  const lines = [
    `待办提醒：${reminder.title}`,
  ];
  if (reminder.dueAt) {
    lines.push(`时间：${formatLocalDateTime(reminder.dueAt)}`);
  }
  if (snippet) {
    lines.push('', snippet);
  }
  return lines.join('\n');
}

function buildFeishuReminderCardJson(reminder: TodoReminder): string {
  const fields = [
    `**标题**：${escapeFeishuCardText(reminder.title)}`,
    reminder.dueAt ? `**时间**：${formatLocalDateTime(reminder.dueAt)}` : '',
    `**来源**：${reminder.sourceType === 'direct' ? '直接提醒' : '记忆待办'}`,
    reminder.target.displayName ? `**会话**：${escapeFeishuCardText(reminder.target.displayName)}` : '',
  ].filter(Boolean).join('\n');
  const displaySnippet = cleanReminderDisplaySnippet(reminder.source.snippet);
  const snippet = displaySnippet ? `\n\n${escapeFeishuCardText(displaySnippet)}` : '';
  return JSON.stringify({
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: '待办提醒',
      },
      template: 'blue',
    },
    elements: [
      {
        tag: 'markdown',
        content: `${fields}${snippet}`,
      },
      {
        tag: 'hr',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: '完成',
            },
            type: 'primary',
            value: {
              callback_data: `reminder:complete:${reminder.id}`,
              chatId: reminder.target.chatId,
            },
          },
        ],
      },
    ],
  });
}

function escapeFeishuCardText(value: string): string {
  return value.replace(/[<>&]/g, (char) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
  }[char] || char));
}

function cleanReminderDisplaySnippet(snippet: string): string {
  return (snippet || '')
    .replace(/\b(?:channelType|chatId|chatType|messageId|displayName|notifyTargets)\s*[:：]\s*[^\s,，;；]+/giu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function repairReminderText(text: string): string | null {
  const repaired = repairLikelyMojibakeText(text);
  return repaired.unresolved ? null : repaired.text;
}

function buildReminderFromTodo(item: KnowledgeItem, enabledChannels: Set<string>): TodoReminder | null {
  const text = repairReminderText(item.value || item.text);
  const snippet = repairReminderText(item.source.snippet || '');
  if (!text || snippet === null) return null;
  const metadataText = `${text}\n${snippet}`;
  const dueAt = parseDueAt(metadataText);
  const todoStatus = parseTodoStatus(metadataText);
  const sourceMetadata = (item.source as KnowledgeItem['source'] & { metadata?: Record<string, string> }).metadata;
  const target = parseReminderTargetFromMetadata(sourceMetadata, metadataText);
  const sourceType = parseSourceType(item, sourceMetadata);
  const title = cleanReminderTitle(text);
  let status: ReminderStatus = 'pending';
  let skipReason = '';

  if (!dueAt) {
    status = 'skipped';
    skipReason = '缺少提醒时间';
  } else if (!target.channelType || !target.chatId) {
    status = 'skipped';
    skipReason = '缺少来源会话';
  } else if (todoStatus !== 'pending') {
    status = 'skipped';
    skipReason = `状态为${todoStatus === 'done' ? '完成' : '取消'}`;
  } else if (!enabledChannels.has(target.channelType.toLowerCase())) {
    status = 'skipped';
    skipReason = `渠道未启用：${target.channelType}`;
  }

  return {
    id: item.id,
    sourceKnowledgeId: item.id,
    title,
    dueAt,
    todoStatus,
    status,
    sourceType,
    createdAt: sourceMetadata?.createdAt,
    createdByMessageId: sourceMetadata?.createdByMessageId,
    skipReason: skipReason || undefined,
    target,
    notifyTargets: parseReminderNotifyTargets(sourceMetadata, metadataText),
    source: {
      path: item.source.path,
      snippet,
      updatedAt: item.source.updatedAt,
    },
    createdFromText: text,
  };
}

function parseSourceType(item: KnowledgeItem, metadata: Record<string, string> | undefined): TodoReminder['sourceType'] {
  if (metadata?.sourceType === 'direct' || metadata?.createdBy === 'direct-fast-path' || metadata?.createdBy === 'agent-action') return 'direct';
  if (item.source.path.toLowerCase().includes(`${path.sep}direct-reminders${path.sep}`.toLowerCase())) return 'direct';
  return 'memory';
}

function parseDueAt(text: string): string | undefined {
  const match = text.match(/(?:@|提醒时间\s*[:：]\s*)(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})/u);
  if (!match) return undefined;
  const [, datePart, timePart] = match;
  const date = new Date(`${datePart}T${timePart.padStart(5, '0')}:00+08:00`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function parseTodoStatus(text: string): TodoReminder['todoStatus'] {
  const match = text.match(/状态\s*[:：]\s*([^\s,，;；]+)/u);
  const value = (match?.[1] || '').trim().toLowerCase();
  if (['完成', '已完成', 'done', 'closed'].includes(value)) return 'done';
  if (['取消', '已取消', 'cancelled', 'canceled'].includes(value)) return 'cancelled';
  return 'pending';
}

function parseReminderTarget(text: string): ReminderTarget {
  return parseReminderTargetFromMetadata({}, text);
}

function parseReminderTargetFromMetadata(metadata: Record<string, string> | undefined, text: string): ReminderTarget {
  return {
    channelType: readInlineField(text, 'channelType') || metadata?.channelType || '',
    chatId: readInlineField(text, 'chatId') || metadata?.chatId || '',
    chatType: readInlineField(text, 'chatType') || metadata?.chatType || undefined,
    messageId: readInlineField(text, 'messageId') || metadata?.messageId || undefined,
    displayName: readInlineField(text, 'displayName') || metadata?.displayName || undefined,
  };
}

function parseReminderNotifyTargets(
  metadata: Record<string, string> | undefined,
  text: string,
): ReminderNotifyTarget[] | undefined {
  const raw = readInlineField(text, 'notifyTargets') || metadata?.notifyTargets || '';
  if (!raw) return undefined;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  try {
    const parsed = JSON.parse(decoded) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const targets = parsed
      .map((item): ReminderNotifyTarget | null => {
        if (!item || typeof item !== 'object') return null;
        const rawTarget = item as Record<string, unknown>;
        const userId = typeof rawTarget.userId === 'string'
          ? rawTarget.userId.trim()
          : typeof rawTarget.user_id === 'string'
            ? rawTarget.user_id.trim()
            : '';
        const name = typeof rawTarget.name === 'string'
          ? rawTarget.name.trim()
          : typeof rawTarget.user_name === 'string'
            ? rawTarget.user_name.trim()
            : '';
        const atAll = rawTarget.atAll === true || rawTarget.at_all === true;
        if (!atAll && !userId) return null;
        return {
          ...(userId ? { userId } : {}),
          ...(name ? { name } : {}),
          ...(atAll ? { atAll: true } : {}),
        };
      })
      .filter((item): item is ReminderNotifyTarget => Boolean(item));
    return targets.length > 0 ? targets : undefined;
  } catch {
    return undefined;
  }
}

function readInlineField(text: string, key: string): string {
  const match = text.match(new RegExp(`${key}\\s*[:：]\\s*([^\\s,，;；]+)`, 'iu'));
  return (match?.[1] || '').trim();
}

function cleanReminderTitle(text: string): string {
  return text
    .replace(/(?:@|提醒时间\s*[:：]\s*)\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}/gu, '')
    .replace(/\b(?:channelType|chatId|chatType|messageId|displayName|notifyTargets)\s*[:：]\s*[^\s,，;；]+/giu, '')
    .replace(/状态\s*[:：]\s*[^\s,，;；]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function updateReminderSourceStatus(
  memoryRoot: string,
  reminder: TodoReminder,
): { updated: boolean; reason?: string } {
  const sourcePath = path.resolve(reminder.source.path);
  const root = path.resolve(memoryRoot);
  if (!sourcePath.startsWith(root + path.sep)) {
    return { updated: false, reason: '源文件不在记忆仓库内，已拒绝自动修改。' };
  }
  if (!fs.existsSync(sourcePath)) {
    return { updated: false, reason: '源文件不存在。' };
  }

  const markdown = fs.readFileSync(sourcePath, 'utf-8');
  const lines = markdown.split(/\r?\n/);
  const title = reminder.title.trim();
  const lineIndex = lines.findIndex((line) =>
    line.includes('状态') &&
    /状态\s*[:：]\s*未完成/u.test(line) &&
    (!title || line.includes(title)),
  );
  if (lineIndex >= 0) {
    lines[lineIndex] = lines[lineIndex].replace(/状态\s*[:：]\s*未完成/u, '状态: 完成');
    fs.writeFileSync(sourcePath, lines.join('\n'), 'utf-8');
    return { updated: true };
  }

  if (reminder.sourceType === 'direct') {
    const replaced = markdown.replace(/状态\s*[:：]\s*未完成/u, '状态: 完成');
    if (replaced !== markdown) {
      fs.writeFileSync(sourcePath, replaced, 'utf-8');
      return { updated: true };
    }
  }

  return { updated: false, reason: '未能在源文件中精确匹配同一条未完成待办。' };
}

function recordCompletionState(
  memoryRoot: string,
  reminder: TodoReminder,
  input: ReminderCompleteInput,
  options: { completionError?: string; preserveCompletedAt?: boolean } = {},
): void {
  const state = readReminderDeliveryState(memoryRoot);
  const previous = state.deliveries[reminder.id];
  const completedAt = options.preserveCompletedAt && previous?.completedAt
    ? previous.completedAt
    : input.completedAt || new Date().toISOString();
  state.updatedAt = new Date().toISOString();
  state.deliveries[reminder.id] = {
    reminderId: reminder.id,
    status: previous?.status || reminder.status,
    channelType: reminder.target.channelType,
    chatId: reminder.target.chatId,
    chatType: reminder.target.chatType,
    dueAt: reminder.dueAt,
    messageId: previous?.messageId,
    cardId: previous?.cardId,
    lastAttemptAt: previous?.lastAttemptAt,
    error: previous?.error,
    attempts: previous?.attempts || 0,
    completedAt,
    completedByUserId: input.completedByUserId || previous?.completedByUserId,
    completionSource: input.completionSource || previous?.completionSource,
    completionError: options.completionError,
  };
  writeReminderDeliveryState(memoryRoot, state);
}

function makeDeliveryRecord(
  reminder: TodoReminder,
  status: ReminderDeliveryRecord['status'],
  attemptedAt: string,
  messageId: string | undefined,
  cardId: string | undefined,
  error: string | undefined,
  state: ReminderDeliveryState,
): ReminderDeliveryRecord {
  const previous = state.deliveries[reminder.id];
  return {
    reminderId: reminder.id,
    status,
    channelType: reminder.target.channelType,
    chatId: reminder.target.chatId,
    chatType: reminder.target.chatType,
    dueAt: reminder.dueAt,
    messageId,
    cardId,
    lastAttemptAt: attemptedAt,
    error,
    attempts: (previous?.attempts || 0) + 1,
    completedAt: previous?.completedAt,
    completedByUserId: previous?.completedByUserId,
    completionSource: previous?.completionSource,
    completionError: previous?.completionError,
  };
}

function normalizeDueAt(raw: string): string {
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function formatFileTimestamp(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'unknown-time';
  const parts = getShanghaiParts(date);
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
}

function formatLocalDateTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const parts = getShanghaiParts(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function getShanghaiParts(date: Date): Record<'year' | 'month' | 'day' | 'hour' | 'minute', string> {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: parts.year || '0000',
    month: parts.month || '00',
    day: parts.day || '00',
    hour: parts.hour || '00',
    minute: parts.minute || '00',
  };
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}
