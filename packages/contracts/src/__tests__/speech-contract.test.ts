import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SPEECH_SETTINGS_SCHEMA,
  SPEECH_STATUS_PROTOCOL,
  createSingingAudioContentPlan,
  type SpeechPanelStateContract,
  type SpeechSettingsContract,
} from '../speech-contract.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('speech shared contract', () => {
  it('快速试听按可演唱正文而非段落标记截取歌词', () => {
    const quick = createSingingAudioContentPlan({
      outputMode: 'quick_preview',
      lyrics: '[Verse]\n第一句要唱清楚，第二句也要完整唱出。',
      stylePrompt: '清晰中文流行演唱',
      vocalLanguage: 'zh',
    });
    const full = createSingingAudioContentPlan({
      outputMode: 'full_generation',
      lyrics: '[Verse]\n第一句要唱清楚，第二句也要完整唱出。',
      stylePrompt: '清晰中文流行演唱',
      vocalLanguage: 'zh',
    });

    assert.ok(quick);
    assert.ok(full);
    assert.equal(quick.lyrics.startsWith('[Verse]'), false);
    assert.equal(quick.lyrics.startsWith('第一句'), true);
    assert.equal(full.lyrics.startsWith('[Verse]'), true);
  });

  it('keeps protocol identifiers and unavailable state explicit', () => {
    const unavailable: SpeechPanelStateContract = {
      available: false,
      unavailableCode: 'speech_runtime_unavailable',
      status: null,
    };
    const settings: SpeechSettingsContract = {
      schema: SPEECH_SETTINGS_SCHEMA,
      inputEnabled: true,
      outputEnabled: true,
      singingEnabled: false,
      channelIds: ['runtime-channel'],
      replyPolicy: 'runtime-policy',
      deliveryMode: 'runtime-delivery',
      asrProvider: 'runtime-asr',
      ttsProvider: 'runtime-tts',
      ttsModelId: 'runtime-model',
      tonePolicy: 'adaptive-natural',
      singingProvider: 'runtime-singing',
      activeVoiceProfileId: 'runtime-profile',
      activeSingingVoiceProfileId: '',
    };

    assert.equal(SPEECH_STATUS_PROTOCOL, 'codex-im-suite/speech-status/v2');
    assert.equal(settings.schema, 'codex-im-suite/speech-settings/v2');
    assert.equal(unavailable.status, null);
  });

  it('publishes the versioned speech schema with privacy-safe fields', () => {
    const schemaPath = path.join(packageRoot, 'schemas', 'speech.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as {
      $id?: string;
      $defs?: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
    };

    assert.equal(schema.$id, 'https://codex-im-suite.local/schemas/speech.schema.json');
    assert.deepEqual(schema.$defs?.SpeechStatusContract?.required, [
      'protocol', 'state', 'inputEnabled', 'outputEnabled', 'singingEnabled', 'channels', 'replyPolicy',
      'deliveryMode', 'asrProvider', 'ttsProvider', 'ttsModel', 'tonePolicy', 'singingProvider', 'singingBenchmark', 'activeVoiceProfileId', 'activeSingingVoiceProfileId', 'providers', 'capabilities',
      'components', 'voiceProfiles', 'limits', 'actions', 'lastCheckedAt',
    ]);
    const statusFields = Object.keys(schema.$defs?.SpeechStatusContract?.properties ?? {});
    for (const forbidden of ['path', 'sourcePath', 'referenceAudio', 'transcript', 'apiKey', 'error']) {
      assert.equal(statusFields.includes(forbidden), false, `SpeechStatus 不应暴露 ${forbidden}`);
    }
    assert.deepEqual(schema.$defs?.SpeechComponentContract?.required, [
      'id', 'displayName', 'kind', 'state', 'installable', 'capabilities',
    ]);
    assert.deepEqual(schema.$defs?.SpeechComponentContract?.properties?.installable, { type: 'boolean' });
    assert.deepEqual(schema.$defs?.SpeechModelSelectionContract?.required, [
      'value', 'liveValue', 'restartRequired', 'options',
    ]);
  });
});
