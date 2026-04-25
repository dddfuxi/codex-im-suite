import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import { isDangerousInput, isPathWithinAllowedRoots, splitWorkspacePathList } from 'claude-to-im/src/lib/bridge/security/validators.js';

import { CTI_HOME, type Config } from './config.js';
import {
  assessExecutorInteraction,
  assessIgnisInteraction,
  assessMcpInteraction,
  canExecuteMutatingFastPath,
  getExecutorCommandRisk,
  type ExecutionRisk,
  inferIgnisFastIntent,
  inferMcpFastIntent,
} from './fast-path-intent.js';
import type { PendingPermissions } from './permission-gateway.js';
import { LocalLlamaProvider, type LocalModelMessage } from './local-llm-provider.js';
import { McpBridge, type McpManifestRecord } from './mcp-bridge.js';
import type {
  ConservativeRouteDecision,
  LocalRouteProtocolResult,
  LocalTaskKind,
} from './local-llm-router.js';
import {
  appendLocalLlmRouteSummary,
  appendLocalLlmExecutionSummary,
  readLocalLlmStatus,
  type LocalLlmExecutionSummary,
  type LocalRouterMode,
} from './local-llm-status.js';
import { sseEvent } from './sse-utils.js';

type LocalExecutionAction = 'answer_only' | 'run_shell' | 'edit_file' | 'multi_step';
type LocalExecutionStepType = 'shell_command' | 'read_file' | 'write_file' | 'search_text';

interface LocalExecutionStepBase {
  type: LocalExecutionStepType;
  reason?: string;
  requiresPermission?: boolean;
}

interface ShellCommandStep extends LocalExecutionStepBase {
  type: 'shell_command';
  command: string;
}

interface ReadFileStep extends LocalExecutionStepBase {
  type: 'read_file';
  path: string;
}

interface WriteFileStep extends LocalExecutionStepBase {
  type: 'write_file';
  path: string;
  content: string;
}

interface SearchTextStep extends LocalExecutionStepBase {
  type: 'search_text';
  path: string;
  pattern: string;
}

type LocalExecutionStep = ShellCommandStep | ReadFileStep | WriteFileStep | SearchTextStep;

interface LocalExecutionPlan {
  action: LocalExecutionAction;
  reason: string;
  taskKind: LocalTaskKind;
  steps: LocalExecutionStep[];
  safetyFlags: string[];
  finalReplyMode: string;
}

interface StepExecutionResult {
  step: LocalExecutionStep;
  success: boolean;
  output: string;
  isError?: boolean;
}

interface LocalAgentHandleContext {
  mode: LocalRouterMode;
  conservative: ConservativeRouteDecision;
  route?: LocalRouteProtocolResult;
}

interface LocalAgentHandleResult {
  handled: boolean;
  fallbackToCodex?: boolean;
  fallbackReason?: string;
}

interface IgnisSessionState {
  sessionId?: string;
  turnId?: string;
  canvasId?: string;
  fileIds?: string[];
  updatedAt: string;
}

type IgnisSessionStore = Record<string, IgnisSessionState>;
type IgnisIntent = 'status' | 'skills' | 'result' | 'wait' | 'history' | 'resume' | 'generate';

interface IgnisDownloadedAssets {
  images: string[];
  files: string[];
  links: string[];
  localFiles: string[];
}

interface IgnisAssetPipelineResult {
  note: string;
  files: string[];
  links: string[];
}

const SHELL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 4000;
const MAX_SEARCH_RESULTS = 40;
const IGNIS_SESSION_STATE_PATH = path.join(CTI_HOME, 'runtime', 'ignis-sessions.json');
const IGNIS_FILE_ID_PATTERN = /\b[A-Za-z0-9_-]{4,}\.(?:png|jpe?g|webp|gif|mp4|mov|glb|gltf|fbx|obj|zip|pdf|md|wav|mp3)\b/gi;
const IGNIS_CDN_BASE_URL = 'https://cdn-asia.funplus-marketing.ai/ultra';
const IGNIS_GENERATION_WAIT_MS = Math.max(30_000, Number.parseInt(process.env.CTI_IGNIS_GENERATION_WAIT_MS || '300000', 10) || 300_000);
const IGNIS_REPLY_FILE_MAX_BYTES = Math.max(1, Number.parseInt(process.env.CTI_IGNIS_REPLY_FILE_MAX_BYTES || String(30 * 1024 * 1024), 10) || 30 * 1024 * 1024);
const IGNIS_ASSET_PIPELINE_TIMEOUT_MS = Math.max(60_000, Number.parseInt(process.env.CTI_ASSET_PIPELINE_TIMEOUT_MS || '900000', 10) || 900_000);
const RUNTIME_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function truncateText(text: string, maxChars = MAX_OUTPUT_CHARS): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function readIgnisSessionStore(): IgnisSessionStore {
  try {
    if (!fs.existsSync(IGNIS_SESSION_STATE_PATH)) return {};
    const raw = fs.readFileSync(IGNIS_SESSION_STATE_PATH, 'utf-8');
    return JSON.parse(raw) as IgnisSessionStore;
  } catch {
    return {};
  }
}

function writeIgnisSessionStore(store: IgnisSessionStore): void {
  fs.mkdirSync(path.dirname(IGNIS_SESSION_STATE_PATH), { recursive: true });
  const tmp = `${IGNIS_SESSION_STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmp, IGNIS_SESSION_STATE_PATH);
}

function collectIgnisValues(value: unknown, keyName: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectIgnisValues(item, keyName, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === keyName && typeof nested === 'string' && nested.trim()) out.add(nested.trim());
    if (key === `${keyName}s` && Array.isArray(nested)) {
      for (const item of nested) {
        if (typeof item === 'string' && item.trim()) out.add(item.trim());
      }
    }
    collectIgnisValues(nested, keyName, out);
  }
}

function addIgnisStringArray(value: unknown, out: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) out.add(item.trim());
  }
}

function collectIgnisGeneratedFileIds(payload: unknown): string[] {
  const root = getIgnisDataObject(payload);
  const out = new Set<string>();
  const artifactSummary = root.artifact_summary;
  if (artifactSummary && typeof artifactSummary === 'object') {
    collectIgnisValues(artifactSummary, 'file_id', out);
  }
  const artifacts = root.artifacts;
  if (artifacts) collectIgnisValues(artifacts, 'file_id', out);

  const toolSummary = root.tool_summary;
  if (toolSummary && typeof toolSummary === 'object') {
    const calls = (toolSummary as Record<string, unknown>).calls;
    if (Array.isArray(calls)) {
      for (const call of calls) {
        if (!call || typeof call !== 'object') continue;
        addIgnisStringArray((call as Record<string, unknown>).output_file_ids, out);
      }
    }
  }

  const toolTrace = root.tool_trace;
  if (Array.isArray(toolTrace)) {
    for (const event of toolTrace) {
      if (!event || typeof event !== 'object') continue;
      if ((event as Record<string, unknown>).type !== 'agent_tool_result') continue;
      const eventPayload = (event as Record<string, unknown>).payload;
      if (!eventPayload || typeof eventPayload !== 'object') continue;
      const content = (eventPayload as Record<string, unknown>).content;
      if (typeof content !== 'string' || !content.trim()) continue;
      try {
        const parsedContent = JSON.parse(content) as unknown;
        collectIgnisValues(parsedContent, 'file_id', out);
      } catch {
        // Ignore non-JSON tool result content.
      }
    }
  }

  if (out.size > 0) return [...out];

  const fallback = new Set<string>();
  collectIgnisValues(root, 'file_id', fallback);
  const inputFileIds = new Set<string>();
  const input = root.input;
  if (input && typeof input === 'object') {
    addIgnisStringArray((input as Record<string, unknown>).file_ids, inputFileIds);
  }
  return [...fallback].filter((id) => !inputFileIds.has(id));
}

function parseIgnisToolPayload(rawText: string): unknown {
  const trimmed = rawText.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (Array.isArray(parsed) && parsed.length > 0) {
    const first = parsed[0];
    if (first && typeof first === 'object' && 'text' in first && typeof (first as { text?: unknown }).text === 'string') {
      return JSON.parse(String((first as { text: string }).text));
    }
  }
  return parsed;
}

function extractIgnisSummary(payload: unknown): { turnIds: string[]; sessionIds: string[]; canvasIds: string[]; fileIds: string[] } {
  const turnIds = new Set<string>();
  const sessionIds = new Set<string>();
  const canvasIds = new Set<string>();
  collectIgnisValues(payload, 'turn_id', turnIds);
  collectIgnisValues(payload, 'session_id', sessionIds);
  collectIgnisValues(payload, 'canvas_id', canvasIds);
  return {
    turnIds: [...turnIds],
    sessionIds: [...sessionIds],
    canvasIds: [...canvasIds],
    fileIds: collectIgnisGeneratedFileIds(payload),
  };
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function extractIgnisFileIds(text: string): string[] {
  return uniq(Array.from(text.matchAll(IGNIS_FILE_ID_PATTERN)).map((match) => match[0]));
}

function isIgnisImageFileId(fileId: string): boolean {
  return /\.(?:png|jpe?g|webp|gif)$/i.test(fileId);
}

function isIgnisModelFileId(fileId: string): boolean {
  return /\.(?:glb|gltf|fbx|obj|usdz|zip)$/i.test(fileId);
}

function isIgnisReplayRequest(prompt: string): boolean {
  const text = prompt.trim();
  if (!text) return false;
  const mentionsIgnis = /\bignis\b/i.test(text);
  const asksReplay = /(再发|重发|补发|重新发|发我一下|发我一份|回传|给我看|下载链接|文件链接)/i.test(text);
  const referencesPrevious = /(上次|上一个|上一轮|上一版|刚才|之前|前面|上回|最近)/i.test(text);
  const mentionsGeneratedAsset = /(结果|文件|图片|图像|视频|模型|glb|gltf|fbx|素材|asset)/i.test(text);
  return asksReplay && (mentionsIgnis || referencesPrevious || mentionsGeneratedAsset);
}

function pickIgnisReplayFileIds(fileIds: string[], prompt: string): string[] {
  const ids = uniq(fileIds);
  if (ids.length === 0) return [];
  const modelIds = ids.filter(isIgnisModelFileId);
  const imageIds = ids.filter(isIgnisImageFileId);

  if (/(模型|3d|3d模型|glb|gltf|fbx|obj|usdz)/i.test(prompt) && modelIds.length > 0) {
    return modelIds.slice(-4);
  }
  if (/(贴图|纹理|材质|texture|png|jpg|jpeg|webp|gif)/i.test(prompt) && imageIds.length > 0) {
    return imageIds.slice(-8);
  }
  if (/(图片|图像|原画|概念图|截图)/i.test(prompt) && imageIds.length > 0) {
    return imageIds.slice(-4);
  }
  if (modelIds.length > 0) return modelIds.slice(-4);
  return ids.slice(-4);
}

function hasIgnisPriorAssetReference(prompt: string): boolean {
  return /(该|这张|这幅|这个|这个图|这张图|上图|上一张|上一版|上一轮|刚才|方才|前面|参考图|原图|草坛|花坛)/i.test(prompt);
}

function hasIgnisSessionReuseLanguage(prompt: string): boolean {
  return /(继续|延续|上一版|上一轮|改一下|保留|同风格|基于刚才|基于上图|再来|换成|调整|沿用)/i.test(prompt);
}

function pickIgnisReferenceFileIds(state: IgnisSessionState | undefined, prompt: string): string[] {
  const ids = uniq(state?.fileIds || []);
  if (ids.length === 0) return [];
  const imageIds = ids.filter(isIgnisImageFileId);
  if (imageIds.length > 0) return imageIds.slice(-1);
  if (/(模型|3d|3d model|glb|gltf|fbx|obj)/i.test(prompt)) {
    return ids.filter((id) => !/\.(?:glb|gltf|fbx|obj)$/i.test(id)).slice(-1);
  }
  return ids.slice(-1);
}

function extractIgnisTurnId(text: string): string | undefined {
  const match = text.match(/\bturn[_-]?id[:：]?\s*([A-Za-z0-9_-]{8,})\b/i) || text.match(/\bturn_[A-Za-z0-9_-]+\b/i);
  return match ? (match[1] || match[0]) : undefined;
}

function getIgnisDataObject(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {};
  const raw = payload as Record<string, unknown>;
  if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) {
    return raw.data as Record<string, unknown>;
  }
  return raw;
}

function getIgnisStatus(payload: unknown): string {
  const data = getIgnisDataObject(payload);
  return typeof data.status === 'string' ? data.status.trim().toLowerCase() : '';
}

function isIgnisTerminalStatus(status: string): boolean {
  return /^(completed|failed|error|cancelled|canceled)$/i.test(status);
}

function parseIgnisHistoryLimit(prompt: string): number {
  const explicit = prompt.match(/(?:最近|近|latest|last|limit)\s*(\d{1,2})\s*(?:次|条|个|轮)?/i)
    || prompt.match(/(?:列出|整理|查看|检查).{0,8}(\d{1,2})\s*(?:次|条|个|轮)/i);
  const value = explicit ? Number.parseInt(explicit[1], 10) : Number.NaN;
  if (Number.isFinite(value) && value > 0) return Math.min(value, 20);
  if (/(最近几次|最近几轮|最近记录|最近列表|整理成列表|整理列表|列个列表)/i.test(prompt)) return 5;
  return 10;
}

function makeCtiFinalReply(text: string, assets: IgnisDownloadedAssets = { images: [], files: [], links: [], localFiles: [] }): string {
  const kind = assets.images.length > 0 && assets.files.length > 0
    ? 'mixed'
    : assets.images.length > 0
      ? 'image'
      : assets.files.length > 0
        ? 'file'
        : 'text';
  return [
    '```cti-final',
    JSON.stringify({
      kind,
      text,
      images: uniq(assets.images),
      files: uniq(assets.files),
      reply_mode: 'plain',
    }),
    '```',
  ].join('\n');
}

function mimeToExtension(mimeType: string, fileName: string): string {
  const existing = path.extname(fileName);
  if (existing) return existing;
  if (/png/i.test(mimeType)) return '.png';
  if (/jpe?g/i.test(mimeType)) return '.jpg';
  if (/webp/i.test(mimeType)) return '.webp';
  if (/gif/i.test(mimeType)) return '.gif';
  if (/mp4/i.test(mimeType)) return '.mp4';
  if (/pdf/i.test(mimeType)) return '.pdf';
  return '.bin';
}

function firstNonEmptyLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function formatIgnisTimeLabel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '未知时间';
  const normalized = value.trim().endsWith('Z') ? value.trim() : `${value.trim()}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value.trim();
  return date.toLocaleString('zh-CN', { hour12: false });
}

function shortenIgnisId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const trimmed = value.trim();
  return trimmed.length <= 16 ? trimmed : `${trimmed.slice(0, 8)}...${trimmed.slice(-6)}`;
}

function extractIgnisHistoryTurns(payload: unknown): Array<Record<string, unknown>> {
  const data = getIgnisDataObject(payload);
  const turns = data.turns;
  if (!Array.isArray(turns)) return [];
  return turns.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
}

function wantsIgnisAssetPipeline(prompt: string): boolean {
  return /(fbx|贴图|材质|纹理|textures?|拆分|拆成|导出|资产包|asset\s*pipeline|unity\s*包|unity包)/i.test(prompt)
    && /(模型|3d|glb|gltf|ignis|资源|asset)/i.test(prompt);
}

function wantsIgnisAssetZip(prompt: string): boolean {
  if (/(不打包|不用打包|不要打包|单独|分别|分开发)/i.test(prompt)) return false;
  return /(打包|压缩|zip|整包|包成|一个包|资产包)/i.test(prompt);
}

function isIgnisModelAsset(filePath: string): boolean {
  return /\.(glb|gltf)$/i.test(filePath);
}

function fileIsSendable(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0 && stat.size <= IGNIS_REPLY_FILE_MAX_BYTES;
  } catch {
    return false;
  }
}

function isIgnisTextureAsset(filePath: string): boolean {
  return /\.(png|jpe?g|webp|gif|tga|bmp)$/i.test(filePath);
}

function isIgnisMetadataAsset(filePath: string): boolean {
  return /(?:^|[\\/])manifest\.json$/i.test(filePath) || /\.(?:mat\.json)$/i.test(filePath);
}

function extractJsonObject(raw: string): string {
  const text = raw.trim();
  const start = text.indexOf('{');
  if (start === -1) throw new Error('执行计划缺少 JSON 对象');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error('执行计划 JSON 不完整');
}

function toTaskKind(value: string | undefined, fallback: LocalTaskKind): LocalTaskKind {
  const valid: LocalTaskKind[] = ['chat', 'explain', 'summarize', 'config_help', 'command_draft', 'script_draft', 'code_explain', 'tool_request', 'repo_query', 'unity_like', 'blender_like', 'doc_like'];
  return valid.includes(value as LocalTaskKind) ? (value as LocalTaskKind) : fallback;
}

function tryConvertRipgrepCommand(command: string): SearchTextStep | null {
  const normalized = command.trim();
  if (!/^(?:&\s*)?(?:rg|rg\.exe)\b/i.test(normalized)) return null;

  const quotedPattern = normalized.match(/"([^"]+)"/);
  if (!quotedPattern?.[1]?.trim()) return null;

  const afterPattern = normalized.slice((quotedPattern.index || 0) + quotedPattern[0].length).trim();
  const explicitPath = afterPattern
    .split(/\s+/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('-') && !/[|;&<>]/.test(item));

  return {
    type: 'search_text',
    path: explicitPath || '.',
    pattern: quotedPattern[1].trim(),
    reason: '将 rg 检索转换为内置 search_text，避免本机 rg.exe 被系统拒绝执行',
    requiresPermission: false,
  };
}

export class LocalAgentProvider {
  private readonly mcpBridge: McpBridge;

  constructor(
    private readonly config: Config,
    private readonly pendingPerms: PendingPermissions,
    private readonly localProvider: LocalLlamaProvider,
  ) {
    this.mcpBridge = new McpBridge(config);
  }

  canHandleIgnisFastPath(params: StreamChatParams): boolean {
    const hasFiles = Boolean(params.files?.length);
    const assessment = assessIgnisInteraction(params.prompt, hasFiles);
    if (assessment.interactionIntent === 'explain') return false;
    return inferIgnisFastIntent(params.prompt, hasFiles, assessment) !== null;
  }

  async handleIgnisFastPath(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    mode: LocalRouterMode,
  ): Promise<LocalAgentHandleResult> {
    const hasFiles = Boolean(params.files?.length);
    const assessment = assessIgnisInteraction(params.prompt, hasFiles);
    const intent = inferIgnisFastIntent(params.prompt, hasFiles, assessment);
    if (!intent) {
      return { handled: false, fallbackToCodex: true, fallbackReason: 'Ignis fast-path preflight rejected' };
    }

    const manifest = this.mcpBridge.resolveManifestByHint('ignis');
    if (!manifest) {
      const text = '未找到 Ignis MCP manifest。请确认 config/mcp.d/ignis-mcp.json 已安装。';
      this.recordIgnisSummary(mode, false, text);
      this.emitTerminalResponse(controller, params.sessionId, makeCtiFinalReply(text), true);
      return { handled: true, fallbackToCodex: false, fallbackReason: 'Ignis MCP manifest missing' };
    }

    const health = await this.ensureIgnisMcpOnline(manifest);
    if (!health.ok) {
      const text = `Ignis MCP 不可用：${health.message}`;
      this.recordIgnisSummary(mode, false, text);
      this.emitTerminalResponse(controller, params.sessionId, makeCtiFinalReply(text), true);
      return { handled: true, fallbackToCodex: false, fallbackReason: health.message };
    }

    if (intent === 'status') {
      const reply = await this.buildIgnisStatusReply(manifest, health);
      this.recordIgnisSummary(mode, true, reply);
      this.emitTerminalResponse(controller, params.sessionId, makeCtiFinalReply(reply), false);
      return { handled: true };
    }

    if (intent === 'history' && !this.resolveIgnisHistorySessionId(params.sessionId)) {
      const reply = '还没有可用的 Ignis 最近记录。先提交过一次 Ignis 任务后，我才能按最近几次整理列表。';
      this.recordIgnisSummary(mode, true, reply);
      this.emitTerminalResponse(controller, params.sessionId, makeCtiFinalReply(reply), false);
      return { handled: true };
    }

    if (intent === 'result') {
      const replay = await this.tryReplayIgnisStoredResult(params);
      if (replay) {
        this.recordIgnisSummary(mode, true, replay.reply);
        this.emitTerminalResponse(controller, params.sessionId, makeCtiFinalReply(replay.reply, replay.assets), false);
        return { handled: true };
      }
      const replayState = this.resolveIgnisReplayState(params.sessionId);
      if (!extractIgnisTurnId(params.prompt) && !replayState?.turnId && !replayState?.sessionId) {
        const reply = '还没有可回传的 Ignis 结果。先提交过一次 Ignis 任务后，再发“重发上次结果”才有内容。';
        this.recordIgnisSummary(mode, true, reply);
        this.emitTerminalResponse(controller, params.sessionId, makeCtiFinalReply(reply), false);
        return { handled: true };
      }
    }

    const tempFiles: string[] = [];
    try {
      const { toolName, args } = this.buildIgnisToolCall(params, intent);
      if (toolName === 'ignis_ask' && params.files?.length) {
        const attachments = (args.attachments as string[] | undefined) || [];
        for (const file of params.files) {
          if (!file.data) continue;
          const ext = mimeToExtension(file.type || '', file.name || 'attachment');
          const filePath = path.join(CTI_HOME, 'runtime', `ignis-attachment-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, Buffer.from(file.data, 'base64'));
          tempFiles.push(filePath);
          attachments.push(filePath);
        }
        args.attachments = attachments;
      }

      const resultText = await this.mcpBridge.callHttpTool(manifest, toolName, args);
      const parsed = parseIgnisToolPayload(resultText);
      this.updateIgnisSessionState(params.sessionId, parsed);
      let finalPayload = parsed;
      let timedOut = false;
      let waitMessage = '';
      if (toolName === 'ignis_ask') {
        const waitResult = await this.waitForIgnisCompletion(manifest, parsed);
        if (waitResult.payload) {
          finalPayload = waitResult.payload;
          this.updateIgnisSessionState(params.sessionId, finalPayload);
        }
        timedOut = waitResult.timedOut;
        waitMessage = waitResult.message || '';
      }
      const assets = await this.downloadIgnisAssets(extractIgnisSummary(finalPayload).fileIds);
      const pipeline = toolName === 'ignis_ask' && intent === 'generate' && !timedOut && wantsIgnisAssetPipeline(params.prompt)
        ? await this.runIgnisAssetPipeline(params.prompt, assets)
        : undefined;
      if (pipeline) {
        assets.files.push(...pipeline.files);
        assets.links.push(...pipeline.links);
      }
      const replyBase = this.formatIgnisReply(toolName, finalPayload, resultText, { intent, timedOut, waitMessage, assets });
      const reply = pipeline?.note ? `${replyBase}\n\n${pipeline.note}` : replyBase;
      this.recordIgnisSummary(mode, true, reply);
      this.emitTerminalResponse(controller, params.sessionId, makeCtiFinalReply(reply, assets), false);
      return { handled: true };
    } catch (error) {
      const text = `Ignis 调用失败：${error instanceof Error ? error.message : String(error)}`;
      this.recordIgnisSummary(mode, false, text);
      this.emitTerminalResponse(controller, params.sessionId, makeCtiFinalReply(text), true);
      return { handled: true, fallbackToCodex: false, fallbackReason: text };
    } finally {
      for (const filePath of tempFiles) {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
  }

  private async ensureIgnisMcpOnline(manifest: McpManifestRecord): Promise<{ ok: boolean; message: string }> {
    let health = await this.mcpBridge.checkHealth(manifest);
    if (health.ok) return health;
    const start = await this.mcpBridge.startService(manifest);
    if (!start.ok) return { ok: false, message: start.message };
    const deadline = Date.now() + 20000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      health = await this.mcpBridge.checkHealth(manifest);
      if (health.ok) return health;
    } while (Date.now() < deadline);
    return health.ok ? health : { ok: false, message: health.message || start.message };
  }

  private async buildIgnisStatusReply(manifest: McpManifestRecord, health: { ok: boolean; message: string }): Promise<string> {
    let tools: string[] = [];
    let cliOk = false;
    let cliError = '';
    try {
      tools = await this.mcpBridge.listHttpTools(manifest);
      await this.mcpBridge.callHttpTool(manifest, 'ignis_skills', { limit: 1 });
      cliOk = true;
    } catch (error) {
      cliError = error instanceof Error ? error.message : String(error);
    }

    const lines = [
      cliOk && health.ok ? 'Ignis 已安装并可用。' : 'Ignis 当前未完全可用。',
      `MCP: ${health.message}`,
      `工具: ${tools.length > 0 ? `${tools.length} 个` : '未获取到'}`,
      `CLI/config: ${cliOk ? '正常' : `异常：${truncateText(cliError, 180)}`}`,
    ];
    if (cliOk) {
      lines.push('生成任务请明确说“用 Ignis 生成/画/做图片、视频或模型”。');
    }
    return lines.join('\n');
  }

  private async waitForIgnisCompletion(
    manifest: McpManifestRecord,
    submittedPayload: unknown,
  ): Promise<{ payload?: unknown; timedOut: boolean; message?: string }> {
    const summary = extractIgnisSummary(submittedPayload);
    const turnId = summary.turnIds[0];
    if (!turnId) return { timedOut: false };
    const submitStatus = getIgnisStatus(submittedPayload);
    if (submitStatus && isIgnisTerminalStatus(submitStatus)) return { payload: submittedPayload, timedOut: false };
    try {
      const waitText = await this.mcpBridge.callHttpTool(manifest, 'ignis_wait', {
        turn_id: turnId,
        timeout_ms: IGNIS_GENERATION_WAIT_MS,
      });
      return { payload: parseIgnisToolPayload(waitText), timedOut: false };
    } catch (error) {
      return {
        timedOut: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async downloadIgnisAssets(fileIds: string[]): Promise<IgnisDownloadedAssets> {
    const assets: IgnisDownloadedAssets = { images: [], files: [], links: [], localFiles: [] };
    const assetDir = path.join(CTI_HOME, 'runtime', 'ignis-assets');
    fs.mkdirSync(assetDir, { recursive: true });
    for (const fileId of uniq(fileIds).slice(0, 8)) {
      const url = /^https?:\/\//i.test(fileId) ? fileId : `${IGNIS_CDN_BASE_URL}/${fileId}`;
      try {
        const response = await fetch(url);
        if (!response.ok) continue;
        const contentType = response.headers.get('content-type') || '';
        const safeName = fileId.split(/[\\/]/).pop()?.replace(/[^a-zA-Z0-9._-]+/g, '-') || `asset-${crypto.randomBytes(4).toString('hex')}`;
        const ext = path.extname(safeName) || mimeToExtension(contentType, safeName);
        const outputPath = path.join(assetDir, safeName.endsWith(ext) ? safeName : `${safeName}${ext}`);
        fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
        assets.localFiles.push(outputPath);
        if (/\.(png|jpe?g|webp|gif)$/i.test(outputPath) || /^image\//i.test(contentType)) {
          assets.images.push(outputPath);
        } else if (fs.statSync(outputPath).size > IGNIS_REPLY_FILE_MAX_BYTES) {
          assets.links.push(url);
        } else {
          assets.files.push(outputPath);
        }
      } catch {
        // Keep the URL in the text even if local download fails.
        assets.links.push(url);
      }
    }
    return assets;
  }

  private async runIgnisAssetPipeline(prompt: string, assets: IgnisDownloadedAssets): Promise<IgnisAssetPipelineResult> {
    const sourceGlb = [...assets.localFiles, ...assets.files].reverse().find(isIgnisModelAsset);
    if (!sourceGlb) {
      return {
        note: '模型拆分未执行：本次 Ignis 结果里没有可处理的 GLB/GLTF 文件。',
        files: [],
        links: [],
      };
    }

    const packageZip = wantsIgnisAssetZip(prompt);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sourceName = path.basename(sourceGlb, path.extname(sourceGlb)).replace(/[^a-zA-Z0-9._-]+/g, '-');
    const outputRoot = path.join(CTI_HOME, 'runtime', 'asset-pipeline', `${sourceName}-${stamp}`);
    try {
      const scriptPath = this.resolveAssetPipelineScript();
      const args = [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-SourceGlb',
        sourceGlb,
        '-OutputRoot',
        outputRoot,
      ];
      if (packageZip) args.push('-PackageZip');
      const result = await this.runPowerShellFile(args, path.dirname(scriptPath), IGNIS_ASSET_PIPELINE_TIMEOUT_MS);
      if (result.exitCode !== 0) {
        throw new Error(firstNonEmptyLine(result.output) || `导出脚本退出码 ${result.exitCode}`);
      }
      const parsed = JSON.parse(extractJsonObject(result.output)) as {
        ok?: boolean;
        outputRoot?: string;
        fbxPath?: string;
        textureCount?: number;
        files?: Array<{ path?: string; relativePath?: string; length?: number }>;
        zipPath?: string | null;
      };
      if (!parsed.ok) throw new Error('导出脚本没有返回成功状态');

      const sendFiles: string[] = [];
      const localOnly: string[] = [];
      const exportedFiles = (parsed.files || [])
        .map((item) => item.path || '')
        .filter(Boolean)
        .filter((filePath) => !/\.(?:glb|gltf)$/i.test(filePath))
        .filter((filePath) => !isIgnisMetadataAsset(filePath));
      const preferredFiles = uniq([
        ...(parsed.fbxPath ? [parsed.fbxPath] : []),
        ...exportedFiles.filter((filePath) => isIgnisTextureAsset(filePath) && /[\\/]unity[\\/]Textures[\\/]/i.test(filePath)),
        ...exportedFiles.filter((filePath) => isIgnisTextureAsset(filePath) && !/[\\/]unity[\\/]Textures[\\/]/i.test(filePath)),
      ]);

      if (packageZip && parsed.zipPath) {
        if (fileIsSendable(parsed.zipPath)) sendFiles.push(parsed.zipPath);
        else localOnly.push(parsed.zipPath);
      } else {
        for (const filePath of preferredFiles.slice(0, 30)) {
          if (fileIsSendable(filePath)) sendFiles.push(filePath);
          else localOnly.push(filePath);
        }
      }

      const lines = [
        '模型已拆分为 FBX 和贴图。',
        `导出目录: ${parsed.outputRoot || outputRoot}`,
      ];
      if (parsed.fbxPath) lines.push(`FBX: ${parsed.fbxPath}`);
      lines.push(`贴图: ${parsed.textureCount || 0} 个`);
      if (sendFiles.length > 0) lines.push(`已准备回传: ${sendFiles.length} 个文件`);
      if (localOnly.length > 0) {
        lines.push('以下文件超过飞书单文件上传限制，请从本机路径取用：');
        lines.push(...localOnly.slice(0, 6));
      }

      return { note: lines.join('\n'), files: sendFiles, links: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        note: `模型已生成，但 FBX/贴图拆分失败：${truncateText(message, 500)}`,
        files: [],
        links: [],
      };
    }
  }

  private resolveAssetPipelineScript(): string {
    const candidates = [
      process.env.CTI_ASSET_PIPELINE_SCRIPT || '',
      process.env.CODEX_IM_SUITE_ROOT ? path.join(process.env.CODEX_IM_SUITE_ROOT, 'scripts', 'export-glb-asset-package.ps1') : '',
      path.join(process.cwd(), 'scripts', 'export-glb-asset-package.ps1'),
      path.resolve(process.cwd(), '..', '..', 'scripts', 'export-glb-asset-package.ps1'),
      path.resolve(RUNTIME_MODULE_DIR, '..', 'scripts', 'export-glb-asset-package.ps1'),
      path.resolve(RUNTIME_MODULE_DIR, '..', '..', 'scripts', 'export-glb-asset-package.ps1'),
    ].filter(Boolean);
    const hit = candidates.find((candidate) => fs.existsSync(candidate));
    if (hit) return hit;
    throw new Error(`未找到 GLB 资产导出脚本：${candidates.join('; ')}`);
  }

  private async runPowerShellFile(args: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', args, {
        cwd,
        env: process.env,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
      }, timeoutMs);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? 1,
          output: [stdout.trim(), stderr.trim()].filter(Boolean).join('\n'),
        });
      });
    });
  }

  private buildIgnisToolCall(params: StreamChatParams, intent: IgnisIntent | null): { toolName: string; args: Record<string, unknown> } {
    const prompt = params.prompt.trim();
    const state = this.getIgnisSessionState(params.sessionId);
    const replayState = this.resolveIgnisReplayState(params.sessionId);
    const explicitTurnId = extractIgnisTurnId(prompt);
    const explicitFileIds = extractIgnisFileIds(prompt);

    if (intent === 'skills') {
      const query = prompt.match(/(?:query|关键词|搜索)[:：]\s*(.+)$/i)?.[1]?.trim();
      return { toolName: 'ignis_skills', args: query ? { query } : {} };
    }

    if (intent === 'wait') {
      const turnId = explicitTurnId || state?.turnId || replayState?.turnId;
      return {
        toolName: 'ignis_wait',
        args: turnId ? { turn_id: turnId } : { session_id: state?.sessionId || replayState?.sessionId },
      };
    }

    if (intent === 'result') {
      const turnId = explicitTurnId || state?.turnId || replayState?.turnId;
      return {
        toolName: 'ignis_result',
        args: turnId ? { turn_id: turnId } : { session_id: state?.sessionId || replayState?.sessionId },
      };
    }

    if (intent === 'history') {
      const historySessionId = this.resolveIgnisHistorySessionId(params.sessionId);
      return {
        toolName: 'ignis_history',
        args: historySessionId
          ? { session_id: historySessionId, limit: parseIgnisHistoryLimit(prompt) }
          : { limit: parseIgnisHistoryLimit(prompt) },
      };
    }

    if (intent === 'resume' && (explicitTurnId || state?.turnId || replayState?.turnId)) {
      return {
        toolName: 'ignis_resume',
        args: {
          turn_id: explicitTurnId || state?.turnId || replayState?.turnId,
          answers: [prompt],
          async: true,
        },
      };
    }

    const newSession = /(新主题|重新开|新开|另起|分支|new session|--new)/i.test(prompt);
    const hasCurrentAttachments = (params.files?.length || 0) > 0;
    const referencesPriorAsset = hasIgnisPriorAssetReference(prompt);
    const reusableSessionId = (!newSession
      && state?.sessionId
      && (hasIgnisSessionReuseLanguage(prompt) || (referencesPriorAsset && !hasCurrentAttachments)))
      ? state.sessionId
      : '';
    const shouldReuse = reusableSessionId.length > 0;
    const referenceFileIds = explicitFileIds.length > 0
      ? explicitFileIds
      : (!hasCurrentAttachments && referencesPriorAsset ? pickIgnisReferenceFileIds(state, prompt) : []);
    return {
      toolName: 'ignis_ask',
      args: {
        prompt,
        async: true,
        new_session: newSession || !state?.sessionId || !shouldReuse,
        ...(shouldReuse ? { session_id: reusableSessionId } : {}),
        ...(referenceFileIds.length > 0 ? { file_ids: referenceFileIds } : {}),
      },
    };
  }

  private getIgnisSessionState(sessionKey: string): IgnisSessionState | undefined {
    return readIgnisSessionStore()[sessionKey];
  }

  private resolveIgnisReplayState(sessionKey: string): IgnisSessionState | undefined {
    const store = readIgnisSessionStore();
    const current = store[sessionKey];
    if (current && ((current.fileIds?.length || 0) > 0 || current.turnId || current.sessionId)) {
      return current;
    }
    return Object.values(store)
      .filter((item) => item && ((item.fileIds?.length || 0) > 0 || item.turnId || item.sessionId))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0];
  }

  private resolveIgnisHistorySessionId(sessionKey: string): string | undefined {
    const store = readIgnisSessionStore();
    const current = store[sessionKey];
    if (current?.sessionId) return current.sessionId;
    const fallback = Object.values(store)
      .filter((item) => item?.sessionId)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0];
    return fallback?.sessionId;
  }

  private updateIgnisSessionState(sessionKey: string, payload: unknown): void {
    const summary = extractIgnisSummary(payload);
    if (summary.turnIds.length === 0 && summary.sessionIds.length === 0 && summary.canvasIds.length === 0 && summary.fileIds.length === 0) {
      return;
    }
    const store = readIgnisSessionStore();
    const previous = store[sessionKey] || { updatedAt: new Date().toISOString() };
    store[sessionKey] = {
      sessionId: summary.sessionIds[0] || previous.sessionId,
      turnId: summary.turnIds[0] || previous.turnId,
      canvasId: summary.canvasIds[0] || previous.canvasId,
      fileIds: uniq([...(previous.fileIds || []), ...summary.fileIds]).slice(-20),
      updatedAt: new Date().toISOString(),
    };
    writeIgnisSessionStore(store);
  }

  private async tryReplayIgnisStoredResult(
    params: StreamChatParams,
  ): Promise<{ reply: string; assets: IgnisDownloadedAssets } | null> {
    if (!isIgnisReplayRequest(params.prompt)) return null;
    const replayState = this.resolveIgnisReplayState(params.sessionId);
    if (!replayState?.fileIds?.length) return null;

    const selectedFileIds = pickIgnisReplayFileIds(replayState.fileIds, params.prompt);
    if (selectedFileIds.length === 0) return null;

    const assets = await this.downloadIgnisAssets(selectedFileIds);
    const deliveredCount = assets.images.length + assets.files.length;
    const lines = ['Ignis 上次结果已回传。'];
    if (deliveredCount > 0) {
      lines.push(`已回传文件: ${deliveredCount} 个`);
    }
    if (assets.links.length > 0) {
      lines.push('部分文件超过飞书单文件上传限制，下载链接：');
      lines.push(...uniq(assets.links).slice(0, 4));
    } else if (selectedFileIds.length > 0 && deliveredCount === 0) {
      lines.push('生成文件链接：');
      lines.push(...selectedFileIds.slice(0, 4).map((id) => `${IGNIS_CDN_BASE_URL}/${id}`));
    }

    return { reply: lines.join('\n').trim(), assets };
  }

  private formatIgnisReply(
    toolName: string,
    payload: unknown,
    fallbackText: string,
    options: { intent?: IgnisIntent | null; timedOut?: boolean; waitMessage?: string; assets?: IgnisDownloadedAssets } = {},
  ): string {
    if (toolName === 'ignis_history' || options.intent === 'history') {
      const historyReply = this.formatIgnisHistoryReply(payload);
      if (historyReply) return historyReply;
    }
    const summary = extractIgnisSummary(payload);
    const status = getIgnisStatus(payload);
    const lines: string[] = [];
    const deliveredCount = (options.assets?.images.length || 0) + (options.assets?.files.length || 0);
    const label = options.timedOut
      ? 'Ignis 已提交，仍在生成中。'
      : toolName === 'ignis_ask' && status === 'completed' && deliveredCount > 0
        ? 'Ignis 已完成，文件已回传。'
      : toolName === 'ignis_ask' && status === 'completed'
        ? 'Ignis 已完成。'
        : toolName === 'ignis_ask'
          ? 'Ignis 任务已提交。'
          : toolName === 'ignis_wait'
            ? 'Ignis 等待完成。'
            : toolName === 'ignis_result' && (deliveredCount > 0 || summary.fileIds.length > 0)
              ? 'Ignis 上次结果已回传。'
              : toolName === 'ignis_result'
                ? 'Ignis 结果如下。'
              : 'Ignis 调用完成。';
    lines.push(label);
    if (deliveredCount > 0) {
      lines.push(`已回传文件: ${deliveredCount} 个`);
    }
    if (options.assets?.links.length) {
      lines.push('部分文件超过飞书单文件上传限制，下载链接：');
      lines.push(...uniq(options.assets.links).slice(0, 4));
    } else if (summary.fileIds.length > 0 && deliveredCount === 0) {
      lines.push('生成文件链接：');
      lines.push(...summary.fileIds.slice(0, 4).map((id) => `${IGNIS_CDN_BASE_URL}/${id}`));
    }

    const readable = options.intent === 'result' && (deliveredCount > 0 || summary.fileIds.length > 0)
      ? ''
      : this.extractIgnisReadableText(payload);
    if (readable) lines.push('', truncateText(readable, 1200));
    if (options.timedOut) {
      lines.push('', '完成后可以发“查上一个 Ignis 结果”获取最新结果。');
      if (options.waitMessage) lines.push(`状态: ${truncateText(options.waitMessage, 200)}`);
    }
    if (lines.length === 1) {
      let fallbackReadable = '';
      try { fallbackReadable = this.extractIgnisReadableText(parseIgnisToolPayload(fallbackText)); } catch { /* ignore */ }
      lines.push(truncateText(fallbackReadable, 1600) || '调用完成。');
    }
    return lines.join('\n').trim();
  }

  private formatIgnisHistoryReply(payload: unknown): string {
    const data = getIgnisDataObject(payload);
    const turns = extractIgnisHistoryTurns(payload);
    if (turns.length === 0) {
      return '最近没有可整理的 Ignis 记录。';
    }

    const sessionId = typeof data.session_id === 'string' ? data.session_id.trim() : '';
    const total = typeof data.total === 'number' && Number.isFinite(data.total) ? data.total : turns.length;
    const lines = [`Ignis 最近记录（${turns.length}/${total}）`];
    if (sessionId) lines.push(`session: ${sessionId}`);

    turns.slice(0, 10).forEach((turn, index) => {
      const status = typeof turn.status === 'string' ? turn.status.trim() : 'unknown';
      const startedAt = formatIgnisTimeLabel(turn.started_at || turn.updated_at);
      const input = turn.input && typeof turn.input === 'object' ? turn.input as Record<string, unknown> : {};
      const message = typeof input.message === 'string' ? truncateText(input.message, 80) : '';
      const artifactSummary = turn.artifact_summary && typeof turn.artifact_summary === 'object'
        ? turn.artifact_summary as Record<string, unknown>
        : {};
      const artifactCount = typeof artifactSummary.count === 'number' ? artifactSummary.count : 0;
      const toolSummary = turn.tool_summary && typeof turn.tool_summary === 'object'
        ? turn.tool_summary as Record<string, unknown>
        : {};
      const toolNames = Array.isArray(toolSummary.names)
        ? (toolSummary.names as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      const turnId = shortenIgnisId(turn.turn_id);

      lines.push(`${index + 1}. ${startedAt} | ${status}`);
      if (message) lines.push(`   输入: ${message}`);
      lines.push(`   文件: ${artifactCount} 个${toolNames.length > 0 ? ` | 工具: ${toolNames.join(', ')}` : ''}`);
      if (turnId) lines.push(`   turn_id: ${turnId}`);
    });

    return lines.join('\n');
  }

  private extractIgnisReadableText(payload: unknown): string {
    const data = getIgnisDataObject(payload);
    const candidates: string[] = [];
    const assistantMessage = data.assistant_message;
    if (assistantMessage && typeof assistantMessage === 'object') {
      const text = (assistantMessage as Record<string, unknown>).text;
      if (typeof text === 'string' && text.trim()) candidates.push(text.trim());
    }
    const error = data.error;
    if (typeof error === 'string' && error.trim()) candidates.push(error.trim());
    const status = getIgnisStatus(payload);
    if (status && status !== 'completed') candidates.push(`status: ${status}`);

    const visit = (value: unknown, keyHint = ''): void => {
      if (candidates.length >= 8) return;
      if (typeof value === 'string') {
        if (/^(text|content|answer|title|summary)$/i.test(keyHint) && value.trim()) {
          candidates.push(value.trim());
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item, keyHint);
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        visit(nested, key);
      }
    };
    visit(data);
    return uniq(candidates)
      .filter((item) => !/^\s*\{[\s\S]*\}\s*$/.test(item))
      .filter((item) => !/^https?:\/\//i.test(item) && !/\b[A-Za-z0-9_-]{4,}\.(?:png|jpe?g|webp|gif|mp4|mov|glb|gltf|fbx|obj|zip|pdf|md|wav|mp3)\b/i.test(item))
      .slice(0, 3)
      .join('\n');
  }

  private recordIgnisSummary(mode: LocalRouterMode, success: boolean, text: string): void {
    const current = readLocalLlmStatus(this.config);
    appendLocalLlmRouteSummary(this.config, {
      timestamp: new Date().toISOString(),
      mode,
      taskKind: 'tool_request',
      decision: success ? 'answer_local' : 'refuse_local',
      provider: success ? 'local' : 'refuse_local',
      reason: truncateText(text, 240),
      compressedPromptChars: 0,
      compressedHistoryChars: 0,
    }, {
      routeHits: current.routeHits + 1,
      localOnlyAnswers: current.localOnlyAnswers + (mode === 'local_only' && success ? 1 : 0),
      localRefusals: current.localRefusals + (success ? 0 : 1),
    });
    appendLocalLlmExecutionSummary(this.config, {
      timestamp: new Date().toISOString(),
      action: 'answer_only',
      stepCount: 0,
      success,
      provider: 'local_executor',
      reason: 'ignis_mcp',
      summary: truncateText(text, 240),
    }, {
      executionCount: current.executionCount + 1,
      executionFailures: current.executionFailures + (success ? 0 : 1),
    });
  }

  canHandleMcpBridgeFastPath(params: StreamChatParams): boolean {
    return this.canHandleMcpBridgeFastPathV2(params);
  }

  async handleMcpBridgeFastPath(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    mode: LocalRouterMode,
  ): Promise<LocalAgentHandleResult> {
    return this.handleMcpBridgeFastPathV2(controller, params, mode);
  }

  private async handleLegacyMcpBridgeFastPath(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    mode: LocalRouterMode,
  ): Promise<LocalAgentHandleResult> {
    const manifest = this.resolveMcpManifest(params.prompt);
    if (!manifest) {
      return {
        handled: true,
        fallbackToCodex: false,
        fallbackReason: '未识别目标 MCP',
      };
    }

    const prompt = params.prompt.toLowerCase();
    if (/(启动|拉起|连接)/i.test(prompt)) {
      const start = await this.mcpBridge.startService(manifest);
      const health = await this.mcpBridge.checkHealth(manifest);
      const text = start.ok
        ? `${manifest.displayName || manifest.id} 启动检查完成。\n${health.message}`
        : `${manifest.displayName || manifest.id} 启动失败：${start.message}`;
      this.emitTerminalResponse(controller, params.sessionId, text, !start.ok);
      return { handled: true };
    }

    if (/(停止|关闭)/i.test(prompt)) {
      const stop = await this.mcpBridge.stopService(manifest);
      const text = stop.ok
        ? `${manifest.displayName || manifest.id} 已停止。`
        : `${manifest.displayName || manifest.id} 停止失败：${stop.message}`;
      this.emitTerminalResponse(controller, params.sessionId, text, !stop.ok);
      return { handled: true };
    }

    if (/(工具列表|列出.*工具|有哪些工具|tools\/list)/i.test(prompt)) {
      if (manifest.type !== 'http') {
        this.emitTerminalResponse(controller, params.sessionId, `${manifest.displayName || manifest.id} 当前是 stdio MCP。第一版本地桥接已支持启动/健康检查，但还没有直接读取工具列表。`, false);
        return { handled: true };
      }
      const tools = await this.mcpBridge.listHttpTools(manifest);
      this.emitTerminalResponse(controller, params.sessionId, tools.length > 0 ? `${manifest.displayName || manifest.id} 可用工具：\n${tools.join('\n')}` : `${manifest.displayName || manifest.id} 没有返回工具列表。`, false);
      return { handled: true };
    }

    const parsedCall = this.parseHttpToolCall(params.prompt, manifest);
    if (parsedCall) {
      if (manifest.type !== 'http') {
        this.emitTerminalResponse(controller, params.sessionId, `${manifest.displayName || manifest.id} 当前是 stdio MCP。第一版本地桥接还不支持直接 tool call。`, true);
        return { handled: true };
      }
      const result = await this.mcpBridge.callHttpTool(manifest, parsedCall.toolName, parsedCall.args);
      this.emitTerminalResponse(controller, params.sessionId, truncateText(result, 3000), false);
      return { handled: true };
    }

    const health = await this.mcpBridge.checkHealth(manifest);
    this.emitTerminalResponse(controller, params.sessionId, `${manifest.displayName || manifest.id} 状态：${health.message}`, !health.ok && mode === 'local_only');
    return { handled: true };
  }

  canHandleFastPath(params: StreamChatParams, conservative: ConservativeRouteDecision): boolean {
    if (!conservative.useLocal) return false;
    const assessment = assessExecutorInteraction(params.prompt);
    if (assessment.interactionIntent === 'explain') return false;
    return this.buildFastPlan(params, conservative, assessment) !== null;
  }

  async handleFastPath(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    context: LocalAgentHandleContext,
  ): Promise<LocalAgentHandleResult> {
    const plan = this.buildFastPlan(params, context.conservative);
    if (!plan) return { handled: false };
    return this.executePlan(controller, params, context, plan);
  }

  async handleRoutedExecution(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    context: LocalAgentHandleContext,
  ): Promise<LocalAgentHandleResult> {
    const route = context.route;
    if (!route) return { handled: false };
    if (!this.shouldAttemptPlannedExecution(params, route)) return { handled: false };

    const fastPlan = this.buildFastPlan(params, context.conservative);
    if (fastPlan) {
      return this.executePlan(controller, params, context, fastPlan);
    }

    const planned = await this.planWithModel(params, route).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    if ('error' in planned) {
      return {
        handled: false,
        fallbackToCodex: context.mode !== 'local_only',
        fallbackReason: `本地执行计划生成失败：${planned.error}`,
      };
    }
    return this.executePlan(controller, params, context, planned);
  }

  private shouldAttemptPlannedExecution(params: StreamChatParams, route: LocalRouteProtocolResult): boolean {
    const assessment = assessExecutorInteraction(params.prompt);
    if (assessment.interactionIntent === 'explain') return false;
    if (route.taskKind === 'command_draft') return false;
    if (assessment.executionRisk === 'mutating') return canExecuteMutatingFastPath(assessment);
    if (route.taskKind === 'repo_query' || route.taskKind === 'tool_request' || route.taskKind === 'script_draft') return true;
    return assessment.executionRisk === 'read_only' || canExecuteMutatingFastPath(assessment);
  }

  private buildFastPlan(
    params: StreamChatParams,
    conservative: ConservativeRouteDecision,
    assessment = assessExecutorInteraction(params.prompt),
  ): LocalExecutionPlan | null {
    const prompt = params.prompt.trim();
    if (!prompt) return null;
    if (!conservative.useLocal || assessment.interactionIntent === 'explain') return null;

    const allowMutating = canExecuteMutatingFastPath(assessment);

    if ((/\bgit pull\b/i.test(prompt) || /(帮我拉取一下git|帮我 pull|拉取一下 git)/i.test(prompt)) && allowMutating) {
      return {
        action: 'run_shell',
        reason: '执行 Git 拉取',
        taskKind: 'repo_query',
        finalReplyMode: 'concise',
        safetyFlags: ['repo_write'],
        steps: [{ type: 'shell_command', command: 'git pull', requiresPermission: true }],
      };
    }

    if (/\bgit status\b/i.test(prompt) || /(查看.*git.*状态|看一下.*git.*状态|看看.*git.*状态|帮我看看.*git.*状态)/i.test(prompt)) {
      return {
        action: 'run_shell',
        reason: '读取 Git 状态',
        taskKind: 'repo_query',
        finalReplyMode: 'concise',
        safetyFlags: ['read_only'],
        steps: [{ type: 'shell_command', command: 'git status -sb', requiresPermission: false }],
      };
    }

    if ((/\bgit fetch\b/i.test(prompt) || /(同步一下远端|fetch 一下)/i.test(prompt)) && allowMutating) {
      return {
        action: 'run_shell',
        reason: '执行 Git fetch',
        taskKind: 'repo_query',
        finalReplyMode: 'concise',
        safetyFlags: ['repo_sync'],
        steps: [{ type: 'shell_command', command: 'git fetch --all --prune', requiresPermission: true }],
      };
    }

    if (/\bgit branch\b/i.test(prompt) || /(当前分支|branch --show-current)/i.test(prompt)) {
      return {
        action: 'run_shell',
        reason: '查看当前 Git 分支',
        taskKind: 'repo_query',
        finalReplyMode: 'concise',
        safetyFlags: ['read_only'],
        steps: [{ type: 'shell_command', command: 'git branch --show-current', requiresPermission: false }],
      };
    }

    if (/\bgit log\b/i.test(prompt) || /(最近.*提交|最近几条提交)/i.test(prompt)) {
      return {
        action: 'run_shell',
        reason: '读取最近 Git 提交',
        taskKind: 'repo_query',
        finalReplyMode: 'concise',
        safetyFlags: ['read_only'],
        steps: [{ type: 'shell_command', command: 'git log --oneline -n 10', requiresPermission: false }],
      };
    }

    const readMatch = prompt.match(/(?:读取|查看|打开)文件[:：]?\s*(.+)$/i);
    if (readMatch?.[1]) {
      return {
        action: 'multi_step',
        reason: '读取文件内容',
        taskKind: 'tool_request',
        finalReplyMode: 'concise',
        safetyFlags: ['read_only'],
        steps: [{ type: 'read_file', path: readMatch[1].trim(), requiresPermission: false }],
      };
    }

    const searchMatch = prompt.match(/(?:搜索文本|查找字符串|搜索)[:：]?\s*(.+?)\s+(?:在|于)\s+(.+)$/i);
    if (searchMatch?.[1] && searchMatch?.[2]) {
      return {
        action: 'multi_step',
        reason: '搜索文本模式',
        taskKind: 'tool_request',
        finalReplyMode: 'concise',
        safetyFlags: ['read_only'],
        steps: [{ type: 'search_text', pattern: searchMatch[1].trim(), path: searchMatch[2].trim(), requiresPermission: false }],
      };
    }

    return null;
  }

  private resolveMcpManifest(prompt: string): McpManifestRecord | null {
    return this.mcpBridge.resolveManifestFromPrompt(prompt);
  }

  private parseHttpToolCall(prompt: string, manifest: McpManifestRecord): { toolName: string; args: Record<string, unknown> } | null {
    const match = prompt.match(/调用\s+.*?mcp\s*工具\s+([A-Za-z0-9_:-]+)\s*(?:参数|params?)\s*([\s\S]+)$/i);
    if (!match) return null;
    const toolName = match[1].trim();
    const rawArgs = match[2].trim();
    try {
      const parsed = JSON.parse(rawArgs);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('参数必须是 JSON 对象');
      }
      return { toolName, args: parsed as Record<string, unknown> };
    } catch (error) {
      throw new Error(`${manifest.displayName || manifest.id} 工具参数 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async planWithModel(params: StreamChatParams, route: LocalRouteProtocolResult): Promise<LocalExecutionPlan> {
    const messages: LocalModelMessage[] = [
      {
        role: 'system',
        content: [
          '你是本地执行计划器。',
          '只输出一个严格 JSON 对象，不要输出 Markdown，不要解释。',
          '允许的 action: answer_only | run_shell | edit_file | multi_step',
          '允许的 step.type: shell_command | read_file | write_file | search_text',
          '如果请求涉及 Unity、Blender、MCP、飞书文档、图片、附件、跨群发送，必须让 steps 为空并 action=answer_only。',
          '不要伪造任何执行结果；这里只生成计划。',
          '如果是 shell_command，只写可直接执行的命令本体，不要包代码块。',
          '读取文件必须优先用 read_file，搜索文本必须优先用 search_text；不要为了读取或搜索生成 rg、grep、findstr、Get-ChildItem、Select-String 这类 shell_command。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `当前请求:\n${route.compressedPrompt}`,
          route.compressedHistory ? `最近相关历史:\n${route.compressedHistory}` : '',
          `任务类型: ${route.taskKind}`,
          '输出 JSON 字段必须包含: action, reason, taskKind, steps, safetyFlags, finalReplyMode',
        ].filter(Boolean).join('\n\n'),
      },
    ];

    const response = await this.localProvider.complete(messages, {
      temperature: 0,
      maxTokens: 512,
      timeoutMs: Math.max(8000, this.config.localLlmRouterTimeoutMs || 30000),
    });
    return this.parsePlan(response.text, route.taskKind);
  }

  private parsePlan(rawText: string, fallbackTaskKind: LocalTaskKind): LocalExecutionPlan {
    const parsed = JSON.parse(extractJsonObject(rawText)) as Partial<LocalExecutionPlan>;
    const action = (parsed.action || 'answer_only') as LocalExecutionAction;
    if (!['answer_only', 'run_shell', 'edit_file', 'multi_step'].includes(action)) {
      throw new Error('执行计划 action 非法');
    }
    const steps = Array.isArray(parsed.steps) ? parsed.steps.map((step) => this.normalizeStep(step)) : [];
    const reason = truncateText(String(parsed.reason || '本地模型未提供原因'), 180);
    return {
      action,
      reason,
      taskKind: toTaskKind(typeof parsed.taskKind === 'string' ? parsed.taskKind : undefined, fallbackTaskKind),
      steps,
      safetyFlags: Array.isArray(parsed.safetyFlags) ? parsed.safetyFlags.map((item) => String(item)) : [],
      finalReplyMode: String(parsed.finalReplyMode || 'concise'),
    };
  }

  private normalizeStep(rawStep: unknown): LocalExecutionStep {
    if (!rawStep || typeof rawStep !== 'object') throw new Error('执行计划步骤非法');
    const step = rawStep as Record<string, unknown>;
    const type = String(step.type || '');
    switch (type) {
      case 'shell_command':
        if (typeof step.command !== 'string' || !step.command.trim()) throw new Error('shell_command 缺少 command');
        {
          const converted = tryConvertRipgrepCommand(step.command);
          if (converted) return converted;
        }
        return {
          type,
          command: step.command.trim(),
          reason: typeof step.reason === 'string' ? step.reason : undefined,
          requiresPermission: step.requiresPermission !== false,
        };
      case 'read_file':
        if (typeof step.path !== 'string' || !step.path.trim()) throw new Error('read_file 缺少 path');
        return {
          type,
          path: step.path.trim(),
          reason: typeof step.reason === 'string' ? step.reason : undefined,
          requiresPermission: false,
        };
      case 'write_file':
        if (typeof step.path !== 'string' || !step.path.trim()) throw new Error('write_file 缺少 path');
        return {
          type,
          path: step.path.trim(),
          content: String(step.content || ''),
          reason: typeof step.reason === 'string' ? step.reason : undefined,
          requiresPermission: true,
        };
      case 'search_text':
        if (typeof step.path !== 'string' || !step.path.trim()) throw new Error('search_text 缺少 path');
        if (typeof step.pattern !== 'string' || !step.pattern.trim()) throw new Error('search_text 缺少 pattern');
        return {
          type,
          path: step.path.trim(),
          pattern: step.pattern.trim(),
          reason: typeof step.reason === 'string' ? step.reason : undefined,
          requiresPermission: false,
        };
      default:
        throw new Error(`不支持的执行步骤: ${type}`);
    }
  }

  private async executePlan(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    context: LocalAgentHandleContext,
    plan: LocalExecutionPlan,
  ): Promise<LocalAgentHandleResult> {
    if (!this.isPlanAllowed(plan, params)) {
      return {
        handled: false,
        fallbackToCodex: context.mode !== 'local_only',
        fallbackReason: `本地执行计划不被允许：${plan.reason}`,
      };
    }

    const results: StepExecutionResult[] = [];
    const workingDirectory = this.resolveWorkingDirectory(params);
    controller.enqueue(sseEvent('status', {
      provider: 'local_executor',
      routeMode: context.mode,
      routeDecision: context.route?.decision || context.conservative.preferredDecision,
      routeReason: plan.reason,
      executionAction: plan.action,
      stepCount: plan.steps.length,
    }));

    try {
      for (const step of plan.steps) {
        const stepResult = await this.executeStep(controller, params, workingDirectory, step);
        results.push(stepResult);
        if (!stepResult.success) break;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      appendLocalLlmExecutionSummary(this.config, this.makeExecutionSummary(plan, false, reason), {
        executionFailures: this.readExecutionFailures() + 1,
        lastError: reason,
      });
      if (context.mode !== 'local_only') {
        return {
          handled: false,
          fallbackToCodex: true,
          fallbackReason: `本地执行失败：${reason}`,
        };
      }
      this.emitTerminalResponse(controller, params.sessionId, `本地执行失败：${reason}`, true);
      return { handled: true };
    }

    const failed = results.find((item) => !item.success);
    const finalText = this.buildFinalReply(plan, results, failed);
    appendLocalLlmExecutionSummary(this.config, this.makeExecutionSummary(plan, !failed, finalText), {
      executionCount: this.readExecutionCount() + 1,
      executionFailures: this.readExecutionFailures() + (failed ? 1 : 0),
      lastError: failed ? finalText : '',
    });
    this.appendRouteSummary(context, plan, failed ? finalText : '');
    this.emitTerminalResponse(controller, params.sessionId, finalText, !!failed);
    return { handled: true };
  }

  private isPlanAllowed(plan: LocalExecutionPlan, params: StreamChatParams): boolean {
    if (plan.steps.length === 0 && plan.action !== 'answer_only') return false;
    if (plan.taskKind === 'unity_like' || plan.taskKind === 'blender_like' || plan.taskKind === 'doc_like') return false;
    const assessment = assessExecutorInteraction(params.prompt);
    const planRisk = this.getPlanExecutionRisk(plan);
    if (planRisk === 'mutating' && !canExecuteMutatingFastPath(assessment)) return false;
    if (assessment.interactionIntent === 'explain' && plan.steps.length > 0) return false;
    return plan.steps.every((step) => {
      if (step.type === 'shell_command') {
        return !isDangerousInput(step.command).dangerous;
      }
      return true;
    });
  }

  private getPlanExecutionRisk(plan: LocalExecutionPlan): ExecutionRisk {
    let risk: ExecutionRisk = 'none';
    for (const step of plan.steps) {
      if (step.type === 'write_file') return 'mutating';
      if (step.type === 'read_file' || step.type === 'search_text') {
        risk = 'read_only';
        continue;
      }
      if (step.type === 'shell_command') {
        const commandRisk = getExecutorCommandRisk(step.command);
        if (commandRisk === 'mutating') return 'mutating';
        if (commandRisk === 'read_only') risk = 'read_only';
      }
    }
    return risk;
  }

  private async executeStep(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    workingDirectory: string,
    step: LocalExecutionStep,
  ): Promise<StepExecutionResult> {
    switch (step.type) {
      case 'shell_command':
        return this.executeShellStep(controller, params, workingDirectory, step);
      case 'read_file':
        return this.executeReadFileStep(controller, params, workingDirectory, step);
      case 'write_file':
        return this.executeWriteFileStep(controller, params, workingDirectory, step);
      case 'search_text':
        return this.executeSearchTextStep(controller, params, workingDirectory, step);
      default:
        throw new Error(`未知步骤类型: ${(step as { type?: string }).type || 'unknown'}`);
    }
  }

  private async executeShellStep(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    workingDirectory: string,
    step: ShellCommandStep,
  ): Promise<StepExecutionResult> {
    if (step.requiresPermission) {
      const allowed = await this.requestPermission(controller, 'Bash', { command: step.command }, step.reason || '本地执行命令');
      if (!allowed) {
        return { step, success: false, output: '用户拒绝执行命令', isError: true };
      }
    }

    const toolId = crypto.randomUUID();
    controller.enqueue(sseEvent('tool_use', { id: toolId, name: 'Bash', input: { command: step.command } }));
    const output = await this.runShell(step.command, workingDirectory);
    controller.enqueue(sseEvent('tool_result', {
      tool_use_id: toolId,
      content: output.output || `Exit code: ${output.exitCode}`,
      is_error: output.exitCode !== 0,
    }));
    return {
      step,
      success: output.exitCode === 0,
      output: output.output || `Exit code: ${output.exitCode}`,
      isError: output.exitCode !== 0,
    };
  }

  private async executeReadFileStep(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    workingDirectory: string,
    step: ReadFileStep,
  ): Promise<StepExecutionResult> {
    const resolved = this.resolveAllowedPath(step.path, workingDirectory, params);
    const toolId = crypto.randomUUID();
    controller.enqueue(sseEvent('tool_use', { id: toolId, name: 'Read', input: { path: resolved } }));
    const content = truncateText(fs.readFileSync(resolved, 'utf-8'));
    controller.enqueue(sseEvent('tool_result', { tool_use_id: toolId, content, is_error: false }));
    return { step, success: true, output: content };
  }

  private async executeWriteFileStep(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    workingDirectory: string,
    step: WriteFileStep,
  ): Promise<StepExecutionResult> {
    const resolved = this.resolveAllowedPath(step.path, workingDirectory, params);
    const allowed = await this.requestPermission(controller, 'Edit', {
      files: [{ path: resolved, kind: 'write' }],
    }, step.reason || '本地写入文件');
    if (!allowed) {
      return { step, success: false, output: '用户拒绝写入文件', isError: true };
    }
    const toolId = crypto.randomUUID();
    controller.enqueue(sseEvent('tool_use', {
      id: toolId,
      name: 'Edit',
      input: { files: [{ path: resolved, kind: 'write' }] },
    }));
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, step.content, 'utf-8');
    const resultText = `write: ${resolved}`;
    controller.enqueue(sseEvent('tool_result', { tool_use_id: toolId, content: resultText, is_error: false }));
    return { step, success: true, output: resultText };
  }

  private async executeSearchTextStep(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    workingDirectory: string,
    step: SearchTextStep,
  ): Promise<StepExecutionResult> {
    const resolved = this.resolveAllowedPath(step.path, workingDirectory, params);
    const toolId = crypto.randomUUID();
    controller.enqueue(sseEvent('tool_use', {
      id: toolId,
      name: 'Search',
      input: { path: resolved, pattern: step.pattern },
    }));
    const matches = this.searchText(resolved, step.pattern);
    const output = matches.length > 0 ? matches.join('\n') : '未找到匹配';
    controller.enqueue(sseEvent('tool_result', { tool_use_id: toolId, content: output, is_error: false }));
    return { step, success: true, output };
  }

  private async requestPermission(
    controller: ReadableStreamDefaultController<string>,
    toolName: string,
    toolInput: Record<string, unknown>,
    reason: string,
  ): Promise<boolean> {
    if (this.config.autoApprove) return true;
    const permissionRequestId = crypto.randomUUID();
    controller.enqueue(sseEvent('permission_request', {
      permissionRequestId,
      toolName,
      toolInput,
      suggestions: [reason],
    }));
    const resolution = await this.pendingPerms.waitFor(permissionRequestId);
    return resolution.behavior === 'allow';
  }

  private async runShell(command: string, workingDirectory: string): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve, reject) => {
      const isWindows = process.platform === 'win32';
      const fileName = isWindows ? 'powershell.exe' : 'bash';
      const args = isWindows
        ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]
        : ['-lc', command];
      const child = spawn(fileName, args, {
        cwd: workingDirectory,
        env: process.env,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
      }, SHELL_TIMEOUT_MS);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const output = truncateText([stdout.trim(), stderr.trim()].filter(Boolean).join('\n'));
        resolve({ exitCode: code ?? 1, output });
      });
    });
  }

  private resolveWorkingDirectory(params: StreamChatParams): string {
    const roots = this.getAllowedRoots(params);
    const candidate = params.workingDirectory || this.config.defaultWorkDir || process.cwd();
    const resolved = path.resolve(candidate);
    if (!isPathWithinAllowedRoots(resolved, roots)) {
      throw new Error(`工作目录不在允许范围内：${resolved}`);
    }
    return resolved;
  }

  private resolveAllowedPath(rawPath: string, workingDirectory: string, params: StreamChatParams): string {
    const roots = this.getAllowedRoots(params);
    const candidate = path.isAbsolute(rawPath) ? rawPath : path.resolve(workingDirectory, rawPath);
    const resolved = path.resolve(candidate);
    if (!isPathWithinAllowedRoots(resolved, roots)) {
      throw new Error(`路径不在允许范围内：${resolved}`);
    }
    return resolved;
  }

  private getAllowedRoots(params: StreamChatParams): string[] {
    const configured = this.config.allowedWorkspaceRoots || [];
    const extras = params.additionalDirectories || [];
    return [...new Set([
      ...configured,
      ...splitWorkspacePathList(configured.join(';')),
      ...extras,
      params.workingDirectory || '',
      this.config.defaultWorkDir || '',
    ].filter(Boolean).map((item) => path.resolve(item)))];
  }

  private searchText(resolvedPath: string, pattern: string): string[] {
    const stat = fs.statSync(resolvedPath);
    const regex = new RegExp(pattern, 'i');
    const results: string[] = [];
    const visitFile = (filePath: string) => {
      const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (regex.test(line)) {
          results.push(`${filePath}:${index + 1}: ${truncateText(line, 200)}`);
        }
      });
    };

    if (stat.isDirectory()) {
      const queue = [resolvedPath];
      while (queue.length > 0 && results.length < MAX_SEARCH_RESULTS) {
        const dir = queue.shift()!;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const next = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            queue.push(next);
          } else if (entry.isFile()) {
            visitFile(next);
            if (results.length >= MAX_SEARCH_RESULTS) break;
          }
        }
      }
    } else {
      visitFile(resolvedPath);
    }
    return results.slice(0, MAX_SEARCH_RESULTS);
  }

  private buildFinalReply(plan: LocalExecutionPlan, results: StepExecutionResult[], failed?: StepExecutionResult): string {
    if (failed) {
      return `本地执行失败：${firstNonEmptyLine(failed.output) || plan.reason}`;
    }
    if (results.length === 0) {
      return plan.reason || '本地已处理。';
    }
    const summary = results.map((item) => firstNonEmptyLine(item.output)).filter(Boolean).join('\n');
    if (plan.action === 'run_shell') {
      return summary ? `本地执行完成：\n${summary}` : '本地执行完成。';
    }
    return summary || '本地处理完成。';
  }

  private emitTerminalResponse(
    controller: ReadableStreamDefaultController<string>,
    sessionId: string,
    text: string,
    isError: boolean,
  ): void {
    controller.enqueue(sseEvent('text', text));
    controller.enqueue(sseEvent('result', {
      subtype: isError ? 'error' : 'success',
      is_error: isError,
      session_id: sessionId,
      usage: {},
    }));
    controller.close();
  }

  private makeExecutionSummary(plan: LocalExecutionPlan, success: boolean, summaryText: string): LocalLlmExecutionSummary {
    return {
      timestamp: new Date().toISOString(),
      action: plan.action,
      stepCount: plan.steps.length,
      success,
      provider: 'local_executor',
      reason: plan.reason,
      summary: truncateText(summaryText, 240),
    };
  }

  private readExecutionCount(): number {
    return readLocalLlmStatus(this.config).executionCount || 0;
  }

  private readExecutionFailures(): number {
    return readLocalLlmStatus(this.config).executionFailures || 0;
  }

  private appendRouteSummary(context: LocalAgentHandleContext, plan: LocalExecutionPlan, fallbackReason: string): void {
    const current = readLocalLlmStatus(this.config);
    appendLocalLlmRouteSummary(this.config, {
      timestamp: new Date().toISOString(),
      mode: context.mode,
      taskKind: plan.taskKind,
      decision: context.route?.decision || context.conservative.preferredDecision,
      provider: 'local',
      reason: plan.reason,
      compressedPromptChars: context.route?.compressedPrompt.length || context.conservative.compressedPrompt.length,
      compressedHistoryChars: context.route?.compressedHistory.length || context.conservative.compressedHistory.length,
      fallbackReason: fallbackReason || undefined,
    }, {
      routeHits: current.routeHits + 1,
      localOnlyAnswers: current.localOnlyAnswers + (context.mode === 'local_only' ? 1 : 0),
      lastError: fallbackReason ? fallbackReason : '',
    });
  }

  canHandleMcpBridgeFastPathV2(params: StreamChatParams): boolean {
    const assessment = assessMcpInteraction(params.prompt);
    if (assessment.interactionIntent === 'explain') return false;
    return inferMcpFastIntent(params.prompt, assessment) !== null;
  }

  async handleMcpBridgeFastPathV2(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    mode: LocalRouterMode,
  ): Promise<LocalAgentHandleResult> {
    const assessment = assessMcpInteraction(params.prompt);
    const intent = inferMcpFastIntent(params.prompt, assessment);
    if (!intent) return { handled: false };

    const manifest = this.mcpBridge.resolveManifestFromPrompt(params.prompt);
    const hasExplicitTarget = manifest !== null;
    if (!hasExplicitTarget && (intent === 'status' || intent === 'list_tools')) {
      const text = this.buildGenericMcpHelpReply();
      this.recordMcpBridgeSummary(mode, 'answer_local', 'tool_request', text, true);
      this.emitTerminalResponse(controller, params.sessionId, text, false);
      return { handled: true };
    }

    if (!hasExplicitTarget) {
      const text = `请先明确目标 MCP。可用入口：${this.formatAvailableMcpNames()}。`;
      this.recordMcpBridgeSummary(mode, 'refuse_local', 'tool_request', text, false);
      this.emitTerminalResponse(controller, params.sessionId, text, true);
      return { handled: true, fallbackToCodex: false, fallbackReason: text };
    }

    if (!manifest) {
      const text = `未识别目标 MCP。请明确说这些入口之一：${this.formatAvailableMcpNames()}。`;
      this.recordMcpBridgeSummary(mode, 'refuse_local', 'tool_request', text, false);
      this.emitTerminalResponse(controller, params.sessionId, text, true);
      return {
        handled: true,
        fallbackToCodex: false,
        fallbackReason: '未识别目标 MCP',
      };
    }

    if (intent === 'start') {
      const start = await this.mcpBridge.startService(manifest);
      const health = await this.mcpBridge.checkHealth(manifest);
      const text = start.ok
        ? `${manifest.displayName || manifest.id} 启动检查完成。\n${health.message}`
        : `${manifest.displayName || manifest.id} 启动失败：${start.message}`;
      this.recordMcpBridgeSummary(mode, start.ok ? 'answer_local' : 'refuse_local', 'tool_request', text, start.ok);
      this.emitTerminalResponse(controller, params.sessionId, text, !start.ok);
      return { handled: true };
    }

    if (intent === 'stop') {
      const stop = await this.mcpBridge.stopService(manifest);
      const text = stop.ok
        ? `${manifest.displayName || manifest.id} 已停止。`
        : `${manifest.displayName || manifest.id} 停止失败：${stop.message}`;
      this.recordMcpBridgeSummary(mode, stop.ok ? 'answer_local' : 'refuse_local', 'tool_request', text, stop.ok);
      this.emitTerminalResponse(controller, params.sessionId, text, !stop.ok);
      return { handled: true };
    }

    if (intent === 'list_tools') {
      if (manifest.type !== 'http') {
        const text = `${manifest.displayName || manifest.id} 当前是 stdio MCP。第一版本地桥接已支持启动和健康检查，但还没有直接读取工具列表。`;
        this.recordMcpBridgeSummary(mode, 'answer_local', 'tool_request', text, true);
        this.emitTerminalResponse(controller, params.sessionId, text, false);
        return { handled: true };
      }
      const tools = await this.mcpBridge.listHttpTools(manifest);
      const text = tools.length > 0
        ? `${manifest.displayName || manifest.id} 可用工具：\n${tools.join('\n')}`
        : `${manifest.displayName || manifest.id} 没有返回工具列表。`;
      this.recordMcpBridgeSummary(mode, 'answer_local', 'tool_request', text, true);
      this.emitTerminalResponse(controller, params.sessionId, text, false);
      return { handled: true };
    }

    if (intent === 'tool_call') {
      const parsedCall = this.parseHttpToolCallV2(params.prompt, manifest);
      if (!parsedCall) {
        const text = `${manifest.displayName || manifest.id} 工具调用缺少可解析的 JSON 参数。`;
        this.recordMcpBridgeSummary(mode, 'refuse_local', 'tool_request', text, false);
        this.emitTerminalResponse(controller, params.sessionId, text, true);
        return { handled: true };
      }
      if (manifest.type !== 'http') {
        const text = `${manifest.displayName || manifest.id} 当前是 stdio MCP。第一版本地桥接还不支持直接 tool call。`;
        this.recordMcpBridgeSummary(mode, 'refuse_local', 'tool_request', text, false);
        this.emitTerminalResponse(controller, params.sessionId, text, true);
        return { handled: true };
      }
      const result = await this.mcpBridge.callHttpTool(manifest, parsedCall.toolName, parsedCall.args);
      const text = truncateText(result, 3000);
      this.recordMcpBridgeSummary(mode, 'answer_local', 'tool_request', text, true);
      this.emitTerminalResponse(controller, params.sessionId, text, false);
      return { handled: true };
    }

    const health = await this.mcpBridge.checkHealth(manifest);
    const text = `${manifest.displayName || manifest.id} 状态：${health.message}`;
    this.recordMcpBridgeSummary(mode, health.ok ? 'answer_local' : 'refuse_local', 'tool_request', text, health.ok);
    this.emitTerminalResponse(controller, params.sessionId, text, !health.ok && mode === 'local_only');
    return { handled: true };
  }

  private buildGenericMcpHelpReply(): string {
    const examples = this.mcpBridge.listAvailableManifestNames().slice(0, 2);
    const statusExample = examples[0] || 'Blender MCP';
    const toolsExample = examples[1] || examples[0] || 'Unity MCP';
    return [
      `可用 MCP 入口：${this.formatAvailableMcpNames()}。`,
      `要查状态：说“检查一下 ${statusExample} 状态”。`,
      `要看工具：说“${toolsExample} 有哪些工具”。`,
      '要启动或停止：请明确目标 MCP，再说“启动一下”或“停止一下”。',
    ].join('\n');
  }

  private formatAvailableMcpNames(): string {
    const names = this.mcpBridge.listAvailableManifestNames();
    return names.length > 0 ? names.join('、') : '当前没有启用的 MCP manifest';
  }

  private parseHttpToolCallV2(prompt: string, manifest: McpManifestRecord): { toolName: string; args: Record<string, unknown> } | null {
    const match = prompt.match(/调用\s+.*?mcp\s*工具\s+([A-Za-z0-9_:-]+)\s*(?:参数|params?)\s*([\s\S]+)$/i);
    if (!match) return null;
    const toolName = match[1].trim();
    const rawArgs = match[2].trim();
    try {
      const parsed = JSON.parse(rawArgs);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('参数必须是 JSON 对象');
      }
      return { toolName, args: parsed as Record<string, unknown> };
    } catch (error) {
      throw new Error(`${manifest.displayName || manifest.id} 工具参数 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private recordMcpBridgeSummary(
    mode: LocalRouterMode,
    decision: 'answer_local' | 'refuse_local',
    taskKind: LocalTaskKind,
    text: string,
    success: boolean,
  ): void {
    const current = readLocalLlmStatus(this.config);
    appendLocalLlmRouteSummary(this.config, {
      timestamp: new Date().toISOString(),
      mode,
      taskKind,
      decision,
      provider: decision === 'answer_local' ? 'local' : 'refuse_local',
      reason: truncateText(text, 240),
      compressedPromptChars: 0,
      compressedHistoryChars: 0,
    }, {
      routeHits: current.routeHits + 1,
      localOnlyAnswers: current.localOnlyAnswers + (mode === 'local_only' && success ? 1 : 0),
      localRefusals: current.localRefusals + (success ? 0 : 1),
    });
    appendLocalLlmExecutionSummary(this.config, {
      timestamp: new Date().toISOString(),
      action: 'answer_only',
      stepCount: 0,
      success,
      provider: 'local_executor',
      reason: 'mcp_bridge',
      summary: truncateText(text, 240),
    }, {
      executionCount: current.executionCount + 1,
      executionFailures: current.executionFailures + (success ? 0 : 1),
    });
  }
}
