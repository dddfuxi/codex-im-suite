import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  runtime: 'claude' | 'codex' | 'auto';
  enabledChannels: string[];
  defaultWorkDir: string;
  bridgeProcessingTimeoutMs?: number;
  allowedWorkspaceRoots?: string[];
  codexAdditionalDirectories?: string[];
  memoryRepoDir?: string;
  unityProjectPath?: string;
  contextHistoryMaxChars?: number;
  contextHistoryMessageMaxChars?: number;
  memoryPromptMaxChars?: number;
  unityMcpEndpoints?: string;
  unityMcpStartCommand?: string;
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
  defaultModel?: string;
  defaultMode: string;
  // Telegram
  tgBotToken?: string;
  tgChatId?: string;
  tgAllowedUsers?: string[];
  // Feishu
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuDomain?: string;
  feishuAllowedUsers?: string[];
  feishuOwnerUsers?: string[];
  feishuDocumentGuideDocId?: string;
  // Discord
  discordBotToken?: string;
  discordAllowedUsers?: string[];
  discordAllowedChannels?: string[];
  discordAllowedGuilds?: string[];
  // QQ
  qqAppId?: string;
  qqAppSecret?: string;
  qqAllowedUsers?: string[];
  qqImageEnabled?: boolean;
  qqMaxImageSize?: number;
  // WeChat
  weixinBaseUrl?: string;
  weixinCdnBaseUrl?: string;
  weixinMediaEnabled?: boolean;
  // Auto-approve all tool permission requests without user confirmation
  autoApprove?: boolean;
  // Prefer minimal bridge/tooling self-repair when the user is blocked by a missing capability
  selfOptimizeOnFailure?: boolean;
}

export const CTI_HOME = process.env.CTI_HOME || path.join(os.homedir(), ".claude-to-im");
export const CONFIG_PATH = path.join(CTI_HOME, "config.env");

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

function mergeWorkspaceRoots(defaultWorkDir: string, explicitRoots?: string[], additionalDirectories?: string[]): string[] | undefined {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const rawEntry of [defaultWorkDir, ...(explicitRoots || []), ...(additionalDirectories || [])]) {
    if (!rawEntry) continue;
    const normalized = path.normalize(rawEntry);
    const dedupeKey = path.resolve(normalized).toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    merged.push(normalized);
  }
  return merged.length > 0 ? merged : undefined;
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
  const memoryRepoDir = env.get("CTI_MEMORY_REPO_DIR") || undefined;
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
  const localLlmTimeoutMs = env.get("CTI_LOCAL_LLM_TIMEOUT_MS")
    ? Number(env.get("CTI_LOCAL_LLM_TIMEOUT_MS"))
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
  const localLlmMaxInputChars = env.get("CTI_LOCAL_LLM_MAX_INPUT_CHARS")
    ? Number(env.get("CTI_LOCAL_LLM_MAX_INPUT_CHARS"))
    : undefined;
  const localLlmMaxOutputTokens = env.get("CTI_LOCAL_LLM_MAX_OUTPUT_TOKENS")
    ? Number(env.get("CTI_LOCAL_LLM_MAX_OUTPUT_TOKENS"))
    : undefined;
  const allowedWorkspaceRoots = mergeWorkspaceRoots(
    defaultWorkDir,
    splitPathList(env.get("CTI_ALLOWED_WORKSPACE_ROOTS")),
    codexAdditionalDirectories,
  );

  return {
    runtime,
    enabledChannels: splitCsv(env.get("CTI_ENABLED_CHANNELS")) ?? [],
    defaultWorkDir,
    bridgeProcessingTimeoutMs,
    allowedWorkspaceRoots,
    codexAdditionalDirectories,
    memoryRepoDir,
    unityProjectPath,
    contextHistoryMaxChars,
    contextHistoryMessageMaxChars,
    memoryPromptMaxChars,
    unityMcpEndpoints: env.get("CTI_UNITY_MCP_ENDPOINTS") || undefined,
    unityMcpStartCommand: env.get("CTI_UNITY_MCP_START_COMMAND") || undefined,
    localLlmEnabled: env.has("CTI_LOCAL_LLM_ENABLED")
      ? env.get("CTI_LOCAL_LLM_ENABLED") === "true"
      : true,
    localLlmBaseUrl: env.get("CTI_LOCAL_LLM_BASE_URL") || "http://127.0.0.1:8080",
    localLlmModel: env.get("CTI_LOCAL_LLM_MODEL") || "qwen2.5-coder-7b-instruct",
    localLlmTimeoutMs: localLlmTimeoutMs ?? 45000,
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
    defaultModel: env.get("CTI_DEFAULT_MODEL") || undefined,
    defaultMode: env.get("CTI_DEFAULT_MODE") || "code",
    tgBotToken: env.get("CTI_TG_BOT_TOKEN") || undefined,
    tgChatId: env.get("CTI_TG_CHAT_ID") || undefined,
    tgAllowedUsers: splitCsv(env.get("CTI_TG_ALLOWED_USERS")),
    feishuAppId: env.get("CTI_FEISHU_APP_ID") || undefined,
    feishuAppSecret: env.get("CTI_FEISHU_APP_SECRET") || undefined,
    feishuDomain: env.get("CTI_FEISHU_DOMAIN") || undefined,
    feishuAllowedUsers: splitCsv(env.get("CTI_FEISHU_ALLOWED_USERS")),
    feishuOwnerUsers: splitCsv(env.get("CTI_FEISHU_OWNER_USERS")),
    feishuDocumentGuideDocId: env.get("CTI_FEISHU_DOCUMENT_GUIDE_DOC_ID") || undefined,
    discordBotToken: env.get("CTI_DISCORD_BOT_TOKEN") || undefined,
    discordAllowedUsers: splitCsv(env.get("CTI_DISCORD_ALLOWED_USERS")),
    discordAllowedChannels: splitCsv(
      env.get("CTI_DISCORD_ALLOWED_CHANNELS")
    ),
    discordAllowedGuilds: splitCsv(env.get("CTI_DISCORD_ALLOWED_GUILDS")),
    qqAppId: env.get("CTI_QQ_APP_ID") || undefined,
    qqAppSecret: env.get("CTI_QQ_APP_SECRET") || undefined,
    qqAllowedUsers: splitCsv(env.get("CTI_QQ_ALLOWED_USERS")),
    qqImageEnabled: env.has("CTI_QQ_IMAGE_ENABLED")
      ? env.get("CTI_QQ_IMAGE_ENABLED") === "true"
      : undefined,
    qqMaxImageSize: env.get("CTI_QQ_MAX_IMAGE_SIZE")
      ? Number(env.get("CTI_QQ_MAX_IMAGE_SIZE"))
      : undefined,
    weixinBaseUrl: env.get("CTI_WEIXIN_BASE_URL") || undefined,
    weixinCdnBaseUrl: env.get("CTI_WEIXIN_CDN_BASE_URL") || undefined,
    weixinMediaEnabled: env.has("CTI_WEIXIN_MEDIA_ENABLED")
      ? env.get("CTI_WEIXIN_MEDIA_ENABLED") === "true"
      : undefined,
    autoApprove: env.get("CTI_AUTO_APPROVE") === "true",
    selfOptimizeOnFailure: env.has("CTI_SELF_OPTIMIZE_ON_FAILURE")
      ? env.get("CTI_SELF_OPTIMIZE_ON_FAILURE") === "true"
      : undefined,
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
  out += formatEnvLine("CTI_CODEX_ADDITIONAL_DIRECTORIES", config.codexAdditionalDirectories?.join(";"));
  out += formatEnvLine("CTI_MEMORY_REPO_DIR", config.memoryRepoDir);
  out += formatEnvLine("CTI_UNITY_PROJECT_PATH", config.unityProjectPath);
  if (config.contextHistoryMaxChars !== undefined)
    out += formatEnvLine("CTI_CONTEXT_HISTORY_MAX_CHARS", String(config.contextHistoryMaxChars));
  if (config.contextHistoryMessageMaxChars !== undefined)
    out += formatEnvLine("CTI_CONTEXT_HISTORY_MESSAGE_MAX_CHARS", String(config.contextHistoryMessageMaxChars));
  if (config.memoryPromptMaxChars !== undefined)
    out += formatEnvLine("CTI_MEMORY_PROMPT_MAX_CHARS", String(config.memoryPromptMaxChars));
  out += formatEnvLine("CTI_UNITY_MCP_ENDPOINTS", config.unityMcpEndpoints);
  out += formatEnvLine("CTI_UNITY_MCP_START_COMMAND", config.unityMcpStartCommand);
  if (config.localLlmEnabled !== undefined)
    out += formatEnvLine("CTI_LOCAL_LLM_ENABLED", String(config.localLlmEnabled));
  out += formatEnvLine("CTI_LOCAL_LLM_BASE_URL", config.localLlmBaseUrl);
  out += formatEnvLine("CTI_LOCAL_LLM_MODEL", config.localLlmModel);
  if (config.localLlmTimeoutMs !== undefined)
    out += formatEnvLine("CTI_LOCAL_LLM_TIMEOUT_MS", String(config.localLlmTimeoutMs));
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
  if (config.localLlmMaxInputChars !== undefined)
    out += formatEnvLine("CTI_LOCAL_LLM_MAX_INPUT_CHARS", String(config.localLlmMaxInputChars));
  if (config.localLlmMaxOutputTokens !== undefined)
    out += formatEnvLine("CTI_LOCAL_LLM_MAX_OUTPUT_TOKENS", String(config.localLlmMaxOutputTokens));
  out += formatEnvLine("CTI_LOCAL_LLM_COMPLEXITY_MODE", config.localLlmComplexityMode);
  if (config.defaultModel) out += formatEnvLine("CTI_DEFAULT_MODEL", config.defaultModel);
  out += formatEnvLine("CTI_DEFAULT_MODE", config.defaultMode);
  out += formatEnvLine("CTI_TG_BOT_TOKEN", config.tgBotToken);
  out += formatEnvLine("CTI_TG_CHAT_ID", config.tgChatId);
  out += formatEnvLine(
    "CTI_TG_ALLOWED_USERS",
    config.tgAllowedUsers?.join(",")
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
  out += formatEnvLine("CTI_FEISHU_DOCUMENT_GUIDE_DOC_ID", config.feishuDocumentGuideDocId);
  out += formatEnvLine("CTI_DISCORD_BOT_TOKEN", config.discordBotToken);
  out += formatEnvLine(
    "CTI_DISCORD_ALLOWED_USERS",
    config.discordAllowedUsers?.join(",")
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
  if (config.qqImageEnabled !== undefined)
    out += formatEnvLine("CTI_QQ_IMAGE_ENABLED", String(config.qqImageEnabled));
  if (config.qqMaxImageSize !== undefined)
    out += formatEnvLine("CTI_QQ_MAX_IMAGE_SIZE", String(config.qqMaxImageSize));
  out += formatEnvLine("CTI_WEIXIN_BASE_URL", config.weixinBaseUrl);
  out += formatEnvLine("CTI_WEIXIN_CDN_BASE_URL", config.weixinCdnBaseUrl);
  if (config.weixinMediaEnabled !== undefined)
    out += formatEnvLine("CTI_WEIXIN_MEDIA_ENABLED", String(config.weixinMediaEnabled));
  if (config.selfOptimizeOnFailure !== undefined)
    out += formatEnvLine("CTI_SELF_OPTIMIZE_ON_FAILURE", String(config.selfOptimizeOnFailure));

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
  if (config.feishuDocumentGuideDocId)
    m.set("bridge_feishu_document_guide_doc_id", config.feishuDocumentGuideDocId);

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

  // ── Defaults ──
  // Upstream keys: bridge_default_work_dir, bridge_default_model, default_model
  m.set("bridge_default_work_dir", config.defaultWorkDir);
  if (config.allowedWorkspaceRoots && config.allowedWorkspaceRoots.length > 0) {
    m.set("bridge_allowed_workspace_roots", config.allowedWorkspaceRoots.join(";"));
  }
  if (config.codexAdditionalDirectories && config.codexAdditionalDirectories.length > 0) {
    m.set("bridge_default_additional_directories", config.codexAdditionalDirectories.join(";"));
  }
  if (config.memoryRepoDir) {
    m.set("bridge_memory_repo_dir", config.memoryRepoDir);
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
  if (config.unityMcpEndpoints) {
    m.set("bridge_unity_mcp_endpoint_list", config.unityMcpEndpoints);
  }
  if (config.unityMcpStartCommand) {
    m.set("bridge_unity_mcp_start_command", config.unityMcpStartCommand);
  }
  if (config.localLlmEnabled !== undefined) {
    m.set("bridge_local_llm_enabled", String(config.localLlmEnabled));
  }
  if (config.localLlmBaseUrl) {
    m.set("bridge_local_llm_base_url", config.localLlmBaseUrl);
  }
  if (config.localLlmModel) {
    m.set("bridge_local_llm_model", config.localLlmModel);
  }
  if (typeof config.localLlmTimeoutMs === "number" && Number.isFinite(config.localLlmTimeoutMs)) {
    m.set("bridge_local_llm_timeout_ms", String(Math.max(1000, Math.floor(config.localLlmTimeoutMs))));
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
  m.set("bridge_default_mode", config.defaultMode);
  if (config.selfOptimizeOnFailure !== undefined) {
    m.set("bridge_self_optimize_on_failure", String(config.selfOptimizeOnFailure));
  }

  return m;
}
