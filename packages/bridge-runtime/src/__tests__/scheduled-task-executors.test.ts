import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyScheduledTaskError,
  executeScheduledTaskRun,
} from '../scheduled-tasks/executors.js';
import {
  makeScheduledRun,
  makeScheduledTask,
} from './scheduled-task-test-fixtures.js';

describe('scheduled task executors', () => {
  it('retries delivery without replaying a successful action', async () => {
    let executeCount = 0;
    let deliverCount = 0;
    const sleeps: number[] = [];
    const result = await executeScheduledTaskRun({
      task: makeScheduledTask(),
      run: makeScheduledRun(),
      executeAction: async () => {
        executeCount += 1;
        return {
          ok: true,
          deliveryPayload: { text: '今日单子' },
        };
      },
      deliver: async () => {
        deliverCount += 1;
        return deliverCount === 1
          ? { ok: false, error: '503 Service Unavailable' }
          : { ok: true, messageId: 'om_delivered' };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    assert.equal(executeCount, 1);
    assert.equal(deliverCount, 2);
    assert.deepEqual(sleeps, [30_000]);
    assert.equal(result.executionStatus, 'ok');
    assert.equal(result.deliveryStatus, 'delivered');
    assert.equal(result.messageId, 'om_delivered');
    assert.equal(result.deliveryPayload?.text, '今日单子');
  });

  it('retries a transient pre-execution failure', async () => {
    let executeCount = 0;
    const result = await executeScheduledTaskRun({
      task: makeScheduledTask({ delivery: { channelType: 'feishu', chatId: 'oc_test', mode: 'none' } }),
      run: makeScheduledRun(),
      executeAction: async () => {
        executeCount += 1;
        if (executeCount === 1) {
          return { ok: false, error: '429 Too Many Requests', executionStarted: false };
        }
        return { ok: true, deliveryPayload: { text: '恢复成功' } };
      },
      deliver: async () => assert.fail('delivery must not run for mode=none'),
      sleep: async () => {},
    });

    assert.equal(executeCount, 2);
    assert.equal(result.executionStatus, 'ok');
    assert.equal(result.deliveryStatus, 'not_requested');
  });

  it('does not replay a non-idempotent controlled tool after execution starts', async () => {
    let executeCount = 0;
    const result = await executeScheduledTaskRun({
      task: makeScheduledTask({
        action: {
          kind: 'controlled_tool',
          toolName: 'tool.write_external_state',
          input: { value: 1 },
          idempotent: false,
        },
      }),
      run: makeScheduledRun(),
      executeAction: async () => {
        executeCount += 1;
        return {
          ok: false,
          error: '503 Service Unavailable',
          executionStarted: true,
        };
      },
      deliver: async () => assert.fail('delivery must not run after execution failure'),
      sleep: async () => {},
    });

    assert.equal(executeCount, 1);
    assert.equal(result.executionStatus, 'error');
    assert.equal(result.errorKind, 'server_error');
  });

  it('classifies transient and permanent failures separately', () => {
    assert.equal(classifyScheduledTaskError('429 Too Many Requests'), 'rate_limit');
    assert.equal(classifyScheduledTaskError('ETIMEDOUT while connecting'), 'timeout');
    assert.equal(classifyScheduledTaskError('503 Service Unavailable'), 'server_error');
    assert.equal(classifyScheduledTaskError('permission denied'), 'permission');
    assert.equal(classifyScheduledTaskError('target chat not found'), 'target_missing');
  });
});
