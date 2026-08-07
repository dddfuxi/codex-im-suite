import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseSingingReplyDirective,
  parseSingingSynthesisReceipt,
  singingRequestSha256,
} from './singing-policy.js';

test('唱歌协议只接受可见风格、歌词、语言和时长，不接受模型/路径/音色执行字段', () => {
  const directive = parseSingingReplyDirective({
    mode: 'song_only',
    prompt: '温暖的中文流行女声，钢琴伴奏',
    lyrics: '[Verse]\n今天一起出发',
    vocal_language: 'zh',
    duration_seconds: 15,
  });
  assert.ok(directive);
  assert.equal(directive?.durationSeconds, 15);
  assert.equal(parseSingingReplyDirective({
    mode: 'song_only',
    prompt: '流行',
    lyrics: '歌词',
    model: 'forged',
  }), undefined);
  assert.equal(parseSingingReplyDirective({
    mode: 'song_only',
    prompt: '流行',
    lyrics: '歌词',
    voiceProfileId: 'forged',
  }), undefined);
  assert.equal(parseSingingReplyDirective({
    mode: 'song_only',
    prompt: '流行',
    lyrics: '歌词',
    duration_seconds: 5,
  }), undefined);
});

test('歌声回执必须绑定规范请求哈希、Opus、绝对路径和文件哈希', () => {
  const directive = parseSingingReplyDirective({
    mode: 'song_only', prompt: '轻快民谣', lyrics: '你好世界', vocal_language: 'zh', duration_seconds: 10,
  })!;
  const receipt = parseSingingSynthesisReceipt({
    protocol: 'cti-singing-synthesis/v1',
    path: 'C:\\managed\\song.opus',
    mediaType: 'audio/ogg; codecs=opus',
    format: 'opus',
    durationMs: 10_000,
    requestSha256: singingRequestSha256(directive),
    fileSha256: 'a'.repeat(64),
    validated: true,
  }, directive);
  assert.equal(receipt?.protocol, 'cti-singing-synthesis/v1');
  assert.equal(parseSingingSynthesisReceipt({ ...receipt, requestSha256: 'b'.repeat(64) }, directive), null);
  assert.equal(parseSingingSynthesisReceipt({ ...receipt, format: 'wav' }, directive), null);
});
