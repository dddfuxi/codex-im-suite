import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import {
  discoverCodexModelCatalog,
  mergeCodexModelOptions,
  parseCodexModelOption,
  type CodexModelCatalogChild,
} from '../codex-model-catalog.js';

describe('runtime Codex model catalog', () => {
  it('parses allowlisted metadata without inventing modalities and accepts string/object efforts', () => {
    assert.deepEqual(parseCodexModelOption({
      id: 'gpt-6-astra',
      displayName: 'GPT 6 Astra',
      inputModalities: ['text', 'text', 'image'],
      supportedReasoningEfforts: ['low', { reasoningEffort: 'high' }, { effort: 'xhigh' }],
      defaultReasoningEffort: 'low',
      hidden: false,
      isDefault: true,
      privateToken: 'must-not-cross-boundary',
    }), {
      id: 'gpt-6-astra',
      displayName: 'GPT 6 Astra',
      inputModalities: ['text', 'image'],
      supportedReasoningEfforts: ['low', 'high', 'xhigh'],
      defaultReasoningEffort: 'low',
      hidden: false,
      isDefault: true,
    });
    assert.deepEqual(parseCodexModelOption({ id: 'text-only' })?.inputModalities, []);
  });

  it('deduplicates pages, hides hidden models, and puts the default first', () => {
    const result = mergeCodexModelOptions([
      [{ id: 'zeta', displayName: 'Zeta' }, { id: 'secret', hidden: true }],
      [{ id: 'zeta', displayName: 'Zeta updated', isDefault: true }, { id: 'alpha', displayName: 'Alpha' }],
    ]);
    assert.deepEqual(result.map((item) => item.id), ['zeta', 'alpha']);
    assert.equal(result[0]?.displayName, 'Zeta updated');
  });

  it('reads model/list pages through the Runtime app-server boundary', async () => {
    const child = createFakeChild();
    const catalog = await discoverCodexModelCatalog({
      configuredModel: 'gpt-6-astra',
      executablePath: 'codex-test',
      runtimeEnv: { CODEX_HOME: process.cwd() },
      spawnProcess: () => child,
      timeoutMs: 1_000,
    });
    assert.equal(catalog.status, 'ready');
    assert.equal(catalog.configuredModel, 'gpt-6-astra');
    assert.deepEqual(catalog.models.map((model) => model.id), ['gpt-6-astra', 'gpt-5.6-sol']);
  });

  it('reads an external OpenAI-compatible /models catalog without exposing credentials', async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = '';
    let authorization = '';
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get('authorization') || '';
      return new Response(JSON.stringify({ data: [{ id: 'gpt-6-astra' }, { id: 'gpt-5.6-sol' }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const catalog = await discoverCodexModelCatalog({
        source: 'external_api',
        configuredModel: 'gpt-6-astra',
        baseUrl: 'https://proxy.example.test/v1',
        apiKey: 'secret-must-stay-in-runtime',
      });
      assert.equal(requestUrl, 'https://proxy.example.test/v1/models');
      assert.equal(authorization, 'Bearer secret-must-stay-in-runtime');
      assert.equal(catalog.source, 'openai_compatible');
      assert.equal(catalog.models[0]?.id, 'gpt-6-astra');
      assert.equal(JSON.stringify(catalog).includes('secret-must-stay-in-runtime'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('supplements the official catalog from a configured custom provider', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-codex-provider-'));
    fs.writeFileSync(path.join(home, 'config.toml'), [
      'model_provider = "cliproxyapi"',
      '',
      '[model_providers.cliproxyapi]',
      'base_url = "https://proxy.example.test/v1"',
      'http_headers = { x-openai-actor-authorization = "cliproxyapi" }',
      'experimental_bearer_token = "provider-secret"',
      '',
    ].join('\n'));
    const originalFetch = globalThis.fetch;
    let authorization = '';
    let actor = '';
    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers);
      authorization = headers.get('authorization') || '';
      actor = headers.get('x-openai-actor-authorization') || '';
      return new Response(JSON.stringify({ data: [{ id: 'gpt-6-astra' }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const catalog = await discoverCodexModelCatalog({
        configuredModel: 'gpt-6-astra',
        executablePath: 'codex-test',
        runtimeEnv: { CODEX_HOME: home },
        spawnProcess: () => createFakeChild(),
        timeoutMs: 1_000,
      });
      assert.equal(authorization, 'Bearer provider-secret');
      assert.equal(actor, 'cliproxyapi');
      assert.deepEqual(catalog.models.map((model) => model.id), ['gpt-6-astra', 'gpt-5.6-sol']);
      assert.equal(JSON.stringify(catalog).includes('provider-secret'), false);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads Ollama tags for the local source', async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = '';
    globalThis.fetch = (async (input) => {
      requestUrl = String(input);
      return new Response(JSON.stringify({ models: [{ name: 'qwen3-coder:30b' }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const catalog = await discoverCodexModelCatalog({
        source: 'local_api',
        configuredModel: 'qwen3-coder:30b',
        baseUrl: 'http://127.0.0.1:11434',
        localKind: 'ollama',
      });
      assert.equal(requestUrl, 'http://127.0.0.1:11434/api/tags');
      assert.equal(catalog.source, 'ollama');
      assert.equal(catalog.models[0]?.id, 'qwen3-coder:30b');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function createFakeChild(): CodexModelCatalogChild {
  const child = new EventEmitter() as CodexModelCatalogChild;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let page = 0;
  stdin.on('data', (chunk) => {
    const line = String(chunk).trim();
    if (!line) return;
    const request = JSON.parse(line) as { id?: number; method?: string };
    if (request.id === undefined) return;
    const result = request.method === 'model/list'
      ? page++ === 0
        ? { data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' }, { id: 'hidden', hidden: true }], nextCursor: 'next' }
        : { data: [{ id: 'gpt-6-astra', displayName: 'GPT-6 Astra', isDefault: true }], nextCursor: null }
      : {};
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  });
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    pid: 1234,
    exitCode: null,
    killed: false,
    kill: () => {
      (child as unknown as { killed: boolean }).killed = true;
      (child as unknown as { exitCode: number }).exitCode = 0;
      stdin.end();
      stdout.end();
      stderr.end();
      return true;
    },
  });
  return child;
}
