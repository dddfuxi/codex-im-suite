/**
 * Provider-neutral model usage and cost accounting contracts.
 *
 * Providers may omit token or cost fields. Missing measurements are represented
 * as null at the persistence boundary; zero is reserved for a measured zero.
 */
export const MODEL_USAGE_PROTOCOL = 'cti-model-usage/v1' as const;

export type UsageProvider = string;
export type UsageStatus = 'succeeded' | 'failed' | 'cancelled' | 'timeout' | 'fallback';
export type UsageCostSource = 'provider_reported' | 'price_table' | 'unknown';

export interface ModelUsageRecordContract {
  protocol: typeof MODEL_USAGE_PROTOCOL;
  callId: string;
  turnId: string | null;
  timestamp: string;
  operation: string;
  provider: UsageProvider;
  model: string;
  status: UsageStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  reportedCostUsd: number | null;
  calculatedCostUsd: number | null;
  costSource: UsageCostSource;
  inputRateUsdPer1M: number | null;
  outputRateUsdPer1M: number | null;
  cacheReadInputRateUsdPer1M: number | null;
  cacheCreationInputRateUsdPer1M: number | null;
  routeDecision: string | null;
  fallbackReason: string | null;
}

export interface ModelUsagePriceContract {
  provider: string;
  model: string;
  inputRateUsdPer1M: number;
  outputRateUsdPer1M: number;
  cacheReadInputRateUsdPer1M?: number;
  cacheCreationInputRateUsdPer1M?: number;
  effectiveFrom?: string;
}

export interface ModelUsageLedgerContract {
  protocol: typeof MODEL_USAGE_PROTOCOL;
  version: 1;
  updatedAt: string;
  records: ModelUsageRecordContract[];
}

export interface ModelUsageSummaryContract {
  protocol: typeof MODEL_USAGE_PROTOCOL;
  generatedAt: string;
  from: string | null;
  to: string | null;
  calls: number;
  succeededCalls: number;
  failedCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
  totalTokens: number;
  reportedCostUsd: number;
  calculatedCostUsd: number;
  knownCostCalls: number;
  unknownCostCalls: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  byProvider: Record<string, {
    calls: number;
    totalTokens: number;
    knownCostUsd: number;
  }>;
}
