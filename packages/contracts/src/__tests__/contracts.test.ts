import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type {
  ExtensionTrustPolicy,
  NodeAgentHeartbeat,
  WorkflowPanelRunContract,
  WorkflowFailureLedgerContract,
  WorkflowRunContract,
} from '../index.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const schemaDir = path.join(packageRoot, 'schemas');

function readSchema(fileName: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(schemaDir, fileName), 'utf8')) as Record<string, unknown>;
}

test('node heartbeat contract keeps stable schema id', () => {
  const schema = readSchema('node-agent-heartbeat.schema.json');
  const heartbeat: NodeAgentHeartbeat = {
    schema: 'codex-im-suite/node-agent-heartbeat/v1',
    nodeId: 'local',
    displayName: 'Local runtime',
    kind: 'local',
    status: 'online',
    version: '0.2.0',
    lastSeenAt: '2026-05-16T00:00:00.000Z',
    capabilities: [
      { id: 'bridge', displayName: 'Bridge', category: 'bridge', status: 'online', risk: 'medium' },
    ],
  };

  assert.equal((schema.properties as Record<string, { const?: string }>).schema.const, heartbeat.schema);
  assert.equal(heartbeat.capabilities[0].category, 'bridge');
});

test('workflow run contract includes checkpoints and events', () => {
  const schema = readSchema('workflow-run.schema.json');
  const run: WorkflowRunContract = {
    schema: 'codex-im-suite/workflow-run/v1',
    id: 'run_1',
    nodeId: 'local',
    status: 'running',
    stage: 'executing',
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:01.000Z',
    checkpoints: [
      {
        id: 'cp_1',
        kind: 'provider',
        stage: 'executing',
        createdAt: '2026-05-16T00:00:01.000Z',
        summary: 'provider started',
        recoverable: true,
      },
    ],
    events: [
      {
        id: 'evt_1',
        stage: 'executing',
        type: 'executor.executing',
        createdAt: '2026-05-16T00:00:01.000Z',
        summary: 'executor started',
        checkpointId: 'cp_1',
      },
    ],
  };

  assert.equal((schema.properties as Record<string, { const?: string }>).schema.const, run.schema);
  assert.equal(run.checkpoints[0].kind, 'provider');
});

test('workflow panel run records Codex SDK parameter evidence', () => {
  const run: WorkflowPanelRunContract = {
    id: 'run-codex-profile',
    sessionId: 'session-codex-profile',
    promptPreview: 'hello',
    stage: 'executing',
    status: 'running',
    startedAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:01.000Z',
    execution: {
      provider: 'codex',
      modelSource: 'official',
      requestedModel: 'gpt-5.4',
      submittedModel: 'gpt-5.4',
      modelMode: 'explicit',
      requestedReasoningEffort: 'xhigh',
      submittedReasoningEffort: 'xhigh',
      threadMode: 'fresh_profile_changed',
      parameterEvidence: 'sdk_thread_options',
      verifiedOutputArtifactCount: 1,
      replaySafety: 'safe_read_only',
      retryDisposition: 'retry_in_turn',
    },
    events: [],
  };

  assert.equal(run.execution?.submittedModel, 'gpt-5.4');
  assert.equal(run.execution?.parameterEvidence, 'sdk_thread_options');
  assert.equal(run.execution?.verifiedOutputArtifactCount, 1);
  const panelSchema = readSchema('workflow-panel-state.schema.json');
  assert.equal(panelSchema.$id, 'https://codex-im-suite.local/schemas/workflow-panel-state.schema.json');
});

test('workflow failure ledger exposes a monotonic watermark without message content', () => {
  const schema = readSchema('workflow-failure-ledger.schema.json');
  const ledger: WorkflowFailureLedgerContract = {
    protocol: 'workflow-failure-ledger/v1',
    updatedAt: '2026-08-03T06:47:00.000Z',
    nextSequence: 2,
    retainedFromSequence: 1,
    entries: [{
      sequence: 1,
      fingerprint: `sha256:${'a'.repeat(64)}`,
      occurredAt: '2026-08-03T06:46:00.000Z',
      kind: 'restart_interrupted',
      state: 'observed',
      stage: 'executing',
      workflowStatus: 'failed',
      failureCodes: ['runtime.restart_during_execution'],
    }],
  };

  assert.equal((schema.properties as Record<string, { const?: string }>).protocol.const, ledger.protocol);
  assert.equal(ledger.entries[0].sequence, 1);
});

test('extension trust policy exposes capability risk and credential scope', () => {
  const schema = readSchema('extension-trust-policy.schema.json');
  const policy: ExtensionTrustPolicy = {
    schema: 'codex-im-suite/extension-trust-policy/v1',
    extensionId: 'example-mcp',
    trustLevel: 'community',
    capabilities: [
      {
        id: 'filesystem-read',
        category: 'mcp',
        risk: 'medium',
        description: 'Reads configured workspace files.',
        requiresCredential: false,
      },
    ],
  };

  assert.equal((schema.properties as Record<string, { const?: string }>).schema.const, policy.schema);
  assert.equal(policy.capabilities[0].risk, 'medium');
});
