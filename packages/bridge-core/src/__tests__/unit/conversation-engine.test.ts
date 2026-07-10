import assert from 'node:assert/strict';
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
  assert.match(prompt, /native mentions require a bridge-resolvable Feishu mention ID or @all/i);
  assert.match(prompt, /Bots and app agents may be mentioned only when the bridge can resolve a valid mention ID/i);
  assert.match(prompt, /If the user explicitly asks you to mention someone/i);
  assert.match(prompt, /do not refuse only because the target is a bot or app agent/i);
  assert.match(prompt, /current sender/i);
  assert.match(prompt, /我\/发起人/);
  assert.match(prompt, /cti-direct-message/);
});
