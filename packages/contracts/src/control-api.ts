import type { SpeechPanelStateContract } from './speech-contract.js';

export type ControlApiRole = 'viewer' | 'operator' | 'owner';

export const CONTROL_PANEL_STATE_SCHEMA = 'codex-im-suite/control-panel-state/v1' as const;
export const CONTROL_COMMAND_SCHEMA = 'codex-im-suite/control-command/v1' as const;
export const CONTROL_RESULT_SCHEMA = 'codex-im-suite/control-result/v1' as const;

export interface ControlCommandRequest<TPayload = unknown> {
  schema: typeof CONTROL_COMMAND_SCHEMA;
  id: string;
  type: 'command';
  command: string;
  payload: TPayload;
  nodeId?: string;
}

export type ControlCommandEnvelope<TPayload = unknown> = ControlCommandRequest<TPayload>;

export interface ControlCommandResult<TData = unknown> {
  schema: typeof CONTROL_RESULT_SCHEMA;
  id: string;
  type: 'result';
  ok: boolean;
  data?: TData;
  error?: string;
  nodeId?: string;
}

export interface RuntimeActionContract {
  id: string;
  label: string;
  enabled: boolean;
  reason?: string;
}

export interface RuntimeUnitContract<TStatus extends string = string> {
  unitId: string;
  id: string;
  displayName: string;
  kind: string;
  category: string;
  status: TStatus;
  detail: string;
  enabled: boolean;
  installState: string;
  source: string;
  cwd: string;
  version: string;
  description: string;
  canInstall: boolean;
  actions: RuntimeActionContract[];
}

export interface ControlPanelSuiteContract {
  version: string;
  protocol: string;
  branch: string;
  commit: string;
  gitDirty: number;
  suiteRoot: string;
  skillDir: string;
}

/**
 * 面板各领域继续拥有自己的强类型视图；这里固定跨宿主的顶层 wire 形状，
 * 避免 React、HTTP 和 WebView2 分别复制一份 PanelState。
 */
export interface ControlPanelStateSections {
  services: unknown[];
  nodes: unknown;
  extensions: unknown;
  skillGovernance: unknown;
  promptSnapshots: unknown;
  scheduledTasks: unknown;
  mcp: unknown;
  release: unknown;
  liveSync: unknown;
  settings: unknown;
  history: unknown;
  speech: SpeechPanelStateContract;
  workflow: unknown;
  agentCollaboration?: unknown;
  projectRegistry: unknown;
  memory: unknown;
  memorySkillAssets: unknown;
  memoryReminders: unknown;
  executors: unknown;
  permissions: unknown;
  paths: unknown;
  activities: unknown[];
  diagnostics?: unknown;
}

export interface ControlPanelStateContract<
  TSections extends ControlPanelStateSections = ControlPanelStateSections,
> {
  schema: typeof CONTROL_PANEL_STATE_SCHEMA;
  generatedAt: string;
  suite: ControlPanelSuiteContract;
  services: TSections['services'];
  nodes: TSections['nodes'];
  extensions: TSections['extensions'];
  skillGovernance: TSections['skillGovernance'];
  promptSnapshots: TSections['promptSnapshots'];
  scheduledTasks: TSections['scheduledTasks'];
  mcp: TSections['mcp'];
  release: TSections['release'];
  liveSync: TSections['liveSync'];
  settings: TSections['settings'];
  history: TSections['history'];
  speech: TSections['speech'];
  workflow: TSections['workflow'];
  agentCollaboration?: TSections['agentCollaboration'];
  projectRegistry: TSections['projectRegistry'];
  memory: TSections['memory'];
  memorySkillAssets: TSections['memorySkillAssets'];
  memoryReminders: TSections['memoryReminders'];
  executors: TSections['executors'];
  permissions: TSections['permissions'];
  paths: TSections['paths'];
  activities: TSections['activities'];
  diagnostics?: TSections['diagnostics'];
}

export interface ControlPlaneState<TNode = unknown> {
  schema: 'codex-im-suite/control-plane-state/v1';
  generatedAt: string;
  activeNodeId: string;
  nodes: TNode[];
}
