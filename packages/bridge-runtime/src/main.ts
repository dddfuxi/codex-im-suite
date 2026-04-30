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
import {
  initializeBridgeRuntimeAudit,
  recordBridgeRuntimeExit,
  touchBridgeRuntimeHeartbeat,
} from 'claude-to-im/src/lib/bridge/runtime-audit.js';
import './adapters/weixin-adapter.js';

import type { BridgeStore, LLMProvider, RetrievedFeishuHistoryContext, RetrievedMemoryContext } from 'claude-to-im/src/lib/bridge/host.js';
import { loadConfig, configToSettings, CTI_HOME } from './config.js';
import type { Config } from './config.js';
import { JsonFileStore } from './store.js';
import { SDKLLMProvider, resolveClaudeCliPath, preflightCheck } from './llm-provider.js';
import { PendingPermissions } from './permission-gateway.js';
import { setupLogger } from './logger.js';
import { OllamaProvider } from './local-llm-provider.js';
import { LocalAgentProvider } from './local-agent-provider.js';
import {
  compressConversationHistory,
  compressPromptText,
  createCompressedParams,
  decideConservativeRoute,
  getLocalRouterMode,
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
import { sseEvent } from './sse-utils.js';
import {
  inferRequestedExecutorId,
  readSessionExecutorDefaults,
  selectExecutor,
} from './executor-registry.js';
import { shouldRetrieveMemoryForPrompt } from './memory-routing.js';
import { startKnowledgeIndexWatcher } from './knowledge-index-service.js';
import {
  createFeishuPushProvider,
  createDirectReminder,
  completeReminder,
  createWeixinPushProvider,
  startTodoReminderService,
  type TodoReminderService,
} from './todo-reminders.js';
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

function buildRecallFallbackReply(recallContext: string, codexFailure: string, localFailure?: string): string {
  const lines = [
    '先把本地记忆里能确定的内容发给你：',
    '',
    recallContext.trim(),
    '',
    `补充：${summarizeCodexFailureMessage(codexFailure)}`,
  ];
  if (localFailure) {
    lines.push(`本地辅助也失败了：${truncatePreview(localFailure, 120)}`);
  }
  return lines.join('\n');
}

const TOOL_EXECUTION_PROMPT_PATTERN = /(unity\s*mcp|unitymcp|mcp\s*for\s*unity|unity|blender|hsscene|furniture_|prefab|timeline|场景|节点|截图|导入|导出|模型|看一眼|查一下|分析一下|整理.*列表)/i;

function requiresConcreteToolOutput(taskKind: LocalTaskKind, prompt: string): boolean {
  if (taskKind === 'unity_like' || taskKind === 'blender_like' || taskKind === 'doc_like') return true;
  if (taskKind !== 'tool_request') return false;
  return TOOL_EXECUTION_PROMPT_PATTERN.test(prompt);
}

function buildToolExecutionBlockerReply(taskKind: LocalTaskKind, prompt: string, codexFailure: string, localFailure?: string): string {
  const domain = /unity|unitymcp|unity\s*mcp|hsscene|furniture_|prefab|timeline|场景|节点/i.test(prompt)
    ? 'Unity/MCP'
    : taskKind === 'blender_like'
      ? 'Blender/MCP'
      : taskKind === 'doc_like'
        ? '飞书文档工具'
        : '工具链';
  const lines = [
    `未完成：这个请求需要实际 ${domain} 执行结果，本轮没有拿到可用工具输出。`,
    `阻塞原因：${summarizeCodexFailureMessage(codexFailure)}`,
    '不会降级成手动检查步骤或示例列表；没有真实工具结果就不能伪装完成。',
  ];
  if (localFailure) {
    lines.push(`本地辅助也失败了：${truncatePreview(localFailure, 120)}`);
  }
  return lines.join('\n');
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

class HubLlmProvider implements LLMProvider {
  constructor(
    private readonly config: Config,
    private readonly store: BridgeStore,
    private readonly localProvider: OllamaProvider,
    private readonly localAgent: LocalAgentProvider,
    private readonly fallbackProvider: LLMProvider,
    private readonly primaryExecutorId: string,
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
        let workflowFailed = false;
        try {
        const conservative = decideConservativeRoute(params, this.config);
        if (this.localAgent.canHandleIgnisFastPath(params)) {
          const ignisResult = await this.localAgent.handleIgnisFastPath(controller, params, routerMode);
          if (ignisResult.handled) return;
        }
        if (this.localAgent.canHandleMcpBridgeFastPathV2(params)) {
          try {
            const mcpResult = await this.localAgent.handleMcpBridgeFastPathV2(controller, params, routerMode);
            if (mcpResult.handled) return;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.dispatchAfterRouteFailure(controller, params, conservative, routerMode, message);
            return;
          }
        }
        if (this.localAgent.canHandleFastPath(params, conservative)) {
          try {
            const fastResult = await this.localAgent.handleFastPath(controller, params, {
              mode: routerMode,
              conservative,
            });
            if (fastResult.handled) return;
            if (fastResult.fallbackToCodex) {
              await this.dispatchAfterRouteFailure(
                controller,
                params,
                conservative,
                routerMode,
                fastResult.fallbackReason || conservative.reason,
              );
              return;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.dispatchAfterRouteFailure(controller, params, conservative, routerMode, message);
            return;
          }
        }
        if (routerMode === 'hybrid') {
          await this.pipeCodexPrimaryWithFallback(controller, params, conservative, '默认直达 Codex（Codex 主脑）');
          return;
        }
        try {
          const routeAttempt = await this.localProvider.route(params);
          const route = this.applySafetyOverride(routeAttempt.route, conservative);
          await this.dispatchByRoute(controller, params, route, routerMode, conservative);
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
          await this.dispatchAfterRouteFailure(controller, params, conservative, routerMode, message);
        }
        } catch (error) {
          workflowFailed = true;
          failWorkflowRun(workflowRun.id, error);
          requestWorkflowRetry(workflowRun.id, 'auto');
          throw error;
        } finally {
          if (!workflowFailed) {
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

  private async dispatchAfterRouteFailure(
    controller: ReadableStreamDefaultController<string>,
    params: Parameters<LLMProvider['streamChat']>[0],
    conservative: ReturnType<typeof decideConservativeRoute>,
    mode: ReturnType<typeof getLocalRouterMode>,
    reason: string,
  ): Promise<void> {
    const recallContext = this.buildRecallContext(params, conservative.requestKind);
    if (mode !== 'local_only') {
      await this.pipeCodexPrimaryWithFallback(controller, params, conservative, `本地辅助失败，升级 Codex：${reason}`);
      return;
    }

    if (mode !== 'local_only' && !conservative.useLocal) {
      const compressedParams = createCompressedParams(
        params,
        conservative.compressedPrompt || compressPromptText(params, this.config),
        conservative.compressedHistory || compressConversationHistory(params, this.config),
        `Conservative fallback: ${conservative.reason}`,
      );
      await this.pipeFallbackStream(controller, compressedParams, {
        mode,
        taskKind: conservative.requestKind,
        decision: 'escalate_codex',
        provider: 'codex',
        reason: `本地路由失败，按保守规则升级：${conservative.reason}`,
        compressedPromptChars: compressedParams.prompt.length,
        compressedHistoryChars: compressedParams.conversationHistory?.[0]?.content.length || 0,
        fallbackReason: reason,
      });
      return;
    }

    const result = conservative.useLocal
      ? await this.localProvider.answer(params, {
          mode: 'local_only',
          bestEffort: true,
          limitReason: `本地路由失败，按保守规则直接本地回答：${conservative.reason}`,
          taskKind: conservative.requestKind,
          commandDraftOnly: conservative.readOnlyDraftOnly,
          recallContext,
        })
      : await this.localProvider.buildBestEffortAnswer(params, reason, conservative.requestKind, recallContext);

    this.emitLocalSuccess(controller, params.sessionId, result.text, result.usage, {
      mode,
      taskKind: conservative.requestKind,
      decision: conservative.useLocal ? 'answer_local' : 'refuse_local',
      provider: 'local_best_effort',
      reason: conservative.useLocal
        ? `本地路由失败，保守规则允许本地处理：${conservative.reason}`
        : `本地路由失败且当前不可升级：${reason}`,
      compressedPromptChars: conservative.compressedPrompt.length,
      compressedHistoryChars: conservative.compressedHistory.length,
      fallbackReason: reason,
    });
  }

  private async dispatchByRoute(
    controller: ReadableStreamDefaultController<string>,
    params: Parameters<LLMProvider['streamChat']>[0],
    route: LocalRouteProtocolResult,
    mode: ReturnType<typeof getLocalRouterMode>,
    conservative: ReturnType<typeof decideConservativeRoute>,
  ): Promise<void> {
    const recallContext = this.buildRecallContext(params, route.taskKind);
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
        const result = await this.localProvider.answer(params, {
          route,
          mode,
          commandDraftOnly: route.taskKind === 'command_draft',
          recallContext,
        });
        this.emitLocalSuccess(controller, params.sessionId, result.text, result.usage, {
          mode,
          taskKind: route.taskKind,
          decision: route.decision,
          provider: 'local',
          reason: route.reason,
          compressedPromptChars: route.compressedPrompt.length,
          compressedHistoryChars: route.compressedHistory.length,
        });
        return;
      }

      case 'escalate_codex': {
        if (mode === 'local_only') {
          const result = await this.localProvider.answer(params, {
            route,
            mode,
            bestEffort: true,
            limitReason: this.localProvider.buildLocalOnlyMessage(route.taskKind, route.reason, route.taskKind === 'command_draft'),
            taskKind: route.taskKind,
            commandDraftOnly: route.taskKind === 'command_draft',
            recallContext,
          });
          this.emitLocalSuccess(controller, params.sessionId, result.text, result.usage, {
            mode,
            taskKind: route.taskKind,
            decision: route.decision,
            provider: 'local_best_effort',
            reason: `当前仅本地模式，未升级 Codex：${route.reason}`,
            compressedPromptChars: route.compressedPrompt.length,
            compressedHistoryChars: route.compressedHistory.length,
          });
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

        const result = await this.localProvider.answer(params, {
          route,
          mode: 'local_only',
          bestEffort: true,
          limitReason: this.localProvider.buildLocalOnlyMessage(route.taskKind, route.reason, route.taskKind === 'command_draft'),
          taskKind: route.taskKind,
          commandDraftOnly: route.taskKind === 'command_draft',
          recallContext,
        });
        this.emitLocalSuccess(controller, params.sessionId, result.text, result.usage, {
          mode,
          taskKind: route.taskKind,
          decision: route.decision,
          provider: 'refuse_local',
          reason: route.reason,
          compressedPromptChars: route.compressedPrompt.length,
          compressedHistoryChars: route.compressedHistory.length,
        });
      }
    }
  }

  private async pipeCodexPrimaryWithFallback(
    controller: ReadableStreamDefaultController<string>,
    params: Parameters<LLMProvider['streamChat']>[0],
    conservative: ReturnType<typeof decideConservativeRoute>,
    reason: string,
  ): Promise<void> {
    const recallContext = this.buildRecallContext(params, conservative.requestKind);
    try {
      await this.pipeFallbackStream(controller, params, {
        mode: 'hybrid',
        taskKind: conservative.requestKind,
        decision: 'escalate_codex',
        provider: 'codex',
        reason,
        compressedPromptChars: 0,
        compressedHistoryChars: 0,
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (requiresConcreteToolOutput(conservative.requestKind, params.prompt)) {
        this.emitLocalSuccess(controller, params.sessionId, buildToolExecutionBlockerReply(conservative.requestKind, params.prompt, message), undefined, {
          mode: 'hybrid',
          taskKind: conservative.requestKind,
          decision: 'refuse_local',
          provider: 'local_best_effort',
          reason: `Codex/MCP 执行链失败，工具任务禁止降级为教程：${message}`,
          compressedPromptChars: 0,
          compressedHistoryChars: 0,
          fallbackReason: message,
        });
        return;
      }
      if (conservative.allowLocalFallback && this.localAgent.canHandleFastPath(params, { ...conservative, useLocal: true })) {
        const fastResult = await this.localAgent.handleFastPath(controller, params, {
          mode: 'hybrid',
          conservative: {
            ...conservative,
            useLocal: true,
          },
        });
        if (fastResult.handled) return;
      }
      try {
        const result = conservative.useLocal
          ? await this.localProvider.answer(params, {
              mode: 'local_only',
              bestEffort: true,
              limitReason: `Codex 不可用，改由本地兜底：${message}`,
              taskKind: conservative.requestKind,
              commandDraftOnly: conservative.readOnlyDraftOnly,
              recallContext,
            })
          : await this.localProvider.buildBestEffortAnswer(params, `Codex 不可用，当前仅能本地兜底：${message}`, conservative.requestKind);

        const finalResult = !conservative.useLocal && recallContext
          ? await this.localProvider.buildBestEffortAnswer(params, message, conservative.requestKind, recallContext)
          : result;

        this.emitLocalSuccess(controller, params.sessionId, finalResult.text, finalResult.usage, {
          mode: 'hybrid',
          taskKind: conservative.requestKind,
          decision: conservative.useLocal ? 'answer_local' : 'refuse_local',
          provider: 'local_best_effort',
          reason: conservative.useLocal
            ? `Codex 不可用，显式小活改由本地兜底：${message}`
            : `Codex 不可用，当前任务仅能本地尽力回答：${message}`,
          compressedPromptChars: 0,
          compressedHistoryChars: 0,
          fallbackReason: message,
        });
        return;
      } catch (localError) {
        const localFailure = localError instanceof Error ? localError.message : String(localError);
        const finalText = recallContext
          ? buildRecallFallbackReply(recallContext, message, localFailure)
          : `${summarizeCodexFailureMessage(message)}${localFailure ? ` 本地辅助也失败了：${truncatePreview(localFailure, 120)}` : ''}`;
        this.emitLocalSuccess(controller, params.sessionId, finalText, undefined, {
          mode: 'hybrid',
          taskKind: conservative.requestKind,
          decision: 'refuse_local',
          provider: 'local_best_effort',
          reason: `Codex 不可用且本地兜底失败：${message}`,
          compressedPromptChars: 0,
          compressedHistoryChars: 0,
          fallbackReason: localFailure,
        });
      }
    }
  }

  private async pipeFallbackStream(
    controller: ReadableStreamDefaultController<string>,
    params: Parameters<LLMProvider['streamChat']>[0],
    summary: Omit<LocalLlmRouteSummary, 'timestamp'>,
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
      provider: 'codex',
      routeMode: summary.mode,
      routeDecision: summary.decision,
      routeReason: summary.reason,
      compressedPromptChars: summary.compressedPromptChars,
      compressedHistoryChars: summary.compressedHistoryChars,
    }));
    try {
      const stream = this.fallbackProvider.streamChat(params);
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
    controller.enqueue(sseEvent('status', {
      provider: summary.provider,
      routeMode: summary.mode,
      routeDecision: summary.decision,
      routeReason: summary.reason,
      compressedPromptChars: summary.compressedPromptChars,
      compressedHistoryChars: summary.compressedHistoryChars,
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
        });
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
          appendWorkflowEvent(workflowRun.id, 'executing', 'executor.executing', `执行器开始处理：${selection.executor.displayName}`, {
            executorId: selection.executor.id,
            fallbackExecutorIds: selection.fallbackExecutorIds,
          });
          const stream = this.provider.streamChat(params);
          const reader = stream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          completeWorkflowRun(workflowRun.id);
          controller.close();
        } catch (error) {
          failWorkflowRun(workflowRun.id, error);
          requestWorkflowRetry(workflowRun.id, 'auto');
          try {
            controller.enqueue(sseEvent('error', error instanceof Error ? error.message : String(error)));
            controller.close();
          } catch {
            // ignore already closed controller
          }
        }
      },
    });
  }
}

async function resolveProvider(config: Config, pendingPerms: PendingPermissions, store: BridgeStore): Promise<LLMProvider> {
  const wrapWithLocalHub = (provider: LLMProvider, primaryExecutorId: string): LLMProvider => {
    if ((config.ollamaEnabled ?? config.localLlmEnabled) !== true) return new ObservedLLMProvider(config, store, provider, primaryExecutorId);
    const localProvider = new OllamaProvider(config);
    return new HubLlmProvider(config, store, localProvider, new LocalAgentProvider(config, pendingPerms, localProvider), provider, primaryExecutorId);
  };

  const runtime = config.runtime;

  if (runtime === 'codex') {
    const { CodexProvider } = await import('./codex-provider.js');
    return wrapWithLocalHub(new CodexProvider(pendingPerms), 'codex');
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
    return wrapWithLocalHub(new CodexProvider(pendingPerms), 'codex');
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
  lastExitReason?: string;
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
      const text = await collectWorkflowRetryResponse(llm, {
        prompt: input.prompt,
        sessionId: claimed.sessionId,
        model: input.model,
        systemPrompt: input.systemPrompt,
        workingDirectory: input.workingDirectory,
        permissionMode: input.permissionMode,
      });
      if (!text) {
        throw new Error('重试执行没有返回可发送文本');
      }
      store.addMessage(claimed.sessionId, 'user', input.prompt);
      store.addMessage(claimed.sessionId, 'assistant', text);
      const channelType = input.channelType || claimed.channelType;
      const chatId = input.chatId || claimed.chatId;
      if (channelType && chatId) {
        const delivered = await bridgeManager.deliverProactiveMessage({
          address: {
            channelType,
            chatId,
            displayName: claimed.chatId || chatId,
          },
          text: `断点续跑重试结果：\n\n${text}`,
          parseMode: 'plain',
          sessionId: claimed.sessionId,
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
  let todoReminderService: TodoReminderService | null = null;
  let workflowRetryTimer: NodeJS.Timeout | null = null;
  if (knowledgeWatcher) {
    const status = knowledgeWatcher.status();
    console.log(`[claude-to-im] Knowledge index: ${status.itemCount} items, watching=${status.watching}, root=${status.memoryRoot}`);
    if (status.lastError) {
      console.warn(`[claude-to-im] Knowledge index warning: ${status.lastError}`);
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

  initBridgeContext({
    store,
    llm,
    permissions: gateway,
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
        });
        console.log(`[claude-to-im] Bridge started (PID: ${process.pid}, channels: ${config.enabledChannels.join(', ')})`);
      },
      onBridgeStop: () => {
        writeStatus({ running: false });
        console.log('[claude-to-im] Bridge stopped');
      },
    },
  });

  await bridgeManager.start();
  workflowRetryTimer = startWorkflowRetryService(runId, llm, store);
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
