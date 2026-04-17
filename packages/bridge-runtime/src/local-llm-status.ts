import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME, type Config } from './config.js';

export type LocalRouterMode = 'hybrid' | 'local_only' | 'codex_only';

export interface LocalLlmRouteSummary {
  timestamp: string;
  mode: LocalRouterMode;
  taskKind: string;
  decision: string;
  provider: 'local' | 'codex' | 'local_best_effort' | 'refuse_local' | 'codex_only';
  reason: string;
  compressedPromptChars: number;
  compressedHistoryChars: number;
  fallbackReason?: string;
}

export interface LocalLlmExecutionSummary {
  timestamp: string;
  action: 'answer_only' | 'run_shell' | 'edit_file' | 'multi_step';
  stepCount: number;
  success: boolean;
  provider: 'local_executor';
  reason: string;
  summary: string;
}

export interface LocalLlmRuntimeStatus {
  enabled: boolean;
  autoRoute: boolean;
  routerEnabled: boolean;
  routerMode: LocalRouterMode;
  forceHub: boolean;
  baseUrl: string;
  model: string;
  routeHits: number;
  routeMisses: number;
  routeFailures: number;
  escalationCount: number;
  localOnlyAnswers: number;
  localRefusals: number;
  executionCount: number;
  executionFailures: number;
  fallbackCount: number;
  serverReachable?: boolean;
  lastCheckAt?: string;
  lastRouteReason?: string;
  lastFallbackReason?: string;
  lastProvider?: 'local' | 'codex' | 'local_best_effort' | 'refuse_local' | 'codex_only';
  lastRouteLabel?: 'codex_primary' | 'local_explicit_task' | 'local_fallback_no_codex' | 'local_refused_out_of_scope' | 'unknown';
  lastCodexPrimary?: boolean;
  lastRequestKind?: string;
  lastDecision?: string;
  lastRefusalReason?: string;
  lastCompressedPromptChars?: number;
  lastCompressedHistoryChars?: number;
  lastError?: string;
  updatedAt?: string;
  recentRoutes?: LocalLlmRouteSummary[];
  recentExecutions?: LocalLlmExecutionSummary[];
}

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_PATH = path.join(RUNTIME_DIR, 'local-llm-status.json');
const MAX_ROUTE_SUMMARIES = 20;
const MAX_EXECUTION_SUMMARIES = 20;

function nowIso(): string {
  return new Date().toISOString();
}

function toRouteLabel(summary: LocalLlmRouteSummary): LocalLlmRuntimeStatus['lastRouteLabel'] {
  const provider = (summary.provider || '').trim().toLowerCase();
  const mode = (summary.mode || '').trim().toLowerCase();
  if (provider === 'codex' || provider === 'codex_only') return 'codex_primary';
  if (provider === 'local_best_effort') return 'local_fallback_no_codex';
  if (provider === 'refuse_local') return 'local_refused_out_of_scope';
  if (provider === 'local' && mode === 'hybrid') return 'local_explicit_task';
  if (provider === 'local' && mode === 'local_only') return 'local_fallback_no_codex';
  return 'unknown';
}

export function getLocalRouterMode(config: Config): LocalRouterMode {
  const raw = (config.localLlmRouterMode || '').trim().toLowerCase();
  if (raw === 'local_only' || raw === 'codex_only' || raw === 'hybrid') return raw;
  if (config.localLlmFallbackToCodex === false) return 'local_only';
  return 'hybrid';
}

export function getLocalLlmStatusPath(): string {
  return STATUS_PATH;
}

export function makeDefaultLocalLlmStatus(config: Config): LocalLlmRuntimeStatus {
  return {
    enabled: config.localLlmEnabled === true,
    autoRoute: config.localLlmAutoRoute !== false,
    routerEnabled: config.localLlmRouterEnabled !== false,
    routerMode: getLocalRouterMode(config),
    forceHub: config.localLlmForceHub !== false,
    baseUrl: config.localLlmBaseUrl || 'http://127.0.0.1:8080',
    model: config.localLlmModel || 'qwen2.5-coder-7b-instruct',
    routeHits: 0,
    routeMisses: 0,
    routeFailures: 0,
    escalationCount: 0,
    localOnlyAnswers: 0,
    localRefusals: 0,
    executionCount: 0,
    executionFailures: 0,
    fallbackCount: 0,
    recentRoutes: [],
    recentExecutions: [],
    updatedAt: nowIso(),
  };
}

export function readLocalLlmStatus(config?: Config): LocalLlmRuntimeStatus {
  const fallback = makeDefaultLocalLlmStatus(config || {
    runtime: 'codex',
    enabledChannels: [],
    defaultWorkDir: process.cwd(),
    defaultMode: 'code',
  });
  try {
    if (!fs.existsSync(STATUS_PATH)) return fallback;
    const raw = fs.readFileSync(STATUS_PATH, 'utf-8').trim();
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) as Partial<LocalLlmRuntimeStatus> };
  } catch {
    return fallback;
  }
}

export function writeLocalLlmStatus(next: LocalLlmRuntimeStatus): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const tmp = `${STATUS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...next, updatedAt: nowIso() }, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_PATH);
}

export function updateLocalLlmStatus(config: Config, patch: Partial<LocalLlmRuntimeStatus>): LocalLlmRuntimeStatus {
  const current = readLocalLlmStatus(config);
  const next: LocalLlmRuntimeStatus = {
    ...current,
    enabled: config.localLlmEnabled === true,
    autoRoute: config.localLlmAutoRoute !== false,
    routerEnabled: config.localLlmRouterEnabled !== false,
    routerMode: getLocalRouterMode(config),
    forceHub: config.localLlmForceHub !== false,
    baseUrl: config.localLlmBaseUrl || current.baseUrl,
    model: config.localLlmModel || current.model,
    ...patch,
  };
  writeLocalLlmStatus(next);
  return next;
}

export function appendLocalLlmRouteSummary(
  config: Config,
  summary: LocalLlmRouteSummary,
  patch: Partial<LocalLlmRuntimeStatus> = {},
): LocalLlmRuntimeStatus {
  const current = readLocalLlmStatus(config);
  const recentRoutes = [...(current.recentRoutes || []), summary].slice(-MAX_ROUTE_SUMMARIES);
  return updateLocalLlmStatus(config, {
    recentRoutes,
    lastDecision: summary.decision,
    lastProvider: summary.provider,
    lastRouteLabel: toRouteLabel(summary),
    lastCodexPrimary: toRouteLabel(summary) === 'codex_primary',
    lastRequestKind: summary.taskKind,
    lastRouteReason: summary.reason,
    lastFallbackReason: summary.fallbackReason,
    lastCompressedPromptChars: summary.compressedPromptChars,
    lastCompressedHistoryChars: summary.compressedHistoryChars,
    ...patch,
  });
}

export function appendLocalLlmExecutionSummary(
  config: Config,
  summary: LocalLlmExecutionSummary,
  patch: Partial<LocalLlmRuntimeStatus> = {},
): LocalLlmRuntimeStatus {
  const current = readLocalLlmStatus(config);
  const recentExecutions = [...(current.recentExecutions || []), summary].slice(-MAX_EXECUTION_SUMMARIES);
  return updateLocalLlmStatus(config, {
    recentExecutions,
    ...patch,
  });
}
