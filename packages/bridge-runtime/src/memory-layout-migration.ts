import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { rebuildKnowledgeIndex, type KnowledgeIndexStatus } from './knowledge-index-service.js';
import {
  resolveMemoryDocumentPath,
  upsertConfirmedMemoryDocument,
  type ConfirmedMemoryDocumentInput,
  type VisibleMemoryScope,
} from './memory-documents.js';
import {
  classifyMemoryV2Source,
  MEMORY_V2_RELATIVE_DIR,
  parseMemorySourceFrontmatter,
} from './memory-source-policy.js';

export interface MemoryLayoutMigrationAction {
  sourcePath: string;
  targetPath: string;
  scope: VisibleMemoryScope;
  pairCount: number;
  sourceHash: string;
}

export interface MemoryLayoutMigrationConflict {
  sourcePath: string;
  targetPath: string;
  key: string;
  existingValue: string;
  incomingValue: string;
}

export interface MemoryLayoutMigrationSkip {
  sourcePath: string;
  reason: string;
}

export interface MemoryLayoutMigrationReport {
  schema: 'codex-im-suite/memory-layout-migration/v1';
  memoryRoot: string;
  sourceRoot: string;
  targetRoot: string;
  backupRoot: string;
  archiveRoot: string;
  applied: boolean;
  startedAt: string;
  completedAt: string;
  actions: MemoryLayoutMigrationAction[];
  conflicts: MemoryLayoutMigrationConflict[];
  skipped: MemoryLayoutMigrationSkip[];
  hashes: Array<{ path: string; sha256: string }>;
  totals: {
    sourceFiles: number;
    migratedPairs: number;
    conflicts: number;
    skipped: number;
  };
  knowledgeIndex?: KnowledgeIndexStatus;
}

export interface MemoryLayoutMigrationOptions {
  apply?: boolean;
  now?: string;
}

interface LegacySource {
  sourcePath: string;
  targetPath: string;
  scope: VisibleMemoryScope;
  metadata: Record<string, string>;
  pairs: Array<{ key: string; value: string }>;
  sourceHash: string;
}

const AGENT_HOME_FILES = [
  '机器人身份.md',
  '行为与安全规则.md',
  '工具与环境.md',
  '记忆总索引.md',
  '记忆库说明.md',
];

function compactTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`无效迁移时间：${value}`);
  return parsed.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, '').replace('T', '-');
}

function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listMarkdownFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(fullPath);
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function splitMarkdownRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (const character of line.trim().replace(/^\|/u, '').replace(/\|$/u, '')) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseKeyValueTable(content: string, confirmedOnly = false): Map<string, string> {
  const normalized = confirmedOnly
    ? content.match(/## 已确认事实\s*\r?\n([\s\S]*?)(?=\r?\n## |$)/u)?.[1] || ''
    : content;
  const result = new Map<string, string>();
  for (const line of normalized.split(/\r?\n/u)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = splitMarkdownRow(line);
    if (cells.length < 2) continue;
    const [key, value] = cells;
    if (!key || !value || /^(?:key|键)$/iu.test(key)) continue;
    if (/^:?-{3,}:?$/u.test(key) || /^:?-{3,}:?$/u.test(value)) continue;
    result.set(key.normalize('NFKC').trim(), value.normalize('NFKC').trim());
  }
  return result;
}

function resolveTarget(memoryRoot: string, metadata: Record<string, string>): { scope: VisibleMemoryScope; targetPath: string } {
  const scope = metadata.memoryScope as VisibleMemoryScope;
  return {
    scope,
    targetPath: resolveMemoryDocumentPath({
      memoryRoot,
      scope,
      channelType: metadata.channelType,
      userId: metadata.userId,
      chatId: metadata.chatId,
    }),
  };
}

function inspectLegacySources(memoryRoot: string): { sources: LegacySource[]; skipped: MemoryLayoutMigrationSkip[] } {
  const legacyRoot = path.join(memoryRoot, MEMORY_V2_RELATIVE_DIR);
  const sources: LegacySource[] = [];
  const skipped: MemoryLayoutMigrationSkip[] = [];
  for (const sourcePath of listMarkdownFiles(legacyRoot)) {
    const content = fs.readFileSync(sourcePath, 'utf8');
    const metadata = parseMemorySourceFrontmatter(content);
    const classification = classifyMemoryV2Source(memoryRoot, sourcePath, metadata);
    if (!classification.ok || classification.layoutVersion !== 'v2' || !classification.scope || !metadata) {
      skipped.push({ sourcePath, reason: classification.reason || '不是有效的 v2 记忆源' });
      continue;
    }
    const pairs = [...parseKeyValueTable(content)].map(([key, value]) => ({ key, value }));
    if (pairs.length === 0) {
      skipped.push({ sourcePath, reason: '未找到可迁移的 key/value 表格' });
      continue;
    }
    const target = resolveTarget(memoryRoot, metadata);
    sources.push({
      sourcePath,
      targetPath: target.targetPath,
      scope: target.scope,
      metadata,
      pairs,
      sourceHash: hashFile(sourcePath),
    });
  }
  return { sources, skipped };
}

function copyDirectory(source: string, target: string): void {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true, errorOnExist: false });
}

function removeDirectory(target: string): void {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function snapshotAgentHome(memoryRoot: string, backupRoot: string): Map<string, boolean> {
  const existed = new Map<string, boolean>();
  for (const fileName of AGENT_HOME_FILES) {
    const sourcePath = path.join(memoryRoot, fileName);
    const didExist = fs.existsSync(sourcePath);
    existed.set(fileName, didExist);
    if (didExist) {
      const targetPath = path.join(backupRoot, 'agent-home', fileName);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
  return existed;
}

function restoreAgentHome(memoryRoot: string, backupRoot: string, existed: Map<string, boolean>): void {
  for (const fileName of AGENT_HOME_FILES) {
    const targetPath = path.join(memoryRoot, fileName);
    const backupPath = path.join(backupRoot, 'agent-home', fileName);
    if (existed.get(fileName) && fs.existsSync(backupPath)) fs.copyFileSync(backupPath, targetPath);
    else if (!existed.get(fileName) && fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true });
  }
}

function buildUpsertInput(stagingRoot: string, source: LegacySource, pairs: Array<{ key: string; value: string }>, now: string): ConfirmedMemoryDocumentInput {
  return {
    memoryRoot: stagingRoot,
    scope: source.scope,
    channelType: source.metadata.channelType,
    userId: source.metadata.userId,
    chatId: source.metadata.chatId,
    displayName: source.metadata.displayName,
    pairs,
    evidenceText: `从旧 v2 记忆迁移：${path.basename(source.sourcePath)}`,
    createdAt: now,
  };
}

function stageMigration(memoryRoot: string, sources: LegacySource[], conflicts: MemoryLayoutMigrationConflict[], now: string): string {
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-memory-layout-'));
  copyDirectory(path.join(memoryRoot, 'memory'), path.join(stagingRoot, 'memory'));
  const confirmedByTarget = new Map<string, Map<string, string>>();

  for (const source of sources) {
    const stagedTarget = path.join(stagingRoot, path.relative(memoryRoot, source.targetPath));
    let current = confirmedByTarget.get(stagedTarget);
    if (!current) {
      current = fs.existsSync(stagedTarget)
        ? parseKeyValueTable(fs.readFileSync(stagedTarget, 'utf8'), true)
        : new Map<string, string>();
      confirmedByTarget.set(stagedTarget, current);
    }
    const accepted: Array<{ key: string; value: string }> = [];
    for (const pair of source.pairs) {
      const existingValue = current.get(pair.key);
      if (existingValue !== undefined && existingValue !== pair.value) {
        conflicts.push({
          sourcePath: source.sourcePath,
          targetPath: source.targetPath,
          key: pair.key,
          existingValue,
          incomingValue: pair.value,
        });
        continue;
      }
      if (existingValue === pair.value) continue;
      current.set(pair.key, pair.value);
      accepted.push(pair);
    }
    if (accepted.length > 0) upsertConfirmedMemoryDocument(buildUpsertInput(stagingRoot, source, accepted, now));
  }

  // 暂存根先完成索引与 UTF-8 回读，只有全部成功后才切换真实目录。
  rebuildKnowledgeIndex(stagingRoot);
  for (const source of sources) {
    const stagedTarget = path.join(stagingRoot, path.relative(memoryRoot, source.targetPath));
    if (!fs.existsSync(stagedTarget)) throw new Error(`迁移暂存文件缺失：${stagedTarget}`);
    fs.readFileSync(stagedTarget, 'utf8');
  }
  return stagingRoot;
}

export function migrateMemoryLayout(memoryRoot: string, options: MemoryLayoutMigrationOptions = {}): MemoryLayoutMigrationReport {
  const root = path.resolve(memoryRoot);
  const startedAt = options.now || new Date().toISOString();
  const stamp = compactTimestamp(startedAt);
  const sourceRoot = path.join(root, MEMORY_V2_RELATIVE_DIR);
  const targetRoot = path.join(root, 'memory');
  const backupRoot = path.join(root, 'backups', 'memory-layout', stamp);
  const archiveRoot = path.join(root, 'archive', `memory-v2-${stamp}`);
  const inspected = inspectLegacySources(root);
  const actions = inspected.sources.map((source) => ({
    sourcePath: source.sourcePath,
    targetPath: source.targetPath,
    scope: source.scope,
    pairCount: source.pairs.length,
    sourceHash: source.sourceHash,
  }));
  const conflicts: MemoryLayoutMigrationConflict[] = [];
  const hashes = inspected.sources.map((source) => ({ path: source.sourcePath, sha256: source.sourceHash }));
  let knowledgeIndex: KnowledgeIndexStatus | undefined;

  if (options.apply) {
    if (fs.existsSync(backupRoot)) throw new Error(`迁移备份目录已存在：${backupRoot}`);
    if (fs.existsSync(archiveRoot)) throw new Error(`迁移归档目录已存在：${archiveRoot}`);
    const stagingRoot = stageMigration(root, inspected.sources, conflicts, startedAt);
    const existingMemory = fs.existsSync(targetRoot);
    let agentHomeSnapshot = new Map<string, boolean>();
    try {
      copyDirectory(sourceRoot, path.join(backupRoot, MEMORY_V2_RELATIVE_DIR));
      if (existingMemory) copyDirectory(targetRoot, path.join(backupRoot, 'memory'));
      agentHomeSnapshot = snapshotAgentHome(root, backupRoot);

      removeDirectory(targetRoot);
      copyDirectory(path.join(stagingRoot, 'memory'), targetRoot);
      if (fs.existsSync(sourceRoot)) {
        fs.mkdirSync(path.dirname(archiveRoot), { recursive: true });
        fs.renameSync(sourceRoot, archiveRoot);
      }
      knowledgeIndex = rebuildKnowledgeIndex(root);

      for (const action of actions) {
        if (!fs.existsSync(action.targetPath)) throw new Error(`迁移目标文件缺失：${action.targetPath}`);
        hashes.push({ path: action.targetPath, sha256: hashFile(action.targetPath) });
      }
    } catch (error) {
      removeDirectory(targetRoot);
      if (existingMemory) copyDirectory(path.join(backupRoot, 'memory'), targetRoot);
      if (!fs.existsSync(sourceRoot)) {
        if (fs.existsSync(archiveRoot)) {
          fs.mkdirSync(path.dirname(sourceRoot), { recursive: true });
          fs.renameSync(archiveRoot, sourceRoot);
        } else {
          copyDirectory(path.join(backupRoot, MEMORY_V2_RELATIVE_DIR), sourceRoot);
        }
      }
      restoreAgentHome(root, backupRoot, agentHomeSnapshot);
      throw error;
    } finally {
      removeDirectory(stagingRoot);
    }
  }

  const completedAt = new Date().toISOString();
  return {
    schema: 'codex-im-suite/memory-layout-migration/v1',
    memoryRoot: root,
    sourceRoot,
    targetRoot,
    backupRoot,
    archiveRoot,
    applied: options.apply === true,
    startedAt,
    completedAt,
    actions,
    conflicts,
    skipped: inspected.skipped,
    hashes,
    totals: {
      sourceFiles: actions.length,
      migratedPairs: actions.reduce((sum, action) => sum + action.pairCount, 0) - conflicts.length,
      conflicts: conflicts.length,
      skipped: inspected.skipped.length,
    },
    knowledgeIndex,
  };
}
