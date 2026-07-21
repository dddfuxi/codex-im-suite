export type WorkflowStage =
  | 'received'
  | 'authorized'
  | 'contextualized'
  | 'routed'
  | 'executing'
  | 'finalizing'
  | 'delivered'
  | 'failed';

export type WorkflowRunStatus = 'running' | 'succeeded' | 'failed' | 'retry_pending' | 'retrying';
export type WorkflowCheckpointKind = 'input' | 'permission' | 'tool' | 'provider' | 'finalizer' | 'delivery' | 'retry';
export const WORKFLOW_PANEL_STATE_PROTOCOL = 'workflow-runtime/v1' as const;

export interface WorkflowRuntimeEventContract {
  id: string;
  runId: string;
  stage: WorkflowStage;
  type: string;
  message: string;
  at: string;
  data?: Record<string, unknown>;
}

export interface WorkflowExecutionSummaryContract {
  executorId?: string;
  executorName?: string;
  executorKind?: string;
  provider?: string;
  codexProfile?: string;
  modelSource?: string;
  attemptedSources?: string[];
  selectedSource?: 'local_api' | 'external_api' | 'official';
  model?: string;
  requestedModel?: string;
  submittedModel?: string;
  modelMode?: 'source_default' | 'explicit';
  requestedReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  submittedReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  executionOverrideReason?: 'restricted_interaction';
  threadMode?: 'fresh' | 'resumed' | 'fresh_profile_changed' | 'fresh_resume_failed';
  parameterEvidence?: 'sdk_thread_options';
  baseUrl?: string;
  requiredEvidenceKind?: 'none' | 'input_evidence_required' | 'local_read_required' | 'tool_required' | 'artifact_required';
  evidenceSatisfied?: boolean;
  noEvidenceRetryAttempted?: boolean;
  requiredToolFamilies?: string[];
  requiredInputEvidenceKinds?: string[];
  requiredInputEvidenceIds?: string[];
  acceptedInputEvidenceKinds?: string[];
  acceptedInputEvidenceIds?: string[];
  inputEvidenceProvider?: string;
  toolUseCount?: number;
  toolResultCount?: number;
  successfulToolResultCount?: number;
  failedToolResultCount?: number;
  failedToolErrors?: string[];
  toolNames?: string[];
  evidenceProtocol?: string;
  requestedTool?: string;
  executedTool?: string;
  jsonToolRetryAttempted?: boolean;
  jsonToolFallbackUsed?: boolean;
  shellExitCode?: number;
  shellDurationMs?: number;
  progressCardCreated?: boolean;
  progressCardFinalized?: boolean;
  progressCardFallbackReason?: string;
  promptProfile?: string;
}

export interface WorkflowTokenUsageContract {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_tokens?: number;
}

export interface WorkflowRecoveryInputContract {
  prompt: string;
  workingDirectory?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: string;
  channelType?: string;
  chatId?: string;
  userId?: string;
  userDisplayName?: string;
  messageId?: string;
}

export interface WorkflowRecoveryStateContract {
  kind: 'recoverable' | 'not_recoverable';
  reason: string;
  input?: WorkflowRecoveryInputContract;
  runtimeRunId?: string;
  markedAt: string;
}

export interface WorkflowRetryStateContract {
  status: 'none' | 'auto_pending' | 'manual_pending' | 'retrying' | 'succeeded' | 'failed' | 'exhausted' | 'unavailable';
  attempts: number;
  maxAttempts: number;
  requestedBy?: 'auto' | 'manual';
  requestedAt?: string;
  claimedBy?: string;
  claimedAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
}

export interface WorkflowPanelRunContract {
  id: string;
  sessionId: string;
  channelType?: string;
  chatId?: string;
  promptPreview: string;
  stage: WorkflowStage;
  status: WorkflowRunStatus;
  executorId?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  error?: string;
  execution?: WorkflowExecutionSummaryContract;
  tokenUsage?: WorkflowTokenUsageContract;
  recovery?: WorkflowRecoveryStateContract;
  retry?: WorkflowRetryStateContract;
  events: WorkflowRuntimeEventContract[];
}

export interface WorkflowPanelStateContract {
  protocol: typeof WORKFLOW_PANEL_STATE_PROTOCOL;
  updatedAt: string;
  runs: WorkflowPanelRunContract[];
}

export interface WorkflowCheckpoint {
  id: string;
  kind: WorkflowCheckpointKind;
  stage: WorkflowStage;
  createdAt: string;
  summary: string;
  recoverable: boolean;
  payloadRef?: string;
}

export interface WorkflowTraceEvent {
  id: string;
  stage: WorkflowStage;
  type: string;
  createdAt: string;
  summary: string;
  nodeId?: string;
  checkpointId?: string;
}

export interface WorkflowRunContract {
  schema: 'codex-im-suite/workflow-run/v1';
  id: string;
  nodeId: string;
  status: WorkflowRunStatus;
  stage: WorkflowStage;
  sessionId?: string;
  chatId?: string;
  executorId?: string;
  createdAt: string;
  updatedAt: string;
  checkpoints: WorkflowCheckpoint[];
  events: WorkflowTraceEvent[];
}
