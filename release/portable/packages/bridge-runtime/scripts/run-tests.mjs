import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

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
const configuredWatchdogMs = Number.parseInt(process.env.CTI_RUNTIME_TEST_WATCHDOG_MS || '180000', 10);
const watchdogMs = Number.isFinite(configuredWatchdogMs)
  ? Math.max(60_000, Math.min(300_000, configuredWatchdogMs))
  : 180_000;

const testArgs = ['--test', '--test-concurrency=1', '--import', 'tsx', '--test-timeout=15000'];
// Node 22+ 可在测试完成后主动释放遗留句柄；旧 Node 仍由父 watchdog 收口。
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map((value) => Number.parseInt(value, 10));
const supportsTestForceExit = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 30);
if (supportsTestForceExit) testArgs.push('--test-force-exit');
testArgs.push(...testFiles);

const status = await new Promise((resolve) => {
  const child = spawn(process.execPath, testArgs, { stdio: 'inherit', env, windowsHide: true });
  let settled = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    resolve(code);
  };
  const terminateTree = () => {
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => {
        try { child.kill('SIGKILL'); } catch { /* 子进程可能已退出。 */ }
      });
      killer.unref();
    } else {
      try { child.kill('SIGKILL'); } catch { /* 子进程可能已退出。 */ }
    }
    child.unref();
  };
  const watchdog = setTimeout(() => {
    console.error(`[bridge-runtime tests] watchdog exceeded ${watchdogMs} ms; terminating test process tree`);
    terminateTree();
    // Windows taskkill 可能因 ACL 或竞态无法触发 close；父 runner 仍必须有界返回。
    setTimeout(() => finish(1), 5_000);
  }, watchdogMs);
  watchdog.unref?.();
  child.once('error', (error) => {
    console.error(`[bridge-runtime tests] child process failed: ${error.message}`);
    finish(1);
  });
  child.once('close', (code) => finish(code ?? 1));
});

fs.rmSync(tmpHome, { recursive: true, force: true });
process.exitCode = status;
