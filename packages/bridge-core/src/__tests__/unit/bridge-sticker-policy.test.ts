import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addFeishuStickerHintForExplicitRequest,
  buildStickerChatPrompt,
  extractStickerAnnotationFromReply,
  extractStickerCandidateAnalysisFromReply,
  isExplicitStickerSendRequest,
  isGenericSingleStickerSendRequest,
  resolveTurnScopedAttachedStickerSelection,
  suppressFeishuStickerHintForInboundStickerReply,
} from '../../lib/bridge/application/stickers.js';

describe('bridge sticker policy', () => {
  it('distinguishes a direct single-sticker send from explanation, negative, and multi-send text', () => {
    assert.equal(isExplicitStickerSendRequest('发个表情包'), true);
    assert.equal(isGenericSingleStickerSendRequest('随便来一个表情包'), true);
    assert.equal(isExplicitStickerSendRequest('解释一下这个表情包是什么意思'), false);
    assert.equal(isExplicitStickerSendRequest('不要发表情包'), false);
    assert.equal(isGenericSingleStickerSendRequest('发两个表情包'), false);
  });

  it('keeps inbound stickers from becoming outbound sticker actions', () => {
    assert.equal(
      suppressFeishuStickerHintForInboundStickerReply('[表情包:file_key] 哈哈，我懂了'),
      '哈哈，我懂了',
    );
    assert.equal(suppressFeishuStickerHintForInboundStickerReply('[表情包]'), '收到这个表情包了。');
    assert.match(buildStickerChatPrompt('', false), /不要凭 file_key 猜具体图案/u);
  });

  it('adds only trusted exact hints and blocks placeholder-only replies without semantic authorization', () => {
    assert.equal(
      addFeishuStickerHintForExplicitRequest('发个表情包', '来啦', 'sticker_123'),
      '[表情包:sticker_123] 来啦',
    );
    assert.equal(
      addFeishuStickerHintForExplicitRequest('发个表情包', '[表情包] 给你一个', '', { allowBareFallback: false }),
      '这个表情包候选还没有可靠语义，我先不乱发。',
    );
  });

  it('parses current-sticker annotations without exposing machine-only protocol text', () => {
    const result = extractStickerAnnotationFromReply([
      '这个表情是在吐槽。',
      '```cti-sticker-annotation',
      JSON.stringify({
        fileKey: 'fk_current',
        label: '无语吐槽',
        description: '角色摊手并露出无语表情',
        confidence: 0.82,
      }),
      '```',
    ].join('\n'), 'fk_current');

    assert.equal(result.text, '这个表情是在吐槽。');
    assert.deepEqual(result.annotation, {
      fileKey: 'fk_current',
      label: '无语吐槽',
      description: '角色摊手并露出无语表情',
      annotationConfidence: 0.82,
    });
  });

  it('authorizes candidate selection only for attached keys with confident specific semantics', () => {
    const result = extractStickerCandidateAnalysisFromReply([
      '我选这个。',
      '```cti-sticker-candidate-analysis',
      JSON.stringify({
        selectedFileKey: 'fk_good',
        annotations: [
          { fileKey: 'fk_good', label: '开心鼓掌', description: '人物鼓掌庆祝', confidence: 0.9 },
          { fileKey: 'fk_generic', label: '表情包', description: '用于聊天', confidence: 0.99 },
          { fileKey: 'fk_other', label: '偷笑', description: '角色捂嘴偷笑', confidence: 0.95 },
        ],
      }),
      '```',
    ].join('\n'), ['fk_good', 'fk_generic']);

    assert.equal(result.text, '我选这个。');
    assert.equal(result.selectedFileKey, 'fk_good');
    assert.deepEqual(result.annotations.map((item) => item.fileKey), ['fk_good', 'fk_generic']);
  });

  it('allows one turn-scoped attached choice only when no analysis block was attempted', () => {
    assert.equal(resolveTurnScopedAttachedStickerSelection(
      '随便发一个表情包',
      '[表情包:fk_one] 给你。',
      { annotations: [], hasAnalysisBlock: false, text: '给你。' },
      ['fk_one'],
    ), 'fk_one');
    assert.equal(resolveTurnScopedAttachedStickerSelection(
      '随便发一个表情包',
      '[表情包:fk_one] 给你。',
      { annotations: [], hasAnalysisBlock: true, text: '给你。' },
      ['fk_one'],
    ), '');
  });
});
