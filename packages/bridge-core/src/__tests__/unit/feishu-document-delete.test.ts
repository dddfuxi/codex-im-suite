import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { initBridgeContext } from '../../lib/bridge/context.js';
import type { BridgeStore } from '../../lib/bridge/host.js';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter.js';

function createStore(): BridgeStore {
  return {
    getSetting: (key: string) => ({
      bridge_feishu_app_id: 'cli_test',
      bridge_feishu_app_secret: 'secret_test',
      bridge_feishu_domain: 'https://open.feishu.cn',
    } as Record<string, string>)[key] || null,
  } as unknown as BridgeStore;
}

function setup(): void {
  initBridgeContext({
    store: createStore(),
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Feishu document deletion adapter', () => {
  it('requests the Drive recycle-bin deletion with the tenant token', async () => {
    setup();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_test' }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 });
    }) as typeof fetch;

    const result = await new FeishuAdapter().deleteDocument('doc/token with spaces');
    assert.deepEqual(result, { ok: true });
    const deletion = calls[1];
    assert.equal(deletion.url, 'https://open.feishu.cn/open-apis/drive/v1/files/doc%2Ftoken%20with%20spaces?type=file');
    assert.equal(deletion.init?.method, 'DELETE');
    assert.equal((deletion.init?.headers as Record<string, string>).Authorization, 'Bearer tenant_test');
  });

  it('keeps a nonzero platform code as a failed deletion', async () => {
    setup();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant_test' }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 177001, msg: 'permission denied' }), { status: 200 });
    }) as typeof fetch;

    const result = await new FeishuAdapter().deleteDocument('doc-forbidden');
    assert.equal(result.ok, false);
    assert.match(result.error || '', /177001/);
    assert.match(result.error || '', /permission denied/);
  });
});
