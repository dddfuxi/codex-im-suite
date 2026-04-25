import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

export type ExecutorKind = 'cli' | 'agent' | 'local_model' | 'mcp';
export type ExecutorRiskLevel = 'read_only' | 'workspace_write' | 'system';
export type ExecutorCapability =
  | 'chat'
  | 'code'
  | 'repo_query'
  | 'file_read'
  | 'file_write'
  | 'mcp_ops'
  | 'image_input'
  | 'artifact_delivery'
  | 'local_tool_agent';

export interface ExecutorHealthCheck {
  kind: 'command' | 'http' | 'runtime_status' | 'none';
  target?: string;
}

export interface ExecutorManifest {
  id: string;
  displayName: string;
  kind: ExecutorKind;
  capabilities: ExecutorCapability[];
  riskLevel: ExecutorRiskLevel;
  enabled: boolean;
  priority: number;
  description: string;
  healthCheck: ExecutorHealthCheck;
  configSchema?: Record<string, unknown>;
}

export interface ExecutorRequest {
  sessionId: string;
  prompt: string;
  workingDirectory?: string;
  permissionMode?: string;
  requestedExecutorId?: string;
  preferredExecutorId?: string;
  taskKind?: string;
  params: StreamChatParams;
}

export interface ExecutorSelection {
  executor: ExecutorManifest;
  reason: string;
  explicit: boolean;
  fallbackExecutorIds: string[];
}

export interface ExecutorRun {
  id: string;
  executorId: string;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  status: 'running' | 'succeeded' | 'failed';
  reason: string;
  error?: string;
  toolCallCount?: number;
}

export interface ToolSandboxPolicy {
  allowReadOnlyGit: boolean;
  allowFileRead: boolean;
  allowTextSearch: boolean;
  allowSingleFileWrite: boolean;
  allowMcpOps: boolean;
  allowedWorkspaceRoots: string[];
  highRiskRequiresPermission: boolean;
}
