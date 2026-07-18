#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CTI_HOME } from './config.js';
import { createFileScheduledTaskStore } from './scheduled-tasks/store.js';

export type ScheduledTaskCliDependencies = { ctiHome?: string };
export type ScheduledTaskCliResult = { exitCode: number; stdout: string; stderr: string };

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function jsonResult(value: unknown): ScheduledTaskCliResult {
  return { exitCode: 0, stdout: `${JSON.stringify(value, null, 2)}\n`, stderr: '' };
}

function errorResult(error: unknown): ScheduledTaskCliResult {
  return { exitCode: 1, stdout: '', stderr: `${error instanceof Error ? error.message : String(error)}\n` };
}

function requireTaskId(argv: string[]): string {
  const id = argv[1]?.trim();
  if (!id || id.startsWith('--')) throw new Error('计划任务命令缺少 taskId。');
  return id;
}

function requireExpectedVersion(argv: string[]): number {
  const raw = option(argv, '--expected-version');
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) throw new Error('计划任务命令需要有效 --expected-version。');
  return version;
}

export async function executeScheduledTaskCli(
  argv: string[],
  dependencies: ScheduledTaskCliDependencies = {},
): Promise<ScheduledTaskCliResult> {
  const root = path.join(dependencies.ctiHome || CTI_HOME, 'data', 'scheduled-tasks');
  const store = createFileScheduledTaskStore(root);
  const command = (argv[0] || 'status').trim().toLowerCase();
  try {
    if (command === 'list') {
      const tasks = await store.listTasks();
      const items = await Promise.all(tasks.map(async (task) => ({ task, state: await store.getState(task.id) })));
      return jsonResult({ tasks, items });
    }
    if (command === 'get') {
      const taskId = requireTaskId(argv);
      const task = await store.getTask(taskId);
      if (!task) throw new Error(`计划任务不存在：${taskId}`);
      return jsonResult({ task, state: await store.getState(taskId) });
    }
    if (command === 'pause' || command === 'resume') {
      const taskId = requireTaskId(argv);
      const task = await store.updateTask(taskId, requireExpectedVersion(argv), { enabled: command === 'resume' });
      return jsonResult(task);
    }
    if (command === 'delete') {
      const taskId = requireTaskId(argv);
      await store.deleteTask(taskId, requireExpectedVersion(argv));
      return jsonResult({ ok: true, taskId, deleted: true });
    }
    if (command === 'history') {
      const taskId = requireTaskId(argv);
      const limit = Math.max(1, Math.min(200, Number(option(argv, '--limit')) || 50));
      return jsonResult({ taskId, runs: await store.listRuns(taskId, limit) });
    }
    if (command === 'status') {
      const tasks = await store.listTasks();
      const states = await Promise.all(tasks.map((task) => store.getState(task.id)));
      const quarantined = fs.existsSync(path.join(root, 'quarantine'))
        ? fs.readdirSync(path.join(root, 'quarantine')).filter((name) => name.endsWith('.json')).length
        : 0;
      return jsonResult({
        root,
        capabilities: {
          list: true,
          pause: true,
          resume: true,
          delete: true,
          history: true,
          runNow: false,
          cancelRun: false,
          retryDelivery: false,
        },
        counts: {
          total: tasks.length,
          enabled: tasks.filter((task) => task.enabled).length,
          paused: tasks.filter((task) => !task.enabled).length,
          running: states.filter((state) => Boolean(state?.runningRunId)).length,
          failed: states.filter((state) => state?.lastRunStatus === 'error' || state?.lastDeliveryStatus === 'failed').length,
          quarantined,
        },
      });
    }
    if (['run-now', 'cancel-run', 'retry-delivery'].includes(command)) {
      throw new Error(`计划任务命令 ${command} 需要连接正在运行的 Bridge，当前 CLI 尚未开放该能力。`);
    }
    throw new Error(`未知计划任务命令：${command}`);
  } catch (error) {
    return errorResult(error);
  }
}

async function main(): Promise<void> {
  const result = await executeScheduledTaskCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath && path.resolve(fileURLToPath(import.meta.url)) === entryPath) {
  void main();
}
