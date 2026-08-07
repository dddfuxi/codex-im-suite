import type { SpeechRuntimeConfig } from './runtime-types.js';

const DEFAULT_MAX_INPUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_DURATION_MS = 300_000;

function bool(env: ReadonlyMap<string, string>, key: string, fallback: boolean): boolean {
  const value = env.get(key)?.trim().toLowerCase();
  return value === undefined || value === '' ? fallback : value === 'true';
}
function boundedInt(
  env: ReadonlyMap<string, string>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number.parseInt(env.get(key) || '', 10);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function id(env: ReadonlyMap<string, string>, key: string, fallback: string): string {
  const value = env.get(key)?.trim();
  return value && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value) ? value : fallback;
}

function optional(env: ReadonlyMap<string, string>, key: string): string | undefined {
  return env.get(key)?.trim() || undefined;
}

function channels(env: ReadonlyMap<string, string>): string[] {
  const values = (env.get('CTI_SPEECH_CHANNELS') || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[a-z0-9._-]+$/.test(item));
  return values.length > 0 ? [...new Set(values)] : ['feishu'];
}

/** 语音默认关闭；启用后才把缺依赖提升为语音链路阻塞，不影响普通文本 Bridge。 */
export function loadSpeechRuntimeConfig(env: ReadonlyMap<string, string>): SpeechRuntimeConfig {
  return {
    inputEnabled: bool(env, 'CTI_SPEECH_INPUT_ENABLED', false),
    outputEnabled: bool(env, 'CTI_SPEECH_OUTPUT_ENABLED', false),
    channels: channels(env),
    replyPolicy: id(env, 'CTI_SPEECH_REPLY_POLICY', 'explicit_or_inbound_audio'),
    deliveryMode: id(env, 'CTI_SPEECH_DELIVERY_MODE', 'voice_only'),
    asrProvider: id(env, 'CTI_SPEECH_ASR_PROVIDER', 'sensevoice_gguf'),
    ttsProvider: id(env, 'CTI_SPEECH_TTS_PROVIDER', 'cosyvoice'),
    modelRoot: optional(env, 'CTI_SPEECH_MODEL_ROOT'),
    senseVoiceBinaryPath: optional(env, 'CTI_SPEECH_SENSEVOICE_BINARY_PATH'),
    asrModel: optional(env, 'CTI_SPEECH_ASR_MODEL'),
    ttsModel: optional(env, 'CTI_SPEECH_TTS_MODEL'),
    ttsReferenceModel: optional(env, 'CTI_SPEECH_TTS_REFERENCE_MODEL'),
    voiceCloneBenchmarkPassed: bool(env, 'CTI_SPEECH_VOICE_CLONE_BENCHMARK_PASSED', false),
    voiceProfileId: optional(env, 'CTI_SPEECH_VOICE_PROFILE')
      || optional(env, 'CTI_SPEECH_ACTIVE_VOICE_PROFILE_ID'),
    ffmpegPath: optional(env, 'CTI_SPEECH_FFMPEG_PATH'),
    ffprobePath: optional(env, 'CTI_SPEECH_FFPROBE_PATH'),
    pythonPath: optional(env, 'CTI_SPEECH_PYTHON_PATH'),
    sidecarPath: optional(env, 'CTI_SPEECH_SIDECAR_PATH'),
    requestTimeoutMs: boundedInt(env, 'CTI_SPEECH_REQUEST_TIMEOUT_MS', 90_000, 1_000, 600_000),
    startupTimeoutMs: boundedInt(env, 'CTI_SPEECH_STARTUP_TIMEOUT_MS', 20_000, 1_000, 120_000),
    maxInputBytes: boundedInt(env, 'CTI_SPEECH_MAX_INPUT_BYTES', DEFAULT_MAX_INPUT_BYTES, 1_024, DEFAULT_MAX_INPUT_BYTES),
    maxDurationMs: boundedInt(env, 'CTI_SPEECH_MAX_DURATION_MS', DEFAULT_MAX_DURATION_MS, 1_000, DEFAULT_MAX_DURATION_MS),
    maxTextChars: boundedInt(env, 'CTI_SPEECH_MAX_TEXT_CHARS', 2_000, 1, 20_000),
  };
}

export function speechConfigToEnvEntries(config: SpeechRuntimeConfig): Array<[string, string]> {
  return [
    ['CTI_SPEECH_INPUT_ENABLED', String(config.inputEnabled)],
    ['CTI_SPEECH_OUTPUT_ENABLED', String(config.outputEnabled)],
    ['CTI_SPEECH_CHANNELS', config.channels.join(',')],
    ['CTI_SPEECH_REPLY_POLICY', config.replyPolicy],
    ['CTI_SPEECH_DELIVERY_MODE', config.deliveryMode],
    ['CTI_SPEECH_ASR_PROVIDER', config.asrProvider],
    ['CTI_SPEECH_TTS_PROVIDER', config.ttsProvider],
    ['CTI_SPEECH_MODEL_ROOT', config.modelRoot || ''],
    ['CTI_SPEECH_SENSEVOICE_BINARY_PATH', config.senseVoiceBinaryPath || ''],
    ['CTI_SPEECH_ASR_MODEL', config.asrModel || ''],
    ['CTI_SPEECH_TTS_MODEL', config.ttsModel || ''],
    ['CTI_SPEECH_TTS_REFERENCE_MODEL', config.ttsReferenceModel || ''],
    ['CTI_SPEECH_VOICE_CLONE_BENCHMARK_PASSED', String(config.voiceCloneBenchmarkPassed)],
    ['CTI_SPEECH_VOICE_PROFILE', config.voiceProfileId || ''],
    ['CTI_SPEECH_FFMPEG_PATH', config.ffmpegPath || ''],
    ['CTI_SPEECH_FFPROBE_PATH', config.ffprobePath || ''],
    ['CTI_SPEECH_PYTHON_PATH', config.pythonPath || ''],
    ['CTI_SPEECH_SIDECAR_PATH', config.sidecarPath || ''],
    ['CTI_SPEECH_REQUEST_TIMEOUT_MS', String(config.requestTimeoutMs)],
    ['CTI_SPEECH_STARTUP_TIMEOUT_MS', String(config.startupTimeoutMs)],
    ['CTI_SPEECH_MAX_INPUT_BYTES', String(config.maxInputBytes)],
    ['CTI_SPEECH_MAX_DURATION_MS', String(config.maxDurationMs)],
    ['CTI_SPEECH_MAX_TEXT_CHARS', String(config.maxTextChars)],
  ];
}

