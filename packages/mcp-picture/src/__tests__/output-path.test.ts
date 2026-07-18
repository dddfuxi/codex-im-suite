import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { resolveArtifactOutputPath } from '../annotate';

describe('picture MCP artifact output path', () => {
  it('fails closed when a default output has no runtime artifact root', () => {
    assert.throws(
      () => resolveArtifactOutputPath(undefined, undefined, 'objects', 123),
      /artifact_root/i,
    );
  });

  it('resolves default and relative outputs under the runtime artifact root', () => {
    const artifactRoot = path.join(os.tmpdir(), 'cti-picture-artifacts');
    assert.equal(
      resolveArtifactOutputPath(undefined, artifactRoot, 'objects', 123),
      path.join(artifactRoot, 'objects-123.png'),
    );
    assert.equal(
      resolveArtifactOutputPath('nested/preview.png', artifactRoot, 'objects', 123),
      path.join(artifactRoot, 'nested', 'preview.png'),
    );
    assert.throws(
      () => resolveArtifactOutputPath('../outside.png', artifactRoot, 'objects', 123),
      /outside artifact_root/i,
    );
  });

  it('preserves an explicit absolute output path without consulting cwd', () => {
    const explicit = path.join(os.tmpdir(), 'explicit-picture.png');
    assert.equal(resolveArtifactOutputPath(explicit, undefined, 'objects', 123), explicit);
  });
});
