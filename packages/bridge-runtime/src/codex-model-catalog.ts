import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

import type { CodexModelCatalogContract, CodexModelOptionContract } from '@codex-im-suite/contracts/panel-settings';

import { buildRestrictedCodexRuntimeProfile } from './codex-provider.js';
import { resolveBundledCodexExecutable } from './codex-app-server-light-provider.js';
import { loadConfig } from './config.js';

const PROTOCOL = 'cti-codex-model-catalog/v1' as const;
type CatalogSource = CodexModelCatalogContract['source'];
const DEFAULT_PAGE_LIMIT = 200;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_TIMEOUT_MS = 20_000;

type JsonRecord = Record<string, unknown>;

export interface CodexModelCatalogChild extends ChildProcessWithoutNullStreams {}

export interface CodexModelCatalogDiscoveryOptions {
  source?: 'official' | 'external_api' | 'local_api';
  configuredModel?: string;
  baseUrl?: string;
  localKind?: string;
  apiKey?: string;
  executablePath?: string;
  /**
   * Explicitly managed Codex home. Runtime callers normally leave this unset so
   * buildRestrictedCodexRuntimeProfile creates the official, isolated home.
   */
  codexHome?: string;
  timeoutMs?: number;
  pageLimit?: number;
  maxPages?: number;
  /** Injectable only for Runtime tests; it prevents a test from launching Codex. */
  spawnProcess?: (file: string, args: string[], options: Parameters<typeof spawn>[2]) => CodexModelCatalogChild;
  /** Injectable only for Runtime tests; production derives this from the managed profile. */
  runtimeEnv?: Record<string, string>;
  runtimeApiKey?: string;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boolValue(value: unknown): boolean {
  return value === true;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item))
    .filter((item, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === item.toLowerCase()) === index);
}

function reasoningEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const values = value.map((item) => {
    if (typeof item === 'string') return stringValue(item);
    const object = record(item);
    return stringValue(object?.reasoningEffort)
      || stringValue(object?.effort)
      || stringValue(object?.id);
  }).filter((item): item is string => Boolean(item));
  return values.filter((item, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === item.toLowerCase()) === index);
}

/** Parse one model/list entry without carrying through arbitrary provider data. */
export function parseCodexModelOption(value: unknown): CodexModelOptionContract | null {
  const item = record(value);
  if (!item) return null;
  const id = stringValue(item.id) || stringValue(item.model);
  if (!id) return null;
  return {
    id,
    displayName: stringValue(item.displayName) || id,
    hidden: boolValue(item.hidden),
    isDefault: boolValue(item.isDefault),
    // Missing inputModalities is intentionally represented as unknown ([]).
    // Inferring image support from the model name would make the panel claim a
    // capability that model/list did not actually advertise.
    inputModalities: stringArray(item.inputModalities),
    defaultReasoningEffort: stringValue(item.defaultReasoningEffort) || '',
    supportedReasoningEfforts: reasoningEfforts(item.supportedReasoningEfforts),
  };
}

/** Merge pages deterministically and discard hidden entries from the public catalog. */
export function mergeCodexModelOptions(pages: readonly unknown[][]): CodexModelOptionContract[] {
  const models = new Map<string, CodexModelOptionContract>();
  for (const page of pages) {
    for (const item of page) {
      const model = parseCodexModelOption(item);
      if (!model || model.hidden) continue;
      models.set(model.id.toLowerCase(), model);
    }
  }
  return [...models.values()]
    .sort((left, right) => (
      Number(right.isDefault) - Number(left.isDefault)
      || left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' })
      || left.id.localeCompare(right.id, undefined, { sensitivity: 'base' })
    ));
}

function errorCatalog(configuredModel: string, message: string): CodexModelCatalogContract {
  return {
    protocol: PROTOCOL,
    generatedAt: new Date().toISOString(),
    status: 'error',
    source: 'codex_app_server',
    models: [],
    configuredModel: configuredModel.trim(),
    // Errors cross the Control API as a short stable user-facing message only;
    // raw stderr, credentials, and local paths never leave Runtime.
    error: message.slice(0, 240),
  };
}

function sourceName(source: 'official' | 'external_api' | 'local_api', localKind = 'ollama'): CatalogSource {
  return source === 'official'
    ? 'codex_app_server'
    : source === 'local_api' && localKind.trim().toLowerCase() === 'ollama'
      ? 'ollama'
      : 'openai_compatible';
}

function configuredValue(source: 'official' | 'external_api' | 'local_api'): string {
  const config = loadConfig();
  return source === 'local_api'
    ? (config.localAiModel || config.ollamaModel || '')
    : (config.codexModel || '');
}

function normalizeModelsEndpoint(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/u, '');
  if (!value) throw new Error('模型服务地址未配置');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('模型服务地址必须是不含凭据的 HTTP(S) 地址');
  }
  let pathName = url.pathname.replace(/\/+$/u, '');
  // Accept either an OpenAI-compatible root, /v1, or a configured
  // /v1/chat/completions endpoint while always querying only /v1/models.
  pathName = pathName.replace(/\/chat\/completions$/iu, '');
  if (pathName.endsWith('/models')) return url.toString();
  url.pathname = `${pathName.endsWith('/v1') ? pathName : `${pathName}/v1`}/models`;
  return url.toString();
}

function normalizeOllamaTagsEndpoint(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/u, '');
  if (!value) throw new Error('Ollama 地址未配置');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Ollama 地址必须是不含凭据的 HTTP(S) 地址');
  }
  const pathName = url.pathname.replace(/\/+$/u, '').replace(/\/v1$/iu, '');
  url.pathname = `${pathName}/api/tags`;
  return url.toString();
}

function readConfiguredProvider(configPath: string): { baseUrl: string; apiKey?: string; headers?: Record<string, string> } | undefined {
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const providerMatch = content.match(/^model_provider\s*=\s*["']([^"']+)["']\s*$/mu);
    const provider = providerMatch?.[1]?.trim();
    if (!provider) return undefined;
    const escaped = provider.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    // Keep multiline matching for the section header, but make the end-of-file
    // branch absolute. A plain `$` under the `m` flag also matches every line
    // ending and would otherwise truncate the section before its fields.
    const section = new RegExp(`^\\[model_providers\\.(?:"${escaped}"|${escaped})\\]\\s*$([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, 'mu').exec(content)?.[1] || '';
    const baseUrl = /^base_url\s*=\s*["']([^"']+)["']\s*$/mu.exec(section)?.[1]?.trim() || '';
    if (!baseUrl) return undefined;
    const apiKey = /^experimental_bearer_token\s*=\s*["']([^"']+)["']\s*$/mu.exec(section)?.[1]?.trim();
    const headerText = /^http_headers\s*=\s*\{([\s\S]*?)\}\s*$/mu.exec(section)?.[1] || '';
    const headers: Record<string, string> = {};
    const headerPattern = /([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*["']([^"']*)["']/gu;
    for (const match of headerText.matchAll(headerPattern)) {
      const name = match[1]?.trim();
      const value = match[2];
      if (name && value !== undefined) headers[name] = value;
    }
    return {
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  } catch {
    return undefined;
  }
}

async function fetchModelCatalog(
  source: 'external_api' | 'local_api',
  configuredModel: string,
  baseUrl: string,
  localKind: string,
  apiKey: string | undefined,
  timeoutMs: number,
  extraHeaders?: Record<string, string>,
): Promise<CodexModelCatalogContract> {
  const isOllama = source === 'local_api' && localKind.trim().toLowerCase() === 'ollama';
  const endpoint = isOllama ? normalizeOllamaTagsEndpoint(baseUrl) : normalizeModelsEndpoint(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { ...extraHeaders, accept: 'application/json' };
    if (!isOllama && apiKey?.trim()) headers.authorization = `Bearer ${apiKey.trim()}`;
    const response = await fetch(endpoint, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as unknown;
    const root = record(body);
    const rows = Array.isArray(root?.data)
      ? root.data
      : Array.isArray(root?.models) ? root.models : [];
    const models = mergeCodexModelOptions([rows.map((item) => {
      const model = record(item);
      if (!model) return item;
      const id = stringValue(model.id) || stringValue(model.model) || stringValue(model.name);
      return id ? { ...model, id, displayName: stringValue(model.displayName) || id, isDefault: Boolean(configuredModel && id === configuredModel) } : model;
    })]);
    return {
      protocol: PROTOCOL,
      generatedAt: new Date().toISOString(),
      status: models.length > 0 ? 'ready' : 'empty',
      source: sourceName(source, localKind),
      models,
      configuredModel: configuredModel.trim(),
      error: '',
    };
  } catch (error) {
    return {
      protocol: PROTOCOL,
      generatedAt: new Date().toISOString(),
      status: 'error',
      source: sourceName(source, localKind),
      models: [],
      configuredModel: configuredModel.trim(),
      error: error instanceof Error && error.name === 'AbortError'
        ? '读取模型目录超时。'
        : '读取模型目录失败，请检查模型服务地址、登录态和 API Key。',
    };
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error('Codex 模型目录探测已取消')));
    const timer = setTimeout(() => finish(() => reject(new Error('Codex 模型目录探测超时'))), timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
}

async function writeJsonLine(child: CodexModelCatalogChild, value: unknown, signal: AbortSignal): Promise<void> {
  if (!child.stdin.writable) throw new Error('Codex app-server stdin 不可写');
  await child.stdin.write(`${JSON.stringify(value)}\n`, 'utf8');
  if (signal.aborted) throw new Error('Codex 模型目录探测已取消');
}

async function readResponse(
  iterator: AsyncIterator<string>,
  id: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<JsonRecord> {
  while (true) {
    const next = await withTimeout(iterator.next(), timeoutMs, signal);
    if (next.done) throw new Error('Codex app-server 在返回模型目录前退出');
    const line = next.value.trim();
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const message = record(parsed);
    if (!message || message.id !== id) continue;
    if (message.error) throw new Error('Codex app-server 拒绝了模型目录请求');
    return message;
  }
}

function responseResult(response: JsonRecord): JsonRecord {
  const result = record(response.result);
  if (!result) throw new Error('Codex 模型目录响应缺少 result');
  return result;
}

function spawnDefault(file: string, args: string[], options: Parameters<typeof spawn>[2]): CodexModelCatalogChild {
  return spawn(file, args, options) as CodexModelCatalogChild;
}

/**
 * Read the official Codex app-server model/list catalog through Runtime.
 * The returned contract contains only allowlisted model metadata.
 */
export async function discoverCodexModelCatalog(
  options: CodexModelCatalogDiscoveryOptions = {},
  cancellationToken?: AbortSignal,
): Promise<CodexModelCatalogContract> {
  const source = options.source || (process.env.CTI_CODEX_MODEL_SOURCE as 'official' | 'external_api' | 'local_api' | undefined) || 'official';
  const configuredModel = options.configuredModel || configuredValue(source);
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pageLimit = Math.min(500, Math.max(1, options.pageLimit ?? DEFAULT_PAGE_LIMIT));
  const maxPages = Math.min(50, Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES));
  let child: CodexModelCatalogChild | undefined;
  let readlineInterface: readline.Interface | undefined;
  if (source !== 'official') {
    const config = loadConfig();
    const baseUrl = options.baseUrl
      || (source === 'local_api' ? config.localAiBaseUrl || config.ollamaBaseUrl || 'http://127.0.0.1:11434' : config.codexBaseUrl || '');
    const localKind = options.localKind || config.localAiKind || 'ollama';
    const apiKey = options.apiKey
      || (source === 'local_api' ? config.localAiApiKey : config.codexApiKey);
    return fetchModelCatalog(source, configuredModel, baseUrl, localKind, apiKey, timeoutMs);
  }
  let detachCancellation: (() => void) | undefined;
  try {
    const runtime = options.runtimeEnv
      ? { env: options.runtimeEnv, apiKey: options.runtimeApiKey }
      : buildRestrictedCodexRuntimeProfile('official', options.codexHome);
    const executable = options.executablePath || resolveBundledCodexExecutable();
    child = (options.spawnProcess || spawnDefault)(executable, ['app-server', '--listen', 'stdio://'], {
      cwd: runtime.env.CODEX_HOME || process.cwd(),
      env: {
        ...runtime.env,
        ...(runtime.apiKey ? { CODEX_API_KEY: runtime.apiKey } : {}),
      },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', () => { /* stderr is intentionally not exposed across the Runtime boundary. */ });
    const signalController = new AbortController();
    const onAbort = () => signalController.abort();
    if (cancellationToken) {
      cancellationToken.addEventListener('abort', onAbort, { once: true });
      detachCancellation = () => cancellationToken.removeEventListener('abort', onAbort);
    }
    const signal = signalController.signal;
    readlineInterface = readline.createInterface({ input: child.stdout });
    const iterator = readlineInterface[Symbol.asyncIterator]();
    await writeJsonLine(child, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        clientInfo: { name: 'codex-im-suite-runtime', title: 'Codex IM Suite Runtime', version: '0.4.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    }, signal);
    await readResponse(iterator, 1, timeoutMs, signal);
    await writeJsonLine(child, { jsonrpc: '2.0', method: 'initialized', params: {} }, signal);

    const pages: unknown[][] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const id = page + 2;
      await writeJsonLine(child, {
        jsonrpc: '2.0', id, method: 'model/list',
        params: { limit: pageLimit, includeHidden: false, ...(cursor ? { cursor } : {}) },
      }, signal);
      const result = responseResult(await readResponse(iterator, id, timeoutMs, signal));
      if (!Array.isArray(result.data)) throw new Error('Codex 模型目录响应缺少 data');
      pages.push(result.data);
      cursor = stringValue(result.nextCursor);
      if (!cursor) break;
    }

    const models = mergeCodexModelOptions(pages);
    // Official app-server's catalog is independent of custom model providers.
    // When the managed config selects one, supplement it from the provider's
    // read-only /models endpoint so locally available models (for example a
    // custom GPT-6 route) are selectable without copying a model name by hand.
    const provider = readConfiguredProvider(`${runtime.env.CODEX_HOME || ''}/config.toml`);
    let publicModels = models;
    if (provider) {
      const providerCatalog = await fetchModelCatalog('external_api', configuredModel, provider.baseUrl, 'custom', provider.apiKey, timeoutMs, provider.headers);
      if (providerCatalog.status === 'ready') {
        publicModels = mergeCodexModelOptions([[...models, ...providerCatalog.models]]);
      }
    }
    return {
      protocol: PROTOCOL,
      generatedAt: new Date().toISOString(),
      status: publicModels.length > 0 ? 'ready' : 'empty',
      source: 'codex_app_server',
      models: publicModels,
      configuredModel: configuredModel.trim(),
      error: '',
    };
  } catch (error) {
    const message = error instanceof Error && error.message.includes('超时')
      ? '读取 Codex 模型目录超时。'
      : '读取 Codex 模型目录失败，请检查 Codex 登录态和 app-server。';
    return errorCatalog(configuredModel, message);
  } finally {
    detachCancellation?.();
    readlineInterface?.close();
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill(); } catch { /* process may already have exited */ }
    }
  }
}
