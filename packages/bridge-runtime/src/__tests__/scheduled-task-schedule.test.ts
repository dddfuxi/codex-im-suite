import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeNextScheduledAt,
  normalizeScheduledTaskSchedule,
  resolveDueScheduledSlot,
} from '../scheduled-tasks/schedule.js';

describe('scheduled task schedule', () => {
  it('selects the latest cron slot inclusively across a long outage', () => {
    const schedule = { kind: 'cron' as const, expression: '0 10-12,14-19 * * 1-5', timezone: 'Asia/Shanghai' };
    const policy = { mode: 'run_latest' as const, maxLatenessMs: 900_000 };
    for (const clock of ['2026-09-18T07:00:00.000Z', '2026-09-18T07:00:00.999Z', '2026-09-18T07:15:00.000Z']) {
      assert.deepEqual(resolveDueScheduledSlot(schedule, '2026-07-20T02:00:00.000Z', clock, policy), {
        scheduledFor: '2026-09-18T07:00:00.000Z', nextRunAt: '2026-09-18T08:00:00.000Z',
        shouldRun: true, caughtUp: true,
      });
    }
    assert.equal(resolveDueScheduledSlot(schedule, '2026-07-20T02:00:00.000Z', '2026-09-18T07:15:00.001Z', policy).shouldRun, false);
    assert.equal(resolveDueScheduledSlot(schedule, '2026-07-20T02:00:00.000Z', '2026-09-19T07:00:00.000Z', policy).shouldRun, false);
  });

  it('collapses years of second-level intervals without losing the original anchor', () => {
    assert.deepEqual(resolveDueScheduledSlot({
      kind: 'every', everyMs: 1_000, anchorAt: '2020-01-01T00:00:00.123Z',
    }, '2020-01-01T00:00:01.123Z', '2026-09-18T07:00:00.456Z', {
      mode: 'run_latest', maxLatenessMs: 900_000,
    }), {
      scheduledFor: '2026-09-18T07:00:00.123Z', nextRunAt: '2026-09-18T07:00:01.123Z',
      shouldRun: true, caughtUp: true,
    });
  });

  it('includes the current cron second without admitting a future slot', () => {
    const schedule = { kind: 'cron' as const, expression: '*/15 * * * * *', timezone: 'UTC' };
    const policy = { mode: 'run_latest' as const, maxLatenessMs: 20_000 };
    for (const second of ['00.000', '00.999', '14.999']) {
      const slot = resolveDueScheduledSlot(schedule, '2026-01-01T00:00:00.000Z', `2026-09-18T07:00:${second}Z`, policy);
      assert.equal(slot.scheduledFor, '2026-09-18T07:00:00.000Z');
      assert.equal(slot.nextRunAt, '2026-09-18T07:00:15.000Z');
    }
  });

  it('computes weekdays at 10:30 in Asia/Shanghai', () => {
    const schedule = normalizeScheduledTaskSchedule({
      kind: 'cron',
      expression: '30 10 * * 1-5',
      timezone: 'Asia/Shanghai',
    });

    assert.equal(
      computeNextScheduledAt(schedule, '2026-07-17T03:00:00.000Z'),
      '2026-07-20T02:30:00.000Z',
    );
  });

  it('keeps every schedules anchored across restarts', () => {
    const schedule = normalizeScheduledTaskSchedule({
      kind: 'every',
      everyMs: 60_000,
      anchorAt: '2026-07-18T00:00:00.000Z',
    });

    assert.equal(
      computeNextScheduledAt(schedule, '2026-07-18T00:02:10.000Z'),
      '2026-07-18T00:03:00.000Z',
    );
  });

  it('returns a future one-shot once and then expires it', () => {
    const schedule = normalizeScheduledTaskSchedule({
      kind: 'at',
      at: '2026-07-18T10:30:00+08:00',
      timezone: 'Asia/Shanghai',
    });

    assert.equal(computeNextScheduledAt(schedule, '2026-07-18T02:00:00.000Z'), '2026-07-18T02:30:00.000Z');
    assert.equal(computeNextScheduledAt(schedule, '2026-07-18T02:30:00.000Z'), undefined);
  });

  it('interprets an offset-less one-shot in its declared timezone', () => {
    const schedule = normalizeScheduledTaskSchedule({
      kind: 'at',
      at: '2026-07-18T10:30:00',
      timezone: 'Asia/Shanghai',
    });

    if (schedule.kind !== 'at') assert.fail('expected an at schedule');
    assert.equal(schedule.at, '2026-07-18T02:30:00.000Z');
  });

  it('rejects invalid timezone and cron expressions', () => {
    assert.throws(
      () => normalizeScheduledTaskSchedule({
        kind: 'cron',
        expression: 'bad',
        timezone: 'Mars/Base',
      }),
      /时区|timezone/iu,
    );

    assert.throws(
      () => normalizeScheduledTaskSchedule({
        kind: 'cron',
        expression: 'bad',
        timezone: 'Asia/Shanghai',
      }),
      /cron|pattern|expression|部分|字段|无效/iu,
    );
  });

  it('rejects an invalid interval or anchor', () => {
    assert.throws(
      () => normalizeScheduledTaskSchedule({
        kind: 'every',
        everyMs: 999,
        anchorAt: '2026-07-18T00:00:00.000Z',
      }),
      /至少 1 秒/u,
    );
    assert.throws(
      () => normalizeScheduledTaskSchedule({
        kind: 'every',
        everyMs: 60_000,
        anchorAt: 'not-a-date',
      }),
      /锚点/u,
    );
  });
});
