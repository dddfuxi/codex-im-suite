import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  panelNavigation,
  resolveLegacyServiceTab,
  resolvePageId,
} from './panel-navigation.js';

describe('panel navigation', () => {
  it('groups pages into the four confirmed domains', () => {
    assert.deepEqual(panelNavigation.map((group) => group.id), ['run', 'robot', 'capability', 'governance']);
    assert.deepEqual(panelNavigation[0].pages, ['overview', 'services', 'sessions', 'scheduledTasks']);
    assert.deepEqual(panelNavigation[1].pages, ['architecture', 'prompts', 'memory']);
    assert.deepEqual(panelNavigation[2].pages, ['skills', 'mcp', 'modelsPlugins']);
    assert.deepEqual(panelNavigation[3].pages, ['permissions', 'release', 'logs', 'settings']);
  });

  it('redirects legacy ids without losing the service subview intent', () => {
    assert.equal(resolvePageId('extensions'), 'skills');
    assert.equal(resolvePageId('nodes'), 'services');
    assert.equal(resolvePageId('executors'), 'services');
    assert.equal(resolvePageId('memory'), 'memory');
    assert.equal(resolvePageId('scheduledTasks'), 'scheduledTasks');
    assert.equal(resolvePageId('unknown'), 'overview');
    assert.equal(resolveLegacyServiceTab('nodes'), 'nodes');
    assert.equal(resolveLegacyServiceTab('executors'), 'executors');
    assert.equal(resolveLegacyServiceTab('services'), 'services');
  });
});
