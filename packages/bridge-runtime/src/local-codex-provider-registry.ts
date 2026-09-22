import type { Config } from './config.js';

export type LocalCodexProviderId = 'ollama' | 'lmstudio' | 'openai-compatible' | 'vllm' | 'custom';

export interface LocalCodexProviderCommandInput {
  model: string;
  outputLastMessagePath?: string;
}

export interface LocalCodexProviderCommand {
  command: string;
  args: string[];
}

export interface LocalCodexProviderUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_tokens?: number;
}

export interface LocalCodexProviderAdapter {
  id: LocalCodexProviderId;
  displayName: string;
  supportsCodexAgent: boolean;
  codexLocalProvider?: 'ollama' | 'lmstudio';
  unsupportedReason?: string;
  normalizeBaseUrl(baseUrl?: string): string;
  healthCheck(config: Pick<Config, 'localAiBaseUrl' | 'localAiModel' | 'localAiApiKey' | 'localAiTimeoutMs'>): Promise<{ ok: boolean; message: string }>;
  buildCommand(input: LocalCodexProviderCommandInput): LocalCodexProviderCommand;
  extractUsage(event: unknown): LocalCodexProviderUsage | undefined;
}

function trimSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function extractCodexJsonlUsage(event: unknown): LocalCodexProviderUsage | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const usage = (event as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const source = usage as Record<string, unknown>;
  const inputTokens = readNumber(source.input_tokens);
  const outputTokens = readNumber(source.output_tokens);
  const cacheReadInputTokens = readNumber(source.cached_input_tokens ?? source.cache_read_input_tokens);
  const cacheCreationInputTokens = readNumber(source.cache_creation_input_tokens);
  if (
    inputTokens === undefined
    && outputTokens === undefined
    && cacheReadInputTokens === undefined
    && cacheCreationInputTokens === undefined
  ) {
    return undefined;
  }
  const result: LocalCodexProviderUsage = {};
  if (inputTokens !== undefined) result.input_tokens = inputTokens;
  if (outputTokens !== undefined) result.output_tokens = outputTokens;
  if (cacheReadInputTokens !== undefined) result.cache_read_input_tokens = cacheReadInputTokens;
  if (cacheCreationInputTokens !== undefined) result.cache_creation_input_tokens = cacheCreationInputTokens;
  if (inputTokens !== undefined || outputTokens !== undefined) {
    result.total_tokens = (inputTokens || 0) + (outputTokens || 0);
  }
  return result;
}

async function checkOpenAiCompatibleChatEndpoint(
  baseUrl: string,
  model: string | undefined,
  apiKey: string | undefined,
  timeoutMs: number | undefined,
): Promise<{ ok: boolean; message: string }> {
  const normalized = trimSlash(baseUrl);
  if (!normalized) return { ok: false, message: '本地 API 地址为空。' };
  const endpoint = /\/v1$/i.test(normalized) ? `${normalized}/models` : `${normalized}/v1/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, timeoutMs || 10000));
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(endpoint, { headers, signal: controller.signal });
    if (!response.ok) return { ok: false, message: `本地 API 探测失败：HTTP ${response.status} ${response.statusText}` };
    return { ok: true, message: `本地 API 可访问${model ? `，模型配置为 ${model}` : ''}。` };
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? `本地 API 探测超时：${timeoutMs || 10000}ms`
      : `本地 API 探测失败：${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, message };
  } finally {
    clearTimeout(timer);
  }
}

function createCliAdapter(id: 'ollama' | 'lmstudio', displayName: string, defaultBaseUrl: string): LocalCodexProviderAdapter {
  return {
    id,
    displayName,
    supportsCodexAgent: true,
    codexLocalProvider: id,
    normalizeBaseUrl(baseUrl?: string): string {
      return trimSlash(baseUrl || defaultBaseUrl);
    },
    healthCheck(config) {
      return checkOpenAiCompatibleChatEndpoint(
        this.normalizeBaseUrl(config.localAiBaseUrl),
        config.localAiModel,
        config.localAiApiKey,
        config.localAiTimeoutMs,
      );
    },
    buildCommand(input) {
      const args = [
        'exec',
        '--oss',
        '--local-provider',
        id,
        '--model',
        input.model,
        '--json',
      ];
      if (input.outputLastMessagePath) {
        args.push('--output-last-message', input.outputLastMessagePath);
      }
      return { command: 'codex', args };
    },
    extractUsage: extractCodexJsonlUsage,
  };
}

function createUnsupportedAdapter(id: LocalCodexProviderId, displayName: string, defaultBaseUrl: string): LocalCodexProviderAdapter {
  return {
    id,
    displayName,
    supportsCodexAgent: false,
    unsupportedReason: `${displayName} 目前只能作为 Chat Completions / OpenAI-compatible API 使用，Codex CLI OSS agent 尚未支持该 local-provider。`,
    normalizeBaseUrl(baseUrl?: string): string {
      const trimmed = trimSlash(baseUrl || defaultBaseUrl);
      if (!trimmed) return defaultBaseUrl;
      return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
    },
    healthCheck(config) {
      return checkOpenAiCompatibleChatEndpoint(
        this.normalizeBaseUrl(config.localAiBaseUrl),
        config.localAiModel,
        config.localAiApiKey,
        config.localAiTimeoutMs,
      );
    },
    buildCommand() {
      throw new Error(this.unsupportedReason || `${displayName} 不支持 Codex agent。`);
    },
    extractUsage: extractCodexJsonlUsage,
  };
}

const ADAPTERS: Record<LocalCodexProviderId, LocalCodexProviderAdapter> = {
  ollama: createCliAdapter('ollama', 'Ollama', 'http://127.0.0.1:11434'),
  lmstudio: createCliAdapter('lmstudio', 'LM Studio', 'http://127.0.0.1:1234'),
  'openai-compatible': createUnsupportedAdapter('openai-compatible', 'OpenAI-compatible', 'http://127.0.0.1:8000/v1'),
  vllm: createUnsupportedAdapter('vllm', 'vLLM', 'http://127.0.0.1:8000/v1'),
  custom: createUnsupportedAdapter('custom', '自定义本地 API', 'http://127.0.0.1:8000/v1'),
};

export function getLocalCodexProviderAdapter(kind: string | undefined): LocalCodexProviderAdapter {
  const normalized = (kind || 'ollama').trim().toLowerCase() as LocalCodexProviderId;
  return ADAPTERS[normalized] || ADAPTERS.ollama;
}

export function getLocalCodexProviderCapabilities(kind: string | undefined): {
  provider: LocalCodexProviderId;
  displayName: string;
  supportsCodexAgent: boolean;
  codexLocalProvider?: 'ollama' | 'lmstudio';
  unsupportedReason?: string;
} {
  const adapter = getLocalCodexProviderAdapter(kind);
  return {
    provider: adapter.id,
    displayName: adapter.displayName,
    supportsCodexAgent: adapter.supportsCodexAgent,
    codexLocalProvider: adapter.codexLocalProvider,
    unsupportedReason: adapter.unsupportedReason,
  };
}
