import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  buildSpeechTranscriptContext,
  composeInboundSpeechPlans,
  decideSpeechReply,
  evaluateSpeechSynthesisEligibility,
  mergeTranscriptWithUserText,
  parseSpeechReplyDirective,
  parseSpeechReferenceVoiceAction,
  parseSpeechReferenceVoiceImportReceipt,
  parseSpeechSynthesisIdentity,
  parseSpeechSynthesisReceipt,
  parseSpeechTranscriptReceipt,
  resolveTrustedInboundAudio,
  resolveTrustedNativeReplyAudio,
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
  assert.equal(resolveTrustedInboundAudio({
    channelType: 'feishu',
    sourceMessageId: 'msg-1',
    raw,
    attachments: [{ ...attachment, type: 'application/octet-stream' }],
  }), null);
});

test('回复旧语音只接受当前消息、原生 reply、fileKey 与 reply 附件范围的唯一绑定', () => {
  const attachment = {
    id: 'reply-audio-1',
    name: 'old-voice.ogg',
    type: 'audio/ogg',
    size: 256,
    data: 'b2dn',
  };
  const raw = {
    feishuReplyTo: { messageId: 'old-message', attachmentCount: 1 },
    feishuNativeReplyAttachments: [{
      protocol: 'cti-feishu-native-reply-attachment/v1',
      relation: 'native_reply',
      sourceMessageId: 'new-message',
      messageId: 'old-message',
      fileKey: 'old-file-key',
      resourceType: 'audio',
      attachmentId: 'reply-audio-1',
    }],
  };
  const resolved = resolveTrustedNativeReplyAudio({
    channelType: 'feishu',
    sourceMessageId: 'new-message',
    raw,
    attachments: [attachment],
  });
  assert.equal(resolved?.relation, 'native_reply');
  assert.equal(resolved?.attachment.id, 'reply-audio-1');
  assert.match(buildSpeechTranscriptContext({
    protocol: 'cti-speech-transcript/v1',
    attachmentId: attachment.id,
    relation: 'native_reply',
    requestMessageId: 'new-message',
    text: '旧语音内容',
    model: 'sensevoice',
    language: 'zh',
    sourceMessageId: 'old-message',
    fileSha256: HASH_A,
    validated: true,
  }, { repliedMessageId: 'old-message' }), /"relation":"native_reply"/u);
  assert.equal(resolveTrustedNativeReplyAudio({
    channelType: 'feishu',
    sourceMessageId: 'forged-message',
    raw,
    attachments: [attachment],
  }), null);
  assert.equal(resolveTrustedNativeReplyAudio({
    channelType: 'feishu',
    sourceMessageId: 'new-message',
    raw: { ...raw, feishuReplyTo: { messageId: 'other-message', attachmentCount: 1 } },
    attachments: [attachment],
  }), null);
  assert.equal(resolveTrustedNativeReplyAudio({
    channelType: 'feishu',
    sourceMessageId: 'new-message',
    raw: { ...raw, feishuReplyTo: { messageId: 'old-message', attachmentCount: 0 } },
    attachments: [attachment],
  }), null);
  assert.equal(resolveTrustedNativeReplyAudio({
    channelType: 'feishu',
    sourceMessageId: 'new-message',
    raw,
    attachments: [{ ...attachment, type: 'application/octet-stream' }],
  }), null);
  assert.equal(resolveTrustedNativeReplyAudio({
    channelType: 'feishu',
    sourceMessageId: 'new-message',
    raw: {
      ...raw,
      feishuNativeReplyAttachments: [
        ...raw.feishuNativeReplyAttachments,
        { ...raw.feishuNativeReplyAttachments[0], attachmentId: 'reply-audio-2' },
      ],
    },
    attachments: [attachment, { ...attachment, id: 'reply-audio-2' }],
  }), null);
});

test('当前语音与原生回复语音同时存在时只把当前语音设为 primary', () => {
  const current = {
    attachment: { id: 'current', name: 'current.ogg', type: 'audio/ogg', size: 1, data: 'YQ==' },
    relation: 'current_message' as const,
    evidence: {
      protocol: 'cti-feishu-inbound-audio/v1' as const,
      messageId: 'msg-current',
      fileKey: 'file-current',
      attachmentId: 'current',
      messageType: 'audio' as const,
    },
  };
  const nativeReply = {
    attachment: { id: 'reply', name: 'reply.ogg', type: 'audio/ogg', size: 1, data: 'Yg==' },
    relation: 'native_reply' as const,
    evidence: {
      protocol: 'cti-feishu-native-reply-attachment/v1' as const,
      relation: 'native_reply' as const,
      sourceMessageId: 'msg-current',
      messageId: 'msg-old',
      fileKey: 'file-old',
      resourceType: 'audio' as const,
      attachmentId: 'reply',
    },
  };

  assert.deepEqual(composeInboundSpeechPlans({
    currentClaimed: true,
    nativeReplyClaimed: true,
    current,
    nativeReply,
  }), {
    primary: current,
    contextual: [nativeReply],
  });
  assert.deepEqual(composeInboundSpeechPlans({
    currentClaimed: false,
    nativeReplyClaimed: true,
    current: null,
    nativeReply,
  }), {
    primary: null,
    contextual: [nativeReply],
  });
  assert.equal(composeInboundSpeechPlans({
    currentClaimed: true,
    nativeReplyClaimed: true,
    current: null,
    nativeReply,
  }), null);
  assert.equal(composeInboundSpeechPlans({
    currentClaimed: true,
    nativeReplyClaimed: true,
    current,
    nativeReply: {
      ...nativeReply,
      attachment: current.attachment,
      evidence: { ...nativeReply.evidence, attachmentId: current.evidence.attachmentId },
    },
  }), null);
});

test('转写回执必须绑定同一 attachmentId、sourceMessageId 与受管文件 SHA-256', () => {
  const rawReceipt = {
    protocol: 'cti-speech-transcript/v1',
    attachmentId: 'audio-1',
    relation: 'current_message',
    requestMessageId: 'msg-1',
    sourceMessageId: 'msg-1',
    text: '  帮我总结今天的会议  ',
    model: 'sense-voice-small-q8',
    language: 'zh',
    durationMs: 2_000,
    fileSha256: HASH_A,
    validated: true,
  };
  const expected = {
    attachmentId: 'audio-1',
    relation: 'current_message' as const,
    requestMessageId: 'msg-1',
    sourceMessageId: 'msg-1',
    fileSha256: HASH_A,
  };
  const receipt = parseSpeechTranscriptReceipt(rawReceipt, expected);
  assert.equal(receipt?.text, '帮我总结今天的会议');
  assert.match(buildSpeechTranscriptContext(receipt!), /cti-speech-transcript\/v1/u);
  assert.match(buildSpeechTranscriptContext(receipt!), /sense-voice-small-q8/u);
  assert.match(buildSpeechTranscriptContext(receipt!), /"language":"zh"/u);
  assert.match(buildSpeechTranscriptContext(receipt!), new RegExp(HASH_A, 'u'));
  assert.equal(mergeTranscriptWithUserText(receipt!.text, ''), '帮我总结今天的会议');
  assert.match(mergeTranscriptWithUserText(receipt!.text, '控制在三句话'), /用户随语音附言：控制在三句话/u);
  assert.equal(parseSpeechTranscriptReceipt({ ...rawReceipt, sourceMessageId: 'forged' }, expected), null);
  assert.equal(parseSpeechTranscriptReceipt({ ...rawReceipt, requestMessageId: 'forged' }, expected), null);
  assert.equal(parseSpeechTranscriptReceipt({ ...rawReceipt, relation: 'native_reply' }, expected), null);
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

test('语音回复裁决只接受结构化 intent、会话命令和可信入站音频，不解析自然语言关键词', () => {
  assert.deepEqual(decideSpeechReply({
    sessionPreference: 'on',
    inboundAudio: true,
    modelDirective: { mode: 'voice_only' },
  }), { mode: 'voice', reason: 'model_directive' });
  assert.deepEqual(decideSpeechReply({
    sessionPreference: 'on',
    inboundAudio: true,
    modelDirective: { mode: 'text_only' },
  }), { mode: 'text', reason: 'model_text_directive' });
  assert.deepEqual(decideSpeechReply({
    sessionPreference: 'off',
    inboundAudio: false,
  }), { mode: 'text', reason: 'session_off' });
  assert.equal(decideSpeechReply({ sessionPreference: 'off', inboundAudio: true }).mode, 'text');
  assert.equal(decideSpeechReply({
    sessionPreference: 'off',
    inboundAudio: false,
    modelDirective: { mode: 'voice_only' },
  }).mode, 'text');
  assert.equal(decideSpeechReply({ sessionPreference: null, inboundAudio: true }).mode, 'voice');
  assert.equal(decideSpeechReply({
    sessionPreference: null,
    inboundAudio: false,
    modelDirective: { mode: 'voice_only' },
  }).mode, 'voice');
  assert.deepEqual(decideSpeechReply({
    sessionPreference: null,
    inboundAudio: true,
    replyPolicy: 'explicit_only',
  }), { mode: 'text', reason: 'reply_policy_explicit_only' });
  assert.deepEqual(decideSpeechReply({
    sessionPreference: null,
    inboundAudio: false,
    modelDirective: { mode: 'voice_only' },
    replyPolicy: 'explicit_only',
  }), { mode: 'voice', reason: 'model_directive' });
  assert.deepEqual(decideSpeechReply({
    sessionPreference: null,
    inboundAudio: false,
  }), { mode: 'text', reason: 'default_text' });
  assert.equal(decideSpeechReply({
    sessionPreference: 'on',
    inboundAudio: false,
    replyPolicy: 'explicit_only',
  }).mode, 'voice');
});

test('模型 speech 对象只允许唯一 mode 字段，出现执行字段时整段拒绝', () => {
  assert.deepEqual(parseSpeechReplyDirective({ mode: 'voice_only' }), { mode: 'voice_only' });
  assert.deepEqual(parseSpeechReplyDirective({ mode: 'text_only' }), { mode: 'text_only' });
  assert.equal(parseSpeechReplyDirective({
    mode: 'voice_only',
    provider: 'forged',
    path: 'C:\\forged.opus',
    voiceProfileId: 'forged',
    file_key: 'forged',
  }), undefined);
  assert.equal(parseSpeechReplyDirective({ mode: 'voice_and_text' }), undefined);
  assert.equal(parseSpeechReplyDirective('voice_only'), undefined);
});

test('TTS 身份快照和回执必须精确绑定模型、版本、音色与正文哈希', () => {
  const identity = {
    ttsModelId: 'generic-tts-model',
    modelRevision: 'revision-2026.08',
    voiceProfileId: 'voice.zh.default',
  };
  assert.deepEqual(parseSpeechSynthesisIdentity(identity), identity);
  assert.equal(parseSpeechSynthesisIdentity({ ...identity, provider: 'forged' }), null);
  assert.equal(parseSpeechSynthesisIdentity({ ...identity, modelRevision: '../unsafe' }), null);

  const text = '受身份绑定的语音结果';
  const rawReceipt = {
    protocol: 'cti-speech-synthesis/v1',
    path: 'C:\\managed\\reply.opus',
    mediaType: 'audio/ogg',
    format: 'opus',
    durationMs: 1_200,
    textSha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    fileSha256: HASH_B,
    validated: true,
    ...identity,
  };
  const expected = { text, expectedIdentity: identity };
  const receipt = parseSpeechSynthesisReceipt(rawReceipt, expected);
  assert.equal(receipt?.format, 'opus');
  assert.equal(parseSpeechSynthesisReceipt({ ...rawReceipt, format: 'wav' }, expected), null);
  assert.equal(parseSpeechSynthesisReceipt({ ...rawReceipt, validated: false }, expected), null);
  assert.equal(parseSpeechSynthesisReceipt({ ...rawReceipt, path: 'reply.opus' }, expected), null);
  assert.equal(parseSpeechSynthesisReceipt({ ...rawReceipt, ttsModelId: 'other' }, expected), null);
  assert.equal(parseSpeechSynthesisReceipt({ ...rawReceipt, modelRevision: 'other' }, expected), null);
  assert.equal(parseSpeechSynthesisReceipt({ ...rawReceipt, voiceProfileId: 'other' }, expected), null);
  assert.equal(parseSpeechSynthesisReceipt({ ...rawReceipt, voiceProfileId: undefined }, expected), null);
  assert.equal(parseSpeechSynthesisReceipt(rawReceipt, { ...expected, text: '其它正文' }), null);
  const identityWithoutVoice = { ...identity, voiceProfileId: null };
  assert.deepEqual(parseSpeechSynthesisIdentity(identityWithoutVoice), identityWithoutVoice);
  assert.equal(parseSpeechSynthesisReceipt(
    { ...rawReceipt, voiceProfileId: null },
    { text, expectedIdentity: identityWithoutVoice },
  )?.voiceProfileId, null);
});

test('参考音色动作只接受语义字段，导入回执绑定真实证据与 Bridge 授权时效', () => {
  assert.deepEqual(parseSpeechReferenceVoiceAction({
    action: 'create_reference_voice',
    profile_name: '  我的\n音色  ',
    rights_basis: 'self_or_authorized',
    usage_scope: 'local_tts_only',
    clean_single_speaker_confirmed: true,
  }), {
    action: 'create_reference_voice',
    profileName: '我的 音色',
    rightsBasis: 'self_or_authorized',
    usageScope: 'local_tts_only',
    cleanSingleSpeakerConfirmed: true,
  });
  assert.equal(parseSpeechReferenceVoiceAction({
    action: 'create_reference_voice',
    rights_basis: 'self_or_authorized',
    usage_scope: 'local_tts_only',
  }), undefined);
  assert.equal(parseSpeechReferenceVoiceAction({
    action: 'create_reference_voice',
    rights_basis: 'public_domain',
    usage_scope: 'local_tts_only',
    clean_single_speaker_confirmed: true,
  }), undefined);
  assert.equal(parseSpeechReferenceVoiceAction({
    action: 'create_reference_voice',
    file_key: 'forged',
  }), undefined);
  assert.equal(parseSpeechReferenceVoiceAction({
    action: 'create_reference_voice',
    path: 'C:\\unsafe.wav',
    provider: 'forged',
  }), undefined);

  const expected = {
    requestMessageId: 'om_request',
    sourceMessageId: 'om_source',
    fileKey: 'file-key',
    attachmentId: 'attachment-1',
    fileSha256: HASH_A,
    authorizationExpiresAt: '2026-08-08T02:05:00.000Z',
  };
  const raw = {
    protocol: 'cti-speech-reference-voice-import/v1',
    voiceProfileId: 'voice.reference.1',
    ...expected,
    validated: true,
  };
  assert.equal(parseSpeechReferenceVoiceImportReceipt(raw, expected)?.voiceProfileId, 'voice.reference.1');
  assert.equal(parseSpeechReferenceVoiceImportReceipt({ ...raw, fileKey: 'forged' }, expected), null);
  assert.equal(parseSpeechReferenceVoiceImportReceipt({ ...raw, authorizationExpiresAt: '2026-08-08T03:00:00.000Z' }, expected), null);
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
