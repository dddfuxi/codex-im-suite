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
