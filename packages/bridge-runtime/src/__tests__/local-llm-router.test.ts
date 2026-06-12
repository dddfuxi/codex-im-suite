import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

import type { Config } from '../config.js';
import {
  buildLightChatParams,
  buildLocalRoutePrompt,
  createCompressedParams,
  decideConservativeRoute,
  getLocalRouterMode,
  isLightChatCandidate,
  parseLocalRoutePayload,
  shouldRunPreCodexLocalFastPath,
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

describe('shouldRunPreCodexLocalFastPath', () => {
  it('only allows pre-Codex fast-path in local_only mode', () => {
    assert.equal(shouldRunPreCodexLocalFastPath('local_only'), true);
    assert.equal(shouldRunPreCodexLocalFastPath('hybrid'), false);
    assert.equal(shouldRunPreCodexLocalFastPath('codex_only'), false);
  });
});

describe('decideConservativeRoute', () => {
  it('identifies short Feishu light chat as a lightweight chat task', () => {
    const decision = decideConservativeRoute(makeParams('在呢', {
      permissionMode: 'acceptEdits',
      systemPrompt: [
        'Channel assistant identity:',
        'Feishu emoji presentation:',
        'Feishu sticker library:',
        'Bridge channel context (authoritative):',
        'MCP, Unity, workspace, files, commands, and artifacts are available for real tasks.',
      ].join('\n'),
      conversationHistory: [
        { role: 'user', content: '前面一句普通闲聊' },
        { role: 'assistant', content: '我在' },
        { role: 'user', content: '小虾米' },
      ],
    }), baseConfig);

    assert.equal(decision.requestKind, 'light_chat');
    assert.equal(decision.preferredDecision, 'answer_local');
    assert.equal(decision.useLocal, true);
    assert.equal(decision.canFastPath, true);
  });

  it('does not classify tool-like or attachment turns as light chat', () => {
    assert.equal(isLightChatCandidate(makeParams('帮我执行 git status'), baseConfig), false);
    assert.equal(isLightChatCandidate(makeParams('看一下这张图里是什么', {
      files: [{ id: 'file-1', name: 'image.png', type: 'image/png', size: 12, data: 'AAAA' }],
    }), baseConfig), false);
    assert.equal(isLightChatCandidate(makeParams('帮我检查 Unity MCP 为什么连不上'), baseConfig), false);
  });

  it('builds a light chat prompt profile without long tool context', () => {
    const params = makeParams('收到啦', {
      systemPrompt: [
        'Channel assistant identity: 小虾米',
        'Feishu emoji presentation: do not default to SMILE',
        'Feishu sticker library: [表情包:收到]',
        'Bridge channel context (authoritative): includes MCP, Unity, workspace, commands and artifacts',
        'Reply presentation contract: concise',
      ].join('\n'),
      conversationHistory: [
        { role: 'user', content: '第一条历史' },
        { role: 'assistant', content: '第二条历史' },
        { role: 'user', content: '第三条历史' },
      ],
    });

    const light = buildLightChatParams(params, baseConfig);

    assert.equal(light.conversationHistory?.length, 2);
    assert.match(light.systemPrompt || '', /Channel assistant identity/);
    assert.match(light.systemPrompt || '', /Feishu emoji presentation/);
    assert.match(light.systemPrompt || '', /Feishu sticker library/);
    assert.match(light.systemPrompt || '', /Light chat reply contract/);
    assert.doesNotMatch(light.systemPrompt || '', /Bridge channel context/);
    assert.doesNotMatch(light.systemPrompt || '', /MCP|Unity|workspace|artifacts/i);
  });

  it('routes simple command generation to local model', () => {
    const decision = decideConservativeRoute(makeParams('给我一条 PowerShell 命令，递归查找 .meta 文件。只返回命令。'), baseConfig);
    assert.equal(decision.useLocal, true);
    assert.equal(decision.requestKind, 'command_draft');
  });

  it('routes common Chinese git read-only queries to local repo path', () => {
    const statusDecision = decideConservativeRoute(makeParams('帮我看看 git 状态'), baseConfig);
    assert.equal(statusDecision.useLocal, false);
    assert.equal(statusDecision.allowLocalFallback, true);
    assert.equal(statusDecision.requestKind, 'repo_query');
    assert.equal(statusDecision.preferredDecision, 'escalate_codex');

    const branchDecision = decideConservativeRoute(makeParams('当前分支是什么'), baseConfig);
    assert.equal(branchDecision.useLocal, false);
    assert.equal(branchDecision.allowLocalFallback, true);
    assert.equal(branchDecision.requestKind, 'repo_query');

    const logDecision = decideConservativeRoute(makeParams('最近几条提交'), baseConfig);
    assert.equal(logDecision.useLocal, false);
    assert.equal(logDecision.allowLocalFallback, true);
    assert.equal(logDecision.requestKind, 'repo_query');

    const stagedDecision = decideConservativeRoute(makeParams('当前git暂存区有啥'), baseConfig);
    assert.equal(stagedDecision.useLocal, false);
    assert.equal(stagedDecision.allowLocalFallback, true);
    assert.equal(stagedDecision.requestKind, 'repo_query');
  });

  it('treats shutdown-like requests as high risk', () => {
    const decision = decideConservativeRoute(makeParams('现在给我关机，shutdown /s /t 0'), baseConfig);
    assert.equal(decision.useLocal, false);
    assert.equal(decision.highRisk, true);
    assert.match(decision.reason, /系统级高风险操作/);
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

  it('local-only tool blocker does not ask the user to manually inspect', async () => {
    const { LocalLlamaProvider } = await import('../local-llm-provider.js');
    const provider = new LocalLlamaProvider(baseConfig);
    const message = provider.buildLocalOnlyMessage('unity_like', '涉及 Unity 或 Unity MCP');
    assert.match(message, /只报告阻塞原因/);
    assert.doesNotMatch(message, /建议步骤|手动检查/);
  });
});
