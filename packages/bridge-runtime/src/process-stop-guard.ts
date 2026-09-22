import fs from 'node:fs';
import path from 'node:path';

export interface CleanupProcessCheckOptions {
  ctiHome: string;
  memoryRoot?: string;
  isProcessAlive?: (pid: number) => boolean;
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

/**
 * 迁移、清理和恢复共享同一失败关闭门禁。该模块不包含 CLI 自启动逻辑，
 * 可以安全打包进其他命令入口，避免多个 CLI 在同一 bundle 中同时执行。
 */
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
