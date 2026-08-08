import type { ScheduledTaskListResult } from '../host.js';

export type ScheduledTaskReadIntent = 'list';

const SCHEDULED_TASK_TARGET_RE = /(?:计划任务|定时任务|定时提醒|计划提醒|调度任务|周期任务|提醒任务)/iu;
const READ_INTENT_RE = /(?:列出|列一下|查看|看看|查询|查一下|有哪些|有什么|列表|全部|所有|当前|正在运行|待执行|状态|多少)/iu;
const MUTATION_INTENT_RE = /(?:创建|新建|添加|设置|安排|修改|暂停|恢复|删除|取消|立即运行|重试|迁移)/iu;

/** 只识别无副作用的明确计划任务读取；混合修改请求继续交给完整 Agent/Policy 链。 */
export function resolveScheduledTaskReadIntent(text: string): ScheduledTaskReadIntent | null {
  const normalized = text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!normalized || !SCHEDULED_TASK_TARGET_RE.test(normalized)) return null;
  if (!READ_INTENT_RE.test(normalized) || MUTATION_INTENT_RE.test(normalized)) return null;
  return 'list';
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeText(value: unknown, maxLength = 160): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function projectSchedule(value: unknown): Record<string, unknown> | undefined {
  const source = record(value);
  if (!source) return undefined;
  const kind = safeText(source.kind, 24);
  if (!kind || !['at', 'every', 'cron'].includes(kind)) return undefined;
  return {
    kind,
    ...(safeText(source.at, 64) ? { at: safeText(source.at, 64) } : {}),
    ...(safeText(source.anchorAt, 64) ? { anchorAt: safeText(source.anchorAt, 64) } : {}),
    ...(typeof source.everyMs === 'number' && Number.isFinite(source.everyMs) ? { everyMs: source.everyMs } : {}),
    ...(safeText(source.expression, 120) ? { expression: safeText(source.expression, 120) } : {}),
    ...(safeText(source.timezone, 64) ? { timezone: safeText(source.timezone, 64) } : {}),
  };
}

function projectTaskItem(value: { task: unknown; state?: unknown }): Record<string, unknown> | null {
  const task = record(value.task);
  if (!task) return null;
  const state = record(value.state);
  const id = safeText(task.id, 96);
  const name = safeText(task.name, 200);
  if (!id || !name) return null;
  const action = record(task.action);
  return {
    id,
    name,
    ...(safeBoolean(task.enabled) !== undefined ? { enabled: safeBoolean(task.enabled) } : {}),
    ...(typeof task.version === 'number' && Number.isInteger(task.version) ? { version: task.version } : {}),
    ...(projectSchedule(task.schedule) ? { schedule: projectSchedule(task.schedule) } : {}),
    ...(safeText(action?.kind, 48) ? { actionKind: safeText(action?.kind, 48) } : {}),
    ...(state && safeText(state.nextRunAt, 64) ? { nextRunAt: safeText(state.nextRunAt, 64) } : {}),
    ...(state && safeText(state.runningRunId, 96) ? { running: true } : { running: false }),
    ...(state && safeText(state.lastRunStatus, 48) ? { lastRunStatus: safeText(state.lastRunStatus, 48) } : {}),
    ...(state && safeText(state.lastDeliveryStatus, 48) ? { lastDeliveryStatus: safeText(state.lastDeliveryStatus, 48) } : {}),
  };
}

/**
 * 将 Runtime Host 结果投影为无路径、无正文、无平台身份的可信只读 evidence。
 * Agent 只能整理这份快照，不能用记忆、工作区文件或模型猜测补任务状态。
 */
export function buildScheduledTaskReadEvidencePrompt(result: ScheduledTaskListResult): string {
  const sourceItems = result.items?.length
    ? result.items
    : result.tasks.map((task) => ({ task }));
  const tasks = sourceItems
    .map(projectTaskItem)
    .filter((item): item is Record<string, unknown> => Boolean(item));
  const evidence = result.ok
    ? { protocol: 'cti-scheduled-task-list-evidence/v1', status: 'ready', total: tasks.length, tasks }
    : { protocol: 'cti-scheduled-task-list-evidence/v1', status: 'error', total: 0, tasks: [], errorCode: 'scheduled_task_list_unavailable' };
  return [
    'Trusted scheduled-task read evidence (Bridge/Runtime Host):',
    JSON.stringify(evidence),
    'Answer the current read-only scheduled-task question from this evidence only.',
    'An empty tasks array means the trusted Host returned zero visible tasks; do not invent remembered reminders.',
    'If status=error, say the list could not be read now. Do not claim the list is empty and do not expose internal diagnostics.',
  ].join('\n');
}
