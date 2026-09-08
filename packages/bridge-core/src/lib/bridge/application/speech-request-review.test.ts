import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOwnerAutoAuthorizedReferenceVoiceAction,
  DEFAULT_UNSPECIFIED_SPEECH_MAX_VISIBLE_UNITS,
  expectsReferenceVoiceCreation,
  extractExplicitReferenceTranscript,
  expectsActiveReferenceVoice,
  expectsManagedSpeechProtocol,
  resolveEffectiveSpeechRequest,
  reviewReferenceVoiceCreationProtocol,
  reviewSpeechReplyProtocol,
} from './speech-request-review.js';

function voiceEnvelope(speech: unknown = { mode: 'voice_only' }): string {
  return [
    '```cti-final',
    JSON.stringify({
      kind: 'text',
      text: '大家好，很高兴认识大家。',
      images: [],
      files: [],
      reply_mode: 'plain',
      speech,
    }),
    '```',
  ].join('\n');
}

test('明确语音交付和指定音色说话要求受管协议', () => {
  for (const value of [
    '请发一条语音介绍自己',
    '你直接发个语音，内容是跟小明打招呼',
    '发送一个音频测试',
    '用语音回复我',
    '用音频回复我',
    '刚才的答复没有按语音送达',
    '这次语音回复我还没收到',
    '原生音频消息未发送成功，重新回复',
    '用你刚刚克隆的音色给大家打个招呼',
    '重新用这个声音念一遍',
    'say hello in a voice message',
    'the audio reply was not delivered',
  ]) {
    assert.equal(expectsManagedSpeechProtocol(value), true, value);
  }
});

test('语音成功后的文字跟进仍属于受控呈现协议', () => {
  assert.deepEqual(reviewSpeechReplyProtocol({
    userText: '先发语音，再艾特群里的小明打招呼',
    responseText: voiceEnvelope({ mode: 'voice_only', after_send_text: '小明，刚才那段是给你的问候。' }),
  }), { ok: true });
});

test('能力咨询、故障追问、取消和唱歌不提升为普通语音请求', () => {
  for (const value of [
    '你能发语音吗？',
    '为什么别的窗口没有语音能力',
    '为什么其他会话不发送语音',
    'does another chat support voice messages?',
    '这个音色生成失败了',
    '不要再发语音',
    '唱一首小星星',
  ]) {
    assert.equal(expectsManagedSpeechProtocol(value), false, value);
  }
});

test('只有明确要求克隆或参考音色的语音交付才要求激活参考音色', () => {
  assert.equal(expectsActiveReferenceVoice('用刚克隆的音色打个招呼'), true);
  assert.equal(expectsActiveReferenceVoice('用参考声音念一下这段话'), true);
  assert.equal(expectsActiveReferenceVoice('用 Serena 发一条语音'), false);
  assert.equal(expectsActiveReferenceVoice('为什么克隆音色没有生效'), false);
});

test('明确语音请求缺协议时要求修复，voice off 会保持硬门禁', () => {
  const missing = reviewSpeechReplyProtocol({
    userText: '用刚克隆的音色打个招呼',
    responseText: voiceEnvelope(null),
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.failure.code, 'missing_managed_speech_protocol');
    assert.match(missing.failure.repairInstruction, /current chat\/session lacks speech capability/u);
    assert.match(missing.failure.repairInstruction, new RegExp(String(DEFAULT_UNSPECIFIED_SPEECH_MAX_VISIBLE_UNITS)));
  }

  const missingReferenceRequirement = reviewSpeechReplyProtocol({
    userText: '用刚克隆的音色打个招呼',
    responseText: voiceEnvelope(),
  });
  assert.equal(missingReferenceRequirement.ok, false);
  if (!missingReferenceRequirement.ok) {
    assert.match(missingReferenceRequirement.failure.repairInstruction, /voice_requirement="active_reference"/u);
  }

  assert.deepEqual(reviewSpeechReplyProtocol({
    userText: '用刚克隆的音色打个招呼',
    responseText: voiceEnvelope({ mode: 'voice_only', voice_requirement: 'active_reference' }),
  }), { ok: true });

  assert.deepEqual(reviewSpeechReplyProtocol({
    userText: '用刚克隆的音色打个招呼',
    responseText: voiceEnvelope(null),
    sessionVoiceDisabled: true,
  }), { ok: true });
});

test('飞书回复或引用残留的外层引号不应使明确音频请求退化为文本回复', () => {
  assert.equal(expectsManagedSpeechProtocol('“用音频回复我'), true);
  assert.equal(expectsManagedSpeechProtocol('「请用语音回复」'), true);
});

test('唯一可信原生回复的通用续办文本继承语音协议，但新指令和显式关闭不会继承', () => {
  const originalRequest = '请用刚刚克隆的音色发一条语音，向大家打个招呼。';
  const inherited = resolveEffectiveSpeechRequest({
    currentText: '请处理我在本条飞书话题中回复或引用的消息。',
    trustedNativeReplyText: originalRequest,
  });
  assert.deepEqual(inherited, { userText: originalRequest, inheritedFromTrustedReply: true });

  const mentionOnly = resolveEffectiveSpeechRequest({
    currentText: '',
    trustedNativeReplyText: originalRequest,
  });
  assert.deepEqual(mentionOnly, { userText: originalRequest, inheritedFromTrustedReply: true });

  const optOut = resolveEffectiveSpeechRequest({
    currentText: '不用发语音，改成文字说明。',
    trustedNativeReplyText: originalRequest,
  });
  assert.deepEqual(optOut, { userText: '不用发语音，改成文字说明。', inheritedFromTrustedReply: false });

  const newInstruction = resolveEffectiveSpeechRequest({
    currentText: '把这条内容整理成三点摘要。',
    trustedNativeReplyText: originalRequest,
  });
  assert.deepEqual(newInstruction, { userText: '把这条内容整理成三点摘要。', inheritedFromTrustedReply: false });
});

test('speech 夹带普通 MP3 文件时不能绕过受管原生语音投递', () => {
  const result = reviewSpeechReplyProtocol({
    userText: '发一条语音打个招呼',
    responseText: [
      '```cti-final',
      JSON.stringify({
        kind: 'mixed',
        text: '语音发好了。',
        images: [],
        files: ['greeting.mp3'],
        reply_mode: 'plain',
        speech: { mode: 'voice_only' },
      }),
      '```',
    ].join('\n'),
  });
  assert.equal(result.ok, false);
});

test('未提供正文的短语音请求限制模型自主扩写，可信引用和明确长请求不被误截断', () => {
  const longText = '这是模型自行扩写的长篇内容。'.repeat(8);
  const responseText = [
    '```cti-final',
    JSON.stringify({
      kind: 'text', text: longText, images: [], files: [], reply_mode: 'plain',
      speech: { mode: 'voice_only' },
    }),
    '```',
  ].join('\n');
  const overBudget = reviewSpeechReplyProtocol({ userText: '发个语音', responseText });
  assert.equal(overBudget.ok, false);
  if (!overBudget.ok) {
    assert.equal(overBudget.failure.code, 'speech_default_content_budget_exceeded');
    assert.match(overBudget.failure.repairInstruction, new RegExp(String(DEFAULT_UNSPECIFIED_SPEECH_MAX_VISIBLE_UNITS)));
  }

  assert.deepEqual(reviewSpeechReplyProtocol({
    userText: '把这个用语音读出来',
    responseText,
    hasReferencedContent: true,
  }), { ok: true });
  assert.deepEqual(reviewSpeechReplyProtocol({
    userText: '请用语音完整朗读下面这段我提供的正文：' + '需要原样保留的内容'.repeat(12),
    responseText,
  }), { ok: true });
});

test('参考音色创建意图不依赖固定句子，单独克隆只在可信音频上下文成立', () => {
  for (const value of [
    '把这条录音复刻成我的音色',
    '创建一个参考声音',
    '导入这段语音作为参考音色',
    'clone this voice',
  ]) assert.equal(expectsReferenceVoiceCreation(value), true, value);
  assert.equal(expectsReferenceVoiceCreation('克隆', false), false);
  assert.equal(expectsReferenceVoiceCreation('克隆', true), true);
  assert.equal(expectsReferenceVoiceCreation('不要克隆这个音色', true), false);
  assert.equal(expectsReferenceVoiceCreation('克隆这个 Git 仓库', true), false);
});

test('逐字参考文本只从当前用户显式标签提取', () => {
  assert.equal(
    extractExplicitReferenceTranscript('克隆这条音频。参考文本： “地铁的故事，从这一站开始”'),
    '地铁的故事，从这一站开始',
  );
  assert.equal(extractExplicitReferenceTranscript('ASR 识别成地铁的故事，从这一站开始'), undefined);
  assert.equal(extractExplicitReferenceTranscript('文本逐字正确'), undefined);
});

test('Owner 自动授权不再重复询问权利，省略固定参考文本格式并交由 Runtime 二次核验', () => {
  const missing = reviewReferenceVoiceCreationProtocol({
    userText: '克隆',
    responseText: voiceEnvelope(),
    ownerMessage: true,
    hasTrustedNativeReplyAudio: true,
    ownerSelfVoiceAutoAuthorization: true,
  });
  assert.deepEqual(missing, { ok: true });

  const userText = '请克隆这条录音；参考文本：地铁的故事，从这一站开始';
  assert.deepEqual(reviewReferenceVoiceCreationProtocol({
    userText,
    responseText: voiceEnvelope(),
    ownerMessage: true,
    hasTrustedNativeReplyAudio: true,
    ownerSelfVoiceAutoAuthorization: true,
  }), { ok: true });
  assert.deepEqual(buildOwnerAutoAuthorizedReferenceVoiceAction({
    userText,
    ownerMessage: true,
    hasTrustedNativeReplyAudio: true,
    ownerSelfVoiceAutoAuthorization: true,
  }), {
    action: 'create_reference_voice',
    rightsBasis: 'self_or_authorized',
    usageScope: 'local_tts_only',
    cleanSingleSpeakerConfirmed: true,
    referenceTranscriptSource: 'runtime_revalidated',
    referenceTranscriptConfirmed: true,
  });
});

test('自动授权仍要求唯一 Owner 和可信原生回复音频', () => {
  for (const input of [
    { ownerMessage: false, hasTrustedNativeReplyAudio: true },
    { ownerMessage: true, hasTrustedNativeReplyAudio: false },
  ]) {
    assert.equal(buildOwnerAutoAuthorizedReferenceVoiceAction({
      userText: '创建参考音色；参考文本：测试文本',
      ownerSelfVoiceAutoAuthorization: true,
      ...input,
    }), undefined);
  }
});
