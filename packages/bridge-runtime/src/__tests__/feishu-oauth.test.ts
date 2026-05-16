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
});

describe('Feishu OAuth state and refresh', () => {
  it('builds a manual authorization card without requiring a public callback URL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-feishu-manual-'));
    try {
      const statePath = path.join(dir, 'states.json');
      const service = new FeishuOAuthService({
        config: {
          appId: 'cli_xxx',
          appSecret: 'secret',
          mode: 'manual',
          callbackPath: '/feishu/oauth/callback',
          scopes: ['offline_access', 'docx:document:readonly'],
          waitForAuthorizationMs: 0,
        },
        tokenStore: new FeishuOAuthTokenStore(path.join(dir, 'tokens.json'), {
          protect: async (value) => value,
          unprotect: async (value) => value,
        }),
        stateStore: new FeishuOAuthStateStore(statePath),
        now: () => new Date('2026-05-09T09:00:00.000Z'),
      });

      const result = await service.requestUserAuthorization({
        userId: 'ou_1',
        chatId: 'oc_1',
        channelType: 'feishu',
        userDisplayName: 'Liu Dan',
        messageId: 'm_1',
        text: 'summarize https://example.feishu.cn/docx/doccn123',
        linkUrls: ['https://example.feishu.cn/docx/doccn123'],
      });

      assert.equal(result.status, 'auth_required');
      assert.match(result.loginUrl || '', /^https:\/\/open\.feishu\.cn\/open-apis\/authen\/v1\/index\?/);
      assert.match(result.loginUrl || '', /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A17321%2Ffeishu%2Foauth%2Fcallback/);
      assert.doesNotMatch(result.loginUrl || '', /scope=/);
      assert.doesNotMatch(result.loginUrl || '', /code_challenge=/);
      const persistedStates = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, any>;
      const persistedState = Object.values(persistedStates)[0];
      assert.equal(persistedState.pendingRequest.text, 'summarize https://example.feishu.cn/docx/doccn123');
      assert.equal(persistedState.pendingRequest.userDisplayName, 'Liu Dan');
      assert.match(result.userMessage, /复制浏览器地址栏/);
      assert.match(result.feishuCardJson || '', /复制回调地址/);
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
        pendingRequest: {
          text: 'summarize https://example.feishu.cn/docx/doc_abc',
          channelType: 'feishu',
          chatId: 'oc_1',
          userId: 'ou_1',
          userDisplayName: 'Liu Dan',
          messageId: 'm_1',
        },
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
          if (String(url).includes('/auth/v3/app_access_token/internal')) {
            return new Response(JSON.stringify({
              code: 0,
              app_access_token: 'app-access-token',
              expire: 7200,
            }), { status: 200 });
          }
          assert.match(String(url), /\/open-apis\/authen\/v1\/access_token/);
          assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer app-access-token');
          assert.match(String(init?.body), /"code":"auth-code"/);
          return new Response(JSON.stringify({
            code: 0,
            data: {
              access_token: 'new-access',
              expires_in: 7200,
              open_id: 'ou_1',
            },
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
      assert.equal(result.resume?.userDisplayName, 'Liu Dan');
      const stored = await tokenStore.getTokens('ou_1');
      assert.equal(stored?.accessToken, 'new-access');
      assert.equal(stored?.refreshToken, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
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
          if (String(url).includes('/auth/v3/app_access_token/internal')) {
            return new Response(JSON.stringify({ code: 0, app_access_token: 'app-access-token', expire: 7200 }), { status: 200 });
          }
          assert.match(String(url), /\/open-apis\/authen\/v1\/access_token/);
          assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer app-access-token');
          return new Response(JSON.stringify({ code: 0, data: { access_token: 'new-access', expires_in: 7200, open_id: 'ou_1' } }), { status: 200 });
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
        userId: 'ou_1',
        chatId: 'oc_1',
        messageId: 'm_1',
        linkUrls: ['https://example.feishu.cn/sheets/shtcn123'],
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
        fetch: async () => new Response(JSON.stringify({
          code: 0,
          data: {
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 7200,
            refresh_token_expires_in: 2592000,
            scope: 'offline_access',
          },
        }), { status: 200 }),
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
