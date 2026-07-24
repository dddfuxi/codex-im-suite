import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { AgentTaskRequest } from '@codex-im-suite/contracts';

import { loadAgentManifestRegistry } from '../agent-workers/manifest-registry.js';
import { validateAgentTaskRequest, validateAgentTurnPlan } from '../agent-workers/protocol.js';

const manifestDir = path.resolve(process.cwd(), '..', '..', 'config', 'agents.d');

function request(input: Record<string, unknown> = {}): AgentTaskRequest {
  return {
    protocol: 'codex-im-suite/agent-worker/v1',
    runId: 'run-1',
    turnId: 'turn-1',
    taskId: 'task-1',
    agentId: 'context',
    capability: 'rank_context',
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    evidenceRefs: ['current-message'],
    input,
  };
}

describe('agent worker protocol validation', () => {
  it('loads the four read-only manifests from the registry', () => {
    const registry = loadAgentManifestRegistry(manifestDir);
    assert.deepEqual([...registry.byId.keys()].sort(), ['context', 'coordinator', 'memory', 'performance']);
    assert.equal(registry.manifests.every((manifest) => manifest.sideEffectLevel === 'none'), true);
  });

  it('rejects unknown agents, fake evidence and forbidden task fields', () => {
    const registry = loadAgentManifestRegistry(manifestDir);
    assert.equal(validateAgentTaskRequest({ ...request(), agentId: 'unknown' }, registry).ok, false);
    assert.equal(validateAgentTaskRequest(request({ apiToken: 'secret' }), registry).ok, false);
    assert.equal(validateAgentTaskRequest(request({ workspacePath: 'C:\\repo' }), registry).ok, false);
    assert.equal(validateAgentTaskRequest(request({ toolAction: { name: 'shell' } }), registry).ok, false);

    const plan = validateAgentTurnPlan({
      shouldCollaborate: true,
      reason: 'test',
      tasks: [{ taskId: 'x', agentId: 'context', capability: 'rank_context', objective: 'test', evidenceRefs: ['fake-id'] }],
    }, registry, new Set(['current-message']), 2);
    assert.equal(plan, null);
  });

  it('rejects malformed or side-effect manifests', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-agent-manifest-test-'));
    try {
      fs.writeFileSync(path.join(tempDir, 'bad.json'), JSON.stringify({
        protocol: 'codex-im-suite/agent-collaboration/v1',
        id: 'bad',
        displayName: 'Bad',
        enabled: true,
        responsibilities: [],
        owns: [],
        excludes: [],
        capabilities: ['x'],
        inputEvidenceKinds: [],
        outputSchemaId: 'x',
        sideEffectLevel: 'write',
        timeoutMs: 1000,
        concurrency: 1,
        modelProfile: 'classifier',
      }), 'utf8');
      assert.throws(() => loadAgentManifestRegistry(tempDir), /无效 Agent Manifest/u);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
