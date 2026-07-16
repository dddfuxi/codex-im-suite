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

  it('places structured turn focus after recalled history and immediately before the current request', async () => {
    let capturedBody = '';
    globalThis.fetch = (async (_url, init) => {
      capturedBody = String(init?.body || '');
      return new Response(JSON.stringify({
        choices: [{ message: { content: '本地回答' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const provider = new OllamaProvider(baseConfig);
    await provider.answer({
      prompt: '继续处理',
      sessionId: 'local-focus-order',
      priorityTurnContext: 'Resolved turn focus: reply-1',
      conversationHistory: [
        { role: 'user', content: '无关旧问题' },
        { role: 'assistant', content: '无关旧回答' },
      ],
    }, {
      mode: 'local_only',
    });

    const body = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
    const userPrompt = body.messages.find((item) => item.role === 'user')?.content || '';
    assert.ok(userPrompt.indexOf('最近相关上下文') < userPrompt.indexOf('Current turn context evidence'));
    assert.ok(userPrompt.indexOf('Current turn context evidence') < userPrompt.indexOf('当前请求'));
  });

  it('calls custom OpenAI-compatible local AI endpoint with bearer token', async () => {
    let capturedUrl = '';
    let capturedAuth = '';
    let capturedBody = '';
    globalThis.fetch = (async (url, init) => {
      capturedUrl = String(url);
      capturedAuth = String(new Headers(init?.headers).get('authorization') || '');
      capturedBody = String(init?.body || '');
      return new Response(JSON.stringify({
        choices: [{ message: { content: '自定义回答' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const provider = new OllamaProvider({
      ...baseConfig,
      localAiKind: 'openai-compatible',
      localAiBaseUrl: 'http://127.0.0.1:1234',
      localAiModel: 'lmstudio-model',
      localAiApiKey: 'secret-key',
      localAiTimeoutMs: 30000,
    });
    const result = await provider.complete([{ role: 'user', content: 'ping' }]);

    assert.equal(capturedUrl, 'http://127.0.0.1:1234/v1/chat/completions');
    assert.equal(capturedAuth, 'Bearer secret-key');
    assert.match(capturedBody, /lmstudio-model/);
    assert.equal(result.text, '自定义回答');
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

  it('honors a short caller deadline for latency-sensitive requests', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    globalThis.fetch = ((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    })) as typeof fetch;

    const provider = new OllamaProvider(baseConfig);
    const pending = provider.complete(
      [{ role: 'user', content: 'ping' }],
      { timeoutMs: 250 },
    );
    t.mock.timers.tick(5000);

    await assert.rejects(pending, /本地模型超时\(250ms\)/);
  });
});
