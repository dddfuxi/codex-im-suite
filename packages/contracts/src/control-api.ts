export type ControlApiRole = 'viewer' | 'operator' | 'owner';

export interface ControlCommandEnvelope<TPayload = unknown> {
  id: string;
  type: 'command';
  command: string;
  payload: TPayload;
  nodeId?: string;
}

export interface ControlCommandResult<TData = unknown> {
  id: string;
  type: 'result';
  ok: boolean;
  data?: TData;
  error?: string;
  nodeId?: string;
}

export interface ControlPlaneState<TNode = unknown> {
  schema: 'codex-im-suite/control-plane-state/v1';
  generatedAt: string;
  activeNodeId: string;
  nodes: TNode[];
}
