export const AGENT_COLLABORATION_PROTOCOL = 'codex-im-suite/agent-collaboration/v1' as const;
export const AGENT_WORKER_PROTOCOL = 'codex-im-suite/agent-worker/v1' as const;

export type AgentCollaborationMode = 'off' | 'shadow' | 'assist';
export type AgentSideEffectLevel = 'none';
export type CollaborationAgentId = 'coordinator' | 'context' | 'memory' | 'performance';
export type AgentTaskStatus = 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'skipped';
export type AgentWorkerHealth = 'starting' | 'online' | 'busy' | 'unresponsive' | 'restarting' | 'circuit_open' | 'stopped';

export interface CollaborationAgentManifest {
  protocol: typeof AGENT_COLLABORATION_PROTOCOL;
  id: CollaborationAgentId | string;
  displayName: string;
  enabled: boolean;
  responsibilities: string[];
  owns: string[];
  excludes: string[];
  capabilities: string[];
  inputEvidenceKinds: string[];
  outputSchemaId: string;
  sideEffectLevel: AgentSideEffectLevel;
  timeoutMs: number;
  concurrency: number;
  modelProfile: string;
}

export interface AgentTaskRequest {
  protocol: typeof AGENT_WORKER_PROTOCOL;
  runId: string;
  turnId: string;
  taskId: string;
  agentId: string;
  capability: string;
  deadlineAt: string;
  evidenceRefs: string[];
  input: Record<string, unknown>;
}

export interface AgentPromptSection {
  id: string;
  title: string;
  content: string;
  priority: number;
}

export interface AgentTaskMetrics {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  modelSource?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentTaskResult {
  protocol: typeof AGENT_WORKER_PROTOCOL;
  runId: string;
  turnId: string;
  taskId: string;
  agentId: string;
  capability: string;
  status: AgentTaskStatus;
  findings: string[];
  evidenceRefs: string[];
  promptSections: AgentPromptSection[];
  /** 经过对应 outputSchemaId 校验的结构化只读输出。 */
  output?: Record<string, unknown>;
  metrics: AgentTaskMetrics;
  errorCode?: string;
  errorSummary?: string;
}

export interface AgentTurnPlanTask {
  taskId: string;
  agentId: string;
  capability: string;
  objective: string;
  evidenceRefs: string[];
}

export interface AgentTurnPlan {
  protocol: typeof AGENT_COLLABORATION_PROTOCOL;
  shouldCollaborate: boolean;
  reason: string;
  tasks: AgentTurnPlanTask[];
}

export type AgentWorkerMessage =
  | { protocol: typeof AGENT_WORKER_PROTOCOL; type: 'hello'; workerId: string; pid: number; at: string }
  | { protocol: typeof AGENT_WORKER_PROTOCOL; type: 'heartbeat'; workerId: string; at: string; activeTaskId?: string }
  | { protocol: typeof AGENT_WORKER_PROTOCOL; type: 'task'; workerId?: string; request: AgentTaskRequest }
  | { protocol: typeof AGENT_WORKER_PROTOCOL; type: 'result'; workerId: string; result: AgentTaskResult }
  | { protocol: typeof AGENT_WORKER_PROTOCOL; type: 'cancel'; taskId: string; reason?: string }
  | { protocol: typeof AGENT_WORKER_PROTOCOL; type: 'shutdown'; reason?: string };

export type AgentWorkflowNodeKind =
  | 'bridge'
  | 'context_broker'
  | 'coordinator'
  | 'specialist'
  | 'primary_agent'
  | 'policy_verifier'
  | 'delivery';

export type AgentWorkflowNodeStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'fallback';

/**
 * 面向聊天卡片的最小脱敏协作状态。这里刻意不包含 findings、Prompt、
 * evidence 内容、模型参数或本地路径，避免把控制面板的完整运行快照外发。
 */
export interface AgentCardProgressItem {
  taskId: string;
  agentId: string;
  displayName: string;
  kind: 'coordinator' | 'specialist' | 'primary_agent';
  status: AgentWorkflowNodeStatus;
  startedAt?: string;
  durationMs?: number;
  errorCode?: string;
}

export interface AgentCardProgressSnapshot {
  runId: string;
  mode: Exclude<AgentCollaborationMode, 'off'>;
  status: AgentCollaborationRun['status'];
  injectedIntoPrimary: boolean;
  agents: AgentCardProgressItem[];
}

export interface AgentCollaborationWorkflowNode {
  id: string;
  kind: AgentWorkflowNodeKind;
  agentId?: string;
  label: string;
  status: AgentWorkflowNodeStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  evidenceCount?: number;
  evidenceRefs?: string[];
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  modelSource?: string;
  model?: string;
  summary?: string;
  triggerReason?: string;
  fallbackReason?: string;
  errorCode?: string;
}

export interface AgentCollaborationWorkflowEdge {
  from: string;
  to: string;
  kind: 'control' | 'evidence' | 'result' | 'fallback';
  status: 'pending' | 'active' | 'completed' | 'failed' | 'fallback';
}

export interface AgentCollaborationRun {
  runId: string;
  workflowRunId?: string;
  sessionId: string;
  turnId: string;
  mode: AgentCollaborationMode;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'fallback';
  triggerReason: string;
  fallbackReason?: string;
  injectedIntoPrimary: boolean;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  nodes: AgentCollaborationWorkflowNode[];
  edges: AgentCollaborationWorkflowEdge[];
}

export interface AgentWorkerView {
  workerId: string;
  pid?: number;
  health: AgentWorkerHealth;
  activeTaskId?: string;
  startedAt?: string;
  lastHeartbeatAt?: string;
  restartCount: number;
  timeoutCount: number;
  circuitOpenCount: number;
  circuitOpenUntil?: string;
  lastErrorCode?: string;
}

export interface AgentResponsibilityView {
  manifest: CollaborationAgentManifest;
  workerId?: string;
  health: 'disabled' | 'idle' | 'running' | 'degraded' | 'unavailable';
  lastInvokedAt?: string;
  lastDurationMs?: number;
  successCount: number;
  failureCount: number;
  timeoutCount: number;
  averageDurationMs?: number;
  p95DurationMs?: number;
}

export interface AgentPerformanceSuggestion {
  id: string;
  generatedAt: string;
  summary: string;
  evidenceWindow: {
    runCount: number;
    startedAt?: string;
    endedAt?: string;
  };
  metricBasis: string[];
}

export interface AgentCollaborationMetricsView {
  windowRunCount: number;
  coordinatorTriggerRate: number;
  fallbackRate: number;
  workerRestartCount: number;
  workerTimeoutCount: number;
  circuitOpenCount: number;
  specialistCallDistribution: Record<string, number>;
}

export interface AgentCollaborationPanelState {
  protocol: typeof AGENT_COLLABORATION_PROTOCOL;
  updatedAt: string;
  mode: AgentCollaborationMode;
  poolHealth: 'disabled' | 'healthy' | 'degraded' | 'unavailable';
  activeTaskCount: number;
  workers: AgentWorkerView[];
  agents: AgentResponsibilityView[];
  currentRun?: AgentCollaborationRun;
  recentRuns: AgentCollaborationRun[];
  metrics: AgentCollaborationMetricsView;
  latestPerformanceSuggestion?: AgentPerformanceSuggestion;
}
