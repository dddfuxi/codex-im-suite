import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME, type Config } from './config.js';

export type LocalRouterMode = 'hybrid' | 'local_only' | 'codex_only';

export interface LocalLlmRouteSummary {
  timestamp: string;
  mode: LocalRouterMode;
  taskKind: string;
  decision: string;
  provider: 'local' | 'codex' | 'codex_local_fallback' | 'local_best_effort' | 'refuse_local' | 'codex_only';
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
  toolCallingState?: 'untested' | 'passed' | 'failed' | 'text_only';
  toolCallingCheckedAt?: string;
  toolCallingModel?: string;
  toolCallingBaseUrl?: string;
  toolCallingMessage?: string;
  toolCallingRecommendedMode?: 'text_only' | 'agent_verified';
  recommendedModels?: LocalModelRecommendation[];
  lastCheckAt?: string;
  lastRouteReason?: string;
  lastFallbackReason?: string;
  lastProvider?: 'local' | 'codex' | 'codex_local_fallback' | 'local_best_effort' | 'refuse_local' | 'codex_only';
  lastRouteLabel?: 'codex_primary' | 'codex_local_fallback' | 'local_explicit_task' | 'local_fallback_no_codex' | 'local_refused_out_of_scope' | 'unknown';
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

export interface LocalModelRecommendation {
  model: string;
  provider: 'ollama' | 'vllm' | 'lmstudio' | 'openai-compatible';
  label: string;
  role: 'text' | 'tool_candidate' | 'strong_tool_candidate' | 'embedding';
  minMemoryGb?: number;
  notes: string;
}

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_PATH = path.join(RUNTIME_DIR, 'local-llm-status.json');
const MAX_ROUTE_SUMMARIES = 20;
const MAX_EXECUTION_SUMMARIES = 20;
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen2.5-coder:7b';

function nowIso(): string {
  return new Date().toISOString();
}

function toRouteLabel(summary: LocalLlmRouteSummary): LocalLlmRuntimeStatus['lastRouteLabel'] {
  const provider = (summary.provider || '').trim().toLowerCase();
  const mode = (summary.mode || '').trim().toLowerCase();
  if (provider === 'codex' || provider === 'codex_only') return 'codex_primary';
  if (provider === 'codex_local_fallback') return 'codex_local_fallback';
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
    enabled: (config.ollamaEnabled ?? config.localLlmEnabled) === true,
    autoRoute: config.localLlmAutoRoute !== false,
    routerEnabled: config.localLlmRouterEnabled !== false,
    routerMode: getLocalRouterMode(config),
    forceHub: config.localLlmForceHub !== false,
    baseUrl: config.localAiBaseUrl || config.ollamaBaseUrl || config.localLlmBaseUrl || DEFAULT_OLLAMA_BASE_URL,
    model: config.localAiModel || config.ollamaModel || config.localLlmModel || DEFAULT_OLLAMA_MODEL,
    routeHits: 0,
    routeMisses: 0,
    routeFailures: 0,
    escalationCount: 0,
    localOnlyAnswers: 0,
    localRefusals: 0,
    executionCount: 0,
    executionFailures: 0,
    fallbackCount: 0,
    toolCallingState: 'untested',
    toolCallingRecommendedMode: 'text_only',
    recommendedModels: [],
    recentRoutes: [],
    recentExecutions: [],
    updatedAt: nowIso(),
  };
}

function isDeprecatedLlamaStatus(status: Partial<LocalLlmRuntimeStatus>): boolean {
  const baseUrl = (status.baseUrl || '').trim();
  const model = (status.model || '').trim();
  return baseUrl === 'http://127.0.0.1:8080'
    || /\.gguf$/i.test(model);
}

function normalizeRuntimeSource(
  status: LocalLlmRuntimeStatus,
  config?: Config,
): LocalLlmRuntimeStatus {
  const desiredBaseUrl = config?.localAiBaseUrl || config?.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL;
  const desiredModel = config?.localAiModel || config?.ollamaModel || DEFAULT_OLLAMA_MODEL;
  if (!isDeprecatedLlamaStatus(status)) return status;
  return {
    ...status,
    baseUrl: desiredBaseUrl,
    model: desiredModel,
    serverReachable: undefined,
    lastCheckAt: undefined,
    lastError: status.lastError || '已忽略旧 llama.cpp 状态，等待 Ollama 健康检查刷新。',
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
    return normalizeRuntimeSource({ ...fallback, ...JSON.parse(raw) as Partial<LocalLlmRuntimeStatus> }, config);
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
    enabled: (config.ollamaEnabled ?? config.localLlmEnabled) === true,
    autoRoute: config.localLlmAutoRoute !== false,
    routerEnabled: config.localLlmRouterEnabled !== false,
    routerMode: getLocalRouterMode(config),
    forceHub: config.localLlmForceHub !== false,
    baseUrl: config.localAiBaseUrl || config.ollamaBaseUrl || config.localLlmBaseUrl || current.baseUrl,
    model: config.localAiModel || config.ollamaModel || config.localLlmModel || current.model,
    ...patch,
  };
  writeLocalLlmStatus(next);
  return next;
}

export function clearLocalLlmTransientStatus(config: Config): LocalLlmRuntimeStatus {
  return updateLocalLlmStatus(config, {
    lastRouteReason: '',
    lastFallbackReason: '',
    lastDecision: '',
    lastRefusalReason: '',
    lastCompressedPromptChars: 0,
    lastCompressedHistoryChars: 0,
    lastProvider: undefined,
    lastRouteLabel: 'unknown',
    lastCodexPrimary: false,
    lastRequestKind: '',
    lastError: '',
  });
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
