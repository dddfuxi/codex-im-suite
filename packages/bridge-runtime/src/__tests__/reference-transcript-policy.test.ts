import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeReferenceTranscript,
  referenceTranscriptMatches,
} from '../speech/reference-transcript-policy.js';

test('参考文本只忽略排版差异，任何实际字词差异都失败关闭', () => {
  assert.equal(normalizeReferenceTranscript('  Ｈello，世界！ '), 'hello世界');
  assert.equal(referenceTranscriptMatches('这是参考文本。', '这是 参考文本'), true);
  assert.equal(referenceTranscriptMatches('这是参考文本。', '这是参考语本。'), false);
  assert.equal(referenceTranscriptMatches('我使用 C++。', '我使用 C。'), false);
  assert.equal(referenceTranscriptMatches('', ''), false);
});
