import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { ManagedSpeechDependencyManager } from '../speech/managed-dependency-manager.js';
import { loadSpeechRuntimeConfig } from '../speech/runtime-config.js';
import type { RuntimeSpeechHost } from '../speech/runtime-speech-host.js';
import { SpeechControlService } from '../speech/speech-control-service.js';
import { SpeechRuntimeStatusService } from '../speech/speech-status.js';
import { DEFAULT_PRESET_PROFILE_ID, SpeechVoiceRegistry } from '../speech/voice-registry.js';

type ObjectSchema = { required?: string[]; properties?: Record<string, unknown> };

function assertObjectShape(value: Record<string, unknown>, schema: ObjectSchema): void {
  for (const field of schema.required || []) assert.ok(Object.hasOwn(value, field), `缺少 schema 必填字段 ${field}`);
  for (const field of Object.keys(value)) assert.ok(Object.hasOwn(schema.properties || {}, field), `出现 schema 未声明字段 ${field}`);
}

function fakeHost(ttsReady: boolean): RuntimeSpeechHost {
  const readyDependency = (id: string) => ({ id, displayName: id, state: 'ready' as const, path: `C:\\fake\\${id}.exe` });
  return {
    getDependencySnapshot: () => ({
      ffmpeg: readyDependency('ffmpeg'), ffprobe: readyDependency('ffprobe'),
      python: readyDependency('python'), sidecar: readyDependency('sidecar'),
    }),
    sidecar: {
      ensureClient: async () => ({
        health: async () => ({
          protocol: 'cti-speech-sidecar/v1' as const,
          status: ttsReady ? 'ready' as const : 'optional_missing' as const,
          version: 'test', capabilities: { asr: false, tts: ttsReady },
          ...(ttsReady ? {} : { diagnosticCode: 'cosyvoice_dependency_missing' }),
        }),
      }),
    },
  } as unknown as RuntimeSpeechHost;
}

describe('speech status and control actions', () => {
  it('never promotes ASR to ready from an installed model when the runtime capability is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-status-asr-'));
    try {
      const config = loadSpeechRuntimeConfig(new Map([['CTI_SPEECH_INPUT_ENABLED', 'true']]));
      const status = new SpeechRuntimeStatusService({
        config, host: fakeHost(false), voiceRegistry: new SpeechVoiceRegistry(path.join(root, 'voices')),
        listManagedComponents: () => [{
          id: 'sensevoice_gguf', displayName: 'SenseVoice Q8', kind: 'model', state: 'ready',
          capabilities: ['asr'], installable: false,
        }, {
          id: 'sensevoice_runtime', displayName: 'SenseVoice Runtime', kind: 'binary', state: 'optional_missing',
          capabilities: ['asr_runtime'], diagnosticCode: 'component_not_installed', installable: true,
        }],
      });
      const value = await status.refresh();
      assert.notEqual(value.asrProvider.options[0]?.state, 'ready');
      // enabled 表示配置项可选择；真实可用性必须由 state/capability 表达。
      assert.equal(value.asrProvider.options[0]?.enabled, true);
      assert.notEqual(value.state, 'ready');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not enable preset installation merely because an unrelated component is installable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-status-blocked-'));
    try {
      const config = loadSpeechRuntimeConfig(new Map([['CTI_SPEECH_OUTPUT_ENABLED', 'true']]));
      const registry = new SpeechVoiceRegistry(path.join(root, 'voices'));
      const status = new SpeechRuntimeStatusService({
        config, host: fakeHost(false), voiceRegistry: registry,
        listManagedComponents: () => [{
          id: 'other_component', displayName: '其他组件', kind: 'binary', state: 'optional_missing',
          capabilities: ['asr'], diagnosticCode: 'component_not_installed', installable: true,
        }],
      });
      const value = await status.refresh();
      assert.equal(value.actions.find((item) => item.id === 'speech.installComponent')?.enabled, true);
      assert.equal(value.actions.find((item) => item.id === 'speech.installPresetVoice')?.enabled, false);
      assert.equal(value.actions.find((item) => item.id === 'speech.previewVoice')?.diagnosticCode, 'cosyvoice_dependency_missing');
      const preset = value.voiceProfiles.find((item) => item.id === DEFAULT_PRESET_PROFILE_ID);
      assert.ok(preset, '未注册 preset 仍需投影为可见 catalog 卡片');
      assert.notEqual(preset.state, 'ready');
      assert.equal(value.components.find((item) => item.id === 'ffmpeg')?.installable, false);
      assert.equal(value.components.find((item) => item.id === 'other_component')?.installable, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('registers the built-in preset only after a real TTS probe and keeps preview blocked', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-status-ready-'));
    try {
      const config = loadSpeechRuntimeConfig(new Map([['CTI_SPEECH_OUTPUT_ENABLED', 'true']]));
      const registry = new SpeechVoiceRegistry(path.join(root, 'voices'));
      const status = new SpeechRuntimeStatusService({ config, host: fakeHost(true), voiceRegistry: registry });
      const before = await status.refresh();
      assert.equal(before.actions.find((item) => item.id === 'speech.installPresetVoice')?.enabled, true);
      assert.equal(before.voiceProfiles.find((item) => item.id === DEFAULT_PRESET_PROFILE_ID)?.state, 'optional_missing');
      assert.equal(before.voiceProfiles.find((item) => item.id === DEFAULT_PRESET_PROFILE_ID)?.diagnosticCode, 'preset_voice_not_registered');
      const service = new SpeechControlService({
        config, status, voiceRegistry: registry,
        dependencies: { install: async () => undefined } as unknown as ManagedSpeechDependencyManager,
        saveConfig: () => undefined,
      });
      const after = await service.execute('speech.installPresetVoice', {});
      assert.equal(after.protocol, 'codex-im-suite/speech-status/v1');
      if (after.protocol !== 'codex-im-suite/speech-status/v1') {
        throw new Error('安装预设音色必须返回语音状态协议');
      }
      assert.equal(registry.resolveProfile(DEFAULT_PRESET_PROFILE_ID).kind, 'preset');
      assert.equal(after.actions.find((item) => item.id === 'speech.installPresetVoice')?.enabled, false);
      assert.equal(after.voiceProfiles.find((item) => item.id === DEFAULT_PRESET_PROFILE_ID)?.state, 'ready');
      await assert.rejects(
        service.execute('speech.previewVoice', {}),
        (error: unknown) => Boolean(error && typeof error === 'object'
          && (error as { code?: string; status?: string }).code === 'speech_preview_live_runtime_unavailable'
          && (error as { status?: string }).status === 'blocked'),
      );

      const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../contracts/schemas/speech.schema.json');
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as { $defs: Record<string, ObjectSchema> };
      assertObjectShape(after as unknown as Record<string, unknown>, schema.$defs.SpeechStatusContract);
      for (const channel of after.channels) assertObjectShape(channel as unknown as Record<string, unknown>, schema.$defs.SpeechChannelContract);
      for (const selection of [after.replyPolicy, after.deliveryMode, after.asrProvider, after.ttsProvider]) {
        assertObjectShape(selection as unknown as Record<string, unknown>, schema.$defs.SpeechSelectionContract);
        for (const option of selection.options) assertObjectShape(option as unknown as Record<string, unknown>, schema.$defs.SpeechSelectionOptionContract);
      }
      for (const action of after.actions) assertObjectShape(action as unknown as Record<string, unknown>, schema.$defs.SpeechActionContract);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
