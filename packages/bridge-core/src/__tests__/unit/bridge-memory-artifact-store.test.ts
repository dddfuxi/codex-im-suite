import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initBridgeContext } from '../../lib/bridge/context.js';
import type { BridgeStore } from '../../lib/bridge/host.js';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter.js';
import { MemoryArtifactStore, createBridgeMemoryArtifactStore } from '../../lib/bridge/memory-artifact-store.js';

function createMockStore(settings: Record<string, string> = {}) {
  return {
    getSetting: (key: string) => settings[key] ?? null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    createSession: () => ({ id: '1', working_directory: '', model: '' }),
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: () => {},
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

function setupContext(settings: Record<string, string> = {}) {
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  initBridgeContext({
    store: createMockStore(settings) as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
}

function useTempRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.resolve(dir);
}

describe('MemoryArtifactStore', () => {
  beforeEach(() => {
    delete process.env.CTI_MEMORY_REPO_DIR;
    process.env.CTI_HOME = useTempRoot('cti-memory-artifacts-home-');
    setupContext();
  });

  it('resolves long-term IM artifacts under the memory repository', () => {
    const memoryRoot = useTempRoot('cti-memory-artifacts-repo-');
    const artifacts = new MemoryArtifactStore(memoryRoot);

    assert.equal(
      artifacts.feishuStickerStorePath(),
      path.join(memoryRoot, 'data', 'im', 'feishu', 'stickers', 'stickers.json'),
    );
    assert.equal(
      artifacts.feishuStickerMediaDirPath(),
      path.join(memoryRoot, 'data', 'im', 'feishu', 'stickers', 'media'),
    );
    assert.equal(
      artifacts.feishuChatSummaryDirPath(),
      path.join(memoryRoot, 'data', 'im', 'feishu', 'summaries'),
    );
    assert.equal(
      artifacts.projectFactsPath(),
      path.join(memoryRoot, 'data', 'projects', 'facts.json'),
    );
  });

  it('uses bridge_memory_repo_dir settings instead of CTI_HOME data for bridge artifacts', () => {
    const ctiHome = useTempRoot('cti-memory-artifacts-home-');
    const memoryRoot = useTempRoot('cti-memory-artifacts-repo-');
    process.env.CTI_HOME = ctiHome;
    setupContext({ bridge_memory_repo_dir: memoryRoot });

    const artifacts = createBridgeMemoryArtifactStore();

    assert.equal(artifacts.root, memoryRoot);
    assert.equal(
      artifacts.feishuStickerStorePath(),
      path.join(memoryRoot, 'data', 'im', 'feishu', 'stickers', 'stickers.json'),
    );
    assert.ok(!artifacts.feishuStickerStorePath().startsWith(path.join(ctiHome, 'data')));
  });

  it('persists Feishu sticker records and reads existing media from memory artifacts only', async () => {
    const ctiHome = useTempRoot('cti-memory-artifacts-home-');
    const memoryRoot = useTempRoot('cti-memory-artifacts-repo-');
    process.env.CTI_HOME = ctiHome;
    process.env.CTI_MEMORY_REPO_DIR = memoryRoot;
    setupContext();

    const artifacts = new MemoryArtifactStore(memoryRoot);
    fs.mkdirSync(artifacts.feishuStickerMediaDirPath(), { recursive: true });
    fs.writeFileSync(
      path.join(artifacts.feishuStickerMediaDirPath(), MemoryArtifactStore.stableFileName('sticker_file_key', '.png')),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    let downloadCount = 0;
    const adapter = new FeishuAdapter() as any;
    adapter.resolveChatDisplayName = async () => 'private chat';
    adapter.persistChatIndex = () => {};
    adapter.reconcileP2pAliasBinding = () => {};
    adapter.syncIndexedChatHistory = async () => {};
    adapter.restClient = {
      im: {
        messageResource: {
          get: async () => {
            downloadCount += 1;
            throw new Error('sticker resources should not be downloaded');
          },
        },
      },
    };

    await adapter.processIncomingEvent({
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_user' },
      },
      message: {
        message_id: 'om_sticker',
        chat_id: 'oc_chat',
        chat_type: 'p2p',
        message_type: 'sticker',
        content: JSON.stringify({ file_key: 'sticker_file_key' }),
        create_time: '1710000000000',
      },
    });

    const inbound = await adapter.consumeOne();
    const oldStorePath = path.join(ctiHome, 'data', 'feishu-stickers.json');
    const oldMediaDir = path.join(ctiHome, 'data', 'feishu-sticker-cache');
    const store = JSON.parse(fs.readFileSync(artifacts.feishuStickerStorePath(), 'utf8'));
    const mediaFiles = fs.readdirSync(artifacts.feishuStickerMediaDirPath());

    assert.equal(inbound?.messageKind, 'feishu_sticker_image');
    assert.equal(downloadCount, 0);
    assert.equal(store.stickers[0].fileKey, 'sticker_file_key');
    assert.equal(mediaFiles.length, 1);
    assert.equal(fs.existsSync(oldStorePath), false);
    assert.equal(fs.existsSync(oldMediaDir), false);
  });
});
