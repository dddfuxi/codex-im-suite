import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFeishuCloudDocumentHost,
  parseFeishuCloudLinks,
  type FeishuCloudAccessTokenProvider,
  type FeishuCloudTenantTokenProvider,
} from '../feishu-cloud-documents.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Feishu cloud document links', () => {
  it('parses docx, sheets, and base links from Feishu cloud URLs', () => {
    const links = parseFeishuCloudLinks([
      '总结 https://example.feishu.cn/docx/doccnA1B2C3',
      '表格 https://example.feishu.cn/sheets/shtcnD4E5F6?sheet=abc',
      '多维表格 https://example.feishu.cn/base/bascnG7H8I9?table=tbl123&view=vew123',
    ].join('\n'));

    assert.deepEqual(links.map((link) => link.type), ['docx', 'sheets', 'base']);
    assert.equal(links[0].token, 'doccnA1B2C3');
    assert.equal(links[1].token, 'shtcnD4E5F6');
    assert.equal(links[2].token, 'bascnG7H8I9');
    assert.equal(links[2].tableId, 'tbl123');
    assert.equal(links[2].viewId, 'vew123');
  });

  it('parses Feishu markdown cloud document links from inbound messages', () => {
    const links = parseFeishuCloudLinks(
      '回复 刘丹: [H项目-4.30版收集：问题、建议、吐槽 - 飞书云文档](https://funplus.feishu.cn/sheets/ZpW5sfiUohtpFTtg0Yacv5XGnHe?sheet=415299) 看一下并总结这个链接',
    );

    assert.equal(links.length, 1);
    assert.equal(links[0].type, 'sheets');
    assert.equal(links[0].token, 'ZpW5sfiUohtpFTtg0Yacv5XGnHe');
    assert.equal(links[0].sheetId, '415299');
  });

  it('reads docx raw content with the Feishu user access token', async () => {
    const tokenProvider: FeishuCloudAccessTokenProvider = {
      getAccessToken: async () => 'user-token',
      requestUserAuthorization: async () => ({ status: 'auth_required', userMessage: 'not used' }),
    };
    const host = createFeishuCloudDocumentHost({
      config: {
        appId: 'cli_xxx',
        appSecret: 'secret',
        maxChars: 80000,
        maxRows: 500,
        maxRecords: 500,
        maxSheets: 5,
      },
      tokenProvider,
      fetch: async (url, init) => {
        assert.match(String(url), /\/open-apis\/docx\/v1\/documents\/doccnA1B2C3\/raw_content/);
        assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer user-token');
        return jsonResponse({ code: 0, data: { content: '真实飞书文档正文' } });
      },
    });

    const result = await host.resolveFeishuCloudLinks({
      text: '总结 https://example.feishu.cn/docx/doccnA1B2C3',
      channelType: 'feishu',
      chatId: 'oc_1',
      userId: 'ou_1',
      messageId: 'm_1',
    });

    assert.equal(result.status, 'resolved');
    assert.match(result.systemPrompt || '', /真实飞书文档正文/);
  });

  it('tries the Feishu tenant access token before requesting a user access token', async () => {
    const userTokenCalls: string[] = [];
    const tenantTokenProvider: FeishuCloudTenantTokenProvider = {
      getTenantAccessToken: async () => 'tenant-token',
    };
    const tokenProvider: FeishuCloudAccessTokenProvider = {
      getAccessToken: async (userId) => {
        userTokenCalls.push(userId);
        return 'user-token';
      },
      requestUserAuthorization: async () => {
        throw new Error('user OAuth should not be requested when tenant token can read');
      },
    };
    const host = createFeishuCloudDocumentHost({
      config: {
        appId: 'cli_xxx',
        appSecret: 'secret',
        maxChars: 80000,
        maxRows: 500,
        maxRecords: 500,
        maxSheets: 5,
      },
      tokenProvider,
      tenantTokenProvider,
      fetch: async (_url, init) => {
        assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer tenant-token');
        return jsonResponse({ code: 0, data: { content: '应用身份可读取正文' } });
      },
    });

    const result = await host.resolveFeishuCloudLinks({
      text: '总结 https://example.feishu.cn/docx/doccnA1B2C3',
      channelType: 'feishu',
      chatId: 'oc_1',
      userId: 'ou_1',
      messageId: 'm_1',
    });

    assert.equal(result.status, 'resolved');
    assert.deepEqual(userTokenCalls, []);
    assert.match(result.systemPrompt || '', /应用身份可读取正文/);
    assert.match(result.systemPrompt || '', /Feishu application tenant token/);
  });

  it('falls back to the requesting Feishu user token when the tenant token cannot access the document', async () => {
    const authorizations: string[] = [];
    const host = createFeishuCloudDocumentHost({
      config: {
        appId: 'cli_xxx',
        appSecret: 'secret',
        maxChars: 80000,
        maxRows: 500,
        maxRecords: 500,
        maxSheets: 5,
      },
      tokenProvider: {
        getAccessToken: async () => 'user-token',
        requestUserAuthorization: async () => {
          throw new Error('stored user token should be used before requesting OAuth');
        },
      },
      tenantTokenProvider: {
        getTenantAccessToken: async () => 'tenant-token',
      },
      fetch: async (_url, init) => {
        const authorization = (init?.headers as Record<string, string>).Authorization;
        authorizations.push(authorization);
        if (authorization === 'Bearer tenant-token') {
          return jsonResponse({ code: 1770032, msg: 'forbidden' }, 403);
        }
        return jsonResponse({ code: 0, data: { content: '刘丹身份可读取正文' } });
      },
    });

    const result = await host.resolveFeishuCloudLinks({
      text: '总结 https://example.feishu.cn/docx/doccnA1B2C3',
      channelType: 'feishu',
      chatId: 'oc_1',
      userId: 'ou_liudan',
      messageId: 'm_1',
    });

    assert.equal(result.status, 'resolved');
    assert.deepEqual(authorizations, ['Bearer tenant-token', 'Bearer user-token']);
    assert.match(result.systemPrompt || '', /刘丹身份可读取正文/);
    assert.match(result.systemPrompt || '', /requesting Feishu user OAuth token/);
  });

  it('asks for user authorization when tenant access is denied and no user token exists', async () => {
    const host = createFeishuCloudDocumentHost({
      config: {
        appId: 'cli_xxx',
        appSecret: 'secret',
        maxChars: 80000,
        maxRows: 500,
        maxRecords: 500,
        maxSheets: 5,
      },
      tokenProvider: {
        getAccessToken: async () => null,
        requestUserAuthorization: async (input) => ({
          status: 'auth_required',
          loginUrl: 'https://accounts.feishu.cn/auth?state=nonce',
          userMessage: `请 ${input.userId} 登录飞书授权`,
          feishuCardJson: '{"card":"login"}',
        }),
      },
      tenantTokenProvider: {
        getTenantAccessToken: async () => 'tenant-token',
      },
      fetch: async () => jsonResponse({ code: 1770032, msg: 'forbidden' }, 403),
    });

    const result = await host.resolveFeishuCloudLinks({
      text: '总结 https://example.feishu.cn/docx/doccnA1B2C3',
      channelType: 'feishu',
      chatId: 'oc_1',
      userId: 'ou_liudan',
      messageId: 'm_1',
    });

    assert.equal(result.status, 'auth_required');
    assert.match(result.userMessage || '', /ou_liudan/);
    assert.equal(result.feishuCardJson, '{"card":"login"}');
  });

  it('explains old retries cannot start user OAuth when tenant access is denied and sender identity is missing', async () => {
    const host = createFeishuCloudDocumentHost({
      config: {
        appId: 'cli_xxx',
        appSecret: 'secret',
        maxChars: 80000,
        maxRows: 500,
        maxRecords: 500,
        maxSheets: 5,
      },
      tokenProvider: {
        getAccessToken: async () => {
          throw new Error('user token lookup requires a sender id');
        },
        requestUserAuthorization: async () => {
          throw new Error('OAuth should not be requested without a sender id');
        },
      },
      tenantTokenProvider: {
        getTenantAccessToken: async () => 'tenant-token',
      },
      fetch: async () => jsonResponse({ code: 1770032, msg: 'forbidden' }, 403),
    });

    const result = await host.resolveFeishuCloudLinks({
      text: '总结 https://example.feishu.cn/docx/doccnA1B2C3',
      channelType: 'feishu',
      chatId: 'oc_1',
      messageId: 'm_old',
    });

    assert.equal(result.status, 'auth_required');
    assert.match(result.userMessage || '', /应用 token 无法读取/);
    assert.match(result.userMessage || '', /重新发送原消息/);
  });

  it('reads sheets and formats bounded table values into prompt context', async () => {
    const calls: string[] = [];
    const host = createFeishuCloudDocumentHost({
      config: {
        appId: 'cli_xxx',
        appSecret: 'secret',
        maxChars: 80000,
        maxRows: 2,
        maxRecords: 500,
        maxSheets: 1,
      },
      tokenProvider: {
        getAccessToken: async () => 'user-token',
        requestUserAuthorization: async () => ({ status: 'auth_required', userMessage: 'not used' }),
      },
      fetch: async (url) => {
        calls.push(String(url));
        if (String(url).includes('/sheets/query')) {
          return jsonResponse({ code: 0, data: { sheets: [{ sheet_id: 'sheet1', title: '问题收集' }] } });
        }
        return jsonResponse({ code: 0, data: { valueRange: { values: [['问题', '建议'], ['卡顿', '优化加载']] } } });
      },
    });

    const result = await host.resolveFeishuCloudLinks({
      text: '总结 https://example.feishu.cn/sheets/shtcn123',
      channelType: 'feishu',
      chatId: 'oc_1',
      userId: 'ou_1',
      messageId: 'm_1',
    });

    assert.equal(result.status, 'resolved');
    assert.equal(calls.length, 2);
    assert.match(result.systemPrompt || '', /问题收集/);
    assert.match(result.systemPrompt || '', /卡顿/);
    assert.match(result.systemPrompt || '', /优化加载/);
  });

  it('reads bitable tables, fields, and capped records', async () => {
    const host = createFeishuCloudDocumentHost({
      config: {
        appId: 'cli_xxx',
        appSecret: 'secret',
        maxChars: 80000,
        maxRows: 500,
        maxRecords: 2,
        maxSheets: 5,
      },
      tokenProvider: {
        getAccessToken: async () => 'user-token',
        requestUserAuthorization: async () => ({ status: 'auth_required', userMessage: 'not used' }),
      },
      fetch: async (url, init) => {
        const target = String(url);
        if (target.endsWith('/tables')) {
          return jsonResponse({ code: 0, data: { items: [{ table_id: 'tbl123', name: '吐槽收集' }] } });
        }
        if (target.includes('/fields')) {
          return jsonResponse({ code: 0, data: { items: [{ field_name: '问题' }, { field_name: '建议' }] } });
        }
        assert.equal(init?.method, 'POST');
        return jsonResponse({
          code: 0,
          data: {
            has_more: false,
            items: [
              { record_id: 'rec1', fields: { 问题: '战斗节奏慢', 建议: '提高移动速度' } },
              { record_id: 'rec2', fields: { 问题: 'UI 看不清', 建议: '提高对比度' } },
            ],
          },
        });
      },
    });

    const result = await host.resolveFeishuCloudLinks({
      text: '总结 https://example.feishu.cn/base/bascn123?table=tbl123',
      channelType: 'feishu',
      chatId: 'oc_1',
      userId: 'ou_1',
      messageId: 'm_1',
    });

    assert.equal(result.status, 'resolved');
    assert.match(result.systemPrompt || '', /吐槽收集/);
    assert.match(result.systemPrompt || '', /战斗节奏慢/);
    assert.match(result.systemPrompt || '', /提高对比度/);
  });

  it('maps Feishu permission errors to a user-visible permission blocker', async () => {
    const host = createFeishuCloudDocumentHost({
      config: {
        appId: 'cli_xxx',
        appSecret: 'secret',
        maxChars: 80000,
        maxRows: 500,
        maxRecords: 500,
        maxSheets: 5,
      },
      tokenProvider: {
        getAccessToken: async () => 'user-token',
        requestUserAuthorization: async () => ({ status: 'auth_required', userMessage: 'not used' }),
      },
      fetch: async () => jsonResponse({ code: 1770032, msg: 'forbidden' }, 403),
    });

    const result = await host.resolveFeishuCloudLinks({
      text: '总结 https://example.feishu.cn/docx/doccnA1B2C3',
      channelType: 'feishu',
      chatId: 'oc_1',
      userId: 'ou_1',
      messageId: 'm_1',
    });

    assert.equal(result.status, 'permission_denied');
    assert.match(result.userMessage || '', /当前登录飞书用户或应用权限无法读取/);
  });

  it('includes endpoint-specific scopes in cloud document permission blockers', async () => {
    const host = createFeishuCloudDocumentHost({
      config: {
        appId: 'cli_xxx',
        appSecret: 'secret',
        maxChars: 80000,
        maxRows: 500,
        maxRecords: 500,
        maxSheets: 5,
      },
      tokenProvider: {
        getAccessToken: async () => 'user-token',
        requestUserAuthorization: async () => ({ status: 'auth_required', userMessage: 'not used' }),
      },
      fetch: async (url) => {
        if (String(url).includes('/tables')) {
          return jsonResponse({ code: 125403, msg: 'missing scope or permission' }, 403);
        }
        return jsonResponse({ code: 0, data: { items: [] } });
      },
    });

    const result = await host.resolveFeishuCloudLinks({
      text: '总结 https://example.feishu.cn/base/bascn123',
      channelType: 'feishu',
      chatId: 'oc_1',
      userId: 'ou_1',
      messageId: 'm_1',
    });

    assert.equal(result.status, 'permission_denied');
    assert.match(result.userMessage || '', /bitable:app:readonly/);
    assert.match(result.userMessage || '', /base:table:read/);
  });
});
