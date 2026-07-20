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
import { resolveProviderWorkspace } from './provider-workspace.js';
import { sseEvent } from './sse-utils.js';

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
export type CodexProviderProfile = 'primary' | 'official' | 'external' | 'local_primary';

interface CodexProviderOptions {
  profile?: CodexProviderProfile;
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

/** Whether to forward bridge model to Codex CLI. Default: false (use Codex current/default model). */
function shouldPassModelToCodex(profile: CodexProviderProfile): boolean {
  if (profile === 'local_primary') return true;
  if (profile === 'official') return false;
  return process.env.CTI_CODEX_PASS_MODEL === 'true';
}

function getCodexModelOverride(profile: CodexProviderProfile): string | undefined {
  if (profile === 'local_primary') {
    const model = (process.env.CTI_LOCAL_AI_MODEL || process.env.CTI_OLLAMA_MODEL || 'qwen2.5-coder:7b').trim();
    return model || 'qwen2.5-coder:7b';
  }
  if (profile === 'official') return undefined;
  const model = (process.env.CTI_CODEX_MODEL || '').trim();
  return model || undefined;
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

function normalizeReasoningEffort(value: string | undefined, fallback: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  const raw = (value || fallback).trim().toLowerCase();
  switch (raw) {
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return raw;
    default:
      return fallback;
  }
}

export function getReasoningEffort(profile: CodexProviderProfile): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  return normalizeReasoningEffort(process.env.CTI_CODEX_REASONING_EFFORT, DEFAULT_REASONING_EFFORT);
}

type CodexClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  config: Record<string, unknown> & { model_reasoning_effort: ReturnType<typeof normalizeReasoningEffort> };
  env: Record<string, string>;
};

const CLASSIFIER_DISABLED_FEATURES = {
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
  const shared = SHARED_CODEX_HOME_PATHS.filter((relativePath) => relativePath !== 'skills');
  if (profile === 'local_primary') return shared.filter((relativePath) => relativePath !== 'plugins');
  return shared;
}

function removeLocalCodexPluginState(bridgeHome: string, profile: CodexProviderProfile): void {
  if (profile !== 'local_primary') return;
  for (const relativePath of LOCAL_CODEX_HOME_BLOCKED_PATHS) {
    try {
      fs.rmSync(path.join(bridgeHome, relativePath), { recursive: true, force: true });
    } catch {
      // best effort; local agent must not depend on plugin sync state
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
        || (isolateLocalAgent && (isPluginSection || isMarketplaceSection || isDesktopSection || isMemoriesSection));
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

export function ensureBridgeCodexHome(profile: CodexProviderProfile): string {
  const bridgeHome = profile === 'local_primary'
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
  removeLocalCodexPluginState(bridgeHome, profile);

  syncFileIfNewer(path.join(globalHome, 'auth.json'), path.join(bridgeHome, 'auth.json'));

  for (const relativePath of getSharedCodexHomePaths(profile)) {
    ensureSharedPath(path.join(globalHome, relativePath), path.join(bridgeHome, relativePath));
  }
  ensureFilteredSkillsRoot(globalHome, bridgeHome);

  const globalConfigPath = path.join(globalHome, 'config.toml');
  const bridgeConfigPath = path.join(bridgeHome, 'config.toml');
  const bridgeConfig = fs.existsSync(globalConfigPath)
    ? sanitizeCodexConfig(fs.readFileSync(globalConfigPath, 'utf-8'), reasoningEffort, profile)
    : `model_reasoning_effort = "${reasoningEffort}"\n`;
  fs.writeFileSync(bridgeConfigPath, bridgeConfig, 'utf-8');

  return bridgeHome;
}

function buildCodexClientOptions(profile: CodexProviderProfile = 'primary'): CodexClientOptions & { modelOverride?: string; passModel: boolean; profile: CodexProviderProfile } {
  const localAiKind = (process.env.CTI_LOCAL_AI_KIND || 'ollama').trim().toLowerCase();
  const useLocalApi = profile === 'local_primary';
  const apiKey = useLocalApi
    ? undefined
    : profile === 'official'
      ? undefined
      : (process.env.CTI_CODEX_API_KEY
      || process.env.CODEX_API_KEY
      || process.env.OPENAI_API_KEY
      || undefined);
  const baseUrl = useLocalApi
    ? undefined
    : profile === 'official'
      ? undefined
      : (process.env.CTI_CODEX_BASE_URL || undefined);
  const bridgeCodexHome = ensureBridgeCodexHome(profile);
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
    ...(baseUrl ? { baseUrl } : {}),
    config: {
      model_reasoning_effort: getReasoningEffort(profile),
    },
    env: useLocalApi ? sanitizeLocalApiEnv(env) : env,
    modelOverride: getCodexModelOverride(profile),
    passModel: shouldPassModelToCodex(profile),
    profile,
  };
}

export function buildCodexClientOptionsForTest(profile: CodexProviderProfile = 'primary'): CodexClientOptions & { modelOverride?: string; passModel: boolean; profile: CodexProviderProfile } {
  return buildCodexClientOptions(profile);
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
    '- images and files must be arrays of local paths when applicable, otherwise use empty arrays.',
    '- reply_mode must be one of: plain, markdown, html.',
    '- Optional keys mentions and reply_to may be included when needed.',
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

  /** Maps session IDs to Codex thread IDs for resume. */
  private threadIds = new Map<string, string>();

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

    const clientOptions = buildCodexClientOptions(this.options.profile || 'primary');

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
      const clientOptions = buildCodexClientOptions(this.options.profile || 'primary');
      this.classifierCodex = new sdk.Codex({
        ...(clientOptions.apiKey ? { apiKey: clientOptions.apiKey } : {}),
        ...(clientOptions.baseUrl ? { baseUrl: clientOptions.baseUrl } : {}),
        config: {
          ...clientOptions.config,
          // 部分官方/代理模型不接受 minimal；low 仍保持低延迟，且属于通用支持档位。
          model_reasoning_effort: 'low',
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

            // Resolve or create thread
            const inMemoryThreadId = self.threadIds.get(params.sessionId);
            if (params.forceFreshThread) {
              self.threadIds.delete(params.sessionId);
            }
            const resumeThreads = shouldResumeThreads();
            if (!resumeThreads) {
              self.threadIds.delete(params.sessionId);
            }
            let savedThreadId = (restrictedMode || params.forceFreshThread || !resumeThreads)
              ? undefined
              : (inMemoryThreadId || params.sdkSessionId || undefined);

            const profile = self.options.profile || 'primary';
            const approvalPolicy = restrictedMode ? 'untrusted' : toApprovalPolicy(params.permissionMode);
            const passModel = shouldPassModelToCodex(profile);
            const modelOverride = getCodexModelOverride(profile);
            const sandboxMode = restrictedMode ? 'read-only' : getSandboxMode();
            const turnPrompt = buildTurnPrompt(params);
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
            const localAiKind = (process.env.CTI_LOCAL_AI_KIND || 'ollama').trim().toLowerCase();
            const modelSource = profile === 'local_primary'
              ? 'local_api'
              : profile === 'official'
                ? 'official'
                : profile === 'external'
                  ? 'external_api'
                  : (process.env.CTI_CODEX_MODEL_SOURCE || (process.env.CTI_CODEX_BASE_URL ? 'external_api' : 'official'));
            const baseUrl = profile === 'local_primary'
              ? normalizeLocalFallbackBaseUrl(process.env.CTI_LOCAL_AI_BASE_URL || process.env.CTI_OLLAMA_BASE_URL || 'http://127.0.0.1:11434', localAiKind)
              : profile === 'official'
                ? undefined
                : (process.env.CTI_CODEX_BASE_URL || undefined);

            controller.enqueue(sseEvent('status', {
              provider: 'codex',
              codexProfile: profile,
              modelSource,
              model: modelOverride || (passModel ? params.model : undefined),
              baseUrl,
            }));

            const threadOptions: Record<string, unknown> = {
              ...(modelOverride ? { model: modelOverride } : passModel && params.model ? { model: params.model } : {}),
              ...(workingDirectory ? { workingDirectory } : {}),
              ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
              ...(shouldSkipGitRepoCheck() ? { skipGitRepoCheck: true } : {}),
              approvalPolicy,
              sandboxMode,
              modelReasoningEffort: restrictedMode ? 'low' : getReasoningEffort(self.options.profile || 'primary'),
              ...(restrictedMode ? {
                networkAccessEnabled: false,
                webSearchMode: 'disabled',
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
                }
              } else {
                thread = codex.startThread(threadOptions);
              }

              let sawAnyEvent = false;
              try {
                const { events } = await thread.runStreamed(input, {
                  ...(params.responseSchema ? { outputSchema: params.responseSchema } : {}),
                  ...(params.abortController?.signal ? { signal: params.abortController.signal } : {}),
                });

                for await (const event of events) {
                  sawAnyEvent = true;
                  if (params.abortController?.signal.aborted) {
                    break;
                  }

                  switch (event.type) {
                    case 'thread.started': {
                      const threadId = event.thread_id as string;
                      if (!restrictedMode) self.threadIds.set(params.sessionId, threadId);

                      controller.enqueue(sseEvent('status', {
                        session_id: threadId,
                        ...(inputEvidenceReceipt ? { inputEvidence: inputEvidenceReceipt } : {}),
                      }));
                      break;
                    }

                    case 'item.completed': {
                      const item = event.item as Record<string, unknown>;
                      if (restrictedMode && CLASSIFIER_FORBIDDEN_ITEM_TYPES.has(String(item.type || ''))) {
                        params.abortController?.abort();
                        throw new Error(`classifier attempted forbidden tool item: ${String(item.type || 'unknown')}`);
                      }
                      self.handleCompletedItem(controller, item);
                      break;
                    }

                    case 'item.started':
                    case 'item.updated': {
                      const item = event.item as Record<string, unknown>;
                      if (restrictedMode && CLASSIFIER_FORBIDDEN_ITEM_TYPES.has(String(item.type || ''))) {
                        params.abortController?.abort();
                        throw new Error(`classifier attempted forbidden tool item: ${String(item.type || 'unknown')}`);
                      }
                      break;
                    }

                    case 'turn.completed': {
                      const usage = event.usage as Record<string, unknown> | undefined;
                      const threadId = self.threadIds.get(params.sessionId);

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
                      const error = (event as { message?: string }).message;
                      controller.enqueue(sseEvent('error', error || 'Turn failed'));
                      break;
                    }

                    case 'error': {
                      const error = (event as { message?: string }).message;
                      controller.enqueue(sseEvent('error', error || 'Thread error'));
                      break;
                    }

                    // turn.started — no action needed
                  }
                }
                break;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (savedThreadId && !retryFresh && !sawAnyEvent && shouldRetryFreshThread(message)) {
                  console.warn('[codex-provider] Resume failed, retrying with a fresh thread:', message);
                  savedThreadId = undefined;
                  retryFresh = true;
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
  ): void {
    const itemType = item.type as string;

    switch (itemType) {
      case 'agent_message': {
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('text', text));
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
          name: 'Bash',
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

      case 'reasoning': {
        // Reasoning is internal; emit as status
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('status', { reasoning: text }));
        }
        break;
      }
    }
  }
}
