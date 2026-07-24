import {
  AGENT_COLLABORATION_PROTOCOL,
  type AgentCollaborationMode,
  type AgentCollaborationPanelState,
  type AgentCollaborationRun,
  type AgentCollaborationWorkflowEdge,
  type AgentCollaborationWorkflowNode,
  type AgentResponsibilityView,
} from '@codex-im-suite/contracts/agent-collaboration';

export function getAgentCollaborationQuickControl(mode: AgentCollaborationMode): {
  label: '开启' | '关闭';
  targetMode: 'off' | 'shadow';
} {
  return mode === 'off'
    ? { label: '开启', targetMode: 'shadow' }
    : { label: '关闭', targetMode: 'off' };
}

const agentOrder = ['coordinator', 'context', 'memory', 'performance'] as const;
const workflowColumnByKind: Record<AgentCollaborationWorkflowNode['kind'], number> = {
  bridge: 0,
  context_broker: 1,
  coordinator: 2,
  specialist: 3,
  primary_agent: 4,
  policy_verifier: 5,
  delivery: 6,
};

export type AgentWorkflowLayoutNode = {
  node: AgentCollaborationWorkflowNode;
  column: number;
  row: number;
  rowSpan: number;
  x: number;
  y: number;
};

export type AgentWorkflowLayoutEdge = {
  edge: AgentCollaborationWorkflowEdge;
  path: string;
};

export type AgentWorkflowLayout = {
  width: number;
  height: number;
  nodes: AgentWorkflowLayoutNode[];
  edges: AgentWorkflowLayoutEdge[];
};

export function createEmptyAgentCollaborationState(updatedAt = ''): AgentCollaborationPanelState {
  return {
    protocol: AGENT_COLLABORATION_PROTOCOL,
    updatedAt,
    mode: 'off',
    poolHealth: 'disabled',
    activeTaskCount: 0,
    workers: [],
    agents: [],
    recentRuns: [],
    metrics: {
      windowRunCount: 0,
      coordinatorTriggerRate: 0,
      fallbackRate: 0,
      workerRestartCount: 0,
      workerTimeoutCount: 0,
      circuitOpenCount: 0,
      specialistCallDistribution: {},
    },
  };
}

export function normalizeAgentCollaborationState(
  state?: AgentCollaborationPanelState,
): AgentCollaborationPanelState {
  return state?.protocol === AGENT_COLLABORATION_PROTOCOL
    ? state
    : createEmptyAgentCollaborationState();
}

export function listAgentCollaborationRuns(
  state?: AgentCollaborationPanelState,
): AgentCollaborationRun[] {
  const normalized = normalizeAgentCollaborationState(state);
  const byId = new Map<string, AgentCollaborationRun>();
  if (normalized.currentRun) byId.set(normalized.currentRun.runId, normalized.currentRun);
  for (const run of normalized.recentRuns) {
    if (!byId.has(run.runId)) byId.set(run.runId, run);
  }
  return [...byId.values()].sort((left, right) => {
    if (left.status === 'running' && right.status !== 'running') return -1;
    if (right.status === 'running' && left.status !== 'running') return 1;
    return Date.parse(right.startedAt || '') - Date.parse(left.startedAt || '');
  });
}

export function selectAgentCollaborationRun(
  state: AgentCollaborationPanelState | undefined,
  preferredRunId?: string,
  workflowRunId?: string,
): AgentCollaborationRun | undefined {
  const runs = listAgentCollaborationRuns(state);
  if (preferredRunId) {
    const preferred = runs.find((run) => run.runId === preferredRunId);
    if (preferred) return preferred;
  }
  if (workflowRunId) {
    const linked = runs.find((run) => run.workflowRunId === workflowRunId);
    if (linked) return linked;
  }
  return runs.find((run) => run.status === 'running') ?? runs[0];
}

export function findAgentRunByWorkflowRunId(
  state: AgentCollaborationPanelState | undefined,
  workflowRunId: string,
): AgentCollaborationRun | undefined {
  if (!workflowRunId) return undefined;
  return listAgentCollaborationRuns(state).find((run) => run.workflowRunId === workflowRunId);
}

export function orderAgentResponsibilities(agents: AgentResponsibilityView[]): AgentResponsibilityView[] {
  const order = new Map(agentOrder.map((id, index) => [id, index]));
  return [...agents].sort((left, right) => {
    const leftOrder = order.get(left.manifest.id as typeof agentOrder[number]) ?? agentOrder.length;
    const rightOrder = order.get(right.manifest.id as typeof agentOrder[number]) ?? agentOrder.length;
    return leftOrder - rightOrder || left.manifest.displayName.localeCompare(right.manifest.displayName, 'zh-CN');
  });
}

export function buildAgentWorkflowLayout(run?: AgentCollaborationRun): AgentWorkflowLayout {
  const width = 1400;
  const height = 420;
  if (!run) return { width, height, nodes: [], edges: [] };

  const specialists = run.nodes
    .filter((node) => node.kind === 'specialist')
    .sort((left, right) => (left.startedAt || left.id).localeCompare(right.startedAt || right.id));
  const specialistRow = new Map(specialists.map((node, index) => [node.id, index % 2]));
  const nodes = run.nodes.map((node): AgentWorkflowLayoutNode => {
    const column = workflowColumnByKind[node.kind];
    const isSpecialist = node.kind === 'specialist' && specialists.length > 1;
    const row = isSpecialist ? specialistRow.get(node.id) ?? 0 : 0;
    return {
      node,
      column,
      row,
      rowSpan: isSpecialist ? 1 : 2,
      x: 100 + column * 200,
      y: isSpecialist ? (row === 0 ? 125 : 295) : 210,
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.node.id, node]));
  const edges = run.edges.flatMap((edge): AgentWorkflowLayoutEdge[] => {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) return [];
    const startX = from.x + 72;
    const endX = to.x - 72;
    const bend = Math.max(26, (endX - startX) * 0.45);
    return [{
      edge,
      path: `M ${startX} ${from.y} C ${startX + bend} ${from.y}, ${endX - bend} ${to.y}, ${endX} ${to.y}`,
    }];
  });
  return { width, height, nodes, edges };
}

export function orderWorkflowTimeline(nodes: AgentCollaborationWorkflowNode[]): AgentCollaborationWorkflowNode[] {
  return [...nodes].sort((left, right) => {
    const leftTime = Date.parse(left.startedAt || '');
    const rightTime = Date.parse(right.startedAt || '');
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    return workflowColumnByKind[left.kind] - workflowColumnByKind[right.kind]
      || left.label.localeCompare(right.label, 'zh-CN');
  });
}

export function agentSuccessRate(agent: AgentResponsibilityView): number | undefined {
  const total = agent.successCount + agent.failureCount + agent.timeoutCount;
  return total > 0 ? agent.successCount / total : undefined;
}

export function formatRate(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function formatAgentDuration(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  if (value < 1000) return `${Math.max(0, Math.round(value))} ms`;
  return `${(Math.max(0, value) / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

export function summarizeEvidenceRefs(refs?: string[], limit = 3): string {
  if (!refs?.length) return '无 evidence';
  const visible = refs.slice(0, limit).map((item) => redactAgentDisplayText(item, 42));
  const suffix = refs.length > visible.length ? ` 等 ${refs.length} 项` : '';
  return `${visible.join('、')}${suffix}`;
}

/**
 * Runtime 已负责生成脱敏摘要；前端再做一次展示层兜底，避免异常 payload
 * 把凭据或本机绝对路径带入可回放的面板页面。
 */
export function redactAgentDisplayText(value?: string, maxLength = 240): string {
  if (!value) return '-';
  const redacted = value
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s，。；;]+/gu, '[路径已隐藏]')
    .replace(/(^|[\s(])\/(?:Users|home|var|tmp|etc|opt|mnt|srv|workspace)\/[^\s，。；;)]+/giu, '$1[路径已隐藏]')
    .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s，。；;]+/giu, '$1=[已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[凭据已隐藏]@')
    .trim();
  return redacted.length > maxLength ? `${redacted.slice(0, Math.max(1, maxLength - 1))}…` : redacted;
}

export function agentModeLabel(mode: AgentCollaborationPanelState['mode']): string {
  if (mode === 'assist') return 'Assist · 已参与回答';
  if (mode === 'shadow') return 'Shadow · 仅观察';
  return 'Off · 未启用';
}

export function agentModeDescription(mode: AgentCollaborationPanelState['mode']): string {
  if (mode === 'assist') return '已验证的只读 Agent 结果会作为独立 section 注入 Primary Agent。';
  if (mode === 'shadow') return '协作链会运行并记录图快照，但不会影响 Primary Agent 的回答。';
  return '普通聊天和确定性命令继续走现有单 Agent 链路，Worker 池不启动。';
}

export function workflowNodeStatusLabel(status: AgentCollaborationWorkflowNode['status']): string {
  const labels: Record<AgentCollaborationWorkflowNode['status'], string> = {
    pending: '待运行',
    running: '运行中',
    succeeded: '成功',
    failed: '失败',
    cancelled: '已取消',
    skipped: '已跳过',
    fallback: '已回退',
  };
  return labels[status];
}

export function workflowNodeStatusGlyph(status: AgentCollaborationWorkflowNode['status']): string {
  const glyphs: Record<AgentCollaborationWorkflowNode['status'], string> = {
    pending: '○',
    running: '…',
    succeeded: '✓',
    failed: '!',
    cancelled: '×',
    skipped: '–',
    fallback: '↪',
  };
  return glyphs[status];
}
