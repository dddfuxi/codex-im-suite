import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function loadCardKitCompat() {
  return await import('../../lib/bridge/channels/feishu/cards/cardkit-compat.js');
}

describe('Feishu CardKit compatibility boundary', () => {
  it('prefers a complete CardKit v2 surface over v1', async () => {
    const { resolveFeishuCardKitCompat } = await loadCardKitCompat();
    const noop = async () => ({ data: {} });

    const resolved = resolveFeishuCardKitCompat({
      cardkit: {
        v2: { card: { create: noop, streamContent: noop, update: noop } },
        v1: {
          card: { create: noop, settings: noop, update: noop },
          cardElement: { content: noop },
        },
      },
    });

    assert.equal(resolved?.version, 'v2');
  });

  it('falls back to CardKit v1 and rejects incomplete SDK surfaces', async () => {
    const { resolveFeishuCardKitCompat } = await loadCardKitCompat();
    const noop = async () => ({ data: {} });

    assert.equal(resolveFeishuCardKitCompat({
      cardkit: {
        v1: {
          card: { create: noop, settings: noop, update: noop },
          cardElement: { content: noop },
        },
      },
    })?.version, 'v1');
    assert.equal(resolveFeishuCardKitCompat({
      cardkit: { v2: { card: { create: noop, update: noop } } },
    }), null);
    assert.equal(resolveFeishuCardKitCompat(null), null);
  });

  it('normalizes card creation and streaming updates for both SDK generations', async () => {
    const {
      createFeishuCardKitCard,
      resolveFeishuCardKitCompat,
      updateFeishuCardKitStreamingContent,
    } = await loadCardKitCompat();
    const calls: unknown[] = [];
    const record = async (payload: unknown) => {
      calls.push(payload);
      return { data: { card_id: 'card_1' } };
    };
    const cardBody = { schema: '2.0', body: { elements: [] } };
    const v1 = resolveFeishuCardKitCompat({
      cardkit: {
        v1: {
          card: { create: record, settings: record, update: record },
          cardElement: { content: record },
        },
      },
    });
    assert.ok(v1);

    await createFeishuCardKitCard(v1, cardBody);
    await updateFeishuCardKitStreamingContent(v1, 'card_1', '处理中', 3);

    assert.deepEqual(calls, [
      { data: { type: 'card_json', data: JSON.stringify(cardBody) } },
      {
        path: { card_id: 'card_1', element_id: 'streaming_content' },
        data: { content: '处理中', sequence: 3 },
      },
    ]);
  });

  it('normalizes streaming mode and final card updates without inventing unsupported v2 settings', async () => {
    const {
      resolveFeishuCardKitCompat,
      setFeishuCardKitStreamingMode,
      updateFeishuCardKitCard,
    } = await loadCardKitCompat();
    const v1Calls: unknown[] = [];
    const v2Calls: unknown[] = [];
    const v1Record = async (payload: unknown) => { v1Calls.push(payload); return { data: {} }; };
    const v2Record = async (payload: unknown) => { v2Calls.push(payload); return { data: {} }; };
    const v1 = resolveFeishuCardKitCompat({
      cardkit: {
        v1: {
          card: { create: v1Record, settings: v1Record, update: v1Record },
          cardElement: { content: v1Record },
        },
      },
    });
    const v2 = resolveFeishuCardKitCompat({
      cardkit: {
        v2: { card: { create: v2Record, streamContent: v2Record, update: v2Record } },
      },
    });
    assert.ok(v1);
    assert.ok(v2);

    await setFeishuCardKitStreamingMode(v1, 'card_1', false, 4);
    await updateFeishuCardKitCard(v1, 'card_1', '{"schema":"2.0"}', 5);
    await setFeishuCardKitStreamingMode(v2, 'card_2', false, 6);
    await updateFeishuCardKitCard(v2, 'card_2', '{"schema":"2.0"}', 7);

    assert.deepEqual(v1Calls, [
      {
        path: { card_id: 'card_1' },
        data: { settings: JSON.stringify({ streaming_mode: false }), sequence: 4 },
      },
      {
        path: { card_id: 'card_1' },
        data: { card: { type: 'card_json', data: '{"schema":"2.0"}' }, sequence: 5 },
      },
    ]);
    assert.deepEqual(v2Calls, [{
      path: { card_id: 'card_2' },
      data: { type: 'card_json', data: '{"schema":"2.0"}', sequence: 7 },
    }]);
  });
});
