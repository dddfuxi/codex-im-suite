import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function loadRegistry() {
  return await import('../../lib/bridge/channels/feishu/cards/streaming-card-registry.js');
}

describe('Feishu streaming card registry', () => {
  it('deduplicates in-flight creation and forgets the promise after settlement', async () => {
    const { FeishuStreamingCardRegistry } = await loadRegistry();
    const registry = new FeishuStreamingCardRegistry();
    let calls = 0;
    let resolveCreation!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { resolveCreation = resolve; });

    const first = registry.trackCreation('oc_chat', () => {
      calls++;
      return pending;
    });
    const second = registry.trackCreation('oc_chat', () => {
      calls++;
      return Promise.resolve(false);
    });

    assert.equal(first, second);
    assert.equal(registry.getCreation('oc_chat'), pending);
    assert.equal(calls, 1);

    resolveCreation(true);
    assert.equal(await first, true);
    await Promise.resolve();
    assert.equal(registry.getCreation('oc_chat'), undefined);
  });

  it('initializes active card state and blocks duplicate creation', async () => {
    const { FeishuStreamingCardRegistry } = await loadRegistry();
    const registry = new FeishuStreamingCardRegistry();

    const state = registry.activate('oc_chat', {
      cardId: 'card_1',
      messageId: 'om_card',
      sourceMessageId: 'om_user',
      startTime: 1234,
    });

    assert.equal(registry.has('oc_chat'), true);
    assert.equal(registry.get('oc_chat'), state);
    assert.deepEqual(state, {
      cardId: 'card_1',
      messageId: 'om_card',
      sourceMessageId: 'om_user',
      sequence: 0,
      startTime: 1234,
      toolCalls: [],
      thinking: true,
      pendingText: null,
      lastUpdateAt: 0,
      throttleTimer: null,
      typewriterTimer: null,
      typewriterKey: '',
    });

    let createCalled = false;
    assert.equal(await registry.trackCreation('oc_chat', () => {
      createCalled = true;
      return Promise.resolve(true);
    }), false);
    assert.equal(createCalled, false);
  });

  it('clears both throttle and typewriter timers when one card is removed', async () => {
    const { FeishuStreamingCardRegistry } = await loadRegistry();
    const cleared: unknown[] = [];
    const registry = new FeishuStreamingCardRegistry((timer) => cleared.push(timer));
    const throttleTimer = { kind: 'throttle' } as unknown as ReturnType<typeof setTimeout>;
    const typewriterTimer = { kind: 'typewriter' } as unknown as ReturnType<typeof setTimeout>;
    const state = registry.activate('oc_chat', {
      cardId: 'card_1',
      messageId: 'om_card',
      startTime: 1,
    });
    state.throttleTimer = throttleTimer;
    state.typewriterTimer = typewriterTimer;

    const removed = registry.remove('oc_chat');

    assert.equal(removed, state);
    assert.deepEqual(cleared, [throttleTimer, typewriterTimer]);
    assert.equal(state.throttleTimer, null);
    assert.equal(state.typewriterTimer, null);
    assert.equal(registry.has('oc_chat'), false);
  });

  it('clears every active card timer and all pending creation records on shutdown', async () => {
    const { FeishuStreamingCardRegistry } = await loadRegistry();
    const cleared: unknown[] = [];
    const registry = new FeishuStreamingCardRegistry((timer) => cleared.push(timer));
    const timers = [
      { id: 1 },
      { id: 2 },
      { id: 3 },
      { id: 4 },
    ] as unknown as Array<ReturnType<typeof setTimeout>>;
    const first = registry.activate('oc_1', { cardId: 'card_1', messageId: 'om_1', startTime: 1 });
    const second = registry.activate('oc_2', { cardId: 'card_2', messageId: 'om_2', startTime: 2 });
    first.throttleTimer = timers[0];
    first.typewriterTimer = timers[1];
    second.throttleTimer = timers[2];
    second.typewriterTimer = timers[3];
    let resolveCreation!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { resolveCreation = resolve; });
    registry.trackCreation('oc_3', () => pending);

    registry.clear();

    assert.deepEqual(cleared, timers);
    assert.equal(registry.has('oc_1'), false);
    assert.equal(registry.has('oc_2'), false);
    assert.equal(registry.getCreation('oc_3'), undefined);
    resolveCreation(false);
    await pending;
  });
});
