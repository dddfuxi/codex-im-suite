import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SPEECH_SETTINGS_SCHEMA,
  SPEECH_STATUS_PROTOCOL,
  type SpeechPanelStateContract,
  type SpeechSettingsContract,
} from '../speech-contract.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('speech shared contract', () => {
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
      'deliveryMode', 'asrProvider', 'ttsProvider', 'ttsModel', 'tonePolicy', 'singingProvider', 'activeVoiceProfileId', 'activeSingingVoiceProfileId', 'capabilities',
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
