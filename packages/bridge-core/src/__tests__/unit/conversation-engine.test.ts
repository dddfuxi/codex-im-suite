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
