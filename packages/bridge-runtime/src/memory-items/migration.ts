import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assertCleanupProcessesStopped } from '../process-stop-guard.js';
import { createMemoryItemLifecycleService } from './lifecycle.js';
import {
  readManagedMemoryDocument,
  writeManagedMemoryDocument,
} from './managed-document.js';

export interface MemoryCandidateMigrationOperation {
  sourcePath: string;
  sourceHash: string;
  candidateCount: number;
  action: 'upgrade' | 'skip' | 'blocked';
  reason?: string;
}

export interface MemoryCandidateMigrationPlan {
  schema: 'codex-im-suite/memory-candidate-migration/v1';
  createdAt: string;
  memoryRoot: string;
  operations: MemoryCandidateMigrationOperation[];
}

export interface MemoryCandidateMigrationResult {
  schema: 'codex-im-suite/memory-candidate-migration-result/v1';
  memoryRoot: string;
  backupRoot: string;
  migratedFiles: number;
  migratedCandidates: number;
  skippedFiles: number;
  appliedAt: string;
}

export interface BuildMemoryCandidateMigrationPlanOptions {
  memoryRoot: string;
  now?: string;
}

export interface ApplyMemoryCandidateMigrationPlanOptions {
  assertProcessesStopped?: (memoryRoot: string) => void;
}

const STATE_RE = /<!--\s*cti-memory-state:([^\s]+)\s*-->/u;

function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function compactTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('invalid_migration_time');
  return parsed.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, '').replace('T', '-');
}

function rawStateVersion(content: string): number | null {
  const match = content.match(STATE_RE);
  if (!match) return null;
  try {
    const state = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as { version?: number };
    return Number.isInteger(state.version) ? state.version! : 1;
  } catch {
    return null;
  }
}

function listManagedMemoryFiles(memoryRoot: string): string[] {
  const memoryDir = path.join(path.resolve(memoryRoot), 'memory');
  if (!fs.existsSync(memoryDir)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (content.includes('cti-memory-state:')) files.push(fullPath);
      }
    }
  };
  visit(memoryDir);
  return files.sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertMigrationProcessesStopped(memoryRoot: string): void {
  assertCleanupProcessesStopped({
    ctiHome: process.env.CTI_HOME?.trim() || path.join(os.homedir(), '.claude-to-im'),
    memoryRoot,
  });
}

export function buildMemoryCandidateMigrationPlan(
  options: BuildMemoryCandidateMigrationPlanOptions,
): MemoryCandidateMigrationPlan {
  const memoryRoot = path.resolve(options.memoryRoot);
  const operations = listManagedMemoryFiles(memoryRoot).map((sourcePath): MemoryCandidateMigrationOperation => {
    const sourceHash = hashFile(sourcePath);
    try {
      const content = fs.readFileSync(sourcePath, 'utf8');
      const document = readManagedMemoryDocument(sourcePath);
      const candidateCount = Object.keys(document.state.candidates).length;
      const version = rawStateVersion(content);
      const needsUpgrade = version !== 2 || content.includes('## 暂定印象');
      return {
        sourcePath,
        sourceHash,
        candidateCount,
        action: needsUpgrade ? 'upgrade' : 'skip',
        ...(needsUpgrade ? {} : { reason: 'already_managed_v2' }),
      };
    } catch (error) {
      return {
        sourcePath,
        sourceHash,
        candidateCount: 0,
        action: 'blocked',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
  return {
    schema: 'codex-im-suite/memory-candidate-migration/v1',
    createdAt: options.now || new Date().toISOString(),
    memoryRoot,
    operations,
  };
}

export function applyMemoryCandidateMigrationPlan(
  plan: MemoryCandidateMigrationPlan,
  options: ApplyMemoryCandidateMigrationPlanOptions = {},
): MemoryCandidateMigrationResult {
  if (plan.schema !== 'codex-im-suite/memory-candidate-migration/v1') throw new Error('invalid_migration_manifest');
  const memoryRoot = path.resolve(plan.memoryRoot);
  (options.assertProcessesStopped || assertMigrationProcessesStopped)(memoryRoot);
  const planHash = crypto.createHash('sha256').update(JSON.stringify(plan), 'utf8').digest('hex');
  const ledgerPath = path.join(memoryRoot, '.cti-memory-items', 'migrations', `${planHash}.json`);
  if (fs.existsSync(ledgerPath)) {
    try {
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as {
        plan?: MemoryCandidateMigrationPlan;
        result?: MemoryCandidateMigrationResult;
      };
      const embeddedPlanHash = ledger.plan
        ? crypto.createHash('sha256').update(JSON.stringify(ledger.plan), 'utf8').digest('hex')
        : '';
      if (
        ledger.plan?.schema !== plan.schema
        || embeddedPlanHash !== planHash
        || ledger.result?.schema !== 'codex-im-suite/memory-candidate-migration-result/v1'
        || path.resolve(ledger.result.memoryRoot) !== memoryRoot
        || !isInside(path.join(memoryRoot, 'backups', 'memory-candidate-migration'), ledger.result.backupRoot)
      ) {
        throw new Error('invalid_migration_ledger');
      }
      return {
        ...ledger.result,
        migratedFiles: 0,
        migratedCandidates: 0,
        skippedFiles: plan.operations.length,
        appliedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid_migration_ledger') throw error;
      throw new Error('invalid_migration_ledger');
    }
  }
  const backupRoot = path.join(memoryRoot, 'backups', 'memory-candidate-migration', compactTimestamp(plan.createdAt));
  const upgraded: Array<{ sourcePath: string; backupPath: string }> = [];
  let migratedCandidates = 0;
  let skippedFiles = 0;

  try {
    for (const operation of plan.operations) {
      const sourcePath = path.resolve(operation.sourcePath);
      if (!isInside(path.join(memoryRoot, 'memory'), sourcePath)) throw new Error('migration_source_outside_memory');
      if (operation.action === 'blocked') throw new Error(`migration_blocked: ${operation.reason || sourcePath}`);
      if (operation.action === 'skip') {
        skippedFiles += 1;
        continue;
      }
      if (!fs.existsSync(sourcePath)) throw new Error('migration_source_missing');
      const currentHash = hashFile(sourcePath);
      if (currentHash !== operation.sourceHash) throw new Error('source_changed');
      const relative = path.relative(memoryRoot, sourcePath);
      const backupPath = path.join(backupRoot, relative);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(sourcePath, backupPath);
      upgraded.push({ sourcePath, backupPath });
      const document = readManagedMemoryDocument(sourcePath);
      document.metadata.updatedAt = plan.createdAt;
      writeManagedMemoryDocument(document, currentHash);
      migratedCandidates += operation.candidateCount;
    }

    createMemoryItemLifecycleService({ memoryRoot, now: () => plan.createdAt }).refreshHumanReadableDocuments();
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const result: MemoryCandidateMigrationResult = {
      schema: 'codex-im-suite/memory-candidate-migration-result/v1',
      memoryRoot,
      backupRoot,
      migratedFiles: upgraded.length,
      migratedCandidates,
      skippedFiles,
      appliedAt: new Date().toISOString(),
    };
    const tempPath = `${ledgerPath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify({ plan, result }, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, ledgerPath);
    return result;
  } catch (error) {
    for (const item of [...upgraded].reverse()) fs.copyFileSync(item.backupPath, item.sourcePath);
    try {
      createMemoryItemLifecycleService({ memoryRoot }).refreshHumanReadableDocuments();
    } catch {
      // 保留原始错误；备份仍可用于人工恢复。
    }
    throw error;
  }
}
