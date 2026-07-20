import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyCandidateEligibility,
  mergeCandidateObservation,
} from '../memory-items/candidate-policy.js';

describe('memory candidate policy', () => {
  it('rejects commands, questions, links, mentions and protocol-like text', () => {
    for (const text of [
      'Unity MCP 截一张 game 图',
      'pve 关卡场景叫啥',
      'https://example.com 看一下并总结',
      '@_user_1 按这个格式回复',
      'powershell -File doctor.ps1 检查工具',
      '```cti-final {"text":"已完成"} ```',
    ]) {
      assert.equal(classifyCandidateEligibility({ role: 'user', text }).eligible, false, text);
    }
  });

  it('accepts a bounded stable human preference only as a candidate signal', () => {
    const result = classifyCandidateEligibility({
      role: 'user',
      text: '我更喜欢所有技术报告先给结论，再列验证证据。',
    });

    assert.equal(result.eligible, true);
    assert.equal(result.reason, 'stable_declarative_candidate');
    assert.equal(result.normalizedText, '我更喜欢所有技术报告先给结论，再列验证证据。');
    assert.equal(classifyCandidateEligibility({ role: 'assistant', text: '用户喜欢中文回复。' }).eligible, false);
  });

  it('counts the same observation once per independent session', () => {
    const first = mergeCandidateObservation(undefined, {
      sessionId: 'session-a',
      text: '我更喜欢先给结论。',
      sourceMessageHash: 'message-a',
      observedAt: '2026-07-20T10:00:00.000Z',
    });
    const replayed = mergeCandidateObservation(first, {
      sessionId: 'session-a',
      text: '我更喜欢先给结论。',
      sourceMessageHash: 'message-a-replayed',
      observedAt: '2026-07-20T10:01:00.000Z',
    });
    const independent = mergeCandidateObservation(replayed, {
      sessionId: 'session-b',
      text: '我更喜欢先给结论。',
      sourceMessageHash: 'message-b',
      observedAt: '2026-07-21T10:00:00.000Z',
    });

    assert.deepEqual(replayed.sessionIds, ['session-a']);
    assert.deepEqual(replayed.sourceMessageHashes, ['message-a']);
    assert.deepEqual(independent.sessionIds, ['session-a', 'session-b']);
    assert.deepEqual(independent.sourceMessageHashes, ['message-a', 'message-b']);
    assert.equal(independent.distinctSessionCount, 2);
  });
});
