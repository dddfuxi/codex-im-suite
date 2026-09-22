import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function loadPolicy() {
  return await import('../../lib/bridge/channels/feishu/documents/document-delivery-policy.js');
}

describe('Feishu document delivery policy', () => {
  it('rejects provider failures and incomplete rewrite shells before document creation', async () => {
    const { decideFeishuDocumentCreation } = await loadPolicy();

    assert.deepEqual(decideFeishuDocumentCreation({
      markdown: '# 完整复盘\n\n## 结论\n已完成。',
      requireHeading: true,
    }), {
      allowed: true,
      markdown: '# 完整复盘\n\n## 结论\n已完成。',
    });
    assert.deepEqual(decideFeishuDocumentCreation({
      markdown: 'MCP tool managecamera reported failure',
      requireHeading: true,
    }), {
      allowed: false,
      reason: '正文只包含工具失败诊断，未创建文档。',
    });
    assert.deepEqual(decideFeishuDocumentCreation({
      markdown: '# 看似完整的正文',
      unexpectedToolUse: true,
      requireHeading: true,
    }), {
      allowed: false,
      reason: '内部正文整理错误触发了工具执行，未创建文档。',
    });
    assert.deepEqual(decideFeishuDocumentCreation({
      markdown: '只有一句普通回复',
      requireHeading: true,
    }), {
      allowed: false,
      reason: '正文整理未返回完整的 Markdown 文档结构。',
    });
  });

  it('builds one creation plan without forwarding generic draft titles', async () => {
    const { buildFeishuDocumentCreationPlan } = await loadPolicy();

    assert.deepEqual(buildFeishuDocumentCreationPlan({
      markdown: '# 有意义的正文',
      requestedTitle: 'Document Draft 07-20 22-08',
      ownerUserId: 'ou_owner',
      chatId: 'oc_1',
      requesterId: 'ou_requester',
      workspace: 'C:\\project',
      sourceText: '整理成飞书文档',
    }), {
      markdown: '# 有意义的正文',
      createOptions: { title: undefined, ownerUserId: 'ou_owner' },
      recordContext: {
        chatId: 'oc_1',
        requesterId: 'ou_requester',
        workspace: 'C:\\project',
        sourceText: '整理成飞书文档',
        markdown: '# 有意义的正文',
      },
    });
  });

  it('turns a created document into the exact memory record input', async () => {
    const { buildFeishuDocumentCreationPlan, buildFeishuDocumentRecordInput } = await loadPolicy();
    const plan = buildFeishuDocumentCreationPlan({
      markdown: '# 正文',
      requestedTitle: '项目复盘',
      chatId: 'oc_1',
      sourceText: '整理项目复盘',
    });

    assert.deepEqual(buildFeishuDocumentRecordInput(plan, {
      documentId: 'doc_1',
      title: '项目复盘',
      url: 'https://example.feishu.cn/docx/doc_1',
    }), {
      documentId: 'doc_1',
      title: '项目复盘',
      url: 'https://example.feishu.cn/docx/doc_1',
      chatId: 'oc_1',
      requesterId: undefined,
      workspace: undefined,
      sourceText: '整理项目复盘',
      markdown: '# 正文',
    });
  });

  it('plans guide replacement before creation and preserves the chosen document id in metadata', async () => {
    const { buildFeishuDocumentGuideMeta, buildFeishuDocumentGuideSyncPlan } = await loadPolicy();

    const replacePlan = buildFeishuDocumentGuideSyncPlan({
      configuredDocumentId: 'doc_configured',
      storedDocumentId: 'doc_stored',
      ownerUserId: 'ou_owner',
    });
    assert.deepEqual(replacePlan, {
      mode: 'replace',
      documentId: 'doc_configured',
      options: { title: '飞书文档导览', ownerUserId: 'ou_owner' },
    });
    assert.deepEqual(buildFeishuDocumentGuideSyncPlan({}), {
      mode: 'create',
      options: { title: '飞书文档导览', ownerUserId: undefined },
    });
    assert.deepEqual(buildFeishuDocumentGuideMeta(replacePlan, {
      title: '飞书文档导览',
      url: 'https://example.feishu.cn/docx/guide',
    }, '2026-07-20T15:00:00.000Z'), {
      documentId: 'doc_configured',
      title: '飞书文档导览',
      url: 'https://example.feishu.cn/docx/guide',
      updatedAt: '2026-07-20T15:00:00.000Z',
    });
  });

  it('builds deterministic success and failure delivery text', async () => {
    const {
      buildFeishuDocumentFailureMessage,
      buildFeishuDocumentSuccessMessage,
    } = await loadPolicy();

    assert.equal(buildFeishuDocumentSuccessMessage({
      title: '项目复盘',
      url: 'https://example.feishu.cn/docx/doc_1',
    }, {
      title: '飞书文档导览',
      url: 'https://example.feishu.cn/docx/guide',
    }), '已生成飞书文档《项目复盘》\nhttps://example.feishu.cn/docx/doc_1\n\n文档导览已更新：https://example.feishu.cn/docx/guide');
    assert.equal(buildFeishuDocumentFailureMessage(new Error('权限不足')), '飞书文档创建失败：权限不足');
    assert.equal(buildFeishuDocumentFailureMessage(undefined), '飞书文档创建失败：未知错误');
  });

  it('redacts credentials and local absolute paths from document creation failures', async () => {
    const { buildFeishuDocumentFailureMessage } = await loadPolicy();
    const text = buildFeishuDocumentFailureMessage(new Error(
      'request failed access_token=secret-value at C:\\Users\\admin\\private\\request.json',
    ));

    assert.match(text, /access_token=\[REDACTED\]/u);
    assert.match(text, /\[本地路径\]/u);
    assert.doesNotMatch(text, /secret-value|C:\\Users\\admin/u);
  });
});
