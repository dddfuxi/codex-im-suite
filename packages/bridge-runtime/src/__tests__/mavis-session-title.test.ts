import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

import { buildMavisSessionTitle } from '../mavis-session-title.js';

function params(overrides: Partial<StreamChatParams>): StreamChatParams {
  return {
    sessionId: 'session-1',
    prompt: 'hello',
    ...overrides,
  };
}

describe('mavis session title', () => {
  it('uses a short prompt as the title', () => {
    assert.equal(buildMavisSessionTitle(params({ prompt: 'just check git' })), 'mavis:just check git');
  });

  it('truncates a long prompt with an ellipsis', () => {
    const longPrompt = 'a'.repeat(120);
    const title = buildMavisSessionTitle(params({ prompt: longPrompt }));
    assert.ok(title.startsWith('mavis:'));
    assert.ok(title.length <= 64);
    assert.ok(title.endsWith('…'));
  });

  it('falls back to sourceMessageId when prompt is empty', () => {
    const title = buildMavisSessionTitle(params({ prompt: '', sourceMessageId: 'om_abc123' }));
    assert.equal(title, 'mavis:msg-om_abc123');
  });

  it('falls back to sourceMessageId when prompt is only whitespace', () => {
    const title = buildMavisSessionTitle(params({ prompt: '   \n\t  ', sourceMessageId: 'om_xyz' }));
    assert.equal(title, 'mavis:msg-om_xyz');
  });

  it('handles emoji in the prompt', () => {
    const title = buildMavisSessionTitle(params({ prompt: '🎉 ship it now' }));
    assert.ok(title.startsWith('mavis:'));
    assert.ok(title.includes('🎉'));
  });

  it('falls back to sessionId tail when prompt and sourceMessageId are both missing', () => {
    const title = buildMavisSessionTitle(params({ prompt: undefined, sourceMessageId: undefined, sessionId: 'mvs_abcdef-1234' }));
    assert.ok(title.startsWith('mavis:'));
    assert.ok(title.includes('1234'));
  });

  it('always prefixes with mavis:', () => {
    const a = buildMavisSessionTitle(params({ prompt: 'check logs' }));
    const b = buildMavisSessionTitle(params({ prompt: '', sourceMessageId: 'm1' }));
    const c = buildMavisSessionTitle(params({ prompt: undefined, sourceMessageId: undefined, sessionId: 's1' }));
    assert.ok(a.startsWith('mavis:'));
    assert.ok(b.startsWith('mavis:'));
    assert.ok(c.startsWith('mavis:'));
  });
});
