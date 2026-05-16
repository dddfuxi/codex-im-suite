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

  it('persists Feishu sender metadata for cloud document retry prechecks', () => {
    const run = startWorkflowRun({
      sessionId: 'session-feishu-cloud-retry',
      prompt: '总结 https://example.feishu.cn/sheets/sht_abc',
      channelType: 'feishu',
      chatId: 'oc_retry',
    });
    recordWorkflowRecoveryInfo(run.id, {
      prompt: '总结 https://example.feishu.cn/sheets/sht_abc',
      workingDirectory: 'C:\\workspace',
      channelType: 'feishu',
      chatId: 'oc_retry',
      userId: 'ou_liudan',
      userDisplayName: '刘丹',
      messageId: 'm_retry',
      maxAutoAttempts: 1,
    });

    const status = readWorkflowStatus();
    const recovered = status.runs.find((item) => item.id === run.id);

    assert.equal(recovered?.recovery?.input?.userId, 'ou_liudan');
    assert.equal(recovered?.recovery?.input?.userDisplayName, '刘丹');
    assert.equal(recovered?.recovery?.input?.messageId, 'm_retry');
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

  it('does not auto-claim stale interrupted runs after the auto-retry age window has passed', () => {
    const oldMaxAge = process.env.CTI_WORKFLOW_AUTO_RETRY_MAX_AGE_MS;
    process.env.CTI_WORKFLOW_AUTO_RETRY_MAX_AGE_MS = '1';
    try {
      const run = startWorkflowRun({
        sessionId: 'session-stale-auto-retry',
        prompt: '桥接断开后继续旧任务',
        channelType: 'feishu',
        chatId: 'chat-stale-auto-retry',
      });
      recordWorkflowRecoveryInfo(run.id, {
        prompt: '桥接断开后继续旧任务',
        workingDirectory: 'C:\\workspace',
        maxAutoAttempts: 1,
      });

      const marked = markInterruptedWorkflowRuns('runtime-stale-window');
      const recovered = marked.find((item) => item.id === run.id);
      assert.equal(recovered?.status, 'retry_pending');
      assert.equal(recovered?.retry?.status, 'auto_pending');

      const until = Date.now() + 10;
      while (Date.now() < until) {
        // wait for the retry window to expire without relying on file mutation
      }

      const claimed = claimNextWorkflowRetry('worker-stale');
      assert.equal(claimed, null);
    } finally {
      if (oldMaxAge === undefined) delete process.env.CTI_WORKFLOW_AUTO_RETRY_MAX_AGE_MS;
      else process.env.CTI_WORKFLOW_AUTO_RETRY_MAX_AGE_MS = oldMaxAge;
    }
  });
});
