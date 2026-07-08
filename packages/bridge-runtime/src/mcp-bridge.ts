import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { Config } from './config.js';

type McpType = 'http' | 'stdio';

interface McpHealthCheck {
  kind?: string;
  url?: string;
  resourceUri?: string;
  successRegex?: string;
  failureRegex?: string;
}

interface ExtensionCompatibility {
  protocol?: string;
  suite?: string;
}

export interface McpManifestRecord {
  id: string;
  displayName?: string;
  type: McpType;
  version?: string;
  compatibility?: ExtensionCompatibility;
  category?: string;
  optional?: boolean;
  installState?: string;
  source?: string;
  aliases?: string[];
  enabled?: boolean;
  launcher?: string;
  stopLauncher?: string;
  cwd?: string;
  registerName?: string;
  env?: Record<string, string>;
  healthCheck?: McpHealthCheck;
  description?: string;
  manifestPath: string;
}

interface McpJsonRpcSuccess<T> {
  jsonrpc: '2.0';
  id?: string | number | null;
  result: T;
}

interface McpJsonRpcError {
  jsonrpc: '2.0';
  id?: string | number | null;
  error: { code?: number; message?: string; data?: unknown };
}

type McpJsonRpcResponse<T> = McpJsonRpcSuccess<T> | McpJsonRpcError;

export interface McpHealthStatus {
  ok: boolean;
  message: string;
}

export interface McpStartStopResult {
  ok: boolean;
  message: string;
  stdout?: string;
  stderr?: string;
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpToolCallResult {
  ok: boolean;
  content: string;
  error?: string;
}

interface HttpMcpSession {
  endpoint: string;
  sessionId: string;
  expiresAt: number;
}

interface HttpMcpToolCacheEntry {
  expiresAt: number;
  tools: McpToolInfo[];
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = path.resolve(MODULE_DIR, '..');
const HTTP_MCP_SESSION_TTL_MS = 5 * 60_000;
const HTTP_MCP_TOOL_CACHE_TTL_MS = 30_000;

function getSuiteRoot(): string {
  const candidates = [
    process.env.CODEX_IM_SUITE_ROOT || '',
    path.join(os.homedir(), 'Documents', 'New project', 'codex-im-suite'),
    path.resolve(RUNTIME_ROOT, '..', '..'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'suite.manifest.json'))) return path.resolve(candidate);
  }
  return path.resolve(RUNTIME_ROOT, '..', '..');
}

function getCtiHome(): string {
  return process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im');
}

function getExtensionManifestDir(kind: 'mcp.d' | 'skills.d' | 'plugins.d'): string {
  return path.join(getCtiHome(), 'extensions', 'manifests', kind);
}

function getManifestDirs(kind: 'mcp.d' | 'skills.d' | 'plugins.d'): string[] {
  const dirs = [
    path.join(getSuiteRoot(), 'config', kind),
    getExtensionManifestDir(kind),
  ];
  const seen = new Set<string>();
  return dirs
    .map((dir) => path.resolve(dir))
    .filter((dir) => {
      const key = dir.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return fs.existsSync(dir);
    });
}

function splitPathList(rawValue?: string | null): string[] {
  if (!rawValue) return [];
  const seen = new Set<string>();
  const values: string[] = [];
  for (const part of rawValue.split(/[,\n;|]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(resolved);
  }
  return values;
}

function expandManifestValue(value: string | undefined, config: Config): string {
  if (!value) return '';
  const suiteRoot = getSuiteRoot();
  const map: Record<string, string> = {
    SUITE_ROOT: suiteRoot,
    CTI_HOME: getCtiHome(),
    USERPROFILE: process.env.USERPROFILE || os.homedir(),
    CTI_UNITY_PROJECT_PATH: config.unityProjectPath || '',
    CTI_DEFAULT_WORKDIR: config.defaultWorkDir || process.cwd(),
    CTI_MEMORY_REPO_DIR: config.memoryRepoDir || '',
  };
  let result = value;
  for (const [key, mapped] of Object.entries(map)) {
    result = result.replaceAll(`\${${key}}`, mapped);
  }
  if (/^https?:\/\//i.test(result)) {
    return result;
  }
  return path.normalize(result);
}

function parseSseJson<T>(rawText: string): T {
  const dataLines = rawText
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6).trim())
    .filter(Boolean);
  if (dataLines.length === 0) {
    return JSON.parse(rawText) as T;
  }
  return JSON.parse(dataLines[dataLines.length - 1]) as T;
}

function compactStatusText(value: string, maxLength = 260): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function formatMcpResourceResult(result: unknown): string {
  if (result && typeof result === 'object' && Array.isArray((result as { contents?: unknown }).contents)) {
    const texts = ((result as { contents?: Array<{ text?: unknown }> }).contents || [])
      .map((item) => typeof item?.text === 'string' ? item.text : '')
      .filter(Boolean);
    if (texts.length > 0) return texts.join('\n');
  }
  return JSON.stringify(result);
}

function isPathWithin(baseDir: string, targetDir: string): boolean {
  const baseResolved = path.resolve(baseDir);
  const targetResolved = path.resolve(targetDir);
  const relative = path.relative(baseResolved, targetResolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function compactSearchText(value: string): string {
  return normalizeSearchText(value).replace(/\s+/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runPowerShellFile(scriptPath: string, cwd: string, env?: Record<string, string>, timeoutMs = 45000): Promise<McpStartStopResult> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd,
      env: { ...process.env, ...(env || {}) },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: (code ?? 1) === 0,
        message: (stdout || stderr || `exit=${code ?? 1}`).trim(),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        message: error.message,
        stderr: error.message,
      });
    });
  });
}

async function runPowerShellCommand(command: string, cwd: string, timeoutMs = 45000): Promise<McpStartStopResult> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
      cwd,
      env: process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: (code ?? 1) === 0,
        message: (stdout || stderr || `exit=${code ?? 1}`).trim(),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        message: error.message,
        stderr: error.message,
      });
    });
  });
}

async function startPowerShellFileDetached(scriptPath: string, cwd: string, env?: Record<string, string>): Promise<McpStartStopResult> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd,
      env: { ...process.env, ...(env || {}) },
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (error) => {
      resolve({
        ok: false,
        message: error.message,
        stderr: error.message,
      });
    });
    child.unref();
    resolve({
      ok: true,
      message: `started detached PID=${child.pid}`,
      stdout: `PID=${child.pid}`,
    });
  });
}

function formatMcpToolPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) {
    const texts = payload
      .map((item) => {
        if (item && typeof item === 'object' && 'text' in item) {
          return String((item as { text?: unknown }).text || '');
        }
        return '';
      })
      .filter(Boolean);
    if (texts.length > 0) return texts.join('\n');
  }
  return JSON.stringify(payload, null, 2);
}

function getManifestCwd(manifest: McpManifestRecord, config: Config): string {
  const cwd = expandManifestValue(manifest.cwd, config);
  if (cwd && fs.existsSync(cwd)) return cwd;
  return getSuiteRoot();
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform === 'win32' && child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      const timer = setTimeout(resolve, 2000);
      killer.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      killer.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  try {
    child.stdin.destroy();
  } catch {
    // ignore best-effort shutdown errors
  }
  if (!child.killed) {
    try {
      child.kill();
    } catch {
      // ignore best-effort shutdown errors
    }
  }
  try { child.stdout.destroy(); } catch { /* ignore best-effort shutdown errors */ }
  try { child.stderr.destroy(); } catch { /* ignore best-effort shutdown errors */ }
}

function waitForChildClose(child: ChildProcessWithoutNullStreams, timeoutMs = 1500): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export class McpBridge {
  private readonly httpSessions = new Map<string, HttpMcpSession>();
  private readonly httpToolDetailsCache = new Map<string, HttpMcpToolCacheEntry>();

  constructor(private readonly config: Config) {}

  private validateManifestWorkspace(manifest: McpManifestRecord): McpHealthStatus {
    const manifestCwd = expandManifestValue(manifest.cwd, this.config);
    if (!manifestCwd) {
      // MCP manifests are executable boundaries; an implicit cwd would bypass the workspace allow-list.
      return {
        ok: false,
        message: `MCP manifest 未声明 cwd，拒绝跳过工作区约束：${manifest.id || path.basename(manifest.manifestPath || 'unknown')}`,
      };
    }

    const allowedRoots = splitPathList(this.config.allowedWorkspaceRoots?.join(';'));
    const defaultWorkDir = this.config.defaultWorkDir ? path.resolve(this.config.defaultWorkDir) : '';
    const unityProjectPath = this.config.unityProjectPath ? path.resolve(this.config.unityProjectPath) : '';
    const userExtensionRoot = path.resolve(getCtiHome(), 'extensions');
    const resolvedCwd = path.resolve(manifestCwd);

    const matchesAllowedRoot = allowedRoots.some((root) => isPathWithin(root, resolvedCwd));
    const matchesDefaultWorkDir = defaultWorkDir ? isPathWithin(defaultWorkDir, resolvedCwd) : false;
    const matchesUnityProject = unityProjectPath ? isPathWithin(unityProjectPath, resolvedCwd) : false;
    const matchesUserExtensions = isPathWithin(userExtensionRoot, resolvedCwd);

    if (matchesAllowedRoot || matchesDefaultWorkDir || matchesUnityProject || matchesUserExtensions) {
      return {
        ok: true,
        message: `工作区匹配：${resolvedCwd}`,
      };
    }

    return {
      ok: false,
      message: `MCP 工作目录不在当前默认工作区内：${resolvedCwd}`,
    };
  }

  listManifests(): McpManifestRecord[] {
    const byId = new Map<string, McpManifestRecord>();
    for (const manifestDir of getManifestDirs('mcp.d')) {
      for (const name of fs.readdirSync(manifestDir).filter((item) => item.endsWith('.json')).sort()) {
        const fullPath = path.join(manifestDir, name);
        const raw = fs.readFileSync(fullPath, 'utf-8');
        const parsed = JSON.parse(raw) as Omit<McpManifestRecord, 'manifestPath'>;
        byId.set(parsed.id, { ...parsed, manifestPath: fullPath });
      }
    }
    return [...byId.values()];
  }

  private getManifestSearchTerms(manifest: McpManifestRecord): string[] {
    const rawTerms = [
      manifest.id,
      manifest.displayName || '',
      manifest.registerName || '',
      manifest.category || '',
      ...(manifest.aliases || []),
      path.basename(manifest.manifestPath, '.json'),
    ];
    const seen = new Set<string>();
    return rawTerms
      .map((item) => normalizeSearchText(item || ''))
      .filter(Boolean)
      .filter((item) => {
        if (seen.has(item)) return false;
        seen.add(item);
        return true;
      })
      .sort((a, b) => b.length - a.length);
  }

  listAvailableManifestNames(): string[] {
    return this.listManifests()
      .filter((manifest) => manifest.enabled !== false)
      .map((manifest) => manifest.displayName || manifest.id)
      .filter(Boolean);
  }

  resolveManifestByHint(hint: string): McpManifestRecord | null {
    const normalized = hint.trim().toLowerCase();
    const manifests = this.listManifests();
    const candidates = manifests.filter((manifest) => {
      const haystacks = this.getManifestSearchTerms(manifest);
      return haystacks.some((item) => item.includes(normalized) || normalized.includes(item));
    });
    return candidates[0] || null;
  }

  resolveManifestFromPrompt(prompt: string): McpManifestRecord | null {
    const normalized = normalizeSearchText(prompt);
    const compact = compactSearchText(prompt);
    const candidates = this.listManifests()
      .filter((manifest) => manifest.enabled !== false)
      .flatMap((manifest) => this.getManifestSearchTerms(manifest).map((term) => ({ manifest, term })))
      .sort((a, b) => b.term.length - a.term.length);
    for (const candidate of candidates) {
      if (candidate.term.length < 3) continue;
      if (normalized.includes(candidate.term) || compact.includes(compactSearchText(candidate.term))) {
        return candidate.manifest;
      }
    }
    return null;
  }

  async checkHealth(manifest: McpManifestRecord): Promise<McpHealthStatus> {
    const workspaceValidation = this.validateManifestWorkspace(manifest);
    if (!workspaceValidation.ok) return workspaceValidation;

    if (manifest.type === 'http') {
      const url = expandManifestValue(manifest.healthCheck?.url || '', this.config);
      if (manifest.healthCheck?.kind === 'mcp-http-resource' || manifest.healthCheck?.resourceUri) {
        const resourceUri = manifest.healthCheck?.resourceUri || '';
        if (!url) return { ok: false, message: 'manifest 未配置 http healthCheck.url' };
        if (!resourceUri) return { ok: false, message: 'manifest 未配置 mcp resource healthCheck.resourceUri' };
        try {
          const result = await this.sendHttpRequest<unknown>(manifest, 'resources/read', { uri: resourceUri });
          const text = formatMcpResourceResult(result);
          if (manifest.healthCheck?.failureRegex && new RegExp(manifest.healthCheck.failureRegex, 'i').test(text)) {
            return { ok: false, message: `MCP protocol 在线，但资源健康检查未通过 | ${resourceUri} | ${compactStatusText(text)}` };
          }
          if (manifest.healthCheck?.successRegex && !new RegExp(manifest.healthCheck.successRegex, 'i').test(text)) {
            return { ok: false, message: `MCP protocol 在线，但资源健康检查未满足成功条件 | ${resourceUri} | ${compactStatusText(text)}` };
          }
          return { ok: true, message: `MCP resource 健康检查通过 | ${resourceUri} | ${compactStatusText(text)}` };
        } catch (error) {
          return { ok: false, message: `MCP resource 健康检查失败 | ${resourceUri} | ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      if (!url) return { ok: false, message: 'manifest 未配置 http healthCheck.url' };
      try {
        const response = await fetch(url, { method: 'GET' });
        const code = response.status;
        if (response.ok || [400, 401, 403, 404, 405, 406].includes(code)) {
          return { ok: true, message: `HTTP 在线 ${code} ${response.statusText} | ${url}` };
        }
        return { ok: false, message: `HTTP ${code} ${response.statusText} | ${url}` };
      } catch (error) {
        return { ok: false, message: `${url} | ${error instanceof Error ? error.message : String(error)}` };
      }
    }

    if (manifest.healthCheck?.kind === 'codex-mcp-list' && manifest.registerName) {
      const result = await runPowerShellCommand('codex mcp list', getSuiteRoot(), 5000);
      const output = `${result.stdout || ''}\n${result.stderr || ''}`;
      if (new RegExp(`^${escapeRegExp(manifest.registerName)}\\s`, 'm').test(output)) {
        return { ok: true, message: `已注册到 Codex，待 Codex 会话握手时加载：${manifest.registerName}` };
      }
      if (!result.ok) {
        return { ok: false, message: `codex mcp list 执行失败：${result.message || '无输出'}` };
      }
      return { ok: false, message: `未在 codex mcp list 中发现 ${manifest.registerName}` };
    }

    return { ok: false, message: '暂不支持的 MCP 健康检查类型' };
  }

  async startService(manifest: McpManifestRecord): Promise<McpStartStopResult> {
    const workspaceValidation = this.validateManifestWorkspace(manifest);
    if (!workspaceValidation.ok) {
      return { ok: false, message: workspaceValidation.message };
    }
    const launcher = expandManifestValue(manifest.launcher, this.config);
    const cwd = getManifestCwd(manifest, this.config);
    if (!launcher || !fs.existsSync(launcher)) {
      return { ok: false, message: `launcher 不存在: ${launcher}` };
    }
    if (manifest.type === 'http') {
      return startPowerShellFileDetached(launcher, cwd, manifest.env ? this.expandEnvMap(manifest.env) : undefined);
    }
    return runPowerShellFile(launcher, cwd, manifest.env ? this.expandEnvMap(manifest.env) : undefined, 60000);
  }

  async stopService(manifest: McpManifestRecord): Promise<McpStartStopResult> {
    const workspaceValidation = this.validateManifestWorkspace(manifest);
    if (!workspaceValidation.ok) {
      return { ok: false, message: workspaceValidation.message };
    }
    const launcher = expandManifestValue(manifest.stopLauncher || '', this.config);
    const cwd = getManifestCwd(manifest, this.config);
    if (!launcher || !fs.existsSync(launcher)) {
      return { ok: false, message: `stopLauncher 不存在: ${launcher}` };
    }
    return runPowerShellFile(launcher, cwd, manifest.env ? this.expandEnvMap(manifest.env) : undefined, 60000);
  }

  async listHttpToolDetails(manifest: McpManifestRecord): Promise<McpToolInfo[]> {
    const workspaceValidation = this.validateManifestWorkspace(manifest);
    if (!workspaceValidation.ok) {
      throw new Error(workspaceValidation.message);
    }
    const endpoint = this.getHttpEndpoint(manifest);
    const cacheKey = `${manifest.id}|${endpoint}`;
    const cached = this.httpToolDetailsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.tools.map((tool) => ({ ...tool }));
    }
    const result = await this.sendHttpRequest<{ tools?: Array<{ name?: string; title?: string; description?: string; inputSchema?: unknown }> }>(manifest, 'tools/list', {});
    const tools = (result.tools || [])
      .map((tool) => ({
        name: String(tool.name || '').trim(),
        title: typeof tool.title === 'string' ? tool.title : undefined,
        description: typeof tool.description === 'string' ? tool.description : undefined,
        inputSchema: tool.inputSchema,
      }))
      .filter((tool) => tool.name);
    this.httpToolDetailsCache.set(cacheKey, {
      expiresAt: Date.now() + HTTP_MCP_TOOL_CACHE_TTL_MS,
      tools,
    });
    return tools.map((tool) => ({ ...tool }));
  }

  async listHttpTools(manifest: McpManifestRecord): Promise<string[]> {
    return (await this.listHttpToolDetails(manifest)).map((tool) => tool.name);
  }

  async listToolDetails(manifest: McpManifestRecord): Promise<McpToolInfo[]> {
    if (manifest.type === 'http') return this.listHttpToolDetails(manifest);
    return this.listStdioToolDetails(manifest);
  }

  async listTools(manifest: McpManifestRecord): Promise<string[]> {
    return (await this.listToolDetails(manifest)).map((tool) => tool.name);
  }

  async callHttpTool(manifest: McpManifestRecord, toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const workspaceValidation = this.validateManifestWorkspace(manifest);
    if (!workspaceValidation.ok) {
      throw new Error(workspaceValidation.message);
    }
    const result = await this.sendHttpRequest<{ isError?: boolean; content?: unknown; structuredContent?: unknown; structured_content?: unknown; error?: unknown }>(manifest, 'tools/call', {
      name: toolName,
      arguments: args,
    });
    const payload = result.content ?? result.structuredContent ?? result.structured_content ?? result;
    const content = formatMcpToolPayload(payload);
    const error = typeof result.error === 'string' ? result.error : undefined;
    return { ok: result.isError !== true && !error, content, ...(error ? { error } : {}) };
  }

  async callTool(manifest: McpManifestRecord, toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (manifest.type === 'http') return this.callHttpTool(manifest, toolName, args);
    return this.callStdioTool(manifest, toolName, args);
  }

  private async listStdioToolDetails(manifest: McpManifestRecord): Promise<McpToolInfo[]> {
    const result = await this.sendStdioRequest<{ tools?: Array<{ name?: string; title?: string; description?: string; inputSchema?: unknown }> }>(
      manifest,
      'tools/list',
      {},
    );
    return (result.tools || [])
      .map((tool) => ({
        name: String(tool.name || '').trim(),
        title: typeof tool.title === 'string' ? tool.title : undefined,
        description: typeof tool.description === 'string' ? tool.description : undefined,
        inputSchema: tool.inputSchema,
      }))
      .filter((tool) => tool.name);
  }

  private async callStdioTool(manifest: McpManifestRecord, toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = await this.sendStdioRequest<{ isError?: boolean; content?: unknown; structuredContent?: unknown; structured_content?: unknown; error?: unknown }>(
      manifest,
      'tools/call',
      { name: toolName, arguments: args },
    );
    const payload = result.content ?? result.structuredContent ?? result.structured_content ?? result;
    const content = formatMcpToolPayload(payload);
    const error = typeof result.error === 'string' ? result.error : undefined;
    return { ok: result.isError !== true && !error, content, ...(error ? { error } : {}) };
  }

  private expandEnvMap(values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expandManifestValue(value, this.config)]));
  }

  private async sendStdioRequest<T>(manifest: McpManifestRecord, method: string, params: Record<string, unknown>): Promise<T> {
    const workspaceValidation = this.validateManifestWorkspace(manifest);
    if (!workspaceValidation.ok) {
      throw new Error(workspaceValidation.message);
    }
    const launcher = expandManifestValue(manifest.launcher, this.config);
    if (!launcher || !fs.existsSync(launcher)) {
      throw new Error(`stdio MCP launcher 不存在: ${launcher}`);
    }
    const cwd = getManifestCwd(manifest, this.config);
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher], {
      cwd,
      env: { ...process.env, ...(manifest.env ? this.expandEnvMap(manifest.env) : {}) },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let nextId = 1;
    let markStartupReady: (() => void) | null = null;
    const startupReady = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        markStartupReady = null;
        resolve();
      }, 1000);
      markStartupReady = () => {
        clearTimeout(timer);
        markStartupReady = null;
        resolve();
      };
    });
    const pending = new Map<number, {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }>();

    const parseOutput = () => {
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message: McpJsonRpcResponse<unknown> | null = null;
        try {
          message = JSON.parse(line) as McpJsonRpcResponse<unknown>;
        } catch {
          continue;
        }
        const id = typeof message.id === 'number' ? message.id : null;
        if (id === null) continue;
        const target = pending.get(id);
        if (!target) continue;
        pending.delete(id);
        if ('error' in message) {
          target.reject(new Error(message.error?.message || `MCP ${method} 返回错误`));
        } else {
          target.resolve(message.result);
        }
      }
    };

    const call = (rpcMethod: string, rpcParams: Record<string, unknown> | undefined): Promise<unknown> => {
      const id = nextId;
      nextId += 1;
      const payload = { jsonrpc: '2.0', id, method: rpcMethod, params: rpcParams || {} };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
          if (error) {
            pending.delete(id);
            reject(error);
          }
        });
      });
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (markStartupReady) markStartupReady();
      parseOutput();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      for (const target of pending.values()) target.reject(error);
      pending.clear();
    });
    child.on('close', (code) => {
      if (pending.size === 0) return;
      const message = stderr || stdout || `stdio MCP exited with code ${code ?? 1}`;
      for (const target of pending.values()) target.reject(new Error(message.trim()));
      pending.clear();
    });

    const operation = async (): Promise<T> => {
      await startupReady;
      await call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codex-im-suite-local-agent', version: '0.1.0' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
      return await call(method, params) as T;
    };

    const timeoutMs = 30000;
    let hardTimer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
      hardTimer = setTimeout(() => {
        reject(new Error(`MCP stdio request timed out: ${method}${stderr ? ` | stderr: ${stderr.slice(0, 400)}` : ''}`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([operation(), timeout]);
    } finally {
      if (hardTimer) clearTimeout(hardTimer);
      for (const target of pending.values()) {
        target.reject(new Error(`MCP stdio request closed: ${method}`));
      }
      pending.clear();
      await terminateChild(child);
      await waitForChildClose(child);
    }
  }

  private getHttpEndpoint(manifest: McpManifestRecord): string {
    const endpoint = expandManifestValue(manifest.healthCheck?.url || manifest.launcher || '', this.config);
    if (!endpoint) throw new Error('HTTP MCP 缺少 endpoint');
    return endpoint;
  }

  private async getHttpSession(manifest: McpManifestRecord, endpoint: string, forceRefresh = false): Promise<HttpMcpSession> {
    const cacheKey = `${manifest.id}|${endpoint}`;
    const cached = this.httpSessions.get(cacheKey);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached;

    const initResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'init-1',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'codex-im-suite-local-agent', version: '0.1.0' },
        },
      }),
    });
    if (!initResponse.ok) {
      throw new Error(`MCP initialize 失败: ${initResponse.status} ${initResponse.statusText}`);
    }
    const sessionId = initResponse.headers.get('mcp-session-id');
    if (!sessionId) {
      throw new Error('MCP initialize 成功但未返回 mcp-session-id');
    }
    await initResponse.text();

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    };
    await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    });

    const session = {
      endpoint,
      sessionId,
      expiresAt: Date.now() + HTTP_MCP_SESSION_TTL_MS,
    };
    this.httpSessions.set(cacheKey, session);
    return session;
  }

  private async sendHttpRequestOnce<T>(
    manifest: McpManifestRecord,
    endpoint: string,
    method: string,
    params: Record<string, unknown>,
    forceNewSession = false,
  ): Promise<T> {
    const session = await this.getHttpSession(manifest, endpoint, forceNewSession);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': session.sessionId,
    };
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `req-${Date.now()}`,
        method,
        params,
      }),
    });
    if (!response.ok) {
      throw new Error(`MCP ${method} 失败: ${response.status} ${response.statusText}`);
    }
    const payload = parseSseJson<McpJsonRpcResponse<T>>(await response.text());
    if ('error' in payload) {
      throw new Error(payload.error?.message || `MCP ${method} 返回错误`);
    }
    return payload.result;
  }

  private async sendHttpRequest<T>(manifest: McpManifestRecord, method: string, params: Record<string, unknown>): Promise<T> {
    const endpoint = this.getHttpEndpoint(manifest);
    try {
      return await this.sendHttpRequestOnce<T>(manifest, endpoint, method, params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/session|mcp-session-id|missing session/i.test(message)) throw error;
      this.httpSessions.delete(`${manifest.id}|${endpoint}`);
      return await this.sendHttpRequestOnce<T>(manifest, endpoint, method, params, true);
    }
  }
}
