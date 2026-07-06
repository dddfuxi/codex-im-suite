import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readBindings,
  upsertBinding,
  removeBinding,
  findBindingByMvs,
  findBindingBySource,
} from '../mavis-session-store.js';

let tmpHome = '';

function withTmpHome(): void {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-mavis-bindings-'));
  process.env.CTI_HOME = tmpHome;
}

function cleanupTmpHome(): void {
  if (tmpHome && fs.existsSync(tmpHome)) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
  // Reset to default CTI_HOME so the test runner's shared home is restored
  // for other test files in the same `node --test` run.
  process.env.CTI_HOME = path.join(os.homedir(), '.claude-to-im');
  tmpHome = '';
}

const baseBinding = {
  bridgeSessionId: 'bridge-1',
  mvsSessionId: 'mvs_abc',
  agentName: 'mavis',
  createdAt: '2026-06-27T00:00:00.000Z',
  lastTurnAt: '2026-06-27T00:00:00.000Z',
  model: { provider_id: 'mavis', model_id: 'sonnet' },
};

describe('mavis session store', () => {
  beforeEach(withTmpHome);
  afterEach(cleanupTmpHome);

  it('writes and reads back a binding', () => {
    upsertBinding(baseBinding);
    const all = readBindings();
    assert.ok(all['bridge-1']);
    assert.equal(all['bridge-1'].mvsSessionId, 'mvs_abc');
  });

  it('upsert is idempotent and merges fields', () => {
    upsertBinding(baseBinding);
    upsertBinding({
      ...baseBinding,
      lastSeenMessageId: 'msg-1',
      lastSeenCommunicationId: 42,
      lastSeenCommunicationTimestamp: 1782820520193,
      lastFinalText: 'partial',
    });
    const all = readBindings();
    assert.equal(all['bridge-1'].lastSeenMessageId, 'msg-1');
    assert.equal(all['bridge-1'].lastSeenCommunicationId, 42);
    assert.equal(all['bridge-1'].lastSeenCommunicationTimestamp, 1782820520193);
    assert.equal(all['bridge-1'].lastFinalText, 'partial');
    assert.equal(all['bridge-1'].mvsSessionId, 'mvs_abc');
  });

  it('removes a binding by bridgeSessionId', () => {
    upsertBinding(baseBinding);
    removeBinding('bridge-1');
    assert.equal(readBindings()['bridge-1'], undefined);
  });

  it('finds a binding by mvsSessionId (reverse lookup)', () => {
    upsertBinding(baseBinding);
    upsertBinding({
      ...baseBinding,
      bridgeSessionId: 'bridge-2',
      mvsSessionId: 'mvs_xyz',
    });
    const found = findBindingByMvs('mvs_xyz');
    assert.ok(found);
    assert.equal(found.bridgeSessionId, 'bridge-2');
  });

  it('finds the newest binding by generic source channel identity', () => {
    upsertBinding({
      ...baseBinding,
      bridgeSessionId: 'bridge-old',
      channelType: 'feishu',
      feishuChatId: 'chat-1',
      createdAt: '2026-06-27T00:00:00.000Z',
      lastTurnAt: '2026-06-27T00:00:00.000Z',
    });
    upsertBinding({
      ...baseBinding,
      bridgeSessionId: 'bridge-newer',
      mvsSessionId: 'mvs_newer',
      channelType: 'feishu',
      feishuChatId: 'chat-1',
      createdAt: '2026-06-27T00:01:00.000Z',
      lastTurnAt: '2026-06-27T00:01:00.000Z',
    });

    const found = findBindingBySource({ channelType: 'feishu', chatId: 'chat-1' });
    assert.ok(found);
    assert.equal(found.bridgeSessionId, 'bridge-newer');
    assert.equal(found.mvsSessionId, 'mvs_newer');
  });

  it('rejects bindings with secret-like field names', () => {
    assert.throws(
      () => upsertBinding({
        ...baseBinding,
        authToken: 'should-not-be-allowed',
      } as unknown as typeof baseBinding),
      /forbidden secret-like field/,
    );
  });

  it('writes atomically via tmp + rename (no .tmp file lingering)', () => {
    upsertBinding(baseBinding);
    const filePath = path.join(tmpHome, 'runtime', 'mavis-session-bindings.json');
    assert.ok(fs.existsSync(filePath));
    assert.equal(fs.existsSync(`${filePath}.tmp`), false);
  });

  it('returns empty record when file does not exist', () => {
    assert.deepEqual(readBindings(), {});
  });

  it('survives a corrupt JSON file by returning empty record', () => {
    const filePath = path.join(tmpHome, 'runtime', 'mavis-session-bindings.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'this is not json', 'utf-8');
    assert.deepEqual(readBindings(), {});
  });
});
