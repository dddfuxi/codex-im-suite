import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertRegularNonSymlink,
  ensureNonSymlinkDirectory,
  isWithinRoot,
  resolveExecutableDependency,
} from './dependency-resolution.js';
import { hashFileSha256, validateAudio, wavToMonoOpus } from './media-pipeline.js';
import { RuntimeSpeechError, type SpeechRuntimeConfig } from './runtime-types.js';
import type { SpeechVoiceRegistry } from './voice-registry.js';
import type { ManagedSingingRuntimeEndpoint } from './managed-singing-runtime-supervisor.js';

export interface RuntimeSingingSynthesisReceipt {
  protocol: 'cti-singing-synthesis/v1';
  path: string;
  mediaType: 'audio/ogg; codecs=opus';
  format: 'opus';
  durationMs: number;
  requestSha256: string;
  fileSha256: string;
  validated: true;
  voiceProfileId?: string;
  peakVramMiB?: number;
}

interface ManagedSongOutput {
  outputRoot: string;
  requestSha256: string;
  fileSha256: string;
}

type FetchLike = typeof fetch;

function canonicalRequestSha256(input: {
  prompt: string;
  lyrics: string;
  vocalLanguage: string;
  durationSeconds: number;
}): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    prompt: input.prompt,
    lyrics: input.lyrics,
    vocalLanguage: input.vocalLanguage,
    durationSeconds: input.durationSeconds,
  }), 'utf8').digest('hex');
}

function requireLoopbackBaseUrl(value: string | undefined): URL {
  if (!value) throw new RuntimeSpeechError('singing_api_not_configured', 'blocked', '歌声 Runtime 尚未配置');
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) {
    throw new RuntimeSpeechError('singing_api_not_loopback', 'blocked', '歌声 Runtime 必须只绑定 127.0.0.1');
  }
  return new URL(url.pathname.endsWith('/') ? url.toString() : `${url.toString()}/`);
}

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      const error = new Error('singing_cancelled');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function maxIntermediateWavBytes(durationSeconds: number, configuredMaxBytes: number): number {
  // ACE-Step 的稳定本地落盘格式是 WAV。按 48kHz、双声道、32-bit PCM
  // 估算中间文件上限并保留少量封装余量；最终 Opus 仍服从配置的交付上限。
  const estimated = Math.ceil(durationSeconds * 48_000 * 2 * 4 * 1.1) + 1024 * 1024;
  return Math.min(512 * 1024 * 1024, Math.max(configuredMaxBytes, estimated));
}

async function writeBoundedBody(response: Response, maxBytes: number, targetPath: string): Promise<void> {
  const declaredRaw = response.headers.get('content-length');
  const declared = declaredRaw === null ? Number.NaN : Number(declaredRaw);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('singing_output_too_large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('singing_output_empty');
  const descriptor = fs.openSync(targetPath, 'wx', 0o600);
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('singing output too large').catch(() => {});
        throw new Error('singing_output_too_large');
      }
      fs.writeSync(descriptor, value);
    }
    if (total <= 0) throw new Error('singing_output_empty');
  } catch (error) {
    try { fs.closeSync(descriptor); } catch { /* 只清理本轮受管文件。 */ }
    try { fs.unlinkSync(targetPath); } catch { /* 失败产物不可投递。 */ }
    throw error;
  }
  fs.closeSync(descriptor);
}

export class AceStepSingingHost {
  private readonly outputRoot: string;
  private readonly runtimeScratchRoot: string;
  private readonly managed = new Map<string, ManagedSongOutput>();

  constructor(private readonly options: {
    config: SpeechRuntimeConfig;
    ctiHome: string;
    runtimeDepsRoot: string;
    voiceRegistry?: SpeechVoiceRegistry;
    fetchImpl?: FetchLike;
    managedRuntime?: {
      ensureRunning(signal?: AbortSignal): Promise<ManagedSingingRuntimeEndpoint>;
      /** 受管生成超时后终止本实例，避免服务端脱离 HTTP 请求继续占用 CPU/GPU。 */
      stop?(): void;
    };
    isBenchmarkVerified?: () => boolean;
    readGpuMemoryMiB?: () => number | undefined;
    /** 仅用于隔离媒体探针的测试缝；生产默认始终执行真实 ffprobe 门禁。 */
    validateAudioImpl?: typeof validateAudio;
    /** 仅用于隔离转码进程的测试缝；生产默认始终执行受管 FFmpeg。 */
    wavToMonoOpusImpl?: typeof wavToMonoOpus;
    /** 允许测试缩短轮询间隔，生产默认保持温和的 750ms。 */
    pollIntervalMs?: number;
  }) {
    this.outputRoot = path.resolve(options.ctiHome, 'runtime', 'speech', 'singing-output');
    this.runtimeScratchRoot = path.resolve(options.ctiHome, 'runtime', 'workspaces');
  }

  private resolveOutputRoot(requested?: string): string {
    if (requested && !path.isAbsolute(requested)) throw new RuntimeSpeechError('singing_output_root_invalid', 'blocked', '歌声输出目录无效');
    const candidate = path.resolve(requested || this.outputRoot);
    const allowedRoot = isWithinRoot(candidate, this.outputRoot)
      ? this.outputRoot
      : isWithinRoot(candidate, this.runtimeScratchRoot) ? this.runtimeScratchRoot : undefined;
    if (!allowedRoot) throw new RuntimeSpeechError('singing_output_root_out_of_bounds', 'blocked', '歌声输出目录不在受管范围内');
    ensureNonSymlinkDirectory(allowedRoot);
    ensureNonSymlinkDirectory(candidate);
    return candidate;
  }

  private headers(tokenValue?: string): Record<string, string> {
    const token = tokenValue?.trim() || this.options.config.singingApiToken?.trim();
    if (!token || token.length < 16) throw new RuntimeSpeechError('singing_api_token_missing', 'blocked', '歌声 Runtime 临时令牌不可用');
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  private async resolveEndpoint(signal?: AbortSignal): Promise<{ base: URL; token: string }> {
    const configuredUrl = this.options.config.singingApiUrl?.trim();
    const configuredToken = this.options.config.singingApiToken?.trim();
    if (configuredUrl || configuredToken) {
      return { base: requireLoopbackBaseUrl(configuredUrl), token: configuredToken || '' };
    }
    if (!this.options.managedRuntime) throw new RuntimeSpeechError('singing_api_not_configured', 'blocked', '歌声 Runtime 尚未配置');
    const endpoint = await this.options.managedRuntime.ensureRunning(signal);
    return { base: requireLoopbackBaseUrl(endpoint.baseUrl), token: endpoint.token };
  }

  private async postJson(base: URL, token: string, endpoint: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await (this.options.fetchImpl || fetch)(new URL(endpoint, base), {
      method: 'POST', headers: this.headers(token), body: JSON.stringify(body), signal, redirect: 'error',
    });
    if (!response.ok) throw new Error('singing_api_request_failed');
    const wrapper = safeRecord(await response.json());
    if (!wrapper || wrapper.code !== 200 || wrapper.error) throw new Error('singing_api_response_invalid');
    return wrapper;
  }

  private resolveReferenceVoice(): { voiceProfileId?: string; referenceAudioPath?: string } {
    const voiceProfileId = this.options.config.singingVoiceProfileId?.trim();
    if (!voiceProfileId) return {};
    if (!this.options.voiceRegistry) throw new RuntimeSpeechError('singing_voice_registry_unavailable', 'blocked', '歌声音色注册表不可用');
    const profile = this.options.voiceRegistry.resolveProfile(voiceProfileId);
    if (profile.kind !== 'reference') throw new RuntimeSpeechError('singing_voice_profile_incompatible', 'blocked', '所选音色不能用于歌声参考');
    return { voiceProfileId, referenceAudioPath: profile.path };
  }

  async health(signal?: AbortSignal): Promise<{ state: 'ready' | 'blocked'; diagnosticCode?: string }> {
    if (!this.options.config.singingEnabled) return { state: 'blocked', diagnosticCode: 'singing_disabled' };
    try {
      const { base, token } = await this.resolveEndpoint(signal);
      const response = await (this.options.fetchImpl || fetch)(new URL('health', base), {
        headers: this.headers(token), signal, redirect: 'error',
      });
      return response.ok ? { state: 'ready' } : { state: 'blocked', diagnosticCode: 'singing_health_failed' };
    } catch (error) {
      return { state: 'blocked', diagnosticCode: error instanceof RuntimeSpeechError ? error.code : 'singing_health_failed' };
    }
  }

  async synthesizeSong(input: {
    prompt: string;
    lyrics: string;
    vocalLanguage: string;
    durationSeconds: number;
    /** 仅受控 benchmark mailbox 可设置，允许完成首次真实性能门禁。 */
    benchmarkMode?: boolean;
    scratchDir?: string;
    signal?: AbortSignal;
  }): Promise<RuntimeSingingSynthesisReceipt> {
    if (!this.options.config.singingEnabled) throw new RuntimeSpeechError('singing_disabled', 'blocked', '歌声能力尚未启用');
    const benchmarkVerified = this.options.isBenchmarkVerified
      ? this.options.isBenchmarkVerified()
      : this.options.config.singingBenchmarkPassed;
    if (!input.benchmarkMode && !benchmarkVerified) {
      throw new RuntimeSpeechError('singing_benchmark_not_verified', 'blocked', '歌声能力尚未通过当前模型与本机硬件性能门禁');
    }
    if (input.durationSeconds < 10 || input.durationSeconds > this.options.config.maxSongDurationSeconds) {
      throw new RuntimeSpeechError('singing_duration_invalid', 'blocked', '歌声时长超过配置上限');
    }
    let managedRuntimeStopped = false;
    const stopManagedRuntimeOnAbort = () => {
      if (managedRuntimeStopped) return;
      managedRuntimeStopped = true;
      this.options.managedRuntime?.stop?.();
    };
    if (input.signal?.aborted) stopManagedRuntimeOnAbort();
    else input.signal?.addEventListener('abort', stopManagedRuntimeOnAbort, { once: true });
    const usesManagedRuntime = !this.options.config.singingApiUrl?.trim()
      && !this.options.config.singingApiToken?.trim();
    const { base, token } = await this.resolveEndpoint(input.signal);
    try {
    const requestSha256 = canonicalRequestSha256(input);
    let peakVramMiB = this.options.readGpuMemoryMiB?.();
    const sampleGpu = () => {
      const current = this.options.readGpuMemoryMiB?.();
      if (current !== undefined) peakVramMiB = peakVramMiB === undefined ? current : Math.max(peakVramMiB, current);
    };
    const reference = this.resolveReferenceVoice();
    const released = await this.postJson(base, token, 'release_task', {
      prompt: input.prompt,
      lyrics: input.lyrics,
      vocal_language: input.vocalLanguage,
      // ACE-Step/torchaudio 在不同平台可用的编码后端不同；稳定要求模型只
      // 生成 WAV，再由 Suite 受管 FFmpeg 统一转成渠道需要的 Ogg/Opus。
      audio_format: 'wav',
      audio_duration: input.durationSeconds,
      model: this.options.config.singingModel,
      // Bridge 已经完成风格、歌词、语言和时长的受限裁决；这里使用 ACE-Step
      // 官方直接 DiT 路径，避免低显存设备再启动 LM 补写元数据或生成语义码。
      // 这条路径仍由独立歌声模型合成，不会降级为普通 TTS。
      thinking: false,
      use_cot_caption: false,
      use_cot_language: false,
      batch_size: 1,
      ...(reference.referenceAudioPath ? { reference_audio_path: reference.referenceAudioPath } : {}),
    }, input.signal);
    const releaseData = safeRecord(released.data);
    const taskId = typeof releaseData?.task_id === 'string' ? releaseData.task_id.trim() : '';
    if (!/^[A-Za-z0-9._-]{8,128}$/u.test(taskId)) throw new Error('singing_task_id_invalid');

    const deadline = Date.now() + this.options.config.singingTimeoutMs;
    let audioPath = '';
    while (Date.now() < deadline) {
      await sleepWithAbort(this.options.pollIntervalMs ?? 750, input.signal);
      sampleGpu();
      const queried = await this.postJson(base, token, 'query_result', { task_id_list: [taskId] }, input.signal);
      const entries = Array.isArray(queried.data) ? queried.data : [];
      const task = entries.map(safeRecord).find((item) => item?.task_id === taskId);
      const status = Number(task?.status);
      if (status === 2) throw new Error('singing_generation_failed');
      if (status !== 1) continue;
      const rawResult = typeof task?.result === 'string' ? JSON.parse(task.result) as unknown : task?.result;
      const results = Array.isArray(rawResult) ? rawResult.map(safeRecord).filter(Boolean) : [];
      const success = results.find((item) => Number(item?.status) === 1 && typeof item?.file === 'string');
      audioPath = typeof success?.file === 'string' ? success.file.trim() : '';
      break;
    }
    if (!audioPath) throw new RuntimeSpeechError('singing_timeout', 'error', '歌声生成超时');
    const audioUrl = new URL(audioPath, base);
    if (audioUrl.origin !== base.origin || audioUrl.pathname !== '/v1/audio') throw new Error('singing_audio_url_invalid');
    const response = await (this.options.fetchImpl || fetch)(audioUrl, {
      headers: this.headers(token), signal: input.signal, redirect: 'error',
    });
    if (!response.ok) throw new Error('singing_audio_download_failed');
    const outputRoot = this.resolveOutputRoot(input.scratchDir);
    const sourcePath = path.join(outputRoot, `${crypto.randomUUID()}.wav`);
    const outputPath = path.join(outputRoot, `${crypto.randomUUID()}.ogg`);
    await writeBoundedBody(
      response,
      maxIntermediateWavBytes(input.durationSeconds, this.options.config.maxInputBytes),
      sourcePath,
    );
    try {
      const ffmpeg = resolveExecutableDependency({
        id: 'ffmpeg', displayName: 'FFmpeg', explicitPath: this.options.config.ffmpegPath,
        runtimeDepsRoot: this.options.runtimeDepsRoot, componentIds: ['ffmpeg_runtime', 'ffmpeg'],
      });
      const ffprobe = resolveExecutableDependency({
        id: 'ffprobe', displayName: 'ffprobe', explicitPath: this.options.config.ffprobePath,
        runtimeDepsRoot: this.options.runtimeDepsRoot, componentIds: ['ffmpeg_runtime', 'ffprobe'],
      });
      if (ffmpeg.state !== 'ready' || !ffmpeg.path) throw new RuntimeSpeechError(ffmpeg.diagnosticCode || 'ffmpeg_missing', 'blocked', 'FFmpeg 不可用');
      if (ffprobe.state !== 'ready' || !ffprobe.path) throw new RuntimeSpeechError(ffprobe.diagnosticCode || 'ffprobe_missing', 'blocked', 'ffprobe 不可用');
      const source = await (this.options.validateAudioImpl || validateAudio)({
        filePath: sourcePath,
        ffprobePath: ffprobe.path,
        maxBytes: maxIntermediateWavBytes(input.durationSeconds, this.options.config.maxInputBytes),
        maxDurationMs: this.options.config.maxSongDurationSeconds * 1000,
        timeoutMs: this.options.config.requestTimeoutMs,
        signal: input.signal,
      });
      if (source.format !== 'wav') throw new Error('singing_source_not_wav');
      await (this.options.wavToMonoOpusImpl || wavToMonoOpus)({
        ffmpegPath: ffmpeg.path,
        sourcePath,
        outputPath,
        timeoutMs: this.options.config.requestTimeoutMs,
        signal: input.signal,
      });
      const inspected = await (this.options.validateAudioImpl || validateAudio)({
        filePath: outputPath,
        ffprobePath: ffprobe.path,
        maxBytes: this.options.config.maxInputBytes,
        maxDurationMs: this.options.config.maxSongDurationSeconds * 1000,
        timeoutMs: this.options.config.requestTimeoutMs,
        signal: input.signal,
      });
      if (inspected.format !== 'ogg' || inspected.codec?.toLowerCase() !== 'opus') throw new Error('singing_output_not_opus');
      const receipt: RuntimeSingingSynthesisReceipt = {
        protocol: 'cti-singing-synthesis/v1',
        path: inspected.path,
        mediaType: 'audio/ogg; codecs=opus',
        format: 'opus',
        durationMs: inspected.durationMs,
        requestSha256,
        fileSha256: hashFileSha256(inspected.path),
        validated: true,
        ...(peakVramMiB !== undefined ? { peakVramMiB } : {}),
        ...(reference.voiceProfileId ? { voiceProfileId: reference.voiceProfileId } : {}),
      };
      this.managed.set(path.resolve(receipt.path), { outputRoot, requestSha256, fileSha256: receipt.fileSha256 });
      return receipt;
    } catch (error) {
      try { fs.unlinkSync(outputPath); } catch { /* 失败产物不可投递。 */ }
      throw error;
    } finally {
      try { fs.unlinkSync(sourcePath); } catch { /* 中间 WAV 不进入交付与缓存。 */ }
    }
    } finally {
      input.signal?.removeEventListener('abort', stopManagedRuntimeOnAbort);
      // 受管 ACE-Step 只在单次歌声动作中占用 GPU；产物已下载到受管目录后
      // 即释放进程，避免下一次普通 TTS 重建时两个模型同时常驻。
      if (usesManagedRuntime) stopManagedRuntimeOnAbort();
    }
  }

  releaseSynthesis(receipt: RuntimeSingingSynthesisReceipt): void {
    const absolute = path.resolve(receipt.path || '');
    const managed = this.managed.get(absolute);
    if (!managed
      || receipt.protocol !== 'cti-singing-synthesis/v1'
      || receipt.validated !== true
      || managed.requestSha256 !== receipt.requestSha256
      || managed.fileSha256 !== receipt.fileSha256
      || !isWithinRoot(absolute, managed.outputRoot)) {
      throw new RuntimeSpeechError('singing_release_rejected', 'blocked', '歌声产物释放被拒绝');
    }
    assertRegularNonSymlink(absolute);
    if (hashFileSha256(absolute) !== receipt.fileSha256) throw new RuntimeSpeechError('singing_release_hash_mismatch', 'blocked', '歌声产物已变化');
    fs.unlinkSync(absolute);
    this.managed.delete(absolute);
  }
}
