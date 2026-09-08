import fs from 'node:fs';
import path from 'node:path';

import type { SpeechModelBenchmarkContract } from '@codex-im-suite/contracts/speech';

import { writeUtf8TextAtomic } from '../atomic-text-file.js';
import { ensureNonSymlinkDirectory } from './dependency-resolution.js';

const PROTOCOL = 'cti-speech-model-benchmarks/v1' as const;

export interface SpeechModelBenchmarkRecord extends SpeechModelBenchmarkContract {
  modelId: string;
  providerId: string;
  hardwareId: string;
}

interface BenchmarkDocument {
  protocol: typeof PROTOCOL;
  records: SpeechModelBenchmarkRecord[];
}

function finiteMetric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteSimilarity(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= -1 && value <= 1 ? value : undefined;
}

function validateRecord(value: unknown): SpeechModelBenchmarkRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Partial<SpeechModelBenchmarkRecord>;
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(item.modelId || '')
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(item.providerId || '')
    || !/^[a-f0-9]{64}$/.test(item.hardwareId || '')
    || typeof item.revision !== 'string' || item.revision.length < 1 || item.revision.length > 160
    || !['ready', 'optional_missing', 'blocked', 'error'].includes(item.state || '')) return null;
  const testedAt = item.testedAt && Number.isFinite(Date.parse(item.testedAt)) ? item.testedAt : undefined;
  return {
    modelId: item.modelId!,
    providerId: item.providerId!,
    hardwareId: item.hardwareId!,
    revision: item.revision,
    state: item.state!,
    ...(typeof item.voiceProfileId === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(item.voiceProfileId)
      ? { voiceProfileId: item.voiceProfileId } : {}),
    ...(testedAt ? { testedAt } : {}),
    ...(finiteMetric(item.coldStartMs) !== undefined ? { coldStartMs: finiteMetric(item.coldStartMs) } : {}),
    ...(finiteMetric(item.warmSynthesisMs) !== undefined ? { warmSynthesisMs: finiteMetric(item.warmSynthesisMs) } : {}),
    ...(finiteMetric(item.outputDurationMs) !== undefined ? { outputDurationMs: finiteMetric(item.outputDurationMs) } : {}),
    ...(finiteMetric(item.realTimeFactor) !== undefined ? { realTimeFactor: finiteMetric(item.realTimeFactor) } : {}),
    ...(finiteMetric(item.peakVramMiB) !== undefined ? { peakVramMiB: finiteMetric(item.peakVramMiB) } : {}),
    ...(finiteSimilarity(item.speakerSimilarity) !== undefined ? { speakerSimilarity: finiteSimilarity(item.speakerSimilarity) } : {}),
    ...(finiteSimilarity(item.speakerSimilarityThreshold) !== undefined && item.speakerSimilarityThreshold! >= 0
      ? { speakerSimilarityThreshold: finiteSimilarity(item.speakerSimilarityThreshold) } : {}),
    ...(typeof item.speakerSimilarityPassed === 'boolean'
      ? { speakerSimilarityPassed: item.speakerSimilarityPassed } : {}),
    ...(finiteSimilarity(item.lyricsAlignment) !== undefined && item.lyricsAlignment! >= 0
      ? { lyricsAlignment: finiteSimilarity(item.lyricsAlignment) } : {}),
    ...(finiteSimilarity(item.lyricsAlignmentThreshold) !== undefined && item.lyricsAlignmentThreshold! >= 0
      ? { lyricsAlignmentThreshold: finiteSimilarity(item.lyricsAlignmentThreshold) } : {}),
    ...(typeof item.lyricsAlignmentPassed === 'boolean'
      ? { lyricsAlignmentPassed: item.lyricsAlignmentPassed } : {}),
    ...(typeof item.diagnosticCode === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(item.diagnosticCode)
      ? { diagnosticCode: item.diagnosticCode } : {}),
  };
}

/** 模型 benchmark 与全局开关解耦；身份不匹配时旧结果不会被复用。 */
export class SpeechModelBenchmarkStore {
  readonly filePath: string;

  constructor(runtimeSpeechRoot: string) {
    const root = path.resolve(runtimeSpeechRoot);
    ensureNonSymlinkDirectory(root);
    this.filePath = path.join(root, 'model-benchmarks.json');
  }

  private readDocument(): BenchmarkDocument {
    try {
      const stat = fs.lstatSync(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 256 * 1024) throw new Error('invalid');
      const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<BenchmarkDocument>;
      if (value.protocol !== PROTOCOL || !Array.isArray(value.records)) throw new Error('invalid');
      return { protocol: PROTOCOL, records: value.records.map(validateRecord).filter((item): item is SpeechModelBenchmarkRecord => item !== null) };
    } catch {
      return { protocol: PROTOCOL, records: [] };
    }
  }

  find(input: { modelId: string; providerId: string; revision: string; hardwareId: string; voiceProfileId?: string }): SpeechModelBenchmarkRecord | null {
    return this.readDocument().records.find((item) => item.modelId === input.modelId
      && item.providerId === input.providerId
      && item.revision === input.revision
      && item.hardwareId === input.hardwareId
      && item.voiceProfileId === input.voiceProfileId) || null;
  }

  /**
   * 合成超时只消费性能指标：参考音色优先使用精确记录，预设音色或旧记录可回退
   * 到同模型/版本/硬件的模型级 benchmark，但绝不跨模型、版本或硬件复用。
   */
  findTiming(input: { modelId: string; providerId: string; revision: string; hardwareId: string; voiceProfileId?: string }): SpeechModelBenchmarkRecord | null {
    const candidates = this.readDocument().records.filter((item) => item.modelId === input.modelId
      && item.providerId === input.providerId
      && item.revision === input.revision
      && item.hardwareId === input.hardwareId);
    return candidates.find((item) => input.voiceProfileId && item.voiceProfileId === input.voiceProfileId)
      || candidates.find((item) => item.voiceProfileId === undefined)
      || null;
  }

  write(record: SpeechModelBenchmarkRecord): void {
    const normalized = validateRecord(record);
    if (!normalized) throw new Error('speech_benchmark_record_invalid');
    const document = this.readDocument();
    const records = document.records.filter((item) => !(item.modelId === normalized.modelId
      && item.providerId === normalized.providerId
      && item.revision === normalized.revision
      && item.hardwareId === normalized.hardwareId
      && item.voiceProfileId === normalized.voiceProfileId));
    records.push(normalized);
    writeUtf8TextAtomic(this.filePath, `${JSON.stringify({ protocol: PROTOCOL, records }, null, 2)}\n`);
  }

  /** 删除某个参考音色的全部硬件/模型验收记录，避免已删除身份的结论被继续复用。 */
  deleteVoiceProfile(profileId: string): number {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(profileId)) throw new Error('speech_benchmark_voice_profile_id_invalid');
    const document = this.readDocument();
    const records = document.records.filter((item) => item.voiceProfileId !== profileId);
    const deleted = document.records.length - records.length;
    if (deleted > 0) {
      writeUtf8TextAtomic(this.filePath, `${JSON.stringify({ protocol: PROTOCOL, records }, null, 2)}\n`);
    }
    return deleted;
  }
}
