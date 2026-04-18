import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type BridgeRuntimeStage =
  | 'adapter_waiting'
  | 'message_received'
  | 'message_bound'
  | 'engine_started'
  | 'permission_waiting'
  | 'provider_streaming'
  | 'reply_sending'
  | 'reply_sent'
  | 'message_failed';

export interface BridgeRuntimeRequestSummary {
  messageId: string;
  chatId: string;
  channelType: string;
  displayName: string;
  textPreview: string;
  startedAt: string;
  stage: BridgeRuntimeStage;
  stageUpdatedAt: string;
  permissionRequestId?: string;
  permissionType?: string;
  permissionStartedAt?: string;
  error?: string;
}

export interface BridgeRuntimeInboundSummary {
  messageId: string;
  chatId: string;
  channelType: string;
  displayName: string;
  chatType?: string;
  textPreview: string;
  receivedAt: string;
}

export interface BridgeRuntimeUnhandledError {
  message: string;
  stack?: string;
  type?: string;
  at: string;
}

export interface BridgeRuntimeFeishuWsState {
  state?: 'starting' | 'connected' | 'disconnected' | 'closed' | 'error';
  updatedAt?: string;
  lastEventType?: string;
  lastEventAt?: string;
  lastError?: string;
  lastDisconnectReason?: string;
}

export interface BridgeRuntimeFeishuP2pPollState {
  state?: 'idle' | 'polling' | 'recovered' | 'failed';
  updatedAt?: string;
  lastPollAt?: string;
  lastRecoveredMessageId?: string;
  lastRecoveredChatId?: string;
  lastError?: string;
}

export interface BridgeRuntimeAudit {
  runId?: string;
  pid?: number;
  startedAt?: string;
  lastHeartbeatAt?: string;
  lastStage?: BridgeRuntimeStage | string;
  lastStageAt?: string;
  lastInboundMessage?: BridgeRuntimeInboundSummary | null;
  lastActiveRequest?: BridgeRuntimeRequestSummary | null;
  lastCompletedRequest?: BridgeRuntimeRequestSummary | null;
  lastExitReason?: string | null;
  lastExitAt?: string | null;
  lastUnhandledError?: BridgeRuntimeUnhandledError | null;
  feishuWs?: BridgeRuntimeFeishuWsState;
  feishuP2pPoll?: BridgeRuntimeFeishuP2pPollState;
}

const CTI_HOME = process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im');
export const BRIDGE_RUNTIME_AUDIT_PATH = path.join(CTI_HOME, 'runtime', 'bridge-runtime-audit.json');

function nowIso(): string {
  return new Date().toISOString();
}

function ensureParentDir(): void {
  fs.mkdirSync(path.dirname(BRIDGE_RUNTIME_AUDIT_PATH), { recursive: true });
}

export function readBridgeRuntimeAudit(): BridgeRuntimeAudit {
  try {
    return JSON.parse(fs.readFileSync(BRIDGE_RUNTIME_AUDIT_PATH, 'utf8')) as BridgeRuntimeAudit;
  } catch {
    return {};
  }
}

export function writeBridgeRuntimeAudit(next: BridgeRuntimeAudit): void {
  ensureParentDir();
  const tmp = `${BRIDGE_RUNTIME_AUDIT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, BRIDGE_RUNTIME_AUDIT_PATH);
}

export function patchBridgeRuntimeAudit(patch: Partial<BridgeRuntimeAudit>): BridgeRuntimeAudit {
  const current = readBridgeRuntimeAudit();
  const next = {
    ...current,
    ...patch,
    feishuWs: {
      ...(current.feishuWs || {}),
      ...(patch.feishuWs || {}),
    },
    feishuP2pPoll: {
      ...(current.feishuP2pPoll || {}),
      ...(patch.feishuP2pPoll || {}),
    },
  } satisfies BridgeRuntimeAudit;
  writeBridgeRuntimeAudit(next);
  return next;
}

export function initializeBridgeRuntimeAudit(runId: string, pid: number): BridgeRuntimeAudit {
  const timestamp = nowIso();
  const next: BridgeRuntimeAudit = {
    runId,
    pid,
    startedAt: timestamp,
    lastHeartbeatAt: timestamp,
    lastStage: 'adapter_waiting',
    lastStageAt: timestamp,
    lastInboundMessage: null,
    lastActiveRequest: null,
    lastCompletedRequest: null,
    lastExitReason: null,
    lastExitAt: null,
    lastUnhandledError: null,
    feishuWs: {
      state: 'starting',
      updatedAt: timestamp,
      lastEventType: '',
      lastEventAt: '',
      lastError: '',
      lastDisconnectReason: '',
    },
    feishuP2pPoll: {
      state: 'idle',
      updatedAt: timestamp,
      lastPollAt: '',
      lastRecoveredMessageId: '',
      lastRecoveredChatId: '',
      lastError: '',
    },
  };
  writeBridgeRuntimeAudit(next);
  return next;
}

export function touchBridgeRuntimeHeartbeat(): BridgeRuntimeAudit {
  return patchBridgeRuntimeAudit({ lastHeartbeatAt: nowIso() });
}

export function summarizeTextPreview(input: string | undefined | null, limit = 160): string {
  if (!input) return '';
  const compact = input.replace(/\s+/g, ' ').trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 1))}…`;
}

export function makeInboundSummary(data: {
  messageId: string;
  chatId: string;
  channelType: string;
  displayName: string;
  text?: string | null;
  chatType?: string | null;
}): BridgeRuntimeInboundSummary {
  return {
    messageId: data.messageId,
    chatId: data.chatId,
    channelType: data.channelType,
    displayName: data.displayName,
    chatType: data.chatType || undefined,
    textPreview: summarizeTextPreview(data.text),
    receivedAt: nowIso(),
  };
}

export function recordBridgeRuntimeInbound(summary: BridgeRuntimeInboundSummary): BridgeRuntimeAudit {
  return patchBridgeRuntimeAudit({
    lastInboundMessage: summary,
    lastHeartbeatAt: nowIso(),
  });
}

export function makeRequestSummary(data: {
  messageId: string;
  chatId: string;
  channelType: string;
  displayName: string;
  text?: string | null;
  startedAt?: string;
  stage: BridgeRuntimeStage;
}): BridgeRuntimeRequestSummary {
  const timestamp = nowIso();
  return {
    messageId: data.messageId,
    chatId: data.chatId,
    channelType: data.channelType,
    displayName: data.displayName,
    textPreview: summarizeTextPreview(data.text),
    startedAt: data.startedAt || timestamp,
    stage: data.stage,
    stageUpdatedAt: timestamp,
  };
}

export function markBridgeRuntimeStage(
  stage: BridgeRuntimeStage,
  options?: {
    activeRequest?: BridgeRuntimeRequestSummary | null;
    completedRequest?: BridgeRuntimeRequestSummary | null;
  },
): BridgeRuntimeAudit {
  const timestamp = nowIso();
  return patchBridgeRuntimeAudit({
    lastStage: stage,
    lastStageAt: timestamp,
    lastActiveRequest: options?.activeRequest,
    lastCompletedRequest: options?.completedRequest,
    lastHeartbeatAt: timestamp,
  });
}

export function updateBridgeRuntimeActiveRequest(
  patch: Partial<BridgeRuntimeRequestSummary>,
  stage?: BridgeRuntimeStage,
): BridgeRuntimeAudit {
  const current = readBridgeRuntimeAudit();
  const timestamp = nowIso();
  const currentActive = current.lastActiveRequest || null;
  const nextActive = currentActive
    ? {
      ...currentActive,
      ...patch,
      stage: stage || patch.stage || currentActive.stage,
      stageUpdatedAt: timestamp,
    }
    : null;
  return patchBridgeRuntimeAudit({
    lastStage: stage || nextActive?.stage || current.lastStage,
    lastStageAt: timestamp,
    lastActiveRequest: nextActive,
    lastHeartbeatAt: timestamp,
  });
}

export function completeBridgeRuntimeRequest(summary?: BridgeRuntimeRequestSummary | null): BridgeRuntimeAudit {
  const timestamp = nowIso();
  const completed: BridgeRuntimeRequestSummary | null = summary
    ? {
      ...summary,
      stage: 'reply_sent' as BridgeRuntimeStage,
      stageUpdatedAt: timestamp,
    }
    : null;
  return patchBridgeRuntimeAudit({
    lastStage: 'reply_sent',
    lastStageAt: timestamp,
    lastCompletedRequest: completed,
    lastActiveRequest: null,
    lastHeartbeatAt: timestamp,
  });
}

export function failBridgeRuntimeRequest(error: unknown, summary?: BridgeRuntimeRequestSummary | null): BridgeRuntimeAudit {
  const timestamp = nowIso();
  const message = error instanceof Error ? error.message : String(error);
  const failed: BridgeRuntimeRequestSummary | null = summary
    ? {
      ...summary,
      stage: 'message_failed' as BridgeRuntimeStage,
      error: message,
      stageUpdatedAt: timestamp,
    }
    : null;
  return patchBridgeRuntimeAudit({
    lastStage: 'message_failed',
    lastStageAt: timestamp,
    lastActiveRequest: failed,
    lastHeartbeatAt: timestamp,
  });
}

export function recordBridgeRuntimeExit(reason: string, error?: unknown): BridgeRuntimeAudit {
  const timestamp = nowIso();
  const current = readBridgeRuntimeAudit();
  const unhandled = error
    ? {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      type: error instanceof Error ? error.name : typeof error,
      at: timestamp,
    }
    : current.lastUnhandledError || null;
  return patchBridgeRuntimeAudit({
    lastExitReason: reason,
    lastExitAt: timestamp,
    lastUnhandledError: unhandled,
    lastHeartbeatAt: timestamp,
  });
}

export function updateFeishuWsAudit(patch: Partial<BridgeRuntimeFeishuWsState>): BridgeRuntimeAudit {
  return patchBridgeRuntimeAudit({
    feishuWs: {
      updatedAt: nowIso(),
      ...patch,
    },
  });
}

export function updateFeishuP2pPollAudit(patch: Partial<BridgeRuntimeFeishuP2pPollState>): BridgeRuntimeAudit {
  return patchBridgeRuntimeAudit({
    feishuP2pPoll: {
      updatedAt: nowIso(),
      ...patch,
    },
  });
}
