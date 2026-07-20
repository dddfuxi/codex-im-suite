import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const schemaDir = path.join(packageRoot, 'schemas');

describe('control panel shared contracts', () => {
  it('exports stable wire protocol identifiers', async () => {
    const contracts = await import('../index.js');

    assert.equal(contracts.CONTROL_PANEL_STATE_SCHEMA, 'codex-im-suite/control-panel-state/v1');
    assert.equal(contracts.CONTROL_COMMAND_SCHEMA, 'codex-im-suite/control-command/v1');
    assert.equal(contracts.CONTROL_RESULT_SCHEMA, 'codex-im-suite/control-result/v1');
    assert.equal(contracts.WORKFLOW_PANEL_STATE_PROTOCOL, 'workflow-runtime/v1');
  });

  it('publishes stable JSON schemas for the control API and project registry', () => {
    const controlApiPath = path.join(schemaDir, 'control-api.schema.json');
    const projectRegistryPath = path.join(schemaDir, 'project-registry.schema.json');

    assert.equal(fs.existsSync(controlApiPath), true, 'control-api.schema.json should exist');
    assert.equal(fs.existsSync(projectRegistryPath), true, 'project-registry.schema.json should exist');

    const controlApi = JSON.parse(fs.readFileSync(controlApiPath, 'utf8')) as {
      $id?: string;
      $defs?: Record<string, { required?: string[] }>;
    };
    const projectRegistry = JSON.parse(fs.readFileSync(projectRegistryPath, 'utf8')) as {
      $id?: string;
      properties?: { schema?: { const?: string } };
    };

    assert.equal(controlApi.$id, 'https://codex-im-suite.local/schemas/control-api.schema.json');
    assert.deepEqual(controlApi.$defs?.RuntimeUnitContract?.required, [
      'unitId', 'id', 'displayName', 'kind', 'category', 'status', 'detail', 'enabled',
      'installState', 'source', 'cwd', 'version', 'description', 'canInstall', 'actions',
    ]);
    assert.deepEqual(controlApi.$defs?.ControlPanelStateContract?.required, [
      'schema', 'generatedAt', 'suite', 'services', 'nodes', 'extensions', 'skillGovernance',
      'promptSnapshots', 'scheduledTasks', 'mcp', 'release', 'liveSync', 'settings', 'history',
      'workflow', 'projectRegistry', 'memory', 'memorySkillAssets', 'memoryReminders', 'executors',
      'permissions', 'paths', 'activities',
    ]);
    assert.deepEqual(controlApi.$defs?.ProjectRegistrySnapshotContract?.required, [
      'schema', 'generatedAt', 'registryPath', 'exists', 'projects', 'error',
    ]);
    assert.equal(projectRegistry.properties?.schema?.const, 'codex-im-suite/project-registry/v1');
  });
});
