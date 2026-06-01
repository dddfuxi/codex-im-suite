import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import type { Config } from './config.js';
import {
  buildTurnPrompt,
  ensureBridgeCodexHome,
  getReasoningEffort,
  getSandboxMode,
  normalizeAdditionalDirectories,
  resolveWorkingDirectory,
  sanitizeLocalApiEnv,
  shouldSkipGitRepoCheck,
  toTextEnv,
  type CodexProviderProfile,
} from './codex-provider.js';
import { getLocalCodexProviderAdapter, type LocalCodexProviderAdapter } from './local-codex-provider-registry.js';
import { McpBridge, type McpManifestRecord, type McpToolInfo } from './mcp-bridge.js';
import { loadMcpToolCallDefinitions, loadUnityMcpExecuteCodeDefinitions } from './local-agent-tool-registry.js';
import {
  buildJsonToolProtocolPrompt,
  buildCtiFinalToolResponseEnvelope,
  buildJsonToolFinalResponsePrompt,
  buildVisibleToolOutcomeFallback,
  collectJsonToolArtifacts,
  buildFallbackJsonToolRequest,
  executeJsonToolRequest,
  isJsonToolProtocolEligible,
  normalizeGeneratedToolFinalText,
  parseJsonToolRequest,
  planDeterministicJsonToolRequest,
  validateJsonToolRequest,
  type JsonToolArtifacts,
  type JsonToolHistoryEntry,
  type JsonToolMcpCatalogEntry,
  type JsonToolResult,
  type JsonToolRequest,
} from './local-agent-tool-protocol.js';
import { sseEvent } from './sse-utils.js';

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const MAX_JSON_TOOL_STEPS = 4;

function localModelName(config: Config): string {
  return (config.localAiModel || config.ollamaModel || config.localLlmModel || 'qwen2.5-coder:7b').trim() || 'qwen2.5-coder:7b';
}

function localBaseUrl(config: Config, adapter: LocalCodexProviderAdapter): string {
  return adapter.normalizeBaseUrl(config.localAiBaseUrl || config.ollamaBaseUrl || config.localLlmBaseUrl);
}

function makeTempPath(prefix: string, ext: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

function appendIfText(value: unknown, parts: string[]): void {
  if (typeof value === 'string' && value) parts.push(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeUsage(
  left: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null,
  right: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null,
): { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null {
  if (!left) return right;
  if (!right) return left;
  return {
    input_tokens: (left.input_tokens || 0) + (right.input_tokens || 0),
    output_tokens: (left.output_tokens || 0) + (right.output_tokens || 0),
    cache_read_input_tokens: (left.cache_read_input_tokens || 0) + (right.cache_read_input_tokens || 0),
    cache_creation_input_tokens: (left.cache_creation_input_tokens || 0) + (right.cache_creation_input_tokens || 0),
  };
}

function rankMcpToolDetails(prompt: string, manifest: McpManifestRecord, tools: McpToolInfo[]): McpToolInfo[] {
  const normalizedPrompt = prompt.toLowerCase();
  const promptTokens = Array.from(new Set([
    ...normalizedPrompt.split(/[^a-z0-9_]+/).filter((item) => item.length >= 3),
    ...(/场景|scene|hsscene/i.test(prompt) ? ['scene', 'asset', 'load', 'search'] : []),
    ...(/截图|图片|game|camera|相机|capture/i.test(prompt) ? ['camera', 'screenshot', 'capture'] : []),
    ...(/物体|节点|gameobject|prefab|预制体/i.test(prompt) ? ['gameobject', 'prefab', 'find'] : []),
  ]));
  const scored = tools.map((tool, index) => {
    const haystack = `${tool.name} ${tool.title || ''} ${tool.description || ''}`.toLowerCase();
    let score = 0;
    for (const token of promptTokens) {
      if (haystack.includes(token)) score += token.length;
    }
    if (/场景|scene|hsscene/i.test(prompt) && /manage_(scene|asset)|find_in_file/.test(tool.name)) score += 30;
    if (/截图|图片|game|camera|相机|capture/i.test(prompt) && /manage_camera/.test(tool.name)) score += 30;
    if (/物体|节点|gameobject/i.test(prompt) && /find_gameobjects|manage_gameobject/.test(tool.name)) score += 30;
    if (/execute_code|batch_execute/.test(tool.name)) score += 4;
    return { tool, score, index };
  });
  const relevant = scored.filter((item) => item.score > 0);
  const candidates = relevant.length > 0 ? relevant : scored;
  const maxTools = /场景|scene|hsscene|截图|图片|game|camera|相机|capture|物体|节点|gameobject|prefab|预制体/i.test(prompt) ? 6 : 8;
  return candidates
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maxTools)
    .map((item) => item.tool);
}

function shouldCompleteJsonToolTask(userText: string, request: JsonToolRequest, result: JsonToolResult): boolean {
  if (!result.ok) return true;
  if (request.tool !== 'mcp_call') return true;
  const toolName = typeof request.args.tool === 'string' ? request.args.tool : '';
  const toolArgs = request.args.arguments && typeof request.args.arguments === 'object' && !Array.isArray(request.args.arguments)
    ? request.args.arguments as Record<string, unknown>
    : {};
  const action = typeof toolArgs.action === 'string' ? toolArgs.action.toLowerCase() : '';
  const explicitMutationIntent = ['切换', '加载', '打开', '创建', '生成', '修改', '删除', '导入', '导出', '保存', '执行', '运行', '设置', '替换', 'load', 'open', 'create', 'switch', 'set', 'save', 'run', 'execute']
    .some((term) => userText.toLowerCase().includes(term));
  const readOnlyMcpAction = /^(search|get|list|find|read|query)/i.test(action) || /^find_|search_|list_/.test(toolName);
  if (explicitMutationIntent && readOnlyMcpAction) return false;
  const asksForMutation = /(切换|加载|打开|创建|生成|修改|删除|导入|导出|保存|执行|运行|设置|替换|load|open|create|switch|set|save|run|execute)/i.test(userText);
  if (!asksForMutation) return true;
  if (readOnlyMcpAction) return false;
  if (/(asset|scene|gameobject|prefab|editor|camera|build|material|component|script)/.test(toolName)) return true;
  return true;
}

function parseMcpToolResultPayload(result: string): { success?: boolean; message?: string; error?: string; code?: string } | null {
  try {
    const parsed = JSON.parse(result) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as { success?: boolean; message?: string; error?: string; code?: string }
      : null;
  } catch {
    return null;
  }
}

function buildGenericMcpDiscoveryRequest(prompt: string, catalog: JsonToolMcpCatalogEntry[]): JsonToolRequest | null {
  if (!/(切换|加载|打开|load|open|switch).*(场景|scene)|(?:场景|scene).*(切换|加载|打开|load|open|switch)/i.test(prompt)) return null;
  if (/\.unity\b/i.test(prompt)) return null;
  const hasAssetSearch = catalog.some((entry) => entry.tool === 'manage_asset');
  const hasSceneAction = catalog.some((entry) => entry.tool === 'manage_scene');
  if (!hasAssetSearch || !hasSceneAction) return null;
  const targetMatch = prompt.match(/(?:切换|加载|打开|load|open|switch)\s*([A-Za-z0-9_.-]{2,80})/i)
    || prompt.match(/([A-Za-z0-9_.-]{2,80})\s*(?:场景|scene)/i);
  const target = targetMatch?.[1]?.trim();
  if (!target || /^(scene|unitymcp|unity|load|open|switch)$/i.test(target)) return null;
  return {
    action: 'tool_request',
    tool: 'mcp_call',
    args: {
      manifestHint: catalog.find((entry) => entry.tool === 'manage_asset')?.manifestHint || 'unityMCP',
      tool: 'manage_asset',
      arguments: {
        action: 'search',
        path: 'Assets',
        filter_type: 'Scene',
        search_pattern: target,
        page_size: 10,
        page_number: 1,
        generate_preview: false,
      },
    },
  };
}

function extractAgentMessageText(item: Record<string, unknown>): string {
  const parts: string[] = [];
  appendIfText(item.text, parts);
  if (Array.isArray(item.content)) {
    for (const block of item.content) {
      if (block && typeof block === 'object') appendIfText((block as { text?: unknown }).text, parts);
    }
  }
  return parts.join('');
}

function shouldBypassLocalApprovals(): boolean {
  return process.env.CTI_CODEX_LOCAL_BYPASS_APPROVALS !== 'false';
}

function shouldIgnoreLocalUserConfig(): boolean {
  return process.env.CTI_CODEX_LOCAL_IGNORE_USER_CONFIG !== 'false';
}

function quoteWindowsCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteWindowsCmdArg).join(' ');
}

function quoteWindowsCmdArg(value: string): string {
  if (value.length === 0) return '""';
  if (!/[ \t"&|<>()^]/.test(value)) return value;
  const escaped = value
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/g, '$1$1')
    .replace(/([&|<>()^])/g, '^$1');
  return `"${escaped}"`;
}

export function parseCodexExecJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function extractJsonToolStatus(result: JsonToolResult): Record<string, unknown> {
  if (result.tool !== 'shell' || !result.data || typeof result.data !== 'object') return {};
  const data = result.data as { exitCode?: unknown; durationMs?: unknown };
  return {
    shellExitCode: typeof data.exitCode === 'number' ? data.exitCode : undefined,
    shellDurationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
  };
}

function buildFailedJsonToolAnswer(result: JsonToolResult): string {
  if (result.tool === 'shell' && result.data && typeof result.data === 'object') {
    const data = result.data as { command?: unknown; cwd?: unknown; exitCode?: unknown; stdout?: unknown; stderr?: unknown; durationMs?: unknown };
    const lines = [
      `未完成：${result.error || '本地 shell 工具执行失败'}`,
      `命令：${String(data.command || '').trim()}`,
      `工作目录：${String(data.cwd || '').trim()}`,
      `exitCode：${String(data.exitCode ?? '')}`,
      `耗时：${String(data.durationMs ?? '')}ms`,
    ];
    const stdout = typeof data.stdout === 'string' ? data.stdout.trim() : '';
    const stderr = typeof data.stderr === 'string' ? data.stderr.trim() : '';
    if (stdout) lines.push('', 'stdout:', stdout);
    if (stderr) lines.push('', 'stderr:', stderr);
    return lines.join('\n');
  }
  if (result.tool === 'mcp_call' || result.tool === 'unity_mcp_execute_code') {
    const data = result.data && typeof result.data === 'object'
      ? result.data as { durationMs?: unknown }
      : {};
    return [
      `未完成：${result.error || 'MCP 工具执行失败'}`,
      `工具：${result.tool}`,
      typeof data.durationMs === 'number' ? `耗时：${data.durationMs}ms` : '',
    ].filter(Boolean).join('\n');
  }
  return `未完成：${result.error || '本地工具执行失败'}`;
}

function collectJsonToolHistoryArtifacts(toolHistory: JsonToolHistoryEntry[]): JsonToolArtifacts {
  const images = new Set<string>();
  const files = new Set<string>();
  for (const entry of toolHistory) {
    const artifacts = collectJsonToolArtifacts(entry.result);
    for (const image of artifacts.images) images.add(image);
    for (const file of artifacts.files) files.add(file);
  }
  return {
    images: Array.from(images),
    files: Array.from(files),
  };
}

export class CodexLocalCliProvider implements LLMProvider {
  private readonly adapter: LocalCodexProviderAdapter;
  private readonly profile: CodexProviderProfile = 'local_primary';
  private readonly mcpBridge: McpBridge;
  private readonly mcpToolCallDefinitions = loadMcpToolCallDefinitions();
  private readonly unityMcpExecuteCodeDefinitions = loadUnityMcpExecuteCodeDefinitions();

  constructor(private readonly config: Config) {
    this.adapter = getLocalCodexProviderAdapter(config.localAiKind);
    this.mcpBridge = new McpBridge(config);
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const adapter = this.adapter;
    const config = this.config;
    const profile = this.profile;
    return new ReadableStream<string>({
      start: async (controller) => {
        const tempFiles: string[] = [];
        let stderr = '';
        let stdoutRemainder = '';
        let sawResult = false;
        let sawText = false;

        const cleanup = () => {
          for (const file of tempFiles) {
            try { fs.unlinkSync(file); } catch { /* ignore */ }
          }
        };

        try {
          const model = localModelName(config);
          const baseUrl = localBaseUrl(config, adapter);
          if (!adapter.supportsCodexAgent) {
            throw new Error(adapter.unsupportedReason || `${adapter.displayName} 目前不能作为 Codex agent 执行器。`);
          }

          const outputLastMessagePath = makeTempPath('cti-codex-last-message', '.txt');
          tempFiles.push(outputLastMessagePath);
          const command = adapter.buildCommand({ model, outputLastMessagePath });
          const workingDirectory = resolveWorkingDirectory(params.workingDirectory);
          const additionalDirectories = normalizeAdditionalDirectories(params.additionalDirectories);
          const args = [...command.args];

          for (const dir of additionalDirectories) args.push('--add-dir', dir);
          if (shouldSkipGitRepoCheck()) args.push('--skip-git-repo-check');
          if (shouldIgnoreLocalUserConfig()) args.push('--ignore-user-config');
          if (shouldBypassLocalApprovals()) {
            args.push('--dangerously-bypass-approvals-and-sandbox');
          } else {
            args.push('--sandbox', getSandboxMode());
          }

          const imageFiles = params.files?.filter((file) => file.type.startsWith('image/')) ?? [];
          for (const file of imageFiles) {
            const ext = MIME_EXT[file.type] || '.png';
            const tmpPath = makeTempPath('cti-img', ext);
            fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
            tempFiles.push(tmpPath);
            args.push('--image', tmpPath);
          }
          const bridgeCodexHome = ensureBridgeCodexHome(profile);
          const env = sanitizeLocalApiEnv({
            ...toTextEnv(process.env),
            CODEX_HOME: bridgeCodexHome,
            CTI_LOCAL_AI_KIND: adapter.id,
            CTI_LOCAL_AI_BASE_URL: baseUrl,
            CTI_LOCAL_AI_MODEL: model,
          });

          controller.enqueue(sseEvent('status', {
            provider: adapter.id,
            codexProfile: profile,
            modelSource: 'local_api',
            selectedSource: 'local_api',
            model,
            baseUrl,
            localProviderCapabilities: {
              supportsCodexAgent: adapter.supportsCodexAgent,
              codexLocalProvider: adapter.codexLocalProvider,
            },
          }));

          if (isJsonToolProtocolEligible(params.executionRequirement, 'local_api')) {
            await this.runJsonToolProtocol(controller, params, model, baseUrl);
            controller.close();
            return;
          }

          const spawnCommand = process.platform === 'win32'
            ? process.env.ComSpec || 'cmd.exe'
            : command.command;
          const spawnArgs = process.platform === 'win32'
            ? ['/d', '/s', '/c', quoteWindowsCommandLine(command.command, args)]
            : args;

          const child = spawn(spawnCommand, spawnArgs, {
            cwd: workingDirectory || process.cwd(),
            env,
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          const abort = () => {
            try { child.kill('SIGTERM'); } catch { /* ignore */ }
          };
          params.abortController?.signal.addEventListener('abort', abort, { once: true });

          const prompt = buildTurnPrompt(params);
          child.stdin.write(prompt);
          child.stdin.end();

          const handleJsonEvent = (event: Record<string, unknown>) => {
            switch (event.type) {
              case 'thread.started': {
                controller.enqueue(sseEvent('status', {
                  session_id: typeof event.thread_id === 'string' ? event.thread_id : undefined,
                }));
                break;
              }
              case 'item.completed': {
                const item = event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : {};
                this.handleCompletedItem(controller, item, () => { sawText = true; });
                break;
              }
              case 'turn.completed': {
                const usage = adapter.extractUsage(event);
                sawResult = true;
                controller.enqueue(sseEvent('result', usage ? {
                  usage: {
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    cache_read_input_tokens: usage.cache_read_input_tokens,
                    cache_creation_input_tokens: usage.cache_creation_input_tokens,
                  },
                } : {}));
                break;
              }
              case 'turn.failed':
              case 'error': {
                const message = typeof event.message === 'string'
                  ? event.message
                  : typeof event.error === 'string'
                    ? event.error
                    : `${event.type}`;
                controller.enqueue(sseEvent('error', message));
                break;
              }
            }
          };

          child.stdout.setEncoding('utf-8');
          child.stdout.on('data', (chunk: string) => {
            stdoutRemainder += chunk;
            const lines = stdoutRemainder.split(/\r?\n/);
            stdoutRemainder = lines.pop() || '';
            for (const line of lines) {
              const event = parseCodexExecJsonLine(line);
              if (event) handleJsonEvent(event);
            }
          });
          child.stderr.setEncoding('utf-8');
          child.stderr.on('data', (chunk: string) => {
            stderr = `${stderr}${chunk}`.slice(-4000);
          });

          await new Promise<void>((resolve, reject) => {
            child.on('error', reject);
            child.on('close', (code) => {
              params.abortController?.signal.removeEventListener('abort', abort);
              const tailEvent = parseCodexExecJsonLine(stdoutRemainder);
              if (tailEvent) handleJsonEvent(tailEvent);
              if (code === 0) {
                if (!sawText && fs.existsSync(outputLastMessagePath)) {
                  const text = fs.readFileSync(outputLastMessagePath, 'utf-8').trim();
                  if (text) controller.enqueue(sseEvent('text', text));
                }
                if (!sawResult) controller.enqueue(sseEvent('result', {}));
                resolve();
                return;
              }
              const stderrMessage = stderr.replace(/\s+/g, ' ').trim();
              reject(new Error(`codex exec local provider exited with code ${code}${stderrMessage ? `: ${stderrMessage}` : ''}`));
            });
          });

          controller.close();
        } catch (error) {
          try {
            controller.enqueue(sseEvent('error', toErrorMessage(error)));
            controller.close();
          } catch {
            // ignore already closed controller
          }
        } finally {
          cleanup();
        }
      },
    });
  }

  private async runJsonToolProtocol(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    model: string,
    baseUrl: string,
  ): Promise<void> {
    const workingDirectory = resolveWorkingDirectory(params.workingDirectory) || process.cwd();
    const additionalDirectories = normalizeAdditionalDirectories(params.additionalDirectories);
    const allowedRoots = Array.from(new Set([
      workingDirectory,
      this.config.defaultWorkDir,
      this.config.unityProjectPath,
      ...(this.config.allowedWorkspaceRoots || []),
      ...additionalDirectories,
    ].filter((item): item is string => !!item?.trim())));
    let toolCatalog = params.executionRequirement?.kind === 'tool_required'
      ? params.executionRequirement.requiredToolFamilies?.includes('unity-mcp')
        ? ['mcp_call', 'unity_mcp_execute_code', 'shell']
        : ['shell']
      : ['list_dir', 'read_file', 'search_files'];
    const contextText = [params.systemPrompt, params.prompt].filter(Boolean).join('\n');
    const mcpToolCatalog = toolCatalog.includes('mcp_call')
      ? await this.buildMcpToolCatalog(params)
      : [];
    const buildRuntimeFallbackRequest = (): JsonToolRequest | null => buildFallbackJsonToolRequest(params.prompt, {
      workingDirectory,
      contextText,
      requirementKind: params.executionRequirement?.kind,
      mcpToolCallDefinitions: this.mcpToolCallDefinitions,
      unityMcpExecuteCodeDefinitions: this.unityMcpExecuteCodeDefinitions,
    });
    const buildDeterministicPlan = () => planDeterministicJsonToolRequest(params.prompt, {
      workingDirectory,
      contextText,
      requirementKind: params.executionRequirement?.kind,
      mcpToolCallDefinitions: this.mcpToolCallDefinitions,
      unityMcpExecuteCodeDefinitions: this.unityMcpExecuteCodeDefinitions,
    });
    let usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null = null;
    let retryAttempted = false;
    let fallbackToolRequestUsed = false;
    let request: JsonToolRequest | null = null;
    let rawModelText = '';
    let lastToolResult: JsonToolResult | null = null;
    let taskComplete = false;
    const toolHistory: Array<{ request: JsonToolRequest; result: JsonToolResult }> = [];

    const deterministicPlan = buildDeterministicPlan();
    if (deterministicPlan && toolCatalog.includes(deterministicPlan.request.tool)) {
      request = deterministicPlan.request;
      fallbackToolRequestUsed = true;
    } else if (deterministicPlan?.request.tool === 'mcp_call' || deterministicPlan?.request.tool === 'unity_mcp_execute_code') {
      if (!toolCatalog.includes(deterministicPlan.request.tool)) {
        toolCatalog = [deterministicPlan.request.tool, ...toolCatalog];
      }
      if (toolCatalog.includes(deterministicPlan.request.tool)) {
        request = deterministicPlan.request;
        fallbackToolRequestUsed = true;
      }
    }
    if (!request && toolCatalog.includes('mcp_call')) {
      request = buildGenericMcpDiscoveryRequest(params.prompt, mcpToolCatalog);
      fallbackToolRequestUsed = !!request;
    }

    const requestFromModel = async (step: number): Promise<JsonToolRequest | null> => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        retryAttempted = attempt > 0;
        const repairPrompt = attempt > 0
          ? [
            'The previous output was not a valid executable JSON tool request.',
            `Previous output:\n${rawModelText.slice(0, 1200)}`,
            'Retry now. Output only the JSON object.',
          ].join('\n')
          : '';
        const protocolPrompt = [
          buildJsonToolProtocolPrompt(
            params.executionRequirement!,
            toolCatalog,
            { workingDirectory, allowedRoots },
            mcpToolCatalog,
          ),
          toolHistory.length > 0
            ? [
              `Tool step ${step + 1} of at most ${MAX_JSON_TOOL_STEPS}.`,
              'Previous real tool results:',
              JSON.stringify(toolHistory.slice(-3), null, 2),
              'If the user request is not complete, output the next tool_request using exact values returned by prior tools.',
              'If a previous MCP action failed because a path, id, name, or scene was not found, do not repeat the same action with the same arguments.',
              'Use an available MCP search/list/read tool first, then retry the action with the exact returned path/id/name.',
              'If the request is complete, output {"action":"final_response","text":"..."}; the runtime may summarize the last tool result.',
            ].join('\n')
            : '',
          repairPrompt,
        ].filter(Boolean).join('\n\n');
        const run = await this.runCodexExecText({
          params: {
            ...params,
            sdkSessionId: undefined,
            forceFreshThread: true,
          },
          model,
          promptOverride: params.prompt,
          systemPromptAppend: protocolPrompt,
          replaceSystemPrompt: true,
        });
        usage = mergeUsage(usage, run.usage);
        rawModelText = run.text.trim();
        const parsed = parseJsonToolRequest(rawModelText);
        if (parsed) return parsed;
      }
      return null;
    };

    if (!request) request = await requestFromModel(0);

    if (!request) {
      request = buildRuntimeFallbackRequest();
      fallbackToolRequestUsed = !!request;
    } else if (request.tool === 'shell' && params.executionRequirement?.kind === 'tool_required') {
      const normalizedRequest = buildRuntimeFallbackRequest();
      if (normalizedRequest?.tool === 'mcp_call' || normalizedRequest?.tool === 'unity_mcp_execute_code') {
        request = normalizedRequest;
        fallbackToolRequestUsed = true;
      }
    }

    if (!request) {
        controller.enqueue(sseEvent('status', {
          provider: this.adapter.id,
          codexProfile: this.profile,
          modelSource: 'local_api',
          selectedSource: 'local_api',
          model,
          baseUrl,
          evidenceProtocol: 'json_tool_request',
          jsonToolRetryAttempted: retryAttempted,
          jsonToolFallbackUsed: false,
          evidenceSatisfied: false,
        }));
        controller.enqueue(sseEvent('text', '未完成：本地模型没有产生可执行工具请求，运行时也没有匹配到可用的工具动作 manifest。'));
        controller.enqueue(sseEvent('result', usage ? { usage } : {}));
        return;
    }

    for (let step = 0; step < MAX_JSON_TOOL_STEPS && request; step += 1) {
      const validation = validateJsonToolRequest(request, { workingDirectory, allowedRoots, contextText });
      const toolId = `json-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      controller.enqueue(sseEvent('tool_use', {
        id: toolId,
        name: `JsonTool:${request.tool}`,
        input: request.args,
      }));

      let toolResult: JsonToolResult;
      if (validation.ok) {
        toolResult = await this.executeValidatedJsonToolRequest(validation.request);
      } else {
        toolResult = { tool: request.tool, ok: false, error: validation.error };
      }
      lastToolResult = toolResult;
      toolHistory.push({ request, result: toolResult });

      controller.enqueue(sseEvent('tool_result', {
        tool_use_id: toolId,
        content: JSON.stringify(toolResult, null, 2),
        is_error: !toolResult.ok,
      }));
      controller.enqueue(sseEvent('status', {
        provider: this.adapter.id,
        codexProfile: this.profile,
        modelSource: 'local_api',
        selectedSource: 'local_api',
        model,
        baseUrl,
        requiredEvidenceKind: params.executionRequirement?.kind,
        evidenceProtocol: 'json_tool_request',
        requestedTool: request.tool,
        executedTool: validation.ok ? request.tool : undefined,
        jsonToolRetryAttempted: retryAttempted,
        jsonToolFallbackUsed: fallbackToolRequestUsed,
        jsonToolStep: step + 1,
        evidenceSatisfied: toolResult.ok,
        ...extractJsonToolStatus(toolResult),
      }));

      if (!toolResult.ok) {
        if (request.tool === 'mcp_call' && step + 1 < MAX_JSON_TOOL_STEPS) {
          const recoveryRequest = await requestFromModel(step + 1);
          fallbackToolRequestUsed = false;
          if (recoveryRequest) {
            request = recoveryRequest;
            continue;
          }
        }
        controller.enqueue(sseEvent('text', buildFailedJsonToolAnswer(toolResult)));
        controller.enqueue(sseEvent('result', usage ? { usage } : {}));
        return;
      }

      const completedRequest = validation.ok ? validation.request : request;
      const resultData = toolResult.data && typeof toolResult.data === 'object' && !Array.isArray(toolResult.data)
        ? toolResult.data as { tool?: unknown; args?: unknown }
        : {};
      const resultArgs = resultData.args && typeof resultData.args === 'object' && !Array.isArray(resultData.args)
        ? resultData.args as Record<string, unknown>
        : {};
      const completionArgs = completedRequest.tool === 'mcp_call' && completedRequest.args.arguments && typeof completedRequest.args.arguments === 'object' && !Array.isArray(completedRequest.args.arguments)
        ? completedRequest.args.arguments as Record<string, unknown>
        : {};
      const completionAction = typeof completionArgs.action === 'string'
        ? completionArgs.action.toLowerCase()
        : typeof resultArgs.action === 'string'
          ? resultArgs.action.toLowerCase()
          : '';
      const completionToolName = String(completedRequest.args.tool || resultData.tool || '');
      const forcedIncompleteProbe = completedRequest.tool === 'mcp_call'
        && ['切换', '加载', '打开', 'load', 'open', 'switch'].some((term) => params.prompt.toLowerCase().includes(term))
        && (/^(search|get|list|find|read|query)/i.test(completionAction) || /^find_|search_|list_/.test(completionToolName));
      const completeNow = forcedIncompleteProbe ? false : shouldCompleteJsonToolTask(params.prompt, completedRequest, toolResult);
      if (completeNow) {
        taskComplete = true;
        break;
      }
      if (step + 1 >= MAX_JSON_TOOL_STEPS) break;
      request = await requestFromModel(step + 1);
      fallbackToolRequestUsed = false;
      if (!request) break;
    }

    if (!lastToolResult) {
      controller.enqueue(sseEvent('text', '未完成：本地工具协议未产生可执行结果。'));
      controller.enqueue(sseEvent('result', usage ? { usage } : {}));
      return;
    }

    if (!taskComplete && params.executionRequirement?.kind === 'tool_required') {
      controller.enqueue(sseEvent('status', {
        provider: this.adapter.id,
        codexProfile: this.profile,
        modelSource: 'local_api',
        selectedSource: 'local_api',
        model,
        baseUrl,
        requiredEvidenceKind: params.executionRequirement.kind,
        evidenceProtocol: 'json_tool_request',
        evidenceSatisfied: false,
      }));
      controller.enqueue(sseEvent('text', '未完成：工具只完成了读取、搜索或状态探测，尚未完成用户要求的实际动作。'));
      controller.enqueue(sseEvent('result', usage ? { usage } : {}));
      return;
    }

    const fallbackAnswer = buildVisibleToolOutcomeFallback(params.prompt, toolHistory);
    let generatedAnswer = fallbackAnswer;
    try {
      const finalResponsePrompt = buildJsonToolFinalResponsePrompt(params.prompt, toolHistory);
      const run = await this.runCodexExecText({
        params: {
          ...params,
          sdkSessionId: undefined,
          forceFreshThread: true,
        },
        model,
        promptOverride: finalResponsePrompt,
        systemPromptAppend: 'You format a final user-visible answer from verified tool history. Follow the prompt exactly.',
        replaceSystemPrompt: true,
      });
      usage = mergeUsage(usage, run.usage);
      generatedAnswer = normalizeGeneratedToolFinalText(run.text, fallbackAnswer);
    } catch {
      generatedAnswer = fallbackAnswer;
    }

    const finalText = buildCtiFinalToolResponseEnvelope(
      generatedAnswer,
      collectJsonToolHistoryArtifacts(toolHistory),
      'markdown',
    );
    controller.enqueue(sseEvent('text', finalText));
    controller.enqueue(sseEvent('result', usage ? { usage } : {}));
  }

  private async executeValidatedJsonToolRequest(request: JsonToolRequest): Promise<JsonToolResult> {
    if (request.tool !== 'mcp_call' && request.tool !== 'unity_mcp_execute_code') return executeJsonToolRequest(request);

    const startedAt = Date.now();
    try {
      const manifestHint = request.tool === 'mcp_call'
        ? String(request.args.manifestHint || '')
        : 'unityMCP';
      const manifest = this.mcpBridge.resolveManifestByHint(manifestHint)
        || (request.tool === 'unity_mcp_execute_code'
          ? this.mcpBridge.resolveManifestByHint('Unity MCP') || this.mcpBridge.resolveManifestByHint('unity')
          : null);
      if (!manifest) {
        return { tool: request.tool, ok: false, error: `MCP manifest is not configured: ${manifestHint || '(empty)'}` };
      }
      const toolName = request.tool === 'mcp_call'
        ? String(request.args.tool || '')
        : 'execute_code';
      const args = request.tool === 'mcp_call'
        ? request.args.arguments && typeof request.args.arguments === 'object' && !Array.isArray(request.args.arguments)
          ? request.args.arguments as Record<string, unknown>
          : {}
        : {
          action: 'execute',
          code: String(request.args.code || ''),
          compiler: request.args.compiler === 'roslyn' || request.args.compiler === 'codedom' ? request.args.compiler : 'auto',
          safety_checks: request.args.safety_checks !== false,
        };
      const result = await this.mcpBridge.callHttpTool(manifest, toolName, args);
      const parsedResult = parseMcpToolResultPayload(result);
      if (parsedResult && parsedResult.success === false) {
        return {
          tool: request.tool,
          ok: false,
          data: {
            server: manifest.id,
            tool: toolName,
            args,
            result,
            durationMs: Date.now() - startedAt,
          },
          error: parsedResult.error || parsedResult.message || `MCP tool ${toolName} reported success=false`,
        };
      }
      return {
        tool: request.tool,
        ok: true,
        data: {
          server: manifest.id,
          tool: toolName,
          args,
          result,
          durationMs: Date.now() - startedAt,
        },
      };
    } catch (error) {
      return {
        tool: request.tool,
        ok: false,
        data: { durationMs: Date.now() - startedAt },
        error: toErrorMessage(error),
      };
    }
  }

  private async buildMcpToolCatalog(params: StreamChatParams): Promise<JsonToolMcpCatalogEntry[]> {
    const manifests = this.selectMcpCatalogManifests(params);
    const entries: JsonToolMcpCatalogEntry[] = [];
    for (const manifest of manifests) {
      try {
        const tools = await this.mcpBridge.listHttpToolDetails(manifest);
        entries.push(...rankMcpToolDetails(params.prompt, manifest, tools).map((tool) => ({
          manifestHint: manifest.id,
          displayName: manifest.displayName,
          tool: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })));
      } catch {
        // Tool catalog is best-effort; request validation still protects execution.
      }
    }
    return entries.slice(0, 12);
  }

  private selectMcpCatalogManifests(params: StreamChatParams): McpManifestRecord[] {
    const selected: McpManifestRecord[] = [];
    const add = (manifest: McpManifestRecord | null) => {
      if (!manifest || manifest.enabled === false || manifest.type !== 'http') return;
      if (selected.some((item) => item.id === manifest.id)) return;
      selected.push(manifest);
    };
    add(this.mcpBridge.resolveManifestFromPrompt(params.prompt));
    if (params.executionRequirement?.requiredToolFamilies?.includes('unity-mcp')) {
      add(this.mcpBridge.resolveManifestByHint('unitymcp'));
      add(this.mcpBridge.resolveManifestByHint('unity'));
    }
    for (const manifest of this.mcpBridge.listManifests()) {
      if (selected.length >= 3) break;
      if (manifest.type === 'http' && manifest.enabled !== false) add(manifest);
    }
    return selected;
  }

  private async runCodexExecText(input: {
    params: StreamChatParams;
    model: string;
    promptOverride: string;
    systemPromptAppend?: string;
    replaceSystemPrompt?: boolean;
  }): Promise<{ text: string; usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null }> {
    const tempFiles: string[] = [];
    let stderr = '';
    let stdoutRemainder = '';
    let text = '';
    let usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null = null;
    let streamError = '';

    const cleanup = () => {
      for (const file of tempFiles) {
        try { fs.unlinkSync(file); } catch { /* ignore */ }
      }
    };

    try {
      const outputLastMessagePath = makeTempPath('cti-codex-json-tool-last-message', '.txt');
      tempFiles.push(outputLastMessagePath);
      const command = this.adapter.buildCommand({ model: input.model, outputLastMessagePath });
      const args = [...command.args];
      const workingDirectory = resolveWorkingDirectory(input.params.workingDirectory);
      const additionalDirectories = normalizeAdditionalDirectories(input.params.additionalDirectories);
      for (const dir of additionalDirectories) args.push('--add-dir', dir);
      if (shouldSkipGitRepoCheck()) args.push('--skip-git-repo-check');
      if (shouldIgnoreLocalUserConfig()) args.push('--ignore-user-config');
      if (shouldBypassLocalApprovals()) {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      } else {
        args.push('--sandbox', getSandboxMode());
      }

      const imageFiles = input.params.files?.filter((file) => file.type.startsWith('image/')) ?? [];
      for (const file of imageFiles) {
        const ext = MIME_EXT[file.type] || '.png';
        const tmpPath = makeTempPath('cti-img', ext);
        fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
        tempFiles.push(tmpPath);
        args.push('--image', tmpPath);
      }

      const env = sanitizeLocalApiEnv({
        ...toTextEnv(process.env),
        CODEX_HOME: ensureBridgeCodexHome(this.profile),
        CTI_LOCAL_AI_KIND: this.adapter.id,
        CTI_LOCAL_AI_BASE_URL: localBaseUrl(this.config, this.adapter),
        CTI_LOCAL_AI_MODEL: input.model,
      });
      const spawnCommand = process.platform === 'win32'
        ? process.env.ComSpec || 'cmd.exe'
        : command.command;
      const spawnArgs = process.platform === 'win32'
        ? ['/d', '/s', '/c', quoteWindowsCommandLine(command.command, args)]
        : args;
      const child = spawn(spawnCommand, spawnArgs, {
        cwd: workingDirectory || process.cwd(),
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const abort = () => {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      };
      input.params.abortController?.signal.addEventListener('abort', abort, { once: true });

      const systemPrompt = input.replaceSystemPrompt
        ? input.systemPromptAppend || ''
        : [input.params.systemPrompt, input.systemPromptAppend]
            .filter((part): part is string => !!part?.trim())
            .join('\n\n');
      const prompt = input.replaceSystemPrompt
        ? [
          systemPrompt.trim() ? `System instructions:\n${systemPrompt}` : '',
          `Current user request:\n${input.promptOverride.trim()}`,
        ].filter(Boolean).join('\n\n')
        : buildTurnPrompt({
          ...input.params,
          prompt: input.promptOverride,
          systemPrompt,
          sdkSessionId: undefined,
          forceFreshThread: true,
        });
      child.stdin.write(prompt);
      child.stdin.end();

      const handleJsonEvent = (event: Record<string, unknown>) => {
        switch (event.type) {
          case 'item.completed': {
            const item = event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : {};
            if (item.type === 'agent_message') text += extractAgentMessageText(item);
            break;
          }
          case 'turn.completed': {
            const extracted = this.adapter.extractUsage(event);
            if (extracted) {
              usage = {
                input_tokens: extracted.input_tokens,
                output_tokens: extracted.output_tokens,
                cache_read_input_tokens: extracted.cache_read_input_tokens,
                cache_creation_input_tokens: extracted.cache_creation_input_tokens,
              };
            }
            break;
          }
          case 'turn.failed':
          case 'error': {
            streamError = typeof event.message === 'string'
              ? event.message
              : typeof event.error === 'string'
                ? event.error
                : `${event.type}`;
            break;
          }
        }
      };

      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => {
        stdoutRemainder += chunk;
        const lines = stdoutRemainder.split(/\r?\n/);
        stdoutRemainder = lines.pop() || '';
        for (const line of lines) {
          const event = parseCodexExecJsonLine(line);
          if (event) handleJsonEvent(event);
        }
      });
      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-4000);
      });

      await new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => {
          input.params.abortController?.signal.removeEventListener('abort', abort);
          const tailEvent = parseCodexExecJsonLine(stdoutRemainder);
          if (tailEvent) handleJsonEvent(tailEvent);
          if (code === 0) {
            if (!text && fs.existsSync(outputLastMessagePath)) {
              text = fs.readFileSync(outputLastMessagePath, 'utf-8');
            }
            resolve();
            return;
          }
          const stderrMessage = stderr.replace(/\s+/g, ' ').trim();
          reject(new Error(`codex exec local provider exited with code ${code}${stderrMessage ? `: ${stderrMessage}` : ''}`));
        });
      });
      if (streamError) throw new Error(streamError);
      return { text, usage };
    } finally {
      cleanup();
    }
  }

  private handleCompletedItem(
    controller: ReadableStreamDefaultController<string>,
    item: Record<string, unknown>,
    markText: () => void,
  ): void {
    switch (item.type) {
      case 'agent_message': {
        const text = extractAgentMessageText(item);
        if (text) {
          markText();
          controller.enqueue(sseEvent('text', text));
        }
        break;
      }
      case 'command_execution': {
        const toolId = typeof item.id === 'string' ? item.id : `tool-${Date.now()}`;
        const command = typeof item.command === 'string' ? item.command : '';
        const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
        const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
        const isError = exitCode != null && exitCode !== 0;
        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Bash',
          input: { command },
        }));
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: output || (isError ? `Exit code: ${exitCode}` : 'Done'),
          is_error: isError,
        }));
        break;
      }
      case 'file_change': {
        const toolId = typeof item.id === 'string' ? item.id : `tool-${Date.now()}`;
        const changes = Array.isArray(item.changes) ? item.changes : [];
        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Edit',
          input: { files: changes },
        }));
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: changes.map((change) => JSON.stringify(change)).join('\n') || 'File changes applied',
          is_error: false,
        }));
        break;
      }
      case 'mcp_tool_call': {
        const toolId = typeof item.id === 'string' ? item.id : `tool-${Date.now()}`;
        const server = typeof item.server === 'string' ? item.server : '';
        const tool = typeof item.tool === 'string' ? item.tool : '';
        const result = item.result && typeof item.result === 'object' ? item.result as { content?: unknown; structured_content?: unknown } : undefined;
        const error = item.error && typeof item.error === 'object' ? item.error as { message?: unknown } : undefined;
        const resultContent = result?.content ?? result?.structured_content;
        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: `mcp__${server}__${tool}`,
          input: item.arguments,
        }));
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: typeof error?.message === 'string'
            ? error.message
            : typeof resultContent === 'string'
              ? resultContent
              : resultContent
                ? JSON.stringify(resultContent)
                : 'Done',
          is_error: !!error,
        }));
        break;
      }
    }
  }
}
