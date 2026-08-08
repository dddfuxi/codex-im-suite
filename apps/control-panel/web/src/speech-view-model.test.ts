import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SpeechPanelStateContract, SpeechStatusContract } from '@codex-im-suite/contracts/speech';
import {
  canImportSpeechReferenceVoice,
  canInstallSpeechComponent,
  canSaveSpeechSettings,
  createSpeechSettingsDraft,
  decodeSpeechPreviewReceipt,
  describeSpeechDisplayState,
  getSpeechAction,
  getSpeechCommandNotice,
  getSpeechPanelDiagnostic,
  updateSpeechChannelIds,
} from './speech-view-model.js';

const readyStatus: SpeechStatusContract = {
  protocol: 'codex-im-suite/speech-status/v2',
  state: 'ready',
  inputEnabled: true,
  outputEnabled: true,
  singingEnabled: false,
  channels: [{ id: 'feishu', displayName: '飞书', state: 'ready', enabled: true, inputSupported: true, outputSupported: true, selected: true }],
  replyPolicy: { value: 'on', options: [{ id: 'on', displayName: '开启', state: 'ready', enabled: true }] },
  deliveryMode: { value: 'voice_only', options: [{ id: 'voice_only', displayName: '仅语音', state: 'ready', enabled: true }] },
  asrProvider: { value: 'asr-a', options: [{ id: 'asr-a', displayName: 'ASR A', state: 'ready', enabled: true }] },
  ttsProvider: { value: 'tts-a', options: [{ id: 'tts-a', displayName: 'TTS A', state: 'ready', enabled: true }] },
  ttsModel: {
    value: 'model-a', liveValue: 'model-a', restartRequired: false,
    options: [{
      id: 'model-a', displayName: '模型 A', state: 'ready', enabled: true, providerId: 'tts-a',
      variant: 'custom_voice', sizeLabel: '1.7B', componentId: 'model-a',
      capabilities: ['preset_voice', 'instruction_control'], defaultVoiceProfileId: 'voice-a',
      benchmark: { state: 'ready', revision: 'a'.repeat(64) },
    }],
  },
  tonePolicy: { value: 'adaptive_natural', options: [{ id: 'adaptive_natural', displayName: '自适应', state: 'ready', enabled: true }] },
  singingProvider: { value: 'singing-a', options: [{ id: 'singing-a', displayName: '歌声 A', state: 'blocked', enabled: true }] },
  singingBenchmark: { state: 'optional_missing', revision: 'uninstalled', diagnosticCode: 'singing_benchmark_not_verified' },
  activeVoiceProfileId: 'voice-a',
  activeSingingVoiceProfileId: '',
  capabilities: [],
  components: [],
  voiceProfiles: [{ id: 'voice-a', displayName: '音色 A', kind: 'preset', state: 'ready', active: true, license: '内置', sourceLabel: 'Runtime', authorizationConfirmed: true, capabilities: ['speech'], compatibleTtsModelIds: ['model-a'] }],
  limits: { maxInputBytes: 1024, maxInputDurationSeconds: 60, maxOutputCharacters: 500, maxPreviewCharacters: 240, maxSongDurationSeconds: 60 },
  actions: [{ id: 'speech.previewVoice', label: '试听', enabled: true }],
  lastCheckedAt: '2026-08-07T00:00:00.000Z',
};

describe('speech view model', () => {
  it('shows unavailable without inventing a SpeechStatus', () => {
    const panel: SpeechPanelStateContract = { available: false, unavailableCode: 'speech_cli_missing', status: null };
    assert.equal(describeSpeechDisplayState(panel).label, 'unavailable');
    assert.equal(getSpeechPanelDiagnostic(panel), 'speech_cli_missing');
  });

  it('builds settings only from Runtime-declared opaque ids', () => {
    const status: SpeechStatusContract = {
      ...readyStatus,
      channels: [
        ...readyStatus.channels,
        { id: 'channel-b', displayName: '渠道 B', state: 'ready', enabled: true, inputSupported: true, outputSupported: false, selected: true },
      ],
    };
    const draft = createSpeechSettingsDraft(status);
    assert.deepEqual(draft.channelIds, ['feishu', 'channel-b']);
    assert.deepEqual(updateSpeechChannelIds(draft.channelIds, 'feishu', false), ['channel-b']);
    assert.deepEqual(updateSpeechChannelIds(draft.channelIds, 'channel-c', true), ['feishu', 'channel-b', 'channel-c']);
    assert.deepEqual(updateSpeechChannelIds(draft.channelIds, 'channel-b', true), ['feishu', 'channel-b']);
    assert.equal(canSaveSpeechSettings(status, draft), true);
    assert.equal(canSaveSpeechSettings(status, { ...draft, ttsProvider: 'invented-provider' }), false);
  });

  it('fails closed when an action was not declared by Runtime', () => {
    assert.equal(getSpeechAction(readyStatus, 'speech.previewVoice').enabled, true);
    assert.deepEqual(getSpeechAction(readyStatus, 'speech.installComponent'), {
      id: 'speech.installComponent',
      label: 'speech.installComponent',
      enabled: false,
      diagnosticCode: 'speech_action_unavailable',
    });
  });

  it('only allows installation for a component with a real managed installer', () => {
    const action = { id: 'speech.installComponent', label: '安装组件', enabled: true };
    const base = {
      id: 'component-a',
      displayName: '组件 A',
      kind: 'model',
      state: 'optional_missing' as const,
      installable: true,
      capabilities: ['asr'],
    };
    assert.equal(canInstallSpeechComponent(base, action), true);
    assert.equal(canInstallSpeechComponent({ ...base, installable: false }, action), false);
    assert.equal(canInstallSpeechComponent({ ...base, state: 'ready' }, action), false);
    assert.equal(canInstallSpeechComponent(base, { ...action, enabled: false }), false);
  });

  it('requires both authorization and clean single-speaker confirmation before reference import', () => {
    const draft = {
      displayName: '授权音色',
      transcript: '这是一段准确转写。',
      sourceLabel: '用户本人录音',
      license: '本人授权',
      authorizationConfirmed: true,
      cleanSingleSpeakerConfirmed: true,
    };
    assert.equal(canImportSpeechReferenceVoice(draft), true);
    assert.equal(canImportSpeechReferenceVoice({ ...draft, authorizationConfirmed: false }), false);
    assert.equal(canImportSpeechReferenceVoice({ ...draft, cleanSingleSpeakerConfirmed: false }), false);
    assert.equal(canImportSpeechReferenceVoice({ ...draft, transcript: '   ' }), false);
  });

  it('does not claim live speech settings applied before a controlled Bridge restart', () => {
    assert.match(getSpeechCommandNotice({ restartRequired: true }), /重启 Bridge/u);
    assert.equal(getSpeechCommandNotice({ restartRequired: false, notice: '不应显示' }), '');
    assert.equal(getSpeechCommandNotice(null), '');
  });

  it('only decodes the exact validated Ogg preview projection', () => {
    const base = {
      protocol: 'codex-im-suite/speech-preview/v2',
      mediaType: 'audio/ogg; codecs=opus',
      base64: Buffer.from('OggS-safe-preview', 'ascii').toString('base64'),
      bytes: Buffer.byteLength('OggS-safe-preview', 'ascii'),
      sha256: 'a'.repeat(64),
      durationMs: 1000,
      modelId: 'model-a',
      voiceProfileId: 'acestep.default',
      validated: true,
    };
    assert.equal(decodeSpeechPreviewReceipt(base).media.byteLength, base.bytes);
    assert.throws(() => decodeSpeechPreviewReceipt({ ...base, path: 'C:/unsafe.ogg' }), /speech_preview_response_invalid/u);
    const badHeader = Buffer.from('RIFF-not-ogg-data', 'ascii');
    assert.throws(() => decodeSpeechPreviewReceipt({
      ...base,
      base64: badHeader.toString('base64'),
      bytes: badHeader.length,
    }), /speech_preview_response_invalid/u);
  });
});
