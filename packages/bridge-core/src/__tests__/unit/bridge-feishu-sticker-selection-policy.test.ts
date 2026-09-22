import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FeishuStickerRecord, FeishuStickerStore } from '../../lib/bridge/channels/feishu/stickers/sticker-store-schema.js';

async function loadStickerSelectionPolicy() {
  return await import('../../lib/bridge/channels/feishu/stickers/sticker-selection-policy.js');
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

describe('Feishu sticker selection policy', () => {
  it('requires specific trusted vision or manual semantics for automatic sending', async () => {
    const { hasReliableFeishuStickerSemantics } = await loadStickerSelectionPolicy();

    assert.equal(hasReliableFeishuStickerSemantics(sticker('vision_ok', {
      label: '挥手打招呼',
      annotationSource: 'vision',
      visionMediaFileKey: 'vision_ok',
      annotationConfidence: 0.8,
    })), true);
    assert.equal(hasReliableFeishuStickerSemantics(sticker('vision_missing_confidence', {
      label: '挥手打招呼',
      annotationSource: 'vision',
      visionMediaFileKey: 'vision_missing_confidence',
    })), false);
    assert.equal(hasReliableFeishuStickerSemantics(sticker('user_only', {
      annotationSource: 'user',
      userAnnotation: { label: '用户说这是挥手' },
    })), false);
    assert.equal(hasReliableFeishuStickerSemantics(sticker('manual_generic', {
      label: '表情包',
      usage: '用于聊天',
      annotationSource: 'manual',
    })), false);
  });

  it('matches colloquial Chinese particles and blocks avoidWhen contexts', async () => {
    const {
      feishuStickerTextOverlapScore,
      feishuStickerAvoidsContext,
    } = await loadStickerSelectionPolicy();
    const record = sticker('arrived', {
      label: '我来了',
      intent: '来啦来啦',
      avoidWhen: '严肃道歉',
      annotationSource: 'manual',
    });

    assert.ok(feishuStickerTextOverlapScore('来啦来啦', '我来了') >= 3);
    assert.equal(feishuStickerTextOverlapScore('表达愤怒', '表达难过'), 0);
    assert.equal(feishuStickerAvoidsContext(record, '这次需要严肃道歉'), true);
    assert.equal(feishuStickerAvoidsContext(record, '我来啦'), false);
  });

  it('resolves generic requests by semantic fit and rejects constrained mismatches', async () => {
    const { resolveFeishuStickerFileKey } = await loadStickerSelectionPolicy();
    const data = store([
      sticker('sticker_praise', {
        aliases: ['夸奖'], label: '点赞', intent: '夸奖做得好', tone: '开心',
        annotationSource: 'manual', chatId: 'oc_group',
      }),
      sticker('sticker_sad', {
        aliases: ['难过'], label: '流泪', intent: '表达难过', tone: '伤心',
        annotationSource: 'manual', chatId: 'oc_group',
      }),
    ]);

    assert.equal(resolveFeishuStickerFileKey(data, '表情包', {
      chatId: 'oc_group', contextText: '夸奖一下，做得好', nowMs: Date.parse('2026-07-20T02:00:00.000Z'),
    }), 'sticker_praise');
    assert.equal(resolveFeishuStickerFileKey(data, '表情包', {
      chatId: 'oc_group', contextText: '需要表达愤怒', nowMs: Date.parse('2026-07-20T02:00:00.000Z'),
    }), null);
    assert.equal(resolveFeishuStickerFileKey(data, '难过', {
      chatId: 'oc_group', contextText: '今天有点伤心', nowMs: Date.parse('2026-07-20T02:00:00.000Z'),
    }), 'sticker_sad');
  });

  it('throttles autonomous stickers per relevant chat while explicit requests can bypass upstream', async () => {
    const {
      canAutoSendFeishuSticker,
      FEISHU_AUTONOMOUS_STICKER_COOLDOWN_MS,
    } = await loadStickerSelectionPolicy();
    const nowMs = Date.parse('2026-07-20T02:00:00.000Z');
    const data = store([
      sticker('recent_same_chat', {
        chatId: 'oc_p2p',
        label: '挥手',
        annotationSource: 'manual',
        lastUsedAt: new Date(nowMs - 60_000).toISOString(),
      }),
      sticker('old_other_chat', {
        chatId: 'oc_other',
        label: '点赞',
        annotationSource: 'manual',
        lastUsedAt: new Date(nowMs - FEISHU_AUTONOMOUS_STICKER_COOLDOWN_MS * 2).toISOString(),
      }),
    ]);

    assert.equal(canAutoSendFeishuSticker(data, { chatId: 'oc_p2p', nowMs }), false);
    assert.equal(canAutoSendFeishuSticker(data, { chatId: 'oc_other', nowMs }), true);
    assert.equal(canAutoSendFeishuSticker(data, {
      chatId: 'oc_p2p',
      nowMs: nowMs + FEISHU_AUTONOMOUS_STICKER_COOLDOWN_MS,
    }), true);
  });

  it('never selects disabled, archived, avoided, user-only, or unknown exact keys', async () => {
    const { resolveFeishuStickerFileKey } = await loadStickerSelectionPolicy();
    const data = store([
      sticker('sticker_disabled', { label: '开心', annotationSource: 'manual', disabled: true }),
      sticker('sticker_archived', { label: '开心', annotationSource: 'manual', archived: true }),
      sticker('sticker_avoid', { label: '开心', annotationSource: 'manual', avoidWhen: '道歉' }),
      sticker('sticker_user', { aliases: ['开心'], annotationSource: 'user', userAnnotation: { label: '开心' } }),
    ]);

    assert.equal(resolveFeishuStickerFileKey(data, '表情包', { contextText: '现在要道歉' }), null);
    assert.equal(resolveFeishuStickerFileKey(data, '开心', { contextText: '开心一下' }), null);
    assert.equal(resolveFeishuStickerFileKey(data, 'file_v1_unknown', { contextText: '开心一下' }), null);
  });

  it('retains enriched records ahead of history-only shells and deduplicates by file key', async () => {
    const { compactFeishuStickerStoreRecords } = await loadStickerSelectionPolicy();
    const shells = Array.from({ length: 90 }, (_, index) => sticker(`shell_${index}`, {
      lastSeenAt: `2026-07-20T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
    }));
    const enriched = sticker('trusted', {
      label: '挥手', intent: '问候', annotationSource: 'manual',
      lastSeenAt: '2026-07-19T00:00:00.000Z',
    });
    const cached = sticker('cached', { mediaMimeType: 'image/png' });
    const duplicateWeak = sticker('trusted', { lastSeenAt: '2026-07-21T00:00:00.000Z' });

    const compacted = compactFeishuStickerStoreRecords([
      ...shells, duplicateWeak, enriched, cached,
    ], { hasCachedMedia: (fileKey) => fileKey === 'cached', maxRecords: 80 });

    assert.equal(compacted.length, 80);
    assert.ok(compacted.some((item) => item.fileKey === 'trusted' && item.label === '挥手'));
    assert.ok(compacted.some((item) => item.fileKey === 'cached'));
    assert.equal(compacted.filter((item) => item.fileKey === 'trusted').length, 1);
  });
});
