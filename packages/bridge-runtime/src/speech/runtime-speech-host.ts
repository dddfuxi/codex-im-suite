import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertRegularNonSymlink,
  ensureNonSymlinkDirectory,
  isWithinRoot,
  removeManagedTempDirectorySafely,
  resolveExecutableDependency,
  type ResolvedDependencyPath,
} from './dependency-resolution.js';
import { hashFileSha256, normalizeForAsr, validateAudio, wavToMonoOpus } from './media-pipeline.js';
import { RuntimeSpeechError, type SpeechRuntimeConfig } from './runtime-types.js';
import { SpeechSidecarSupervisor, type SidecarTranscriptionResult } from './sidecar-supervisor.js';
import { findSpeechModel, speechToneInstruction } from './speech-model-catalog.js';
import type { SpeechModelBenchmarkStore } from './speech-model-benchmark-store.js';
import { SpeechVoiceRegistry } from './voice-registry.js';

export interface RuntimeSpeechTranscriptReceipt {
  protocol: 'cti-speech-transcript/v1';
  attachmentId: string;
  text: string;
  model: string;
  language: string;
  mediaType?: string;
  durationMs?: number;
  relation: 'current_message' | 'native_reply';
  /** 触发当前 Bridge 回合的平台消息。 */
  requestMessageId: string;
  /** 真正承载音频字节的平台消息；native reply 时与 request 不同。 */
  sourceMessageId: string;
  fileSha256: string;
  validated: true;
}

export interface RuntimeSpeechSynthesisReceipt {
  protocol: 'cti-speech-synthesis/v1';
  path: string;
  mediaType: string;
  format: 'opus';
  durationMs: number;
  textSha256: string;
  fileSha256: string;
  validated: true;
  ttsModelId: string;
  modelRevision: string;
  voiceProfileId: string;
  peakVramMiB?: number;
}

export interface RuntimeSpeechReferenceVoiceImportReceipt {
  protocol: 'cti-speech-reference-voice-import/v1';
  voiceProfileId: string;
  requestMessageId: string;
  sourceMessageId: string;
  fileKey: string;
  attachmentId: string;
  fileSha256: string;
  authorizationExpiresAt: string;
  validated: true;
}

interface ManagedSynthesisOutput {
  outputRoot: string;
  receiptFingerprint: string;
  fileSha256: string;
}

export type RuntimeSpeechReplyPolicy = 'explicit_or_inbound_audio' | 'explicit_only';

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

export interface RuntimeSpeechMediaPipeline {
  validateAudio: typeof validateAudio;
  normalizeForAsr: typeof normalizeForAsr;
  wavToMonoOpus: typeof wavToMonoOpus;
  hashFileSha256: typeof hashFileSha256;
}

const DEFAULT_MEDIA_PIPELINE: RuntimeSpeechMediaPipeline = {
  validateAudio,
  normalizeForAsr,
  wavToMonoOpus,
  hashFileSha256,
};

const SENSEVOICE_SPOKEN_LANGUAGES = new Set(['zh', 'en', 'yue', 'ja', 'ko']);
const MAX_RELEASED_SYNTHESIS_TOMBSTONES = 256;

function synthesisReceiptFingerprint(receipt: RuntimeSpeechSynthesisReceipt): string {
  return crypto.createHash('sha256').update(JSON.stringify([
    receipt.protocol,
    receipt.path,
    receipt.mediaType,
    receipt.format,
    receipt.durationMs,
    receipt.textSha256,
    receipt.fileSha256,
    receipt.validated,
    receipt.ttsModelId,
    receipt.modelRevision,
    receipt.voiceProfileId || '',
  ]), 'utf8').digest('hex');
}

/** Sidecar 字段仍按不可信边界校验，不能仅靠 TypeScript 必填声明生成事实回执。 */
export function validateSidecarTranscriptResult(result: SidecarTranscriptionResult): {
  text: string;
  model: string;
  language: string;
} {
  const text = result.text?.trim();
  if (!text) throw new RuntimeSpeechError('asr_empty_transcript', 'error', '语音转写结果为空');
  const model = result.model?.trim();
  if (!model || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(model)) {
    throw new RuntimeSpeechError('asr_model_identity_invalid', 'error', '语音模型身份无效');
  }
  const language = result.language?.trim().toLowerCase();
  if (!language || !SENSEVOICE_SPOKEN_LANGUAGES.has(language)) {
    throw new RuntimeSpeechError('asr_language_identity_invalid', 'error', '语音语言身份无效');
  }
  return { text, model, language };
}

/** ASR 与 TTS 共用一个受控槽，避免本地模型同时争抢 CPU/GPU/显存。 */
class SingleSpeechRequestGate {
  private busy = false;
  private readonly queue: Waiter[] = [];

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new RuntimeSpeechError('speech_request_aborted', 'error', '语音请求已取消'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      waiter.abort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new RuntimeSpeechError('speech_request_aborted', 'error', '语音请求已取消'));
      };
      if (!this.busy) {
        this.busy = true;
        resolve(this.createRelease());
        return;
      }
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.queue.push(waiter);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        next.signal?.removeEventListener('abort', next.abort!);
        if (next.signal?.aborted) continue;
        next.resolve(this.createRelease());
        return;
      }
      this.busy = false;
    };
  }
}

const KNOWN_ERROR_MESSAGES: Record<string, string> = {
  audio_empty: '语音文件为空',
  audio_too_large: '语音文件超过大小限制',
  audio_too_long: '语音时长超过限制',
  audio_header_unsupported: '语音文件真实格式不受支持',
  audio_sha256_mismatch: '语音文件完整性校验失败',
  audio_duration_invalid: '无法确认语音时长',
  audio_stream_missing: '文件中没有有效音轨',
  ffprobe_failed: '语音探测失败',
  ffmpeg_asr_normalize_failed: '语音标准化失败',
  ffmpeg_opus_encode_failed: '语音编码失败',
  voice_profile_not_found: '所选音色不存在',
};

function normalizeFailure(error: unknown): RuntimeSpeechError {
  if (error instanceof RuntimeSpeechError) return error;
  const code = error instanceof Error && /^[a-z0-9_]+$/i.test(error.message) ? error.message : 'speech_runtime_error';
  return new RuntimeSpeechError(code, 'error', KNOWN_ERROR_MESSAGES[code] || '语音运行时处理失败');
}

function requireReady(dependency: ResolvedDependencyPath): string {
  if (dependency.state === 'ready' && dependency.path) return dependency.path;
  throw new RuntimeSpeechError(
    dependency.diagnosticCode || `${dependency.id}_missing`,
    dependency.state === 'blocked' ? 'blocked' : 'optional_missing',
    `${dependency.displayName} 尚不可用`,
  );
}

export class RuntimeSpeechHost {
  private readonly gate = new SingleSpeechRequestGate();
  private readonly media: RuntimeSpeechMediaPipeline;
  private readonly speechOutputRoot: string;
  private readonly runtimeScratchRoot: string;
  private readonly managedSynthesisOutputs = new Map<string, ManagedSynthesisOutput>();
  private readonly releasedSynthesisReceipts = new Set<string>();
  readonly sidecar: SpeechSidecarSupervisor;

  constructor(private readonly options: {
    config: SpeechRuntimeConfig;
    ctiHome: string;
    runtimeDepsRoot: string;
    bundledSidecarCandidates: string[];
    voiceRegistry?: SpeechVoiceRegistry;
    benchmarkStore?: SpeechModelBenchmarkStore;
    hardwareId?: string;
    sidecar?: SpeechSidecarSupervisor;
    mediaPipeline?: RuntimeSpeechMediaPipeline;
  }) {
    this.media = options.mediaPipeline || DEFAULT_MEDIA_PIPELINE;
    this.speechOutputRoot = path.resolve(options.ctiHome, 'runtime', 'speech', 'output');
    this.runtimeScratchRoot = path.resolve(options.ctiHome, 'runtime', 'workspaces');
    this.sidecar = options.sidecar || new SpeechSidecarSupervisor({
      config: options.config,
      runtimeDepsRoot: options.runtimeDepsRoot,
      runtimeStateRoot: path.join(options.ctiHome, 'runtime', 'speech'),
      bundledSidecarCandidates: options.bundledSidecarCandidates,
    });
  }

  /**
   * Core 只能选择 Runtime 已知的默认输出根或 TurnStorage scratch 根。
   * 逐段复验目录，防止中间 junction/symlink 把合成或清理引到 CTI_HOME 外。
   */
  private resolveManagedSynthesisRoot(requestedRoot?: string): string {
    if (requestedRoot && !path.isAbsolute(requestedRoot)) {
      throw new RuntimeSpeechError('speech_synthesis_root_out_of_bounds', 'blocked', '语音合成目录不在受管范围内');
    }
    const candidate = path.resolve(requestedRoot || this.speechOutputRoot);
    const allowedRoot = isWithinRoot(candidate, this.speechOutputRoot)
      ? this.speechOutputRoot
      : isWithinRoot(candidate, this.runtimeScratchRoot)
        ? this.runtimeScratchRoot
        : undefined;
    if (!allowedRoot) {
      throw new RuntimeSpeechError('speech_synthesis_root_out_of_bounds', 'blocked', '语音合成目录不在受管范围内');
    }
    ensureNonSymlinkDirectory(allowedRoot);
    ensureNonSymlinkDirectory(candidate);
    let current = allowedRoot;
    const relative = path.relative(allowedRoot, candidate);
    for (const segment of relative ? relative.split(path.sep) : []) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new RuntimeSpeechError('speech_synthesis_root_unsafe', 'blocked', '语音合成目录不安全');
      }
    }
    return candidate;
  }

  private resolveMediaDependencies(): { ffmpeg: ResolvedDependencyPath; ffprobe: ResolvedDependencyPath } {
    return {
      ffmpeg: resolveExecutableDependency({
        id: 'ffmpeg', displayName: 'FFmpeg', explicitPath: this.options.config.ffmpegPath,
        runtimeDepsRoot: this.options.runtimeDepsRoot,
        componentIds: ['ffmpeg_runtime', 'ffmpeg'],
      }),
      ffprobe: resolveExecutableDependency({
        id: 'ffprobe', displayName: 'ffprobe', explicitPath: this.options.config.ffprobePath,
        runtimeDepsRoot: this.options.runtimeDepsRoot,
        componentIds: ['ffmpeg_runtime', 'ffprobe'],
      }),
    };
  }

  getDependencySnapshot(): {
    ffmpeg: ResolvedDependencyPath;
    ffprobe: ResolvedDependencyPath;
    python: ResolvedDependencyPath;
    sidecar: ResolvedDependencyPath;
  } {
    return { ...this.resolveMediaDependencies(), ...this.sidecar.resolveDependencies() };
  }

  /** Core 只消费受限只读策略，不读取 env，也不持有可变 Runtime 配置。 */
  getReplyPolicy(): RuntimeSpeechReplyPolicy {
    return this.options.config.replyPolicy === 'explicit_only' ? 'explicit_only' : 'explicit_or_inbound_audio';
  }

  /** 只把 Sidecar 真实加载并与配置一致的模型身份签发给 Core。 */
  async getSynthesisIdentity(input: { signal?: AbortSignal } = {}): Promise<{
    ttsModelId: string;
    modelRevision: string;
    voiceProfileId: string;
  } | null> {
    if (!this.options.config.outputEnabled) return null;
    const selectedModel = findSpeechModel(this.options.config.ttsModelId);
    const voiceProfileId = this.options.config.voiceProfileId || selectedModel?.defaultVoiceProfileId || '';
    if (!selectedModel || selectedModel.providerId !== this.options.config.ttsProvider || !voiceProfileId) return null;
    try {
      const profile = this.options.voiceRegistry?.resolveProfile(voiceProfileId);
      if (!profile || !profile.compatibleTtsModelIds.includes(selectedModel.id)) return null;
      const client = await this.sidecar.ensureClient(input.signal);
      const health = await client.health(input.signal);
      if (!health.capabilities.tts
        || health.tts?.providerId !== selectedModel.providerId
        || health.tts.modelId !== selectedModel.id
        || !/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(health.tts.revision || '')) return null;
      return { ttsModelId: selectedModel.id, modelRevision: health.tts.revision, voiceProfileId };
    } catch {
      return null;
    }
  }

  async transcribe(input: {
    attachmentId: string;
    path: string;
    mediaType?: string;
    sha256: string;
    relation?: 'current_message' | 'native_reply';
    requestMessageId?: string;
    sourceMessageId: string;
    signal?: AbortSignal;
  }): Promise<RuntimeSpeechTranscriptReceipt> {
    if (!this.options.config.inputEnabled) throw new RuntimeSpeechError('speech_input_disabled', 'optional_missing', '语音输入尚未启用');
    const release = await this.gate.acquire(input.signal);
    const tempRoot = path.join(this.options.ctiHome, 'runtime', 'speech', 'tmp');
    ensureNonSymlinkDirectory(tempRoot);
    const requestRoot = fs.mkdtempSync(path.join(tempRoot, 'asr-'));
    try {
      const dependencies = this.resolveMediaDependencies();
      const ffmpegPath = requireReady(dependencies.ffmpeg);
      const ffprobePath = requireReady(dependencies.ffprobe);
      const source = await this.media.validateAudio({
        filePath: input.path,
        ffprobePath,
        maxBytes: this.options.config.maxInputBytes,
        maxDurationMs: this.options.config.maxDurationMs,
        expectedSha256: input.sha256,
        timeoutMs: this.options.config.requestTimeoutMs,
        signal: input.signal,
      });
      const normalizedPath = path.join(requestRoot, 'input.wav');
      await this.media.normalizeForAsr({
        ffmpegPath,
        sourcePath: source.path,
        outputPath: normalizedPath,
        timeoutMs: this.options.config.requestTimeoutMs,
        signal: input.signal,
      });
      await this.media.validateAudio({
        filePath: normalizedPath,
        ffprobePath,
        maxBytes: this.options.config.maxInputBytes,
        maxDurationMs: this.options.config.maxDurationMs,
        timeoutMs: this.options.config.requestTimeoutMs,
        signal: input.signal,
      });
      const client = await this.sidecar.ensureClient(input.signal);
      const result = await client.transcribe({
        audioPath: normalizedPath,
        provider: this.options.config.asrProvider,
        model: this.options.config.asrModel,
      }, input.signal);
      const { text, model, language } = validateSidecarTranscriptResult(result);
      return {
        protocol: 'cti-speech-transcript/v1',
        attachmentId: input.attachmentId,
        relation: input.relation || 'current_message',
        requestMessageId: input.requestMessageId || input.sourceMessageId,
        sourceMessageId: input.sourceMessageId,
        text,
        model,
        language,
        mediaType: input.mediaType,
        durationMs: source.durationMs,
        fileSha256: source.sha256,
        validated: true,
      };
    } catch (error) {
      throw normalizeFailure(error);
    } finally {
      try {
        removeManagedTempDirectorySafely({
          targetPath: requestRoot,
          managedRoot: tempRoot,
          requiredNamePrefix: 'asr-',
        });
      } catch { /* 临时文件保留不影响事实回执，也绝不越过受管根。 */ }
      release();
    }
  }

  /**
   * 只把当前回合已转写并由 Owner 明确授权的 native reply 音频导入注册表。
   * 模型不能提供平台 ID、文件路径、Provider、模型或最终 profile ID。
   */
  async importReferenceVoice(input: {
    profileName?: string;
    path: string;
    mediaType: string;
    sha256: string;
    requestMessageId: string;
    sourceMessageId: string;
    fileKey: string;
    attachmentId: string;
    transcript: RuntimeSpeechTranscriptReceipt;
    authorization: {
      protocol: 'cti-speech-reference-voice-authorization/v1';
      scope: 'current_native_reply_audio';
      ownerUserId: string;
      authorizedAt: string;
      expiresAt: string;
      rightsBasis?: 'self_or_authorized';
      usageScope?: 'local_tts_only';
      cleanSingleSpeakerConfirmed?: true;
    };
    signal?: AbortSignal;
  }): Promise<RuntimeSpeechReferenceVoiceImportReceipt> {
    if (!this.options.voiceRegistry) {
      throw new RuntimeSpeechError('voice_registry_unavailable', 'optional_missing', '音色注册表不可用');
    }
    if (input.signal?.aborted) throw new RuntimeSpeechError('speech_request_aborted', 'error', '语音请求已取消');
    const authorization = input.authorization;
    const authorizedAtMs = Date.parse(authorization.authorizedAt || '');
    const expiresAtMs = Date.parse(authorization.expiresAt || '');
    const now = Date.now();
    if (authorization.protocol !== 'cti-speech-reference-voice-authorization/v1'
      || authorization.scope !== 'current_native_reply_audio'
      || authorization.rightsBasis !== 'self_or_authorized'
      || authorization.usageScope !== 'local_tts_only'
      || authorization.cleanSingleSpeakerConfirmed !== true
      || !authorization.ownerUserId?.trim()
      || !Number.isFinite(authorizedAtMs)
      || !Number.isFinite(expiresAtMs)
      || authorizedAtMs > now + 5_000
      || expiresAtMs <= now
      || expiresAtMs <= authorizedAtMs
      || expiresAtMs - authorizedAtMs > 10 * 60_000) {
      throw new RuntimeSpeechError('voice_authorization_invalid', 'blocked', '参考音色授权无效或已过期');
    }
    if (!path.isAbsolute(input.path)
      || !input.mediaType.toLowerCase().startsWith('audio/')
      || !input.requestMessageId?.trim()
      || !input.sourceMessageId?.trim()
      || !input.fileKey?.trim()
      || !input.attachmentId?.trim()
      || !/^[a-f0-9]{64}$/u.test(input.sha256 || '')) {
      throw new RuntimeSpeechError('voice_source_binding_invalid', 'blocked', '参考音色来源绑定无效');
    }
    const transcript = input.transcript;
    if (transcript.protocol !== 'cti-speech-transcript/v1'
      || transcript.validated !== true
      || transcript.relation !== 'native_reply'
      || transcript.requestMessageId !== input.requestMessageId
      || transcript.sourceMessageId !== input.sourceMessageId
      || transcript.attachmentId !== input.attachmentId
      || transcript.fileSha256 !== input.sha256
      || !transcript.text?.trim()) {
      throw new RuntimeSpeechError('voice_transcript_binding_invalid', 'blocked', '参考音色转写与来源证据不一致');
    }
    assertRegularNonSymlink(input.path);
    if (this.media.hashFileSha256(input.path) !== input.sha256) {
      throw new RuntimeSpeechError('voice_source_sha256_mismatch', 'blocked', '参考音色源文件已发生变化');
    }

    const release = await this.gate.acquire(input.signal);
    try {
      if (input.signal?.aborted) throw new RuntimeSpeechError('speech_request_aborted', 'error', '语音请求已取消');
      const profile = await this.options.voiceRegistry.importReferenceVoice({
        sourcePath: input.path,
        displayName: input.profileName?.trim() || `飞书参考音色 ${input.sha256.slice(0, 8)}`,
        transcript: transcript.text,
        sourceLabel: '飞书原生回复语音',
        license: 'Owner 已确认本人或已获授权，仅限本地 TTS 使用',
        authorizationConfirmed: true,
        cleanSingleSpeakerConfirmed: true,
        sourceKind: 'feishu_native_reply',
        authorization: {
          kind: 'bridge_owner_native_reply',
          ownerIdHash: crypto.createHash('sha256').update(authorization.ownerUserId, 'utf8').digest('hex'),
          scope: 'local_tts_only',
          authorizedAt: authorization.authorizedAt,
          requestMessageId: input.requestMessageId,
          sourceMessageId: input.sourceMessageId,
          attachmentId: input.attachmentId,
          sourceFileSha256: input.sha256,
        },
      });
      return {
        protocol: 'cti-speech-reference-voice-import/v1',
        voiceProfileId: profile.id,
        requestMessageId: input.requestMessageId,
        sourceMessageId: input.sourceMessageId,
        fileKey: input.fileKey,
        attachmentId: input.attachmentId,
        fileSha256: input.sha256,
        authorizationExpiresAt: authorization.expiresAt,
        validated: true,
      };
    } catch (error) {
      throw normalizeFailure(error);
    } finally {
      release();
    }
  }

  async synthesize(input: {
    text: string;
    /** Core 只使用这一份 Runtime 预签发身份；以下旧字段仅保留给受控面板试听。 */
    expectedIdentity?: {
      ttsModelId: string;
      modelRevision: string;
      voiceProfileId: string | null;
    };
    ttsModelId?: string;
    modelRevision?: string;
    voiceProfileId?: string;
    trustedPreviewMode?: boolean;
    /** 仅由 live 试听控制通道建立模型级性能记录，Core 不可设置。 */
    benchmarkMode?: boolean;
    scratchDir?: string;
    signal?: AbortSignal;
  }): Promise<RuntimeSpeechSynthesisReceipt> {
    if (!this.options.config.outputEnabled) throw new RuntimeSpeechError('speech_output_disabled', 'optional_missing', '语音输出尚未启用');
    const text = input.text.trim();
    if (!text || text.length > this.options.config.maxTextChars) throw new RuntimeSpeechError('tts_text_invalid', 'blocked', '语音文本为空或超过长度限制');
    const release = await this.gate.acquire(input.signal);
    let wavPath: string | undefined;
    let opusPath: string | undefined;
    let completed = false;
    try {
      const dependencies = this.resolveMediaDependencies();
      const ffmpegPath = requireReady(dependencies.ffmpeg);
      const ffprobePath = requireReady(dependencies.ffprobe);
      const outputRoot = this.resolveManagedSynthesisRoot(input.scratchDir);
      const requestId = crypto.randomUUID();
      wavPath = path.join(outputRoot, `${requestId}.wav`);
      opusPath = path.join(outputRoot, `${requestId}.ogg`);
      const selectedModel = findSpeechModel(this.options.config.ttsModelId);
      if (!selectedModel || selectedModel.providerId !== this.options.config.ttsProvider) {
        throw new RuntimeSpeechError('tts_provider_model_mismatch', 'blocked', '语音 Provider 与模型不匹配');
      }
      const requestedTtsModelId = input.expectedIdentity?.ttsModelId || input.ttsModelId;
      const requestedModelRevision = input.expectedIdentity?.modelRevision || input.modelRevision;
      const requestedVoiceProfileId = input.expectedIdentity
        ? input.expectedIdentity.voiceProfileId || undefined
        : input.voiceProfileId;
      const voiceProfileId = requestedVoiceProfileId || this.options.config.voiceProfileId || selectedModel.defaultVoiceProfileId;
      if (!voiceProfileId) throw new RuntimeSpeechError('voice_profile_not_found', 'blocked', '当前模型尚未选择音色');
      const client = await this.sidecar.ensureClient(input.signal);
      const liveHealth = await client.health(input.signal);
      if (!input.trustedPreviewMode && (
        requestedTtsModelId !== selectedModel.id
        || requestedModelRevision !== liveHealth.tts?.revision
        || requestedVoiceProfileId !== (this.options.config.voiceProfileId || selectedModel.defaultVoiceProfileId)
      )) {
        throw new RuntimeSpeechError('tts_synthesis_identity_mismatch', 'blocked', '语音合成请求身份与当前 Runtime 不一致');
      }
      let voiceReferencePath: string | undefined;
      let voiceReferenceTranscript: string | undefined;
      let presetSpeakerId: string | undefined;
      if (voiceProfileId) {
        if (!this.options.voiceRegistry) throw new RuntimeSpeechError('voice_registry_unavailable', 'optional_missing', '音色注册表不可用');
        const profile = this.options.voiceRegistry.resolveProfile(voiceProfileId);
        if (!profile.compatibleTtsModelIds.includes(selectedModel.id)) {
          throw new RuntimeSpeechError('voice_profile_model_incompatible', 'blocked', '所选音色与当前模型不兼容');
        }
        if (profile.kind === 'reference') {
          if (!input.benchmarkMode) {
            const revision = liveHealth.tts?.revision || '';
            const passed = revision && this.options.benchmarkStore && this.options.hardwareId
              ? this.options.benchmarkStore.find({
                  modelId: selectedModel.id,
                  providerId: selectedModel.providerId,
                  revision,
                  hardwareId: this.options.hardwareId,
                })
              : null;
            if (passed?.state !== 'ready') {
              throw new RuntimeSpeechError('voice_clone_benchmark_not_verified', 'blocked', '当前模型与硬件尚未通过参考音色性能门禁');
            }
          }
          voiceReferencePath = profile.path;
          voiceReferenceTranscript = profile.transcript;
          presetSpeakerId = undefined;
        } else {
          presetSpeakerId = profile.presetSpeakerId;
        }
      }
      const synthesis = await client.synthesize({
        text,
        outputPath: wavPath,
        provider: this.options.config.ttsProvider,
        modelId: selectedModel.id,
        ...(selectedModel.capabilities.includes('instruction_control')
          ? { toneInstruction: speechToneInstruction(this.options.config.tonePolicy) }
          : {}),
        voiceProfileId,
        ...(presetSpeakerId ? { presetSpeakerId } : {}),
        voiceReferencePath,
        voiceReferenceTranscript,
      }, input.signal);
      if (synthesis.provider !== selectedModel.providerId
        || synthesis.model !== selectedModel.id
        || synthesis.revision !== liveHealth.tts?.revision
        || !/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(synthesis.revision || '')) {
        throw new RuntimeSpeechError('tts_model_identity_mismatch', 'error', '语音模型身份校验失败');
      }
      await this.media.validateAudio({
        filePath: wavPath,
        ffprobePath,
        maxBytes: this.options.config.maxInputBytes,
        maxDurationMs: this.options.config.maxDurationMs,
        timeoutMs: this.options.config.requestTimeoutMs,
        signal: input.signal,
      });
      await this.media.wavToMonoOpus({
        ffmpegPath,
        sourcePath: wavPath,
        outputPath: opusPath,
        timeoutMs: this.options.config.requestTimeoutMs,
        signal: input.signal,
      });
      const output = await this.media.validateAudio({
        filePath: opusPath,
        ffprobePath,
        maxBytes: this.options.config.maxInputBytes,
        maxDurationMs: this.options.config.maxDurationMs,
        timeoutMs: this.options.config.requestTimeoutMs,
        signal: input.signal,
      });
      if (output.format !== 'ogg' || output.codec?.toLowerCase() !== 'opus') throw new RuntimeSpeechError('tts_output_not_opus', 'blocked', '语音输出格式校验失败');
      const receipt: RuntimeSpeechSynthesisReceipt = {
        protocol: 'cti-speech-synthesis/v1',
        path: output.path,
        mediaType: 'audio/ogg; codecs=opus',
        format: 'opus',
        durationMs: output.durationMs,
        textSha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
        fileSha256: this.media.hashFileSha256(output.path),
        validated: true,
        ttsModelId: selectedModel.id,
        modelRevision: synthesis.revision,
        voiceProfileId,
        ...(Number.isFinite(synthesis.peakVramMiB) && synthesis.peakVramMiB! >= 0
          ? { peakVramMiB: synthesis.peakVramMiB }
          : {}),
      };
      this.managedSynthesisOutputs.set(path.resolve(output.path), {
        outputRoot,
        receiptFingerprint: synthesisReceiptFingerprint(receipt),
        fileSha256: receipt.fileSha256,
      });
      completed = true;
      return receipt;
    } catch (error) {
      throw normalizeFailure(error);
    } finally {
      try { if (wavPath) fs.unlinkSync(wavPath); } catch { /* WAV 始终是中间产物。 */ }
      try { if (!completed && opusPath) fs.unlinkSync(opusPath); } catch { /* 失败产物不能进入后续投递。 */ }
      release();
    }
  }

  /**
   * 交付完成或失败后释放本实例生成的临时 Opus。
   * Core 传回的 path 不构成删除授权；必须同时命中本实例登记、受管根和当前文件 Hash。
   */
  releaseSynthesis(receipt: RuntimeSpeechSynthesisReceipt): void {
    if (
      !receipt
      || receipt.protocol !== 'cti-speech-synthesis/v1'
      || receipt.validated !== true
      || receipt.format !== 'opus'
      || receipt.mediaType !== 'audio/ogg; codecs=opus'
      || !Number.isFinite(receipt.durationMs)
      || receipt.durationMs <= 0
      || !/^[a-f0-9]{64}$/.test(receipt.textSha256 || '')
      || !/^[a-f0-9]{64}$/.test(receipt.fileSha256 || '')
      || !/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(receipt.ttsModelId || '')
      || !/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(receipt.modelRevision || '')
      || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(receipt.voiceProfileId || '')
      || !path.isAbsolute(receipt.path || '')
    ) {
      throw new RuntimeSpeechError('speech_synthesis_release_rejected', 'blocked', '语音合成回执无效');
    }
    const absolutePath = path.resolve(receipt.path);
    if (
      !isWithinRoot(absolutePath, this.speechOutputRoot)
      && !isWithinRoot(absolutePath, this.runtimeScratchRoot)
    ) {
      throw new RuntimeSpeechError('speech_synthesis_release_out_of_bounds', 'blocked', '语音合成产物不在受管范围内');
    }
    const fingerprint = synthesisReceiptFingerprint(receipt);
    if (this.releasedSynthesisReceipts.has(fingerprint)) return;
    const managed = this.managedSynthesisOutputs.get(absolutePath);
    if (
      !managed
      || managed.receiptFingerprint !== fingerprint
      || managed.fileSha256 !== receipt.fileSha256
      || !isWithinRoot(absolutePath, managed.outputRoot)
    ) {
      throw new RuntimeSpeechError('speech_synthesis_release_unknown', 'blocked', '语音合成产物不属于当前 Runtime 实例');
    }
    try {
      this.resolveManagedSynthesisRoot(managed.outputRoot);
      assertRegularNonSymlink(absolutePath);
      if (this.media.hashFileSha256(absolutePath) !== receipt.fileSha256) {
        throw new RuntimeSpeechError('speech_synthesis_release_hash_mismatch', 'blocked', '语音合成产物已发生变化');
      }
      fs.unlinkSync(absolutePath);
    } catch (error) {
      if (error instanceof RuntimeSpeechError) throw error;
      throw new RuntimeSpeechError('speech_synthesis_release_failed', 'error', '语音合成产物清理失败');
    }
    this.managedSynthesisOutputs.delete(absolutePath);
    this.releasedSynthesisReceipts.add(fingerprint);
    while (this.releasedSynthesisReceipts.size > MAX_RELEASED_SYNTHESIS_TOMBSTONES) {
      const oldest = this.releasedSynthesisReceipts.values().next().value as string | undefined;
      if (!oldest) break;
      this.releasedSynthesisReceipts.delete(oldest);
    }
  }

  stop(): Promise<void> {
    return this.sidecar.stop();
  }
}
