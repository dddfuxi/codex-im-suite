import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type {
  ExtensionTrustPolicy,
  NodeAgentHeartbeat,
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
