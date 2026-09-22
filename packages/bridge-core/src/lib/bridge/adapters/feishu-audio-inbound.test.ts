import assert from 'node:assert/strict';
import test from 'node:test';

import { initBridgeContext } from '../context.js';
import type { BridgeStore } from '../host.js';
import { FeishuAdapter, readBoundedFeishuResponseBody } from './feishu-adapter.js';

function createMockStore(): BridgeStore {
  return {
    getSetting: (key) => key === 'bridge_feishu_require_mention' ? 'false' : null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as never),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    createSession: () => ({ id: 'session-1', working_directory: '', model: '' } as never),
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    retrieveRelevantMemory: () => null,
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

type AudioTestAdapter = {
  processIncomingEvent(event: unknown): Promise<void>;
  consumeOne(): Promise<Record<string, any> | null>;
  downloadResource(...args: unknown[]): Promise<Record<string, unknown> | null>;
  resolveChatDisplayName(...args: unknown[]): Promise<string>;
  persistChatIndex(...args: unknown[]): void;
  syncIndexedChatHistory(...args: unknown[]): Promise<void>;
};

function createAudioTestAdapter(downloadResult: Record<string, unknown> | null): AudioTestAdapter {
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  initBridgeContext({
    store: createMockStore(),
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
  const adapter = new FeishuAdapter() as unknown as AudioTestAdapter;
  adapter.downloadResource = async () => downloadResult;
  adapter.resolveChatDisplayName = async () => '语音测试群';
  adapter.persistChatIndex = () => {};
  adapter.syncIndexedChatHistory = async () => {};
  return adapter;
}

const validAudioAttachment = {
    id: 'attachment-audio-1',
    name: 'voice.ogg',
    type: 'audio/ogg',
    size: 8,
    data: Buffer.from('OggSdata').toString('base64'),
};

function buildAudioEvent(content: string, messageId = 'om_audio_1'): unknown {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
    message: {
      message_id: messageId,
      chat_id: 'oc_audio',
      chat_type: 'group',
      message_type: 'audio',
      content,
      create_time: String(Date.now()),
    },
  };
}

test('当前真实飞书语音显式标记 feishu_audio 并绑定同一 message_id/file_key/attachmentId', async () => {
  const adapter = createAudioTestAdapter(validAudioAttachment);
  await adapter.processIncomingEvent(buildAudioEvent(JSON.stringify({ file_key: 'file_audio_1' })));

  const inbound = await adapter.consumeOne();
  assert.ok(inbound);
  assert.equal(inbound.messageKind, 'feishu_audio');
  assert.equal(inbound.raw.messageKind, 'feishu_audio');
  assert.deepEqual(inbound.raw.feishuInboundAudio, {
    protocol: 'cti-feishu-inbound-audio/v1',
    messageId: 'om_audio_1',
    fileKey: 'file_audio_1',
    attachmentId: 'attachment-audio-1',
    messageType: 'audio',
  });
});

test('飞书语音下载失败仍保留 audio 事件身份，但不签发伪造附件 evidence', async () => {
  const adapter = createAudioTestAdapter(null);
  await adapter.processIncomingEvent(buildAudioEvent(JSON.stringify({ file_key: 'file_audio_2' }), 'om_audio_2'));

  const inbound = await adapter.consumeOne();
  assert.ok(inbound);
  assert.equal(inbound.messageKind, 'feishu_audio');
  assert.equal(inbound.raw.messageKind, 'feishu_audio');
  assert.equal(inbound.raw.feishuInboundAudio, undefined);
  assert.deepEqual(inbound.attachments, []);
  assert.match(inbound.text, /audio download failed/u);
});

test('飞书语音缺少 file_key 仍入队失败关闭，且不创建附件或成功 evidence', async () => {
  const adapter = createAudioTestAdapter(validAudioAttachment);
  await adapter.processIncomingEvent(buildAudioEvent('{}', 'om_audio_missing_key'));

  const inbound = await adapter.consumeOne();
  assert.ok(inbound);
  assert.equal(inbound.messageKind, 'feishu_audio');
  assert.equal(inbound.raw.messageKind, 'feishu_audio');
  assert.equal(inbound.raw.feishuInboundAudio, undefined);
  assert.deepEqual(inbound.attachments, []);
  assert.equal(inbound.text, '');
});

test('回复中的 m4a 文件按真实文件头恢复为可克隆音频 evidence', async () => {
  const adapter = new FeishuAdapter() as any;
  adapter.downloadResource = async () => adapter.buildDownloadedResourceAttachment(
    'file_m4a_1',
    'file',
    Buffer.concat([Buffer.from('....ftypM4A ', 'ascii'), Buffer.alloc(120)]),
  );
  const result = await adapter.downloadAttachmentsFromMessageItem({
    message_id: 'om_reply_m4a',
    chat_id: 'oc_audio',
    create_time: String(Date.now()),
    msg_type: 'file',
    body: { content: JSON.stringify({ file_key: 'file_m4a_1' }) },
    sender: { id: 'ou_owner', sender_type: 'user' },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'audio/mp4');
  result[0].id = 'reply-m4a-1';

  const raw = {
    feishuReplyTo: { messageId: 'om_reply_m4a', attachmentCount: 1 },
    feishuNativeReplyAttachments: [{
      protocol: 'cti-feishu-native-reply-attachment/v1',
      relation: 'native_reply',
      sourceMessageId: 'om_request_m4a',
      messageId: 'om_reply_m4a',
      fileKey: 'file_m4a_1',
      resourceType: 'audio',
      attachmentId: 'reply-m4a-1',
    }],
  };
  const { resolveTrustedNativeReplyAudio } = await import('../application/speech-policy.js');
  const resolved = resolveTrustedNativeReplyAudio({
    channelType: 'feishu',
    sourceMessageId: 'om_request_m4a',
    raw,
    attachments: result,
  });
  assert.equal(resolved?.attachment.id, 'reply-m4a-1');
  assert.equal((resolved?.evidence as { resourceType?: string }).resourceType, 'audio');
});

test('飞书 HTTP 资源下载先检查 Content-Length，并对伪造小长度继续执行流式上限', async () => {
  let oversizedPulled = false;
  const oversized = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      oversizedPulled = true;
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  }), { headers: { 'content-length': '99' } });
  await assert.rejects(readBoundedFeishuResponseBody(oversized, 4), /resource_download_too_large/);
  assert.equal(oversizedPulled, false);

  const forgedSmallLength = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6]));
      controller.close();
    },
  }), { headers: { 'content-length': '1' } });
  await assert.rejects(readBoundedFeishuResponseBody(forgedSmallLength, 4), /resource_download_too_large/);

  const valid = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } });
  assert.deepEqual(await readBoundedFeishuResponseBody(valid, 4), Buffer.from([1, 2, 3]));
});
