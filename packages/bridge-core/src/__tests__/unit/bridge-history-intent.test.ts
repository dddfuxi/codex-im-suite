import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractHistoryTargetSpeakerNames,
  parseFeishuHistoryIntent,
} from '../../lib/bridge/application/history-intent.js';

const NOW = new Date(2026, 6, 20, 15, 30, 0, 0);

describe('bridge history intent', () => {
  it('recognizes casual group-history summaries without requiring the word record', () => {
    const intent = parseFeishuHistoryIntent('看看群里都在聊什么', NOW);

    assert.ok(intent);
    assert.equal(intent.responseMode, 'chat');
    assert.equal(intent.purpose, 'summary');
    assert.equal(intent.limit, 30);
    assert.equal(intent.scopeText, '本群最近消息');
  });

  it('promotes upward message references to cloud history instead of nearby context', () => {
    const intent = parseFeishuHistoryIntent('小虾米，看我上面那条卡片再回答', NOW);

    assert.ok(intent);
    assert.equal(intent.scopeText, '本群上方消息');
    assert.equal(intent.purpose, 'summary');
  });

  it('creates deterministic time windows and clamps requested counts', () => {
    const yesterday = parseFeishuHistoryIntent('总结昨天上午群聊最近999条消息', NOW);
    assert.ok(yesterday);
    assert.equal(yesterday.limit, 100);
    assert.equal(yesterday.scopeText, '本群昨天的上午聊天记录');
    assert.equal(yesterday.startTimeMs, new Date(2026, 6, 19, 0, 0, 0, 0).getTime());
    assert.equal(yesterday.endTimeMs, new Date(2026, 6, 19, 12, 0, 0, 0).getTime());

    const minimum = parseFeishuHistoryIntent('总结最近1条群聊消息', NOW);
    assert.equal(minimum?.limit, 5);
  });

  it('extracts speaker-scoped reference actions without treating ordinary history as an action', () => {
    assert.deepEqual(extractHistoryTargetSpeakerNames('根据小明的聊天记录核对表情包命名'), ['小明']);
    const intent = parseFeishuHistoryIntent('根据小明的聊天记录核对表情包命名', NOW);
    assert.ok(intent);
    assert.equal(intent.purpose, 'reference');
    assert.equal(intent.limit, 50);
    assert.deepEqual(intent.targetSpeakerNames, ['小明']);
  });

  it('routes explicit document output requests while rejecting unrelated document questions', () => {
    const intent = parseFeishuHistoryIntent('把今天群聊总结生成飞书文档并发链接', NOW);
    assert.ok(intent);
    assert.equal(intent.responseMode, 'doc');
    assert.match(intent.scopeText, /今天/u);

    assert.equal(parseFeishuHistoryIntent('飞书文档权限为什么失败', NOW), null);
    assert.equal(parseFeishuHistoryIntent('这条消息怎么发送', NOW), null);
  });
});
