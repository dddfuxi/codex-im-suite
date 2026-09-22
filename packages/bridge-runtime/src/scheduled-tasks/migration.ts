import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseMemorySourceFrontmatter } from '../memory-source-policy.js';
import type { ScheduledTaskStore } from './store.js';
import type { ScheduledTaskCreate } from './types.js';

export type ScheduledTaskMigrationOperation = {
  sourcePath: string;
  sourceHash: string;
  action: 'create' | 'skip' | 'blocked';
  reason: string;
  task?: ScheduledTaskCreate;
};

export type ScheduledTaskMigrationPlan = {
  schema: 'codex-im-suite/scheduled-task-migration/v1';
  generatedAt: string;
  sourceRoot: string;
  scheduledTasksRoot: string;
  operations: ScheduledTaskMigrationOperation[];
};

export type ScheduledTaskMigrationEntry = {
  sourcePath: string;
  sourceHash: string;
  taskId: string;
  backupPath: string;
  migratedAt: string;
};

export type ScheduledTaskMigrationApplyResult = {
  schema: 'codex-im-suite/scheduled-task-migration-apply/v1';
  appliedAt: string;
  manifestPath: string;
  created: number;
  skipped: number;
  blocked: number;
  entries: ScheduledTaskMigrationEntry[];
};

type BuildMigrationPlanInput = {
  memoryRoot: string;
  scheduledTasksRoot: string;
  now?: string;
};

type ApplyMigrationPlanOptions = {
  store: ScheduledTaskStore;
  assertProcessesStopped: () => void;
  now?: () => string;
};

type StoredMigrationManifest = {
  schema: 'codex-im-suite/scheduled-task-migration-manifest/v1';
  updatedAt: string;
  entries: ScheduledTaskMigrationEntry[];
};

const MIGRATION_SCHEMA = 'codex-im-suite/scheduled-task-migration/v1' as const;

function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function manifestPath(scheduledTasksRoot: string): string {
  return path.join(path.resolve(scheduledTasksRoot), 'migrations', 'direct-reminders.json');
}

function readManifest(scheduledTasksRoot: string): StoredMigrationManifest {
  const filePath = manifestPath(scheduledTasksRoot);
  if (!fs.existsSync(filePath)) {
    return { schema: 'codex-im-suite/scheduled-task-migration-manifest/v1', updatedAt: '', entries: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as StoredMigrationManifest;
    return parsed?.schema === 'codex-im-suite/scheduled-task-migration-manifest/v1' && Array.isArray(parsed.entries)
      ? parsed
      : { schema: 'codex-im-suite/scheduled-task-migration-manifest/v1', updatedAt: '', entries: [] };
  } catch (error) {
    throw new Error(`无法解析 direct reminder 迁移清单：${filePath}；${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

function parseDueAt(text: string): string | undefined {
  const match = text.match(/(?:@|提醒时间\s*[:：]\s*)(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})/u);
  if (!match) return undefined;
  const parsed = new Date(`${match[1]}T${match[2].padStart(5, '0')}:00+08:00`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function parseNotifyTargets(raw: string | undefined): Array<{ userId?: string; name?: string; atAll?: boolean }> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const result = parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const value = item as Record<string, unknown>;
      const userId = typeof value.userId === 'string' ? value.userId.trim() : '';
      const name = typeof value.name === 'string' ? value.name.trim() : '';
      const atAll = value.atAll === true;
      if (!userId && !atAll) return [];
      return [{ ...(userId ? { userId } : {}), ...(name ? { name } : {}), ...(atAll ? { atAll: true } : {}) }];
    });
    return result.length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}

function parseLegacyReminder(sourcePath: string, sourceHash: string): ScheduledTaskMigrationOperation {
  try {
    const markdown = fs.readFileSync(sourcePath, 'utf8');
    const metadata = parseMemorySourceFrontmatter(markdown) || {};
    const body = markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '');
    const todoLine = body.split(/\r?\n/u).map((line) => line.trim()).find((line) => /^(?:[-*]\s*)?待办\s*[:：]/u.test(line));
    if (!todoLine) return { sourcePath, sourceHash, action: 'blocked', reason: '未找到可识别的待办正文' };
    if (/状态\s*[:：]\s*(?:完成|已完成|取消|已取消|done|closed|cancelled|canceled)/iu.test(todoLine)) {
      return { sourcePath, sourceHash, action: 'skip', reason: '旧 direct reminder 已完成或取消' };
    }
    const dueAt = parseDueAt(todoLine);
    if (!dueAt) return { sourcePath, sourceHash, action: 'blocked', reason: '旧 direct reminder 缺少有效提醒时间' };
    const channelType = (metadata.channelType || '').trim();
    const chatId = (metadata.chatId || '').trim();
    if (!channelType || !chatId) return { sourcePath, sourceHash, action: 'blocked', reason: '旧 direct reminder 缺少投递渠道或会话' };
    const title = todoLine
      .replace(/^(?:[-*]\s*)?待办\s*[:：]\s*/u, '')
      .replace(/(?:@|提醒时间\s*[:：]\s*)\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}/u, '')
      .replace(/状态\s*[:：]\s*[^\s,，;；]+/u, '')
      .trim();
    if (!title) return { sourcePath, sourceHash, action: 'blocked', reason: '旧 direct reminder 标题为空' };
    const migrationIdentity = `legacy-direct-reminder:${sourceHash}`;
    return {
      sourcePath,
      sourceHash,
      action: 'create',
      reason: '未完成且时间、投递目标有效',
      task: {
        name: title,
        schedule: { kind: 'at', at: dueAt, timezone: metadata.timezone || 'Asia/Shanghai' },
        action: { kind: 'notify', text: `待办提醒：${title}` },
        executionContext: {
          sourceSessionId: metadata.sessionId || migrationIdentity,
          workspaceMode: 'none',
        },
        delivery: {
          channelType,
          chatId,
          chatType: metadata.chatType || undefined,
          notifyTargets: parseNotifyTargets(metadata.notifyTargets),
          mode: 'result',
        },
        misfirePolicy: { mode: 'run_latest', maxLatenessMs: 15 * 60_000 },
        retryPolicy: {
          maxAttempts: 3,
          backoffMs: [5_000, 30_000, 120_000],
          retryOn: ['rate_limit', 'overloaded', 'network', 'timeout', 'server_error'],
        },
        owner: {
          channelType,
          userId: metadata.createdByUserId || `legacy-migration:${sourceHash.slice(0, 16)}`,
          sourceMessageId: migrationIdentity,
        },
      },
    };
  } catch (error) {
    return { sourcePath, sourceHash, action: 'blocked', reason: `读取失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

export function buildScheduledTaskMigrationPlan(input: BuildMigrationPlanInput): ScheduledTaskMigrationPlan {
  const sourceRoot = path.join(path.resolve(input.memoryRoot), 'data', 'todos', 'direct-reminders');
  const scheduledTasksRoot = path.resolve(input.scheduledTasksRoot);
  const migratedHashes = new Set(readManifest(scheduledTasksRoot).entries.map((entry) => entry.sourceHash));
  const operations: ScheduledTaskMigrationOperation[] = [];
  if (fs.existsSync(sourceRoot)) {
    for (const name of fs.readdirSync(sourceRoot).sort((left, right) => left.localeCompare(right))) {
      if (!name.toLowerCase().endsWith('.md')) continue;
      const sourcePath = path.join(sourceRoot, name);
      const sourceHash = hashFile(sourcePath);
      operations.push(migratedHashes.has(sourceHash)
        ? { sourcePath, sourceHash, action: 'skip', reason: '相同 source hash 已迁移' }
        : parseLegacyReminder(sourcePath, sourceHash));
    }
  }
  return {
    schema: MIGRATION_SCHEMA,
    generatedAt: input.now || new Date().toISOString(),
    sourceRoot,
    scheduledTasksRoot,
    operations,
  };
}

export async function applyScheduledTaskMigrationPlan(
  plan: ScheduledTaskMigrationPlan,
  options: ApplyMigrationPlanOptions,
): Promise<ScheduledTaskMigrationApplyResult> {
  if (plan.schema !== MIGRATION_SCHEMA) throw new Error(`不支持的迁移计划协议：${plan.schema}`);
  options.assertProcessesStopped();
  for (const operation of plan.operations.filter((item) => item.action === 'create')) {
    if (!fs.existsSync(operation.sourcePath) || hashFile(operation.sourcePath) !== operation.sourceHash) {
      throw new Error(`源文件已变化，拒绝 Apply：${operation.sourcePath}`);
    }
    if (!operation.task) throw new Error(`迁移计划缺少任务定义：${operation.sourcePath}`);
  }

  const appliedAt = options.now?.() || new Date().toISOString();
  const stored = readManifest(plan.scheduledTasksRoot);
  const knownHashes = new Set(stored.entries.map((entry) => entry.sourceHash));
  const entries = [...stored.entries];
  const backupRoot = path.join(
    path.resolve(plan.scheduledTasksRoot),
    'migrations',
    'backups',
    appliedAt.replace(/[:.]/gu, '-'),
  );
  let created = 0;
  let skipped = plan.operations.filter((item) => item.action === 'skip').length;
  const blocked = plan.operations.filter((item) => item.action === 'blocked').length;

  for (const operation of plan.operations.filter((item) => item.action === 'create')) {
    if (knownHashes.has(operation.sourceHash)) {
      skipped += 1;
      continue;
    }
    const backupPath = path.join(backupRoot, `${operation.sourceHash.slice(0, 16)}-${path.basename(operation.sourcePath)}`);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(operation.sourcePath, backupPath, fs.constants.COPYFILE_EXCL);
    const task = await options.store.createTask(operation.task!);
    const entry: ScheduledTaskMigrationEntry = {
      sourcePath: operation.sourcePath,
      sourceHash: operation.sourceHash,
      taskId: task.id,
      backupPath,
      migratedAt: appliedAt,
    };
    entries.push(entry);
    knownHashes.add(operation.sourceHash);
    created += 1;
    writeJsonAtomic(manifestPath(plan.scheduledTasksRoot), {
      schema: 'codex-im-suite/scheduled-task-migration-manifest/v1',
      updatedAt: appliedAt,
      entries,
    } satisfies StoredMigrationManifest);
  }

  return {
    schema: 'codex-im-suite/scheduled-task-migration-apply/v1',
    appliedAt,
    manifestPath: manifestPath(plan.scheduledTasksRoot),
    created,
    skipped,
    blocked,
    entries: entries.filter((entry) => entry.migratedAt === appliedAt),
  };
}
