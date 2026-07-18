import { Cron } from 'croner';

import type { ScheduledTaskSchedule } from './types.js';

const OFFSET_SUFFIX_RE = /(?:Z|[+-]\d{2}:?\d{2})$/iu;
const LOCAL_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u;

function assertTimezone(timezone: string): string {
  const normalized = timezone.trim();
  if (!normalized) throw new Error('计划任务时区不能为空');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date(0));
  } catch {
    throw new Error(`无效计划任务时区：${timezone}`);
  }
  return normalized;
}

function readZonedParts(date: Date, timezone: string): Record<string, number> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type === 'literal') continue;
    const value = Number(part.value);
    if (Number.isFinite(value)) parts[part.type] = value;
  }
  return parts;
}

/**
 * 把没有偏移量的本地时间按显式 IANA 时区转换为 UTC。
 * 二次计算偏移可覆盖大多数 DST 边界；最后回读用于拒绝不存在的墙上时间。
 */
function parseLocalDateTimeInTimezone(value: string, timezone: string): Date {
  const match = LOCAL_DATE_TIME_RE.exec(value.trim());
  if (!match) throw new Error(`无效单次时间：${value}`);
  const requested = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || '0'),
    millisecond: Number((match[7] || '0').padEnd(3, '0')),
  };
  const wallClockAsUtc = Date.UTC(
    requested.year,
    requested.month - 1,
    requested.day,
    requested.hour,
    requested.minute,
    requested.second,
    requested.millisecond,
  );
  if (!Number.isFinite(wallClockAsUtc)) throw new Error(`无效单次时间：${value}`);

  const resolveOffset = (candidateMs: number) => {
    const parts = readZonedParts(new Date(candidateMs), timezone);
    const representedAsUtc = Date.UTC(
      parts.year,
      (parts.month || 1) - 1,
      parts.day || 1,
      parts.hour || 0,
      parts.minute || 0,
      parts.second || 0,
      requested.millisecond,
    );
    return representedAsUtc - candidateMs;
  };

  let candidateMs = wallClockAsUtc - resolveOffset(wallClockAsUtc);
  candidateMs = wallClockAsUtc - resolveOffset(candidateMs);
  const candidate = new Date(candidateMs);
  const roundTrip = readZonedParts(candidate, timezone);
  if (
    roundTrip.year !== requested.year
    || roundTrip.month !== requested.month
    || roundTrip.day !== requested.day
    || roundTrip.hour !== requested.hour
    || roundTrip.minute !== requested.minute
    || roundTrip.second !== requested.second
  ) {
    throw new Error(`单次时间在时区 ${timezone} 中不存在或存在歧义：${value}`);
  }
  return candidate;
}

function normalizeAt(value: string, timezone: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('单次时间不能为空');
  const date = OFFSET_SUFFIX_RE.test(normalized)
    ? new Date(normalized)
    : parseLocalDateTimeInTimezone(normalized, timezone);
  if (!Number.isFinite(date.getTime())) throw new Error(`无效单次时间：${value}`);
  return date.toISOString();
}

export function normalizeScheduledTaskSchedule(
  input: ScheduledTaskSchedule,
): ScheduledTaskSchedule {
  if (input.kind === 'every') {
    if (!Number.isFinite(input.everyMs) || input.everyMs < 1_000) {
      throw new Error('固定间隔必须至少 1 秒');
    }
    const anchor = new Date(input.anchorAt);
    if (!Number.isFinite(anchor.getTime())) throw new Error(`无效固定间隔锚点：${input.anchorAt}`);
    return {
      kind: 'every',
      everyMs: Math.floor(input.everyMs),
      anchorAt: anchor.toISOString(),
    };
  }

  const timezone = assertTimezone(input.timezone);
  if (input.kind === 'at') {
    return {
      kind: 'at',
      at: normalizeAt(input.at, timezone),
      timezone,
    };
  }

  const expression = input.expression.trim();
  if (!expression) throw new Error('cron 表达式不能为空');
  try {
    // 不传 callback 时 Croner 只负责表达式计算，不创建业务执行路径。
    new Cron(expression, { timezone, catch: false });
  } catch (error) {
    throw new Error(`无效 cron 表达式：${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    kind: 'cron',
    expression,
    timezone,
  };
}

export function computeNextScheduledAt(
  schedule: ScheduledTaskSchedule,
  after: string,
): string | undefined {
  const normalized = normalizeScheduledTaskSchedule(schedule);
  const afterMs = new Date(after).getTime();
  if (!Number.isFinite(afterMs)) throw new Error(`无效计划任务参考时间：${after}`);

  if (normalized.kind === 'at') {
    const atMs = new Date(normalized.at).getTime();
    return atMs > afterMs ? normalized.at : undefined;
  }

  if (normalized.kind === 'every') {
    const anchorMs = new Date(normalized.anchorAt).getTime();
    if (afterMs < anchorMs) return normalized.anchorAt;
    const steps = Math.floor((afterMs - anchorMs) / normalized.everyMs) + 1;
    return new Date(anchorMs + steps * normalized.everyMs).toISOString();
  }

  const next = new Cron(normalized.expression, {
    timezone: normalized.timezone,
    catch: false,
  }).nextRun(new Date(afterMs));
  return next?.toISOString();
}
