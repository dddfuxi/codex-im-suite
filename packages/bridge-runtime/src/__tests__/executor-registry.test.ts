import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

import type { Config } from '../config.js';
import {
  buildExecutorManifests,
  buildToolSandboxPolicy,
  inferCapabilities,
  inferRequestedExecutorId,
  selectExecutor,
} from '../executor-registry.js';

const baseConfig: Config = {
  runtime: 'codex',
  enabledChannels: [],
  defaultWorkDir: process.cwd(),
  defaultMode: 'code',
  allowedWorkspaceRoots: [process.cwd()],
  localLlmEnabled: true,
  localLlmRouterMode: 'hybrid',
  localLlmForceHub: true,
  ollamaEnabled: true,
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen2.5-coder:7b',
  codexLocalFallbackEnabled: true,
};

function params(prompt: string): StreamChatParams {
  return {
    sessionId: 'session-1',
    prompt,
    workingDirectory: process.cwd(),
    permissionMode: 'default',
    conversationHistory: [],
  };
}

describe('executor registry', () => {
  it('registers codex and local agent fallback executors', () => {
    const manifests = buildExecutorManifests(baseConfig);
    assert.ok(manifests.some((manifest) => manifest.id === 'codex'));
    assert.ok(manifests.some((manifest) => manifest.id === 'codex-local-fallback'));
    assert.ok(manifests.some((manifest) => manifest.id === 'local-tool-agent'));
    assert.ok(manifests.some((manifest) => manifest.id === 'codex-oss-ollama'));
    assert.equal(manifests.find((manifest) => manifest.id === 'codex-local-fallback')?.enabled, true);
    assert.equal(manifests.find((manifest) => manifest.id === 'local-tool-agent')?.kind, 'agent');
    assert.equal(manifests.find((manifest) => manifest.id === 'local-tool-agent')?.enabled, false);
    assert.equal(manifests.find((manifest) => manifest.id === 'codex-oss-ollama')?.kind, 'cli');
  });

  it('keeps local fallback disabled unless explicitly enabled', () => {
    const manifests = buildExecutorManifests({
      ...baseConfig,
      codexLocalFallbackEnabled: undefined,
    });
    assert.equal(manifests.find((manifest) => manifest.id === 'codex-local-fallback')?.enabled, false);
  });

  it('disables codex-oss-ollama when local AI is not Ollama', () => {
    const manifests = buildExecutorManifests({
      ...baseConfig,
      localAiKind: 'openai-compatible',
      localAiBaseUrl: 'http://127.0.0.1:1234',
      localAiModel: 'lmstudio-model',
    });
    assert.equal(manifests.find((manifest) => manifest.id === 'codex-local-fallback')?.enabled, true);
    assert.equal(manifests.find((manifest) => manifest.id === 'local-tool-agent')?.enabled, false);
    assert.equal(manifests.find((manifest) => manifest.id === 'codex-oss-ollama')?.enabled, false);
  });

  it('surfaces local API tool-call trust state in executor metadata', () => {
    const manifests = buildExecutorManifests({
      ...baseConfig,
      codexModelSource: 'local_api',
      localAgentMode: 'text_only',
      localToolCallRequired: true,
      executionRequiredRoute: 'codex_or_external',
    });
    const codex = manifests.find((manifest) => manifest.id === 'codex');
    assert.equal(codex?.configSchema?.modelSource, 'local_api');
    assert.equal(codex?.configSchema?.localAgentMode, 'text_only');
    assert.equal(codex?.configSchema?.localToolCallingState, 'untested');
    assert.equal(codex?.configSchema?.localExecutionTrusted, false);
  });

  it('detects explicit executor hints', () => {
    assert.equal(inferRequestedExecutorId('@codex 帮我看一下状态'), 'codex');
    assert.equal(inferRequestedExecutorId('@local 帮我总结这段日志'), 'codex-local-fallback');
    assert.equal(inferRequestedExecutorId('@ollama 帮我总结这段日志'), 'codex-oss-ollama');
    assert.equal(inferRequestedExecutorId('@claude 处理这个问题'), 'claude-cli');
  });

  it('selects an explicit executor over automatic routing', () => {
    const selection = selectExecutor(baseConfig, {
      sessionId: 'session-1',
      prompt: '@local 帮我看看 git 状态',
      requestedExecutorId: 'codex-local-fallback',
      params: params('@local 帮我看看 git 状态'),
    });
    assert.equal(selection.executor.id, 'codex-local-fallback');
    assert.equal(selection.explicit, true);
  });

  it('keeps automatic routing distinct from preferred executor bias', () => {
    const selection = selectExecutor(baseConfig, {
      sessionId: 'session-1',
      prompt: '帮我看看 git 状态',
      preferredExecutorId: 'codex',
      params: params('帮我看看 git 状态'),
    });
    assert.equal(selection.executor.id, 'codex');
    assert.equal(selection.explicit, false);
  });

  it('infers capabilities from prompt and attachments', () => {
    const caps = inferCapabilities({
      ...params('搜索文件并读取结果'),
      files: [{ id: 'img', name: 'a.png', type: 'image/png', size: 1, data: 'AA==' }],
    });
    assert.ok(caps.includes('file_read'));
    assert.ok(caps.includes('image_input'));
  });

  it('builds a conservative sandbox policy for local agent', () => {
    const policy = buildToolSandboxPolicy(baseConfig);
    assert.equal(policy.allowReadOnlyGit, true);
    assert.equal(policy.highRiskRequiresPermission, true);
    assert.deepEqual(policy.allowedWorkspaceRoots, [process.cwd()]);
  });
});
