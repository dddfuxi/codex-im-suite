import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { hashFileSha256 } from '../speech/media-pipeline.js';
import { loadSpeechRuntimeConfig } from '../speech/runtime-config.js';
import { createSpeechRuntime } from '../speech/speech-runtime.js';
import { DEFAULT_PRESET_PROFILE_ID, SpeechVoiceRegistry } from '../speech/voice-registry.js';

function writeMinimalWav(filePath: string): void {
  const bytes = Buffer.alloc(44);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(0, 40);
  fs.writeFileSync(filePath, bytes);
}

describe('speech voice registry', () => {
  it('stores the registry only under CTI_HOME runtime/speech/voices', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-speech-runtime-root-'));
    const ctiHome = path.join(root, 'cti-home');
    const skillRoot = path.join(root, 'skill');
    const manifestDir = path.join(skillRoot, 'src', 'speech');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'managed-dependencies.json'), JSON.stringify({
      protocol: 'cti-speech-managed-dependencies/v1', components: [],
    }), 'utf8');
    try {
      const runtime = createSpeechRuntime({ config: loadSpeechRuntimeConfig(new Map()), ctiHome, skillRoot });
      assert.equal(runtime.voiceRegistry.root, path.join(ctiHome, 'runtime', 'speech', 'voices'));
      assert.equal(runtime.voiceRegistry.root.includes(`${path.sep}data${path.sep}`), false);
      await runtime.host.stop();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires explicit authorization before importing a reference voice', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-voice-registry-'));
    const source = path.join(root, 'source.wav');
    writeMinimalWav(source);
    try {
      const registry = new SpeechVoiceRegistry(path.join(root, 'registry'), undefined, async (sourcePath) => ({
        format: 'wav', durationMs: 5_000, sha256: hashFileSha256(sourcePath),
      }));
      await assert.rejects(registry.importReferenceVoice({
        sourcePath: source,
        displayName: '测试音色',
        transcript: '测试文本',
        sourceLabel: '用户导入',
        license: '用户已授权',
        authorizationConfirmed: false,
        cleanSingleSpeakerConfirmed: true,
      }), /voice_authorization_required/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stores only a relative managed path and keeps sensitive evidence out of summaries', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-voice-registry-'));
    const source = path.join(root, 'source.wav');
    writeMinimalWav(source);
    try {
      const registry = new SpeechVoiceRegistry(path.join(root, 'registry'), undefined, async (sourcePath) => ({
        format: 'wav', durationMs: 5_000, sha256: hashFileSha256(sourcePath),
      }));
      const profile = await registry.importReferenceVoice({
        sourcePath: source,
        displayName: '测试音色',
        transcript: '仅保存在注册表内部的转写',
        sourceLabel: '用户导入',
        license: '用户已授权',
        authorizationConfirmed: true,
        cleanSingleSpeakerConfirmed: true,
      });
      assert.equal(path.isAbsolute(profile.relativePath!), false);
      assert.match(profile.sha256!, /^[a-f0-9]{64}$/);
      const raw = fs.readFileSync(registry.registryPath, 'utf8');
      assert.equal(raw.includes(source), false);
      const summary = registry.listSummaries(profile.id)
        .find((item) => item.id === profile.id) as unknown as Record<string, unknown>;
      assert.equal(summary.active, true);
      assert.equal('transcript' in summary, false);
      assert.equal('sha256' in summary, false);
      assert.equal('relativePath' in summary, false);
      assert.equal('source' in summary, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a reference voice that was modified after import', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-voice-tamper-'));
    const source = path.join(root, 'source.wav');
    writeMinimalWav(source);
    try {
      const registry = new SpeechVoiceRegistry(path.join(root, 'registry'), undefined, async (sourcePath) => ({
        format: 'wav', durationMs: 5_000, sha256: hashFileSha256(sourcePath),
      }));
      const profile = await registry.importReferenceVoice({
        sourcePath: source,
        displayName: '防篡改音色',
        transcript: '参考文本',
        sourceLabel: '用户导入',
        license: '用户已授权',
        authorizationConfirmed: true,
        cleanSingleSpeakerConfirmed: true,
      });
      const managedPath = registry.resolveProfilePath(profile);
      fs.appendFileSync(managedPath, 'tampered', 'utf8');

      assert.throws(() => registry.resolveProfile(profile.id), /voice_reference_sha256_mismatch/);
      assert.equal(registry.listSummaries(profile.id).find((item) => item.id === profile.id)?.state, 'blocked');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a built-in SFT preset virtual instead of converting it to a reference profile', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-voice-registry-'));
    try {
      const registry = new SpeechVoiceRegistry(path.join(root, 'registry'));
      const profile = registry.registerPreset({
        id: DEFAULT_PRESET_PROFILE_ID,
        displayName: '内置中文女声',
        presetSpeakerId: DEFAULT_PRESET_PROFILE_ID,
        sourceLabel: 'CosyVoice 官方 SFT',
        license: 'Apache-2.0',
      });
      assert.equal(profile.kind, 'preset');
      assert.equal(profile.relativePath, undefined);
      assert.deepEqual(registry.resolveProfile(profile.id), {
        kind: 'preset',
        presetSpeakerId: DEFAULT_PRESET_PROFILE_ID,
        compatibleTtsModelIds: ['cosyvoice-300m-sft'],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts only inclusive 3-30 second reference audio boundaries', async () => {
    for (const [durationMs, accepted] of [[2_900, false], [3_000, true], [30_000, true], [30_100, false]] as const) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-voice-duration-'));
      const source = path.join(root, 'source.wav');
      writeMinimalWav(source);
      try {
        const registry = new SpeechVoiceRegistry(path.join(root, 'registry'), undefined, async (sourcePath) => ({
          format: 'wav', durationMs, sha256: hashFileSha256(sourcePath),
        }));
        const operation = registry.importReferenceVoice({
          sourcePath: source,
          displayName: `边界-${durationMs}`,
          transcript: '参考文本',
          sourceLabel: '用户导入',
          license: '用户已授权',
          authorizationConfirmed: true,
          cleanSingleSpeakerConfirmed: true,
        });
        if (accepted) assert.equal((await operation).kind, 'reference');
        else await assert.rejects(operation, /voice_duration_out_of_range/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
