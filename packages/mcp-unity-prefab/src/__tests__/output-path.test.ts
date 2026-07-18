import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { resolvePrefabSheetOutputPath } from '../render-sheet';

describe('Unity prefab MCP artifact output path', () => {
  it('fails closed when a relative output has no runtime artifact root', () => {
    assert.throws(
      () => resolvePrefabSheetOutputPath('output/prefabs.png', undefined),
      /artifact_root/i,
    );
  });

  it('resolves relative outputs under the runtime artifact root and blocks traversal', () => {
    const artifactRoot = path.join(os.tmpdir(), 'cti-prefab-artifacts');
    assert.equal(
      resolvePrefabSheetOutputPath('output/prefabs.png', artifactRoot),
      path.join(artifactRoot, 'output', 'prefabs.png'),
    );
    assert.throws(
      () => resolvePrefabSheetOutputPath('../outside.png', artifactRoot),
      /outside artifact_root/i,
    );
  });

  it('preserves an explicit absolute output path without consulting cwd', () => {
    const explicit = path.join(os.tmpdir(), 'explicit-prefabs.png');
    assert.equal(resolvePrefabSheetOutputPath(explicit, undefined), explicit);
  });
});
