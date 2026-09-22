import type {
  FeishuCloudDocumentHost,
  FeishuCloudLinkResolveResult,
  StreamChatParams,
  TurnStorageHost,
} from 'claude-to-im/host';
import type { WorkflowRun } from './workflow-status.js';

export type WorkflowRetryExecutionPreparation =
  | { status: 'ready'; params: StreamChatParams }
  | { status: 'blocked'; text: string; feishuCardJson?: string };

export async function prepareWorkflowRetryExecution(options: {
  run: WorkflowRun;
  cloudDocuments?: FeishuCloudDocumentHost;
  turnStorage?: TurnStorageHost;
}): Promise<WorkflowRetryExecutionPreparation> {
  const input = options.run.recovery?.input;
  if (!input?.prompt) {
    return { status: 'blocked', text: '缺少可重试输入' };
  }

  if (!input.turnId || !input.executionRequirement) {
    return { status: 'blocked', text: '缺少原始 turnId 或执行要求，不能在丢失证据门禁的情况下重试。' };
  }
  let files: StreamChatParams['files'];
  const refs = input.inputEvidenceRefs || [];
  if (refs.length > 0) {
    if (!options.turnStorage?.restoreRecoveryInputEvidence) {
      return { status: 'blocked', text: '受管输入证据恢复能力不可用，未执行重试。' };
    }
    try {
      files = options.turnStorage.restoreRecoveryInputEvidence({
        sessionId: options.run.sessionId,
        turnId: input.turnId,
        refs,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      return { status: 'blocked', text: `受管输入证据已缺失、过期或校验失败（${code}），未执行重试。` };
    }
  } else if (input.executionRequirement.kind === 'input_evidence_required') {
    return { status: 'blocked', text: '原始请求依赖附件或输入证据，但恢复记录为空，未执行裸重试。' };
  }

  const params: StreamChatParams = {
    prompt: input.prompt,
    sessionId: options.run.sessionId,
    turnId: input.turnId,
    forceFreshThread: true,
    model: input.model,
    systemPrompt: input.systemPrompt,
    workingDirectory: input.workingDirectory,
    additionalDirectories: input.additionalDirectories,
    permissionMode: input.permissionMode,
    executionRequirement: input.executionRequirement,
    noEvidenceRetryAttempted: input.noEvidenceRetryAttempted,
    files,
    sourceUserId: input.userId,
    sourceUserDisplayName: input.userDisplayName,
    sourceMessageId: input.messageId,
    sourceChannelType: input.channelType || options.run.channelType,
    sourceChatId: input.chatId || options.run.chatId,
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
