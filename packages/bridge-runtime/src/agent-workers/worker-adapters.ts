import crypto from 'node:crypto';

import type { AgentCollaborationRun, AgentTaskRequest, AgentTaskResult } from '@codex-im-suite/contracts';
import type {
  MemoryIntentHost,
  MemoryWriteIntentDecision,
  MemoryWriteIntentInput,
  TurnReferenceResolutionInput,
  TurnReferenceResolverHost,
} from 'claude-to-im/host';
import { createTurnReferenceResolverSnapshot } from 'claude-to-im/evidence';

import type { Config } from '../config.js';
import type { AgentCollaborationStateStore } from './state-store.js';
import type { AgentWorkerSupervisor } from './supervisor.js';

function nowIso(): string {
  return new Date().toISOString();
}

function standaloneRun(input: {
  runId: string;
  sessionId: string;
  turnId: string;
  agentId: string;
  taskId: string;
  label: string;
  triggerReason: string;
  evidenceRefs: string[];
  mode: 'shadow' | 'assist';
}): AgentCollaborationRun {
  const timestamp = nowIso();
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    mode: input.mode,
    status: 'running',
    triggerReason: input.triggerReason,
    injectedIntoPrimary: input.mode === 'assist',
    startedAt: timestamp,
    nodes: [
      { id: 'bridge', kind: 'bridge', label: 'Bridge Gateway', status: 'succeeded', startedAt: timestamp, endedAt: timestamp, durationMs: 0 },
      { id: 'context', kind: 'context_broker', label: 'Context Broker', status: input.agentId === 'context' ? 'running' : 'skipped' },
      { id: 'agent:coordinator', kind: 'coordinator', agentId: 'coordinator', label: 'Coordinator Agent', status: 'skipped', summary: '该任务由确定性入口直接触发，无需 Coordinator。' },
      { id: `agent:${input.taskId}`, kind: 'specialist', agentId: input.agentId, label: input.label, status: 'running', startedAt: timestamp, evidenceCount: input.evidenceRefs.length, evidenceRefs: input.evidenceRefs },
      { id: 'primary', kind: 'primary_agent', label: 'Primary Agent（唯一执行者）', status: 'skipped' },
      { id: 'policy', kind: 'policy_verifier', label: 'Policy Verifier', status: 'skipped' },
      { id: 'delivery', kind: 'delivery', label: 'Delivery（唯一发送者）', status: 'skipped' },
    ],
    edges: [
      { from: 'bridge', to: `agent:${input.taskId}`, kind: 'control', status: 'active' },
      { from: `agent:${input.taskId}`, to: 'primary', kind: 'result', status: 'pending' },
    ],
  };
}

class StandaloneWorkerAdapter {
  constructor(
    protected readonly config: Config,
    protected readonly supervisor: AgentWorkerSupervisor,
    protected readonly stateStore: AgentCollaborationStateStore,
  ) {}

  protected async execute(input: {
    sessionId: string;
    turnId: string;
    agentId: string;
    capability: string;
    taskInput: Record<string, unknown>;
    evidenceRefs: string[];
    triggerReason: string;
    abortSignal?: AbortSignal;
  }): Promise<AgentTaskResult> {
    const runId = crypto.randomUUID();
    const taskId = `${input.agentId}-${crypto.randomUUID().slice(0, 8)}`;
    const mode = this.config.agentCollaborationMode === 'assist' ? 'assist' : 'shadow';
    this.stateStore.startRun(standaloneRun({
      runId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentId: input.agentId,
      taskId,
      label: input.agentId === 'context' ? '上下文 Agent' : '记忆 Agent',
      triggerReason: input.triggerReason,
      evidenceRefs: input.evidenceRefs,
      mode,
    }));
    const request: AgentTaskRequest = {
      protocol: 'codex-im-suite/agent-worker/v1',
      runId,
      turnId: input.turnId,
      taskId,
      agentId: input.agentId,
      capability: input.capability,
      deadlineAt: new Date(Date.now() + (this.config.agentTaskTimeoutMs || 30_000)).toISOString(),
      evidenceRefs: input.evidenceRefs,
      input: input.taskInput,
    };
    const result = await this.supervisor.executeTask(request, new Set(input.evidenceRefs), input.abortSignal);
    this.stateStore.recordAgentResult(runId, result);
    if (input.agentId === 'context') {
      this.stateStore.updateNode(runId, 'context', {
        status: result.status === 'succeeded' ? 'succeeded' : 'fallback',
        endedAt: result.metrics.endedAt,
        durationMs: result.metrics.durationMs,
        errorCode: result.errorCode,
      });
    }
    const succeeded = result.status === 'succeeded';
    this.stateStore.finishRun(runId, succeeded ? 'succeeded' : 'fallback', {
      fallbackReason: succeeded ? undefined : `${input.agentId} Agent 失败，父进程保持原有保守裁决。`,
      injectedIntoPrimary: succeeded && mode === 'assist',
    });
    return result;
  }
}

export class WorkerMemoryIntentHost extends StandaloneWorkerAdapter implements MemoryIntentHost {
  async classifyMemoryWrite(input: MemoryWriteIntentInput): Promise<MemoryWriteIntentDecision> {
    const recentMessages = (input.recentMessages || []).slice(-8).map((message, index) => ({
      evidenceId: `history:${index + 1}`,
      speaker: message.role,
      content: String(message.content || '').replace(/\s+/gu, ' ').slice(0, 500),
    }));
    const evidenceRefs = ['current-message', ...recentMessages.map((item) => item.evidenceId)];
    const result = await this.execute({
      sessionId: input.sessionId,
      turnId: `memory-intent-${crypto.randomUUID()}`,
      agentId: 'memory',
      capability: 'classify_memory_intent',
      taskInput: {
        currentText: input.text.slice(0, 4_000),
        recentMessages,
      },
      evidenceRefs,
      triggerReason: '确定性入口发现可能的记忆写入意图。',
    });
    const output = result.output || {};
    const action = output.action === 'write' || output.action === 'clarify' ? output.action : 'ignore';
    const scope = ['temporary', 'user', 'group', 'long_term'].includes(String(output.scope))
      ? output.scope as MemoryWriteIntentDecision['scope']
      : undefined;
    return {
      action,
      scope,
      confidence: typeof output.confidence === 'number' ? Math.max(0, Math.min(1, output.confidence)) : 0,
      reason: typeof output.reason === 'string' ? output.reason.slice(0, 500) : result.errorCode,
      candidates: Array.isArray(output.candidates)
        ? output.candidates.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const record = item as Record<string, unknown>;
          return [{
            key: typeof record.key === 'string' ? record.key.slice(0, 200) : undefined,
            value: typeof record.value === 'string' ? record.value.slice(0, 2_000) : undefined,
            text: typeof record.text === 'string' ? record.text.slice(0, 2_000) : '',
            confidence: typeof record.confidence === 'number' ? record.confidence : undefined,
            source: 'model' as const,
          }];
        })
        : [],
      clarification: typeof output.clarification === 'string' ? output.clarification.slice(0, 500) : undefined,
    };
  }
}

export class WorkerTurnReferenceResolverHost extends StandaloneWorkerAdapter implements TurnReferenceResolverHost {
  async resolveTurnFocus(input: TurnReferenceResolutionInput) {
    const envelope = createTurnReferenceResolverSnapshot(input.envelope);
    const evidenceRefs = envelope.evidence.map((item) => item.id);
    const result = await this.execute({
      sessionId: input.sessionId,
      turnId: `context-${crypto.randomUUID()}`,
      agentId: 'context',
      capability: 'resolve_context',
      taskInput: {
        currentText: input.currentText.slice(0, 2_000),
        deterministicDecision: input.deterministicDecision,
        evidence: envelope.evidence.map((item) => ({
          id: item.id,
          kind: item.kind,
          relation: item.relation,
          source: item.source,
          confidence: item.confidence,
          content: item.content,
        })),
      },
      evidenceRefs,
      triggerReason: input.deterministicDecision.reason,
      abortSignal: input.abortSignal,
    });
    return result.output || {};
  }
}
