import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type {
  BridgeControlHost,
  BridgeRestartRequest,
  BridgeRestartScheduleResult,
} from 'claude-to-im/host';
import { CTI_HOME } from './config.js';

interface DetachedChild {
  unref(): void;
}

type SpawnDetached = (
  file: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean },
) => DetachedChild;

export interface BridgeControlHostOptions {
  skillRoot?: string;
  ctiHome?: string;
  now?: () => Date;
  spawnDetached?: SpawnDetached;
}

const RESTART_DELAY_MS = 2000;

function defaultSkillRoot(): string {
  // src/*.ts 和构建后的 dist/daemon.mjs 都位于 skill 根目录的一级子目录。
  return path.resolve(fileURLToPath(new URL('../', import.meta.url)));
}

function appendAudit(
  ctiHome: string,
  request: BridgeRestartRequest,
  at: string,
  result: 'scheduled' | 'failed',
  detail?: string,
): void {
  const auditPath = path.join(ctiHome, 'data', 'bridge-control-audit.jsonl');
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(auditPath, `${JSON.stringify({
    protocol: 'cti-bridge-control-audit/v1',
    at,
    action: 'restart_live',
    actor: request.requestedBy,
    result,
    ...(detail ? { detail: detail.slice(0, 500) } : {}),
  })}\n`, 'utf8');
}

export function createBridgeControlHost(options: BridgeControlHostOptions = {}): BridgeControlHost {
  const skillRoot = path.resolve(options.skillRoot || defaultSkillRoot());
  const ctiHome = path.resolve(options.ctiHome || CTI_HOME);
  const now = options.now || (() => new Date());
  const spawnDetached = options.spawnDetached || ((file, args, spawnOptions) => spawn(file, args, spawnOptions));
  const workerPath = path.join(skillRoot, 'scripts', 'restart-live-bridge.mjs');

  return {
    async scheduleRestart(request): Promise<BridgeRestartScheduleResult> {
      const requestedAt = now();
      if (!fs.existsSync(workerPath)) {
        const error = `受控重启 worker 不存在：${workerPath}`;
        appendAudit(ctiHome, request, requestedAt.toISOString(), 'failed', error);
        return { ok: false, error };
      }
      try {
        // 只启动仓库自带 worker，不接受模型或用户传入命令、路径和参数。
        const child = spawnDetached(process.execPath, [workerPath], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
        const scheduledFor = new Date(requestedAt.getTime() + RESTART_DELAY_MS).toISOString();
        appendAudit(ctiHome, request, requestedAt.toISOString(), 'scheduled');
        return { ok: true, scheduledFor, message: 'live Bridge restart scheduled' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendAudit(ctiHome, request, requestedAt.toISOString(), 'failed', message);
        return { ok: false, error: `无法启动受控重启 worker：${message}` };
      }
    },
  };
}
