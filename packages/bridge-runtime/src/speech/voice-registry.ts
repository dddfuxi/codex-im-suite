import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { writeUtf8TextAtomic } from '../atomic-text-file.js';
import { assertRegularNonSymlink, ensureNonSymlinkDirectory, isWithinRoot } from './dependency-resolution.js';
import { hashFileSha256, sniffAudioHeader, type AudioFormat } from './media-pipeline.js';
import { SPEECH_MODEL_CATALOG, SPEECH_PRESET_VOICE_CATALOG } from './speech-model-catalog.js';

export const DEFAULT_PRESET_VOICE = Object.freeze({
  id: 'cosyvoice.sft.zh_female',
  displayName: '内置中文女声',
  presetSpeakerId: 'cosyvoice.sft.zh_female',
  sourceLabel: 'CosyVoice 官方 SFT',
  license: 'Apache-2.0',
});
export const DEFAULT_PRESET_PROFILE_ID = DEFAULT_PRESET_VOICE.id;
const ALLOWED_PRESET_SPEAKER_IDS = new Set<string>([
  DEFAULT_PRESET_PROFILE_ID,
  ...SPEECH_PRESET_VOICE_CATALOG.map((item) => item.speakerId),
]);
const REFERENCE_MODEL_IDS = SPEECH_MODEL_CATALOG
  .filter((item) => item.capabilities.includes('voice_clone'))
  .map((item) => item.id);

export interface VoiceProfileRecord {
  id: string;
  displayName: string;
  kind: 'preset' | 'reference';
  relativePath?: string;
  sha256?: string;
  transcript?: string;
  presetSpeakerId?: string;
  source: string;
  sourceLabel: string;
  license: string;
  authorizationConfirmed: true;
  /** Bridge 原生语音导入时保存受控授权与来源绑定；面板摘要不会投影这些字段。 */
  authorization?: {
    kind: 'bridge_owner_native_reply';
    ownerIdHash: string;
    scope: 'local_tts_only';
    authorizedAt: string;
    requestMessageId: string;
    sourceMessageId: string;
    attachmentId: string;
    sourceFileSha256: string;
  };
  compatibleTtsModelIds: string[];
  cleanSingleSpeakerConfirmed?: true;
  createdAt: string;
}

export interface ReferenceVoiceAudioEvidence {
  format: AudioFormat;
  durationMs: number;
  sha256: string;
}

interface VoiceRegistryDocument {
  protocol: 'cti-speech-voice-registry/v2';
  revision: number;
  profiles: VoiceProfileRecord[];
}

export interface ImportReferenceVoiceInput {
  sourcePath: string;
  displayName: string;
  transcript: string;
  sourceLabel: string;
  license: string;
  authorizationConfirmed: boolean;
  cleanSingleSpeakerConfirmed: boolean;
  sourceKind?: 'user_provided' | 'feishu_native_reply';
  authorization?: VoiceProfileRecord['authorization'];
}

const EMPTY_REGISTRY: VoiceRegistryDocument = {
  protocol: 'cti-speech-voice-registry/v2',
  revision: 0,
  profiles: [],
};

function sanitizeText(value: unknown, maxChars: number, field: string): string {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (!text || text.length > maxChars) throw new Error(`voice_${field}_invalid`);
  return text;
}

function extensionFor(format: AudioFormat): string {
  return format === 'm4a' ? '.m4a' : `.${format}`;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class SpeechVoiceRegistry {
  readonly root: string;
  readonly filesRoot: string;
  readonly registryPath: string;
  private readonly lockPath: string;

  constructor(
    root: string,
    private readonly maxBytes = 20 * 1024 * 1024,
    private readonly validateReferenceAudio?: (sourcePath: string) => Promise<ReferenceVoiceAudioEvidence>,
  ) {
    this.root = path.resolve(root);
    this.filesRoot = path.join(this.root, 'files');
    this.registryPath = path.join(this.root, 'voice-registry.json');
    this.lockPath = `${this.registryPath}.lock`;
    ensureNonSymlinkDirectory(this.root);
    ensureNonSymlinkDirectory(this.filesRoot);
  }

  private acquireLock(): number {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const descriptor = fs.openSync(this.lockPath, 'wx', 0o600);
        fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
        return descriptor;
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: string }).code : '';
        if (code !== 'EEXIST') throw error;
        try {
          const stat = fs.lstatSync(this.lockPath);
          const value = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as { pid?: number };
          // 只清理已确认持锁进程不存在的过期普通文件，不能仅凭 mtime 抢锁。
          if (!stat.isSymbolicLink() && stat.isFile() && Date.now() - stat.mtimeMs > 30_000 && !isProcessAlive(Number(value.pid))) {
            fs.unlinkSync(this.lockPath);
            continue;
          }
        } catch {
          // 无法证明锁已失效时继续等待，失败关闭而不是强删。
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      }
    }
    throw new Error('voice_registry_locked');
  }

  private withLock<T>(operation: () => T): T {
    const descriptor = this.acquireLock();
    try { return operation(); } finally {
      fs.closeSync(descriptor);
      try {
        const stat = fs.lstatSync(this.lockPath);
        if (!stat.isSymbolicLink() && stat.isFile()) fs.unlinkSync(this.lockPath);
      } catch {
        // 主事实已原子写入，锁清理失败由下一次持锁检查恢复。
      }
    }
  }

  private readDocument(): VoiceRegistryDocument {
    if (!fs.existsSync(this.registryPath)) return { ...EMPTY_REGISTRY, profiles: [] };
    const stat = fs.lstatSync(this.registryPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('voice_registry_unsafe');
    const parsed = JSON.parse(fs.readFileSync(this.registryPath, 'utf8')) as Partial<VoiceRegistryDocument>;
    if ((parsed.protocol !== EMPTY_REGISTRY.protocol && parsed.protocol !== 'cti-speech-voice-registry/v1')
      || !Number.isInteger(parsed.revision) || !Array.isArray(parsed.profiles)) {
      throw new Error('voice_registry_invalid');
    }
    const ids = new Set<string>();
    const profiles = parsed.profiles.map((item) => this.validateRecord(item));
    for (const profile of profiles) {
      if (ids.has(profile.id)) throw new Error('voice_registry_duplicate_id');
      ids.add(profile.id);
    }
    return { protocol: EMPTY_REGISTRY.protocol, revision: parsed.revision!, profiles };
  }

  private validateRecord(value: unknown): VoiceProfileRecord {
    if (!value || typeof value !== 'object') throw new Error('voice_profile_invalid');
    const item = value as Partial<VoiceProfileRecord>;
    const id = sanitizeText(item.id, 80, 'id');
    if (!/^[a-z0-9][a-z0-9._-]+$/i.test(id)) throw new Error('voice_id_invalid');
    if (item.authorizationConfirmed !== true) throw new Error('voice_authorization_missing');
    const kind = item.kind === 'preset' ? 'preset' : item.kind === 'reference' ? 'reference' : (() => { throw new Error('voice_kind_invalid'); })();
    const base = {
      id,
      displayName: sanitizeText(item.displayName, 100, 'display_name'),
      kind,
      source: sanitizeText(item.source, 200, 'source'),
      sourceLabel: sanitizeText(item.sourceLabel, 100, 'source_label'),
      license: sanitizeText(item.license, 200, 'license'),
      authorizationConfirmed: true as const,
      createdAt: sanitizeText(item.createdAt, 64, 'created_at'),
    };
    if (kind === 'preset') {
      const presetSpeakerId = sanitizeText(item.presetSpeakerId, 80, 'preset_speaker_id');
      if (!ALLOWED_PRESET_SPEAKER_IDS.has(presetSpeakerId)) throw new Error('voice_preset_speaker_invalid');
      const catalogPreset = SPEECH_PRESET_VOICE_CATALOG.find((entry) => entry.speakerId === presetSpeakerId);
      const compatibleTtsModelIds = catalogPreset?.compatibleTtsModelIds
        || (Array.isArray(item.compatibleTtsModelIds) ? item.compatibleTtsModelIds : ['cosyvoice-300m-sft']);
      return { ...base, kind, presetSpeakerId, compatibleTtsModelIds: this.validateCompatibleModels(compatibleTtsModelIds) };
    }
    const relativePath = String(item.relativePath || '').replace(/\\/g, '/');
    if (!relativePath || path.posix.isAbsolute(relativePath) || relativePath.split('/').includes('..')) throw new Error('voice_relative_path_invalid');
    const resolved = path.resolve(this.root, ...relativePath.split('/'));
    if (!isWithinRoot(resolved, this.root)) throw new Error('voice_relative_path_escape');
    if (!/^[a-f0-9]{64}$/.test(String(item.sha256 || ''))) throw new Error('voice_sha256_invalid');
    if (item.cleanSingleSpeakerConfirmed !== true) throw new Error('voice_clean_single_speaker_confirmation_missing');
    let authorization: VoiceProfileRecord['authorization'];
    if (item.authorization !== undefined) {
      const candidate = item.authorization;
      if (!candidate
        || candidate.kind !== 'bridge_owner_native_reply'
        || candidate.scope !== 'local_tts_only'
        || !/^[a-f0-9]{64}$/u.test(candidate.ownerIdHash || '')
        || !Number.isFinite(Date.parse(candidate.authorizedAt || ''))
        || !candidate.requestMessageId?.trim()
        || !candidate.sourceMessageId?.trim()
        || !candidate.attachmentId?.trim()
        || !/^[a-f0-9]{64}$/u.test(candidate.sourceFileSha256 || '')) {
        throw new Error('voice_authorization_metadata_invalid');
      }
      authorization = {
        kind: 'bridge_owner_native_reply',
        ownerIdHash: candidate.ownerIdHash,
        scope: 'local_tts_only',
        authorizedAt: candidate.authorizedAt,
        requestMessageId: sanitizeText(candidate.requestMessageId, 200, 'authorization_request_message_id'),
        sourceMessageId: sanitizeText(candidate.sourceMessageId, 200, 'authorization_source_message_id'),
        attachmentId: sanitizeText(candidate.attachmentId, 200, 'authorization_attachment_id'),
        sourceFileSha256: candidate.sourceFileSha256,
      };
    }
    return {
      ...base,
      kind,
      relativePath,
      sha256: item.sha256!,
      transcript: sanitizeText(item.transcript, 4_000, 'transcript'),
      compatibleTtsModelIds: this.validateCompatibleModels(
        Array.isArray(item.compatibleTtsModelIds) ? item.compatibleTtsModelIds : REFERENCE_MODEL_IDS,
      ),
      cleanSingleSpeakerConfirmed: true,
      ...(authorization ? { authorization } : {}),
    };
  }

  private validateCompatibleModels(values: unknown[]): string[] {
    const known = new Set(SPEECH_MODEL_CATALOG.map((item) => item.id));
    const normalized = values
      .filter((value): value is string => typeof value === 'string' && known.has(value));
    const unique = [...new Set(normalized)];
    if (unique.length === 0) throw new Error('voice_compatible_models_invalid');
    return unique;
  }

  private writeDocument(document: VoiceRegistryDocument): void {
    writeUtf8TextAtomic(this.registryPath, `${JSON.stringify(document, null, 2)}\n`);
  }

  list(): VoiceProfileRecord[] {
    return this.readDocument().profiles.map((item) => ({ ...item }));
  }

  listSummaries(activeVoiceProfileId?: string): Array<{
    id: string;
    displayName: string;
    kind: 'preset' | 'reference';
    state: 'ready' | 'optional_missing' | 'blocked' | 'error';
    active: boolean;
    license: string;
    sourceLabel: string;
    authorizationConfirmed: boolean;
    capabilities: Array<'speech' | 'singing'>;
    compatibleTtsModelIds: string[];
  }> {
    const persisted = this.list().map((profile) => {
      let state: 'ready' | 'optional_missing' | 'blocked' | 'error' = 'ready';
      if (profile.kind === 'reference') {
        try {
          const resolved = this.resolveProfilePath(profile);
          if (hashFileSha256(resolved) !== profile.sha256) state = 'blocked';
        } catch {
          state = 'optional_missing';
        }
      }
      return {
        id: profile.id,
        displayName: profile.displayName,
        kind: profile.kind,
        state,
        active: profile.id === activeVoiceProfileId,
        license: profile.license,
        sourceLabel: profile.sourceLabel,
        authorizationConfirmed: profile.authorizationConfirmed,
        capabilities: (profile.kind === 'reference' ? ['speech', 'singing'] : ['speech']) as Array<'speech' | 'singing'>,
        compatibleTtsModelIds: [...profile.compatibleTtsModelIds],
      };
    });
    const persistedIds = new Set(persisted.map((item) => item.id));
    const presets = SPEECH_PRESET_VOICE_CATALOG
      .filter((item) => !persistedIds.has(item.id))
      .map((item) => ({
        id: item.id,
        displayName: item.displayName,
        kind: 'preset' as const,
        state: 'ready' as const,
        active: item.id === activeVoiceProfileId,
        license: item.license,
        sourceLabel: item.sourceLabel,
        authorizationConfirmed: true,
        capabilities: ['speech'] as Array<'speech' | 'singing'>,
        compatibleTtsModelIds: [...item.compatibleTtsModelIds],
      }));
    return [...presets, ...persisted];
  }

  resolveProfile(profileId: string):
    | { kind: 'preset'; presetSpeakerId: string; compatibleTtsModelIds: string[] }
    | { kind: 'reference'; path: string; transcript: string; compatibleTtsModelIds: string[] } {
    const profile = this.list().find((item) => item.id === profileId);
    if (!profile) {
      const preset = SPEECH_PRESET_VOICE_CATALOG.find((item) => item.id === profileId);
      if (!preset) throw new Error('voice_profile_not_found');
      return {
        kind: 'preset',
        presetSpeakerId: preset.speakerId,
        compatibleTtsModelIds: [...preset.compatibleTtsModelIds],
      };
    }
    if (profile.kind === 'preset') return {
      kind: 'preset',
      presetSpeakerId: profile.presetSpeakerId!,
      compatibleTtsModelIds: [...profile.compatibleTtsModelIds],
    };
    const referencePath = this.resolveProfilePath(profile);
    // listSummaries 只是展示检查；每次真正交给 Sidecar 前仍必须重新验证内容 Hash。
    if (hashFileSha256(referencePath) !== profile.sha256) throw new Error('voice_reference_sha256_mismatch');
    return {
      kind: 'reference',
      path: referencePath,
      transcript: profile.transcript!,
      compatibleTtsModelIds: [...profile.compatibleTtsModelIds],
    };
  }

  resolveProfilePath(profileOrId: VoiceProfileRecord | string): string {
    const profile = typeof profileOrId === 'string'
      ? this.list().find((item) => item.id === profileOrId)
      : profileOrId;
    if (!profile) throw new Error('voice_profile_not_found');
    if (profile.kind !== 'reference' || !profile.relativePath) throw new Error('voice_profile_has_no_reference_file');
    const resolved = path.resolve(this.root, ...profile.relativePath.split('/'));
    if (!isWithinRoot(resolved, this.root)) throw new Error('voice_relative_path_escape');
    assertRegularNonSymlink(resolved);
    return resolved;
  }

  async importReferenceVoice(input: ImportReferenceVoiceInput): Promise<VoiceProfileRecord> {
    if (input.authorizationConfirmed !== true) throw new Error('voice_authorization_required');
    if (input.cleanSingleSpeakerConfirmed !== true) throw new Error('voice_clean_single_speaker_confirmation_required');
    if (!this.validateReferenceAudio) throw new Error('voice_audio_validator_unavailable');
    const sourcePath = path.resolve(input.sourcePath);
    const stat = assertRegularNonSymlink(sourcePath);
    if (stat.size <= 0 || stat.size > this.maxBytes) throw new Error('voice_file_size_invalid');
    const descriptor = fs.openSync(sourcePath, 'r');
    const header = Buffer.alloc(32);
    let count = 0;
    try { count = fs.readSync(descriptor, header, 0, header.length, 0); } finally { fs.closeSync(descriptor); }
    const format = sniffAudioHeader(header.subarray(0, count));
    if (!format) throw new Error('voice_audio_header_unsupported');
    const evidence = await this.validateReferenceAudio(sourcePath);
    if (evidence.durationMs < 3_000 || evidence.durationMs > 30_000) throw new Error('voice_duration_out_of_range');
    if (evidence.format !== format) throw new Error('voice_audio_format_mismatch');
    const sha256 = hashFileSha256(sourcePath);
    if (evidence.sha256 !== sha256) throw new Error('voice_audio_changed_after_validation');
    const fileName = `${sha256}${extensionFor(format)}`;
    const targetPath = path.join(this.filesRoot, fileName);
    const relativePath = path.posix.join('files', fileName);
    const record = this.validateRecord({
      id: `reference-${sha256.slice(0, 16)}`,
      displayName: sanitizeText(input.displayName, 100, 'display_name'),
      kind: 'reference',
      relativePath,
      sha256,
      transcript: sanitizeText(input.transcript, 4_000, 'transcript'),
      source: input.sourceKind === 'feishu_native_reply' ? 'feishu_native_reply' : 'user_provided',
      sourceLabel: sanitizeText(input.sourceLabel, 100, 'source_label'),
      license: sanitizeText(input.license, 200, 'license'),
      authorizationConfirmed: true,
      compatibleTtsModelIds: [...REFERENCE_MODEL_IDS],
      cleanSingleSpeakerConfirmed: true,
      ...(input.authorization ? { authorization: input.authorization } : {}),
      createdAt: new Date().toISOString(),
    });
    return this.withLock(() => {
      const document = this.readDocument();
      if (!fs.existsSync(targetPath)) {
        const tempPath = path.join(this.filesRoot, `.${fileName}.${crypto.randomUUID()}.tmp`);
        try {
          fs.copyFileSync(sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
          if (hashFileSha256(tempPath) !== sha256) throw new Error('voice_copy_sha256_mismatch');
          fs.renameSync(tempPath, targetPath);
        } finally {
          try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* 下次导入不会信任该临时文件。 */ }
        }
      } else {
        assertRegularNonSymlink(targetPath);
        if (hashFileSha256(targetPath) !== sha256) throw new Error('voice_existing_sha256_mismatch');
      }
      const profiles = document.profiles.filter((item) => item.id !== record.id);
      profiles.push(record);
      this.writeDocument({ protocol: document.protocol, revision: document.revision + 1, profiles });
      return { ...record };
    });
  }

  registerPreset(input: {
    id: string;
    displayName: string;
    presetSpeakerId: string;
    sourceLabel: string;
    license: string;
    compatibleTtsModelIds?: string[];
  }): VoiceProfileRecord {
    if (!ALLOWED_PRESET_SPEAKER_IDS.has(input.presetSpeakerId)) throw new Error('voice_preset_speaker_invalid');
    const record: VoiceProfileRecord = {
      id: sanitizeText(input.id, 80, 'id'),
      displayName: sanitizeText(input.displayName, 100, 'display_name'),
      kind: 'preset',
      presetSpeakerId: input.presetSpeakerId,
      source: 'builtin_preset',
      sourceLabel: sanitizeText(input.sourceLabel, 100, 'source_label'),
      license: sanitizeText(input.license, 200, 'license'),
      authorizationConfirmed: true,
      compatibleTtsModelIds: this.validateCompatibleModels(
        input.compatibleTtsModelIds || ['cosyvoice-300m-sft'],
      ),
      createdAt: new Date().toISOString(),
    };
    return this.withLock(() => {
      const document = this.readDocument();
      const profiles = document.profiles.filter((item) => item.id !== record.id);
      profiles.push(record);
      this.writeDocument({ protocol: document.protocol, revision: document.revision + 1, profiles });
      return { ...record };
    });
  }
}
