import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

import type { Config } from '../config.js';
import {
  buildLocalRoutePrompt,
  createCompressedParams,
  decideConservativeRoute,
  getLocalRouterMode,
  parseLocalRoutePayload,
} from '../local-llm-router.js';

const baseConfig: Config = {
  runtime: 'codex',
  enabledChannels: [],
  defaultWorkDir: process.cwd(),
  defaultMode: 'code',
  localLlmEnabled: true,
  localLlmAutoRoute: true,
  localLlmRouterEnabled: true,
  localLlmRouterMode: 'hybrid',
  localLlmForceHub: true,
  localLlmMaxInputChars: 6000,
  localLlmRouterMaxInputChars: 6000,
  localLlmRouterMaxHistoryItems: 6,
};

function makeParams(prompt: string, overrides: Partial<StreamChatParams> = {}): StreamChatParams {
  return {
    sessionId: 'test-session',
    prompt,
    systemPrompt: '',
    permissionMode: 'default',
    workingDirectory: process.cwd(),
    model: 'gpt-5.4',
    conversationHistory: [],
    ...overrides,
  };
}

describe('getLocalRouterMode', () => {
  it('uses hybrid by default', () => {
    assert.equal(getLocalRouterMode(baseConfig), 'hybrid');
  });

  it('falls back to local_only when legacy fallback is disabled', () => {
    assert.equal(getLocalRouterMode({ ...baseConfig, localLlmRouterMode: undefined, localLlmFallbackToCodex: false }), 'local_only');
  });
});

describe('decideConservativeRoute', () => {
  it('routes simple command generation to local model', () => {
    const decision = decideConservativeRoute(makeParams('给我一条 PowerShell 命令，递归查找 .meta 文件。只返回命令。'), baseConfig);
    assert.equal(decision.useLocal, true);
    assert.equal(decision.requestKind, 'command_draft');
  });

  it('rejects Unity and MCP related requests', () => {
    const decision = decideConservativeRoute(makeParams('帮我检查 Unity MCP 为什么连不上'), baseConfig);
    assert.equal(decision.useLocal, false);
    assert.equal(decision.highRisk, true);
    assert.match(decision.reason, /Unity/);
  });

  it('rejects git write operations', () => {
    const decision = decideConservativeRoute(makeParams('帮我执行 git pull 并处理冲突'), baseConfig);
    assert.equal(decision.useLocal, false);
    assert.equal(decision.highRisk, true);
    assert.match(decision.reason, /仓库写操作|发布/);
  });

  it('rejects requests with attachments', () => {
    const decision = decideConservativeRoute(
      makeParams('请总结这个附件里的内容', {
        files: [{ id: 'file-1', name: 'error.log', type: 'text/plain', size: 12, data: 'ZXJyb3I=', filePath: 'C:\\tmp\\error.log' }],
      }),
      baseConfig,
    );
    assert.equal(decision.useLocal, false);
    assert.match(decision.reason, /附件/);
  });

  it('rejects write-mode requests', () => {
    const decision = decideConservativeRoute(makeParams('直接帮我改这个脚本', { permissionMode: 'acceptEdits' }), baseConfig);
    assert.equal(decision.useLocal, false);
    assert.match(decision.reason, /写入模式/);
  });
});

describe('route protocol helpers', () => {
  it('builds router prompt with compressed request and history', () => {
    const prompt = buildLocalRoutePrompt(
      makeParams('解释这个 JSON 配置的作用', {
        conversationHistory: [
          { role: 'user', content: '之前我们讨论过路由模式。' },
          { role: 'assistant', content: '当前是 hybrid。' },
        ],
      }),
      baseConfig,
    );
    assert.match(prompt, /当前用户请求/);
    assert.match(prompt, /最近相关历史/);
  });

  it('parses strict JSON route payload', () => {
    const route = parseLocalRoutePayload(
      '{"decision":"answer_local","taskKind":"summarize","reason":"这是简单总结","needsCodex":false,"canAnswerLocally":true,"compressedPrompt":"总结这段日志","compressedHistory":"User: 日志很短","suggestedReplyMode":"concise","safetyFlags":["low_risk"]}',
      makeParams('总结一下'),
      baseConfig,
    );
    assert.equal(route.decision, 'answer_local');
    assert.equal(route.taskKind, 'summarize');
    assert.equal(route.compressedPrompt, '总结这段日志');
  });

  it('creates compressed params for Codex escalation', () => {
    const next = createCompressedParams(
      makeParams('帮我整理一下这个问题'),
      '只保留必要问题描述',
      'User: 关键上下文',
      '本地路由建议升级',
    );
    assert.equal(next.prompt, '只保留必要问题描述');
    assert.equal(next.conversationHistory?.length, 1);
    assert.match(next.systemPrompt || '', /Local router summary/);
  });
});
