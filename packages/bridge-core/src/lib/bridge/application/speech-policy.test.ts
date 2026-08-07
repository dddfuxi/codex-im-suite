import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSpeechTranscriptContext,
  decideSpeechReply,
  evaluateSpeechSynthesisEligibility,
  mergeTranscriptWithUserText,
  parseSpeechReplyDirective,
  parseSpeechSynthesisReceipt,
  parseSpeechTranscriptReceipt,
  resolveTrustedInboundAudio,
  speechFailureMessage,
} from './speech-policy.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

test('ASR 只接受当前飞书 audio 事件签发且唯一绑定的附件', () => {
  const attachment = {
    id: 'audio-1',
    name: 'voice.opus',
    type: 'audio/ogg',
    size: 128,
    data: '',
    filePath: 'C:\\managed\\voice.opus',
  };
  const raw = {
    feishuInboundAudio: {
      protocol: 'cti-feishu-inbound-audio/v1',
      messageId: 'msg-1',
      fileKey: 'file-1',
      attachmentId: 'audio-1',
      messageType: 'audio',
    },
  };
  assert.equal(resolveTrustedInboundAudio({
    channelType: 'feishu',
    sourceMessageId: 'msg-1',
    raw,
    attachments: [attachment],
  })?.attachment.id, 'audio-1');
  assert.equal(resolveTrustedInboundAudio({
    channelType: 'feishu',
    sourceMessageId: 'other-message',
    raw,
    attachments: [attachment],
  }), null);
  assert.equal(resolveTrustedInboundAudio({
    channelType: 'feishu',
    sourceMessageId: 'msg-1',
    raw,
    attachments: [attachment, { ...attachment }],
  }), null);
  assert.equal(resolveTrustedInboundAudio({
    channelType: 'discord',
    sourceMessageId: 'msg-1',
    raw,
    attachments: [attachment],
  }), null);
});

test('转写回执必须绑定同一 attachmentId、sourceMessageId 与受管文件 SHA-256', () => {
  const rawReceipt = {
    protocol: 'cti-speech-transcript/v1',
    attachmentId: 'audio-1',
    sourceMessageId: 'msg-1',
    text: '  帮我总结今天的会议  ',
    model: 'sense-voice-small-q8',
    language: 'zh',
    durationMs: 2_000,
    fileSha256: HASH_A,
    validated: true,
  };
  const expected = { attachmentId: 'audio-1', sourceMessageId: 'msg-1', fileSha256: HASH_A };
  const receipt = parseSpeechTranscriptReceipt(rawReceipt, expected);
  assert.equal(receipt?.text, '帮我总结今天的会议');
  assert.match(buildSpeechTranscriptContext(receipt!), /cti-speech-transcript\/v1/u);
  assert.match(buildSpeechTranscriptContext(receipt!), /sense-voice-small-q8/u);
  assert.match(buildSpeechTranscriptContext(receipt!), /"language":"zh"/u);
  assert.match(buildSpeechTranscriptContext(receipt!), new RegExp(HASH_A, 'u'));
  assert.equal(mergeTranscriptWithUserText(receipt!.text, ''), '帮我总结今天的会议');
  assert.match(mergeTranscriptWithUserText(receipt!.text, '控制在三句话'), /用户随语音附言：控制在三句话/u);
  assert.equal(parseSpeechTranscriptReceipt({ ...rawReceipt, sourceMessageId: 'forged' }, expected), null);
  assert.equal(parseSpeechTranscriptReceipt(rawReceipt, { ...expected, fileSha256: HASH_B }), null);
  assert.equal(parseSpeechTranscriptReceipt({ ...rawReceipt, model: '' }, expected), null);
  assert.equal(parseSpeechTranscriptReceipt({ ...rawReceipt, language: undefined }, expected), null);
  assert.equal(parseSpeechTranscriptReceipt({ ...rawReceipt, language: '' }, expected), null);
  assert.equal(parseSpeechTranscriptReceipt({ ...rawReceipt, language: 'zh/../../model' }, expected), null);
  assert.equal(parseSpeechTranscriptReceipt({ ...rawReceipt, fileSha256: undefined }, expected), null);
});

test('TTS 只接受可由单一语音完整替代的纯文本结果，并返回稳定阻断原因', () => {
  assert.deepEqual(evaluateSpeechSynthesisEligibility({ text: '这是可以朗读的结果。' }), {
    eligible: true,
    reason: 'eligible',
  });
  assert.equal(evaluateSpeechSynthesisEligibility({ text: '```ts\nconst value = 1;\n```' }).reason, 'fenced_code');
  assert.equal(evaluateSpeechSynthesisEligibility({ text: '<pre>diagnostic</pre>' }).reason, 'fenced_code');
  assert.equal(evaluateSpeechSynthesisEligibility({ text: '请看图片', imageCount: 1 }).reason, 'image_content');
  assert.equal(evaluateSpeechSynthesisEligibility({ text: '![验收图](result.png)' }).reason, 'image_content');
  assert.equal(evaluateSpeechSynthesisEligibility({ text: '附件见结果', fileCount: 1 }).reason, 'file_content');
  assert.equal(evaluateSpeechSynthesisEligibility({ text: '请选择', hasInteractiveContent: true }).reason, 'interactive_content');
  assert.equal(evaluateSpeechSynthesisEligibility({ text: '请确认', permissionRequested: true }).reason, 'permission_flow');
  assert.equal(evaluateSpeechSynthesisEligibility({ text: '请 @ 对方', mentionCount: 1 }).reason, 'platform_mention');
});

test('语音回复裁决遵循明确文字、会话关闭、明确语音、会话开启、Runtime 策略与默认触发优先级', () => {
  assert.deepEqual(decideSpeechReply({
    userText: '不要发语音，请用文字回答',
    sessionPreference: 'on',
    inboundAudio: true,
    modelDirective: { mode: 'voice_only' },
  }), { mode: 'text', reason: 'explicit_text' });
  assert.deepEqual(decideSpeechReply({
    userText: '请用语音回答',
    sessionPreference: 'off',
    inboundAudio: false,
  }), { mode: 'text', reason: 'session_off' });
  assert.equal(decideSpeechReply({ userText: '继续', sessionPreference: 'off', inboundAudio: true }).mode, 'text');
  assert.equal(decideSpeechReply({
    userText: '继续',
    sessionPreference: 'off',
    inboundAudio: false,
    modelDirective: { mode: 'voice_only' },
  }).mode, 'text');
  assert.equal(decideSpeechReply({ userText: '继续', sessionPreference: null, inboundAudio: true }).mode, 'voice');
  assert.equal(decideSpeechReply({
    userText: '继续',
    sessionPreference: null,
    inboundAudio: false,
    modelDirective: { mode: 'voice_only' },
  }).mode, 'voice');
  assert.deepEqual(decideSpeechReply({
    userText: '继续',
    sessionPreference: null,
    inboundAudio: true,
    replyPolicy: 'explicit_only',
  }), { mode: 'text', reason: 'reply_policy_explicit_only' });
  assert.equal(decideSpeechReply({
    userText: '继续',
    sessionPreference: null,
    inboundAudio: false,
    modelDirective: { mode: 'voice_only' },
    replyPolicy: 'explicit_only',
  }).mode, 'text');
  assert.equal(decideSpeechReply({
    userText: '请用语音回答',
    sessionPreference: null,
    inboundAudio: false,
    replyPolicy: 'explicit_only',
  }).mode, 'voice');
  assert.deepEqual(decideSpeechReply({
    userText: "Please don't send voice; reply in text.",
    sessionPreference: 'on',
    inboundAudio: true,
  }), { mode: 'text', reason: 'explicit_text' });
  assert.deepEqual(decideSpeechReply({
    userText: 'Please reply by voice.',
    sessionPreference: null,
    inboundAudio: false,
  }), { mode: 'voice', reason: 'explicit_voice' });
  assert.equal(decideSpeechReply({
    userText: '继续',
    sessionPreference: 'on',
    inboundAudio: false,
    replyPolicy: 'explicit_only',
  }).mode, 'voice');
});

test('模型 speech 对象只允许唯一 mode 字段，出现执行字段时整段拒绝', () => {
  assert.deepEqual(parseSpeechReplyDirective({ mode: 'voice_only' }), { mode: 'voice_only' });
  assert.equal(parseSpeechReplyDirective({
    mode: 'voice_only',
    provider: 'forged',
    path: 'C:\\forged.opus',
    voiceProfileId: 'forged',
    file_key: 'forged',
  }), undefined);
  assert.equal(parseSpeechReplyDirective({ mode: 'voice_and_text' }), undefined);
});

test('TTS 回执只接受绝对路径、Opus、正时长和完整哈希', () => {
  const receipt = parseSpeechSynthesisReceipt({
    protocol: 'cti-speech-synthesis/v1',
    path: 'C:\\managed\\reply.opus',
    mediaType: 'audio/ogg',
    format: 'opus',
    durationMs: 1_200,
    textSha256: HASH_A,
    fileSha256: HASH_B,
    validated: true,
  });
  assert.equal(receipt?.format, 'opus');
  assert.equal(parseSpeechSynthesisReceipt({ ...receipt, format: 'wav' }), null);
  assert.equal(parseSpeechSynthesisReceipt({ ...receipt, validated: false }), null);
  assert.equal(parseSpeechSynthesisReceipt({ ...receipt, path: 'reply.opus' }), null);
});

test('语音失败只映射稳定、可行动且不泄露内部路径的中文提示', () => {
  assert.match(speechFailureMessage({ errorCode: 'speech_timeout', message: 'C:\\private\\model' }, 'transcribe'), /超时/u);
  assert.match(speechFailureMessage({ errorCode: 'speech_input_unavailable' }, 'transcribe'), /重新发送语音/u);
  assert.match(speechFailureMessage({ code: 'audio_too_large' }, 'transcribe'), /超过/u);
  assert.match(speechFailureMessage({ code: 'audio_too_long' }, 'transcribe'), /分段/u);
  assert.match(speechFailureMessage({ code: 'asr_no_speech' }, 'transcribe'), /没有识别/u);
  assert.match(speechFailureMessage({ code: 'asr_empty_transcript' }, 'transcribe'), /没有识别/u);
  assert.match(speechFailureMessage({ code: 'sensevoice_timeout' }, 'transcribe'), /超时/u);
  assert.match(speechFailureMessage({ code: 'sidecar_request_timeout' }, 'transcribe'), /超时/u);
  assert.match(speechFailureMessage({ code: 'speech_input_disabled' }, 'transcribe'), /尚未就绪/u);
  assert.doesNotMatch(speechFailureMessage({ code: 'speech_timeout', message: 'C:\\private\\model' }, 'transcribe'), /private/u);
  assert.match(speechFailureMessage(new Error('secret'), 'synthesize'), /完整文字/u);
});
