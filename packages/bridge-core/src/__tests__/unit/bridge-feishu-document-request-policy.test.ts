import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function loadPolicy() {
  return await import('../../lib/bridge/channels/feishu/documents/document-request-policy.js');
}

describe('Feishu document request policy', () => {
  it('separates generation, list, and unrelated permission questions', async () => {
    const {
      isFeishuDocumentGenerationRequest,
      isFeishuDocumentGenerationRequestStrict,
      isFeishuDocumentListRequest,
    } = await loadPolicy();

    assert.equal(isFeishuDocumentGenerationRequest('把上一条整理成飞书文档并发链接'), true);
    assert.equal(isFeishuDocumentGenerationRequestStrict('把这个内容重写到云文档'), true);
    assert.equal(isFeishuDocumentListRequest('之前生成过哪些飞书文档'), true);
    assert.equal(isFeishuDocumentGenerationRequestStrict('飞书文档权限为什么失败'), false);
    assert.equal(isFeishuDocumentListRequest('解释一下文档权限'), false);
  });

  it('builds deterministic titles and rejects generic generated titles', async () => {
    const { buildFeishuDocumentDraftTitle, isGenericFeishuDocumentTitle } = await loadPolicy();

    assert.equal(
      buildFeishuDocumentDraftTitle(new Date('2026-07-20T14:08:00.000Z'), 'Asia/Shanghai'),
      'Document Draft 07-20 22-08',
    );
    assert.equal(isGenericFeishuDocumentTitle('群聊总结 2026-07-20'), true);
    assert.equal(isGenericFeishuDocumentTitle('Neon Harvest 技能平衡复盘'), false);
  });

  it('builds a document rewrite prompt that preserves failures and asks for meaningful structure', async () => {
    const { buildFeishuDocumentRewritePrompt } = await loadPolicy();
    const prompt = buildFeishuDocumentRewritePrompt('构建失败：缺少权限', '整理成飞书文档');

    assert.match(prompt, /第一行必须是有内容含义的一级标题/u);
    assert.match(prompt, /失败\/空白截图\/替代方案/u);
    assert.match(prompt, /构建失败：缺少权限/u);
    assert.match(prompt, /用户当前请求：整理成飞书文档/u);
  });

  it('recognizes only supported Feishu cloud links and sanitizes them from provider-visible user text', async () => {
    const {
      containsFeishuCloudDocumentLink,
      sanitizeFeishuCloudDocumentLinks,
      shouldResolveFeishuCloudLinks,
    } = await loadPolicy();
    const text = '总结 https://example.feishu.cn/docx/doc_abc 和 https://example.larksuite.com/sheets/sht_xyz';

    assert.equal(containsFeishuCloudDocumentLink(text), true);
    assert.equal(shouldResolveFeishuCloudLinks('feishu', text), true);
    assert.equal(shouldResolveFeishuCloudLinks('telegram', text), false);
    assert.equal(containsFeishuCloudDocumentLink('https://example.feishu.cn.evil.test/docx/doc_abc'), false);
    assert.equal(sanitizeFeishuCloudDocumentLinks(text), '总结 [已读取的飞书云文档] 和 [已读取的飞书云文档]');
  });

  it('detects Feishu OAuth callback pairs without trusting an unrelated channel', async () => {
    const { shouldHandleFeishuOAuthCallback } = await loadPolicy();

    assert.equal(shouldHandleFeishuOAuthCallback('feishu', 'http://127.0.0.1/callback?code=a&state=b'), true);
    assert.equal(shouldHandleFeishuOAuthCallback('feishu', 'state=b&amp;code=a'), true);
    assert.equal(shouldHandleFeishuOAuthCallback('qq', 'code=a&state=b'), false);
    assert.equal(shouldHandleFeishuOAuthCallback('feishu', '只有 code=a'), false);
  });

  it('normalizes cloud blockers and suppresses reused authorization cards', async () => {
    const { buildFeishuCloudBlockerMessage, resolveFeishuOAuthCardJson } = await loadPolicy();

    assert.equal(buildFeishuCloudBlockerMessage({ status: 'auth_required' }), '需要你登录飞书后，我才能安全读取这个云文档。');
    assert.equal(buildFeishuCloudBlockerMessage({ status: 'permission_denied' }), '未完成：当前登录飞书用户也没有这个云文档权限，请让文档所有者分享给你或导出内容。');
    assert.equal(buildFeishuCloudBlockerMessage({ status: 'error', userMessage: '自定义阻塞' }), '自定义阻塞');
    assert.equal(resolveFeishuOAuthCardJson({ status: 'auth_required', feishuCardJson: '{"card":1}', authorizationCardDisposition: 'reuse' }), undefined);
    assert.equal(resolveFeishuOAuthCardJson({ status: 'auth_required', feishuCardJson: '{"card":1}', authorizationCardDisposition: 'send' }), '{"card":1}');
  });

  it('turns every cloud host result into one explicit provider or delivery decision', async () => {
    const { decideFeishuCloudResolution } = await loadPolicy();

    assert.deepEqual(decideFeishuCloudResolution({
      status: 'resolved',
      systemPrompt: '  verified document evidence  ',
    }), {
      kind: 'resolved',
      systemPrompt: 'verified document evidence',
    });
    assert.deepEqual(decideFeishuCloudResolution({
      status: 'auth_required',
      userMessage: '请完成授权',
      feishuCardJson: '{"card":1}',
      authorizationCardDisposition: 'send',
    }), {
      kind: 'blocked',
      text: '请完成授权',
      feishuCardJson: '{"card":1}',
    });
    assert.deepEqual(decideFeishuCloudResolution({
      status: 'permission_denied',
    }), {
      kind: 'blocked',
      text: '未完成：当前登录飞书用户也没有这个云文档权限，请让文档所有者分享给你或导出内容。',
      feishuCardJson: undefined,
    });
    assert.deepEqual(decideFeishuCloudResolution({ status: 'no_links' }), { kind: 'no_links' });
  });

  it('fails closed when a resolved cloud document result has no evidence prompt', async () => {
    const { decideFeishuCloudResolution } = await loadPolicy();

    assert.deepEqual(decideFeishuCloudResolution({ status: 'resolved', systemPrompt: '   ' }), {
      kind: 'blocked',
      text: '未完成：飞书云文档读取结果缺少可靠正文，无法继续处理。',
      feishuCardJson: undefined,
    });
  });

  it('builds a secret-free OAuth audit entry only for tracked authorization requests', async () => {
    const { buildFeishuOAuthRequestAuditInput } = await loadPolicy();
    const message = {
      channelType: 'feishu',
      chatId: 'oc_1',
      messageId: 'om_1',
      userId: 'ou_1',
    };

    assert.deepEqual(buildFeishuOAuthRequestAuditInput(message, {
      status: 'auth_required',
      authorizationRequestId: 'oauth-request-1',
      requestedScopes: ['offline_access', 'sheets:spreadsheet:readonly'],
      authorizationCardDisposition: 'reuse',
      loginUrl: 'https://accounts.feishu.cn/secret',
      feishuCardJson: '{"secret":"must-not-appear"}',
    }), {
      channelType: 'feishu',
      chatId: 'oc_1',
      direction: 'outbound',
      messageId: 'om_1',
      summary: '[FEISHU_OAUTH_REQUEST] requestId=oauth-request-1 disposition=reuse userId=ou_1 scopes=offline_access,sheets:spreadsheet:readonly',
    });
    assert.equal(buildFeishuOAuthRequestAuditInput(message, {
      status: 'permission_denied',
      authorizationRequestId: 'oauth-request-1',
    }), undefined);
    assert.equal(buildFeishuOAuthRequestAuditInput(message, {
      status: 'auth_required',
    }), undefined);
  });
});
