import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CTI_HOME, hydrateProcessEnvironmentFromConfigFile, loadConfig, saveConfig } from '../config.js';
import { createSpeechRuntime } from './speech-runtime.js';
import { RuntimeSpeechError } from './runtime-types.js';
import { SpeechControlService } from './speech-control-service.js';
import { requestSingingVoicePreview, requestSpeechVoicePreview } from './speech-preview-control.js';

function decodePayload(argv: string[]): unknown {
  if (argv.length === 0) return {};
  if (argv.length !== 2 || argv[0] !== '--input-json') throw new RuntimeSpeechError('speech_cli_arguments_invalid', 'blocked', '语音命令参数格式无效');
  if (argv[1].length > 512 * 1024) throw new RuntimeSpeechError('speech_payload_too_large', 'blocked', '语音命令参数过大');
  try {
    return JSON.parse(Buffer.from(argv[1], 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new RuntimeSpeechError('speech_payload_invalid', 'blocked', '语音命令参数无效');
  }
}
export function resolveSpeechSkillRoot(moduleFilePath: string): string {
  const moduleDir = path.dirname(path.resolve(moduleFilePath));
  const parentDir = path.dirname(moduleDir);
  // 源码入口位于 src/speech，bundle 位于 dist；两者最终都必须回到 package 根。
  return path.basename(moduleDir).toLowerCase() === 'speech'
      && path.basename(parentDir).toLowerCase() === 'src'
    ? path.dirname(parentDir)
    : parentDir;
}

export async function runSpeechControlCli(argv: string[]): Promise<unknown> {
  hydrateProcessEnvironmentFromConfigFile();
  const config = loadConfig();
  if (!config.speech) throw new RuntimeSpeechError('speech_config_unavailable', 'error', '语音配置未接入 Runtime');
  const skillRoot = resolveSpeechSkillRoot(fileURLToPath(import.meta.url));
  const runtime = createSpeechRuntime({ config: config.speech, ctiHome: CTI_HOME, skillRoot });
  try {
    const service = new SpeechControlService({
      config: config.speech,
      status: runtime.status,
      voiceRegistry: runtime.voiceRegistry,
      dependencies: runtime.dependencies,
      saveConfig: (speech) => saveConfig({ ...config, speech }),
      // CLI 可能与长期 live Bridge 并发；禁止为刷新面板再启动第二个模型 Sidecar。
      probeSidecar: false,
      readLiveStatus: runtime.readLiveStatus,
      previewVoice: ({ text, voiceProfileId }) => requestSpeechVoicePreview({
        runtimeStateRoot: path.join(CTI_HOME, 'runtime', 'speech'),
        text,
        voiceProfileId,
        // C# 网关总超时为 120 秒；为清理与 JSON 回传预留固定余量。
        timeoutMs: Math.min(110_000, config.speech!.requestTimeoutMs + 10_000),
      }),
      previewSingingVoice: ({ text, voiceProfileId }) => requestSingingVoicePreview({
        runtimeStateRoot: path.join(CTI_HOME, 'runtime', 'speech'),
        text,
        voiceProfileId,
        timeoutMs: Math.min(110_000, config.speech!.singingTimeoutMs + 10_000),
      }),
    });
    return await service.execute(argv[0] || '', decodePayload(argv.slice(1)));
  } finally {
    await runtime.host.stop();
  }
}

function isDirectExecution(): boolean {
  return process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}

if (isDirectExecution()) {
  runSpeechControlCli(process.argv.slice(2)).then(
    (data) => process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`),
    (error) => {
      const runtimeError = error instanceof RuntimeSpeechError
        ? error
        : new RuntimeSpeechError(
          error instanceof Error && /^[a-z0-9_]+$/i.test(error.message) ? error.message : 'speech_control_failed',
          'error',
          '语音控制命令执行失败',
        );
      process.stdout.write(`${JSON.stringify({ ok: false, errorCode: runtimeError.code, error: runtimeError.message })}\n`);
      process.exitCode = 1;
    },
  );
}

