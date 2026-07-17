import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';
const daemonScript = path.join(scriptDir, isWindows ? 'daemon.ps1' : 'daemon.sh');

// 给当前 IM 回复和 streaming card 收尾留出时间，然后交给已有 supervisor 重启。
await delay(2000);

const child = isWindows
  ? spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      daemonScript,
      'restart',
    ], { detached: true, stdio: 'ignore', windowsHide: true })
  : spawn('/bin/sh', [daemonScript, 'restart'], { detached: true, stdio: 'ignore' });

child.unref();
