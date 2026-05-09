import type {
  FeishuCloudDocumentHost,
  FeishuCloudLinkResolveResult,
  StreamChatParams,
} from 'claude-to-im/src/lib/bridge/host.js';
import type { WorkflowRun } from './workflow-status.js';

export type WorkflowRetryExecutionPreparation =
  | { status: 'ready'; params: StreamChatParams }
  | { status: 'blocked'; text: string; feishuCardJson?: string };

export async function prepareWorkflowRetryExecution(options: {
  run: WorkflowRun;
  cloudDocuments?: FeishuCloudDocumentHost;
}): Promise<WorkflowRetryExecutionPreparation> {
  const input = options.run.recovery?.input;
  if (!input?.prompt) {
    return { status: 'blocked', text: '缺少可重试输入' };
  }

  const params: StreamChatParams = {
    prompt: input.prompt,
    sessionId: options.run.sessionId,
    model: input.model,
    systemPrompt: input.systemPrompt,
    workingDirectory: input.workingDirectory,
    permissionMode: input.permissionMode,
    sourceUserId: input.userId,
    sourceUserDisplayName: input.userDisplayName,
    sourceMessageId: input.messageId,
  };

  const channelType = input.channelType || options.run.channelType || '';
  const chatId = input.chatId || options.run.chatId || '';
  if (channelType !== 'feishu' || !chatId || !options.cloudDocuments) {
    return { status: 'ready', params };
  }

  const resolved = await options.cloudDocuments.resolveFeishuCloudLinks({
    text: input.prompt,
    channelType,
    chatId,
    userId: input.userId,
    userDisplayName: input.userDisplayName,
    messageId: input.messageId,
  });

  if (resolved.status === 'no_links') {
    return { status: 'ready', params };
  }

  if (resolved.status === 'resolved' && resolved.systemPrompt) {
    return {
      status: 'ready',
      params: {
        ...params,
        systemPrompt: [params.systemPrompt, resolved.systemPrompt].filter(Boolean).join('\n\n'),
      },
    };
  }

  return {
    status: 'blocked',
    text: buildFeishuCloudBlockerMessage(resolved),
    feishuCardJson: resolved.feishuCardJson,
  };
}

function buildFeishuCloudBlockerMessage(result: FeishuCloudLinkResolveResult): string {
  const fallback = result.status === 'auth_required'
    ? '需要你登录飞书后，我才能安全读取这个云文档。'
    : result.status === 'permission_denied'
      ? '未完成：当前登录飞书用户也没有这个云文档权限，请让文档所有者分享给你或导出内容。'
      : '未完成：读取飞书云文档失败。';
  return result.userMessage?.trim() || result.error?.trim() || fallback;
}
