import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function loadLifecycle() {
  return await import('../../lib/bridge/channels/feishu/lifecycle/p2p-polling.js');
}

describe('Feishu P2P polling lifecycle', () => {
  it('runs immediately, schedules one interval, and keeps polling single-flight', async () => {
    const { FeishuP2pPollingLifecycle } = await loadLifecycle();
    const scheduled = new Set<() => void>();
    let resolveRun!: () => void;
    let calls = 0;
    const lifecycle = new FeishuP2pPollingLifecycle({
      intervalMs: 5000,
      poll: async () => {
        calls += 1;
        await new Promise<void>((resolve) => { resolveRun = resolve; });
      },
      scheduleInterval: (callback) => {
        scheduled.add(callback);
        return callback;
      },
      clearScheduledInterval: (handle) => scheduled.delete(handle as () => void),
    });

    lifecycle.start();
    assert.equal(calls, 1);
    assert.equal(scheduled.size, 1);

    const [tick] = [...scheduled];
    tick();
    tick();
    assert.equal(calls, 1, 'interval ticks must not overlap an active poll');

    resolveRun();
    await lifecycle.whenIdle();
    tick();
    assert.equal(calls, 2);
    resolveRun();
    await lifecycle.whenIdle();
  });

  it('restarting replaces the timer without allowing the previous active poll to overlap', async () => {
    const { FeishuP2pPollingLifecycle } = await loadLifecycle();
    const scheduled = new Set<() => void>();
    let resolveRun!: () => void;
    let calls = 0;
    const lifecycle = new FeishuP2pPollingLifecycle({
      intervalMs: 5000,
      poll: async () => {
        calls += 1;
        await new Promise<void>((resolve) => { resolveRun = resolve; });
      },
      scheduleInterval: (callback) => {
        scheduled.add(callback);
        return callback;
      },
      clearScheduledInterval: (handle) => scheduled.delete(handle as () => void),
    });

    lifecycle.start();
    lifecycle.start();
    assert.equal(calls, 1);
    assert.equal(scheduled.size, 1);

    resolveRun();
    await lifecycle.whenIdle();
    [...scheduled][0]();
    assert.equal(calls, 2);
    resolveRun();
    await lifecycle.whenIdle();
  });

  it('stops future ticks and suppresses stale idle state after an in-flight poll finishes', async () => {
    const { FeishuP2pPollingLifecycle } = await loadLifecycle();
    const scheduled = new Set<() => void>();
    const states: string[] = [];
    let resolveRun!: () => void;
    const lifecycle = new FeishuP2pPollingLifecycle({
      intervalMs: 5000,
      poll: () => new Promise<void>((resolve) => { resolveRun = resolve; }),
      scheduleInterval: (callback) => {
        scheduled.add(callback);
        return callback;
      },
      clearScheduledInterval: (handle) => scheduled.delete(handle as () => void),
      onState: (state) => states.push(state.state),
    });

    lifecycle.start();
    assert.deepEqual(states, ['polling']);
    lifecycle.stop();
    assert.equal(scheduled.size, 0);

    resolveRun();
    await lifecycle.whenIdle();
    assert.deepEqual(states, ['polling']);
    assert.equal(await lifecycle.pollNow(), false);
  });

  it('reports failures without leaking a rejected promise and allows the next interval to retry', async () => {
    const { FeishuP2pPollingLifecycle } = await loadLifecycle();
    const scheduled = new Set<() => void>();
    const states: Array<{ state: string; at: string; error?: string }> = [];
    let calls = 0;
    const lifecycle = new FeishuP2pPollingLifecycle({
      intervalMs: 5000,
      poll: async () => {
        calls += 1;
        if (calls === 1) throw new Error('temporary p2p failure');
      },
      scheduleInterval: (callback) => {
        scheduled.add(callback);
        return callback;
      },
      clearScheduledInterval: (handle) => scheduled.delete(handle as () => void),
      onState: (state) => states.push(state),
    });

    lifecycle.start();
    await lifecycle.whenIdle();
    assert.deepEqual(states, [
      { state: 'polling', at: states[0].at },
      { state: 'failed', at: states[1].at, error: 'temporary p2p failure' },
    ]);

    [...scheduled][0]();
    await lifecycle.whenIdle();
    assert.equal(calls, 2);
    assert.equal(states.at(-1)?.state, 'idle');
  });

  it('filters non-recoverable messages and returns unseen user messages in chronological order', async () => {
    const { selectFeishuP2pRecoveryCandidates } = await loadLifecycle();
    const candidates = selectFeishuP2pRecoveryCandidates([
      { message_id: 'om_newer', chat_id: 'oc_p2p', create_time: '3000', msg_type: 'text' },
      { message_id: 'om_deleted', chat_id: 'oc_p2p', create_time: '4000', msg_type: 'text', deleted: true },
      { message_id: 'om_system', chat_id: 'oc_p2p', create_time: '5000', msg_type: 'system' },
      { message_id: 'om_self', chat_id: 'oc_p2p', create_time: '6000', msg_type: 'text', sender: { id: 'ou_bot' } },
      { message_id: 'om_seen', chat_id: 'oc_p2p', create_time: '7000', msg_type: 'text' },
      { message_id: 'om_old', chat_id: 'oc_p2p', create_time: '1000', msg_type: 'text' },
      { message_id: 'om_older', chat_id: 'oc_p2p', create_time: '2000', msg_type: 'text' },
    ], {
      latestKnownTime: 1000,
      isFromSelf: (item) => item.sender?.id === 'ou_bot',
      isSeen: (messageId) => messageId === 'om_seen',
    });

    assert.deepEqual(candidates.map((item) => item.message_id), ['om_older', 'om_newer']);
  });
});
