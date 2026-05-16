import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reviewOutboundAnswerRules } from '../answer-review.js';

describe('answer review', () => {
  it('warns when a memory answer returns an unrelated structured table', () => {
    const decision = reviewOutboundAnswerRules({
      channelType: 'feishu',
      chatId: 'oc_group',
      userText: '第十三条龙叫啥@小虾米',
      answerText: '项目 HSScene：医院内部场景 city3d_citystage_ST2H_Scene == 外城场景',
      memoryPlan: {
        intent: 'explicit_recall',
        queryText: '第十三条龙叫啥@小虾米',
        normalizedKey: '第十三条龙',
        answerMode: 'direct_if_confident',
        minConfidence: 0.78,
        allowDirectAnswer: true,
      },
      memoryHits: [{
        sessionId: 'knowledge-index:dragon',
        role: 'assistant',
        source: 'summary',
        sourceType: 'knowledge',
        score: 20,
        confidence: 0.95,
        answerability: 'structured',
        quality: 'high',
        structuredKey: '第十三条龙',
        structuredValue: '雷霆龙',
        content: '第十三条龙 = 雷霆龙',
      }],
    });

    assert.equal(decision.verdict, 'warn');
    assert.ok(decision.reasonCodes.includes('memory_key_mismatch'));
  });

  it('warns on mojibake and protocol leakage', () => {
    const decision = reviewOutboundAnswerRules({
      channelType: 'feishu',
      chatId: 'oc_group',
      userText: '整理一下你现在都记得啥',
      answerText: 'HSScene = 鍖婚櫌鍐呴儴鍦烘櫙\n```cti-final\n{}',
    });

    assert.equal(decision.verdict, 'warn');
    assert.ok(decision.reasonCodes.includes('mojibake'));
    assert.ok(decision.reasonCodes.includes('protocol_leakage'));
  });
});
