import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideWorkflowFailureRetry,
  normalizeWorkflowFailureText,
} from '../workflow-failure-policy.js';

describe('workflow failure retry policy', () => {
  it('does not retry a wrapped Chinese Codex login-expired failure', () => {
    const decision = decideWorkflowFailureRetry(
      new Error('Codex 主模型失败，自动切换链未启用可用来源：Codex 登录已失效，请重新登录。'),
    );

    assert.deepEqual(decision, {
      category: 'authentication',
      autoRetry: false,
      reasonCode: 'authentication_requires_user_action',
    });
  });

  it('reads nested causes instead of depending only on the outer message', () => {
    const error = new Error('provider failed', {
      cause: Object.assign(new Error('401 Unauthorized: refresh token expired'), { code: 'AUTH_EXPIRED' }),
    });

    assert.match(normalizeWorkflowFailureText(error), /refresh token expired/);
    assert.equal(decideWorkflowFailureRetry(error).category, 'authentication');
  });

  it('does not restart an aborted turn', () => {
    const decision = decideWorkflowFailureRetry(new Error('The operation was aborted'));

    assert.equal(decision.autoRetry, false);
    assert.equal(decision.category, 'cancelled');
  });

  it('keeps one automatic retry for transient network failures', () => {
    const decision = decideWorkflowFailureRetry(new Error('fetch failed: ECONNRESET'));

    assert.equal(decision.autoRetry, true);
    assert.equal(decision.category, 'transient');
  });

  it('preserves the existing one-retry fallback for unknown failures', () => {
    const decision = decideWorkflowFailureRetry(new Error('unexpected provider failure'));

    assert.equal(decision.autoRetry, true);
    assert.equal(decision.category, 'unknown');
  });
});
