import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME, type Config } from '../config.js';
import {
  probeLocalModelCapabilities,
  shouldTrustLocalApiForExecution,
} from '../local-model-capability.js';

const originalFetch = globalThis.fetch;
const capabilityPath = path.join(CTI_HOME, 'runtime', 'local-model-capabilities.json');
const statusPath = path.join(CTI_HOME, 'runtime', 'local-llm-status.json');

const baseConfig: Config = {
  runtime: 'codex',
  enabledChannels: [],
  defaultWorkDir: process.cwd(),
  defaultMode: 'code',
  localAiKind: 'ollama',
  localAiBaseUrl: 'http://127.0.0.1:11434',
  localAiModel: 'qwen3:14b',
  localAiTimeoutMs: 10000,
  localAgentMode: 'agent_verified',
  localToolCallRequired: true,
  executionRequiredRoute: 'codex_or_external',
};

describe('local model capability probing', () => {
  beforeEach(() => {
    fs.rmSync(capabilityPath, { force: true });
    fs.rmSync(statusPath, { force: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(capabilityPath, { force: true });
    fs.rmSync(statusPath, { force: true });
  });

  it('trusts a local API for execution only after structured tool calls pass', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (url, init) => {
      requestedUrl = String(url);
      const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: unknown[] };
      assert.equal(Array.isArray(body.tools), true);
      return new Response(JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  type: 'function',
                  function: { name: 'cti_probe_echo', arguments: '{"marker":"cti-tool-probe"}' },
                },
              ],
            },
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const profile = await probeLocalModelCapabilities(baseConfig);

    assert.equal(requestedUrl, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(profile.toolCallingState, 'passed');
    assert.equal(profile.recommendedMode, 'agent_verified');
    assert.equal(shouldTrustLocalApiForExecution(baseConfig), true);
  });

  it('keeps text-only local APIs away from execution tasks', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: 'I would call a tool here.' },
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const profile = await probeLocalModelCapabilities(baseConfig);

    assert.equal(profile.toolCallingState, 'text_only');
    assert.equal(profile.recommendedMode, 'text_only');
    assert.equal(shouldTrustLocalApiForExecution(baseConfig), false);
  });

  it('allows explicit unsafe override when tool-call requirement is disabled', () => {
    assert.equal(shouldTrustLocalApiForExecution({
      ...baseConfig,
      localToolCallRequired: false,
    }), true);
  });
});
