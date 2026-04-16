import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

import type { Config } from '../config.js';
import { decideLocalRoute } from '../local-llm-router.js';

const baseConfig: Config = {
  runtime: 'codex',
  enabledChannels: [],
  defaultWorkDir: process.cwd(),
  defaultMode: 'code',
  localLlmEnabled: true,
  localLlmAutoRoute: true,
  localLlmMaxInputChars: 6000,
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

describe('decideLocalRoute', () => {
  it('routes simple command generation to local model', () => {
    const decision = decideLocalRoute(
      makeParams('帮我写一个 PowerShell 命令，递归查找 .meta 文件'),
      baseConfig,
    );
    assert.equal(decision.useLocal, true);
    assert.equal(decision.requestKind, 'command');
  });

  it('rejects Unity and MCP related requests', () => {
    const decision = decideLocalRoute(
      makeParams('帮我检查 Unity MCP 为什么连不上'),
      baseConfig,
    );
    assert.equal(decision.useLocal, false);
    assert.equal(decision.requestKind, 'excluded');
    assert.match(decision.reason, /Unity\/Blender\/MCP/);
  });

  it('rejects requests with attachments', () => {
    const decision = decideLocalRoute(
      makeParams('请总结这个附件里的内容', {
        files: [{ id: 'file-1', name: 'error.log', type: 'text/plain', size: 12, data: 'ZXJyb3I=', filePath: 'C:\\tmp\\error.log' }],
      }),
      baseConfig,
    );
    assert.equal(decision.useLocal, false);
    assert.match(decision.reason, /附件/);
  });

  it('rejects write-mode requests', () => {
    const decision = decideLocalRoute(
      makeParams('直接帮我改这个脚本', { permissionMode: 'acceptEdits' }),
      baseConfig,
    );
    assert.equal(decision.useLocal, false);
    assert.match(decision.reason, /写入模式/);
  });

  it('rejects long history even if prompt is simple', () => {
    const longMessage = 'a'.repeat(2000);
    const decision = decideLocalRoute(
      makeParams('解释这个 JSON 配置的作用', {
        conversationHistory: [
          { role: 'user', content: longMessage },
          { role: 'assistant', content: longMessage },
        ],
      }),
      baseConfig,
    );
    assert.equal(decision.useLocal, false);
    assert.match(decision.reason, /历史上下文过长/);
  });
});
