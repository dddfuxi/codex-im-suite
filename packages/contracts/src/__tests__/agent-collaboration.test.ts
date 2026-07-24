import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  AgentCardProgressSnapshot,
  AgentTaskRequest,
  AgentTaskResult,
  CollaborationAgentManifest,
} from '../agent-collaboration.js';

describe('agent collaboration contract', () => {
  it('keeps Chinese text unchanged through UTF-8 NDJSON serialization', () => {
    const manifest: CollaborationAgentManifest = {
      protocol: 'codex-im-suite/agent-collaboration/v1',
      id: 'context',
      displayName: '上下文 Agent',
      enabled: true,
      responsibilities: ['解决冲突引用'],
      owns: ['真实 evidence ID 选择'],
      excludes: ['不执行工具', '不发送消息'],
      capabilities: ['resolve_context'],
      inputEvidenceKinds: ['message', 'history'],
      outputSchemaId: 'codex-im-suite/agent-task-result/v1',
      sideEffectLevel: 'none',
      timeoutMs: 30000,
      concurrency: 1,
      modelProfile: 'classifier',
    };
    const request: AgentTaskRequest = {
      protocol: 'codex-im-suite/agent-worker/v1',
      runId: 'run-1',
      turnId: 'turn-1',
      taskId: 'task-1',
      agentId: 'context',
      capability: 'resolve_context',
      deadlineAt: new Date(Date.now() + 1000).toISOString(),
      evidenceRefs: ['当前消息', '引用消息'],
      input: { objective: '判断“继续”指向哪条真实消息' },
    };

    const decoded = JSON.parse(Buffer.from(`${JSON.stringify({ manifest, request })}\n`, 'utf8').toString('utf8')) as {
      manifest: CollaborationAgentManifest;
      request: AgentTaskRequest;
    };
    assert.equal(decoded.manifest.displayName, '上下文 Agent');
    assert.deepEqual(decoded.request.evidenceRefs, ['当前消息', '引用消息']);
    assert.equal(decoded.request.input.objective, '判断“继续”指向哪条真实消息');
  });

  it('does not define action or delivery fields on specialist results', () => {
    const result: AgentTaskResult = {
      protocol: 'codex-im-suite/agent-worker/v1',
      runId: 'run-1',
      turnId: 'turn-1',
      taskId: 'task-1',
      agentId: 'memory',
      capability: 'rank_memory',
      status: 'succeeded',
      findings: ['命中项 A 比命中项 B 更接近当前问题'],
      evidenceRefs: ['memory:a', 'memory:b'],
      promptSections: [],
      metrics: {
        startedAt: '2026-07-24T00:00:00.000Z',
        endedAt: '2026-07-24T00:00:00.010Z',
        durationMs: 10,
      },
    };
    assert.equal('toolActions' in result, false);
    assert.equal('delivery' in result, false);
    assert.equal('write' in result, false);
  });

  it('keeps the card progress snapshot free of prompt, evidence content, and actions', () => {
    const snapshot: AgentCardProgressSnapshot = {
      runId: 'run-1',
      mode: 'shadow',
      status: 'running',
      injectedIntoPrimary: false,
      agents: [{
        taskId: 'coordinator',
        agentId: 'coordinator',
        displayName: 'Coordinator Agent',
        kind: 'coordinator',
        status: 'running',
        startedAt: '2026-07-24T00:00:00.000Z',
      }],
    };

    const encoded = JSON.stringify(snapshot);
    assert.equal('promptSections' in snapshot, false);
    assert.equal('evidenceRefs' in snapshot, false);
    assert.equal('findings' in snapshot, false);
    assert.doesNotMatch(encoded, /credential|absolutePath|toolActions/u);
  });
});
