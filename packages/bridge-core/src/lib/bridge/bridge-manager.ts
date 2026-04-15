/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import type { BridgeStatus, InboundMessage, OutboundMessage, StreamingPreviewState, ToolCallInfo } from './types.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters/index.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { deliver, deliverRendered } from './delivery-layer.js';
import { markdownToTelegramChunks } from './markdown/telegram.js';
import { markdownToDiscordChunks } from './markdown/discord.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';
import {
  splitWorkspacePathList,
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators.js';
import {
  getFeishuDocumentGuideMetaPath,
  getFeishuDocumentGuidePath,
  recordFeishuDocumentMemory,
  renderFeishuDocumentMemoryList,
} from './feishu-document-memory.js';

const GLOBAL_KEY = '__bridge_manager__';
const execFileAsync = promisify(execFile);

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

interface ProgressPulseConfig {
  enabled: boolean;
  intervalMs: number;
}

interface UnityMcpHealthConfig {
  endpoints: string[];
  startCommand: string;
  probeTimeoutMs: number;
  startTimeoutMs: number;
  retryCount: number;
}

function getReplyEndMarker(): string {
  const { store } = getBridgeContext();
  const raw = (store.getSetting('bridge_reply_end_marker') || process.env.CTI_REPLY_END_MARKER || '✅').trim();
  return raw || '✅';
}

function appendReplyEndMarker(text: string): string {
  const marker = getReplyEndMarker();
  const trimmed = text.trimEnd();
  if (!trimmed) return marker;
  if (trimmed.endsWith(marker)) return text;
  return `${trimmed}\n\n${marker}`;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};

const PROGRESS_PULSE_DEFAULTS: ProgressPulseConfig = {
  enabled: false,
  intervalMs: 60000,
};

const UNITY_MCP_DEFAULT_ENDPOINTS = [
  'http://127.0.0.1:8081/mcp',
  'http://127.0.0.1:8080/mcp',
  'http://127.0.0.1:8080',
];

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

function getProgressPulseConfig(): ProgressPulseConfig {
  const { store } = getBridgeContext();
  const enabledRaw = (store.getSetting('bridge_progress_updates_enabled') || '').trim().toLowerCase();
  const enabled = enabledRaw
    ? enabledRaw === '1' || enabledRaw === 'true' || enabledRaw === 'yes' || enabledRaw === 'on'
    : PROGRESS_PULSE_DEFAULTS.enabled;

  const intervalCandidate = parseInt(store.getSetting('bridge_progress_update_interval_ms') || '', 10);
  const intervalMs = Number.isFinite(intervalCandidate) && intervalCandidate >= 8000
    ? intervalCandidate
    : PROGRESS_PULSE_DEFAULTS.intervalMs;

  return { enabled, intervalMs };
}

function parseEndpointList(raw: string | null | undefined): string[] {
  if (!raw) return [...UNITY_MCP_DEFAULT_ENDPOINTS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[,\n;|]/)) {
    const value = token.trim();
    if (!value) continue;
    if (!/^https?:\/\//i.test(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.length > 0 ? out : [...UNITY_MCP_DEFAULT_ENDPOINTS];
}

function getUnityMcpHealthConfig(): UnityMcpHealthConfig {
  const { store } = getBridgeContext();
  const endpointRaw = store.getSetting('bridge_unity_mcp_endpoint_list') || process.env.CTI_UNITY_MCP_ENDPOINTS || '';
  const startCommand = (store.getSetting('bridge_unity_mcp_start_command') || process.env.CTI_UNITY_MCP_START_COMMAND || '').trim();
  const probeTimeoutCandidate = parseInt(store.getSetting('bridge_unity_mcp_probe_timeout_ms') || '', 10);
  const startTimeoutCandidate = parseInt(store.getSetting('bridge_unity_mcp_start_timeout_ms') || '', 10);
  const retryCountCandidate = parseInt(store.getSetting('bridge_unity_mcp_retry_count') || '', 10);
  return {
    endpoints: parseEndpointList(endpointRaw),
    startCommand,
    probeTimeoutMs: Number.isFinite(probeTimeoutCandidate) && probeTimeoutCandidate >= 800 ? probeTimeoutCandidate : 2500,
    startTimeoutMs: Number.isFinite(startTimeoutCandidate) && startTimeoutCandidate >= 5000 ? startTimeoutCandidate : 40000,
    retryCount: Number.isFinite(retryCountCandidate) && retryCountCandidate >= 1 ? Math.min(retryCountCandidate, 6) : 3,
  };
}

async function probeUnityMcpEndpoint(endpoint: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
    });
    return { ok: true, detail: `${endpoint} -> HTTP ${response.status}` };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `${endpoint} -> ${errorMessage}` };
  } finally {
    clearTimeout(timer);
  }
}

async function executeUnityMcpStartCommand(
  command: string,
  workingDirectory: string,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const { store } = getBridgeContext();
  const cwd = workingDirectory && fs.existsSync(workingDirectory) ? workingDirectory : process.cwd();
  const runEnv = {
    ...process.env,
    CTI_DEFAULT_WORKDIR: store.getSetting('bridge_default_work_dir') || process.env.CTI_DEFAULT_WORKDIR || cwd,
    CTI_UNITY_PROJECT_PATH: store.getSetting('bridge_unity_project_path') || process.env.CTI_UNITY_PROJECT_PATH || path.join(cwd, 'Game'),
  };
  try {
    const run = process.platform === 'win32'
      ? await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        cwd,
        env: runEnv,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 4,
      })
      : await execFileAsync('sh', ['-lc', command], {
        cwd,
        env: runEnv,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 4,
      });
    const output = [run.stdout?.trim(), run.stderr?.trim()].filter(Boolean).join('\n');
    const shortOutput = output.length > 400 ? `${output.slice(0, 397)}...` : output;
    return { ok: true, detail: shortOutput ? `start command ok: ${shortOutput}` : 'start command ok' };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = [err.stdout?.trim(), err.stderr?.trim(), err.message?.trim()].filter(Boolean).join('\n');
    const shortOutput = output.length > 400 ? `${output.slice(0, 397)}...` : output;
    return { ok: false, detail: shortOutput || 'start command failed' };
  }
}

async function ensureUnityMcpReady(workingDirectory: string): Promise<{ ok: boolean; summary: string }> {
  const config = getUnityMcpHealthConfig();
  const lines: string[] = [];
  const retryEndpoints = [...config.endpoints];

  for (const endpoint of config.endpoints) {
    const probe = await probeUnityMcpEndpoint(endpoint, config.probeTimeoutMs);
    lines.push(`probe: ${probe.detail}`);
    if (probe.ok) {
      return { ok: true, summary: lines.join('\n') };
    }
  }

  if (!config.startCommand) {
    lines.push('start: skipped (bridge_unity_mcp_start_command 未配置)');
    return { ok: false, summary: lines.join('\n') };
  }

  const startResult = await executeUnityMcpStartCommand(config.startCommand, workingDirectory, config.startTimeoutMs);
  lines.push(`start: ${startResult.detail}`);
  const discoveredFromStart = Array.from(startResult.detail.matchAll(/https?:\/\/[^\s)]+/ig)).map((match) => match[0]);
  for (const endpoint of discoveredFromStart) {
    if (!retryEndpoints.some((item) => item.toLowerCase() === endpoint.toLowerCase())) {
      retryEndpoints.push(endpoint);
    }
  }
  if (startResult.ok && /mcp_ready/i.test(startResult.detail)) {
    return { ok: true, summary: lines.join('\n') };
  }

  for (let attempt = 1; attempt <= config.retryCount; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1600));
    for (const endpoint of retryEndpoints) {
      const probe = await probeUnityMcpEndpoint(endpoint, config.probeTimeoutMs);
      lines.push(`retry#${attempt}: ${probe.detail}`);
      if (probe.ok) {
        return { ok: true, summary: lines.join('\n') };
      }
    }
  }

  return { ok: false, summary: lines.join('\n') };
}

/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * feishu/qq channels WITH at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean {
  if (channelType !== 'feishu' && channelType !== 'qq' && channelType !== 'weixin') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0; // any pending → route to inline path
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

// ── Channel-aware rendering dispatch ──────────────────────────

import type { ChannelAddress, SendResult } from './types.js';

/**
 * Render response text and deliver via the appropriate channel format.
 * Telegram: Markdown → HTML chunks via deliverRendered.
 * Other channels: plain text via deliver (no HTML).
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
): Promise<SendResult> {
  const finalText = appendReplyEndMarker(responseText);
  if (adapter.channelType === 'telegram') {
    const chunks = markdownToTelegramChunks(finalText, 4096);
    if (chunks.length > 0) {
      return deliverRendered(adapter, address, chunks, { sessionId, replyToMessageId });
    }
    return { ok: true };
  }
  if (adapter.channelType === 'discord') {
    // Discord: native markdown, chunk at 2000 chars with fence repair
    const chunks = markdownToDiscordChunks(finalText, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: chunks[i].text,
        parseMode: 'Markdown',
        replyToMessageId,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (adapter.channelType === 'feishu') {
    // Feishu: pass markdown through for adapter to format as post/card
    return deliver(adapter, {
      address,
      text: finalText,
      parseMode: 'Markdown',
      replyToMessageId,
    }, { sessionId });
  }
  // Generic fallback: deliver as plain text (deliver() handles chunking internally)
  return deliver(adapter, {
    address,
    text: finalText,
    parseMode: 'plain',
    replyToMessageId,
  }, { sessionId });
}

interface DirectCommandRequest {
  command: string;
  args: string[];
  display: string;
  mutating: boolean;
}

interface DirectCommandResult {
  ok: boolean;
  text: string;
}

interface ProgressPulseController {
  stop: () => void;
}

function buildProgressMessage(step: 'started' | 'running'): string {
  if (step === 'started') {
    return '已收到，正在处理这条请求。我会分阶段回报进度。';
  }
  return '仍在处理中：正在执行当前步骤，完成后会继续同步结果。';
}

function buildProgressMessageForBridge(step: 'started' | 'running'): string {
  if (step === 'started') {
    return '已收到，开始执行。后续只发送有实际结果的阶段进度。';
  }
  return '仍在执行，但还没有新的可汇报结果。';
}

async function startProgressPulse(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  sessionId: string,
): Promise<ProgressPulseController | null> {
  const config = getProgressPulseConfig();
  if (!config.enabled) return null;
  if (adapter.channelType === 'qq' || adapter.channelType === 'weixin') return null;

  try {
    await deliver(adapter, {
      address: msg.address,
      text: buildProgressMessageForBridge('started'),
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    }, { sessionId });
  } catch {
    return null;
  }

  const timer = setInterval(() => {
    void deliver(adapter, {
      address: msg.address,
      text: buildProgressMessageForBridge('running'),
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    }, { sessionId }).catch(() => {
      // non-critical heartbeat failure
    });
  }, config.intervalMs);

  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

function extractLocalImagePaths(text: string, workingDirectory: string, additionalDirectories: string[] = []): string[] {
  const found = new Set<string>();
  const searchDirectories = Array.from(new Set([workingDirectory, ...additionalDirectories].filter(Boolean)));
  const markdownPathRe = /\[[^\]]+\]\(([^)]+\.(?:png|jpe?g|webp|gif))\)/ig;
  const absolutePathRe = /([A-Za-z]:\\[^\r\n"'<>|?*]+\.(?:png|jpe?g|webp|gif))/ig;
  const filenameRe = /\b([A-Za-z0-9._-]+\.(?:png|jpe?g|webp|gif))\b/ig;

  for (const match of text.matchAll(markdownPathRe)) {
    found.add(match[1]);
  }
  for (const match of text.matchAll(absolutePathRe)) {
    found.add(match[1]);
  }
  for (const match of text.matchAll(filenameRe)) {
    const candidate = match[1];
    if (candidate.includes('\\') || candidate.includes('/')) {
      found.add(candidate);
      continue;
    }
    for (const directory of searchDirectories) {
      found.add(path.join(directory, candidate));
    }
  }

  return Array.from(found)
    .map((candidate) => candidate.replace(/\//g, '\\'))
    .filter((candidate) => {
      if (path.isAbsolute(candidate)) return fs.existsSync(candidate);
      return searchDirectories.some((directory) => fs.existsSync(path.join(directory, candidate)));
    })
    .map((candidate) => {
      if (path.isAbsolute(candidate)) return candidate;
      for (const directory of searchDirectories) {
        const resolved = path.join(directory, candidate);
        if (fs.existsSync(resolved)) return resolved;
      }
      return path.join(workingDirectory, candidate);
    });
}

function collectRecentAssistantImagePaths(
  sessionId: string,
  workingDirectory: string,
  additionalDirectories: string[] = [],
): string[] {
  const { store } = getBridgeContext();
  const recent = store.getMessages(sessionId, { limit: 4 }).messages;
  const found = new Set<string>();

  for (const message of recent) {
    if (message.role !== 'assistant' || !message.content) continue;
    for (const imagePath of extractLocalImagePaths(message.content, workingDirectory, additionalDirectories)) {
      found.add(imagePath);
    }
  }

  return Array.from(found);
}

interface WorkspaceCatalogEntry {
  label: string;
  path: string;
  kind: 'root' | 'project';
}

function getConfiguredWorkspaceRoots(): string[] {
  const { store } = getBridgeContext();
  const configured = splitWorkspacePathList(store.getSetting('bridge_allowed_workspace_roots'));
  if (configured.length > 0) return configured;

  const fallback = store.getSetting('bridge_default_work_dir');
  return fallback ? [fallback] : [];
}

function getSt3WorkspaceRoot(): string {
  const { store } = getBridgeContext();
  return path.normalize(
    store.getSetting('bridge_st3_workspace_root')
      || store.getSetting('bridge_default_work_dir')
      || process.env.CTI_DEFAULT_WORKDIR
      || 'C:\\unity\\ST3',
  );
}

function getSt3UnityProjectPath(): string {
  const { store } = getBridgeContext();
  return path.normalize(
    store.getSetting('bridge_unity_project_path')
      || process.env.CTI_UNITY_PROJECT_PATH
      || path.join(getSt3WorkspaceRoot(), 'Game'),
  );
}

function getConfiguredAdditionalDirectories(): string[] {
  const { store } = getBridgeContext();
  return splitWorkspacePathList(store.getSetting('bridge_default_additional_directories'));
}

function getAccessibleWorkspaceDirectories(primaryWorkingDirectory: string): string[] {
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const candidate of [primaryWorkingDirectory, ...getConfiguredAdditionalDirectories()]) {
    const validated = validateWorkingDirectory(candidate, getConfiguredWorkspaceRoots());
    if (!validated) continue;
    const dedupeKey = path.resolve(validated).toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    directories.push(validated);
  }
  return directories;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listWorkspaceCatalog(): WorkspaceCatalogEntry[] {
  const seenPaths = new Set<string>();
  const entries: WorkspaceCatalogEntry[] = [];

  const pushEntry = (label: string, targetPath: string, kind: 'root' | 'project') => {
    const dedupeKey = path.resolve(targetPath).toLowerCase();
    if (seenPaths.has(dedupeKey)) return;
    seenPaths.add(dedupeKey);
    entries.push({ label, path: targetPath, kind });
  };

  for (const root of getConfiguredWorkspaceRoots()) {
    if (!fs.existsSync(root)) continue;
    pushEntry(path.basename(root), root, 'root');

    try {
      const children = fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        pushEntry(child.name, path.join(root, child.name), 'project');
      }
    } catch {
      // Ignore unreadable roots; they simply won't be listed/resolved by name.
    }
  }

  return entries;
}

function resolveWorkspaceArgument(rawTarget: string): { path?: string; matches?: string[]; error?: string } {
  const allowedRoots = getConfiguredWorkspaceRoots();
  const trimmed = rawTarget.trim().replace(/^["']|["']$/g, '').trim();
  if (!trimmed) return { error: 'empty' };

  const absolute = validateWorkingDirectory(trimmed, allowedRoots);
  if (absolute) {
    if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
      return { path: absolute };
    }
    return { error: 'not_found' };
  }

  if (path.isAbsolute(trimmed)) {
    return { error: 'not_allowed' };
  }

  const catalog = listWorkspaceCatalog();
  const normalizedTarget = trimmed.toLowerCase();
  const matchedPaths = Array.from(new Set(
    catalog
      .filter((entry) => entry.label.toLowerCase() === normalizedTarget)
      .map((entry) => entry.path)
  ));

  for (const root of allowedRoots) {
    const candidate = validateWorkingDirectory(path.join(root, trimmed), allowedRoots);
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        matchedPaths.push(candidate);
      }
    } catch {
      // Ignore unreadable paths here and continue searching.
    }
  }

  const uniqueMatches = Array.from(new Set(matchedPaths.map((entry) => path.resolve(entry))));
  if (uniqueMatches.length === 1) {
    return { path: uniqueMatches[0] };
  }
  if (uniqueMatches.length > 1) {
    return { error: 'ambiguous', matches: uniqueMatches.sort() };
  }
  return { error: 'not_found' };
}

function resolveWorkspaceArgumentForMessage(
  rawTarget: string,
  msg: InboundMessage,
): { path?: string; matches?: string[]; error?: string } {
  const resolved = resolveWorkspaceArgument(rawTarget);
  if (resolved.path || resolved.error !== 'not_allowed' || !isOwnerMessage(msg)) {
    return resolved;
  }

  const normalized = validateWorkingDirectory(rawTarget.trim().replace(/^["']|["']$/g, '').trim(), []);
  if (normalized && fs.existsSync(normalized) && fs.statSync(normalized).isDirectory()) {
    return { path: normalized };
  }
  return resolved;
}

function detectWorkspaceOverrideFromText(text: string, allowOwnerOverride = false): string | null {
  const absoluteMatches = text.match(/[A-Za-z]:\\[^\s"'<>|?*]+/g) || [];
  for (const candidate of absoluteMatches) {
    const resolved = resolveWorkspaceArgument(candidate);
    if (resolved.path) return resolved.path;
    if (allowOwnerOverride) {
      const normalized = validateWorkingDirectory(candidate, []);
      if (normalized && fs.existsSync(normalized) && fs.statSync(normalized).isDirectory()) {
        return normalized;
      }
    }
  }

  const catalog = listWorkspaceCatalog();
  const lowerText = text.toLowerCase();
  const matched = new Set<string>();

  for (const entry of catalog) {
    const label = entry.label.trim();
    if (!label || label.length < 3) continue;
    const escaped = escapeRegex(label.toLowerCase());
    const patterns = [
      new RegExp(`(^|\\s)${escaped}(?=\\s+(git|npm|pnpm|yarn)\\b)`),
      new RegExp(`(在|到|切到|切换到|进入|使用|针对|绑定到)\\s*${escaped}(\\s|$)`),
      new RegExp(`${escaped}\\s*(工程|项目|仓库|目录)`),
    ];
    if (patterns.some((pattern) => pattern.test(lowerText))) {
      matched.add(entry.path);
    }
  }

  return matched.size === 1 ? Array.from(matched)[0] : null;
}

function renderWorkspaceSummaryLines(): string[] {
  const roots = getConfiguredWorkspaceRoots();
  const lines = ['<b>Available Workspaces</b>', ''];
  if (roots.length === 0) {
    lines.push('No workspace roots configured.');
    return lines;
  }

  const byRoot = new Map<string, string[]>();
  for (const root of roots) {
    byRoot.set(root, []);
  }

  for (const entry of listWorkspaceCatalog()) {
    if (entry.kind !== 'project') continue;
    const parent = path.dirname(entry.path);
    const projects = byRoot.get(parent);
    if (projects) {
      projects.push(entry.label);
    }
  }

  for (const root of roots) {
    const projects = (byRoot.get(root) || []).slice(0, 12);
    lines.push(`<code>${escapeHtml(root)}</code>`);
    if (projects.length > 0) {
      lines.push(`Projects: ${escapeHtml(projects.join(', '))}`);
    }
  }

  const additionalDirectories = getConfiguredAdditionalDirectories();
  if (additionalDirectories.length > 0) {
    lines.push('');
    lines.push(`Additional directories: <code>${escapeHtml(additionalDirectories.join(' | '))}</code>`);
  }

  return lines;
}

function isFeishuDocGenerationRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  const mentionsDoc = /(飞书文档|文档链接|回链接|发链接|在线文档)/.test(normalized);
  const asksToGenerate = /(生成|整理成|做成|输出成|输出到|保存成|创建)/.test(normalized);
  return mentionsDoc && asksToGenerate;
}

function isFeishuDocGenerationRequestStrict(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  const mentionsDoc = /(飞书文档|云文档|文档链接|在线文档|docx|document)/i.test(normalized);
  const asksToGenerate = /(生成|整理成|做成|输出到|保存|创建|重写|更新|修改|生成.*链接|回链接)/.test(normalized);
  return mentionsDoc && asksToGenerate;
}

function isFeishuDocumentListRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  return /(有哪些文档|文档有哪些|文档列表|生成过什么文档|之前.*文档|导览文档|文档导览|list.*docs|docs.*list)/i.test(normalized);
}

function parseDirectCommandRequest(text: string): DirectCommandRequest | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();
  if (!lower) return null;

  if (/\bgit pull --ff-only\b/.test(lower)) {
    return { command: 'git', args: ['pull', '--ff-only'], display: 'git pull --ff-only', mutating: true };
  }
  if (/\bgit pull\b/.test(lower)) {
    return { command: 'git', args: ['pull'], display: 'git pull', mutating: true };
  }
  if (/\bgit status -sb\b/.test(lower)) {
    return { command: 'git', args: ['status', '-sb'], display: 'git status -sb', mutating: false };
  }
  if (/\bgit status\b/.test(lower)) {
    return { command: 'git', args: ['status'], display: 'git status', mutating: false };
  }

  return null;
}

function formatDirectCommandResult(request: DirectCommandRequest, stdout: string, stderr: string): DirectCommandResult {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
  const text = combined || '(无输出)';
  return {
    ok: true,
    text: `${request.display} 执行成功。\n\n\`\`\`text\n${text}\n\`\`\``,
  };
}

function formatDirectCommandError(request: DirectCommandRequest, stdout: string, stderr: string, errorMessage: string): DirectCommandResult {
  const combined = [stderr.trim(), stdout.trim(), errorMessage.trim()].filter(Boolean).join('\n');
  const text = combined || '命令执行失败';
  return {
    ok: false,
    text: `${request.display} 失败。\n\n\`\`\`text\n${text}\n\`\`\``,
  };
}

async function executeDirectCommand(request: DirectCommandRequest, workingDirectory: string): Promise<DirectCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(request.command, request.args, {
      cwd: workingDirectory,
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 4,
    });
    return formatDirectCommandResult(request, stdout, stderr);
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return formatDirectCommandError(request, err.stdout || '', err.stderr || '', err.message || String(error));
  }
}

function shouldForceFreshThreadBeforeExecution(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  return /\b(git\s+(pull|status|fetch|rebase|merge|checkout|switch)|npm\s+(install|run)|pnpm\s+(install|run|add)|yarn\s+(install|add)|执行|运行|直接拉取|拉取到最新|先执行|马上执行)\b/i.test(normalized);
}

function shouldUseExecutionFirstPrompt(text: string): boolean {
  return shouldForceFreshThreadBeforeExecution(text);
}

function buildExecutionFirstPrompt(text: string): string {
  return [
    '你现在处于执行优先模式。',
    '规则：',
    '1. 对用户要求的命令先执行，再回复。',
    '2. 回复必须基于真实执行结果，不要编造权限限制、沙箱限制或预判失败。',
    '3. 不要输出“我先检查”“我准备”“我判断”“我再看看”这类过程描述。',
    '4. 如果命令成功，直接简要汇报结果。',
    '5. 如果命令失败，直接给出真实错误和下一步处理建议。',
    '6. 除非用户明确要求，不要把问题改写成让用户自己在本机执行。',
    '',
    `用户请求：${text}`,
  ].join('\n');
}

function shouldUseUnityQuickActionFastPath(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const hasUnityCue = /(unity|mcp|scene|inspector|hierarchy|gameobject|menuitem|editor window|unity editor|场景|层级|检查器|菜单|按钮|预览工具|解锁预览工具|全显|医院模拟|截图|选中|聚焦)/i.test(normalized);
  if (!hasUnityCue) return false;

  const hasActionCue = /(打开|点击|点开|调用|触发|执行|切换|显示|隐藏|全显|解锁|截图|选中|聚焦|定位|刷新|重试|直接)/i.test(normalized);
  if (!hasActionCue) return false;

  const looksAnalytical = /(分析|为什么|原因|诊断|排查|检查逻辑|看看脚本|看代码|搜一下|总结一下|解释一下)/i.test(normalized);
  return !looksAnalytical;
}

function extractUnityMenuPath(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const explicitMatch = normalized.match(/\b[A-Za-z0-9_\-.]+(?:\/[A-Za-z0-9_\-.一-龥（）()]+){2,}\b/);
  if (explicitMatch) {
    return explicitMatch[0];
  }

  return null;
}

function shouldUseUnityMenuActionFastPath(text: string): boolean {
  return !!extractUnityMenuPath(text) && shouldUseUnityQuickActionFastPath(text);
}

function shouldForceFreshThreadForFastPath(text: string): boolean {
  return shouldForceFreshThreadBeforeExecution(text) || shouldUseUnityQuickActionFastPath(text);
}

function buildExecutionFirstSystemInstructions(): string {
  return [
    'Execution-first mode:',
    '1. Execute the requested command first, then answer.',
    '2. Base the answer only on the real execution result.',
    '3. Do not output process narration like "我先检查/我再看看/我准备".',
    '4. If it fails, give the real error and one concrete next step.',
    '5. Do not rewrite the task into "please run this locally" unless execution is actually impossible.',
  ].join('\n');
}

function buildUnityQuickActionSystemInstructions(): string {
  return [
    'Unity quick-action mode:',
    '1. This is a simple Unity Editor action request. Prefer the most direct Unity MCP/editor action first.',
    '2. Mandatory attempt rule: before saying unavailable, execute at least one concrete attempt and show its result (Unity MCP tool call result OR launcher shell command output).',
    '3. If an existing Unity editor tool/menu/window already exists, use it directly. Do not create temporary scripts, temporary menu items, or project helper code unless the user explicitly asks for code changes.',
    '4. Do not begin with broad project search, repo-wide grep, long script archaeology, or log spelunking.',
    '5. First try one direct action path: menu invocation, window action, scene-object operation, or screenshot confirmation.',
    '6. If direct Unity MCP tools are missing, run one bootstrap attempt for Unity MCP connection/startup and report exact command + error.',
    '7. If MCP/bootstrap still cannot perform the operation, fall back to Codex CLI/local desktop automation to simulate the required Unity UI click or keyboard path when it is safe and the target is unambiguous.',
    '8. UI clicking is the final fallback only after MCP/editor invocation is unavailable or failed; do not skip directly to screenshots or refusal.',
    '9. For screenshot requests, the requested source is binding: if the user specifies a scene, camera, Game view, or PreviewCamera, do not substitute a Scene View/window crop as success. If exact capture fails, keep repairing via MCP/CLI/UI automation or report the exact failure.',
    '10. After any screenshot capture, verify the actual image content before declaring success. If the image is blank, black, transparent, mostly one color, or clearly the wrong viewport/camera, treat it as failure and continue repair.',
    '11. For a requested camera such as PreviewCamera, success requires: requested scene loaded, target camera found/enabled, output rendered from that camera or Game view, and non-blank image verified.',
    '12. Send progress only when a real checkpoint is completed (for example: MCP connected, scene loaded, target camera found, screenshot saved and verified). Do not send repeated empty "still working" messages.',
    '13. If that direct path fails, do at most one narrow fallback to locate the exact menu/script/window.',
    '14. Keep the reply short and result-first. Do not narrate a long step-by-step thought chain.',
  ].join('\n');
}

function buildUnityMenuActionSystemInstructions(menuPath: string): string {
  return [
    'Unity menu-action mode:',
    `1. The user already provided an explicit Unity menu path: ${menuPath}`,
    '2. First action should be invoking that exact existing menu entry through Unity MCP/editor tooling.',
    '3. Do not search the whole project before trying the exact menu path.',
    '4. Do not create temporary scripts, temporary menu items, or helper code.',
    '5. If the menu opens an existing window/tool, continue using that existing editor tool.',
    '6. Only if the exact menu invocation fails should you do one narrow fallback to confirm the menu path or the existing window entry.',
    '7. If MCP cannot invoke the menu/window, use Codex CLI/local desktop automation to simulate the existing Unity UI click path when it is safe and unambiguous.',
    '8. UI clicking is only the final fallback when direct menu invocation is unavailable.',
    '9. If the user requested an exact camera/source screenshot, never mark a different viewport crop as completed.',
    '10. Verify captured screenshot content is non-blank and from the requested source before reporting success.',
  ].join('\n');
}

function buildUnityScreenshotPolicyInstructions(text: string): string {
  const wantsOverview = /(全览图|横屏|整体布局|全景|overview|panorama|landscape|16:9)/i.test(text);
  const defaultProjectPath = getSt3UnityProjectPath();
  return [
    'ST3 screenshot policy:',
    `1. Default Unity project path is ${defaultProjectPath}. Use it unless the owner explicitly names another project path.`,
    wantsOverview
      ? '2. The user requested an overview/landscape shot. Use a landscape 16:9 capture and adjust the camera/viewpoint to show the whole requested scene.'
      : '2. The user did not explicitly request an overview. Prefer Game view or the requested camera in portrait orientation.',
    '3. If the request names PreviewCamera, Game view, or a scene camera, that source is binding. A Scene View crop or random editor viewport is not a valid success.',
    '4. For Timeline scenes, set the PlayableDirector to the requested time, default to time=0 for first frame, call Evaluate(), then render the camera.',
    '5. Verify the screenshot is not blank, not mostly one color, and has the requested orientation before reporting completion.',
  ].join('\n');
}

function getFastPathOptions(text: string): { extraSystemPrompt?: string; historyLimit?: number } {
  const screenshotPolicy = /(截图|截一张|拍一下|预览图|全览图|横屏|竖屏|screenshot|capture|overview|previewcamera)/i.test(text)
    ? buildUnityScreenshotPolicyInstructions(text)
    : '';
  const menuPath = extractUnityMenuPath(text);
  if (menuPath && shouldUseUnityMenuActionFastPath(text)) {
    return {
      extraSystemPrompt: [
        buildUnityQuickActionSystemInstructions(),
        buildUnityMenuActionSystemInstructions(menuPath),
        screenshotPolicy,
      ].join('\n\n'),
      historyLimit: 6,
    };
  }

  if (shouldUseUnityQuickActionFastPath(text)) {
    return {
      extraSystemPrompt: [buildUnityQuickActionSystemInstructions(), screenshotPolicy].filter(Boolean).join('\n\n'),
      historyLimit: 8,
    };
  }

  if (shouldUseExecutionFirstPrompt(text)) {
    return {
      extraSystemPrompt: buildExecutionFirstSystemInstructions(),
      historyLimit: 12,
    };
  }

  return {};
}

function extractAssistantMarkdown(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('[')) {
    try {
      const blocks = JSON.parse(trimmed) as Array<{ type?: string; text?: string; content?: string }>;
      if (Array.isArray(blocks)) {
        return blocks
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text!.trim())
          .filter(Boolean)
          .join('\n\n')
          .trim();
      }
    } catch {
      // Fall through to raw content
    }
  }

  return trimmed;
}

function buildFeishuDocTitleFromSession(now = new Date()): string {
  const timeLabel = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now).replace(/[/:]/g, '-');
  return `Document Draft ${timeLabel}`;
}

function isGenericFeishuDocumentTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return /^(群聊总结|最近消息|会话整理|聊天记录|原始记录|document draft)/i.test(normalized)
    || /^(group chat summary|recent messages|conversation cleanup)/i.test(normalized);
}

function buildFeishuDocumentRewritePrompt(sourceMarkdown: string, userRequest: string): string {
  return [
    '请把下面的材料整理成一份适合直接写入飞书文档的 Markdown 正文。',
    '',
    '硬性要求：',
    '1. 第一行必须是有内容含义的一级标题，不要写“聊天记录”“原始记录”“以下是”“群聊总结”“最近消息”等流水账标题，也不要用时间戳当标题。',
    '2. 文档默认使用这些结构：结论摘要、关键事实、执行结果、问题与风险、后续待办。',
    '3. 如果材料来自群聊或执行日志，要提炼结论，不要按时间顺序逐条复述聊天记录。',
    '4. 如果材料里包含失败/空白截图/替代方案，必须在“问题与风险”里明确写出来，不要包装成成功。',
    '5. 如果是 Unity 场景类文档，需要附录时优先附“场景位置”，不要附截图文件路径清单，除非用户明确要求截图路径。',
    '6. 只输出文档正文，不要输出说明、客套话、代码块围栏或“已生成文档”。',
    '',
    `用户当前请求：${userRequest}`,
    '',
    '=== 待整理材料开始 ===',
    sourceMarkdown.trim(),
    '=== 待整理材料结束 ===',
  ].join('\n');
}

function parseIdList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n;|]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getConfiguredOwnerIds(channelType: string): string[] {
  const { store } = getBridgeContext();
  if (channelType !== 'feishu') return [];
  const explicit = parseIdList(store.getSetting('bridge_feishu_owner_users'));
  if (explicit.length > 0) return explicit;
  const allowed = parseIdList(store.getSetting('bridge_feishu_allowed_users'));
  return allowed.length === 1 ? allowed : [];
}

function isOwnerMessage(msg: InboundMessage): boolean {
  const owners = getConfiguredOwnerIds(msg.address.channelType);
  if (owners.length === 0) return false;
  const userId = msg.address.userId?.trim();
  return !!userId && owners.includes(userId);
}

function buildOwnerRequiredMessage(msg: InboundMessage): string {
  const userId = msg.address.userId || '(unknown)';
  return [
    '这类操作只允许飞书 owner 本人发起或批准。',
    `当前发送者 ID：${userId}`,
    '如果这是你的账号，请把这个 ID 加到 CTI_FEISHU_OWNER_USERS 后重启桥接。',
  ].join('\n');
}

function isDangerousUserRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  return /(删除|删掉|永久删除|物理删除|清空|删库|重置会话|清会话|清记忆|修改代码|改代码|写代码|提交|commit|push|pull|rebase|merge|checkout|switch|npm install|pnpm install|yarn add|rm -rf|del \/s|remove-item|icacls|takeown|chmod|chown|delete|drop database|truncate)/i.test(normalized);
}

async function syncFeishuDocumentGuideBestEffort(
  adapter: BaseChannelAdapter,
  store: ReturnType<typeof getBridgeContext>['store'],
  ownerUserId?: string,
): Promise<{ title: string; url: string } | null> {
  const guidePath = getFeishuDocumentGuidePath(store);
  if (!fs.existsSync(guidePath)) return null;
  const markdown = fs.readFileSync(guidePath, 'utf-8').trim();
  if (!markdown) return null;

  const metaPath = getFeishuDocumentGuideMetaPath(store);
  let meta: { documentId?: string; url?: string; title?: string } = {};
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as typeof meta;
  } catch {
    // First guide sync; no local meta yet.
  }

  const configuredGuideId = store.getSetting('bridge_feishu_document_guide_doc_id') || '';
  const guideDocumentId = configuredGuideId || meta.documentId || '';
  const replaceDoc = (adapter as BaseChannelAdapter & {
    replaceDocumentFromMarkdown?: (documentId: string, markdown: string, options?: { title?: string; ownerUserId?: string }) => Promise<{ documentId?: string; title: string; url: string }>;
  }).replaceDocumentFromMarkdown;
  const createDoc = (adapter as BaseChannelAdapter & {
    createDocumentFromMarkdown?: (markdown: string, options?: { title?: string; ownerUserId?: string }) => Promise<{ documentId?: string; title: string; url: string }>;
  }).createDocumentFromMarkdown;

  try {
    let guideInfo: { documentId?: string; title: string; url: string } | null = null;
    if (guideDocumentId && typeof replaceDoc === 'function') {
      guideInfo = await replaceDoc.call(adapter, guideDocumentId, markdown, {
        title: '飞书文档导览',
        ownerUserId,
      });
    } else if (!guideDocumentId && typeof createDoc === 'function') {
      guideInfo = await createDoc.call(adapter, markdown, {
        title: '飞书文档导览',
        ownerUserId,
      });
    }

    if (!guideInfo) return null;
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(`${metaPath}.tmp`, JSON.stringify({
      documentId: guideInfo.documentId || guideDocumentId,
      title: guideInfo.title,
      url: guideInfo.url,
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf-8');
    fs.renameSync(`${metaPath}.tmp`, metaPath);
    return { title: guideInfo.title, url: guideInfo.url };
  } catch (err) {
    console.warn('[bridge-manager] Failed to sync Feishu document guide:', err instanceof Error ? err.message : err);
    return null;
  }
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  autoStartChecked: boolean;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      sessionLocks: new Map(),
      autoStartChecked: false,
    };
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  return g[GLOBAL_KEY];
}

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  state.sessionLocks.set(sessionId, current);
  // Cleanup when the chain completes.
  // Suppress rejection on the cleanup chain — callers handle errors on `current` directly.
  current.finally(() => {
    if (state.sessionLocks.get(sessionId) === current) {
      state.sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  // Iterate all registered adapter types and create those that are enabled
  for (const channelType of getRegisteredTypes()) {
    const settingKey = `bridge_${channelType}_enabled`;
    if (store.getSetting(settingKey) !== 'true') continue;

    const adapter = createAdapter(channelType);
    if (!adapter) continue;

    const configError = adapter.validateConfig();
    if (!configError) {
      registerAdapter(adapter);
    } else {
      console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
    }
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., suppress competing polling)
  lifecycle.onBridgeStart?.();

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
    }
  }

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  const { lifecycle } = getBridgeContext();

  state.running = false;

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  // Stop all adapters
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${type}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
    }
  }

  state.adapters.clear();
  state.adapterMeta.clear();
  state.startedAt = null;

  // Notify host that bridge stopped
  lifecycle.onBridgeStop?.();

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.channelType, adapter);
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries, commands, and numeric permission shortcuts are
        // lightweight — process inline (outside session lock).
        // Regular messages use per-session locking for concurrency.
        //
        // IMPORTANT: numeric shortcuts (1/2/3) for feishu/qq MUST run outside
        // the session lock. The current session is blocked waiting for the
        // permission to be resolved; if "1" enters the session lock queue it
        // deadlocks (permission waits for "1", "1" waits for lock release).
        if (
          msg.callbackData ||
          msg.text.trim().startsWith('/') ||
          isNumericPermissionShortcut(adapter.channelType, msg.text.trim(), msg.address.chatId)
        ) {
          await handleMessage(adapter, msg);
        } else {
          const binding = router.resolve(msg.address);
          // Fire-and-forget into session lock — loop continues to accept
          // messages for other sessions immediately.
          processWithSessionLock(binding.codepilotSessionId, () =>
            handleMessage(adapter, msg),
          ).catch(err => {
            console.error(`[bridge-manager] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
    }
  });
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const { store } = getBridgeContext();
  const rawData = msg.raw as {
    imageDownloadFailed?: boolean;
    attachmentDownloadFailed?: boolean;
    failedCount?: number;
    failedLabel?: string;
    userVisibleError?: string;
    feishuDocRequest?: {
      title: string;
      scopeText: string;
    };
    feishuSender?: {
      openId?: string;
      userId?: string;
      unionId?: string;
      chatType?: string;
    };
  } | undefined;

  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries (permission buttons)
  if (msg.callbackData) {
    if (adapter.channelType === 'feishu' && !isOwnerMessage(msg)) {
      await deliver(adapter, {
        address: msg.address,
        text: buildOwnerRequiredMessage(msg),
        parseMode: 'plain',
        replyToMessageId: msg.callbackMessageId,
      });
      ack();
      return;
    }
    const handled = broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId);
    if (handled) {
      // Send confirmation
      const confirmMsg: OutboundMessage = {
        address: msg.address,
        text: 'Permission response recorded.',
        parseMode: 'plain',
      };
      await deliver(adapter, confirmMsg);
    }
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  // Handle attachment-only download failures — surface error to user instead of silently dropping
  if (!rawText && !hasAttachments) {
    if (rawData?.userVisibleError) {
      await deliver(adapter, {
        address: msg.address,
        text: rawData.userVisibleError,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    } else if (rawData?.imageDownloadFailed || rawData?.attachmentDownloadFailed) {
      const failureLabel = rawData.failedLabel || (rawData.imageDownloadFailed ? 'image(s)' : 'attachment(s)');
      await deliver(adapter, {
        address: msg.address,
        text: `Failed to download ${rawData.failedCount ?? 1} ${failureLabel}. Please try sending again.`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // ── Numeric shortcut for permission replies (feishu/qq/weixin only) ──
  // On mobile, typing `/perm allow <uuid>` is painful.
  // If the user sends "1", "2", or "3" and there is exactly one pending
  // permission for this chat, map it: 1→allow, 2→allow_session, 3→deny.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (
    adapter.channelType === 'feishu'
    || adapter.channelType === 'qq'
    || adapter.channelType === 'weixin'
  ) {
    // eslint-disable-next-line no-control-regex
    const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (/^[123]$/.test(normalized)) {
      const pendingLinks = store.listPendingPermissionLinksByChat(msg.address.chatId);
      if (pendingLinks.length === 1) {
        if (adapter.channelType === 'feishu' && !isOwnerMessage(msg)) {
          await deliver(adapter, {
            address: msg.address,
            text: buildOwnerRequiredMessage(msg),
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
          ack();
          return;
        }
        const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
        const action = actionMap[normalized];
        const permId = pendingLinks[0].permissionRequestId;
        const callbackData = `perm:${action}:${permId}`;
        const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
        const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
        if (handled) {
          await deliver(adapter, {
            address: msg.address,
            text: `${label}: recorded.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        } else {
          await deliver(adapter, {
            address: msg.address,
            text: `Permission not found or already resolved.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        }
        ack();
        return;
      }
      if (pendingLinks.length > 1) {
        // Multiple pending permissions — numeric shortcut is ambiguous.
        await deliver(adapter, {
          address: msg.address,
          text: `Multiple pending permissions (${pendingLinks.length}). Please use the full command:\n/perm allow|allow_session|deny <id>`,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        });
        ack();
        return;
      }
      // pendingLinks.length === 0: no pending permissions, fall through as normal message
    } else if (rawText !== normalized && /^[123]$/.test(rawText) === false) {
      // Log when normalization changed the text — helps diagnose encoding issues
      const codePoints = [...rawText].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      console.log(`[bridge-manager] Shortcut candidate raw codepoints: ${codePoints.join(' ')} → normalized: "${normalized}"`);
    }
  }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (rawText.startsWith('/')) {
    await handleCommand(adapter, msg, rawText);
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  // Regular message — route to conversation engine
  if (adapter.channelType === 'feishu' && isFeishuDocumentListRequest(rawText)) {
    await deliver(adapter, {
      address: msg.address,
      text: renderFeishuDocumentMemoryList(store),
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    ack();
    return;
  }

  if (adapter.channelType === 'feishu' && isDangerousUserRequest(rawText) && !isOwnerMessage(msg)) {
    await deliver(adapter, {
      address: msg.address,
      text: buildOwnerRequiredMessage(msg),
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    ack();
    return;
  }

  const binding = router.resolve(msg.address);
  const turnWorkspaceOverride = detectWorkspaceOverrideFromText(rawText, isOwnerMessage(msg));
  if (turnWorkspaceOverride && turnWorkspaceOverride !== binding.workingDirectory && adapter.channelType === 'feishu' && !isOwnerMessage(msg)) {
    await deliver(adapter, {
      address: msg.address,
      text: buildOwnerRequiredMessage(msg),
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    ack();
    return;
  }
  const effectiveBinding = turnWorkspaceOverride && turnWorkspaceOverride !== binding.workingDirectory
    ? { ...binding, workingDirectory: turnWorkspaceOverride, sdkSessionId: '' }
    : binding;
  const usesTransientWorkspaceOverride = effectiveBinding.workingDirectory !== binding.workingDirectory;
  const accessibleWorkspaceDirectories = getAccessibleWorkspaceDirectories(
    effectiveBinding.workingDirectory || store.getSession(effectiveBinding.codepilotSessionId)?.working_directory || '',
  );
  if (effectiveBinding.id && effectiveBinding.sdkSessionId && shouldForceFreshThreadForFastPath(rawText)) {
    try {
      store.updateChannelBinding(effectiveBinding.id, { sdkSessionId: '' });
      effectiveBinding.sdkSessionId = '';
    } catch {
      // best effort
    }
  }
  const directFeishuDocRequest =
    adapter.channelType === 'feishu'
    && (isFeishuDocGenerationRequest(rawText) || isFeishuDocGenerationRequestStrict(rawText))
    && !rawData?.feishuDocRequest;
  const directCommandRequest = parseDirectCommandRequest(rawText);

  if (directCommandRequest) {
    if (adapter.channelType === 'feishu' && directCommandRequest.mutating && !isOwnerMessage(msg)) {
      await deliver(adapter, {
        address: msg.address,
        text: buildOwnerRequiredMessage(msg),
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
      ack();
      return;
    }
    const workingDirectory = effectiveBinding.workingDirectory || store.getSession(effectiveBinding.codepilotSessionId)?.working_directory || '';
    const result = await executeDirectCommand(directCommandRequest, workingDirectory);
    store.addMessage(effectiveBinding.codepilotSessionId, 'user', rawText);
    store.addMessage(effectiveBinding.codepilotSessionId, 'assistant', result.text);
    if (effectiveBinding.id) {
      try {
        store.updateChannelBinding(effectiveBinding.id, { sdkSessionId: '' });
      } catch {
        // best effort
      }
    }
    await deliverResponse(adapter, msg.address, result.text, effectiveBinding.codepilotSessionId, msg.messageId);
    ack();
    return;
  }

  if (false && directFeishuDocRequest) {
    const history = store.getMessages(effectiveBinding.codepilotSessionId, { limit: 20 }).messages;
    const latestAssistant = [...history]
      .reverse()
      .find((entry) => entry.role === 'assistant');
    const markdown = extractAssistantMarkdown(latestAssistant?.content ?? '');

    if (!markdown) {
      await deliver(adapter, {
        address: msg.address,
        text: '当前会话里没有可整理成飞书文档的上一条回复。先让我产出一段总结或正文，再让我生成飞书文档。',
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      }, { sessionId: effectiveBinding.codepilotSessionId });
      ack();
      return;
    }

    const createDoc = (adapter as BaseChannelAdapter & {
      createDocumentFromMarkdown?: (markdown: string, options?: { title?: string; ownerUserId?: string }) => Promise<{ documentId?: string; title: string; url: string }>;
    }).createDocumentFromMarkdown!;

    if (typeof createDoc !== 'function') {
      await deliver(adapter, {
        address: msg.address,
        text: '当前飞书通道还没有加载文档创建能力。',
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      }, { sessionId: effectiveBinding.codepilotSessionId });
      ack();
      return;
    }

    try {
      const docInfo = await createDoc.call(adapter, markdown, {
        title: buildFeishuDocTitleFromSession(),
      });
      await deliver(adapter, {
        address: msg.address,
        text: `已生成飞书文档《${docInfo.title}》\n${docInfo.url}`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      }, { sessionId: effectiveBinding.codepilotSessionId });
    } catch (err) {
      const caught = err as { message?: string };
      const errorMessage = caught.message || String(err);
      await deliver(adapter, {
        address: msg.address,
        text: `飞书文档创建失败：${errorMessage}`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      }, { sessionId: effectiveBinding.codepilotSessionId });
    }

    ack();
    return;
  }

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(msg.address.chatId);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  const state = getState();
  state.activeTasks.set(effectiveBinding.codepilotSessionId, taskAbort);
  const progressPulse = await startProgressPulse(adapter, msg, effectiveBinding.codepilotSessionId);
  const directFeishuDocSourceMarkdown = directFeishuDocRequest
    ? extractAssistantMarkdown(
      [...store.getMessages(effectiveBinding.codepilotSessionId, { limit: 20 }).messages]
        .reverse()
        .find((entry) => entry.role === 'assistant')?.content || '',
    )
    : '';
  const feishuDocRequest = rawData?.feishuDocRequest ?? (
    directFeishuDocRequest
      ? { title: undefined, scopeText: '上一条回复整理' }
      : undefined
  );

  if (directFeishuDocRequest && !directFeishuDocSourceMarkdown) {
    progressPulse?.stop();
    await deliver(adapter, {
      address: msg.address,
      text: '当前会话里没有可整理成飞书文档的上一条有效回复。先让我产出一段总结或正文，再让我生成飞书文档。',
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    }, { sessionId: effectiveBinding.codepilotSessionId });
    ack();
    return;
  }

  // ── Streaming preview setup ──────────────────────────────────
  let previewState: StreamingPreviewState | null = null;
  const caps = feishuDocRequest ? null : (adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null);
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;

  // Build the preview onPartialText callback (or undefined if preview not supported)
  const previewOnPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;

    // Truncate to maxChars + ellipsis
    ps.pendingText = fullText.length > cfg.maxChars
      ? fullText.slice(0, cfg.maxChars) + '...'
      : fullText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      // Not enough new content — schedule trailing-edge timer if not already set
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      // Too soon — schedule trailing-edge timer to ensure latest text is sent
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    // Clear any pending trailing-edge timer and flush immediately
    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  // ── Streaming card setup (Feishu CardKit v2) ──────────────────
  // If the adapter supports streaming cards (e.g. Feishu), wire up
  // onStreamText, onToolEvent, and onStreamEnd callbacks.
  // These run in parallel with the existing preview system — Feishu
  // uses cards instead of message edit for streaming.
  const hasStreamingCards = !feishuDocRequest && typeof adapter.onStreamText === 'function';
  const toolCallTracker = new Map<string, ToolCallInfo>();

  const onStreamCardText = hasStreamingCards ? (fullText: string) => {
    try { adapter.onStreamText!(msg.address.chatId, fullText); } catch { /* non-critical */ }
  } : undefined;

  const onToolEvent = hasStreamingCards ? (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => {
    if (toolName) {
      toolCallTracker.set(toolId, { id: toolId, name: toolName, status });
    } else {
      // tool_result doesn't carry name — update existing entry's status
      const existing = toolCallTracker.get(toolId);
      if (existing) existing.status = status;
    }
    try {
      adapter.onToolEvent!(msg.address.chatId, Array.from(toolCallTracker.values()));
    } catch { /* non-critical */ }
  } : undefined;

  // Combined partial text callback: streaming preview + streaming cards
  const onPartialText = (previewOnPartialText || onStreamCardText) ? (fullText: string) => {
    if (previewOnPartialText) previewOnPartialText(fullText);
    if (onStreamCardText) onStreamCardText(fullText);
  } : undefined;

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use text or empty string for image-only messages (prompt is still required by streamClaude)
    const basePromptText = directFeishuDocRequest
      ? buildFeishuDocumentRewritePrompt(directFeishuDocSourceMarkdown, rawText)
      : (text || (hasAttachments ? 'Describe this image.' : ''));
    let fastPathOptions = getFastPathOptions(rawText);
    if (shouldUseUnityQuickActionFastPath(rawText)) {
      const unityMcpCheck = await ensureUnityMcpReady(
        effectiveBinding.workingDirectory || store.getSession(effectiveBinding.codepilotSessionId)?.working_directory || process.cwd(),
      );
      const precheckPrompt = [
        'Unity MCP precheck (factual runtime diagnostics):',
        unityMcpCheck.summary,
        'Use these diagnostics as ground truth for this turn.',
        unityMcpCheck.ok
          ? 'Unity MCP endpoint is reachable; proceed with the requested Unity operation.'
          : 'Unity MCP precheck is not fully healthy, but do not stop here. Continue the turn, run concrete diagnostics or repair commands when safe, and only report failure after at least one additional actionable attempt.',
      ].join('\n');
      fastPathOptions = {
        ...fastPathOptions,
        extraSystemPrompt: [fastPathOptions.extraSystemPrompt, precheckPrompt].filter(Boolean).join('\n\n'),
      };
      if (false && !unityMcpCheck.ok) {
        await deliver(adapter, {
          address: msg.address,
          text: appendReplyEndMarker(`Unity MCP 前置检查失败，已自动尝试拉起但仍未连通。\n\n${unityMcpCheck.summary}`),
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        }, { sessionId: effectiveBinding.codepilotSessionId });
        ack();
        return;
      }
    }

    const result = await engine.processMessage(effectiveBinding, basePromptText, async (perm) => {
      await broker.forwardPermissionRequest(
        adapter,
        msg.address,
        perm.permissionRequestId,
        perm.toolName,
        perm.toolInput,
        effectiveBinding.codepilotSessionId,
        perm.suggestions,
        msg.messageId,
      );
    }, taskAbort.signal, hasAttachments ? msg.attachments : undefined, onPartialText, onToolEvent, {
      storedUserText: text || rawText,
      historyLimit: fastPathOptions.historyLimit,
      extraSystemPrompt: fastPathOptions.extraSystemPrompt,
    });

    // Finalize streaming card if adapter supports it.
    // onStreamEnd awaits any in-flight card creation and returns true if a card
    // was actually finalized (meaning content is already visible to the user).
    let cardFinalized = false;
    if (hasStreamingCards && adapter.onStreamEnd) {
      try {
        const status = result.hasError ? 'error' : 'completed';
        cardFinalized = await adapter.onStreamEnd(msg.address.chatId, status, result.responseText);
      } catch (err) {
        console.warn('[bridge-manager] Card finalize failed:', err instanceof Error ? err.message : err);
      }
    }

    // Send response text — render via channel-appropriate format.
    // Skip if streaming card was finalized (content already in card).
    let handledAsDoc = false;
    if (feishuDocRequest && adapter.channelType === 'feishu' && result.responseText) {
      const createDoc = (adapter as BaseChannelAdapter & {
        createDocumentFromMarkdown?: (markdown: string, options?: { title?: string; ownerUserId?: string }) => Promise<{ documentId?: string; title: string; url: string }>;
      }).createDocumentFromMarkdown;

      if (typeof createDoc === 'function') {
        try {
          const docInfo = await createDoc.call(adapter, result.responseText, {
            title: feishuDocRequest.title && !isGenericFeishuDocumentTitle(feishuDocRequest.title)
              ? feishuDocRequest.title
              : undefined,
            ownerUserId: getConfiguredOwnerIds(adapter.channelType)[0],
          });
          recordFeishuDocumentMemory(store, {
            title: docInfo.title,
            url: docInfo.url,
            documentId: docInfo.documentId,
            chatId: msg.address.chatId,
            requesterId: msg.address.userId,
            workspace: effectiveBinding.workingDirectory || store.getSession(effectiveBinding.codepilotSessionId)?.working_directory || '',
            sourceText: rawText,
            markdown: result.responseText,
          });
          const guideInfo = await syncFeishuDocumentGuideBestEffort(
            adapter,
            store,
            getConfiguredOwnerIds(adapter.channelType)[0],
          );
          handledAsDoc = true;
          if (false) {
          await deliver(adapter, {
            address: msg.address,
            text: `已生成飞书文档《${docInfo.title}》\n${docInfo.url}`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          }, { sessionId: effectiveBinding.codepilotSessionId });
          }
          await deliver(adapter, {
            address: msg.address,
            text: guideInfo
              ? `已生成飞书文档《${docInfo.title}》\n${docInfo.url}\n\n文档导览已更新：${guideInfo.url}`
              : `已生成飞书文档《${docInfo.title}》\n${docInfo.url}`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          }, { sessionId: effectiveBinding.codepilotSessionId });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          await deliver(adapter, {
            address: msg.address,
            text: `飞书文档创建失败：${errorMessage}`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          }, { sessionId: effectiveBinding.codepilotSessionId });
        }
      }
    }

    if (result.responseText) {
      if (!cardFinalized && !handledAsDoc) {
        await deliverResponse(adapter, msg.address, result.responseText, effectiveBinding.codepilotSessionId, msg.messageId);
      }

      const resolvedWorkingDirectory =
        effectiveBinding.workingDirectory || store.getSession(effectiveBinding.codepilotSessionId)?.working_directory || '';
      const localImagePaths = Array.from(new Set([
        ...extractLocalImagePaths(
          result.responseText,
          resolvedWorkingDirectory,
          accessibleWorkspaceDirectories,
        ),
        ...collectRecentAssistantImagePaths(
          effectiveBinding.codepilotSessionId,
          resolvedWorkingDirectory,
          accessibleWorkspaceDirectories,
        ),
      ]));
      if (localImagePaths.length > 0 && typeof adapter.sendLocalImage === 'function') {
        for (const imagePath of localImagePaths.slice(0, 4)) {
          const imageSend = await adapter.sendLocalImage(msg.address.chatId, imagePath, msg.messageId);
          if (!imageSend.ok) {
            console.warn(`[bridge-manager] Failed to send local image: ${imagePath}`, imageSend.error);
          }
        }
      }
    } else if (result.hasError) {
      const errorResponse: OutboundMessage = {
        address: msg.address,
        text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
        parseMode: 'HTML',
        replyToMessageId: msg.messageId,
      };
      await deliver(adapter, errorResponse);
    }

    // Persist the actual SDK session ID for future resume.
    // If the result has an error and no session ID was captured, clear the
    // stale ID so the next message starts fresh instead of retrying a broken resume.
    if (effectiveBinding.id) {
      try {
        if (usesTransientWorkspaceOverride) {
          store.updateChannelBinding(effectiveBinding.id, { sdkSessionId: '' });
        } else {
          const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError, result.shouldRefreshSession);
          if (update !== null) {
            store.updateChannelBinding(effectiveBinding.id, { sdkSessionId: update });
          }
        }
      } catch { /* best effort */ }
    }
  } finally {
    progressPulse?.stop();

    // Clean up preview state
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }

    // If task was aborted and streaming card is still active, finalize as interrupted
    if (hasStreamingCards && adapter.onStreamEnd && taskAbort.signal.aborted) {
      try {
        await adapter.onStreamEnd(msg.address.chatId, 'interrupted', '');
      } catch { /* best effort */ }
    }

    state.activeTasks.delete(effectiveBinding.codepilotSessionId);
    // Notify adapter that message processing ended
    adapter.onMessageEnd?.(msg.address.chatId);
    // Commit the offset only after full processing (success or failure)
    ack();
  }
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const { store } = getBridgeContext();

  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: `Command rejected: invalid input detected.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let response = '';

  switch (command) {
    case '/start':
      response = [
        '<b>CodePilot Bridge</b>',
        '',
        'Send any message to interact with Claude.',
        '',
        '<b>Commands:</b>',
        '/new [project_or_path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd &lt;project_or_path&gt; - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/whoami - Show current Feishu sender IDs',
        '/docs - List generated Feishu documents',
        '/projects - List available workspaces',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission',
        '/help - Show this help',
      ].join('\n');
      break;

    case '/new': {
      // Abort any running task on the current session before creating a new one
      const oldBinding = router.resolve(msg.address);
      const st = getState();
      const oldTask = st.activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        oldTask.abort();
        st.activeTasks.delete(oldBinding.codepilotSessionId);
      }

      let workDir: string | undefined;
      if (args) {
        const resolved = resolveWorkspaceArgumentForMessage(args, msg);
        if (!resolved.path) {
          if (resolved.error === 'ambiguous' && resolved.matches) {
            response = `Workspace is ambiguous. Use an absolute path.\n${resolved.matches.map((entry) => `<code>${escapeHtml(entry)}</code>`).join('\n')}`;
          } else if (resolved.error === 'not_allowed') {
            response = 'Path is outside the configured workspace roots.';
          } else {
            response = 'Workspace not found. Use /projects to list available workspaces.';
          }
          break;
        }
        workDir = resolved.path;
      }
      const binding = router.createBinding(msg.address, workDir);
      response = `New session created.\nSession: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>\nCWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`;
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind &lt;session_id&gt;';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format. Expected a 32-64 character hex/UUID string.';
        break;
      }
      const binding = router.bindToSession(msg.address, args);
      if (binding) {
        response = `Bound to session <code>${args.slice(0, 8)}...</code>`;
      } else {
        response = 'Session not found.';
      }
      break;
    }

    case '/cwd': {
      if (!args) {
        response = 'Usage: /cwd <project_name_or_absolute_path>';
        break;
      }
      const resolved = resolveWorkspaceArgumentForMessage(args, msg);
      if (!resolved.path) {
        if (resolved.error === 'ambiguous' && resolved.matches) {
          response = `Workspace is ambiguous. Use an absolute path.\n${resolved.matches.map((entry) => `<code>${escapeHtml(entry)}</code>`).join('\n')}`;
        } else if (resolved.error === 'not_allowed') {
          response = 'Path is outside the configured workspace roots.';
        } else {
          response = 'Workspace not found. Use /projects to list available workspaces.';
        }
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { workingDirectory: resolved.path, sdkSessionId: '' });
      response = `Working directory set to <code>${escapeHtml(resolved.path)}</code>`;
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { mode: args });
      response = `Mode set to <b>${args}</b>`;
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      response = [
        '<b>Bridge Status</b>',
        '',
        `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        `Model: <code>${binding.model || 'default'}</code>`,
        `Additional dirs: <code>${escapeHtml(getConfiguredAdditionalDirectories().join(' | ') || '(none)')}</code>`,
      ].join('\n');
      break;
    }

    case '/whoami': {
      const sender = (msg.raw as { feishuSender?: { openId?: string; userId?: string; unionId?: string; chatType?: string } } | undefined)?.feishuSender;
      response = [
        '<b>Current Sender</b>',
        '',
        `channel: <code>${escapeHtml(msg.address.channelType)}</code>`,
        `chatId: <code>${escapeHtml(msg.address.chatId)}</code>`,
        `address.userId: <code>${escapeHtml(msg.address.userId || '')}</code>`,
        `open_id: <code>${escapeHtml(sender?.openId || '')}</code>`,
        `user_id: <code>${escapeHtml(sender?.userId || '')}</code>`,
        `union_id: <code>${escapeHtml(sender?.unionId || '')}</code>`,
        `chat_type: <code>${escapeHtml(sender?.chatType || '')}</code>`,
        `owner: <b>${isOwnerMessage(msg) ? 'yes' : 'no'}</b>`,
      ].join('\n');
      break;
    }

    case '/docs': {
      response = escapeHtml(renderFeishuDocumentMemoryList(store));
      break;
    }

    case '/projects': {
      response = renderWorkspaceSummaryLines().join('\n');
      break;
    }

    case '/sessions': {
      const bindings = router.listBindings(adapter.channelType);
      if (bindings.length === 0) {
        response = 'No sessions found.';
      } else {
        const lines = ['<b>Sessions:</b>', ''];
        for (const b of bindings.slice(0, 10)) {
          const active = b.active ? 'active' : 'inactive';
          lines.push(`<code>${b.codepilotSessionId.slice(0, 8)}...</code> [${active}] ${escapeHtml(b.workingDirectory || '~')}`);
        }
        response = lines.join('\n');
      }
      break;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const st = getState();
      const taskAbort = st.activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        st.activeTasks.delete(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/perm': {
      if (adapter.channelType === 'feishu' && !isOwnerMessage(msg)) {
        response = escapeHtml(buildOwnerRequiredMessage(msg));
        break;
      }
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage: /perm allow <id> | /perm allow_session <id> | /perm deny <id>
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny &lt;permission_id&gt;';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
      if (handled) {
        response = `Permission ${permAction}: recorded.`;
      } else {
        response = `Permission not found or already resolved.`;
      }
      break;
    }

    case '/help':
      response = [
        '<b>CodePilot Bridge Commands</b>',
        '',
        '/new [project_or_path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd &lt;project_or_path&gt; - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/whoami - Show current Feishu sender IDs',
        '/docs - List generated Feishu documents',
        '/projects - List available workspaces',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission request',
        '1/2/3 - Quick permission reply (Feishu/QQ/WeChat, single pending)',
        '/help - Show this help',
      ].join('\n');
      break;

    default:
      response = `Unknown command: ${escapeHtml(command)}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: 'HTML',
      replyToMessageId: msg.messageId,
    });
  }
}

// ── SDK Session Update Logic ─────────────────────────────────

/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Rules:
 * - If result has sdkSessionId AND no error → save the new ID
 * - If result has error (regardless of sdkSessionId) → clear to empty string
 * - Otherwise → no update needed
 */
export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
  shouldRefreshSession = false,
): string | null {
  if (hasError || shouldRefreshSession) {
    return '';
  }
  if (sdkSessionId) {
    return sdkSessionId;
  }
  return null;
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = {
  handleMessage,
  isDangerousUserRequest,
  isFeishuDocumentListRequest,
  isFeishuDocGenerationRequestStrict,
  buildUnityScreenshotPolicyInstructions,
};
