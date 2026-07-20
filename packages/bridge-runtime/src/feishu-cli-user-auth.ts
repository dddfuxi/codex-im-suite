import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  FeishuCliUserAuthBeginInput,
  FeishuCliUserAuthBeginResult,
  FeishuCliUserAuthHost,
  FeishuOAuthManualResumeRequest,
} from 'claude-to-im/host';

const execFileAsync = promisify(execFile);

export interface FeishuCliDeviceAuthorizationResult {
  ok: boolean;
  reason?: 'expired' | 'denied' | 'failed';
}

export interface FeishuCliDeviceAuthorizationRunner {
  waitForAuthorization(input: {
    deviceCode: string;
    expiresInSeconds: number;
  }): Promise<FeishuCliDeviceAuthorizationResult>;
}

export interface FeishuCliUserAuthNotification extends FeishuOAuthManualResumeRequest {
  text: string;
  feishuCardJson?: string;
}

export interface FeishuCliUserAuthHostOptions {
  runner: FeishuCliDeviceAuthorizationRunner;
  onResume(resume: FeishuOAuthManualResumeRequest): Promise<void>;
  onNotify(notification: FeishuCliUserAuthNotification): Promise<void>;
}

interface PendingAuthorization {
  authorizationRequestId: string;
  requests: FeishuOAuthManualResumeRequest[];
  deviceCode: string;
  expiresInSeconds: number;
}

function normalizeScopes(scopes: Iterable<string>): string[] {
  return Array.from(new Set(
    Array.from(scopes)
      .map((scope) => scope.trim())
      .filter((scope) => /^[a-z0-9_.-]+:[a-z0-9_.:-]+$/i.test(scope)),
  )).sort();
}

function buildAuthorizationKey(userId: string, scopes: Iterable<string>): string {
  return `${userId.trim()}|${normalizeScopes(scopes).join(',')}`;
}

function isValidChallenge(input: FeishuCliUserAuthBeginInput): boolean {
  if (input.challenge.protocol !== 'cti-feishu-cli-user-auth/v1') return false;
  if (!input.userId?.trim()) return false;
  if (!/^[A-Za-z0-9._~-]{16,2048}$/.test(input.challenge.deviceCode)) return false;
  if (normalizeScopes(input.challenge.requestedScopes).length === 0) return false;
  if (!Number.isFinite(input.challenge.expiresInSeconds) || input.challenge.expiresInSeconds <= 0) return false;
  try {
    const url = new URL(input.challenge.verificationUrl);
    return url.protocol === 'https:'
      && ['accounts.feishu.cn', 'accounts.larksuite.com', 'accounts.larkoffice.com'].includes(url.hostname.toLowerCase())
      && url.pathname === '/oauth/v1/device/verify';
  } catch {
    return false;
  }
}

function toResumeRequest(input: FeishuCliUserAuthBeginInput): FeishuOAuthManualResumeRequest {
  return {
    text: input.text,
    channelType: input.channelType,
    chatId: input.chatId,
    userId: input.userId,
    userDisplayName: input.userDisplayName,
    messageId: input.messageId,
  };
}

function appendUniqueRequest(
  requests: FeishuOAuthManualResumeRequest[],
  incoming: FeishuOAuthManualResumeRequest,
): void {
  const duplicate = requests.some((request) =>
    request.channelType === incoming.channelType
    && request.chatId === incoming.chatId
    && request.messageId === incoming.messageId
  );
  if (!duplicate) requests.push(incoming);
}

function buildAuthorizationCard(input: FeishuCliUserAuthBeginInput): string {
  const scopes = normalizeScopes(input.challenge.requestedScopes);
  const expiresInMinutes = Math.max(1, Math.ceil(input.challenge.expiresInSeconds / 60));
  return JSON.stringify({
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: '需要飞书用户授权' },
      style: {
        color: {
          'cus-muted': {
            light_mode: 'rgba(100,106,115,1)',
            dark_mode: 'rgba(150,155,163,1)',
          },
        },
      },
    },
    header: {
      title: { tag: 'plain_text', content: '需要飞书用户授权' },
      subtitle: { tag: 'plain_text', content: '本机共享 lark-cli 用户身份' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'approve_colorful' },
      text_tag_list: [
        { tag: 'text_tag', text: { tag: 'plain_text', content: 'Owner 授权' }, color: 'blue' },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: '**需要访问你的飞书私有资源**\n完成授权后，机器人会自动恢复刚才的任务，无需再回复“好了”。',
        },
        {
          tag: 'markdown',
          text_size: 'notation',
          content: `<font color='grey'>本次最小权限：${scopes.join('、')}\n授权链接约 ${expiresInMinutes} 分钟内有效。</font>`,
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '打开飞书授权页' },
          type: 'primary_filled',
          width: 'fill',
          behaviors: [
            {
              type: 'open_url',
              default_url: input.challenge.verificationUrl,
              pc_url: input.challenge.verificationUrl,
              ios_url: input.challenge.verificationUrl,
              android_url: input.challenge.verificationUrl,
            },
          ],
        },
      ],
    },
  });
}

function buildFailureText(reason: FeishuCliDeviceAuthorizationResult['reason']): string {
  if (reason === 'expired') return '未完成：飞书用户授权已过期，请重新发送原任务以生成新的授权卡。';
  if (reason === 'denied') return '未完成：飞书用户授权未通过，原任务没有继续执行。';
  return '未完成：飞书用户授权没有成功，原任务没有继续执行。请稍后重新发送原任务。';
}

function buildFailureCard(text: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default', summary: { content: '飞书授权未完成' } },
    header: {
      title: { tag: 'plain_text', content: '飞书授权未完成' },
      template: 'red',
      icon: { tag: 'standard_icon', token: 'warning_colorful' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      elements: [{ tag: 'markdown', content: text }],
    },
  });
}

class FeishuCliUserAuthBroker implements FeishuCliUserAuthHost {
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(private readonly options: FeishuCliUserAuthHostOptions) {}

  async beginAuthorization(input: FeishuCliUserAuthBeginInput): Promise<FeishuCliUserAuthBeginResult> {
    if (!isValidChallenge(input)) {
      return {
        status: 'error',
        userMessage: '未完成：飞书 CLI 返回的授权证据无效，已拒绝发起授权。',
      };
    }

    const key = buildAuthorizationKey(input.userId || '', input.challenge.requestedScopes);
    const request = toResumeRequest(input);
    const existing = this.pending.get(key);
    if (existing) {
      appendUniqueRequest(existing.requests, request);
      return {
        status: 'reused',
        userMessage: '已合并到现有飞书授权请求。完成上一张授权卡后，我会自动继续这项任务。',
        authorizationRequestId: existing.authorizationRequestId,
      };
    }

    const pending: PendingAuthorization = {
      authorizationRequestId: crypto.randomUUID(),
      requests: [request],
      deviceCode: input.challenge.deviceCode,
      expiresInSeconds: input.challenge.expiresInSeconds,
    };
    this.pending.set(key, pending);
    void this.completeAuthorization(key, pending);
    return {
      status: 'started',
      userMessage: '需要你的飞书用户授权。点击卡片按钮完成授权后，我会自动继续原任务。',
      feishuCardJson: buildAuthorizationCard(input),
      authorizationRequestId: pending.authorizationRequestId,
    };
  }

  private async completeAuthorization(key: string, pending: PendingAuthorization): Promise<void> {
    let result: FeishuCliDeviceAuthorizationResult;
    try {
      result = await this.options.runner.waitForAuthorization({
        deviceCode: pending.deviceCode,
        expiresInSeconds: pending.expiresInSeconds,
      });
    } catch {
      result = { ok: false, reason: 'failed' };
    }

    if (this.pending.get(key) !== pending) return;
    this.pending.delete(key);
    if (result.ok) {
      for (const request of pending.requests) {
        try {
          await this.options.onResume(request);
        } catch {
          const text = '未完成：飞书授权已成功，但恢复原任务时发生错误，请重新发送原任务。';
          await this.options.onNotify({ ...request, text, feishuCardJson: buildFailureCard(text) });
        }
      }
      return;
    }

    const text = buildFailureText(result.reason);
    const feishuCardJson = buildFailureCard(text);
    for (const request of pending.requests) {
      await this.options.onNotify({ ...request, text, feishuCardJson });
    }
  }
}

export function createFeishuCliUserAuthHost(options: FeishuCliUserAuthHostOptions): FeishuCliUserAuthHost {
  return new FeishuCliUserAuthBroker(options);
}

function resolveLarkCliInvocation(): { file: string; argsPrefix: string[] } {
  if (process.platform === 'win32' && process.env.APPDATA) {
    const scriptPath = path.join(process.env.APPDATA, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
    if (fs.existsSync(scriptPath)) return { file: process.execPath, argsPrefix: [scriptPath] };
  }
  return { file: 'lark-cli', argsPrefix: [] };
}

export function createLarkCliDeviceAuthorizationRunner(): FeishuCliDeviceAuthorizationRunner {
  return {
    waitForAuthorization: async ({ deviceCode, expiresInSeconds }) => {
      const invocation = resolveLarkCliInvocation();
      try {
        await execFileAsync(
          invocation.file,
          [...invocation.argsPrefix, 'auth', 'login', '--device-code', deviceCode],
          {
            windowsHide: true,
            timeout: Math.max(30_000, Math.min(3_615_000, expiresInSeconds * 1_000 + 15_000)),
            maxBuffer: 512 * 1024,
            env: {
              ...process.env,
              LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
              LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
            },
          },
        );
        return { ok: true };
      } catch (error) {
        const combined = [
          error instanceof Error ? error.message : '',
          typeof (error as { stdout?: unknown })?.stdout === 'string' ? (error as { stdout: string }).stdout : '',
          typeof (error as { stderr?: unknown })?.stderr === 'string' ? (error as { stderr: string }).stderr : '',
        ].join(' ').toLowerCase();
        if (/expired|timeout|timed out|过期/.test(combined)) return { ok: false, reason: 'expired' };
        if (/denied|declined|cancel|拒绝|取消/.test(combined)) return { ok: false, reason: 'denied' };
        return { ok: false, reason: 'failed' };
      }
    },
  };
}
