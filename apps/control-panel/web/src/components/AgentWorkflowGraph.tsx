import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Bot,
  BrainCircuit,
  Network,
  Send,
  ShieldCheck,
  Waypoints,
} from 'lucide-react';
import type {
  AgentCollaborationRun,
  AgentCollaborationWorkflowNode,
} from '@codex-im-suite/contracts/agent-collaboration';
import {
  buildAgentWorkflowLayout,
  formatAgentDuration,
  orderWorkflowTimeline,
  workflowNodeStatusGlyph,
  workflowNodeStatusLabel,
} from '../agent-collaboration-view-model.js';

type AgentWorkflowGraphProps = {
  run?: AgentCollaborationRun;
  selectedNodeId?: string;
  onSelectNode?: (nodeId: string) => void;
};

function nodeDuration(node: AgentCollaborationWorkflowNode, now: number): number | undefined {
  if (node.status === 'running' && node.startedAt) {
    const startedAt = Date.parse(node.startedAt);
    if (Number.isFinite(startedAt)) return Math.max(0, now - startedAt);
  }
  if (typeof node.durationMs === 'number') return node.durationMs;
  if (node.startedAt && node.endedAt) {
    const startedAt = Date.parse(node.startedAt);
    const endedAt = Date.parse(node.endedAt);
    if (Number.isFinite(startedAt) && Number.isFinite(endedAt)) return Math.max(0, endedAt - startedAt);
  }
  return undefined;
}

function NodeKindIcon({ kind }: { kind: AgentCollaborationWorkflowNode['kind'] }) {
  const props = { size: 16, 'aria-hidden': true } as const;
  switch (kind) {
    case 'bridge':
      return <Network {...props} />;
    case 'context_broker':
      return <Waypoints {...props} />;
    case 'coordinator':
      return <BrainCircuit {...props} />;
    case 'specialist':
      return <Activity {...props} />;
    case 'primary_agent':
      return <Bot {...props} />;
    case 'policy_verifier':
      return <ShieldCheck {...props} />;
    case 'delivery':
      return <Send {...props} />;
  }
}

function formatTimelineTime(value?: string): string {
  if (!value) return '未开始';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString('zh-CN', { hour12: false });
}

export function AgentWorkflowGraph({ run, selectedNodeId, onSelectNode }: AgentWorkflowGraphProps) {
  const layout = useMemo(() => buildAgentWorkflowLayout(run), [run]);
  const timeline = useMemo(() => orderWorkflowTimeline(run?.nodes ?? []), [run]);
  const hasRunningNode = run?.nodes.some((node) => node.status === 'running') ?? false;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasRunningNode) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunningNode]);

  if (!run || layout.nodes.length === 0) {
    return <div className="empty-inline">当前没有可回放的 Agent 协作工作流。</div>;
  }

  const markerId = `agent-flow-arrow-${run.runId.replace(/[^a-zA-Z0-9_-]/gu, '-')}`;

  return (
    <div className="agent-workflow-shell">
      <div className="agent-workflow-canvas-viewport">
        <div
          className="agent-workflow-canvas"
          role="img"
          aria-label={`Agent 协作工作流：${run.triggerReason}`}
        >
          <svg viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M 0 0 L 8 4 L 0 8 z" />
              </marker>
            </defs>
            {layout.edges.map(({ edge, path }) => (
              <path
                key={`${edge.from}-${edge.to}-${edge.kind}`}
                className={`agent-workflow-edge ${edge.kind} ${edge.status}`}
                d={path}
                markerEnd={`url(#${markerId})`}
              />
            ))}
          </svg>
          {layout.nodes.map(({ node, x, y }) => {
            const duration = nodeDuration(node, now);
            return (
              <button
                key={node.id}
                type="button"
                className={`agent-workflow-node kind-${node.kind} status-${node.status}${selectedNodeId === node.id ? ' selected' : ''}`}
                style={{ left: `${(x / layout.width) * 100}%`, top: `${(y / layout.height) * 100}%` }}
                onClick={() => onSelectNode?.(node.id)}
                aria-pressed={selectedNodeId === node.id}
                aria-label={`${node.label}，${workflowNodeStatusLabel(node.status)}，${formatAgentDuration(duration)}`}
              >
                <span className="agent-workflow-node-heading">
                  <NodeKindIcon kind={node.kind} />
                  <strong>{node.label}</strong>
                </span>
                {node.agentId && <small>{node.agentId}</small>}
                <span className="agent-workflow-node-state">
                  <span className="agent-workflow-node-status-mark" aria-hidden="true">{workflowNodeStatusGlyph(node.status)}</span>
                  <span>{workflowNodeStatusLabel(node.status)}</span>
                  <span>{formatAgentDuration(duration)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <section className="agent-workflow-timeline" aria-label="Agent 工作流顺序时间线">
        <h3>顺序时间线</h3>
        <ol>
          {timeline.map((node) => (
            <li key={node.id} className={`status-${node.status}`}>
              <button type="button" onClick={() => onSelectNode?.(node.id)} aria-pressed={selectedNodeId === node.id}>
                <span className="agent-workflow-node-status-mark" aria-hidden="true">{workflowNodeStatusGlyph(node.status)}</span>
                <strong>{node.label}</strong>
                <span>{workflowNodeStatusLabel(node.status)}</span>
                <time>{formatTimelineTime(node.startedAt)}</time>
                <span>{formatAgentDuration(nodeDuration(node, now))}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
