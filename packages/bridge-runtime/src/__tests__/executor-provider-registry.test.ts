import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

import type { Config } from '../config.js';
import { ExecutorProviderRegistry } from '../executor-provider-registry.js';
import { buildExecutorManifests } from '../executor-registry.js';
import type { ExecutorRequest } from '../executor-types.js';

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
  mavisEnabled: true,
  mavisCliPath: 'mavis',
};

const configWithMavisOff: Config = { ...baseConfig, mavisEnabled: false };

function params(prompt: string): StreamChatParams {
  return {
    sessionId: 'session-1',
    prompt,
    workingDirectory: process.cwd(),
    permissionMode: 'default',
    conversationHistory: [],
  };
}

function buildRequest(overrides: Partial<ExecutorRequest> = {}): ExecutorRequest {
  return {
    sessionId: 'session-1',
    prompt: 'check git status',
    workingDirectory: process.cwd(),
    permissionMode: 'default',
    params: params('check git status'),
    ...overrides,
  };
}

describe('executor provider registry', () => {
  it('does not advertise mavis-agent in buildExecutorManifests when mavisEnabled=false', () => {
    const manifests = buildExecutorManifests(configWithMavisOff);
    const mavis = manifests.find((m) => m.id === 'mavis-agent');
    assert.ok(mavis);
    assert.equal(mavis.enabled, false);
  });

  it('advertises mavis-agent in buildExecutorManifests when mavisEnabled=true and cliPath is set', () => {
    const manifests = buildExecutorManifests(baseConfig);
    const mavis = manifests.find((m) => m.id === 'mavis-agent');
    assert.ok(mavis);
    assert.equal(mavis.enabled, true);
    assert.equal(mavis.kind, 'agent');
  });

  it('accepts a complete ExecutorRequest and does not derive fields from StreamChatParams', () => {
    const registry = new ExecutorProviderRegistry();
    const fakeExternal = { streamChat: () => new ReadableStream<string>({ start(c) { c.close(); } }) };
    registry.register('mavis-agent', fakeExternal as never);

    const request = buildRequest({ requestedExecutorId: 'mavis-agent' });
    const dispatch = registry.resolveForRequest(baseConfig, request, fakeExternal as never);
    assert.equal(dispatch.isExternal, true);
    assert.equal(dispatch.selection.executor.id, 'mavis-agent');
  });

  it('falls back to default provider for codex selection (isExternal=false)', () => {
    const registry = new ExecutorProviderRegistry();
    const fakeCodex = { streamChat: () => new ReadableStream<string>({ start(c) { c.close(); } }) };
    const fakeExternal = { streamChat: () => new ReadableStream<string>({ start(c) { c.close(); } }) };
    registry.register('mavis-agent', fakeExternal as never);

    const request = buildRequest({ requestedExecutorId: 'codex' });
    const dispatch = registry.resolveForRequest(baseConfig, request, fakeCodex as never);
    assert.equal(dispatch.isExternal, false);
    assert.equal(dispatch.provider, fakeCodex);
    assert.equal(dispatch.selection.executor.id, 'codex');
  });

  // v3.2 实施级问题 ④ + v3.3 P1 必修：sessionDefaultId 折进 requestedExecutorId；@hint 优先于 sessionDefault
  it('caller-folding case: sessionDefaultId in requestedExecutorId picks mavis-agent when no @hint', () => {
    const registry = new ExecutorProviderRegistry();
    const fakeExternal = { streamChat: () => new ReadableStream<string>({ start(c) { c.close(); } }) };
    registry.register('mavis-agent', fakeExternal as never);

    // Caller has already folded: hintedExecutorId ?? sessionDefaultId → 'mavis-agent'
    const request = buildRequest({ requestedExecutorId: 'mavis-agent' });
    const dispatch = registry.resolveForRequest(baseConfig, request, fakeExternal as never);
    assert.equal(dispatch.isExternal, true);
    assert.equal(dispatch.selection.executor.id, 'mavis-agent');
  });

  // v3.3 P1 + v3.4 残留：@hint 严格优先于 sessionDefault
  it('@hint strictly wins over sessionDefault (v3.3 P1 + v3.4 残留 P2)', () => {
    const registry = new ExecutorProviderRegistry();
    const fakeCodex = { streamChat: () => new ReadableStream<string>({ start(c) { c.close(); } }) };
    const fakeMavis = { streamChat: () => new ReadableStream<string>({ start(c) { c.close(); } }) };
    registry.register('mavis-agent', fakeMavis as never);

    // Caller computed: hintedExecutorId = 'codex' (from @codex), sessionDefaultId = 'mavis-agent'
    // Final: hintedExecutorId ?? sessionDefaultId ?? undefined === 'codex'
    // → selectExecutor sees requestedExecutorId='codex' and routes to codex (NOT mavis).
    const request = buildRequest({
      requestedExecutorId: 'codex',          // = hintedExecutorId
      // (caller's local sessionDefault would be 'mavis-agent' but it's been folded away)
      prompt: '@codex take over',
    });
    const dispatch = registry.resolveForRequest(baseConfig, request, fakeCodex as never);
    assert.equal(dispatch.isExternal, false);
    assert.equal(dispatch.selection.executor.id, 'codex');
  });

  it('@mavis hint resolves to mavis-agent via selectExecutor (when mavis-agent enabled)', () => {
    const registry = new ExecutorProviderRegistry();
    const fakeMavis = { streamChat: () => new ReadableStream<string>({ start(c) { c.close(); } }) };
    registry.register('mavis-agent', fakeMavis as never);

    // requestedExecutorId is undefined → selectExecutor will infer from prompt
    const request = buildRequest({
      prompt: '@mavis summarize logs',
      requestedExecutorId: undefined,
    });
    const dispatch = registry.resolveForRequest(baseConfig, request, fakeMavis as never);
    assert.equal(dispatch.isExternal, true);
    assert.equal(dispatch.selection.executor.id, 'mavis-agent');
  });

  it('registers and unregisters executors dynamically', () => {
    const registry = new ExecutorProviderRegistry();
    const fake = { streamChat: () => new ReadableStream<string>({ start(c) { c.close(); } }) };
    assert.equal(registry.has('mavis-agent'), false);
    registry.register('mavis-agent', fake as never);
    assert.equal(registry.has('mavis-agent'), true);
    registry.unregister('mavis-agent');
    assert.equal(registry.has('mavis-agent'), false);
  });

  it('returns the default provider when external executor is not registered', () => {
    const registry = new ExecutorProviderRegistry();
    const fakeCodex = { streamChat: () => new ReadableStream<string>({ start(c) { c.close(); } }) };

    // requestedExecutorId = 'mavis-agent' but registry has no provider for it
    const request = buildRequest({ requestedExecutorId: 'mavis-agent' });
    const dispatch = registry.resolveForRequest(baseConfig, request, fakeCodex as never);
    assert.equal(dispatch.isExternal, false);
    assert.equal(dispatch.provider, fakeCodex);
    assert.equal(dispatch.selection.executor.id, 'mavis-agent');
  });

  it('does not accept a 4th sessionDefaultId argument (caller folds it in)', () => {
    // v3.2 选项 A：registry 只接 ExecutorRequest + defaultProvider。
    // 这里用类型断言来强制：编译期就报"too many arguments"。
    const registry = new ExecutorProviderRegistry();
    const fake = { streamChat: () => new ReadableStream<string>({ start(c) { c.close(); } }) };
    const request = buildRequest({ requestedExecutorId: 'mavis-agent' });
    // @ts-expect-error — 4th argument is not part of the v3.2 contract.
    registry.resolveForRequest(baseConfig, request, fake, 'mavis-agent');
  });
});
