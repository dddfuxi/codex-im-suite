import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { Config } from '../config.js';
import { OllamaProvider, parseOllamaTags } from '../local-llm-provider.js';

const baseConfig: Config = {
  runtime: 'codex',
  enabledChannels: [],
  defaultWorkDir: process.cwd(),
  defaultMode: 'code',
  ollamaEnabled: true,
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen2.5-coder:7b',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('OllamaProvider', () => {
  it('calls Ollama OpenAI-compatible chat completions endpoint', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    globalThis.fetch = (async (url, init) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body || '');
      return new Response(JSON.stringify({
        choices: [{ message: { content: '本地回答' } }],
        usage: { total_tokens: 3 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const provider = new OllamaProvider(baseConfig);
    const result = await provider.complete([{ role: 'user', content: 'ping' }]);

    assert.equal(capturedUrl, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.match(capturedBody, /qwen2\.5-coder:7b/);
    assert.equal(result.text, '本地回答');
  });

  it('parses Ollama tag responses and detects configured model', () => {
    const tags = parseOllamaTags({
      models: [
        { name: 'llama3.1:8b' },
        { name: 'qwen2.5-coder:7b' },
      ],
    });

    assert.deepEqual(tags, ['llama3.1:8b', 'qwen2.5-coder:7b']);
  });
});
