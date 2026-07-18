import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeNextScheduledAt,
  normalizeScheduledTaskSchedule,
} from '../scheduled-tasks/schedule.js';

describe('scheduled task schedule', () => {
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
