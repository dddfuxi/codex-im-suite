import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readKnowledgeIndex } from './knowledge-indexer.js';
import { rebuildKnowledgeIndex, type KnowledgeIndexStatus } from './knowledge-index-service.js';
import { rebuildReminderIndexFromKnowledge, type ReminderIndex } from './todo-reminders.js';
import {
  countLikelyMojibake,
  hasLikelyMojibake,
  repairLikelyMojibakeText,
  type MojibakeTextRepair,
} from './mojibake.js';

export { hasLikelyMojibake, repairLikelyMojibakeText } from './mojibake.js';

export type HistoryMojibakeRepairMode = 'scan' | 'apply';
export type HistoryMojibakeTargetKind = 'cti-json' | 'memory-markdown' | 'generated-index';

export interface HistoryMojibakeRepairOptions {
  ctiHome?: string;
  memoryRoot?: string;
  apply?: boolean;
  backupRoot?: string;
  generatedAt?: string;
  enabledReminderChannels?: string[];
}

export interface HistoryMojibakeFileReport {
  path: string;
  kind: HistoryMojibakeTargetKind;
  hits: number;
  changed: boolean;
  unresolved: boolean;
  backupPath?: string;
}

export interface HistoryMojibakeRepairReport {
  schema: 'codex-im-suite/history-mojibake-repair/v1';
  mode: HistoryMojibakeRepairMode;
  generatedAt: string;
  ctiHome?: string;
  memoryRoot?: string;
  filesScanned: number;
  filesWithHits: number;
  hitCount: number;
  repairedFileCount: number;
  unresolvedFileCount: number;
  backupManifestPath?: string;
  files: HistoryMojibakeFileReport[];
  knowledgeRebuild?: KnowledgeIndexStatus;
  reminderRebuild?: Pick<ReminderIndex, 'schema' | 'reminderCount' | 'pendingCount' | 'skippedCount' | 'generatedAt'>;
  postRepairMojibakeCount?: number;
}

export interface HistoryMojibakeBackupManifest {
  schema: 'codex-im-suite/history-mojibake-backup/v1';
  createdAt: string;
  ctiHome?: string;
  memoryRoot?: string;
  entries: Array<{
    originalPath: string;
    backupPath: string;
    kind: HistoryMojibakeTargetKind;
  }>;
}

export interface HistoryMojibakeRestoreReport {
  schema: 'codex-im-suite/history-mojibake-restore/v1';
  restoredAt: string;
  manifestPath: string;
  restoredFileCount: number;
  knowledgeRebuild?: KnowledgeIndexStatus;
  reminderRebuild?: Pick<ReminderIndex, 'schema' | 'reminderCount' | 'pendingCount' | 'skippedCount' | 'generatedAt'>;
}

interface RepairTarget {
  path: string;
  kind: HistoryMojibakeTargetKind;
}

const JSON_REPAIR_FILES = [
  ['data', 'feishu-history-index.json'],
  ['data', 'feishu-chat-index.json'],
  ['data', 'memory-profiles.json'],
  ['data', 'audit.json'],
];

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function defaultCtiHome(): string {
  return process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im');
}

function defaultBackupRoot(ctiHome: string, generatedAt: string): string {
  const stamp = generatedAt.replace(/\D/g, '').slice(0, 14) || new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return path.join(ctiHome, 'backups', 'mojibake-repair', stamp);
}

function isSkippableMemoryDir(name: string): boolean {
  return ['.git', '.cti-index', 'node_modules', 'archive', '.obsidian'].includes(name);
}

function enumerateFiles(root: string, predicate: (filePath: string) => boolean, skipDir?: (name: string) => boolean): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDir?.(entry.name)) visit(fullPath);
      } else if (entry.isFile() && predicate(fullPath)) {
        result.push(fullPath);
      }
    }
  };
  visit(root);
  return result;
}

function collectTargets(ctiHome?: string, memoryRoot?: string): RepairTarget[] {
  const targets = new Map<string, RepairTarget>();
  const add = (filePath: string, kind: HistoryMojibakeTargetKind) => {
    if (!filePath || !fs.existsSync(filePath)) return;
    const resolved = path.resolve(filePath);
    targets.set(resolved.toLowerCase(), { path: resolved, kind });
  };

  if (ctiHome) {
    const dataDir = path.join(ctiHome, 'data');
    for (const parts of JSON_REPAIR_FILES) add(path.join(ctiHome, ...parts), 'cti-json');
    for (const filePath of enumerateFiles(path.join(dataDir, 'messages'), (item) => /\.json$/i.test(item))) add(filePath, 'cti-json');
    for (const filePath of enumerateFiles(path.join(dataDir, 'message-archives'), (item) => /\.json$/i.test(item))) add(filePath, 'cti-json');
    for (const filePath of enumerateFiles(path.join(dataDir, 'feishu-history'), (item) => /\.json$/i.test(item))) add(filePath, 'cti-json');
  }

  if (memoryRoot) {
    for (const filePath of enumerateFiles(memoryRoot, (item) => /\.md$/i.test(item), isSkippableMemoryDir)) add(filePath, 'memory-markdown');
    add(path.join(memoryRoot, '.cti-index', 'knowledge.json'), 'generated-index');
    add(path.join(memoryRoot, '.cti-index', 'reminders.json'), 'generated-index');
  }

  return [...targets.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function repairJsonValue(value: unknown): { value: unknown; changed: boolean; unresolved: boolean } {
  if (typeof value === 'string') {
    const repaired = repairLikelyMojibakeText(value);
    return { value: repaired.text, changed: repaired.changed, unresolved: repaired.unresolved };
  }
  if (Array.isArray(value)) {
    let changed = false;
    let unresolved = false;
    const next = value.map((item) => {
      const repaired = repairJsonValue(item);
      changed = changed || repaired.changed;
      unresolved = unresolved || repaired.unresolved;
      return repaired.value;
    });
    return { value: next, changed, unresolved };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    let unresolved = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const repaired = repairJsonValue(item);
      changed = changed || repaired.changed;
      unresolved = unresolved || repaired.unresolved;
      next[key] = repaired.value;
    }
    return { value: next, changed, unresolved };
  }
  return { value, changed: false, unresolved: false };
}

function repairFileContent(raw: string, target: RepairTarget): { text: string; repair: MojibakeTextRepair } {
  if ((target.kind === 'cti-json' || target.kind === 'generated-index') && /\.json$/i.test(target.path)) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      const repaired = repairJsonValue(parsed);
      const text = JSON.stringify(repaired.value, null, 2);
      return {
        text,
        repair: {
          text,
          changed: repaired.changed,
          unresolved: repaired.unresolved || hasLikelyMojibake(text),
          scoreBefore: countLikelyMojibake(raw),
          scoreAfter: countLikelyMojibake(text),
        },
      };
    } catch {
      // Fall back to raw text repair for partially written JSON.
    }
  }
  const repair = repairLikelyMojibakeText(raw);
  return { text: repair.text, repair };
}

function writeBackup(target: RepairTarget, raw: string, backupRoot: string, manifest: HistoryMojibakeBackupManifest): string {
  const suffix = `${sha1(target.path).slice(0, 12)}-${path.basename(target.path)}`;
  const backupPath = path.join(backupRoot, suffix);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, raw, 'utf-8');
  manifest.entries.push({
    originalPath: target.path,
    backupPath,
    kind: target.kind,
  });
  return backupPath;
}

function rebuildMemoryArtifacts(
  memoryRoot: string | undefined,
  enabledReminderChannels: string[] | undefined,
): Pick<HistoryMojibakeRepairReport, 'knowledgeRebuild' | 'reminderRebuild' | 'postRepairMojibakeCount'> {
  if (!memoryRoot || !fs.existsSync(memoryRoot)) return {};
  const knowledgeRebuild = rebuildKnowledgeIndex(memoryRoot);
  const knowledgeIndex = readKnowledgeIndex(memoryRoot);
  let reminderRebuild: HistoryMojibakeRepairReport['reminderRebuild'];
  if (knowledgeIndex) {
    const reminderIndex = rebuildReminderIndexFromKnowledge(memoryRoot, knowledgeIndex, {
      enabledChannels: enabledReminderChannels && enabledReminderChannels.length > 0 ? enabledReminderChannels : ['feishu'],
    });
    reminderRebuild = {
      schema: reminderIndex.schema,
      reminderCount: reminderIndex.reminderCount,
      pendingCount: reminderIndex.pendingCount,
      skippedCount: reminderIndex.skippedCount,
      generatedAt: reminderIndex.generatedAt,
    };
  }
  const postRepairMojibakeCount = knowledgeIndex ? countLikelyMojibake(JSON.stringify(knowledgeIndex)) : undefined;
  return { knowledgeRebuild, reminderRebuild, postRepairMojibakeCount };
}

export function runHistoryMojibakeRepair(options: HistoryMojibakeRepairOptions = {}): HistoryMojibakeRepairReport {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const ctiHome = options.ctiHome ? path.resolve(options.ctiHome) : defaultCtiHome();
  const memoryRoot = options.memoryRoot ? path.resolve(options.memoryRoot) : undefined;
  const backupRoot = options.backupRoot ? path.resolve(options.backupRoot) : defaultBackupRoot(ctiHome, generatedAt);
  const apply = options.apply === true;
  const mode: HistoryMojibakeRepairMode = apply ? 'apply' : 'scan';
  const targets = collectTargets(ctiHome, memoryRoot);
  const manifest: HistoryMojibakeBackupManifest = {
    schema: 'codex-im-suite/history-mojibake-backup/v1',
    createdAt: generatedAt,
    ctiHome,
    memoryRoot,
    entries: [],
  };
  const files: HistoryMojibakeFileReport[] = [];

  for (const target of targets) {
    let raw = '';
    try {
      raw = fs.readFileSync(target.path, 'utf-8');
    } catch {
      continue;
    }
    const hits = countLikelyMojibake(raw);
    if (hits === 0) continue;
    const { text, repair } = repairFileContent(raw, target);
    let backupPath: string | undefined;
    if (apply && repair.changed && text !== raw) {
      backupPath = writeBackup(target, raw, backupRoot, manifest);
      fs.writeFileSync(target.path, text, 'utf-8');
    }
    files.push({
      path: target.path,
      kind: target.kind,
      hits,
      changed: repair.changed && text !== raw,
      unresolved: repair.unresolved,
      backupPath,
    });
  }

  let backupManifestPath: string | undefined;
  if (apply && manifest.entries.length > 0) {
    backupManifestPath = path.join(backupRoot, 'manifest.json');
    fs.mkdirSync(path.dirname(backupManifestPath), { recursive: true });
    fs.writeFileSync(backupManifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  const rebuild = apply ? rebuildMemoryArtifacts(memoryRoot, options.enabledReminderChannels) : {};
  return {
    schema: 'codex-im-suite/history-mojibake-repair/v1',
    mode,
    generatedAt,
    ctiHome,
    memoryRoot,
    filesScanned: targets.length,
    filesWithHits: files.length,
    hitCount: files.reduce((sum, item) => sum + item.hits, 0),
    repairedFileCount: files.filter((item) => item.backupPath).length,
    unresolvedFileCount: files.filter((item) => item.unresolved).length,
    backupManifestPath,
    files,
    ...rebuild,
  };
}

export function restoreHistoryMojibakeBackup(manifestPath: string): HistoryMojibakeRestoreReport {
  const resolvedManifest = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(resolvedManifest, 'utf-8')) as HistoryMojibakeBackupManifest;
  if (manifest.schema !== 'codex-im-suite/history-mojibake-backup/v1') {
    throw new Error(`不支持的备份 manifest：${resolvedManifest}`);
  }
  let restoredFileCount = 0;
  for (const entry of manifest.entries) {
    if (!entry.originalPath || !entry.backupPath || !fs.existsSync(entry.backupPath)) continue;
    fs.mkdirSync(path.dirname(entry.originalPath), { recursive: true });
    fs.copyFileSync(entry.backupPath, entry.originalPath);
    restoredFileCount += 1;
  }
  const rebuild = rebuildMemoryArtifacts(manifest.memoryRoot, undefined);
  return {
    schema: 'codex-im-suite/history-mojibake-restore/v1',
    restoredAt: new Date().toISOString(),
    manifestPath: resolvedManifest,
    restoredFileCount,
    ...rebuild,
  };
}
