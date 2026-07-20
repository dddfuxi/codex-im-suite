import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

async function loadProjectRegistryModule() {
  try {
    return await import('../projects/project-registry.js');
  } catch {
    return null;
  }
}

describe('runtime project registry loader', () => {
  it('loads structured records and imports only non-duplicate legacy roots', async () => {
    const module = await loadProjectRegistryModule();
    assert.ok(module, 'runtime project registry loader should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-project-registry-'));
    const registryPath = path.join(root, 'project-registry.json');
    try {
      fs.writeFileSync(registryPath, `${JSON.stringify({
        schema: 'codex-im-suite/project-registry/v1',
        projects: [{
          id: 'st4',
          displayName: 'ST4',
          type: 'unity',
          workspaceRoot: 'F:\\unity\\ST4',
          unityProjectRoot: 'F:\\unity\\ST4\\Game',
          accessMode: 'read_write',
          enabled: true,
        }],
      }, null, 2)}\n`, 'utf8');

      const result = module.loadRegisteredProjectRegistry({
        registryPath,
        legacyRoots: ['F:\\unity\\ST4', 'C:\\unity\\ST3'],
        deniedRoots: ['E:\\cli-md'],
      });

      assert.equal(result.source, 'mixed');
      assert.deepEqual(result.projects.map((item: { id: string }) => item.id), ['st4', result.projects[1].id]);
      assert.equal(result.projects[1].workspaceRoot, path.normalize('C:\\unity\\ST3'));
      assert.equal(result.projects[1].type, 'generic');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for malformed registry JSON', async () => {
    const module = await loadProjectRegistryModule();
    assert.ok(module, 'runtime project registry loader should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-project-registry-invalid-'));
    const registryPath = path.join(root, 'project-registry.json');
    try {
      fs.writeFileSync(registryPath, '{broken', 'utf8');
      assert.throws(() => module.loadRegisteredProjectRegistry({ registryPath }), /project_registry_invalid_json/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses legacy roots when no structured registry exists', async () => {
    const module = await loadProjectRegistryModule();
    assert.ok(module, 'runtime project registry loader should exist');
    const result = module.loadRegisteredProjectRegistry({
      registryPath: path.join(os.tmpdir(), `missing-project-registry-${Date.now()}.json`),
      legacyRoots: ['C:\\unity\\ST3'],
    });

    assert.equal(result.source, 'legacy');
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].workspaceRoot, path.normalize('C:\\unity\\ST3'));
  });
});
