import type { ScheduledTaskListResult } from '../host.js';

const SCHEDULED_TASK_TARGET_RE = /(?:计划任务|定时任务|定时提醒|计划提醒|调度任务|周期任务|提醒任务)/iu;
const READ_INTENT_RE = /(?:列出|列一下|查看|看看|查询|查一下|有哪些|有什么|列表|全部|所有|当前|正在运行|待执行|状态|多少)/iu;
const MUTATION_INTENT_RE = /(?:创建|新建|添加|设置|安排|修改|暂停|恢复|删除|取消|立即运行|重试|迁移)/iu;
const LOCAL_CHECK_IN_RE = /(?:打卡|签到)/iu;
const CHECK_IN_ANALYTICS_RE = /(?:对比|比较|统计|汇总|趋势|排行|排行榜|本周|上周|两周|两个星期|近\s*[一二三四五六七八九十\d]+\s*(?:天|周|星期))/iu;
const CHECK_IN_PARTICIPANT_RE = /(?:谁|哪些人|什么人|什麼人|姓名|名字|成员名单|成員名單|参与者|參與者)/iu;
const EXTERNAL_ATTENDANCE_RE = /(?:飞书\s*)?(?:考勤|上下班|上班|下班)/iu;

export type ScheduledTaskReadIntent = 'list' | 'check_in_history';

export interface ScheduledTaskCheckInHistoryRead {
  task: unknown;
  runs: unknown[];
}

type CheckInHistoryWindow = {
  label: string;
  startDate: string;
  endDateExclusive: string;
};

/** 只识别无副作用的明确计划任务读取；混合修改请求继续交给完整 Agent/Policy 链。 */
export function resolveScheduledTaskReadIntent(text: string): ScheduledTaskReadIntent | null {
  const normalized = text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!normalized || MUTATION_INTENT_RE.test(normalized)) return null;
  // “打卡”可能指飞书考勤。只有互动打卡的统计语义才进入本地账本，考勤类请求
  // 保持原有外部资源路由，避免把两种数据源混为一谈。
  if (LOCAL_CHECK_IN_RE.test(normalized)
    && (CHECK_IN_ANALYTICS_RE.test(normalized) || CHECK_IN_PARTICIPANT_RE.test(normalized))
    && !EXTERNAL_ATTENDANCE_RE.test(normalized)) {
    return 'check_in_history';
  }
  if (!SCHEDULED_TASK_TARGET_RE.test(normalized)) return null;
  if (!READ_INTENT_RE.test(normalized)) return null;
  return 'list';
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeText(value: unknown, maxLength = 160): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function projectSchedule(value: unknown): Record<string, unknown> | undefined {
  const source = record(value);
  if (!source) return undefined;
  const kind = safeText(source.kind, 24);
  if (!kind || !['at', 'every', 'cron'].includes(kind)) return undefined;
  return {
    kind,
    ...(safeText(source.at, 64) ? { at: safeText(source.at, 64) } : {}),
    ...(safeText(source.anchorAt, 64) ? { anchorAt: safeText(source.anchorAt, 64) } : {}),
    ...(typeof source.everyMs === 'number' && Number.isFinite(source.everyMs) ? { everyMs: source.everyMs } : {}),
    ...(safeText(source.expression, 120) ? { expression: safeText(source.expression, 120) } : {}),
    ...(safeText(source.timezone, 64) ? { timezone: safeText(source.timezone, 64) } : {}),
  };
}

function projectTaskItem(value: { task: unknown; state?: unknown }): Record<string, unknown> | null {
  const task = record(value.task);
  if (!task) return null;
  const state = record(value.state);
  const id = safeText(task.id, 96);
  const name = safeText(task.name, 200);
  if (!id || !name) return null;
  const action = record(task.action);
  return {
    id,
    name,
    ...(safeBoolean(task.enabled) !== undefined ? { enabled: safeBoolean(task.enabled) } : {}),
    ...(typeof task.version === 'number' && Number.isInteger(task.version) ? { version: task.version } : {}),
    ...(projectSchedule(task.schedule) ? { schedule: projectSchedule(task.schedule) } : {}),
    ...(safeText(action?.kind, 48) ? { actionKind: safeText(action?.kind, 48) } : {}),
    ...(state && safeText(state.nextRunAt, 64) ? { nextRunAt: safeText(state.nextRunAt, 64) } : {}),
    ...(state && safeText(state.runningRunId, 96) ? { running: true } : { running: false }),
    ...(state && safeText(state.lastRunStatus, 48) ? { lastRunStatus: safeText(state.lastRunStatus, 48) } : {}),
    ...(state && safeText(state.lastDeliveryStatus, 48) ? { lastDeliveryStatus: safeText(state.lastDeliveryStatus, 48) } : {}),
  };
}

/**
 * 将 Runtime Host 结果投影为无路径、无正文、无平台身份的可信只读 evidence。
 * Agent 只能整理这份快照，不能用记忆、工作区文件或模型猜测补任务状态。
 */
export function buildScheduledTaskReadEvidencePrompt(result: ScheduledTaskListResult): string {
  const sourceItems = result.items?.length
    ? result.items
    : result.tasks.map((task) => ({ task }));
  const tasks = sourceItems
    .map(projectTaskItem)
    .filter((item): item is Record<string, unknown> => Boolean(item));
  const evidence = result.ok
    ? { protocol: 'cti-scheduled-task-list-evidence/v1', status: 'ready', total: tasks.length, tasks }
    : { protocol: 'cti-scheduled-task-list-evidence/v1', status: 'error', total: 0, tasks: [], errorCode: 'scheduled_task_list_unavailable' };
  return [
    'Trusted scheduled-task read evidence (Bridge/Runtime Host):',
    JSON.stringify(evidence),
    'Answer the current read-only scheduled-task question from this evidence only.',
    'An empty tasks array means the trusted Host returned zero visible tasks; do not invent remembered reminders.',
    'If status=error, say the list could not be read now. Do not claim the list is empty and do not expose internal diagnostics.',
  ].join('\n');
}

function projectCheckInRun(value: unknown): Record<string, unknown> | null {
  const run = record(value);
  if (!run) return null;
  const occurredAt = safeText(run.queuedAt, 64);
  const checkInCount = typeof run.checkInCount === 'number' && Number.isFinite(run.checkInCount)
    ? Math.max(0, Math.floor(run.checkInCount))
    : undefined;
  if (!occurredAt || checkInCount === undefined) return null;
  const participants = Array.isArray(run.participants)
    ? run.participants
      .map((value) => {
        const participant = record(value);
        const name = safeText(participant?.name, 80);
        const checkedInAt = safeText(participant?.checkedInAt, 64);
        return name ? { name, ...(checkedInAt ? { checkedInAt } : {}) } : null;
      })
      .filter((value): value is { name: string; checkedInAt?: string } => Boolean(value))
    : [];
  return {
    occurredAt,
    checkInCount,
    ...(participants.length > 0 ? { participants } : {}),
    ...(safeText(run.executionStatus, 48) ? { executionStatus: safeText(run.executionStatus, 48) } : {}),
    ...(safeText(run.deliveryStatus, 48) ? { deliveryStatus: safeText(run.deliveryStatus, 48) } : {}),
  };
}

function resolveSafeTimeZone(value: unknown): string {
  const candidate = safeText(value, 64) || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format();
    return candidate;
  } catch {
    return 'UTC';
  }
}

function calendarDateParts(value: Date, timeZone: string): { year: number; month: number; day: number } {
  const values = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value).reduce<Record<string, string>>((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addCalendarDays(date: { year: number; month: number; day: number }, amount: number): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day + amount));
}

/**
 * 将自然语言中的常见相对周期变成可审计的日期窗口。窗口使用任务自身的
 * IANA 时区（无效/缺失时才降级 UTC），不把业务名称或某个部署时区写进规则。
 */
export function resolveCheckInHistoryWindow(text: string, now = new Date(), timeZone = 'UTC'): CheckInHistoryWindow | undefined {
  const normalized = text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const today = calendarDateParts(now, resolveSafeTimeZone(timeZone));
  const todayUtc = addCalendarDays(today, 0);
  const weekday = (todayUtc.getUTCDay() + 6) % 7; // Monday = 0
  if (/(?:上周|上个(?:星期|周))/u.test(normalized)) {
    const start = addCalendarDays(today, -weekday - 7);
    return { label: '上周', startDate: formatDate(start), endDateExclusive: formatDate(addCalendarDays(today, -weekday)) };
  }
  if (/(?:本周|这周|这个(?:星期|周))/u.test(normalized)) {
    const start = addCalendarDays(today, -weekday);
    return { label: '本周', startDate: formatDate(start), endDateExclusive: formatDate(addCalendarDays(today, 1)) };
  }
  const recent = /近\s*(\d{1,3})\s*(天|周|星期)/u.exec(normalized);
  if (!recent) return undefined;
  const count = Number(recent[1]);
  if (!Number.isInteger(count) || count < 1) return undefined;
  const days = Math.min(count * (recent[2] === '天' ? 1 : 7), 366);
  return {
    label: `近 ${count} ${recent[2]}`,
    startDate: formatDate(addCalendarDays(today, -(days - 1))),
    endDateExclusive: formatDate(addCalendarDays(today, 1)),
  };
}

function dateInWindow(occurredAt: string, window: CheckInHistoryWindow | undefined, timeZone: string): boolean {
  if (!window) return true;
  const date = calendarDateParts(new Date(occurredAt), timeZone);
  const key = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
  return key >= window.startDate && key < window.endDateExclusive;
}

function summarizeCheckInRuns(runs: unknown[], window: CheckInHistoryWindow | undefined, timeZone: string): Record<string, unknown> {
  const daily = new Map<string, { scheduledRuns: number; successfulDeliveries: number; checkInCount: number }>();
  const participantStats = new Map<string, { checkInCount: number; lastCheckedInAt?: string }>();
  let scheduledRuns = 0;
  let successfulDeliveries = 0;
  let checkInCount = 0;
  let activeSlots = 0;
  for (const raw of runs) {
    const run = projectCheckInRun(raw);
    if (!run || typeof run.occurredAt !== 'string' || !dateInWindow(run.occurredAt, window, timeZone)) continue;
    const day = calendarDateParts(new Date(run.occurredAt), timeZone);
    const date = `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
    const item = daily.get(date) || { scheduledRuns: 0, successfulDeliveries: 0, checkInCount: 0 };
    const count = typeof run.checkInCount === 'number' ? run.checkInCount : 0;
    scheduledRuns += 1;
    item.scheduledRuns += 1;
    if (run.executionStatus === 'ok' && run.deliveryStatus === 'delivered') {
      successfulDeliveries += 1;
      item.successfulDeliveries += 1;
    }
    checkInCount += count;
    item.checkInCount += count;
    if (count > 0) activeSlots += 1;
    const participants = Array.isArray(run.participants) ? run.participants : [];
    for (const participant of participants) {
      if (!participant || typeof participant !== 'object') continue;
      const participantRecord = participant as Record<string, unknown>;
      const name = typeof participantRecord.name === 'string'
        ? participantRecord.name
        : '';
      if (!name) continue;
      const checkedInAt = typeof participantRecord.checkedInAt === 'string'
        ? participantRecord.checkedInAt
        : undefined;
      const existing = participantStats.get(name) || { checkInCount: 0 };
      existing.checkInCount += 1;
      if (!existing.lastCheckedInAt || (checkedInAt && checkedInAt > existing.lastCheckedInAt)) {
        existing.lastCheckedInAt = checkedInAt;
      }
      participantStats.set(name, existing);
    }
    daily.set(date, item);
  }
  return {
    ...(window ? { window: { ...window, timeZone } } : {}),
    scheduledRuns,
    successfulDeliveries,
    activeSlots,
    checkInCount,
    participants: [...participantStats.entries()]
      .sort((left, right) => right[1].checkInCount - left[1].checkInCount || left[0].localeCompare(right[0]))
      .map(([name, stats]) => ({ name, ...stats })),
    daily: [...daily.entries()].map(([date, item]) => ({ date, ...item })),
  };
}

/**
 * 互动打卡比较读取本地账本，并将真实参与者 ID 交给当前渠道适配器解析为显示名；
 * Provider 只接收名称、时间和统计结果，不接收平台 ID、卡片内容或本机路径。
 */
export function buildScheduledTaskCheckInHistoryEvidencePrompt(
  result: { ok: boolean; items: ScheduledTaskCheckInHistoryRead[] },
  options: { requestText?: string; now?: Date } = {},
): string {
  const tasks = result.items
    .map((item) => {
      const task = record(item.task);
      const action = record(task?.action);
      const name = safeText(task?.name, 200);
      if (!name || action?.kind !== 'check_in') return null;
      const schedule = record(task?.schedule);
      const timeZone = resolveSafeTimeZone(schedule?.timezone);
      const window = options.requestText ? resolveCheckInHistoryWindow(options.requestText, options.now, timeZone) : undefined;
      return {
        name,
        summary: summarizeCheckInRuns(item.runs, window, timeZone),
      };
    })
    .filter((task): task is { name: string; summary: Record<string, unknown> } => Boolean(task));
  const evidence = result.ok
    ? { protocol: 'cti-scheduled-check-in-history-evidence/v1', status: 'ready', tasks }
    : { protocol: 'cti-scheduled-check-in-history-evidence/v1', status: 'error', tasks: [], errorCode: 'scheduled_check_in_history_unavailable' };
  return [
    'Trusted local interactive check-in history evidence (Bridge/Runtime Host):',
    JSON.stringify(evidence),
    'Answer the current comparison or statistics question from this evidence only.',
    'This is Bridge-local interactive check-in data, not Feishu attendance, cloud documents, or Base data. Do not call lark-cli, request Feishu user authorization, or infer missing records.',
    'Participant names come only from the current channel roster matched to the persisted check-in user IDs. Do not invent or rename participants; if the list is empty, report that names could not be resolved and keep the aggregate count.',
    'If status=error, say the local check-in history could not be read now. If tasks is empty, say there is no visible local interactive check-in history.',
  ].join('\n');
}
