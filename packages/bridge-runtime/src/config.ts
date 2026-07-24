import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RegisteredProject } from "@codex-im-suite/contracts";
import { getLocalCodexProviderCapabilities } from "./local-codex-provider-registry.js";
import { loadRegisteredProjectRegistry } from "./projects/project-registry.js";

export interface Config {
  runtime: 'claude' | 'codex' | 'auto';
  enabledChannels: string[];
  defaultWorkDir: string;
  bridgeProcessingTimeoutMs?: number;
  allowedWorkspaceRoots?: string[];
  projectRegistryPath?: string;
  projectDeniedRoots?: string[];
  registeredProjects?: RegisteredProject[];
  projectRegistryWarnings?: string[];
  codexAdditionalDirectories?: string[];
  memoryRepoDir?: string;
  uploadCacheDir?: string;
  unityProjectPath?: string;
  contextHistoryMaxChars?: number;
  contextHistoryMessageMaxChars?: number;
  memoryPromptMaxChars?: number;
  todoPushEnabled?: boolean;
  todoPushPollMs?: number;
  todoPushWindowMs?: number;
  todoPushChannels?: string[];
  directReminderEnabled?: boolean;
  directReminderPushEnabled?: boolean;
  directReminderDecisionMode?: string;
  directReminderAllowSlashCommand?: boolean;
  scheduledTasksEnabled?: boolean;
  scheduledTasksPollMs?: number;
  scheduledTasksMaxConcurrentRuns?: number;
  scheduledTasksFailureAlertAfter?: number;
  scheduledTasksFailureAlertCooldownMs?: number;
  unityMcpEndpoints?: string;
  unityMcpStartCommand?: string;
  localAiKind?: 'ollama' | 'lmstudio' | 'vllm' | 'openai-compatible' | 'custom';
  localAiBaseUrl?: string;
  localAiModel?: string;
  localAiApiKey?: string;
  localAiTimeoutMs?: number;
  codexModelSource?: 'official' | 'local_api' | 'external_api';
  codexRoutingMode?: 'manual' | 'auto_failover';
  codexApiFallbackChain?: Array<'local_api' | 'external_api' | 'official'>;
  codexFailoverCandidateTimeoutMs?: number;
  codexBaseUrl?: string;
  codexApiKey?: string;
  codexModel?: string;
  codexPassModel?: boolean;
  codexReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  codexInheritGlobalMcp?: boolean;
  memoryOptimizerEnabled?: boolean;
  memoryOptimizerIntervalDays?: number;
  memoryOptimizerModelSource?: 'codex_primary' | 'local_ai' | 'external_api';
  ollamaEnabled?: boolean;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  ollamaTimeoutMs?: number;
  localLlmEnabled?: boolean;
  localLlmBaseUrl?: string;
  localLlmModel?: string;
  localLlmTimeoutMs?: number;
  localLlmAutoRoute?: boolean;
  localLlmFallbackToCodex?: boolean;
  localLlmRouterEnabled?: boolean;
  localLlmRouterMode?: 'hybrid' | 'local_only' | 'codex_only';
  localLlmForceHub?: boolean;
  localLlmRouterMaxInputChars?: number;
  localLlmRouterMaxHistoryItems?: number;
  localLlmRouterTimeoutMs?: number;
  localLlmMaxInputChars?: number;
  localLlmMaxOutputTokens?: number;
  localLlmComplexityMode?: string;
  lightChatFastPathEnabled?: boolean;
  lightChatFastPathTimeoutMs?: number;
  memoryIntentTimeoutMs?: number;
  agentCollaborationMode?: 'off' | 'shadow' | 'assist';
  agentWorkerPoolSize?: number;
  agentMaxSpecialists?: number;
  agentTaskTimeoutMs?: number;
  agentTurnBudgetMs?: number;
  agentPerformanceBatchSize?: number;
  agentPerformanceIntervalMs?: number;
  lightChatHistoryLimit?: number;
  lightChatMaxInputChars?: number;
  replyStyleHint?: string;
  /** 通用自适应安全档位；只影响可降级的低风险动作，不取消高风险硬门禁。 */
  safetyPolicyProfile?: 'strict' | 'balanced' | 'fluent';
  defaultModel?: string;
  defaultMode: string;
  defaultExecutorId?: string;
  // Telegram
  tgBotToken?: string;
  tgChatId?: string;
  tgAllowedUsers?: string[];
  tgOwnerUsers?: string[];
  // Feishu
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuDomain?: string;
  feishuAllowedUsers?: string[];
  feishuOwnerUsers?: string[];
  feishuGrantedScopes?: string[];
  feishuDocumentGuideDocId?: string;
  feishuOAuthMode?: 'callback' | 'manual';
  feishuOAuthPublicBaseUrl?: string;
  feishuOAuthManualRedirectUri?: string;
  feishuOAuthCallbackPath?: string;
  feishuOAuthScopes?: string[];
  feishuOAuthCallbackPort?: number;
  feishuCloudMaxChars?: number;
  feishuCloudMaxRows?: number;
  feishuCloudMaxRecords?: number;
  feishuCloudMaxSheets?: number;
  // Discord
  discordBotToken?: string;
  discordAllowedUsers?: string[];
  discordOwnerUsers?: string[];
  discordAllowedChannels?: string[];
  discordAllowedGuilds?: string[];
  // QQ
  qqAppId?: string;
  qqAppSecret?: string;
  qqAllowedUsers?: string[];
  qqOwnerUsers?: string[];
  qqImageEnabled?: boolean;
  qqMaxImageSize?: number;
  // WeChat
  weixinBaseUrl?: string;
  weixinCdnBaseUrl?: string;
  weixinAllowedUsers?: string[];
  weixinOwnerUsers?: string[];
  weixinMediaEnabled?: boolean;
  // Auto-approve all tool permission requests without user confirmation
  autoApprove?: boolean;
  // Prefer minimal bridge/tooling self-repair when the user is blocked by a missing capability
  selfOptimizeOnFailure?: boolean;
  // ── Mavis external agent executor (v3.4 design) ──
  // 12 fields; env primary = CTI_MAVIS_*, alias = MAVIS_* (load only).
  mavisEnabled?: boolean;          // default false (opt-in)
  mavisCliPath?: string;           // default 'mavis'
  mavisAgentName?: string;         // default 'mavis'
  mavisDataDir?: string;           // optional, explicit > env
  mavisBridgeSessionId?: string;   // optional Mavis sender session for communication send
  mavisPort?: number;              // optional
  mavisPollIntervalMs?: number;    // default 1500
  mavisHardTimeoutMs?: number;     // default 480_000
  mavisQuietTimeoutMs?: number;    // default 90_000
  mavisMaxDiffBytes?: number;      // default 32_000
  mavisReadOnly?: boolean;         // true → drop file_write / mcp_ops capabilities
  mavisDefaultExecutor?: boolean;  // true → write sessionExecutorDefaults('mavis-agent')
}

export const CTI_HOME = process.env.CTI_HOME || path.join(os.homedir(), ".claude-to-im");
export const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
export const CONFIG_PATH = path.join(CTI_HOME, "config.env");

export function resolveSuiteRoot(explicitRoot = process.env.CODEX_IM_SUITE_ROOT): string {
  const candidates = [explicitRoot, process.cwd()].filter((value): value is string => Boolean(value?.trim()));
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(path.join(resolved, 'suite.manifest.json'))) return resolved;
  }
  return path.resolve(explicitRoot || process.cwd());
}

/**
 * Read a string env var with primary / alias fallback.
 * Returns the primary value if present, otherwise the alias value, otherwise undefined.
 * If alias is used, logs a one-time warn recommending the primary name.
 */
function readMavisEnv(
  env: Map<string, string>,
  primary: string,
  alias: string,
): string | undefined {
  const primaryValue = env.get(primary);
  if (primaryValue !== undefined) return primaryValue;
  const aliasValue = env.get(alias);
  if (aliasValue !== undefined) {
    // eslint-disable-next-line no-console
    console.warn(`[config] ${alias} is a compatibility alias; prefer ${primary}`);
    return aliasValue;
  }
  return undefined;
}

function readMavisBool(
  env: Map<string, string>,
  primary: string,
  alias: string,
): boolean | undefined {
  const v = readMavisEnv(env, primary, alias);
  if (v === undefined) return undefined;
  return v === 'true';
}

function readMavisNumber(
  env: Map<string, string>,
  primary: string,
  alias: string,
): number | undefined {
  const v = readMavisEnv(env, primary, alias);
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function normalizeExecutorId(value: string | undefined): string | undefined {
  const normalized = (value || "").trim().toLowerCase();
  if (!normalized) return undefined;
  return /^[a-z0-9._-]+$/.test(normalized) ? normalized : undefined;
}

function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

/**
 * 将受控 config.env 投影到当前 Bridge 进程环境。
 *
 * Windows supervisor 不会像 Unix daemon 那样 source config.env；如果不在
 * Runtime 启动时显式覆盖，控制面板进程继承的旧 CTI_* 值会继续传给 Codex
 * SDK。这里只接受合法环境变量名，并按文件值覆盖继承值，使 config.env 在
 * 各平台都保持同一事实来源。
 */
export function hydrateProcessEnvironmentFromConfigFile(configPath = CONFIG_PATH): void {
  let entries: Map<string, string>;
  try {
    entries = parseEnvFile(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return;
  }
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    process.env[key] = value;
  }
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitPathList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const rawEntry of value.split(/[,\n;|]/)) {
    const trimmed = rawEntry.trim();
    if (!trimmed) continue;
    const normalized = path.normalize(trimmed);
    const dedupeKey = path.resolve(normalized).toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    entries.push(normalized);
  }
  return entries.length > 0 ? entries : undefined;
}

function mergeWorkspaceRoots(defaultWorkDir: string, explicitRoots?: string[]): string[] | undefined {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const rawEntry of [defaultWorkDir, ...(explicitRoots || [])]) {
    if (!rawEntry) continue;
    const normalized = path.normalize(rawEntry);
    const dedupeKey = path.resolve(normalized).toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    merged.push(normalized);
  }
  return merged.length > 0 ? merged : undefined;
}

function isSameOrChildPath(candidatePath: string, rootPath?: string): boolean {
  if (!rootPath) return false;
  const candidate = path.resolve(candidatePath).replace(/[\\/]+$/, "");
  const root = path.resolve(rootPath).replace(/[\\/]+$/, "");
  return candidate.toLowerCase() === root.toLowerCase()
    || candidate.toLowerCase().startsWith((root + path.sep).toLowerCase());
}

function getDefaultMemoryRepoDir(): string {
  return process.platform === "win32" ? "E:\\cli-md" : path.join(CTI_HOME, "memory-repo");
}

function getDefaultUploadCacheDir(): string {
  return path.join(CTI_HOME, "runtime", "uploads");
}

function getDefaultProjectRegistryPath(): string {
  return path.join(CTI_HOME, "project-registry.json");
}

function resolveSafeMemoryRepoDir(rawMemoryRepoDir: string | undefined, defaultWorkDir: string): string {
  const fallback = getDefaultMemoryRepoDir();
  const configured = rawMemoryRepoDir && rawMemoryRepoDir.trim() ? rawMemoryRepoDir.trim() : fallback;
  const normalized = path.resolve(configured);
  if (isSameOrChildPath(normalized, defaultWorkDir)) {
    return fallback;
  }
  return normalized;
}

function resolveSafeUploadCacheDir(rawUploadCacheDir: string | undefined, defaultWorkDir: string): string {
  const fallback = getDefaultUploadCacheDir();
  const configured = rawUploadCacheDir && rawUploadCacheDir.trim() ? rawUploadCacheDir.trim() : fallback;
  const normalized = path.resolve(configured);
  return isSameOrChildPath(normalized, defaultWorkDir) ? fallback : normalized;
}

export function loadConfig(): Config {
  let env = new Map<string, string>();
  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf-8");
    env = parseEnvFile(content);
  } catch {
    // Config file doesn't exist yet — use defaults
  }

  const rawRuntime = env.get("CTI_RUNTIME") || "claude";
  const runtime = (["claude", "codex", "auto"].includes(rawRuntime) ? rawRuntime : "claude") as Config["runtime"];
  const defaultWorkDir = env.get("CTI_DEFAULT_WORKDIR") || process.cwd();
  const codexAdditionalDirectories = splitPathList(env.get("CTI_CODEX_ADDITIONAL_DIRECTORIES"));
  const rawMemoryRepoDir = env.get("CTI_MEMORY_REPO_DIR") || undefined;
  const rawUploadCacheDir = env.get("CTI_UPLOAD_CACHE_DIR") || undefined;
  const unityProjectPath = env.get("CTI_UNITY_PROJECT_PATH") || undefined;
  const contextHistoryMaxChars = env.get("CTI_CONTEXT_HISTORY_MAX_CHARS")
    ? Number(env.get("CTI_CONTEXT_HISTORY_MAX_CHARS"))
    : undefined;
  const bridgeProcessingTimeoutMs = env.has("CTI_BRIDGE_PROCESSING_TIMEOUT_MS")
    ? Number(env.get("CTI_BRIDGE_PROCESSING_TIMEOUT_MS"))
    : undefined;
  const contextHistoryMessageMaxChars = env.get("CTI_CONTEXT_HISTORY_MESSAGE_MAX_CHARS")
    ? Number(env.get("CTI_CONTEXT_HISTORY_MESSAGE_MAX_CHARS"))
    : undefined;
  const memoryPromptMaxChars = env.get("CTI_MEMORY_PROMPT_MAX_CHARS")
    ? Number(env.get("CTI_MEMORY_PROMPT_MAX_CHARS"))
    : undefined;
  const todoPushPollMs = env.get("CTI_TODO_PUSH_POLL_MS")
    ? Number(env.get("CTI_TODO_PUSH_POLL_MS"))
    : undefined;
  const todoPushWindowMs = env.get("CTI_TODO_PUSH_WINDOW_MS")
    ? Number(env.get("CTI_TODO_PUSH_WINDOW_MS"))
    : undefined;
  const scheduledTasksPollMs = env.get("CTI_SCHEDULED_TASKS_POLL_MS")
    ? Number(env.get("CTI_SCHEDULED_TASKS_POLL_MS"))
    : undefined;
  const scheduledTasksMaxConcurrentRuns = env.get("CTI_SCHEDULED_TASKS_MAX_CONCURRENT_RUNS")
    ? Number(env.get("CTI_SCHEDULED_TASKS_MAX_CONCURRENT_RUNS"))
    : undefined;
  const scheduledTasksFailureAlertAfter = env.get("CTI_SCHEDULED_TASKS_FAILURE_ALERT_AFTER")
    ? Number(env.get("CTI_SCHEDULED_TASKS_FAILURE_ALERT_AFTER"))
    : undefined;
  const scheduledTasksFailureAlertCooldownMs = env.get("CTI_SCHEDULED_TASKS_FAILURE_ALERT_COOLDOWN_MS")
    ? Number(env.get("CTI_SCHEDULED_TASKS_FAILURE_ALERT_COOLDOWN_MS"))
    : undefined;
  const localLlmTimeoutMs = env.get("CTI_LOCAL_LLM_TIMEOUT_MS")
    ? Number(env.get("CTI_LOCAL_LLM_TIMEOUT_MS"))
    : undefined;
  const ollamaTimeoutMs = env.get("CTI_OLLAMA_TIMEOUT_MS")
    ? Number(env.get("CTI_OLLAMA_TIMEOUT_MS"))
    : undefined;
  const localAiTimeoutMs = env.get("CTI_LOCAL_AI_TIMEOUT_MS")
    ? Number(env.get("CTI_LOCAL_AI_TIMEOUT_MS"))
    : undefined;
  const codexFailoverCandidateTimeoutMs = env.get("CTI_CODEX_FAILOVER_CANDIDATE_TIMEOUT_MS")
    ? Number(env.get("CTI_CODEX_FAILOVER_CANDIDATE_TIMEOUT_MS"))
    : undefined;
  const localLlmRouterMaxInputChars = env.get("CTI_LOCAL_LLM_ROUTER_MAX_INPUT_CHARS")
    ? Number(env.get("CTI_LOCAL_LLM_ROUTER_MAX_INPUT_CHARS"))
    : undefined;
  const localLlmRouterMaxHistoryItems = env.get("CTI_LOCAL_LLM_ROUTER_MAX_HISTORY_ITEMS")
    ? Number(env.get("CTI_LOCAL_LLM_ROUTER_MAX_HISTORY_ITEMS"))
    : undefined;
  const localLlmRouterTimeoutMs = env.get("CTI_LOCAL_LLM_ROUTER_TIMEOUT_MS")
    ? Number(env.get("CTI_LOCAL_LLM_ROUTER_TIMEOUT_MS"))
    : undefined;
  const lightChatFastPathTimeoutMs = env.get("CTI_LIGHT_CHAT_FAST_PATH_TIMEOUT_MS")
    ? Number(env.get("CTI_LIGHT_CHAT_FAST_PATH_TIMEOUT_MS"))
    : undefined;
  const memoryIntentTimeoutMs = env.get("CTI_MEMORY_INTENT_TIMEOUT_MS")
    ? Number(env.get("CTI_MEMORY_INTENT_TIMEOUT_MS"))
    : undefined;
  const rawAgentCollaborationMode = (env.get("CTI_AGENT_COLLABORATION_MODE") || "off").trim().toLowerCase();
  const agentCollaborationMode = (["off", "shadow", "assist"].includes(rawAgentCollaborationMode)
    ? rawAgentCollaborationMode
    : "off") as NonNullable<Config["agentCollaborationMode"]>;
  const agentWorkerPoolSize = env.get("CTI_AGENT_WORKER_POOL_SIZE")
    ? Number(env.get("CTI_AGENT_WORKER_POOL_SIZE"))
    : undefined;
  const agentMaxSpecialists = env.get("CTI_AGENT_MAX_SPECIALISTS")
    ? Number(env.get("CTI_AGENT_MAX_SPECIALISTS"))
    : undefined;
  const agentTaskTimeoutMs = env.get("CTI_AGENT_TASK_TIMEOUT_MS")
    ? Number(env.get("CTI_AGENT_TASK_TIMEOUT_MS"))
    : undefined;
  const agentTurnBudgetMs = env.get("CTI_AGENT_TURN_BUDGET_MS")
    ? Number(env.get("CTI_AGENT_TURN_BUDGET_MS"))
    : undefined;
  const agentPerformanceBatchSize = env.get("CTI_AGENT_PERFORMANCE_BATCH_SIZE")
    ? Number(env.get("CTI_AGENT_PERFORMANCE_BATCH_SIZE"))
    : undefined;
  const agentPerformanceIntervalMs = env.get("CTI_AGENT_PERFORMANCE_INTERVAL_MS")
    ? Number(env.get("CTI_AGENT_PERFORMANCE_INTERVAL_MS"))
    : undefined;
  const lightChatHistoryLimit = env.get("CTI_LIGHT_CHAT_HISTORY_LIMIT")
    ? Number(env.get("CTI_LIGHT_CHAT_HISTORY_LIMIT"))
    : undefined;
  const lightChatMaxInputChars = env.get("CTI_LIGHT_CHAT_MAX_INPUT_CHARS")
    ? Number(env.get("CTI_LIGHT_CHAT_MAX_INPUT_CHARS"))
    : undefined;
  const localLlmMaxInputChars = env.get("CTI_LOCAL_LLM_MAX_INPUT_CHARS")
    ? Number(env.get("CTI_LOCAL_LLM_MAX_INPUT_CHARS"))
    : undefined;
  const localLlmMaxOutputTokens = env.get("CTI_LOCAL_LLM_MAX_OUTPUT_TOKENS")
    ? Number(env.get("CTI_LOCAL_LLM_MAX_OUTPUT_TOKENS"))
    : undefined;
  const feishuOAuthCallbackPort = env.get("CTI_FEISHU_OAUTH_CALLBACK_PORT")
    ? Number(env.get("CTI_FEISHU_OAUTH_CALLBACK_PORT"))
    : undefined;
  const feishuCloudMaxChars = env.get("CTI_FEISHU_CLOUD_MAX_CHARS")
    ? Number(env.get("CTI_FEISHU_CLOUD_MAX_CHARS"))
    : undefined;
  const feishuCloudMaxRows = env.get("CTI_FEISHU_CLOUD_MAX_ROWS")
    ? Number(env.get("CTI_FEISHU_CLOUD_MAX_ROWS"))
    : undefined;
  const feishuCloudMaxRecords = env.get("CTI_FEISHU_CLOUD_MAX_RECORDS")
    ? Number(env.get("CTI_FEISHU_CLOUD_MAX_RECORDS"))
    : undefined;
  const feishuCloudMaxSheets = env.get("CTI_FEISHU_CLOUD_MAX_SHEETS")
    ? Number(env.get("CTI_FEISHU_CLOUD_MAX_SHEETS"))
    : undefined;
  const allowedWorkspaceRoots = mergeWorkspaceRoots(
    defaultWorkDir,
    splitPathList(env.get("CTI_ALLOWED_WORKSPACE_ROOTS")),
  );
  const memoryRepoDir = resolveSafeMemoryRepoDir(rawMemoryRepoDir, defaultWorkDir);
  const uploadCacheDir = resolveSafeUploadCacheDir(rawUploadCacheDir, defaultWorkDir);
  const projectRegistryPath = path.resolve(env.get("CTI_PROJECT_REGISTRY_PATH") || getDefaultProjectRegistryPath());
  const projectDeniedRoots = splitPathList(env.get("CTI_PROJECT_DENIED_ROOTS")) || [];
  const projectDeniedRootMap = new Map<string, string>();
  for (const item of [
    CTI_HOME,
    CODEX_HOME,
    memoryRepoDir,
    uploadCacheDir,
    ...projectDeniedRoots,
  ]) {
    const resolved = path.resolve(item);
    projectDeniedRootMap.set(process.platform === "win32" ? resolved.toLowerCase() : resolved, resolved);
  }
  const effectiveProjectDeniedRoots = Array.from(projectDeniedRootMap.values());
  const projectRegistry = loadRegisteredProjectRegistry({
    registryPath: projectRegistryPath,
    legacyRoots: allowedWorkspaceRoots,
    deniedRoots: effectiveProjectDeniedRoots,
  });
  const ollamaEnabled = env.has("CTI_OLLAMA_ENABLED")
    ? env.get("CTI_OLLAMA_ENABLED") === "true"
    : (env.has("CTI_LOCAL_LLM_ENABLED") ? env.get("CTI_LOCAL_LLM_ENABLED") === "true" : true);
  const rawLocalAiKind = (env.get("CTI_LOCAL_AI_KIND") || "ollama").trim().toLowerCase();
  const localAiKind = (["ollama", "lmstudio", "vllm", "openai-compatible", "custom"].includes(rawLocalAiKind)
    ? rawLocalAiKind
    : "ollama") as NonNullable<Config["localAiKind"]>;
  const localAiBaseUrl = env.get("CTI_LOCAL_AI_BASE_URL")
    || env.get("CTI_OLLAMA_BASE_URL")
    || "http://127.0.0.1:11434";
  const localAiModel = env.get("CTI_LOCAL_AI_MODEL")
    || env.get("CTI_OLLAMA_MODEL")
    || "qwen2.5-coder:7b";
  const effectiveLocalAiTimeoutMs = localAiTimeoutMs ?? ollamaTimeoutMs ?? localLlmTimeoutMs ?? 45000;
  const ollamaBaseUrl = localAiBaseUrl;
  const ollamaModel = localAiModel;
  const effectiveOllamaTimeoutMs = effectiveLocalAiTimeoutMs;
  const rawCodexReasoningEffort = (env.get("CTI_CODEX_REASONING_EFFORT") || "").trim().toLowerCase();
  const codexReasoningEffort = ["minimal", "low", "medium", "high", "xhigh"].includes(rawCodexReasoningEffort)
    ? rawCodexReasoningEffort as NonNullable<Config["codexReasoningEffort"]>
    : undefined;
  const rawCodexModelSource = (env.get("CTI_CODEX_MODEL_SOURCE") || "").trim().toLowerCase();
  const codexModelSource = (["official", "local_api", "external_api"].includes(rawCodexModelSource)
    ? rawCodexModelSource
    : ((env.get("CTI_CODEX_BASE_URL") || env.get("CTI_CODEX_MODEL") || env.get("CTI_CODEX_API_KEY")) ? "external_api" : "official")) as NonNullable<Config["codexModelSource"]>;
  const rawCodexRoutingMode = (env.get("CTI_CODEX_ROUTING_MODE") || "").trim().toLowerCase();
  const codexRoutingMode = (rawCodexRoutingMode === "auto_failover" ? "auto_failover" : "manual") as NonNullable<Config["codexRoutingMode"]>;
  const rawCodexApiFallbackChain = splitCsv(env.get("CTI_CODEX_API_FALLBACK_CHAIN")) || ["local_api", "external_api"];
  const codexApiFallbackChain = Array.from(new Set(rawCodexApiFallbackChain
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is 'local_api' | 'external_api' | 'official' => item === "local_api" || item === "external_api" || item === "official")));
  const defaultExecutorId = normalizeExecutorId(env.get("CTI_DEFAULT_EXECUTOR_ID"));
  const memoryOptimizerIntervalDays = env.get("CTI_MEMORY_OPTIMIZER_INTERVAL_DAYS")
    ? Number(env.get("CTI_MEMORY_OPTIMIZER_INTERVAL_DAYS"))
    : 7;
  const rawMemoryOptimizerModelSource = (env.get("CTI_MEMORY_OPTIMIZER_MODEL_SOURCE") || "").trim().toLowerCase();
  const memoryOptimizerModelSource = (["codex_primary", "local_ai", "external_api"].includes(rawMemoryOptimizerModelSource)
    ? rawMemoryOptimizerModelSource
    : "codex_primary") as NonNullable<Config["memoryOptimizerModelSource"]>;

  return {
    runtime,
    enabledChannels: splitCsv(env.get("CTI_ENABLED_CHANNELS")) ?? [],
    defaultWorkDir,
    bridgeProcessingTimeoutMs,
    allowedWorkspaceRoots,
    projectRegistryPath,
    projectDeniedRoots,
    registeredProjects: projectRegistry.projects,
    projectRegistryWarnings: projectRegistry.warnings,
    codexAdditionalDirectories,
    memoryRepoDir,
    uploadCacheDir,
    unityProjectPath,
    contextHistoryMaxChars,
    contextHistoryMessageMaxChars,
    memoryPromptMaxChars,
    todoPushEnabled: env.has("CTI_TODO_PUSH_ENABLED")
      ? env.get("CTI_TODO_PUSH_ENABLED") === "true"
      : false,
    todoPushPollMs: todoPushPollMs ?? 60000,
    todoPushWindowMs: todoPushWindowMs ?? 5 * 60 * 1000,
    todoPushChannels: splitCsv(env.get("CTI_TODO_PUSH_CHANNELS")) ?? ["feishu"],
    directReminderEnabled: env.has("CTI_DIRECT_REMINDER_ENABLED")
      ? env.get("CTI_DIRECT_REMINDER_ENABLED") === "true"
      : true,
    directReminderPushEnabled: env.has("CTI_DIRECT_REMINDER_PUSH_ENABLED")
      ? env.get("CTI_DIRECT_REMINDER_PUSH_ENABLED") === "true"
      : true,
    directReminderDecisionMode: env.get("CTI_DIRECT_REMINDER_DECISION_MODE") || "codex_action",
    directReminderAllowSlashCommand: env.has("CTI_DIRECT_REMINDER_ALLOW_SLASH_COMMAND")
      ? env.get("CTI_DIRECT_REMINDER_ALLOW_SLASH_COMMAND") === "true"
      : true,
    scheduledTasksEnabled: env.has("CTI_SCHEDULED_TASKS_ENABLED")
      ? env.get("CTI_SCHEDULED_TASKS_ENABLED") === "true"
      : true,
    scheduledTasksPollMs: typeof scheduledTasksPollMs === "number" && Number.isFinite(scheduledTasksPollMs)
      ? Math.max(5000, Math.floor(scheduledTasksPollMs))
      : 15000,
    scheduledTasksMaxConcurrentRuns: typeof scheduledTasksMaxConcurrentRuns === "number" && Number.isFinite(scheduledTasksMaxConcurrentRuns)
      ? Math.max(1, Math.min(16, Math.floor(scheduledTasksMaxConcurrentRuns)))
      : 4,
    scheduledTasksFailureAlertAfter: typeof scheduledTasksFailureAlertAfter === "number" && Number.isFinite(scheduledTasksFailureAlertAfter)
      ? Math.max(1, Math.floor(scheduledTasksFailureAlertAfter))
      : 3,
    scheduledTasksFailureAlertCooldownMs: typeof scheduledTasksFailureAlertCooldownMs === "number" && Number.isFinite(scheduledTasksFailureAlertCooldownMs)
      ? Math.max(60000, Math.floor(scheduledTasksFailureAlertCooldownMs))
      : 3600000,
    unityMcpEndpoints: env.get("CTI_UNITY_MCP_ENDPOINTS") || undefined,
    unityMcpStartCommand: env.get("CTI_UNITY_MCP_START_COMMAND") || undefined,
    localAiKind,
    localAiBaseUrl,
    localAiModel,
    localAiApiKey: env.get("CTI_LOCAL_AI_API_KEY") || undefined,
    localAiTimeoutMs: effectiveLocalAiTimeoutMs,
    codexModelSource,
    codexRoutingMode,
    codexApiFallbackChain: codexApiFallbackChain.length > 0 ? codexApiFallbackChain : ["local_api", "external_api"],
    codexFailoverCandidateTimeoutMs: typeof codexFailoverCandidateTimeoutMs === "number" && Number.isFinite(codexFailoverCandidateTimeoutMs)
      ? Math.max(250, Math.min(30_000, Math.floor(codexFailoverCandidateTimeoutMs)))
      : 2000,
    codexBaseUrl: env.get("CTI_CODEX_BASE_URL") || undefined,
    codexApiKey: env.get("CTI_CODEX_API_KEY") || undefined,
    codexModel: env.get("CTI_CODEX_MODEL") || undefined,
    codexPassModel: env.has("CTI_CODEX_PASS_MODEL") ? env.get("CTI_CODEX_PASS_MODEL") === "true" : undefined,
    codexReasoningEffort,
    codexInheritGlobalMcp: env.has("CTI_CODEX_INHERIT_GLOBAL_MCP") ? env.get("CTI_CODEX_INHERIT_GLOBAL_MCP") === "true" : false,
    memoryOptimizerEnabled: env.has("CTI_MEMORY_OPTIMIZER_ENABLED") ? env.get("CTI_MEMORY_OPTIMIZER_ENABLED") === "true" : false,
    memoryOptimizerIntervalDays: Number.isFinite(memoryOptimizerIntervalDays) ? Math.max(1, Math.floor(memoryOptimizerIntervalDays)) : 7,
    memoryOptimizerModelSource,
    ollamaEnabled,
    ollamaBaseUrl,
    ollamaModel,
    ollamaTimeoutMs: effectiveOllamaTimeoutMs,
    localLlmEnabled: env.has("CTI_LOCAL_LLM_ENABLED")
      ? env.get("CTI_LOCAL_LLM_ENABLED") === "true"
      : ollamaEnabled,
    localLlmBaseUrl: ollamaBaseUrl,
    localLlmModel: ollamaModel,
    localLlmTimeoutMs: effectiveOllamaTimeoutMs,
    localLlmAutoRoute: env.has("CTI_LOCAL_LLM_AUTO_ROUTE")
      ? env.get("CTI_LOCAL_LLM_AUTO_ROUTE") === "true"
      : true,
    localLlmFallbackToCodex: env.has("CTI_LOCAL_LLM_FALLBACK_TO_CODEX")
      ? env.get("CTI_LOCAL_LLM_FALLBACK_TO_CODEX") === "true"
      : true,
    localLlmRouterEnabled: env.has("CTI_LOCAL_LLM_ROUTER_ENABLED")
      ? env.get("CTI_LOCAL_LLM_ROUTER_ENABLED") === "true"
      : true,
    localLlmRouterMode: ((env.get("CTI_LOCAL_LLM_ROUTER_MODE") || "hybrid").trim().toLowerCase() as Config["localLlmRouterMode"]) || "hybrid",
    localLlmForceHub: env.has("CTI_LOCAL_LLM_FORCE_HUB")
      ? env.get("CTI_LOCAL_LLM_FORCE_HUB") === "true"
      : true,
    localLlmRouterMaxInputChars: localLlmRouterMaxInputChars ?? (localLlmMaxInputChars ?? 6000),
    localLlmRouterMaxHistoryItems: localLlmRouterMaxHistoryItems ?? 6,
    localLlmRouterTimeoutMs: localLlmRouterTimeoutMs ?? 30000,
    localLlmMaxInputChars: localLlmMaxInputChars ?? 6000,
    localLlmMaxOutputTokens: localLlmMaxOutputTokens ?? 768,
    localLlmComplexityMode: env.get("CTI_LOCAL_LLM_COMPLEXITY_MODE") || "conservative",
    lightChatFastPathEnabled: env.has("CTI_LIGHT_CHAT_FAST_PATH_ENABLED")
      ? env.get("CTI_LIGHT_CHAT_FAST_PATH_ENABLED") === "true"
      : true,
    lightChatFastPathTimeoutMs: typeof lightChatFastPathTimeoutMs === "number" && Number.isFinite(lightChatFastPathTimeoutMs)
      ? Math.max(250, Math.min(10_000, Math.floor(lightChatFastPathTimeoutMs)))
      : 2000,
    memoryIntentTimeoutMs: typeof memoryIntentTimeoutMs === "number" && Number.isFinite(memoryIntentTimeoutMs)
      ? Math.max(30_000, Math.min(60_000, Math.floor(memoryIntentTimeoutMs)))
      : 30_000,
    agentCollaborationMode,
    agentWorkerPoolSize: typeof agentWorkerPoolSize === "number" && Number.isFinite(agentWorkerPoolSize)
      ? Math.max(1, Math.min(4, Math.floor(agentWorkerPoolSize)))
      : 2,
    agentMaxSpecialists: typeof agentMaxSpecialists === "number" && Number.isFinite(agentMaxSpecialists)
      ? Math.max(1, Math.min(2, Math.floor(agentMaxSpecialists)))
      : 2,
    agentTaskTimeoutMs: typeof agentTaskTimeoutMs === "number" && Number.isFinite(agentTaskTimeoutMs)
      ? Math.max(1_000, Math.min(120_000, Math.floor(agentTaskTimeoutMs)))
      : 30_000,
    agentTurnBudgetMs: typeof agentTurnBudgetMs === "number" && Number.isFinite(agentTurnBudgetMs)
      ? Math.max(1_000, Math.min(180_000, Math.floor(agentTurnBudgetMs)))
      : 35_000,
    agentPerformanceBatchSize: typeof agentPerformanceBatchSize === "number" && Number.isFinite(agentPerformanceBatchSize)
      ? Math.max(5, Math.min(500, Math.floor(agentPerformanceBatchSize)))
      : 20,
    agentPerformanceIntervalMs: typeof agentPerformanceIntervalMs === "number" && Number.isFinite(agentPerformanceIntervalMs)
      ? Math.max(60_000, Math.min(24 * 60 * 60_000, Math.floor(agentPerformanceIntervalMs)))
      : 1_800_000,
    lightChatHistoryLimit: typeof lightChatHistoryLimit === "number" && Number.isFinite(lightChatHistoryLimit) ? Math.max(0, Math.floor(lightChatHistoryLimit)) : 2,
    lightChatMaxInputChars: typeof lightChatMaxInputChars === "number" && Number.isFinite(lightChatMaxInputChars) ? Math.max(80, Math.floor(lightChatMaxInputChars)) : 280,
    replyStyleHint: env.get("CTI_REPLY_STYLE_HINT") || undefined,
    safetyPolicyProfile: (['strict', 'balanced', 'fluent'].includes(
      (env.get("CTI_SAFETY_POLICY_PROFILE") || "balanced").trim().toLowerCase(),
    ) ? (env.get("CTI_SAFETY_POLICY_PROFILE") || "balanced").trim().toLowerCase() : "balanced") as Config["safetyPolicyProfile"],
    defaultModel: env.get("CTI_DEFAULT_MODEL") || undefined,
    defaultMode: env.get("CTI_DEFAULT_MODE") || "code",
    defaultExecutorId,
    tgBotToken: env.get("CTI_TG_BOT_TOKEN") || undefined,
    tgChatId: env.get("CTI_TG_CHAT_ID") || undefined,
    tgAllowedUsers: splitCsv(env.get("CTI_TG_ALLOWED_USERS")),
    tgOwnerUsers: splitCsv(env.get("CTI_TG_OWNER_USERS")),
    feishuAppId: env.get("CTI_FEISHU_APP_ID") || undefined,
    feishuAppSecret: env.get("CTI_FEISHU_APP_SECRET") || undefined,
    feishuDomain: env.get("CTI_FEISHU_DOMAIN") || undefined,
    feishuAllowedUsers: splitCsv(env.get("CTI_FEISHU_ALLOWED_USERS")),
    feishuOwnerUsers: splitCsv(env.get("CTI_FEISHU_OWNER_USERS")),
    feishuGrantedScopes: splitCsv(env.get("CTI_FEISHU_GRANTED_SCOPES")),
    feishuDocumentGuideDocId: env.get("CTI_FEISHU_DOCUMENT_GUIDE_DOC_ID") || undefined,
    feishuOAuthMode: (env.get("CTI_FEISHU_OAUTH_MODE") || "callback").trim().toLowerCase() === "manual" ? "manual" : "callback",
    feishuOAuthPublicBaseUrl: env.get("CTI_FEISHU_OAUTH_PUBLIC_BASE_URL") || undefined,
    feishuOAuthManualRedirectUri: env.get("CTI_FEISHU_OAUTH_MANUAL_REDIRECT_URI") || undefined,
    feishuOAuthCallbackPath: env.get("CTI_FEISHU_OAUTH_CALLBACK_PATH") || "/feishu/oauth/callback",
    feishuOAuthScopes: splitCsv(env.get("CTI_FEISHU_OAUTH_SCOPES")) ?? [
      "offline_access",
      "docx:document:readonly",
      "sheets:spreadsheet:readonly",
      "sheets:spreadsheet:read",
      "drive:drive:readonly",
      "bitable:app:readonly",
      "base:table:read",
      "base:field:read",
      "base:record:retrieve",
    ],
    feishuOAuthCallbackPort: feishuOAuthCallbackPort ?? 17321,
    feishuCloudMaxChars: feishuCloudMaxChars ?? 80000,
    feishuCloudMaxRows: feishuCloudMaxRows ?? 500,
    feishuCloudMaxRecords: feishuCloudMaxRecords ?? 500,
    feishuCloudMaxSheets: feishuCloudMaxSheets ?? 5,
    discordBotToken: env.get("CTI_DISCORD_BOT_TOKEN") || undefined,
    discordAllowedUsers: splitCsv(env.get("CTI_DISCORD_ALLOWED_USERS")),
    discordOwnerUsers: splitCsv(env.get("CTI_DISCORD_OWNER_USERS")),
    discordAllowedChannels: splitCsv(
      env.get("CTI_DISCORD_ALLOWED_CHANNELS")
    ),
    discordAllowedGuilds: splitCsv(env.get("CTI_DISCORD_ALLOWED_GUILDS")),
    qqAppId: env.get("CTI_QQ_APP_ID") || undefined,
    qqAppSecret: env.get("CTI_QQ_APP_SECRET") || undefined,
    qqAllowedUsers: splitCsv(env.get("CTI_QQ_ALLOWED_USERS")),
    qqOwnerUsers: splitCsv(env.get("CTI_QQ_OWNER_USERS")),
    qqImageEnabled: env.has("CTI_QQ_IMAGE_ENABLED")
      ? env.get("CTI_QQ_IMAGE_ENABLED") === "true"
      : undefined,
    qqMaxImageSize: env.get("CTI_QQ_MAX_IMAGE_SIZE")
      ? Number(env.get("CTI_QQ_MAX_IMAGE_SIZE"))
      : undefined,
    weixinBaseUrl: env.get("CTI_WEIXIN_BASE_URL") || undefined,
    weixinCdnBaseUrl: env.get("CTI_WEIXIN_CDN_BASE_URL") || undefined,
    weixinAllowedUsers: splitCsv(env.get("CTI_WEIXIN_ALLOWED_USERS")),
    weixinOwnerUsers: splitCsv(env.get("CTI_WEIXIN_OWNER_USERS")),
    weixinMediaEnabled: env.has("CTI_WEIXIN_MEDIA_ENABLED")
      ? env.get("CTI_WEIXIN_MEDIA_ENABLED") === "true"
      : undefined,
    autoApprove: env.get("CTI_AUTO_APPROVE") === "true",
    selfOptimizeOnFailure: env.has("CTI_SELF_OPTIMIZE_ON_FAILURE")
      ? env.get("CTI_SELF_OPTIMIZE_ON_FAILURE") === "true"
      : undefined,
    // ── Mavis external agent (v3.4) — CTI_MAVIS_* primary, MAVIS_* alias (load only) ──
    mavisEnabled: readMavisBool(env, "CTI_MAVIS_ENABLED", "MAVIS_ENABLED"),
    mavisCliPath: readMavisEnv(env, "CTI_MAVIS_CLI_PATH", "MAVIS_CLI_PATH"),
    mavisAgentName: readMavisEnv(env, "CTI_MAVIS_AGENT_NAME", "MAVIS_AGENT_NAME"),
    mavisDataDir: readMavisEnv(env, "CTI_MAVIS_DATA_DIR", "MAVIS_DATA_DIR"),
    mavisBridgeSessionId: readMavisEnv(env, "CTI_MAVIS_BRIDGE_SESSION_ID", "MAVIS_BRIDGE_SESSION_ID"),
    mavisPort: readMavisNumber(env, "CTI_MAVIS_PORT", "MAVIS_PORT"),
    mavisPollIntervalMs: readMavisNumber(env, "CTI_MAVIS_POLL_INTERVAL_MS", "MAVIS_POLL_INTERVAL_MS"),
    mavisHardTimeoutMs: readMavisNumber(env, "CTI_MAVIS_HARD_TIMEOUT_MS", "MAVIS_HARD_TIMEOUT_MS"),
    mavisQuietTimeoutMs: readMavisNumber(env, "CTI_MAVIS_QUIET_TIMEOUT_MS", "MAVIS_QUIET_TIMEOUT_MS"),
    mavisMaxDiffBytes: readMavisNumber(env, "CTI_MAVIS_MAX_DIFF_BYTES", "MAVIS_MAX_DIFF_BYTES"),
    mavisReadOnly: readMavisBool(env, "CTI_MAVIS_READ_ONLY", "MAVIS_READ_ONLY"),
    mavisDefaultExecutor: readMavisBool(env, "CTI_MAVIS_DEFAULT_EXECUTOR", "MAVIS_DEFAULT_EXECUTOR"),
  };
}

function formatEnvLine(key: string, value: string | undefined): string {
  if (value === undefined || value === "") return "";
  return `${key}=${value}\n`;
}

export function saveConfig(config: Config): void {
  let out = "";
  out += formatEnvLine("CTI_RUNTIME", config.runtime);
  out += formatEnvLine(
    "CTI_ENABLED_CHANNELS",
    config.enabledChannels.join(",")
  );
  out += formatEnvLine("CTI_DEFAULT_WORKDIR", config.defaultWorkDir);
  if (config.bridgeProcessingTimeoutMs !== undefined)
    out += formatEnvLine("CTI_BRIDGE_PROCESSING_TIMEOUT_MS", String(config.bridgeProcessingTimeoutMs));
  out += formatEnvLine("CTI_ALLOWED_WORKSPACE_ROOTS", config.allowedWorkspaceRoots?.join(";"));
  out += formatEnvLine("CTI_PROJECT_REGISTRY_PATH", config.projectRegistryPath);
  out += formatEnvLine("CTI_PROJECT_DENIED_ROOTS", config.projectDeniedRoots?.join(";"));
  out += formatEnvLine("CTI_CODEX_ADDITIONAL_DIRECTORIES", config.codexAdditionalDirectories?.join(";"));
  out += formatEnvLine("CTI_MEMORY_REPO_DIR", config.memoryRepoDir);
  out += formatEnvLine("CTI_UPLOAD_CACHE_DIR", config.uploadCacheDir);
  out += formatEnvLine("CTI_UNITY_PROJECT_PATH", config.unityProjectPath);
  if (config.contextHistoryMaxChars !== undefined)
    out += formatEnvLine("CTI_CONTEXT_HISTORY_MAX_CHARS", String(config.contextHistoryMaxChars));
  if (config.contextHistoryMessageMaxChars !== undefined)
    out += formatEnvLine("CTI_CONTEXT_HISTORY_MESSAGE_MAX_CHARS", String(config.contextHistoryMessageMaxChars));
  if (config.memoryPromptMaxChars !== undefined)
    out += formatEnvLine("CTI_MEMORY_PROMPT_MAX_CHARS", String(config.memoryPromptMaxChars));
  if (config.todoPushEnabled !== undefined)
    out += formatEnvLine("CTI_TODO_PUSH_ENABLED", String(config.todoPushEnabled));
  if (config.todoPushPollMs !== undefined)
    out += formatEnvLine("CTI_TODO_PUSH_POLL_MS", String(config.todoPushPollMs));
  if (config.todoPushWindowMs !== undefined)
    out += formatEnvLine("CTI_TODO_PUSH_WINDOW_MS", String(config.todoPushWindowMs));
  out += formatEnvLine("CTI_TODO_PUSH_CHANNELS", config.todoPushChannels?.join(","));
  if (config.directReminderEnabled !== undefined)
    out += formatEnvLine("CTI_DIRECT_REMINDER_ENABLED", String(config.directReminderEnabled));
  if (config.directReminderPushEnabled !== undefined)
    out += formatEnvLine("CTI_DIRECT_REMINDER_PUSH_ENABLED", String(config.directReminderPushEnabled));
  out += formatEnvLine("CTI_DIRECT_REMINDER_DECISION_MODE", config.directReminderDecisionMode);
  if (config.directReminderAllowSlashCommand !== undefined)
    out += formatEnvLine("CTI_DIRECT_REMINDER_ALLOW_SLASH_COMMAND", String(config.directReminderAllowSlashCommand));
  if (config.scheduledTasksEnabled !== undefined)
    out += formatEnvLine("CTI_SCHEDULED_TASKS_ENABLED", String(config.scheduledTasksEnabled));
  if (config.scheduledTasksPollMs !== undefined)
    out += formatEnvLine("CTI_SCHEDULED_TASKS_POLL_MS", String(config.scheduledTasksPollMs));
  if (config.scheduledTasksMaxConcurrentRuns !== undefined)
    out += formatEnvLine("CTI_SCHEDULED_TASKS_MAX_CONCURRENT_RUNS", String(config.scheduledTasksMaxConcurrentRuns));
  if (config.scheduledTasksFailureAlertAfter !== undefined)
    out += formatEnvLine("CTI_SCHEDULED_TASKS_FAILURE_ALERT_AFTER", String(config.scheduledTasksFailureAlertAfter));
  if (config.scheduledTasksFailureAlertCooldownMs !== undefined)
    out += formatEnvLine("CTI_SCHEDULED_TASKS_FAILURE_ALERT_COOLDOWN_MS", String(config.scheduledTasksFailureAlertCooldownMs));
  out += formatEnvLine("CTI_UNITY_MCP_ENDPOINTS", config.unityMcpEndpoints);
  out += formatEnvLine("CTI_UNITY_MCP_START_COMMAND", config.unityMcpStartCommand);
  out += formatEnvLine("CTI_LOCAL_AI_KIND", config.localAiKind);
  out += formatEnvLine("CTI_LOCAL_AI_BASE_URL", config.localAiBaseUrl);
  out += formatEnvLine("CTI_LOCAL_AI_MODEL", config.localAiModel);
  out += formatEnvLine("CTI_LOCAL_AI_API_KEY", config.localAiApiKey);
  if (config.localAiTimeoutMs !== undefined)
    out += formatEnvLine("CTI_LOCAL_AI_TIMEOUT_MS", String(config.localAiTimeoutMs));
  out += formatEnvLine("CTI_CODEX_MODEL_SOURCE", config.codexModelSource);
  out += formatEnvLine("CTI_CODEX_ROUTING_MODE", config.codexRoutingMode);
  out += formatEnvLine("CTI_CODEX_API_FALLBACK_CHAIN", config.codexApiFallbackChain?.join(","));
  if (config.codexFailoverCandidateTimeoutMs !== undefined)
    out += formatEnvLine("CTI_CODEX_FAILOVER_CANDIDATE_TIMEOUT_MS", String(config.codexFailoverCandidateTimeoutMs));
  out += formatEnvLine("CTI_CODEX_BASE_URL", config.codexBaseUrl);
  out += formatEnvLine("CTI_CODEX_API_KEY", config.codexApiKey);
  out += formatEnvLine("CTI_CODEX_MODEL", config.codexModel);
  if (config.codexPassModel !== undefined)
    out += formatEnvLine("CTI_CODEX_PASS_MODEL", String(config.codexPassModel));
  out += formatEnvLine("CTI_CODEX_REASONING_EFFORT", config.codexReasoningEffort);
  if (config.codexInheritGlobalMcp !== undefined)
    out += formatEnvLine("CTI_CODEX_INHERIT_GLOBAL_MCP", String(config.codexInheritGlobalMcp));
  if (config.memoryOptimizerEnabled !== undefined)
    out += formatEnvLine("CTI_MEMORY_OPTIMIZER_ENABLED", String(config.memoryOptimizerEnabled));
  if (config.memoryOptimizerIntervalDays !== undefined)
    out += formatEnvLine("CTI_MEMORY_OPTIMIZER_INTERVAL_DAYS", String(config.memoryOptimizerIntervalDays));
  out += formatEnvLine("CTI_MEMORY_OPTIMIZER_MODEL_SOURCE", config.memoryOptimizerModelSource);
  if (config.ollamaEnabled !== undefined)
    out += formatEnvLine("CTI_OLLAMA_ENABLED", String(config.ollamaEnabled));
  out += formatEnvLine("CTI_OLLAMA_BASE_URL", config.ollamaBaseUrl);
  out += formatEnvLine("CTI_OLLAMA_MODEL", config.ollamaModel);
  if (config.ollamaTimeoutMs !== undefined)
    out += formatEnvLine("CTI_OLLAMA_TIMEOUT_MS", String(config.ollamaTimeoutMs));
  // Deprecated llama.cpp endpoint/model envs are read for one-time migration only.
  // Persist new Ollama envs plus legacy router knobs, not old server source keys.
  if (config.localLlmAutoRoute !== undefined)
    out += formatEnvLine("CTI_LOCAL_LLM_AUTO_ROUTE", String(config.localLlmAutoRoute));
  if (config.localLlmFallbackToCodex !== undefined)
    out += formatEnvLine("CTI_LOCAL_LLM_FALLBACK_TO_CODEX", String(config.localLlmFallbackToCodex));
  if (config.localLlmRouterEnabled !== undefined)
    out += formatEnvLine("CTI_LOCAL_LLM_ROUTER_ENABLED", String(config.localLlmRouterEnabled));
  out += formatEnvLine("CTI_LOCAL_LLM_ROUTER_MODE", config.localLlmRouterMode);
  if (config.localLlmForceHub !== undefined)
    out += formatEnvLine("CTI_LOCAL_LLM_FORCE_HUB", String(config.localLlmForceHub));
  if (config.localLlmRouterMaxInputChars !== undefined)
    out += formatEnvLine("CTI_LOCAL_LLM_ROUTER_MAX_INPUT_CHARS", String(config.localLlmRouterMaxInputChars));
  if (config.localLlmRouterMaxHistoryItems !== undefined)
    out += formatEnvLine("CTI_LOCAL_LLM_ROUTER_MAX_HISTORY_ITEMS", String(config.localLlmRouterMaxHistoryItems));
  if (config.localLlmRouterTimeoutMs !== undefined)
    out += formatEnvLine("CTI_LOCAL_LLM_ROUTER_TIMEOUT_MS", String(config.localLlmRouterTimeoutMs));
  if (config.lightChatFastPathEnabled !== undefined)
    out += formatEnvLine("CTI_LIGHT_CHAT_FAST_PATH_ENABLED", String(config.lightChatFastPathEnabled));
  if (config.lightChatFastPathTimeoutMs !== undefined)
    out += formatEnvLine("CTI_LIGHT_CHAT_FAST_PATH_TIMEOUT_MS", String(config.lightChatFastPathTimeoutMs));
  if (config.memoryIntentTimeoutMs !== undefined)
    out += formatEnvLine("CTI_MEMORY_INTENT_TIMEOUT_MS", String(config.memoryIntentTimeoutMs));
  out += formatEnvLine("CTI_AGENT_COLLABORATION_MODE", config.agentCollaborationMode || "off");
  if (config.agentWorkerPoolSize !== undefined)
    out += formatEnvLine("CTI_AGENT_WORKER_POOL_SIZE", String(config.agentWorkerPoolSize));
  if (config.agentMaxSpecialists !== undefined)
    out += formatEnvLine("CTI_AGENT_MAX_SPECIALISTS", String(config.agentMaxSpecialists));
  if (config.agentTaskTimeoutMs !== undefined)
    out += formatEnvLine("CTI_AGENT_TASK_TIMEOUT_MS", String(config.agentTaskTimeoutMs));
  if (config.agentTurnBudgetMs !== undefined)
    out += formatEnvLine("CTI_AGENT_TURN_BUDGET_MS", String(config.agentTurnBudgetMs));
  if (config.agentPerformanceBatchSize !== undefined)
    out += formatEnvLine("CTI_AGENT_PERFORMANCE_BATCH_SIZE", String(config.agentPerformanceBatchSize));
  if (config.agentPerformanceIntervalMs !== undefined)
    out += formatEnvLine("CTI_AGENT_PERFORMANCE_INTERVAL_MS", String(config.agentPerformanceIntervalMs));
  if (config.lightChatHistoryLimit !== undefined)
    out += formatEnvLine("CTI_LIGHT_CHAT_HISTORY_LIMIT", String(config.lightChatHistoryLimit));
  if (config.lightChatMaxInputChars !== undefined)
    out += formatEnvLine("CTI_LIGHT_CHAT_MAX_INPUT_CHARS", String(config.lightChatMaxInputChars));
  if (config.localLlmMaxInputChars !== undefined)
    out += formatEnvLine("CTI_LOCAL_LLM_MAX_INPUT_CHARS", String(config.localLlmMaxInputChars));
  if (config.localLlmMaxOutputTokens !== undefined)
    out += formatEnvLine("CTI_LOCAL_LLM_MAX_OUTPUT_TOKENS", String(config.localLlmMaxOutputTokens));
  out += formatEnvLine("CTI_LOCAL_LLM_COMPLEXITY_MODE", config.localLlmComplexityMode);
  out += formatEnvLine("CTI_REPLY_STYLE_HINT", config.replyStyleHint);
  if (config.defaultModel) out += formatEnvLine("CTI_DEFAULT_MODEL", config.defaultModel);
  out += formatEnvLine("CTI_DEFAULT_MODE", config.defaultMode);
  out += formatEnvLine("CTI_DEFAULT_EXECUTOR_ID", normalizeExecutorId(config.defaultExecutorId));
  out += formatEnvLine("CTI_TG_BOT_TOKEN", config.tgBotToken);
  out += formatEnvLine("CTI_TG_CHAT_ID", config.tgChatId);
  out += formatEnvLine(
    "CTI_TG_ALLOWED_USERS",
    config.tgAllowedUsers?.join(",")
  );
  out += formatEnvLine(
    "CTI_TG_OWNER_USERS",
    config.tgOwnerUsers?.join(",")
  );
  out += formatEnvLine("CTI_FEISHU_APP_ID", config.feishuAppId);
  out += formatEnvLine("CTI_FEISHU_APP_SECRET", config.feishuAppSecret);
  out += formatEnvLine("CTI_FEISHU_DOMAIN", config.feishuDomain);
  out += formatEnvLine(
    "CTI_FEISHU_ALLOWED_USERS",
    config.feishuAllowedUsers?.join(",")
  );
  out += formatEnvLine(
    "CTI_FEISHU_OWNER_USERS",
    config.feishuOwnerUsers?.join(",")
  );
  out += formatEnvLine("CTI_FEISHU_GRANTED_SCOPES", config.feishuGrantedScopes?.join(","));
  out += formatEnvLine("CTI_FEISHU_DOCUMENT_GUIDE_DOC_ID", config.feishuDocumentGuideDocId);
  out += formatEnvLine("CTI_FEISHU_OAUTH_MODE", config.feishuOAuthMode);
  out += formatEnvLine("CTI_FEISHU_OAUTH_PUBLIC_BASE_URL", config.feishuOAuthPublicBaseUrl);
  out += formatEnvLine("CTI_FEISHU_OAUTH_MANUAL_REDIRECT_URI", config.feishuOAuthManualRedirectUri);
  out += formatEnvLine("CTI_FEISHU_OAUTH_CALLBACK_PATH", config.feishuOAuthCallbackPath);
  out += formatEnvLine("CTI_FEISHU_OAUTH_SCOPES", config.feishuOAuthScopes?.join(","));
  if (config.feishuOAuthCallbackPort !== undefined)
    out += formatEnvLine("CTI_FEISHU_OAUTH_CALLBACK_PORT", String(config.feishuOAuthCallbackPort));
  if (config.feishuCloudMaxChars !== undefined)
    out += formatEnvLine("CTI_FEISHU_CLOUD_MAX_CHARS", String(config.feishuCloudMaxChars));
  if (config.feishuCloudMaxRows !== undefined)
    out += formatEnvLine("CTI_FEISHU_CLOUD_MAX_ROWS", String(config.feishuCloudMaxRows));
  if (config.feishuCloudMaxRecords !== undefined)
    out += formatEnvLine("CTI_FEISHU_CLOUD_MAX_RECORDS", String(config.feishuCloudMaxRecords));
  if (config.feishuCloudMaxSheets !== undefined)
    out += formatEnvLine("CTI_FEISHU_CLOUD_MAX_SHEETS", String(config.feishuCloudMaxSheets));
  out += formatEnvLine("CTI_DISCORD_BOT_TOKEN", config.discordBotToken);
  out += formatEnvLine(
    "CTI_DISCORD_ALLOWED_USERS",
    config.discordAllowedUsers?.join(",")
  );
  out += formatEnvLine(
    "CTI_DISCORD_OWNER_USERS",
    config.discordOwnerUsers?.join(",")
  );
  out += formatEnvLine(
    "CTI_DISCORD_ALLOWED_CHANNELS",
    config.discordAllowedChannels?.join(",")
  );
  out += formatEnvLine(
    "CTI_DISCORD_ALLOWED_GUILDS",
    config.discordAllowedGuilds?.join(",")
  );
  out += formatEnvLine("CTI_QQ_APP_ID", config.qqAppId);
  out += formatEnvLine("CTI_QQ_APP_SECRET", config.qqAppSecret);
  out += formatEnvLine(
    "CTI_QQ_ALLOWED_USERS",
    config.qqAllowedUsers?.join(",")
  );
  out += formatEnvLine(
    "CTI_QQ_OWNER_USERS",
    config.qqOwnerUsers?.join(",")
  );
  if (config.qqImageEnabled !== undefined)
    out += formatEnvLine("CTI_QQ_IMAGE_ENABLED", String(config.qqImageEnabled));
  if (config.qqMaxImageSize !== undefined)
    out += formatEnvLine("CTI_QQ_MAX_IMAGE_SIZE", String(config.qqMaxImageSize));
  out += formatEnvLine("CTI_WEIXIN_BASE_URL", config.weixinBaseUrl);
  out += formatEnvLine("CTI_WEIXIN_CDN_BASE_URL", config.weixinCdnBaseUrl);
  out += formatEnvLine(
    "CTI_WEIXIN_ALLOWED_USERS",
    config.weixinAllowedUsers?.join(",")
  );
  out += formatEnvLine(
    "CTI_WEIXIN_OWNER_USERS",
    config.weixinOwnerUsers?.join(",")
  );
  if (config.weixinMediaEnabled !== undefined)
    out += formatEnvLine("CTI_WEIXIN_MEDIA_ENABLED", String(config.weixinMediaEnabled));
  if (config.selfOptimizeOnFailure !== undefined)
    out += formatEnvLine("CTI_SELF_OPTIMIZE_ON_FAILURE", String(config.selfOptimizeOnFailure));
  // ── Mavis external agent (v3.4) — write CTI_MAVIS_* ONLY; never write MAVIS_* alias ──
  if (config.mavisEnabled !== undefined)
    out += formatEnvLine("CTI_MAVIS_ENABLED", String(config.mavisEnabled));
  out += formatEnvLine("CTI_MAVIS_CLI_PATH", config.mavisCliPath);
  out += formatEnvLine("CTI_MAVIS_AGENT_NAME", config.mavisAgentName);
  out += formatEnvLine("CTI_MAVIS_DATA_DIR", config.mavisDataDir);
  out += formatEnvLine("CTI_MAVIS_BRIDGE_SESSION_ID", config.mavisBridgeSessionId);
  if (config.mavisPort !== undefined)
    out += formatEnvLine("CTI_MAVIS_PORT", String(config.mavisPort));
  if (config.mavisPollIntervalMs !== undefined)
    out += formatEnvLine("CTI_MAVIS_POLL_INTERVAL_MS", String(config.mavisPollIntervalMs));
  if (config.mavisHardTimeoutMs !== undefined)
    out += formatEnvLine("CTI_MAVIS_HARD_TIMEOUT_MS", String(config.mavisHardTimeoutMs));
  if (config.mavisQuietTimeoutMs !== undefined)
    out += formatEnvLine("CTI_MAVIS_QUIET_TIMEOUT_MS", String(config.mavisQuietTimeoutMs));
  if (config.mavisMaxDiffBytes !== undefined)
    out += formatEnvLine("CTI_MAVIS_MAX_DIFF_BYTES", String(config.mavisMaxDiffBytes));
  if (config.mavisReadOnly !== undefined)
    out += formatEnvLine("CTI_MAVIS_READ_ONLY", String(config.mavisReadOnly));
  if (config.mavisDefaultExecutor !== undefined)
    out += formatEnvLine("CTI_MAVIS_DEFAULT_EXECUTOR", String(config.mavisDefaultExecutor));

  fs.mkdirSync(CTI_HOME, { recursive: true });
  const tmpPath = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmpPath, out, { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return "*".repeat(value.length - 4) + value.slice(-4);
}

export function configToSettings(config: Config): Map<string, string> {
  const m = new Map<string, string>();
  m.set("remote_bridge_enabled", "true");
  m.set("bridge_safety_policy_profile", config.safetyPolicyProfile || "balanced");
  if (config.bridgeProcessingTimeoutMs !== undefined) {
    m.set("bridge_processing_timeout_ms", String(config.bridgeProcessingTimeoutMs));
  }

  // ── Telegram ──
  // Upstream keys: telegram_bot_token, bridge_telegram_enabled,
  //   telegram_bridge_allowed_users, telegram_chat_id
  m.set(
    "bridge_telegram_enabled",
    config.enabledChannels.includes("telegram") ? "true" : "false"
  );
  if (config.tgBotToken) m.set("telegram_bot_token", config.tgBotToken);
  if (config.tgAllowedUsers)
    m.set("telegram_bridge_allowed_users", config.tgAllowedUsers.join(","));
  if (config.tgOwnerUsers)
    m.set("telegram_bridge_owner_users", config.tgOwnerUsers.join(","));
  if (config.tgChatId) m.set("telegram_chat_id", config.tgChatId);

  // ── Discord ──
  // Upstream keys: bridge_discord_bot_token, bridge_discord_enabled,
  //   bridge_discord_allowed_users, bridge_discord_allowed_channels,
  //   bridge_discord_allowed_guilds
  m.set(
    "bridge_discord_enabled",
    config.enabledChannels.includes("discord") ? "true" : "false"
  );
  if (config.discordBotToken)
    m.set("bridge_discord_bot_token", config.discordBotToken);
  if (config.discordAllowedUsers)
    m.set("bridge_discord_allowed_users", config.discordAllowedUsers.join(","));
  if (config.discordOwnerUsers)
    m.set("bridge_discord_owner_users", config.discordOwnerUsers.join(","));
  if (config.discordAllowedChannels)
    m.set(
      "bridge_discord_allowed_channels",
      config.discordAllowedChannels.join(",")
    );
  if (config.discordAllowedGuilds)
    m.set(
      "bridge_discord_allowed_guilds",
      config.discordAllowedGuilds.join(",")
    );

  // ── Feishu ──
  // Upstream keys: bridge_feishu_app_id, bridge_feishu_app_secret,
  //   bridge_feishu_domain, bridge_feishu_enabled, bridge_feishu_allowed_users
  m.set(
    "bridge_feishu_enabled",
    config.enabledChannels.includes("feishu") ? "true" : "false"
  );
  if (config.feishuAppId) m.set("bridge_feishu_app_id", config.feishuAppId);
  if (config.feishuAppSecret)
    m.set("bridge_feishu_app_secret", config.feishuAppSecret);
  if (config.feishuDomain) m.set("bridge_feishu_domain", config.feishuDomain);
  if (config.feishuAllowedUsers)
    m.set("bridge_feishu_allowed_users", config.feishuAllowedUsers.join(","));
  if (config.feishuOwnerUsers)
    m.set("bridge_feishu_owner_users", config.feishuOwnerUsers.join(","));
  if (config.feishuGrantedScopes)
    m.set("bridge_feishu_granted_scopes", config.feishuGrantedScopes.join(","));
  if (config.feishuDocumentGuideDocId)
    m.set("bridge_feishu_document_guide_doc_id", config.feishuDocumentGuideDocId);
  if (config.feishuOAuthMode)
    m.set("bridge_feishu_oauth_mode", config.feishuOAuthMode);
  if (config.feishuOAuthPublicBaseUrl)
    m.set("bridge_feishu_oauth_public_base_url", config.feishuOAuthPublicBaseUrl);
  if (config.feishuOAuthManualRedirectUri)
    m.set("bridge_feishu_oauth_manual_redirect_uri", config.feishuOAuthManualRedirectUri);
  if (config.feishuOAuthCallbackPath)
    m.set("bridge_feishu_oauth_callback_path", config.feishuOAuthCallbackPath);
  if (config.feishuOAuthScopes)
    m.set("bridge_feishu_oauth_scopes", config.feishuOAuthScopes.join(","));
  if (typeof config.feishuOAuthCallbackPort === "number" && Number.isFinite(config.feishuOAuthCallbackPort))
    m.set("bridge_feishu_oauth_callback_port", String(Math.max(1, Math.floor(config.feishuOAuthCallbackPort))));
  if (typeof config.feishuCloudMaxChars === "number" && Number.isFinite(config.feishuCloudMaxChars))
    m.set("bridge_feishu_cloud_max_chars", String(Math.max(1000, Math.floor(config.feishuCloudMaxChars))));
  if (typeof config.feishuCloudMaxRows === "number" && Number.isFinite(config.feishuCloudMaxRows))
    m.set("bridge_feishu_cloud_max_rows", String(Math.max(1, Math.floor(config.feishuCloudMaxRows))));
  if (typeof config.feishuCloudMaxRecords === "number" && Number.isFinite(config.feishuCloudMaxRecords))
    m.set("bridge_feishu_cloud_max_records", String(Math.max(1, Math.floor(config.feishuCloudMaxRecords))));
  if (typeof config.feishuCloudMaxSheets === "number" && Number.isFinite(config.feishuCloudMaxSheets))
    m.set("bridge_feishu_cloud_max_sheets", String(Math.max(1, Math.floor(config.feishuCloudMaxSheets))));

  // ── QQ ──
  // Upstream keys: bridge_qq_enabled, bridge_qq_app_id, bridge_qq_app_secret,
  //   bridge_qq_allowed_users, bridge_qq_image_enabled, bridge_qq_max_image_size
  m.set(
    "bridge_qq_enabled",
    config.enabledChannels.includes("qq") ? "true" : "false"
  );
  if (config.qqAppId) m.set("bridge_qq_app_id", config.qqAppId);
  if (config.qqAppSecret) m.set("bridge_qq_app_secret", config.qqAppSecret);
  if (config.qqAllowedUsers)
    m.set("bridge_qq_allowed_users", config.qqAllowedUsers.join(","));
  if (config.qqOwnerUsers)
    m.set("bridge_qq_owner_users", config.qqOwnerUsers.join(","));
  if (config.qqImageEnabled !== undefined)
    m.set("bridge_qq_image_enabled", String(config.qqImageEnabled));
  if (config.qqMaxImageSize !== undefined)
    m.set("bridge_qq_max_image_size", String(config.qqMaxImageSize));

  // ── WeChat ──
  // Upstream keys: bridge_weixin_enabled, bridge_weixin_media_enabled,
  //   bridge_weixin_base_url, bridge_weixin_cdn_base_url
  m.set(
    "bridge_weixin_enabled",
    config.enabledChannels.includes("weixin") ? "true" : "false"
  );
  if (config.weixinMediaEnabled !== undefined)
    m.set("bridge_weixin_media_enabled", String(config.weixinMediaEnabled));
  if (config.weixinBaseUrl)
    m.set("bridge_weixin_base_url", config.weixinBaseUrl);
  if (config.weixinCdnBaseUrl)
    m.set("bridge_weixin_cdn_base_url", config.weixinCdnBaseUrl);
  if (config.weixinAllowedUsers)
    m.set("bridge_weixin_allowed_users", config.weixinAllowedUsers.join(","));
  if (config.weixinOwnerUsers)
    m.set("bridge_weixin_owner_users", config.weixinOwnerUsers.join(","));

  // ── Defaults ──
  // Upstream keys: bridge_default_work_dir, bridge_default_model, default_model
  m.set("bridge_default_work_dir", config.defaultWorkDir);
  if (config.allowedWorkspaceRoots && config.allowedWorkspaceRoots.length > 0) {
    m.set("bridge_allowed_workspace_roots", config.allowedWorkspaceRoots.join(";"));
  }
  if (config.projectRegistryPath) m.set("bridge_project_registry_path", config.projectRegistryPath);
  if (config.projectDeniedRoots && config.projectDeniedRoots.length > 0) {
    m.set("bridge_project_denied_roots", config.projectDeniedRoots.join(";"));
  }
  const registeredProjects = config.registeredProjects || [];
  m.set("bridge_project_registry_json", JSON.stringify({
    schema: "codex-im-suite/project-registry/v1",
    projects: registeredProjects,
  }));
  m.set("bridge_registered_project_count", String(registeredProjects.length));
  if (config.memoryRepoDir) {
    m.set("bridge_memory_repo_dir", config.memoryRepoDir);
  }
  if (config.uploadCacheDir) {
    m.set("bridge_upload_cache_dir", config.uploadCacheDir);
  }
  if (config.unityProjectPath) {
    m.set("bridge_unity_project_path", config.unityProjectPath);
  }
  if (typeof config.contextHistoryMaxChars === "number" && Number.isFinite(config.contextHistoryMaxChars)) {
    m.set("bridge_context_history_max_chars", String(Math.max(1200, Math.floor(config.contextHistoryMaxChars))));
  }
  if (typeof config.contextHistoryMessageMaxChars === "number" && Number.isFinite(config.contextHistoryMessageMaxChars)) {
    m.set("bridge_context_history_message_max_chars", String(Math.max(120, Math.floor(config.contextHistoryMessageMaxChars))));
  }
  if (typeof config.memoryPromptMaxChars === "number" && Number.isFinite(config.memoryPromptMaxChars)) {
    m.set("bridge_memory_prompt_max_chars", String(Math.max(240, Math.floor(config.memoryPromptMaxChars))));
  }
  m.set("bridge_todo_push_enabled", String(config.todoPushEnabled === true));
  m.set("bridge_direct_reminder_enabled", String(config.directReminderEnabled !== false));
  m.set("bridge_direct_reminder_push_enabled", String(config.directReminderPushEnabled !== false));
  m.set("bridge_direct_reminder_decision_mode", config.directReminderDecisionMode || "codex_action");
  m.set("bridge_direct_reminder_allow_slash_command", String(config.directReminderAllowSlashCommand !== false));
  m.set("bridge_scheduled_tasks_enabled", String(config.scheduledTasksEnabled !== false));
  if (typeof config.scheduledTasksPollMs === "number" && Number.isFinite(config.scheduledTasksPollMs)) {
    m.set("bridge_scheduled_tasks_poll_ms", String(Math.max(5000, Math.floor(config.scheduledTasksPollMs))));
  }
  if (typeof config.scheduledTasksMaxConcurrentRuns === "number" && Number.isFinite(config.scheduledTasksMaxConcurrentRuns)) {
    m.set("bridge_scheduled_tasks_max_concurrent_runs", String(Math.max(1, Math.min(16, Math.floor(config.scheduledTasksMaxConcurrentRuns)))));
  }
  if (typeof config.scheduledTasksFailureAlertAfter === "number" && Number.isFinite(config.scheduledTasksFailureAlertAfter)) {
    m.set("bridge_scheduled_tasks_failure_alert_after", String(Math.max(1, Math.floor(config.scheduledTasksFailureAlertAfter))));
  }
  if (typeof config.scheduledTasksFailureAlertCooldownMs === "number" && Number.isFinite(config.scheduledTasksFailureAlertCooldownMs)) {
    m.set("bridge_scheduled_tasks_failure_alert_cooldown_ms", String(Math.max(60000, Math.floor(config.scheduledTasksFailureAlertCooldownMs))));
  }
  if (typeof config.todoPushPollMs === "number" && Number.isFinite(config.todoPushPollMs)) {
    m.set("bridge_todo_push_poll_ms", String(Math.max(5000, Math.floor(config.todoPushPollMs))));
  }
  if (typeof config.todoPushWindowMs === "number" && Number.isFinite(config.todoPushWindowMs)) {
    m.set("bridge_todo_push_window_ms", String(Math.max(0, Math.floor(config.todoPushWindowMs))));
  }
  m.set("bridge_todo_push_channels", (config.todoPushChannels && config.todoPushChannels.length > 0 ? config.todoPushChannels : ["feishu"]).join(","));
  if (config.unityMcpEndpoints) {
    m.set("bridge_unity_mcp_endpoint_list", config.unityMcpEndpoints);
  }
  if (config.unityMcpStartCommand) {
    m.set("bridge_unity_mcp_start_command", config.unityMcpStartCommand);
  }
  if (config.localAiKind) {
    m.set("bridge_local_ai_kind", config.localAiKind);
  }
  const localProviderCapabilities = getLocalCodexProviderCapabilities(config.localAiKind);
  m.set("bridge_local_provider_supports_codex_agent", String(localProviderCapabilities.supportsCodexAgent));
  m.set("bridge_local_provider_codex_local_provider", localProviderCapabilities.codexLocalProvider || "");
  m.set("bridge_local_provider_capability_message", localProviderCapabilities.supportsCodexAgent
    ? `${localProviderCapabilities.displayName} 支持 Codex CLI OSS agent。`
    : (localProviderCapabilities.unsupportedReason || `${localProviderCapabilities.displayName} 当前不能作为 Codex agent 执行器。`));
  if (config.localAiBaseUrl) {
    m.set("bridge_local_ai_base_url", config.localAiBaseUrl);
  }
  if (config.localAiModel) {
    m.set("bridge_local_ai_model", config.localAiModel);
  }
  if (config.localAiApiKey) {
    m.set("bridge_local_ai_api_key_set", "true");
    m.set("bridge_local_ai_api_key_masked", maskSecret(config.localAiApiKey));
  } else {
    m.set("bridge_local_ai_api_key_set", "false");
  }
  if (typeof config.localAiTimeoutMs === "number" && Number.isFinite(config.localAiTimeoutMs)) {
    m.set("bridge_local_ai_timeout_ms", String(Math.max(1000, Math.floor(config.localAiTimeoutMs))));
  }
  if (config.codexModelSource) {
    m.set("bridge_codex_model_source", config.codexModelSource);
  }
  m.set("bridge_codex_routing_mode", config.codexRoutingMode || "manual");
  m.set("bridge_codex_api_fallback_chain", (config.codexApiFallbackChain || ["local_api", "external_api"]).join(","));
  if (typeof config.codexFailoverCandidateTimeoutMs === "number" && Number.isFinite(config.codexFailoverCandidateTimeoutMs)) {
    m.set("bridge_codex_failover_candidate_timeout_ms", String(Math.max(250, Math.floor(config.codexFailoverCandidateTimeoutMs))));
  }
  if (config.codexBaseUrl) {
    m.set("bridge_codex_base_url", config.codexBaseUrl);
  }
  if (config.codexApiKey) {
    m.set("bridge_codex_api_key_set", "true");
    m.set("bridge_codex_api_key_masked", maskSecret(config.codexApiKey));
  } else {
    m.set("bridge_codex_api_key_set", "false");
  }
  if (config.codexModel) {
    m.set("bridge_codex_model", config.codexModel);
  }
  if (config.codexPassModel !== undefined) {
    m.set("bridge_codex_pass_model", String(config.codexPassModel));
  }
  if (config.codexReasoningEffort) {
    m.set("bridge_codex_reasoning_effort", config.codexReasoningEffort);
  }
  m.set("bridge_codex_inherit_global_mcp", String(config.codexInheritGlobalMcp === true));
  m.set("bridge_memory_optimizer_enabled", String(config.memoryOptimizerEnabled === true));
  m.set("bridge_memory_optimizer_interval_days", String(config.memoryOptimizerIntervalDays ?? 7));
  m.set("bridge_memory_optimizer_model_source", config.memoryOptimizerModelSource || "codex_primary");
  m.set("bridge_default_executor_id", normalizeExecutorId(config.defaultExecutorId) || "");
  if (config.ollamaEnabled !== undefined) {
    m.set("bridge_ollama_enabled", String(config.ollamaEnabled));
  }
  if (config.ollamaBaseUrl) {
    m.set("bridge_ollama_base_url", config.ollamaBaseUrl);
  }
  if (config.ollamaModel) {
    m.set("bridge_ollama_model", config.ollamaModel);
  }
  if (typeof config.ollamaTimeoutMs === "number" && Number.isFinite(config.ollamaTimeoutMs)) {
    m.set("bridge_ollama_timeout_ms", String(Math.max(1000, Math.floor(config.ollamaTimeoutMs))));
  }
  const localCompatEnabled = config.localLlmEnabled ?? config.ollamaEnabled;
  const localCompatBaseUrl = config.localLlmBaseUrl || config.localAiBaseUrl || config.ollamaBaseUrl;
  const localCompatModel = config.localLlmModel || config.localAiModel || config.ollamaModel;
  const localCompatTimeout = config.localLlmTimeoutMs ?? config.localAiTimeoutMs ?? config.ollamaTimeoutMs;
  if (localCompatEnabled !== undefined) {
    m.set("bridge_local_llm_enabled", String(localCompatEnabled));
  }
  if (localCompatBaseUrl) {
    m.set("bridge_local_llm_base_url", localCompatBaseUrl);
  }
  if (localCompatModel) {
    m.set("bridge_local_llm_model", localCompatModel);
  }
  if (typeof localCompatTimeout === "number" && Number.isFinite(localCompatTimeout)) {
    m.set("bridge_local_llm_timeout_ms", String(Math.max(1000, Math.floor(localCompatTimeout))));
  }
  if (config.localLlmAutoRoute !== undefined) {
    m.set("bridge_local_llm_auto_route", String(config.localLlmAutoRoute));
  }
  if (config.localLlmFallbackToCodex !== undefined) {
    m.set("bridge_local_llm_fallback_to_codex", String(config.localLlmFallbackToCodex));
  }
  if (config.localLlmRouterEnabled !== undefined) {
    m.set("bridge_local_llm_router_enabled", String(config.localLlmRouterEnabled));
  }
  if (config.localLlmRouterMode) {
    m.set("bridge_local_llm_router_mode", config.localLlmRouterMode);
  }
  if (config.localLlmForceHub !== undefined) {
    m.set("bridge_local_llm_force_hub", String(config.localLlmForceHub));
  }
  if (typeof config.localLlmRouterMaxInputChars === "number" && Number.isFinite(config.localLlmRouterMaxInputChars)) {
    m.set("bridge_local_llm_router_max_input_chars", String(Math.max(1200, Math.floor(config.localLlmRouterMaxInputChars))));
  }
  if (typeof config.localLlmRouterMaxHistoryItems === "number" && Number.isFinite(config.localLlmRouterMaxHistoryItems)) {
    m.set("bridge_local_llm_router_max_history_items", String(Math.max(2, Math.floor(config.localLlmRouterMaxHistoryItems))));
  }
  if (typeof config.localLlmRouterTimeoutMs === "number" && Number.isFinite(config.localLlmRouterTimeoutMs)) {
    m.set("bridge_local_llm_router_timeout_ms", String(Math.max(1000, Math.floor(config.localLlmRouterTimeoutMs))));
  }
  if (config.lightChatFastPathEnabled !== undefined) {
    m.set("bridge_light_chat_fast_path_enabled", String(config.lightChatFastPathEnabled));
  }
  if (typeof config.lightChatFastPathTimeoutMs === "number" && Number.isFinite(config.lightChatFastPathTimeoutMs)) {
    m.set("bridge_light_chat_fast_path_timeout_ms", String(Math.max(250, Math.floor(config.lightChatFastPathTimeoutMs))));
  }
  if (typeof config.memoryIntentTimeoutMs === "number" && Number.isFinite(config.memoryIntentTimeoutMs)) {
    m.set("bridge_memory_intent_timeout_ms", String(Math.max(250, Math.floor(config.memoryIntentTimeoutMs))));
  }
  m.set("bridge_agent_collaboration_mode", config.agentCollaborationMode || "off");
  m.set("bridge_agent_worker_pool_size", String(config.agentWorkerPoolSize || 2));
  m.set("bridge_agent_max_specialists", String(config.agentMaxSpecialists || 2));
  m.set("bridge_agent_task_timeout_ms", String(config.agentTaskTimeoutMs || 30_000));
  m.set("bridge_agent_turn_budget_ms", String(config.agentTurnBudgetMs || 35_000));
  if (typeof config.lightChatHistoryLimit === "number" && Number.isFinite(config.lightChatHistoryLimit)) {
    m.set("bridge_light_chat_history_limit", String(Math.max(0, Math.floor(config.lightChatHistoryLimit))));
  }
  if (typeof config.lightChatMaxInputChars === "number" && Number.isFinite(config.lightChatMaxInputChars)) {
    m.set("bridge_light_chat_max_input_chars", String(Math.max(80, Math.floor(config.lightChatMaxInputChars))));
  }
  if (typeof config.localLlmMaxInputChars === "number" && Number.isFinite(config.localLlmMaxInputChars)) {
    m.set("bridge_local_llm_max_input_chars", String(Math.max(1200, Math.floor(config.localLlmMaxInputChars))));
  }
  if (typeof config.localLlmMaxOutputTokens === "number" && Number.isFinite(config.localLlmMaxOutputTokens)) {
    m.set("bridge_local_llm_max_output_tokens", String(Math.max(128, Math.floor(config.localLlmMaxOutputTokens))));
  }
  if (config.localLlmComplexityMode) {
    m.set("bridge_local_llm_complexity_mode", config.localLlmComplexityMode);
  }
  if (config.defaultModel) {
    m.set("bridge_default_model", config.defaultModel);
    m.set("default_model", config.defaultModel);
  }
  if (config.replyStyleHint?.trim()) {
    m.set("bridge_reply_style_hint", config.replyStyleHint.trim());
  }
  m.set("bridge_default_mode", config.defaultMode);
  if (config.selfOptimizeOnFailure !== undefined) {
    m.set("bridge_self_optimize_on_failure", String(config.selfOptimizeOnFailure));
  }

  return m;
}
