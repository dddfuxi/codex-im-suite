import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-workflow-contract-'));
process.env.CTI_HOME = testHome;

const {
  appendWorkflowEvent,
  completeWorkflowRun,
  failWorkflowRun,
  recordWorkflowRecoveryInfo,
  setWorkflowExecutor,
  startWorkflowRun,
} = await import('../workflow-status.js');
const { toWorkflowRunContract } = await import('../workflow-contract.js');

after(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('workflow contract adapter', () => {
  it('maps existing workflow runs into the shared workflow contract', () => {
    const run = startWorkflowRun({
      sessionId: 'contract-session',
      prompt: '执行一次契约映射',
      channelType: 'feishu',
      chatId: 'contract-chat',
    });
    setWorkflowExecutor(run.id, 'codex', 'contract test');
    appendWorkflowEvent(run.id, 'executing', 'executor.executing', '开始执行');
    const completed = completeWorkflowRun(run.id);
    assert.ok(completed);

    const contract = toWorkflowRunContract(completed!, 'local');

    assert.equal(contract.schema, 'codex-im-suite/workflow-run/v1');
    assert.equal(contract.nodeId, 'local');
    assert.equal(contract.status, 'succeeded');
    assert.equal(contract.stage, 'delivered');
    assert.equal(contract.executorId, 'codex');
    assert.ok(contract.checkpoints.some((checkpoint) => checkpoint.kind === 'provider'));
    assert.ok(contract.checkpoints.some((checkpoint) => checkpoint.kind === 'delivery'));
    assert.ok(contract.events.some((event) => event.type === 'executor.executing' && event.checkpointId));
  });

  it('keeps retry and recovery information as checkpoints', () => {
    const run = startWorkflowRun({
      sessionId: 'contract-retry-session',
      prompt: '失败后重试',
    });
    recordWorkflowRecoveryInfo(run.id, {
      prompt: '失败后重试',
      workingDirectory: 'C:\\workspace',
      maxAutoAttempts: 1,
    });
    const failed = failWorkflowRun(run.id, new Error('temporary failure'));
    assert.ok(failed);

    const contract = toWorkflowRunContract(failed!, 'fake-remote');

    assert.equal(contract.nodeId, 'fake-remote');
    assert.equal(contract.status, 'failed');
    assert.ok(contract.checkpoints.some((checkpoint) => checkpoint.kind === 'input' && checkpoint.recoverable));
    assert.ok(contract.checkpoints.some((checkpoint) => checkpoint.kind === 'finalizer' && checkpoint.recoverable));
  });
});
