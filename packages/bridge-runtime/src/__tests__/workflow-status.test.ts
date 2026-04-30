import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendWorkflowEvent,
  completeWorkflowRun,
  failWorkflowRun,
  claimNextWorkflowRetry,
  markInterruptedWorkflowRuns,
  readWorkflowStatus,
  recordWorkflowRecoveryInfo,
  requestWorkflowRetry,
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

  it('marks interrupted running runs as recoverable when retry input was persisted', () => {
    const run = startWorkflowRun({
      sessionId: 'session-recoverable',
      prompt: '继续处理这条消息',
      channelType: 'feishu',
      chatId: 'chat-recoverable',
    });
    recordWorkflowRecoveryInfo(run.id, {
      prompt: '继续处理这条消息',
      workingDirectory: 'C:\\workspace',
      model: 'gpt-test',
      permissionMode: 'default',
      maxAutoAttempts: 2,
    });

    const marked = markInterruptedWorkflowRuns('runtime-next');
    const recovered = marked.find((item) => item.id === run.id);

    assert.equal(recovered?.status, 'retry_pending');
    assert.equal(recovered?.stage, 'failed');
    assert.equal(recovered?.recovery?.kind, 'recoverable');
    assert.equal(recovered?.retry?.status, 'auto_pending');
    assert.equal(recovered?.retry?.attempts, 0);
    assert.equal(recovered?.recovery?.input?.prompt, '继续处理这条消息');
  });

  it('marks interrupted running runs without retry input as not recoverable', () => {
    const run = startWorkflowRun({
      sessionId: 'session-not-recoverable',
      prompt: '缺少恢复信息',
    });

    const marked = markInterruptedWorkflowRuns('runtime-next');
    const recovered = marked.find((item) => item.id === run.id);

    assert.equal(recovered?.status, 'failed');
    assert.equal(recovered?.stage, 'failed');
    assert.equal(recovered?.recovery?.kind, 'not_recoverable');
    assert.equal(recovered?.retry?.status, 'unavailable');
  });

  it('lets the control panel request and claim a manual retry for a failed run', () => {
    const run = startWorkflowRun({
      sessionId: 'session-manual',
      prompt: '手动重试这条消息',
      channelType: 'feishu',
      chatId: 'chat-manual',
    });
    recordWorkflowRecoveryInfo(run.id, {
      prompt: '手动重试这条消息',
      workingDirectory: 'C:\\workspace',
      maxAutoAttempts: 1,
    });
    failWorkflowRun(run.id, new Error('temporary failure'));

    const pending = requestWorkflowRetry(run.id, 'manual');
    assert.equal(pending?.status, 'retry_pending');
    assert.equal(pending?.retry?.status, 'manual_pending');

    const claimed = claimNextWorkflowRetry('worker-1');
    assert.equal(claimed?.id, run.id);
    assert.equal(claimed?.status, 'retrying');
    assert.equal(claimed?.retry?.status, 'retrying');
    assert.equal(claimed?.retry?.claimedBy, 'worker-1');
  });
});
