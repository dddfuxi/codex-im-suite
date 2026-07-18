import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

describe('bridge-core test environment isolation', () => {
  it('routes runtime, upload, memory, and Codex state into one temporary test root', () => {
    const testRoot = process.env.CTI_TEST_ROOT;
    assert.ok(testRoot, 'CTI_TEST_ROOT must be injected before the test suite starts');
    assert.ok(isInside(os.tmpdir(), testRoot), 'test root must stay under the operating-system temp directory');

    const isolatedPaths = {
      CTI_HOME: process.env.CTI_HOME,
      CTI_UPLOAD_CACHE_DIR: process.env.CTI_UPLOAD_CACHE_DIR,
      CTI_MEMORY_REPO_DIR: process.env.CTI_MEMORY_REPO_DIR,
      CODEX_HOME: process.env.CODEX_HOME,
    };

    for (const [name, candidate] of Object.entries(isolatedPaths)) {
      assert.ok(candidate, `${name} must be configured for tests`);
      assert.ok(isInside(testRoot, candidate), `${name} must stay inside CTI_TEST_ROOT`);
    }
  });
});
