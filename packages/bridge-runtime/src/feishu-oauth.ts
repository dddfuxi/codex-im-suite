import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildFeishuOAuthAuthorizationKey,
  mergeFeishuOAuthPendingRequests,
  normalizeFeishuOAuthScopes,
} from './feishu-oauth-governance.js';

const execFileAsync = promisify(execFile);
const FEISHU_OAUTH_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const FEISHU_TOKEN_URL = 'https://accounts.feishu.cn/oauth/v3/token';
const FEISHU_USER_INFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info';
const CLOCK_SKEW_MS = 60 * 1000;

export interface StoredFeishuUserTokens {
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt?: string;
  openId?: string;
  unionId?: string;
  userId?: string;
}

interface PersistedFeishuUserTokens {
  boundUserId?: string;
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt?: string;
  openId?: string;
  unionId?: string;
  userId?: string;
  updatedAt: string;
}

export interface TokenProtector {
  protect(value: string): Promise<string>;
  unprotect(value: string): Promise<string>;
}

export interface FeishuOAuthState {
  state: string;
  userId: string;
  chatId: string;
  messageId?: string;
  codeVerifier: string;
  redirectUri: string;
  linkHashes: string[];
  requestedScopes?: string[];
  authorizationKey?: string;
  expiresAt: string;
  pendingRequest?: FeishuOAuthPendingRequest;
  pendingRequests?: FeishuOAuthPendingRequest[];
}

export interface FeishuOAuthPendingRequest {
  text: string;
  channelType: string;
  chatId: string;
  userId?: string;
  userDisplayName?: string;
  messageId?: string;
}

export interface FeishuOAuthConfig {
  appId?: string;
  appSecret?: string;
  mode?: 'callback' | 'manual';
  publicBaseUrl?: string;
  manualRedirectUri?: string;
  callbackPath: string;
  callbackPort?: number;
  scopes: string[];
  waitForAuthorizationMs: number;
}

export interface FeishuAuthorizationInput {
  resourceClass: 'cloud_document';
  userId: string;
  chatId: string;
  channelType?: string;
  userDisplayName?: string;
  messageId?: string;
  text?: string;
  linkUrls: string[];
  requestedScopes: string[];
}

export type FeishuAuthorizationResult =
  | { status: 'authorized'; accessToken: string }
  | {
      status: 'auth_required';
      loginUrl?: string;
      userMessage: string;
      feishuCardJson?: string;
      authorizationRequestId?: string;
      requestedScopes?: string[];
      cardDisposition?: 'send' | 'reuse';
    };

export type FeishuManualCallbackResult =
  | { status: 'no_callback' }
  | { status: 'bound'; userMessage: string; resume?: FeishuOAuthPendingRequest; resumes?: FeishuOAuthPendingRequest[] }
  | { status: 'error'; userMessage: string; error?: string };

export type FeishuOAuthCallbackResult = {
  ok: boolean;
  message: string;
  resume?: FeishuOAuthPendingRequest;
  resumes?: FeishuOAuthPendingRequest[];
};

export class FeishuOAuthTokenStore {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly protector: TokenProtector = createDefaultTokenProtector(),
  ) {}

  async getTokens(userId: string, requiredScopes: string[] = []): Promise<StoredFeishuUserTokens | null> {
    const all = await this.readAll();
    const normalizedRequiredScopes = normalizeFeishuOAuthScopes(requiredScopes);
    const record = Object.entries(all)
      .filter(([storageKey, candidate]) => candidate.boundUserId === userId || (!candidate.boundUserId && storageKey === userId))
      .map(([, candidate]) => candidate)
      .filter((candidate) => {
        const candidateScopes = new Set(normalizeFeishuOAuthScopes(candidate.scopes || []));
        return normalizedRequiredScopes.every((scope) => candidateScopes.has(scope));
      })
      .sort((left, right) => {
        const scopeDelta = normalizeFeishuOAuthScopes(left.scopes || []).length - normalizeFeishuOAuthScopes(right.scopes || []).length;
        if (scopeDelta !== 0) return scopeDelta;
        return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
      })[0];
    if (!record) return null;
    return {
      accessTokenExpiresAt: record.accessTokenExpiresAt,
      refreshTokenExpiresAt: record.refreshTokenExpiresAt,
      scopes: normalizeFeishuOAuthScopes(record.scopes || []),
      openId: record.openId,
      unionId: record.unionId,
      userId: record.userId,
      accessToken: await this.protector.unprotect(record.accessToken),
      refreshToken: record.refreshToken ? await this.protector.unprotect(record.refreshToken) : undefined,
    };
  }

  async saveTokens(userId: string, tokens: StoredFeishuUserTokens): Promise<void> {
    await this.enqueueMutation(async () => {
      const all = await this.readAll();
      const normalizedScopes = normalizeFeishuOAuthScopes(tokens.scopes || []);
      const storageKey = buildTokenGrantStorageKey(userId, normalizedScopes);
      all[storageKey] = {
        ...tokens,
        boundUserId: userId,
        scopes: normalizedScopes,
        accessToken: await this.protector.protect(tokens.accessToken),
        refreshToken: tokens.refreshToken ? await this.protector.protect(tokens.refreshToken) : undefined,
        updatedAt: new Date().toISOString(),
      };
      // 旧版本以 userId 为唯一键；首次新格式写入时移除同用户旧单 grant，其他 scope grant 保留。
      delete all[userId];
      await writeJsonAtomic(this.filePath, all);
    });
  }

  async deleteTokens(userId: string, scopes?: string[]): Promise<void> {
    await this.enqueueMutation(async () => {
      const all = await this.readAll();
      if (scopes) {
        delete all[buildTokenGrantStorageKey(userId, scopes)];
        if (all[userId]) delete all[userId];
      } else {
        for (const [storageKey, record] of Object.entries(all)) {
          if (record.boundUserId === userId || (!record.boundUserId && storageKey === userId)) delete all[storageKey];
        }
      }
      await writeJsonAtomic(this.filePath, all);
    });
  }

  private async enqueueMutation(run: () => Promise<void>): Promise<void> {
    const current = this.mutationTail.then(run, run);
    this.mutationTail = current.catch(() => undefined);
    await current;
  }

  private async readAll(): Promise<Record<string, PersistedFeishuUserTokens>> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Record<string, PersistedFeishuUserTokens>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }
}

export class FeishuOAuthStateStore {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async put(state: FeishuOAuthState): Promise<void> {
    await this.enqueueMutation(async () => {
      const all = await this.readAll();
      all[state.state] = state;
      await writeJsonAtomic(this.filePath, all);
    });
  }

  async consume(stateValue: string, expectedUserId?: string): Promise<FeishuOAuthState | null> {
    return this.enqueueMutation(async () => {
      const all = await this.readAll();
      const state = all[stateValue];
      if (!state) return null;
      if (new Date(state.expiresAt).getTime() <= this.now().getTime()) {
        delete all[stateValue];
        await writeJsonAtomic(this.filePath, all);
        return null;
      }
      if (expectedUserId && state.userId !== expectedUserId) return null;
      delete all[stateValue];
      await writeJsonAtomic(this.filePath, all);
      return state;
    });
  }

  async get(stateValue: string): Promise<FeishuOAuthState | null> {
    await this.mutationTail.catch(() => undefined);
    const all = await this.readAll();
    return all[stateValue] ?? null;
  }

  async findActiveByAuthorizationKey(authorizationKey: string): Promise<FeishuOAuthState | null> {
    return this.enqueueMutation(async () => {
      const all = await this.readAll();
      let changed = false;
      let matched: FeishuOAuthState | null = null;
      for (const [stateValue, state] of Object.entries(all)) {
        if (new Date(state.expiresAt).getTime() <= this.now().getTime()) {
          delete all[stateValue];
          changed = true;
          continue;
        }
        if (!matched && state.authorizationKey === authorizationKey) matched = state;
      }
      if (changed) await writeJsonAtomic(this.filePath, all);
      return matched;
    });
  }

  async mergePendingRequest(
    stateValue: string,
    pendingRequest: FeishuOAuthPendingRequest | undefined,
    linkHashes: string[],
  ): Promise<FeishuOAuthState | null> {
    return this.enqueueMutation(async () => {
      const all = await this.readAll();
      const state = all[stateValue];
      if (!state || new Date(state.expiresAt).getTime() <= this.now().getTime()) return null;
      state.pendingRequests = mergeFeishuOAuthPendingRequests(getPendingRequests(state), pendingRequest);
      state.linkHashes = Array.from(new Set([...(state.linkHashes || []), ...linkHashes]));
      delete state.pendingRequest;
      all[stateValue] = state;
      await writeJsonAtomic(this.filePath, all);
      return state;
    });
  }

  private async enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
    const current = this.mutationTail.then(run, run);
    this.mutationTail = current.then(() => undefined, () => undefined);
    return current;
  }

  private async readAll(): Promise<Record<string, FeishuOAuthState>> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Record<string, FeishuOAuthState>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }
}

interface PendingAuthorization {
  userId: string;
  resolve: (value: FeishuAuthorizationResult) => void;
}

export class FeishuOAuthService {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly authorizationLocks = new Map<string, Promise<void>>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: {
    config: FeishuOAuthConfig;
    tokenStore: FeishuOAuthTokenStore;
    stateStore: FeishuOAuthStateStore;
    fetch?: typeof fetch;
    now?: () => Date;
  }) {
    this.fetchImpl = options.fetch || fetch;
    this.now = options.now || (() => new Date());
  }

  async getAccessToken(userId: string, requiredScopes: string[] = []): Promise<string | null> {
    const tokens = await this.options.tokenStore.getTokens(userId, requiredScopes);
    if (!tokens) return null;
    const storedScopes = new Set(normalizeFeishuOAuthScopes(tokens.scopes || []));
    if (normalizeFeishuOAuthScopes(requiredScopes).some((scope) => !storedScopes.has(scope))) return null;
    if (new Date(tokens.accessTokenExpiresAt).getTime() > this.now().getTime() + CLOCK_SKEW_MS) {
      return tokens.accessToken;
    }
    if (!tokens.refreshToken) return null;
    if (tokens.refreshTokenExpiresAt && new Date(tokens.refreshTokenExpiresAt).getTime() <= this.now().getTime()) {
      await this.options.tokenStore.deleteTokens(userId, tokens.scopes);
      return null;
    }
    return this.refreshAccessToken(userId, tokens.refreshToken, tokens.scopes || []);
  }

  async requestUserAuthorization(input: FeishuAuthorizationInput): Promise<FeishuAuthorizationResult> {
    const configError = this.validateConfig();
    if (configError) {
      return {
        status: 'auth_required',
        userMessage: configError,
        feishuCardJson: buildConfigurationBlockerCard(configError),
      };
    }

    const requestedScopes = normalizeFeishuOAuthScopes(input.requestedScopes);
    const configuredScopes = new Set(normalizeFeishuOAuthScopes(this.options.config.scopes));
    const missingConfiguredScopes = requestedScopes.filter((scope) => !configuredScopes.has(scope));
    if (missingConfiguredScopes.length > 0) {
      const message = `未完成：当前 OAuth 配置未声明任务所需 scope：${missingConfiguredScopes.join(', ')}。请由 Owner 在飞书开放平台开通并更新 CTI_FEISHU_OAUTH_SCOPES。`;
      return {
        status: 'auth_required',
        userMessage: message,
        requestedScopes,
        cardDisposition: 'send',
        feishuCardJson: buildConfigurationBlockerCard(message),
      };
    }
    const authorizationKey = buildFeishuOAuthAuthorizationKey(input.userId, requestedScopes);
    return this.withAuthorizationKeyLock(authorizationKey, async () => {
      const existing = await this.options.stateStore.findActiveByAuthorizationKey(authorizationKey);
      if (existing) {
        const pendingRequest = toPendingRequest(input);
        const merged = await this.options.stateStore.mergePendingRequest(
          existing.state,
          pendingRequest,
          hashLinkUrls(input.linkUrls),
        ) || existing;
        const loginUrl = this.buildAuthorizationUrl(merged);
        return {
          status: 'auth_required',
          loginUrl,
          userMessage: '已合并到现有授权请求。完成上一张授权卡后，我会继续处理这项任务。',
          authorizationRequestId: merged.state,
          requestedScopes,
          cardDisposition: 'reuse',
        };
      }

      const state = await this.createState(input, requestedScopes, authorizationKey);
      const loginUrl = this.buildAuthorizationUrl(state);
      const manualMode = this.options.config.mode === 'manual';
      const card = manualMode
        ? buildManualAuthorizationCard(loginUrl, requestedScopes)
        : buildAuthorizationCard(loginUrl, requestedScopes);
      const waitMs = Math.max(0, this.options.config.waitForAuthorizationMs);
      if (waitMs <= 0) {
        return {
          status: 'auth_required',
          loginUrl,
          userMessage: manualMode
            ? buildManualAuthorizationMessage(loginUrl, requestedScopes)
            : buildAuthorizationMessage(loginUrl, requestedScopes),
          feishuCardJson: card,
          authorizationRequestId: state.state,
          requestedScopes,
          cardDisposition: 'send',
        };
      }

      const completed = new Promise<FeishuAuthorizationResult>((resolve) => {
        this.pending.set(state.state, { userId: input.userId, resolve });
      });
      const timeout = new Promise<FeishuAuthorizationResult>((resolve) => {
        setTimeout(() => {
          this.pending.delete(state.state);
          resolve({
            status: 'auth_required',
            loginUrl,
            userMessage: manualMode
              ? buildManualAuthorizationMessage(loginUrl, requestedScopes)
              : buildAuthorizationMessage(loginUrl, requestedScopes),
            feishuCardJson: card,
            authorizationRequestId: state.state,
            requestedScopes,
            cardDisposition: 'send',
          });
        }, waitMs).unref();
      });
      return Promise.race([completed, timeout]);
    });
  }

  private async withAuthorizationKeyLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.authorizationLocks.get(key) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate, () => gate);
    this.authorizationLocks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
      if (this.authorizationLocks.get(key) === tail) this.authorizationLocks.delete(key);
    }
  }

  async handleOAuthCallback(callbackUrl: URL): Promise<FeishuOAuthCallbackResult> {
    const code = callbackUrl.searchParams.get('code') || '';
    const stateValue = callbackUrl.searchParams.get('state') || '';
    if (!code || !stateValue) {
      return { ok: false, message: '飞书授权回调缺少 code 或 state。' };
    }
    const existingState = await this.options.stateStore.get(stateValue);
    const state = await this.options.stateStore.consume(stateValue, existingState?.userId);
    if (!state) {
      return { ok: false, message: '飞书授权已过期或无效，请回到聊天里重新发起。' };
    }
    try {
      const exchangedTokens = await this.exchangeAuthorizationCode(code, state);
      const tokens = await this.verifyAuthorizedUserIdentity(state.userId, exchangedTokens);
      await this.options.tokenStore.saveTokens(state.userId, tokens);
      const resumes = getPendingRequests(state);
      const pending = this.pending.get(state.state);
      if (pending) {
        this.pending.delete(state.state);
        pending.resolve({ status: 'authorized', accessToken: tokens.accessToken });
      }
      if (resumes.length > 0) {
        return { ok: true, message: '飞书授权成功。已收到，正在处理中。', resume: resumes[0], resumes };
      }
      return { ok: true, message: '飞书授权成功，可以回到聊天继续。' };
    } catch (error) {
      const pending = this.pending.get(state.state);
      if (pending) {
        this.pending.delete(state.state);
        pending.resolve({
          status: 'auth_required',
          userMessage: `飞书授权失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return { ok: false, message: `飞书授权失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async handleManualCallbackText(input: { text: string; userId?: string }): Promise<FeishuManualCallbackResult> {
    const parsed = parseOAuthCallbackText(input.text);
    if (!parsed) return { status: 'no_callback' };
    const existingState = await this.options.stateStore.get(parsed.state);
    if (!existingState) {
      return { status: 'error', userMessage: '飞书授权已过期或无效，请重新发送原问题后再授权。' };
    }
    if (input.userId && existingState.userId !== input.userId) {
      return { status: 'error', userMessage: '授权回传账号与原请求发起人不一致，已拒绝绑定。' };
    }
    const state = await this.options.stateStore.consume(parsed.state, existingState.userId);
    if (!state) {
      return { status: 'error', userMessage: '飞书授权已过期或无效，请重新发送原问题后再授权。' };
    }
    try {
      const exchangedTokens = await this.exchangeAuthorizationCode(parsed.code, state);
      const tokens = await this.verifyAuthorizedUserIdentity(state.userId, exchangedTokens);
      await this.options.tokenStore.saveTokens(state.userId, tokens);
      const resumes = getPendingRequests(state);
      if (resumes.length > 0) {
        return {
          status: 'bound',
          userMessage: '已收到，正在处理中。',
          resume: resumes[0],
          resumes,
        };
      }
      return { status: 'bound', userMessage: '飞书授权成功。请回到聊天里重新发送原问题，我会按你的飞书身份读取云文档。' };
    } catch (error) {
      return {
        status: 'error',
        userMessage: `飞书授权失败：${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private validateConfig(): string | null {
    if (!this.options.config.appId || !this.options.config.appSecret) {
      return '未完成：缺少飞书应用 App ID 或 App Secret，无法发起云文档安全授权。';
    }
    if (this.options.config.mode !== 'manual' && !this.options.config.publicBaseUrl) {
      return '未完成：缺少 CTI_FEISHU_OAUTH_PUBLIC_BASE_URL，无法生成飞书 OAuth 公网回调登录链接。';
    }
    return null;
  }

  private async createState(
    input: FeishuAuthorizationInput,
    requestedScopes: string[],
    authorizationKey: string,
  ): Promise<FeishuOAuthState> {
    const stateValue = crypto.randomBytes(24).toString('base64url');
    const state: FeishuOAuthState = {
      state: stateValue,
      userId: input.userId,
      chatId: input.chatId,
      messageId: input.messageId,
      codeVerifier: crypto.randomBytes(48).toString('base64url'),
      redirectUri: this.getRedirectUri(),
      linkHashes: hashLinkUrls(input.linkUrls),
      requestedScopes,
      authorizationKey,
      expiresAt: new Date(this.now().getTime() + 5 * 60 * 1000).toISOString(),
      pendingRequests: mergeFeishuOAuthPendingRequests([], toPendingRequest(input)),
    };
    await this.options.stateStore.put(state);
    return state;
  }

  private buildAuthorizationUrl(state: FeishuOAuthState): string {
    const url = new URL(FEISHU_OAUTH_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.options.config.appId!);
    url.searchParams.set('redirect_uri', state.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', normalizeFeishuOAuthScopes(state.requestedScopes || this.options.config.scopes).join(' '));
    url.searchParams.set('state', state.state);
    url.searchParams.set('code_challenge', pkceChallenge(state.codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  private getRedirectUri(): string {
    if (this.options.config.mode === 'manual') {
      if (this.options.config.manualRedirectUri) return this.options.config.manualRedirectUri;
      return buildRedirectUri(`http://127.0.0.1:${this.options.config.callbackPort || 17321}`, this.options.config.callbackPath);
    }
    return buildRedirectUri(this.options.config.publicBaseUrl!, this.options.config.callbackPath);
  }

  private async exchangeAuthorizationCode(code: string, state: FeishuOAuthState): Promise<StoredFeishuUserTokens> {
    const scopes = normalizeFeishuOAuthScopes(state.requestedScopes || this.options.config.scopes);
    return this.requestToken({
      grant_type: 'authorization_code',
      client_id: this.options.config.appId!,
      client_secret: this.options.config.appSecret!,
      code,
      redirect_uri: state.redirectUri,
      code_verifier: state.codeVerifier,
      ...(scopes.length > 0 ? { scope: scopes.join(' ') } : {}),
    }, scopes);
  }

  private async refreshAccessToken(userId: string, refreshToken: string, scopes: string[]): Promise<string | null> {
    try {
      const normalizedScopes = normalizeFeishuOAuthScopes(scopes);
      const tokens = await this.requestToken({
        grant_type: 'refresh_token',
        client_id: this.options.config.appId!,
        client_secret: this.options.config.appSecret!,
        refresh_token: refreshToken,
        ...(normalizedScopes.length > 0 ? { scope: normalizedScopes.join(' ') } : {}),
      }, normalizedScopes);
      await this.options.tokenStore.saveTokens(userId, tokens);
      return tokens.accessToken;
    } catch {
      await this.options.tokenStore.deleteTokens(userId, scopes);
      return null;
    }
  }

  private async verifyAuthorizedUserIdentity(
    expectedOpenId: string,
    tokens: StoredFeishuUserTokens,
  ): Promise<StoredFeishuUserTokens> {
    const response = await this.fetchImpl(FEISHU_USER_INFO_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    const payload = await response.json() as any;
    if (!response.ok || payload.code !== 0) {
      throw new Error(`飞书授权身份校验失败：${payload.msg || payload.message || `HTTP ${response.status}`}`);
    }
    const data = payload.data || payload;
    const openId = typeof data.open_id === 'string' ? data.open_id.trim() : '';
    if (!openId) {
      throw new Error('飞书授权身份校验失败：user_info 未返回 open_id。');
    }
    if (openId !== expectedOpenId) {
      throw new Error('授权账号与发起请求的飞书用户不一致，已拒绝绑定。');
    }
    return {
      ...tokens,
      openId,
      unionId: typeof data.union_id === 'string' && data.union_id.trim() ? data.union_id.trim() : undefined,
      userId: typeof data.user_id === 'string' && data.user_id.trim() ? data.user_id.trim() : undefined,
    };
  }

  private async requestToken(body: Record<string, string>, fallbackScopes: string[]): Promise<StoredFeishuUserTokens> {
    const response = await this.fetchImpl(FEISHU_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as any;
    if (!response.ok || payload.code !== 0) {
      throw new Error(payload.msg || payload.message || `HTTP ${response.status}`);
    }
    const data = payload.data || payload;
    const nowMs = this.now().getTime();
    const accessTtlMs = Number(data.expires_in || data.expire || 7200) * 1000;
    const refreshTtlMs = data.refresh_token_expires_in ? Number(data.refresh_token_expires_in) * 1000 : undefined;
    const scopeText = String(data.scope || '').trim();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      scopes: normalizeFeishuOAuthScopes(scopeText ? scopeText.split(/\s+/).filter(Boolean) : fallbackScopes),
      accessTokenExpiresAt: new Date(nowMs + accessTtlMs).toISOString(),
      refreshTokenExpiresAt: refreshTtlMs ? new Date(nowMs + refreshTtlMs).toISOString() : undefined,
      openId: data.open_id || data.user?.open_id,
      unionId: data.union_id || data.user?.union_id,
      userId: data.user_id || data.user?.user_id,
    };
  }
}

export function startFeishuOAuthCallbackServer(
  service: FeishuOAuthService,
  options: { host?: string; port: number; callbackPath: string; onResume?: (resume: FeishuOAuthPendingRequest) => Promise<void> | void },
): http.Server {
  const callbackPath = normalizeCallbackPath(options.callbackPath);
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      if (requestUrl.pathname !== callbackPath) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const result = await service.handleOAuthCallback(requestUrl);
      if (result.ok && options.onResume) {
        const resumes = result.resumes?.length ? result.resumes : result.resume ? [result.resume] : [];
        for (const resume of resumes) {
          void Promise.resolve(options.onResume(resume)).catch((error) => {
            console.warn('[feishu-oauth] callback resume error:', error instanceof Error ? error.message : error);
          });
        }
      }
      res.writeHead(result.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderCallbackHtml(result.ok, result.message));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderCallbackHtml(false, error instanceof Error ? error.message : String(error)));
    }
  });
  server.on('error', (error) => {
    console.warn('[feishu-oauth] callback server error:', error instanceof Error ? error.message : error);
  });
  server.listen(options.port, options.host || '127.0.0.1');
  server.unref();
  return server;
}

function buildAuthorizationMessage(loginUrl: string, requestedScopes: string[]): string {
  return [
    '需要你登录飞书后，我才能安全读取这个云文档。',
    formatRequestedScopes(requestedScopes),
    '',
    `授权链接：${loginUrl}`,
    '',
    '授权完成后请回到聊天里重新发送原问题。',
  ].join('\n');
}

function buildManualAuthorizationMessage(loginUrl: string, requestedScopes: string[]): string {
  return [
    '需要你登录飞书后，我才能安全读取这个云文档。',
    formatRequestedScopes(requestedScopes),
    '',
    `授权链接：${loginUrl}`,
    '',
    '授权完成后，浏览器可能停在一个无法访问的本地回调地址；这是正常的。',
    '请复制浏览器地址栏里的完整地址，回到飞书发送给我；我会从其中的 code/state 完成绑定。',
  ].join('\n');
}

function buildAuthorizationCard(loginUrl: string, requestedScopes: string[]): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '需要飞书授权' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            '这个云文档需要使用你的飞书账号权限读取。点击按钮登录授权后，请回到聊天里重新发送原问题。',
            '',
            formatRequestedScopes(requestedScopes),
          ].join('\n'),
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '登录飞书授权' },
            type: 'primary',
            url: loginUrl,
          },
        ],
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '如果浏览器显示 127.0.0.1 拒绝连接：请复制地址栏完整 URL 发回飞书；如果在本机打开则会自动回调。',
          },
        ],
      },
    ],
  });
}

function buildManualAuthorizationCard(loginUrl: string, requestedScopes: string[]): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '需要飞书授权' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            '这个云文档需要使用你的飞书账号权限读取。',
            formatRequestedScopes(requestedScopes),
            '点击按钮完成授权后，请把浏览器地址栏里的完整回调地址复制回飞书发送。',
          ].join('\n'),
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '打开飞书授权页' },
            type: 'primary',
            url: loginUrl,
          },
        ],
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: '无需公网回调；复制回调地址后我会从 code/state 完成授权绑定。',
          },
        ],
      },
    ],
  });
}

function formatRequestedScopes(scopes: string[]): string {
  const normalized = normalizeFeishuOAuthScopes(scopes);
  return `本次最小权限：${normalized.join('、') || '未声明'}`;
}

function toPendingRequest(input: FeishuAuthorizationInput): FeishuOAuthPendingRequest | undefined {
  if (!input.text?.trim()) return undefined;
  return {
    text: input.text,
    channelType: input.channelType || 'feishu',
    chatId: input.chatId,
    userId: input.userId,
    userDisplayName: input.userDisplayName,
    messageId: input.messageId,
  };
}

function getPendingRequests(state: FeishuOAuthState): FeishuOAuthPendingRequest[] {
  return mergeFeishuOAuthPendingRequests(
    Array.isArray(state.pendingRequests) ? state.pendingRequests : [],
    state.pendingRequest,
  );
}

function hashLinkUrls(linkUrls: string[]): string[] {
  return Array.from(new Set(linkUrls.map((url) => crypto.createHash('sha256').update(url).digest('hex'))));
}

function buildTokenGrantStorageKey(userId: string, scopes: Iterable<string>): string {
  return `grant:${crypto.createHash('sha256').update(buildFeishuOAuthAuthorizationKey(userId, scopes)).digest('hex')}`;
}

function buildConfigurationBlockerCard(message: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '飞书 OAuth 配置缺失' },
      template: 'red',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            message,
            '',
            '请在本机配置 `CTI_FEISHU_OAUTH_PUBLIC_BASE_URL`，并确保它和飞书开放平台后台登记的 OAuth redirect URI 一致。',
            '配置后重启 bridge，再让发起人重新发送原问题。',
          ].join('\n'),
        },
      },
    ],
  });
}

function renderCallbackHtml(ok: boolean, message: string): string {
  const escaped = message.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] || char));
  return `<!doctype html><meta charset="utf-8"><title>Feishu OAuth</title><body><h1>${ok ? '授权成功' : '授权失败'}</h1><p>${escaped}</p></body>`;
}

function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function buildRedirectUri(publicBaseUrl: string, callbackPath: string): string {
  const base = publicBaseUrl.replace(/\/+$/, '');
  return `${base}${normalizeCallbackPath(callbackPath)}`;
}

function parseOAuthCallbackText(text: string): { code: string; state: string } | null {
  const normalized = text.replace(/&amp;/g, '&').trim();
  const urlMatch = normalized.match(/https?:\/\/[^\s<>"']+/i);
  if (urlMatch) {
    try {
      const url = new URL(urlMatch[0]);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (code && state) return { code, state };
    } catch {
      // Fall through to raw query parsing.
    }
  }
  const queryMatch = normalized.match(/(?:^|\s|\?)(code=[^\s&]+(?:&state=[^\s&]+)|state=[^\s&]+(?:&code=[^\s&]+))/i);
  if (!queryMatch) return null;
  const params = new URLSearchParams(queryMatch[1]);
  const code = params.get('code');
  const state = params.get('state');
  return code && state ? { code, state } : null;
}

function normalizeCallbackPath(callbackPath: string): string {
  const trimmed = callbackPath.trim() || '/feishu/oauth/callback';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}

function createDefaultTokenProtector(): TokenProtector {
  if (process.platform === 'win32') {
    return {
      protect: async (value) => {
        const encoded = Buffer.from(value, 'utf8').toString('base64');
        const script = [
          `$plain=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
          '$secure=ConvertTo-SecureString -String $plain -AsPlainText -Force',
          '$secure | ConvertFrom-SecureString',
        ].join(';');
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
          windowsHide: true,
        });
        return `win-dpapi:${Buffer.from(stdout.trim(), 'utf8').toString('base64')}`;
      },
      unprotect: async (value) => {
        if (!value.startsWith('win-dpapi:')) {
          throw new Error('飞书 OAuth token 存储格式不受支持。');
        }
        const encoded = value.slice('win-dpapi:'.length);
        const script = [
          `$cipher=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
          '$secure=ConvertTo-SecureString -String $cipher',
          '$bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
          'try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }',
        ].join(';');
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
          windowsHide: true,
        });
        return stdout.trim();
      },
    };
  }
  return {
    protect: async (value) => `plain:${Buffer.from(value, 'utf8').toString('base64')}`,
    unprotect: async (value) => {
      if (!value.startsWith('plain:')) throw new Error('飞书 OAuth token 存储格式不受支持。');
      return Buffer.from(value.slice('plain:'.length), 'base64').toString('utf8');
    },
  };
}
