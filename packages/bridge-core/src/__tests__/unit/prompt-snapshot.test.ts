import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createPromptSnapshot } from '../../lib/bridge/prompt-snapshot.js';

describe('prompt snapshot', () => {
  it('redacts secrets and records truncation without storing raw tokens', () => {
    const snapshot = createPromptSnapshot({
      sessionId: 's1',
      sections: [{ id: 'policy', kind: 'policy', source: 'test', priority: 1, content: 'token=secret-value' }],
      maxSectionChars: 12,
      now: () => new Date('2026-07-15T05:00:00.000Z'),
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /secret-value/u);
    assert.equal(snapshot.sections[0].truncated, true);
    assert.equal(snapshot.sections[0].injected, true);
    assert.match(snapshot.sections[0].hash, /^[a-f0-9]{64}$/u);
    assert.equal(snapshot.sections[0].truncationReason, 'section_limit');
  });

  it('records separately injected priority context without adding it to system prompt text', () => {
    const snapshot = createPromptSnapshot({
      sessionId: 's2',
      sections: [{ id: 'priority', kind: 'priority_context', source: 'adapter', priority: 1, content: 'reply evidence', injected: true }],
    });
    assert.equal(snapshot.sections[0].kind, 'priority_context');
    assert.equal(snapshot.sections[0].charCount, 'reply evidence'.length);
  });

  it('records the scoped sticker expression policy as its own section', () => {
    const snapshot = createPromptSnapshot({
      sessionId: 's3',
      sections: [{
        id: 'expression.sticker-semantics',
        kind: 'expression',
        source: 'sticker-semantics',
        priority: 18,
        content: '## 表达与表情包策略\n- 当前群聊可试用庆祝猫',
      }],
    });
    assert.equal(snapshot.sections[0].id, 'expression.sticker-semantics');
    assert.equal(snapshot.sections[0].kind, 'expression');
  });
});
