import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-rt-tests-'));
const testDir = path.resolve('src/__tests__');
const testFiles = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => path.join(testDir, name));

const env = {
  ...process.env,
  CTI_HOME: tmpHome,
};

const result = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', '--import', 'tsx', '--test-timeout=15000', ...testFiles],
  {
    stdio: 'inherit',
    env,
  },
);

fs.rmSync(tmpHome, { recursive: true, force: true });
process.exit(result.status ?? 1);
