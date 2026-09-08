import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseSingingReplyDirective,
  parseSingingSynthesisReceipt,
  singingFailureMessage,
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
    generationStatus: 'generated',
    deliveryStatus: 'not_sent',
    speakerSimilarityStatus: 'not_applicable',
    lyricsAlignmentStatus: 'passed',
    lyricsAlignment: 0.95,
    lyricsAlignmentThreshold: 0.8,
    lyricsAlignmentPassed: true,
  }, directive);
  assert.equal(receipt?.protocol, 'cti-singing-synthesis/v1');
  assert.equal(parseSingingSynthesisReceipt({ ...receipt, requestSha256: 'b'.repeat(64) }, directive), null);
  assert.equal(parseSingingSynthesisReceipt({ ...receipt, format: 'wav' }, directive), null);
  assert.equal(parseSingingSynthesisReceipt({ ...receipt, lyricsAlignmentPassed: false }, directive), null);
});

test('克隆歌声回执必须同时通过说话人相似度和歌词对齐', () => {
  const directive = parseSingingReplyDirective({
    mode: 'song_only', prompt: '自然演唱', lyrics: '逐字唱对', vocal_language: 'zh',
    duration_seconds: 10, voice_requirement: 'active_reference',
  })!;
  const base = {
    protocol: 'cti-singing-synthesis/v1', path: 'C:\\managed\\song.opus',
    mediaType: 'audio/ogg; codecs=opus', format: 'opus', durationMs: 10_000,
    requestSha256: singingRequestSha256(directive), fileSha256: 'a'.repeat(64), validated: true,
    generationStatus: 'generated', deliveryStatus: 'not_sent', voiceProfileId: 'reference.voice',
    speakerSimilarityStatus: 'passed', speakerSimilarity: 0.9, speakerSimilarityThreshold: 0.72,
    speakerSimilarityPassed: true, lyricsAlignmentStatus: 'passed', lyricsAlignment: 0.96,
    lyricsAlignmentThreshold: 0.8, lyricsAlignmentPassed: true,
  };
  assert.ok(parseSingingSynthesisReceipt(base, directive));
  assert.equal(parseSingingSynthesisReceipt({ ...base, speakerSimilarity: 0.6 }, directive), null);
  assert.equal(parseSingingSynthesisReceipt({ ...base, speakerSimilarityStatus: 'not_applicable' }, directive), null);
});

test('歌唱协议仅接受参考音色类别要求，不接受具体音色身份', () => {
  const directive = parseSingingReplyDirective({
    mode: 'song_only', prompt: '低沉男声', lyrics: '认真唱出来', vocal_language: 'zh',
    duration_seconds: 10, voice_requirement: 'active_reference',
  });
  assert.equal(directive?.voiceRequirement, 'active_reference');
  assert.equal(parseSingingReplyDirective({
    mode: 'song_only', prompt: '低沉男声', lyrics: '认真唱出来', vocal_language: 'zh',
    duration_seconds: 10, voice_requirement: 'reference-123',
  }), undefined);
});

test('克隆歌声音色未激活时给出可操作失败，并明确不冒充', () => {
  assert.match(singingFailureMessage({ code: 'singing_reference_voice_not_active' }), /参考歌声音色/u);
  assert.match(singingFailureMessage({ code: 'singing_reference_voice_not_active' }), /不会改用默认歌声冒充/u);
});
