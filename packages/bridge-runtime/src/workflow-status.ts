import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME } from './config.js';

export type WorkflowStage =
  | 'received'
  | 'authorized'
  | 'contextualized'
  | 'routed'
  | 'executing'
  | 'finalizing'
  | 'delivered'
  | 'failed';

export interface WorkflowEvent {
  id: string;
  runId: string;
  stage: WorkflowStage;
  type: string;
  message: string;
  at: string;
  data?: Record<string, unknown>;
}

export interface WorkflowRun {
  id: string;
  sessionId: string;
  channelType?: string;
  chatId?: string;
  promptPreview: string;
  stage: WorkflowStage;
  status: 'running' | 'succeeded' | 'failed';
  executorId?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  error?: string;
  events: WorkflowEvent[];
}

export interface WorkflowStatusFile {
  protocol: 'workflow-runtime/v1';
  updatedAt: string;
  runs: WorkflowRun[];
}

const STATUS_PATH = path.join(CTI_HOME, 'runtime', 'workflow-runs.json');
const MAX_RUNS = 80;
const MAX_EVENTS_PER_RUN = 80;

function nowIso(): string {
  return new Date().toISOString();
}

function preview(text: string, limit = 180): string {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized;
}

export function getWorkflowStatusPath(): string {
  return STATUS_PATH;
}

export function readWorkflowStatus(): WorkflowStatusFile {
  try {
    if (!fs.existsSync(STATUS_PATH)) {
      return { protocol: 'workflow-runtime/v1', updatedAt: nowIso(), runs: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf-8')) as Partial<WorkflowStatusFile>;
    return {
      protocol: 'workflow-runtime/v1',
      updatedAt: parsed.updatedAt || nowIso(),
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch {
    return { protocol: 'workflow-runtime/v1', updatedAt: nowIso(), runs: [] };
  }
}

function writeWorkflowStatus(next: WorkflowStatusFile): WorkflowStatusFile {
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
  const tmp = `${STATUS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...next, updatedAt: nowIso() }, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_PATH);
  return next;
}

function event(runId: string, stage: WorkflowStage, type: string, message: string, data?: Record<string, unknown>): WorkflowEvent {
  return {
    id: crypto.randomUUID(),
    runId,
    stage,
    type,
    message,
    at: nowIso(),
    data,
  };
}

export function startWorkflowRun(data: {
  sessionId: string;
  prompt: string;
  channelType?: string;
  chatId?: string;
}): WorkflowRun {
  const timestamp = nowIso();
  const run: WorkflowRun = {
    id: crypto.randomUUID(),
    sessionId: data.sessionId,
    channelType: data.channelType,
    chatId: data.chatId,
    promptPreview: preview(data.prompt),
    stage: 'received',
    status: 'running',
    startedAt: timestamp,
    updatedAt: timestamp,
    events: [],
  };
  run.events.push(event(run.id, 'received', 'workflow.received', '请求进入 workflow'));
  const current = readWorkflowStatus();
  writeWorkflowStatus({
    protocol: 'workflow-runtime/v1',
    updatedAt: timestamp,
    runs: [...current.runs, run].slice(-MAX_RUNS),
  });
  return run;
}

export function appendWorkflowEvent(
  runId: string,
  stage: WorkflowStage,
  type: string,
  message: string,
  data?: Record<string, unknown>,
): WorkflowRun | null {
  const current = readWorkflowStatus();
  const index = current.runs.findIndex((run) => run.id === runId);
  if (index < 0) return null;
  const nextEvent = event(runId, stage, type, message, data);
  const run = {
    ...current.runs[index],
    stage,
    updatedAt: nowIso(),
    events: [...current.runs[index].events, nextEvent].slice(-MAX_EVENTS_PER_RUN),
  };
  const runs = [...current.runs];
  runs[index] = run;
  writeWorkflowStatus({ ...current, runs });
  return run;
}

export function setWorkflowExecutor(runId: string, executorId: string, reason: string): WorkflowRun | null {
  const current = readWorkflowStatus();
  const index = current.runs.findIndex((run) => run.id === runId);
  if (index < 0) return null;
  const run = {
    ...current.runs[index],
    executorId,
    stage: 'routed' as WorkflowStage,
    updatedAt: nowIso(),
    events: [
      ...current.runs[index].events,
      event(runId, 'routed', 'executor.selected', reason, { executorId }),
    ].slice(-MAX_EVENTS_PER_RUN),
  };
  const runs = [...current.runs];
  runs[index] = run;
  writeWorkflowStatus({ ...current, runs });
  return run;
}

export function completeWorkflowRun(runId: string, message = 'workflow completed'): WorkflowRun | null {
  const current = readWorkflowStatus();
  const index = current.runs.findIndex((run) => run.id === runId);
  if (index < 0) return null;
  const timestamp = nowIso();
  const run = {
    ...current.runs[index],
    stage: 'delivered' as WorkflowStage,
    status: 'succeeded' as const,
    updatedAt: timestamp,
    endedAt: timestamp,
    events: [...current.runs[index].events, event(runId, 'delivered', 'workflow.completed', message)].slice(MAX_EVENTS_PER_RUN * -1),
  };
  const runs = [...current.runs];
  runs[index] = run;
  writeWorkflowStatus({ ...current, runs });
  return run;
}

export function failWorkflowRun(runId: string, error: unknown): WorkflowRun | null {
  const current = readWorkflowStatus();
  const index = current.runs.findIndex((run) => run.id === runId);
  if (index < 0) return null;
  const timestamp = nowIso();
  const message = error instanceof Error ? error.message : String(error);
  const run = {
    ...current.runs[index],
    stage: 'failed' as WorkflowStage,
    status: 'failed' as const,
    error: message,
    updatedAt: timestamp,
    endedAt: timestamp,
    events: [...current.runs[index].events, event(runId, 'failed', 'workflow.failed', message)].slice(MAX_EVENTS_PER_RUN * -1),
  };
  const runs = [...current.runs];
  runs[index] = run;
  writeWorkflowStatus({ ...current, runs });
  return run;
}
