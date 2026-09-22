import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { SpeechStatusContract } from '@codex-im-suite/contracts/speech';

import { loadSpeechRuntimeConfig } from '../speech/runtime-config.js';
import { SpeechLiveStatusStore } from '../speech/speech-live-status.js';

function statusFixture(): SpeechStatusContract {
  return {
    protocol: 'codex-im-suite/speech-status/v2',
    state: 'optional_missing',
    inputEnabled: true,
    outputEnabled: false,
  } as SpeechStatusContract;
}

describe('speech live status snapshot', () => {
  it('binds a fresh snapshot to live PID and config identity without persisting dependency paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-live-status-'));
    const now = new Date('2026-08-07T02:00:00.000Z');
    const secretPath = path.join(root, 'private-model.gguf');
    const config = loadSpeechRuntimeConfig(new Map([
      ['CTI_SPEECH_INPUT_ENABLED', 'true'],
      ['CTI_SPEECH_ASR_MODEL', secretPath],
    ]));
    try {
      const store = new SpeechLiveStatusStore(root, config, () => now, () => true);
      const status = statusFixture();
      store.write(status);
      assert.deepEqual(store.read(), status);
      const raw = fs.readFileSync(store.statusPath, 'utf8');
      assert.equal(raw.includes(secretPath), false);
      assert.equal(raw.includes('token'), false);
      assert.equal(raw.includes('port'), false);

      config.inputEnabled = false;
      assert.equal(store.read(), null, '配置变化后不能复用旧 live capability');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects stale or dead-owner snapshots instead of treating ACTIVE as capability ready', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-live-stale-'));
    const config = loadSpeechRuntimeConfig(new Map());
    const writtenAt = new Date('2026-08-07T02:00:00.000Z');
    try {
      new SpeechLiveStatusStore(root, config, () => writtenAt, () => true, 60_000).write(statusFixture());
      const stale = new SpeechLiveStatusStore(
        root,
        config,
        () => new Date('2026-08-07T02:02:00.000Z'),
        () => true,
        60_000,
      );
      assert.equal(stale.read(), null);
      const dead = new SpeechLiveStatusStore(root, config, () => writtenAt, () => false, 60_000);
      assert.equal(dead.read(), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
