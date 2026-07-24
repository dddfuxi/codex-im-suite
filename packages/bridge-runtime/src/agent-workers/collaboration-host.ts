import crypto from 'node:crypto';

import type {
  AgentCardProgressItem,
  AgentCardProgressSnapshot,
  AgentCollaborationRun,
  AgentCollaborationWorkflowEdge,
  AgentCollaborationWorkflowNode,
  AgentPerformanceSuggestion,
  AgentPromptSection,
  AgentTaskRequest,
  AgentTaskResult,
  AgentTurnPlanTask,
} from '@codex-im-suite/contracts';
import type {
  AgentCollaborationCompletionInput,
  AgentCollaborationHost,
  AgentCollaborationTurnInput,
  AgentCollaborationTurnResult,
} from 'claude-to-im/host';
import { decideCollaborationEligibility } from 'claude-to-im/policy';

import type { Config } from '../config.js';
import type { AgentManifestRegistry } from './manifest-registry.js';
import { validateAgentTurnPlan } from './protocol.js';
import type { AgentCollaborationStateStore } from './state-store.js';
import type { AgentWorkerSupervisor } from './supervisor.js';

function nowIso(): string {
  return new Date().toISOString();
}

function duration(startedAt: string, endedAt = nowIso()): number {
  return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}

function sanitizedEvidence(input: AgentCollaborationTurnInput, evidenceIds?: readonly string[]): Array<Record<string, unknown>> {
  const allowed = evidenceIds ? new Set(evidenceIds) : null;
  return input.envelope.evidence
    .filter((item) => !allowed || allowed.has(item.id))
    .slice(0, 24)
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      relation: item.relation,
      source: item.source,
      confidence: item.confidence,
      content: item.content.slice(0, item.relation === 'current' || item.relation === 'native_reply' ? 1_600 : 700),
    }));
}

function baseNodes(input: AgentCollaborationTurnInput, coordinatorStatus: AgentCollaborationWorkflowNode['status']): AgentCollaborationWorkflowNode[] {
  const timestamp = nowIso();
  return [
    { id: 'bridge', kind: 'bridge', label: 'Bridge Gateway', status: 'succeeded', startedAt: timestamp, endedAt: timestamp, durationMs: 0, evidenceCount: input.envelope.evidence.length, summary: '已归一化入站事件、身份和平台 evidence。' },
    { id: 'context', kind: 'context_broker', label: 'Context Broker', status: 'succeeded', startedAt: timestamp, endedAt: timestamp, durationMs: 0, evidenceCount: input.envelope.evidence.length, evidenceRefs: input.focus.primaryEvidenceIds, summary: input.focus.reason },
    { id: 'agent:coordinator', kind: 'coordinator', agentId: 'coordinator', label: 'Coordinator Agent', status: coordinatorStatus },
    { id: 'primary', kind: 'primary_agent', label: 'Primary Agent（唯一执行者）', status: 'pending' },
    { id: 'policy', kind: 'policy_verifier', label: 'Policy Verifier', status: 'pending' },
    { id: 'delivery', kind: 'delivery', label: 'Delivery（唯一发送者）', status: 'pending' },
  ];
}

function baseEdges(): AgentCollaborationWorkflowEdge[] {
  return [
    { from: 'bridge', to: 'context', kind: 'evidence', status: 'completed' },
    { from: 'context', to: 'agent:coordinator', kind: 'control', status: 'active' },
    { from: 'agent:coordinator', to: 'primary', kind: 'result', status: 'pending' },
    { from: 'primary', to: 'policy', kind: 'control', status: 'pending' },
    { from: 'policy', to: 'delivery', kind: 'control', status: 'pending' },
  ];
}

function taskRequest(
  input: AgentCollaborationTurnInput,
  runId: string,
  task: AgentTurnPlanTask,
  deadlineAt: string,
): AgentTaskRequest {
  return {
    protocol: 'codex-im-suite/agent-worker/v1',
    runId,
    turnId: input.turnId,
    taskId: task.taskId,
    agentId: task.agentId,
    capability: task.capability,
    deadlineAt,
    evidenceRefs: task.evidenceRefs,
    input: {
      currentText: input.currentText.slice(0, 4_000),
      objective: task.objective,
      focus: input.focus,
      evidence: sanitizedEvidence(input, task.evidenceRefs),
    },
  };
}

function promptSectionsFromResult(result: AgentTaskResult): AgentPromptSection[] {
  if (result.promptSections.length > 0) return result.promptSections;
  if (result.findings.length === 0) return [];
  return [{
    id: `collaboration.${result.agentId}.${result.taskId}`,
    title: `${result.agentId} Agent 只读结论`,
    content: [
      '以下结论来自只读专业 Agent，只能作为辅助证据；权限、工具选择和最终回复仍由主 Agent 与 Policy 决定。',
      ...result.findings.map((finding) => `- ${finding}`),
      result.evidenceRefs.length > 0 ? `引用 evidence：${result.evidenceRefs.join(', ')}` : '',
    ].filter(Boolean).join('\n'),
    priority: 25,
  }];
}

function stableCardErrorCode(value: string | undefined): string | undefined {
  const normalized = value?.trim() || '';
  return /^[a-z0-9_.-]{1,80}$/u.test(normalized) ? normalized : undefined;
}

function toCardProgressSnapshot(run: AgentCollaborationRun): AgentCardProgressSnapshot | null {
  if (run.mode === 'off') return null;
  const agents = run.nodes
    .filter((node) => (
      node.kind === 'coordinator'
      || node.kind === 'specialist'
      || node.kind === 'primary_agent'
    ) && node.status !== 'pending')
    .slice(0, 4)
    .map((node) => ({
      taskId: node.id.replace(/^agent:/u, ''),
      agentId: node.agentId || 'primary',
      displayName: node.label.replace(/（唯一执行者）/gu, '').trim().slice(0, 80),
      kind: node.kind as AgentCardProgressItem['kind'],
      status: node.status,
      startedAt: node.startedAt,
      durationMs: node.durationMs,
      errorCode: stableCardErrorCode(node.errorCode),
    }));
  if (agents.length === 0) return null;
  return {
    runId: run.runId,
    mode: run.mode,
    status: run.status,
    injectedIntoPrimary: run.injectedIntoPrimary,
    agents,
  };
}

export class RuntimeAgentCollaborationHost implements AgentCollaborationHost {
  private performanceRunning = false;
  private lastPerformanceAt = 0;
  private readonly progressListeners = new Map<string, NonNullable<AgentCollaborationTurnInput['onProgress']>>();

  constructor(
    private readonly config: Config,
    private readonly registry: AgentManifestRegistry,
    private readonly supervisor: AgentWorkerSupervisor,
    private readonly stateStore: AgentCollaborationStateStore,
  ) {}

  async prepareTurn(input: AgentCollaborationTurnInput): Promise<AgentCollaborationTurnResult> {
    const mode = this.config.agentCollaborationMode || 'off';
    if (mode === 'off') return { mode, status: 'skipped', triggerReason: '协作模式关闭', promptSections: [] };
    const eligibility = decideCollaborationEligibility({
      mode,
      text: input.currentText,
      evidenceCount: input.envelope.evidence.length,
      focus: input.focus,
      hasAttachments: input.hasAttachments,
      memoryIntentCandidate: input.memoryIntentCandidate,
    });
    const runId = crypto.randomUUID();
    const startedAt = nowIso();
    const run: AgentCollaborationRun = {
      runId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      mode,
      status: 'running',
      triggerReason: eligibility.reason,
      injectedIntoPrimary: false,
      startedAt,
      nodes: baseNodes(input, eligibility.eligible ? 'running' : 'skipped'),
      edges: baseEdges(),
    };
    if (!eligibility.eligible) {
      run.edges = run.edges.map((edge) => edge.from === 'context' && edge.to === 'agent:coordinator'
        ? { ...edge, status: 'completed' }
        : edge.from === 'agent:coordinator' && edge.to === 'primary'
          ? { ...edge, kind: 'fallback', status: 'fallback' }
          : edge);
      this.stateStore.startRun(run);
      return { mode, runId, status: 'skipped', triggerReason: eligibility.reason, promptSections: [] };
    }

    this.stateStore.startRun(run);
    if (input.onProgress) this.progressListeners.set(runId, input.onProgress);
    this.emitProgress(runId);
    const deadlineAt = new Date(Date.now() + (this.config.agentTurnBudgetMs || 35_000)).toISOString();
    const evidenceIds = new Set(input.envelope.evidence.map((item) => item.id));
    const coordinatorRequest: AgentTaskRequest = {
      protocol: 'codex-im-suite/agent-worker/v1',
      runId,
      turnId: input.turnId,
      taskId: 'coordinator',
      agentId: 'coordinator',
      capability: 'plan_turn',
      deadlineAt,
      evidenceRefs: [...evidenceIds],
      input: {
        currentText: input.currentText.slice(0, 4_000),
        focus: input.focus,
        evidence: sanitizedEvidence(input),
        registry: this.registry.manifests
          .filter((manifest) => manifest.enabled)
          .map((manifest) => ({
            id: manifest.id,
            displayName: manifest.displayName,
            responsibilities: manifest.responsibilities,
            capabilities: manifest.capabilities,
            excludes: manifest.excludes,
          })),
        maxSpecialists: this.config.agentMaxSpecialists || 2,
      },
    };
    const coordinatorResult = await this.supervisor.executeTask(coordinatorRequest, evidenceIds, input.abortSignal);
    this.stateStore.recordAgentResult(runId, coordinatorResult);
    const plan = coordinatorResult.status === 'succeeded'
      ? validateAgentTurnPlan(coordinatorResult.output, this.registry, evidenceIds, this.config.agentMaxSpecialists || 2)
      : null;
    if (!plan) {
      this.markCoordinatorFallback(runId, coordinatorResult.errorCode || 'invalid_coordinator_plan');
      this.emitProgress(runId);
      return { mode, runId, status: 'fallback', triggerReason: eligibility.reason, promptSections: [] };
    }
    this.stateStore.updateNode(runId, 'agent:coordinator', {
      status: 'succeeded',
      summary: plan.reason,
      endedAt: coordinatorResult.metrics.endedAt,
      durationMs: coordinatorResult.metrics.durationMs,
    });
    this.emitProgress(runId);
    if (!plan.shouldCollaborate || plan.tasks.length === 0) {
      this.stateStore.updateRun(runId, (current) => ({
        ...current,
        edges: current.edges.map((edge) => edge.from === 'agent:coordinator' && edge.to === 'primary'
          ? { ...edge, status: 'completed' }
          : edge),
      }));
      this.emitProgress(runId);
      return { mode, runId, status: 'skipped', triggerReason: plan.reason || eligibility.reason, promptSections: [] };
    }

    this.addSpecialistNodes(runId, plan.tasks);
    this.emitProgress(runId);
    const results = await Promise.all(plan.tasks.map(async (task) => {
      const result = await this.supervisor.executeTask(taskRequest(input, runId, task, deadlineAt), evidenceIds, input.abortSignal);
      this.stateStore.recordAgentResult(runId, result);
      this.emitProgress(runId);
      return result;
    }));
    const succeeded = results.filter((result) => result.status === 'succeeded');
    if (succeeded.length === 0) {
      this.stateStore.updateRun(runId, (current) => ({
        ...current,
        status: 'fallback',
        fallbackReason: '专业 Agent 全部失败，已继续现有单 Agent 链路。',
        edges: current.edges.map((edge) => edge.to === 'primary' ? { ...edge, kind: 'fallback', status: 'fallback' } : edge),
      }));
      this.emitProgress(runId);
      return { mode, runId, status: 'fallback', triggerReason: plan.reason, promptSections: [] };
    }
    this.stateStore.updateRun(runId, (current) => ({
      ...current,
      edges: current.edges.map((edge) => edge.to === 'primary' ? { ...edge, status: 'completed' } : edge),
    }));
    const promptSections = mode === 'assist' ? succeeded.flatMap(promptSectionsFromResult).slice(0, 4) : [];
    return {
      mode,
      runId,
      status: mode === 'assist' ? 'assisted' : 'shadowed',
      triggerReason: plan.reason,
      promptSections,
    };
  }

  markPrimaryStarted(runId: string): void {
    this.stateStore.updateNode(runId, 'primary', { status: 'running', startedAt: nowIso() });
    this.stateStore.updateRun(runId, (run) => ({
      ...run,
      injectedIntoPrimary: run.mode === 'assist'
        && run.nodes.some((node) => node.kind === 'specialist' && node.status === 'succeeded'),
    }));
    this.emitProgress(runId);
  }

  markPrimaryCompleted(input: AgentCollaborationCompletionInput): void {
    const run = this.findRun(input.runId);
    if (!run) return;
    const endedAt = nowIso();
    const primary = run.nodes.find((node) => node.id === 'primary');
    const succeeded = input.status === 'succeeded';
    this.stateStore.updateNode(input.runId, 'primary', {
      status: succeeded ? 'succeeded' : input.status === 'cancelled' ? 'cancelled' : 'fallback',
      endedAt,
      durationMs: primary?.startedAt ? duration(primary.startedAt, endedAt) : undefined,
      tokenUsage: input.tokenUsage,
      summary: input.answerSummary?.replace(/\s+/gu, ' ').trim().slice(0, 600),
      errorCode: input.errorCode,
    });
    this.emitProgress(input.runId);
  }

  completeTurn(input: AgentCollaborationCompletionInput): void {
    this.markPrimaryCompleted(input);
    const run = this.findRun(input.runId);
    if (!run) return;
    const endedAt = nowIso();
    const succeeded = input.status === 'succeeded';
    this.stateStore.updateNode(input.runId, 'policy', {
      status: succeeded ? 'succeeded' : 'fallback',
      startedAt: endedAt,
      endedAt,
      durationMs: 0,
      summary: succeeded ? '现有 Policy 与 Answer Review 已完成验证。' : '主链失败，Policy 保持失败关闭。',
    });
    this.stateStore.updateNode(input.runId, 'delivery', {
      status: succeeded ? 'succeeded' : input.status === 'cancelled' ? 'cancelled' : 'fallback',
      startedAt: endedAt,
      endedAt,
      durationMs: 0,
      summary: succeeded ? 'Bridge 已通过现有 Delivery Layer 完成交付。' : '未把内部 Worker 异常作为用户回复发送。',
    });
    const fallback = run.status === 'fallback' || !succeeded;
    this.stateStore.finishRun(input.runId, fallback ? 'fallback' : 'succeeded', {
      fallbackReason: fallback ? run.fallbackReason || input.errorCode || '主链以 fallback 收口' : undefined,
      injectedIntoPrimary: run.mode === 'assist' && run.nodes.some((node) => node.kind === 'specialist' && node.status === 'succeeded'),
    });
    this.emitProgress(input.runId);
    this.progressListeners.delete(input.runId);
    void this.maybeAnalyzePerformance();
  }

  linkWorkflowRun(runId: string, workflowRunId: string): void {
    this.stateStore.linkWorkflowRun(runId, workflowRunId);
  }

  private addSpecialistNodes(runId: string, tasks: AgentTurnPlanTask[]): void {
    this.stateStore.updateRun(runId, (run) => {
      const nodes = [...run.nodes];
      const edges = run.edges.filter((edge) => !(edge.from === 'agent:coordinator' && edge.to === 'primary'));
      for (const task of tasks) {
        nodes.splice(Math.max(0, nodes.findIndex((node) => node.id === 'primary')), 0, {
          id: `agent:${task.taskId}`,
          kind: 'specialist',
          agentId: task.agentId,
          label: this.registry.byId.get(task.agentId)?.displayName || task.agentId,
          status: 'running',
          startedAt: nowIso(),
          evidenceCount: task.evidenceRefs.length,
          evidenceRefs: task.evidenceRefs,
          triggerReason: task.objective,
        });
        edges.push({ from: 'agent:coordinator', to: `agent:${task.taskId}`, kind: 'control', status: 'active' });
        edges.push({ from: `agent:${task.taskId}`, to: 'primary', kind: 'result', status: 'pending' });
      }
      return { ...run, nodes, edges };
    });
  }

  private markCoordinatorFallback(runId: string, errorCode: string): void {
    this.stateStore.updateNode(runId, 'agent:coordinator', {
      status: 'fallback',
      endedAt: nowIso(),
      errorCode,
      fallbackReason: 'Coordinator 失败或返回无效计划，继续现有单 Agent 链路。',
    });
    this.stateStore.updateRun(runId, (run) => ({
      ...run,
      status: 'fallback',
      fallbackReason: 'Coordinator 失败或返回无效计划，继续现有单 Agent 链路。',
      edges: run.edges.map((edge) => edge.from === 'agent:coordinator' && edge.to === 'primary'
        ? { ...edge, kind: 'fallback', status: 'fallback' }
        : edge),
    }));
  }

  private findRun(runId: string): AgentCollaborationRun | undefined {
    const snapshot = this.stateStore.snapshot();
    return snapshot.currentRun?.runId === runId
      ? snapshot.currentRun
      : snapshot.recentRuns.find((item) => item.runId === runId);
  }

  private emitProgress(runId: string): void {
    const listener = this.progressListeners.get(runId);
    if (!listener) return;
    const run = this.findRun(runId);
    if (!run) return;
    const snapshot = toCardProgressSnapshot(run);
    if (!snapshot) return;
    try {
      listener(snapshot);
    } catch {
      // 卡片观察链失败不能影响只读协作或主 Agent 执行。
    }
  }

  private async maybeAnalyzePerformance(): Promise<void> {
    if (this.performanceRunning || !this.registry.byId.get('performance')?.enabled) return;
    const snapshot = this.stateStore.snapshot();
    const completedRuns = snapshot.recentRuns.filter((run) => run.endedAt);
    const intervalDue = Date.now() - this.lastPerformanceAt >= (this.config.agentPerformanceIntervalMs || 1_800_000);
    const batchDue = completedRuns.length >= (this.config.agentPerformanceBatchSize || 20);
    if (!intervalDue && !batchDue) return;
    this.performanceRunning = true;
    this.lastPerformanceAt = Date.now();
    const runId = `performance-${crypto.randomUUID()}`;
    const request: AgentTaskRequest = {
      protocol: 'codex-im-suite/agent-worker/v1',
      runId,
      turnId: runId,
      taskId: 'performance',
      agentId: 'performance',
      capability: 'analyze_performance',
      deadlineAt: new Date(Date.now() + (this.config.agentTaskTimeoutMs || 30_000)).toISOString(),
      evidenceRefs: ['metrics:window'],
      input: {
        metrics: snapshot.metrics,
        agentStats: snapshot.agents.map((agent) => ({
          agentId: agent.manifest.id,
          successCount: agent.successCount,
          failureCount: agent.failureCount,
          timeoutCount: agent.timeoutCount,
          averageDurationMs: agent.averageDurationMs,
          p95DurationMs: agent.p95DurationMs,
        })),
      },
    };
    try {
      const result = await this.supervisor.executeTask(request, new Set(['metrics:window']));
      const output = result.output || {};
      if (result.status === 'succeeded' && typeof output.summary === 'string') {
        const suggestion: AgentPerformanceSuggestion = {
          id: crypto.randomUUID(),
          generatedAt: nowIso(),
          summary: output.summary.slice(0, 2_000),
          evidenceWindow: {
            runCount: completedRuns.length,
            startedAt: completedRuns[0]?.startedAt,
            endedAt: completedRuns.at(-1)?.endedAt,
          },
          metricBasis: Array.isArray(output.metricBasis)
            ? output.metricBasis.filter((item): item is string => typeof item === 'string').slice(0, 12)
            : [],
        };
        this.stateStore.setPerformanceSuggestion(suggestion);
      }
    } finally {
      this.performanceRunning = false;
    }
  }
}
