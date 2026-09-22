import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const existingRoot = process.env.CTI_TEST_ROOT?.trim();
const testRoot = existingRoot
  ? path.resolve(existingRoot)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'cti-bridge-core-tests-'));

if (!isInside(os.tmpdir(), testRoot)) {
  throw new Error(`CTI_TEST_ROOT must stay under the operating-system temp directory: ${testRoot}`);
}

const isolatedPaths = {
  CTI_HOME: path.join(testRoot, 'cti-home'),
  CTI_UPLOAD_CACHE_DIR: path.join(testRoot, 'uploads'),
  CTI_MEMORY_REPO_DIR: path.join(testRoot, 'memory'),
  CODEX_HOME: path.join(testRoot, 'codex-home'),
};

process.env.CTI_TEST_ROOT = testRoot;
for (const [name, value] of Object.entries(isolatedPaths)) {
  process.env[name] = value;
  fs.mkdirSync(value, { recursive: true });
}

if (!existingRoot) {
  process.once('exit', () => {
    if (isInside(os.tmpdir(), testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });
}
