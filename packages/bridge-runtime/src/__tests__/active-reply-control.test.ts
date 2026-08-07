import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ActiveReplyCancelRequest } from 'claude-to-im';
import { ACTIVE_REPLY_CONTROL_PROTOCOL, handleActiveReplyControlRequest } from '../active-reply-control.js';
import { completeWorkflowRun, readWorkflowStatus, recordWorkflowRecoveryInfo, startWorkflowRun } from '../workflow-status.js';

describe('active reply control', () => {
  let tempHome = '';
  const originalCtiHome = process.env.CTI_HOME;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-active-reply-control-'));
    process.env.CTI_HOME = tempHome;
  });

  afterEach(() => {
    if (originalCtiHome === undefined) delete process.env.CTI_HOME;
    else process.env.CTI_HOME = originalCtiHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('matches the persisted run to the in-memory turn and records one cancelled terminal state', async () => {
    const run = startWorkflowRun({
      sessionId: 'session-a',
      prompt: '生成一段很长的回复',
      channelType: 'feishu',
      chatId: 'chat-a',
    });
    recordWorkflowRecoveryInfo(run.id, {
      prompt: '生成一段很长的回复',
      turnId: 'message-a',
      executionRequirement: { kind: 'none', reason: 'test', requiredToolFamilies: [] },
    });
    const seen: ActiveReplyCancelRequest[] = [];
    const result = await handleActiveReplyControlRequest({
      protocol: ACTIVE_REPLY_CONTROL_PROTOCOL,
      requestId: 'request-a',
      action: 'cancel_reply',
      workflowRunId: run.id,
      requestedAt: new Date().toISOString(),
    }, async (input) => {
      seen.push(input);
      return { disposition: 'accepted', sessionId: input.sessionId, turnId: input.turnId, detail: 'accepted' };
    });

    assert.equal(result.disposition, 'accepted');
    assert.deepEqual(seen, [{ sessionId: 'session-a', turnId: 'message-a', channelType: 'feishu', chatId: 'chat-a' }]);
    assert.equal(readWorkflowStatus().runs.find((item) => item.id === run.id)?.status, 'cancelled');
    assert.equal(completeWorkflowRun(run.id)?.status, 'cancelled');
  });

  it('does not call Bridge for a run that has already completed', async () => {
    const run = startWorkflowRun({ sessionId: 'session-done', prompt: '完成', channelType: 'feishu', chatId: 'chat-done' });
    completeWorkflowRun(run.id);
    let calls = 0;
    const result = await handleActiveReplyControlRequest({
      protocol: ACTIVE_REPLY_CONTROL_PROTOCOL,
      requestId: 'request-done',
      action: 'cancel_reply',
      workflowRunId: run.id,
      requestedAt: new Date().toISOString(),
    }, async () => {
      calls += 1;
      return { disposition: 'accepted', sessionId: '', turnId: '', detail: '' };
    });
    assert.equal(result.disposition, 'already_terminal');
    assert.equal(result.workflowStatus, 'succeeded');
    assert.equal(calls, 0);
  });

  it('fails closed when the run has no durable turn identity', async () => {
    const run = startWorkflowRun({ sessionId: 'session-unsafe', prompt: '没有 turn', channelType: 'feishu', chatId: 'chat-unsafe' });
    let calls = 0;
    const result = await handleActiveReplyControlRequest({
      protocol: ACTIVE_REPLY_CONTROL_PROTOCOL,
      requestId: 'request-unsafe',
      action: 'cancel_reply',
      workflowRunId: run.id,
      requestedAt: new Date().toISOString(),
    }, async () => {
      calls += 1;
      return { disposition: 'accepted', sessionId: '', turnId: '', detail: '' };
    });
    assert.equal(result.disposition, 'conflict');
    assert.equal(calls, 0);
  });
});
