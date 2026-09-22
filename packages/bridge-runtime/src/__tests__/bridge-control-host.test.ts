import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createBridgeControlHost } from '../bridge-control-host.js';

describe('bridge control host', () => {
  it('schedules only the repository-owned restart worker and records an audit event', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-bridge-control-'));
    try {
      const skillRoot = path.join(root, 'live-skill');
      const ctiHome = path.join(root, 'cti-home');
      const workerPath = path.join(skillRoot, 'scripts', 'restart-live-bridge.mjs');
      fs.mkdirSync(path.dirname(workerPath), { recursive: true });
      fs.writeFileSync(workerPath, '// fixture', 'utf8');
      const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
      const host = createBridgeControlHost({
        skillRoot,
        ctiHome,
        now: () => new Date('2026-07-16T13:00:00.000Z'),
        spawnDetached: (file, args, options) => {
          calls.push({ file, args, options });
          return { unref() {} };
        },
      });

      const result = await host.scheduleRestart({
        requestedBy: {
          channelType: 'feishu',
          chatId: 'oc_source',
          userId: 'ou_owner',
          messageId: 'om_request',
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.scheduledFor, '2026-07-16T13:00:02.000Z');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].file, process.execPath);
      assert.deepEqual(calls[0].args, [workerPath]);
      assert.equal(calls[0].options.detached, true);
      assert.equal(calls[0].options.windowsHide, true);
      const auditPath = path.join(ctiHome, 'data', 'bridge-control-audit.jsonl');
      const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8').trim());
      assert.equal(audit.action, 'restart_live');
      assert.equal(audit.result, 'scheduled');
      assert.deepEqual(audit.actor, {
        channelType: 'feishu',
        chatId: 'oc_source',
        userId: 'ou_owner',
        messageId: 'om_request',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the fixed restart worker is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-bridge-control-missing-'));
    try {
      let spawned = false;
      const host = createBridgeControlHost({
        skillRoot: path.join(root, 'live-skill'),
        ctiHome: path.join(root, 'cti-home'),
        spawnDetached: () => {
          spawned = true;
          return { unref() {} };
        },
      });

      const result = await host.scheduleRestart({
        requestedBy: { channelType: 'feishu', chatId: 'oc_source', userId: 'ou_owner' },
      });

      assert.equal(result.ok, false);
      assert.equal(spawned, false);
      assert.match(result.error || '', /重启 worker 不存在/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
