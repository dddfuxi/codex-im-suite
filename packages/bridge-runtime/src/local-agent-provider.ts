import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import { isDangerousInput, isPathWithinAllowedRoots, splitWorkspacePathList } from 'claude-to-im/src/lib/bridge/security/validators.js';

import type { Config } from './config.js';
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

const SHELL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 4000;
const MAX_SEARCH_RESULTS = 40;

function truncateText(text: string, maxChars = MAX_OUTPUT_CHARS): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function firstNonEmptyLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
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

export class LocalAgentProvider {
  private readonly mcpBridge: McpBridge;

  constructor(
    private readonly config: Config,
    private readonly pendingPerms: PendingPermissions,
    private readonly localProvider: LocalLlamaProvider,
  ) {
    this.mcpBridge = new McpBridge(config);
  }

  canHandleMcpBridgeFastPath(params: StreamChatParams): boolean {
    const prompt = params.prompt.toLowerCase();
    const mentionsMcp = /(mcp|unity mcp|blender mcp|picture mcp|prefab mcp|unitymcp|blendermcp)/i.test(params.prompt);
    if (!mentionsMcp) return false;
    return /(检查|状态|连通|在线|健康|启动|停止|重启|工具列表|列出.*工具|有哪些工具|调用.*工具|tool call|tools\/list)/i.test(prompt);
  }

  async handleMcpBridgeFastPath(
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
    if (!conservative.useLocal || !conservative.executionIntent || !conservative.canFastPath) return false;
    const prompt = params.prompt.toLowerCase();
    return /\bgit (pull|status|fetch|branch|log)\b/.test(prompt)
      || /(帮我拉取一下\s*git|帮我\s*pull|执行命令|运行命令|读取文件|查看文件|打开文件|搜索文本|查找字符串)/i.test(params.prompt);
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
    if (route.taskKind === 'command_draft') return false;
    if (route.taskKind === 'repo_query' || route.taskKind === 'tool_request' || route.taskKind === 'script_draft') return true;
    return /(执行|运行|拉取一下git|pull 一下|读取文件|搜索文本|查找字符串)/i.test(params.prompt);
  }

  private buildFastPlan(params: StreamChatParams, conservative: ConservativeRouteDecision): LocalExecutionPlan | null {
    const prompt = params.prompt.trim();
    if (!prompt) return null;

    if (/\bgit pull\b/i.test(prompt) || /(帮我拉取一下git|帮我 pull|拉取一下 git)/i.test(prompt)) {
      return {
        action: 'run_shell',
        reason: '执行 Git 拉取',
        taskKind: 'repo_query',
        finalReplyMode: 'concise',
        safetyFlags: ['repo_write'],
        steps: [{ type: 'shell_command', command: 'git pull', requiresPermission: true }],
      };
    }

    if (/\bgit status\b/i.test(prompt) || /(查看.*git.*状态|看一下.*git.*状态)/i.test(prompt)) {
      return {
        action: 'run_shell',
        reason: '读取 Git 状态',
        taskKind: 'repo_query',
        finalReplyMode: 'concise',
        safetyFlags: ['read_only'],
        steps: [{ type: 'shell_command', command: 'git status -sb', requiresPermission: false }],
      };
    }

    if (/\bgit fetch\b/i.test(prompt) || /(同步一下远端|fetch 一下)/i.test(prompt)) {
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
    const normalized = prompt.toLowerCase();
    if (/(unity mcp|unitymcp|mcp.*unity)/i.test(normalized)) return this.mcpBridge.resolveManifestByHint('unity');
    if (/(blender mcp|blendermcp|mcp.*blender)/i.test(normalized)) return this.mcpBridge.resolveManifestByHint('blender');
    if (/(picture mcp|mcp.*picture|图片 mcp)/i.test(normalized)) return this.mcpBridge.resolveManifestByHint('picture');
    if (/(prefab mcp|unity prefab mcp|mcp.*prefab)/i.test(normalized)) return this.mcpBridge.resolveManifestByHint('prefab');
    return this.mcpBridge.resolveManifestByHint('unity')
      || this.mcpBridge.resolveManifestByHint('blender')
      || this.mcpBridge.resolveManifestByHint('picture')
      || this.mcpBridge.resolveManifestByHint('prefab');
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
    return plan.steps.every((step) => {
      if (step.type === 'shell_command') {
        return !isDangerousInput(step.command).dangerous;
      }
      return true;
    });
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
    const prompt = params.prompt.toLowerCase();
    const mentionsMcp = /(mcp|unity\s*mcp|blender\s*mcp|picture\s*mcp|prefab\s*mcp|unitymcp|blendermcp|picturemcp|prefabmcp|图片\s*mcp|预制体\s*mcp)/i.test(params.prompt);
    if (!mentionsMcp) return false;
    if (/(什么是|是什么|原理|区别|介绍|说明|why|what is)/i.test(prompt)) return false;
    return /(检查|状态|连接|在线|离线|健康|启动|停止|重启|工具列表|列出.*工具|有哪些工具|调用.*工具|tool call|tools\/list|tools\/call)/i.test(prompt) || mentionsMcp;
  }

  async handleMcpBridgeFastPathV2(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    mode: LocalRouterMode,
  ): Promise<LocalAgentHandleResult> {
    const manifest = this.resolveMcpManifestV2(params.prompt);
    if (!manifest) {
      const text = '未识别目标 MCP。请明确说 Unity MCP、Blender MCP、Picture MCP 或 Prefab MCP。';
      this.recordMcpBridgeSummary(mode, 'refuse_local', 'tool_request', text, false);
      this.emitTerminalResponse(controller, params.sessionId, text, true);
      return {
        handled: true,
        fallbackToCodex: false,
        fallbackReason: '未识别目标 MCP',
      };
    }

    const prompt = params.prompt.toLowerCase();
    if (/(启动|拉起|连接|重启)/i.test(prompt)) {
      const start = await this.mcpBridge.startService(manifest);
      const health = await this.mcpBridge.checkHealth(manifest);
      const text = start.ok
        ? `${manifest.displayName || manifest.id} 启动检查完成。\n${health.message}`
        : `${manifest.displayName || manifest.id} 启动失败：${start.message}`;
      this.recordMcpBridgeSummary(mode, start.ok ? 'answer_local' : 'refuse_local', 'tool_request', text, start.ok);
      this.emitTerminalResponse(controller, params.sessionId, text, !start.ok);
      return { handled: true };
    }

    if (/(停止|关闭)/i.test(prompt)) {
      const stop = await this.mcpBridge.stopService(manifest);
      const text = stop.ok
        ? `${manifest.displayName || manifest.id} 已停止。`
        : `${manifest.displayName || manifest.id} 停止失败：${stop.message}`;
      this.recordMcpBridgeSummary(mode, stop.ok ? 'answer_local' : 'refuse_local', 'tool_request', text, stop.ok);
      this.emitTerminalResponse(controller, params.sessionId, text, !stop.ok);
      return { handled: true };
    }

    if (/(工具列表|列出.*工具|有哪些工具|tools\/list)/i.test(prompt)) {
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

    const parsedCall = this.parseHttpToolCallV2(params.prompt, manifest);
    if (parsedCall) {
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

  private resolveMcpManifestV2(prompt: string): McpManifestRecord | null {
    const normalized = prompt.toLowerCase();
    if (/(unity mcp|unitymcp|mcp.*unity)/i.test(normalized)) return this.mcpBridge.resolveManifestByHint('unity');
    if (/(blender mcp|blendermcp|mcp.*blender)/i.test(normalized)) return this.mcpBridge.resolveManifestByHint('blender');
    if (/(picture mcp|mcp.*picture|图片 mcp)/i.test(normalized)) return this.mcpBridge.resolveManifestByHint('picture');
    if (/(prefab mcp|unity prefab mcp|mcp.*prefab|预制体 mcp)/i.test(normalized)) return this.mcpBridge.resolveManifestByHint('prefab');
    return this.mcpBridge.resolveManifestByHint('unity')
      || this.mcpBridge.resolveManifestByHint('blender')
      || this.mcpBridge.resolveManifestByHint('picture')
      || this.mcpBridge.resolveManifestByHint('prefab');
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
