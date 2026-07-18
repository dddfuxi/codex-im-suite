import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

async function loadProviderWorkspaceModule() {
  try {
    return await import('../provider-workspace.js');
  } catch {
    return null;
  }
}

function makePlan(primary: string, temporary: string[] = []) {
  return {
    version: 'cti-turn-workspace/v1' as const,
    primaryWorkspace: {
      path: primary,
      accessMode: 'read_only' as const,
      evidenceIds: ['current_message'],
      reason: 'test',
      expiresAfterTurn: true as const,
    },
    temporaryMounts: temporary.map((item) => ({
      path: item,
      accessMode: 'read_only' as const,
      evidenceIds: ['current_message'],
      reason: 'test',
      expiresAfterTurn: true as const,
    })),
    deniedRoots: [],
    resolvedFrom: 'explicit_path' as const,
    createdAt: '2026-07-17T12:00:00.000Z',
    expiresAfterTurn: true as const,
  };
}

describe('provider workspace resolution', () => {
  it('uses workspacePlan instead of legacy workingDirectory and additionalDirectories', async () => {
    const module = await loadProviderWorkspaceModule();
    assert.ok(module, 'provider workspace module should exist');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-provider-workspace-'));
    const primary = path.join(root, 'primary');
    const temporary = path.join(root, 'temporary');
    const legacy = path.join(root, 'legacy');
    fs.mkdirSync(primary);
    fs.mkdirSync(temporary);
    fs.mkdirSync(legacy);

    try {
      const resolved = module.resolveProviderWorkspace({
        workingDirectory: legacy,
        additionalDirectories: [legacy],
        workspacePlan: makePlan(primary, [temporary]),
      });

      assert.equal(resolved.workingDirectory, primary);
      assert.deepEqual(resolved.additionalDirectories, [temporary]);
      assert.deepEqual(resolved.allowedRoots, [primary, temporary]);
      assert.equal(resolved.source, 'workspace_plan');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops missing temporary mounts without falling back to legacy extras', async () => {
    const module = await loadProviderWorkspaceModule();
    assert.ok(module, 'provider workspace module should exist');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-provider-workspace-missing-'));
    const primary = path.join(root, 'primary');
    const legacy = path.join(root, 'legacy');
    fs.mkdirSync(primary);
    fs.mkdirSync(legacy);

    try {
      const resolved = module.resolveProviderWorkspace({
        workingDirectory: legacy,
        additionalDirectories: [legacy],
        workspacePlan: makePlan(primary, [path.join(root, 'missing')]),
      });

      assert.equal(resolved.workingDirectory, primary);
      assert.deepEqual(resolved.additionalDirectories, []);
      assert.deepEqual(resolved.allowedRoots, [primary]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an isolated scheduled-task sandbox as the only provider root', async () => {
    const module = await loadProviderWorkspaceModule();
    assert.ok(module, 'provider workspace module should exist');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-provider-workspace-isolated-'));
    const sandbox = path.join(root, 'sandbox');
    const legacyProject = path.join(root, 'legacy-project');
    fs.mkdirSync(sandbox);
    fs.mkdirSync(legacyProject);

    try {
      const resolved = module.resolveProviderWorkspace({
        workingDirectory: legacyProject,
        additionalDirectories: [legacyProject],
        workspacePlan: makePlan(sandbox),
      });

      assert.equal(resolved.workingDirectory, sandbox);
      assert.deepEqual(resolved.additionalDirectories, []);
      assert.deepEqual(resolved.allowedRoots, [sandbox]);
      assert.equal(resolved.source, 'workspace_plan');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the legacy provider behavior when no plan is supplied', async () => {
    const module = await loadProviderWorkspaceModule();
    assert.ok(module, 'provider workspace module should exist');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-provider-workspace-legacy-'));
    const primary = path.join(root, 'primary');
    const extra = path.join(root, 'extra');
    fs.mkdirSync(primary);
    fs.mkdirSync(extra);

    try {
      const resolved = module.resolveProviderWorkspace({
        workingDirectory: primary,
        additionalDirectories: [extra, extra],
      });

      assert.equal(resolved.workingDirectory, primary);
      assert.deepEqual(resolved.additionalDirectories, [extra]);
      assert.deepEqual(resolved.allowedRoots, [primary, extra]);
      assert.equal(resolved.source, 'legacy_params');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
