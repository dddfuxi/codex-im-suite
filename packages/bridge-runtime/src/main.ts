/**
 * Daemon entry point for claude-to-im-skill.
 *
 * Assembles all DI implementations and starts the bridge.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import * as bridgeManager from 'claude-to-im/src/lib/bridge/bridge-manager.js';
import 'claude-to-im/src/lib/bridge/adapters/index.js';
import { classifyToolResultQuality } from 'claude-to-im/src/lib/bridge/execution-requirement.js';
import {
  initializeBridgeRuntimeAudit,
  recordBridgeRuntimeExit,
  touchBridgeRuntimeHeartbeat,
} from 'claude-to-im/src/lib/bridge/runtime-audit.js';
import './adapters/weixin-adapter.js';

import type {
  BridgeStore,
  LLMProvider,
  MemoryIntentHost,
  MemoryWriteIntentDecision,
  MemoryWriteIntentInput,
  RetrievedFeishuHistoryContext,
  RetrievedMemoryContext,
} from 'claude-to-im/src/lib/bridge/host.js';
import { loadConfig, configToSettings, CTI_HOME } from './config.js';
import type { Config } from './config.js';
import { JsonFileStore } from './store.js';
import { SDKLLMProvider, resolveClaudeCliPath, preflightCheck } from './llm-provider.js';
import { PendingPermissions } from './permission-gateway.js';
import { setupLogger } from './logger.js';
import { OllamaProvider, type LocalModelMessage } from './local-llm-provider.js';
import { LocalAgentProvider } from './local-agent-provider.js';
import {
  compressConversationHistory,
  compressPromptText,
  createCompressedParams,
  buildLightChatParams,
  decideConservativeRoute,
  getLocalRouterMode,
  shouldRunPreCodexLocalFastPath,
  type LocalRouteProtocolResult,
  type LocalTaskKind,
} from './local-llm-router.js';
import {
  appendLocalLlmRouteSummary,
  clearLocalLlmTransientStatus,
  readLocalLlmStatus,
  updateLocalLlmStatus,
  type LocalLlmRouteSummary,
} from './local-llm-status.js';
import {
  readLocalModelCapabilityProfile,
  shouldTrustLocalApiForExecution,
} from './local-model-capability.js';
import {
  buildCtiFinalToolResponseEnvelope,
  buildVisibleToolOutcomeFallback,
  collectJsonToolArtifacts,
  executeJsonToolRequest,
  parseJsonToolRequest,
  validateJsonToolRequest,
  type JsonToolRequest,
  type JsonToolResult,
  planDeterministicJsonToolRequest,
} from './local-agent-tool-protocol.js';
import {
  loadMcpToolCallDefinitions,
  loadShellArtifactDefinitions,
  loadUnityMcpExecuteCodeDefinitions,
} from './local-agent-tool-registry.js';
import { buildManifestCodexSlimParams } from './manifest-codex-slim.js';
import { sseEvent } from './sse-utils.js';
import { McpBridge, type McpManifestRecord } from './mcp-bridge.js';
import {
  inferRequestedExecutorId,
  readSessionExecutorDefaults,
  selectExecutor,
} from './executor-registry.js';
import { shouldRetrieveMemoryForPrompt } from './memory-routing.js';
import { startKnowledgeIndexWatcher } from './knowledge-index-service.js';
import { startMemoryOptimizerService, type MemoryOptimizerService } from './memory-optimizer.js';
import {
  createFeishuPushProvider,
  createDirectReminder,
  completeReminder,
  createWeixinPushProvider,
  startTodoReminderService,
  type TodoReminderService,
} from './todo-reminders.js';
import { createExtensionCatalogHost } from './extension-catalog-host.js';
import { createFeishuCloudDocumentHost, FeishuTenantAccessTokenProvider } from './feishu-cloud-documents.js';
import {
  FeishuOAuthService,
  FeishuOAuthStateStore,
  FeishuOAuthTokenStore,
  startFeishuOAuthCallbackServer,
} from './feishu-oauth.js';
import { prepareWorkflowRetryExecution } from './workflow-retry.js';
import { writeExecutorStatus } from './executor-status.js';
import {
  appendWorkflowEvent,
  claimNextWorkflowRetry,
  completeWorkflowRun,
  completeWorkflowRetry,
  failWorkflowRun,
  failWorkflowRetry,
  markInterruptedWorkflowRuns,
  readWorkflowStatus,
  recordWorkflowRecoveryInfo,
  requestWorkflowRetry,
  setWorkflowExecutor,
  startWorkflowRun,
} from './workflow-status.js';

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(MODULE_DIR, '..');
const CORE_ROOT = path.resolve(SKILL_ROOT, '..', 'claude-to-im-core');

interface ParsedBridgeSseEvent {
  type: string;
  data: unknown;
}

function tryParseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function parseBridgeSseEvents(chunk: string): ParsedBridgeSseEvent[] {
  const events: ParsedBridgeSseEvent[] = [];
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payloadText = line.slice(5).trim();
    if (!payloadText) continue;
    const payload = tryParseJson<{ type?: unknown; data?: unknown }>(payloadText);
    if (!payload || typeof payload.type !== 'string') continue;
    let data: unknown = payload.data;
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        data = tryParseJson(trimmed) ?? data;
      }
    }
    events.push({ type: payload.type, data });
  }
  return events;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const direct = tryParseJson<Record<string, unknown>>(trimmed);
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) {
    const parsed = tryParseJson<Record<string, unknown>>(fenced);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const parsed = tryParseJson<Record<string, unknown>>(trimmed.slice(start, end + 1));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }
  return null;
}

function normalizeMemoryIntentDecision(payload: Record<string, unknown> | null): MemoryWriteIntentDecision {
  if (!payload) return { action: 'ignore', confidence: 0, reason: 'invalid_json' };
  const rawAction = typeof payload.action === 'string' ? payload.action.trim().toLowerCase() : '';
  const action: MemoryWriteIntentDecision['action'] = rawAction === 'write' || rawAction === 'clarify' ? rawAction : 'ignore';
  const rawConfidence = typeof payload.confidence === 'number'
    ? payload.confidence
    : Number.parseFloat(String(payload.confidence ?? '0'));
  const candidates = Array.isArray(payload.candidates)
    ? payload.candidates
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({
        key: typeof item.key === 'string' ? item.key.trim() : undefined,
        value: typeof item.value === 'string' ? item.value.trim() : undefined,
        text: typeof item.text === 'string' ? item.text.trim() : '',
        confidence: typeof item.confidence === 'number' ? item.confidence : undefined,
        source: 'model' as const,
      }))
      .filter((item) => item.text || item.key || item.value)
    : [];
  return {
    action,
    confidence: Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0,
    reason: typeof payload.reason === 'string' ? payload.reason.slice(0, 160) : undefined,
    candidates,
    clarification: typeof payload.clarification === 'string' ? payload.clarification.slice(0, 240) : undefined,
  };
}

async function collectProviderText(provider: LLMProvider, params: Parameters<LLMProvider['streamChat']>[0], timeoutMs: number): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const abortController = params.abortController || new AbortController();
  const relay = () => abortController.abort();
  timeout.addEventListener('abort', relay, { once: true });
  let text = '';
  try {
    const reader = provider.streamChat({ ...params, abortController }).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parseBridgeSseEvents(value)) {
        if (event.type === 'text' && typeof event.data === 'string') text += event.data;
        if (event.type === 'error') {
          throw new Error(typeof event.data === 'string' ? event.data : 'provider error');
        }
      }
    }
    return text.trim();
  } finally {
    timeout.removeEventListener('abort', relay);
  }
}

class ProviderMemoryIntentHost implements MemoryIntentHost {
  constructor(private readonly provider: LLMProvider) {}

  async classifyMemoryWrite(input: MemoryWriteIntentInput): Promise<MemoryWriteIntentDecision> {
    const recent = (input.recentMessages || [])
      .slice(-8)
      .map((message) => `${message.role}: ${String(message.content || '').replace(/\s+/g, ' ').slice(0, 420)}`)
      .join('\n');
    const prompt = [
      '判断当前用户消息是否要求写入、更新、覆盖或保存长期记忆。',
      '只返回 JSON，不要解释，不要输出思考过程。',
      'JSON schema:',
      '{"action":"write|ignore|clarify","confidence":0.0,"reason":"short","candidates":[{"key":"记忆键","value":"记忆值","text":"完整事实","confidence":0.0}],"clarification":"optional"}',
      '规则：',
      '- 如果用户要求记住、记录、更新某个事实、偏好、命名、路径、分支、配置或对应表，action=write。',
      '- 如果当前消息使用“这个/它/重新记一下”等指代，可以从最近上下文补全，但候选值必须真实出现在当前消息或最近上下文。',
      '- 如果缺少可保存的 key 或 value 且无法从最近上下文唯一补全，action=clarify。',
      '- 普通提问、执行任务、闲聊、工具请求不是记忆写入，action=ignore。',
      '- candidates 要保留用户原始键和值，不要改写为泛称，不要编造。',
      '',
      recent ? `最近上下文:\n${recent}` : '最近上下文: (empty)',
      '',
      `当前消息:\n${input.text}`,
    ].join('\n');

    const text = await collectProviderText(this.provider, {
      prompt,
      sessionId: `${input.sessionId}:memory-intent`,
      forceFreshThread: true,
      systemPrompt: 'You are a strict JSON classifier for memory-write intent. Return JSON only.',
      workingDirectory: input.workingDirectory,
      conversationHistory: [],
      replyPresentation: { replyStyleHint: '简洁、只给结论' },
      executionRequirement: { kind: 'none', reason: 'memory intent classification', requiredToolFamilies: [] },
    }, 25_000);
    return normalizeMemoryIntentDecision(extractJsonObject(text));
  }
}

function extractCodexFatalStreamError(chunk: string): string | null {
  const events = parseBridgeSseEvents(chunk);
  for (const event of events) {
    if (event.type === 'error') {
      if (typeof event.data === 'string' && event.data.trim()) return event.data.trim();
      return 'Codex 流返回错误事件';
    }
    if (event.type === 'result' && event.data && typeof event.data === 'object') {
      const data = event.data as { is_error?: unknown; error?: unknown; message?: unknown };
      if (data.is_error === true) {
        if (typeof data.error === 'string' && data.error.trim()) return data.error.trim();
        if (typeof data.message === 'string' && data.message.trim()) return data.message.trim();
        return 'Codex 返回错误结果';
      }
    }
  }
  if (/Codex Exec exited with code \d+/i.test(chunk)) {
    return chunk.trim();
  }
  return null;
}

function shouldAugmentWithMemory(prompt: string): boolean {
  return shouldRetrieveMemoryForPrompt(prompt);
}

function truncatePreview(text: string, maxChars = 220): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function summarizeCodexFailureMessage(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('401 unauthorized') || normalized.includes('refresh token') || normalized.includes('authentication token')) {
    return 'Codex 登录已失效，请重新登录。';
  }
  return truncatePreview(message, 180) || 'Codex 当前不可用。';
}

function shouldAutoRetryWorkflowError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error || '')).toLowerCase();
  if (!message.trim()) return true;
  if (message.includes('usage limit')) return false;
  if (message.includes('401 unauthorized') || message.includes('refresh token') || message.includes('authentication token')) return false;
  if (message.includes('method not allowed') || message.includes('unexpected status 405')) return false;
  if (message.includes('/v1/responses')) return false;
  if (message.includes('invalid request parameter')) return false;
  return true;
}

type CodexModelSource = 'local_api' | 'external_api' | 'official';

function isCodexApiFailoverError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error || '')).toLowerCase();
  if (!message.trim()) return false;
  return [
    'usage limit',
    'rate limit',
    'quota',
    '429',
    '401 unauthorized',
    '403 forbidden',
    'refresh token',
    'authentication token',
    'api key',
    'method not allowed',
    'unexpected status 405',
    '/v1/responses',
    'invalid request parameter',
    'econnrefused',
    'connection refused',
    'could not connect',
    'econnreset',
    'enotfound',
    'etimedout',
    'timeout',
    'fetch failed',
    'socket hang up',
    'status 500',
    'status 502',
    'status 503',
    'status 504',
    '不能作为 codex agent',
    '不支持 codex agent',
    '尚未支持该 local-provider',
    'unsupported codex agent',
  ].some((needle) => message.includes(needle));
}

function parseSseChunk(chunk: string): Array<{ type: string; data: string }> {
  const events: Array<{ type: string; data: string }> = [];
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const raw = trimmed.slice(5).trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { type?: unknown; data?: unknown };
      if (typeof parsed.type !== 'string') continue;
      events.push({
        type: parsed.type,
        data: typeof parsed.data === 'string' ? parsed.data : JSON.stringify(parsed.data ?? ''),
      });
    } catch {
      // Ignore malformed diagnostic chunks.
    }
  }
  return events;
}

function getBufferedFailoverError(chunks: string[]): string | null {
  const events = chunks.flatMap(parseSseChunk);
  const errorEvent = events.find((event) => event.type === 'error');
  if (!errorEvent?.data) return null;
  const hasUserVisibleOrToolOutput = events.some((event) => (
    event.type === 'text'
    || event.type === 'tool_use'
    || event.type === 'tool_result'
    || event.type === 'result'
  ));
  return hasUserVisibleOrToolOutput ? null : errorEvent.data;
}

function isCodexSourceConfigured(config: Config, source: CodexModelSource): boolean {
  if (source === 'official') return true;
  if (source === 'local_api') {
    return !!(config.localAiBaseUrl || config.ollamaBaseUrl || config.localLlmBaseUrl);
  }
  if (source === 'external_api') {
    return !!config.codexBaseUrl;
  }
  return false;
}

const TOOL_EXECUTION_PROMPT_PATTERN = /(unity\s*mcp|unitymcp|mcp\s*for\s*unity|unity|blender|hsscene|furniture_|prefab|timeline|场景|节点|截图|导入|导出|模型|看一眼|查一下|分析一下|整理.*列表)/i;

function requiresConcreteToolOutput(taskKind: LocalTaskKind, prompt: string): boolean {
  if (taskKind === 'unity_like' || taskKind === 'blender_like' || taskKind === 'doc_like') return true;
  if (taskKind !== 'tool_request') return false;
  return TOOL_EXECUTION_PROMPT_PATTERN.test(prompt);
}

function formatMemoryContext(memory: RetrievedMemoryContext | null, feishuHistory: RetrievedFeishuHistoryContext | null): string | undefined {
  const lines: string[] = [];

  if (memory?.summary) {
    lines.push(`本地记忆摘要:\n${memory.summary.trim()}`);
  }
  if (memory?.hits?.length) {
    const items = memory.hits
      .slice(0, 4)
      .map((hit) => `- [${hit.role}/${hit.source}] ${truncatePreview(hit.content, 180)}`);
    if (items.length) {
      lines.push(`本地记忆命中:\n${items.join('\n')}`);
    }
  }

  if (feishuHistory?.summary) {
    lines.push(`当前聊天历史摘要:\n${feishuHistory.summary.trim()}`);
  }
  if (feishuHistory?.items?.length) {
    const items = feishuHistory.items
      .slice(0, 4)
      .map((item) => `- [${item.senderName || item.senderId || 'unknown'}] ${truncatePreview(item.text || '', 180)}`);
    if (items.length) {
      lines.push(`当前聊天历史命中:\n${items.join('\n')}`);
    }
  }

  const merged = lines.filter(Boolean).join('\n\n').trim();
  return merged || undefined;
}

class CodexApiFailoverProvider implements LLMProvider {
  constructor(
    private readonly providers: Array<{ source: CodexModelSource; provider: LLMProvider }>,
  ) {}

  streamChat(params: Parameters<LLMProvider['streamChat']>[0]): ReturnType<LLMProvider['streamChat']> {
    const providers = this.providers;
    return new ReadableStream<string>({
      start: async (controller) => {
        const attemptedSources: CodexModelSource[] = [];
        let lastError: unknown;
        for (const candidate of providers) {
          attemptedSources.push(candidate.source);
          const buffered: string[] = [];
          try {
            controller.enqueue(sseEvent('status', {
              provider: 'codex',
              modelSource: candidate.source,
              selectedSource: candidate.source,
              attemptedSources,
            }));
            const stream = candidate.provider.streamChat(params);
            const reader = stream.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffered.push(value);
            }
            const bufferedFailoverError = getBufferedFailoverError(buffered);
            if (bufferedFailoverError && isCodexApiFailoverError(bufferedFailoverError)) {
              lastError = new Error(bufferedFailoverError);
              controller.enqueue(sseEvent('status', {
                provider: 'codex',
                modelSource: candidate.source,
                selectedSource: candidate.source,
                attemptedSources,
                failover: true,
                error: summarizeCodexFailureMessage(bufferedFailoverError),
              }));
              continue;
            }
            for (const chunk of buffered) controller.enqueue(chunk);
            controller.close();
            return;
          } catch (error) {
            lastError = error;
            if (!isCodexApiFailoverError(error)) throw error;
            const message = error instanceof Error ? error.message : String(error);
            controller.enqueue(sseEvent('status', {
              provider: 'codex',
              modelSource: candidate.source,
              selectedSource: candidate.source,
              attemptedSources,
              failover: true,
              error: summarizeCodexFailureMessage(message),
            }));
          }
        }
        const finalMessage = lastError instanceof Error ? lastError.message : String(lastError || 'Codex API failover exhausted');
        if (finalMessage.toLowerCase().includes('/v1/responses')) {
          throw new Error(
            '本地 API 协议不兼容：当前 Codex SDK 会调用 Responses/WebSocket 接口 `/v1/responses`，' +
            '但 Ollama 的 OpenAI 兼容层只提供 Chat Completions，无法直接作为 Codex agent 后端。' +
            ` 原始错误：${truncatePreview(finalMessage, 220)}`,
          );
        }
        throw lastError instanceof Error ? lastError : new Error(finalMessage);
      },
    });
  }
}

class ManifestSlimCodexProvider implements LLMProvider {
  private readonly mcpBridge: McpBridge;

  constructor(
    private readonly config: Config,
    private readonly provider: LLMProvider,
  ) {
    this.mcpBridge = new McpBridge(config);
  }

  streamChat(params: Parameters<LLMProvider['streamChat']>[0]): ReturnType<LLMProvider['streamChat']> {
    const slim = buildManifestCodexSlimParams(params, {
      defaultWorkDir: this.config.defaultWorkDir,
      unityProjectPath: this.config.unityProjectPath,
      allowedWorkspaceRoots: this.config.allowedWorkspaceRoots,
      mcpToolCallDefinitions: loadMcpToolCallDefinitions(),
      unityMcpExecuteCodeDefinitions: loadUnityMcpExecuteCodeDefinitions(),
      shellArtifactDefinitions: loadShellArtifactDefinitions(),
    });
    if (!slim.plan) return this.provider.streamChat(params);

    return new ReadableStream<string>({
      start: async (controller) => {
        appendLocalLlmRouteSummary(this.config, {
          timestamp: new Date().toISOString(),
          mode: getLocalRouterMode(this.config),
          taskKind: 'tool_request',
          decision: 'escalate_codex',
          provider: 'codex',
          reason: `配置型 manifest 命中，压缩上下文后交给 Codex 主链路规划 JSON 工具请求：${slim.plan!.reason}`,
          compressedPromptChars: 0,
          compressedHistoryChars: slim.compressedHistoryChars,
        });
        try {
          const chunks = await this.collectProviderChunks(this.provider.streamChat(slim.params));
          const planned = this.selectCodexToolRequest(chunks, slim.plan!.request);
          const validation = validateJsonToolRequest(planned.request, {
            workingDirectory: params.workingDirectory || this.config.defaultWorkDir,
            allowedRoots: this.getAllowedRoots(params),
            contextText: [slim.params.systemPrompt || '', params.prompt || ''].filter(Boolean).join('\n'),
          });
          const executableRequest = validation.ok ? validation.request : planned.request;
          const toolId = `manifest-codex-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          controller.enqueue(sseEvent('tool_use', {
            id: toolId,
            name: `JsonTool:${executableRequest.tool}`,
            input: executableRequest.args,
          }));
          const toolResult = validation.ok
            ? await this.executeValidatedJsonToolRequest(executableRequest, slim.params.executionRequirement?.requiredToolFamilies || [])
            : { tool: executableRequest.tool, ok: false, error: validation.error } as JsonToolResult;
          controller.enqueue(sseEvent('tool_result', {
            tool_use_id: toolId,
            content: JSON.stringify(toolResult, null, 2),
            is_error: !toolResult.ok,
          }));
          controller.enqueue(sseEvent('status', {
            provider: 'codex',
            codexProfile: 'official',
            modelSource: this.config.codexModelSource || 'official',
            requiredEvidenceKind: slim.params.executionRequirement?.kind,
            evidenceProtocol: 'json_tool_request',
            requestedTool: executableRequest.tool,
            executedTool: validation.ok ? executableRequest.tool : undefined,
            jsonToolFallbackUsed: planned.fallbackUsed,
            evidenceSatisfied: toolResult.ok,
          }));
          const finalBody = toolResult.ok
            ? buildVisibleToolOutcomeFallback(params.prompt, [{ request: executableRequest, result: toolResult }])
            : this.buildFailedToolAnswer(toolResult);
          const finalText = buildCtiFinalToolResponseEnvelope(
            finalBody,
            collectJsonToolArtifacts(toolResult),
            'markdown',
          );
          controller.enqueue(sseEvent('text', finalText));
          const usage = this.extractUsageFromChunks(chunks);
          controller.enqueue(sseEvent('result', usage ? { usage } : {}));
          controller.close();
        } catch (error) {
          controller.enqueue(sseEvent('error', error instanceof Error ? error.message : String(error)));
          controller.close();
        }
      },
    });
  }

  private async collectProviderChunks(stream: ReadableStream<string>): Promise<string[]> {
    const chunks: string[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return chunks;
  }

  private selectCodexToolRequest(
    chunks: string[],
    fallbackRequest: JsonToolRequest,
  ): { request: JsonToolRequest; fallbackUsed: boolean } {
    const text = chunks
      .flatMap(parseSseChunk)
      .filter((event) => event.type === 'text')
      .map((event) => event.data)
      .join('\n')
      .trim();
    const parsed = parseJsonToolRequest(text);
    if (parsed && this.isSameManifestToolBoundary(parsed, fallbackRequest)) {
      return { request: parsed, fallbackUsed: false };
    }
    return { request: fallbackRequest, fallbackUsed: true };
  }

  private isSameManifestToolBoundary(candidate: JsonToolRequest, expected: JsonToolRequest): boolean {
    if (candidate.tool !== expected.tool) return false;
    if (candidate.tool === 'mcp_call') {
      return String(candidate.args.manifestHint || '').trim().toLowerCase() === String(expected.args.manifestHint || '').trim().toLowerCase()
        && String(candidate.args.tool || '').trim() === String(expected.args.tool || '').trim();
    }
    if (candidate.tool === 'unity_mcp_execute_code') return true;
    if (candidate.tool === 'shell_artifact') {
      return String(candidate.args.command || '').trim() === String(expected.args.command || '').trim();
    }
    return false;
  }

  private extractUsageFromChunks(chunks: string[]): Record<string, unknown> | null {
    for (const event of chunks.flatMap(parseSseChunk).reverse()) {
      if (event.type !== 'result') continue;
      try {
        const parsed = JSON.parse(event.data) as { usage?: unknown };
        if (parsed.usage && typeof parsed.usage === 'object') return parsed.usage as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    return null;
  }

  private getAllowedRoots(params: Parameters<LLMProvider['streamChat']>[0]): string[] {
    return [
      params.workingDirectory,
      this.config.defaultWorkDir,
      this.config.unityProjectPath,
      ...(this.config.allowedWorkspaceRoots || []),
    ].filter((item): item is string => !!item && item.trim().length > 0);
  }

  private async executeValidatedJsonToolRequest(request: JsonToolRequest, requiredFamilies: string[] = []): Promise<JsonToolResult> {
    if (request.tool !== 'mcp_call' && request.tool !== 'unity_mcp_execute_code') return executeJsonToolRequest(request);

    const startedAt = Date.now();
    try {
      const manifestHint = request.tool === 'mcp_call' ? String(request.args.manifestHint || '') : 'unityMCP';
      const manifest = this.mcpBridge.resolveManifestByHint(manifestHint)
        || (request.tool === 'unity_mcp_execute_code'
          ? this.mcpBridge.resolveManifestByHint('Unity MCP') || this.mcpBridge.resolveManifestByHint('unity')
          : null);
      if (!manifest) {
        return { tool: request.tool, ok: false, error: `MCP manifest is not configured: ${manifestHint || '(empty)'}` };
      }
      if (!this.isMcpManifestCompatibleWithFamilies(manifest, request.tool === 'mcp_call' ? requiredFamilies : [])) {
        return {
          tool: request.tool,
          ok: false,
          error: `MCP manifest is not compatible with this turn's required tool families: ${manifest.id}`,
        };
      }
      const toolName = request.tool === 'mcp_call' ? String(request.args.tool || '') : 'execute_code';
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
      const result = await this.mcpBridge.callTool(manifest, toolName, args);
      const parsedResult = this.parseMcpToolResultPayload(result.content);
      const data = {
        server: manifest.id,
        tool: toolName,
        args,
        result: result.content,
        durationMs: Date.now() - startedAt,
      };
      if (!result.ok || (parsedResult && parsedResult.success === false)) {
        return {
          tool: request.tool,
          ok: false,
          data,
          error: result.error || parsedResult?.error || parsedResult?.message || `MCP tool ${toolName} reported failure`,
        };
      }
      return { tool: request.tool, ok: true, data };
    } catch (error) {
      return {
        tool: request.tool,
        ok: false,
        data: { durationMs: Date.now() - startedAt },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private parseMcpToolResultPayload(result: string): { success?: boolean; message?: string; error?: string; code?: string } | null {
    try {
      const parsed = JSON.parse(result) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as { success?: boolean; message?: string; error?: string; code?: string }
        : null;
    } catch {
      return null;
    }
  }

  private normalizeMcpFamilyTerms(manifest: McpManifestRecord): string {
    return [
      manifest.id,
      manifest.displayName,
      manifest.category,
      manifest.source,
      ...(manifest.aliases || []),
    ].filter(Boolean).join(' ').toLowerCase();
  }

  private isMcpManifestCompatibleWithFamilies(manifest: McpManifestRecord | null, requiredFamilies: string[] = []): boolean {
    if (!manifest) return false;
    const families = new Set(requiredFamilies.map((family) => family.trim().toLowerCase()).filter(Boolean));
    const specificFamilies = Array.from(families).filter((family) => family !== 'mcp' && family !== 'tool');
    if (specificFamilies.length === 0) return true;
    const terms = this.normalizeMcpFamilyTerms(manifest);
    if (families.has('web-search') && !/(^|\s|\.|-)web(\.|-| )?search(\s|$)/.test(terms)) return false;
    if (families.has('unity-mcp') && !/(^|\s|\.|-)unity(\s|\.|-|mcp|$)|unitymcp/.test(terms)) return false;
    return true;
  }

  private buildFailedToolAnswer(result: JsonToolResult): string {
    return [
      `未完成：${result.error || '工具执行失败，但没有返回更具体的错误。'}`,
      `工具：${result.tool}`,
    ].join('\n');
  }
}

class HubLlmProvider implements LLMProvider {
  constructor(
    private readonly config: Config,
    private readonly store: BridgeStore,
    private readonly localProvider: OllamaProvider,
    private readonly localAgent: LocalAgentProvider,
    private readonly fallbackProvider: LLMProvider,
    private readonly localAgentFallbackProvider: LLMProvider | null,
    private readonly primaryExecutorId: string,
    private readonly trustedExecutionProvider: LLMProvider = fallbackProvider,
  ) {}

  streamChat(params: Parameters<LLMProvider['streamChat']>[0]): ReturnType<LLMProvider['streamChat']> {
    const routerMode = getLocalRouterMode(this.config);
    const routerEnabled = (this.config.ollamaEnabled ?? this.config.localLlmEnabled) === true
      && this.config.localLlmRouterEnabled !== false
      && this.config.localLlmForceHub !== false;

    if (!routerEnabled || routerMode === 'codex_only') {
      updateLocalLlmStatus(this.config, {
        routeMisses: readLocalLlmStatus(this.config).routeMisses + 1,
        lastProvider: 'codex_only',
        lastDecision: 'codex_only',
        lastRouteReason: routerEnabled ? '当前模式为仅 Codex' : '本地中枢未启用',
      });
      return this.fallbackProvider.streamChat(params);
    }

    return new ReadableStream<string>({
      start: async (controller) => {
        const workflowRun = this.startObservedWorkflow(params, 'hybrid');
        const evidence = emptyStreamEvidence();
        seedExecutionRequirementEvidence(evidence, params);
        const observedController = createObservedController(controller, evidence);
        let workflowFailed = false;
        try {
        const conservative = decideConservativeRoute(params, this.config);
        if (shouldRunPreCodexLocalFastPath(routerMode)) {
          if (this.localAgent.canHandleMcpBridgeFastPathV2(params)) {
            try {
              const mcpResult = await this.localAgent.handleMcpBridgeFastPathV2(observedController, params, routerMode);
              if (mcpResult.handled) return;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              await this.dispatchAfterRouteFailure(observedController, params, conservative, routerMode, message);
              return;
            }
          }
        }
        if (routerMode === 'hybrid') {
          if (conservative.requestKind === 'light_chat' && conservative.useLocal) {
            await this.pipeLightChatFastPath(observedController, params, conservative, routerMode);
            return;
          }
          await this.pipeCodexPrimaryWithFallback(observedController, params, conservative, '默认直达 Codex（Codex 主脑）');
          return;
        }
        if (routerMode === 'local_only') {
          await this.pipeLocalAgentApiFallback(observedController, params, conservative, '当前模式为仅本地模型 API');
          return;
        }
        try {
          const routeAttempt = await this.localProvider.route(params);
          const route = this.applySafetyOverride(routeAttempt.route, conservative);
          await this.dispatchByRoute(observedController, params, route, routerMode, conservative);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const current = readLocalLlmStatus(this.config);
          updateLocalLlmStatus(this.config, {
            routeFailures: current.routeFailures + 1,
            lastError: message,
            lastFallbackReason: message,
            serverReachable: false,
            lastCheckAt: new Date().toISOString(),
          });
          await this.dispatchAfterRouteFailure(observedController, params, conservative, routerMode, message);
        }
        } catch (error) {
          workflowFailed = true;
          flushWorkflowEvidence(workflowRun.id, evidence);
          failWorkflowRun(workflowRun.id, error);
          if (shouldAutoRetryWorkflowError(error)) {
            requestWorkflowRetry(workflowRun.id, 'auto');
          }
          throw error;
        } finally {
          if (!workflowFailed) {
            flushWorkflowEvidence(workflowRun.id, evidence);
            completeWorkflowRun(workflowRun.id);
          }
        }
      },
    });
  }

  private startObservedWorkflow(
    params: Parameters<LLMProvider['streamChat']>[0],
    taskKind?: string,
  ): ReturnType<typeof startWorkflowRun> {
    const binding = this.store
      .listChannelBindings()
      .find((item) => item.codepilotSessionId === params.sessionId);
    const workflowRun = startWorkflowRun({
      sessionId: params.sessionId,
      prompt: params.prompt,
      channelType: binding?.channelType,
      chatId: binding?.chatId,
    });
    recordWorkflowRecoveryInfo(workflowRun.id, {
      prompt: params.prompt,
      workingDirectory: params.workingDirectory,
      model: params.model,
      systemPrompt: params.systemPrompt,
      permissionMode: params.permissionMode,
      channelType: binding?.channelType,
      chatId: binding?.chatId,
      userId: params.sourceUserId,
      userDisplayName: params.sourceUserDisplayName,
      messageId: params.sourceMessageId,
    });
    appendWorkflowEvent(workflowRun.id, 'authorized', 'workflow.authorized', '请求进入执行器路由前置阶段');
    appendWorkflowEvent(workflowRun.id, 'contextualized', 'workflow.contextualized', '会话、记忆和工作区上下文已准备');
    const sessionDefaults = readSessionExecutorDefaults(this.config);
    const requestedExecutorId = inferRequestedExecutorId(params.prompt) || sessionDefaults[params.sessionId];
    const selection = selectExecutor(this.config, {
      sessionId: params.sessionId,
      prompt: params.prompt,
      workingDirectory: params.workingDirectory,
      permissionMode: params.permissionMode,
      requestedExecutorId,
      preferredExecutorId: this.primaryExecutorId,
      taskKind,
      params,
    }, sessionDefaults[params.sessionId]);
    writeExecutorStatus(this.config, { sessionId: params.sessionId, selection });
    setWorkflowExecutor(workflowRun.id, selection.executor.id, selection.reason);
    appendWorkflowEvent(workflowRun.id, 'executing', 'executor.executing', `执行器开始处理：${selection.executor.displayName}`, {
      executorId: selection.executor.id,
      fallbackExecutorIds: selection.fallbackExecutorIds,
    });
    return workflowRun;
  }

  private applySafetyOverride(route: LocalRouteProtocolResult, conservative: ReturnType<typeof decideConservativeRoute>): LocalRouteProtocolResult {
    if (!conservative.highRisk) return route;
    return {
      ...route,
      decision: conservative.preferredDecision,
      taskKind: (conservative.requestKind as LocalRouteProtocolResult['taskKind']) || route.taskKind,
      reason: conservative.reason,
      needsCodex: true,
      canAnswerLocally: false,
      compressedPrompt: conservative.compressedPrompt || route.compressedPrompt,
      compressedHistory: conservative.compressedHistory || route.compressedHistory,
      safetyFlags: [...new Set([...(route.safetyFlags || []), 'high_risk_request'])],
    };
  }

  private buildRecallContext(
    params: Parameters<LLMProvider['streamChat']>[0],
    taskKind?: string,
  ): string | undefined {
    if (!shouldAugmentWithMemory(params.prompt) && taskKind !== 'repo_query') {
      return undefined;
    }

    const session = this.store.getSession(params.sessionId);
    const binding = this.store
      .listChannelBindings()
      .find((item) => item.codepilotSessionId === params.sessionId);
    const workingDirectory = params.workingDirectory || session?.working_directory;
    const channelType = binding?.channelType || '';
    const chatId = binding?.chatId || '';

    const memory = this.store.retrieveRelevantMemory({
      sessionId: params.sessionId,
      channelType,
      chatId,
      workingDirectory,
      query: params.prompt,
      recentHistoryLimit: 6,
    });

    const feishuHistory = binding?.channelType === 'feishu' && binding.chatId && this.store.retrieveRelevantFeishuHistory
      ? this.store.retrieveRelevantFeishuHistory({
          chatId: binding.chatId,
          query: params.prompt,
          limit: 4,
        })
      : null;

    return formatMemoryContext(memory, feishuHistory);
  }

  private async pipeLightChatFastPath(
    controller: ReadableStreamDefaultController<string>,
    params: Parameters<LLMProvider['streamChat']>[0],
    conservative: ReturnType<typeof decideConservativeRoute>,
    mode: ReturnType<typeof getLocalRouterMode>,
  ): Promise<void> {
    const lightParams = buildLightChatParams(params, this.config);
    const summary: Omit<LocalLlmRouteSummary, 'timestamp'> = {
      mode,
      taskKind: 'light_chat',
      decision: 'answer_local',
      provider: 'local_best_effort',
      reason: 'light_chat_fast_path',
      compressedPromptChars: lightParams.prompt.length,
      compressedHistoryChars: JSON.stringify(lightParams.conversationHistory || []).length,
      promptProfile: 'light_chat',
    };
    try {
      const result = await this.localProvider.complete(
        this.buildLightChatLocalMessages(lightParams),
        {
          temperature: 0.35,
          maxTokens: Math.min(256, Math.max(96, this.config.localLlmMaxOutputTokens || 160)),
          timeoutMs: Math.max(5000, Math.min(20000, this.config.localAiTimeoutMs || this.config.ollamaTimeoutMs || this.config.localLlmTimeoutMs || 12000)),
        },
      );
      this.emitLocalSuccess(controller, lightParams.sessionId, result.text, result.usage, summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.pipeFallbackStream(controller, lightParams, {
        mode,
        taskKind: 'light_chat',
        decision: 'escalate_codex',
        provider: 'codex',
        reason: `light_chat_fast_path_failed; fallback with light prompt: ${truncatePreview(message, 160)}`,
        compressedPromptChars: lightParams.prompt.length,
        compressedHistoryChars: JSON.stringify(lightParams.conversationHistory || []).length,
        promptProfile: 'light_chat',
        fallbackReason: message,
      }, this.fallbackProvider);
    }
  }

  private buildLightChatLocalMessages(params: Parameters<LLMProvider['streamChat']>[0]): LocalModelMessage[] {
    const messages: LocalModelMessage[] = [];
    const systemPrompt = params.systemPrompt?.trim();
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    for (const item of params.conversationHistory || []) {
      const content = item.content?.trim();
      if (!content) continue;
      messages.push({ role: item.role, content });
    }
    messages.push({ role: 'user', content: params.prompt });
    return messages;
  }

  private async dispatchAfterRouteFailure(
    controller: ReadableStreamDefaultController<string>,
    params: Parameters<LLMProvider['streamChat']>[0],
    conservative: ReturnType<typeof decideConservativeRoute>,
    mode: ReturnType<typeof getLocalRouterMode>,
    reason: string,
  ): Promise<void> {
    if (mode !== 'local_only') {
      await this.pipeCodexPrimaryWithFallback(controller, params, conservative, `本地辅助失败，升级 Codex：${reason}`);
      return;
    }

    await this.pipeLocalAgentApiFallback(controller, params, conservative, `本地路由失败，切换本地模型 API：${reason}`);
  }

  private async dispatchByRoute(
    controller: ReadableStreamDefaultController<string>,
    params: Parameters<LLMProvider['streamChat']>[0],
    route: LocalRouteProtocolResult,
    mode: ReturnType<typeof getLocalRouterMode>,
    conservative: ReturnType<typeof decideConservativeRoute>,
  ): Promise<void> {
    switch (route.decision) {
      case 'answer_local': {
        const executed = await this.localAgent.handleRoutedExecution(controller, params, {
          mode,
          conservative,
          route,
        });
        if (executed.handled) return;
        if (executed.fallbackToCodex && mode !== 'local_only') {
          const compressedParams = createCompressedParams(params, route.compressedPrompt, route.compressedHistory, executed.fallbackReason || route.reason);
          await this.pipeFallbackStream(controller, compressedParams, {
            mode,
            taskKind: route.taskKind,
            decision: 'escalate_codex',
            provider: 'codex',
            reason: executed.fallbackReason || route.reason,
            compressedPromptChars: route.compressedPrompt.length,
            compressedHistoryChars: route.compressedHistory.length,
          });
          return;
        }
        await this.pipeLocalAgentApiFallback(controller, params, conservative, `本地路由要求直答，改用本地模型 API：${route.reason}`);
        return;
      }

      case 'escalate_codex': {
        if (mode === 'local_only') {
          await this.pipeLocalAgentApiFallback(controller, params, conservative, `当前仅本地模式，使用本地模型 API：${route.reason}`);
          return;
        }

        const compressedParams = createCompressedParams(params, route.compressedPrompt, route.compressedHistory, route.reason);
        await this.pipeFallbackStream(controller, compressedParams, {
          mode,
          taskKind: route.taskKind,
          decision: route.decision,
          provider: 'codex',
          reason: route.reason,
          compressedPromptChars: route.compressedPrompt.length,
          compressedHistoryChars: route.compressedHistory.length,
        });
        return;
      }

      case 'refuse_local':
      default: {
        if (mode !== 'local_only' && !conservative.highRisk) {
          const compressedParams = createCompressedParams(params, route.compressedPrompt, route.compressedHistory, route.reason);
          await this.pipeFallbackStream(controller, compressedParams, {
            mode,
            taskKind: route.taskKind,
            decision: route.decision,
            provider: 'codex',
            reason: `本地拒答，升级 Codex：${route.reason}`,
            compressedPromptChars: route.compressedPrompt.length,
            compressedHistoryChars: route.compressedHistory.length,
          });
          return;
        }

        await this.pipeLocalAgentApiFallback(controller, params, conservative, `本地路由拒绝直答，使用本地模型 API：${route.reason}`);
      }
    }
  }

  private isLocalAgentApiFallbackEnabled(): boolean {
    return false;
  }

  private buildAgentFallbackUnavailableReply(primaryFailure: string, localFailure?: string): string {
    const parts = [
      `主 Codex API 与本地模型 API 都不可用。主 API：${summarizeCodexFailureMessage(primaryFailure)}`,
    ];
    if (localFailure) {
      parts.push(`本地模型 API：${truncatePreview(localFailure, 180)}`);
    } else if (!this.isLocalAgentApiFallbackEnabled()) {
      parts.push('本地模型 API 未启用。');
    } else if (!this.localAgentFallbackProvider) {
      parts.push('本地模型 API provider 未初始化。');
    }
    return parts.join(' ');
  }

  private async pipeLocalAgentApiFallback(
    controller: ReadableStreamDefaultController<string>,
    params: Parameters<LLMProvider['streamChat']>[0],
    conservative: ReturnType<typeof decideConservativeRoute>,
    reason: string,
    primaryFailure?: string,
  ): Promise<void> {
    const routeMode = getLocalRouterMode(this.config);
    if (requiresConcreteToolOutput(conservative.requestKind, params.prompt) && !shouldTrustLocalApiForExecution(this.config)) {
      this.emitLocalSuccess(controller, params.sessionId, this.buildLocalApiUnverifiedReply(), undefined, {
        mode: routeMode,
        taskKind: conservative.requestKind,
        decision: 'refuse_local',
        provider: 'refuse_local',
        reason: primaryFailure
          ? `主执行模型失败，且本地 API 未通过工具调用探测：${primaryFailure}`
          : '本地 API 未通过工具调用探测，拒绝执行类任务',
        compressedPromptChars: 0,
        compressedHistoryChars: 0,
        fallbackReason: primaryFailure || reason,
      });
      return;
    }
    if (!this.isLocalAgentApiFallbackEnabled() || !this.localAgentFallbackProvider) {
      this.emitLocalSuccess(controller, params.sessionId, this.buildAgentFallbackUnavailableReply(primaryFailure || reason), undefined, {
        mode: routeMode,
        taskKind: conservative.requestKind,
        decision: 'refuse_local',
        provider: 'codex_local_fallback',
        reason,
        compressedPromptChars: 0,
        compressedHistoryChars: 0,
        fallbackReason: primaryFailure || reason,
      });
      return;
    }

    try {
      await this.pipeFallbackStream(controller, params, {
        mode: routeMode,
        taskKind: conservative.requestKind,
        decision: 'escalate_codex',
        provider: 'codex_local_fallback',
        reason,
        compressedPromptChars: 0,
        compressedHistoryChars: 0,
        fallbackReason: primaryFailure,
      }, this.localAgentFallbackProvider);
    } catch (fallbackError) {
      const localFailure = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      this.emitLocalSuccess(controller, params.sessionId, this.buildAgentFallbackUnavailableReply(primaryFailure || reason, localFailure), undefined, {
        mode: routeMode,
        taskKind: conservative.requestKind,
        decision: 'refuse_local',
        provider: 'codex_local_fallback',
        reason: `本地模型 API 模型来源失败：${reason}`,
        compressedPromptChars: 0,
        compressedHistoryChars: 0,
        fallbackReason: localFailure,
      });
    }
  }

  private shouldAvoidLocalPrimaryForExecution(
    conservative: ReturnType<typeof decideConservativeRoute>,
    params: Parameters<LLMProvider['streamChat']>[0],
  ): boolean {
    return false;
  }

  private buildLocalApiUnverifiedReply(): string {
    const capability = readLocalModelCapabilityProfile(this.config);
    const checked = capability.updatedAt ? `最近探测：${capability.updatedAt}` : '尚未探测';
    return [
      '未执行：当前本地 API 主模型还没有通过工具调用能力探测。',
      `模型：${capability.model || this.config.localAiModel || 'unknown'}`,
      `状态：${capability.toolCallingState}，${capability.message || checked}`,
      '为了避免“未执行却编结果”，执行类任务已被拦截。请在扩展页/设置页运行“测试工具调用”，或改用官方 Codex / 外部 API 作为执行模型。',
    ].join('\n');
  }

  private async pipeCodexPrimaryWithFallback(
    controller: ReadableStreamDefaultController<string>,
    params: Parameters<LLMProvider['streamChat']>[0],
    conservative: ReturnType<typeof decideConservativeRoute>,
    reason: string,
  ): Promise<void> {
    if (params.executionRequirement?.requiredToolFamilies?.includes('web-search')) {
      const { CodexLocalCliProvider } = await import('./codex-local-cli-provider.js');
      await this.pipeFallbackStream(controller, params, {
        mode: 'hybrid',
        taskKind: 'tool_request',
        decision: 'escalate_codex',
        provider: 'codex_local_fallback',
        reason: `${reason}；当前请求匹配到非严格工具证据族，优先尝试本地 MCP 工具协议`,
        compressedPromptChars: 0,
        compressedHistoryChars: 0,
      }, new CodexLocalCliProvider(this.config));
      return;
    }
    const useTrustedExecutionProvider = this.shouldAvoidLocalPrimaryForExecution(conservative, params);
    if (useTrustedExecutionProvider) {
      this.emitLocalSuccess(controller, params.sessionId, this.buildLocalApiUnverifiedReply(), undefined, {
        mode: 'hybrid',
        taskKind: conservative.requestKind,
        decision: 'refuse_local',
        provider: 'refuse_local',
        reason: '本地 API 未通过工具调用探测，按配置拒绝执行类任务',
        compressedPromptChars: 0,
        compressedHistoryChars: 0,
      });
      return;
    }
    const provider = this.fallbackProvider;
    const executionReason = useTrustedExecutionProvider
      ? `${reason}；本地 API 未通过工具调用探测，执行类任务改交官方/外部 Codex`
      : reason;
    try {
      await this.pipeFallbackStream(controller, params, {
        mode: 'hybrid',
        taskKind: conservative.requestKind,
        decision: 'escalate_codex',
        provider: 'codex',
        reason: executionReason,
        compressedPromptChars: 0,
        compressedHistoryChars: 0,
      }, provider);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const handledByLocalToolFallback = await this.tryDeterministicLocalToolFallbackAfterCodexFailure(
        controller,
        params,
        conservative,
        message,
      );
      if (handledByLocalToolFallback) return;
      const handledByConfiguredToolFallback = await this.tryConfiguredJsonToolFallbackAfterCodexFailure(
        controller,
        params,
        conservative,
        message,
      );
      if (handledByConfiguredToolFallback) return;
      if (!this.isLocalAgentApiFallbackEnabled()) {
        throw new Error(`Codex 主模型失败，自动切换链未启用可用来源：${summarizeCodexFailureMessage(message)}`);
      }
      if (this.localAgent.canHandleMcpBridgeFastPathV2(params)) {
        try {
          const mcpResult = await this.localAgent.handleMcpBridgeFastPathV2(controller, params, 'hybrid');
          if (mcpResult.handled) return;
        } catch (mcpError) {
          const localFailure = mcpError instanceof Error ? mcpError.message : String(mcpError);
          this.emitLocalSuccess(controller, params.sessionId, `Codex/MCP 执行链不可用：${summarizeCodexFailureMessage(message)} 本地 MCP 状态检查也失败了：${truncatePreview(localFailure, 120)}`, undefined, {
            mode: 'hybrid',
            taskKind: conservative.requestKind,
            decision: 'refuse_local',
            provider: 'codex_local_fallback',
            reason: `Codex 失败后 MCP 动态检查失败：${message}`,
            compressedPromptChars: 0,
            compressedHistoryChars: 0,
            fallbackReason: localFailure,
          });
          return;
        }
      }
      if (requiresConcreteToolOutput(conservative.requestKind, params.prompt)) {
        await this.pipeLocalAgentApiFallback(controller, params, conservative, `主 Codex API 失败，切换本地模型 API 继续工具任务：${message}`, message);
        return;
      }
      await this.pipeLocalAgentApiFallback(controller, params, conservative, `主 Codex API 失败，切换本地模型 API：${message}`, message);
    }
  }

  private async tryDeterministicLocalToolFallbackAfterCodexFailure(
    controller: ReadableStreamDefaultController<string>,
    params: Parameters<LLMProvider['streamChat']>[0],
    conservative: ReturnType<typeof decideConservativeRoute>,
    primaryFailure: string,
  ): Promise<boolean> {
    if (!this.isDeterministicReadOnlyFallbackCandidate(params.prompt)) return false;
    const safeConservative = {
      ...conservative,
      useLocal: true,
      allowLocalFallback: true,
      highRisk: false,
      canFastPath: true,
      preferredDecision: 'answer_local' as const,
      reason: `Codex 主模型失败，尝试受控只读工具兜底：${conservative.reason}`,
    };
    if (!this.localAgent.canHandleFastPath(params, safeConservative)) return false;
    const executed = await this.localAgent.handleFastPath(controller, params, {
      mode: 'hybrid',
      conservative: safeConservative,
    });
    if (executed.handled) return true;
    appendLocalLlmRouteSummary(this.config, {
      timestamp: new Date().toISOString(),
      mode: 'hybrid',
      taskKind: conservative.requestKind,
      decision: 'escalate_codex',
      provider: 'local_best_effort',
      reason: `Codex 失败后只读工具兜底未处理：${executed.fallbackReason || primaryFailure}`,
      compressedPromptChars: 0,
      compressedHistoryChars: 0,
      fallbackReason: primaryFailure,
    });
    return false;
  }

  private async tryConfiguredJsonToolFallbackAfterCodexFailure(
    controller: ReadableStreamDefaultController<string>,
    params: Parameters<LLMProvider['streamChat']>[0],
    conservative: ReturnType<typeof decideConservativeRoute>,
    primaryFailure: string,
  ): Promise<boolean> {
    const requirement = params.executionRequirement;
    if (requirement?.kind !== 'tool_required' && requirement?.kind !== 'artifact_required') return false;
    const contextText = [params.systemPrompt || '', params.prompt || ''].filter(Boolean).join('\n');
    const plan = planDeterministicJsonToolRequest(params.prompt, {
      workingDirectory: params.workingDirectory,
      contextText,
      requirementKind: requirement.kind,
      mcpToolCallDefinitions: loadMcpToolCallDefinitions(),
      unityMcpExecuteCodeDefinitions: loadUnityMcpExecuteCodeDefinitions(),
      shellArtifactDefinitions: loadShellArtifactDefinitions(),
    });
    if (!plan) return false;

    try {
      const { CodexLocalCliProvider } = await import('./codex-local-cli-provider.js');
      await this.pipeFallbackStream(controller, params, {
        mode: getLocalRouterMode(this.config),
        taskKind: conservative.requestKind,
        decision: 'escalate_codex',
        provider: 'codex_local_fallback',
        reason: `主 Codex API 失败，使用已匹配的本地工具动作兜底：${plan.reason}；${summarizeCodexFailureMessage(primaryFailure)}`,
        compressedPromptChars: 0,
        compressedHistoryChars: 0,
        fallbackReason: primaryFailure,
      }, new CodexLocalCliProvider(this.config));
      return true;
    } catch (error) {
      const fallbackFailure = error instanceof Error ? error.message : String(error);
      appendLocalLlmRouteSummary(this.config, {
        timestamp: new Date().toISOString(),
        mode: getLocalRouterMode(this.config),
        taskKind: conservative.requestKind,
        decision: 'escalate_codex',
        provider: 'codex_local_fallback',
        reason: `已匹配本地工具动作，但兜底执行失败：${truncatePreview(fallbackFailure, 180)}`,
        compressedPromptChars: 0,
        compressedHistoryChars: 0,
        fallbackReason: primaryFailure,
      });
      return false;
    }
  }

  private isDeterministicReadOnlyFallbackCandidate(prompt: string): boolean {
    const text = (prompt || '').trim();
    if (!text) return false;
    if (/(git\s+(pull|push|fetch|rebase|merge|reset|checkout|switch|cherry-pick|clean|stash|commit)|发布|修改|写入|删除|创建文件|保存|关机|shutdown|unity|mcp|blender|截图|图片|附件|导入|导出)/i.test(text)) {
      return false;
    }
    return /(\bgit status\b|\bgit branch\b|\bgit log\b|git.*暂存区|暂存区.*(有啥|有什么|状态|内容)|staged|cached|当前分支|分支是什么|最近.*提交|提交记录|读取文件|查看文件|打开文件|搜索文本|查找字符串)/i.test(text);
  }

  private async pipeFallbackStream(
    controller: ReadableStreamDefaultController<string>,
    params: Parameters<LLMProvider['streamChat']>[0],
    summary: Omit<LocalLlmRouteSummary, 'timestamp'>,
    provider: LLMProvider = this.fallbackProvider,
  ): Promise<void> {
    const current = readLocalLlmStatus(this.config);
    appendLocalLlmRouteSummary(this.config, {
      timestamp: new Date().toISOString(),
      ...summary,
    }, {
      routeHits: current.routeHits + 1,
      escalationCount: current.escalationCount + 1,
      serverReachable: true,
      lastCheckAt: new Date().toISOString(),
      lastError: '',
    });
    controller.enqueue(sseEvent('status', {
      provider: summary.provider,
      routeMode: summary.mode,
      routeDecision: summary.decision,
      routeReason: summary.reason,
      compressedPromptChars: summary.compressedPromptChars,
      compressedHistoryChars: summary.compressedHistoryChars,
      ...(summary.promptProfile ? { promptProfile: summary.promptProfile } : {}),
    }));
    try {
      const stream = provider.streamChat(params);
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const fatalError = extractCodexFatalStreamError(value);
        if (fatalError) {
          throw new Error(fatalError);
        }
        controller.enqueue(value);
      }
      controller.close();
    } catch (error) {
      throw (error instanceof Error ? error : new Error(String(error)));
    }
  }

  private emitLocalSuccess(
    controller: ReadableStreamDefaultController<string>,
    sessionId: string,
    text: string,
    usage: Record<string, unknown> | undefined,
    summary: Omit<LocalLlmRouteSummary, 'timestamp'>,
  ): void {
    const current = readLocalLlmStatus(this.config);
    const patch = summary.provider === 'local_best_effort'
      ? { localOnlyAnswers: current.localOnlyAnswers + 1 }
      : summary.provider === 'refuse_local'
        ? { localRefusals: current.localRefusals + 1 }
        : { routeHits: current.routeHits + 1 };

    appendLocalLlmRouteSummary(this.config, {
      timestamp: new Date().toISOString(),
      ...summary,
    }, {
      ...patch,
      serverReachable: true,
      lastCheckAt: new Date().toISOString(),
      lastError: '',
    });
    const localModel = this.config.localAiModel || this.config.ollamaModel || this.config.localLlmModel;
    const localBaseUrl = this.config.localAiBaseUrl || this.config.ollamaBaseUrl || this.config.localLlmBaseUrl;
    controller.enqueue(sseEvent('status', {
      provider: summary.provider,
      routeMode: summary.mode,
      routeDecision: summary.decision,
      routeReason: summary.reason,
      compressedPromptChars: summary.compressedPromptChars,
      compressedHistoryChars: summary.compressedHistoryChars,
      ...(summary.promptProfile ? { promptProfile: summary.promptProfile } : {}),
      ...(summary.provider === 'local_best_effort'
        ? {
            modelSource: 'local_api',
            ...(localModel ? { model: localModel } : {}),
            ...(localBaseUrl ? { baseUrl: localBaseUrl } : {}),
          }
        : {}),
    }));
    controller.enqueue(sseEvent('text', text));
    controller.enqueue(sseEvent('result', {
      subtype: 'success',
      is_error: false,
      session_id: sessionId,
      usage: usage || {},
    }));
    controller.close();
  }
}

function collectTsFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    } else if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function computeFingerprint(paths: string[]): string {
  const hash = crypto.createHash('sha256');
  for (const filePath of paths.filter((value, index, array) => value && array.indexOf(value) === index).sort()) {
    if (!fs.existsSync(filePath)) continue;
    hash.update(filePath);
    hash.update('\n');
    hash.update(fs.readFileSync(filePath));
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, 16);
}

function computeRuntimeFingerprints(): { bridgeFingerprint: string; toolingFingerprint: string } {
  const bridgeFiles = [
    ...collectTsFiles(path.join(CORE_ROOT, 'src', 'lib', 'bridge')),
    path.join(SKILL_ROOT, 'src', 'store.ts'),
    path.join(SKILL_ROOT, 'src', 'config.ts'),
  ];
  const toolingFiles = [
    path.join(SKILL_ROOT, 'src', 'codex-provider.ts'),
    path.join(SKILL_ROOT, 'src', 'codex-local-cli-provider.ts'),
    path.join(SKILL_ROOT, 'src', 'local-agent-tool-protocol.ts'),
    path.join(SKILL_ROOT, 'src', 'local-codex-provider-registry.ts'),
    path.join(SKILL_ROOT, 'src', 'llm-provider.ts'),
    path.join(SKILL_ROOT, 'src', 'main.ts'),
    path.join(SKILL_ROOT, 'src', 'local-llm-provider.ts'),
    path.join(SKILL_ROOT, 'src', 'local-llm-router.ts'),
    path.join(SKILL_ROOT, 'src', 'knowledge-indexer.ts'),
    path.join(SKILL_ROOT, 'src', 'knowledge-index-service.ts'),
  ];
  return {
    bridgeFingerprint: computeFingerprint(bridgeFiles),
    toolingFingerprint: computeFingerprint(toolingFiles),
  };
}

interface StreamEvidence {
  toolUseCount: number;
  toolResultCount: number;
  successfulToolResultCount: number;
  failedToolResultCount: number;
  failedToolErrors: string[];
  toolNames: string[];
  provider?: string;
  codexProfile?: string;
  modelSource?: string;
  attemptedSources?: string[];
  selectedSource?: CodexModelSource;
  model?: string;
  baseUrl?: string;
  requiredEvidenceKind?: 'none' | 'local_read_required' | 'tool_required' | 'artifact_required';
  evidenceSatisfied?: boolean;
  noEvidenceRetryAttempted?: boolean;
  requiredToolFamilies?: string[];
  evidenceProtocol?: string;
  requestedTool?: string;
  executedTool?: string;
  jsonToolRetryAttempted?: boolean;
  jsonToolFallbackUsed?: boolean;
  shellExitCode?: number;
  shellDurationMs?: number;
  progressCardCreated?: boolean;
  progressCardFinalized?: boolean;
  progressCardFallbackReason?: string;
  promptProfile?: string;
  tokenUsage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    total_tokens?: number;
  };
}

function emptyStreamEvidence(): StreamEvidence {
  return {
    toolUseCount: 0,
    toolResultCount: 0,
    successfulToolResultCount: 0,
    failedToolResultCount: 0,
    failedToolErrors: [],
    toolNames: [],
  };
}

function seedExecutionRequirementEvidence(evidence: StreamEvidence, params: Parameters<LLMProvider['streamChat']>[0]): void {
  const requirement = params.executionRequirement;
  if (!requirement) return;
  evidence.requiredEvidenceKind = requirement.kind;
  evidence.evidenceSatisfied = requirement.kind === 'none';
  evidence.requiredToolFamilies = requirement.requiredToolFamilies;
  evidence.noEvidenceRetryAttempted = params.noEvidenceRetryAttempted === true;
}

function readUsageNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function collectStreamEvidence(value: string, evidence: StreamEvidence): void {
  for (const event of parseBridgeSseEvents(value)) {
    const data = event.data && typeof event.data === 'object'
      ? event.data as Record<string, unknown>
      : null;
    if (event.type === 'tool_use') {
      evidence.toolUseCount += 1;
      const name = typeof data?.name === 'string' ? data.name.trim() : '';
      if (name && !evidence.toolNames.includes(name)) evidence.toolNames.push(name);
      continue;
    }
    if (event.type === 'tool_result') {
      evidence.toolResultCount += 1;
      const resultQuality = classifyToolResultQuality(data?.content, data?.is_error === true);
      if (!resultQuality.ok) {
        evidence.failedToolResultCount += 1;
        const errorSummary = resultQuality.errorSummary;
        if (errorSummary && !evidence.failedToolErrors.includes(errorSummary)) {
          evidence.failedToolErrors = [...evidence.failedToolErrors, errorSummary].slice(0, 3);
        }
      } else {
        evidence.successfulToolResultCount += 1;
        if (evidence.requiredEvidenceKind && evidence.requiredEvidenceKind !== 'none') {
          evidence.evidenceSatisfied = true;
        }
      }
      continue;
    }
    if (event.type === 'status' && data) {
      if (typeof data.provider === 'string') evidence.provider = data.provider;
      if (typeof data.codexProfile === 'string') evidence.codexProfile = data.codexProfile;
      if (typeof data.modelSource === 'string') evidence.modelSource = data.modelSource;
      if (Array.isArray(data.attemptedSources)) evidence.attemptedSources = data.attemptedSources.filter((item): item is string => typeof item === 'string');
      if (data.selectedSource === 'local_api' || data.selectedSource === 'external_api' || data.selectedSource === 'official') evidence.selectedSource = data.selectedSource;
      if (typeof data.model === 'string') evidence.model = data.model;
      if (typeof data.baseUrl === 'string') evidence.baseUrl = data.baseUrl;
      if (typeof data.evidenceProtocol === 'string') evidence.evidenceProtocol = data.evidenceProtocol;
      if (typeof data.requestedTool === 'string') evidence.requestedTool = data.requestedTool;
      if (typeof data.executedTool === 'string') evidence.executedTool = data.executedTool;
      if (typeof data.jsonToolRetryAttempted === 'boolean') evidence.jsonToolRetryAttempted = data.jsonToolRetryAttempted;
      if (typeof data.jsonToolFallbackUsed === 'boolean') evidence.jsonToolFallbackUsed = data.jsonToolFallbackUsed;
      if (typeof data.shellExitCode === 'number') evidence.shellExitCode = data.shellExitCode;
      if (typeof data.shellDurationMs === 'number') evidence.shellDurationMs = data.shellDurationMs;
      if (typeof data.progressCardCreated === 'boolean') evidence.progressCardCreated = data.progressCardCreated;
      if (typeof data.progressCardFinalized === 'boolean') evidence.progressCardFinalized = data.progressCardFinalized;
      if (typeof data.progressCardFallbackReason === 'string') evidence.progressCardFallbackReason = data.progressCardFallbackReason;
      if (typeof data.promptProfile === 'string') evidence.promptProfile = data.promptProfile;
      if (typeof data.evidenceSatisfied === 'boolean') evidence.evidenceSatisfied = data.evidenceSatisfied;
      continue;
    }
    if (event.type === 'result' && data) {
      const usage = data.usage && typeof data.usage === 'object'
        ? data.usage as Record<string, unknown>
        : null;
      if (!usage) continue;
      const inputTokens = readUsageNumber(usage.input_tokens);
      const outputTokens = readUsageNumber(usage.output_tokens);
      const cacheReadInputTokens = readUsageNumber(usage.cache_read_input_tokens);
      const cacheCreationInputTokens = readUsageNumber(usage.cache_creation_input_tokens);
      if (
        inputTokens === undefined
        && outputTokens === undefined
        && cacheReadInputTokens === undefined
        && cacheCreationInputTokens === undefined
      ) {
        continue;
      }
      evidence.tokenUsage = {
        ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
        ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
        ...(cacheReadInputTokens !== undefined ? { cache_read_input_tokens: cacheReadInputTokens } : {}),
        ...(cacheCreationInputTokens !== undefined ? { cache_creation_input_tokens: cacheCreationInputTokens } : {}),
        ...((inputTokens !== undefined || outputTokens !== undefined)
          ? { total_tokens: (inputTokens || 0) + (outputTokens || 0) }
          : {}),
      };
    }
  }
}

function flushWorkflowEvidence(runId: string, evidence: StreamEvidence): void {
  const payload: Record<string, unknown> = {
    toolUseCount: evidence.toolUseCount,
    toolResultCount: evidence.toolResultCount,
    successfulToolResultCount: evidence.successfulToolResultCount,
    failedToolResultCount: evidence.failedToolResultCount,
    failedToolErrors: evidence.failedToolErrors,
    toolNames: evidence.toolNames,
  };
  if (evidence.provider) payload.provider = evidence.provider;
  if (evidence.codexProfile) payload.codexProfile = evidence.codexProfile;
  if (evidence.modelSource) payload.modelSource = evidence.modelSource;
  if (evidence.attemptedSources?.length) payload.attemptedSources = evidence.attemptedSources;
  if (evidence.selectedSource) payload.selectedSource = evidence.selectedSource;
  if (evidence.model) payload.model = evidence.model;
  if (evidence.baseUrl) payload.baseUrl = evidence.baseUrl;
  if (evidence.requiredEvidenceKind) payload.requiredEvidenceKind = evidence.requiredEvidenceKind;
  if (typeof evidence.evidenceSatisfied === 'boolean') payload.evidenceSatisfied = evidence.evidenceSatisfied;
  if (typeof evidence.noEvidenceRetryAttempted === 'boolean') payload.noEvidenceRetryAttempted = evidence.noEvidenceRetryAttempted;
  if (evidence.requiredToolFamilies?.length) payload.requiredToolFamilies = evidence.requiredToolFamilies;
  if (evidence.evidenceProtocol) payload.evidenceProtocol = evidence.evidenceProtocol;
  if (evidence.requestedTool) payload.requestedTool = evidence.requestedTool;
  if (evidence.executedTool) payload.executedTool = evidence.executedTool;
  if (typeof evidence.jsonToolRetryAttempted === 'boolean') payload.jsonToolRetryAttempted = evidence.jsonToolRetryAttempted;
  if (typeof evidence.jsonToolFallbackUsed === 'boolean') payload.jsonToolFallbackUsed = evidence.jsonToolFallbackUsed;
  if (typeof evidence.shellExitCode === 'number') payload.shellExitCode = evidence.shellExitCode;
  if (typeof evidence.shellDurationMs === 'number') payload.shellDurationMs = evidence.shellDurationMs;
  if (typeof evidence.progressCardCreated === 'boolean') payload.progressCardCreated = evidence.progressCardCreated;
  if (typeof evidence.progressCardFinalized === 'boolean') payload.progressCardFinalized = evidence.progressCardFinalized;
  if (evidence.progressCardFallbackReason) payload.progressCardFallbackReason = evidence.progressCardFallbackReason;
  if (evidence.promptProfile) payload.promptProfile = evidence.promptProfile;
  if (evidence.tokenUsage) payload.tokenUsage = evidence.tokenUsage;
  appendWorkflowEvent(runId, 'finalizing', 'execution.evidence', '执行证据已记录', payload);
}

function createObservedController(
  controller: ReadableStreamDefaultController<string>,
  evidence: StreamEvidence,
): ReadableStreamDefaultController<string> {
  return {
    enqueue(value: string) {
      collectStreamEvidence(value, evidence);
      controller.enqueue(value);
    },
    close() {
      controller.close();
    },
    error(reason?: unknown) {
      controller.error(reason);
    },
    desiredSize: controller.desiredSize,
  } as ReadableStreamDefaultController<string>;
}

class ObservedLLMProvider implements LLMProvider {
  constructor(
    private readonly config: Config,
    private readonly store: BridgeStore,
    private readonly provider: LLMProvider,
    private readonly primaryExecutorId: string,
  ) {}

  streamChat(params: Parameters<LLMProvider['streamChat']>[0]): ReturnType<LLMProvider['streamChat']> {
    return new ReadableStream<string>({
      start: async (controller) => {
        const binding = this.store
          .listChannelBindings()
          .find((item) => item.codepilotSessionId === params.sessionId);
        const workflowRun = startWorkflowRun({
          sessionId: params.sessionId,
          prompt: params.prompt,
          channelType: binding?.channelType,
          chatId: binding?.chatId,
        });
        recordWorkflowRecoveryInfo(workflowRun.id, {
          prompt: params.prompt,
          workingDirectory: params.workingDirectory,
          model: params.model,
          systemPrompt: params.systemPrompt,
          permissionMode: params.permissionMode,
          channelType: binding?.channelType,
          chatId: binding?.chatId,
          userId: params.sourceUserId,
          userDisplayName: params.sourceUserDisplayName,
          messageId: params.sourceMessageId,
        });
        const evidence = emptyStreamEvidence();
        seedExecutionRequirementEvidence(evidence, params);
        const observedController = createObservedController(controller, evidence);
        try {
          appendWorkflowEvent(workflowRun.id, 'authorized', 'workflow.authorized', '请求进入执行器路由前置阶段');
          appendWorkflowEvent(workflowRun.id, 'contextualized', 'workflow.contextualized', '会话和工作区上下文已准备');
          const sessionDefaults = readSessionExecutorDefaults(this.config);
          const requestedExecutorId = inferRequestedExecutorId(params.prompt) || sessionDefaults[params.sessionId];
          const selection = selectExecutor(this.config, {
            sessionId: params.sessionId,
            prompt: params.prompt,
            workingDirectory: params.workingDirectory,
            permissionMode: params.permissionMode,
            requestedExecutorId,
            preferredExecutorId: this.primaryExecutorId,
            params,
          }, sessionDefaults[params.sessionId]);
          writeExecutorStatus(this.config, { sessionId: params.sessionId, selection });
          setWorkflowExecutor(workflowRun.id, selection.executor.id, selection.reason);
          const configuredModelSource = this.config.codexModelSource || (
            this.config.codexBaseUrl || this.config.codexModel || this.config.codexApiKey
              ? 'external_api'
              : 'official'
          );
          appendWorkflowEvent(workflowRun.id, 'executing', 'executor.executing', `执行器开始处理：${selection.executor.displayName}`, {
            executorId: selection.executor.id,
            fallbackExecutorIds: selection.fallbackExecutorIds,
            codexModelSource: configuredModelSource,
            localAiModel: this.config.localAiModel || this.config.ollamaModel || this.config.localLlmModel,
            localAiBaseUrl: this.config.localAiBaseUrl || this.config.ollamaBaseUrl || this.config.localLlmBaseUrl,
          });
          const stream = this.provider.streamChat(params);
          const reader = stream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            observedController.enqueue(value);
          }
          flushWorkflowEvidence(workflowRun.id, evidence);
          completeWorkflowRun(workflowRun.id);
          observedController.close();
        } catch (error) {
          flushWorkflowEvidence(workflowRun.id, evidence);
          failWorkflowRun(workflowRun.id, error);
          if (shouldAutoRetryWorkflowError(error)) {
            requestWorkflowRetry(workflowRun.id, 'auto');
          }
          try {
            observedController.enqueue(sseEvent('error', error instanceof Error ? error.message : String(error)));
            observedController.close();
          } catch {
            // ignore already closed controller
          }
        }
      },
    });
  }
}

async function resolveProvider(config: Config, pendingPerms: PendingPermissions, store: BridgeStore): Promise<LLMProvider> {
  const wrapWithLocalHub = (
    provider: LLMProvider,
    primaryExecutorId: string,
  ): LLMProvider => {
    const localProvider = new OllamaProvider(config);
    return new HubLlmProvider(
      config,
      store,
      localProvider,
      new LocalAgentProvider(config, pendingPerms, localProvider),
      provider,
      null,
      primaryExecutorId,
      provider,
    );
  };
  const wrapCodexMainProvider = (provider: LLMProvider): LLMProvider => (
    new ManifestSlimCodexProvider(config, wrapWithLocalHub(provider, 'codex'))
  );

  const runtime = config.runtime;

  if (runtime === 'codex') {
    const { CodexProvider } = await import('./codex-provider.js');
    const { CodexLocalCliProvider } = await import('./codex-local-cli-provider.js');
    const createCodexProvider = (source: CodexModelSource): LLMProvider => source === 'local_api'
      ? new CodexLocalCliProvider(config)
      : new CodexProvider(pendingPerms, {
        profile: source === 'official' ? 'official' : 'external',
      });
    const failoverChain: CodexModelSource[] = (config.codexApiFallbackChain || ['local_api', 'external_api'])
      .filter((source) => isCodexSourceConfigured(config, source));
    const primaryProvider = config.codexRoutingMode === 'auto_failover'
      ? new CodexApiFailoverProvider((failoverChain.length > 0 ? failoverChain : ['local_api'] as CodexModelSource[]).map((source) => ({
        source,
        provider: createCodexProvider(source),
      })))
      : createCodexProvider(config.codexModelSource || 'official');
    return wrapCodexMainProvider(primaryProvider);
  }

  if (runtime === 'auto') {
    const cliPath = resolveClaudeCliPath();
    if (cliPath) {
      const check = preflightCheck(cliPath);
      if (check.ok) {
        console.log(`[claude-to-im] Auto: using Claude CLI at ${cliPath} (${check.version})`);
        return wrapWithLocalHub(new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove), 'claude-cli');
      }
      console.warn(
        `[claude-to-im] Auto: Claude CLI at ${cliPath} failed preflight: ${check.error}\n` +
        '  Falling back to Codex.',
      );
    } else {
      console.log('[claude-to-im] Auto: Claude CLI not found, falling back to Codex');
    }
    const { CodexProvider } = await import('./codex-provider.js');
    const { CodexLocalCliProvider } = await import('./codex-local-cli-provider.js');
    const createCodexProvider = (source: CodexModelSource): LLMProvider => source === 'local_api'
      ? new CodexLocalCliProvider(config)
      : new CodexProvider(pendingPerms, {
        profile: source === 'official' ? 'official' : 'external',
      });
    const failoverChain: CodexModelSource[] = (config.codexApiFallbackChain || ['local_api', 'external_api'])
      .filter((source) => isCodexSourceConfigured(config, source));
    const primaryProvider = config.codexRoutingMode === 'auto_failover'
      ? new CodexApiFailoverProvider((failoverChain.length > 0 ? failoverChain : ['local_api'] as CodexModelSource[]).map((source) => ({
        source,
        provider: createCodexProvider(source),
      })))
      : createCodexProvider(config.codexModelSource || 'official');
    return wrapCodexMainProvider(primaryProvider);
  }

  const cliPath = resolveClaudeCliPath();
  if (!cliPath) {
    console.error(
      '[claude-to-im] FATAL: Cannot find the `claude` CLI executable.\n' +
      '  Tried: CTI_CLAUDE_CODE_EXECUTABLE env, /usr/local/bin/claude, /opt/homebrew/bin/claude, ~/.npm-global/bin/claude, ~/.local/bin/claude\n' +
      '  Fix: Install Claude Code CLI or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/claude\n' +
      '  Or set CTI_RUNTIME=codex to use Codex instead',
    );
    process.exit(1);
  }

  const check = preflightCheck(cliPath);
  if (check.ok) {
    console.log(`[claude-to-im] CLI preflight OK: ${cliPath} (${check.version})`);
  } else {
    console.error(
      `[claude-to-im] FATAL: Claude CLI preflight check failed.\n` +
      `  Path: ${cliPath}\n` +
      `  Error: ${check.error}\n` +
      '  Fix:\n' +
      '    1. Install Claude Code CLI >= 2.x\n' +
      '    2. Or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/correct/claude\n' +
      '    3. Or set CTI_RUNTIME=auto to fall back to Codex',
    );
    process.exit(1);
  }

  return wrapWithLocalHub(new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove), 'claude-cli');
}

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  lastExitReason?: string | null;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* ignore */ }
  const merged = { ...existing, ...info };
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

async function collectWorkflowRetryResponse(
  llm: LLMProvider,
  params: Parameters<LLMProvider['streamChat']>[0],
): Promise<string> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 10 * 60 * 1000);
  const parts: string[] = [];
  try {
    const stream = llm.streamChat({
      ...params,
      forceFreshThread: true,
      abortController,
    });
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const fatal = extractCodexFatalStreamError(value);
      if (fatal) throw new Error(fatal);
      for (const event of parseBridgeSseEvents(value)) {
        if (event.type === 'permission_request') {
          abortController.abort();
          throw new Error('重试执行触发权限请求，第一版后台重试不会代替用户授权。请在聊天里重新发送该请求。');
        }
        if (event.type === 'text' && typeof event.data === 'string') {
          parts.push(event.data);
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return parts.join('').trim();
}

function startWorkflowRetryService(
  runId: string,
  llm: LLMProvider,
  store: BridgeStore,
  cloudDocuments?: ReturnType<typeof createFeishuCloudDocumentHost>,
): NodeJS.Timeout {
  let active = false;
  const workerId = `runtime:${runId}`;
  const tick = async () => {
    if (active) return;
    active = true;
    const claimed = claimNextWorkflowRetry(workerId);
    try {
      if (!claimed) return;
      const input = claimed.recovery?.input;
      if (!input?.prompt) {
        failWorkflowRetry(claimed.id, new Error('缺少可重试输入'));
        return;
      }
      const prepared = await prepareWorkflowRetryExecution({
        run: claimed,
        cloudDocuments,
      });
      const channelType = input.channelType || claimed.channelType;
      const chatId = input.chatId || claimed.chatId;
      if (prepared.status === 'blocked') {
        if (channelType && chatId) {
          const delivered = await bridgeManager.deliverProactiveMessage({
            address: {
              channelType,
              chatId,
              displayName: claimed.chatId || chatId,
            },
            text: prepared.text,
            parseMode: 'plain',
            sessionId: claimed.sessionId,
            feishuCardJson: prepared.feishuCardJson,
            dedupKey: `workflow-retry-cloud-blocker:${claimed.id}:${claimed.retry?.attempts || 0}`,
          });
          if (!delivered.ok) {
            throw new Error(`云文档授权提示发送失败：${delivered.error || 'unknown error'}`);
          }
        }
        failWorkflowRetry(claimed.id, new Error(prepared.text));
        return;
      }
      const text = await collectWorkflowRetryResponse(llm, prepared.params);
      if (!text) {
        throw new Error('重试执行没有返回可发送文本');
      }
      store.addMessage(claimed.sessionId, 'user', input.prompt);
      store.addMessage(claimed.sessionId, 'assistant', text);
      if (channelType && chatId) {
        const hasFinalReplyBlock = /```cti-final\b/i.test(text) || /"kind"\s*:\s*"(?:text|image|file|mixed)"/i.test(text);
        const outboundText = hasFinalReplyBlock
          ? text
          : `断点续跑重试结果：\n\n${text}`;
        const delivered = await bridgeManager.deliverProactiveMessage({
          address: {
            channelType,
            chatId,
            displayName: claimed.chatId || chatId,
          },
          text: outboundText,
          parseMode: 'plain',
          replyToMessageId: input.messageId,
          sessionId: claimed.sessionId,
          prepareFinalReply: true,
          workingDirectory: input.workingDirectory,
          sourcePrompt: input.prompt,
          dedupKey: `workflow-retry:${claimed.id}:${claimed.retry?.attempts || 0}`,
        });
        if (!delivered.ok) {
          throw new Error(`重试结果发送失败：${delivered.error || 'unknown error'}`);
        }
      }
      completeWorkflowRetry(claimed.id);
    } catch (error) {
      const failed = readWorkflowStatus().runs.find((item) => item.retry?.claimedBy === workerId && item.status === 'retrying');
      if (failed) {
        failWorkflowRetry(failed.id, error);
      } else {
        console.warn('[claude-to-im] Workflow retry failed:', error instanceof Error ? error.message : error);
      }
    } finally {
      active = false;
    }
  };
  setTimeout(() => { tick().catch((error) => console.warn('[claude-to-im] Workflow retry tick failed:', error)); }, 1200);
  return setInterval(() => {
    tick().catch((error) => console.warn('[claude-to-im] Workflow retry tick failed:', error));
  }, 8000);
}

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();
  clearLocalLlmTransientStatus(config);

  const runId = crypto.randomUUID();
  console.log(`[claude-to-im] Starting bridge (run_id: ${runId})`);
  initializeBridgeRuntimeAudit(runId, process.pid);
  const interruptedRuns = markInterruptedWorkflowRuns(runId);
  if (interruptedRuns.length > 0) {
    const recoverable = interruptedRuns.filter((run) => run.recovery?.kind === 'recoverable').length;
    console.warn(`[claude-to-im] Workflow recovery: marked ${interruptedRuns.length} interrupted run(s), recoverable=${recoverable}`);
  }

  const settings = configToSettings(config);
  if (!settings.get('bridge_unity_mcp_endpoint_list')) {
    settings.set('bridge_unity_mcp_endpoint_list', 'http://127.0.0.1:8081/mcp;http://127.0.0.1:8080/mcp;http://127.0.0.1:8080');
  }
  if (!settings.get('bridge_unity_mcp_start_command')) {
    const unityLauncher = path.join(SKILL_ROOT, 'scripts', 'launch-unity-mcp.ps1').replace(/'/g, "''");
    settings.set('bridge_unity_mcp_start_command', `& '${unityLauncher}'`);
  }
  const { bridgeFingerprint, toolingFingerprint } = computeRuntimeFingerprints();
  settings.set('bridge_runtime_fingerprint', bridgeFingerprint);
  settings.set('bridge_tooling_fingerprint', toolingFingerprint);

  const store = new JsonFileStore(settings);
  const knowledgeWatcher = config.memoryRepoDir
    ? startKnowledgeIndexWatcher(config.memoryRepoDir)
    : null;
  const memoryOptimizer = config.memoryRepoDir
    ? startMemoryOptimizerService(config.memoryRepoDir, config)
    : null;
  let todoReminderService: TodoReminderService | null = null;
  let workflowRetryTimer: NodeJS.Timeout | null = null;
  if (knowledgeWatcher) {
    const status = knowledgeWatcher.status();
    console.log(`[claude-to-im] Knowledge index: ${status.itemCount} items, watching=${status.watching}, root=${status.memoryRoot}`);
    if (status.lastError) {
      console.warn(`[claude-to-im] Knowledge index warning: ${status.lastError}`);
    }
  }
  if (memoryOptimizer) {
    const status = memoryOptimizer.status();
    console.log(`[claude-to-im] Memory optimizer: enabled=${status.enabled}, drafts=${status.draftCount}, next=${status.nextRunAt || '-'}`);
    if (status.recentError) {
      console.warn(`[claude-to-im] Memory optimizer warning: ${status.recentError}`);
    }
  }
  const pendingPerms = new PendingPermissions();
  try {
    writeExecutorStatus(config);
  } catch (error) {
    console.warn('[claude-to-im] Failed to write executor baseline status:', error instanceof Error ? error.message : error);
  }
  const llm = await resolveProvider(config, pendingPerms, store);
  console.log(`[claude-to-im] Runtime: ${config.runtime}`);

  const gateway = {
    resolvePendingPermission: (id: string, resolution: { behavior: 'allow' | 'deny'; message?: string }) =>
      pendingPerms.resolve(id, resolution),
  };
  const feishuOAuthTokenStore = new FeishuOAuthTokenStore(path.join(CTI_HOME, 'data', 'feishu-oauth-tokens.json'));
  const feishuOAuthStateStore = new FeishuOAuthStateStore(path.join(CTI_HOME, 'runtime', 'feishu-oauth-states.json'));
  const feishuOAuthService = new FeishuOAuthService({
    config: {
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
      mode: config.feishuOAuthMode || 'callback',
      publicBaseUrl: config.feishuOAuthPublicBaseUrl,
      manualRedirectUri: config.feishuOAuthManualRedirectUri,
      callbackPath: config.feishuOAuthCallbackPath || '/feishu/oauth/callback',
      callbackPort: config.feishuOAuthCallbackPort ?? 17321,
      scopes: config.feishuOAuthScopes || [],
      waitForAuthorizationMs: 0,
    },
    tokenStore: feishuOAuthTokenStore,
    stateStore: feishuOAuthStateStore,
  });
  const feishuTenantTokenProvider = new FeishuTenantAccessTokenProvider({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
  });
  const feishuCloudDocuments = createFeishuCloudDocumentHost({
    config: {
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
      maxChars: config.feishuCloudMaxChars ?? 80000,
      maxRows: config.feishuCloudMaxRows ?? 500,
      maxRecords: config.feishuCloudMaxRecords ?? 500,
      maxSheets: config.feishuCloudMaxSheets ?? 5,
    },
    tokenProvider: feishuOAuthService,
    tenantTokenProvider: feishuTenantTokenProvider,
  });
  const shouldStartFeishuOAuthCallbackServer = Boolean(config.feishuOAuthPublicBaseUrl)
    || config.feishuOAuthMode === 'manual';
  const feishuOAuthCallbackServer = shouldStartFeishuOAuthCallbackServer
    ? startFeishuOAuthCallbackServer(feishuOAuthService, {
      port: config.feishuOAuthCallbackPort ?? 17321,
      callbackPath: config.feishuOAuthCallbackPath || '/feishu/oauth/callback',
      onResume: async (resume) => {
        await bridgeManager.resumeFeishuOAuthRequest(resume);
      },
    })
    : null;
  if (feishuOAuthCallbackServer) {
    console.log(`[claude-to-im] Feishu OAuth callback listening on 127.0.0.1:${config.feishuOAuthCallbackPort ?? 17321}${config.feishuOAuthCallbackPath || '/feishu/oauth/callback'}`);
  }

  initBridgeContext({
    store,
    llm,
    permissions: gateway,
    extensions: createExtensionCatalogHost(),
    feishuCloudDocuments,
    feishuOAuth: {
      handleManualCallbackText: async (input) => feishuOAuthService.handleManualCallbackText({
        text: input.text,
        userId: input.userId,
      }),
    },
    memoryIntents: new ProviderMemoryIntentHost(llm),
    reminders: config.memoryRepoDir && config.directReminderEnabled !== false ? {
      createDirectReminder: async (input) => {
        try {
          const created = createDirectReminder(config.memoryRepoDir!, {
            title: input.title,
            dueAt: input.dueAt,
            timezone: input.timezone,
            target: input.target,
            sourcePrompt: input.sourcePrompt,
            createdByMessageId: input.createdByMessageId,
          });
          return {
            ok: true,
            reminderId: created.reminder.id,
            title: created.reminder.title,
            dueAt: created.reminder.dueAt,
            target: created.reminder.target,
            message: 'direct reminder created',
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      completeReminder: async (input) => {
        try {
          const completed = completeReminder(config.memoryRepoDir!, {
            reminderId: input.reminderId,
            chatId: input.chatId,
            completedAt: input.completedAt,
            completedByUserId: input.completedByUserId,
            completionSource: input.completionSource,
            callbackMessageId: input.callbackMessageId,
          });
          return completed;
        } catch (error) {
          return {
            ok: false,
            reminderId: input.reminderId,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      tickReminders: async () => {
        await todoReminderService?.tick();
      },
    } : undefined,
    lifecycle: {
      onBridgeStart: () => {
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          startedAt: new Date().toISOString(),
          channels: config.enabledChannels,
          lastExitReason: null,
        });
        console.log(`[claude-to-im] Bridge started (PID: ${process.pid}, channels: ${config.enabledChannels.join(', ')})`);
      },
      onBridgeStop: () => {
        feishuOAuthCallbackServer?.close();
        writeStatus({ running: false });
        console.log('[claude-to-im] Bridge stopped');
      },
    },
  });

  await bridgeManager.start();
  workflowRetryTimer = startWorkflowRetryService(runId, llm, store, feishuCloudDocuments);
  if (config.memoryRepoDir) {
    const todoPushChannels = config.todoPushChannels && config.todoPushChannels.length > 0
      ? config.todoPushChannels
      : ['feishu'];
    const todoPushEnabled = config.todoPushEnabled === true;
    const directReminderPushEnabled = config.directReminderEnabled !== false && config.directReminderPushEnabled !== false;
    todoReminderService = startTodoReminderService({
      memoryRoot: config.memoryRepoDir,
      enabled: todoPushEnabled || directReminderPushEnabled,
      enabledSourceTypes: [
        ...(todoPushEnabled ? ['memory' as const] : []),
        ...(directReminderPushEnabled ? ['direct' as const] : []),
      ],
      pollMs: config.todoPushPollMs ?? 60_000,
      windowMs: config.todoPushWindowMs ?? 5 * 60_000,
      enabledChannels: todoPushChannels,
      providers: [
        createFeishuPushProvider({
          enabled: (todoPushEnabled || directReminderPushEnabled) && todoPushChannels.includes('feishu'),
          deliver: (input) => bridgeManager.deliverProactiveMessage(input),
        }),
        createWeixinPushProvider(),
      ],
    });
    console.log(`[claude-to-im] Todo reminder index: enabled=${todoPushEnabled}, channels=${todoPushChannels.join(',')}`);
  }
  const heartbeatTimer = setInterval(() => {
    touchBridgeRuntimeHeartbeat();
  }, 15_000);

  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[claude-to-im] Shutting down (${reason})...`);
    pendingPerms.denyAll();
    await bridgeManager.stop();
    todoReminderService?.close();
    knowledgeWatcher?.close();
    memoryOptimizer?.close();
    if (workflowRetryTimer) clearInterval(workflowRetryTimer);
    clearInterval(heartbeatTimer);
    recordBridgeRuntimeExit(reason);
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  process.on('unhandledRejection', (reason) => {
    console.error('[claude-to-im] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
    recordBridgeRuntimeExit(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`, reason);
    writeStatus({ running: false, lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}` });
  });
  process.on('uncaughtException', (err) => {
    console.error('[claude-to-im] uncaughtException:', err.stack || err.message);
    todoReminderService?.close();
    knowledgeWatcher?.close();
    memoryOptimizer?.close();
    if (workflowRetryTimer) clearInterval(workflowRetryTimer);
    clearInterval(heartbeatTimer);
    recordBridgeRuntimeExit(`uncaughtException: ${err.message}`, err);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });
  process.on('beforeExit', (code) => {
    console.log(`[claude-to-im] beforeExit (code: ${code})`);
  });
  process.on('exit', (code) => {
    console.log(`[claude-to-im] exit (code: ${code})`);
    todoReminderService?.close();
    knowledgeWatcher?.close();
    memoryOptimizer?.close();
    if (workflowRetryTimer) clearInterval(workflowRetryTimer);
    clearInterval(heartbeatTimer);
  });

  setInterval(() => { /* keepalive */ }, 45_000);
}

main().catch((err) => {
  console.error('[claude-to-im] Fatal error:', err instanceof Error ? err.stack || err.message : err);
  try { recordBridgeRuntimeExit(`fatal: ${err instanceof Error ? err.message : String(err)}`, err); } catch { /* ignore */ }
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});
