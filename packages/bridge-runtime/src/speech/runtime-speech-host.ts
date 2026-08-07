import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertRegularNonSymlink,
  ensureNonSymlinkDirectory,
  isWithinRoot,
  resolveExecutableDependency,
  type ResolvedDependencyPath,
} from './dependency-resolution.js';
import { hashFileSha256, normalizeForAsr, validateAudio, wavToMonoOpus } from './media-pipeline.js';
import { RuntimeSpeechError, type SpeechRuntimeConfig } from './runtime-types.js';
import { SpeechSidecarSupervisor, type SidecarTranscriptionResult } from './sidecar-supervisor.js';
import { DEFAULT_PRESET_PROFILE_ID, SpeechVoiceRegistry } from './voice-registry.js';

export interface RuntimeSpeechTranscriptReceipt {
  protocol: 'cti-speech-transcript/v1';
  attachmentId: string;
  text: string;
  model: string;
  language: string;
  mediaType?: string;
  durationMs?: number;
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
  voiceProfileId?: string;
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
      }),
      ffprobe: resolveExecutableDependency({
        id: 'ffprobe', displayName: 'ffprobe', explicitPath: this.options.config.ffprobePath,
        runtimeDepsRoot: this.options.runtimeDepsRoot,
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

  async transcribe(input: {
    attachmentId: string;
    path: string;
    mediaType?: string;
    sha256: string;
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
      try { fs.rmSync(requestRoot, { recursive: true, force: true }); } catch { /* 临时文件保留不影响事实回执。 */ }
      release();
    }
  }

  async synthesize(input: {
    text: string;
    voiceProfileId?: string;
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
      const voiceProfileId = input.voiceProfileId || this.options.config.voiceProfileId;
      let voiceReferencePath: string | undefined;
      let voiceReferenceTranscript: string | undefined;
      let presetSpeakerId: string | undefined = DEFAULT_PRESET_PROFILE_ID;
      if (voiceProfileId) {
        if (!this.options.voiceRegistry) throw new RuntimeSpeechError('voice_registry_unavailable', 'optional_missing', '音色注册表不可用');
        const profile = this.options.voiceRegistry.resolveProfile(voiceProfileId);
        if (profile.kind === 'reference') {
          if (!this.options.config.voiceCloneBenchmarkPassed) {
            throw new RuntimeSpeechError('voice_clone_benchmark_not_verified', 'blocked', '参考音色尚未通过本机性能门禁');
          }
          voiceReferencePath = profile.path;
          voiceReferenceTranscript = profile.transcript;
          presetSpeakerId = undefined;
        } else {
          presetSpeakerId = profile.presetSpeakerId;
        }
      }
      const client = await this.sidecar.ensureClient(input.signal);
      await client.synthesize({
        text,
        outputPath: wavPath,
        provider: this.options.config.ttsProvider,
        voiceProfileId,
        ...(presetSpeakerId ? { presetSpeakerId } : {}),
        voiceReferencePath,
        voiceReferenceTranscript,
      }, input.signal);
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
        ...(voiceProfileId ? { voiceProfileId } : {}),
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
