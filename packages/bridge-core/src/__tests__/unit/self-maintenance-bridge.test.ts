import assert from 'node:assert/strict';
import { test } from 'node:test';

import { initBridgeContext } from '../../lib/bridge/context';

test('bridge invokes the runtime-owned self-maintenance boundary with structured evidence only', async () => {
  const calls: unknown[] = [];
  initBridgeContext({
    store: {},
    llm: {},
    permissions: {},
    lifecycle: {},
    selfMaintenance: {
      maintain: async (input: unknown) => {
        calls.push(input);
        return { applied: true, reason: 'confirmed', changedTargets: ['tool_rules'], backupCount: 1 };
      },
    },
  } as any);
  const { _testOnly } = await import('../../lib/bridge/bridge-manager');

  const result = await _testOnly.runSelfMaintenanceSafely({
    phase: 'correction',
    sessionId: 'session-1',
    channelType: 'feishu',
    chatId: 'chat-1',
    currentUserText: '上一条判断错了。',
    previousAssistantText: '文件不存在。',
    workingDirectory: 'C:\\workspace',
  });

  assert.equal(result?.applied, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    phase: 'correction',
    sessionId: 'session-1',
    channelType: 'feishu',
    chatId: 'chat-1',
    currentUserText: '上一条判断错了。',
    previousAssistantText: '文件不存在。',
    workingDirectory: 'C:\\workspace',
  });
});

test('self-maintenance classifier failures do not interrupt the main reply path', async () => {
  initBridgeContext({
    store: {},
    llm: {},
    permissions: {},
    lifecycle: {},
    selfMaintenance: {
      maintain: async () => { throw new Error('classifier unavailable'); },
    },
  } as any);
  const { _testOnly } = await import('../../lib/bridge/bridge-manager');

  const result = await _testOnly.runSelfMaintenanceSafely({
    phase: 'outcome',
    sessionId: 'session-1',
    channelType: 'feishu',
    chatId: 'chat-1',
    currentUserText: '执行测试',
    assistantText: '测试通过',
    executionEvidence: { hasError: false, evidenceSatisfied: true },
  });

  assert.equal(result, null);
});

test('bridge records correction classifier skips through the runtime-owned metrics boundary', async () => {
  const calls: unknown[] = [];
  initBridgeContext({
    store: {},
    llm: {},
    permissions: {},
    lifecycle: {},
    selfMaintenance: {
      maintain: async () => ({ applied: false, reason: 'unused' }),
      recordRoutingSkip: async (input: unknown) => { calls.push(input); },
    },
  } as any);
  const { _testOnly } = await import('../../lib/bridge/bridge-manager');

  await _testOnly.recordSelfMaintenanceSkipSafely({
    phase: 'correction',
    sessionId: 'session-1',
    reason: 'no correction candidate',
  });

  assert.deepEqual(calls, [{
    phase: 'correction',
    sessionId: 'session-1',
    reason: 'no correction candidate',
  }]);
});
