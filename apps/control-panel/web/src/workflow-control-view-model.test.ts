import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WorkflowPanelRunContract } from '@codex-im-suite/contracts/workflow';
import { canCancelActiveReply, cancelActiveReplyTitle } from './workflow-control-view-model.js';

function run(status: WorkflowPanelRunContract['status']): WorkflowPanelRunContract {
  return {
    id: `run-${status}`,
    sessionId: 'session-1',
    promptPreview: '测试回复',
    stage: status === 'succeeded' ? 'delivered' : status === 'running' ? 'executing' : 'failed',
    status,
    startedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    events: [],
  };
}

describe('workflow active reply controls', () => {
  it('enables termination only for a currently running reply', () => {
    assert.equal(canCancelActiveReply(run('running')), true);
    for (const status of ['succeeded', 'failed', 'cancelled', 'retry_pending', 'retrying'] as const) {
      assert.equal(canCancelActiveReply(run(status)), false);
    }
  });

  it('explains terminal and non-active states without implying Bridge shutdown', () => {
    assert.match(cancelActiveReplyTitle(run('running')), /不会停止 Bridge/);
    assert.match(cancelActiveReplyTitle(run('cancelled')), /已终止/);
    assert.match(cancelActiveReplyTitle(run('succeeded')), /已完成，无法终止/);
    assert.match(cancelActiveReplyTitle(run('retrying')), /不是当前聊天的活动回复/);
  });
});
