import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { StickerDeliveryEvidence } from 'claude-to-im/src/lib/bridge/sticker-semantic-evolution.js';

import { buildStickerSemanticHumanReadableProjections } from './human-readable-projection.js';
import type {
  StickerSemanticActor,
  StickerSemanticAsset,
  StickerSemanticDeliveryFileV1,
  StickerSemanticFeedbackRecordV1,
  StickerSemanticRevisionFileV1,
  StickerSemanticRevisionV1,
  StickerSemanticSnapshot,
} from './types.js';

export interface StickerSemanticFileOperations {
  writeAtomic(filePath: string, content: string): void;
  removeFile(filePath: string): void;
}

export interface StickerSemanticStoreOptions {
  memoryRoot: string;
  now?: () => string;
  fileOps?: StickerSemanticFileOperations;
}

export interface StickerSemanticStore {
  readSnapshot(): StickerSemanticSnapshot;
  applyRevision(revision: StickerSemanticRevisionV1, actor: StickerSemanticActor): StickerSemanticRevisionV1;
  saveRevision(input: {
    revision: StickerSemanticRevisionV1;
    expectedBaseHash: string;
    actor: StickerSemanticActor;
    feedback?: StickerSemanticFeedbackRecordV1;
  }): StickerSemanticRevisionV1;
  recordDelivery(evidence: StickerDeliveryEvidence): void;
  recordFeedback(feedback: StickerSemanticFeedbackRecordV1): void;
  findDeliveries(messageIds: string[]): StickerDeliveryEvidence[];
  refreshHumanReadableDocuments(): void;
}

interface LegacyStickerRecord {
  fileKey: string;
  aliases?: string[];
  label?: string;
  description?: string;
  annotationSource?: 'vision' | 'manual' | 'user';
  annotationConfidence?: number;
  archived?: boolean;
  disabled?: boolean;
}

interface LegacyStickerFile {
  version?: number;
  updatedAt?: string;
  stickers?: LegacyStickerRecord[];
}

interface BeforeImage { filePath: string; existed: boolean; content: string }
interface Mutation { filePath: string; content: string; kind: 'machine' | 'projection' }

const LOCK_STALE_MS = 10 * 60_000;

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
}

const DEFAULT_FILE_OPS: StickerSemanticFileOperations = {
  writeAtomic: atomicWrite,
  removeFile: (filePath) => fs.rmSync(filePath, { force: true }),
};

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function sha256Json(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function acquireWriteLock(memoryRoot: string): () => void {
  const lockDir = path.join(memoryRoot, '.cti-sticker-semantics');
  const lockPath = path.join(lockDir, 'write.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, 'utf8');
      fs.closeSync(fd);
      return () => fs.rmSync(lockPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stale = false;
      let ownerAlive = true;
      try {
        stale = Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: number };
        ownerAlive = isProcessAlive(lock.pid || 0);
      } catch { /* 保守地保留未知锁。 */ }
      if (!stale || ownerAlive || attempt > 0) throw new Error('sticker_semantic_write_locked');
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new Error('sticker_semantic_write_locked');
}

function captureBeforeImages(mutations: Mutation[]): BeforeImage[] {
  const seen = new Set<string>();
  return mutations.flatMap((mutation) => {
    const filePath = path.resolve(mutation.filePath);
    if (seen.has(filePath)) return [];
    seen.add(filePath);
    const existed = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    return [{ filePath, existed, content: existed ? fs.readFileSync(filePath, 'utf8') : '' }];
  });
}

function restoreBeforeImages(images: BeforeImage[]): void {
  for (const image of [...images].reverse()) {
    if (image.existed) atomicWrite(image.filePath, image.content);
    else fs.rmSync(image.filePath, { force: true });
  }
}

function toAssets(stickerFile: LegacyStickerFile): StickerSemanticAsset[] {
  return (stickerFile.stickers || []).map((item) => ({
    fileKey: item.fileKey,
    label: item.label,
    aliases: Array.isArray(item.aliases) ? item.aliases.filter((value) => typeof value === 'string') : [],
    archived: Boolean(item.archived),
    disabled: Boolean(item.disabled),
    visual: {
      source: item.annotationSource === 'vision' || item.annotationSource === 'manual' ? item.annotationSource : 'unverified',
      description: item.annotationSource === 'vision' || item.annotationSource === 'manual' ? item.description : undefined,
      confidence: item.annotationSource === 'vision' || item.annotationSource === 'manual' ? item.annotationConfidence : undefined,
    },
  }));
}

export function createStickerSemanticStore(options: StickerSemanticStoreOptions): StickerSemanticStore {
  const memoryRoot = path.resolve(options.memoryRoot);
  const now = options.now || (() => new Date().toISOString());
  const fileOps = options.fileOps || DEFAULT_FILE_OPS;
  const stickerRoot = path.join(memoryRoot, 'data', 'im', 'feishu', 'stickers');
  const stickerPath = path.join(stickerRoot, 'stickers.json');
  const revisionPath = path.join(stickerRoot, 'semantic-revisions.json');
  const deliveryPath = path.join(stickerRoot, 'semantic-deliveries.json');
  const feedbackPath = path.join(stickerRoot, 'semantic-feedback.jsonl');

  const readFeedback = (): StickerSemanticFeedbackRecordV1[] => {
    if (!fs.existsSync(feedbackPath)) return [];
    return fs.readFileSync(feedbackPath, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line) as StickerSemanticFeedbackRecordV1]; } catch { return []; }
      });
  };

  const readMachine = () => {
    const stickerFile = readJson<LegacyStickerFile>(stickerPath, { version: 1, stickers: [] });
    const revisionFile = readJson<StickerSemanticRevisionFileV1>(revisionPath, {
      schema: 'codex-im-suite/sticker-semantic-revisions/v1', updatedAt: '', revisions: [],
    });
    const deliveryFile = readJson<StickerSemanticDeliveryFileV1>(deliveryPath, {
      schema: 'codex-im-suite/sticker-semantic-deliveries/v1', updatedAt: '', deliveries: [],
    });
    return { stickerFile, revisionFile, deliveryFile, feedbackRecords: readFeedback() };
  };

  const snapshotFrom = (machine: ReturnType<typeof readMachine>, generatedAt = now()): StickerSemanticSnapshot => ({
    schema: 'codex-im-suite/sticker-semantic-snapshot/v1',
    generatedAt,
    baseHash: sha256Json(machine),
    assets: toAssets(machine.stickerFile),
    revisions: machine.revisionFile.revisions,
    deliveries: machine.deliveryFile.deliveries,
  });

  const projectionMutations = (snapshot: StickerSemanticSnapshot): Mutation[] => {
    const masterIndexPath = path.join(memoryRoot, '记忆总索引.md');
    const memoryGuidePath = path.join(memoryRoot, '记忆库说明.md');
    return buildStickerSemanticHumanReadableProjections({
      memoryRoot,
      snapshot,
      masterIndexContent: fs.existsSync(masterIndexPath) ? fs.readFileSync(masterIndexPath, 'utf8') : '# 记忆总索引\n',
      memoryGuideContent: fs.existsSync(memoryGuidePath) ? fs.readFileSync(memoryGuidePath, 'utf8') : '# 记忆库说明\n',
    }).map((item) => ({ filePath: item.path, content: item.content, kind: 'projection' as const }));
  };

  const commit = (machineMutations: Mutation[], projections: Mutation[]): void => {
    const all = [...machineMutations, ...projections];
    const before = captureBeforeImages(all);
    let phase: Mutation['kind'] = 'machine';
    try {
      for (const mutation of machineMutations) fileOps.writeAtomic(mutation.filePath, mutation.content);
      phase = 'projection';
      for (const mutation of projections) fileOps.writeAtomic(mutation.filePath, mutation.content);
    } catch (error) {
      restoreBeforeImages(before);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(phase === 'projection' ? `projection_write_failed: ${message}` : `sticker_semantic_mutation_failed: ${message}`);
    }
  };

  const mutate = <T>(operation: () => T): T => {
    const release = acquireWriteLock(memoryRoot);
    try { return operation(); } finally { release(); }
  };

  const persistRevision = (input: {
    revision: StickerSemanticRevisionV1;
    expectedBaseHash: string;
    actor: StickerSemanticActor;
    feedback?: StickerSemanticFeedbackRecordV1;
    versionFileName: string;
    allowExisting: boolean;
  }): StickerSemanticRevisionV1 => mutate(() => {
    const machine = readMachine();
    const current = snapshotFrom(machine);
    if (input.expectedBaseHash !== current.baseHash) throw new Error('source_changed');
    if (!current.assets.some((item) => item.fileKey === input.revision.fileKey)) throw new Error('sticker_not_found');
    const existingIndex = machine.revisionFile.revisions.findIndex((item) => item.revisionId === input.revision.revisionId);
    if (existingIndex >= 0 && !input.allowExisting) throw new Error('revision_conflict');
    const revisions = [...machine.revisionFile.revisions];
    if (existingIndex >= 0) revisions[existingIndex] = input.revision;
    else revisions.push(input.revision);
    machine.revisionFile = {
      schema: 'codex-im-suite/sticker-semantic-revisions/v1',
      updatedAt: now(),
      revisions,
    };
    if (input.feedback && !machine.feedbackRecords.some((item) => item.evidenceHash === input.feedback?.evidenceHash)) {
      machine.feedbackRecords = [...machine.feedbackRecords, input.feedback].slice(-5000);
    }
    const next = snapshotFrom(machine, machine.revisionFile.updatedAt);
    const versionPath = path.join(stickerRoot, 'semantic-versions', input.revision.fileKey, `${input.versionFileName}.json`);
    const mutations: Mutation[] = [
      { filePath: revisionPath, content: `${JSON.stringify(machine.revisionFile, null, 2)}\n`, kind: 'machine' },
      { filePath: versionPath, content: `${JSON.stringify({ actor: input.actor, revision: input.revision }, null, 2)}\n`, kind: 'machine' },
    ];
    if (input.feedback) {
      mutations.push({
        filePath: feedbackPath,
        content: machine.feedbackRecords.map((item) => JSON.stringify(item)).join('\n') + '\n',
        kind: 'machine',
      });
    }
    commit(mutations, projectionMutations(next));
    return input.revision;
  });

  return {
    readSnapshot: () => snapshotFrom(readMachine()),
    applyRevision: (revision, actor) => persistRevision({
      revision,
      expectedBaseHash: revision.baseHash,
      actor,
      versionFileName: revision.revisionId,
      allowExisting: false,
    }),
    saveRevision: (input) => persistRevision({
      ...input,
      versionFileName: input.revision.versionId,
      allowExisting: true,
    }),
    recordDelivery: (evidence) => mutate(() => {
      const machine = readMachine();
      if (machine.deliveryFile.deliveries.some((item) => item.deliveryId === evidence.deliveryId)) return;
      machine.deliveryFile = {
        schema: 'codex-im-suite/sticker-semantic-deliveries/v1',
        updatedAt: now(),
        deliveries: [...machine.deliveryFile.deliveries, evidence].slice(-2000),
      };
      const next = snapshotFrom(machine, machine.deliveryFile.updatedAt);
      commit([
        { filePath: deliveryPath, content: `${JSON.stringify(machine.deliveryFile, null, 2)}\n`, kind: 'machine' },
      ], projectionMutations(next));
    }),
    recordFeedback: (feedback) => mutate(() => {
      const machine = readMachine();
      if (machine.feedbackRecords.some((item) => item.evidenceHash === feedback.evidenceHash)) return;
      machine.feedbackRecords = [...machine.feedbackRecords, feedback].slice(-5000);
      const next = snapshotFrom(machine, feedback.createdAt || now());
      commit([{
        filePath: feedbackPath,
        content: machine.feedbackRecords.map((item) => JSON.stringify(item)).join('\n') + '\n',
        kind: 'machine',
      }], projectionMutations(next));
    }),
    findDeliveries: (messageIds) => {
      const ids = new Set(messageIds.map((value) => value.trim()).filter(Boolean));
      return readMachine().deliveryFile.deliveries.filter((item) => ids.has(item.outboundMessageId));
    },
    refreshHumanReadableDocuments: () => mutate(() => {
      const snapshot = snapshotFrom(readMachine());
      commit([], projectionMutations(snapshot));
    }),
  };
}
