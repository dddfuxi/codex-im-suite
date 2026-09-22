export type ScheduledTaskStatusKind = 'normal' | 'attention' | 'disabled';

export type ScheduledTaskStatusInput = {
  enabled: boolean;
  running: boolean;
  lastRunStatus?: string;
  lastDeliveryStatus?: string;
};

export type ScheduledTaskCapabilityName = 'runNow' | 'cancelRun' | 'retryDelivery';

export type ScheduledTaskCapabilities = {
  list?: boolean;
  pause?: boolean;
  resume?: boolean;
  delete?: boolean;
  history?: boolean;
  runNow?: boolean;
  cancelRun?: boolean;
  retryDelivery?: boolean;
};

export type ScheduledTaskCounts = {
  total: number;
  enabled: number;
  paused: number;
  running: number;
  failed: number;
  quarantined: number;
};

export type ScheduledTaskPanelTask = {
  id: string;
  version: number;
  name: string;
  enabled: boolean;
  schedule: Record<string, unknown>;
  action: Record<string, unknown>;
  delivery?: { channelType?: string; mode?: string };
  updatedAt?: string;
};

export type ScheduledTaskPanelItem = {
  task: ScheduledTaskPanelTask;
  state: null | {
    nextRunAt?: string;
    runningRunId?: string;
    lastRunAt?: string;
    lastRunStatus?: string;
    lastExecutionStatus?: string;
    lastDeliveryStatus?: string;
    lastError?: string;
  };
};

export type ScheduledTaskRun = {
  runId: string;
  scheduledFor: string;
  trigger: string;
  executionStatus: string;
  deliveryStatus: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  summary?: string;
};

export type ScheduledTaskPanelState = {
  available: boolean;
  error: string;
  status: {
    root?: string;
    capabilities?: ScheduledTaskCapabilities;
    counts?: ScheduledTaskCounts;
  };
  items: ScheduledTaskPanelItem[];
};

const unavailableCapabilityReasons: Record<ScheduledTaskCapabilityName, string> = {
  runNow: '当前计划任务 CLI 尚未连接运行中的 Bridge，暂不支持立即运行。',
  cancelRun: '当前计划任务 CLI 尚未连接运行中的 Bridge，暂不支持取消运行。',
  retryDelivery: '当前计划任务 CLI 尚未连接运行中的 Bridge，暂不支持仅重试投递。',
};

export function buildScheduledTaskStatus(input: ScheduledTaskStatusInput): { kind: ScheduledTaskStatusKind; label: string } {
  if (input.lastRunStatus === 'error') return { kind: 'attention', label: '失败' };
  if (input.lastDeliveryStatus === 'failed') return { kind: 'attention', label: '投递失败' };
  if (input.running) return { kind: 'normal', label: '运行中' };
  if (!input.enabled) return { kind: 'disabled', label: '已暂停' };
  if (input.lastRunStatus === 'ok') return { kind: 'normal', label: '正常' };
  return { kind: 'disabled', label: '等待首次运行' };
}

export function describeScheduledTaskSchedule(schedule: Record<string, unknown>): string {
  if (schedule.kind === 'cron') return `Cron ${String(schedule.expression ?? '')} · ${String(schedule.timezone ?? 'UTC')}`;
  if (schedule.kind === 'every') return `每 ${formatInterval(Number(schedule.everyMs ?? 0))}`;
  if (schedule.kind === 'at') return `单次 · ${formatDateTime(String(schedule.at ?? ''))} · ${String(schedule.timezone ?? 'UTC')}`;
  return '未知计划';
}

export function describeScheduledTaskAction(action: Record<string, unknown>): string {
  if (action.kind === 'notify') return '固定通知';
  if (action.kind === 'agent_turn') return '动态 Agent 任务';
  if (action.kind === 'controlled_tool') return `受控工具 · ${String(action.toolName ?? '未命名')}`;
  return '未知动作';
}

export function getScheduledTaskCapability(
  capabilities: Partial<Record<ScheduledTaskCapabilityName, boolean>>,
  name: ScheduledTaskCapabilityName,
): { enabled: boolean; reason: string } {
  return capabilities[name]
    ? { enabled: true, reason: '' }
    : { enabled: false, reason: unavailableCapabilityReasons[name] };
}

export function formatDateTime(value: string): string {
  if (!value) return '未安排';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

function formatInterval(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '未知间隔';
  if (milliseconds % 86_400_000 === 0) return `${milliseconds / 86_400_000} 天`;
  if (milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000} 小时`;
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000} 分钟`;
  return `${Math.round(milliseconds / 1000)} 秒`;
}
