import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import type { Config } from './config.js';

type McpType = 'http' | 'stdio';

interface McpHealthCheck {
  kind?: string;
  url?: string;
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

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = path.resolve(MODULE_DIR, '..');

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

export class McpBridge {
  constructor(private readonly config: Config) {}

  private validateManifestWorkspace(manifest: McpManifestRecord): McpHealthStatus {
    const manifestCwd = expandManifestValue(manifest.cwd, this.config);
    if (!manifestCwd) {
      return { ok: true, message: 'manifest 未声明 cwd，跳过工作区约束检查' };
    }

    const allowedRoots = splitPathList(this.config.allowedWorkspaceRoots?.join(';'));
    const defaultWorkDir = this.config.defaultWorkDir ? path.resolve(this.config.defaultWorkDir) : '';
    const unityProjectPath = this.config.unityProjectPath ? path.resolve(this.config.unityProjectPath) : '';
    const resolvedCwd = path.resolve(manifestCwd);

    const matchesAllowedRoot = allowedRoots.some((root) => isPathWithin(root, resolvedCwd));
    const matchesDefaultWorkDir = defaultWorkDir ? isPathWithin(defaultWorkDir, resolvedCwd) : false;
    const matchesUnityProject = unityProjectPath ? isPathWithin(unityProjectPath, resolvedCwd) : false;

    if (matchesAllowedRoot || matchesDefaultWorkDir || matchesUnityProject) {
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
    const manifestDir = path.join(getSuiteRoot(), 'config', 'mcp.d');
    if (!fs.existsSync(manifestDir)) return [];
    return fs.readdirSync(manifestDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const fullPath = path.join(manifestDir, name);
        const raw = fs.readFileSync(fullPath, 'utf-8');
        const parsed = JSON.parse(raw) as Omit<McpManifestRecord, 'manifestPath'>;
        return { ...parsed, manifestPath: fullPath };
      });
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
      const result = await runPowerShellFile(
        path.join(getSuiteRoot(), 'scripts', 'register-external-mcps.ps1'),
        getSuiteRoot(),
        undefined,
        1000,
      );
      const output = `${result.stdout || ''}\n${result.stderr || ''}`;
      if (new RegExp(`^${manifest.registerName}\\s`, 'm').test(output)) {
        return { ok: true, message: `已注册到 Codex: ${manifest.registerName}` };
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
    const cwd = expandManifestValue(manifest.cwd, this.config) || getSuiteRoot();
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
    const cwd = expandManifestValue(manifest.cwd, this.config) || getSuiteRoot();
    if (!launcher || !fs.existsSync(launcher)) {
      return { ok: false, message: `stopLauncher 不存在: ${launcher}` };
    }
    return runPowerShellFile(launcher, cwd, manifest.env ? this.expandEnvMap(manifest.env) : undefined, 60000);
  }

  async listHttpTools(manifest: McpManifestRecord): Promise<string[]> {
    const workspaceValidation = this.validateManifestWorkspace(manifest);
    if (!workspaceValidation.ok) {
      throw new Error(workspaceValidation.message);
    }
    const result = await this.sendHttpRequest<{ tools?: Array<{ name?: string }> }>(manifest, 'tools/list', {});
    return (result.tools || []).map((tool) => String(tool.name || '')).filter(Boolean);
  }

  async callHttpTool(manifest: McpManifestRecord, toolName: string, args: Record<string, unknown>): Promise<string> {
    const workspaceValidation = this.validateManifestWorkspace(manifest);
    if (!workspaceValidation.ok) {
      throw new Error(workspaceValidation.message);
    }
    const result = await this.sendHttpRequest<{ content?: unknown; structuredContent?: unknown; structured_content?: unknown }>(manifest, 'tools/call', {
      name: toolName,
      arguments: args,
    });
    const payload = result.content ?? result.structuredContent ?? result.structured_content ?? result;
    return formatMcpToolPayload(payload);
  }

  private expandEnvMap(values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expandManifestValue(value, this.config)]));
  }

  private async sendHttpRequest<T>(manifest: McpManifestRecord, method: string, params: Record<string, unknown>): Promise<T> {
    const endpoint = expandManifestValue(manifest.healthCheck?.url || manifest.launcher || '', this.config);
    if (!endpoint) throw new Error('HTTP MCP 缺少 endpoint');

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
}
