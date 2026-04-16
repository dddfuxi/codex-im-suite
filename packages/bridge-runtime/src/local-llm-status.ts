import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME, type Config } from './config.js';

export interface LocalLlmRuntimeStatus {
  enabled: boolean;
  autoRoute: boolean;
  baseUrl: string;
  model: string;
  routeHits: number;
  routeMisses: number;
  fallbackCount: number;
  serverReachable?: boolean;
  lastCheckAt?: string;
  lastRouteReason?: string;
  lastFallbackReason?: string;
  lastProvider?: 'local' | 'codex';
  lastRequestKind?: string;
  lastError?: string;
  updatedAt?: string;
}

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_PATH = path.join(RUNTIME_DIR, 'local-llm-status.json');

function nowIso(): string {
  return new Date().toISOString();
}

export function getLocalLlmStatusPath(): string {
  return STATUS_PATH;
}

export function makeDefaultLocalLlmStatus(config: Config): LocalLlmRuntimeStatus {
  return {
    enabled: config.localLlmEnabled === true,
    autoRoute: config.localLlmAutoRoute !== false,
    baseUrl: config.localLlmBaseUrl || 'http://127.0.0.1:8080',
    model: config.localLlmModel || 'qwen2.5-coder-7b-instruct',
    routeHits: 0,
    routeMisses: 0,
    fallbackCount: 0,
    updatedAt: nowIso(),
  };
}

export function readLocalLlmStatus(config?: Config): LocalLlmRuntimeStatus {
  const fallback = makeDefaultLocalLlmStatus(config || {
    runtime: 'codex',
    enabledChannels: [],
    defaultWorkDir: process.cwd(),
    defaultMode: 'code',
  });
  try {
    if (!fs.existsSync(STATUS_PATH)) return fallback;
    const raw = fs.readFileSync(STATUS_PATH, 'utf-8').trim();
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) as Partial<LocalLlmRuntimeStatus> };
  } catch {
    return fallback;
  }
}

export function writeLocalLlmStatus(next: LocalLlmRuntimeStatus): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const tmp = `${STATUS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...next, updatedAt: nowIso() }, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_PATH);
}

export function updateLocalLlmStatus(config: Config, patch: Partial<LocalLlmRuntimeStatus>): LocalLlmRuntimeStatus {
  const current = readLocalLlmStatus(config);
  const next = {
    ...current,
    enabled: config.localLlmEnabled === true,
    autoRoute: config.localLlmAutoRoute !== false,
    baseUrl: config.localLlmBaseUrl || current.baseUrl,
    model: config.localLlmModel || current.model,
    ...patch,
  };
  writeLocalLlmStatus(next);
  return next;
}
