import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildStickerSemanticHumanReadableProjections,
  renderStickerSemanticArchive,
} from '../sticker-semantics/human-readable-projection.js';
import type { StickerSemanticSnapshot } from '../sticker-semantics/types.js';

describe('sticker semantic human-readable projection', () => {
  it('renders current semantics without sensitive evidence ids', () => {
    const snapshot: StickerSemanticSnapshot = {
      schema: 'codex-im-suite/sticker-semantic-snapshot/v1',
      generatedAt: '2026-07-20T00:00:00.000Z',
      baseHash: 'a'.repeat(64),
      assets: [{
        fileKey: 'file-1',
        label: '真棒猫',
        aliases: ['真棒'],
        archived: false,
        disabled: false,
        visual: { source: 'vision', description: '猫咪配字真棒', confidence: 0.95 },
      }],
      revisions: [{
        schema: 'codex-im-suite/sticker-semantic-revision/v1',
        revisionId: 'revision-1',
        fileKey: 'file-1',
        scope: 'chat',
        scopeId: 'oc_secret_chat',
        status: 'trial',
        versionId: 'version-1',
        baseHash: 'a'.repeat(64),
        patch: { usage: '用于轻松确认' },
        supportEvidenceHashes: ['evidenceHash-secret'],
        contradictionEvidenceHashes: [],
        supportSessionIds: ['session-secret'],
        contradictionSessionIds: [],
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
      }],
      deliveries: [{
        schema: 'codex-im-suite/sticker-delivery-evidence/v1',
        deliveryId: 'delivery-secret',
        channelType: 'feishu',
        chatId: 'oc_secret_chat',
        fileKey: 'file-1',
        outboundMessageId: 'om_secret',
        semanticRevisionId: 'revision-1',
        contextHash: 'b'.repeat(64),
        sessionId: 'session-secret',
        sentAt: '2026-07-20T00:00:00.000Z',
      }],
    };

    const markdown = renderStickerSemanticArchive(snapshot);
    assert.match(markdown, /# 表情包语义档案/u);
    assert.match(markdown, /试用/u);
    assert.match(markdown, /用于轻松确认/u);
    assert.doesNotMatch(markdown, /open_id|outboundMessageId|evidenceHash|om_secret|oc_secret_chat|session-secret/u);
  });

  it('updates managed blocks without rewriting human-authored bytes', () => {
    const snapshot: StickerSemanticSnapshot = {
      schema: 'codex-im-suite/sticker-semantic-snapshot/v1',
      generatedAt: '2026-07-20T00:00:00.000Z',
      baseHash: 'a'.repeat(64),
      assets: [],
      revisions: [],
      deliveries: [],
    };
    const masterPrefix = '# 记忆总索引\n\n用户前文尾部空格  \n\n';
    const masterSuffix = '\n\n用户后文尾部空格  \n';
    const guidePrefix = '# 记忆库说明\n\n用户说明前文  \n\n';
    const guideSuffix = '\n\n用户说明后文  \n';
    const projections = buildStickerSemanticHumanReadableProjections({
      memoryRoot: 'C:\\memory',
      snapshot,
      masterIndexContent: `${masterPrefix}<!-- cti-sticker-semantics-index:start -->\n旧区块\n<!-- cti-sticker-semantics-index:end -->${masterSuffix}`,
      memoryGuideContent: `${guidePrefix}<!-- cti-sticker-semantics-status:start -->\n旧区块\n<!-- cti-sticker-semantics-status:end -->${guideSuffix}`,
    });

    const master = projections.find((item) => item.kind === 'master_index')?.content || '';
    const guide = projections.find((item) => item.kind === 'memory_guide')?.content || '';
    assert.equal(master.slice(0, master.indexOf('<!-- cti-sticker-semantics-index:start -->')), masterPrefix);
    assert.equal(master.slice(master.indexOf('<!-- cti-sticker-semantics-index:end -->') + '<!-- cti-sticker-semantics-index:end -->'.length), masterSuffix);
    assert.equal(guide.slice(0, guide.indexOf('<!-- cti-sticker-semantics-status:start -->')), guidePrefix);
    assert.equal(guide.slice(guide.indexOf('<!-- cti-sticker-semantics-status:end -->') + '<!-- cti-sticker-semantics-status:end -->'.length), guideSuffix);
  });
});
