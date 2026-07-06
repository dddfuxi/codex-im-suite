import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME, type Config } from './config.js';
import { buildExecutorManifests, getConfiguredDefaultExecutorId, readSessionExecutorDefaults } from './executor-registry.js';
import type { ExecutorManifest, ExecutorSelection } from './executor-types.js';

export interface ExecutorRuntimeStatus {
  protocol: 'executor-runtime/v1';
  updatedAt: string;
  defaultExecutorId?: string;
  executors: ExecutorManifest[];
  sessionDefaults: Record<string, string>;
  lastSelection?: {
    sessionId: string;
    executorId: string;
    reason: string;
    explicit: boolean;
    fallbackExecutorIds: string[];
    selectedAt: string;
  };
}

const STATUS_PATH = path.join(CTI_HOME, 'runtime', 'executor-status.json');

function nowIso(): string {
  return new Date().toISOString();
}

export function getExecutorStatusPath(): string {
  return STATUS_PATH;
}

export function makeExecutorStatus(config: Config, selection?: { sessionId: string; selection: ExecutorSelection }): ExecutorRuntimeStatus {
  return {
    protocol: 'executor-runtime/v1',
    updatedAt: nowIso(),
    defaultExecutorId: getConfiguredDefaultExecutorId(config),
    executors: buildExecutorManifests(config),
    sessionDefaults: readSessionExecutorDefaults(config),
    ...(selection
      ? {
        lastSelection: {
          sessionId: selection.sessionId,
          executorId: selection.selection.executor.id,
          reason: selection.selection.reason,
          explicit: selection.selection.explicit,
          fallbackExecutorIds: selection.selection.fallbackExecutorIds,
          selectedAt: nowIso(),
        },
      }
      : {}),
  };
}

export function readExecutorStatus(config: Config): ExecutorRuntimeStatus {
  const fallback = makeExecutorStatus(config);
  try {
    if (!fs.existsSync(STATUS_PATH)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf-8')) as Partial<ExecutorRuntimeStatus>;
    return {
      ...fallback,
      ...parsed,
      executors: parsed.executors || fallback.executors,
      sessionDefaults: parsed.sessionDefaults || fallback.sessionDefaults,
    };
  } catch {
    return fallback;
  }
}

export function writeExecutorStatus(config: Config, selection?: { sessionId: string; selection: ExecutorSelection }): ExecutorRuntimeStatus {
  const next = makeExecutorStatus(config, selection);
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
  const tmp = `${STATUS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_PATH);
  return next;
}
