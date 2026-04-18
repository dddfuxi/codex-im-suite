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

import type { LLMProvider } from 'claude-to-im/src/lib/bridge/host.js';
import { loadConfig, configToSettings, CTI_HOME } from './config.js';
import type { Config } from './config.js';
import { JsonFileStore } from './store.js';
import { SDKLLMProvider, resolveClaudeCliPath, preflightCheck } from './llm-provider.js';
import { PendingPermissions } from './permission-gateway.js';
import { setupLogger } from './logger.js';
import { LocalLlamaProvider } from './local-llm-provider.js';
import { LocalAgentProvider } from './local-agent-provider.js';
import {
  compressConversationHistory,
  compressPromptText,
  createCompressedParams,
  decideConservativeRoute,
  getLocalRouterMode,
  type LocalRouteProtocolResult,
} from './local-llm-router.js';
import {
  appendLocalLlmRouteSummary,
  readLocalLlmStatus,
  updateLocalLlmStatus,
  type LocalLlmRouteSummary,
} from './local-llm-status.js';
import { sseEvent } from './sse-utils.js';

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

class HubLlmProvider implements LLMProvider {
  constructor(
    private readonly config: Config,
    private readonly localProvider: LocalLlamaProvider,
    private readonly localAgent: LocalAgentProvider,
    private readonly fallbackProvider: LLMProvider,
  ) {}

  streamChat(params: Parameters<LLMProvider['streamChat']>[0]): ReturnType<LLMProvider['streamChat']> {
    const routerMode = getLocalRouterMode(this.config);
    const routerEnabled = this.config.localLlmEnabled === true
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
        const conservative = decideConservativeRoute(params, this.config);
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
      },
    });
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
        })
      : await this.localProvider.buildBestEffortAnswer(params, reason, conservative.requestKind);

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
        const result = await this.localProvider.answer(params, { route, mode, commandDraftOnly: route.taskKind === 'command_draft' });
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
      const result = conservative.useLocal
        ? await this.localProvider.answer(params, {
            mode: 'local_only',
            bestEffort: true,
            limitReason: `Codex 不可用，改由本地兜底：${message}`,
            taskKind: conservative.requestKind,
            commandDraftOnly: conservative.readOnlyDraftOnly,
          })
        : await this.localProvider.buildBestEffortAnswer(params, `Codex 不可用，当前仅能本地兜底：${message}`, conservative.requestKind);

      this.emitLocalSuccess(controller, params.sessionId, result.text, result.usage, {
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
  ];
  return {
    bridgeFingerprint: computeFingerprint(bridgeFiles),
    toolingFingerprint: computeFingerprint(toolingFiles),
  };
}

async function resolveProvider(config: Config, pendingPerms: PendingPermissions): Promise<LLMProvider> {
  const wrapWithLocalHub = (provider: LLMProvider): LLMProvider => {
    if (config.localLlmEnabled !== true) return provider;
    const localProvider = new LocalLlamaProvider(config);
    return new HubLlmProvider(config, localProvider, new LocalAgentProvider(config, pendingPerms, localProvider), provider);
  };

  const runtime = config.runtime;

  if (runtime === 'codex') {
    const { CodexProvider } = await import('./codex-provider.js');
    return wrapWithLocalHub(new CodexProvider(pendingPerms));
  }

  if (runtime === 'auto') {
    const cliPath = resolveClaudeCliPath();
    if (cliPath) {
      const check = preflightCheck(cliPath);
      if (check.ok) {
        console.log(`[claude-to-im] Auto: using Claude CLI at ${cliPath} (${check.version})`);
        return wrapWithLocalHub(new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove));
      }
      console.warn(
        `[claude-to-im] Auto: Claude CLI at ${cliPath} failed preflight: ${check.error}\n` +
        '  Falling back to Codex.',
      );
    } else {
      console.log('[claude-to-im] Auto: Claude CLI not found, falling back to Codex');
    }
    const { CodexProvider } = await import('./codex-provider.js');
    return wrapWithLocalHub(new CodexProvider(pendingPerms));
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

  return wrapWithLocalHub(new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove));
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

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();
  updateLocalLlmStatus(config, {});

  const runId = crypto.randomUUID();
  console.log(`[claude-to-im] Starting bridge (run_id: ${runId})`);
  initializeBridgeRuntimeAudit(runId, process.pid);

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
  const pendingPerms = new PendingPermissions();
  const llm = await resolveProvider(config, pendingPerms);
  console.log(`[claude-to-im] Runtime: ${config.runtime}`);

  const gateway = {
    resolvePendingPermission: (id: string, resolution: { behavior: 'allow' | 'deny'; message?: string }) =>
      pendingPerms.resolve(id, resolution),
  };

  initBridgeContext({
    store,
    llm,
    permissions: gateway,
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
