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

  it('persists imported reference voices across registry instances and deletes their managed files on request', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-voice-persistent-delete-'));
    const source = path.join(root, 'source.wav');
    const registryRoot = path.join(root, 'registry');
    writeMinimalWav(source);
    try {
      const first = new SpeechVoiceRegistry(registryRoot, undefined, async (sourcePath) => ({
        format: 'wav', durationMs: 5_000, sha256: hashFileSha256(sourcePath),
      }));
      const imported = await first.importReferenceVoice({
        sourcePath: source,
        displayName: '长期保存音色',
        transcript: '参考文本',
        sourceLabel: '用户导入',
        license: '用户已授权',
        authorizationConfirmed: true,
        cleanSingleSpeakerConfirmed: true,
      });
      const managedPath = first.resolveProfilePath(imported);

      const afterRestart = new SpeechVoiceRegistry(registryRoot);
      assert.equal(afterRestart.listSummaries().some((item) => item.id === imported.id), true);
      assert.equal(fs.existsSync(managedPath), true);
      assert.equal(afterRestart.deleteReferenceVoice(imported.id).kind, 'reference');
      assert.equal(afterRestart.list().some((item) => item.id === imported.id), false);
      assert.equal(fs.existsSync(managedPath), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('never deletes preset voices through the reference voice deletion API', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-voice-preset-delete-'));
    try {
      const registry = new SpeechVoiceRegistry(path.join(root, 'registry'));
      assert.throws(() => registry.deleteReferenceVoice('qwen3.serena'), /voice_preset_delete_forbidden/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('renames only persistent reference voices without changing their stable identity or managed audio', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-voice-persistent-rename-'));
    const source = path.join(root, 'source.wav');
    writeMinimalWav(source);
    try {
      const registry = new SpeechVoiceRegistry(path.join(root, 'registry'), undefined, async (sourcePath) => ({
        format: 'wav', durationMs: 5_000, sha256: hashFileSha256(sourcePath),
      }));
      const imported = await registry.importReferenceVoice({
        sourcePath: source,
        displayName: '原始名称',
        transcript: '参考文本',
        sourceLabel: '用户导入',
        license: '用户已授权',
        authorizationConfirmed: true,
        cleanSingleSpeakerConfirmed: true,
      });
      const managedPath = registry.resolveProfilePath(imported);
      const renamed = registry.renameReferenceVoice(imported.id, '新的克隆音色');

      assert.equal(renamed.id, imported.id);
      assert.equal(renamed.sha256, imported.sha256);
      assert.equal(renamed.displayName, '新的克隆音色');
      assert.equal(registry.resolveProfilePath(renamed), managedPath);
      assert.equal(fs.existsSync(managedPath), true);
      assert.equal(new SpeechVoiceRegistry(path.join(root, 'registry')).list().find((item) => item.id === imported.id)?.displayName, '新的克隆音色');
      assert.throws(() => registry.renameReferenceVoice('qwen3.serena', '不能改预设'), /voice_preset_rename_forbidden/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects empty, overlong and conflicting reference voice display names', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-voice-rename-validation-'));
    const firstSource = path.join(root, 'first.wav');
    const secondSource = path.join(root, 'second.wav');
    writeMinimalWav(firstSource);
    writeMinimalWav(secondSource);
    fs.appendFileSync(secondSource, 'unique', 'utf8');
    try {
      const registry = new SpeechVoiceRegistry(path.join(root, 'registry'), undefined, async (sourcePath) => ({
        format: 'wav', durationMs: 5_000, sha256: hashFileSha256(sourcePath),
      }));
      const first = await registry.importReferenceVoice({
        sourcePath: firstSource, displayName: '音色甲', transcript: '甲', sourceLabel: '用户导入', license: '已授权',
        authorizationConfirmed: true, cleanSingleSpeakerConfirmed: true,
      });
      await registry.importReferenceVoice({
        sourcePath: secondSource, displayName: '音色乙', transcript: '乙', sourceLabel: '用户导入', license: '已授权',
        authorizationConfirmed: true, cleanSingleSpeakerConfirmed: true,
      });
      assert.throws(() => registry.renameReferenceVoice(first.id, ' '), /voice_display_name_invalid/);
      assert.throws(() => registry.renameReferenceVoice(first.id, '甲'.repeat(101)), /voice_display_name_invalid/);
      assert.throws(() => registry.renameReferenceVoice(first.id, '音色乙'), /voice_display_name_conflict/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a panel source changed after live transcript verification', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-voice-verified-hash-'));
    const source = path.join(root, 'source.wav');
    writeMinimalWav(source);
    const verifiedSha256 = hashFileSha256(source);
    fs.appendFileSync(source, 'changed-after-asr', 'utf8');
    try {
      const registry = new SpeechVoiceRegistry(path.join(root, 'registry'), undefined, async (sourcePath) => ({
        format: 'wav', durationMs: 5_000, sha256: hashFileSha256(sourcePath),
      }));
      await assert.rejects(registry.importReferenceVoice({
        sourcePath: source,
        expectedSha256: verifiedSha256,
        displayName: '已变化音色',
        transcript: '参考文本',
        sourceLabel: '用户导入',
        license: '用户已授权',
        authorizationConfirmed: true,
        cleanSingleSpeakerConfirmed: true,
      }), /voice_reference_source_changed_after_transcript_verification/);
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
