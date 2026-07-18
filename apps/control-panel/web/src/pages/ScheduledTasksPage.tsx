import { useState } from 'react';
import { AlertTriangle, CalendarClock, History, Pause, Play, RefreshCw, RotateCw, Trash2 } from 'lucide-react';

import {
  buildScheduledTaskStatus,
  describeScheduledTaskAction,
  describeScheduledTaskSchedule,
  formatDateTime,
  getScheduledTaskCapability,
  type ScheduledTaskPanelItem,
  type ScheduledTaskPanelState,
  type ScheduledTaskRun,
} from '../scheduled-task-view-model.js';

type ScheduledTasksPageProps = {
  state: ScheduledTaskPanelState;
  run: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  refresh: () => Promise<void>;
  pending: Record<string, boolean>;
};

const emptyCounts = { total: 0, enabled: 0, paused: 0, running: 0, failed: 0, quarantined: 0 };

function statusClass(kind: 'normal' | 'attention' | 'disabled'): string {
  return kind === 'normal' ? 'ok' : kind === 'attention' ? 'error' : 'idle';
}

function deliveryLabel(value?: string): string {
  if (value === 'delivered') return '已投递';
  if (value === 'failed') return '投递失败';
  if (value === 'pending') return '等待投递';
  if (value === 'not_requested') return '无需投递';
  return value || '尚无记录';
}

export function ScheduledTasksPage({ state, run, refresh, pending }: ScheduledTasksPageProps) {
  const [history, setHistory] = useState<{ taskId: string; taskName: string; runs: ScheduledTaskRun[] } | null>(null);
  const [localError, setLocalError] = useState('');
  const counts = state.status?.counts ?? emptyCounts;
  const capabilities = state.status?.capabilities ?? {};
  const runNow = getScheduledTaskCapability(capabilities, 'runNow');
  const cancelRun = getScheduledTaskCapability(capabilities, 'cancelRun');
  const retryDelivery = getScheduledTaskCapability(capabilities, 'retryDelivery');

  const mutate = async (command: string, payload: Record<string, unknown>) => {
    setLocalError('');
    try {
      await run(command, payload);
      await refresh();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  };

  const loadHistory = async (item: ScheduledTaskPanelItem) => {
    setLocalError('');
    try {
      const result = await run('scheduledTasks.history', { taskId: item.task.id, limit: 50 }) as { runs?: ScheduledTaskRun[] };
      setHistory({ taskId: item.task.id, taskName: item.task.name, runs: result.runs ?? [] });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  };

  if (!state.available) {
    return (
      <section className="panel scheduled-task-unavailable">
        <AlertTriangle size={24} />
        <div>
          <h2>计划任务运行态不可用</h2>
          <p>{state.error || '未能读取计划任务 CLI。面板不会展示或启用未经验证的入口。'}</p>
        </div>
        <button className="command-button" onClick={() => void refresh()}><RefreshCw size={15} />重试</button>
      </section>
    );
  }

  return (
    <section className="content-stack scheduled-tasks-page">
      <div className="summary-grid scheduled-task-summary">
        {Object.entries({ 总数: counts.total, 启用: counts.enabled, 暂停: counts.paused, 运行中: counts.running, 失败: counts.failed, 隔离: counts.quarantined }).map(([label, value]) => (
          <article className="metric compact" key={label}><span>{label}</span><strong>{value}</strong></article>
        ))}
      </div>

      {(localError || counts.quarantined > 0) && (
        <div className="scheduled-task-warning">
          <AlertTriangle size={16} />
          <span>{localError || `隔离区中有 ${counts.quarantined} 个损坏记录，请先查看 runtime 日志后再处理。`}</span>
        </div>
      )}

      {(!runNow.enabled || !cancelRun.enabled || !retryDelivery.enabled) && (
        <div className="scheduled-task-capability-note">
          当前面板已开放查看、暂停、恢复、历史和删除；立即运行、取消运行、仅重试投递会在 runtime daemon 控制接口接通后启用。
        </div>
      )}

      <section className="panel">
        <div className="section-header">
          <div>
            <h2>统一计划任务</h2>
            <p className="panel-intro">任务定义、运行账本和投递状态分开保存；执行成功但飞书投递失败时不会重新运行 Agent。</p>
          </div>
          <button className="command-button" onClick={() => void refresh()} disabled={pending['state.refresh']}>
            <RefreshCw size={15} className={pending['state.refresh'] ? 'spin' : ''} />刷新
          </button>
        </div>

        {state.items.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><CalendarClock size={26} /></div>
            <strong>还没有计划任务</strong>
            <span>可在飞书中用自然语言创建，例如“工作日 10:30 给我发送动态日报”。</span>
          </div>
        ) : (
          <div className="scheduled-task-list">
            {state.items.map((item) => {
              const current = buildScheduledTaskStatus({
                enabled: item.task.enabled,
                running: Boolean(item.state?.runningRunId),
                lastRunStatus: item.state?.lastRunStatus,
                lastDeliveryStatus: item.state?.lastDeliveryStatus,
              });
              return (
                <article className="scheduled-task-card" key={item.task.id}>
                  <div className="scheduled-task-card-head">
                    <div>
                      <div className="scheduled-task-title-row">
                        <h3>{item.task.name}</h3>
                        <span className={`status-pill ${statusClass(current.kind)}`}>{current.label}</span>
                      </div>
                      <div className="scheduled-task-meta">{describeScheduledTaskSchedule(item.task.schedule)} · {describeScheduledTaskAction(item.task.action)}</div>
                    </div>
                    <code>{item.task.id}</code>
                  </div>

                  <div className="scheduled-task-facts">
                    <div><span>下次运行</span><strong>{formatDateTime(item.state?.nextRunAt ?? '')}</strong></div>
                    <div><span>执行状态</span><strong>{item.state?.lastExecutionStatus || item.state?.lastRunStatus || '尚无记录'}</strong></div>
                    <div><span>投递状态</span><strong>{deliveryLabel(item.state?.lastDeliveryStatus)}</strong></div>
                    <div><span>最近运行</span><strong>{formatDateTime(item.state?.lastRunAt ?? '')}</strong></div>
                  </div>
                  {item.state?.lastError && <p className="scheduled-task-error">{item.state.lastError}</p>}

                  <div className="scheduled-task-actions">
                    <button className="mini-button" onClick={() => void mutate(item.task.enabled ? 'scheduledTasks.pause' : 'scheduledTasks.resume', { taskId: item.task.id, expectedVersion: item.task.version })}>
                      {item.task.enabled ? <Pause size={14} /> : <Play size={14} />}{item.task.enabled ? '暂停' : '恢复'}
                    </button>
                    <button className="mini-button" disabled={!runNow.enabled} title={runNow.reason} onClick={() => void mutate('scheduledTasks.runNow', { taskId: item.task.id })}>
                      <Play size={14} />立即运行
                    </button>
                    <button className="mini-button" disabled={!item.state?.runningRunId || !cancelRun.enabled} title={!item.state?.runningRunId ? '当前任务没有运行中的实例。' : cancelRun.reason} onClick={() => void mutate('scheduledTasks.cancelRun', { taskId: item.task.id, runId: item.state?.runningRunId })}>
                      <Pause size={14} />取消运行
                    </button>
                    <button className="mini-button" onClick={() => void loadHistory(item)}><History size={14} />历史</button>
                    <button className="mini-button danger" onClick={() => {
                      if (window.confirm(`永久删除计划任务“${item.task.name}”？`)) void mutate('scheduledTasks.delete', { taskId: item.task.id, expectedVersion: item.task.version });
                    }}><Trash2 size={14} />删除</button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {history && (
        <section className="panel scheduled-task-history">
          <div className="section-header">
            <div><h2>{history.taskName} · 运行历史</h2><p className="panel-intro">执行状态与投递状态独立记录。</p></div>
            <button className="mini-button" onClick={() => setHistory(null)}>关闭</button>
          </div>
          {history.runs.length === 0 ? <div className="empty-inline">暂无运行记录。</div> : history.runs.map((runItem) => (
            <article className="scheduled-task-run" key={runItem.runId}>
              <div><strong>{formatDateTime(runItem.scheduledFor)}</strong><span>{runItem.trigger}</span></div>
              <div><span>执行</span><strong>{runItem.executionStatus}</strong></div>
              <div><span>投递</span><strong>{deliveryLabel(runItem.deliveryStatus)}</strong></div>
              {runItem.deliveryStatus === 'failed' && (
                <button className="mini-button" disabled={!retryDelivery.enabled} title={retryDelivery.reason} onClick={() => void mutate('scheduledTasks.retryDelivery', { taskId: history.taskId, runId: runItem.runId })}>
                  <RotateCw size={14} />仅重试投递
                </button>
              )}
              {(runItem.error || runItem.summary) && <p>{runItem.error || runItem.summary}</p>}
            </article>
          ))}
        </section>
      )}
    </section>
  );
}
