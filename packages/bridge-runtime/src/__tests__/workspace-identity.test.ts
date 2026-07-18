import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

async function loadModule() {
  try {
    return await import('../workspace-identity.js');
  } catch {
    return null;
  }
}

describe('workspace identity', () => {
  it('uses one stable workspace id for case and trailing-separator variants', async () => {
    const module = await loadModule();
    assert.ok(module, 'workspace identity module should exist');

    const first = module.resolveWorkspaceIdentity('C:\\Projects\\Alpha\\');
    const second = module.resolveWorkspaceIdentity('c:\\projects\\alpha');

    assert.equal(first.id, second.id);
    assert.equal(first.label, 'Alpha');
    assert.match(first.id, /^alpha-[a-f0-9]{10}$/u);
  });

  it('anchors subdirectories and moved clones to the same git remote project identity', async () => {
    const module = await loadModule();
    assert.ok(module, 'workspace identity module should exist');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-workspace-git-identity-'));
    const firstRoot = path.join(temp, 'first-name');
    const movedRoot = path.join(temp, 'renamed-copy');
    const remoteConfig = '[remote "origin"]\n\turl = https://example.com/team/alpha-project.git\n';

    try {
      for (const root of [firstRoot, movedRoot]) {
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });
        fs.mkdirSync(path.join(root, 'packages', 'runtime'), { recursive: true });
        fs.writeFileSync(path.join(root, '.git', 'config'), remoteConfig, 'utf8');
      }

      const fromRoot = module.resolveWorkspaceIdentity(firstRoot);
      const fromNested = module.resolveWorkspaceIdentity(path.join(firstRoot, 'packages', 'runtime'));
      const fromMovedClone = module.resolveWorkspaceIdentity(movedRoot);

      assert.equal(fromRoot.id, fromNested.id);
      assert.equal(fromRoot.id, fromMovedClone.id);
      assert.equal(fromRoot.label, 'alpha-project');
      assert.equal(fromNested.normalizedPath, path.resolve(firstRoot));
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
