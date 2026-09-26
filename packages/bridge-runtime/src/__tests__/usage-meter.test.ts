import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { UsageMeter } from '../usage-meter.js';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cti-usage-meter-'));
}

describe('UsageMeter', () => {
  it('prefers provider-reported cost and persists atomically', () => {
    const home = tempHome();
    const meter = new UsageMeter({
      ctiHome: home,
      prices: [{ provider: 'jev', model: 'm', inputRateUsdPer1M: 1, outputRateUsdPer1M: 2 }],
      now: () => new Date('2026-09-25T00:00:00.000Z'),
    });
    const record = meter.record({
      callId: 'call-1', turnId: 'turn-1', operation: 'router', provider: 'jev', model: 'm',
      inputTokens: 100, outputTokens: 50, reportedCostUsd: 0.004, latencyMs: 80,
      routeDecision: 'task',
    });
    assert.equal(record.costSource, 'provider_reported');
    assert.equal(record.reportedCostUsd, 0.004);
    assert.equal(record.calculatedCostUsd, 0.0002);
    assert.equal(record.totalTokens, 150);
    const persisted = JSON.parse(fs.readFileSync(meter.filePath, 'utf8')) as { records: unknown[] };
    assert.equal(persisted.records.length, 1);
    assert.equal(new UsageMeter({ ctiHome: home }).getRecords().length, 1);
  });

  it('calculates price-table cost and keeps unknown cost as null', () => {
    const home = tempHome();
    const meter = new UsageMeter({
      ctiHome: home,
      prices: [{ provider: 'coordinator', model: 'm', inputRateUsdPer1M: 1, outputRateUsdPer1M: 3 }],
    });
    const priced = meter.record({ operation: 'chat', provider: 'coordinator', model: 'm', inputTokens: 1_000_000, outputTokens: 2_000_000 });
    assert.equal(priced.costSource, 'price_table');
    assert.equal(priced.calculatedCostUsd, 7);
    const unknown = meter.record({ operation: 'chat', provider: 'primary', model: 'unknown', inputTokens: 10 });
    assert.equal(unknown.costSource, 'unknown');
    assert.equal(unknown.reportedCostUsd, null);
    assert.equal(unknown.calculatedCostUsd, null);
  });

  it('loads versioned CTI_HOME/config/model-prices.json and requires complete cache dimensions', () => {
    const home = tempHome();
    const pricePath = path.join(home, 'config', 'model-prices.json');
    fs.mkdirSync(path.dirname(pricePath), { recursive: true });
    fs.writeFileSync(pricePath, JSON.stringify({
      protocol: 'cti-model-prices/v1', version: 1,
      prices: [{ provider: 'p', model: 'm', inputRateUsdPer1M: 1, outputRateUsdPer1M: 2, effectiveFrom: '2026-01-01T00:00:00.000Z' }],
    }), 'utf8');
    const meter = new UsageMeter({ ctiHome: home });
    const partialCache = meter.record({ operation: 'chat', provider: 'p', model: 'm', inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2 });
    assert.equal(partialCache.calculatedCostUsd, null);
    const complete = meter.record({ operation: 'chat', provider: 'p', model: 'm', inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 0 });
    assert.equal(complete.costSource, 'price_table');
  });

  it('summarizes token, cost, status, provider and latency metrics', () => {
    const home = tempHome();
    const meter = new UsageMeter({ ctiHome: home, now: () => new Date('2026-09-25T00:00:00.000Z') });
    meter.record({ operation: 'a', provider: 'jev', model: 'm', inputTokens: 2, outputTokens: 3, latencyMs: 100, reportedCostUsd: 0.1 });
    meter.record({ operation: 'b', provider: 'jev', model: 'm', inputTokens: 4, status: 'timeout', latencyMs: 300, fallbackReason: 'timeout' });
    const summary = meter.summary();
    assert.equal(summary.calls, 2);
    assert.equal(summary.succeededCalls, 1);
    assert.equal(summary.failedCalls, 1);
    assert.equal(summary.totalTokens, 5);
    assert.equal(summary.knownCostCalls, 1);
    assert.equal(summary.unknownCostCalls, 1);
    assert.equal(summary.p50LatencyMs, 100);
    assert.equal(summary.p95LatencyMs, 300);
    assert.equal(summary.byProvider.jev?.calls, 2);
    assert.equal(summary.knownCostUsd, 0.1);
    assert.equal(summary.unknownInputTokenCalls, 0);
    assert.equal(summary.unknownTotalTokenCalls, 1);
    assert.equal(summary.routeMetrics.agreementRate, null);
    assert.equal(summary.failureRate, 0.5);
  });

  it('builds a bounded display snapshot with route agreement metrics', () => {
    const meter = new UsageMeter({ ctiHome: tempHome(), maxRecords: 5000 });
    meter.record({ operation: 'router', provider: 'jev', model: 'm', inputTokens: 1, outputTokens: 1, routeDecision: 'task', routeMode: 'shadow', effectivePath: 'coordinator', routeComparisonId: 'pair-1' });
    meter.record({ operation: 'router', provider: 'coordinator', model: 'c', inputTokens: 1, outputTokens: 1, routeDecision: 'task', coordinatorRoute: 'task', routeComparisonId: 'pair-1' });
    const snapshot = meter.snapshot();
    assert.equal(snapshot.protocol, 'cti-model-usage-snapshot/v1');
    assert.equal(snapshot.records.length, 2);
    assert.equal(snapshot.summary.routeMetrics.pairedComparisons, 1);
    assert.equal(snapshot.summary.routeMetrics.agreementRate, 1);
    assert.equal(snapshot.window.displayLimit, 200);
  });

  it('bounds retained records', () => {
    const meter = new UsageMeter({ ctiHome: tempHome(), maxRecords: 2 });
    meter.record({ operation: 'a', provider: 'x', model: 'm' });
    meter.record({ operation: 'b', provider: 'x', model: 'm' });
    meter.record({ operation: 'c', provider: 'x', model: 'm' });
    assert.deepEqual(meter.getRecords().map((record) => record.operation), ['b', 'c']);
  });
});
