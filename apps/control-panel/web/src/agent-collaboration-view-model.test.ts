import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  AgentCollaborationPanelState,
  AgentCollaborationRun,
  AgentResponsibilityView,
} from '@codex-im-suite/contracts/agent-collaboration';
import {
  agentSuccessRate,
  buildAgentWorkflowLayout,
  createEmptyAgentCollaborationState,
  findAgentRunByWorkflowRunId,
  getAgentCollaborationQuickControl,
  orderAgentResponsibilities,
  orderWorkflowTimeline,
  redactAgentDisplayText,
  selectAgentCollaborationRun,
  summarizeEvidenceRefs,
} from './agent-collaboration-view-model.js';

function run(overrides: Partial<AgentCollaborationRun> = {}): AgentCollaborationRun {
  return {
    runId: 'run-1',
    workflowRunId: 'workflow-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    mode: 'assist',
    status: 'succeeded',
    triggerReason: '复杂请求',
    injectedIntoPrimary: true,
    startedAt: '2026-07-24T00:00:00.000Z',
    endedAt: '2026-07-24T00:00:02.000Z',
    durationMs: 2000,
    nodes: [
      { id: 'bridge', kind: 'bridge', label: 'Bridge', status: 'succeeded' },
      { id: 'coordinator', kind: 'coordinator', label: '协调', status: 'succeeded' },
      { id: 'context', kind: 'specialist', agentId: 'context', label: '上下文', status: 'succeeded' },
      { id: 'memory', kind: 'specialist', agentId: 'memory', label: '记忆', status: 'fallback' },
      { id: 'primary', kind: 'primary_agent', label: '主 Agent', status: 'succeeded' },
    ],
    edges: [
      { from: 'bridge', to: 'coordinator', kind: 'control', status: 'completed' },
      { from: 'coordinator', to: 'context', kind: 'control', status: 'completed' },
      { from: 'coordinator', to: 'memory', kind: 'control', status: 'fallback' },
      { from: 'context', to: 'primary', kind: 'result', status: 'completed' },
      { from: 'memory', to: 'primary', kind: 'fallback', status: 'fallback' },
    ],
    ...overrides,
  };
}

function state(runs: AgentCollaborationRun[]): AgentCollaborationPanelState {
  return {
    ...createEmptyAgentCollaborationState(),
    mode: 'assist',
    poolHealth: 'healthy',
    currentRun: runs.find((item) => item.status === 'running'),
    recentRuns: runs,
  };
}

describe('agent collaboration view model', () => {
  it('uses Shadow as the safe quick-enable mode and Off as the quick-disable target', () => {
    assert.deepEqual(getAgentCollaborationQuickControl('off'), { label: '开启', targetMode: 'shadow' });
    assert.deepEqual(getAgentCollaborationQuickControl('shadow'), { label: '关闭', targetMode: 'off' });
    assert.deepEqual(getAgentCollaborationQuickControl('assist'), { label: '关闭', targetMode: 'off' });
  });

  it('selects a workflow-linked run before the latest fallback', () => {
    const latest = run({ runId: 'latest', workflowRunId: 'workflow-latest', startedAt: '2026-07-24T01:00:00.000Z' });
    const linked = run({ runId: 'linked', workflowRunId: 'workflow-target' });
    assert.equal(selectAgentCollaborationRun(state([latest, linked]), undefined, 'workflow-target')?.runId, 'linked');
    assert.equal(findAgentRunByWorkflowRunId(state([latest, linked]), 'workflow-target')?.runId, 'linked');
  });

  it('lays two specialists on parallel rows and rejoins their edges', () => {
    const layout = buildAgentWorkflowLayout(run());
    const context = layout.nodes.find((item) => item.node.id === 'context');
    const memory = layout.nodes.find((item) => item.node.id === 'memory');
    assert.equal(context?.column, 3);
    assert.equal(memory?.column, 3);
    assert.notEqual(context?.row, memory?.row);
    assert.equal(layout.edges.length, 5);
    assert.ok(layout.edges.every((item) => item.path.startsWith('M ')));
  });

  it('orders unknown agents after the four registry roles without truncating Chinese text', () => {
    const makeAgent = (id: string, displayName: string): AgentResponsibilityView => ({
      manifest: {
        protocol: 'codex-im-suite/agent-collaboration/v1',
        id,
        displayName,
        enabled: true,
        responsibilities: ['这是一个很长的中文职责说明，用于验证职责事实不会被前端覆盖。'],
        owns: [],
        excludes: [],
        capabilities: ['analyze'],
        inputEvidenceKinds: [],
        outputSchemaId: 'test',
        sideEffectLevel: 'none',
        timeoutMs: 30000,
        concurrency: 1,
        modelProfile: 'classifier',
      },
      health: 'idle',
      successCount: 3,
      failureCount: 1,
      timeoutCount: 0,
    });
    const ordered = orderAgentResponsibilities([
      makeAgent('custom', '自定义'),
      makeAgent('memory', '记忆'),
      makeAgent('coordinator', '协调'),
    ]);
    assert.deepEqual(ordered.map((item) => item.manifest.id), ['coordinator', 'memory', 'custom']);
    assert.match(ordered[0].manifest.responsibilities[0], /中文职责说明/u);
  });

  it('keeps fallback nodes visible in the accessible timeline', () => {
    const timeline = orderWorkflowTimeline(run().nodes);
    assert.ok(timeline.some((node) => node.status === 'fallback'));
  });

  it('computes success rates and redacts long evidence summaries by length', () => {
    const agent = orderAgentResponsibilities([]) as AgentResponsibilityView[];
    assert.equal(agent.length, 0);
    assert.equal(agentSuccessRate({ successCount: 3, failureCount: 1, timeoutCount: 0 } as AgentResponsibilityView), 0.75);
    assert.match(summarizeEvidenceRefs(['evidence-short', 'x'.repeat(80)], 2), /…/u);
  });

  it('hides local paths and credential-like values before panel display', () => {
    assert.equal(redactAgentDisplayText('读取 C:\\Users\\admin\\secret.txt'), '读取 [路径已隐藏]');
    assert.equal(redactAgentDisplayText('api_key=secret-value'), 'api_key=[已隐藏]');
    assert.equal(redactAgentDisplayText('https://user:pass@example.com/path'), 'https://[凭据已隐藏]@example.com/path');
  });
});
