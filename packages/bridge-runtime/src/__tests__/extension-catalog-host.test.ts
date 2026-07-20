import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExtensionCatalogHost } from '../extension-catalog-host.js';
import type { ExtensionCatalogItemSummary } from 'claude-to-im/host';
import type { SkillLifecycleService } from '../skill-lifecycle.js';

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

  it('routes skill installation through lifecycle while leaving non-skill extensions on the legacy adapter', async () => {
    const lifecycleCalls: string[] = [];
    const lifecycle = makeLifecycle({
      prepareInstall: async () => {
        lifecycleCalls.push('prepare');
        return {
          nonce: 'skill-nonce',
          skillId: 'doc-helper',
          requiredRole: 'user',
          actor: { channelType: 'feishu', chatId: 'oc_1', userId: 'ou_1' },
          expiresAt: '2026-05-07T04:10:00.000Z',
          request: {
            id: 'doc-helper',
            sourceClass: 'official_curated',
            source: 'https://github.com/openai/skills/tree/main/skills/.curated/doc-helper',
            risk: 'low',
            changeKind: 'install',
            actor: { channelType: 'feishu', chatId: 'oc_1', userId: 'ou_1' },
          },
        };
      },
      confirmInstall: async () => {
        lifecycleCalls.push('confirm');
        return makeSkillRegistryItem('doc-helper');
      },
    });
    const host = createExtensionCatalogHost({
      ctiHome,
      lifecycle,
      request: async (_url: string, body: ControlRequest) => {
        calls.push(body);
        return { ok: true, data: { id: 'unity-mcp', displayName: 'Unity MCP', type: 'mcp' } };
      },
      nonceFactory: () => 'legacy-nonce',
      now: () => new Date('2026-05-07T04:00:00.000Z'),
    });
    const actor = { channelType: 'feishu', chatId: 'oc_1', userId: 'ou_1' };

    const skillPrepared = await host.prepareInstallAction({
      item: {
        ...makeItem('doc-helper', 'Doc Helper', 'skill'),
        source: 'https://github.com/openai/skills/tree/main/skills/.curated/doc-helper',
      },
      actor,
    });
    assert.equal(skillPrepared.nonce, 'skill:skill-nonce');
    assert.equal(calls.length, 0);
    await host.confirmInstallAction('skill:skill-nonce', actor);
    assert.deepEqual(lifecycleCalls, ['prepare', 'confirm']);
    assert.equal(calls.length, 0);

    const mcpItem = makeItem('unity-mcp', 'Unity MCP', 'mcp');
    const mcpPrepared = await host.prepareInstallAction({ item: mcpItem, actor });
    assert.equal(calls.length, 0);
    await host.confirmInstallAction(mcpPrepared.nonce || '', actor);
    assert.equal(calls[0].command, 'extension.remote.install');
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

function makeSkillRegistryItem(id: string) {
  return {
    id,
    displayName: id,
    sourceClass: 'official_curated' as const,
    state: 'enabled' as const,
    risk: 'low' as const,
    enabled: true,
    updatedAt: '2026-05-07T04:00:00.000Z',
  };
}

function makeLifecycle(overrides: Partial<SkillLifecycleService>): SkillLifecycleService {
  return {
    snapshot: () => ({ protocol: 'cti-skill-registry/v1', generatedAt: '2026-05-07T04:00:00.000Z', items: [] }),
    search: async () => [],
    createDraft: async () => makeSkillRegistryItem('draft'),
    validate: async (id) => makeSkillRegistryItem(id),
    prepareInstall: async () => makeSkillRegistryItem('installed'),
    confirmInstall: async () => makeSkillRegistryItem('installed'),
    setEnabled: async (id, enabled) => ({ ...makeSkillRegistryItem(id), state: enabled ? 'enabled' : 'disabled', enabled }),
    rollback: async (id) => makeSkillRegistryItem(id),
    ...overrides,
  };
}
