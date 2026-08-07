import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { cleanupStaleAtomicWriteTemps, writeUtf8TextAtomic } from '../atomic-text-file.js';
import { normalizeScheduledTaskSchedule } from './schedule.js';
import {
  SCHEDULED_TASK_RUN_SCHEMA,
  SCHEDULED_TASK_SCHEMA,
  SCHEDULED_TASK_CHECK_IN_SCHEMA,
  type ScheduledTaskCheckInState,
  type ScheduledTask,
  type ScheduledTaskAction,
  type ScheduledTaskCreate,
  type ScheduledTaskDelivery,
  type ScheduledTaskExecutionContext,
  type ScheduledTaskMisfirePolicy,
  type ScheduledTaskOwner,
  type ScheduledTaskRetryPolicy,
  type ScheduledTaskRun,
  type ScheduledTaskSchedule,
  type ScheduledTaskState,
  type VersionedScheduledTask,
  type VersionedScheduledTaskState,
} from './types.js';

const TASK_ID_RE = /^[a-z0-9][a-z0-9_-]{5,80}$/iu;
const SLOT_KEY_RE = /^[a-z0-9][a-z0-9_-]{5,128}$/iu;

export type ScheduledTaskPatch = Partial<{
  name: string;
  enabled: boolean;
  schedule: ScheduledTaskSchedule;
  action: ScheduledTaskAction;
  executionContext: ScheduledTaskExecutionContext;
  delivery: ScheduledTaskDelivery;
  misfirePolicy: ScheduledTaskMisfirePolicy;
  retryPolicy: ScheduledTaskRetryPolicy;
  owner: ScheduledTaskOwner;
}>;

export interface ScheduledTaskStore {
  listTasks(): Promise<VersionedScheduledTask[]>;
  getTask(taskId: string): Promise<VersionedScheduledTask | null>;
  createTask(task: ScheduledTaskCreate): Promise<VersionedScheduledTask>;
  updateTask(
    taskId: string,
    expectedVersion: number,
    patch: ScheduledTaskPatch,
  ): Promise<VersionedScheduledTask>;
  deleteTask(taskId: string, expectedVersion: number): Promise<void>;
  getState(taskId: string): Promise<VersionedScheduledTaskState | null>;
  compareAndSetState(
    taskId: string,
    expectedVersion: number,
    next: ScheduledTaskState,
  ): Promise<VersionedScheduledTaskState>;
  appendRun(run: ScheduledTaskRun): Promise<void>;
  listRuns(taskId: string, limit?: number): Promise<ScheduledTaskRun[]>;
  getRunBySlotKey(taskId: string, slotKey: string): Promise<ScheduledTaskRun | null>;
  getCheckIns(taskId: string, slotKey: string): Promise<ScheduledTaskCheckInState | null>;
  recordCheckIn(input: {
    taskId: string;
    runId: string;
    slotKey: string;
    channelType: string;
    userId: string;
    checkedInAt: string;
  }): Promise<{ recorded: boolean; state: ScheduledTaskCheckInState }>;
}

export type FileScheduledTaskStoreOptions = {
  now?: () => string;
  idFactory?: () => string;
};

type StorePaths = {
  root: string;
  tasks: string;
  states: string;
  runs: string;
  checkIns: string;
  quarantine: string;
};

function buildPaths(root: string): StorePaths {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    tasks: path.join(resolved, 'tasks'),
    states: path.join(resolved, 'states'),
    runs: path.join(resolved, 'runs'),
    checkIns: path.join(resolved, 'check-ins'),
    quarantine: path.join(resolved, 'quarantine'),
  };
}

function ensureStoreDirectories(paths: StorePaths): void {
  for (const directory of Object.values(paths)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function assertTaskId(taskId: string): string {
  const normalized = taskId.trim();
  if (!TASK_ID_RE.test(normalized)) throw new Error(`无效计划任务 ID：${taskId}`);
  return normalized;
}

function assertSlotKey(slotKey: string): string {
  const normalized = slotKey.trim();
  if (!SLOT_KEY_RE.test(normalized)) throw new Error(`无效计划任务运行槽位：${slotKey}`);
  return normalized;
}

function assertIsoTime(value: string, field: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`无效${field}：${value}`);
  return date.toISOString();
}

function validateTaskCreate(input: ScheduledTaskCreate): ScheduledTaskCreate {
  const name = input.name.trim();
  if (!name) throw new Error('计划任务名称不能为空');
  if (!input.executionContext.sourceSessionId.trim()) throw new Error('计划任务缺少来源会话');
  if (!input.delivery.channelType.trim() || !input.delivery.chatId.trim()) {
    throw new Error('计划任务缺少投递渠道或会话');
  }
  if (!input.owner.channelType.trim() || !input.owner.userId.trim()) {
    throw new Error('计划任务缺少创建者证据');
  }
  if (!Number.isFinite(input.misfirePolicy.maxLatenessMs) || input.misfirePolicy.maxLatenessMs < 0) {
    throw new Error('计划任务漏跑窗口无效');
  }
  if (!Number.isInteger(input.retryPolicy.maxAttempts) || input.retryPolicy.maxAttempts < 0) {
    throw new Error('计划任务重试次数无效');
  }
  return {
    ...input,
    name,
    schedule: normalizeScheduledTaskSchedule(input.schedule),
  };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  cleanupStaleAtomicWriteTemps(filePath);
  writeUtf8TextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseVersionedTask(value: unknown): VersionedScheduledTask {
  if (!isRecord(value)) throw new Error('计划任务记录不是对象');
  if (value.schema !== SCHEDULED_TASK_SCHEMA) throw new Error('计划任务 schema 不受支持');
  if (typeof value.id !== 'string') throw new Error('计划任务缺少 id');
  assertTaskId(value.id);
  if (!Number.isInteger(value.version) || Number(value.version) < 1) throw new Error('计划任务版本无效');
  if (typeof value.name !== 'string' || !value.name.trim()) throw new Error('计划任务名称无效');
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    throw new Error('计划任务时间戳无效');
  }
  assertIsoTime(value.createdAt, '创建时间');
  assertIsoTime(value.updatedAt, '更新时间');
  return value as VersionedScheduledTask;
}

function parseVersionedState(value: unknown, taskId: string): VersionedScheduledTaskState {
  if (!isRecord(value)) throw new Error('计划任务状态不是对象');
  if (value.taskId !== taskId) throw new Error('计划任务状态 ID 不匹配');
  if (!Number.isInteger(value.version) || Number(value.version) < 1) throw new Error('计划任务状态版本无效');
  return value as VersionedScheduledTaskState;
}

function parseRun(value: unknown, taskId: string): ScheduledTaskRun {
  if (!isRecord(value)) throw new Error('计划任务运行记录不是对象');
  if (value.schema !== SCHEDULED_TASK_RUN_SCHEMA) throw new Error('计划任务运行 schema 不受支持');
  if (value.taskId !== taskId) throw new Error('计划任务运行 ID 不匹配');
  if (typeof value.runId !== 'string' || !value.runId.trim()) throw new Error('计划任务运行缺少 runId');
  if (typeof value.queuedAt !== 'string') throw new Error('计划任务运行缺少排队时间');
  assertIsoTime(value.queuedAt, '排队时间');
  return value as ScheduledTaskRun;
}

function quarantineInvalidFile(
  paths: StorePaths,
  filePath: string,
  error: unknown,
  now: string,
): void {
  const timestamp = assertIsoTime(now, '隔离时间').replace(/[-:.]/gu, '');
  const baseName = path.basename(filePath, path.extname(filePath));
  const prefix = `${baseName}.${timestamp}`;
  const invalidPath = path.join(paths.quarantine, `${prefix}.invalid.json`);
  const errorPath = path.join(paths.quarantine, `${prefix}.error.json`);
  fs.renameSync(filePath, invalidPath);
  writeJsonAtomic(errorPath, {
    schema: 'codex-im-suite/scheduled-task-quarantine/v1',
    sourceName: path.basename(filePath),
    quarantinedAt: now,
    error: error instanceof Error ? error.message : String(error),
  });
}

function taskPath(paths: StorePaths, taskId: string): string {
  return path.join(paths.tasks, `${assertTaskId(taskId)}.json`);
}

function statePath(paths: StorePaths, taskId: string): string {
  return path.join(paths.states, `${assertTaskId(taskId)}.json`);
}

function runDirectory(paths: StorePaths, taskId: string): string {
  return path.join(paths.runs, assertTaskId(taskId));
}

function runPath(paths: StorePaths, run: ScheduledTaskRun): string {
  const name = crypto.createHash('sha256').update(run.runId).digest('hex');
  return path.join(runDirectory(paths, run.taskId), `${name}.json`);
}

function checkInDirectory(paths: StorePaths, taskId: string): string {
  return path.join(paths.checkIns, assertTaskId(taskId));
}

function checkInPath(paths: StorePaths, taskId: string, slotKey: string): string {
  const normalizedSlotKey = assertSlotKey(slotKey);
  const name = crypto.createHash('sha256').update(normalizedSlotKey).digest('hex');
  return path.join(checkInDirectory(paths, taskId), `${name}.json`);
}

function parseCheckInState(value: unknown, taskId: string, slotKey: string): ScheduledTaskCheckInState {
  if (!isRecord(value)) throw new Error('计划任务打卡记录不是对象');
  if (value.schema !== SCHEDULED_TASK_CHECK_IN_SCHEMA) throw new Error('计划任务打卡 schema 不受支持');
  if (value.taskId !== taskId || value.slotKey !== slotKey) throw new Error('计划任务打卡记录边界不匹配');
  if (typeof value.runId !== 'string' || !value.runId.trim()) throw new Error('计划任务打卡记录缺少 runId');
  if (typeof value.updatedAt !== 'string') throw new Error('计划任务打卡记录缺少更新时间');
  assertIsoTime(value.updatedAt, '打卡更新时间');
  if (!Array.isArray(value.entries)) throw new Error('计划任务打卡条目无效');
  for (const entry of value.entries) {
    if (!isRecord(entry) || typeof entry.channelType !== 'string' || !entry.channelType.trim()
      || typeof entry.userId !== 'string' || !entry.userId.trim() || typeof entry.checkedInAt !== 'string') {
      throw new Error('计划任务打卡参与者无效');
    }
    assertIsoTime(entry.checkedInAt, '打卡时间');
  }
  return value as ScheduledTaskCheckInState;
}

export function createFileScheduledTaskStore(
  root: string,
  options: FileScheduledTaskStoreOptions = {},
): ScheduledTaskStore {
  const paths = buildPaths(root);
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? (() => `task_${crypto.randomUUID().replace(/-/gu, '')}`);
  ensureStoreDirectories(paths);

  const readTask = (taskId: string): VersionedScheduledTask | null => {
    const filePath = taskPath(paths, taskId);
    if (!fs.existsSync(filePath)) return null;
    return parseVersionedTask(parseJsonFile(filePath));
  };

  return {
    async listTasks() {
      const tasks: VersionedScheduledTask[] = [];
      for (const name of fs.readdirSync(paths.tasks).filter((item) => item.endsWith('.json')).sort()) {
        const filePath = path.join(paths.tasks, name);
        try {
          tasks.push(parseVersionedTask(parseJsonFile(filePath)));
        } catch (error) {
          quarantineInvalidFile(paths, filePath, error, now());
        }
      }
      return tasks.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    },

    async getTask(taskId) {
      return readTask(taskId);
    },

    async createTask(input) {
      const taskId = assertTaskId(idFactory());
      const filePath = taskPath(paths, taskId);
      if (fs.existsSync(filePath)) throw new Error(`计划任务已存在：${taskId}`);
      const timestamp = assertIsoTime(now(), '当前时间');
      const task: VersionedScheduledTask = {
        schema: SCHEDULED_TASK_SCHEMA,
        id: taskId,
        version: 1,
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...validateTaskCreate(input),
      };
      writeJsonAtomic(filePath, task);
      return task;
    },

    async updateTask(taskId, expectedVersion, patch) {
      const current = readTask(taskId);
      if (!current) throw new Error(`计划任务不存在：${taskId}`);
      if (current.version !== expectedVersion) {
        throw new Error(`计划任务版本冲突：期望 ${expectedVersion}，实际 ${current.version}`);
      }
      const validated = validateTaskCreate({
        name: patch.name ?? current.name,
        schedule: patch.schedule ?? current.schedule,
        action: patch.action ?? current.action,
        executionContext: patch.executionContext ?? current.executionContext,
        delivery: patch.delivery ?? current.delivery,
        misfirePolicy: patch.misfirePolicy ?? current.misfirePolicy,
        retryPolicy: patch.retryPolicy ?? current.retryPolicy,
        owner: patch.owner ?? current.owner,
      });
      const updated: VersionedScheduledTask = {
        ...current,
        ...validated,
        enabled: patch.enabled ?? current.enabled,
        version: current.version + 1,
        updatedAt: assertIsoTime(now(), '当前时间'),
      };
      writeJsonAtomic(taskPath(paths, taskId), updated);
      return updated;
    },

    async deleteTask(taskId, expectedVersion) {
      const current = readTask(taskId);
      if (!current) throw new Error(`计划任务不存在：${taskId}`);
      if (current.version !== expectedVersion) {
        throw new Error(`计划任务版本冲突：期望 ${expectedVersion}，实际 ${current.version}`);
      }
      fs.rmSync(taskPath(paths, taskId), { force: true });
      fs.rmSync(statePath(paths, taskId), { force: true });
    },

    async getState(taskId) {
      const filePath = statePath(paths, taskId);
      if (!fs.existsSync(filePath)) return null;
      return parseVersionedState(parseJsonFile(filePath), assertTaskId(taskId));
    },

    async compareAndSetState(taskId, expectedVersion, next) {
      const id = assertTaskId(taskId);
      if (next.taskId !== id) throw new Error('计划任务状态 ID 不匹配');
      const filePath = statePath(paths, id);
      const current = fs.existsSync(filePath)
        ? parseVersionedState(parseJsonFile(filePath), id)
        : null;
      const actualVersion = current?.version ?? 0;
      if (actualVersion !== expectedVersion) {
        throw new Error(`计划任务状态版本冲突：期望 ${expectedVersion}，实际 ${actualVersion}`);
      }
      const { version: _ignoredVersion, ...state } = next as ScheduledTaskState & { version?: number };
      const updated: VersionedScheduledTaskState = {
        ...state,
        version: actualVersion + 1,
      };
      writeJsonAtomic(filePath, updated);
      return updated;
    },

    async appendRun(run) {
      const id = assertTaskId(run.taskId);
      if (run.taskId !== id) throw new Error('计划任务运行 ID 不匹配');
      parseRun(run, id);
      writeJsonAtomic(runPath(paths, run), run);
    },

    async listRuns(taskId, limit = 50) {
      const id = assertTaskId(taskId);
      const directory = runDirectory(paths, id);
      if (!fs.existsSync(directory)) return [];
      const runs: ScheduledTaskRun[] = [];
      for (const name of fs.readdirSync(directory).filter((item) => item.endsWith('.json'))) {
        const filePath = path.join(directory, name);
        try {
          runs.push(parseRun(parseJsonFile(filePath), id));
        } catch (error) {
          quarantineInvalidFile(paths, filePath, error, now());
        }
      }
      return runs
        .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt) || right.runId.localeCompare(left.runId))
        .slice(0, Math.max(0, Math.floor(limit)));
    },

    async getRunBySlotKey(taskId, slotKey) {
      const id = assertTaskId(taskId);
      const normalizedSlotKey = assertSlotKey(slotKey);
      const directory = runDirectory(paths, id);
      if (!fs.existsSync(directory)) return null;
      for (const name of fs.readdirSync(directory).filter((item) => item.endsWith('.json'))) {
        const filePath = path.join(directory, name);
        try {
          const run = parseRun(parseJsonFile(filePath), id);
          if (run.slotKey === normalizedSlotKey) return run;
        } catch (error) {
          quarantineInvalidFile(paths, filePath, error, now());
        }
      }
      return null;
    },

    async getCheckIns(taskId, slotKey) {
      const id = assertTaskId(taskId);
      const normalizedSlotKey = assertSlotKey(slotKey);
      const filePath = checkInPath(paths, id, normalizedSlotKey);
      if (!fs.existsSync(filePath)) return null;
      return parseCheckInState(parseJsonFile(filePath), id, normalizedSlotKey);
    },

    async recordCheckIn(input) {
      const taskId = assertTaskId(input.taskId);
      const slotKey = assertSlotKey(input.slotKey);
      const channelType = input.channelType.trim();
      const userId = input.userId.trim();
      if (!channelType || !userId) throw new Error('计划任务打卡缺少真实参与者身份');
      const checkedInAt = assertIsoTime(input.checkedInAt, '打卡时间');
      const filePath = checkInPath(paths, taskId, slotKey);
      const current = fs.existsSync(filePath)
        ? parseCheckInState(parseJsonFile(filePath), taskId, slotKey)
        : null;
      if (current && current.runId !== input.runId) throw new Error('计划任务打卡 runId 与槽位不匹配');
      const alreadyRecorded = current?.entries.some((entry) => (
        entry.channelType === channelType && entry.userId === userId
      )) ?? false;
      if (alreadyRecorded) return { recorded: false, state: current! };
      const state: ScheduledTaskCheckInState = {
        schema: SCHEDULED_TASK_CHECK_IN_SCHEMA,
        taskId,
        runId: input.runId,
        slotKey,
        updatedAt: checkedInAt,
        entries: [
          ...(current?.entries || []),
          { channelType, userId, checkedInAt },
        ],
      };
      writeJsonAtomic(filePath, state);
      return { recorded: true, state };
    },
  };
}
