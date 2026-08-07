import fs from 'node:fs';
import path from 'node:path';

import { readManagedInstallMarker } from './managed-install-marker.js';
import type { SpeechRuntimeConfig } from './runtime-types.js';

export type SpeechBackendDependencyState = 'ready' | 'optional_missing' | 'blocked';

export interface SpeechBackendDependency {
  id: string;
  state: SpeechBackendDependencyState;
  source?: 'explicit' | 'managed';
  path?: string;
  diagnosticCode?: string;
}

export interface SpeechBackendDependencies {
  senseVoiceBinary: SpeechBackendDependency;
  senseVoiceModel: SpeechBackendDependency;
  cosyVoiceSftModel: SpeechBackendDependency;
  cosyVoiceReferenceModel: SpeechBackendDependency;
}

type DependencyKind = 'executable' | 'file' | 'directory';

interface ResolveBackendDependencyInput {
  id: string;
  kind: DependencyKind;
  explicitPath?: string;
  runtimeDepsRoot: string;
  componentIds: string[];
  relativeCandidates?: string[];
  directoryMarkers?: string[];
}

function inspectCandidate(candidate: string, kind: DependencyKind, markers: string[]): boolean {
  try {
    const comparable = (value: string) => process.platform === 'win32'
      ? path.normalize(value).toLowerCase()
      : path.normalize(value);
    if (comparable(fs.realpathSync.native(candidate)) !== comparable(path.resolve(candidate))) return false;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) return false;
    if (kind === 'directory') {
      if (!stat.isDirectory()) return false;
      return markers.length === 0 || markers.some((marker) => {
        const markerPath = path.join(candidate, marker);
        try {
          const markerStat = fs.lstatSync(markerPath);
          return markerStat.isFile() && !markerStat.isSymbolicLink();
        } catch {
          return false;
        }
      });
    }
    if (!stat.isFile()) return false;
    if (kind === 'executable' && process.platform !== 'win32') {
      try { fs.accessSync(candidate, fs.constants.X_OK); } catch { return false; }
    }
    return true;
  } catch {
    return false;
  }
}

function managedBases(runtimeDepsRoot: string, componentIds: string[]): string[] {
  const roots: string[] = [];
  for (const componentId of componentIds) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(componentId)) continue;
    for (const componentRoot of [
      path.join(runtimeDepsRoot, 'speech', componentId),
      path.join(runtimeDepsRoot, componentId),
    ]) {
      try {
        const stat = fs.lstatSync(componentRoot);
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
        for (const entry of fs.readdirSync(componentRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-z0-9._-]+$/i.test(entry.name)) continue;
          const versionRoot = path.join(componentRoot, entry.name);
          if (readManagedInstallMarker(versionRoot, {
            id: componentId,
            version: entry.name,
            platform: `${process.platform}-${process.arch}`,
          })) roots.push(versionRoot);
        }
      } catch {
        // 受管组件尚未安装是正常的 optional_missing。
      }
    }
  }
  return roots;
}

export function resolveBackendDependency(input: ResolveBackendDependencyInput): SpeechBackendDependency {
  const explicit = input.explicitPath?.trim();
  const markers = input.directoryMarkers || [];
  if (explicit) {
    if (!path.isAbsolute(explicit)) {
      return { id: input.id, state: 'blocked', source: 'explicit', diagnosticCode: 'explicit_path_not_absolute' };
    }
    const candidate = path.resolve(explicit);
    return inspectCandidate(candidate, input.kind, markers)
      ? { id: input.id, state: 'ready', source: 'explicit', path: candidate }
      : { id: input.id, state: 'blocked', source: 'explicit', diagnosticCode: 'explicit_path_missing_or_unsafe' };
  }

  const relativeCandidates = input.relativeCandidates || ['.'];
  for (const base of managedBases(path.resolve(input.runtimeDepsRoot), input.componentIds)) {
    for (const relative of relativeCandidates) {
      const candidate = path.resolve(base, relative);
      const relativeToBase = path.relative(base, candidate);
      if (relativeToBase.startsWith('..') || path.isAbsolute(relativeToBase)) continue;
      if (inspectCandidate(candidate, input.kind, markers)) {
        return { id: input.id, state: 'ready', source: 'managed', path: candidate };
      }
    }
  }
  return { id: input.id, state: 'optional_missing', diagnosticCode: 'backend_dependency_not_installed' };
}

function senseVoiceExecutableCandidates(): string[] {
  const names = process.platform === 'win32'
    ? ['llama-funasr-sensevoice.exe', 'llama-funasr-sensevoice']
    : ['llama-funasr-sensevoice'];
  return names.flatMap((name) => [name, path.join('bin', name)]);
}

const COSYVOICE_MARKERS = ['cosyvoice.yaml', 'cosyvoice2.yaml', 'cosyvoice3.yaml'];

export function resolveSpeechBackendDependencies(
  config: SpeechRuntimeConfig,
  runtimeDepsRoot: string,
): SpeechBackendDependencies {
  let modelDependencyRoot = path.resolve(runtimeDepsRoot);
  let modelRootBlocked = false;
  if (config.modelRoot) {
    if (!path.isAbsolute(config.modelRoot) || !inspectCandidate(path.resolve(config.modelRoot), 'directory', [])) {
      modelRootBlocked = true;
    } else {
      // 显式模型根一旦有效便独占模型解析；无效时 blocked，禁止偷偷回退 runtime-deps。
      modelDependencyRoot = path.resolve(config.modelRoot);
    }
  }
  const senseVoiceBinary = resolveBackendDependency({
    id: 'sensevoice_binary',
    kind: 'executable',
    explicitPath: config.senseVoiceBinaryPath,
    runtimeDepsRoot: path.resolve(runtimeDepsRoot),
    componentIds: ['sensevoice_runtime', 'sensevoice_gguf'],
    relativeCandidates: senseVoiceExecutableCandidates(),
  });
  let senseVoiceModel = resolveBackendDependency({
    id: 'sensevoice_model',
    kind: 'file',
    explicitPath: config.asrModel,
    runtimeDepsRoot: modelDependencyRoot,
    componentIds: ['sensevoice_gguf'],
    relativeCandidates: [
      'sensevoice-small-q8.gguf',
      'sensevoice-small-f16.gguf',
      'sensevoice-small.gguf',
    ],
  });
  let cosyVoiceSftModel = resolveBackendDependency({
    id: 'cosyvoice_sft_model',
    kind: 'directory',
    explicitPath: config.ttsModel,
    runtimeDepsRoot: modelDependencyRoot,
    componentIds: ['cosyvoice'],
    directoryMarkers: COSYVOICE_MARKERS,
  });
  let cosyVoiceReferenceModel = resolveBackendDependency({
    id: 'cosyvoice_reference_model',
    kind: 'directory',
    explicitPath: config.ttsReferenceModel,
    runtimeDepsRoot: modelDependencyRoot,
    componentIds: ['cosyvoice_clone', 'cosyvoice'],
    directoryMarkers: COSYVOICE_MARKERS,
  });
  if (modelRootBlocked) {
    const blocked = (id: string): SpeechBackendDependency => ({
      id,
      state: 'blocked',
      source: 'explicit',
      diagnosticCode: 'explicit_model_root_missing_or_unsafe',
    });
    if (!config.asrModel) senseVoiceModel = blocked('sensevoice_model');
    if (!config.ttsModel) cosyVoiceSftModel = blocked('cosyvoice_sft_model');
    if (!config.ttsReferenceModel) cosyVoiceReferenceModel = blocked('cosyvoice_reference_model');
  }
  // 同一份本地 CosyVoice 模型若同时支持 SFT 与 zero-shot，可安全复用；
  // 是否真正支持仍由 Sidecar 加载和调用结果裁决，不能仅凭目录名宣称 ready。
  if (!modelRootBlocked && !config.ttsReferenceModel && cosyVoiceReferenceModel.state !== 'ready' && cosyVoiceSftModel.state === 'ready') {
    cosyVoiceReferenceModel = { ...cosyVoiceSftModel, id: 'cosyvoice_reference_model' };
  }
  // 参考音色复刻必须经过现场性能/OOM 门禁；未确认前不把模型路径交给 Sidecar。
  if (!config.voiceCloneBenchmarkPassed && cosyVoiceReferenceModel.state !== 'blocked') {
    cosyVoiceReferenceModel = {
      id: 'cosyvoice_reference_model',
      state: 'blocked',
      diagnosticCode: 'voice_clone_benchmark_not_verified',
    };
  }
  return { senseVoiceBinary, senseVoiceModel, cosyVoiceSftModel, cosyVoiceReferenceModel };
}

function aggregate(
  dependencies: SpeechBackendDependency[],
  missingCode: string,
): { state: SpeechBackendDependencyState; diagnosticCode?: string } {
  const blocked = dependencies.find((item) => item.state === 'blocked');
  if (blocked) return { state: 'blocked', diagnosticCode: blocked.diagnosticCode || missingCode };
  if (dependencies.every((item) => item.state === 'ready')) return { state: 'ready' };
  return { state: 'optional_missing', diagnosticCode: missingCode };
}

/** 仅把已验证的本地路径交给 Sidecar；缺失/坏路径只传稳定状态码。 */
export function speechBackendEnvironment(dependencies: SpeechBackendDependencies): NodeJS.ProcessEnv {
  const asr = aggregate(
    [dependencies.senseVoiceBinary, dependencies.senseVoiceModel],
    'sensevoice_dependency_missing',
  );
  const ttsCandidates = [dependencies.cosyVoiceSftModel, dependencies.cosyVoiceReferenceModel];
  const ttsReady = ttsCandidates.some((item) => item.state === 'ready');
  const ttsBlocked = ttsCandidates.find((item) => item.state === 'blocked');
  const tts = ttsReady
    ? { state: 'ready' as const }
    : ttsBlocked
      ? { state: 'blocked' as const, diagnosticCode: ttsBlocked.diagnosticCode || 'cosyvoice_dependency_missing' }
      : { state: 'optional_missing' as const, diagnosticCode: 'cosyvoice_dependency_missing' };
  return {
    CTI_SPEECH_ASR_DEPENDENCY_STATE: asr.state,
    CTI_SPEECH_ASR_DIAGNOSTIC: asr.diagnosticCode,
    CTI_SPEECH_TTS_DEPENDENCY_STATE: tts.state,
    CTI_SPEECH_TTS_DIAGNOSTIC: tts.diagnosticCode,
    CTI_SPEECH_SENSEVOICE_BINARY: dependencies.senseVoiceBinary.path,
    CTI_SPEECH_ASR_MODEL_PATH: dependencies.senseVoiceModel.path,
    CTI_SPEECH_TTS_MODEL_PATH: dependencies.cosyVoiceSftModel.path,
    CTI_SPEECH_TTS_REFERENCE_MODEL_PATH: dependencies.cosyVoiceReferenceModel.path,
  };
}
