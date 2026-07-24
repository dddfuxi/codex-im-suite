import os from 'node:os';
import path from 'node:path';

import type { LLMProvider } from 'claude-to-im/host';

import type { Config } from '../config.js';
import { CodexLocalCliProvider } from '../codex-local-cli-provider.js';
import { CodexProvider } from '../codex-provider.js';
import { SDKLLMProvider, preflightCheck, resolveClaudeCliPath } from '../llm-provider.js';
import { PendingPermissions } from '../permission-gateway.js';

export interface RestrictedWorkerProviderConfig {
  runtime: Config['runtime'];
  workerId: string;
  claudeExecutable?: string;
  codexModelSource?: Config['codexModelSource'];
  codexBaseUrl?: string;
  codexApiKey?: string;
  codexModel?: string;
  codexPassModel?: boolean;
  codexReasoningEffort?: Config['codexReasoningEffort'];
  localAiKind?: Config['localAiKind'];
  localAiBaseUrl?: string;
  localAiModel?: string;
  localAiApiKey?: string;
  localAiTimeoutMs?: number;
}

export interface RestrictedProviderCollection {
  text: string;
  modelSource?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

function setProviderEnvironment(config: RestrictedWorkerProviderConfig): void {
  const isolatedHome = path.join(os.tmpdir(), 'codex-im-suite-agent-workers', config.workerId);
  process.env.CTI_HOME = isolatedHome;
  process.env.CTI_CODEX_INHERIT_GLOBAL_MCP = 'false';
  process.env.CTI_CODEX_RESUME_THREADS = 'false';
  if (config.codexBaseUrl) process.env.CTI_CODEX_BASE_URL = config.codexBaseUrl;
  if (config.codexApiKey) process.env.CTI_CODEX_API_KEY = config.codexApiKey;
  if (config.codexModel) process.env.CTI_CODEX_MODEL = config.codexModel;
  if (config.codexReasoningEffort) process.env.CTI_CODEX_REASONING_EFFORT = config.codexReasoningEffort;
  if (config.localAiBaseUrl) process.env.CTI_LOCAL_AI_BASE_URL = config.localAiBaseUrl;
  if (config.localAiModel) process.env.CTI_LOCAL_AI_MODEL = config.localAiModel;
  if (config.localAiApiKey) process.env.CTI_LOCAL_AI_API_KEY = config.localAiApiKey;
  if (config.claudeExecutable) process.env.CTI_CLAUDE_CODE_EXECUTABLE = config.claudeExecutable;
}

function minimalConfig(config: RestrictedWorkerProviderConfig): Config {
  return {
    runtime: config.runtime,
    enabledChannels: [],
    defaultWorkDir: path.join(os.tmpdir(), 'codex-im-suite-agent-workers', config.workerId),
    defaultMode: 'plan',
    codexModelSource: config.codexModelSource || 'official',
    codexBaseUrl: config.codexBaseUrl,
    codexApiKey: config.codexApiKey,
    codexModel: config.codexModel,
    codexPassModel: config.codexPassModel,
    codexReasoningEffort: config.codexReasoningEffort,
    codexInheritGlobalMcp: false,
    localAiKind: config.localAiKind,
    localAiBaseUrl: config.localAiBaseUrl,
    localAiModel: config.localAiModel,
    localAiApiKey: config.localAiApiKey,
    localAiTimeoutMs: config.localAiTimeoutMs,
  };
}

export async function createRestrictedAgentProvider(config: RestrictedWorkerProviderConfig): Promise<LLMProvider> {
  setProviderEnvironment(config);
  const pendingPermissions = new PendingPermissions();
  const createCodex = (): LLMProvider => config.codexModelSource === 'local_api'
    ? new CodexLocalCliProvider(minimalConfig(config))
    : new CodexProvider(pendingPermissions, {
      profile: config.codexModelSource === 'external_api' ? 'external' : 'official',
    });
  if (config.runtime === 'codex') return createCodex();
  const claudePath = config.claudeExecutable || resolveClaudeCliPath();
  if (config.runtime === 'claude') {
    if (!claudePath || !preflightCheck(claudePath).ok) throw new Error('restricted_claude_provider_unavailable');
    return new SDKLLMProvider(pendingPermissions, claudePath, false);
  }
  if (claudePath && preflightCheck(claudePath).ok) return new SDKLLMProvider(pendingPermissions, claudePath, false);
  return createCodex();
}

function parseEventLine(line: string): { type?: string; data?: unknown } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  try {
    return JSON.parse(trimmed.slice(5).trim()) as { type?: string; data?: unknown };
  } catch {
    return null;
  }
}

function collectUsage(data: unknown, current: RestrictedProviderCollection): void {
  if (!data || typeof data !== 'object') return;
  const record = data as Record<string, unknown>;
  const usage = record.usage && typeof record.usage === 'object' ? record.usage as Record<string, unknown> : record;
  const read = (key: string): number | undefined => typeof usage[key] === 'number' && Number.isFinite(usage[key])
    ? usage[key] as number
    : undefined;
  current.inputTokens = read('input_tokens') ?? current.inputTokens;
  current.outputTokens = read('output_tokens') ?? current.outputTokens;
  current.totalTokens = read('total_tokens') ?? (
    current.inputTokens !== undefined || current.outputTokens !== undefined
      ? (current.inputTokens || 0) + (current.outputTokens || 0)
      : current.totalTokens
  );
  if (typeof record.model === 'string') current.model = record.model;
  if (typeof record.modelSource === 'string') current.modelSource = record.modelSource;
  if (typeof record.selectedSource === 'string') current.modelSource = record.selectedSource;
}

export async function collectRestrictedProviderJson(
  provider: LLMProvider,
  input: {
    prompt: string;
    systemPrompt: string;
    responseSchema: unknown;
    sessionId: string;
    timeoutMs: number;
    abortSignal?: AbortSignal;
  },
): Promise<RestrictedProviderCollection> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), input.timeoutMs);
  const relay = () => abortController.abort();
  input.abortSignal?.addEventListener('abort', relay, { once: true });
  const collected: RestrictedProviderCollection = { text: '' };
  try {
    const reader = provider.streamChat({
      prompt: input.prompt,
      sessionId: input.sessionId,
      forceFreshThread: true,
      interactionMode: 'classifier',
      responseSchema: input.responseSchema,
      systemPrompt: input.systemPrompt,
      conversationHistory: [],
      executionRequirement: { kind: 'none', reason: 'read-only specialist agent', requiredToolFamilies: [] },
      abortController,
    }).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of value.split(/\r?\n/u)) {
        const event = parseEventLine(line);
        if (!event) continue;
        collectUsage(event.data, collected);
        if (event.type === 'text') {
          collected.text += typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
        }
        if (event.type === 'error') throw new Error(typeof event.data === 'string' ? event.data : 'restricted_provider_error');
      }
    }
    return { ...collected, text: collected.text.trim() };
  } finally {
    clearTimeout(timer);
    input.abortSignal?.removeEventListener('abort', relay);
  }
}
