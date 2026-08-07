import type {
  WorkflowCheckpoint,
  WorkflowCheckpointKind,
  WorkflowRunContract,
  WorkflowTraceEvent,
} from '@codex-im-suite/contracts';

import type { WorkflowRun, WorkflowStatusFile, WorkflowEvent } from './workflow-status.js';

function stableCheckpointId(runId: string, kind: WorkflowCheckpointKind, suffix: string): string {
  return `${runId}:${kind}:${suffix}`;
}

function eventToTraceEvent(event: WorkflowEvent, nodeId: string): WorkflowTraceEvent {
  return {
    id: event.id,
    stage: event.stage,
    type: event.type,
    createdAt: event.at,
    summary: event.message,
    nodeId,
  };
}

function buildRunCheckpoints(run: WorkflowRun): WorkflowCheckpoint[] {
  const checkpoints: WorkflowCheckpoint[] = [];

  if (run.recovery?.input) {
    checkpoints.push({
      id: stableCheckpointId(run.id, 'input', 'recovery'),
      kind: 'input',
      stage: 'received',
      createdAt: run.recovery.markedAt || run.startedAt,
      summary: '已持久化最小恢复输入',
      recoverable: run.recovery.kind === 'recoverable',
      payloadRef: 'recovery.input',
    });
  }

  if (run.executorId) {
    checkpoints.push({
      id: stableCheckpointId(run.id, 'provider', run.executorId),
      kind: 'provider',
      stage: 'executing',
      createdAt: run.updatedAt || run.startedAt,
      summary: `执行器已选择：${run.executorId}`,
      recoverable: run.recovery?.kind === 'recoverable',
      payloadRef: 'executorId',
    });
  }

  if (run.retry && run.retry.status !== 'none') {
    checkpoints.push({
      id: stableCheckpointId(run.id, 'retry', run.retry.status),
      kind: 'retry',
      stage: run.status === 'retrying' ? 'executing' : 'failed',
      createdAt: run.retry.requestedAt || run.retry.claimedAt || run.retry.lastAttemptAt || run.updatedAt,
      summary: `重试状态：${run.retry.status}，次数 ${run.retry.attempts}/${run.retry.maxAttempts}`,
      recoverable: run.recovery?.kind === 'recoverable',
      payloadRef: 'retry',
    });
  }

  if (run.status === 'succeeded') {
    checkpoints.push({
      id: stableCheckpointId(run.id, 'delivery', 'succeeded'),
      kind: 'delivery',
      stage: 'delivered',
      createdAt: run.endedAt || run.updatedAt,
      summary: '结果已交付',
      recoverable: false,
    });
  }

  if (run.status === 'failed') {
    checkpoints.push({
      id: stableCheckpointId(run.id, 'finalizer', 'failed'),
      kind: 'finalizer',
      stage: 'failed',
      createdAt: run.endedAt || run.updatedAt,
      summary: run.error || run.recovery?.reason || 'workflow failed',
      recoverable: run.recovery?.kind === 'recoverable',
    });
  }

  if (run.status === 'cancelled') {
    checkpoints.push({
      id: stableCheckpointId(run.id, 'finalizer', 'cancelled'),
      kind: 'finalizer',
      stage: 'failed',
      createdAt: run.endedAt || run.updatedAt,
      summary: run.error || '当前回复已终止',
      recoverable: false,
    });
  }

  return checkpoints;
}

export function toWorkflowRunContract(run: WorkflowRun, nodeId = 'local'): WorkflowRunContract {
  const checkpoints = buildRunCheckpoints(run);
  const events = run.events.map((event) => eventToTraceEvent(event, nodeId));
  const providerCheckpoint = checkpoints.find((checkpoint) => checkpoint.kind === 'provider');

  return {
    schema: 'codex-im-suite/workflow-run/v1',
    id: run.id,
    nodeId,
    status: run.status,
    stage: run.stage,
    sessionId: run.sessionId,
    chatId: run.chatId,
    executorId: run.executorId,
    verifiedOutputArtifactCount: run.execution?.verifiedOutputArtifactCount,
    replaySafety: run.execution?.replaySafety,
    retryDisposition: run.execution?.retryDisposition,
    createdAt: run.startedAt,
    updatedAt: run.updatedAt,
    checkpoints,
    events: providerCheckpoint
      ? events.map((event) => event.type.startsWith('executor.') ? { ...event, checkpointId: providerCheckpoint.id } : event)
      : events,
  };
}

export function buildWorkflowTraceSnapshot(status: WorkflowStatusFile, nodeId = 'local'): WorkflowRunContract[] {
  return status.runs.map((run) => toWorkflowRunContract(run, nodeId));
}
