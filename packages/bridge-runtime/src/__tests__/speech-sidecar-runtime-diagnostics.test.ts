import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  SpeechSidecarInstanceLock,
  SpeechSidecarRuntimeDiagnostics,
} from '../speech/sidecar-runtime-diagnostics.js';

describe('speech sidecar single-instance lock', () => {
  it('fails closed for a live holder and only lets the holder release the lock', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-sidecar-lock-live-'));
    const probedPids: number[] = [];
    try {
      const holder = new SpeechSidecarInstanceLock(root, 'holder-run-0001', () => true, 4101);
      const contender = new SpeechSidecarInstanceLock(root, 'contender-run-0001', (pid) => {
        probedPids.push(pid);
        return true;
      }, 4102);

      holder.acquire();
      const original = fs.readFileSync(holder.lockPath, 'utf8');
      assert.throws(() => contender.acquire(), /sidecar_instance_locked/);
      assert.deepEqual(probedPids, [4101]);
      assert.equal(contender.release(), false);
      assert.equal(fs.readFileSync(holder.lockPath, 'utf8'), original);

      assert.equal(holder.release(), true);
      contender.acquire();
      const current = JSON.parse(fs.readFileSync(contender.lockPath, 'utf8')) as Record<string, unknown>;
      assert.equal(current.runId, 'contender-run-0001');
      assert.equal(current.ownerPid, 4102);
      assert.equal(contender.release(), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reclaims a confirmed stale PID without probing or killing a real process', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-sidecar-lock-stale-'));
    const lock = new SpeechSidecarInstanceLock(root, 'replacement-run-0001', (pid) => {
      assert.equal(pid, 4999);
      return false;
    }, 4103);
    try {
      fs.writeFileSync(lock.lockPath, `${JSON.stringify({
        protocol: 'cti-speech-sidecar-lock/v1',
        runId: 'stale-run-0001',
        ownerPid: 4999,
        createdAt: '2026-08-07T00:00:00.000Z',
      })}\n`, 'utf8');

      lock.acquire();
      const current = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8')) as Record<string, unknown>;
      assert.equal(current.runId, 'replacement-run-0001');
      assert.equal(current.ownerPid, 4103);
      assert.equal(fs.readdirSync(root).some((name) => name.includes('.stale-')), false);
      assert.equal(lock.release(), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('speech sidecar runtime diagnostics', () => {
  it('isolates concurrent supervisor PIDs and writes bounded logs without token or absolute paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-sidecar-state-'));
    try {
      const live = new SpeechSidecarRuntimeDiagnostics(root, 'live-run-0001', 256);
      const cli = new SpeechSidecarRuntimeDiagnostics(root, 'cli-probe-0001', 256);
      live.recordStarted(1111, 31001);
      cli.recordStarted(2222, 31002);
      const token = 'secret-sidecar-token-value';
      for (let index = 0; index < 12; index += 1) {
        live.append('stderr', `${token} C:\\Users\\alice\\model.bin /tmp/model-${index} diagnostic ${'x'.repeat(80)}`, [token]);
      }
      cli.recordStopped(2222, 'exit_0');

      assert.equal(fs.readFileSync(live.pidPath, 'utf8').trim(), '1111');
      assert.equal(fs.existsSync(cli.pidPath), false);
      assert.ok(fs.statSync(live.logPath).size <= 256);
      if (fs.existsSync(live.rotatedLogPath)) assert.ok(fs.statSync(live.rotatedLogPath).size <= 256);
      const persisted = fs.readdirSync(path.dirname(live.statePath))
        .flatMap((fileName) => {
          const target = path.join(path.dirname(live.statePath), fileName);
          return fs.lstatSync(target).isFile() ? [fs.readFileSync(target, 'utf8')] : [];
        })
        .join('\n');
      assert.equal(persisted.includes(token), false);
      assert.equal(persisted.includes('C:\\Users\\alice'), false);
      assert.equal(persisted.includes('/tmp/model'), false);

      live.recordStopped(1111, 'signal_sigterm');
      assert.equal(fs.existsSync(live.pidPath), false);
      const state = JSON.parse(fs.readFileSync(live.statePath, 'utf8')) as Record<string, unknown>;
      assert.equal(state.state, 'stopped');
      assert.equal(state.exitCode, 'signal_sigterm');
      assert.equal(state.pid, null);
      assert.equal('token' in state, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
