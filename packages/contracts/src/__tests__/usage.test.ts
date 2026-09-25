import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MODEL_USAGE_PROTOCOL,
  type ModelUsageLedgerContract,
  type ModelUsageRecordContract,
} from '../usage.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('model usage contracts', () => {
  it('represents missing measurements as null', () => {
    const record: ModelUsageRecordContract = {
      protocol: MODEL_USAGE_PROTOCOL,
      callId: 'call-1',
      turnId: null,
      timestamp: '2026-09-25T00:00:00.000Z',
      operation: 'router',
      provider: 'jev',
      model: 'typesafe/jev-1.13',
      status: 'timeout',
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      totalTokens: null,
      latencyMs: 1000,
      reportedCostUsd: null,
      calculatedCostUsd: null,
      costSource: 'unknown',
      inputRateUsdPer1M: null,
      outputRateUsdPer1M: null,
      cacheReadInputRateUsdPer1M: null,
      cacheCreationInputRateUsdPer1M: null,
      routeDecision: null,
      fallbackReason: 'timeout',
    };
    const ledger: ModelUsageLedgerContract = {
      protocol: MODEL_USAGE_PROTOCOL,
      version: 1,
      updatedAt: record.timestamp,
      records: [record],
    };
    assert.equal(ledger.records[0]?.reportedCostUsd, null);
  });

  it('publishes the usage schema', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(packageRoot, 'schemas', 'usage.schema.json'), 'utf8')) as {
      $id?: string;
      $defs?: Record<string, unknown>;
    };
    assert.equal(schema.$id, 'https://codex-im-suite.local/schemas/usage.schema.json');
    assert.ok(schema.$defs?.ModelUsageRecordContract);
    assert.ok(schema.$defs?.ModelUsageLedgerContract);
    assert.ok(schema.$defs?.ModelUsageSummaryContract);
  });
});
