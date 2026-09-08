import fs from 'node:fs';
import path from 'node:path';

import { runNoShell } from './subprocess.js';
import type { SpeechRuntimeConfig } from './runtime-types.js';

export interface SingingLyricsTranscript {
  text: string;
  language: string;
  model: string;
  provider: string;
}

export interface SingingLyricsVerifier {
  transcribe(input: { candidatePath: string; signal?: AbortSignal }): Promise<SingingLyricsTranscript>;
}

type WslRunner = typeof runNoShell;

const WSL_DISTRIBUTION = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const WSL_EXECUTABLE = /^(?:\/[a-z0-9._+\/-]{0,255}|[a-z0-9._+-]{1,64})$/i;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const LANGUAGE = /^[a-z]{2,16}$/i;

function safeRegularFile(value: string | undefined, code: string): string {
  if (!value || !path.isAbsolute(value)) throw new Error(code);
  try {
    const candidate = path.resolve(value);
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync.native(candidate) !== candidate) throw new Error(code);
    return candidate;
  } catch {
    throw new Error(code);
  }
}

function safeRegularDirectory(value: string | undefined, code: string): string {
  if (!value || !path.isAbsolute(value)) throw new Error(code);
  try {
    const candidate = path.resolve(value);
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(candidate) !== candidate) throw new Error(code);
    return candidate;
  } catch {
    throw new Error(code);
  }
}

function parseWslPath(value: string): string {
  const normalized = value.trim();
  if (!normalized || !normalized.startsWith('/') || normalized.includes('\0') || /[\r\n]/u.test(normalized)) {
    throw new Error('singing_lyrics_verifier_wsl_path_invalid');
  }
  return normalized;
}

function verifyTranscript(value: unknown): SingingLyricsTranscript {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('singing_lyrics_verifier_response_invalid');
  const record = value as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  const language = typeof record.language === 'string' ? record.language.trim().toLowerCase() : '';
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
  if (!text || text.length > 100_000 || !LANGUAGE.test(language) || !MODEL_ID.test(model) || provider !== 'fireredasr2_aed_wsl') {
    throw new Error('singing_lyrics_verifier_response_invalid');
  }
  return { text, language, model, provider };
}

/**
 * 演唱歌词验收与日常 ASR 分离：FireRed 仅在生成歌声后按需启动，避免与
 * Windows Sidecar / ACE-Step 同时占用 GPU，也不会把 WSL 可选依赖变成普通语音必需项。
 */
export class FireRedAsr2WslLyricsVerifier implements SingingLyricsVerifier {
  constructor(private readonly options: {
    config: SpeechRuntimeConfig;
    scriptCandidates: string[];
    runner?: WslRunner;
  }) {}

  private get runner(): WslRunner { return this.options.runner || runNoShell; }

  private resolveDistro(): string {
    const value = this.options.config.singingLyricsVerifierWslDistro || 'UbuntuFireRed';
    if (!WSL_DISTRIBUTION.test(value)) throw new Error('singing_lyrics_verifier_wsl_distro_invalid');
    return value;
  }

  private resolvePython(): string {
    const value = this.options.config.singingLyricsVerifierWslPython || 'python3';
    if (!WSL_EXECUTABLE.test(value)) throw new Error('singing_lyrics_verifier_wsl_python_invalid');
    return value;
  }

  private resolveScript(): string {
    const explicit = this.options.config.singingLyricsVerifierScriptPath;
    if (explicit) return safeRegularFile(explicit, 'singing_lyrics_verifier_script_invalid');
    for (const candidate of this.options.scriptCandidates) {
      try { return safeRegularFile(candidate, 'singing_lyrics_verifier_script_invalid'); } catch { /* try next */ }
    }
    throw new Error('singing_lyrics_verifier_script_missing');
  }

  private async toWslPath(distro: string, windowsPath: string, signal?: AbortSignal): Promise<string> {
    const completed = await this.runner('wsl.exe', [
      '--distribution', distro, '--exec', 'wslpath', '-a', windowsPath,
    ], { signal, timeoutMs: this.options.config.requestTimeoutMs, maxOutputBytes: 4_096 });
    if (completed.code !== 0) throw new Error('singing_lyrics_verifier_wsl_unavailable');
    return parseWslPath(completed.stdout);
  }

  async transcribe(input: { candidatePath: string; signal?: AbortSignal }): Promise<SingingLyricsTranscript> {
    const distro = this.resolveDistro();
    const python = this.resolvePython();
    const candidatePath = safeRegularFile(input.candidatePath, 'singing_lyrics_verifier_audio_invalid');
    const modelPath = safeRegularDirectory(this.options.config.singingLyricsVerifierModelPath, 'singing_lyrics_verifier_model_missing');
    const scriptPath = this.resolveScript();
    const [candidate, model, script] = await Promise.all([
      this.toWslPath(distro, candidatePath, input.signal),
      this.toWslPath(distro, modelPath, input.signal),
      this.toWslPath(distro, scriptPath, input.signal),
    ]);
    const completed = await this.runner('wsl.exe', [
      '--distribution', distro, '--exec', python, script,
      '--audio-path', candidate,
      '--model-path', model,
    ], {
      signal: input.signal,
      timeoutMs: this.options.config.synthesisTimeoutMs,
      maxOutputBytes: 256 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    if (completed.code !== 0) throw new Error('singing_lyrics_verifier_execution_failed');
    let parsed: unknown;
    try { parsed = JSON.parse(completed.stdout); } catch { throw new Error('singing_lyrics_verifier_response_invalid'); }
    return verifyTranscript(parsed);
  }
}

export function createSingingLyricsVerifier(input: {
  config: SpeechRuntimeConfig;
  scriptCandidates: string[];
}): SingingLyricsVerifier | undefined {
  if (input.config.singingLyricsVerifier === 'sensevoice_gguf') return undefined;
  if (input.config.singingLyricsVerifier === 'fireredasr2_aed_wsl') {
    return new FireRedAsr2WslLyricsVerifier(input);
  }
  throw new Error('singing_lyrics_verifier_unsupported');
}
