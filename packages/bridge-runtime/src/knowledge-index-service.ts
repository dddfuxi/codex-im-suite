import fs from 'node:fs';
import path from 'node:path';

import {
  buildKnowledgeIndexFromMarkdown,
  getKnowledgeIndexPath,
  readKnowledgeIndex,
  searchKnowledgeIndex,
  writeKnowledgeIndex,
  type KnowledgeIndex,
  type KnowledgeItem,
  type KnowledgeKind,
  type KnowledgeSourceFile,
} from './knowledge-indexer.js';
import { isIndexableMemoryV2SourceFile, MEMORY_V2_RELATIVE_DIR } from './memory-source-policy.js';
import {
  buildMemoryGraphFromKnowledgeIndex,
  getMemoryGraphIndexPath,
  readMemoryGraphIndex,
  writeMemoryGraphIndex,
} from './memory-graph.js';

export interface KnowledgeIndexStatus {
  schema: 'codex-im-suite/knowledge-index-status/v1';
  memoryRoot: string;
  indexPath: string;
  watching: boolean;
  exists: boolean;
  markdownFileCount: number;
  itemCount: number;
  conflictCount: number;
  memoryGraphPath?: string;
  memoryGraphNodeCount?: number;
  memoryGraphEdgeCount?: number;
  generatedAt?: string;
  lastIndexedAt?: string;
  lastEventAt?: string;
  watcherStartedAt?: string;
  watcherPid?: number;
  statusUpdatedAt?: string;
  lastError?: string;
}

export interface KnowledgeIndexWatcher {
  close: () => void;
  status: () => KnowledgeIndexStatus;
  rebuild: () => Promise<KnowledgeIndexStatus>;
}

const STATUS_SCHEMA: KnowledgeIndexStatus['schema'] = 'codex-im-suite/knowledge-index-status/v1';
const MAX_MARKDOWN_FILES = 2000;
const WATCHER_HEARTBEAT_MS = Math.max(5_000, Number.parseInt(process.env.CTI_MEMORY_WATCHER_HEARTBEAT_MS || '30000', 10) || 30_000);
const WATCHER_STATUS_FRESH_MS = Math.max(WATCHER_HEARTBEAT_MS * 3, Number.parseInt(process.env.CTI_MEMORY_WATCHER_STATUS_FRESH_MS || '120000', 10) || 120_000);

function shouldSkipDirectory(name: string): boolean {
  return name === '.git'
    || name === '.cti-index'
    || name === 'node_modules'
    || name === 'archive'
    || name === '.obsidian';
}

function collectMarkdownFiles(root: string, limit = MAX_MARKDOWN_FILES): string[] {
  const memoryV2Root = path.join(root, MEMORY_V2_RELATIVE_DIR);
  if (!fs.existsSync(memoryV2Root)) return [];
  const files: string[] = [];
  const visit = (dir: string) => {
    if (files.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(entry.name)) visit(fullPath);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        files.push(fullPath);
      }
      if (files.length >= limit) return;
    }
  };
  visit(memoryV2Root);
  return files;
}

function readMarkdownSource(filePath: string): KnowledgeSourceFile | null {
  try {
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      content: fs.readFileSync(filePath, 'utf-8'),
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

function collectIndexableMemorySources(root: string): KnowledgeSourceFile[] {
  return collectMarkdownFiles(root)
    .map(readMarkdownSource)
    .filter((file): file is KnowledgeSourceFile => !!file)
    .filter((file) => isIndexableMemoryV2SourceFile(root, file));
}

function makeStatus(
  memoryRoot: string,
  patch: Partial<KnowledgeIndexStatus> = {},
): KnowledgeIndexStatus {
  const index = readKnowledgeIndex(memoryRoot);
  const graph = readMemoryGraphIndex(memoryRoot);
  return {
    schema: STATUS_SCHEMA,
    memoryRoot,
    indexPath: getKnowledgeIndexPath(memoryRoot),
    watching: false,
    exists: !!index,
    markdownFileCount: 0,
    itemCount: index?.itemCount ?? 0,
    conflictCount: index?.conflictCount ?? 0,
    memoryGraphPath: getMemoryGraphIndexPath(memoryRoot),
    memoryGraphNodeCount: graph?.nodeCount ?? 0,
    memoryGraphEdgeCount: graph?.edgeCount ?? 0,
    generatedAt: index?.generatedAt,
    statusUpdatedAt: new Date().toISOString(),
    ...patch,
  };
}

export function getKnowledgeStatusPath(memoryRoot: string): string {
  return path.join(memoryRoot, '.cti-index', 'status.json');
}

function readPersistedStatus(memoryRoot: string): KnowledgeIndexStatus | null {
  const statusPath = getKnowledgeStatusPath(memoryRoot);
  try {
    if (!fs.existsSync(statusPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as KnowledgeIndexStatus;
    if (parsed?.schema !== STATUS_SCHEMA) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isFreshWatcherStatus(status: KnowledgeIndexStatus | null): boolean {
  if (!status?.watching || !status.statusUpdatedAt) return false;
  const ageMs = Date.now() - Date.parse(status.statusUpdatedAt);
  return Number.isFinite(ageMs) && ageMs <= WATCHER_STATUS_FRESH_MS;
}

function writeKnowledgeStatus(memoryRoot: string, status: KnowledgeIndexStatus): void {
  const statusPath = getKnowledgeStatusPath(memoryRoot);
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  const tmp = `${statusPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    ...status,
    statusUpdatedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');
  fs.renameSync(tmp, statusPath);
}

export function rebuildKnowledgeIndex(memoryRoot: string): KnowledgeIndexStatus {
  const root = path.resolve(memoryRoot);
  if (!fs.existsSync(root)) {
    return makeStatus(root, {
      exists: false,
      lastError: `记忆仓库不存在：${root}`,
    });
  }

  const sources = collectIndexableMemorySources(root);
  const index = buildKnowledgeIndexFromMarkdown({
    memoryRoot: root,
    files: sources,
  });
  writeKnowledgeIndex(root, index);
  const graph = buildMemoryGraphFromKnowledgeIndex(index);
  writeMemoryGraphIndex(root, graph);
  const status = makeStatus(root, {
    exists: true,
    markdownFileCount: sources.length,
    itemCount: index.itemCount,
    conflictCount: index.conflictCount,
    memoryGraphNodeCount: graph.nodeCount,
    memoryGraphEdgeCount: graph.edgeCount,
    generatedAt: index.generatedAt,
    lastIndexedAt: new Date().toISOString(),
  });
  writeKnowledgeStatus(root, status);
  return status;
}

export function readKnowledgeIndexStatus(memoryRoot: string): KnowledgeIndexStatus {
  const root = path.resolve(memoryRoot);
  const markdownFileCount = fs.existsSync(root) ? collectIndexableMemorySources(root).length : 0;
  const persisted = readPersistedStatus(root);
  if (persisted) {
    return makeStatus(root, {
      ...persisted,
      exists: fs.existsSync(getKnowledgeIndexPath(root)),
      markdownFileCount,
      watching: isFreshWatcherStatus(persisted),
    });
  }
  return makeStatus(root, {
    exists: fs.existsSync(getKnowledgeIndexPath(root)),
    markdownFileCount,
  });
}

export function searchKnowledge(
  memoryRoot: string,
  query: { query?: string; kinds?: KnowledgeKind[]; limit?: number },
): { index: KnowledgeIndex | null; hits: KnowledgeItem[] } {
  const root = path.resolve(memoryRoot);
  const index = readKnowledgeIndex(root);
  if (!index) return { index: null, hits: [] };
  return {
    index,
    hits: searchKnowledgeIndex(index, query),
  };
}

export function startKnowledgeIndexWatcher(memoryRoot: string): KnowledgeIndexWatcher {
  const root = path.resolve(memoryRoot);
  let status = rebuildKnowledgeIndex(root);
  let timer: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  const watcherStartedAt = new Date().toISOString();

  const persistStatus = (patch: Partial<KnowledgeIndexStatus> = {}) => {
    status = {
      ...status,
      ...patch,
      watcherStartedAt,
      watcherPid: process.pid,
      statusUpdatedAt: new Date().toISOString(),
    };
    try {
      if (fs.existsSync(root)) {
        writeKnowledgeStatus(root, status);
      }
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : String(error);
    }
  };

  const scheduleRebuild = () => {
    if (timer) clearTimeout(timer);
    persistStatus({
      watching: !!watcher,
      lastEventAt: new Date().toISOString(),
    });
    timer = setTimeout(() => {
      try {
        status = rebuildKnowledgeIndex(root);
        persistStatus({
          watching: !!watcher,
          lastError: undefined,
        });
      } catch (error) {
        status = makeStatus(root, {
          watching: !!watcher,
          lastError: error instanceof Error ? error.message : String(error),
        });
        persistStatus();
      }
    }, 750);
  };

  try {
    if (fs.existsSync(root)) {
      watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        const name = String(filename || '');
        if (!name || /\.md$/i.test(name)) scheduleRebuild();
      });
      status.watching = true;
    }
  } catch (error) {
    status.lastError = error instanceof Error ? error.message : String(error);
    status.watching = false;
  }
  persistStatus({ watching: !!watcher });

  if (watcher) {
    heartbeat = setInterval(() => {
      persistStatus({ watching: !!watcher });
    }, WATCHER_HEARTBEAT_MS);
    heartbeat.unref?.();
  }

  return {
    close: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      watcher?.close();
      watcher = null;
      persistStatus({ watching: false });
    },
    status: () => ({ ...status }),
    rebuild: async () => {
      status = rebuildKnowledgeIndex(root);
      persistStatus({
        watching: !!watcher,
        lastError: undefined,
      });
      return { ...status };
    },
  };
}
