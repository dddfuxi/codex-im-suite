import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { shouldRunCorrectionMaintenance } from '../../lib/bridge/self-maintenance-routing.js';

describe('self-maintenance correction routing', () => {
  it('skips ordinary continuations and acknowledgements', () => {
    for (const text of ['继续', '收到', '谢谢', '可以，往下做', '再优化一下']) {
      assert.equal(shouldRunCorrectionMaintenance({
        currentUserText: text,
        previousAssistantText: '上一轮已经完成基础实现。',
      }), false, text);
    }
  });

  it('keeps explicit and contrastive corrections on the classifier path', () => {
    for (const text of [
      '你刚才判断错了，文件实际存在。',
      '还是错，正确的是 B。',
      '其实不是这个目录，是另一个工作区。',
      'That is incorrect; the file actually exists.',
    ]) {
      assert.equal(shouldRunCorrectionMaintenance({
        currentUserText: text,
        previousAssistantText: '文件不存在。',
      }), true, text);
    }
  });

  it('does not run without a real previous assistant output', () => {
    assert.equal(shouldRunCorrectionMaintenance({
      currentUserText: '你判断错了。',
      previousAssistantText: '',
    }), false);
  });
});
