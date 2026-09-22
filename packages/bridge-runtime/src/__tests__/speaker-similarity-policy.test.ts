import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SPEAKER_SIMILARITY_THRESHOLD,
  speakerSimilarityAcceptanceRecorded,
  speakerSimilarityPassed,
} from '../speech/speaker-similarity-policy.js';

test('说话人相似度必须是有效余弦值且达到统一阈值', () => {
  assert.equal(speakerSimilarityPassed(DEFAULT_SPEAKER_SIMILARITY_THRESHOLD), true);
  assert.equal(speakerSimilarityPassed(DEFAULT_SPEAKER_SIMILARITY_THRESHOLD - 0.01), false);
  assert.equal(speakerSimilarityPassed(Number.NaN), false);
  assert.equal(speakerSimilarityPassed(1.01), false);
});

test('音色身份通过不依赖模型性能 state，但必须保留一致的真实指标', () => {
  assert.equal(speakerSimilarityAcceptanceRecorded({
    speakerSimilarity: 0.91,
    speakerSimilarityThreshold: 0.72,
    speakerSimilarityPassed: true,
  }), true);
  assert.equal(speakerSimilarityAcceptanceRecorded({
    speakerSimilarity: 0.71,
    speakerSimilarityThreshold: 0.72,
    speakerSimilarityPassed: true,
  }), false);
  assert.equal(speakerSimilarityAcceptanceRecorded({
    speakerSimilarity: 0.91,
    speakerSimilarityThreshold: 0.72,
    speakerSimilarityPassed: false,
  }), false);
});
