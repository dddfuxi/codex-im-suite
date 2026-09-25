import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  MODEL_USAGE_PROTOCOL,
  ModelUsageLedgerContract,
  ModelUsagePriceContract,
  ModelUsageRecordContract,
  ModelUsageSummaryContract,
  UsageCostSource,
  UsageStatus,
} from '@codex-im-suite/contracts';

import { CTI_HOME } from './config.js';
import { cleanupStaleAtomicWriteTemps, writeUtf8TextAtomic } from './atomic-text-file.js';

export interface UsageMeterInput {
  callId?: string;
  turnId?: string | null;
  timestamp?: string | Date;
  operation: string;
  provider: string;
  model: string;
  status?: UsageStatus;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  latencyMs?: number | null;
  reportedCostUsd?: number | null;
  routeDecision?: string | null;
  fallbackReason?: string | null;
}

export interface UsageMeterOptions {
  ctiHome?: string;
  prices?: readonly ModelUsagePriceContract[];
  maxRecords?: number;
  now?: () => Date;
}

export interface UsageSummaryRange {
  from?: string | Date;
  to?: string | Date;
}

const DEFAULT_MAX_RECORDS = 5_000;
const MAX_TEXT = 256;

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function boundedText(value: unknown, fallback: string | null): string | null {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text ? text.slice(0, MAX_TEXT) : fallback;
}

function safeDiagnostic(value: unknown): string | null {
  const text = boundedText(value, null);
  if (!text) return null;
  return text
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/gu, '[redacted]')
    .replace(/[A-Za-z]:\\[^\s]+/gu, '[path]')
    .replace(/(?:\/|\\)Users(?:\/|\\)[^\s]+/giu, '[path]')
    .slice(0, MAX_TEXT);
}

function normalizeStatus(value: unknown): UsageStatus {
  return value === 'failed' || value === 'cancelled' || value === 'timeout' || value === 'fallback'
    ? value
    : 'succeeded';
}

function normalizePrice(value: ModelUsagePriceContract): ModelUsagePriceContract | null {
  if (!value || typeof value.provider !== 'string' || typeof value.model !== 'string') return null;
  const inputRate = finiteNonNegative(value.inputRateUsdPer1M);
  const outputRate = finiteNonNegative(value.outputRateUsdPer1M);
  if (inputRate === null || outputRate === null) return null;
  const cacheReadRate = finiteNonNegative(value.cacheReadInputRateUsdPer1M);
  const cacheCreationRate = finiteNonNegative(value.cacheCreationInputRateUsdPer1M);
  return {
    provider: value.provider.trim(),
    model: value.model.trim(),
    inputRateUsdPer1M: inputRate,
    outputRateUsdPer1M: outputRate,
    ...(cacheReadRate !== null ? { cacheReadInputRateUsdPer1M: cacheReadRate } : {}),
    ...(cacheCreationRate !== null ? { cacheCreationInputRateUsdPer1M: cacheCreationRate } : {}),
    ...(typeof value.effectiveFrom === 'string' && Number.isFinite(Date.parse(value.effectiveFrom))
      ? { effectiveFrom: new Date(value.effectiveFrom).toISOString() }
      : {}),
  };
}

function normalizeTimestamp(value: string | Date | undefined, fallback: Date): string {
  const date = value instanceof Date ? value : value ? new Date(value) : fallback;
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback.toISOString();
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index] ?? null;
}

function parseDate(value: string | Date | undefined): number | null {
  if (value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}

function isUsageRecord(value: unknown): value is ModelUsageRecordContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const nullableNumber = (candidate: unknown): boolean => candidate === null || finiteNonNegative(candidate) !== null;
  return item.protocol === 'cti-model-usage/v1'
    && typeof item.callId === 'string'
    && typeof item.timestamp === 'string'
    && typeof item.operation === 'string'
    && typeof item.provider === 'string'
    && typeof item.model === 'string'
    && (item.status === 'succeeded' || item.status === 'failed' || item.status === 'cancelled' || item.status === 'timeout' || item.status === 'fallback')
    && nullableNumber(item.inputTokens)
    && nullableNumber(item.outputTokens)
    && nullableNumber(item.cacheReadInputTokens)
    && nullableNumber(item.cacheCreationInputTokens)
    && nullableNumber(item.totalTokens)
    && nullableNumber(item.latencyMs)
    && nullableNumber(item.reportedCostUsd)
    && nullableNumber(item.calculatedCostUsd)
    && (item.costSource === 'provider_reported' || item.costSource === 'price_table' || item.costSource === 'unknown');
}

function effectiveTokens(record: ModelUsageRecordContract): number {
  return record.totalTokens ?? 0;
}

/**
 * Provider-neutral usage ledger. It deliberately accepts already-normalized
 * measurements only; prompts, responses, credentials and attachments never
 * enter the ledger.
 */
export class UsageMeter {
  readonly filePath: string;
  private readonly prices: readonly ModelUsagePriceContract[];
  private readonly maxRecords: number;
  private readonly now: () => Date;
  private records: ModelUsageRecordContract[];
  private lastPersistenceError: unknown = null;

  constructor(options: UsageMeterOptions = {}) {
    const ctiHome = path.resolve(options.ctiHome || process.env.CTI_HOME?.trim() || CTI_HOME);
    this.filePath = path.join(ctiHome, 'runtime', 'model-usage.json');
    this.prices = (options.prices || []).map(normalizePrice).filter((price): price is ModelUsagePriceContract => Boolean(price));
    this.maxRecords = Math.max(1, Math.min(50_000, Math.floor(options.maxRecords || DEFAULT_MAX_RECORDS)));
    this.now = options.now || (() => new Date());
    cleanupStaleAtomicWriteTemps(this.filePath);
    this.records = this.readLedger();
  }

  /** Adds one bounded measurement and persists it atomically. */
  record(input: UsageMeterInput): ModelUsageRecordContract {
    const now = this.now();
    const timestamp = normalizeTimestamp(input.timestamp, now);
    const price = this.findPrice(input.provider, input.model, timestamp);
    const inputTokens = finiteNonNegative(input.inputTokens);
    const outputTokens = finiteNonNegative(input.outputTokens);
    const cacheReadInputTokens = finiteNonNegative(input.cacheReadInputTokens);
    const cacheCreationInputTokens = finiteNonNegative(input.cacheCreationInputTokens);
    // Cache counters are sub-components of input tokens, so they are kept as
    // separate dimensions and must not be added to totalTokens a second time.
    const totalTokens = inputTokens !== null || outputTokens !== null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : null;
    const reportedCostUsd = finiteNonNegative(input.reportedCostUsd);
    const calculatedCostUsd = this.calculateCost({
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
    }, price);
    const costSource: UsageCostSource = reportedCostUsd !== null
      ? 'provider_reported'
      : calculatedCostUsd !== null
        ? 'price_table'
        : 'unknown';
    const record: ModelUsageRecordContract = {
      protocol: 'cti-model-usage/v1',
      callId: boundedText(input.callId, null) || crypto.randomUUID(),
      turnId: boundedText(input.turnId, null),
      timestamp,
      operation: boundedText(input.operation, 'unknown') || 'unknown',
      provider: boundedText(input.provider, 'unknown') || 'unknown',
      model: boundedText(input.model, 'unknown') || 'unknown',
      status: normalizeStatus(input.status),
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      totalTokens,
      latencyMs: finiteNonNegative(input.latencyMs),
      reportedCostUsd,
      calculatedCostUsd,
      costSource,
      inputRateUsdPer1M: price?.inputRateUsdPer1M ?? null,
      outputRateUsdPer1M: price?.outputRateUsdPer1M ?? null,
      cacheReadInputRateUsdPer1M: price?.cacheReadInputRateUsdPer1M ?? null,
      cacheCreationInputRateUsdPer1M: price?.cacheCreationInputRateUsdPer1M ?? null,
      routeDecision: safeDiagnostic(input.routeDecision),
      fallbackReason: safeDiagnostic(input.fallbackReason),
    };
    this.records = [...this.records, record].slice(-this.maxRecords);
    try {
      this.persist();
      this.lastPersistenceError = null;
    } catch (error) {
      // Usage is observational: a locked/full disk must not block the model
      // response. The caller can inspect this diagnostic if desired.
      this.lastPersistenceError = error;
    }
    return record;
  }

  getRecords(): ModelUsageRecordContract[] {
    return this.records.map((record) => ({ ...record }));
  }

  getLastPersistenceError(): unknown {
    return this.lastPersistenceError;
  }

  summary(range: UsageSummaryRange = {}): ModelUsageSummaryContract {
    const fromMs = parseDate(range.from);
    const toMs = parseDate(range.to);
    const filtered = this.records.filter((record) => {
      const time = Date.parse(record.timestamp);
      return (fromMs === null || time >= fromMs) && (toMs === null || time <= toMs);
    });
    const latency = filtered
      .map((record) => record.latencyMs)
      .filter((value): value is number => value !== null);
    const byProvider: ModelUsageSummaryContract['byProvider'] = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadInputTokens = 0;
    let totalCacheCreationInputTokens = 0;
    let totalTokens = 0;
    let reportedCostUsd = 0;
    let calculatedCostUsd = 0;
    let knownCostCalls = 0;
    for (const record of filtered) {
      totalInputTokens += record.inputTokens ?? 0;
      totalOutputTokens += record.outputTokens ?? 0;
      totalCacheReadInputTokens += record.cacheReadInputTokens ?? 0;
      totalCacheCreationInputTokens += record.cacheCreationInputTokens ?? 0;
      totalTokens += effectiveTokens(record);
      reportedCostUsd += record.reportedCostUsd ?? 0;
      calculatedCostUsd += record.calculatedCostUsd ?? 0;
      if (record.costSource !== 'unknown') knownCostCalls += 1;
      const provider = byProvider[record.provider] || { calls: 0, totalTokens: 0, knownCostUsd: 0 };
      provider.calls += 1;
      provider.totalTokens += effectiveTokens(record);
      provider.knownCostUsd += record.reportedCostUsd ?? record.calculatedCostUsd ?? 0;
      byProvider[record.provider] = provider;
    }
    return {
      protocol: 'cti-model-usage/v1',
      generatedAt: this.now().toISOString(),
      from: range.from === undefined ? null : normalizeTimestamp(range.from, this.now()),
      to: range.to === undefined ? null : normalizeTimestamp(range.to, this.now()),
      calls: filtered.length,
      succeededCalls: filtered.filter((record) => record.status === 'succeeded').length,
      failedCalls: filtered.filter((record) => record.status !== 'succeeded').length,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadInputTokens,
      totalCacheCreationInputTokens,
      totalTokens,
      reportedCostUsd,
      calculatedCostUsd,
      knownCostCalls,
      unknownCostCalls: filtered.length - knownCostCalls,
      p50LatencyMs: percentile(latency, 0.5),
      p95LatencyMs: percentile(latency, 0.95),
      byProvider,
    };
  }

  private findPrice(provider: string, model: string, timestamp: string): ModelUsagePriceContract | null {
    const effectiveAt = Date.parse(timestamp);
    const candidates = this.prices.filter((price) => price.provider === provider && price.model === model)
      .filter((price) => !price.effectiveFrom || Date.parse(price.effectiveFrom) <= effectiveAt)
      .sort((left, right) => Date.parse(right.effectiveFrom || '') - Date.parse(left.effectiveFrom || ''));
    return candidates[0] || null;
  }

  private calculateCost(tokens: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadInputTokens: number | null;
    cacheCreationInputTokens: number | null;
  }, price: ModelUsagePriceContract | null): number | null {
    if (!price) return null;
    let total = 0;
    let hasMeasuredComponent = false;
    const cacheReadRate = price.cacheReadInputRateUsdPer1M ?? price.inputRateUsdPer1M;
    const cacheCreationRate = price.cacheCreationInputRateUsdPer1M ?? price.inputRateUsdPer1M;
    const cacheRead = tokens.cacheReadInputTokens ?? 0;
    const cacheCreation = tokens.cacheCreationInputTokens ?? 0;
    if (tokens.inputTokens !== null) {
      const uncachedInput = Math.max(0, tokens.inputTokens - cacheRead - cacheCreation);
      total += (uncachedInput / 1_000_000) * price.inputRateUsdPer1M;
      hasMeasuredComponent = true;
    }
    if (tokens.outputTokens !== null) {
      total += (tokens.outputTokens / 1_000_000) * price.outputRateUsdPer1M;
      hasMeasuredComponent = true;
    }
    if (tokens.cacheReadInputTokens !== null) {
      total += (tokens.cacheReadInputTokens / 1_000_000) * cacheReadRate;
      hasMeasuredComponent = true;
    }
    if (tokens.cacheCreationInputTokens !== null) {
      total += (tokens.cacheCreationInputTokens / 1_000_000) * cacheCreationRate;
      hasMeasuredComponent = true;
    }
    return hasMeasuredComponent ? total : null;
  }

  private readLedger(): ModelUsageRecordContract[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<ModelUsageLedgerContract>;
      if (parsed.protocol !== 'cti-model-usage/v1' || parsed.version !== 1 || !Array.isArray(parsed.records)) return [];
      return parsed.records.filter(isUsageRecord).slice(-this.maxRecords);
    } catch {
      return [];
    }
  }

  private persist(): void {
    const ledger: ModelUsageLedgerContract = {
      protocol: 'cti-model-usage/v1',
      version: 1,
      updatedAt: this.now().toISOString(),
      records: this.records,
    };
    writeUtf8TextAtomic(this.filePath, `${JSON.stringify(ledger)}\n`);
  }
}

export function createUsageMeter(options: UsageMeterOptions = {}): UsageMeter {
  return new UsageMeter(options);
}
