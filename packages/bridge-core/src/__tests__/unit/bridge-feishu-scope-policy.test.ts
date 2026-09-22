import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePreferredFeishuScopeRequirements,
  selectPreferredFeishuScope,
} from '../../lib/bridge/channels/feishu/permissions/scope-policy';
import { getFeishuRecommendedScopes } from '../../lib/bridge/feishu-capabilities';

describe('Feishu least-privilege scope policy', () => {
  it('selects one base read-only scope from compatible Contact alternatives', () => {
    assert.equal(selectPreferredFeishuScope([
      'contact:contact.base:readonly',
      'contact:contact:access_as_app',
      'contact:contact:readonly',
      'contact:contact:readonly_as_app',
    ]), 'contact:contact.base:readonly');
  });

  it('does not expand alternative requirements into a batch request', () => {
    assert.deepEqual(resolvePreferredFeishuScopeRequirements([
      'im:chat.members:read',
      ['contact:contact.base:readonly', 'contact:contact:readonly'],
      ['contact:user.base:readonly', 'contact:contact:access_as_app'],
    ]), [
      'im:chat.members:read',
      'contact:contact.base:readonly',
      'contact:user.base:readonly',
    ]);
  });

  it('keeps the global diagnostic recommendation list to one scope per compatible group', () => {
    const scopes = getFeishuRecommendedScopes();

    assert.ok(scopes.includes('contact:contact.base:readonly'));
    assert.ok(scopes.includes('contact:user.base:readonly'));
    assert.equal(scopes.includes('contact:contact:access_as_app'), false);
    assert.equal(scopes.includes('contact:contact:readonly'), false);
    assert.equal(scopes.includes('contact:contact:readonly_as_app'), false);
  });
});
