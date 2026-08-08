import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  ensureNonSymlinkDirectory,
  isWithinRoot,
} from './dependency-resolution.js';
import {
  RuntimeSpeechError,
  type SpeechRuntimeState,
} from './runtime-types.js';
import {
  MAX_SPEECH_PREVIEW_BYTES,
  MAX_SPEECH_PREVIEW_TEXT_CHARACTERS,
  SPEECH_PREVIEW_PROTOCOL,
  type SpeechPreviewReceipt,
} from './speech-preview.js';
import { SpeechSidecarInstanceLock } from './sidecar-runtime-diagnostics.js';

export const SPEECH_PREVIEW_CONTROL_PROTOCOL = 'cti-speech-preview-control/v2' as const;

const MAX_REQUEST_FILE_BYTES = 32 * 1024;
const MAX_RESPONSE_FILE_BYTES = Math.ceil(MAX_SPEECH_PREVIEW_BYTES * 4 / 3) + 64 * 1024;
// 普通试听仍由调用方使用短超时；歌声首次加载和 benchmark 需要更长上限。
// 该上限只约束受限、无路径的本机 mailbox，不放宽媒体或文本门禁。
const MAX_REQUEST_LIFETIME_MS = 15 * 60_000;
const STALE_FILE_AGE_MS = 10 * 60_000;

export interface SpeechPreviewControlRequest {
  protocol: typeof SPEECH_PREVIEW_CONTROL_PROTOCOL;
  requestId: string;
  clientNonce: string;
  action: 'preview_voice' | 'benchmark_voice' | 'preview_singing_voice' | 'benchmark_singing_voice';
  requestedAt: string;
  expiresAt: string;
  input: {
    text: string;
    modelId: string;
    voiceProfileId: string;
  };
}

export interface SpeechPreviewControlResponse {
  protocol: typeof SPEECH_PREVIEW_CONTROL_PROTOCOL;
  requestId: string;
  clientNonce: string;
  ok: boolean;
  result?: SpeechPreviewReceipt;
  errorCode?: string;
  status?: Exclude<SpeechRuntimeState, 'ready'>;
  error?: string;
  respondedAt: string;
}

interface SpeechPreviewControlDirectories {
  root: string;
  requests: string;
  responses: string;
}

function safeOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{7,79}$/iu.test(value);
}

function safeNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function safeVoiceProfileId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(value);
}

const safeModelId = safeVoiceProfileId;

function safePreviewText(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && Array.from(value).length <= MAX_SPEECH_PREVIEW_TEXT_CHARACTERS
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function controlDirectories(runtimeStateRoot: string): SpeechPreviewControlDirectories {
  const speechRoot = path.resolve(runtimeStateRoot);
  ensureNonSymlinkDirectory(speechRoot);
  const root = path.join(speechRoot, 'preview-control');
  const requests = path.join(root, 'requests');
  const responses = path.join(root, 'responses');
  for (const directory of [root, requests, responses]) ensureNonSymlinkDirectory(directory);
  return { root, requests, responses };
}

function assertOwnedPath(candidate: string, root: string): void {
  if (!isWithinRoot(candidate, root)) throw new Error('speech_preview_control_path_escape');
}

function writeJsonExclusive(filePath: string, value: unknown, root: string): void {
  assertOwnedPath(filePath, root);
  const tempPath = filePath + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  assertOwnedPath(tempPath, root);
  const descriptor = fs.openSync(tempPath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value) + '\n', { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    if (fs.existsSync(filePath)) throw new Error('speech_preview_control_collision');
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      const stat = fs.lstatSync(tempPath);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(tempPath);
    } catch {
      // 已完成 rename 或临时文件已不存在。
    }
  }
}

function readBoundedJson(filePath: string, maxBytes: number): unknown {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > maxBytes) {
    throw new Error('speech_preview_control_file_invalid');
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function validateRequest(
  value: unknown,
  expectedRequestId: string,
  nowMs: number,
): SpeechPreviewControlRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeSpeechError('speech_preview_request_invalid', 'blocked', '语音试听请求无效');
  }
  const request = value as Partial<SpeechPreviewControlRequest>;
  const requestedAt = typeof request.requestedAt === 'string' ? Date.parse(request.requestedAt) : Number.NaN;
  const expiresAt = typeof request.expiresAt === 'string' ? Date.parse(request.expiresAt) : Number.NaN;
  if (
    request.protocol !== SPEECH_PREVIEW_CONTROL_PROTOCOL
    || (request.action !== 'preview_voice' && request.action !== 'benchmark_voice'
      && request.action !== 'preview_singing_voice' && request.action !== 'benchmark_singing_voice')
    || request.requestId !== expectedRequestId
    || !safeOpaqueId(request.requestId)
    || !safeNonce(request.clientNonce)
    || !Number.isFinite(requestedAt)
    || !Number.isFinite(expiresAt)
    || requestedAt > nowMs + 5_000
    || expiresAt <= nowMs
    || expiresAt <= requestedAt
    || expiresAt - requestedAt > MAX_REQUEST_LIFETIME_MS
    || !request.input
    || !safePreviewText(request.input.text)
    || !safeModelId(request.input.modelId)
    || !safeVoiceProfileId(request.input.voiceProfileId)
  ) {
    throw new RuntimeSpeechError('speech_preview_request_invalid', 'blocked', '语音试听请求无效或已过期');
  }
  return request as SpeechPreviewControlRequest;
}

function validatePreviewReceipt(
  value: unknown,
  expectedModelId: string,
  expectedVoiceProfileId: string,
  benchmark = false,
): SpeechPreviewReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeSpeechError('speech_preview_response_invalid', 'error', '语音试听响应无效');
  }
  const receipt = value as Partial<SpeechPreviewReceipt>;
  const expectedKeys = [
    'base64', 'bytes', 'durationMs', 'mediaType', 'modelId',
    ...(benchmark ? ['modelRevision', 'peakVramMiB'] : []),
    'protocol', 'sha256', 'validated', 'voiceProfileId',
  ];
  if (
    Object.keys(receipt).sort().join('\n') !== expectedKeys.join('\n')
    ||
    receipt.protocol !== SPEECH_PREVIEW_PROTOCOL
    || receipt.mediaType !== 'audio/ogg; codecs=opus'
    || receipt.validated !== true
    || receipt.modelId !== expectedModelId
    || receipt.voiceProfileId !== expectedVoiceProfileId
    || (benchmark && (typeof receipt.modelRevision !== 'string'
      || !/^[a-z0-9][a-z0-9._-]{0,159}$/iu.test(receipt.modelRevision)
      || !Number.isFinite(receipt.peakVramMiB)
      || receipt.peakVramMiB! < 0))
    || typeof receipt.base64 !== 'string'
    || receipt.base64.length === 0
    || receipt.base64.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(receipt.base64)
    || !Number.isSafeInteger(receipt.bytes)
    || receipt.bytes! <= 0
    || receipt.bytes! > MAX_SPEECH_PREVIEW_BYTES
    || typeof receipt.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(receipt.sha256)
    || !Number.isFinite(receipt.durationMs)
    || receipt.durationMs! <= 0
  ) {
    throw new RuntimeSpeechError('speech_preview_response_invalid', 'error', '语音试听响应无效');
  }
  const media = Buffer.from(receipt.base64, 'base64');
  const sha256 = crypto.createHash('sha256').update(media).digest('hex');
  if (
    media.length !== receipt.bytes
    || media.toString('base64') !== receipt.base64
    || sha256 !== receipt.sha256
  ) {
    throw new RuntimeSpeechError('speech_preview_response_invalid', 'error', '语音试听媒体校验失败');
  }
  // 上面的完整门禁已经把可选 DTO 字段收窄为确定值；重新构造安全回执，
  // 避免把 Runtime 返回对象上的额外字段跨过控制面板边界。
  const bytes = receipt.bytes as number;
  const durationMs = receipt.durationMs as number;
  return {
    protocol: SPEECH_PREVIEW_PROTOCOL,
    mediaType: 'audio/ogg; codecs=opus',
    base64: receipt.base64,
    bytes,
    sha256: receipt.sha256,
    durationMs,
    modelId: receipt.modelId,
    voiceProfileId: receipt.voiceProfileId,
    ...(benchmark ? { modelRevision: receipt.modelRevision!, peakVramMiB: receipt.peakVramMiB! } : {}),
    validated: true,
  };
}

function runtimeFailure(error: unknown): RuntimeSpeechError {
  if (error instanceof RuntimeSpeechError) return error;
  return new RuntimeSpeechError('speech_preview_failed', 'error', '语音试听失败');
}

function cleanupStaleFiles(directories: SpeechPreviewControlDirectories, nowMs: number): void {
  const cutoff = nowMs - STALE_FILE_AGE_MS;
  for (const directory of [directories.requests, directories.responses]) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || (!entry.name.endsWith('.json') && !entry.name.includes('.processing-'))) continue;
      const candidate = path.join(directory, entry.name);
      try {
        assertOwnedPath(candidate, directory);
        const stat = fs.lstatSync(candidate);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs <= cutoff) fs.unlinkSync(candidate);
      } catch {
        // 过期清理只处理可证明归属的普通文件。
      }
    }
  }
}

export function startSpeechPreviewControlService(options: {
  runtimeStateRoot: string;
  previewVoice: (input: {
    text: string;
    modelId: string;
    voiceProfileId: string;
    signal: AbortSignal;
  }) => Promise<SpeechPreviewReceipt>;
  benchmarkVoice?: (input: {
    text: string;
    modelId: string;
    voiceProfileId: string;
    signal: AbortSignal;
  }) => Promise<SpeechPreviewReceipt>;
  previewSingingVoice?: (input: {
    text: string;
    modelId: string;
    voiceProfileId: string;
    signal: AbortSignal;
  }) => Promise<SpeechPreviewReceipt>;
  benchmarkSingingVoice?: (input: {
    text: string;
    modelId: string;
    voiceProfileId: string;
    signal: AbortSignal;
  }) => Promise<SpeechPreviewReceipt>;
  pollMs?: number;
  now?: () => Date;
}): {
  stop(): void;
  pollNow(): Promise<void>;
  isRunning(): boolean;
} {
  const directories = controlDirectories(options.runtimeStateRoot);
  const consumerLock = new SpeechSidecarInstanceLock(
    directories.root,
    'consumer-' + crypto.randomUUID(),
  );
  consumerLock.acquire();
  const now = options.now || (() => new Date());
  let stopped = false;
  let pumping = false;
  let currentAbort: AbortController | undefined;

  cleanupStaleFiles(directories, now().getTime());

  const pollNow = async () => {
    if (stopped || pumping) return;
    pumping = true;
    try {
      const names = fs.readdirSync(directories.requests)
        .filter((name) => name.endsWith('.json'))
        .sort();
      for (const name of names) {
        if (stopped) break;
        const requestId = name.slice(0, -'.json'.length);
        if (!safeOpaqueId(requestId)) continue;
        const sourcePath = path.join(directories.requests, name);
        const processingPath = path.join(
          directories.requests,
          requestId + '.processing-' + consumerLock.runId,
        );
        assertOwnedPath(sourcePath, directories.requests);
        assertOwnedPath(processingPath, directories.requests);

        let outgoing: SpeechPreviewControlResponse | undefined;
        try {
          const stat = fs.lstatSync(sourcePath);
          if (stat.isSymbolicLink() || !stat.isFile()) continue;
          fs.renameSync(sourcePath, processingPath);
          const raw = readBoundedJson(processingPath, MAX_REQUEST_FILE_BYTES);
          const rawRecord = raw && typeof raw === 'object' && !Array.isArray(raw)
            ? raw as Partial<SpeechPreviewControlRequest>
            : {};
          try {
            const request = validateRequest(raw, requestId, now().getTime());
            currentAbort = new AbortController();
            const expiresAt = Date.parse(request.expiresAt);
            const expiryTimer = setTimeout(
              () => currentAbort?.abort(new Error('speech_preview_request_expired')),
              Math.max(0, expiresAt - now().getTime()),
            );
            expiryTimer.unref?.();
            try {
              const preview = request.action === 'preview_singing_voice'
                ? options.previewSingingVoice
                : request.action === 'benchmark_singing_voice'
                  ? options.benchmarkSingingVoice
                : request.action === 'benchmark_voice'
                  ? options.benchmarkVoice
                  : options.previewVoice;
              if (!preview) throw new RuntimeSpeechError('singing_preview_live_runtime_unavailable', 'blocked', '实时歌声试听通道不可用');
              const result = await preview({
                ...request.input,
                signal: currentAbort.signal,
              });
              if (!stopped && now().getTime() < expiresAt) {
                outgoing = {
                  protocol: SPEECH_PREVIEW_CONTROL_PROTOCOL,
                  requestId,
                  clientNonce: request.clientNonce,
                  ok: true,
                  result: validatePreviewReceipt(
                    result,
                    request.input.modelId,
                    request.input.voiceProfileId,
                    request.action === 'benchmark_voice' || request.action === 'benchmark_singing_voice',
                  ),
                  respondedAt: now().toISOString(),
                };
              }
            } finally {
              clearTimeout(expiryTimer);
              currentAbort = undefined;
            }
          } catch (error) {
            const failure = runtimeFailure(error);
            if (
              !stopped
              && safeNonce(rawRecord.clientNonce)
              && typeof rawRecord.expiresAt === 'string'
              && now().getTime() < Date.parse(rawRecord.expiresAt)
            ) {
              outgoing = {
                protocol: SPEECH_PREVIEW_CONTROL_PROTOCOL,
                requestId,
                clientNonce: rawRecord.clientNonce,
                ok: false,
                errorCode: failure.code,
                status: failure.status,
                error: failure.message,
                respondedAt: now().toISOString(),
              };
            }
          }
          if (outgoing) {
            const responsePath = path.join(directories.responses, requestId + '.json');
            writeJsonExclusive(responsePath, outgoing, directories.responses);
          }
        } catch {
          // 非普通文件、竞争消费或写回失败均失败关闭；不猜测请求归属。
        } finally {
          currentAbort = undefined;
          try {
            const stat = fs.lstatSync(processingPath);
            if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(processingPath);
          } catch {
            // 请求可能未成功改名或已经清理。
          }
        }
      }
      cleanupStaleFiles(directories, now().getTime());
    } finally {
      pumping = false;
      if (stopped) consumerLock.release();
    }
  };

  const timer = setInterval(() => { void pollNow(); }, Math.max(50, options.pollMs ?? 100));
  timer.unref?.();
  void pollNow();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      currentAbort?.abort(new Error('speech_preview_service_stopped'));
      if (!pumping) consumerLock.release();
    },
    pollNow,
    isRunning: () => !stopped,
  };
}

async function requestPreview(input: {
  runtimeStateRoot: string;
  text: string;
  modelId: string;
  voiceProfileId: string;
  timeoutMs: number;
  action: SpeechPreviewControlRequest['action'];
  now?: () => Date;
}): Promise<SpeechPreviewReceipt> {
  if (!safePreviewText(input.text) || !safeModelId(input.modelId) || !safeVoiceProfileId(input.voiceProfileId)) {
    throw new RuntimeSpeechError('speech_preview_request_invalid', 'blocked', '语音试听参数无效');
  }
  const directories = controlDirectories(input.runtimeStateRoot);
  const now = input.now || (() => new Date());
  const timeoutMs = Math.max(100, Math.min(MAX_REQUEST_LIFETIME_MS, Math.trunc(input.timeoutMs)));
  const requestId = 'preview-' + crypto.randomUUID();
  const clientNonce = crypto.randomBytes(32).toString('base64url');
  const requestedAt = now();
  const request: SpeechPreviewControlRequest = {
    protocol: SPEECH_PREVIEW_CONTROL_PROTOCOL,
    requestId,
    clientNonce,
    action: input.action,
    requestedAt: requestedAt.toISOString(),
    expiresAt: new Date(requestedAt.getTime() + timeoutMs).toISOString(),
    input: {
      text: input.text,
      modelId: input.modelId,
      voiceProfileId: input.voiceProfileId,
    },
  };
  const requestPath = path.join(directories.requests, requestId + '.json');
  const responsePath = path.join(directories.responses, requestId + '.json');
  writeJsonExclusive(requestPath, request, directories.requests);

  const deadline = requestedAt.getTime() + timeoutMs;
  try {
    while (now().getTime() < deadline) {
      if (fs.existsSync(responsePath)) {
        let raw: unknown;
        try {
          raw = readBoundedJson(responsePath, MAX_RESPONSE_FILE_BYTES);
        } finally {
          try {
            const stat = fs.lstatSync(responsePath);
            if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(responsePath);
          } catch {
            // 只清理当前随机 requestId 对应的普通响应文件。
          }
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new RuntimeSpeechError('speech_preview_response_invalid', 'error', '语音试听响应无效');
        }
        const response = raw as Partial<SpeechPreviewControlResponse>;
        if (
          response.protocol !== SPEECH_PREVIEW_CONTROL_PROTOCOL
          || response.requestId !== requestId
          || response.clientNonce !== clientNonce
          || typeof response.respondedAt !== 'string'
          || !Number.isFinite(Date.parse(response.respondedAt))
        ) {
          throw new RuntimeSpeechError('speech_preview_response_owner_mismatch', 'blocked', '语音试听响应归属校验失败');
        }
        if (!response.ok) {
          const code = typeof response.errorCode === 'string' && /^[a-z0-9_]{1,80}$/iu.test(response.errorCode)
            ? response.errorCode
            : 'speech_preview_failed';
          const status = response.status === 'blocked' || response.status === 'optional_missing'
            ? response.status
            : 'error';
          throw new RuntimeSpeechError(
            code,
            status,
            typeof response.error === 'string' && response.error.length <= 200
              ? response.error
              : '语音试听失败',
          );
        }
        return validatePreviewReceipt(
          response.result,
          input.modelId,
          input.voiceProfileId,
          input.action === 'benchmark_voice' || input.action === 'benchmark_singing_voice',
        );
      }
      // CLI 通过 Promise 完成后才输出唯一 JSON 回执；这里的等待句柄必须保持
      // 进程存活，否则没有其他活动句柄时 Node 会以退出码 0 静默提前结束。
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    }
    throw new RuntimeSpeechError(
      'speech_preview_live_timeout',
      'error',
      '实时 Bridge 未在限定时间内返回语音试听',
    );
  } finally {
    try {
      const stat = fs.lstatSync(requestPath);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(requestPath);
    } catch {
      // consumer 已取走请求或请求文件已不存在。
    }
  }
}

export function requestSpeechVoicePreview(input: {
  runtimeStateRoot: string;
  text: string;
  modelId: string;
  voiceProfileId: string;
  timeoutMs: number;
  now?: () => Date;
}): Promise<SpeechPreviewReceipt> {
  return requestPreview({ ...input, action: 'preview_voice' });
}

export function requestSpeechVoiceBenchmark(input: {
  runtimeStateRoot: string;
  text: string;
  modelId: string;
  voiceProfileId: string;
  timeoutMs: number;
  now?: () => Date;
}): Promise<SpeechPreviewReceipt> {
  return requestPreview({ ...input, action: 'benchmark_voice' });
}

export function requestSingingVoicePreview(input: {
  runtimeStateRoot: string;
  text: string;
  modelId: string;
  voiceProfileId: string;
  timeoutMs: number;
  now?: () => Date;
}): Promise<SpeechPreviewReceipt> {
  return requestPreview({ ...input, action: 'preview_singing_voice' });
}

export function requestSingingVoiceBenchmark(input: {
  runtimeStateRoot: string;
  text: string;
  modelId: string;
  voiceProfileId: string;
  timeoutMs: number;
  now?: () => Date;
}): Promise<SpeechPreviewReceipt> {
  return requestPreview({ ...input, action: 'benchmark_singing_voice' });
}

export function getSpeechPreviewControlDirectories(runtimeStateRoot: string) {
  return controlDirectories(runtimeStateRoot);
}
