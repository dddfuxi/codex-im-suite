import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FeishuHistoryIntent } from '../../lib/bridge/application/history-intent.js';

async function loadModule() {
  try {
    return await import('../../lib/bridge/channels/feishu/history/indexed-history-prompt.js');
  } catch {
    return null;
  }
}

function intent(patch: Partial<FeishuHistoryIntent> = {}): FeishuHistoryIntent {
  return {
    originalPrompt: '总结群聊',
    taskPrompt: '总结群聊',
    limit: 20,
    scopeText: '本群今天的聊天记录',
    responseMode: 'chat',
    purpose: 'summary',
    ...patch,
  };
}

describe('Feishu indexed history prompt', () => {
  it('reports a scoped empty result without pretending that history was recovered', async () => {
    const module = await loadModule();
    assert.ok(module, 'Feishu indexed history prompt module should exist');

    const prompt = module.buildFeishuIndexedHistoryPrompt({
      intent: intent({ taskPrompt: '根据小王的记录核对命名', targetSpeakerNames: ['小王'], purpose: 'reference' }),
      retrieved: null,
    });

    assert.match(prompt, /用户当前请求：根据小王的记录核对命名/);
    assert.match(prompt, /没有筛到与 小王 相关的有效消息/);
    assert.doesNotMatch(prompt, /群聊历史开始/);
  });

  it('builds document-only instructions around the retrieved history summary', async () => {
    const module = await loadModule();
    assert.ok(module, 'Feishu indexed history prompt module should exist');

    const prompt = module.buildFeishuIndexedHistoryPrompt({
      intent: intent({ responseMode: 'doc', taskPrompt: '整理成飞书文档' }),
      retrieved: {
        summary: '[10:00] 小王：确认方案 A',
        items: [{ messageId: 'om_1' }],
        syncStatus: { messageCount: 42 },
      },
    });

    assert.match(prompt, /适合直接写入飞书文档的 Markdown 正文/);
    assert.match(prompt, /本地索引已同步 42 条/);
    assert.match(prompt, /=== 群聊历史开始 ===/);
    assert.match(prompt, /\[10:00\] 小王：确认方案 A/);
    assert.match(prompt, /用户当前请求：整理成飞书文档/);
  });

  it('preserves exact identifiers for speaker-scoped reference work', async () => {
    const module = await loadModule();
    assert.ok(module, 'Feishu indexed history prompt module should exist');

    const prompt = module.buildFeishuIndexedHistoryPrompt({
      intent: intent({
        taskPrompt: '按小王说的修正资源名',
        purpose: 'reference',
        targetSpeakerNames: ['小王'],
      }),
      retrieved: {
        summary: '小王：资源名用 HospitalWall_A',
        items: [{ messageId: 'om_1' }],
      },
    });

    assert.match(prompt, /优先原样保留/);
    assert.match(prompt, /=== 相关群聊记录开始 ===/);
    assert.match(prompt, /HospitalWall_A/);
  });

  it('builds a concise summary prompt for ordinary indexed history retrieval', async () => {
    const module = await loadModule();
    assert.ok(module, 'Feishu indexed history prompt module should exist');

    const prompt = module.buildFeishuIndexedHistoryPrompt({
      intent: intent(),
      retrieved: {
        summary: '大家决定明天发布。',
        items: [{ messageId: 'om_1' }, { messageId: 'om_2' }],
      },
    });

    assert.match(prompt, /索引命中的2条相关消息/);
    assert.match(prompt, /直接给出结论和摘要/);
    assert.match(prompt, /大家决定明天发布/);
  });
});
