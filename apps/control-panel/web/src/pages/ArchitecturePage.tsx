import { useEffect, useMemo, useState } from 'react';
import { AGENT_ARCHITECTURE_LAYERS } from 'claude-to-im/architecture';
import type {
  AgentCollaborationPanelState,
  AgentCollaborationRun,
  AgentCollaborationWorkflowNode,
  AgentResponsibilityView,
  AgentWorkerView,
} from '@codex-im-suite/contracts/agent-collaboration';
import { AgentWorkflowGraph } from '../components/AgentWorkflowGraph.js';
import {
  agentModeDescription,
  agentModeLabel,
  agentSuccessRate,
  formatAgentDuration,
  formatRate,
  listAgentCollaborationRuns,
  normalizeAgentCollaborationState,
  orderAgentResponsibilities,
  redactAgentDisplayText,
  selectAgentCollaborationRun,
  summarizeEvidenceRefs,
  workflowNodeStatusLabel,
} from '../agent-collaboration-view-model.js';

export type ArchitectureBlueprintItem = {
  id: string;
  title: string;
  detail: string;
  status: 'normal' | 'attention' | 'disabled';
  children?: Array<{
    id: string;
    title: string;
    detail: string;
    status: 'normal' | 'attention' | 'disabled';
  }>;
};

type ArchitecturePageProps = {
  blueprint: ArchitectureBlueprintItem[];
  collaboration?: AgentCollaborationPanelState;
  selectedRunId?: string;
  selectedWorkflowRunId?: string;
  onSelectRun?: (runId: string, workflowRunId?: string) => void;
};

function joinFacts(items: string[]): string {
  return items.length > 0 ? items.join(' · ') : 'Registry 未声明';
}

function formatTimestamp(value?: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function poolHealthLabel(value: AgentCollaborationPanelState['poolHealth']): string {
  const labels: Record<AgentCollaborationPanelState['poolHealth'], string> = {
    disabled: '未启动',
    healthy: '健康',
    degraded: '降级',
    unavailable: '不可用',
  };
  return labels[value];
}

function responsibilityHealthLabel(value: AgentResponsibilityView['health']): string {
  const labels: Record<AgentResponsibilityView['health'], string> = {
    disabled: '未启用',
    idle: '空闲',
    running: '运行中',
    degraded: '降级',
    unavailable: '不可用',
  };
  return labels[value];
}

function workerHealthLabel(value: AgentWorkerView['health']): string {
  const labels: Record<AgentWorkerView['health'], string> = {
    starting: '启动中',
    online: '在线',
    busy: '忙碌',
    unresponsive: '失联',
    restarting: '重启中',
    circuit_open: '熔断',
    stopped: '已停止',
  };
  return labels[value];
}

function runStatusLabel(value: AgentCollaborationRun['status']): string {
  const labels: Record<AgentCollaborationRun['status'], string> = {
    running: '运行中',
    succeeded: '成功',
    failed: '失败',
    cancelled: '已取消',
    skipped: '已跳过',
    fallback: '已回退',
  };
  return labels[value];
}

function totalTokenLabel(node?: AgentCollaborationWorkflowNode): string {
  if (!node?.tokenUsage) return '-';
  const input = node.tokenUsage.inputTokens ?? 0;
  const output = node.tokenUsage.outputTokens ?? 0;
  const total = node.tokenUsage.totalTokens ?? input + output;
  return `${total}（输入 ${input} / 输出 ${output}）`;
}

function TopologyAgentNode({
  agent,
  selected,
  onSelect,
}: {
  agent?: AgentResponsibilityView;
  selected: boolean;
  onSelect: (agentId: string) => void;
}) {
  if (!agent) {
    return (
      <div className="agent-topology-node unavailable" aria-label="Agent Registry 未返回该职责">
        <strong>Registry 未返回</strong>
        <span>不推断职责</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`agent-topology-node agent ${agent.health}${selected ? ' selected' : ''}`}
      onClick={() => onSelect(agent.manifest.id)}
      aria-pressed={selected}
    >
      <strong>{agent.manifest.displayName}</strong>
      <span>{agent.manifest.responsibilities[0] || 'Registry 未声明职责'}</span>
      <small>{responsibilityHealthLabel(agent.health)} · 副作用 {agent.manifest.sideEffectLevel}</small>
    </button>
  );
}

export function ArchitecturePage({
  blueprint,
  collaboration,
  selectedRunId,
  selectedWorkflowRunId,
  onSelectRun,
}: ArchitecturePageProps) {
  const state = normalizeAgentCollaborationState(collaboration);
  const agents = useMemo(() => orderAgentResponsibilities(state.agents), [state.agents]);
  const runs = useMemo(() => listAgentCollaborationRuns(state), [state]);
  const selectedRun = selectAgentCollaborationRun(state, selectedRunId, selectedWorkflowRunId);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState('');

  const coordinator = agents.find((agent) => agent.manifest.id === 'coordinator');
  const specialists = agents.filter((agent) => agent.manifest.id !== 'coordinator');
  const selectedAgent = agents.find((agent) => agent.manifest.id === selectedAgentId) ?? agents[0];
  const selectedNode = selectedRun?.nodes.find((node) => node.id === selectedNodeId) ?? selectedRun?.nodes[0];
  const agentNameById = new Map(agents.map((agent) => [agent.manifest.id, agent.manifest.displayName]));

  useEffect(() => {
    if (!agents.length) {
      setSelectedAgentId('');
      return;
    }
    if (!agents.some((agent) => agent.manifest.id === selectedAgentId)) {
      setSelectedAgentId(agents[0].manifest.id);
    }
  }, [agents, selectedAgentId]);

  useEffect(() => {
    if (!selectedRun?.nodes.length) {
      setSelectedNodeId('');
      return;
    }
    if (!selectedRun.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(selectedRun.nodes[0].id);
    }
  }, [selectedNodeId, selectedRun]);

  return (
    <section className="content-stack architecture-page">
      <section className="panel agent-responsibility-panel">
        <div className="section-heading agent-section-heading">
          <div>
            <h2>Agent 职责拓扑</h2>
            <p>Manifest 声明与 Runtime 运行事实分开显示；Bridge、Primary Agent 和 Delivery 保持唯一收发与执行边界。</p>
          </div>
          <span className={`agent-mode-badge mode-${state.mode}`}>{agentModeLabel(state.mode)}</span>
        </div>
        <p className="agent-mode-description">{agentModeDescription(state.mode)}</p>

        <div className="agent-summary-grid">
          <div><span>当前模式</span><strong>{agentModeLabel(state.mode)}</strong></div>
          <div><span>Worker 池</span><strong>{poolHealthLabel(state.poolHealth)}</strong></div>
          <div><span>活动任务</span><strong>{state.activeTaskCount}</strong></div>
          <div><span>Worker 数量</span><strong>{state.workers.length}</strong></div>
        </div>

        <div className="subsection-title agent-subsection-title">
          <strong>当前运行主链</strong>
          <span>只展示宿主返回的状态，不在页面内重算策略。</span>
        </div>
        <div className="architecture-flow">
          {blueprint.map((item) => (
            <article key={item.id} className={`architecture-flow-node ${item.status}`}>
              <span>{item.title}</span>
              <p>{item.detail}</p>
              {item.children && item.children.length > 0 && (
                <div className="architecture-flow-children">
                  {item.children.map((child) => (
                    <small key={child.id}>{child.title} · {child.detail}</small>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>

        <div className="subsection-title agent-subsection-title">
          <strong>协作职责边界</strong>
          <span>专业 Agent 首期全部只读；Performance Agent 是异步观察旁路。</span>
        </div>
        <div className="agent-responsibility-layout">
          <div className="agent-topology-viewport">
            <div className="agent-topology" aria-label="Agent 职责拓扑图">
              <div className="agent-topology-node deterministic"><strong>Bridge Gateway</strong><span>确定性入口与唯一发送者</span><small>平台身份与 evidence</small></div>
              <span className="agent-topology-arrow" aria-hidden="true">→</span>
              <div className="agent-topology-node deterministic"><strong>Context Broker</strong><span>确定性证据归一与引用解析</span><small>不授权、不执行</small></div>
              <span className="agent-topology-arrow" aria-hidden="true">→</span>
              <TopologyAgentNode agent={coordinator} selected={selectedAgent?.manifest.id === coordinator?.manifest.id} onSelect={setSelectedAgentId} />
              <span className="agent-topology-arrow fanout" aria-hidden="true">⇢</span>
              <div className="agent-topology-specialists">
                {specialists.map((agent) => (
                  <div key={agent.manifest.id} className={agent.manifest.id === 'performance' ? 'agent-topology-async' : ''}>
                    {agent.manifest.id === 'performance' && <small>异步性能旁路</small>}
                    <TopologyAgentNode agent={agent} selected={selectedAgent?.manifest.id === agent.manifest.id} onSelect={setSelectedAgentId} />
                  </div>
                ))}
                {specialists.length === 0 && <TopologyAgentNode agent={undefined} selected={false} onSelect={() => undefined} />}
              </div>
              <span className="agent-topology-arrow merge" aria-hidden="true">⇢</span>
              <div className="agent-topology-node executor"><strong>Primary Agent</strong><span>唯一回复与工具执行者</span><small>只消费已验证 section</small></div>
              <span className="agent-topology-arrow" aria-hidden="true">→</span>
              <div className="agent-topology-node deterministic"><strong>Policy Verifier</strong><span>权限、风险与结果复核</span><small>专业 Agent 不得绕过</small></div>
              <span className="agent-topology-arrow" aria-hidden="true">→</span>
              <div className="agent-topology-node deterministic"><strong>Delivery</strong><span>唯一平台投递收口</span><small>格式化与审计</small></div>
            </div>
          </div>

          <aside className="agent-manifest-detail" aria-live="polite">
            {selectedAgent ? (
              <>
                <div className="agent-detail-title">
                  <div><span>Manifest 声明</span><h3>{selectedAgent.manifest.displayName}</h3></div>
                  <span className={`agent-health-badge ${selectedAgent.health}`}>{responsibilityHealthLabel(selectedAgent.health)}</span>
                </div>
                <dl>
                  <dt>职责</dt><dd>{joinFacts(selectedAgent.manifest.responsibilities)}</dd>
                  <dt>负责</dt><dd>{joinFacts(selectedAgent.manifest.owns)}</dd>
                  <dt>不负责</dt><dd>{joinFacts(selectedAgent.manifest.excludes)}</dd>
                  <dt>能力</dt><dd>{joinFacts(selectedAgent.manifest.capabilities)}</dd>
                  <dt>输入 evidence</dt><dd>{joinFacts(selectedAgent.manifest.inputEvidenceKinds)}</dd>
                  <dt>输出 Schema</dt><dd><code>{selectedAgent.manifest.outputSchemaId}</code></dd>
                  <dt>副作用</dt><dd>{selectedAgent.manifest.sideEffectLevel}</dd>
                  <dt>模型档位</dt><dd>{selectedAgent.manifest.modelProfile}</dd>
                  <dt>超时 / 并发</dt><dd>{formatAgentDuration(selectedAgent.manifest.timeoutMs)} / {selectedAgent.manifest.concurrency}</dd>
                </dl>
                <div className="agent-runtime-facts">
                  <span>Runtime 事实</span>
                  <strong>{selectedAgent.workerId || '未分配 Worker'}</strong>
                  <small>最近调用 {formatTimestamp(selectedAgent.lastInvokedAt)} · {formatAgentDuration(selectedAgent.lastDurationMs)}</small>
                  <small>成功 {selectedAgent.successCount} / 失败 {selectedAgent.failureCount} / 超时 {selectedAgent.timeoutCount}</small>
                </div>
              </>
            ) : <div className="empty-inline">Agent Registry 尚未返回职责声明。</div>}
          </aside>
        </div>

        <div className="subsection-title agent-subsection-title">
          <strong>Worker 实时状态</strong>
          <span>每个 Worker 同时只运行一个任务；stdout 仅承载 NDJSON 协议。</span>
        </div>
        <div className="agent-worker-grid">
          {state.workers.map((worker) => (
            <article key={worker.workerId} className={`agent-worker-card ${worker.health}`}>
              <div><strong>{worker.workerId}</strong><span>{workerHealthLabel(worker.health)}</span></div>
              <dl>
                <dt>PID</dt><dd>{worker.pid ?? '-'}</dd>
                <dt>当前任务</dt><dd>{worker.activeTaskId || '-'}</dd>
                <dt>Heartbeat</dt><dd>{formatTimestamp(worker.lastHeartbeatAt)}</dd>
                <dt>重启 / 超时 / 熔断</dt><dd>{worker.restartCount} / {worker.timeoutCount} / {worker.circuitOpenCount}</dd>
                {worker.lastErrorCode && <><dt>错误码</dt><dd><code>{worker.lastErrorCode}</code></dd></>}
              </dl>
            </article>
          ))}
          {state.workers.length === 0 && <div className="empty-inline">当前模式未启动 Worker，或 Runtime 状态尚未生成。</div>}
        </div>
      </section>

      <section className="panel agent-workflow-panel">
        <div className="section-heading agent-section-heading">
          <div>
            <h2>实时与历史工作流</h2>
            <p>活动协作回合优先展示；会话详情和本页复用同一份 Runtime 节点、边快照。</p>
          </div>
          {selectedRun && <span className={`agent-run-status status-${selectedRun.status}`}>{runStatusLabel(selectedRun.status)}</span>}
        </div>
        <div className="agent-run-toolbar">
          <label>
            <span>协作回合</span>
            <select
              value={selectedRun?.runId ?? ''}
              onChange={(event) => {
                const run = runs.find((item) => item.runId === event.target.value);
                if (run) onSelectRun?.(run.runId, run.workflowRunId);
              }}
              disabled={runs.length === 0}
            >
              {runs.length === 0 && <option value="">暂无协作记录</option>}
              {runs.map((run) => (
                <option key={run.runId} value={run.runId}>
                  {formatTimestamp(run.startedAt)} · {runStatusLabel(run.status)} · {redactAgentDisplayText(run.triggerReason, 72)}
                </option>
              ))}
            </select>
          </label>
          {selectedRun && (
            <div className="agent-run-summary">
              <span>触发：{redactAgentDisplayText(selectedRun.triggerReason)}</span>
              <span>总耗时：{formatAgentDuration(selectedRun.durationMs)}</span>
              <span>{selectedRun.mode === 'shadow' ? '仅观察，未参与回答' : selectedRun.injectedIntoPrimary ? '已注入 Primary Agent' : '未注入 Primary Agent'}</span>
            </div>
          )}
        </div>

        <div className="agent-workflow-detail-layout">
          <AgentWorkflowGraph run={selectedRun} selectedNodeId={selectedNode?.id} onSelectNode={setSelectedNodeId} />
          <aside className="agent-node-detail" aria-live="polite">
            {selectedNode ? (
              <>
                <div className="agent-detail-title">
                  <div><span>节点详情</span><h3>{selectedNode.label}</h3></div>
                  <span className={`agent-run-status status-${selectedNode.status}`}>{workflowNodeStatusLabel(selectedNode.status)}</span>
                </div>
                <dl>
                  <dt>Agent</dt><dd>{selectedNode.agentId ? agentNameById.get(selectedNode.agentId) || selectedNode.agentId : '确定性底座'}</dd>
                  <dt>开始 / 结束</dt><dd>{formatTimestamp(selectedNode.startedAt)} / {formatTimestamp(selectedNode.endedAt)}</dd>
                  <dt>耗时</dt><dd>{formatAgentDuration(selectedNode.durationMs)}</dd>
                  <dt>Evidence</dt><dd>{selectedNode.evidenceCount ?? selectedNode.evidenceRefs?.length ?? 0} · {summarizeEvidenceRefs(selectedNode.evidenceRefs)}</dd>
                  <dt>模型</dt><dd>{[selectedNode.modelSource, selectedNode.model].filter(Boolean).join(' · ') || '-'}</dd>
                  <dt>Token</dt><dd>{totalTokenLabel(selectedNode)}</dd>
                  <dt>触发原因</dt><dd>{redactAgentDisplayText(selectedNode.triggerReason)}</dd>
                  <dt>Findings 摘要</dt><dd>{redactAgentDisplayText(selectedNode.summary, 420)}</dd>
                  {(selectedNode.fallbackReason || selectedNode.errorCode) && <><dt>Fallback / 错误</dt><dd>{redactAgentDisplayText(selectedNode.fallbackReason)} {selectedNode.errorCode ? <code>{selectedNode.errorCode}</code> : null}</dd></>}
                </dl>
              </>
            ) : <div className="empty-inline">选择一个工作流节点查看脱敏运行事实。</div>}
          </aside>
        </div>
      </section>

      <section className="panel agent-performance-panel">
        <div className="section-heading">
          <div>
            <h2>性能观察</h2>
            <p>指标和建议仅供观察，不提供自动应用、自动重启或发布入口。</p>
          </div>
        </div>
        <div className="agent-performance-metrics">
          <div><span>Coordinator 触发率</span><strong>{formatRate(state.metrics.coordinatorTriggerRate)}</strong></div>
          <div><span>协作 fallback</span><strong>{formatRate(state.metrics.fallbackRate)}</strong></div>
          <div><span>统计窗口</span><strong>{state.metrics.windowRunCount} 回合</strong></div>
          <div><span>Worker 重启</span><strong>{state.metrics.workerRestartCount}</strong></div>
          <div><span>Worker 超时</span><strong>{state.metrics.workerTimeoutCount}</strong></div>
          <div><span>熔断次数</span><strong>{state.metrics.circuitOpenCount}</strong></div>
        </div>

        <div className="agent-performance-layout">
          <div className="agent-performance-table-wrap">
            <table className="agent-performance-table">
              <thead><tr><th>Agent</th><th>状态</th><th>成功率</th><th>平均</th><th>P95</th><th>调用</th></tr></thead>
              <tbody>
                {agents.map((agent) => {
                  const calls = agent.successCount + agent.failureCount + agent.timeoutCount;
                  return (
                    <tr key={agent.manifest.id}>
                      <td>{agent.manifest.displayName}</td>
                      <td>{responsibilityHealthLabel(agent.health)}</td>
                      <td>{formatRate(agentSuccessRate(agent))}</td>
                      <td>{formatAgentDuration(agent.averageDurationMs)}</td>
                      <td>{formatAgentDuration(agent.p95DurationMs)}</td>
                      <td>{calls}</td>
                    </tr>
                  );
                })}
                {agents.length === 0 && <tr><td colSpan={6}>暂无 Agent 运行统计。</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="agent-performance-side">
            <section>
              <h3>专业 Agent 调用分布</h3>
              <ul>
                {Object.entries(state.metrics.specialistCallDistribution).map(([agentId, count]) => (
                  <li key={agentId}><span>{agentNameById.get(agentId) || agentId}</span><strong>{count}</strong></li>
                ))}
                {Object.keys(state.metrics.specialistCallDistribution).length === 0 && <li><span>暂无调用</span><strong>0</strong></li>}
              </ul>
            </section>
            <section className="agent-performance-suggestion">
              <h3>Performance Agent 最新建议</h3>
              {state.latestPerformanceSuggestion ? (
                <>
                  <p>{redactAgentDisplayText(state.latestPerformanceSuggestion.summary, 520)}</p>
                  <small>{formatTimestamp(state.latestPerformanceSuggestion.generatedAt)} · {state.latestPerformanceSuggestion.evidenceWindow.runCount} 个协作回合</small>
                  <ul>{state.latestPerformanceSuggestion.metricBasis.map((basis) => <li key={basis}>{redactAgentDisplayText(basis, 180)}</li>)}</ul>
                </>
              ) : <p>尚未达到批次阈值，或 Performance Agent 尚未生成建议。</p>}
            </section>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>机器人八层职责注册表</h2>
            <p>内容直接来自 bridge-core 的 Agent Architecture Registry；面板只读展示，不维护副本。</p>
          </div>
        </div>
        <div className="architecture-layer-grid">
          {AGENT_ARCHITECTURE_LAYERS.map((layer, index) => (
            <article className="architecture-layer-card" key={layer.id}>
              <div className="architecture-layer-index">{String(index + 1).padStart(2, '0')}</div>
              <div>
                <h3>{layer.title}</h3>
                <p>{layer.responsibility}</p>
                <dl>
                  <dt>负责</dt>
                  <dd>{layer.owns.join(' · ')}</dd>
                  <dt>不负责</dt>
                  <dd>{layer.excludes.join(' · ')}</dd>
                </dl>
              </div>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}
