export interface ParsedReminderRequest {
  title: string;
  dueAt: string;
}

export interface NaturalReminderParseOptions {
  allowImplicitTimeOnly?: boolean;
  invocationAliases?: string[];
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
const RECURRING_REMINDER_HINT_RE = /(?:每天|每日|天天|每早|每晚|每个?(?:工作日|周末)|每(?:周|星期|礼拜)(?:[一二三四五六日天1-7])?|每月|每年)/u;
const SCHEDULING_TIME_HINT_RE = /(?:[0-9]{1,4}|[一二两三四五六七八九十]{1,3})\s*(?:分钟|分|小时|时|天)后|(?:(?:今天|明天|后天)?\s*(?:凌晨|早上|上午|中午|下午|晚上|今晚)?\s*(?:[01]?\d|2[0-3]|[一二两三四五六七八九十]{1,3})\s*(?:点|时|:|：))|(?:\d{4}[年/-])?\d{1,2}[月/-]\d{1,2}[日号]?/u;
const TASK_SCHEDULING_INTENT_RE = /(?:(?:新建|新增|创建|设置|安排|建立|添加|加)(?:一个|一条|个|条)?\s*(?:任务|待办|提醒|闹钟)|(?:任务|待办|提醒|闹钟).{0,12}(?:新建|新增|创建|设置|安排|建立|添加)|提醒我|提示我|通知我|叫我)/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function stripLeadingInvocationAliases(text: string, aliases: string[] | undefined): string {
  let normalized = text.trim();
  const sortedAliases = (aliases || [])
    .map((alias) => alias.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const alias of sortedAliases) {
    const next = normalized.replace(new RegExp(`^${escapeRegExp(alias)}\\s*[,，、:：]?\\s*`, 'iu'), '').trim();
    if (next !== normalized) normalized = next;
  }
  return normalized;
}

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
      .replace(/^(?:新建|新增|创建|设置|安排|建立|添加|加)(?:一个|一条|个|条)?\s*(?:任务|待办|提醒|闹钟)\s*/u, '')
      .replace(/^(?:给我|帮我|麻烦你?|请你?)\s*/u, '')
      .replace(/^(?:发|发送)(?:一条|一个|个)?(?:消息|信息|提醒)?\s*/u, '')
      .replace(/^(?:提醒我|提示我|通知我|告诉我|叫我)\s*/u, '')
      .replace(/^(?:提醒|提示|通知|告诉|叫|喊|让)\s+@?_user_\d+\s*/iu, '')
      .replace(/^(?:提醒|提示|通知|告诉|叫|喊|让)\s+[@＠][^\s,，。！？!?；;:：]{1,64}\s*/u, '')
      .replace(/@?_user_\d+\s*/giu, '')
      .replace(/^(?:说|内容是|内容为|为|：|:)\s*/u, '')
      .trim();
    if (title === before) break;
  }
  return title.replace(/[，,。！？!?\s]+$/u, '').trim();
}

function isUsableNaturalReminderTitle(title: string, implicit: boolean): boolean {
  const trimmed = title.trim();
  if (!trimmed || /^(提醒|消息|信息|待办)$/u.test(trimmed)) return false;
  if (!implicit) return true;
  // 隐式提醒仅用于本轮已确认唤醒别名的窄场景，避免把普通任务讨论误识别成提醒。
  if (trimmed.length > 40) return false;
  return !/[?？]|为什么|怎么|如何|解释|说明|脚本|代码|示例|查询|搜索|列出|查看/u.test(trimmed);
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

export function containsUnverifiedReminderCompletion(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const completionClaim = /(已|已经|成功|实际|真的).{0,16}(创建|设好|设置|登记|安排).{0,32}(系统计划任务|计划任务|提醒|消息提醒|定时提醒)/i;
  const schedulerArtifact = /(CodexFeishuReminder_|Register-ScheduledTask|schtasks\s+\/Create)/i;
  if (schedulerArtifact.test(normalized)) return true;
  if (!completionClaim.test(normalized)) return false;
  // 只拦截“已经创建”的伪完成；能力边界说明或明确否定不能被误判。
  const negatedClaim = /(?:不能|不可|不要|无法|没有|没能|未能|还没有|不能假装|不能硬说).{0,32}(?:已|已经|成功|实际|真的).{0,16}(?:创建|设好|设置|登记|安排)/iu;
  return !negatedClaim.test(normalized);
}

export function hasRecurringReminderHint(text: string): boolean {
  return RECURRING_REMINDER_HINT_RE.test(text);
}

export function hasSchedulingTimeHint(text: string): boolean {
  return hasRecurringReminderHint(text) || SCHEDULING_TIME_HINT_RE.test(text);
}

export function hasTaskSchedulingIntent(text: string): boolean {
  return TASK_SCHEDULING_INTENT_RE.test(text);
}

export function parseNaturalReminderRequest(
  text: string,
  now = new Date(),
  options: NaturalReminderParseOptions = {},
): ParsedReminderRequest | null {
  const normalized = stripLeadingInvocationAliases(
    text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim(),
    options.invocationAliases,
  );
  if (!normalized) return null;
  if (/(为什么|怎么回事|解释|说明|脚本|代码|示例|怎么写|如何写|帮我写|今天有什么|有哪些|查看|列出|查询|搜索)/u.test(normalized)) {
    return null;
  }
  const hasExplicitReminderIntent = /(提醒我|提示我|提醒\s+(?:@?_user_\d+|[@＠][^\s,，。！？!?；;:：]{1,64})|给我发.{0,8}(消息|提醒|信息)|发.{0,8}(消息|提醒|信息).{0,8}(提醒我|提示我|通知我)|(?:设置|创建|新建|新增|建立|添加|加|安排).{0,8}(任务|待办|提醒|闹钟))/u.test(normalized);
  if (!hasExplicitReminderIntent && !options.allowImplicitTimeOnly) return null;
  // 当前 direct reminder 只支持单次 dueAt；周期表达必须交给统一计划任务协议。
  if (hasRecurringReminderHint(normalized)) return null;
  const implicit = !hasExplicitReminderIntent;

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
    if (!isUsableNaturalReminderTitle(title, implicit)) return null;
    return { title, dueAt: new Date(now.getTime() + ms).toISOString() };
  }

  const absolute = buildAbsoluteReminderDueAt(normalized, now);
  if (!absolute) return null;
  const absoluteTitle = extractNaturalReminderTitle(normalized.slice(absolute.end))
    || extractNaturalReminderTitle(normalized.slice(0, absolute.start));
  if (!isUsableNaturalReminderTitle(absoluteTitle, implicit)) return null;
  return { title: absoluteTitle, dueAt: absolute.dueAt };
}

export function parseSlashReminderArgs(args: string, now = new Date()): ParsedReminderRequest | null {
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
