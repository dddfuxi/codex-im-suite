import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldDirectAnswerFromMemory,
  shouldRetrieveMemoryForPrompt,
} from '../memory-routing.js';

describe('memory routing', () => {
  it('does not direct-answer ordinary keyword matches from memory', () => {
    assert.equal(shouldDirectAnswerFromMemory('场景名称是什么'), false);
    assert.equal(shouldDirectAnswerFromMemory('HSScene 对应什么'), false);
  });

  it('retrieves memory only for explicit recall or search requests', () => {
    assert.equal(shouldRetrieveMemoryForPrompt('帮我找上次的场景名称对应表'), true);
    assert.equal(shouldRetrieveMemoryForPrompt('你还记得 HSScene 的常用名称吗'), true);
    assert.equal(shouldRetrieveMemoryForPrompt('场景名称是什么'), false);
  });
});
