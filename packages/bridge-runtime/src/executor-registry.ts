import fs from 'node:fs';
import path from 'node:path';

import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

import type { Config } from './config.js';
import { resolveClaudeCliPath, preflightCheck } from './llm-provider.js';
import { getLocalRouterMode, readLocalLlmStatus } from './local-llm-status.js';
import type {
  ExecutorCapability,
  ExecutorManifest,
  ExecutorRequest,
  ExecutorSelection,
  ToolSandboxPolicy,
} from './executor-types.js';

const EXECUTOR_HINTS: Array<{ pattern: RegExp; id: string }> = [
  { pattern: /(?:^|\s)@?codex(?:\s|$)/i, id: 'codex' },
  { pattern: /(?:^|\s)@?claude(?:\s|$)/i, id: 'claude-cli' },
  { pattern: /(?:^|\s)@?(?:local|local-agent|本地)(?:\s|$)/i, id: 'local-tool-agent' },
];

function isCodexEnabled(config: Config): boolean {
  return config.runtime === 'codex' || config.runtime === 'auto';
}

function isClaudeEnabled(config: Config): boolean {
  if (config.runtime === 'codex') return false;
  const cliPath = resolveClaudeCliPath();
  return !!cliPath && preflightCheck(cliPath).ok;
}

function isLocalAgentEnabled(config: Config): boolean {
  return config.localLlmEnabled === true && getLocalRouterMode(config) !== 'codex_only';
}

export function buildToolSandboxPolicy(config: Config): ToolSandboxPolicy {
  return {
    allowReadOnlyGit: true,
    allowFileRead: true,
    allowTextSearch: true,
    allowSingleFileWrite: true,
    allowMcpOps: true,
    allowedWorkspaceRoots: config.allowedWorkspaceRoots || [config.defaultWorkDir].filter(Boolean),
    highRiskRequiresPermission: true,
  };
}

export function buildExecutorManifests(config: Config): ExecutorManifest[] {
  const localStatus = readLocalLlmStatus(config);
  const localModel = config.localLlmModel || localStatus.model || 'local-model';
  return [
    {
      id: 'codex',
      displayName: 'Codex CLI / SDK',
      kind: 'cli',
      capabilities: ['chat', 'code', 'repo_query', 'file_read', 'file_write', 'image_input', 'artifact_delivery'],
      riskLevel: 'workspace_write',
      enabled: isCodexEnabled(config),
      priority: config.runtime === 'codex' ? 100 : 80,
      description: '默认主脑执行器，负责复杂仓库修改、多步任务和工具调用。',
      healthCheck: { kind: 'runtime_status', target: 'codex' },
    },
    {
      id: 'claude-cli',
      displayName: 'Claude CLI',
      kind: 'cli',
      capabilities: ['chat', 'code', 'repo_query', 'file_read', 'file_write', 'image_input'],
      riskLevel: 'workspace_write',
      enabled: isClaudeEnabled(config),
      priority: config.runtime === 'claude' ? 95 : 70,
      description: 'Claude Code CLI 执行器，保留为可切换 CLI 后端。',
      healthCheck: { kind: 'command', target: 'claude --version' },
    },
    {
      id: 'local-tool-agent',
      displayName: `Local Tool Agent (${localModel})`,
      kind: 'agent',
      capabilities: ['chat', 'repo_query', 'file_read', 'file_write', 'mcp_ops', 'local_tool_agent'],
      riskLevel: 'workspace_write',
      enabled: isLocalAgentEnabled(config),
      priority: getLocalRouterMode(config) === 'local_only' ? 90 : 55,
      description: '受控本地模型 agent，只能通过白名单工具执行低风险或授权后的操作。',
      healthCheck: { kind: 'http', target: config.localLlmBaseUrl || localStatus.baseUrl },
      configSchema: {
        model: localModel,
        routerMode: getLocalRouterMode(config),
        sandbox: buildToolSandboxPolicy(config),
      },
    },
  ];
}

export function inferRequestedExecutorId(prompt: string): string | undefined {
  for (const hint of EXECUTOR_HINTS) {
    if (hint.pattern.test(prompt)) return hint.id;
  }
  return undefined;
}

export function inferCapabilities(params: StreamChatParams, taskKind?: string): ExecutorCapability[] {
  const prompt = params.prompt || '';
  const capabilities = new Set<ExecutorCapability>(['chat']);
  if (taskKind === 'repo_query' || /\bgit\b|分支|提交|仓库|状态/u.test(prompt)) capabilities.add('repo_query');
  if (/读取|查看|搜索|find|grep|rg\b|Get-Content/iu.test(prompt)) capabilities.add('file_read');
  if (/修改|写入|保存|生成文件|edit|patch/iu.test(prompt)) capabilities.add('file_write');
  if (/mcp|unity|blender|ignis/i.test(prompt)) capabilities.add('mcp_ops');
  if (params.files?.some((file) => file.type.startsWith('image/'))) capabilities.add('image_input');
  return Array.from(capabilities);
}

export function selectExecutor(
  config: Config,
  request: ExecutorRequest,
  sessionDefaultId?: string,
): ExecutorSelection {
  const manifests = buildExecutorManifests(config).filter((manifest) => manifest.enabled);
  const required = inferCapabilities(request.params, request.taskKind);
  const explicitId = request.requestedExecutorId || inferRequestedExecutorId(request.prompt) || sessionDefaultId;
  const preferredId = request.preferredExecutorId;
  const explicit = explicitId ? manifests.find((manifest) => manifest.id === explicitId) : undefined;
  if (explicit) {
    return {
      executor: explicit,
      explicit: true,
      reason: `显式选择执行器：${explicit.id}`,
      fallbackExecutorIds: manifests.filter((manifest) => manifest.id !== explicit.id).map((manifest) => manifest.id),
    };
  }

  const candidates = manifests
    .map((manifest) => {
      const matched = required.filter((capability) => manifest.capabilities.includes(capability)).length;
      const score = manifest.priority + matched * 20 + (manifest.id === preferredId ? 15 : 0);
      return { manifest, score, matched };
    })
    .sort((a, b) => b.score - a.score);
  const picked = candidates[0]?.manifest || buildExecutorManifests(config)[0];
  return {
    executor: picked,
    explicit: false,
    reason: `按 capability 自动选择：${required.join(', ') || 'chat'}`,
    fallbackExecutorIds: candidates.slice(1).map((item) => item.manifest.id),
  };
}

export function resolveSessionExecutorDefaultsPath(config?: Config): string {
  const home = process.env.CTI_HOME || path.join(process.env.USERPROFILE || process.cwd(), '.claude-to-im');
  return path.join(home, 'runtime', 'executor-session-defaults.json');
}

export function readSessionExecutorDefaults(config?: Config): Record<string, string> {
  const filePath = resolveSessionExecutorDefaultsPath(config);
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function writeSessionExecutorDefault(sessionId: string, executorId: string, config?: Config): void {
  const filePath = resolveSessionExecutorDefaultsPath(config);
  const current = readSessionExecutorDefaults(config);
  if (executorId) {
    current[sessionId] = executorId;
  } else {
    delete current[sessionId];
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}
