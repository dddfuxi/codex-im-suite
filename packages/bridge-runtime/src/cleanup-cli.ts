import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyWorkspaceCleanupPlan,
  buildWorkspaceCleanupPlan,
  readWorkspaceCleanupPlan,
  restoreWorkspaceCleanupPlan,
  writeWorkspaceCleanupReports,
  type WorkspaceCleanupPlan,
} from './cleanup-plan.js';

interface CleanupCliOptions {
  targets: string[];
  ctiHome: string;
  memoryRoot?: string;
  apply: boolean;
  applyManifest?: string;
  restoreManifest?: string;
  now?: string;
}

export interface CleanupProcessCheckOptions {
  ctiHome: string;
  memoryRoot?: string;
  isProcessAlive?: (pid: number) => boolean;
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith('--')) throw new Error(`${option} 缺少参数值`);
  return value;
}

function parseCleanupCliOptions(argv: string[]): CleanupCliOptions {
  const options: CleanupCliOptions = {
    targets: [],
    ctiHome: process.env.CTI_HOME?.trim() || path.join(os.homedir(), '.claude-to-im'),
    memoryRoot: process.env.CTI_MEMORY_REPO_DIR?.trim() || undefined,
    apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--target') {
      options.targets.push(requireValue(argv, index, argument));
      index += 1;
    } else if (argument === '--cti-home') {
      options.ctiHome = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === '--memory-root') {
      options.memoryRoot = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === '--apply') {
      options.apply = true;
    } else if (argument === '--apply-manifest') {
      options.applyManifest = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === '--restore') {
      options.restoreManifest = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === '--now') {
      options.now = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      throw new Error('用法：cleanup-cli --target <目录> [--apply]；使用已审清单：cleanup-cli --apply-manifest <清单.json>；恢复：cleanup-cli --restore <清单.json>');
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  if (options.restoreManifest && (options.targets.length > 0 || options.apply || options.applyManifest)) {
    throw new Error('--restore 不能与 --target、--apply 或 --apply-manifest 同时使用');
  }
  if (options.applyManifest && (options.targets.length > 0 || options.apply)) {
    throw new Error('--apply-manifest 不能与 --target 或 --apply 同时使用');
  }
  if (!options.restoreManifest && !options.applyManifest && options.targets.length === 0) throw new Error('至少传入一个 --target');
  return {
    ...options,
    ctiHome: path.resolve(options.ctiHome),
    memoryRoot: options.memoryRoot ? path.resolve(options.memoryRoot) : undefined,
    restoreManifest: options.restoreManifest ? path.resolve(options.restoreManifest) : undefined,
    applyManifest: options.applyManifest ? path.resolve(options.applyManifest) : undefined,
    targets: options.targets.map((target) => path.resolve(target)),
  };
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readJsonIfExists(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch (error) {
    throw new Error(`无法解析进程状态文件，拒绝清理：${filePath}；${error instanceof Error ? error.message : String(error)}`);
  }
}

export function assertCleanupProcessesStopped(options: CleanupProcessCheckOptions): void {
  const isProcessAlive = options.isProcessAlive || defaultIsProcessAlive;
  const bridgeStatusPath = path.join(path.resolve(options.ctiHome), 'runtime', 'status.json');
  const bridgeStatus = readJsonIfExists(bridgeStatusPath);
  const bridgePid = Number(bridgeStatus?.pid || 0);
  if (bridgeStatus?.running === true && isProcessAlive(bridgePid)) {
    throw new Error(`Bridge 仍在运行（PID ${bridgePid}），拒绝 Apply/Restore。请先安全停止 Bridge。`);
  }

  if (!options.memoryRoot) return;
  const watcherStatusPath = path.join(path.resolve(options.memoryRoot), '.cti-index', 'status.json');
  const watcherStatus = readJsonIfExists(watcherStatusPath);
  const watcherPid = Number(watcherStatus?.watcherPid || 0);
  if (watcherStatus?.watching === true && (!watcherPid || isProcessAlive(watcherPid))) {
    throw new Error(`记忆索引 watcher 仍在运行（PID ${watcherPid || 'unknown'}），拒绝 Apply/Restore。`);
  }
}

export function runWorkspaceCleanupCli(argv: string[]): WorkspaceCleanupPlan {
  const options = parseCleanupCliOptions(argv);
  const processCheck = () => assertCleanupProcessesStopped({
    ctiHome: options.ctiHome,
    memoryRoot: options.memoryRoot,
  });
  if (options.restoreManifest) {
    const plan = readWorkspaceCleanupPlan(options.restoreManifest);
    return restoreWorkspaceCleanupPlan(plan, { assertProcessesStopped: processCheck });
  }
  if (options.applyManifest) {
    const plan = readWorkspaceCleanupPlan(options.applyManifest);
    if (path.resolve(plan.ctiHome) !== options.ctiHome) {
      throw new Error(`清单 CTI_HOME 与当前参数不一致：${plan.ctiHome}`);
    }
    return applyWorkspaceCleanupPlan(plan, { assertProcessesStopped: processCheck });
  }

  const plan = buildWorkspaceCleanupPlan({
    targets: options.targets,
    ctiHome: options.ctiHome,
    now: options.now,
  });
  writeWorkspaceCleanupReports(plan);
  return options.apply
    ? applyWorkspaceCleanupPlan(plan, { assertProcessesStopped: processCheck })
    : plan;
}

function isDirectExecution(): boolean {
  const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return entryPath === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    const plan = runWorkspaceCleanupCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({
      mode: plan.mode,
      report_json: plan.reportJsonPath,
      report_markdown: plan.reportMarkdownPath,
      backup_root: plan.backupRoot,
      totals: plan.totals,
      targets: plan.targets.map((target) => ({
        original_path: target.originalPath,
        backup_path: target.backupPath,
        classification: target.classification,
        automatic_cleanup_allowed: target.automaticCleanupAllowed,
      })),
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
