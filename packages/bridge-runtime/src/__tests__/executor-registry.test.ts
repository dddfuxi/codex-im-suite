import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { StreamChatParams } from 'claude-to-im/host';

import type { Config } from '../config.js';
import {
  applyMavisDefaultExecutor,
  buildExecutorManifests,
  buildToolSandboxPolicy,
  getConfiguredDefaultExecutorId,
  inferCapabilities,
  inferRequestedExecutorId,
  listMavisReadOnlyForbiddenCapabilities,
  MAVIS_READ_ONLY_ALLOWED_CAPABILITIES,
  resolveRequestedExecutorId,
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
  it('registers codex model sources without legacy local tool agent', () => {
    const manifests = buildExecutorManifests(baseConfig);
    assert.ok(manifests.some((manifest) => manifest.id === 'codex'));
    assert.ok(manifests.some((manifest) => manifest.id === 'codex-oss-ollama'));
    assert.equal(manifests.some((manifest) => manifest.id === 'local-tool-agent'), false);
    assert.equal(manifests.some((manifest) => manifest.id === 'codex-local-fallback'), false);
    assert.equal(manifests.find((manifest) => manifest.id === 'codex-oss-ollama')?.kind, 'cli');
  });

  it('disables codex-oss-ollama when local AI is not Ollama', () => {
    const manifests = buildExecutorManifests({
      ...baseConfig,
      localAiKind: 'openai-compatible',
      localAiBaseUrl: 'http://127.0.0.1:1234',
      localAiModel: 'lmstudio-model',
    });
    assert.equal(manifests.some((manifest) => manifest.id === 'codex-local-fallback'), false);
    assert.equal(manifests.some((manifest) => manifest.id === 'local-tool-agent'), false);
    assert.equal(manifests.find((manifest) => manifest.id === 'codex-oss-ollama')?.enabled, false);
  });

  it('surfaces local API as a Codex model source without fallback knobs', () => {
    const manifests = buildExecutorManifests({
      ...baseConfig,
      codexModelSource: 'local_api',
    });
    const codex = manifests.find((manifest) => manifest.id === 'codex');
    assert.equal(codex?.configSchema?.modelSource, 'local_api');
    assert.equal(codex?.configSchema?.localToolCallingState, 'untested');
    assert.equal(codex?.configSchema?.localExecutionTrusted, true);
    assert.equal(codex?.configSchema?.localAgentMode, undefined);
    assert.equal(codex?.configSchema?.localToolCallRequired, undefined);
    assert.equal(codex?.configSchema?.executionRequiredRoute, undefined);
    assert.equal(codex?.configSchema?.localFallbackEnabled, undefined);
    assert.equal(codex?.configSchema?.failureFallbackMode, undefined);
  });

  it('detects explicit executor hints', () => {
    assert.equal(inferRequestedExecutorId('@codex check status'), 'codex');
    assert.equal(inferRequestedExecutorId('@local summarize logs'), 'codex');
    assert.equal(inferRequestedExecutorId('@ollama summarize logs'), 'codex-oss-ollama');
    assert.equal(inferRequestedExecutorId('@claude handle issue'), 'claude-cli');
  });

  it('selects an explicit executor over automatic routing', () => {
    const selection = selectExecutor(baseConfig, {
      sessionId: 'session-1',
      prompt: '@local check git status',
      requestedExecutorId: 'codex',
      params: params('@local check git status'),
    });
    assert.equal(selection.executor.id, 'codex');
    assert.equal(selection.explicit, true);
  });

  it('keeps automatic routing distinct from preferred executor bias', () => {
    const selection = selectExecutor(baseConfig, {
      sessionId: 'session-1',
      prompt: 'check git status',
      preferredExecutorId: 'codex',
      params: params('check git status'),
    });
    assert.equal(selection.executor.id, 'codex');
    assert.equal(selection.explicit, false);
  });

  it('uses generic configured default executor before sticky session defaults', () => {
    assert.equal(
      resolveRequestedExecutorId(
        { ...baseConfig, defaultExecutorId: 'mavis-agent' },
        '帮我检查项目',
        'codex',
      ),
      'mavis-agent',
    );
    assert.equal(
      resolveRequestedExecutorId(
        { ...baseConfig, defaultExecutorId: 'mavis-agent' },
        '@codex 帮我检查项目',
        'mavis-agent',
      ),
      'codex',
    );
  });

  it('maps legacy mavisDefaultExecutor into the generic default executor slot', () => {
    assert.equal(getConfiguredDefaultExecutorId({
      ...baseConfig,
      mavisEnabled: true,
      mavisCliPath: 'mavis',
      mavisDefaultExecutor: true,
    }), 'mavis-agent');
    assert.equal(getConfiguredDefaultExecutorId({
      ...baseConfig,
      defaultExecutorId: 'codex',
      mavisEnabled: true,
      mavisCliPath: 'mavis',
      mavisDefaultExecutor: true,
    }), 'codex');
  });

  it('infers capabilities from prompt and attachments', () => {
    const caps = inferCapabilities({
      ...params('Get-Content package.json'),
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

  // v3.4: mavis external agent — opt-in executor
  it('does NOT register mavis-agent when mavisEnabled=false (opt-in default)', () => {
    const manifests = buildExecutorManifests({ ...baseConfig, mavisEnabled: false });
    const mavis = manifests.find((m) => m.id === 'mavis-agent');
    assert.ok(mavis);
    assert.equal(mavis.enabled, false);
    assert.equal(mavis.priority, 0);
  });

  it('registers mavis-agent with priority=50 when mavisEnabled=true and cliPath is set', () => {
    const manifests = buildExecutorManifests({
      ...baseConfig,
      mavisEnabled: true,
      mavisCliPath: 'mavis',
    });
    const mavis = manifests.find((m) => m.id === 'mavis-agent');
    assert.ok(mavis);
    assert.equal(mavis.enabled, true);
    assert.equal(mavis.priority, 50);
    assert.equal(mavis.kind, 'agent');
  });

  it('mavisReadOnly=true drops file_write and mcp_ops capabilities', () => {
    const manifests = buildExecutorManifests({
      ...baseConfig,
      mavisEnabled: true,
      mavisCliPath: 'mavis',
      mavisReadOnly: true,
    });
    const mavis = manifests.find((m) => m.id === 'mavis-agent');
    assert.ok(mavis);
    assert.equal(mavis.riskLevel, 'read_only');
    assert.ok(!mavis.capabilities.includes('file_write'));
    assert.ok(!mavis.capabilities.includes('mcp_ops'));
    assert.ok(mavis.capabilities.includes('file_read'));
  });

  it('@mavis / @minimax hint routes to mavis-agent via inferRequestedExecutorId', () => {
    assert.equal(inferRequestedExecutorId('@mavis summarize logs'), 'mavis-agent');
    assert.equal(inferRequestedExecutorId('@minimax draft email'), 'mavis-agent');
    assert.equal(inferRequestedExecutorId('@minimax-code refactor'), 'mavis-agent');
  });
});

// v3.5 P2 fix: mavisDefaultExecutor is no longer an empty switch. These
// tests pin the consumer-side semantics in isolation from main.ts.
describe('applyMavisDefaultExecutor (v3.5 P2 fix)', () => {
  const baseConfig: Config = {
    runtime: 'codex',
    enabledChannels: [],
    defaultWorkDir: process.cwd(),
    defaultMode: 'code',
    allowedWorkspaceRoots: [process.cwd()],
    mavisEnabled: true,
    mavisCliPath: 'mavis',
  };

  it('lazily writes mavis-agent when mavisDefaultExecutor=true and no sticky default exists', () => {
    const result = applyMavisDefaultExecutor(
      { ...baseConfig, mavisDefaultExecutor: true },
      'bridge-session-A',
      {},
    );
    assert.equal(result.wrote, true);
    assert.equal(result.sessionDefaultId, 'mavis-agent');
  });

  it('preserves an existing sticky default (does not overwrite)', () => {
    const result = applyMavisDefaultExecutor(
      { ...baseConfig, mavisDefaultExecutor: true },
      'bridge-session-A',
      { 'bridge-session-A': 'codex' },
    );
    assert.equal(result.wrote, false);
    assert.equal(result.sessionDefaultId, 'codex');
  });

  it('is a no-op when mavisDefaultExecutor=false', () => {
    const result = applyMavisDefaultExecutor(
      { ...baseConfig, mavisDefaultExecutor: false },
      'bridge-session-B',
      {},
    );
    assert.equal(result.wrote, false);
    assert.equal(result.sessionDefaultId, undefined);
  });

  it('is a no-op when mavisEnabled=false (cannot default to disabled executor)', () => {
    const result = applyMavisDefaultExecutor(
      { ...baseConfig, mavisDefaultExecutor: true, mavisEnabled: false },
      'bridge-session-C',
      {},
    );
    assert.equal(result.wrote, false);
    assert.equal(result.sessionDefaultId, undefined);
  });

  it('is a no-op when mavisCliPath is missing', () => {
    const result = applyMavisDefaultExecutor(
      { ...baseConfig, mavisDefaultExecutor: true, mavisCliPath: undefined },
      'bridge-session-D',
      {},
    );
    assert.equal(result.wrote, false);
    assert.equal(result.sessionDefaultId, undefined);
  });
});

// v3.6 P1 fix: broadened the file_write prompt heuristic so the
// read-only gate can no longer be bypassed by phrases like
// "删除 package.json" / "create file" / "remove lockfile" / "touch script"
// / "mv src dst" / "rm lockfile". The pre-existing pattern only matched
// `修改|写入|保存|生成文件|edit|patch`.
describe('inferCapabilities — v3.6 broadened file_write heuristic', () => {
  it('flags "delete" / "删除" / "remove" / "erase" as file_write', () => {
    assert.ok(inferCapabilities(params('please delete package-lock.json')).includes('file_write'));
    assert.ok(inferCapabilities(params('删除 package.json')).includes('file_write'));
    assert.ok(inferCapabilities(params('remove the stale lockfile')).includes('file_write'));
    assert.ok(inferCapabilities(params('erase tmp/cache.dat')).includes('file_write'));
    assert.ok(inferCapabilities(params('drop table.sql')).includes('file_write'));
  });

  it('flags "create" / "新建" / "touch" as file_write', () => {
    assert.ok(inferCapabilities(params('create a new file under src/')).includes('file_write'));
    assert.ok(inferCapabilities(params('新建文件 script.sh')).includes('file_write'));
    assert.ok(inferCapabilities(params('touch new-script.sh')).includes('file_write'));
    assert.ok(inferCapabilities(params('append a row to logs')).includes('file_write'));
  });

  it('flags short shell write commands (rm / mv) as file_write', () => {
    assert.ok(inferCapabilities(params('rm -rf dist/')).includes('file_write'));
    assert.ok(inferCapabilities(params('mv old.txt new.txt')).includes('file_write'));
    // Word-boundary safety: should NOT flag substrings like "arm" or "firm".
    assert.ok(!inferCapabilities(params('alarm the user about firm prices')).includes('file_write'));
  });

  it('flags "rename" / "重命名" / "replace" / "替换" / "update" as file_write', () => {
    assert.ok(inferCapabilities(params('rename the directory')).includes('file_write'));
    assert.ok(inferCapabilities(params('重命名 main.ts 到 index.ts')).includes('file_write'));
    assert.ok(inferCapabilities(params('replace placeholder with real value')).includes('file_write'));
    assert.ok(inferCapabilities(params('替换文本')).includes('file_write'));
    assert.ok(inferCapabilities(params('update the README')).includes('file_write'));
  });

  it('still treats pure read prompts as read-only', () => {
    const caps = inferCapabilities(params('查看 src/ 目录结构'));
    assert.ok(!caps.includes('file_write'));
    assert.ok(caps.includes('file_read'));
    assert.ok(!caps.includes('mcp_ops'));
  });

  it('still detects MCP / Unity / Blender intents', () => {
    assert.ok(inferCapabilities(params('call the unity MCP to open scene')).includes('mcp_ops'));
    assert.ok(inferCapabilities(params('use blender to render')).includes('mcp_ops'));
    assert.ok(inferCapabilities(params('ask ignis to generate')).includes('mcp_ops'));
  });
});

// v3.6 P1 fix: strict allow-list for read-only mode. The previous
// implementation was a blacklist (`required.includes('file_write') ||
// required.includes('mcp_ops')`); the new gate uses an allow-list so
// any future capability added to the readOnly manifest that we forget
// to enumerate in the gate can no longer silently bypass read-only
// mode.
describe('MAVIS_READ_ONLY_ALLOWED_CAPABILITIES + listMavisReadOnlyForbiddenCapabilities (v3.6 P1 fix)', () => {
  it('exposes the exact allow-list declared in the readOnly manifest', () => {
    assert.ok(MAVIS_READ_ONLY_ALLOWED_CAPABILITIES.has('chat'));
    assert.ok(MAVIS_READ_ONLY_ALLOWED_CAPABILITIES.has('repo_query'));
    assert.ok(MAVIS_READ_ONLY_ALLOWED_CAPABILITIES.has('file_read'));
    assert.ok(MAVIS_READ_ONLY_ALLOWED_CAPABILITIES.has('image_input'));
    assert.equal(MAVIS_READ_ONLY_ALLOWED_CAPABILITIES.size, 4);
  });

  it('flags file_write / mcp_ops as forbidden', () => {
    const required = inferCapabilities(params('删除 package.json'));
    const forbidden = listMavisReadOnlyForbiddenCapabilities(required);
    assert.ok(forbidden.includes('file_write'));
  });

  it('flags mcp_ops as forbidden even if file_write is absent', () => {
    const required = inferCapabilities(params('call unity MCP'));
    const forbidden = listMavisReadOnlyForbiddenCapabilities(required);
    assert.ok(forbidden.includes('mcp_ops'));
    assert.ok(!forbidden.includes('file_write'));
  });

  it('passes a pure read prompt (no forbidden capabilities)', () => {
    const required = inferCapabilities(params('查看 git 状态'));
    const forbidden = listMavisReadOnlyForbiddenCapabilities(required);
    assert.deepEqual(forbidden, []);
  });

  it('allow-list stays aligned with the readOnly manifest capabilities', () => {
    // Drift guard: if someone adds a capability to the manifest, they
    // MUST also add it to the allow-list (and vice versa). Otherwise the
    // registry and the gate disagree, which is exactly the kind of
    // v3.6 bug we are trying to prevent.
    const manifests = buildExecutorManifests({
      ...baseConfig,
      mavisEnabled: true,
      mavisCliPath: 'mavis',
      mavisReadOnly: true,
    });
    const mavis = manifests.find((m) => m.id === 'mavis-agent');
    assert.ok(mavis);
    for (const cap of mavis.capabilities) {
      assert.ok(
        MAVIS_READ_ONLY_ALLOWED_CAPABILITIES.has(cap),
        `manifest declares ${cap} but allow-list does not include it`,
      );
    }
  });
});

