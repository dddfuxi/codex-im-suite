import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeterministicReferencedSingingDirective,
  expectsActiveReferenceSingingVoice,
  expectsManagedSingingProtocol,
  reviewSingingReplyProtocol,
} from './singing-request-review.js';

function singingEnvelope(extra: Record<string, unknown> = {}): string {
  return [
    '```cti-final',
    JSON.stringify({
      kind: 'text',
      text: '完整文字回退。',
      images: [],
      files: [],
      reply_mode: 'plain',
      singing: {
        mode: 'song_only',
        prompt: '轻快童谣',
        lyrics: '星光轻轻落下来',
        vocal_language: 'zh',
        duration_seconds: 10,
      },
      ...extra,
    }),
    '```',
  ].join('\n');
}

test('明确演唱请求要求受管歌声协议，但能力咨询和否定请求不触发', () => {
  for (const value of ['唱一首小星星', '发语音唱。。。。', '请清唱一段', '来一首轻快的歌', 'sing a song for me']) {
    assert.equal(expectsManagedSingingProtocol(value), true, value);
  }
  for (const value of ['你会唱歌吗？', '不要唱歌', '停止演唱', 'can you sing?']) {
    assert.equal(expectsManagedSingingProtocol(value), false, value);
  }
});

test('明确演唱请求缺少 singing 时要求协议修复，合法协议直接通过', () => {
  const missing = reviewSingingReplyProtocol({
    userText: '唱一首小星星',
    responseText: singingEnvelope({ singing: undefined }),
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.failure.code, 'missing_managed_singing_protocol');
    assert.match(missing.failure.repairInstruction, /empty images\/files/u);
  }

  assert.deepEqual(reviewSingingReplyProtocol({
    userText: '唱一首小星星',
    responseText: singingEnvelope(),
  }), { ok: true });
});

test('singing 夹带普通音频文件时视为无效，不能绕过原生歌声投递', () => {
  const result = reviewSingingReplyProtocol({
    userText: '发语音唱一段',
    responseText: singingEnvelope({ kind: 'mixed', files: ['song.mp3'] }),
  });
  assert.equal(result.ok, false);
});

test('克隆音色演唱要求参考音色类别，并把可信原生回复正文带入一次协议修复', () => {
  assert.equal(expectsActiveReferenceSingingVoice('用克隆音色把这个唱出来'), true);
  assert.equal(expectsActiveReferenceSingingVoice('唱一首小星星'), false);

  const missing = reviewSingingReplyProtocol({
    userText: '用克隆音色把这个唱出来',
    responseText: singingEnvelope(),
    referencedText: '来啦～冥神低音开唱',
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.match(missing.failure.repairInstruction, /voice_requirement="active_reference"/u);
    assert.match(missing.failure.repairInstruction, /冥神低音开唱/u);
  }

  assert.deepEqual(reviewSingingReplyProtocol({
    userText: '用克隆音色把这个唱出来',
    responseText: singingEnvelope({
      singing: {
        mode: 'song_only',
        prompt: '低沉男声',
        lyrics: '来啦～冥神低音开唱',
        vocal_language: 'zh',
        duration_seconds: 10,
        voice_requirement: 'active_reference',
      },
    }),
  }), { ok: true });
});

test('唯一可靠引用可形成通用完整歌声指令，且不会接受缺失引用或能力咨询', () => {
  const directive = buildDeterministicReferencedSingingDirective({
    userText: '用克隆音色把这个唱出来',
    referencedText: '第一句歌词\n第二句歌词',
    maxDurationSeconds: 180,
  });
  assert.equal(directive?.voiceRequirement, 'active_reference');
  assert.equal(directive?.lyrics, '第一句歌词\n第二句歌词');
  assert.ok((directive?.durationSeconds || 0) >= 10);
  const longLyrics = Array.from({ length: 600 }, (_, index) => `第${index + 1}句`).join('\n');
  assert.equal(buildDeterministicReferencedSingingDirective({
    userText: '用克隆音色把这个完整唱出来',
    referencedText: longLyrics,
    maxLyricsCharacters: 6_000,
    maxDurationSeconds: 600,
  })?.lyrics, longLyrics);
  assert.equal(buildDeterministicReferencedSingingDirective({
    userText: '用克隆音色把这个唱出来',
  }), undefined);
  assert.equal(buildDeterministicReferencedSingingDirective({
    userText: '你会唱歌吗？',
    referencedText: '不是歌词授权',
  }), undefined);
});
