import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InboundMessage } from '../../lib/bridge/types.js';

async function loadQueue() {
  return await import('../../lib/bridge/channels/feishu/lifecycle/inbound-queue.js');
}

function message(messageId: string): InboundMessage {
  return {
    messageId,
    address: { channelType: 'feishu', chatId: 'oc_test' },
    text: messageId,
    timestamp: Date.parse('2026-07-21T00:00:00.000Z'),
  };
}

describe('Feishu inbound queue lifecycle', () => {
  it('delivers queued messages in FIFO order while open', async () => {
    const { FeishuInboundQueue } = await loadQueue();
    const queue = new FeishuInboundQueue();
    queue.open();
    assert.equal(queue.enqueue(message('om_1')), true);
    assert.equal(queue.enqueue(message('om_2')), true);

    assert.equal((await queue.consumeOne())?.messageId, 'om_1');
    assert.equal((await queue.consumeOne())?.messageId, 'om_2');
  });

  it('hands the next message directly to the oldest waiting consumer', async () => {
    const { FeishuInboundQueue } = await loadQueue();
    const queue = new FeishuInboundQueue();
    queue.open();
    const pending = queue.consumeOne();

    assert.equal(queue.enqueue(message('om_waiter')), true);
    assert.equal((await pending)?.messageId, 'om_waiter');
    assert.equal(queue.size, 0);
  });

  it('can read queued work without waiting for future messages', async () => {
    const { FeishuInboundQueue } = await loadQueue();
    const queue = new FeishuInboundQueue();
    queue.open();

    const result = await Promise.race([
      queue.consumeOne(false),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 20)),
    ]);

    assert.equal(result, null);
  });

  it('removes one queued message by stable platform message id', async () => {
    const { FeishuInboundQueue } = await loadQueue();
    const queue = new FeishuInboundQueue();
    queue.open();
    queue.enqueue(message('om_keep'));
    queue.enqueue(message('om_remove'));

    assert.equal(queue.removeByMessageId(' om_remove ')?.messageId, 'om_remove');
    assert.equal(queue.removeByMessageId('om_missing'), null);
    assert.equal((await queue.consumeOne())?.messageId, 'om_keep');
  });

  it('closes fail-safe by resolving waiters, discarding queued work, and rejecting late enqueue', async () => {
    const { FeishuInboundQueue } = await loadQueue();
    const queue = new FeishuInboundQueue();
    queue.open();
    const pending = queue.consumeOne();
    assert.equal(queue.enqueue(message('om_direct')), true);
    assert.equal((await pending)?.messageId, 'om_direct');
    queue.enqueue(message('om_stale'));
    queue.close();

    assert.equal(queue.size, 0);
    assert.equal(queue.enqueue(message('om_late')), false);
    assert.equal(await queue.consumeOne(), null);

    queue.open();
    const nextPending = queue.consumeOne();
    queue.close();
    assert.equal(await nextPending, null);
  });
});
