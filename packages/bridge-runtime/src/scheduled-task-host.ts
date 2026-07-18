import type { TurnWorkspacePlan } from 'claude-to-im/src/lib/bridge/workspace-plan.js';

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
  sleep?: (ms: number) => Promise<void>;
};

async function runWithTimeout(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<ScheduledActionResult>,
): Promise<ScheduledActionResult> {
  const controller = new AbortController();
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

export type ScheduledTaskCreateRequest = {
  task: ScheduledTaskCreate;
  actor: ScheduledTaskActor;
};

export function createScheduledTaskHost(options: ScheduledTaskHostOptions) {
  return {
    async create(request: ScheduledTaskCreateRequest) {
      if (request.task.action.kind === 'controlled_tool' && request.actor.role !== 'owner') {
        throw new Error('创建受控工具计划任务需要 Owner 权限');
      }
      if (request.actor.role === 'viewer') throw new Error('创建计划任务至少需要 Operator 权限');
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
      if (
        actor.role === 'viewer'
        && (task.owner.channelType !== actor.channelType || task.owner.userId !== actor.userId)
      ) {
        throw new Error('无权查看其他用户的计划任务');
      }
      return {
        task,
        state: await options.store.getState(taskId),
      };
    },
  };
}
