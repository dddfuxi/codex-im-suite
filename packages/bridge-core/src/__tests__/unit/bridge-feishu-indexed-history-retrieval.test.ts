import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter.js';
import type { FeishuHistoryIntent } from '../../lib/bridge/application/history-intent.js';

async function loadRetrievalModule() {
  return await import('../../lib/bridge/channels/feishu/history/indexed-history-retrieval.js');
}

function intent(patch: Partial<FeishuHistoryIntent> = {}): FeishuHistoryIntent {
  return {
    originalPrompt: '总结今天群聊',
    taskPrompt: '总结今天群聊',
    limit: 30,
    startTimeMs: 1000,
    endTimeMs: 5000,
    scopeText: '本群今天的聊天记录',
    responseMode: 'chat',
    purpose: 'summary',
    targetSpeakerNames: ['小王'],
    ...patch,
  };
}

describe('Feishu indexed history retrieval', () => {
  it('passes the exact current-chat scope to the controlled index capability', async () => {
    const { retrieveFeishuIndexedHistory } = await loadRetrievalModule();
    const queries: unknown[] = [];
    const expected = {
      summary: '[07-20 10:00] 小王: 使用 ResourceToken_v2',
      items: [{ messageId: 'om_history_1' }],
    };

    const result = retrieveFeishuIndexedHistory({
      chatId: 'oc_current',
      intent: intent(),
      retrieve: (query) => {
        queries.push(query);
        return expected;
      },
    });

    assert.equal(result, expected);
    assert.deepEqual(queries, [{
      chatId: 'oc_current',
      query: '总结今天群聊',
      limit: 30,
      startTimeMs: 1000,
      endTimeMs: 5000,
      targetSpeakerNames: ['小王'],
    }]);
  });

  it('fails closed when the indexed retrieval capability is unavailable', async () => {
    const { retrieveFeishuIndexedHistory } = await loadRetrievalModule();

    assert.equal(retrieveFeishuIndexedHistory({
      chatId: 'oc_current',
      intent: intent(),
    }), null);
  });

  it('does not query an index without a stable current chat identity', async () => {
    const { retrieveFeishuIndexedHistory } = await loadRetrievalModule();
    let called = false;

    assert.equal(retrieveFeishuIndexedHistory({
      chatId: '  ',
      intent: intent(),
      retrieve: () => {
        called = true;
        return { summary: 'unsafe', items: [] };
      },
    }), null);
    assert.equal(called, false);
  });

  it('removes the obsolete direct-cloud prompt path from the Feishu adapter facade', () => {
    const adapter = new FeishuAdapter() as unknown as Record<string, unknown>;

    assert.equal(adapter.buildHistoryAugmentedPrompt, undefined);
    assert.equal(adapter.matchesHistorySpeakerV2, undefined);
    assert.equal(adapter.isNamingContextItemV2, undefined);
    assert.equal(adapter.extractCodeLikeTokensV2, undefined);
    assert.equal(adapter.mergeHistoryItemsV2, undefined);
  });
});
