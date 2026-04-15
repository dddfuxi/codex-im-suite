import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initBridgeContext } from '../../lib/bridge/context.js';
import type { BridgeStore } from '../../lib/bridge/host.js';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter.js';

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

describe('FeishuAdapter outbound image markers', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
    initBridgeContext({
      store: createMockStore({
        bridge_feishu_app_id: 'app-id',
        bridge_feishu_app_secret: 'app-secret',
      }) as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
  });

  it('strips image markers from text and sends local image separately', async () => {
    const adapter = new FeishuAdapter();
    const sentMessages: Array<{ msg_type: string; content: string }> = [];
    const tmpImagePath = path.join(os.tmpdir(), `cti-feishu-test-${Date.now()}.png`);
    fs.writeFileSync(tmpImagePath, Buffer.from('png'));

    try {
      (adapter as any).restClient = {
        im: {
          message: {
            create: async ({ data }: { data: { msg_type: string; content: string } }) => {
              sentMessages.push({ msg_type: data.msg_type, content: data.content });
              return { data: { message_id: `msg-${sentMessages.length}` } };
            },
          },
        },
      };

      (adapter as any).uploadImage = async (localPath: string) => {
        assert.equal(localPath, tmpImagePath);
        return 'img-key-1';
      };

      const result = await adapter.send({
        address: { channelType: 'feishu', chatId: 'chat-1' },
        text: `已完成标注。\n[[CTI_IMAGE:${tmpImagePath}]]`,
        parseMode: 'plain',
      });

      assert.equal(result.ok, true);
      assert.equal(sentMessages.length, 2);
      assert.equal(sentMessages[0].msg_type, 'post');
      assert.match(sentMessages[0].content, /已完成标注/u);
      assert.equal(sentMessages[1].msg_type, 'image');
      assert.equal(sentMessages[1].content, JSON.stringify({ image_key: 'img-key-1' }));
    } finally {
      try { fs.unlinkSync(tmpImagePath); } catch {}
    }
  });
});
