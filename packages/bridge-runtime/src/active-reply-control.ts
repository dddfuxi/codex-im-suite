import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ActiveReplyCancelRequest, ActiveReplyCancelResult } from 'claude-to-im';

import { CTI_HOME } from './config.js';
import { cancelWorkflowRun, readWorkflowStatus, type WorkflowRun } from './workflow-status.js';

export const ACTIVE_REPLY_CONTROL_PROTOCOL = 'cti-active-reply-control/v1' as const;

export interface ActiveReplyControlRequest {
  protocol: typeof ACTIVE_REPLY_CONTROL_PROTOCOL;
  requestId: string;
  action: 'cancel_reply';
  workflowRunId: string;
  requestedAt: string;
}

export interface ActiveReplyControlResponse {
  protocol: typeof ACTIVE_REPLY_CONTROL_PROTOCOL;
  requestId: string;
  workflowRunId: string;
  ok: boolean;
  disposition: 'accepted' | 'already_terminal' | 'not_found' | 'conflict' | 'invalid_request';
  workflowStatus?: WorkflowRun['status'];
  detail: string;
  respondedAt: string;
}

interface ActiveReplyControlServiceOptions {
  ctiHome?: string;
  pollMs?: number;
  now?: () => Date;
  cancelActiveReply: (request: ActiveReplyCancelRequest) => Promise<ActiveReplyCancelResult>;
}

function controlDirectories(ctiHome = process.env.CTI_HOME?.trim() || CTI_HOME) {
  const root = path.join(path.resolve(ctiHome), 'runtime', 'active-reply-control');
  return {
    root,
    requests: path.join(root, 'requests'),
    responses: path.join(root, 'responses'),
  };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function terminalStatus(status: WorkflowRun['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function response(
  request: Pick<ActiveReplyControlRequest, 'requestId' | 'workflowRunId'>,
  now: Date,
  disposition: ActiveReplyControlResponse['disposition'],
  detail: string,
  workflowStatus?: WorkflowRun['status'],
): ActiveReplyControlResponse {
  return {
    protocol: ACTIVE_REPLY_CONTROL_PROTOCOL,
    requestId: request.requestId,
    workflowRunId: request.workflowRunId,
    ok: disposition === 'accepted' || disposition === 'already_terminal',
    disposition,
    workflowStatus,
    detail,
    respondedAt: now.toISOString(),
  };
}

export async function handleActiveReplyControlRequest(
  request: ActiveReplyControlRequest,
  cancelActiveReply: ActiveReplyControlServiceOptions['cancelActiveReply'],
  now = new Date(),
): Promise<ActiveReplyControlResponse> {
  if (request.protocol !== ACTIVE_REPLY_CONTROL_PROTOCOL
    || request.action !== 'cancel_reply'
    || !request.requestId?.trim()
    || !request.workflowRunId?.trim()) {
    return response(request, now, 'invalid_request', '终止请求协议或字段无效。');
  }
  const run = readWorkflowStatus().runs.find((item) => item.id === request.workflowRunId);
  if (!run) return response(request, now, 'not_found', '未找到对应的 Workflow 回合。');
  if (terminalStatus(run.status)) {
    return response(request, now, 'already_terminal', '该回复已经结束，无需再次终止。', run.status);
  }
  if (run.status !== 'running') {
    return response(request, now, 'conflict', '该 Workflow 当前没有正在生成的回复。', run.status);
  }
  const turnId = run.recovery?.input?.turnId?.trim() || '';
  if (!turnId) {
    return response(request, now, 'conflict', 'Workflow 缺少原始 turnId，已拒绝宽松匹配。', run.status);
  }
  const cancelled = await cancelActiveReply({
    sessionId: run.sessionId,
    turnId,
    channelType: run.channelType,
    chatId: run.chatId,
  });
  if (cancelled.disposition === 'accepted' || cancelled.disposition === 'already_cancelled') {
    const updated = cancelWorkflowRun(run.id, '用户从控制面板终止了当前回复');
    return response(request, now, 'accepted', cancelled.detail, updated?.status || 'cancelled');
  }
  const latest = readWorkflowStatus().runs.find((item) => item.id === run.id);
  if (latest && terminalStatus(latest.status)) {
    return response(request, now, 'already_terminal', '回复在终止请求到达前已经结束。', latest.status);
  }
  return response(
    request,
    now,
    cancelled.disposition === 'conflict' ? 'conflict' : 'not_found',
    cancelled.detail,
    latest?.status || run.status,
  );
}

export function startActiveReplyControlService(options: ActiveReplyControlServiceOptions): { stop(): void; pollNow(): Promise<void> } {
  const dirs = controlDirectories(options.ctiHome);
  fs.mkdirSync(dirs.requests, { recursive: true });
  fs.mkdirSync(dirs.responses, { recursive: true });
  const now = options.now || (() => new Date());
  let stopped = false;
  let pumping = false;

  const pollNow = async () => {
    if (stopped || pumping) return;
    pumping = true;
    try {
      const names = fs.readdirSync(dirs.requests)
        .filter((name) => name.endsWith('.json') || name.endsWith('.processing'))
        .sort();
      for (const name of names) {
        if (stopped) break;
        const sourcePath = path.join(dirs.requests, name);
        const requestId = name.replace(/\.(?:json|processing)$/u, '');
        const processingPath = path.join(dirs.requests, `${requestId}.processing`);
        try {
          if (sourcePath !== processingPath) fs.renameSync(sourcePath, processingPath);
          const parsed = JSON.parse(fs.readFileSync(processingPath, 'utf8')) as ActiveReplyControlRequest;
          const result = await handleActiveReplyControlRequest(parsed, options.cancelActiveReply, now());
          writeJsonAtomic(path.join(dirs.responses, `${requestId}.json`), result);
        } catch (error) {
          writeJsonAtomic(path.join(dirs.responses, `${requestId}.json`), response(
            { requestId, workflowRunId: '' },
            now(),
            'invalid_request',
            error instanceof Error ? error.message : String(error),
          ));
        } finally {
          try { fs.unlinkSync(processingPath); } catch { /* best effort */ }
        }
      }
    } finally {
      pumping = false;
    }
  };

  const timer = setInterval(() => { void pollNow(); }, Math.max(50, options.pollMs ?? 200));
  timer.unref?.();
  void pollNow();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    pollNow,
  };
}

export function getActiveReplyControlDirectories(ctiHome?: string) {
  return controlDirectories(ctiHome);
}
