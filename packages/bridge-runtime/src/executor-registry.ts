import fs from 'node:fs';
import path from 'node:path';

import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

import { normalizeExecutorId, type Config } from './config.js';
import { readLocalModelCapabilityProfile } from './local-model-capability.js';
import { resolveClaudeCliPath, preflightCheck } from './llm-provider.js';
import { readLocalLlmStatus } from './local-llm-status.js';
import type {
  ExecutorCapability,
  ExecutorManifest,
  ExecutorRequest,
  ExecutorSelection,
  ToolSandboxPolicy,
} from './executor-types.js';

const EXECUTOR_HINTS: Array<{ pattern: RegExp; id: string }> = [
  { pattern: /(?:^|\s)@?codex(?:\s|$)/i, id: 'codex' },
  { pattern: /(?:^|\s)@?claude(?:\s|$)/i, id: 'claude-cli' },
  { pattern: /(?:^|\s)@?(?:ollama|codex-oss|本地codex)(?:\s|$)/i, id: 'codex-oss-ollama' },
  { pattern: /(?:^|\s)@?(?:local|local-agent|本地)(?:\s|$)/i, id: 'codex' },
  // v3.4: mavis external agent — opt-in executor
  { pattern: /(?:^|\s)@?(?:mavis|minimax|minimax-code)(?:\s|$)/i, id: 'mavis-agent' },
];

function isCodexEnabled(config: Config): boolean {
  return config.runtime === 'codex' || config.runtime === 'auto';
}

function isClaudeEnabled(config: Config): boolean {
  if (config.runtime === 'codex') return false;
  const cliPath = resolveClaudeCliPath();
  return !!cliPath && preflightCheck(cliPath).ok;
}

function isCodexOssOllamaEnabled(config: Config): boolean {
  const localAiKind = (config.localAiKind || 'ollama').toLowerCase();
  return localAiKind === 'ollama' && (config.ollamaEnabled ?? config.localLlmEnabled) === true && isCodexEnabled(config);
}

function isMavisEnabled(config: Config): boolean {
  // v3.4: opt-in. mavisEnabled === true AND a mavisCliPath is configured.
  return config.mavisEnabled === true && !!config.mavisCliPath;
}

export function buildToolSandboxPolicy(config: Config): ToolSandboxPolicy {
  return {
    allowReadOnlyGit: true,
    allowFileRead: true,
    allowTextSearch: true,
    allowSingleFileWrite: true,
    allowMcpOps: true,
    allowedWorkspaceRoots: config.allowedWorkspaceRoots || [config.defaultWorkDir].filter(Boolean),
    highRiskRequiresPermission: true,
  };
}

export function buildExecutorManifests(config: Config): ExecutorManifest[] {
  const localStatus = readLocalLlmStatus(config);
  const localModel = config.localAiModel || config.ollamaModel || config.localLlmModel || localStatus.model || 'qwen2.5-coder:7b';
  const localBaseUrl = config.localAiBaseUrl || config.ollamaBaseUrl || config.localLlmBaseUrl || localStatus.baseUrl || 'http://127.0.0.1:11434';
  const localCapabilities = readLocalModelCapabilityProfile(config);
  const codexModelSource = config.codexModelSource || ((config.codexBaseUrl || config.codexModel || config.codexApiKey) ? 'external_api' : 'official');
  const codexRoutingMode = config.codexRoutingMode || 'manual';
  const codexDisplayName = codexModelSource === 'local_api'
    ? `Codex CLI (本地模型 API: ${localModel})`
    : codexModelSource === 'external_api'
      ? `Codex CLI (外部 API: ${config.codexModel || '未指定模型'})`
      : codexRoutingMode === 'auto_failover'
        ? `Codex CLI (auto failover: ${(config.codexApiFallbackChain || ['local_api', 'external_api']).join(' -> ')})`
        : 'Codex CLI / SDK';

  return [
    {
      id: 'codex',
      displayName: codexDisplayName,
      kind: 'cli',
      capabilities: ['chat', 'code', 'repo_query', 'file_read', 'file_write', 'image_input', 'artifact_delivery'],
      riskLevel: 'workspace_write',
      enabled: isCodexEnabled(config),
      priority: config.runtime === 'codex' ? 100 : 80,
      description: '默认 Codex agent 执行器，负责仓库修改、多步任务和工具调用；本地 API / 外部 API 只是它的模型来源。',
      healthCheck: { kind: 'runtime_status', target: 'codex' },
      configSchema: {
        modelSource: codexModelSource,
        model: codexModelSource === 'local_api' ? localModel : config.codexModel,
        baseUrl: codexModelSource === 'local_api' ? localBaseUrl : config.codexBaseUrl,
        routingMode: codexRoutingMode,
        fallbackChain: config.codexApiFallbackChain || ['local_api', 'external_api'],
        localToolCallingState: localCapabilities.toolCallingState,
        localToolCallingMessage: localCapabilities.message,
        localExecutionTrusted: true,
        codexHome: codexModelSource === 'local_api' ? 'runtime/codex-home-local-primary' : 'runtime/codex-home',
      },
    },
    {
      id: 'claude-cli',
      displayName: 'Claude CLI',
      kind: 'cli',
      capabilities: ['chat', 'code', 'repo_query', 'file_read', 'file_write', 'image_input'],
      riskLevel: 'workspace_write',
      enabled: isClaudeEnabled(config),
      priority: config.runtime === 'claude' ? 95 : 70,
      description: 'Claude Code CLI 执行器，保留为可切换 CLI 后端。',
      healthCheck: { kind: 'command', target: 'claude --version' },
    },
    {
      id: 'codex-oss-ollama',
      displayName: `Codex OSS Ollama (${localModel})`,
      kind: 'cli',
      capabilities: ['chat', 'repo_query', 'file_read'],
      riskLevel: 'read_only',
      enabled: isCodexOssOllamaEnabled(config),
      priority: 45,
      description: '实验性 Codex OSS Ollama 只读入口；主要模型切换应通过 Codex CLI 模型来源 local_api 完成。',
      healthCheck: { kind: 'http', target: localBaseUrl },
      configSchema: {
        provider: 'ollama',
        model: localModel,
        baseUrl: localBaseUrl,
        command: 'codex exec --oss --local-provider ollama',
        readOnlyOnly: true,
      },
    },
    // v3.4: mavis external agent — opt-in, low priority, only loaded when
    // mavisEnabled=true AND mavisCliPath is set. Real dispatch goes through
    // `ExecutorProviderRegistry` (see executor-provider-registry.ts); this
    // manifest is the registry's discoverability source.
    {
      id: 'mavis-agent',
      displayName: `Mavis Agent (${config.mavisAgentName || 'mavis'})`,
      kind: 'agent',
      capabilities: config.mavisReadOnly
        ? ['chat', 'repo_query', 'file_read', 'image_input']
        : ['chat', 'code', 'repo_query', 'file_read', 'file_write', 'mcp_ops', 'image_input', 'artifact_delivery'],
      riskLevel: config.mavisReadOnly ? 'read_only' : 'workspace_write',
      enabled: isMavisEnabled(config),
      priority: config.mavisEnabled ? 50 : 0,
      description: 'Mavis / MiniMax Code 独立 executor；通过 mavis CLI 派发任务、轮询结果。',
      healthCheck: { kind: 'command', target: `${config.mavisCliPath || 'mavis'} status` },
      configSchema: {
        protocol: 'mavis-cli/v1',
        agent: config.mavisAgentName || 'mavis',
        port: config.mavisPort,
        dataDir: config.mavisDataDir,
        pollIntervalMs: config.mavisPollIntervalMs ?? 1500,
        hardTimeoutMs: config.mavisHardTimeoutMs ?? 480000,
        quietTimeoutMs: config.mavisQuietTimeoutMs ?? 90000,
        maxDiffBytes: config.mavisMaxDiffBytes ?? 32000,
        readOnly: !!config.mavisReadOnly,
        optIn: true,
        category: 'external-agent',
      },
    },
  ];
}

export function inferRequestedExecutorId(prompt: string): string | undefined {
  for (const hint of EXECUTOR_HINTS) {
    if (hint.pattern.test(prompt)) return hint.id;
  }
  return undefined;
}

export function getConfiguredDefaultExecutorId(config: Config): string | undefined {
  const configured = normalizeExecutorId(config.defaultExecutorId);
  if (configured) return configured;
  // Compatibility bridge for the old MiniMax-only switch. New callers should
  // prefer CTI_DEFAULT_EXECUTOR_ID so executor selection stays provider-neutral.
  if (
    config.mavisDefaultExecutor === true
    && config.mavisEnabled === true
    && !!config.mavisCliPath
  ) {
    return 'mavis-agent';
  }
  return undefined;
}

export function resolveRequestedExecutorId(
  config: Config,
  prompt: string,
  sessionDefaultId?: string,
): string | undefined {
  const hintedExecutorId = inferRequestedExecutorId(prompt);
  return hintedExecutorId
    ?? getConfiguredDefaultExecutorId(config)
    ?? normalizeExecutorId(sessionDefaultId);
}

/**
 * v3.6 P1 fix: broadened the file_write prompt heuristic. The previous
 * pattern only matched `修改|写入|保存|生成文件|edit|patch`, which let
 * phrases like "删除 package.json"、"create file"、"remove lockfile" or
 * "touch new-script.sh" slip through the read-only gate as if they were
 * pure reads. The mavis CLI would then happily execute the write.
 *
 * The new pattern covers the common write intents in both Chinese and
 * English — explicit create / delete / rename / append / replace verbs
 * plus short shell-style commands (`rm`, `mv`, `touch`). It is still a
 * prompt heuristic, not a sandbox — the truly airtight fix is to pass a
 * read-only sandbox flag to the mavis CLI in `createSession`; that is
 * future work tracked separately.
 */
const FILE_WRITE_INTENT_PATTERN = /(修改|写入|保存|生成文件|edit|patch|删除|新建|创建|create|delete|remove|drop|erase|trash|unlink|rename|重命名|move|移动|write to|save to|append|追加|insert|插入|put file|replace|替换|update|modify|touch)/iu;
// Short shell commands need word boundaries to avoid matching `arm`, `firm`, etc.
const FILE_WRITE_SHORT_CMD_PATTERN = /(?<![a-z])(?:rm|mv)\s/iu;

const MCP_INTENT_PATTERN = /(mcp|unity|blender|ignis|playwright|computer[\s_-]?use|desktop_)/i;

export function inferCapabilities(params: StreamChatParams, taskKind?: string): ExecutorCapability[] {
  const prompt = params.prompt || '';
  const capabilities = new Set<ExecutorCapability>(['chat']);
  if (taskKind === 'repo_query' || /\bgit\b|分支|提交|仓库|状态/u.test(prompt)) capabilities.add('repo_query');
  if (/读取|查看|搜索|find|grep|rg\b|Get-Content/iu.test(prompt)) capabilities.add('file_read');
  if (FILE_WRITE_INTENT_PATTERN.test(prompt) || FILE_WRITE_SHORT_CMD_PATTERN.test(prompt)) capabilities.add('file_write');
  if (MCP_INTENT_PATTERN.test(prompt)) capabilities.add('mcp_ops');
  if (params.files?.some((file) => file.type.startsWith('image/'))) capabilities.add('image_input');
  return Array.from(capabilities);
}

/**
 * v3.6 P1 fix: strict allow-list for `mavisReadOnly` mode.
 *
 * The previous implementation gated read-only with a blacklist
 * (`required.includes('file_write') || required.includes('mcp_ops')`).
 * That worked *given* `inferCapabilities` correctly inferred those — but
 * a pure read prompt that accidentally matched `code` would also slip
 * through. The cleaner model is: a read-only executor may ONLY emit
 * capabilities from this allow-list. Anything else (`file_write`,
 * `mcp_ops`, or any future capability we forget to enumerate in the
 * gate) is forbidden.
 *
 * This set MUST stay aligned with the `readOnly` manifest's
 * `capabilities` in `buildExecutorManifests` (executor-registry.ts).
 * If you add a capability to the readOnly manifest, also add it here.
 */
export const MAVIS_READ_ONLY_ALLOWED_CAPABILITIES: ReadonlySet<ExecutorCapability> = new Set<ExecutorCapability>([
  'chat',
  'repo_query',
  'file_read',
  'image_input',
]);

export function listMavisReadOnlyForbiddenCapabilities(
  required: ExecutorCapability[],
): ExecutorCapability[] {
  return required.filter((capability) => !MAVIS_READ_ONLY_ALLOWED_CAPABILITIES.has(capability));
}

export function selectExecutor(
  config: Config,
  request: ExecutorRequest,
  sessionDefaultId?: string,
): ExecutorSelection {
  const manifests = buildExecutorManifests(config).filter((manifest) => manifest.enabled);
  const required = inferCapabilities(request.params, request.taskKind);
  const explicitId = request.requestedExecutorId || inferRequestedExecutorId(request.prompt) || sessionDefaultId;
  const preferredId = request.preferredExecutorId;
  const explicit = explicitId ? manifests.find((manifest) => manifest.id === explicitId) : undefined;
  if (explicit) {
    return {
      executor: explicit,
      explicit: true,
      reason: `显式选择执行器：${explicit.id}`,
      fallbackExecutorIds: manifests.filter((manifest) => manifest.id !== explicit.id).map((manifest) => manifest.id),
    };
  }

  const candidates = manifests
    .map((manifest) => {
      const matched = required.filter((capability) => manifest.capabilities.includes(capability)).length;
      const score = manifest.priority + matched * 20 + (manifest.id === preferredId ? 15 : 0);
      return { manifest, score, matched };
    })
    .sort((a, b) => b.score - a.score);
  const picked = candidates[0]?.manifest || buildExecutorManifests(config)[0];
  return {
    executor: picked,
    explicit: false,
    reason: `按 capability 自动选择：${required.join(', ') || 'chat'}`,
    fallbackExecutorIds: candidates.slice(1).map((item) => item.manifest.id),
  };
}

export function resolveSessionExecutorDefaultsPath(config?: Config): string {
  const home = process.env.CTI_HOME || path.join(process.env.USERPROFILE || process.cwd(), '.claude-to-im');
  return path.join(home, 'runtime', 'executor-session-defaults.json');
}

export function readSessionExecutorDefaults(config?: Config): Record<string, string> {
  const filePath = resolveSessionExecutorDefaultsPath(config);
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function writeSessionExecutorDefault(sessionId: string, executorId: string, config?: Config): void {
  const filePath = resolveSessionExecutorDefaultsPath(config);
  const current = readSessionExecutorDefaults(config);
  if (executorId) {
    current[sessionId] = executorId;
  } else {
    delete current[sessionId];
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * v3.5 P2 fix: make `mavisDefaultExecutor` actually do something.
 *
 * The previous implementation loaded the flag and persisted it through
 * `saveConfig`, but no consumer ever read it — so setting
 * `CTI_MAVIS_DEFAULT_EXECUTOR=true` had no observable effect on which
 * executor a session actually used.
 *
 * This helper is the *write side* of the consumer:
 * - When `mavisDefaultExecutor=true` AND `mavisEnabled=true` AND a
 *   `mavisCliPath` is configured AND the session has no sticky default
 *   yet → lazily persist `'mavis-agent'` as that session's default.
 * - The read side is the caller's `requestedExecutorId =
 *   hintedExecutorId ?? sessionDefaultId ?? undefined` fold; the caller
 *   passes the returned `sessionDefaultId` and still lets explicit
 *   `@codex` / `@claude` / `@minimax` override (v3.3 P1 invariant).
 *
 * Returns the effective `sessionDefaultId` to feed into the resolver
 * (either the pre-existing sticky default, or `'mavis-agent'` if we
 * just wrote it). The `wrote` flag is exposed so callers / tests can
 * observe the lazy-write side effect.
 *
 * The write is best-effort: if the file system is unwritable, we still
 * return the default we'd have written so the request is not lost; the
 * failure is observable only via `wrote === false`.
 */
export function applyMavisDefaultExecutor(
  config: Config,
  sessionId: string,
  sessionDefaults: Record<string, string>,
): { sessionDefaultId: string | undefined; wrote: boolean } {
  const existing = sessionDefaults[sessionId];
  if (
    config.mavisDefaultExecutor === true
    && config.mavisEnabled === true
    && !!config.mavisCliPath
    && !existing
  ) {
    try {
      writeSessionExecutorDefault(sessionId, 'mavis-agent', config);
      return { sessionDefaultId: 'mavis-agent', wrote: true };
    } catch {
      // tolerate — best effort. The caller can still see the intent
      // without persisting it; subsequent turns will re-attempt the write.
      return { sessionDefaultId: 'mavis-agent', wrote: false };
    }
  }
  return { sessionDefaultId: existing, wrote: false };
}
