import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendWorkflowEvent,
  completeWorkflowRun,
  failWorkflowRun,
  readWorkflowStatus,
  setWorkflowExecutor,
  startWorkflowRun,
} from '../workflow-status.js';

describe('workflow status store', () => {
  it('records ordered workflow stages and completion', () => {
    const run = startWorkflowRun({
      sessionId: 'session-1',
      prompt: '帮我看看 git 状态',
      channelType: 'feishu',
      chatId: 'chat-1',
    });
    setWorkflowExecutor(run.id, 'codex', '测试选择 Codex');
    appendWorkflowEvent(run.id, 'executing', 'executor.started', '开始执行');
    const completed = completeWorkflowRun(run.id);
    assert.equal(completed?.status, 'succeeded');
    assert.equal(completed?.stage, 'delivered');
    assert.equal(completed?.executorId, 'codex');
    assert.deepEqual(
      completed?.events.map((event) => event.stage),
      ['received', 'routed', 'executing', 'delivered'],
    );
  });

  it('records failed runs with error message', () => {
    const run = startWorkflowRun({
      sessionId: 'session-2',
      prompt: '触发失败',
    });
    const failed = failWorkflowRun(run.id, new Error('boom'));
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.stage, 'failed');
    assert.equal(failed?.error, 'boom');
    assert.ok(readWorkflowStatus().runs.some((item) => item.id === run.id));
  });
});
