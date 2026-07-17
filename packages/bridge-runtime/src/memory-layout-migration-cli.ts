import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readKnowledgeIndexStatus } from './knowledge-index-service.js';
import {
  migrateMemoryLayout,
  type MemoryLayoutMigrationReport,
} from './memory-layout-migration.js';

interface CliOptions {
  memoryRoot: string;
  apply: boolean;
  reportPath?: string;
  now?: string;
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith('--')) throw new Error(`${option} 缺少参数值`);
  return value;
}

function parseCliOptions(argv: string[]): CliOptions {
  let memoryRoot = process.env.CTI_MEMORY_REPO_DIR?.trim() || '';
  let apply = false;
  let reportPath: string | undefined;
  let now: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      apply = true;
    } else if (argument === '--memory-root') {
      memoryRoot = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === '--report') {
      reportPath = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === '--now') {
      now = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      throw new Error('用法：memory-layout-migration-cli --memory-root <路径> [--apply] [--report <JSON路径>]');
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  if (!memoryRoot) throw new Error('缺少记忆库路径；请传入 --memory-root 或设置 CTI_MEMORY_REPO_DIR');
  return {
    memoryRoot: path.resolve(memoryRoot),
    apply,
    reportPath: reportPath ? path.resolve(reportPath) : undefined,
    now,
  };
}

function assertApplyIsSafe(memoryRoot: string): void {
  const status = readKnowledgeIndexStatus(memoryRoot);
  if (!status.watching) return;
  if (status.watcherPid && !isProcessAlive(status.watcherPid)) return;
  throw new Error(`记忆索引 watcher 仍在运行，拒绝 Apply：${memoryRoot}。请先安全停止 Bridge。`);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function writeReport(reportPath: string, report: MemoryLayoutMigrationReport): void {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const tempPath = `${reportPath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, reportPath);
}

export function runMemoryLayoutMigrationCli(argv: string[]): MemoryLayoutMigrationReport {
  const options = parseCliOptions(argv);
  if (options.apply) assertApplyIsSafe(options.memoryRoot);
  const report = migrateMemoryLayout(options.memoryRoot, {
    apply: options.apply,
    now: options.now,
  });
  if (options.reportPath) writeReport(options.reportPath, report);
  return report;
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return entryPath === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    const report = runMemoryLayoutMigrationCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
