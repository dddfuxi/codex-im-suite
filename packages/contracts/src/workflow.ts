export type WorkflowStage =
  | 'received'
  | 'authorized'
  | 'contextualized'
  | 'routed'
  | 'executing'
  | 'finalizing'
  | 'delivered'
  | 'failed';

export type WorkflowRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'retry_pending' | 'retrying';
export type WorkflowCheckpointKind = 'input' | 'permission' | 'tool' | 'provider' | 'finalizer' | 'delivery' | 'retry';
export const WORKFLOW_PANEL_STATE_PROTOCOL = 'workflow-runtime/v1' as const;
export const WORKFLOW_FAILURE_LEDGER_PROTOCOL = 'workflow-failure-ledger/v1' as const;

export interface WorkflowRuntimeEventContract {
  id: string;
  runId: string;
  stage: WorkflowStage;
  type: string;
  message: string;
  at: string;
  data?: Record<string, unknown>;
}

export type WorkflowFailureDiagnosticSource = 'provider' | 'tool';
export type WorkflowFailureDiagnosticCategory =
  | 'authentication'
  | 'usage_limit'
  | 'provider_protocol'
  | 'invalid_request'
  | 'cancelled'
  | 'transient'
  | 'dependency_unavailable'
  | 'runtime_incompatible'
  | 'runtime_unavailable'
  | 'unknown';

/**
 * 脱敏后的稳定失败诊断。原始错误仍只保留在受控运行记录中；自动化、面板和
 * 性能分析使用这里的 code/category 去重，避免绝对路径或底层异常覆盖主因。
 */
export interface WorkflowFailureDiagnosticContract {
  source: WorkflowFailureDiagnosticSource;
  category: WorkflowFailureDiagnosticCategory;
  code: string;
  summary: string;
  autoRetry?: boolean;
}

export type WorkflowReplaySafety =
  | 'safe_no_tools'
  | 'safe_read_only'
  | 'unsafe_side_effects'
  | 'unsafe_unknown';

export type WorkflowRetryDisposition =
  | 'not_needed'
  | 'retry_in_turn'
  | 'artifact_recovery'
  | 'manual_retry_required'
  | 'exhausted'
  | 'not_retryable';

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
  /** 当前回合内已经通过 TurnStorage 完整复核的输出产物数量。 */
  verifiedOutputArtifactCount?: number;
  /** Provider 断流后，基于实际工具调用和 Manifest 风险得出的重放安全级别。 */
  replaySafety?: WorkflowReplaySafety;
  /** 本轮失败最终采用的恢复处置；不会作为新的状态枚举。 */
  retryDisposition?: WorkflowRetryDisposition;
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
  failureDiagnostics?: WorkflowFailureDiagnosticContract[];
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

export interface WorkflowExecutionRequirementContract {
  kind: 'none' | 'input_evidence_required' | 'local_read_required' | 'tool_required' | 'artifact_required';
  reason: string;
  requiredToolFamilies: string[];
  requiredInputEvidenceKinds?: Array<'image' | 'audio' | 'video' | 'file'>;
  requiredInputEvidenceIds?: string[];
  strictToolEvidence?: boolean;
}

export interface WorkflowRecoveryInputEvidenceRefContract {
  id: string;
  name: string;
  type: string;
  size: number;
  filePath: string;
  sha256: string;
  createdAt: string;
  expiresAt: string;
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
  turnId?: string;
  workingDirectory?: string;
  additionalDirectories?: string[];
  model?: string;
  systemPrompt?: string;
  permissionMode?: string;
  executionRequirement?: WorkflowExecutionRequirementContract;
  noEvidenceRetryAttempted?: boolean;
  inputEvidenceRefs?: WorkflowRecoveryInputEvidenceRefContract[];
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

export type WorkflowFailureLedgerKind = 'workflow_failed' | 'retry_failed' | 'restart_interrupted';

/**
 * 跨 Workflow 滚动窗口保留的最小失败事实。这里不保存正文、错误原文、
 * session/chat/user 标识或绝对路径；sequence 可作为每日扫描的稳定水位。
 */
export interface WorkflowFailureLedgerEntryContract {
  sequence: number;
  fingerprint: string;
  occurredAt: string;
  kind: WorkflowFailureLedgerKind;
  state: 'observed' | 'resolved';
  stage: WorkflowStage;
  workflowStatus: WorkflowRunStatus;
  failureCodes: string[];
  replaySafety?: WorkflowReplaySafety;
  retryDisposition?: WorkflowRetryDisposition;
  repairEvidenceRefs?: string[];
}

export interface WorkflowFailureLedgerContract {
  protocol: typeof WORKFLOW_FAILURE_LEDGER_PROTOCOL;
  updatedAt: string;
  nextSequence: number;
  retainedFromSequence: number;
  entries: WorkflowFailureLedgerEntryContract[];
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
  verifiedOutputArtifactCount?: number;
  replaySafety?: WorkflowReplaySafety;
  retryDisposition?: WorkflowRetryDisposition;
  createdAt: string;
  updatedAt: string;
  checkpoints: WorkflowCheckpoint[];
  events: WorkflowTraceEvent[];
}
