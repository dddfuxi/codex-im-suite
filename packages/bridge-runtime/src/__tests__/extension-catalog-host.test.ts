import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExtensionCatalogHost } from '../extension-catalog-host.js';
import type { ExtensionCatalogItemSummary } from 'claude-to-im/src/lib/bridge/host.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-ext-host-'));
type ControlRequest = { command: string; payload: unknown };

describe('extension catalog host', () => {
  let ctiHome: string;
  let calls: Array<{ command: string; payload: unknown }>;

  beforeEach(() => {
    ctiHome = fs.mkdtempSync(path.join(tmpRoot, 'case-'));
    calls = [];
  });

  afterEach(() => {
    fs.rmSync(ctiHome, { recursive: true, force: true });
  });

  it('searches catalog items through Control API', async () => {
    const host = createExtensionCatalogHost({
      ctiHome,
      request: async (_url: string, body: ControlRequest) => {
        calls.push(body);
        return {
          ok: true,
          data: {
            items: [
              makeItem('ollama-qwen3-8b', 'Qwen3 8B'),
              makeItem('browser-use', 'Browser'),
            ],
          },
        };
      },
    });

    const found = await host.searchExtensions('qwen');

    assert.equal(found.length, 1);
    assert.equal(found[0].id, 'ollama-qwen3-8b');
    assert.equal(calls[0].command, 'extension.catalog.list');
  });

  it('persists install confirmation actions and calls install only when confirmed', async () => {
    const item = makeItem('browser-use', 'Browser', 'plugin');
    const host = createExtensionCatalogHost({
      ctiHome,
      request: async (_url: string, body: ControlRequest) => {
        calls.push(body);
        return {
          ok: true,
          data: { id: item.id, type: item.type, displayName: item.displayName, version: item.version },
        };
      },
      nonceFactory: () => 'nonce-1',
      now: () => new Date('2026-05-07T04:00:00.000Z'),
    });

    const prepared = await host.prepareInstallAction({
      item,
      actor: { channelType: 'feishu', chatId: 'oc_1', userId: 'ou_1', messageId: 'm_1' },
    });

    assert.equal(prepared.ok, true);
    assert.equal(prepared.nonce, 'nonce-1');
    assert.equal(calls.length, 0);

    const confirmed = await host.confirmInstallAction('nonce-1', {
      channelType: 'feishu',
      chatId: 'oc_1',
      userId: 'ou_1',
      messageId: 'm_2',
    });

    assert.equal(confirmed.ok, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      command: 'extension.remote.install',
      payload: { id: 'browser-use', allowUntrusted: false },
    });
  });

  it('rejects expired confirmations before calling Control API', async () => {
    const host = createExtensionCatalogHost({
      ctiHome,
      request: async (_url: string, body: ControlRequest) => {
        calls.push(body);
        return { ok: true, data: {} };
      },
      nonceFactory: () => 'expired',
      now: () => new Date('2026-05-07T04:00:00.000Z'),
    });
    await host.prepareInstallAction({
      item: makeItem('browser-use', 'Browser', 'plugin'),
      actor: { channelType: 'feishu', chatId: 'oc_1', userId: 'ou_1', messageId: 'm_1' },
    });

    const lateHost = createExtensionCatalogHost({
      ctiHome,
      request: async (_url: string, body: ControlRequest) => {
        calls.push(body);
        return { ok: true, data: {} };
      },
      now: () => new Date('2026-05-07T04:11:00.000Z'),
    });
    const confirmed = await lateHost.confirmInstallAction('expired', {
      channelType: 'feishu',
      chatId: 'oc_1',
      userId: 'ou_1',
      messageId: 'm_2',
    });

    assert.equal(confirmed.ok, false);
    assert.equal(confirmed.status, 'expired');
    assert.equal(calls.length, 0);
  });

  it('removes browser records through extension.remote.remove without touching plugin cache', async () => {
    const host = createExtensionCatalogHost({
      ctiHome,
      request: async (_url: string, body: ControlRequest) => {
        calls.push(body);
        return { ok: true, data: { removed: 'browser-use', type: 'plugin' } };
      },
      nonceFactory: () => 'remove-1',
      now: () => new Date('2026-05-07T04:00:00.000Z'),
    });
    await host.prepareRemoveAction({
      item: makeItem('browser-use', 'Browser', 'plugin'),
      actor: { channelType: 'feishu', chatId: 'oc_1', userId: 'ou_1', messageId: 'm_1' },
    });

    const confirmed = await host.confirmRemoveAction('remove-1', {
      channelType: 'feishu',
      chatId: 'oc_1',
      userId: 'ou_1',
      messageId: 'm_2',
    });

    assert.equal(confirmed.ok, true);
    assert.deepEqual(calls[0], {
      command: 'extension.remote.remove',
      payload: { id: 'browser-use', type: 'plugin' },
    });
  });
});

function makeItem(id: string, displayName: string, type: ExtensionCatalogItemSummary['type'] = 'model'): ExtensionCatalogItemSummary {
  return {
    id,
    type,
    displayName,
    version: '1.0.0',
    category: `${type}.test`,
    description: `${displayName} 描述`,
    installHandler: type === 'plugin' ? 'codex-plugin.record' : 'ollama.pull',
    source: id,
    installed: false,
    canRemove: type === 'plugin',
  };
}
