import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildStickerExpressionPromptSection } from '../sticker-semantics/prompt-section.js';
import type { StickerSemanticRevisionV1, StickerSemanticSnapshot } from '../sticker-semantics/types.js';

function revision(input: Partial<StickerSemanticRevisionV1> & Pick<StickerSemanticRevisionV1, 'revisionId' | 'fileKey' | 'scope' | 'status'>): StickerSemanticRevisionV1 {
  return {
    schema: 'codex-im-suite/sticker-semantic-revision/v1',
    versionId: `${input.revisionId}-version`,
    baseHash: 'a'.repeat(64),
    patch: {},
    supportEvidenceHashes: ['evidenceHash-secret'],
    contradictionEvidenceHashes: [],
    supportSessionIds: ['session-secret'],
    contradictionSessionIds: [],
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...input,
  };
}

function snapshot(): StickerSemanticSnapshot {
  return {
    schema: 'codex-im-suite/sticker-semantic-snapshot/v1',
    generatedAt: '2026-07-20T00:00:00.000Z',
    baseHash: 'b'.repeat(64),
    assets: [
      { fileKey: 'file-1', label: '庆祝猫', aliases: ['庆祝'], archived: false, disabled: false, visual: { source: 'vision', description: '猫咪庆祝' } },
      { fileKey: 'file-2', label: '归档猫', aliases: ['归档'], archived: true, disabled: false, visual: { source: 'vision', description: '不应出现' } },
      { fileKey: 'file-3', label: '未核验猫', aliases: ['未核验'], archived: false, disabled: false, visual: { source: 'unverified' } },
    ],
    revisions: [
      revision({ revisionId: 'global-1', fileKey: 'file-1', scope: 'global', status: 'confirmed', patch: { usage: '全局基础语义' } }),
      revision({ revisionId: 'chat-a', fileKey: 'file-1', scope: 'chat', scopeId: 'chat-a', status: 'trial', patch: { tone: '当前群聊覆盖' } }),
      revision({ revisionId: 'chat-b', fileKey: 'file-1', scope: 'chat', scopeId: 'chat-b', status: 'confirmed', patch: { tone: '其他群聊秘密' } }),
      revision({ revisionId: 'user-a', fileKey: 'file-1', scope: 'user', scopeId: 'user-a', status: 'confirmed', patch: { intent: '当前用户偏好' } }),
      revision({ revisionId: 'regressed-1', fileKey: 'file-1', scope: 'global', status: 'regressed', patch: { aliases: ['regressed-alias'] } }),
      revision({ revisionId: 'rejected-1', fileKey: 'file-1', scope: 'global', status: 'rejected', patch: { aliases: ['rejected-alias'] } }),
      revision({ revisionId: 'archived-1', fileKey: 'file-2', scope: 'global', status: 'confirmed', patch: { aliases: ['archived-alias'] } }),
      revision({ revisionId: 'unverified-1', fileKey: 'file-3', scope: 'global', status: 'confirmed', patch: { aliases: ['unverified-alias'] } }),
    ],
    deliveries: [],
  };
}

describe('sticker semantic prompt section', () => {
  it('composes global then matching chat then matching user semantics', () => {
    const section = buildStickerExpressionPromptSection({ snapshot: snapshot(), chatId: 'chat-a', userId: 'user-a', maxChars: 2400 });
    assert.ok(section);
    const content = section.content;
    assert.ok(content.indexOf('全局基础语义') < content.indexOf('当前群聊覆盖'));
    assert.ok(content.indexOf('当前群聊覆盖') < content.indexOf('当前用户偏好'));
    assert.doesNotMatch(content, /其他群聊秘密|chat-b|user-b/u);
  });

  it('excludes regressed rejected archived and unverified semantics without leaking ids', () => {
    const section = buildStickerExpressionPromptSection({ snapshot: snapshot(), chatId: 'chat-a', userId: 'user-a', maxChars: 2400 });
    assert.ok(section);
    assert.doesNotMatch(section.content, /regressed-alias|rejected-alias|archived-alias|unverified-alias/u);
    assert.doesNotMatch(section.content, /chat-a|user-a|om_|evidenceHash|deliveryId|session-secret|revisionId|file-1/u);
  });

  it('respects the prompt budget and reports truncation', () => {
    const section = buildStickerExpressionPromptSection({ snapshot: snapshot(), chatId: 'chat-a', userId: 'user-a', maxChars: 120 });
    assert.ok(section);
    assert.equal(section.truncated, true);
    assert.ok(section.content.length <= 120);
  });
});
