import fs from 'node:fs';
import path from 'node:path';

export type SelfMaintenanceMetricPhase = 'correction' | 'outcome';
export type SelfMaintenanceMetricOutcome = 'applied' | 'ignored' | 'rejected' | 'error' | 'skipped';

export interface SelfMaintenanceMetricInput {
  phase: SelfMaintenanceMetricPhase;
  outcome: SelfMaintenanceMetricOutcome;
  durationMs: number;
  reason: string;
  timestamp: string;
}

export interface SelfMaintenanceMetrics {
  protocol: 'cti-self-maintenance-metrics/v1';
  totalCalls: number;
  applied: number;
  ignored: number;
  rejected: number;
  errors: number;
  skipped: number;
  totalDurationMs: number;
  averageDurationMs: number;
  hashConflicts: number;
  lockConflicts: number;
  byPhase: Record<SelfMaintenanceMetricPhase, { calls: number; totalDurationMs: number }>;
  lastOutcome: SelfMaintenanceMetricOutcome | '';
  lastReasonCategory: string;
  updatedAt: string;
}

function emptyMetrics(): SelfMaintenanceMetrics {
  return {
    protocol: 'cti-self-maintenance-metrics/v1',
    totalCalls: 0,
    applied: 0,
    ignored: 0,
    rejected: 0,
    errors: 0,
    skipped: 0,
    totalDurationMs: 0,
    averageDurationMs: 0,
    hashConflicts: 0,
    lockConflicts: 0,
    byPhase: {
      correction: { calls: 0, totalDurationMs: 0 },
      outcome: { calls: 0, totalDurationMs: 0 },
    },
    lastOutcome: '',
    lastReasonCategory: '',
    updatedAt: '',
  };
}

function metricsPath(memoryRoot: string): string {
  return path.join(memoryRoot, '.cti-self-history', 'metrics.json');
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function reasonCategory(reason: string): string {
  if (/baseHash|哈希|并发更新/iu.test(reason)) return 'hash_conflict';
  if (/写锁|lock|占用/iu.test(reason)) return 'lock_conflict';
  if (/证据|evidence/iu.test(reason)) return 'evidence_rejected';
  if (/密钥|token|secret|password/iu.test(reason)) return 'sensitive_content';
  return 'other';
}

export function readSelfMaintenanceMetrics(memoryRoot: string): SelfMaintenanceMetrics {
  try {
    const parsed = JSON.parse(fs.readFileSync(metricsPath(memoryRoot), 'utf8')) as SelfMaintenanceMetrics;
    return parsed.protocol === 'cti-self-maintenance-metrics/v1' ? parsed : emptyMetrics();
  } catch {
    return emptyMetrics();
  }
}

export function recordSelfMaintenanceMetric(memoryRoot: string, input: SelfMaintenanceMetricInput): SelfMaintenanceMetrics {
  const metrics = readSelfMaintenanceMetrics(memoryRoot);
  const durationMs = Math.max(0, Math.round(input.durationMs));
  metrics.totalCalls += input.outcome === 'skipped' ? 0 : 1;
  metrics.applied += input.outcome === 'applied' ? 1 : 0;
  metrics.ignored += input.outcome === 'ignored' ? 1 : 0;
  metrics.rejected += input.outcome === 'rejected' ? 1 : 0;
  metrics.errors += input.outcome === 'error' ? 1 : 0;
  metrics.skipped += input.outcome === 'skipped' ? 1 : 0;
  metrics.totalDurationMs += input.outcome === 'skipped' ? 0 : durationMs;
  metrics.averageDurationMs = metrics.totalCalls > 0 ? Math.round(metrics.totalDurationMs / metrics.totalCalls) : 0;
  if (input.outcome !== 'skipped') {
    metrics.byPhase[input.phase].calls += 1;
    metrics.byPhase[input.phase].totalDurationMs += durationMs;
  }
  const category = reasonCategory(input.reason);
  metrics.hashConflicts += category === 'hash_conflict' ? 1 : 0;
  metrics.lockConflicts += category === 'lock_conflict' ? 1 : 0;
  metrics.lastOutcome = input.outcome;
  metrics.lastReasonCategory = category;
  metrics.updatedAt = input.timestamp;
  atomicWrite(metricsPath(memoryRoot), `${JSON.stringify(metrics, null, 2)}\n`);
  return metrics;
}
