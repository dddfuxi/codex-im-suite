import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  DeniedWorkspaceRoot,
  TurnWorkspacePlan,
} from 'claude-to-im/workspace';
import type {
  ScheduledTaskActionHost,
  ScheduledTaskActorInput,
  ScheduledTaskCreateInput,
  ScheduledTaskMutationResult,
} from 'claude-to-im/host';

import {
  executeScheduledTaskRun,
  retryScheduledTaskDelivery,
  type ScheduledActionResult,
  type ScheduledDeliveryResult,
} from './scheduled-tasks/executors.js';
import type {
  ScheduledTaskExecuteInput,
  ScheduledTaskExecutionResult,
  ScheduledTaskService,
} from './scheduled-tasks/service.js';
import type { ScheduledTaskStore } from './scheduled-tasks/store.js';
import type {
  ScheduledTaskCreate,
  ScheduledTaskDeliveryPayload,
  ScheduledTaskRun,
  VersionedScheduledTask,
} from './scheduled-tasks/types.js';
import { buildScheduledTaskCard } from './scheduled-tasks/presentation.js';

export type ScheduledTaskActorRole = 'viewer' | 'operator' | 'owner';

export type ScheduledTaskActor = {
  role: ScheduledTaskActorRole;
  channelType: string;
  userId: string;
  messageId?: string;
};

export type ScheduledTaskWorkspaceResolution =
  | { ok: true; workspacePlan: TurnWorkspacePlan }
  | { ok: false; error: string };

export type ScheduledTaskIsolatedWorkspaceOptions = {
  deniedRoots: readonly DeniedWorkspaceRoot[];
  tempRoot?: string;
  now?: () => string;
};

/**
 * 无绑定工作区的计划任务仍必须携带真实工作区计划，避免 Provider 回退到
 * 默认项目目录。该沙箱只在当前回合存在，也不会自动挂载任何注册项目根。
 */
export function createScheduledTaskIsolatedWorkspacePlan(
  sandboxPath: string,
  deniedRoots: readonly DeniedWorkspaceRoot[],
  createdAt = new Date().toISOString(),
): TurnWorkspacePlan {
  const resolvedSandbox = path.resolve(sandboxPath);
  return {
    version: 'cti-turn-workspace/v1',
    primaryWorkspace: {
      path: resolvedSandbox,
      accessMode: 'read_only',
      evidenceIds: ['scheduled_task_runtime'],
      reason: 'ephemeral isolated workspace for a scheduled agent turn',
      expiresAfterTurn: true,
    },
    temporaryMounts: [],
    deniedRoots: deniedRoots
      .filter((item) => item.path?.trim())
      .map((item) => ({ path: path.resolve(item.path.trim()), reason: item.reason })),
    resolvedFrom: 'default',
    createdAt,
    expiresAfterTurn: true,
  };
}

export async function withScheduledTaskIsolatedWorkspace<T>(
  options: ScheduledTaskIsolatedWorkspaceOptions,
  operation: (workspacePlan: TurnWorkspacePlan) => Promise<T>,
): Promise<T> {
  const tempRoot = path.resolve(options.tempRoot ?? os.tmpdir());
  const sandboxPath = await fs.promises.mkdtemp(path.join(tempRoot, 'cti-scheduled-task-'));
  try {
    return await operation(createScheduledTaskIsolatedWorkspacePlan(
      sandboxPath,
      options.deniedRoots,
      options.now?.() ?? new Date().toISOString(),
    ));
  } finally {
    await fs.promises.rm(sandboxPath, { recursive: true, force: true });
  }
}

export type ScheduledTaskAgentTurnInput = {
  task: VersionedScheduledTask;
  run: ScheduledTaskRun;
  workspacePlan?: TurnWorkspacePlan;
  signal: AbortSignal;
};

export type ScheduledTaskToolContext = {
  task: VersionedScheduledTask;
  run: ScheduledTaskRun;
  signal: AbortSignal;
};

export type ScheduledToolDefinition = {
  name: string;
  idempotent: boolean;
  requiredRole: 'owner';
  execute(input: unknown, context: ScheduledTaskToolContext): Promise<ScheduledActionResult>;
};

export type ScheduledTaskDeliveryInput = {
  task: VersionedScheduledTask;
  run: ScheduledTaskRun;
  payload: ScheduledTaskDeliveryPayload;
};

export type ScheduledTaskRunExecutorDependencies = {
  resolveWorkspacePlan(input: {
    sourceSessionId: string;
    workspaceId?: string;
  }): Promise<ScheduledTaskWorkspaceResolution>;
  runAgentTurn(input: ScheduledTaskAgentTurnInput): Promise<ScheduledActionResult>;
  deliver(input: ScheduledTaskDeliveryInput): Promise<ScheduledDeliveryResult>;
  tools: ReadonlyMap<string, ScheduledToolDefinition>;
  runtimeSignal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
};

async function runWithTimeout(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<ScheduledActionResult>,
  runtimeSignal?: AbortSignal,
): Promise<ScheduledActionResult> {
  const controller = new AbortController();
  const relayRuntimeAbort = () => controller.abort(runtimeSignal?.reason || 'scheduled task runtime stopping');
  if (runtimeSignal?.aborted) relayRuntimeAbort();
  else runtimeSignal?.addEventListener('abort', relayRuntimeAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<ScheduledActionResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort('scheduled task timeout');
          resolve({
            ok: false,
            error: `计划任务执行超时：${timeoutMs}ms`,
            errorKind: 'timeout',
            executionStarted: true,
          });
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    runtimeSignal?.removeEventListener('abort', relayRuntimeAbort);
  }
}

export function createScheduledTaskRunExecutor(
  dependencies: ScheduledTaskRunExecutorDependencies,
): (input: ScheduledTaskExecuteInput) => Promise<ScheduledTaskExecutionResult> {
  return async (input) => {
    const deliver = (payload: ScheduledTaskDeliveryPayload) => dependencies.deliver({
      task: input.task,
      run: input.run,
      payload,
    });

    if (input.mode === 'delivery_only') {
      const payload = input.previousRun?.deliveryPayload;
      if (!payload) {
        return {
          executionStatus: 'ok',
          deliveryStatus: 'failed',
          errorKind: 'invalid_input',
          error: '计划任务运行记录缺少可重试的投递内容',
        };
      }
      return retryScheduledTaskDelivery({
        task: input.task,
        run: input.previousRun!,
        payload,
        deliver,
        sleep: dependencies.sleep,
      });
    }

    const requestedTool = input.task.action.kind === 'controlled_tool'
      ? dependencies.tools.get(input.task.action.toolName)
      : undefined;
    const executionTask: VersionedScheduledTask = input.task.action.kind === 'controlled_tool' && requestedTool
      ? {
          ...input.task,
          action: {
            ...input.task.action,
            idempotent: requestedTool.idempotent,
          },
        }
      : input.task;
    const executeAction = async (): Promise<ScheduledActionResult> => {
      const action = executionTask.action;
      if (action.kind === 'notify') {
        return {
          ok: true,
          deliveryPayload: { text: action.text, parseMode: 'plain' },
          summary: action.text,
        };
      }

      if (action.kind === 'agent_turn') {
        let workspacePlan: TurnWorkspacePlan | undefined;
        if (input.task.executionContext.workspaceMode === 'bound') {
          const resolved = await dependencies.resolveWorkspacePlan({
            sourceSessionId: input.task.executionContext.sourceSessionId,
            workspaceId: input.task.executionContext.workspaceId,
          });
          if (!resolved.ok) {
            return {
              ok: false,
              error: `计划任务工作区不可用：${resolved.error}`,
              errorKind: 'workspace_unavailable',
              executionStarted: false,
            };
          }
          workspacePlan = resolved.workspacePlan;
        }
        return runWithTimeout(
          Math.max(1_000, Math.floor(action.timeoutMs ?? 60 * 60_000)),
          (signal) => dependencies.runAgentTurn({
            task: input.task,
            run: input.run,
            workspacePlan,
            signal,
          }),
          dependencies.runtimeSignal,
        );
      }

      const tool = requestedTool;
      if (!tool) {
        return {
          ok: false,
          error: `计划任务工具未注册：${action.toolName}`,
          errorKind: 'tool_not_allowed',
          executionStarted: false,
        };
      }
      return runWithTimeout(
        Math.max(1_000, Math.floor(action.timeoutMs ?? 10 * 60_000)),
        (signal) => tool.execute(action.input, {
          task: executionTask,
          run: input.run,
          signal,
        }),
        dependencies.runtimeSignal,
      );
    };

    return executeScheduledTaskRun({
      task: executionTask,
      run: input.run,
      executeAction,
      deliver,
      sleep: dependencies.sleep,
    });
  };
}

export type ScheduledTaskHostOptions = {
  store: ScheduledTaskStore;
  service: ScheduledTaskService;
};

export type ScheduledTaskSchedulerOptions = {
  service: ScheduledTaskService;
  pollMs: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  onError?: (error: unknown) => void;
};

export function createScheduledTaskScheduler(options: ScheduledTaskSchedulerOptions) {
  const setIntervalFn = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;
  const pollMs = Math.max(5_000, Math.floor(options.pollMs));
  let timer: NodeJS.Timeout | undefined;
  let accepting = false;
  let activeTick: Promise<void> | null = null;

  const tick = () => {
    if (!accepting || activeTick) return;
    activeTick = options.service.tick()
      .then(() => undefined)
      .catch((error) => options.onError?.(error))
      .finally(() => { activeTick = null; });
  };

  return {
    async start() {
      if (accepting) return;
      accepting = true;
      await options.service.recover();
      await options.service.tick();
      if (!accepting) return;
      timer = setIntervalFn(tick, pollMs);
      timer.unref?.();
    },
    stop() {
      accepting = false;
      if (timer) clearIntervalFn(timer);
      timer = undefined;
    },
  };
}

export type ScheduledTaskCreateRequest = {
  task: ScheduledTaskCreate;
  actor: ScheduledTaskActor;
};

export function createScheduledTaskHost(options: ScheduledTaskHostOptions) {
  const canAccess = (task: VersionedScheduledTask, actor: ScheduledTaskActor): boolean => (
    actor.role === 'owner'
    || actor.role === 'operator'
    || (task.owner.channelType === actor.channelType && task.owner.userId === actor.userId)
  );
  const requireTask = async (taskId: string, actor: ScheduledTaskActor): Promise<VersionedScheduledTask> => {
    const task = await options.store.getTask(taskId);
    if (!task) throw new Error(`计划任务不存在：${taskId}`);
    if (!canAccess(task, actor)) throw new Error('无权管理其他用户的计划任务');
    return task;
  };

  return {
    async create(request: ScheduledTaskCreateRequest) {
      if (request.task.action.kind === 'controlled_tool' && request.actor.role !== 'owner') {
        throw new Error('创建受控工具计划任务需要 Owner 权限');
      }
      if (!request.actor.userId.trim()) throw new Error('创建计划任务缺少真实用户身份');
      const task = await options.store.createTask({
        ...request.task,
        owner: {
          channelType: request.actor.channelType,
          userId: request.actor.userId,
          sourceMessageId: request.actor.messageId ?? request.task.owner.sourceMessageId,
        },
      });
      const state = await options.service.ensureTaskState(task.id);
      return { task, state };
    },

    async list(actor: ScheduledTaskActor) {
      const tasks = await options.store.listTasks();
      if (actor.role === 'owner' || actor.role === 'operator') return tasks;
      return tasks.filter((task) => task.owner.channelType === actor.channelType && task.owner.userId === actor.userId);
    },

    async get(taskId: string, actor: ScheduledTaskActor) {
      const task = await options.store.getTask(taskId);
      if (!task) return null;
      if (!canAccess(task, actor)) throw new Error('无权查看其他用户的计划任务');
      return {
        task,
        state: await options.store.getState(taskId),
      };
    },

    async pause(taskId: string, actor: ScheduledTaskActor) {
      const task = await requireTask(taskId, actor);
      return options.store.updateTask(task.id, task.version, { enabled: false });
    },

    async resume(taskId: string, actor: ScheduledTaskActor) {
      const task = await requireTask(taskId, actor);
      const updated = await options.store.updateTask(task.id, task.version, { enabled: true });
      await options.service.ensureTaskState(task.id);
      return updated;
    },

    async runNow(taskId: string, actor: ScheduledTaskActor) {
      await requireTask(taskId, actor);
      return options.service.runNow(taskId);
    },

    async delete(taskId: string, actor: ScheduledTaskActor) {
      const task = await requireTask(taskId, actor);
      await options.store.deleteTask(task.id, task.version);
    },

    async history(taskId: string, actor: ScheduledTaskActor, limit?: number) {
      await requireTask(taskId, actor);
      return options.store.listRuns(taskId, limit);
    },
  };
}

function toRuntimeActor(actor: ScheduledTaskActorInput): ScheduledTaskActor {
  return {
    role: actor.role,
    channelType: actor.channelType,
    userId: actor.userId,
    messageId: actor.messageId,
  };
}

function mutationFailure(error: unknown): ScheduledTaskMutationResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function buildTaskCard(task: VersionedScheduledTask, nextRunAt?: string): string {
  return buildScheduledTaskCard({
    taskId: task.id,
    name: task.name,
    actionKind: task.action.kind,
    scheduleKind: task.schedule.kind,
    timezone: task.schedule.kind === 'every' ? undefined : task.schedule.timezone,
    nextRunAt,
    enabled: task.enabled,
  });
}

/**
 * 将 bridge-core 的可信动作协议适配为 runtime 持久化协议。
 * 漏跑和重试策略由 runtime 统一给默认值，模型与渠道都不能覆盖。
 */
export function createBridgeScheduledTaskActionHost(
  options: ScheduledTaskHostOptions,
): ScheduledTaskActionHost {
  const host = createScheduledTaskHost(options);
  const create = async (input: ScheduledTaskCreateInput): Promise<ScheduledTaskMutationResult> => {
    try {
      const created = await host.create({
        actor: toRuntimeActor(input.actor),
        task: {
          name: input.name,
          schedule: input.schedule,
          action: input.taskAction,
          executionContext: input.executionContext,
          delivery: {
            channelType: input.delivery.target.channelType,
            chatId: input.delivery.target.chatId,
            chatType: input.delivery.target.chatType,
            notifyTargets: input.delivery.notifyTargets,
            mode: input.delivery.mode,
          },
          misfirePolicy: { mode: 'run_latest', maxLatenessMs: 15 * 60_000 },
          retryPolicy: {
            maxAttempts: 3,
            backoffMs: [5_000, 30_000, 120_000],
            retryOn: ['rate_limit', 'overloaded', 'network', 'timeout', 'server_error'],
          },
          owner: {
            channelType: input.actor.channelType,
            userId: input.actor.userId,
            sourceMessageId: input.actor.messageId,
          },
        },
      });
      return {
        ok: true,
        taskId: created.task.id,
        name: created.task.name,
        nextRunAt: created.state.nextRunAt,
        feishuCardJson: buildTaskCard(created.task, created.state.nextRunAt),
      };
    } catch (error) {
      return mutationFailure(error);
    }
  };

  const mutateTask = async (
    input: { taskId: string; actor: ScheduledTaskActorInput },
    operation: (taskId: string, actor: ScheduledTaskActor) => Promise<unknown>,
  ): Promise<ScheduledTaskMutationResult> => {
    try {
      const result = await operation(input.taskId, toRuntimeActor(input.actor));
      const task = result && typeof result === 'object' && 'name' in result
        ? result as { name?: string }
        : await options.store.getTask(input.taskId);
      const state = await options.store.getState(input.taskId);
      return {
        ok: true,
        taskId: input.taskId,
        name: task?.name,
        nextRunAt: state?.nextRunAt,
        feishuCardJson: task ? buildTaskCard(task as VersionedScheduledTask, state?.nextRunAt) : undefined,
      };
    } catch (error) {
      return mutationFailure(error);
    }
  };

  return {
    create,
    async list(input) {
      try {
        return { ok: true, tasks: await host.list(toRuntimeActor(input.actor)) };
      } catch (error) {
        return { ok: false, tasks: [], error: error instanceof Error ? error.message : String(error) };
      }
    },
    async get(input) {
      try {
        const result = await host.get(input.taskId, toRuntimeActor(input.actor));
        return result
          ? { ok: true, task: result.task, state: result.state }
          : { ok: false, error: `计划任务不存在：${input.taskId}` };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    pause: (input) => mutateTask(input, host.pause),
    resume: (input) => mutateTask(input, host.resume),
    runNow: (input) => mutateTask(input, host.runNow),
    async cancelRun(input) {
      return { ok: false, taskId: input.taskId, error: '当前运行取消接口尚未接入 active-run controller' };
    },
    async delete(input) {
      try {
        await host.delete(input.taskId, toRuntimeActor(input.actor));
        return { ok: true, taskId: input.taskId };
      } catch (error) {
        return mutationFailure(error);
      }
    },
    async history(input) {
      try {
        return { ok: true, runs: await host.history(input.taskId, toRuntimeActor(input.actor), input.limit) };
      } catch (error) {
        return { ok: false, runs: [], error: error instanceof Error ? error.message : String(error) };
      }
    },
    async retryDelivery(input) {
      return { ok: false, taskId: input.taskId, error: '当前投递重试接口尚未开放为手动操作' };
    },
  };
}
