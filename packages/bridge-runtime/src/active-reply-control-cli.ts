import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  ACTIVE_REPLY_CONTROL_PROTOCOL,
  getActiveReplyControlDirectories,
  type ActiveReplyControlRequest,
  type ActiveReplyControlResponse,
} from './active-reply-control.js';

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function waitForResponse(filePath: string, timeoutMs: number): Promise<ActiveReplyControlResponse> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const result = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ActiveReplyControlResponse;
      try { fs.unlinkSync(filePath); } catch { /* best effort */ }
      return result;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('Bridge 未在限定时间内响应终止请求，请确认 Bridge 仍在线。');
}

async function main(): Promise<void> {
  const [command, workflowRunId] = process.argv.slice(2).filter((arg) => arg !== '--json');
  if (command !== 'cancel' || !workflowRunId || !/^[A-Za-z0-9._:-]{1,180}$/u.test(workflowRunId)) {
    throw new Error('用法：active-reply-control-cli.mjs cancel <workflowRunId> --json');
  }
  const dirs = getActiveReplyControlDirectories();
  fs.mkdirSync(dirs.requests, { recursive: true });
  fs.mkdirSync(dirs.responses, { recursive: true });
  const requestId = crypto.randomUUID();
  const request: ActiveReplyControlRequest = {
    protocol: ACTIVE_REPLY_CONTROL_PROTOCOL,
    requestId,
    action: 'cancel_reply',
    workflowRunId,
    requestedAt: new Date().toISOString(),
  };
  const targetPath = path.join(dirs.requests, `${requestId}.json`);
  const tempPath = `${targetPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(request)}\n`, 'utf8');
  fs.renameSync(tempPath, targetPath);
  const result = await waitForResponse(path.join(dirs.responses, `${requestId}.json`), 12_000);
  print(result);
  if (!result.ok) process.exitCode = 2;
}

main().catch((error) => {
  print({
    protocol: ACTIVE_REPLY_CONTROL_PROTOCOL,
    ok: false,
    disposition: 'bridge_unavailable',
    detail: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
