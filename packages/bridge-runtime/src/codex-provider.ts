/**
 * Codex Provider — LLMProvider implementation backed by @openai/codex-sdk.
 *
 * Maps Codex SDK thread events to the SSE stream format consumed by
 * the bridge conversation engine, making Codex a drop-in alternative
 * to the Claude Code SDK backend.
 *
 * Requires `@openai/codex-sdk` to be installed (optionalDependency).
 * The provider lazily imports the SDK at first use and throws a clear
 * error if it is not available.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { formatPriorityTurnContext, type LLMProvider, type StreamChatParams } from 'claude-to-im/host';
import { buildProviderInputEvidenceReceipt } from 'claude-to-im/evidence';
import type { PendingPermissions } from './permission-gateway.js';
import { CTI_HOME } from './config.js';
import {
  createCodexExecutionProfile,
  normalizeCodexReasoningEffort,
  resolveCodexModelSource,
  type CodexExecutionProfile,
  type CodexProviderProfile,
  type CodexReasoningEffort,
} from './codex-execution-profile.js';
import { resolveProviderWorkspace } from './provider-workspace.js';
import { sseEvent } from './sse-utils.js';
import type { CodexMcpServerProjection } from './mcp-bridge.js';

export type { CodexProviderProfile } from './codex-execution-profile.js';

/** MIME → file extension for temp image files. */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const SUMMARY_MARKER = '[[CTI_SUMMARY]]';
const DEFAULT_REASONING_EFFORT = 'low';
const DEFAULT_CONTEXT_CHAR_BUDGET = 12000;
const SYSTEM_PROMPT_CHAR_BUDGET = 4000;
const MAX_HISTORY_ENTRY_CHARS = 800;
const MAX_TOOL_RESULT_CHARS = 240;
const FINAL_REPLY_FENCE = 'cti-final';
const DEFAULT_FINAL_DRAIN_TIMEOUT_MS = 5_000;
const MIN_FINAL_DRAIN_TIMEOUT_MS = 1_000;
const MAX_FINAL_DRAIN_TIMEOUT_MS = 60_000;
const FINAL_DRAIN_TIMEOUT = Symbol('codex-final-drain-timeout');
const DEFAULT_STREAM_RECOVERY_TIMEOUT_MS = 15 * 60_000;
const MAX_STREAM_RECOVERY_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_STREAM_RECOVERY_POLL_MS = 500;
const SHARED_CODEX_HOME_PATHS = ['skills', 'plugins', 'vendor_imports', 'rules'];
const DEFAULT_BRIDGE_BLOCKED_SKILLS = ['github-memory-protocol'];
const LOCAL_CODEX_HOME_BLOCKED_PATHS = ['plugins', path.join('.tmp', 'plugins')];
const STATE_DB_PATTERNS = [
  /^state_\d+\.sqlite(?:-shm|-wal)?$/i,
  /^logs_\d+\.sqlite(?:-shm|-wal)?$/i,
];

// All SDK types kept as `any` because @openai/codex-sdk is optional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ThreadInstance = any;
interface CodexProviderOptions {
  profile?: CodexProviderProfile;
  /** Runtime 从受管 MCP manifest 生成的可信连接；不接受模型侧动态输入。 */
  managedMcpServers?: readonly CodexMcpServerProjection[];
  /** classifier 必须使用独立 Home，测试或受控宿主可显式覆盖。 */
  classifierCodexHome?: string;
  /** 完整最终协议出现后等待 SDK 正常结束的时长；测试可注入更短值。 */
  finalDrainTimeoutMs?: number;
  /** SDK 断流后等待同一受管 rollout 收口的时长；不会重放原任务。 */
  streamRecoveryTimeoutMs?: number;
  /** 测试或受控宿主可覆盖 rollout 所在 Codex Home。 */
  codexHome?: string;
  /** 测试可降低轮询间隔。 */
  streamRecoveryPollMs?: number;
}

function resolveFinalDrainTimeoutMs(configured?: number): number {
  if (Number.isFinite(configured) && Number(configured) > 0) {
    return Math.max(1, Math.floor(Number(configured)));
  }
  const fromEnv = Number(process.env.CTI_CODEX_FINAL_DRAIN_TIMEOUT_MS);
  if (!Number.isFinite(fromEnv) || fromEnv <= 0) return DEFAULT_FINAL_DRAIN_TIMEOUT_MS;
  return Math.min(
    MAX_FINAL_DRAIN_TIMEOUT_MS,
    Math.max(MIN_FINAL_DRAIN_TIMEOUT_MS, Math.floor(fromEnv)),
  );
}

function resolveStreamRecoveryTimeoutMs(configured?: number): number {
  if (Number.isFinite(configured) && Number(configured) > 0) {
    return Math.max(1, Math.floor(Number(configured)));
  }
  const fromEnv = Number(process.env.CTI_CODEX_STREAM_RECOVERY_TIMEOUT_MS);
  if (!Number.isFinite(fromEnv) || fromEnv <= 0) return DEFAULT_STREAM_RECOVERY_TIMEOUT_MS;
  return Math.min(MAX_STREAM_RECOVERY_TIMEOUT_MS, Math.max(1_000, Math.floor(fromEnv)));
}

function resolveStreamRecoveryPollMs(configured?: number): number {
  if (!Number.isFinite(configured) || Number(configured) <= 0) return DEFAULT_STREAM_RECOVERY_POLL_MS;
  return Math.max(5, Math.floor(Number(configured)));
}

/**
 * 只把完整、严格且具备可交付内容的 cti-final 视为收尾信号。
 * 裸 JSON、截断 fence 和普通进度文字都不能启动 watchdog。
 */
export function hasCompleteFinalReplyEnvelope(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const fencePattern = /```cti-final[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/giu;
  for (const match of text.matchAll(fencePattern)) {
    try {
      const parsed = JSON.parse(match[1].trim()) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const envelope = parsed as Record<string, unknown>;
      if (!['text', 'image', 'file', 'mixed'].includes(String(envelope.kind || '').toLowerCase())) continue;
      if (!['plain', 'markdown', 'html'].includes(String(envelope.reply_mode || '').toLowerCase())) continue;
      if (typeof envelope.text !== 'string') continue;
      if (!Array.isArray(envelope.images) || !envelope.images.every((item) => typeof item === 'string')) continue;
      if (!Array.isArray(envelope.files) || !envelope.files.every((item) => typeof item === 'string')) continue;
      if (!envelope.text.trim() && envelope.images.length === 0 && envelope.files.length === 0) continue;
      return true;
    } catch {
      // 继续检查同一消息中的后续完整 fence。
    }
  }
  return false;
}

/**
 * Shell 只是承载层。只有命令明确调用受控 Unity bridge/CLI 时，才把它提升为
 * Unity 工具证据；普通 Bash/PowerShell 成功不能冒充场景写入成功。
 */
export function inferCommandExecutionToolName(command: string): string {
  const normalized = command.normalize('NFKC').replace(/\\/gu, '/').toLowerCase();
  if (
    /(?:^|[\s"'])[^\s"']*\/\.aibridge\/cli\/aibridgecli(?:\.exe)?(?:[\s"']|$)/u.test(normalized)
    || /(?:^|[\s"'])[^\s"']*\/mcp-for-unity(?:\.exe)?(?:[\s"']|$)/u.test(normalized)
    || /(?:^|[\s"'])unity(?:\.exe)?[\s"'][^\r\n]*-batchmode\b/u.test(normalized)
  ) {
    return 'unity-mcp:managed-cli';
  }
  return 'Bash';
}

function findManagedRolloutFile(codexHome: string, threadId: string): string | undefined {
  const roots = [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')];
  const stack = roots.filter((root) => fs.existsSync(root));
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(target);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) {
        return target;
      }
    }
  }
  return undefined;
}

function parseRolloutToolInput(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { raw };
  }
}

function readRolloutCommand(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const command = (input as Record<string, unknown>).command;
  return typeof command === 'string' ? command : '';
}

function isRolloutToolOutputError(output: string): boolean {
  const exitCode = output.match(/(?:^|\n)Exit code:\s*(-?\d+)/iu)?.[1];
  return exitCode !== undefined && Number(exitCode) !== 0;
}

interface DisconnectedTurnRecoveryInput {
  codexHome: string;
  threadId: string;
  turnStartedAtMs: number;
  controller: ReadableStreamDefaultController<string>;
  signal: AbortSignal;
  timeoutMs: number;
  pollMs: number;
  seenItemIds: Set<string>;
}

/**
 * SDK 的 HTTP/事件流偶尔会先断开，但受管 Codex 子进程仍继续写同一 rollout。
 * 这里只跟随同一 thread 的耐久事件，不重新提交 prompt，因此不会重复副作用。
 */
async function recoverDisconnectedTurn(input: DisconnectedTurnRecoveryInput): Promise<boolean> {
  const deadline = Date.now() + input.timeoutMs;
  let rolloutPath: string | undefined;
  let offset = 0;
  const pendingCalls = new Map<string, { name: string; toolName: string; toolInput: unknown }>();
  const emittedCommentary = new Set<string>();

  while (Date.now() < deadline && !input.signal.aborted) {
    rolloutPath ||= findManagedRolloutFile(input.codexHome, input.threadId);
    if (rolloutPath) {
      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(rolloutPath);
      } catch {
        buffer = Buffer.alloc(0);
      }
      if (buffer.length < offset) offset = 0;
      const unread = buffer.subarray(offset);
      const lastNewline = unread.lastIndexOf(0x0a);
      if (lastNewline >= 0) {
        const complete = unread.subarray(0, lastNewline + 1).toString('utf8');
        offset += lastNewline + 1;
        for (const line of complete.split(/\r?\n/gu)) {
          if (!line.trim()) continue;
          let record: Record<string, unknown>;
          try {
            record = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          const timestamp = Date.parse(String(record.timestamp || ''));
          if (Number.isFinite(timestamp) && timestamp + 1_000 < input.turnStartedAtMs) continue;
          const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
            ? record.payload as Record<string, unknown>
            : undefined;
          if (!payload) continue;

          if (record.type === 'response_item' && payload.type === 'function_call') {
            const callId = String(payload.call_id || '');
            if (!callId || input.seenItemIds.has(callId)) continue;
            const name = String(payload.name || 'tool');
            const toolInput = parseRolloutToolInput(payload.arguments);
            const command = name === 'shell_command' ? readRolloutCommand(toolInput) : '';
            const toolName = name === 'shell_command' ? inferCommandExecutionToolName(command) : name;
            pendingCalls.set(callId, { name, toolName, toolInput });
            input.controller.enqueue(sseEvent('tool_use', {
              id: callId,
              name: toolName,
              input: toolInput,
            }));
            continue;
          }

          if (record.type === 'response_item' && payload.type === 'function_call_output') {
            const callId = String(payload.call_id || '');
            if (!callId || input.seenItemIds.has(callId)) continue;
            const pending = pendingCalls.get(callId);
            if (!pending) continue;
            const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? 'Done');
            input.seenItemIds.add(callId);
            pendingCalls.delete(callId);
            input.controller.enqueue(sseEvent('tool_result', {
              tool_use_id: callId,
              content: output || 'Done',
              is_error: isRolloutToolOutputError(output),
            }));
            continue;
          }

          if (record.type === 'event_msg' && payload.type === 'agent_message' && payload.phase === 'commentary') {
            const message = typeof payload.message === 'string' ? payload.message.trim() : '';
            if (message && !emittedCommentary.has(message)) {
              emittedCommentary.add(message);
              input.controller.enqueue(sseEvent('text', message));
            }
            continue;
          }

          if (record.type === 'event_msg' && payload.type === 'task_complete') {
            const finalText = typeof payload.last_agent_message === 'string'
              ? payload.last_agent_message.trim()
              : '';
            if (finalText) input.controller.enqueue(sseEvent('text', finalText));
            input.controller.enqueue(sseEvent('result', { session_id: input.threadId }));
            return true;
          }
        }
      }
    }

    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        input.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, input.pollMs);
      input.signal.addEventListener('abort', finish, { once: true });
    });
  }
  return false;
}

/**
 * Map bridge permission modes to Codex approval policies.
 * - 'acceptEdits' (code mode) → 'never' (execute directly unless the tool itself fails)
 * - 'plan' → 'on-request' (ask before executing)
 * - 'default' (ask mode) → 'on-request'
 */
export function toApprovalPolicy(permissionMode?: string): string {
  switch (permissionMode) {
    case 'acceptEdits': return 'never';
    case 'plan': return 'on-request';
    case 'default': return 'on-request';
    default: return 'on-request';
  }
}

/**
 * Codex sandbox mode for bridge sessions.
 * Default to danger-full-access so bridge-side coding sessions do not get
 * blocked on repo metadata writes such as `.git/FETCH_HEAD`.
 */
export function getSandboxMode(): string {
  return process.env.CTI_CODEX_SANDBOX_MODE || 'danger-full-access';
}

/** Allow Codex to run outside a trusted Git repository when explicitly enabled. */
export function shouldSkipGitRepoCheck(): boolean {
  return process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK === 'true';
}

function shouldRetryFreshThread(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('resuming session with different model') ||
    lower.includes('no such session') ||
    (lower.includes('resume') && lower.includes('session'))
  );
}

export function getReasoningEffort(_profile: CodexProviderProfile): CodexReasoningEffort {
  return normalizeCodexReasoningEffort(process.env.CTI_CODEX_REASONING_EFFORT || DEFAULT_REASONING_EFFORT);
}

type CodexClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  config: Record<string, unknown> & { model_reasoning_effort: CodexReasoningEffort };
  env: Record<string, string>;
};

export const CLASSIFIER_DISABLED_FEATURES = {
  shell_tool: false,
  unified_exec: false,
  apps: false,
  plugins: false,
  browser_use: false,
  browser_use_external: false,
  computer_use: false,
  image_generation: false,
  multi_agent: false,
  workspace_dependencies: false,
  skill_mcp_dependency_install: false,
  standalone_web_search: false,
  web_search_request: false,
  request_permissions_tool: false,
} as const;

const CLASSIFIER_FORBIDDEN_ITEM_TYPES = new Set([
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'web_search',
]);

function shouldResumeThreads(): boolean {
  return process.env.CTI_CODEX_RESUME_THREADS === 'true';
}

function getContextCharBudget(): number {
  return Math.max(
    4000,
    Number.parseInt(process.env.CTI_CODEX_CONTEXT_MAX_CHARS || `${DEFAULT_CONTEXT_CHAR_BUDGET}`, 10) || DEFAULT_CONTEXT_CHAR_BUDGET,
  );
}

function getGlobalCodexHome(): string {
  return process.env.CTI_CODEX_GLOBAL_HOME || path.join(os.homedir(), '.codex');
}

function getBridgeCodexHome(): string {
  return process.env.CTI_CODEX_HOME || path.join(CTI_HOME, 'runtime', 'codex-home');
}

function getOfficialCodexHome(): string {
  return process.env.CTI_CODEX_OFFICIAL_HOME || path.join(CTI_HOME, 'runtime', 'codex-home-official');
}

function getExternalCodexHome(): string {
  return process.env.CTI_CODEX_EXTERNAL_HOME || path.join(CTI_HOME, 'runtime', 'codex-home-external');
}

function getLocalPrimaryCodexHome(): string {
  return process.env.CTI_CODEX_LOCAL_PRIMARY_HOME || path.join(CTI_HOME, 'runtime', 'codex-home-local-primary');
}

function getCodexHomeForProfile(profile: CodexProviderProfile): string {
  if (profile === 'official') return getOfficialCodexHome();
  if (profile === 'external') return getExternalCodexHome();
  if (profile === 'local_primary') return getLocalPrimaryCodexHome();
  return getBridgeCodexHome();
}

function normalizeLocalFallbackBaseUrl(baseUrl: string, kind: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (kind === 'ollama' && !/\/v1$/i.test(trimmed)) return `${trimmed}/v1`;
  return trimmed;
}

export function sanitizeLocalApiEnv(env: Record<string, string>): Record<string, string> {
  const next = { ...env };
  delete next.OPENAI_API_KEY;
  delete next.CODEX_API_KEY;
  delete next.CTI_CODEX_API_KEY;
  delete next.CTI_CODEX_BASE_URL;
  return next;
}

export function normalizeAdditionalDirectories(additionalDirectories?: string[]): string[] {
  if (!Array.isArray(additionalDirectories)) return [];
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const entry of additionalDirectories) {
    if (!entry || typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const absolute = path.resolve(trimmed);
    if (!fs.existsSync(absolute)) continue;
    const dedupeKey = absolute.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    resolved.push(absolute);
  }
  return resolved;
}

export function resolveWorkingDirectory(workingDirectory?: string): string | undefined {
  const candidates = [
    workingDirectory,
    process.env.CTI_DEFAULT_WORKDIR,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const absolute = path.resolve(trimmed);
    if (fs.existsSync(absolute)) return absolute;
  }
  return undefined;
}

export function toTextEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function ensureSharedPath(sourcePath: string, targetPath: string): void {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return;
  const stats = fs.statSync(sourcePath);
  if (stats.isDirectory()) {
    try {
      fs.symlinkSync(sourcePath, targetPath, 'junction');
      return;
    } catch {
      fs.cpSync(sourcePath, targetPath, { recursive: true });
      return;
    }
  }
  fs.copyFileSync(sourcePath, targetPath);
}

function removeGeneratedSharedPath(targetPath: string): void {
  if (!fs.existsSync(targetPath)) return;
  const stats = fs.lstatSync(targetPath);
  if (stats.isSymbolicLink()) {
    fs.unlinkSync(targetPath);
    return;
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
}

export function getBridgeBlockedSkillNames(): Set<string> {
  const configured = (process.env.CTI_CODEX_BLOCKED_SKILLS || '')
    .split(/[;,\n]/u)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_BRIDGE_BLOCKED_SKILLS, ...configured]);
}

/**
 * Bridge Codex Home 不能直接共享整个个人 skills 根目录，否则 IM 记忆请求会被
 * 旧 github-memory-protocol 的高优先级触发规则抢走。这里保留其他个人 skill，
 * 只在生成的 bridge home 中过滤明确禁止的旧入口，不修改用户全局技能目录。
 */
function ensureFilteredSkillsRoot(globalHome: string, bridgeHome: string): void {
  const sourceRoot = path.join(globalHome, 'skills');
  const targetRoot = path.join(bridgeHome, 'skills');
  if (!fs.existsSync(sourceRoot)) return;

  if (fs.existsSync(targetRoot) && fs.lstatSync(targetRoot).isSymbolicLink()) {
    fs.unlinkSync(targetRoot);
  }
  fs.mkdirSync(targetRoot, { recursive: true });

  const blocked = getBridgeBlockedSkillNames();
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    const target = path.join(targetRoot, entry.name);
    if (blocked.has(entry.name.toLowerCase())) {
      removeGeneratedSharedPath(target);
      continue;
    }
    ensureSharedPath(path.join(sourceRoot, entry.name), target);
  }
}

function syncFileIfNewer(sourcePath: string, targetPath: string): void {
  if (!fs.existsSync(sourcePath)) return;
  if (!fs.existsSync(targetPath)) {
    fs.copyFileSync(sourcePath, targetPath);
    return;
  }
  const sourceStat = fs.statSync(sourcePath);
  const targetStat = fs.statSync(targetPath);
  if (sourceStat.mtimeMs > targetStat.mtimeMs || sourceStat.size !== targetStat.size) {
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function getSharedCodexHomePaths(profile: CodexProviderProfile): string[] {
  const inheritGlobalPlugins = profile !== 'local_primary'
    && process.env.CTI_CODEX_INHERIT_GLOBAL_PLUGINS === 'true';
  const shared = SHARED_CODEX_HOME_PATHS.filter((relativePath) => relativePath !== 'skills'
    && (inheritGlobalPlugins || relativePath !== 'plugins'));
  return shared;
}

function removeUnsupportedCodexPluginState(bridgeHome: string, profile: CodexProviderProfile): void {
  const inheritGlobalPlugins = profile !== 'local_primary'
    && process.env.CTI_CODEX_INHERIT_GLOBAL_PLUGINS === 'true';
  if (inheritGlobalPlugins) return;
  for (const relativePath of LOCAL_CODEX_HOME_BLOCKED_PATHS) {
    try {
      // Bridge Home 是生成目录；遇到 junction/symlink 时只解除生成入口，不能
      // 递归触碰用户全局插件缓存。
      removeGeneratedSharedPath(path.join(bridgeHome, relativePath));
    } catch {
      // best effort; CLI/SDK Bridge 不应依赖桌面专用插件运行态
    }
  }
}

function sanitizeCodexConfig(content: string, reasoningEffort: string, profile: CodexProviderProfile = 'primary'): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const topLevel: string[] = [];
  const sections: string[] = [];
  let skipSection = false;
  let inTopLevel = true;
  const inheritGlobalMcp = process.env.CTI_CODEX_INHERIT_GLOBAL_MCP === 'true';
  const inheritGlobalPlugins = profile !== 'local_primary'
    && process.env.CTI_CODEX_INHERIT_GLOBAL_PLUGINS === 'true';
  const isolateLocalAgent = profile === 'local_primary';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const sectionName = trimmed.slice(1, -1).trim();
      const isFeatureSection = sectionName === 'features' || sectionName.startsWith('features.');
      const isMcpSection = sectionName === 'mcp_servers' || sectionName.startsWith('mcp_servers.');
      const isPluginSection = sectionName === 'plugins' || sectionName.startsWith('plugins.');
      const isMarketplaceSection = sectionName === 'marketplaces' || sectionName.startsWith('marketplaces.');
      const isDesktopSection = sectionName === 'desktop' || sectionName.startsWith('desktop.');
      const isMemoriesSection = sectionName === 'memories' || sectionName.startsWith('memories.');
      skipSection = isFeatureSection
        || (!inheritGlobalMcp && isMcpSection)
        || (!inheritGlobalPlugins && (isPluginSection || isMarketplaceSection || isDesktopSection))
        || (isolateLocalAgent && isMemoriesSection);
      inTopLevel = false;
      if (!skipSection) sections.push(line);
      continue;
    }
    if (skipSection) continue;
    if (inTopLevel && /^model\s*=/.test(trimmed)) continue;
    if (isolateLocalAgent && inTopLevel && /^(personality|notify)\s*=/.test(trimmed)) continue;
    if (trimmed.startsWith('model_reasoning_effort')) continue;
    (inTopLevel ? topLevel : sections).push(line);
  }

  const normalizedTopLevel = topLevel.join('\n').trim();
  const normalizedSections = sections.join('\n').trim();
  return [
    normalizedTopLevel,
    `model_reasoning_effort = "${reasoningEffort}"`,
    normalizedSections,
  ]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n');
}

function renderManagedCodexMcpConfig(
  content: string,
  profile: CodexProviderProfile,
  servers: readonly CodexMcpServerProjection[] = [],
): string {
  // 受限本地 Agent / classifier 不能因为 Primary 的能力投影获得 MCP。
  if (profile === 'local_primary' || servers.length === 0) return content;
  const sections: string[] = [];
  const seen = new Set<string>();

  for (const server of servers) {
    const name = server.name.trim();
    const key = name.toLowerCase();
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name) || seen.has(key)) continue;
    seen.add(key);
    const sectionPattern = new RegExp(`\\[mcp_servers\\.(?:"${name}"|${name})\\]`, 'iu');
    if (sectionPattern.test(content)) continue;

    if (server.type === 'http') {
      if (!server.url || !/^https?:\/\//iu.test(server.url)) continue;
      sections.push([
        `[mcp_servers.${name}]`,
        `url = ${JSON.stringify(server.url)}`,
      ].join('\n'));
      continue;
    }

    if (!server.command || !path.isAbsolute(server.command)) continue;
    const lines = [
      `[mcp_servers.${name}]`,
      `command = ${JSON.stringify(server.command)}`,
    ];
    const envEntries = Object.entries(server.env || {})
      .filter(([envKey]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(envKey));
    if (envEntries.length > 0) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [envKey, value] of envEntries) {
        lines.push(`${envKey} = ${JSON.stringify(value)}`);
      }
    }
    sections.push(lines.join('\n'));
  }

  if (sections.length === 0) return content;
  return `${content.trimEnd()}\n\n# Managed by codex-im-suite from config/mcp.d\n${sections.join('\n\n')}\n`;
}

function resetBridgeStateDatabases(bridgeHome: string): void {
  // Codex 会从 sessions 回填 state DB。若每次创建主客户端/分类器都删除它，
  // 冷启动回填会与短超时互相打断，并留下持续的 backfill 锁。
  // 因此只在明确诊断到状态库不兼容时，才由运维显式请求一次重置。
  if (process.env.CTI_CODEX_RESET_STATE !== 'true') return;
  if (!fs.existsSync(bridgeHome)) return;
  for (const entry of fs.readdirSync(bridgeHome)) {
    if (!STATE_DB_PATTERNS.some((pattern) => pattern.test(entry))) continue;
    const target = path.join(bridgeHome, entry);
    try {
      fs.rmSync(target, { force: true });
    } catch {
      // best effort; ignore locked files
    }
  }
}

export function ensureBridgeCodexHome(
  profile: CodexProviderProfile,
  managedMcpServers: readonly CodexMcpServerProjection[] = [],
  homeOverride?: string,
): string {
  const bridgeHome = homeOverride
    ? path.resolve(homeOverride)
    : profile === 'local_primary'
      ? getLocalPrimaryCodexHome()
      : profile === 'official'
        ? getOfficialCodexHome()
        : profile === 'external'
          ? getExternalCodexHome()
          : getBridgeCodexHome();
  const globalHome = getGlobalCodexHome();
  const reasoningEffort = getReasoningEffort(profile);

  fs.mkdirSync(bridgeHome, { recursive: true });
  fs.mkdirSync(path.join(bridgeHome, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(bridgeHome, 'archived_sessions'), { recursive: true });
  fs.mkdirSync(path.join(bridgeHome, 'tmp'), { recursive: true });
  resetBridgeStateDatabases(bridgeHome);
  removeUnsupportedCodexPluginState(bridgeHome, profile);

  syncFileIfNewer(path.join(globalHome, 'auth.json'), path.join(bridgeHome, 'auth.json'));

  for (const relativePath of getSharedCodexHomePaths(profile)) {
    ensureSharedPath(path.join(globalHome, relativePath), path.join(bridgeHome, relativePath));
  }
  ensureFilteredSkillsRoot(globalHome, bridgeHome);

  const globalConfigPath = path.join(globalHome, 'config.toml');
  const bridgeConfigPath = path.join(bridgeHome, 'config.toml');
  const sanitizedBridgeConfig = fs.existsSync(globalConfigPath)
    ? sanitizeCodexConfig(fs.readFileSync(globalConfigPath, 'utf-8'), reasoningEffort, profile)
    : `model_reasoning_effort = "${reasoningEffort}"\n`;
  const bridgeConfig = renderManagedCodexMcpConfig(sanitizedBridgeConfig, profile, managedMcpServers);
  fs.writeFileSync(bridgeConfigPath, bridgeConfig, 'utf-8');

  return bridgeHome;
}

function resolveExecutionProfile(
  profile: CodexProviderProfile,
  restrictedInteraction = false,
): CodexExecutionProfile {
  const localAiKind = (process.env.CTI_LOCAL_AI_KIND || 'ollama').trim().toLowerCase();
  const configuredModelSource = process.env.CTI_CODEX_MODEL_SOURCE
    || (process.env.CTI_CODEX_BASE_URL || process.env.CTI_CODEX_MODEL || process.env.CTI_CODEX_API_KEY
      ? 'external_api'
      : 'official');
  const modelSource = resolveCodexModelSource({
    providerProfile: profile,
    configuredModelSource,
  });
  const baseUrl = modelSource === 'local_api'
    ? normalizeLocalFallbackBaseUrl(
      process.env.CTI_LOCAL_AI_BASE_URL || process.env.CTI_OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
      localAiKind,
    )
    : modelSource === 'external_api'
      ? process.env.CTI_CODEX_BASE_URL || undefined
      : undefined;
  return createCodexExecutionProfile({
    providerProfile: profile,
    configuredModelSource,
    configuredModel: process.env.CTI_CODEX_MODEL,
    localModel: process.env.CTI_LOCAL_AI_MODEL || process.env.CTI_OLLAMA_MODEL || 'qwen2.5-coder:7b',
    configuredReasoningEffort: process.env.CTI_CODEX_REASONING_EFFORT || DEFAULT_REASONING_EFFORT,
    baseUrl,
    restrictedInteraction,
  });
}

export function getOrdinaryCodexExecutionProfile(
  profile: CodexProviderProfile = 'primary',
): CodexExecutionProfile {
  return resolveExecutionProfile(profile, false);
}

function buildCodexClientOptions(
  profile: CodexProviderProfile = 'primary',
  managedMcpServers: readonly CodexMcpServerProjection[] = [],
  homeOverride?: string,
): CodexClientOptions & {
  executionProfile: CodexExecutionProfile;
  modelOverride?: string;
  passModel: boolean;
  profile: CodexProviderProfile;
} {
  const executionProfile = resolveExecutionProfile(profile);
  const useLocalApi = executionProfile.modelSource === 'local_api';
  const apiKey = useLocalApi
    ? process.env.CTI_LOCAL_AI_API_KEY || undefined
    : executionProfile.modelSource === 'external_api'
      ? (process.env.CTI_CODEX_API_KEY
      || process.env.CODEX_API_KEY
      || process.env.OPENAI_API_KEY
      || undefined)
      : undefined;
  const bridgeCodexHome = ensureBridgeCodexHome(profile, managedMcpServers, homeOverride);
  process.env.CODEX_HOME = bridgeCodexHome;
  const env = {
    ...toTextEnv(process.env),
    // Codex tool calls inherit only this explicit environment object.  The
    // bridge may resolve CTI_HOME from its default path without exporting the
    // variable globally, so pass it through here to keep memory/history helper
    // scripts on the active bridge data store instead of legacy fallbacks.
    CTI_HOME: process.env.CTI_HOME || CTI_HOME,
    CODEX_HOME: bridgeCodexHome,
  };
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(executionProfile.baseUrl ? { baseUrl: executionProfile.baseUrl } : {}),
    config: {
      model_reasoning_effort: executionProfile.requestedReasoningEffort,
    },
    env: useLocalApi ? sanitizeLocalApiEnv(env) : env,
    executionProfile,
    modelOverride: executionProfile.submittedModel,
    passModel: executionProfile.modelMode === 'explicit',
    profile,
  };
}

export function buildCodexClientOptionsForTest(
  profile: CodexProviderProfile = 'primary',
  managedMcpServers: readonly CodexMcpServerProjection[] = [],
): CodexClientOptions & {
  executionProfile: CodexExecutionProfile;
  modelOverride?: string;
  passModel: boolean;
  profile: CodexProviderProfile;
} {
  return buildCodexClientOptions(profile, managedMcpServers);
}

/**
 * 常驻 app-server 与一次性 Codex SDK 必须复用同一模型、认证和隔离 Home。
 * 该出口只暴露启动受限会话所需的运行参数，避免第二套 Provider 配置漂移。
 */
export function buildRestrictedCodexRuntimeProfile(
  profile: CodexProviderProfile = 'official',
  restrictedCodexHome?: string,
): {
  executionProfile: CodexExecutionProfile;
  env: Record<string, string>;
  apiKey?: string;
  config: Record<string, unknown>;
} {
  // 轻聊协调器不能复用 Primary 的可变 config.toml：否则它每次按无 MCP
  // 配置初始化时都会覆盖 official / external Home 的受管 manifest 投影。
  // 独立 Home 同步认证与受控基础配置，但继续保持无 MCP、无工具边界。
  const clientOptions = buildCodexClientOptions(profile, [], restrictedCodexHome);
  return {
    executionProfile: resolveExecutionProfile(profile, true),
    env: clientOptions.env,
    ...(clientOptions.apiKey ? { apiKey: clientOptions.apiKey } : {}),
    config: {
      ...clientOptions.config,
      model_reasoning_effort: 'low',
      project_doc_max_bytes: 0,
      web_search: 'disabled',
      features: CLASSIFIER_DISABLED_FEATURES,
    },
  };
}

function normalizeText(text: string): string {
  return text
    .replace(/<!--files:[\s\S]*?-->/g, '[附带文件]')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(text: string, maxLen: number): string {
  const normalized = normalizeText(text);
  if (!normalized) return '';
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 3)}...` : normalized;
}

function truncateSystemPromptPreservingProtocols(text: string, maxLen = SYSTEM_PROMPT_CHAR_BUDGET): string {
  const normalized = normalizeText(text);
  if (!normalized || normalized.length <= maxLen) return normalized;

  const lines = text
    .replace(/<!--files:[\s\S]*?-->/g, '[附带文件]')
    .split(/\r?\n/)
    .map(line => normalizeText(line))
    .filter(Boolean);
  const protocolLines = [...new Set(lines.filter(line => (
    /\bprotocol\b/i.test(line) && /```cti-[a-z0-9][a-z0-9-]*/i.test(line)
  )))];
  if (protocolLines.length === 0) return truncateText(text, maxLen);

  // 协议可能位于任意 prompt section；先给结构化动作协议保留预算，再裁剪普通上下文。
  const protocolBlock = ['Critical bridge protocols:', ...protocolLines].join('\n');
  const separator = '\n\n';
  if (protocolBlock.length + separator.length >= maxLen) return truncateText(protocolBlock, maxLen);

  const protocolSet = new Set(protocolLines);
  const regularText = lines.filter(line => !protocolSet.has(line)).join(' ');
  const regularBudget = maxLen - protocolBlock.length - separator.length;
  const regularBlock = truncateText(regularText, regularBudget);
  return regularBlock ? `${regularBlock}${separator}${protocolBlock}` : protocolBlock;
}

function getReplyStyleHint(params?: StreamChatParams): string {
  return (
    params?.replyPresentation?.replyStyleHint
    || process.env.CTI_REPLY_STYLE_HINT
    || ''
  ).trim();
}

function buildBridgeReplyGuardrails(params?: StreamChatParams): string {
  const lines = [
    'Bridge reply contract:',
    '- User-facing reply must be concise and outcome-first.',
    '- Do not expose hidden reasoning, long planning narration, or step-by-step internal thought.',
    '- Execution details, troubleshooting steps, and intermediate progress belong to bridge logs/panel, not the final chat reply.',
    '- Prefer a short natural Chinese reply that states: what was done, the key result, and at most one next step if needed.',
    '- Keep only the essential result unless the user explicitly asks for a detailed walkthrough.',
    '- If the task is unfinished or blocked, state the exact blocker briefly instead of narrating your whole investigation.',
    '- Execution posture: you are the worker responsible for solving the request, not a helper giving the user homework.',
    '- Default posture: proactively satisfy the request. When a safe bounded action can move the task forward, use the available context and safe tools first instead of asking the user to do the check manually.',
    '- If input is incomplete, infer reasonable safe defaults from the current turn, attachments, workspace, history, and tool evidence; ask only for the smallest missing detail that blocks safe execution.',
    '- If only part of the task can be completed, keep the useful partial result, explain the exact blocker, and give one concrete next confirmation or option.',
    '- Do not answer executable tasks with generic instructions, suggested manual steps, placeholder tables, or sample scripts unless the user explicitly asks for a tutorial or draft.',
    '- For Unity/Blender/MCP/repository/file tasks, the final answer must be based on real tool output, a real command result, or an explicit blocker from a concrete attempt.',
    '- Use only tools and skills actually exposed by the current runtime. Do not guess skill paths or manually execute files from plugin caches; if an exposed capability lacks its required helper/runtime, report that concrete blocker and use a verified non-plugin alternative only when one exists.',
    '- For a concrete Unity/Prefab/scene request, never answer with "please specify MCP entry" or an MCP entry list if the user already named Unity, Unity MCP, unitymcp, prefab, a scene, or a prefab/object name. Attempt Unity tooling, or report the exact blocker.',
    '- For screenshot requests, only send images that were captured or regenerated during the current turn, or images that the user explicitly asked to resend by exact path/name. Do not search old capture folders and reuse a historical screenshot as proof of a new scene refresh.',
    '- If Unity scene refresh or preview capture fails, return a text-only "未完成" blocker. Do not attach a previous screenshot to make the task look complete.',
    '- For HTTP MCP endpoints, a 406 Not Acceptable response from /mcp usually means the endpoint is alive but the request missed the MCP Accept header. Retry with Accept: application/json, text/event-stream and a proper initialize handshake before declaring the MCP offline.',
    '- If no concrete attempt was made for a requested tool workflow, do not produce a final how-to answer. Attempt the tool path first or report the missing prerequisite.',
    '- Never start the user-facing reply with phrases like: 这次是…… / 我会…… / 我先…… / 我继续…… / 我已经确认…… . Start with the actual answer or result directly.',
    '- If the user asked to send something again, repeat the concrete content directly instead of describing your retrieval process.',
    '- If the answer is a mapping, checklist, or correspondence table, include the actual items. Do not stop at an intro sentence.',
    '- If retrieved content contains exact identifiers, names, codes, keys, file names, scene names, or other structured labels, preserve those exact strings verbatim in the final answer.',
    '- For replay / resend / correspondence requests, prefer the exact recovered mapping lines over a paraphrased summary. Do not collapse a structured mapping into only category words or loose Chinese summaries. If you only found partial items, say it is partial while still listing the exact recovered keys.',
    '- Tone should be natural and light, similar to: 这个我做好啦…… / 这个已经处理完了……, but avoid repetitive filler.',
    '- If future style or memory hints are provided, treat them as an explicit persona/output requirement.',
    '- When a custom reply style hint exists, you must visibly reflect it in the final wording, not just keep the default neutral tone.',
    '- Keep the custom style while still staying concise and not exposing hidden reasoning.',
    `- Emit exactly one final fenced result block labeled ${FINAL_REPLY_FENCE}.`,
    `- The ${FINAL_REPLY_FENCE} block must contain strict JSON with keys: kind, text, images, files, reply_mode.`,
    '- kind must be one of: text, image, file, mixed.',
    '- Put all final user-visible content only inside that JSON block. Do not place the final answer outside the block.',
    '- text must contain the complete final text to send. For mappings, lists, and tables, include all actual items in text.',
    '- images and files must contain only requested output deliverables. Attachments supplied only for recognition, description, analysis, or context are input evidence and must not be copied into these arrays unless the user\'s actual result objective requires delivering that same source attachment.',
    '- Judge source-attachment delivery from the current request purpose rather than a fixed phrase or filename. New generated/edited/annotated/exported artifacts may use their new verified local paths.',
    '- Otherwise images and files must be empty arrays.',
    '- Optional card_hero may be {"image":"<one exact path already present in images>","alt":"<short description>"} when one delivered image should appear as a wide card banner above the reply text and controls. Use it based on the requested presentation goal, not fixed keywords.',
    '- card_hero never creates or fetches an image. Its image must exactly match one entry in images. Never put an image_key, URL, callback data, platform identity, or an input-only attachment in card_hero.',
    '- reply_mode must be one of: plain, markdown, html.',
    '- Optional keys mentions and reply_to may be included when needed.',
    '- For Feishu market-style overviews, monitoring/status analysis, comparisons, reviews, or incident situation reports with several real indicators, optional analysis_view may contain visible-only title, verdict, tone, metrics, and sections. Do not use it for lightweight chat or invent metrics to fill a template.',
    '- analysis_view tone is positive|negative|warning|neutral|info; metrics contains at most 6 objects with label/value and optional change/tone; sections contains at most 4 objects with title/items and optional tone. Never include Card JSON, colors, callbacks, URLs, commands, paths, platform IDs, or trusted actions.',
    '- Keep the normal text as useful fallback detail, but do not repeat the same analysis_view title, verdict, and all metrics verbatim. Use it for supporting evidence or context.',
    '- When the user must choose one of 2-8 concrete known alternatives, optional choices may be an array of objects with only label and optional description; optional choice_title names the decision.',
    '- For a multi-turn finite-choice interaction, include choice_flow={"mode":"continuous","state":"active"} with 2-8 choices on every non-terminal turn. On the terminal turn include choice_flow={"mode":"continuous","state":"complete"}. Never invent a flow ID; the Bridge owns it.',
    '- Only when the user explicitly requests group participation, include choice_session: vote={"mode":"vote","state":"active","duration_seconds":10..3600}, claim={"mode":"claim","state":"active"}, or parallel={"mode":"parallel","state":"active"}. Ordinary choices omit it and remain initiator-only.',
    '- Group choice is never a permission, Owner/high-risk confirmation, credential, or identity mechanism. Never include participant IDs or callback/action fields.',
    '- Do not use choices for free-form input, permissions, Owner/high-risk confirmation, secrets, identity resolution, or arbitrary commands. Never include callback_data or platform/action parameters; the Bridge creates safe buttons.',
    '- Never output a naked JSON object outside the fenced result block.',
    `- Example:\n\`\`\`${FINAL_REPLY_FENCE}\n{"kind":"text","text":"对应关系再发你一次：\\n| Key | Label |\\n|---|---|\\n| \`ITEM_A\` | 标签A |","images":[],"files":[],"reply_mode":"markdown"}\n\`\`\``,
  ];
  const styleHint = getReplyStyleHint(params);
  if (styleHint) {
    lines.push(`- Required custom reply style: ${styleHint}`);
    lines.push('- Apply the custom reply style in the very first sentence of the user-facing reply.');
    lines.push('- If the custom reply style conflicts with safety or truthfulness, preserve safety/truthfulness and keep as much of the style as possible.');
  }
  return lines.join('\n');
}

function summarizeToolBlocks(rawContent: string): string {
  try {
    const blocks = JSON.parse(rawContent) as Array<Record<string, unknown>>;
    const parts: string[] = [];
    for (const block of blocks) {
      if (block?.type === 'text') {
        const text = truncateText(String(block.text || ''), MAX_HISTORY_ENTRY_CHARS);
        if (text) parts.push(text);
        continue;
      }
      if (block?.type === 'tool_use') {
        const name = String(block.name || '');
        const input = block.input as { command?: unknown; files?: Array<{ path?: string; kind?: string }> } | undefined;
        if (name === 'Bash' && typeof input?.command === 'string') {
          parts.push(`工具 Bash: ${truncateText(input.command, 160)}`);
        } else if (name === 'Edit' && Array.isArray(input?.files)) {
          const files = input.files
            .slice(0, 4)
            .map((file) => `${String(file.kind || 'update')}:${String(file.path || '')}`)
            .join(', ');
          if (files) parts.push(`工具 Edit: ${files}`);
        } else if (name) {
          parts.push(`工具 ${name}`);
        }
        continue;
      }
      if (block?.type === 'tool_result') {
        const content = truncateText(String(block.content || ''), MAX_TOOL_RESULT_CHARS);
        if (content) parts.push(`结果: ${content}`);
      }
    }
    return truncateText(parts.join(' | '), MAX_HISTORY_ENTRY_CHARS);
  } catch {
    return truncateText(rawContent, MAX_HISTORY_ENTRY_CHARS);
  }
}

function serializeHistoryEntry(
  message: { role: 'user' | 'assistant'; content: string },
): string {
  const roleLabel = message.role === 'assistant' ? 'Assistant' : 'User';
  const rawContent = message.content || '';
  let content: string;

  if (rawContent.startsWith(SUMMARY_MARKER)) {
    content = truncateText(rawContent.slice(SUMMARY_MARKER.length), MAX_HISTORY_ENTRY_CHARS);
  } else if (rawContent.trim().startsWith('[')) {
    content = summarizeToolBlocks(rawContent);
  } else {
    content = truncateText(rawContent, MAX_HISTORY_ENTRY_CHARS);
  }

  return content ? `${roleLabel}: ${content}` : '';
}

function selectHistoryEntries(
  history: Array<{ role: 'user' | 'assistant'; content: string }> | undefined,
): string[] {
  if (!history || history.length === 0) return [];
  const budget = getContextCharBudget();
  const selected: string[] = [];
  let totalChars = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = serializeHistoryEntry(history[index]);
    if (!entry) continue;
    const nextSize = totalChars + entry.length + 1;
    if (selected.length > 0 && nextSize > budget) break;
    selected.push(entry);
    totalChars = nextSize;
  }

  return selected.reverse();
}

export function buildTurnPrompt(params: StreamChatParams): string {
  const sections: string[] = [];
  const systemPrompt = truncateSystemPromptPreservingProtocols(params.systemPrompt || '');
  const priorityTurnContext = formatPriorityTurnContext(params.priorityTurnContext);
  const historyEntries = selectHistoryEntries(params.conversationHistory);
  const userPrompt = params.prompt.trim();

  if (systemPrompt) {
    sections.push(`System instructions:\n${systemPrompt}`);
  }
  sections.push(`Bridge reply style:\n${buildBridgeReplyGuardrails(params)}`);
  if (historyEntries.length > 0) {
    sections.push(`Conversation context:\n${historyEntries.join('\n')}`);
  }
  // 结构化本轮焦点放在普通历史之后、当前请求之前，避免旧会话与记忆
  // 在注意力顺序上覆盖原生 reply、mention 或附件关系。
  if (priorityTurnContext) {
    sections.push(priorityTurnContext);
  }
  sections.push(`Current user request:\n${userPrompt}`);
  return sections.join('\n\n');
}

export class CodexProvider implements LLMProvider {
  private sdk: CodexModule | null = null;
  private codex: CodexInstance | null = null;
  private classifierCodex: CodexInstance | null = null;

  /**
   * 只复用执行档案一致的 Codex thread，避免模型或推理强度变化后沿用旧会话参数。
   */
  private threadBindings = new Map<string, { threadId: string; profileFingerprint: string }>();

  constructor(
    private pendingPerms: PendingPermissions,
    private readonly options: CodexProviderOptions = {},
  ) {}

  /**
   * Lazily load the Codex SDK. Throws a clear error if not installed.
   */
  private async ensureSDK(): Promise<{ sdk: CodexModule; codex: CodexInstance }> {
    if (this.sdk && this.codex) {
      return { sdk: this.sdk, codex: this.codex };
    }

    try {
      this.sdk = await (Function('return import("@openai/codex-sdk")')() as Promise<CodexModule>);
    } catch {
      throw new Error(
        '[CodexProvider] @openai/codex-sdk is not installed. ' +
        'Install it with: npm install @openai/codex-sdk'
      );
    }

    const clientOptions = buildCodexClientOptions(
      this.options.profile || 'primary',
      this.options.managedMcpServers,
    );

    const CodexClass = this.sdk.Codex;
    this.codex = new CodexClass({
      ...(clientOptions.apiKey ? { apiKey: clientOptions.apiKey } : {}),
      ...(clientOptions.baseUrl ? { baseUrl: clientOptions.baseUrl } : {}),
      config: clientOptions.config,
      env: clientOptions.env,
    });

    return { sdk: this.sdk, codex: this.codex };
  }

  private async ensureClassifierSDK(): Promise<{ sdk: CodexModule; codex: CodexInstance }> {
    const { sdk } = await this.ensureSDK();
    if (!this.classifierCodex) {
      const profile = this.options.profile || 'primary';
      const classifierCodexHome = this.options.classifierCodexHome
        || path.join(CTI_HOME, 'runtime', 'codex-classifier', `codex-home-${profile}`);
      // classifier 与轻聊协调器一样是无工具受限回合，不能用“无 MCP 配置”
      // 重写 Primary official / external Home；两者必须物理隔离。
      const clientOptions = buildCodexClientOptions(profile, [], classifierCodexHome);
      this.classifierCodex = new sdk.Codex({
        ...(clientOptions.apiKey ? { apiKey: clientOptions.apiKey } : {}),
        ...(clientOptions.baseUrl ? { baseUrl: clientOptions.baseUrl } : {}),
        config: {
          ...clientOptions.config,
          // 部分官方/代理模型不接受 minimal；low 仍保持低延迟，且属于通用支持档位。
          model_reasoning_effort: 'low',
          // classifier 不属于项目执行回合，禁止从进程 cwd 自动加载 AGENTS.md。
          // 否则 bridge 运行在大型仓库时，简单 JSON 裁决也会携带整份项目规则。
          project_doc_max_bytes: 0,
          features: CLASSIFIER_DISABLED_FEATURES,
        },
        env: clientOptions.env,
      });
    }
    return { sdk, codex: this.classifierCodex };
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          const tempFiles: string[] = [];
          try {
            const classifierMode = params.interactionMode === 'classifier';
            const responseOnlyMode = params.interactionMode === 'response_only';
            const restrictedMode = classifierMode || responseOnlyMode;
            const { codex } = restrictedMode
              ? await self.ensureClassifierSDK()
              : await self.ensureSDK();

            const profile = self.options.profile || 'primary';
            const executionProfile = resolveExecutionProfile(profile, restrictedMode);
            const inMemoryBinding = self.threadBindings.get(params.sessionId);
            if (params.forceFreshThread) {
              self.threadBindings.delete(params.sessionId);
            }
            const resumeThreads = shouldResumeThreads();
            if (!resumeThreads) {
              self.threadBindings.delete(params.sessionId);
            }
            let threadMode: 'fresh' | 'resumed' | 'fresh_profile_changed' | 'fresh_resume_failed' = 'fresh';
            let savedThreadId: string | undefined;
            if (!restrictedMode && !params.forceFreshThread && resumeThreads) {
              if (inMemoryBinding) {
                if (inMemoryBinding.profileFingerprint === executionProfile.fingerprint) {
                  savedThreadId = inMemoryBinding.threadId;
                  threadMode = 'resumed';
                } else {
                  self.threadBindings.delete(params.sessionId);
                  threadMode = 'fresh_profile_changed';
                }
              } else if (params.sdkSessionId) {
                // 跨 daemon 的旧 thread 已由 bridge fingerprint 清理不兼容配置；剩余 ID 可安全尝试恢复。
                savedThreadId = params.sdkSessionId;
                threadMode = 'resumed';
              }
            }

            const approvalPolicy = restrictedMode ? 'untrusted' : toApprovalPolicy(params.permissionMode);
            const sandboxMode = restrictedMode ? 'read-only' : getSandboxMode();
            const turnPrompt = classifierMode
              ? [
                params.systemPrompt?.trim() ? `Classifier instructions:\n${params.systemPrompt.trim()}` : '',
                `Classifier input:\n${params.prompt.trim()}`,
              ].filter(Boolean).join('\n\n')
              : buildTurnPrompt(params);
            const providerWorkspace = restrictedMode ? null : resolveProviderWorkspace(params);
            const workingDirectory = restrictedMode
              ? undefined
              : providerWorkspace?.source === 'workspace_plan'
                ? providerWorkspace.workingDirectory
                : resolveWorkingDirectory(params.workingDirectory);
            const additionalDirectories = restrictedMode
              ? []
              : providerWorkspace?.source === 'workspace_plan'
                ? providerWorkspace.additionalDirectories
                : normalizeAdditionalDirectories(params.additionalDirectories);
            // 官方 Codex 的 Web Search 是服务端只读能力，不依赖 Desktop Browser
            // helper。仅在正常官方回合开放；受限分类器、外部端点和本地模型继续禁用。
            const webSearchMode = !restrictedMode && executionProfile.modelSource === 'official'
              ? 'live'
              : 'disabled';
            controller.enqueue(sseEvent('status', {
              provider: 'codex',
              codexProfile: profile,
              modelSource: executionProfile.modelSource,
              model: executionProfile.submittedModel,
              baseUrl: executionProfile.baseUrl,
            }));

            const threadOptions: Record<string, unknown> = {
              ...(executionProfile.submittedModel ? { model: executionProfile.submittedModel } : {}),
              ...(workingDirectory ? { workingDirectory } : {}),
              ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
              ...(shouldSkipGitRepoCheck() ? { skipGitRepoCheck: true } : {}),
              approvalPolicy,
              sandboxMode,
              modelReasoningEffort: executionProfile.submittedReasoningEffort,
              webSearchMode,
              ...(restrictedMode ? {
                networkAccessEnabled: false,
                skipGitRepoCheck: true,
              } : {}),
            };

            // Build input: Codex SDK UserInput supports { type: "text" } and
            // { type: "local_image", path: string }. We write base64 data to
            // temp files so the SDK can read them as local images.
            const imageFiles = restrictedMode ? [] : params.files?.filter(
              f => f.type.startsWith('image/')
            ) ?? [];
            const inputEvidenceReceipt = buildProviderInputEvidenceReceipt(imageFiles, 'codex', ['image']);

            let input: string | Array<Record<string, string>>;
            if (imageFiles.length > 0) {
              const parts: Array<Record<string, string>> = [
                { type: 'text', text: turnPrompt },
              ];
              for (const file of imageFiles) {
                const ext = MIME_EXT[file.type] || '.png';
                const tmpPath = path.join(os.tmpdir(), `cti-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
                fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
                tempFiles.push(tmpPath);
                parts.push({ type: 'local_image', path: tmpPath });
              }
              input = parts;
            } else {
              input = turnPrompt;
            }

            let retryFresh = false;

            while (true) {
              let thread: ThreadInstance;
              if (savedThreadId) {
                try {
                  thread = codex.resumeThread(savedThreadId, threadOptions);
                } catch {
                  thread = codex.startThread(threadOptions);
                  savedThreadId = undefined;
                  threadMode = 'fresh_resume_failed';
                }
              } else {
                thread = codex.startThread(threadOptions);
              }

              controller.enqueue(sseEvent('status', {
                provider: 'codex',
                codexProfile: profile,
                modelSource: executionProfile.modelSource,
                model: executionProfile.submittedModel,
                requestedModel: executionProfile.requestedModel,
                submittedModel: executionProfile.submittedModel,
                modelMode: executionProfile.modelMode,
                requestedReasoningEffort: executionProfile.requestedReasoningEffort,
                submittedReasoningEffort: executionProfile.submittedReasoningEffort,
                executionOverrideReason: executionProfile.overrideReason,
                threadMode,
                parameterEvidence: 'sdk_thread_options',
              }));

              let sawAnyEvent = false;
              try {
                const upstreamSignal = params.abortController?.signal;
                const runAbortController = new AbortController();
                const turnStartedAtMs = Date.now();
                let activeThreadId = savedThreadId;
                const seenItemIds = new Set<string>();
                const relayUpstreamAbort = () => runAbortController.abort(upstreamSignal?.reason);
                if (upstreamSignal?.aborted) {
                  relayUpstreamAbort();
                } else {
                  upstreamSignal?.addEventListener('abort', relayUpstreamAbort, { once: true });
                }
                let events: AsyncIterable<any>;
                try {
                  ({ events } = await thread.runStreamed(input, {
                    ...(params.responseSchema ? { outputSchema: params.responseSchema } : {}),
                    signal: runAbortController.signal,
                  }));
                } catch (err) {
                  upstreamSignal?.removeEventListener('abort', relayUpstreamAbort);
                  runAbortController.abort(err);
                  throw err;
                }

                // `thread.started` 只保证在新线程出现；恢复既有线程时 Codex SDK
                // 可能直接返回 turn 事件。图片已经被本轮 runStreamed 接收后就在这里
                // 发出结构化回执，避免复用会话被误判成“模型没有收到附件”。
                if (inputEvidenceReceipt) {
                  controller.enqueue(sseEvent('status', { inputEvidence: inputEvidenceReceipt }));
                }

                let emittedAgentMessage = false;
                let sawCompleteFinalEnvelope = false;
                let sawTurnCompleted = false;
                let streamTerminalError = '';
                let postFinalDrainTriggered = false;
                let finalDrainTimer: ReturnType<typeof setTimeout> | undefined;
                let resolveFinalDrain: (() => void) | undefined;
                let finalDrainPromise: Promise<typeof FINAL_DRAIN_TIMEOUT> | undefined;
                const clearFinalDrain = () => {
                  if (finalDrainTimer) clearTimeout(finalDrainTimer);
                  finalDrainTimer = undefined;
                  finalDrainPromise = undefined;
                  resolveFinalDrain = undefined;
                };
                const invalidateFinalDrain = () => {
                  if (!sawCompleteFinalEnvelope) return;
                  sawCompleteFinalEnvelope = false;
                  clearFinalDrain();
                };
                const armFinalDrain = () => {
                  if (restrictedMode || finalDrainPromise || upstreamSignal?.aborted) return;
                  finalDrainPromise = new Promise<typeof FINAL_DRAIN_TIMEOUT>((resolve) => {
                    resolveFinalDrain = () => resolve(FINAL_DRAIN_TIMEOUT);
                  });
                  finalDrainTimer = setTimeout(() => {
                    if (sawTurnCompleted || upstreamSignal?.aborted) return;
                    postFinalDrainTriggered = true;
                    // 先终止 SDK 子进程，再独立唤醒本地迭代循环；即使 SDK 没有
                    // 因 signal 产出 EOF，也能用已经验证的最终协议正常收口。
                    runAbortController.abort(new Error('Codex final drain timeout'));
                    resolveFinalDrain?.();
                  }, resolveFinalDrainTimeoutMs(self.options.finalDrainTimeoutMs));
                };
                const iterator = events[Symbol.asyncIterator]();
                try {
                  eventLoop: while (true) {
                    const nextEvent = finalDrainPromise
                      ? await Promise.race([iterator.next(), finalDrainPromise])
                      : await iterator.next();
                    if (nextEvent === FINAL_DRAIN_TIMEOUT) {
                      void Promise.resolve(iterator.return?.()).catch(() => undefined);
                      break;
                    }
                    if (nextEvent.done) {
                      if (!sawTurnCompleted && !sawCompleteFinalEnvelope) {
                        streamTerminalError ||= 'Codex SDK stream ended before a verified turn completion.';
                      }
                      break;
                    }
                    const event = nextEvent.value;
                    sawAnyEvent = true;
                    if (upstreamSignal?.aborted) {
                      break;
                    }

                    switch (event.type) {
                    case 'thread.started': {
                      const threadId = event.thread_id as string;
                      activeThreadId = threadId;
                      if (!restrictedMode) {
                        self.threadBindings.set(params.sessionId, {
                          threadId,
                          profileFingerprint: executionProfile.fingerprint,
                        });
                      }

                      controller.enqueue(sseEvent('status', {
                        session_id: threadId,
                      }));
                      break;
                    }

                      case 'item.completed': {
                        const item = event.item as Record<string, unknown>;
                        if (typeof item.id === 'string' && item.id) seenItemIds.add(item.id);
                        // final 之后若又出现任何 completed item，说明它不是实际末尾；
                        // 先撤销旧 watchdog，只有当前 item 自身是新 final 才重新启动。
                        invalidateFinalDrain();
                        if (restrictedMode && CLASSIFIER_FORBIDDEN_ITEM_TYPES.has(String(item.type || ''))) {
                          params.abortController?.abort();
                          throw new Error(`classifier attempted forbidden tool item: ${String(item.type || 'unknown')}`);
                        }
                        const emitted = self.handleCompletedItem(controller, item, emittedAgentMessage);
                        if (emitted) {
                          emittedAgentMessage = true;
                        }
                        if (
                          !restrictedMode
                          && item.type === 'agent_message'
                          && hasCompleteFinalReplyEnvelope(String(item.text || ''))
                        ) {
                          sawCompleteFinalEnvelope = true;
                          armFinalDrain();
                        }
                        break;
                      }

                      case 'item.started':
                      case 'item.updated': {
                        const item = event.item as Record<string, unknown>;
                        invalidateFinalDrain();
                        if (restrictedMode && CLASSIFIER_FORBIDDEN_ITEM_TYPES.has(String(item.type || ''))) {
                          params.abortController?.abort();
                          throw new Error(`classifier attempted forbidden tool item: ${String(item.type || 'unknown')}`);
                        }
                        break;
                      }

                      case 'turn.completed': {
                        sawTurnCompleted = true;
                        clearFinalDrain();
                        const usage = event.usage as Record<string, unknown> | undefined;
                        const threadId = self.threadBindings.get(params.sessionId)?.threadId;

                        controller.enqueue(sseEvent('result', {
                          usage: usage ? {
                            input_tokens: usage.input_tokens ?? 0,
                            output_tokens: usage.output_tokens ?? 0,
                            cache_read_input_tokens: usage.cached_input_tokens ?? 0,
                          } : undefined,
                          ...(threadId ? { session_id: threadId } : {}),
                        }));
                        break;
                      }

                      case 'turn.failed': {
                        sawTurnCompleted = true;
                        clearFinalDrain();
                        const error = (event as { message?: string }).message;
                        controller.enqueue(sseEvent('error', error || 'Turn failed'));
                        void Promise.resolve(iterator.return?.()).catch(() => undefined);
                        break eventLoop;
                      }

                      case 'error': {
                        clearFinalDrain();
                        const error = (event as { message?: string }).message;
                        streamTerminalError = error || 'Thread error';
                        void Promise.resolve(iterator.return?.()).catch(() => undefined);
                        break eventLoop;
                      }

                      // turn.started — no action needed
                    }
                  }
                } catch (err) {
                  if (!(postFinalDrainTriggered && sawCompleteFinalEnvelope && !upstreamSignal?.aborted)) {
                    streamTerminalError = err instanceof Error ? err.message : String(err);
                  }
                } finally {
                  clearFinalDrain();
                  upstreamSignal?.removeEventListener('abort', relayUpstreamAbort);
                }
                if (postFinalDrainTriggered && sawCompleteFinalEnvelope && !upstreamSignal?.aborted) {
                  const threadId = self.threadBindings.get(params.sessionId)?.threadId;
                  console.warn('[codex-provider] Complete final reply was recovered after the SDK drain timeout.');
                  controller.enqueue(sseEvent('result', {
                    ...(threadId ? { session_id: threadId } : {}),
                  }));
                  break;
                }
                if (!sawTurnCompleted) {
                  if (upstreamSignal?.aborted) {
                    runAbortController.abort(upstreamSignal.reason);
                    if (streamTerminalError) throw new Error(streamTerminalError);
                    throw upstreamSignal.reason instanceof Error
                      ? upstreamSignal.reason
                      : new Error('Codex turn was cancelled.');
                  }
                  upstreamSignal?.addEventListener('abort', relayUpstreamAbort, { once: true });
                  let recovered = false;
                  try {
                    recovered = !restrictedMode && !!activeThreadId
                      && await recoverDisconnectedTurn({
                        codexHome: self.options.codexHome || getCodexHomeForProfile(profile),
                        threadId: activeThreadId,
                        turnStartedAtMs,
                        controller,
                        signal: runAbortController.signal,
                        timeoutMs: resolveStreamRecoveryTimeoutMs(self.options.streamRecoveryTimeoutMs),
                        pollMs: resolveStreamRecoveryPollMs(self.options.streamRecoveryPollMs),
                        seenItemIds,
                      });
                  } finally {
                    upstreamSignal?.removeEventListener('abort', relayUpstreamAbort);
                  }
                  if (recovered) {
                    console.warn('[codex-provider] Recovered a disconnected turn from its managed rollout.');
                    break;
                  }
                  // 不能确认同一线程终态时必须先终止底层进程，禁止卡片结束后继续写入。
                  runAbortController.abort(new Error('Codex disconnected turn recovery timed out'));
                  throw new Error(streamTerminalError || 'Codex execution stream disconnected before completion.');
                }
                break;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (savedThreadId && !retryFresh && !sawAnyEvent && shouldRetryFreshThread(message)) {
                  console.warn('[codex-provider] Resume failed, retrying with a fresh thread:', message);
                  savedThreadId = undefined;
                  retryFresh = true;
                  threadMode = 'fresh_resume_failed';
                  continue;
                }
                throw err;
              }
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[codex-provider] Error:', err instanceof Error ? err.stack || err.message : err);
            try {
              controller.enqueue(sseEvent('error', message));
              controller.close();
            } catch {
              // Controller already closed
            }
          } finally {
            // Clean up temp image files
            for (const tmp of tempFiles) {
              try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            }
          }
        })();
      },
    });
  }

  /**
   * Map a completed Codex item to SSE events.
   */
  private handleCompletedItem(
    controller: ReadableStreamDefaultController<string>,
    item: Record<string, unknown>,
    prependAgentMessageSeparator = false,
  ): boolean {
    const itemType = item.type as string;

    switch (itemType) {
      case 'agent_message': {
        const text = (item.text as string) || '';
        if (text) {
          // Official Codex may emit progress and the final envelope as separate completed items.
          // Preserve that message boundary so Markdown fences and JSON do not stick to prior text.
          controller.enqueue(sseEvent('text', `${prependAgentMessageSeparator ? '\n' : ''}${text}`));
          return true;
        }
        break;
      }

      case 'command_execution': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const command = item.command as string || '';
        const output = item.aggregated_output as string || '';
        const exitCode = item.exit_code as number | undefined;
        const isError = exitCode != null && exitCode !== 0;

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: inferCommandExecutionToolName(command),
          input: { command },
        }));

        const resultContent = output || (isError ? `Exit code: ${exitCode}` : 'Done');
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: resultContent,
          is_error: isError,
        }));
        break;
      }

      case 'file_change': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const changes = item.changes as Array<{ path: string; kind: string }> || [];
        const summary = changes.map(c => `${c.kind}: ${c.path}`).join('\n');

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Edit',
          input: { files: changes },
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: summary || 'File changes applied',
          is_error: false,
        }));
        break;
      }

      case 'mcp_tool_call': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const server = item.server as string || '';
        const tool = item.tool as string || '';
        const args = item.arguments as unknown;
        const result = item.result as { content?: unknown; structured_content?: unknown } | undefined;
        const error = item.error as { message?: string } | undefined;

        const resultContent = result?.content ?? result?.structured_content;
        const resultText = typeof resultContent === 'string' ? resultContent : (resultContent ? JSON.stringify(resultContent) : undefined);

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: `mcp__${server}__${tool}`,
          input: args,
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: error?.message || resultText || 'Done',
          is_error: !!error,
        }));
        break;
      }

      case 'web_search': {
        const toolId = (item.id as string) || `web-search-${Date.now()}`;
        const query = (item.query as string) || '';

        // completed web_search 表示服务端检索已结束，搜索结果已回到模型上下文。
        // 只在这里补 Bridge 工具回执，不能把模型声明或“准备搜索”冒充为 evidence。
        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'web_search',
          input: { query },
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: JSON.stringify({ status: 'completed', query }),
          is_error: false,
        }));
        break;
      }

      case 'reasoning': {
        // Reasoning is internal; emit as status
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('status', { reasoning: text }));
        }
        break;
      }
    }

    return false;
  }
}
