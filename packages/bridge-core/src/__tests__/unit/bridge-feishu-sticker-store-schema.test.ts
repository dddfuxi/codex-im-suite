import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function loadStickerStoreSchema() {
  return await import('../../lib/bridge/channels/feishu/stickers/sticker-store-schema.js');
}

describe('Feishu sticker store schema', () => {
  it('normalizes tombstones and history backfills without trusting malformed entries', async () => {
    const { normalizeFeishuStickerStore } = await loadStickerStoreSchema();
    const store = normalizeFeishuStickerStore({
      version: 1,
      updatedAt: '2026-07-20T00:00:00.000Z',
      stickers: [
        {
          fileKey: '   ', aliases: [], firstSeenAt: '', lastSeenAt: '', useCount: 0,
        },
        {
          fileKey: ' sticker_valid ', aliases: [], firstSeenAt: '', lastSeenAt: '', useCount: 0,
        },
      ],
      deletedStickers: {
        ' sticker_deleted ': { deletedAt: '2026-07-19T00:00:00.000Z', source: ' control-panel ' },
        invalid: { deletedAt: '' },
      },
      historyBackfills: {
        oc_group: { chatId: '', completedAt: '2026-07-20T00:00:00.000Z', candidateCount: '3' as unknown as number },
        invalid: null as never,
      },
    });

    assert.deepEqual(store.deletedStickers, {
      sticker_deleted: { deletedAt: '2026-07-19T00:00:00.000Z', source: 'control-panel' },
    });
    assert.deepEqual(store.stickers.map((item) => item.fileKey), ['sticker_valid']);
    assert.deepEqual(store.historyBackfills, {
      oc_group: {
        chatId: 'oc_group',
        latestMessageTime: undefined,
        completedAt: '2026-07-20T00:00:00.000Z',
        candidateCount: 3,
      },
    });
  });

  it('drops mojibake semantics and bounds lists and confidence', async () => {
    const { sanitizeFeishuStickerRecord } = await loadStickerStoreSchema();
    const record = sanitizeFeishuStickerRecord({
      fileKey: 'sticker_clean',
      aliases: ['挥手', '琛ㄦ儏???', ...Array.from({ length: 25 }, (_, index) => `别名${index}`)],
      label: '琛ㄦ儏???',
      intent: '  打招呼  ',
      examples: ['早上好', '锟斤拷', ...Array.from({ length: 10 }, (_, index) => `例子${index}`)],
      annotationConfidence: 2,
      annotationSource: 'manual',
      firstSeenAt: '2026-07-20T00:00:00.000Z',
      lastSeenAt: '2026-07-20T00:00:00.000Z',
      useCount: 0,
    });

    assert.equal(record.label, undefined);
    assert.equal(record.intent, '打招呼');
    assert.equal(record.annotationConfidence, 1);
    assert.equal(record.aliases.length, 20);
    assert.ok(!record.aliases.some((item) => item.includes('琛ㄦ儏')));
    assert.equal((record.examples ?? []).length, 8);
    assert.ok(!(record.examples ?? []).some((item) => item.includes('锟')));
  });

  it('downgrades vision semantics when the analyzed media key does not match the record', async () => {
    const { sanitizeFeishuStickerRecord } = await loadStickerStoreSchema();
    const record = sanitizeFeishuStickerRecord({
      fileKey: 'sticker_target',
      aliases: ['挥手'],
      label: '挥手打招呼',
      intent: '问候',
      annotationSource: 'vision',
      visionMediaFileKey: 'sticker_other',
      annotationConfidence: 0.96,
      annotationVerifiedAt: '2026-07-20T00:00:00.000Z',
      firstSeenAt: '2026-07-20T00:00:00.000Z',
      lastSeenAt: '2026-07-20T00:00:00.000Z',
      useCount: 0,
    });

    assert.equal(record.annotationSource, undefined);
    assert.equal(record.label, undefined);
    assert.equal(record.intent, undefined);
    assert.equal(record.annotationConfidence, undefined);
    assert.equal(record.annotationVerifiedAt, undefined);
  });

  it('migrates legacy text-taught semantics into unverified user evidence', async () => {
    const { sanitizeFeishuStickerRecord } = await loadStickerStoreSchema();
    const record = sanitizeFeishuStickerRecord({
      fileKey: 'sticker_user_taught',
      aliases: ['疑惑'],
      label: '疑惑脸',
      intent: '表示不理解',
      learnedFromMessageId: 'om_explanation',
      messageId: 'om_sticker',
      userId: 'ou_user',
      annotationConfidence: 0.9,
      annotationUpdatedAt: '2026-07-20T00:00:00.000Z',
      firstSeenAt: '2026-07-20T00:00:00.000Z',
      lastSeenAt: '2026-07-20T00:00:00.000Z',
      useCount: 0,
    });

    assert.equal(record.annotationSource, 'user');
    assert.equal(record.label, undefined);
    assert.equal(record.intent, undefined);
    assert.deepEqual(record.userAnnotation, {
      label: '疑惑脸',
      intent: '表示不理解',
      aliases: ['疑惑'],
      annotationConfidence: 0.9,
      learnedFromMessageId: 'om_explanation',
      userId: 'ou_user',
      updatedAt: '2026-07-20T00:00:00.000Z',
    });
  });

  it('keeps archive timestamps only for archived records', async () => {
    const { sanitizeFeishuStickerRecord } = await loadStickerStoreSchema();
    const base = {
      fileKey: 'sticker_archive',
      aliases: [],
      firstSeenAt: '2026-07-20T00:00:00.000Z',
      lastSeenAt: '2026-07-20T00:00:00.000Z',
      useCount: 0,
    };

    assert.equal(sanitizeFeishuStickerRecord({ ...base, archived: false, archivedAt: 'old' }).archivedAt, undefined);
    assert.equal(sanitizeFeishuStickerRecord({ ...base, archived: true, archivedAt: 'kept' }).archivedAt, 'kept');
  });
});
