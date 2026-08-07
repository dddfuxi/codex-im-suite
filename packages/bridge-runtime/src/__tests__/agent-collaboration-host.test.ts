import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type {
  AgentCardProgressSnapshot,
  AgentCollaborationPanelState,
  AgentCollaborationRun,
  AgentTaskRequest,
  AgentTaskResult,
} from '@codex-im-suite/contracts';
import type { AgentCollaborationTurnInput } from 'claude-to-im/host';

import { RuntimeAgentCollaborationHost } from '../agent-workers/collaboration-host.js';
import { loadAgentManifestRegistry } from '../agent-workers/manifest-registry.js';
import { AgentCollaborationStateStore } from '../agent-workers/state-store.js';
import type { AgentWorkerSupervisor } from '../agent-workers/supervisor.js';
import type { Config } from '../config.js';

const manifestDir = path.resolve(process.cwd(), '..', '..', 'config', 'agents.d');

function turnInput(): AgentCollaborationTurnInput {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    currentText: '先分析当前上下文冲突，然后比较记忆证据，并且给出一个跨职责的结构化方案与性能风险。',
    hasAttachments: false,
    memoryIntentCandidate: false,
    envelope: {
      protocol: 'cti-turn-context/v1',
      channelType: 'feishu',
      chatId: 'redacted-chat',
      messageId: 'turn-1',
      currentText: '复杂请求',
      evidence: [
        { id: 'current-message', kind: 'message', relation: 'current', source: 'platform_event', confidence: 1, content: '复杂请求' },
        { id: 'history:1', kind: 'history', relation: 'retrieved', source: 'local_history', confidence: 0.8, content: '历史证据' },
      ],
    },
    focus: {
      protocol: 'cti-turn-focus/v1',
      mode: 'deterministic',
      focus: 'current_request',
      primaryEvidenceIds: ['current-message'],
      supportingEvidenceIds: ['history:1'],
      conflictingEvidenceIds: [],
      confidence: 1,
      requiresAgentResolution: false,
      reason: 'test',
    },
  };
}

function result(request: AgentTaskRequest, output: Record<string, unknown>, status: AgentTaskResult['status'] = 'succeeded'): AgentTaskResult {
  return {
    protocol: 'codex-im-suite/agent-worker/v1',
    runId: request.runId,
    turnId: request.turnId,
    taskId: request.taskId,
    agentId: request.agentId,
    capability: request.capability,
    status,
    findings: Array.isArray(output.findings) ? output.findings as string[] : [],
    evidenceRefs: request.evidenceRefs,
    promptSections: Array.isArray(output.promptSections) ? output.promptSections as AgentTaskResult['promptSections'] : [],
    output,
    metrics: {
      startedAt: '2026-07-24T00:00:00.000Z',
      endedAt: '2026-07-24T00:00:00.010Z',
      durationMs: 10,
      totalTokens: 12,
    },
    errorCode: status === 'succeeded' ? undefined : 'fake_failure',
  };
}

function makeHarness(mode: 'shadow' | 'assist', handler: (request: AgentTaskRequest) => AgentTaskResult) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-collaboration-host-test-'));
  const registry = loadAgentManifestRegistry(manifestDir);
  const state = new AgentCollaborationStateStore(path.join(tempDir, 'state.json'), mode, registry.manifests);
  const supervisor = {
    executeTask: async (request: AgentTaskRequest) => handler(request),
  } as unknown as AgentWorkerSupervisor;
  const config: Config = {
    runtime: 'codex',
    enabledChannels: [],
    defaultWorkDir: tempDir,
    defaultMode: 'plan',
    agentCollaborationMode: mode,
    agentMaxSpecialists: 2,
    agentTaskTimeoutMs: 30000,
    agentTurnBudgetMs: 35000,
    agentPerformanceBatchSize: 500,
    agentPerformanceIntervalMs: 86400000,
  };
  return {
    tempDir,
    state,
    host: new RuntimeAgentCollaborationHost(config, registry, supervisor, state),
  };
}

describe('runtime agent collaboration host', () => {
  it('recovers persisted running snapshots after a bridge restart without fake long durations', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-collaboration-recovery-test-'));
    const statusPath = path.join(tempDir, 'agent-collaboration.json');
    const startedAt = '2026-07-30T09:18:21.590Z';
    const run: AgentCollaborationRun = {
      runId: 'orphaned-run',
      sessionId: 'session-orphaned',
      turnId: 'turn-orphaned',
      mode: 'shadow',
      status: 'running',
      triggerReason: '主链足够',
      injectedIntoPrimary: false,
      startedAt,
      nodes: [
        { id: 'bridge', kind: 'bridge', label: 'Bridge', status: 'succeeded', startedAt, endedAt: startedAt, durationMs: 0 },
        { id: 'primary', kind: 'primary_agent', label: 'Primary', status: 'running', startedAt },
        { id: 'policy', kind: 'policy_verifier', label: 'Policy', status: 'pending' },
        { id: 'delivery', kind: 'delivery', label: 'Delivery', status: 'pending' },
      ],
      edges: [
        { from: 'bridge', to: 'primary', kind: 'control', status: 'active' },
        { from: 'primary', to: 'policy', kind: 'control', status: 'pending' },
      ],
    };
    const persisted: AgentCollaborationPanelState = {
      protocol: 'codex-im-suite/agent-collaboration/v1',
      updatedAt: startedAt,
      mode: 'shadow',
      poolHealth: 'degraded',
      activeTaskCount: 0,
      workers: [],
      agents: [],
      currentRun: run,
      recentRuns: [run],
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
    fs.writeFileSync(statusPath, JSON.stringify(persisted), 'utf8');
    const staleTemp = `${statusPath}.1234.00000000-0000-4000-8000-000000000000.tmp`;
    fs.writeFileSync(staleTemp, '{}', 'utf8');
    const staleTime = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(staleTemp, staleTime, staleTime);

    try {
      const registry = loadAgentManifestRegistry(manifestDir);
      const state = new AgentCollaborationStateStore(statusPath, 'shadow', registry.manifests).snapshot();
      const recovered = state.recentRuns.find((item) => item.runId === run.runId)!;
      assert.equal(state.currentRun, undefined);
      assert.equal(recovered.status, 'fallback');
      assert.ok(recovered.endedAt);
      assert.equal(recovered.durationMs, undefined);
      assert.equal(recovered.nodes.find((node) => node.id === 'primary')?.status, 'fallback');
      assert.equal(recovered.nodes.find((node) => node.id === 'primary')?.durationMs, 0);
      assert.equal(recovered.nodes.find((node) => node.id === 'primary')?.errorCode, 'bridge_restart_recovered');
      assert.equal(recovered.nodes.find((node) => node.id === 'policy')?.status, 'skipped');
      assert.equal(recovered.edges[0]?.status, 'fallback');
      assert.equal(fs.existsSync(staleTemp), false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps active runs out of the frozen performance denominator', async () => {
    const harness = makeHarness('assist', (request) => result(request, {
      shouldCollaborate: false,
      reason: '主链足够',
      tasks: [],
    }));
    try {
      const prepared = await harness.host.prepareTurn(turnInput());
      assert.equal(harness.state.snapshot().metrics.windowRunCount, 0);
      harness.host.completeTurn({ runId: prepared.runId!, status: 'succeeded', answerSummary: '完成' });
      assert.equal(harness.state.snapshot().metrics.windowRunCount, 1);
    } finally {
      fs.rmSync(harness.tempDir, { recursive: true, force: true });
    }
  });

  it('records a frozen metrics evidence watermark and does not reanalyze without enough new runs', async () => {
    let performanceCalls = 0;
    const harness = makeHarness('assist', (request) => {
      if (request.agentId === 'performance') {
        performanceCalls += 1;
        assert.equal((request.input.evidence as { id?: string }).id, 'metrics:window');
        assert.equal((request.input.metrics as { windowRunCount?: number }).windowRunCount, 1);
        return result(request, { summary: '稳定', metricBasis: ['窗口运行数：1'] });
      }
      return result(request, { shouldCollaborate: false, reason: '主链足够', tasks: [] });
    });
    try {
      const first = await harness.host.prepareTurn(turnInput());
      harness.host.completeTurn({ runId: first.runId!, status: 'succeeded', answerSummary: '完成' });
      for (let attempt = 0; attempt < 20 && !harness.state.snapshot().latestPerformanceSuggestion; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(performanceCalls, 1);
      const firstSnapshot = harness.state.snapshot();
      assert.deepEqual(firstSnapshot.latestPerformanceSuggestion?.evidenceRefs, ['metrics:window']);
      assert.equal(firstSnapshot.latestPerformanceSuggestion?.evidenceWindow.runCount, 1);
      assert.equal(firstSnapshot.latestPerformanceSuggestion?.evidenceWindow.analyzedThroughRunId, first.runId);
      assert.ok(firstSnapshot.latestPerformanceSuggestion?.evidenceWindow.snapshotUpdatedAt);

      const second = await harness.host.prepareTurn({ ...turnInput(), turnId: 'turn-2' });
      harness.host.completeTurn({ runId: second.runId!, status: 'succeeded', answerSummary: '完成' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(performanceCalls, 1);
      assert.equal(harness.state.snapshot().metrics.windowRunCount, 2);
    } finally {
      fs.rmSync(harness.tempDir, { recursive: true, force: true });
    }
  });

  it('runs two specialists in parallel and injects only in assist mode', async () => {
    const progress: AgentCardProgressSnapshot[] = [];
    const harness = makeHarness('assist', (request) => {
      if (request.agentId === 'coordinator') return result(request, {
        shouldCollaborate: true,
        reason: '需要上下文和记忆协作',
        tasks: [
          { taskId: 'context-1', agentId: 'context', capability: 'rank_context', objective: '整理上下文', evidenceRefs: ['current-message', 'history:1'] },
          { taskId: 'memory-1', agentId: 'memory', capability: 'rank_memory', objective: '整理记忆', evidenceRefs: ['history:1'] },
        ],
      });
      return result(request, {
        findings: [`${request.agentId} 结论`],
        evidenceRefs: request.evidenceRefs,
        promptSections: [{ id: `section.${request.agentId}`, title: '结论', content: `${request.agentId} 辅助内容`, priority: 25 }],
      });
    });
    try {
      const prepared = await harness.host.prepareTurn({
        ...turnInput(),
        onProgress: (snapshot) => progress.push(snapshot),
      });
      assert.equal(prepared.status, 'assisted');
      assert.equal(prepared.promptSections.length, 2);
      assert.ok(prepared.runId);
      harness.host.markPrimaryStarted(prepared.runId!);
      harness.host.markPrimaryCompleted({ runId: prepared.runId!, status: 'succeeded', answerSummary: '完成' });
      harness.host.completeTurn({ runId: prepared.runId!, status: 'succeeded', answerSummary: '完成' });
      const run = harness.state.snapshot().recentRuns.at(-1)!;
      assert.equal(run.nodes.filter((node) => node.kind === 'specialist').length, 2);
      assert.equal(run.status, 'succeeded');
      assert.equal(run.injectedIntoPrimary, true);
      assert.equal(progress[0]?.agents[0]?.status, 'running');
      assert.ok(progress.some((snapshot) => snapshot.agents.some((agent) => agent.agentId === 'context' && agent.status === 'succeeded')));
      assert.ok(progress.some((snapshot) => snapshot.agents.some((agent) => agent.kind === 'primary_agent' && agent.status === 'succeeded')));
      const cardJson = JSON.stringify(progress);
      assert.doesNotMatch(cardJson, /辅助内容|当前消息|历史证据|promptSections|evidenceRefs/u);
    } finally {
      fs.rmSync(harness.tempDir, { recursive: true, force: true });
    }
  });

  it('keeps validated results out of the prompt in shadow mode', async () => {
    const harness = makeHarness('shadow', (request) => request.agentId === 'coordinator'
      ? result(request, { shouldCollaborate: true, reason: 'shadow', tasks: [{ taskId: 'context-1', agentId: 'context', capability: 'rank_context', objective: 'test', evidenceRefs: ['current-message'] }] })
      : result(request, { findings: ['只观察'], evidenceRefs: ['current-message'], promptSections: [{ id: 'x', title: 'x', content: '不应注入', priority: 25 }] }));
    try {
      const prepared = await harness.host.prepareTurn(turnInput());
      assert.equal(prepared.status, 'shadowed');
      assert.deepEqual(prepared.promptSections, []);
    } finally {
      fs.rmSync(harness.tempDir, { recursive: true, force: true });
    }
  });

  it('falls back when coordinator or every specialist fails', async () => {
    const harness = makeHarness('assist', (request) => request.agentId === 'coordinator'
      ? result(request, { shouldCollaborate: true, reason: 'test', tasks: [{ taskId: 'memory-1', agentId: 'memory', capability: 'rank_memory', objective: 'test', evidenceRefs: ['history:1'] }] })
      : result(request, {}, 'failed'));
    try {
      const prepared = await harness.host.prepareTurn(turnInput());
      assert.equal(prepared.status, 'fallback');
      assert.deepEqual(prepared.promptSections, []);
      assert.equal(harness.state.snapshot().currentRun?.status, 'fallback');
    } finally {
      fs.rmSync(harness.tempDir, { recursive: true, force: true });
    }
  });

  it('records coordinator skip without calling a specialist', async () => {
    let calls = 0;
    const harness = makeHarness('assist', (request) => {
      calls += 1;
      return result(request, { shouldCollaborate: false, reason: '主链足够', tasks: [] });
    });
    try {
      const prepared = await harness.host.prepareTurn(turnInput());
      assert.equal(prepared.status, 'skipped');
      assert.equal(calls, 1);
    } finally {
      fs.rmSync(harness.tempDir, { recursive: true, force: true });
    }
  });
});
