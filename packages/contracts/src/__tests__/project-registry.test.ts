import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

async function loadProjectRegistryModule() {
  try {
    return await import('../project-registry.js');
  } catch {
    return null;
  }
}

describe('project registry contract', () => {
  it('normalizes structured Unity and non-Unity project records', async () => {
    const module = await loadProjectRegistryModule();
    assert.ok(module, 'project registry contract should exist');

    const projects = module.parseProjectRegistryDocument({
      schema: 'codex-im-suite/project-registry/v1',
      projects: [{
        id: 'st4',
        displayName: 'ST4',
        type: 'unity',
        workspaceRoot: 'F:\\unity\\ST4\\',
        unityProjectRoot: 'F:\\unity\\ST4\\Game\\',
        accessMode: 'read_write',
        mcpProfileIds: ['unity-main', 'unity-main', ''],
        enabled: true,
      }, {
        id: 'suite',
        displayName: 'codex-im-suite',
        type: 'node',
        workspaceRoot: 'C:\\workspace\\codex-im-suite',
        accessMode: 'read_only',
        enabled: true,
      }],
    });

    assert.deepEqual(projects, [{
      id: 'st4',
      displayName: 'ST4',
      type: 'unity',
      workspaceRoot: path.normalize('F:\\unity\\ST4'),
      unityProjectRoot: path.normalize('F:\\unity\\ST4\\Game'),
      accessMode: 'read_write',
      mcpProfileIds: ['unity-main'],
      enabled: true,
    }, {
      id: 'suite',
      displayName: 'codex-im-suite',
      type: 'node',
      workspaceRoot: path.normalize('C:\\workspace\\codex-im-suite'),
      accessMode: 'read_only',
      enabled: true,
    }]);
  });

  it('rejects duplicate identities, duplicate roots, invalid Unity roots and denied paths', async () => {
    const module = await loadProjectRegistryModule();
    assert.ok(module, 'project registry contract should exist');
    const base = {
      displayName: 'Project',
      type: 'generic',
      accessMode: 'read_write',
      enabled: true,
    };

    assert.throws(() => module.parseProjectRegistryDocument({
      schema: 'codex-im-suite/project-registry/v1',
      projects: [
        { ...base, id: 'same', workspaceRoot: 'C:\\workspace\\one' },
        { ...base, id: 'same', workspaceRoot: 'C:\\workspace\\two' },
      ],
    }), /duplicate_project_id/u);
    assert.throws(() => module.parseProjectRegistryDocument({
      schema: 'codex-im-suite/project-registry/v1',
      projects: [
        { ...base, id: 'one', workspaceRoot: 'C:\\workspace\\same' },
        { ...base, id: 'two', workspaceRoot: 'C:\\workspace\\same\\' },
      ],
    }), /duplicate_workspace_root/u);
    assert.throws(() => module.parseProjectRegistryDocument({
      schema: 'codex-im-suite/project-registry/v1',
      projects: [{
        ...base,
        id: 'unity-bad',
        type: 'unity',
        workspaceRoot: 'C:\\workspace\\unity',
        unityProjectRoot: 'D:\\outside\\Game',
      }],
    }), /unity_project_root_outside_workspace/u);
    assert.throws(() => module.parseProjectRegistryDocument({
      schema: 'codex-im-suite/project-registry/v1',
      projects: [{ ...base, id: 'memory', workspaceRoot: 'E:\\cli-md\\project' }],
    }, { deniedRoots: ['E:\\cli-md'] }), /project_root_denied/u);
  });

  it('imports legacy allowed roots as stable generic project records', async () => {
    const module = await loadProjectRegistryModule();
    assert.ok(module, 'project registry contract should exist');

    const first = module.importLegacyWorkspaceRoots([
      'C:\\unity\\ST3',
      'C:\\unity\\ST3\\',
      'F:\\unity\\ST4',
    ]);
    const second = module.importLegacyWorkspaceRoots(['C:\\unity\\ST3', 'F:\\unity\\ST4']);

    assert.equal(first.length, 2);
    assert.deepEqual(first.map((item: { id: string }) => item.id), second.map((item: { id: string }) => item.id));
    assert.equal(first.every((item: { type: string; accessMode: string; enabled: boolean }) => (
      item.type === 'generic' && item.accessMode === 'read_write' && item.enabled
    )), true);
  });
});
