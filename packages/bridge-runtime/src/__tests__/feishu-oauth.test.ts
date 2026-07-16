import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FeishuOAuthService,
  FeishuOAuthStateStore,
  FeishuOAuthTokenStore,
  startFeishuOAuthCallbackServer,
} from '../feishu-oauth.js';

describe('Feishu OAuth token store', () => {
  it('stores protected Feishu user tokens and restores them by bound user id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-token-'));
    try {
      const tokenPath = path.join(dir, 'tokens.json');
      const store = new FeishuOAuthTokenStore(tokenPath, {
        protect: async (value) => `protected:${Buffer.from(value, 'utf8').toString('base64')}`,
        unprotect: async (value) => Buffer.from(value.replace(/^protected:/, ''), 'base64').toString('utf8'),
      });

      await store.saveTokens('ou_1', {
        accessToken: 'access-token-secret',
        refreshToken: 'refresh-token-secret',
        scopes: ['docx:document:readonly'],
        accessTokenExpiresAt: '2026-05-09T10:00:00.000Z',
        refreshTokenExpiresAt: '2026-06-09T10:00:00.000Z',
      });

      const raw = fs.readFileSync(tokenPath, 'utf8');
      assert.doesNotMatch(raw, /access-token-secret|refresh-token-secret/);
      const loaded = await store.getTokens('ou_1');
      assert.equal(loaded?.accessToken, 'access-token-secret');
      assert.equal(loaded?.refreshToken, 'refresh-token-secret');
      assert.deepEqual(loaded?.scopes, ['docx:document:readonly']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps separate minimum-scope token grants for the same Feishu user', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-token-grants-'));
    try {
      const store = new FeishuOAuthTokenStore(path.join(dir, 'tokens.json'), {
        protect: async (value) => `protected:${value}`,
        unprotect: async (value) => value.replace(/^protected:/, ''),
      });

      await Promise.all([
        store.saveTokens('ou_1', {
          accessToken: 'docx-access',
          refreshToken: 'docx-refresh',
          scopes: ['auth:user.id:read', 'docx:document:readonly', 'offline_access'],
          accessTokenExpiresAt: '2026-05-09T10:00:00.000Z',
        }),
        store.saveTokens('ou_1', {
          accessToken: 'sheets-access',
          refreshToken: 'sheets-refresh',
          scopes: ['auth:user.id:read', 'offline_access', 'sheets:spreadsheet:readonly'],
          accessTokenExpiresAt: '2026-05-09T10:00:00.000Z',
        }),
      ]);

      const docx = await store.getTokens('ou_1', ['docx:document:readonly']);
      const sheets = await store.getTokens('ou_1', ['sheets:spreadsheet:readonly']);
      assert.equal(docx?.accessToken, 'docx-access');
      assert.equal(sheets?.accessToken, 'sheets-access');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Feishu OAuth state and refresh', () => {
  it('uses the official OAuth v3 PKCE flow for manual authorization with minimum scopes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-manual-'));
    try {
      const statePath = path.join(dir, 'states.json');
      const service = new FeishuOAuthService({
        config: {
          appId: 'cli_xxx',
          appSecret: 'secret',
          mode: 'manual',
          callbackPath: '/feishu/oauth/callback',
          scopes: ['offline_access', 'auth:user.id:read', 'docx:document:readonly'],
          waitForAuthorizationMs: 0,
        },
        tokenStore: new FeishuOAuthTokenStore(path.join(dir, 'tokens.json'), {
          protect: async (value) => value,
          unprotect: async (value) => value,
        }),
        stateStore: new FeishuOAuthStateStore(statePath, () => new Date('2026-05-09T09:00:00.000Z')),
        now: () => new Date('2026-05-09T09:00:00.000Z'),
      });

      const result = await service.requestUserAuthorization({
        resourceClass: 'cloud_document',
        userId: 'ou_1',
        chatId: 'oc_1',
        channelType: 'feishu',
        userDisplayName: 'Liu Dan',
        messageId: 'm_1',
        text: 'summarize https://example.feishu.cn/docx/doccn123',
        linkUrls: ['https://example.feishu.cn/docx/doccn123'],
        requestedScopes: ['offline_access', 'auth:user.id:read', 'docx:document:readonly'],
      });

      assert.equal(result.status, 'auth_required');
      assert.match(result.loginUrl || '', /^https:\/\/accounts\.feishu\.cn\/open-apis\/authen\/v1\/authorize\?/);
      assert.match(result.loginUrl || '', /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A17321%2Ffeishu%2Foauth%2Fcallback/);
      assert.deepEqual(new URL(result.loginUrl || '').searchParams.get('scope')?.split(' '), [
        'auth:user.id:read',
        'docx:document:readonly',
        'offline_access',
      ]);
      assert.match(result.loginUrl || '', /code_challenge=/);
      assert.equal(result.cardDisposition, 'send');
      assert.deepEqual(result.requestedScopes, ['auth:user.id:read', 'docx:document:readonly', 'offline_access']);
      const persistedStates = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, any>;
      const persistedState = Object.values(persistedStates)[0];
      assert.equal(persistedState.pendingRequests[0].text, 'summarize https://example.feishu.cn/docx/doccn123');
      assert.equal(persistedState.pendingRequests[0].userDisplayName, 'Liu Dan');
      assert.deepEqual(persistedState.requestedScopes, ['auth:user.id:read', 'docx:document:readonly', 'offline_access']);
      assert.match(result.userMessage, /复制浏览器地址栏/);
      assert.match(result.feishuCardJson || '', /复制回调地址/);
      assert.match(result.feishuCardJson || '', /docx:document:readonly/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges same-user same-scope tasks into one pending authorization card', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-oauth-dedupe-'));
    try {
      const statePath = path.join(dir, 'states.json');
      const service = new FeishuOAuthService({
        config: {
          appId: 'cli_xxx',
          appSecret: 'secret',
          mode: 'manual',
          callbackPath: '/feishu/oauth/callback',
          scopes: ['offline_access', 'auth:user.id:read', 'docx:document:readonly', 'sheets:spreadsheet:readonly'],
          waitForAuthorizationMs: 0,
        },
        tokenStore: new FeishuOAuthTokenStore(path.join(dir, 'tokens.json'), {
          protect: async (value) => value,
          unprotect: async (value) => value,
        }),
        stateStore: new FeishuOAuthStateStore(statePath, () => new Date('2026-05-09T09:00:00.000Z')),
        now: () => new Date('2026-05-09T09:00:00.000Z'),
      });
      const baseInput = {
        resourceClass: 'cloud_document' as const,
        userId: 'ou_1',
        chatId: 'oc_1',
        channelType: 'feishu',
        userDisplayName: 'Liu Dan',
        linkUrls: ['https://example.feishu.cn/docx/doccn123'],
        requestedScopes: ['offline_access', 'auth:user.id:read', 'docx:document:readonly'],
      };

      const first = await service.requestUserAuthorization({
        ...baseInput,
        messageId: 'm_1',
        text: '总结第一个文档',
      });
      const second = await service.requestUserAuthorization({
        ...baseInput,
        messageId: 'm_2',
        text: '总结第二个文档',
      });

      assert.equal(first.status, 'auth_required');
      assert.equal(second.status, 'auth_required');
      assert.equal(first.cardDisposition, 'send');
      assert.equal(second.cardDisposition, 'reuse');
      assert.equal(second.feishuCardJson, undefined);
      assert.equal(second.loginUrl, first.loginUrl);
      assert.equal(second.authorizationRequestId, first.authorizationRequestId);
      assert.match(second.userMessage, /已合并到现有授权请求/);
      const states = Object.values(JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, any>);
      assert.equal(states.length, 1);
      assert.deepEqual(states[0].pendingRequests.map((item: any) => item.messageId), ['m_1', 'm_2']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent same-user same-scope requests into one authorization card', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-oauth-concurrent-dedupe-'));
    try {
      const service = new FeishuOAuthService({
        config: {
          appId: 'cli_xxx',
          appSecret: 'secret',
          mode: 'manual',
          callbackPath: '/feishu/oauth/callback',
          scopes: ['offline_access', 'auth:user.id:read', 'docx:document:readonly'],
          waitForAuthorizationMs: 0,
        },
        tokenStore: new FeishuOAuthTokenStore(path.join(dir, 'tokens.json'), {
          protect: async (value) => value,
          unprotect: async (value) => value,
        }),
        stateStore: new FeishuOAuthStateStore(path.join(dir, 'states.json'), () => new Date('2026-05-09T09:00:00.000Z')),
        now: () => new Date('2026-05-09T09:00:00.000Z'),
      });
      const baseInput = {
        resourceClass: 'cloud_document' as const,
        userId: 'ou_1',
        chatId: 'oc_1',
        channelType: 'feishu',
        linkUrls: ['https://example.feishu.cn/docx/doccn123'],
        requestedScopes: ['offline_access', 'auth:user.id:read', 'docx:document:readonly'],
      };

      const [first, second] = await Promise.all([
        service.requestUserAuthorization({ ...baseInput, messageId: 'm_1', text: '总结第一个文档' }),
        service.requestUserAuthorization({ ...baseInput, messageId: 'm_2', text: '总结第二个文档' }),
      ]);

      assert.equal(first.status, 'auth_required');
      assert.equal(second.status, 'auth_required');
      assert.deepEqual([first.cardDisposition, second.cardDisposition].sort(), ['reuse', 'send']);
      assert.equal(first.authorizationRequestId, second.authorizationRequestId);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves concurrent different-scope authorization states for the same user', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-oauth-concurrent-scopes-'));
    try {
      const statePath = path.join(dir, 'states.json');
      const service = new FeishuOAuthService({
        config: {
          appId: 'cli_xxx',
          appSecret: 'secret',
          mode: 'manual',
          callbackPath: '/feishu/oauth/callback',
          scopes: ['offline_access', 'auth:user.id:read', 'docx:document:readonly', 'sheets:spreadsheet:readonly'],
          waitForAuthorizationMs: 0,
        },
        tokenStore: new FeishuOAuthTokenStore(path.join(dir, 'tokens.json'), {
          protect: async (value) => value,
          unprotect: async (value) => value,
        }),
        stateStore: new FeishuOAuthStateStore(statePath, () => new Date('2026-05-09T09:00:00.000Z')),
        now: () => new Date('2026-05-09T09:00:00.000Z'),
      });

      const [docx, sheets] = await Promise.all([
        service.requestUserAuthorization({
          resourceClass: 'cloud_document',
          userId: 'ou_1',
          chatId: 'oc_1',
          messageId: 'm_docx',
          text: '总结文档',
          linkUrls: ['https://example.feishu.cn/docx/doccn123'],
          requestedScopes: ['offline_access', 'auth:user.id:read', 'docx:document:readonly'],
        }),
        service.requestUserAuthorization({
          resourceClass: 'cloud_document',
          userId: 'ou_1',
          chatId: 'oc_1',
          messageId: 'm_sheets',
          text: '总结表格',
          linkUrls: ['https://example.feishu.cn/sheets/shtcn123'],
          requestedScopes: ['offline_access', 'auth:user.id:read', 'sheets:spreadsheet:readonly'],
        }),
      ]);

      assert.equal(docx.cardDisposition, 'send');
      assert.equal(sheets.cardDisposition, 'send');
      assert.notEqual(docx.authorizationRequestId, sheets.authorizationRequestId);
      const states = Object.values(JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, any>);
      assert.equal(states.length, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exchanges a manually pasted callback URL for user tokens', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-manual-callback-'));
    try {
      const stateStore = new FeishuOAuthStateStore(path.join(dir, 'states.json'), () => new Date('2026-05-09T09:00:00.000Z'));
      await stateStore.put({
        state: 'nonce-1',
        userId: 'ou_1',
        chatId: 'oc_1',
        messageId: 'm_1',
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1:17321/feishu/oauth/callback',
        linkHashes: ['abc'],
        expiresAt: '2026-05-09T09:05:00.000Z',
        requestedScopes: ['docx:document:readonly', 'offline_access'],
        authorizationKey: 'ou_1|docx:document:readonly,offline_access',
        pendingRequests: [
          {
            text: 'summarize https://example.feishu.cn/docx/doc_abc',
            channelType: 'feishu',
            chatId: 'oc_1',
            userId: 'ou_1',
            userDisplayName: 'Liu Dan',
            messageId: 'm_1',
          },
          {
            text: 'summarize https://example.feishu.cn/docx/doc_second',
            channelType: 'feishu',
            chatId: 'oc_1',
            userId: 'ou_1',
            userDisplayName: 'Liu Dan',
            messageId: 'm_2',
          },
        ],
      });
      const tokenStore = new FeishuOAuthTokenStore(path.join(dir, 'tokens.json'), {
        protect: async (value) => `p:${value}`,
        unprotect: async (value) => value.replace(/^p:/, ''),
      });
      const service = new FeishuOAuthService({
        config: {
          appId: 'cli_xxx',
          appSecret: 'secret',
          mode: 'manual',
          callbackPath: '/feishu/oauth/callback',
          scopes: ['offline_access'],
          waitForAuthorizationMs: 0,
        },
        tokenStore,
        stateStore,
        now: () => new Date('2026-05-09T09:00:00.000Z'),
        fetch: async (url, init) => {
          if (String(url) === 'https://accounts.feishu.cn/oauth/v3/token') {
            assert.match(String(init?.body), /"code":"auth-code"/);
            assert.match(String(init?.body), /"code_verifier":"verifier"/);
            assert.match(String(init?.body), /"scope":"docx:document:readonly offline_access"/);
            return new Response(JSON.stringify({
              code: 0,
              data: {
                access_token: 'new-access',
                refresh_token: 'new-refresh',
                expires_in: 7200,
                refresh_token_expires_in: 2592000,
                scope: 'offline_access docx:document:readonly',
              },
            }), { status: 200 });
          }
          assert.equal(String(url), 'https://open.feishu.cn/open-apis/authen/v1/user_info');
          assert.equal(init?.headers && new Headers(init.headers).get('authorization'), 'Bearer new-access');
          return new Response(JSON.stringify({
            code: 0,
            data: { open_id: 'ou_1', union_id: 'on_1' },
          }), { status: 200 });
        },
      });

      const result = await service.handleManualCallbackText({
        text: 'http://127.0.0.1:17321/feishu/oauth/callback?code=auth-code&state=nonce-1',
        userId: 'ou_1',
      });

      assert.equal(result.status, 'bound');
      assert.equal(result.userMessage, '已收到，正在处理中。');
      assert.equal(result.resume?.text, 'summarize https://example.feishu.cn/docx/doc_abc');
      assert.deepEqual(result.resumes?.map((item) => item.messageId), ['m_1', 'm_2']);
      assert.equal(result.resume?.userDisplayName, 'Liu Dan');
      const stored = await tokenStore.getTokens('ou_1');
      assert.equal(stored?.accessToken, 'new-access');
      assert.equal(stored?.refreshToken, 'new-refresh');
      assert.equal(stored?.openId, 'ou_1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects OAuth binding when official user_info mismatches or cannot be verified', async () => {
    const cases = [
      {
        name: 'mismatched user',
        userInfo: () => new Response(JSON.stringify({
          code: 0,
          data: { open_id: 'ou_other' },
        }), { status: 200 }),
        expected: /不一致/,
      },
      {
        name: 'user info failure',
        userInfo: () => new Response(JSON.stringify({
          code: 20005,
          msg: 'invalid user access token',
        }), { status: 401 }),
        expected: /身份|user_info|用户信息|校验/i,
      },
    ];

    for (const testCase of cases) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-user-info-'));
      try {
        const stateStore = new FeishuOAuthStateStore(path.join(dir, 'states.json'), () => new Date('2026-05-09T09:00:00.000Z'));
        await stateStore.put({
          state: `nonce-${testCase.name.replace(/\s+/g, '-')}`,
          userId: 'ou_1',
          chatId: 'oc_1',
          messageId: 'm_1',
          codeVerifier: 'verifier',
          redirectUri: 'http://127.0.0.1:17321/feishu/oauth/callback',
          linkHashes: ['abc'],
          expiresAt: '2026-05-09T09:05:00.000Z',
          requestedScopes: ['docx:document:readonly', 'offline_access'],
        });
        const tokenStore = new FeishuOAuthTokenStore(path.join(dir, 'tokens.json'), {
          protect: async (value) => value,
          unprotect: async (value) => value,
        });
        const service = new FeishuOAuthService({
          config: {
            appId: 'cli_xxx',
            appSecret: 'secret',
            mode: 'manual',
            callbackPath: '/feishu/oauth/callback',
            scopes: ['docx:document:readonly', 'offline_access'],
            waitForAuthorizationMs: 0,
          },
          tokenStore,
          stateStore,
          now: () => new Date('2026-05-09T09:00:00.000Z'),
          fetch: async (url) => {
            if (String(url) === 'https://accounts.feishu.cn/oauth/v3/token') {
              return new Response(JSON.stringify({
                code: 0,
                data: {
                  access_token: 'new-access',
                  refresh_token: 'new-refresh',
                  expires_in: 7200,
                  scope: 'docx:document:readonly offline_access',
                },
              }), { status: 200 });
            }
            assert.equal(String(url), 'https://open.feishu.cn/open-apis/authen/v1/user_info');
            return testCase.userInfo();
          },
        });
        const state = `nonce-${testCase.name.replace(/\s+/g, '-')}`;

        const result = await service.handleManualCallbackText({
          text: `http://127.0.0.1:17321/feishu/oauth/callback?code=auth-code&state=${state}`,
          userId: 'ou_1',
        });

        assert.equal(result.status, 'error', testCase.name);
        assert.match(result.userMessage, testCase.expected);
        assert.equal(await tokenStore.getTokens('ou_1'), null);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('resumes original request after localhost callback server receives OAuth redirect', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-callback-resume-'));
    try {
      const stateStore = new FeishuOAuthStateStore(path.join(dir, 'states.json'), () => new Date('2026-05-09T09:00:00.000Z'));
      await stateStore.put({
        state: 'nonce-resume-1',
        userId: 'ou_1',
        chatId: 'oc_1',
        messageId: 'm_1',
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1:17321/feishu/oauth/callback',
        linkHashes: ['abc'],
        expiresAt: '2026-05-09T09:05:00.000Z',
        pendingRequest: {
          text: 'summarize https://example.feishu.cn/docx/doc_resume',
          channelType: 'feishu',
          chatId: 'oc_1',
          userId: 'ou_1',
          userDisplayName: 'Liu Dan',
          messageId: 'm_1',
        },
      });
      const tokenStore = new FeishuOAuthTokenStore(path.join(dir, 'tokens.json'), {
        protect: async (value) => value,
        unprotect: async (value) => value,
      });
      const service = new FeishuOAuthService({
        config: {
          appId: 'cli_xxx',
          appSecret: 'secret',
          mode: 'manual',
          callbackPath: '/feishu/oauth/callback',
          scopes: ['offline_access'],
          waitForAuthorizationMs: 0,
        },
        tokenStore,
        stateStore,
        now: () => new Date('2026-05-09T09:00:00.000Z'),
        fetch: async (url, init) => {
          if (String(url) === 'https://accounts.feishu.cn/oauth/v3/token') {
            assert.match(String(init?.body), /"code_verifier":"verifier"/);
            return new Response(JSON.stringify({
              code: 0,
              data: {
                access_token: 'new-access',
                refresh_token: 'new-refresh',
                expires_in: 7200,
                refresh_token_expires_in: 2592000,
                scope: 'offline_access docx:document:readonly',
              },
            }), { status: 200 });
          }
          assert.equal(String(url), 'https://open.feishu.cn/open-apis/authen/v1/user_info');
          return new Response(JSON.stringify({
            code: 0,
            data: { open_id: 'ou_1' },
          }), { status: 200 });
        },
      });
      let resumed: any = null;
      const server = startFeishuOAuthCallbackServer(service, {
        host: '127.0.0.1',
        port: 0,
        callbackPath: '/feishu/oauth/callback',
        onResume: async (resume) => {
          resumed = resume;
        },
      });
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const addr = server.address();
      assert.ok(addr && typeof addr === 'object');
      const port = addr.port;
      const resp = await fetch(`http://127.0.0.1:${port}/feishu/oauth/callback?code=auth-code&state=nonce-resume-1`);
      assert.equal(resp.status, 200);
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(resumed);
      assert.equal(resumed.text, 'summarize https://example.feishu.cn/docx/doc_resume');
      assert.equal(resumed.userDisplayName, 'Liu Dan');
      server.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a Feishu configuration blocker card when public OAuth callback URL is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-config-'));
    try {
      const service = new FeishuOAuthService({
        config: {
          appId: 'cli_xxx',
          appSecret: 'secret',
          callbackPath: '/feishu/oauth/callback',
          scopes: ['offline_access'],
          waitForAuthorizationMs: 0,
        },
        tokenStore: new FeishuOAuthTokenStore(path.join(dir, 'tokens.json'), {
          protect: async (value) => value,
          unprotect: async (value) => value,
        }),
        stateStore: new FeishuOAuthStateStore(path.join(dir, 'states.json')),
      });

      const result = await service.requestUserAuthorization({
        resourceClass: 'cloud_document',
        userId: 'ou_1',
        chatId: 'oc_1',
        messageId: 'm_1',
        linkUrls: ['https://example.feishu.cn/sheets/shtcn123'],
        requestedScopes: ['offline_access', 'auth:user.id:read', 'sheets:spreadsheet:readonly'],
      });

      assert.equal(result.status, 'auth_required');
      assert.match(result.userMessage, /CTI_FEISHU_OAUTH_PUBLIC_BASE_URL/);
      assert.match(result.feishuCardJson || '', /飞书 OAuth 配置缺失/);
      assert.doesNotMatch(result.feishuCardJson || '', /登录飞书授权/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('consumes OAuth state only for the original Feishu user and before expiry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-state-'));
    try {
      const store = new FeishuOAuthStateStore(path.join(dir, 'states.json'), () => new Date('2026-05-09T09:00:00.000Z'));
      await store.put({
        state: 'nonce-1',
        userId: 'ou_1',
        chatId: 'oc_1',
        messageId: 'm_1',
        codeVerifier: 'verifier',
        redirectUri: 'https://bot.example.com/feishu/oauth/callback',
        linkHashes: ['abc'],
        expiresAt: '2026-05-09T09:05:00.000Z',
      });

      assert.equal(await store.consume('nonce-1', 'ou_other'), null);
      const consumed = await store.consume('nonce-1', 'ou_1');
      assert.equal(consumed?.codeVerifier, 'verifier');
      assert.equal(await store.consume('nonce-1', 'ou_1'), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refreshes expired access tokens with the stored Feishu refresh token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-refresh-'));
    try {
      const tokenStore = new FeishuOAuthTokenStore(path.join(dir, 'tokens.json'), {
        protect: async (value) => `p:${value}`,
        unprotect: async (value) => value.replace(/^p:/, ''),
      });
      await tokenStore.saveTokens('ou_1', {
        accessToken: 'old-access',
        refreshToken: 'refresh-token',
        scopes: ['offline_access'],
        accessTokenExpiresAt: '2026-05-09T08:59:00.000Z',
        refreshTokenExpiresAt: '2026-06-09T09:00:00.000Z',
      });
      const service = new FeishuOAuthService({
        config: {
          appId: 'cli_xxx',
          appSecret: 'secret',
          publicBaseUrl: 'https://bot.example.com',
          callbackPath: '/feishu/oauth/callback',
          scopes: ['offline_access'],
          waitForAuthorizationMs: 1,
        },
        tokenStore,
        stateStore: new FeishuOAuthStateStore(path.join(dir, 'states.json')),
        now: () => new Date('2026-05-09T09:00:00.000Z'),
        fetch: async (url, init) => {
          assert.equal(String(url), 'https://accounts.feishu.cn/oauth/v3/token');
          assert.match(String(init?.body), /"grant_type":"refresh_token"/);
          assert.match(String(init?.body), /"scope":"offline_access"/);
          return new Response(JSON.stringify({
            code: 0,
            data: {
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_in: 7200,
              refresh_token_expires_in: 2592000,
              scope: 'offline_access',
            },
          }), { status: 200 });
        },
      });

      const token = await service.getAccessToken('ou_1');

      assert.equal(token, 'new-access');
      const stored = await tokenStore.getTokens('ou_1');
      assert.equal(stored?.refreshToken, 'new-refresh');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
