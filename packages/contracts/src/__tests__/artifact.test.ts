import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function loadArtifactContract() {
  try {
    return await import('../artifact.js');
  } catch {
    return null;
  }
}

describe('artifact contract', () => {
  it('normalizes a structured promotion request without trusting absolute paths', async () => {
    const module = await loadArtifactContract();
    assert.ok(module, 'artifact contract should exist');

    assert.deepEqual(module.parseArtifactPromotionRequest({
      artifactId: 'artifact-0123456789abcdef01234567',
      targetProjectId: 'st4',
      targetRelativePath: 'Assets\\Generated\\preview.png',
      expectedSha256: 'a'.repeat(64),
    }), {
      artifactId: 'artifact-0123456789abcdef01234567',
      targetProjectId: 'st4',
      targetRelativePath: 'Assets/Generated/preview.png',
      expectedSha256: 'a'.repeat(64),
    });
  });

  it('rejects traversal, absolute targets, invalid ids and invalid hashes', async () => {
    const module = await loadArtifactContract();
    assert.ok(module, 'artifact contract should exist');

    for (const targetRelativePath of ['../outside.png', 'Assets/../../outside.png', 'C:\\outside.png', '/tmp/outside.png']) {
      assert.throws(() => module.parseArtifactPromotionRequest({
        artifactId: 'artifact-0123456789abcdef01234567',
        targetProjectId: 'st4',
        targetRelativePath,
      }), /invalid_artifact_target_path/u);
    }
    assert.throws(() => module.parseArtifactPromotionRequest({
      artifactId: 'made-up',
      targetProjectId: 'st4',
      targetRelativePath: 'Assets/out.png',
    }), /invalid_artifact_id/u);
    assert.throws(() => module.parseArtifactPromotionRequest({
      artifactId: 'artifact-0123456789abcdef01234567',
      targetProjectId: 'ST 4',
      targetRelativePath: 'Assets/out.png',
    }), /invalid_artifact_project_id/u);
    assert.throws(() => module.parseArtifactPromotionRequest({
      artifactId: 'artifact-0123456789abcdef01234567',
      targetProjectId: 'st4',
      targetRelativePath: 'Assets/out.png',
      expectedSha256: 'bad',
    }), /invalid_artifact_sha256/u);
  });
});
