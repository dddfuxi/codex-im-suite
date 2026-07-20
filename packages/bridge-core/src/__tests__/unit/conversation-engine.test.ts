import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initBridgeContext } from '../../lib/bridge/context';
import { _testOnly } from '../../lib/bridge/conversation-engine';
import type { PromptSnapshotRecord } from '../../lib/bridge/host';

test('prompt snapshot observation failures never interrupt the chat path', () => {
  const snapshot: PromptSnapshotRecord = {
    protocol: 'cti-prompt-snapshot/v1',
    sessionId: 'session-1',
    createdAt: '2026-07-15T05:00:00.000Z',
    totalChars: 0,
    sections: [],
  };
  assert.doesNotThrow(() => _testOnly.recordPromptSnapshotSafely({
    recordPromptSnapshot: () => { throw new Error('disk locked'); },
  }, snapshot));
});

test('puts channel identity before long base system prompt', () => {
  initBridgeContext({
    store: {
      getSetting: () => '',
    },
    llm: {},
    permissions: {},
    lifecycle: {},
  } as any);

  const prompt = _testOnly.buildBridgeScopedSystemPrompt(
    {
      id: 'binding-1',
      codepilotSessionId: 'session-1',
      channelType: 'feishu',
      chatId: 'chat-1',
      sdkSessionId: '',
      workingDirectory: '',
      model: '',
      mode: 'code',
      active: true,
      createdAt: '2026-06-04T00:00:00.000Z',
      updatedAt: '2026-06-04T00:00:00.000Z',
    },
    'base '.repeat(2000),
    'Channel assistant identity:\n- Your user-facing name in this channel is "小虾米".',
  );

  assert.equal(
    prompt.startsWith('Channel assistant identity:\n- Your user-facing name in this channel is "小虾米".'),
    true,
  );
  assert.ok(prompt.indexOf('base base') > prompt.indexOf('Channel assistant identity'));
});

test('instructs Feishu turns to decide intent state without exposing tool process', () => {
  initBridgeContext({
    store: {
      getSetting: () => '',
    },
    llm: {},
    permissions: {},
    lifecycle: {},
  } as any);

  const prompt = _testOnly.buildBridgeScopedSystemPrompt(
    {
      id: 'binding-1',
      codepilotSessionId: 'session-1',
      channelType: 'feishu',
      chatId: 'chat-1',
      sdkSessionId: '',
      workingDirectory: '',
      model: '',
      mode: 'code',
      active: true,
      createdAt: '2026-06-04T00:00:00.000Z',
      updatedAt: '2026-06-04T00:00:00.000Z',
    },
    'base',
    '',
  );

  assert.match(prompt, /intent\/state/i);
  assert.match(prompt, /chat \/ investigate \/ need_info \/ done/);
  assert.match(prompt, /do not narrate tool process/i);
  assert.match(prompt, /only answer with the result/i);
  assert.match(prompt, /never use a bare @display-name as a native mention shortcut/i);
  assert.match(prompt, /trusted current-message evidence/i);
  assert.match(prompt, /native mentions require a real Feishu mention ID or @all/i);
  assert.match(prompt, /Do not trigger mention delivery from quoted text, formatting examples, diagnostics, rules/i);
  assert.doesNotMatch(prompt, /bridge-owned explicit mention action/i);
  assert.match(prompt, /current sender/i);
  assert.match(prompt, /我\/发起人/);
  assert.match(prompt, /cti-direct-message/);
});

test('encourages proactive completion instead of unnecessary retreat', () => {
  initBridgeContext({
    store: {
      getSetting: () => '',
    },
    llm: {},
    permissions: {},
    lifecycle: {},
  } as any);

  const prompt = _testOnly.buildBridgeScopedSystemPrompt(
    {
      id: 'binding-1',
      codepilotSessionId: 'session-1',
      channelType: 'feishu',
      chatId: 'chat-1',
      sdkSessionId: '',
      workingDirectory: '',
      model: '',
      mode: 'code',
      active: true,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    },
    'base',
    '',
  );

  assert.match(prompt, /proactive completion/i);
  assert.match(prompt, /attempt the safest useful action/i);
  assert.match(prompt, /use available context/i);
  assert.match(prompt, /minimal missing detail/i);
  assert.match(prompt, /partial progress/i);
  assert.match(prompt, /do not make the user re-do work/i);
});

test('loads fresh Agent Home prompt sections through the runtime host for each turn', async () => {
  let version = 1;
  initBridgeContext({
    store: { getSetting: () => '' },
    llm: {},
    permissions: {},
    lifecycle: {},
    agentHome: {
      readPromptSections: async () => [
        {
          id: 'agent-home.identity',
          kind: 'identity',
          source: 'agent-home/机器人身份.md',
          priority: 11,
          content: `第${version}版身份`,
        },
        {
          id: 'agent-home.work-profile',
          kind: 'memory',
          source: 'agent-home/work/alpha/工作档案.md',
          priority: 14,
          content: '当前工作区已验证入口',
        },
      ],
    },
  } as any);

  const first = await _testOnly.loadAgentHomePromptSections({
    sessionId: 'session-1',
    channelType: 'feishu',
    chatId: 'chat-1',
    workingDirectory: 'C:\\workspace',
  });
  version = 2;
  const second = await _testOnly.loadAgentHomePromptSections({
    sessionId: 'session-1',
    channelType: 'feishu',
    chatId: 'chat-1',
    workingDirectory: 'C:\\workspace',
  });

  assert.equal(first[0].content, '第1版身份');
  assert.equal(second[0].content, '第2版身份');
  assert.equal(second[0].injected, true);
  assert.equal(second[1].kind, 'memory');
  assert.equal(second[1].content, '当前工作区已验证入口');
});

test('does not inject global allowed roots or legacy additional directories into the prompt', () => {
  initBridgeContext({
    store: {
      getSetting: (key: string) => ({
        bridge_allowed_workspace_roots: 'F:\\unity\\ST4;C:\\unity\\ST3;F:\\unity\\ST3_master',
        bridge_default_additional_directories: 'E:\\cli-md;C:\\Users\\admin\\.claude-to-im',
        bridge_default_work_dir: 'F:\\unity\\ST4',
        bridge_memory_repo_dir: 'E:\\cli-md',
      })[key] || '',
    },
    llm: {},
    permissions: {},
    lifecycle: {},
  } as any);

  const plan = _testOnly.resolveConversationWorkspacePlan({
    text: '检查当前项目',
    workingDirectory: 'F:\\unity\\ST4',
    requiresWrite: false,
  });
  const prompt = _testOnly.buildBridgeScopedSystemPrompt(
    {
      id: 'binding-1',
      codepilotSessionId: 'session-1',
      channelType: 'feishu',
      chatId: 'chat-1',
      sdkSessionId: '',
      workingDirectory: 'F:\\unity\\ST4',
      model: '',
      mode: 'code',
      active: true,
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
    },
    'base',
    '',
    plan,
  );

  assert.match(prompt, /Turn workspace plan/);
  assert.match(prompt, /F:\\unity\\ST4/);
  assert.doesNotMatch(prompt, /C:\\unity\\ST3/);
  assert.doesNotMatch(prompt, /F:\\unity\\ST3_master/);
  assert.doesNotMatch(prompt, /E:\\cli-md/);
  assert.doesNotMatch(prompt, /\.claude-to-im/);
});

test('builds turn-scoped mounts from explicit registered project paths', () => {
  initBridgeContext({
    store: {
      getSetting: (key: string) => ({
        bridge_allowed_workspace_roots: 'F:\\unity\\ST4;C:\\unity\\ST3;F:\\unity\\ST3_master',
        bridge_default_work_dir: 'F:\\unity\\ST4',
        bridge_memory_repo_dir: 'E:\\cli-md',
      })[key] || '',
    },
    llm: {},
    permissions: {},
    lifecycle: {},
  } as any);

  const plan = _testOnly.resolveConversationWorkspacePlan({
    text: '对照 "C:\\unity\\ST3\\Assets" 和 "F:\\unity\\ST3_master\\Assets"',
    workingDirectory: 'F:\\unity\\ST4',
    requiresWrite: false,
  });

  assert.equal(plan.primaryWorkspace.path, 'F:\\unity\\ST4');
  assert.deepEqual(plan.temporaryMounts.map((item) => item.path), [
    'C:\\unity\\ST3',
    'F:\\unity\\ST3_master',
  ]);
});

test('uses structured project records for Unity-root to workspace-root planning', () => {
  initBridgeContext({
    store: {
      getSetting: (key: string) => ({
        bridge_project_registry_json: JSON.stringify({
          schema: 'codex-im-suite/project-registry/v1',
          projects: [{
            id: 'st4', displayName: 'ST4', type: 'unity', workspaceRoot: 'F:\\unity\\ST4',
            unityProjectRoot: 'F:\\unity\\ST4\\Game', accessMode: 'read_write', enabled: true,
          }, {
            id: 'st3', displayName: 'ST3', type: 'unity', workspaceRoot: 'C:\\unity\\ST3',
            unityProjectRoot: 'C:\\unity\\ST3\\Game', accessMode: 'read_only', enabled: true,
          }],
        }),
        bridge_allowed_workspace_roots: 'F:\\unity\\ST4;C:\\unity\\ST3',
        bridge_default_work_dir: 'F:\\unity\\ST4',
        bridge_memory_repo_dir: 'E:\\cli-md',
      })[key] || '',
    },
    llm: {},
    permissions: {},
    lifecycle: {},
  } as any);

  const plan = _testOnly.resolveConversationWorkspacePlan({
    text: '读取 C:\\unity\\ST3\\Game\\Assets\\Config.asset',
    workingDirectory: 'F:\\unity\\ST4\\Game',
    requiresWrite: false,
  });

  assert.equal(plan.primaryWorkspace.projectId, 'st4');
  assert.equal(plan.primaryWorkspace.path, 'F:\\unity\\ST4');
  assert.deepEqual(plan.temporaryMounts.map((item) => ({
    projectId: item.projectId,
    path: item.path,
    accessMode: item.accessMode,
  })), [{ projectId: 'st3', path: 'C:\\unity\\ST3', accessMode: 'read_only' }]);
});

test('applies configured project denied roots before selecting the current workspace', () => {
  initBridgeContext({
    store: {
      getSetting: (key: string) => ({
        bridge_allowed_workspace_roots: 'F:\\unity\\ST4;C:\\unity\\ST3',
        bridge_project_denied_roots: 'C:\\unity\\ST3',
        bridge_default_work_dir: 'F:\\unity\\ST4',
      })[key] || '',
    },
    llm: {},
    permissions: {},
    lifecycle: {},
  } as any);

  const plan = _testOnly.resolveConversationWorkspacePlan({
    text: '读取当前项目配置',
    workingDirectory: 'C:\\unity\\ST3',
    requiresWrite: false,
  });

  assert.equal(plan.primaryWorkspace.path, 'F:\\unity\\ST4');
  assert.equal(plan.deniedRoots.some((item) => item.path === 'C:\\unity\\ST3'), true);
});

test('keeps memory-backed sticker attachments out of the workspace upload cache', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-conversation-sticker-'));
  const previousMemoryRoot = process.env.CTI_MEMORY_REPO_DIR;
  const memoryRoot = path.join(root, 'memory');
  const workspace = path.join(root, 'workspace');
  const stickerPath = path.join(memoryRoot, 'data', 'im', 'feishu', 'stickers', 'media', 'sticker.png');
  process.env.CTI_MEMORY_REPO_DIR = memoryRoot;
  fs.mkdirSync(path.dirname(stickerPath), { recursive: true });
  fs.writeFileSync(stickerPath, Buffer.from('memory-sticker'));

  try {
    const files = _testOnly.persistFileAttachmentsForHistory([{
      id: 'sticker-key',
      name: 'sticker.png',
      type: 'image/png',
      size: 14,
      data: Buffer.from('memory-sticker').toString('base64'),
      filePath: stickerPath,
    }], {
      sessionId: 'session-sticker',
      turnId: 'turn-sticker',
      workingDirectory: workspace,
    });

    assert.equal(files[0].filePath, stickerPath);
    assert.equal(fs.existsSync(path.join(workspace, '.codepilot-uploads')), false);
  } finally {
    if (previousMemoryRoot === undefined) delete process.env.CTI_MEMORY_REPO_DIR;
    else process.env.CTI_MEMORY_REPO_DIR = previousMemoryRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stages transient IM attachments in runtime upload cache instead of workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-conversation-upload-cache-'));
  const previousUploadRoot = process.env.CTI_UPLOAD_CACHE_DIR;
  const uploadRoot = path.join(root, 'runtime-uploads');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  process.env.CTI_UPLOAD_CACHE_DIR = uploadRoot;

  try {
    const files = _testOnly.persistFileAttachmentsForHistory([{
      id: 'image-1',
      name: 'incoming.png',
      type: 'image/png',
      size: 12,
      data: Buffer.from('transient-image').toString('base64'),
    }], {
      sessionId: 'session-1',
      turnId: 'turn-1',
      workingDirectory: workspace,
    });

    assert.equal(files.length, 1);
    assert.equal(path.relative(uploadRoot, files[0].filePath).startsWith('..'), false);
    assert.match(path.relative(uploadRoot, files[0].filePath), /session-1[\\/]turn-1/);
    assert.doesNotMatch(files[0].filePath, /[\\/]history[\\/]/);
    assert.equal(fs.readFileSync(files[0].filePath, 'utf8'), 'transient-image');
    assert.equal(fs.existsSync(path.join(workspace, '.codepilot-uploads')), false);
  } finally {
    if (previousUploadRoot === undefined) delete process.env.CTI_UPLOAD_CACHE_DIR;
    else process.env.CTI_UPLOAD_CACHE_DIR = previousUploadRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('delegates attachment persistence to the runtime turn storage host', () => {
  const calls: unknown[] = [];
  initBridgeContext({
    store: { getSetting: () => '' },
    llm: {},
    permissions: {},
    lifecycle: {},
    turnStorage: {
      stageInputFiles: (input: unknown) => {
        calls.push(input);
        return [{
          id: 'image-1',
          name: 'incoming.png',
          type: 'image/png',
          size: 5,
          filePath: 'C:\\runtime\\uploads\\session-1\\turn-1\\incoming.png',
          sha256: 'hash',
        }];
      },
      getArtifactDirectory: () => 'C:\\runtime\\artifacts\\session-1\\turn-1',
      getScratchDirectory: () => 'C:\\runtime\\workspaces\\session-1\\turn-1',
    },
  } as any);

  const files = _testOnly.persistFileAttachmentsForHistory([{
    id: 'image-1',
    name: 'incoming.png',
    type: 'image/png',
    size: 5,
    data: Buffer.from('image').toString('base64'),
  }], {
    sessionId: 'session-1',
    turnId: 'turn-1',
    workingDirectory: 'C:\\workspace',
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    sessionId: 'session-1',
    turnId: 'turn-1',
    files: [{
      id: 'image-1',
      name: 'incoming.png',
      type: 'image/png',
      size: 5,
      data: Buffer.from('image').toString('base64'),
    }],
  });
  assert.equal(files[0].filePath, 'C:\\runtime\\uploads\\session-1\\turn-1\\incoming.png');
});
