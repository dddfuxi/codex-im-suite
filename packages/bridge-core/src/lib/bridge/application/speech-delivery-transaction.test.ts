import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deliverSpeechWithTextFallback,
  replaceProgressCardWithSpeech,
} from './speech-delivery-transaction.js';

test('撤卡失败时不上传音频、不另发文字，由原卡保留唯一文字终态', async () => {
  let audioCalls = 0;
  let textCalls = 0;
  const result = await replaceProgressCardWithSpeech({
    recallProgressCard: async () => ({ ok: false, error: 'recall failed' }),
    sendAudio: async () => { audioCalls += 1; return { ok: true, messageId: 'audio' }; },
    sendTextFallback: async () => { textCalls += 1; return { ok: true, messageId: 'text' }; },
  });
  assert.deepEqual(result, { kind: 'card_preserved', error: 'recall failed' });
  assert.equal(audioCalls, 0);
  assert.equal(textCalls, 0);
});

test('撤卡成功且音频失败时只发送一次完整文字 fallback', async () => {
  let textCalls = 0;
  const result = await replaceProgressCardWithSpeech({
    recallProgressCard: async () => ({ ok: true, messageId: 'old-card' }),
    sendAudio: async () => ({ ok: false, error: 'upload failed' }),
    sendTextFallback: async () => { textCalls += 1; return { ok: true, messageId: 'text-result' }; },
  });
  assert.deepEqual(result, { kind: 'text_fallback', messageId: 'text-result' });
  assert.equal(textCalls, 1);
});

test('撤卡和音频都成功时不再发送文字', async () => {
  let textCalls = 0;
  const result = await replaceProgressCardWithSpeech({
    recallProgressCard: async () => ({ ok: true, messageId: 'old-card' }),
    sendAudio: async () => ({ ok: true, messageId: 'audio-result' }),
    sendTextFallback: async () => { textCalls += 1; return { ok: true, messageId: 'text-result' }; },
  });
  assert.deepEqual(result, { kind: 'audio', messageId: 'audio-result' });
  assert.equal(textCalls, 0);
});

test('非流式音频失败只调用一次文字 fallback', async () => {
  let audioCalls = 0;
  let textCalls = 0;
  const result = await deliverSpeechWithTextFallback({
    sendAudio: async () => { audioCalls += 1; return { ok: false, error: 'tts upload failed' }; },
    sendTextFallback: async () => { textCalls += 1; return { ok: true, messageId: 'text-result' }; },
  });
  assert.equal(result.kind, 'text_fallback');
  assert.equal(audioCalls, 1);
  assert.equal(textCalls, 1);
});
