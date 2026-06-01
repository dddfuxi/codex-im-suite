import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getLocalCodexProviderAdapter,
  getLocalCodexProviderCapabilities,
} from '../local-codex-provider-registry.js';

describe('local Codex provider registry', () => {
  it('builds an Ollama Codex CLI command from the configured model', () => {
    const adapter = getLocalCodexProviderAdapter('ollama');
    const command = adapter.buildCommand({ model: 'qwen2.5-coder:7b', outputLastMessagePath: 'last.txt' });

    assert.equal(adapter.supportsCodexAgent, true);
    assert.equal(command.command, 'codex');
    assert.deepEqual(command.args.slice(0, 7), [
      'exec',
      '--oss',
      '--local-provider',
      'ollama',
      '--model',
      'qwen2.5-coder:7b',
      '--json',
    ]);
    assert.ok(command.args.includes('--output-last-message'));
    assert.equal(adapter.normalizeBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
    assert.equal(adapter.normalizeBaseUrl('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434');
  });

  it('builds an LM Studio Codex CLI command from the configured model', () => {
    const adapter = getLocalCodexProviderAdapter('lmstudio');
    const command = adapter.buildCommand({ model: 'local-model' });

    assert.equal(adapter.supportsCodexAgent, true);
    assert.deepEqual(command.args.slice(0, 6), [
      'exec',
      '--oss',
      '--local-provider',
      'lmstudio',
      '--model',
      'local-model',
    ]);
  });

  it('marks OpenAI-compatible providers as unsupported for Codex OSS agent execution', () => {
    const adapter = getLocalCodexProviderAdapter('vllm');
    const capabilities = getLocalCodexProviderCapabilities('vllm');

    assert.equal(adapter.supportsCodexAgent, false);
    assert.equal(capabilities.supportsCodexAgent, false);
    assert.match(capabilities.unsupportedReason || '', /Codex CLI OSS agent/);
    assert.throws(() => adapter.buildCommand({ model: 'qwen' }), /Codex CLI OSS agent/);
  });

  it('extracts token usage from Codex exec JSONL turn.completed events', () => {
    const adapter = getLocalCodexProviderAdapter('ollama');
    const usage = adapter.extractUsage({
      type: 'turn.completed',
      usage: {
        input_tokens: 4096,
        cached_input_tokens: 128,
        output_tokens: 32,
      },
    });

    assert.equal(usage?.input_tokens, 4096);
    assert.equal(usage?.cache_read_input_tokens, 128);
    assert.equal(usage?.output_tokens, 32);
    assert.equal(usage?.total_tokens, 4128);
  });
});
