import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  FeishuStickerRecord,
  FeishuStickerStore,
} from '../../lib/bridge/channels/feishu/stickers/sticker-store-schema.js';

async function loadPolicy() {
  return await import('../../lib/bridge/channels/feishu/stickers/sticker-semantic-evolution-policy.js');
}

function sticker(fileKey: string, patch: Partial<FeishuStickerRecord> = {}): FeishuStickerRecord {
  return {
    fileKey,
    aliases: [],
    firstSeenAt: '2026-07-20T00:00:00.000Z',
    lastSeenAt: '2026-07-20T00:00:00.000Z',
    useCount: 0,
    ...patch,
  };
}

function store(stickers: FeishuStickerRecord[]): FeishuStickerStore {
  return { version: 1, updatedAt: '', stickers, deletedStickers: {} };
}

describe('Feishu sticker semantic evolution policy', () => {
  it('parses only explicit user explanations and keeps them as unverified evidence', async () => {
    const { parseFeishuStickerUserAnnotation } = await loadPolicy();

    assert.deepEqual(parseFeishuStickerUserAnnotation('这个表情包表示：无语吐槽，适合在朋友开玩笑时用'), {
      description: '无语吐槽',
      intent: '无语吐槽',
      tone: '朋友开玩笑时用',
      usage: '朋友开玩笑时用',
      annotationConfidence: 0.82,
    });
    assert.equal(parseFeishuStickerUserAnnotation('这个群是干什么的'), null);
    assert.equal(parseFeishuStickerUserAnnotation('这个表情包是什么意思？'), null);
  });

  it('binds reply explanations to the exact sticker and uses a recent unknown sticker only for explicit subjects', async () => {
    const { resolveFeishuStickerUserAnnotationTarget } = await loadPolicy();
    const records = [
      sticker('trusted', { chatId: 'oc_1', messageId: 'om_trusted', annotationSource: 'manual', label: '已核验' }),
      sticker('recent', { chatId: 'oc_1', messageId: 'om_recent', lastSeenAt: '2026-07-20T01:59:00.000Z' }),
      sticker('other', { chatId: 'oc_2', messageId: 'om_other', lastSeenAt: '2026-07-20T01:59:30.000Z' }),
    ];

    assert.equal(resolveFeishuStickerUserAnnotationTarget(records, {
      chatId: 'oc_1', replyToMessageId: 'om_trusted', text: '这个表示无语', nowMs: Date.parse('2026-07-20T02:00:00.000Z'),
    })?.fileKey, 'trusted');
    assert.equal(resolveFeishuStickerUserAnnotationTarget(records, {
      chatId: 'oc_1', text: '这个表情包表示无语', nowMs: Date.parse('2026-07-20T02:00:00.000Z'),
    })?.fileKey, 'recent');
    assert.equal(resolveFeishuStickerUserAnnotationTarget(records, {
      chatId: 'oc_1', text: '这个表示无语', nowMs: Date.parse('2026-07-20T02:00:00.000Z'),
    }), null);
  });

  it('never lets user evidence overwrite trusted semantics', async () => {
    const { evolveFeishuStickerAnnotation } = await loadPolicy();
    const original = store([sticker('fk_manual', {
      label: '鼓掌庆祝',
      intent: '称赞成功',
      annotationSource: 'manual',
      annotationConfidence: 0.95,
    })]);

    const result = evolveFeishuStickerAnnotation(original, {
      fileKey: 'fk_manual', chatId: 'oc_1', userId: 'ou_1', learnedFromMessageId: 'om_claim',
      label: '用户说这是生气', intent: '表达愤怒', source: 'user', annotationConfidence: 0.9,
    }, { nowIso: '2026-07-20T02:00:00.000Z' });

    assert.equal(result.accepted, true);
    assert.equal(result.record?.label, '鼓掌庆祝');
    assert.equal(result.record?.annotationSource, 'manual');
    assert.equal(result.record?.userAnnotation?.intent, '表达愤怒');
    assert.equal(original.stickers[0].userAnnotation, undefined);
  });

  it('accepts vision only for the actual media key and preserves manual priority', async () => {
    const { evolveFeishuStickerAnnotation } = await loadPolicy();
    const original = store([sticker('fk_one')]);

    const mismatch = evolveFeishuStickerAnnotation(original, {
      fileKey: 'fk_one', chatId: 'oc_1', label: '挥手', source: 'vision',
      visionMediaFileKey: 'fk_other', annotationConfidence: 0.9,
    }, { nowIso: '2026-07-20T02:00:00.000Z' });
    assert.equal(mismatch.accepted, false);
    assert.equal(mismatch.reason, 'vision_media_mismatch');
    assert.deepEqual(mismatch.store, original);

    const vision = evolveFeishuStickerAnnotation(original, {
      fileKey: 'fk_one', chatId: 'oc_1', label: '挥手问候', intent: '打招呼', source: 'vision',
      visionMediaFileKey: 'fk_one', annotationConfidence: 0.88,
    }, { nowIso: '2026-07-20T02:00:00.000Z' });
    assert.equal(vision.accepted, true);
    assert.equal(vision.record?.annotationSource, 'vision');
    assert.equal(vision.record?.visionMediaFileKey, 'fk_one');

    const manual = evolveFeishuStickerAnnotation(vision.store, {
      fileKey: 'fk_one', chatId: 'oc_1', label: '挥手告别', intent: '结束聊天', source: 'manual',
      annotationConfidence: 1,
    }, { nowIso: '2026-07-20T02:01:00.000Z' });
    const laterVision = evolveFeishuStickerAnnotation(manual.store, {
      fileKey: 'fk_one', chatId: 'oc_1', label: '错误覆盖', intent: '错误覆盖', source: 'vision',
      visionMediaFileKey: 'fk_one', annotationConfidence: 0.99,
    }, { nowIso: '2026-07-20T02:02:00.000Z' });
    assert.equal(laterVision.record?.label, '挥手告别');
    assert.equal(laterVision.record?.annotationSource, 'manual');
  });
});
