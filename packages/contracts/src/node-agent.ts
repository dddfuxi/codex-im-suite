export type NodeAgentKind = 'local' | 'remote' | 'fake';
export type NodeAgentStatus = 'online' | 'degraded' | 'offline' | 'unknown';
export type NodeActionLeaseStatus = 'requested' | 'granted' | 'denied' | 'expired' | 'completed' | 'failed';

export interface NodeCapability {
  id: string;
  displayName: string;
  category: 'bridge' | 'executor' | 'mcp' | 'memory' | 'extension' | 'release' | 'media' | 'custom';
  status: NodeAgentStatus;
  detail?: string;
  risk?: 'low' | 'medium' | 'high';
}

export interface NodeAgentHeartbeat {
  schema: 'codex-im-suite/node-agent-heartbeat/v1';
  nodeId: string;
  displayName: string;
  kind: NodeAgentKind;
  status: NodeAgentStatus;
  version: string;
  host?: string;
  lastSeenAt: string;
  capabilities: NodeCapability[];
}

export interface NodeActionLease {
  schema: 'codex-im-suite/node-action-lease/v1';
  leaseId: string;
  nodeId: string;
  command: string;
  requestedBy: string;
  status: NodeActionLeaseStatus;
  createdAt: string;
  expiresAt: string;
  completedAt?: string;
  error?: string;
}

export interface NodeLogEvent {
  schema: 'codex-im-suite/node-log-event/v1';
  nodeId: string;
  level: 'debug' | 'info' | 'warning' | 'error';
  message: string;
  timestamp: string;
  source?: string;
}
