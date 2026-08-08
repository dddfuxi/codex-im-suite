import fs from 'node:fs';
import path from 'node:path';

import { resolveExecutableDependency } from './dependency-resolution.js';
import { AceStepSingingHost } from './ace-step-singing-host.js';
import { ManagedSpeechDependencyManager } from './managed-dependency-manager.js';
import { validateAudio } from './media-pipeline.js';
import { RuntimeSpeechHost } from './runtime-speech-host.js';
import { SpeechLiveStatusStore } from './speech-live-status.js';
import { SpeechModelBenchmarkStore } from './speech-model-benchmark-store.js';
import { getSpeechHardwareIdentity } from './speech-hardware.js';
import { SpeechRuntimeStatusService } from './speech-status.js';
import { createSpeechVoicePreview } from './speech-preview.js';
import { createSingingVoicePreview } from './singing-preview.js';
import { startSpeechPreviewControlService } from './speech-preview-control.js';
import type { SpeechRuntimeConfig } from './runtime-types.js';
import { SpeechVoiceRegistry } from './voice-registry.js';

function firstExisting(candidates: string[]): string {
  const found = candidates.find((candidate) => {
    try {
      const stat = fs.lstatSync(candidate);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch { return false; }
  });
  if (!found) throw new Error('speech_manifest_missing');
  return path.resolve(found);
}
export function createSpeechRuntime(input: {
  config: SpeechRuntimeConfig;
  ctiHome: string;
  skillRoot: string;
}) {
  const runtimeDepsRoot = path.join(input.ctiHome, 'runtime-deps');
  const runtimeSpeechStateRoot = path.join(input.ctiHome, 'runtime', 'speech');
  const manifestPath = firstExisting([
    path.join(input.skillRoot, 'dist', 'speech-managed-dependencies.json'),
    path.join(input.skillRoot, 'src', 'speech', 'managed-dependencies.json'),
  ]);
  const sidecarCandidates = [
    path.join(input.skillRoot, 'dist', 'speech-sidecar', 'runtime_server.py'),
    path.join(input.skillRoot, 'src', 'speech', 'sidecar', 'runtime_server.py'),
  ];
  const voiceRegistry = new SpeechVoiceRegistry(
    path.join(input.ctiHome, 'runtime', 'speech', 'voices'),
    input.config.maxInputBytes,
    async (sourcePath) => {
      const ffprobe = resolveExecutableDependency({
        id: 'ffprobe',
        displayName: 'ffprobe',
        explicitPath: input.config.ffprobePath,
        runtimeDepsRoot,
      });
      if (ffprobe.state !== 'ready' || !ffprobe.path) throw new Error(ffprobe.diagnosticCode || 'ffprobe_missing');
      const evidence = await validateAudio({
        filePath: sourcePath,
        ffprobePath: ffprobe.path,
        maxBytes: input.config.maxInputBytes,
        maxDurationMs: 30_000,
        timeoutMs: input.config.requestTimeoutMs,
      });
      return { format: evidence.format, durationMs: evidence.durationMs, sha256: evidence.sha256 };
    },
  );
  const dependencies = new ManagedSpeechDependencyManager(manifestPath, runtimeDepsRoot);
  const benchmarkStore = new SpeechModelBenchmarkStore(runtimeSpeechStateRoot);
  const hardware = getSpeechHardwareIdentity();
  const host = new RuntimeSpeechHost({
    config: input.config,
    ctiHome: input.ctiHome,
    runtimeDepsRoot,
    bundledSidecarCandidates: sidecarCandidates,
    voiceRegistry,
    benchmarkStore,
    hardwareId: hardware.id,
  });
  const singingHost = new AceStepSingingHost({
    config: input.config,
    ctiHome: input.ctiHome,
    runtimeDepsRoot,
    voiceRegistry,
  });
  let previewControlService: ReturnType<typeof startSpeechPreviewControlService> | undefined;
  const status = new SpeechRuntimeStatusService({
    config: input.config,
    host,
    voiceRegistry,
    listManagedComponents: () => dependencies.listStatuses(),
    previewAvailable: () => previewControlService?.isRunning() === true,
    singingHost,
    benchmarkStore,
    hardwareId: hardware.id,
  });
  const liveStatus = new SpeechLiveStatusStore(runtimeSpeechStateRoot, input.config);
  let liveStatusTimer: NodeJS.Timeout | undefined;
  let liveRefreshRunning = false;
  const refreshLiveStatus = async () => {
    if (liveRefreshRunning) return;
    liveRefreshRunning = true;
    try {
      const value = await status.refresh({
        probeSidecar: input.config.inputEnabled || input.config.outputEnabled,
      });
      liveStatus.write(value);
    } catch {
      // 预热与观察链失败不能阻断普通 Bridge、Provider 或文本交付。
    } finally {
      liveRefreshRunning = false;
    }
  };
  const startLivePrewarm = () => {
    if (!previewControlService) {
      try {
        previewControlService = startSpeechPreviewControlService({
          runtimeStateRoot: runtimeSpeechStateRoot,
          previewVoice: ({ text, modelId, voiceProfileId, signal }) => createSpeechVoicePreview({
            host,
            text,
            ttsModelId: modelId,
            voiceProfileId,
            signal,
          }),
          benchmarkVoice: ({ text, modelId, voiceProfileId, signal }) => createSpeechVoicePreview({
            host,
            text,
            ttsModelId: modelId,
            voiceProfileId,
            benchmarkMode: true,
            signal,
          }),
          previewSingingVoice: ({ text, modelId, voiceProfileId, signal }) => createSingingVoicePreview({
            host: singingHost,
            lyrics: text,
            modelId,
            voiceProfileId,
            signal,
          }),
        });
      } catch {
        // mailbox 归属失败时保持不可试听，绝不启动第二个 Sidecar。
      }
    }
    void refreshLiveStatus();
    if ((input.config.inputEnabled || input.config.outputEnabled) && !liveStatusTimer) {
      liveStatusTimer = setInterval(() => { void refreshLiveStatus(); }, 15_000);
      liveStatusTimer.unref?.();
    }
  };
  const stopLiveStatus = () => {
    if (liveStatusTimer) clearInterval(liveStatusTimer);
    liveStatusTimer = undefined;
    previewControlService?.stop();
    previewControlService = undefined;
  };
  return {
    host,
    singingHost,
    status,
    voiceRegistry,
    dependencies,
    benchmarkStore,
    hardware,
    readLiveStatus: () => liveStatus.read(),
    startLivePrewarm,
    stopLiveStatus,
  };
}

