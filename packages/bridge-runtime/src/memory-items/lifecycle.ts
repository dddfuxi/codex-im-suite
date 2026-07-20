import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ensureAgentHome } from '../agent-home.js';
import { rebuildKnowledgeIndex, getKnowledgeStatusPath } from '../knowledge-index-service.js';
import { readKnowledgeIndex, writeKnowledgeIndex } from '../knowledge-indexer.js';
import {
  buildMemoryHumanReadableProjections,
  type ProjectionFile,
} from './human-readable-projections.js';
import {
  readManagedMemoryDocument,
  renderManagedMemoryDocument,
  memoryCandidateFingerprint,
} from './managed-document.js';
import type {
  ManagedMemoryDocument,
  MemoryItemActor,
  MemoryItemArchive,
  MemoryItemListRecord,
  MemoryItemStatus,
} from './types.js';

export interface MemoryItemFileOperations {
  writeAtomic(filePath: string, content: string): void;
  removeFile(filePath: string): void;
}

export interface MemoryItemLifecycleServiceOptions {
  memoryRoot: string;
  now?: () => string;
  fileOps?: MemoryItemFileOperations;
}

export interface MemoryItemLifecycleService {
  listConfirmed(): MemoryItemListRecord[];
  listCandidates(): MemoryItemListRecord[];
  listArchives(): MemoryItemArchive[];
  refreshHumanReadableDocuments(): void;
  confirmCandidate(itemId: string, actor: MemoryItemActor, options?: { key?: string; expectedBaseHash?: string }): MemoryItemListRecord;
  archive(itemId: string, actor: MemoryItemActor, options?: { expectedBaseHash?: string }): MemoryItemArchive;
  restore(archiveId: string, actor: MemoryItemActor): MemoryItemListRecord;
  deleteArchive(archiveId: string, actor: MemoryItemActor): { deleted: boolean; archiveId: string };
}

interface FileBeforeImage {
  filePath: string;
  existed: boolean;
  content: string;
}

interface FileMutation {
  filePath: string;
  content?: string;
  remove?: boolean;
  kind: 'machine' | 'projection';
}

const LOCK_STALE_MS = 10 * 60_000;
const ARCHIVE_ID_RE = /^[a-f0-9]{64}$/u;

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

const DEFAULT_FILE_OPS: MemoryItemFileOperations = {
  writeAtomic: atomicWrite,
  removeFile: (filePath) => fs.rmSync(filePath, { force: true }),
};

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function cloneDocument(document: ManagedMemoryDocument): ManagedMemoryDocument {
  return {
    ...document,
    metadata: { ...document.metadata },
    state: JSON.parse(JSON.stringify(document.state)) as ManagedMemoryDocument['state'],
  };
}

function archiveRoot(memoryRoot: string): string {
  return path.join(path.resolve(memoryRoot), 'archive', 'memory-items');
}

function archivePath(memoryRoot: string, archive: Pick<MemoryItemArchive, 'archiveId' | 'scope'>): string {
  return path.join(archiveRoot(memoryRoot), archive.scope, `${archive.archiveId}.json`);
}

function listMarkdownFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(fullPath);
    }
  };
  visit(root);
  return files;
}

function listManagedDocuments(memoryRoot: string): ManagedMemoryDocument[] {
  const memoryDir = path.join(path.resolve(memoryRoot), 'memory');
  return listMarkdownFiles(memoryDir)
    .filter((filePath) => fs.readFileSync(filePath, 'utf8').includes('cti-memory-state:'))
    .map(readManagedMemoryDocument);
}

function makeItemId(relativeSourcePath: string, status: MemoryItemStatus, key: string): string {
  return crypto.createHash('sha256').update(`${relativeSourcePath}\n${status}\n${key}`, 'utf8').digest('hex');
}

function listItems(memoryRoot: string, status: MemoryItemStatus): MemoryItemListRecord[] {
  const root = path.resolve(memoryRoot);
  const items: MemoryItemListRecord[] = [];
  for (const document of listManagedDocuments(root)) {
    const sourceRelativePath = path.relative(root, document.filePath).replace(/\\/gu, '/');
    const entries = status === 'confirmed' ? document.state.confirmed : document.state.candidates;
    for (const [key, entry] of Object.entries(entries)) {
      items.push({
        itemId: makeItemId(sourceRelativePath, status, key),
        key,
        entry,
        status,
        scope: document.metadata.scope,
        sourcePath: document.filePath,
        sourceRelativePath,
        sourceBaseHash: document.baseHash,
      });
    }
  }
  return items.sort((left, right) => left.sourceRelativePath.localeCompare(right.sourceRelativePath, 'zh-CN') || left.key.localeCompare(right.key, 'zh-CN'));
}

function readArchiveFile(filePath: string): MemoryItemArchive | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as MemoryItemArchive;
    if (parsed.schema !== 'codex-im-suite/memory-item-archive/v1' || !ARCHIVE_ID_RE.test(parsed.archiveId)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function listArchives(memoryRoot: string): MemoryItemArchive[] {
  const root = archiveRoot(memoryRoot);
  if (!fs.existsSync(root)) return [];
  const archives: MemoryItemArchive[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        const archive = readArchiveFile(fullPath);
        if (archive) archives.push(archive);
      }
    }
  };
  visit(root);
  return archives.sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
}

function isLockOwnerAlive(lockPath: string): boolean {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: number };
    if (!Number.isInteger(lock.pid) || (lock.pid || 0) <= 0) return false;
    if (lock.pid === process.pid) return true;
    try {
      process.kill(lock.pid!, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  } catch {
    return false;
  }
}

function acquireWriteLock(memoryRoot: string): () => void {
  const directory = path.join(path.resolve(memoryRoot), '.cti-memory-items');
  const lockPath = path.join(directory, 'write.lock');
  fs.mkdirSync(directory, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, 'utf8');
      fs.closeSync(descriptor);
      return () => fs.rmSync(lockPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stale = (() => {
        try { return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS; } catch { return false; }
      })();
      if (!stale || isLockOwnerAlive(lockPath) || attempt > 0) throw new Error('memory_item_write_locked');
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new Error('memory_item_write_locked');
}

function captureBeforeImages(mutations: FileMutation[]): FileBeforeImage[] {
  const seen = new Set<string>();
  const images: FileBeforeImage[] = [];
  for (const mutation of mutations) {
    const filePath = path.resolve(mutation.filePath);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    images.push({
      filePath,
      existed: fs.existsSync(filePath) && fs.statSync(filePath).isFile(),
      content: fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? fs.readFileSync(filePath, 'utf8') : '',
    });
  }
  return images;
}

function restoreBeforeImages(images: FileBeforeImage[]): void {
  for (const image of [...images].reverse()) {
    if (image.existed) atomicWrite(image.filePath, image.content);
    else fs.rmSync(image.filePath, { force: true });
  }
}

function syncArchivedCount(memoryRoot: string, archivedCount: number): void {
  const index = readKnowledgeIndex(memoryRoot);
  if (index) {
    index.stats.archivedCount = archivedCount;
    writeKnowledgeIndex(memoryRoot, index);
  }
  const statusPath = getKnowledgeStatusPath(memoryRoot);
  if (fs.existsSync(statusPath)) {
    try {
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
      status.archivedCount = archivedCount;
      atomicWrite(statusPath, `${JSON.stringify(status, null, 2)}\n`);
    } catch {
      // 状态文件损坏由知识索引服务负责重建；生命周期主事务仍以源 state 为准。
    }
  }
}

function sourcePathFromArchive(memoryRoot: string, archive: MemoryItemArchive): string {
  const root = path.resolve(memoryRoot);
  const sourcePath = path.resolve(root, archive.sourceRelativePath);
  const memoryDir = path.join(root, 'memory');
  if (!isInside(memoryDir, sourcePath)) throw new Error('archive_source_outside_memory');
  return sourcePath;
}

export function createMemoryItemLifecycleService(options: MemoryItemLifecycleServiceOptions): MemoryItemLifecycleService {
  const memoryRoot = path.resolve(options.memoryRoot);
  const now = options.now || (() => new Date().toISOString());
  const fileOps = options.fileOps || DEFAULT_FILE_OPS;
  ensureAgentHome(memoryRoot);

  const buildProjectionMutations = (
    documents: ManagedMemoryDocument[],
    archives: MemoryItemArchive[],
    generatedAt: string,
  ): FileMutation[] => {
    const guidePath = path.join(memoryRoot, '记忆库说明.md');
    const projections = buildMemoryHumanReadableProjections({
      memoryRoot,
      documents,
      archives,
      generatedAt,
      existingGuideContent: fs.existsSync(guidePath) ? fs.readFileSync(guidePath, 'utf8') : undefined,
    });
    return projections.map((projection: ProjectionFile) => ({
      filePath: projection.path,
      content: projection.content,
      kind: 'projection' as const,
    }));
  };

  const commitMutation = (
    machineMutations: FileMutation[],
    projectionMutations: FileMutation[],
    archivedCount: number,
  ): void => {
    ensureAgentHome(memoryRoot);
    const allMutations = [...machineMutations, ...projectionMutations];
    const beforeImages = captureBeforeImages(allMutations);
    let phase: FileMutation['kind'] = 'machine';
    try {
      for (const mutation of machineMutations) {
        if (mutation.remove) fileOps.removeFile(mutation.filePath);
        else fileOps.writeAtomic(mutation.filePath, mutation.content || '');
      }
      const status = rebuildKnowledgeIndex(memoryRoot);
      if (status.lastError) throw new Error(status.lastError);
      syncArchivedCount(memoryRoot, archivedCount);
      phase = 'projection';
      for (const mutation of projectionMutations) {
        fileOps.writeAtomic(mutation.filePath, mutation.content || '');
      }
    } catch (error) {
      restoreBeforeImages(beforeImages.filter((image) => machineMutations.some((mutation) => path.resolve(mutation.filePath) === image.filePath)));
      try {
        rebuildKnowledgeIndex(memoryRoot);
        syncArchivedCount(memoryRoot, listArchives(memoryRoot).length);
      } catch {
        // 后续异常会通过 rollback_failed 暴露，避免宣称事务已恢复。
      }
      restoreBeforeImages(beforeImages.filter((image) => projectionMutations.some((mutation) => path.resolve(mutation.filePath) === image.filePath)));
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(phase === 'projection' ? `projection_write_failed: ${message}` : `memory_item_mutation_failed: ${message}`);
    }
  };

  const mutate = <T>(operation: () => T): T => {
    const release = acquireWriteLock(memoryRoot);
    try { return operation(); } finally { release(); }
  };

  const requireItem = (itemId: string, status?: MemoryItemStatus): MemoryItemListRecord => {
    const items = status ? listItems(memoryRoot, status) : [...listItems(memoryRoot, 'confirmed'), ...listItems(memoryRoot, 'candidate')];
    const item = items.find((candidate) => candidate.itemId === itemId);
    if (!item) throw new Error('memory_item_not_found');
    return item;
  };

  return {
    listConfirmed: () => listItems(memoryRoot, 'confirmed'),
    listCandidates: () => listItems(memoryRoot, 'candidate'),
    listArchives: () => listArchives(memoryRoot),
    refreshHumanReadableDocuments: () => mutate(() => {
      const documents = listManagedDocuments(memoryRoot);
      const archives = listArchives(memoryRoot);
      const generatedAt = now();
      const projections = buildProjectionMutations(documents, archives, generatedAt);
      commitMutation([], projections, archives.length);
    }),

    confirmCandidate: (itemId, _actor, confirmOptions = {}) => mutate(() => {
      const item = requireItem(itemId, 'candidate');
      if (confirmOptions.expectedBaseHash && confirmOptions.expectedBaseHash !== item.sourceBaseHash) throw new Error('source_changed');
      const document = cloneDocument(readManagedMemoryDocument(item.sourcePath));
      const sourceEntry = document.state.candidates[item.key];
      if (!sourceEntry) throw new Error('memory_item_not_found');
      const confirmedKey = confirmOptions.key?.trim() || item.key.replace(/^暂定-/u, '记忆-');
      if (!confirmedKey || document.state.confirmed[confirmedKey]) throw new Error('confirm_conflict');
      delete document.state.candidates[item.key];
      document.state.confirmed[confirmedKey] = {
        ...sourceEntry,
        status: 'confirmed',
        sourceKind: 'explicit',
        confidence: 1,
        updatedAt: now(),
      };
      document.metadata.updatedAt = now();
      const documents = listManagedDocuments(memoryRoot).map((candidate) => candidate.filePath === document.filePath ? document : candidate);
      const archives = listArchives(memoryRoot);
      const machineMutations: FileMutation[] = [{ filePath: document.filePath, content: renderManagedMemoryDocument(document), kind: 'machine' }];
      const projections = buildProjectionMutations(documents, archives, document.metadata.updatedAt);
      commitMutation(machineMutations, projections, archives.length);
      return requireItem(makeItemId(item.sourceRelativePath, 'confirmed', confirmedKey), 'confirmed');
    }),

    archive: (itemId, actor, archiveOptions = {}) => mutate(() => {
      const item = requireItem(itemId);
      if (archiveOptions.expectedBaseHash && archiveOptions.expectedBaseHash !== item.sourceBaseHash) throw new Error('source_changed');
      const document = cloneDocument(readManagedMemoryDocument(item.sourcePath));
      const entries = item.status === 'confirmed' ? document.state.confirmed : document.state.candidates;
      const entry = entries[item.key];
      if (!entry) throw new Error('memory_item_not_found');
      delete entries[item.key];
      const archivedAt = now();
      document.metadata.updatedAt = archivedAt;
      const archive: MemoryItemArchive = {
        schema: 'codex-im-suite/memory-item-archive/v1',
        archiveId: crypto.createHash('sha256').update(`${item.itemId}\n${archivedAt}\n${crypto.randomUUID()}`, 'utf8').digest('hex'),
        itemId: item.itemId,
        previousStatus: item.status,
        scope: item.scope,
        sourceRelativePath: item.sourceRelativePath,
        sourceBaseHash: item.sourceBaseHash,
        key: item.key,
        entry,
        archivedAt,
        archivedBy: actor,
      };
      const archives = [...listArchives(memoryRoot), archive];
      const documents = listManagedDocuments(memoryRoot).map((candidate) => candidate.filePath === document.filePath ? document : candidate);
      const machineMutations: FileMutation[] = [
        { filePath: document.filePath, content: renderManagedMemoryDocument(document), kind: 'machine' },
        { filePath: archivePath(memoryRoot, archive), content: `${JSON.stringify(archive, null, 2)}\n`, kind: 'machine' },
      ];
      const projections = buildProjectionMutations(documents, archives, archivedAt);
      commitMutation(machineMutations, projections, archives.length);
      return archive;
    }),

    restore: (archiveId, _actor) => mutate(() => {
      if (!ARCHIVE_ID_RE.test(archiveId)) throw new Error('invalid_archive_id');
      const archive = listArchives(memoryRoot).find((candidate) => candidate.archiveId === archiveId);
      if (!archive) throw new Error('memory_archive_not_found');
      const sourcePath = sourcePathFromArchive(memoryRoot, archive);
      if (!fs.existsSync(sourcePath)) throw new Error('archive_source_missing');
      const document = cloneDocument(readManagedMemoryDocument(sourcePath));
      if (document.state.confirmed[archive.key] || document.state.candidates[archive.key]) throw new Error('restore_conflict');
      const target = archive.previousStatus === 'confirmed' ? document.state.confirmed : document.state.candidates;
      target[archive.key] = { ...archive.entry, status: archive.previousStatus, updatedAt: now() };
      document.metadata.updatedAt = now();
      const archives = listArchives(memoryRoot).filter((candidate) => candidate.archiveId !== archiveId);
      const documents = listManagedDocuments(memoryRoot).map((candidate) => candidate.filePath === document.filePath ? document : candidate);
      const machineMutations: FileMutation[] = [
        { filePath: document.filePath, content: renderManagedMemoryDocument(document), kind: 'machine' },
        { filePath: archivePath(memoryRoot, archive), remove: true, kind: 'machine' },
      ];
      const projections = buildProjectionMutations(documents, archives, document.metadata.updatedAt);
      commitMutation(machineMutations, projections, archives.length);
      return requireItem(makeItemId(archive.sourceRelativePath, archive.previousStatus, archive.key), archive.previousStatus);
    }),

    deleteArchive: (archiveId, _actor) => mutate(() => {
      if (!ARCHIVE_ID_RE.test(archiveId)) throw new Error('invalid_archive_id');
      const archive = listArchives(memoryRoot).find((candidate) => candidate.archiveId === archiveId);
      if (!archive) return { deleted: false, archiveId };
      const sourcePath = sourcePathFromArchive(memoryRoot, archive);
      if (!fs.existsSync(sourcePath)) throw new Error('archive_source_missing');
      const document = cloneDocument(readManagedMemoryDocument(sourcePath));
      const fingerprint = archive.entry.candidateFingerprint || memoryCandidateFingerprint(archive.key, archive.entry.value);
      document.state.deletedCandidateFingerprints[fingerprint] = { deletedAt: now() };
      document.metadata.updatedAt = now();
      const archives = listArchives(memoryRoot).filter((candidate) => candidate.archiveId !== archiveId);
      const documents = listManagedDocuments(memoryRoot).map((candidate) => candidate.filePath === document.filePath ? document : candidate);
      const machineMutations: FileMutation[] = [
        { filePath: document.filePath, content: renderManagedMemoryDocument(document), kind: 'machine' },
        { filePath: archivePath(memoryRoot, archive), remove: true, kind: 'machine' },
      ];
      const projections = buildProjectionMutations(documents, archives, document.metadata.updatedAt);
      commitMutation(machineMutations, projections, archives.length);
      return { deleted: true, archiveId };
    }),
  };
}
