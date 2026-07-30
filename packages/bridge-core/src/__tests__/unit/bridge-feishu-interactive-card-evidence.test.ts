import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseFeishuInteractiveCardEvidence } from '../../lib/bridge/feishu-interactive-card-evidence.js';

describe('Feishu interactive card evidence boundary', () => {
  it('separates terminal completion metadata from the business body', () => {
    const evidence = parseFeishuInteractiveCardEvidence(JSON.stringify({
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: '这叫一鼓作气，不叫胜负心。' },
          { tag: 'markdown', content: '已完成 · 5.6s' },
        ],
      },
    }));

    assert.equal(evidence.visibleText, '这叫一鼓作气，不叫胜负心。');
    assert.deepEqual(evidence.textParts, ['这叫一鼓作气，不叫胜负心。']);
    assert.deepEqual(evidence.presentationTextParts, ['已完成 · 5.6s']);
    assert.equal(evidence.presentationMetadataRemoved, true);
  });

  it('separates the structured footer after a divider without dropping the result', () => {
    const evidence = parseFeishuInteractiveCardEvidence(JSON.stringify({
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: '构建结果：全部通过。' },
          { tag: 'hr' },
          {
            tag: 'markdown',
            content: '<font color="grey">✓ 已完成 · 耗时：5.6s · 来源：Codex · 模型：gpt-5</font>',
            text_size: 'notation',
          },
        ],
      },
    }));

    assert.equal(evidence.visibleText, '构建结果：全部通过。');
    assert.equal(evidence.presentationMetadataRemoved, true);
    assert.match(evidence.rawText, /5\.6s/u);
  });

  it('removes notation-only execution badges and compound elapsed time', () => {
    const evidence = parseFeishuInteractiveCardEvidence(JSON.stringify({
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: '正文结论。' },
          {
            tag: 'markdown',
            content: '<font color="green">● 结果已生成</font>　<font color="grey">● 仅文本回复</font>',
            text_size: 'notation',
          },
          { tag: 'hr' },
          { tag: 'markdown', content: '✅ · 耗时：1m 2s', text_size: 'notation' },
        ],
      },
    }));

    assert.equal(evidence.visibleText, '正文结论。');
    assert.deepEqual(evidence.presentationTextParts, [
      '<font color="green">● 结果已生成</font>　<font color="grey">● 仅文本回复</font>',
      '✅ · 耗时：1m 2s',
    ]);
  });

  it('keeps a card whose only business text genuinely discusses elapsed time', () => {
    const evidence = parseFeishuInteractiveCardEvidence(JSON.stringify({
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: '任务已完成，用时 5.6 秒，主要瓶颈是网络。' },
        ],
      },
    }));

    assert.equal(evidence.visibleText, '任务已完成，用时 5.6 秒，主要瓶颈是网络。');
    assert.deepEqual(evidence.presentationTextParts, []);
    assert.equal(evidence.presentationMetadataRemoved, false);
  });
});
