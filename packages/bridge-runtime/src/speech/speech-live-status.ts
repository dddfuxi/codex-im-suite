import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { SpeechStatusContract } from '@codex-im-suite/contracts/speech';

import { writeUtf8TextAtomic } from '../atomic-text-file.js';
import { ensureNonSymlinkDirectory } from './dependency-resolution.js';
import type { SpeechRuntimeConfig } from './runtime-types.js';

const LIVE_STATUS_PROTOCOL = 'cti-speech-live-status/v1' as const;
const DEFAULT_MAX_AGE_MS = 2 * 60 * 1000;

interface LiveSpeechStatusEnvelope {
  protocol: typeof LIVE_STATUS_PROTOCOL;
  ownerPid: number;
  configIdentity: string;
  createdAt: string;
  status: SpeechStatusContract;
}

function configIdentity(config: SpeechRuntimeConfig): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    inputEnabled: config.inputEnabled,
    outputEnabled: config.outputEnabled,
    channels: [...config.channels].sort(),
    replyPolicy: config.replyPolicy,
    deliveryMode: config.deliveryMode,
    asrProvider: config.asrProvider,
    ttsProvider: config.ttsProvider,
    voiceProfileId: config.voiceProfileId || '',
    voiceCloneBenchmarkPassed: config.voiceCloneBenchmarkPassed,
    // 路径只参与不可逆身份 Hash，不进入持久化状态。
    dependencyIdentity: crypto.createHash('sha256').update(JSON.stringify([
      config.modelRoot || '',
      config.senseVoiceBinaryPath || '',
      config.asrModel || '',
      config.ttsModel || '',
      config.ttsReferenceModel || '',
      config.ffmpegPath || '',
      config.ffprobePath || '',
      config.pythonPath || '',
      config.sidecarPath || '',
    ]), 'utf8').digest('hex'),
  }), 'utf8').digest('hex');
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: string }).code
      : undefined;
    return code !== 'ESRCH';
  }
}

/** live Bridge 写、控制 CLI 只读的脱敏语音状态快照。 */
export class SpeechLiveStatusStore {
  readonly statusPath: string;

  constructor(
    runtimeStateRoot: string,
    private readonly config: SpeechRuntimeConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly isProcessAlive: (pid: number) => boolean = processIsAlive,
    private readonly maxAgeMs = DEFAULT_MAX_AGE_MS,
  ) {
    const root = path.resolve(runtimeStateRoot);
    ensureNonSymlinkDirectory(root);
    this.statusPath = path.join(root, 'status.json');
  }

  write(status: SpeechStatusContract): void {
    const envelope: LiveSpeechStatusEnvelope = {
      protocol: LIVE_STATUS_PROTOCOL,
      ownerPid: process.pid,
      configIdentity: configIdentity(this.config),
      createdAt: this.now().toISOString(),
      status,
    };
    writeUtf8TextAtomic(this.statusPath, `${JSON.stringify(envelope, null, 2)}\n`);
  }

  read(): SpeechStatusContract | null {
    try {
      const stat = fs.lstatSync(this.statusPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 512 * 1024) return null;
      const value = JSON.parse(fs.readFileSync(this.statusPath, 'utf8')) as Partial<LiveSpeechStatusEnvelope>;
      const createdAt = typeof value.createdAt === 'string' ? Date.parse(value.createdAt) : Number.NaN;
      if (
        value.protocol !== LIVE_STATUS_PROTOCOL
        || !Number.isInteger(value.ownerPid)
        || value.ownerPid! <= 0
        || !this.isProcessAlive(value.ownerPid!)
        || value.configIdentity !== configIdentity(this.config)
        || !Number.isFinite(createdAt)
        || createdAt > this.now().getTime() + 5_000
        || this.now().getTime() - createdAt > this.maxAgeMs
        || !value.status
        || value.status.protocol !== 'codex-im-suite/speech-status/v1'
      ) return null;
      return value.status;
    } catch {
      return null;
    }
  }
}
