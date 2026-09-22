import fs from 'node:fs';

import type {
  AgentCollaborationMode,
  AgentCollaborationPanelState,
  AgentCollaborationRun,
  AgentCollaborationWorkflowNode,
  AgentPerformanceSuggestion,
  AgentTaskResult,
  AgentWorkerView,
  CollaborationAgentManifest,
} from '@codex-im-suite/contracts';

import { cleanupStaleAtomicWriteTemps, writeUtf8TextAtomic } from '../atomic-text-file.js';

const MAX_RUNS = 80;
const RESTART_RECOVERY_CODE = 'bridge_restart_recovered';
const RESTART_RECOVERY_REASON = 'Bridge 启动时发现上次进程未收口，已结束旧观察记录；未自动重放任务。';

function nowIso(): string {
  return new Date().toISOString();
}

function percentile95(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function agentDurations(runs: AgentCollaborationRun[], agentId: string): number[] {
  return runs.flatMap((run) => run.nodes
    .filter((node) => node.agentId === agentId && typeof node.durationMs === 'number')
    .map((node) => node.durationMs as number));
}

export function buildAgentCollaborationMetrics(
  runs: AgentCollaborationRun[],
  workers: AgentWorkerView[],
): AgentCollaborationPanelState['metrics'] {
  // Performance 指标只消费已经结束的回合，避免 currentRun 同时存在于
  // recentRuns 时造成实时窗口、建议正文和 evidenceWindow 分母不一致。
  const completedRuns = runs.filter((run) => Boolean(run.endedAt));
  const triggeredRuns = completedRuns.filter((run) => run.nodes.some((node) => node.kind === 'coordinator' && node.status !== 'skipped'));
  const fallbackRuns = completedRuns.filter((run) => run.status === 'fallback');
  const specialistCallDistribution: Record<string, number> = {};
  for (const node of completedRuns.flatMap((run) => run.nodes.filter((item) => item.kind === 'specialist' && item.agentId))) {
    specialistCallDistribution[node.agentId!] = (specialistCallDistribution[node.agentId!] || 0) + 1;
  }
  return {
    windowRunCount: completedRuns.length,
    coordinatorTriggerRate: completedRuns.length > 0 ? triggeredRuns.length / completedRuns.length : 0,
    fallbackRate: completedRuns.length > 0 ? fallbackRuns.length / completedRuns.length : 0,
    workerRestartCount: workers.reduce((sum, worker) => sum + worker.restartCount, 0),
    workerTimeoutCount: workers.reduce((sum, worker) => sum + worker.timeoutCount, 0),
    circuitOpenCount: workers.reduce((sum, worker) => sum + worker.circuitOpenCount, 0),
    specialistCallDistribution,
  };
}

function normalizePerformanceSuggestion(
  value: AgentPerformanceSuggestion | undefined,
  runs: AgentCollaborationRun[],
): AgentPerformanceSuggestion | undefined {
  if (!value || typeof value.summary !== 'string' || !value.evidenceWindow) return undefined;
  const endedAt = value.evidenceWindow.endedAt;
  const analyzedThroughRunId = value.evidenceWindow.analyzedThroughRunId
    || [...runs].reverse().find((run) => run.endedAt && (!endedAt || run.endedAt <= endedAt))?.runId;
  return {
    ...value,
    evidenceRefs: Array.isArray(value.evidenceRefs) && value.evidenceRefs.length > 0
      ? [...new Set(value.evidenceRefs)]
      : ['metrics:window'],
    evidenceWindow: {
      ...value.evidenceWindow,
      analyzedThroughRunId,
      snapshotUpdatedAt: value.evidenceWindow.snapshotUpdatedAt || value.generatedAt,
    },
  };
}

function recoverInterruptedRun(run: AgentCollaborationRun, recoveredAt: string): AgentCollaborationRun {
  const needsRecovery = !run.endedAt && (
    run.status === 'running'
    || run.nodes.some((node) => node.status === 'running' || node.status === 'pending')
  );
  if (!needsRecovery) return run;
  return {
    ...run,
    status: 'fallback',
    fallbackReason: RESTART_RECOVERY_REASON,
    endedAt: recoveredAt,
    // 进程退出前没有可靠结束时间，禁止用“恢复时间 - 开始时间”伪造耗时。
    durationMs: undefined,
    nodes: run.nodes.map((node) => {
      if (node.status === 'running') {
        const endedAt = node.startedAt || recoveredAt;
        return {
          ...node,
          status: 'fallback',
          endedAt,
          durationMs: node.startedAt ? 0 : undefined,
          fallbackReason: RESTART_RECOVERY_REASON,
          errorCode: RESTART_RECOVERY_CODE,
          summary: node.summary || '上次进程结束前未写入终态，已在本次启动时收口。',
        };
      }
      if (node.status === 'pending') {
        return {
          ...node,
          status: 'skipped',
          fallbackReason: RESTART_RECOVERY_REASON,
          errorCode: RESTART_RECOVERY_CODE,
        };
      }
      return node;
    }),
    edges: run.edges.map((edge) => edge.status === 'pending' || edge.status === 'active'
      ? { ...edge, status: 'fallback' }
      : edge),
  };
}

export class AgentCollaborationStateStore {
  private state: AgentCollaborationPanelState;

  constructor(
    private readonly statusPath: string,
    mode: AgentCollaborationMode,
    private readonly manifests: CollaborationAgentManifest[],
  ) {
    this.state = this.read(mode);
    this.recoverPersistedRuns();
    cleanupStaleAtomicWriteTemps(this.statusPath);
    this.persist();
  }

  snapshot(): AgentCollaborationPanelState {
    return structuredClone(this.state);
  }

  setWorkers(workers: AgentWorkerView[]): void {
    this.state.workers = workers.map((worker) => ({ ...worker }));
    this.refreshDerived();
    this.persist();
  }

  startRun(run: AgentCollaborationRun): void {
    this.state.currentRun = structuredClone(run);
    this.upsertRecentRun(run);
    this.refreshDerived();
    this.persist();
  }

  updateRun(runId: string, mutate: (run: AgentCollaborationRun) => AgentCollaborationRun): AgentCollaborationRun | null {
    const existing = this.findRun(runId);
    if (!existing) return null;
    const next = mutate(structuredClone(existing));
    if (this.state.currentRun?.runId === runId) this.state.currentRun = structuredClone(next);
    this.upsertRecentRun(next);
    this.refreshDerived();
    this.persist();
    return next;
  }

  updateNode(runId: string, nodeId: string, patch: Partial<AgentCollaborationWorkflowNode>): AgentCollaborationRun | null {
    return this.updateRun(runId, (run) => ({
      ...run,
      nodes: run.nodes.map((node) => node.id === nodeId ? { ...node, ...patch } : node),
    }));
  }

  linkWorkflowRun(runId: string, workflowRunId: string): void {
    this.updateRun(runId, (run) => ({ ...run, workflowRunId }));
  }

  recordAgentResult(runId: string, result: AgentTaskResult, workerId?: string): void {
    const endedAt = result.metrics.endedAt || nowIso();
    this.updateNode(runId, `agent:${result.taskId}`, {
      status: result.status === 'succeeded'
        ? 'succeeded'
        : result.status === 'cancelled'
          ? 'cancelled'
          : 'failed',
      endedAt,
      durationMs: result.metrics.durationMs,
      evidenceCount: result.evidenceRefs.length,
      evidenceRefs: result.evidenceRefs,
      tokenUsage: {
        inputTokens: result.metrics.inputTokens,
        outputTokens: result.metrics.outputTokens,
        totalTokens: result.metrics.totalTokens,
      },
      modelSource: result.metrics.modelSource,
      model: result.metrics.model,
      summary: result.findings.join('；').slice(0, 800) || result.errorSummary,
      errorCode: result.errorCode,
    });
    if (workerId) {
      const worker = this.state.workers.find((item) => item.workerId === workerId);
      if (worker) worker.activeTaskId = undefined;
    }
  }

  finishRun(
    runId: string,
    status: AgentCollaborationRun['status'],
    options: { fallbackReason?: string; injectedIntoPrimary?: boolean } = {},
  ): void {
    const endedAt = nowIso();
    this.updateRun(runId, (run) => ({
      ...run,
      status,
      fallbackReason: options.fallbackReason || run.fallbackReason,
      injectedIntoPrimary: options.injectedIntoPrimary ?? run.injectedIntoPrimary,
      endedAt,
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(run.startedAt)),
    }));
    if (this.state.currentRun?.runId === runId) this.state.currentRun = undefined;
    this.refreshDerived();
    this.persist();
  }

  setPerformanceSuggestion(suggestion: AgentPerformanceSuggestion): void {
    this.state.latestPerformanceSuggestion = structuredClone(suggestion);
    this.persist();
  }

  private read(mode: AgentCollaborationMode): AgentCollaborationPanelState {
    try {
      if (fs.existsSync(this.statusPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.statusPath, 'utf8')) as Partial<AgentCollaborationPanelState>;
        return {
          protocol: 'codex-im-suite/agent-collaboration/v1',
          updatedAt: parsed.updatedAt || nowIso(),
          mode,
          poolHealth: mode === 'off' ? 'disabled' : parsed.poolHealth || 'unavailable',
          activeTaskCount: parsed.activeTaskCount || 0,
          workers: Array.isArray(parsed.workers) ? parsed.workers : [],
          agents: [],
          currentRun: parsed.currentRun,
          recentRuns: Array.isArray(parsed.recentRuns) ? parsed.recentRuns.slice(-MAX_RUNS) : [],
          metrics: parsed.metrics || {
            windowRunCount: 0,
            coordinatorTriggerRate: 0,
            fallbackRate: 0,
            workerRestartCount: 0,
            workerTimeoutCount: 0,
            circuitOpenCount: 0,
            specialistCallDistribution: {},
          },
          latestPerformanceSuggestion: normalizePerformanceSuggestion(
            parsed.latestPerformanceSuggestion,
            Array.isArray(parsed.recentRuns) ? parsed.recentRuns.slice(-MAX_RUNS) : [],
          ),
        };
      }
    } catch {
      // 状态是派生观察数据；损坏时从 Manifest 和新运行事实重建。
    }
    return {
      protocol: 'codex-im-suite/agent-collaboration/v1',
      updatedAt: nowIso(),
      mode,
      poolHealth: mode === 'off' ? 'disabled' : 'unavailable',
      activeTaskCount: 0,
      workers: [],
      agents: [],
      recentRuns: [],
      metrics: {
        windowRunCount: 0,
        coordinatorTriggerRate: 0,
        fallbackRate: 0,
        workerRestartCount: 0,
        workerTimeoutCount: 0,
        circuitOpenCount: 0,
        specialistCallDistribution: {},
      },
    };
  }

  private recoverPersistedRuns(): void {
    const recoveredAt = nowIso();
    const recoveredRecentRuns = this.state.recentRuns.map((run) => recoverInterruptedRun(run, recoveredAt));
    if (this.state.currentRun) {
      const recoveredCurrent = recoverInterruptedRun(this.state.currentRun, recoveredAt);
      const existingIndex = recoveredRecentRuns.findIndex((run) => run.runId === recoveredCurrent.runId);
      if (existingIndex >= 0) recoveredRecentRuns[existingIndex] = recoveredCurrent;
      else recoveredRecentRuns.push(recoveredCurrent);
    }
    this.state.currentRun = undefined;
    this.state.recentRuns = recoveredRecentRuns.slice(-MAX_RUNS);
  }

  private findRun(runId: string): AgentCollaborationRun | undefined {
    return this.state.currentRun?.runId === runId
      ? this.state.currentRun
      : this.state.recentRuns.find((run) => run.runId === runId);
  }

  private upsertRecentRun(run: AgentCollaborationRun): void {
    const others = this.state.recentRuns.filter((item) => item.runId !== run.runId);
    this.state.recentRuns = [...others, structuredClone(run)].slice(-MAX_RUNS);
  }

  private refreshDerived(): void {
    const workers = this.state.workers;
    const onlineWorkers = workers.filter((worker) => worker.health === 'online' || worker.health === 'busy').length;
    const degradedWorkers = workers.filter((worker) => ['unresponsive', 'restarting', 'circuit_open'].includes(worker.health)).length;
    this.state.poolHealth = this.state.mode === 'off'
      ? 'disabled'
      : onlineWorkers === workers.length && workers.length > 0
        ? 'healthy'
        : onlineWorkers > 0 || degradedWorkers > 0
          ? 'degraded'
          : 'unavailable';
    this.state.activeTaskCount = workers.filter((worker) => Boolean(worker.activeTaskId)).length;

    const runs = this.state.recentRuns;
    this.state.agents = this.manifests.map((manifest) => {
      const nodes = runs.flatMap((run) => run.nodes.filter((node) => node.agentId === manifest.id));
      const durations = agentDurations(runs, manifest.id);
      const successCount = nodes.filter((node) => node.status === 'succeeded').length;
      const failureCount = nodes.filter((node) => node.status === 'failed' || node.status === 'fallback').length;
      const timeoutCount = nodes.filter((node) => node.errorCode === 'task_timed_out').length;
      const runningNode = this.state.currentRun?.nodes.find((node) => node.agentId === manifest.id && node.status === 'running');
      const lastNode = [...nodes].reverse().find((node) => node.startedAt || node.endedAt);
      return {
        manifest,
        workerId: runningNode ? workers.find((worker) => worker.activeTaskId === runningNode.id.replace(/^agent:/u, ''))?.workerId : undefined,
        health: !manifest.enabled
          ? 'disabled' as const
          : runningNode
            ? 'running' as const
            : failureCount > successCount && failureCount > 0
              ? 'degraded' as const
              : this.state.poolHealth === 'unavailable'
                ? 'unavailable' as const
                : 'idle' as const,
        lastInvokedAt: lastNode?.startedAt,
        lastDurationMs: lastNode?.durationMs,
        successCount,
        failureCount,
        timeoutCount,
        averageDurationMs: durations.length > 0 ? Math.round(durations.reduce((sum, item) => sum + item, 0) / durations.length) : undefined,
        p95DurationMs: percentile95(durations),
      };
    });

    this.state.metrics = buildAgentCollaborationMetrics(runs, workers);
    this.state.updatedAt = nowIso();
  }

  private persist(): void {
    this.refreshDerived();
    writeUtf8TextAtomic(this.statusPath, JSON.stringify(this.state, null, 2));
  }
}
