import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function loadAttachmentRecoveryModule() {
  return await import('../../lib/bridge/channels/feishu/history/attachment-recovery.js');
}

describe('Feishu history attachment recovery plan', () => {
  it('binds image and sticker recovery to the exact replied message resource', async () => {
    const { buildFeishuHistoryAttachmentRecoveryPlan } = await loadAttachmentRecoveryModule();

    for (const messageType of ['image', 'sticker']) {
      assert.deepEqual(buildFeishuHistoryAttachmentRecoveryPlan({
        messageId: 'om_replied_media',
        messageType,
        fileKey: 'img_exact_reply',
      }), [{
        messageId: 'om_replied_media',
        fileKey: 'img_exact_reply',
        resourceType: 'image',
      }]);
    }
  });

  it('preserves Feishu file-like resource types for platform download handling', async () => {
    const { buildFeishuHistoryAttachmentRecoveryPlan } = await loadAttachmentRecoveryModule();

    assert.deepEqual(
      ['file', 'audio', 'video', 'media'].map((messageType) => (
        buildFeishuHistoryAttachmentRecoveryPlan({
          messageId: `om_${messageType}`,
          messageType,
          fileKey: `key_${messageType}`,
        })[0]
      )),
      [
        { messageId: 'om_file', fileKey: 'key_file', resourceType: 'file' },
        { messageId: 'om_audio', fileKey: 'key_audio', resourceType: 'audio' },
        { messageId: 'om_video', fileKey: 'key_video', resourceType: 'video' },
        { messageId: 'om_media', fileKey: 'key_media', resourceType: 'media' },
      ],
    );
  });

  it('recovers post images in source order without duplicate downloads', async () => {
    const { buildFeishuHistoryAttachmentRecoveryPlan } = await loadAttachmentRecoveryModule();

    assert.deepEqual(buildFeishuHistoryAttachmentRecoveryPlan({
      messageId: 'om_post',
      messageType: 'post',
      imageKeys: ['img_first', 'img_first', ' ', 'img_second'],
    }), [
      { messageId: 'om_post', fileKey: 'img_first', resourceType: 'image' },
      { messageId: 'om_post', fileKey: 'img_second', resourceType: 'image' },
    ]);
  });

  it('recovers interactive images before files and never promotes the same key twice', async () => {
    const { buildFeishuHistoryAttachmentRecoveryPlan } = await loadAttachmentRecoveryModule();

    assert.deepEqual(buildFeishuHistoryAttachmentRecoveryPlan({
      messageId: 'om_card',
      messageType: 'interactive',
      imageKeys: ['shared_key', 'img_only'],
      fileKeys: ['shared_key', 'file_only'],
    }), [
      { messageId: 'om_card', fileKey: 'shared_key', resourceType: 'image' },
      { messageId: 'om_card', fileKey: 'img_only', resourceType: 'image' },
      { messageId: 'om_card', fileKey: 'file_only', resourceType: 'file' },
    ]);
  });

  it('fails closed when the message identity or recoverable resource evidence is missing', async () => {
    const { buildFeishuHistoryAttachmentRecoveryPlan } = await loadAttachmentRecoveryModule();

    assert.deepEqual(buildFeishuHistoryAttachmentRecoveryPlan({
      messageId: '',
      messageType: 'image',
      fileKey: 'img_without_message',
    }), []);
    assert.deepEqual(buildFeishuHistoryAttachmentRecoveryPlan({
      messageId: 'om_text',
      messageType: 'text',
      fileKey: 'untrusted_key',
      imageKeys: ['untrusted_image'],
      fileKeys: ['untrusted_file'],
    }), []);
  });
});
