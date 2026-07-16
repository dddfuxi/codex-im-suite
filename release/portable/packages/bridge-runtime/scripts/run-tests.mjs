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
    // Child-level test timeouts cannot fire if a regression starves the event
    // loop. The parent watchdog guarantees the suite returns control instead
    // of leaving a permanent high-CPU Node worker behind.
    timeout: 120_000,
    killSignal: 'SIGKILL',
  },
);

fs.rmSync(tmpHome, { recursive: true, force: true });
if (result.error) {
  console.error(`[bridge-runtime tests] child process failed: ${result.error.message}`);
}
process.exit(result.status ?? 1);
