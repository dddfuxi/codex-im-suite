import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initBridgeContext } from '../../lib/bridge/context';
import { _testOnly } from '../../lib/bridge/conversation-engine';

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
    }], workspace);

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
    }], workspace);

    assert.equal(files.length, 1);
    assert.equal(path.relative(uploadRoot, files[0].filePath).startsWith('..'), false);
    assert.equal(fs.readFileSync(files[0].filePath, 'utf8'), 'transient-image');
    assert.equal(fs.existsSync(path.join(workspace, '.codepilot-uploads')), false);
  } finally {
    if (previousUploadRoot === undefined) delete process.env.CTI_UPLOAD_CACHE_DIR;
    else process.env.CTI_UPLOAD_CACHE_DIR = previousUploadRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
