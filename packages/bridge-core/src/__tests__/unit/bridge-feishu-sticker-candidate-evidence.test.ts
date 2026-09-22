import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FeishuStickerRecord } from '../../lib/bridge/channels/feishu/stickers/sticker-store-schema.js';

async function loadEvidence() {
  return await import('../../lib/bridge/channels/feishu/stickers/sticker-candidate-evidence.js');
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

describe('Feishu sticker candidate evidence', () => {
  it('ranks current-chat trusted candidates before recent unverified shells', async () => {
    const { rankFeishuStickerEvidenceRecords } = await loadEvidence();
    const ranked = rankFeishuStickerEvidenceRecords([
      sticker('recent_shell', { chatId: 'oc_1', lastSeenAt: '2026-07-20T03:00:00.000Z' }),
      sticker('trusted_other', { chatId: 'oc_2', label: '鼓掌', annotationSource: 'manual' }),
      sticker('trusted_current', { chatId: 'oc_1', label: '挥手', annotationSource: 'manual' }),
      sticker('disabled', { chatId: 'oc_1', label: '开心', annotationSource: 'manual', disabled: true }),
    ], { chatId: 'oc_1', limit: 80 });

    assert.deepEqual(ranked.map((item) => item.fileKey), ['trusted_current', 'recent_shell', 'trusted_other']);
  });

  it('builds bounded candidate evidence without promoting user claims to visual facts', async () => {
    const {
      buildFeishuStickerLibraryPrompt,
      summarizeFeishuStickerCandidate,
    } = await loadEvidence();
    const candidate = summarizeFeishuStickerCandidate(sticker('fk_one', {
      chatId: 'oc_1', label: '视觉挥手', intent: '问候', annotationSource: 'vision',
      annotationConfidence: 0.88, visionMediaFileKey: 'fk_one',
      userAnnotation: { label: '用户说这是生气', intent: '表达愤怒' },
    }), true);
    const prompt = buildFeishuStickerLibraryPrompt({
      requestText: '发个问候表情包',
      chatId: 'oc_1',
      candidates: [candidate],
      attachedFileKeys: ['fk_one'],
      candidateLimit: 4,
      minimumVisionConfidence: 0.45,
    });

    assert.match(prompt, /fileKey=fk_one; image=attached; chat=current/u);
    assert.match(prompt, /source=vision; confidence=0\.88/u);
    assert.match(prompt, /old aliases.*user-provided explanations are retrieval evidence, not visual facts/u);
    assert.doesNotMatch(prompt, /用户说这是生气|表达愤怒/u);
  });
});
