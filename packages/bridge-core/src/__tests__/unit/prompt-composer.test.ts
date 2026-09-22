import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { composeBridgePrompt, composePromptSections } from '../../lib/bridge/prompt-composer.js';

describe('prompt composer', () => {
  it('composes prompt sections in stable priority order', () => {
    const result = composeBridgePrompt({
      identity: 'identity',
      base: 'base',
      policy: 'policy',
      memory: 'memory',
      skills: 'skills',
      style: 'style',
      protocol: 'protocol',
    });
    assert.deepEqual(result.sections.map((item) => item.kind), ['identity', 'base', 'policy', 'skills', 'memory', 'style', 'protocol']);
    assert.equal(result.text, result.sections.map((item) => item.content).join('\n\n'));
  });

  it('preserves explicit section order for compatibility-sensitive bridge prompts', () => {
    const result = composePromptSections([
      { id: 'channel', kind: 'identity', source: 'channel', priority: 10, content: 'channel' },
      { id: 'memory', kind: 'memory', source: 'memory', priority: 20, content: 'memory' },
      { id: 'base', kind: 'base', source: 'session', priority: 30, content: 'base' },
    ]);
    assert.equal(result.text, 'channel\n\nmemory\n\nbase');
  });

  it('keeps sticker expression policy as an independent prompt section', () => {
    const result = composePromptSections([
      { id: 'expression.sticker-semantics', kind: 'expression', source: 'sticker-semantics', priority: 18, content: '表达与表情包策略' },
      { id: 'memory', kind: 'memory', source: 'memory', priority: 20, content: 'memory' },
    ]);
    assert.equal(result.sections[0].id, 'expression.sticker-semantics');
    assert.equal(result.sections[0].kind, 'expression');
  });
});
