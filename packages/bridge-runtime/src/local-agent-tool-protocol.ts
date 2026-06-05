import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import type { ExecutionRequirementKind } from 'claude-to-im/src/lib/bridge/host.js';
import { maskSecrets } from './logger.js';

export interface JsonToolRequest {
  action: 'tool_request';
  tool: 'list_dir' | 'read_file' | 'search_files' | 'shell' | 'shell_artifact' | 'mcp_call' | 'unity_mcp_execute_code';
  args: Record<string, unknown>;
}

export interface JsonToolResult {
  tool: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface JsonToolHistoryEntry {
  request: JsonToolRequest;
  result: JsonToolResult;
}

export interface JsonToolArtifacts {
  images: string[];
  files: string[];
}

export interface UnityMcpExecuteCodeDefinition {
  id: string;
  displayName?: string;
  match?: {
    keywords?: string[];
    regex?: string[];
    contextualRegex?: string[];
    contextRegex?: string[];
  };
  codeTemplate: string;
  compiler?: 'auto' | 'roslyn' | 'codedom';
  safety_checks?: boolean;
}

export interface McpToolCallDefinition {
  id: string;
  displayName?: string;
  match?: {
    keywords?: string[];
    regex?: string[];
    contextualRegex?: string[];
    contextRegex?: string[];
  };
  manifestHint: string;
  tool: string;
  arguments?: Record<string, unknown>;
}

export interface ShellArtifactDefinition {
  id: string;
  displayName?: string;
  match?: {
    keywords?: string[];
    regex?: string[];
    contextualRegex?: string[];
    contextRegex?: string[];
  };
  command: string;
  cwd?: string;
  timeoutMs?: number;
  artifactPaths?: string[];
}

export interface JsonToolMcpCatalogEntry {
  manifestHint: string;
  displayName?: string;
  tool: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
}

export interface LocalToolProtocolEvidence {
  protocol: 'json_tool_request';
  requestedTool?: string;
  executedTool?: string;
  satisfied: boolean;
  retryAttempted: boolean;
}

export interface DeterministicJsonToolRequestPlan {
  request: JsonToolRequest;
  source: 'runtime_deterministic';
  reason: string;
}

export interface JsonToolValidationOptions {
  workingDirectory?: string;
  allowedRoots: string[];
  contextText?: string;
}

export type JsonToolValidation =
  | { ok: true; request: JsonToolRequest }
  | { ok: false; error: string };

const SUPPORTED_TOOLS = new Set(['list_dir', 'read_file', 'search_files', 'shell', 'shell_artifact', 'mcp_call', 'unity_mcp_execute_code']);
const MAX_READ_FILE_BYTES = 64 * 1024;
const MAX_SEARCH_RESULTS = 80;
const MAX_SHELL_OUTPUT_CHARS = 24 * 1024;
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
const MAX_SHELL_TIMEOUT_MS = 10 * 60_000;
const FINAL_REPLY_FENCE = 'cti-final';
const MAX_FINAL_REPLY_ASSETS = 12;
const DEFAULT_ARTIFACT_SETTLE_TIMEOUT_MS = 3000;
const ARTIFACT_SETTLE_POLL_MS = 100;
const IMAGE_FILE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
const DENIED_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  'auth.json',
  'config.env',
  'credentials.json',
]);

export function isJsonToolProtocolEligible(
  requirement: { kind: ExecutionRequirementKind } | undefined,
  modelSource: string | undefined,
): boolean {
  return modelSource === 'local_api'
    && (requirement?.kind === 'local_read_required' || requirement?.kind === 'tool_required' || requirement?.kind === 'artifact_required');
}

export function buildJsonToolProtocolPrompt(
  requirement: { kind: ExecutionRequirementKind; reason?: string; requiredToolFamilies?: string[] },
  toolCatalog: string[],
  workspaceContext: { workingDirectory?: string; allowedRoots?: string[] },
  mcpToolCatalog: JsonToolMcpCatalogEntry[] = [],
): string {
  const toolSchema = toolCatalog.join('|') || 'list_dir|read_file|search_files';
  const toolGuidance = [
    toolCatalog.includes('unity_mcp_execute_code')
      ? '- Use unity_mcp_execute_code for Unity Editor C# snippets, configured Unity MCP tool aliases, or Unity MCP execute_code requests.'
      : '',
    toolCatalog.includes('mcp_call')
      ? '- Use mcp_call for configured MCP manifest actions such as screenshots or other direct MCP tools.'
      : '',
    toolCatalog.includes('shell')
      ? '- Use shell for concrete OS command/tool execution requested by the user, only when no Unity MCP execution is required.'
      : '',
    toolCatalog.includes('shell_artifact')
      ? '- Use shell_artifact only for configured artifact-producing actions such as a desktop screenshot. It must return real local artifact paths.'
      : '',
    toolCatalog.some((tool) => tool === 'list_dir' || tool === 'read_file' || tool === 'search_files')
      ? '- Use list_dir for directory/folder listing, read_file for one small file, search_files for bounded project search.'
      : '',
  ].filter(Boolean).join('\n');
  return [
    'Local agent JSON tool protocol:',
    '- You must not answer the user yet.',
    '- Output exactly one minified JSON object and no Markdown.',
    `- The JSON schema is {"action":"tool_request","tool":"${toolSchema}","args":{...}}.`,
    toolGuidance,
    '- Do not invent local facts. Request the smallest real tool needed.',
    '- If an exact tool argument such as a path, id, or scene name is unknown, call a read/search/list MCP tool first, then use the returned exact value in the next tool_request.',
    '- You may need multiple tool_request turns. After each tool_result, continue with another tool_request until the user request is actually completed.',
    toolCatalog.includes('mcp_call')
      ? '- For scene switch/load/open requests, read-only scene actions such as get_active or get_loaded_scenes are only probes, not completion. If the target scene path is unknown, use an asset/search tool first, then call the scene load/open action with the exact returned path.'
      : '',
    toolCatalog.includes('mcp_call')
      ? '- When the user names a target scene but does not provide an exact .unity path, the first tool_request should resolve that target path with an asset/search tool. Do not inspect the currently active/loaded scene as the first step for a switch/load/open request.'
      : '',
    `- Requirement: ${requirement.kind}.`,
    requirement.reason ? `- Reason: ${requirement.reason}.` : '',
    `- Available tools: ${toolCatalog.join(', ')}.`,
    `- Working directory: ${workspaceContext.workingDirectory || '(unset)'}.`,
    `- Allowed roots: ${(workspaceContext.allowedRoots || []).join(' | ') || '(working directory only)'}.`,
    formatMcpToolCatalogForPrompt(mcpToolCatalog),
    'Examples:',
    '{"action":"tool_request","tool":"list_dir","args":{"path":"Game","kind":"folders"}}',
    '{"action":"tool_request","tool":"read_file","args":{"path":"README.md"}}',
    '{"action":"tool_request","tool":"search_files","args":{"path":".","query":"WorkflowRun","maxResults":20}}',
    '{"action":"tool_request","tool":"shell","args":{"command":"node --version","cwd":"."}}',
    '{"action":"tool_request","tool":"shell_artifact","args":{"command":"powershell -ExecutionPolicy Bypass -File scripts/capture-desktop-screenshot.ps1","cwd":".","artifactPaths":["C:\\\\Users\\\\admin\\\\.claude-to-im\\\\runtime\\\\captures\\\\desktop-latest.png"]}}',
    '{"action":"tool_request","tool":"mcp_call","args":{"manifestHint":"unitymcp","tool":"manage_camera","arguments":{"action":"screenshot","capture_source":"game_view","include_image":false}}}',
    '{"action":"tool_request","tool":"unity_mcp_execute_code","args":{"code":"return UnityEngine.Application.unityVersion;","compiler":"auto","safety_checks":true}}',
  ].filter(Boolean).join('\n');
}

function formatMcpToolCatalogForPrompt(entries: JsonToolMcpCatalogEntry[]): string {
  if (entries.length === 0) return '';
  const lines = [
    'Available MCP tool schemas for mcp_call:',
    '- Use args: {"manifestHint":"...","tool":"...","arguments":{...}}.',
  ];
  for (const entry of entries.slice(0, 6)) {
    const description = compactPromptText(entry.description || entry.title || '', 180);
    const schema = summarizeJsonSchemaForPrompt(entry.inputSchema);
    lines.push(`- manifestHint=${entry.manifestHint}; tool=${entry.tool}${entry.title ? `; title=${entry.title}` : ''}`);
    if (description) lines.push(`  description=${description}`);
    if (schema) lines.push(`  inputSchema=${schema}`);
  }
  return lines.join('\n');
}

function compactPromptText(value: string, maxLength: number): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength - 1)}…` : compacted;
}

function summarizeJsonSchemaForPrompt(schema: unknown): string {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return '';
  const root = schema as { properties?: unknown; required?: unknown };
  const properties = root.properties && typeof root.properties === 'object' && !Array.isArray(root.properties)
    ? root.properties as Record<string, unknown>
    : {};
  const required = Array.isArray(root.required)
    ? root.required.filter((item): item is string => typeof item === 'string')
    : [];
  const entries = Object.entries(properties).slice(0, 18).map(([key, value]) => {
    const property = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const enumValues = Array.isArray(property.enum)
      ? property.enum.map((item) => String(item)).filter(Boolean).slice(0, 18)
      : [];
    const type = typeof property.type === 'string'
      ? property.type
      : Array.isArray(property.anyOf)
        ? 'any'
        : 'value';
    return enumValues.length > 0
      ? `${key}: enum[${enumValues.join('|')}]`
      : `${key}: ${type}`;
  });
  if (entries.length === 0) return '';
  return compactPromptText([
    `properties={${entries.join('; ')}}`,
    required.length > 0 ? `required=[${required.join(',')}]` : '',
  ].filter(Boolean).join('; '), 620);
}

export function buildToolResultPrompt(result: JsonToolResult, originalUserText: string): string {
  return [
    'A real local read-only tool was executed by the runtime. Answer the user only from this tool result.',
    'If the tool result is an error, say it was not completed and include the concrete blocker.',
    '',
    `Current user request:\n${originalUserText}`,
    '',
    `Tool result JSON:\n${JSON.stringify(result, null, 2)}`,
  ].join('\n');
}

export function buildJsonToolFinalResponsePrompt(
  originalUserText: string,
  toolHistory: JsonToolHistoryEntry[],
  options: { replyStyleHint?: string } = {},
): string {
  const styleHint = options.replyStyleHint?.trim();
  return [
    'Final answer composer for an IM/Feishu user after real tools have already run.',
    '- You are not chatting with the user directly. You are formatting the final answer from the supplied real tool history.',
    '- Answer in Chinese unless the user explicitly asked for another language.',
    '- Output only the final user-facing Markdown body. Do not output JSON, cti-final fences, or protocol names such as JsonTool/tool_request/tool_result.',
    '- The final answer must be outcome-first. Do not include a separate "处理思路" section unless the user explicitly asked for a detailed walkthrough.',
    '- If the action was not completed, start with "未完成：" and name the exact blocker from the tool history.',
    '- Do not paste raw MCP JSON or logs. Extract meaningful fields such as scene name, path, count, created file, screenshot, or error.',
    '- Keep it concise enough for a Feishu card. Markdown is allowed; use bullets or a small table only when it improves readability.',
    '- If local files or images were produced, mention them briefly; the runtime will attach existing artifacts separately.',
    styleHint ? `- Required reply style: ${styleHint}` : '',
    styleHint ? '- Apply the required reply style in the first sentence while preserving truthfulness and not exaggerating the result.' : '',
    '',
    `用户请求：\n${originalUserText}`,
    '',
    `真实工具执行历史：\n${summarizeToolHistoryForPrompt(toolHistory)}`,
  ].join('\n');
}

export function normalizeGeneratedToolFinalText(text: string, fallbackText: string): string {
  let normalized = text.replace(/\r\n/g, '\n').trim();
  const ctiMatch = normalized.match(/```cti-final\s*\n([\s\S]*?)\n```/i);
  if (ctiMatch) {
    try {
      const parsed = JSON.parse(ctiMatch[1].trim()) as { text?: unknown };
      if (typeof parsed.text === 'string' && parsed.text.trim()) normalized = parsed.text.trim();
    } catch {
      normalized = normalized.replace(/```cti-final\s*\n[\s\S]*?\n```/ig, '').trim();
    }
  }
  normalized = normalized.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  normalized = normalized.replace(/\bJsonTool\b|\btool_request\b|\btool_result\b|\bcti-final\b/gi, '').trim();
  normalized = normalized
    .replace(/(?:^|\n)\s*[-*]?\s*未完成[:：]\s*(?:无|没有|none|no)[^\n]*(?=\n|$)/giu, '')
    .trim();
  return isUsableGeneratedToolFinalText(normalized) ? normalized : fallbackText;
}

export function isUsableGeneratedToolFinalText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length < 20) return false;
  if (/"success"\s*:\s*true|^\s*\{[\s\S]*\}\s*$/iu.test(text)) return false;
  if (/\b(JsonTool|tool_request|tool_result|cti-final)\b/iu.test(text)) return false;
  if (/how can i assist|how can i help|got it\.?|有什么可以帮忙|请问有什么可以帮/iu.test(normalized)) return false;
  return true;
}

export function buildCtiFinalToolResponseEnvelope(
  text: string,
  artifacts: JsonToolArtifacts,
  replyMode: 'plain' | 'markdown' = 'markdown',
): string {
  const kind = artifacts.images.length > 0 && artifacts.files.length > 0
    ? 'mixed'
    : artifacts.images.length > 0
      ? 'image'
      : artifacts.files.length > 0
        ? 'file'
        : 'text';
  const envelope = {
    kind,
    text,
    images: artifacts.images,
    files: artifacts.files,
    reply_mode: replyMode,
  };
  return [
    `\`\`\`${FINAL_REPLY_FENCE}`,
    JSON.stringify(envelope),
    '```',
  ].join('\n');
}

export function collectJsonToolArtifacts(result: JsonToolResult): JsonToolArtifacts {
  if (result.tool === 'shell_artifact' && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
    const data = result.data as Record<string, unknown>;
    const explicitArtifacts = collectExistingLocalArtifacts({
      artifacts: data.artifacts,
      artifactPaths: data.artifactPaths,
      images: data.images,
      files: data.files,
    });
    if (explicitArtifacts.images.length > 0 || explicitArtifacts.files.length > 0) return explicitArtifacts;
  }
  return collectExistingLocalArtifacts(result.data);
}

export function buildVisibleToolOutcomeFallback(
  originalUserText: string,
  toolHistory: JsonToolHistoryEntry[],
): string {
  const last = toolHistory[toolHistory.length - 1]?.result;
  if (!last) return '未完成：没有拿到可用的工具执行结果。';
  if (!last.ok) return `未完成：${last.error || '工具执行失败，但没有返回更具体的错误。'}`;

  const outcome = extractReadableOutcome(last);
  const actionSummary = summarizeUserVisibleActions(toolHistory);
  const lines = [
    outcome || '已完成，工具返回成功。',
  ];
  if (actionSummary.length > 0) {
    lines.push('', '依据：', ...actionSummary.map((item) => `- ${item}`));
  } else {
    lines.push('', `依据：已按“${compactPromptText(originalUserText, 80)}”执行真实工具链。`);
  }
  return lines.join('\n');
}

function summarizeToolHistoryForPrompt(toolHistory: JsonToolHistoryEntry[]): string {
  const compact = toolHistory.slice(-4).map(({ request, result }) => ({
    request: {
      tool: request.tool,
      args: request.args,
    },
    result: {
      tool: result.tool,
      ok: result.ok,
      error: result.error,
      data: compactToolResultDataForPrompt(result.data),
    },
  }));
  return maskSecrets(compactPromptText(JSON.stringify(compact, null, 2), 7000));
}

function compactToolResultDataForPrompt(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const record = data as Record<string, unknown>;
  const copy: Record<string, unknown> = { ...record };
  if (typeof copy.result === 'string') {
    const trimmed = copy.result.trim();
    try {
      copy.result = JSON.parse(trimmed);
    } catch {
      copy.result = compactPromptText(trimmed, 2500);
    }
  }
  return copy;
}

function summarizeUserVisibleActions(toolHistory: JsonToolHistoryEntry[]): string[] {
  return toolHistory.map(({ request, result }) => {
    const args = request.args || {};
    const toolName = String(args.tool || request.tool);
    const action = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
      ? String((args.arguments as Record<string, unknown>).action || '')
      : '';
    const status = result.ok ? '成功' : '失败';
    if (request.tool === 'mcp_call') return `调用 ${toolName}${action ? `/${action}` : ''}，结果：${status}。`;
    return `执行 ${request.tool}，结果：${status}。`;
  });
}

function extractReadableOutcome(result: JsonToolResult): string {
  const data = result.data && typeof result.data === 'object' && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : {};
  const parsedResult = typeof data.result === 'string' ? parseMaybeJson(data.result) : data.result;
  if (parsedResult && typeof parsedResult === 'object' && !Array.isArray(parsedResult)) {
    const record = parsedResult as Record<string, unknown>;
    const lines: string[] = [];
    if (typeof record.message === 'string' && record.message.trim()) lines.push(`- ${record.message.trim()}`);
    const payload = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? record.data as Record<string, unknown>
      : {};
    if (typeof payload.name === 'string' && payload.name.trim()) lines.push(`- 名称：${payload.name.trim()}`);
    if (typeof payload.path === 'string' && payload.path.trim()) lines.push(`- 路径：${payload.path.trim()}`);
    if (typeof payload.fullPath === 'string' && payload.fullPath.trim()) lines.push(`- 文件：${payload.fullPath.trim()}`);
    if (typeof payload.totalCount === 'number') lines.push(`- 数量：${payload.totalCount}`);
    if (Array.isArray(payload.assets)) lines.push(`- 匹配资源：${payload.assets.length} 个`);
    if (lines.length > 0) return lines.join('\n');
  }
  if (typeof data.result === 'string' && data.result.trim()) return `- ${compactPromptText(data.result.trim(), 600)}`;
  return '';
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function buildDeterministicToolAnswer(result: JsonToolResult): string | null {
  if (!result.ok) return `未完成：${result.error || '本地只读工具执行失败'}`;
  if (result.tool === 'list_dir' && result.data && typeof result.data === 'object') {
    const data = result.data as { path?: unknown; entries?: unknown };
    if (!Array.isArray(data.entries)) return null;
    const entries = data.entries
      .filter((entry): entry is { name?: unknown; type?: unknown } => !!entry && typeof entry === 'object')
      .map((entry) => ({
        name: typeof entry.name === 'string' ? entry.name : '',
        type: typeof entry.type === 'string' ? entry.type : 'other',
      }))
      .filter((entry) => entry.name);
    const directories = entries.filter((entry) => entry.type === 'directory');
    const files = entries.filter((entry) => entry.type === 'file');
    const lines = [`${String(data.path || '目标目录')} 下检测到：`];
    if (directories.length > 0) {
      lines.push('文件夹：');
      lines.push(...directories.map((entry) => `- ${entry.name}`));
    }
    if (files.length > 0) {
      lines.push('文件：');
      lines.push(...files.map((entry) => `- ${entry.name}`));
    }
    if (entries.length === 0) lines.push('没有子项。');
    return lines.join('\n');
  }
  if (result.tool === 'read_file' && result.data && typeof result.data === 'object') {
    const data = result.data as { path?: unknown; content?: unknown };
    if (typeof data.content !== 'string') return null;
    return `${String(data.path || '文件')} 内容：\n${data.content}`;
  }
  if (result.tool === 'search_files' && result.data && typeof result.data === 'object') {
    const data = result.data as { path?: unknown; results?: unknown };
    if (!Array.isArray(data.results)) return null;
    const lines = [`${String(data.path || '搜索目录')} 的搜索结果：`];
    const results = data.results
      .filter((entry): entry is { path?: unknown; type?: unknown } => !!entry && typeof entry === 'object')
      .map((entry) => String(entry.path || '').trim())
      .filter(Boolean);
    lines.push(...(results.length > 0 ? results.map((item) => `- ${item}`) : ['没有匹配项。']));
    return lines.join('\n');
  }
  if (result.tool === 'shell' && result.data && typeof result.data === 'object') {
    const data = result.data as { command?: unknown; cwd?: unknown; exitCode?: unknown; stdout?: unknown; stderr?: unknown; durationMs?: unknown };
    const lines = [
      `命令执行完成：${String(data.command || '').trim() || '(unknown command)'}`,
      `工作目录：${String(data.cwd || '').trim() || '(unknown cwd)'}`,
      `exitCode：${String(data.exitCode ?? '')}`,
      `耗时：${String(data.durationMs ?? '')}ms`,
    ];
    const stdout = typeof data.stdout === 'string' ? data.stdout.trim() : '';
    const stderr = typeof data.stderr === 'string' ? data.stderr.trim() : '';
    if (stdout) lines.push('', 'stdout:', stdout);
    if (stderr) lines.push('', 'stderr:', stderr);
    if (!stdout && !stderr) lines.push('', '命令没有输出。');
    return lines.join('\n');
  }
  if (result.tool === 'mcp_call' && result.data && typeof result.data === 'object') {
    const data = result.data as { server?: unknown; tool?: unknown; result?: unknown; durationMs?: unknown };
    const resultText = typeof data.result === 'string' ? data.result.trim() : JSON.stringify(data.result ?? '', null, 2);
    return [
      `MCP 工具执行完成：${String(data.server || 'unknown')} / ${String(data.tool || 'unknown')}`,
      `耗时：${String(data.durationMs ?? '')}ms`,
      '',
      resultText || '没有返回内容。',
    ].join('\n');
  }
  if (result.tool === 'unity_mcp_execute_code' && result.data && typeof result.data === 'object') {
    const data = result.data as { result?: unknown; durationMs?: unknown };
    const resultText = typeof data.result === 'string' ? data.result.trim() : JSON.stringify(data.result ?? '', null, 2);
    return [
      'Unity MCP execute_code 执行完成：',
      `耗时：${String(data.durationMs ?? '')}ms`,
      '',
      resultText || '没有返回内容。',
    ].join('\n');
  }
  return null;
}

export function buildCtiFinalToolAnswer(result: JsonToolResult): string | null {
  if (!result.ok) return null;
  const artifacts = collectJsonToolArtifacts(result);
  if (artifacts.images.length === 0 && artifacts.files.length === 0) return null;
  const kind = artifacts.images.length > 0 && artifacts.files.length > 0
    ? 'mixed'
    : artifacts.images.length > 0
      ? 'image'
      : 'file';
  const text = buildToolArtifactSummary(result, artifacts);
  const envelope = {
    kind,
    text,
    images: artifacts.images,
    files: artifacts.files,
    reply_mode: 'plain',
  };
  return [
    `\`\`\`${FINAL_REPLY_FENCE}`,
    JSON.stringify(envelope),
    '```',
  ].join('\n');
}

export async function buildCtiFinalToolAnswerAfterArtifactSettle(
  result: JsonToolResult,
  timeoutMs = DEFAULT_ARTIFACT_SETTLE_TIMEOUT_MS,
): Promise<string | null> {
  const startedAt = Date.now();
  let answer = buildCtiFinalToolAnswer(result);
  while (!answer && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, ARTIFACT_SETTLE_POLL_MS));
    answer = buildCtiFinalToolAnswer(result);
  }
  return answer;
}

function buildToolArtifactSummary(
  result: JsonToolResult,
  artifacts: { images: string[]; files: string[] },
): string {
  const data = result.data && typeof result.data === 'object' ? result.data as { server?: unknown; tool?: unknown; displayName?: unknown } : {};
  const toolLabel = result.tool === 'mcp_call'
    ? `MCP 工具执行完成：${String(data.server || 'unknown')} / ${String(data.tool || 'unknown')}`
    : result.tool === 'shell_artifact'
      ? `本地产物工具执行完成：${String(data.displayName || 'artifact')}`
    : `本地工具执行完成：${result.tool}`;
  const lines = [toolLabel];
  if (artifacts.images.length > 0) {
    lines.push(`图片：${artifacts.images.map((item) => path.basename(item)).join('、')}`);
  }
  if (artifacts.files.length > 0) {
    lines.push(`文件：${artifacts.files.map((item) => path.basename(item)).join('、')}`);
  }
  return lines.join('\n');
}

function collectExistingLocalArtifacts(value: unknown): { images: string[]; files: string[] } {
  const candidates = new Set<string>();
  collectLocalPathCandidates(value, candidates, 0, new Set<object>());
  const emitted = new Set<string>();
  const images: string[] = [];
  const files: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeExistingLocalFilePath(candidate);
    if (!normalized) continue;
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (emitted.has(key)) continue;
    emitted.add(key);
    const ext = path.extname(normalized).toLowerCase();
    if (IMAGE_FILE_EXTENSIONS.has(ext)) images.push(normalized);
    else files.push(normalized);
    if (images.length + files.length >= MAX_FINAL_REPLY_ASSETS) break;
  }
  return { images, files };
}

function collectLocalPathCandidates(
  value: unknown,
  candidates: Set<string>,
  depth: number,
  seen: Set<object>,
): void {
  if (depth > 8 || candidates.size >= MAX_FINAL_REPLY_ASSETS * 4) return;
  if (typeof value === 'string') {
    for (const item of extractPathCandidatesFromString(value)) candidates.add(item);
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        collectLocalPathCandidates(JSON.parse(trimmed), candidates, depth + 1, seen);
      } catch {
        // Non-JSON strings can still contain path candidates collected above.
      }
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectLocalPathCandidates(item, candidates, depth + 1, seen);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/secret|token|password|authorization|cookie/i.test(key)) continue;
    collectLocalPathCandidates(item, candidates, depth + 1, seen);
  }
}

function extractPathCandidatesFromString(value: string): string[] {
  const candidates = new Set<string>();
  const trimmed = value.trim();
  if (trimmed) candidates.add(trimmed);
  const windowsOrPosixPathPattern = /(?:file:\/\/\/?)?(?:[A-Za-z]:[\\/]|\\\\[^\\/\s"'<>|]+[\\/][^\\/\s"'<>|]+[\\/]|\/)[^\r\n"'<>|]*?\.[A-Za-z0-9]{1,8}/g;
  for (const match of value.matchAll(windowsOrPosixPathPattern)) {
    if (match[0]) candidates.add(match[0]);
  }
  return Array.from(candidates);
}

function normalizeExistingLocalFilePath(candidate: string): string | null {
  let normalized = candidate.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!normalized) return null;
  if (/^file:/i.test(normalized)) {
    try {
      normalized = decodeURIComponent(new URL(normalized).pathname);
      if (/^\/[A-Za-z]:\//.test(normalized)) normalized = normalized.slice(1);
    } catch {
      return null;
    }
  }
  normalized = normalized.replace(/[),.;，。；、]+$/u, '');
  if (!path.isAbsolute(normalized)) return null;
  try {
    const stat = fs.statSync(normalized);
    if (!stat.isFile()) return null;
    return path.resolve(normalized);
  } catch {
    return null;
  }
}

export function parseJsonToolRequest(text: string): JsonToolRequest | null {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    if (parsed.action !== 'tool_request') return null;
    if (typeof parsed.tool !== 'string' || !SUPPORTED_TOOLS.has(parsed.tool)) return null;
    if (!parsed.args || typeof parsed.args !== 'object' || Array.isArray(parsed.args)) return null;
    return {
      action: 'tool_request',
      tool: parsed.tool as JsonToolRequest['tool'],
      args: parsed.args as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

export function buildFallbackJsonToolRequest(
  userText: string,
  context: {
    workingDirectory?: string;
    contextText?: string;
    requirementKind?: ExecutionRequirementKind;
    mcpToolCallDefinitions?: McpToolCallDefinition[];
    unityMcpExecuteCodeDefinitions?: UnityMcpExecuteCodeDefinition[];
    shellArtifactDefinitions?: ShellArtifactDefinition[];
  },
): JsonToolRequest | null {
  const text = userText.trim();
  if (!text) return null;
  if (context.requirementKind === 'tool_required' || context.requirementKind === 'artifact_required') {
    const configuredMcpCallRequest = buildConfiguredMcpToolCallRequest(
      text,
      context.mcpToolCallDefinitions || [],
      context,
    );
    if (configuredMcpCallRequest) return configuredMcpCallRequest;

    const configuredUnityMcpRequest = buildConfiguredUnityMcpExecuteCodeRequest(
      text,
      context.unityMcpExecuteCodeDefinitions || [],
      context,
    );
    if (configuredUnityMcpRequest) return configuredUnityMcpRequest;

    const configuredShellArtifactRequest = buildConfiguredShellArtifactRequest(
      text,
      context.shellArtifactDefinitions || [],
      context,
    );
    if (configuredShellArtifactRequest) return configuredShellArtifactRequest;

    const unityCode = extractUnityExecuteCode(text);
    if (unityCode) {
      return {
        action: 'tool_request',
        tool: 'unity_mcp_execute_code',
        args: {
          code: unityCode,
          compiler: 'auto',
          safety_checks: true,
        },
      };
    }
    const command = extractExplicitShellCommand(text);
    if (command) {
      return {
        action: 'tool_request',
        tool: 'shell',
        args: {
          command,
          cwd: inferCommandCwd(command, context.workingDirectory, context.contextText),
        },
      };
    }
  }
  const looksLikeDirectoryList = /(folder|folders|directory|directories|dir|list|列出|文件夹|目录|有哪些|看一眼|查看|看看)/iu.test(text);
  const looksLikeReadFile = /(read|读取|打开).*(file|文件)|\.[a-z0-9]{1,8}\b/iu.test(text);
  const looksLikeSearch = /(search|find|grep|rg|搜索|查找)/iu.test(text);
  const targetPath = inferTargetPath(text, context.workingDirectory, context.contextText);
  const looksLikeDirectoryListClean = /(列出|列一下|有哪些|有什么|看一下|看一眼|看看|查看|目录|文件夹|工作目录|当前目录|本地目录)/iu.test(text);
  const looksLikeReadFileClean = /(read|读取|读一下|打开).*(file|文件)|\.[a-z0-9]{1,8}\b/iu.test(text);
  const looksLikeSearchClean = /(search|find|grep|rg|搜索|搜一下|查找)/iu.test(text);

  if (looksLikeSearch || looksLikeSearchClean) {
    return { action: 'tool_request', tool: 'search_files', args: { path: targetPath || '.', query: inferSearchQuery(text), maxResults: 30 } };
  }
  if ((looksLikeReadFile || looksLikeReadFileClean) && targetPath) {
    return { action: 'tool_request', tool: 'read_file', args: { path: targetPath } };
  }
  if (looksLikeDirectoryList || looksLikeDirectoryListClean) {
    return { action: 'tool_request', tool: 'list_dir', args: { path: targetPath || '.', kind: 'folders' } };
  }
  return null;
}

export function planDeterministicJsonToolRequest(
  userText: string,
  context: {
    workingDirectory?: string;
    contextText?: string;
    requirementKind?: ExecutionRequirementKind;
    mcpToolCallDefinitions?: McpToolCallDefinition[];
    unityMcpExecuteCodeDefinitions?: UnityMcpExecuteCodeDefinition[];
    shellArtifactDefinitions?: ShellArtifactDefinition[];
  },
): DeterministicJsonToolRequestPlan | null {
  const request = buildFallbackJsonToolRequest(userText, context);
  if (!request) return null;

  if (context.requirementKind === 'tool_required' || context.requirementKind === 'artifact_required') {
    if (request.tool === 'mcp_call') {
      return {
        request,
        source: 'runtime_deterministic',
        reason: 'configured MCP tool action manifest',
      };
    }
    if (request.tool === 'unity_mcp_execute_code') {
      return {
        request,
        source: 'runtime_deterministic',
        reason: 'configured Unity MCP manifest or explicit execute_code request',
      };
    }
    if (request.tool === 'shell') {
      return {
        request,
        source: 'runtime_deterministic',
        reason: 'explicit shell command in user request',
      };
    }
    if (request.tool === 'shell_artifact') {
      return {
        request,
        source: 'runtime_deterministic',
        reason: 'configured artifact tool manifest',
      };
    }
    return null;
  }

  if (context.requirementKind === 'local_read_required') {
    if (request.tool === 'list_dir' || request.tool === 'read_file' || request.tool === 'search_files') {
      return {
        request,
        source: 'runtime_deterministic',
        reason: 'bounded local read request inferred from user text and workspace context',
      };
    }
  }

  return null;
}

export function validateJsonToolRequest(request: JsonToolRequest, options: JsonToolValidationOptions): JsonToolValidation {
  if (request.tool === 'shell') return validateShellToolRequest(request, options);
  if (request.tool === 'shell_artifact') return validateShellArtifactToolRequest(request, options);
  if (request.tool === 'mcp_call') return validateMcpCallRequest(request);
  if (request.tool === 'unity_mcp_execute_code') return validateUnityMcpExecuteCodeRequest(request);

  let rawPath = typeof request.args.path === 'string' ? request.args.path.trim() : '';
  if (!rawPath) return { ok: false, error: 'tool request is missing args.path' };
  if (isUnsafePath(rawPath)) return { ok: false, error: 'path is not allowed' };

  const workingDirectory = options.workingDirectory ? path.resolve(options.workingDirectory) : process.cwd();
  const roots = normalizeAllowedRoots(options.allowedRoots.length > 0 ? options.allowedRoots : [workingDirectory]);
  if (!path.isAbsolute(rawPath) && !fs.existsSync(path.join(workingDirectory, rawPath))) {
    const contextMatch = resolveFromContextPaths(rawPath, workingDirectory, options.contextText);
    if (contextMatch) rawPath = contextMatch;
  }
  if (!path.isAbsolute(rawPath) && !fs.existsSync(path.join(workingDirectory, rawPath))) {
    const childMatches = findChildRelativePathMatches(rawPath, workingDirectory);
    if (childMatches.length > 1) {
      return { ok: false, error: `path candidates are not unique: ${childMatches.join(' | ')}` };
    }
    if (childMatches.length === 1) rawPath = childMatches[0];
  }
  const resolvedPath = path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(workingDirectory, rawPath));
  if (!isInsideAnyRoot(resolvedPath, roots)) {
    return { ok: false, error: `path is outside allowed roots: ${resolvedPath}` };
  }
  if (isDeniedSecretPath(resolvedPath)) {
    return { ok: false, error: `path is blocked by local read policy: ${resolvedPath}` };
  }

  const args: Record<string, unknown> = { ...request.args, path: resolvedPath };
  if (request.tool === 'list_dir') {
    const kind = request.args.kind === 'files' || request.args.kind === 'folders' || request.args.kind === 'all'
      ? request.args.kind
      : 'all';
    args.kind = kind;
  }
  if (request.tool === 'search_files') {
    const maxResults = Number(request.args.maxResults ?? 30);
    args.maxResults = Number.isFinite(maxResults) ? Math.min(Math.max(Math.trunc(maxResults), 1), MAX_SEARCH_RESULTS) : 30;
    args.query = typeof request.args.query === 'string' ? request.args.query : '';
    args.glob = typeof request.args.glob === 'string' ? request.args.glob : undefined;
  }

  return { ok: true, request: { ...request, args } };
}

export function executeJsonToolRequest(request: JsonToolRequest): JsonToolResult {
  try {
    switch (request.tool) {
      case 'list_dir':
        return executeListDir(request);
      case 'read_file':
        return executeReadFile(request);
      case 'search_files':
        return executeSearchFiles(request);
      case 'shell':
        return executeShell(request);
      case 'shell_artifact':
        return executeShellArtifact(request);
      case 'mcp_call':
        return { tool: request.tool, ok: false, error: 'mcp_call must be executed by the MCP bridge' };
      case 'unity_mcp_execute_code':
        return { tool: request.tool, ok: false, error: 'unity_mcp_execute_code must be executed by the MCP bridge' };
      default:
        return { tool: String((request as { tool?: unknown }).tool || ''), ok: false, error: 'unsupported tool' };
    }
  } catch (error) {
    return {
      tool: request.tool,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateMcpCallRequest(request: JsonToolRequest): JsonToolValidation {
  const manifestHint = typeof request.args.manifestHint === 'string' ? request.args.manifestHint.trim() : '';
  const tool = typeof request.args.tool === 'string' ? request.args.tool.trim() : '';
  const rawArguments = request.args.arguments;
  const args = rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
    ? rawArguments as Record<string, unknown>
    : {};
  if (!manifestHint) return { ok: false, error: 'mcp_call request is missing args.manifestHint' };
  if (!/^[\p{L}\p{N}_ .-]{2,80}$/u.test(manifestHint)) return { ok: false, error: 'mcp_call args.manifestHint contains unsupported characters' };
  if (!tool) return { ok: false, error: 'mcp_call request is missing args.tool' };
  if (!/^[A-Za-z0-9_.-]{2,80}$/.test(tool)) return { ok: false, error: 'mcp_call args.tool contains unsupported characters' };
  const serializedArguments = JSON.stringify(args);
  if (serializedArguments.length > 16_000) return { ok: false, error: 'mcp_call args.arguments is too large' };
  return {
    ok: true,
    request: {
      ...request,
      args: {
        manifestHint,
        tool,
        arguments: args,
      },
    },
  };
}

function validateUnityMcpExecuteCodeRequest(request: JsonToolRequest): JsonToolValidation {
  const code = typeof request.args.code === 'string' ? request.args.code.trim() : '';
  if (!code) return { ok: false, error: 'unity_mcp_execute_code request is missing args.code' };
  if (code.length > 16_000) return { ok: false, error: 'unity_mcp_execute_code args.code is too long' };
  if (/\b(?:System\.IO\.File\.Delete|Directory\.Delete|Process\.Start|File\.WriteAllBytes|File\.WriteAllText)\b/i.test(code)) {
    return { ok: false, error: 'unity_mcp_execute_code contains blocked high-risk API usage' };
  }
  const compiler = request.args.compiler === 'roslyn' || request.args.compiler === 'codedom' ? request.args.compiler : 'auto';
  const safetyChecks = request.args.safety_checks === false ? false : true;
  return {
    ok: true,
    request: {
      ...request,
      args: {
        code,
        compiler,
        safety_checks: safetyChecks,
      },
    },
  };
}

function validateShellToolRequest(request: JsonToolRequest, options: JsonToolValidationOptions): JsonToolValidation {
  const command = typeof request.args.command === 'string' ? request.args.command.trim() : '';
  if (!command) return { ok: false, error: 'shell tool request is missing args.command' };
  if (command.length > 4000) return { ok: false, error: 'shell command is too long' };

  const workingDirectory = options.workingDirectory ? path.resolve(options.workingDirectory) : process.cwd();
  const roots = normalizeAllowedRoots(options.allowedRoots.length > 0 ? options.allowedRoots : [workingDirectory]);
  const rawCwd = typeof request.args.cwd === 'string' && request.args.cwd.trim()
    ? request.args.cwd.trim()
    : inferCommandCwd(command, workingDirectory);
  if (isUnsafePath(rawCwd)) return { ok: false, error: 'shell cwd is not allowed' };
  const cwd = path.resolve(path.isAbsolute(rawCwd) ? rawCwd : path.join(workingDirectory, rawCwd));
  if (!isInsideAnyRoot(cwd, roots)) {
    return { ok: false, error: `shell cwd is outside allowed roots: ${cwd}` };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return { ok: false, error: `shell cwd does not exist: ${cwd}` };
  }
  if (!stat.isDirectory()) return { ok: false, error: `shell cwd is not a directory: ${cwd}` };

  const requestedTimeout = Number(request.args.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(Math.max(Math.trunc(requestedTimeout), 1000), MAX_SHELL_TIMEOUT_MS)
    : DEFAULT_SHELL_TIMEOUT_MS;

  return { ok: true, request: { ...request, args: { ...request.args, command, cwd, timeoutMs } } };
}

function validateShellArtifactToolRequest(request: JsonToolRequest, options: JsonToolValidationOptions): JsonToolValidation {
  const shellValidation = validateShellToolRequest(request, options);
  if (!shellValidation.ok) return shellValidation;

  const workingDirectory = options.workingDirectory ? path.resolve(options.workingDirectory) : process.cwd();
  const roots = normalizeAllowedRoots(options.allowedRoots.length > 0 ? options.allowedRoots : [workingDirectory]);
  const rawArtifactPaths = Array.isArray(request.args.artifactPaths)
    ? request.args.artifactPaths.filter((item): item is string => typeof item === 'string')
    : [];
  const artifactPaths: string[] = [];
  for (const rawPath of rawArtifactPaths) {
    const trimmed = rawPath.trim();
    if (!trimmed) continue;
    if (isUnsafePath(trimmed)) return { ok: false, error: 'shell_artifact path is not allowed' };
    const resolved = path.resolve(path.isAbsolute(trimmed) ? trimmed : path.join(workingDirectory, trimmed));
    if (!isInsideAnyRoot(resolved, roots)) {
      return { ok: false, error: `shell_artifact path is outside allowed roots: ${resolved}` };
    }
    artifactPaths.push(resolved);
  }
  if (artifactPaths.length === 0) return { ok: false, error: 'shell_artifact request is missing args.artifactPaths' };
  return {
    ok: true,
    request: {
      ...shellValidation.request,
      args: {
        ...shellValidation.request.args,
        artifactPaths,
        displayName: typeof request.args.displayName === 'string' ? request.args.displayName : undefined,
      },
    },
  };
}

function executeShell(request: JsonToolRequest): JsonToolResult {
  const command = String(request.args.command || '');
  const cwd = String(request.args.cwd || process.cwd());
  const timeoutMs = Number(request.args.timeoutMs || DEFAULT_SHELL_TIMEOUT_MS);
  const startedAt = Date.now();
  const output = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  const durationMs = Date.now() - startedAt;
  const stdout = truncateToolOutput(maskSecrets(String(output.stdout || '')));
  const stderr = truncateToolOutput(maskSecrets(String(output.stderr || '')));
  const exitCode = typeof output.status === 'number'
    ? output.status
    : output.error && output.error.name === 'ETIMEDOUT'
      ? 124
      : 1;
  const error = output.error
    ? output.error.name === 'ETIMEDOUT'
      ? `shell command timed out after ${timeoutMs}ms`
      : output.error.message
    : exitCode === 0
      ? undefined
      : `shell command exited with code ${exitCode}`;
  return {
    tool: request.tool,
    ok: exitCode === 0 && !output.error,
    data: { command, cwd, exitCode, stdout, stderr, durationMs },
    error,
  };
}

function executeShellArtifact(request: JsonToolRequest): JsonToolResult {
  const shellResult = executeShell(request);
  const artifactPaths = Array.isArray(request.args.artifactPaths)
    ? request.args.artifactPaths.filter((item): item is string => typeof item === 'string')
    : [];
  const artifacts = artifactPaths
    .map((artifactPath) => path.resolve(artifactPath))
    .filter((artifactPath) => {
      try {
        return fs.statSync(artifactPath).isFile();
      } catch {
        return false;
      }
    });
  const data = shellResult.data && typeof shellResult.data === 'object'
    ? shellResult.data as Record<string, unknown>
    : {};
  return {
    tool: request.tool,
    ok: shellResult.ok && artifacts.length > 0,
    data: {
      ...data,
      artifactPaths,
      artifacts,
      displayName: typeof request.args.displayName === 'string' ? request.args.displayName : undefined,
    },
    error: shellResult.ok && artifacts.length === 0
      ? `shell_artifact did not create expected artifact: ${artifactPaths.join(' | ')}`
      : shellResult.error,
  };
}

function executeListDir(request: JsonToolRequest): JsonToolResult {
  const target = String(request.args.path || '');
  const kind = request.args.kind === 'files' || request.args.kind === 'folders' ? request.args.kind : 'all';
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return { tool: request.tool, ok: false, error: `not a directory: ${target}` };
  const entries = fs.readdirSync(target, { withFileTypes: true })
    .filter((entry) => {
      if (kind === 'folders') return entry.isDirectory();
      if (kind === 'files') return entry.isFile();
      return true;
    })
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  return { tool: request.tool, ok: true, data: { path: target, entries } };
}

function executeReadFile(request: JsonToolRequest): JsonToolResult {
  const target = String(request.args.path || '');
  const stat = fs.statSync(target);
  if (!stat.isFile()) return { tool: request.tool, ok: false, error: `not a file: ${target}` };
  if (stat.size > MAX_READ_FILE_BYTES) {
    return { tool: request.tool, ok: false, error: `file is too large for local read protocol: ${stat.size} bytes` };
  }
  return {
    tool: request.tool,
    ok: true,
    data: {
      path: target,
      size: stat.size,
      content: fs.readFileSync(target, 'utf-8'),
    },
  };
}

function executeSearchFiles(request: JsonToolRequest): JsonToolResult {
  const root = String(request.args.path || '');
  const query = String(request.args.query || '').toLowerCase();
  const maxResults = Number(request.args.maxResults || 30);
  const results: Array<{ path: string; type: 'directory' | 'file' }> = [];
  walk(root, (itemPath, dirent) => {
    if (results.length >= maxResults) return false;
    const relative = path.relative(root, itemPath) || path.basename(itemPath);
    if (!query || relative.toLowerCase().includes(query)) {
      results.push({
        path: itemPath,
        type: dirent.isDirectory() ? 'directory' : 'file',
      });
    }
    return true;
  });
  return { tool: request.tool, ok: true, data: { path: root, query, results } };
}

function walk(root: string, visit: (itemPath: string, dirent: fs.Dirent) => boolean): void {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const itemPath = path.join(root, entry.name);
    const shouldContinue = visit(itemPath, entry);
    if (shouldContinue === false) return;
    if (entry.isDirectory()) walk(itemPath, visit);
  }
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : null;
}

function extractExplicitShellCommand(text: string): string | null {
  const fenced = text.match(/```(?:powershell|pwsh|bash|sh|cmd)?\s*([\s\S]*?)```/i);
  const source = (fenced?.[1] || text).trim();
  const start = source.search(/\b(?:powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd\s*\/c|git|npm|npx|node|python|py|dotnet|rg)\b/i);
  if (start < 0) return null;
  const raw = source.slice(start).trim();
  const powershellFile = raw.match(/^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+.*?-File\s+(?:"[^"]+"|'[^']+'|\S+)(?:\s+[A-Za-z0-9_.:/\\=-]+)*/i);
  if (powershellFile?.[0]) return powershellFile[0].trim();
  return raw
    .replace(/\s+(?:检查一下|检查|总结|并总结|帮我|看一下|看看|发给我|告诉我)[\s\S]*$/u, '')
    .trim();
}

function extractUnityExecuteCode(text: string): string | null {
  const jsonText = extractJsonObject(text);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const action = typeof parsed.action === 'string' ? parsed.action : '';
      const code = typeof parsed.code === 'string'
        ? parsed.code
        : parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args) && typeof (parsed.args as { code?: unknown }).code === 'string'
          ? String((parsed.args as { code?: unknown }).code)
          : '';
      if (code && (action === 'execute' || action === 'tool_request' || /execute_code/i.test(text))) return code.trim();
    } catch {
      // continue with text patterns
    }
  }

  const fenced = text.match(/```(?:csharp|cs|c#)?\s*([\s\S]*?)```/i);
  if (fenced?.[1] && /return\s+|UnityEngine|GameObject|AssetDatabase|EditorUtility|Selection|SceneManager/.test(fenced[1])) {
    return fenced[1].trim();
  }

  return null;
}

function buildConfiguredUnityMcpExecuteCodeRequest(
  text: string,
  definitions: UnityMcpExecuteCodeDefinition[],
  context?: { workingDirectory?: string; contextText?: string },
): JsonToolRequest | null {
  for (const definition of definitions) {
    if (!definition.codeTemplate.trim()) continue;
    if (!matchesUnityMcpDefinition(text, definition, context)) continue;
    return {
      action: 'tool_request',
      tool: 'unity_mcp_execute_code',
      args: {
        code: definition.codeTemplate,
        compiler: definition.compiler || 'auto',
        safety_checks: definition.safety_checks !== false,
      },
    };
  }
  return null;
}

function buildConfiguredMcpToolCallRequest(
  text: string,
  definitions: McpToolCallDefinition[],
  context?: { workingDirectory?: string; contextText?: string },
): JsonToolRequest | null {
  for (const definition of definitions) {
    if (!definition.manifestHint.trim() || !definition.tool.trim()) continue;
    if (!matchesToolDefinition(text, definition, context)) continue;
    return {
      action: 'tool_request',
      tool: 'mcp_call',
      args: {
        manifestHint: definition.manifestHint,
        tool: definition.tool,
        arguments: definition.arguments || {},
      },
    };
  }
  return null;
}

function buildConfiguredShellArtifactRequest(
  text: string,
  definitions: ShellArtifactDefinition[],
  context?: { workingDirectory?: string; contextText?: string },
): JsonToolRequest | null {
  for (const definition of definitions) {
    if (!definition.command.trim()) continue;
    if (!matchesToolDefinition(text, definition, context)) continue;
    return {
      action: 'tool_request',
      tool: 'shell_artifact',
      args: {
        command: definition.command,
        cwd: definition.cwd || '.',
        timeoutMs: definition.timeoutMs,
        artifactPaths: definition.artifactPaths || [],
        displayName: definition.displayName || definition.id,
      },
    };
  }
  return null;
}

function matchesUnityMcpDefinition(
  text: string,
  definition: UnityMcpExecuteCodeDefinition,
  context?: { workingDirectory?: string; contextText?: string },
): boolean {
  return matchesToolDefinition(text, definition, context);
}

function matchesToolDefinition(
  text: string,
  definition: { match?: { keywords?: string[]; regex?: string[]; contextualRegex?: string[]; contextRegex?: string[] } },
  context?: { workingDirectory?: string; contextText?: string },
): boolean {
  const match = definition.match || {};
  const lowerText = text.toLowerCase();
  const keywords = (match.keywords || []).map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (keywords.length > 0 && keywords.every((keyword) => lowerText.includes(keyword))) return true;
  for (const pattern of match.regex || []) {
    try {
      if (new RegExp(pattern, 'iu').test(text)) return true;
    } catch {
      continue;
    }
  }
  const contextualRegex = (match.contextualRegex || []).map((item) => item.trim()).filter(Boolean);
  const contextRegex = (match.contextRegex || []).map((item) => item.trim()).filter(Boolean);
  if (contextualRegex.length > 0 && contextRegex.length > 0) {
    const contextText = [
      context?.workingDirectory || '',
      context?.contextText || '',
    ].filter(Boolean).join('\n');
    if (contextText) {
      const textMatched = contextualRegex.some((pattern) => {
        try {
          return new RegExp(pattern, 'iu').test(text);
        } catch {
          return false;
        }
      });
      const contextMatched = textMatched && contextRegex.some((pattern) => {
        try {
          return new RegExp(pattern, 'iu').test(contextText);
        } catch {
          return false;
        }
      });
      if (contextMatched) return true;
    }
  }
  return false;
}

function inferCommandCwd(command: string, workingDirectory?: string, contextText?: string): string {
  const fromCommand = command.match(/[a-zA-Z]:\\[^\s"']+/u)
    || command.match(/"([a-zA-Z]:\\[^"]+)"/u)
    || command.match(/'([a-zA-Z]:\\[^']+)'/u);
  const commandPath = (fromCommand?.[1] || fromCommand?.[0] || '').trim();
  if (commandPath) {
    const assetsIndex = commandPath.toLowerCase().indexOf(`${path.sep.toLowerCase()}assets${path.sep.toLowerCase()}`);
    if (assetsIndex > 0) return commandPath.slice(0, assetsIndex);
    try {
      const stat = fs.existsSync(commandPath) ? fs.statSync(commandPath) : null;
      if (stat?.isFile()) return path.dirname(commandPath);
      if (stat?.isDirectory()) return commandPath;
    } catch {
      // fall through to context
    }
  }
  if (workingDirectory && contextText) {
    const contextPath = resolveFromContextPaths('.', workingDirectory, contextText);
    if (contextPath) return path.join(workingDirectory, contextPath);
  }
  return workingDirectory || process.cwd();
}

function inferTargetPath(text: string, workingDirectory?: string, contextText?: string): string {
  const normalized = text.replace(/[，。？?！!：:；;]/g, ' ');
  const quoted = normalized.match(/["'`“”‘’]([^"'`“”‘’]+)["'`“”‘’]/u);
  if (quoted?.[1]) return quoted[1].trim();
  const windowsPath = normalized.match(/[a-zA-Z]:\\[^\s]+/u);
  if (windowsPath?.[0]) return windowsPath[0].trim();
  const gameMatch = normalized.match(/Game/iu);
  if (gameMatch) return 'Game';
  const assetMatch = normalized.match(/\b(Assets|Packages|ProjectSettings|Library|Scripts|Scenes)\b/u);
  if (assetMatch?.[1]) return resolveNestedRelativePath(assetMatch[1], workingDirectory, contextText);
  if (workingDirectory && /工作目录|当前目录|本地目录|working\s*directory/iu.test(text)) return '.';
  if (workingDirectory && /工作目录|working\s*directory|当前目录|本地目录/iu.test(text)) return '.';
  return '.';
}

function resolveNestedRelativePath(relativePath: string, workingDirectory?: string, contextText?: string): string {
  if (!workingDirectory || path.isAbsolute(relativePath)) return relativePath;
  if (fs.existsSync(path.join(workingDirectory, relativePath))) return relativePath;

  const contextMatch = resolveFromContextPaths(relativePath, workingDirectory, contextText);
  if (contextMatch) return contextMatch;

  let childMatches: string[] = [];
  try {
    childMatches = findChildRelativePathMatches(relativePath, workingDirectory);
  } catch {
    childMatches = [];
  }
  if (childMatches.length === 1) return childMatches[0];

  return relativePath;
}

function findChildRelativePathMatches(relativePath: string, workingDirectory: string): string[] {
  return fs.readdirSync(workingDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(entry.name, relativePath))
    .filter((candidate) => fs.existsSync(path.join(workingDirectory, candidate)));
}

function resolveFromContextPaths(relativePath: string, workingDirectory: string, contextText?: string): string | null {
  if (!contextText) return null;
  const root = path.resolve(workingDirectory);
  const escapedRoot = escapeRegExp(root);
  const candidates = Array.from(new Set(
    Array.from(contextText.matchAll(new RegExp(`${escapedRoot}(?:\\\\[^\\s"'“”‘’]+)*`, 'giu')))
      .map((match) => match[0])
      .filter((candidate) => candidate.length > root.length),
  ));
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const candidatePath = fs.existsSync(path.join(resolved, relativePath))
      ? path.join(resolved, relativePath)
      : fs.existsSync(resolved) && path.basename(resolved).toLowerCase() === relativePath.toLowerCase()
        ? resolved
        : null;
    if (!candidatePath) continue;
    const rel = path.relative(root, candidatePath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inferSearchQuery(text: string): string {
  const quoted = text.match(/["'`“”‘’]([^"'`“”‘’]+)["'`“”‘’]/u);
  if (quoted?.[1]) return quoted[1].trim();
  return text.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function truncateToolOutput(text: string): string {
  if (text.length <= MAX_SHELL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_SHELL_OUTPUT_CHARS)}\n...[truncated ${text.length - MAX_SHELL_OUTPUT_CHARS} chars]`;
}

function normalizeAllowedRoots(roots: string[]): string[] {
  return Array.from(new Set(
    roots
      .map((root) => root.trim())
      .filter(Boolean)
      .map((root) => path.resolve(root).toLowerCase()),
  ));
}

function isInsideAnyRoot(candidate: string, roots: string[]): boolean {
  const normalized = path.resolve(candidate).toLowerCase();
  return roots.some((root) => normalized === root || normalized.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`));
}

function isUnsafePath(rawPath: string): boolean {
  return rawPath.startsWith('\\\\') || rawPath.startsWith('//') || rawPath.includes('\0');
}

function isDeniedSecretPath(candidate: string): boolean {
  return candidate.split(/[\\/]+/).some((part) => DENIED_BASENAMES.has(part.toLowerCase()));
}
