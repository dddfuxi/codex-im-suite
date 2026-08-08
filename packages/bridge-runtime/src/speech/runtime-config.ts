import path from 'node:path';

import {
  DEFAULT_TONE_POLICY_ID,
  DEFAULT_TTS_MODEL_ID,
  DEFAULT_TTS_PROVIDER_ID,
  DEFAULT_TTS_VOICE_PROFILE_ID,
  findSpeechModel,
} from './speech-model-catalog.js';
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
  const legacyTtsModel = optional(env, 'CTI_SPEECH_TTS_MODEL');
  const explicitModelId = optional(env, 'CTI_SPEECH_TTS_MODEL_ID');
  const migratedModelId = legacyTtsModel && findSpeechModel(legacyTtsModel) ? legacyTtsModel : undefined;
  const migratedModelPath = legacyTtsModel && path.isAbsolute(legacyTtsModel) ? legacyTtsModel : undefined;
  return {
    inputEnabled: bool(env, 'CTI_SPEECH_INPUT_ENABLED', false),
    outputEnabled: bool(env, 'CTI_SPEECH_OUTPUT_ENABLED', false),
    channels: channels(env),
    replyPolicy: id(env, 'CTI_SPEECH_REPLY_POLICY', 'explicit_or_inbound_audio'),
    deliveryMode: id(env, 'CTI_SPEECH_DELIVERY_MODE', 'voice_only'),
    asrProvider: id(env, 'CTI_SPEECH_ASR_PROVIDER', 'sensevoice_gguf'),
    ttsProvider: id(env, 'CTI_SPEECH_TTS_PROVIDER', DEFAULT_TTS_PROVIDER_ID),
    ttsModelId: explicitModelId && findSpeechModel(explicitModelId)
      ? explicitModelId
      : migratedModelId || DEFAULT_TTS_MODEL_ID,
    tonePolicy: id(env, 'CTI_SPEECH_TONE_POLICY', DEFAULT_TONE_POLICY_ID),
    modelRoot: optional(env, 'CTI_SPEECH_MODEL_ROOT'),
    senseVoiceBinaryPath: optional(env, 'CTI_SPEECH_SENSEVOICE_BINARY_PATH'),
    asrModel: optional(env, 'CTI_SPEECH_ASR_MODEL'),
    ttsModelPath: optional(env, 'CTI_SPEECH_TTS_MODEL_PATH') || migratedModelPath,
    ttsReferenceModelPath: optional(env, 'CTI_SPEECH_TTS_REFERENCE_MODEL_PATH')
      || optional(env, 'CTI_SPEECH_TTS_REFERENCE_MODEL'),
    voiceCloneBenchmarkPassed: bool(env, 'CTI_SPEECH_VOICE_CLONE_BENCHMARK_PASSED', false),
    voiceProfileId: optional(env, 'CTI_SPEECH_VOICE_PROFILE')
      || optional(env, 'CTI_SPEECH_ACTIVE_VOICE_PROFILE_ID')
      || DEFAULT_TTS_VOICE_PROFILE_ID,
    singingEnabled: bool(env, 'CTI_SINGING_ENABLED', false),
    singingProvider: id(env, 'CTI_SINGING_PROVIDER', 'ace_step_1_5'),
    singingApiUrl: optional(env, 'CTI_SINGING_API_URL'),
    singingApiToken: optional(env, 'CTI_SINGING_API_TOKEN'),
    singingVoiceProfileId: optional(env, 'CTI_SINGING_VOICE_PROFILE'),
    singingBenchmarkPassed: bool(env, 'CTI_SINGING_BENCHMARK_PASSED', false),
    singingModel: id(env, 'CTI_SINGING_MODEL', 'acestep-v15-turbo'),
    singingLmModel: id(env, 'CTI_SINGING_LM_MODEL', 'acestep-5Hz-lm-0.6B'),
    singingTimeoutMs: boundedInt(env, 'CTI_SINGING_TIMEOUT_MS', 600_000, 10_000, 1_800_000),
    maxSongDurationSeconds: boundedInt(env, 'CTI_SINGING_MAX_DURATION_SECONDS', 600, 10, 600),
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
    ['CTI_SPEECH_TTS_MODEL_ID', config.ttsModelId],
    ['CTI_SPEECH_TONE_POLICY', config.tonePolicy],
    ['CTI_SPEECH_MODEL_ROOT', config.modelRoot || ''],
    ['CTI_SPEECH_SENSEVOICE_BINARY_PATH', config.senseVoiceBinaryPath || ''],
    ['CTI_SPEECH_ASR_MODEL', config.asrModel || ''],
    ['CTI_SPEECH_TTS_MODEL_PATH', config.ttsModelPath || ''],
    ['CTI_SPEECH_TTS_REFERENCE_MODEL_PATH', config.ttsReferenceModelPath || ''],
    // v1 同名字段曾同时表示 ID 与路径；保存 v2 后清空，避免形成第二事实源。
    ['CTI_SPEECH_TTS_MODEL', ''],
    ['CTI_SPEECH_TTS_REFERENCE_MODEL', ''],
    ['CTI_SPEECH_VOICE_CLONE_BENCHMARK_PASSED', String(config.voiceCloneBenchmarkPassed)],
    ['CTI_SPEECH_VOICE_PROFILE', config.voiceProfileId || ''],
    ['CTI_SINGING_ENABLED', String(config.singingEnabled)],
    ['CTI_SINGING_PROVIDER', config.singingProvider],
    ['CTI_SINGING_API_URL', config.singingApiUrl || ''],
    ['CTI_SINGING_API_TOKEN', config.singingApiToken || ''],
    ['CTI_SINGING_VOICE_PROFILE', config.singingVoiceProfileId || ''],
    ['CTI_SINGING_BENCHMARK_PASSED', String(config.singingBenchmarkPassed)],
    ['CTI_SINGING_MODEL', config.singingModel],
    ['CTI_SINGING_LM_MODEL', config.singingLmModel],
    ['CTI_SINGING_TIMEOUT_MS', String(config.singingTimeoutMs)],
    ['CTI_SINGING_MAX_DURATION_SECONDS', String(config.maxSongDurationSeconds)],
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

