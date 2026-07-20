import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FeishuStreamingCardRegistry } from '../../lib/bridge/channels/feishu/cards/streaming-card-registry.js';
import type { ToolCallInfo } from '../../lib/bridge/types.js';

async function loadLifecycle() {
  return await import('../../lib/bridge/channels/feishu/cards/streaming-card-lifecycle.js');
}

class FakeScheduler {
  now = 1_000;
  private nextId = 1;
  private readonly tasks = new Map<number, { dueAt: number; run: () => void }>();

  setTimeout = (run: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.tasks.set(id, { dueAt: this.now + delayMs, run });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimeout = (timer: ReturnType<typeof setTimeout>): void => {
    this.tasks.delete(timer as unknown as number);
  };

  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.dueAt;
      task.run();
    }
    this.now = target;
  }

  get size(): number {
    return this.tasks.size;
  }
}

function createHarness() {
  const scheduler = new FakeScheduler();
  const registry = new FeishuStreamingCardRegistry(scheduler.clearTimeout);
  const streamed: Array<{ cardId: string; content: string; sequence: number }> = [];
  const renderFinalCalls: unknown[][] = [];
  return {
    scheduler,
    registry,
    streamed,
    renderFinalCalls,
    options: {
      registry,
      now: () => scheduler.now,
      setTimer: scheduler.setTimeout,
      clearTimer: scheduler.clearTimeout,
      throttleMs: 200,
      typewriterIntervalMs: 70,
      typewriterStepChars: 2,
      getCurrentStep: (text: string) => text,
      renderStreamingContent: (text: string, tools: ToolCallInfo[], visibleChars: number) =>
        `${[...text].slice(0, visibleChars).join('')}|tools=${tools.length}`,
      pushStreamingContent: async (state: { cardId: string }, content: string, sequence: number) => {
        streamed.push({ cardId: state.cardId, content, sequence });
      },
      extractFinalResponse: (text: string) => text.replace(/^FINAL:/u, ''),
      renderFinalCard: (...args: unknown[]) => {
        renderFinalCalls.push(args);
        return JSON.stringify({ finalText: args[0], footer: args[2] });
      },
      formatElapsed: (elapsedMs: number) => `${elapsedMs}ms`,
    },
  };
}

describe('Feishu streaming card lifecycle', () => {
  it('streams new text immediately and advances it through one typewriter timer chain', async () => {
    const { FeishuStreamingCardLifecycle } = await loadLifecycle();
    const harness = createHarness();
    const lifecycle = new FeishuStreamingCardLifecycle(harness.options);
    const state = harness.registry.activate('oc_chat', {
      cardId: 'card_1',
      messageId: 'om_card',
      startTime: 900,
    });

    lifecycle.updateText('oc_chat', 'abcd');
    await Promise.resolve();

    assert.equal(state.thinking, false);
    assert.equal(state.pendingText, 'abcd');
    assert.deepEqual(harness.streamed, [
      { cardId: 'card_1', content: '|tools=0', sequence: 1 },
    ]);
    assert.equal(harness.scheduler.size, 1);

    harness.scheduler.advance(70);
    await Promise.resolve();
    harness.scheduler.advance(70);
    await Promise.resolve();

    assert.deepEqual(harness.streamed.map((item) => item.content), [
      '|tools=0',
      'ab|tools=0',
      'abcd|tools=0',
    ]);
    assert.equal(state.sequence, 3);
    assert.equal(state.lastUpdateAt, 1_140);
    assert.equal(state.typewriterTimer, null);
  });

  it('coalesces rapid text into one trailing-edge flush', async () => {
    const { FeishuStreamingCardLifecycle } = await loadLifecycle();
    const harness = createHarness();
    const lifecycle = new FeishuStreamingCardLifecycle(harness.options);
    const state = harness.registry.activate('oc_chat', {
      cardId: 'card_1',
      messageId: 'om_card',
      startTime: 900,
    });
    state.lastUpdateAt = harness.scheduler.now;

    lifecycle.updateText('oc_chat', 'first');
    lifecycle.updateText('oc_chat', 'latest');

    assert.equal(harness.streamed.length, 0);
    assert.equal(harness.scheduler.size, 1);
    assert.equal(state.pendingText, 'latest');

    harness.scheduler.advance(199);
    await Promise.resolve();
    assert.equal(harness.streamed.length, 0);

    harness.scheduler.advance(1);
    await Promise.resolve();
    assert.equal(harness.streamed[0]?.content, '|tools=0');
  });

  it('restarts typewriter progress when tool state changes', async () => {
    const { FeishuStreamingCardLifecycle } = await loadLifecycle();
    const harness = createHarness();
    const lifecycle = new FeishuStreamingCardLifecycle(harness.options);
    const state = harness.registry.activate('oc_chat', {
      cardId: 'card_1',
      messageId: 'om_card',
    });

    lifecycle.updateText('oc_chat', 'abcd');
    await Promise.resolve();
    const previousKey = state.typewriterKey;
    state.lastUpdateAt = 0;
    lifecycle.updateTools('oc_chat', [{ id: 'tool_1', name: 'Read', status: 'running' }]);
    await Promise.resolve();

    assert.notEqual(state.typewriterKey, previousKey);
    assert.equal(harness.scheduler.size, 1);
    assert.equal(harness.streamed.at(-1)?.content, '|tools=1');
  });

  it('waits for creation, closes streaming, writes the final card, persists, and removes state', async () => {
    const { FeishuStreamingCardLifecycle } = await loadLifecycle();
    const harness = createHarness();
    const lifecycle = new FeishuStreamingCardLifecycle(harness.options);
    let resolveCreation!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { resolveCreation = resolve; });
    harness.registry.trackCreation('oc_chat', () => pending);
    const calls: string[] = [];

    const finalizing = lifecycle.finalize({
      chatId: 'oc_chat',
      status: 'completed',
      responseText: 'FINAL:结果正文',
      hooks: {
        closeStreaming: async (_state, sequence) => { calls.push(`close:${sequence}`); },
        resolveFinalResponse: async (_state, visibleText) => `${visibleText}-resolved`,
        updateFinalCard: async (_state, cardJson, sequence) => {
          calls.push(`update:${sequence}:${cardJson}`);
        },
        persistContinuation: (_state, status, finalText) => {
          calls.push(`persist:${status}:${finalText}`);
        },
      },
    });

    harness.registry.activate('oc_chat', {
      cardId: 'card_1',
      messageId: 'om_card',
      startTime: 800,
    });
    resolveCreation(true);

    assert.equal(await finalizing, true);
    assert.deepEqual(calls, [
      'close:1',
      'update:2:{"finalText":"结果正文-resolved","footer":{"status":"已完成","elapsed":"200ms"}}',
      'persist:completed:结果正文-resolved',
    ]);
    assert.equal(harness.registry.has('oc_chat'), false);
    assert.equal(harness.renderFinalCalls.length, 1);
  });

  it('removes card state when final delivery fails', async () => {
    const { FeishuStreamingCardLifecycle } = await loadLifecycle();
    const harness = createHarness();
    const lifecycle = new FeishuStreamingCardLifecycle(harness.options);
    harness.registry.activate('oc_chat', {
      cardId: 'card_1',
      messageId: 'om_card',
    });

    const result = await lifecycle.finalize({
      chatId: 'oc_chat',
      status: 'error',
      responseText: '失败',
      hooks: {
        closeStreaming: async () => { throw new Error('settings failed'); },
        resolveFinalResponse: async (_state, visibleText) => visibleText,
        updateFinalCard: async () => {},
      },
    });

    assert.equal(result, false);
    assert.equal(harness.registry.has('oc_chat'), false);
  });
});
