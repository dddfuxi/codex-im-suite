import type { LLMProvider } from 'claude-to-im/src/lib/bridge/host.js';
import {
  planConfiguredJsonToolRequest,
  type McpToolCallDefinition,
  type ShellArtifactDefinition,
  type UnityMcpExecuteCodeDefinition,
} from './local-agent-tool-protocol.js';

type StreamChatParams = Parameters<LLMProvider['streamChat']>[0];
type ManifestPlan = NonNullable<ReturnType<typeof planConfiguredJsonToolRequest>>;

export interface ManifestCodexSlimOptions {
  workingDirectory?: string;
  defaultWorkDir?: string;
  unityProjectPath?: string;
  allowedWorkspaceRoots?: string[];
  mcpToolCallDefinitions?: McpToolCallDefinition[];
  unityMcpExecuteCodeDefinitions?: UnityMcpExecuteCodeDefinition[];
  shellArtifactDefinitions?: ShellArtifactDefinition[];
}

export interface ManifestCodexSlimResult {
  params: StreamChatParams;
  plan: ManifestPlan | null;
  compressedHistoryChars: number;
  compressedSystemPromptChars: number;
}

function buildManifestContext(params: StreamChatParams, options: ManifestCodexSlimOptions): string {
  return [
    `workingDirectory=${params.workingDirectory || options.workingDirectory || ''}`,
    `defaultWorkDir=${options.defaultWorkDir || ''}`,
    `unityProjectPath=${options.unityProjectPath || ''}`,
    `allowedWorkspaceRoots=${(options.allowedWorkspaceRoots || []).join(';')}`,
    'mode=codex-main-manifest-slim',
  ].filter((line) => !line.endsWith('=')).join('\n');
}

function planTargetsUnityMcp(plan: ManifestPlan): boolean {
  if (plan.request.tool === 'unity_mcp_execute_code') return true;
  if (plan.request.tool !== 'mcp_call') return false;
  const args = plan.request.args as { manifestHint?: unknown; tool?: unknown };
  const haystack = `${String(args.manifestHint || '')} ${String(args.tool || '')}`.toLowerCase();
  return /unitymcp|unity\s*mcp|\bunity\b|mcpforunity|manage_(camera|scene|asset|gameobject|components|prefabs|editor)|find_gameobjects|execute_code/.test(haystack);
}

function buildManifestExecutionRequirement(plan: ManifestPlan): NonNullable<StreamChatParams['executionRequirement']> {
  if (plan.request.tool === 'shell_artifact') {
    return {
      kind: 'artifact_required',
      reason: `configured artifact manifest selected for Codex main task: ${plan.reason}`,
      requiredToolFamilies: ['artifact', 'shell'],
      strictToolEvidence: true,
    };
  }
  if (planTargetsUnityMcp(plan)) {
    return {
      kind: 'tool_required',
      reason: `configured Unity MCP manifest selected for Codex main task: ${plan.reason}`,
      requiredToolFamilies: ['unity-mcp', 'mcp'],
      strictToolEvidence: true,
    };
  }
  return {
    kind: 'tool_required',
    reason: `configured MCP manifest selected for Codex main task: ${plan.reason}`,
    requiredToolFamilies: ['mcp'],
    strictToolEvidence: true,
  };
}

function buildManifestSlimSystemPrompt(params: StreamChatParams, plan: ManifestPlan, contextText: string): string {
  return [
    'Manifest-constrained Codex task.',
    'You are still the Codex agent responsible for the task, but runtime has already selected the relevant manifest tool boundary.',
    'Return only a JSON tool_request object for the selected manifest request. Runtime will execute that JSON tool request and attach produced files/images.',
    'Do not claim the tool is unavailable just because it is not directly exposed as a Codex CLI tool. The runtime, not Codex CLI, hosts mcp_call and shell_artifact.',
    'Do not read skill files, scan directories, inspect plugin caches, or hand-write MCP HTTP/session calls before returning the selected tool_request JSON.',
    'If the selected tool cannot be executed with the provided manifest data, stop and report the concrete blocker instead of broad exploration.',
    'Selected manifest JSON tool request:',
    JSON.stringify(plan.request),
    'Runtime context:',
    contextText,
    params.systemPrompt?.trim() ? `Original reply contract:\n${params.systemPrompt.trim().slice(0, 2000)}` : '',
  ].filter(Boolean).join('\n');
}

export function buildManifestCodexSlimParams(
  params: StreamChatParams,
  options: ManifestCodexSlimOptions,
): ManifestCodexSlimResult {
  if (params.interactionMode === 'classifier') {
    return {
      params,
      plan: null,
      compressedHistoryChars: 0,
      compressedSystemPromptChars: 0,
    };
  }
  // Structured user input is already the evidence source. Manifest keyword
  // matches must not turn read-only image/audio/file analysis into a new
  // screenshot, generation, or artifact-producing action.
  if (params.executionRequirement?.kind === 'input_evidence_required') {
    return {
      params,
      plan: null,
      compressedHistoryChars: 0,
      compressedSystemPromptChars: 0,
    };
  }
  const contextText = buildManifestContext(params, options);
  const plan = planConfiguredJsonToolRequest(params.prompt, {
    workingDirectory: params.workingDirectory || options.workingDirectory,
    contextText,
    mcpToolCallDefinitions: options.mcpToolCallDefinitions || [],
    unityMcpExecuteCodeDefinitions: options.unityMcpExecuteCodeDefinitions || [],
    shellArtifactDefinitions: options.shellArtifactDefinitions || [],
  });
  if (!plan) {
    return {
      params,
      plan: null,
      compressedHistoryChars: 0,
      compressedSystemPromptChars: 0,
    };
  }

  const nextSystemPrompt = buildManifestSlimSystemPrompt(params, plan, contextText);
  return {
    params: {
      ...params,
      systemPrompt: nextSystemPrompt,
      conversationHistory: [],
      sdkSessionId: undefined,
      forceFreshThread: true,
      executionRequirement: buildManifestExecutionRequirement(plan),
    },
    plan,
    compressedHistoryChars: JSON.stringify(params.conversationHistory || []).length,
    compressedSystemPromptChars: Math.max(0, (params.systemPrompt || '').length - nextSystemPrompt.length),
  };
}
