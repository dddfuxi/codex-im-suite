export interface FeishuHistoryAttachmentRecoveryInput {
  messageId: string;
  messageType: string;
  fileKey?: string;
  imageKeys?: string[];
  fileKeys?: string[];
}

export interface FeishuHistoryAttachmentRecoveryRequest {
  messageId: string;
  fileKey: string;
  resourceType: 'image' | 'file' | 'audio' | 'video' | 'media';
}

/**
 * 把已解析的飞书历史消息资源转换为确定性的下载计划。
 *
 * 这里只裁决“下载哪个 message_id/file_key 以及资源类型”；平台鉴权、
 * SDK/HTTP fallback、大小限制、失败审计和最终附件注入仍由 adapter 负责。
 */
export function buildFeishuHistoryAttachmentRecoveryPlan(
  input: FeishuHistoryAttachmentRecoveryInput,
): FeishuHistoryAttachmentRecoveryRequest[] {
  const messageId = input.messageId.trim();
  const messageType = input.messageType.trim().toLowerCase();
  if (!messageId) return [];

  const requests: FeishuHistoryAttachmentRecoveryRequest[] = [];
  const seenKeys = new Set<string>();
  const add = (
    rawKey: string | undefined,
    resourceType: FeishuHistoryAttachmentRecoveryRequest['resourceType'],
  ) => {
    const fileKey = rawKey?.trim() || '';
    if (!fileKey || seenKeys.has(fileKey)) return;
    seenKeys.add(fileKey);
    requests.push({ messageId, fileKey, resourceType });
  };

  if (messageType === 'image' || messageType === 'sticker') {
    add(input.fileKey, 'image');
    return requests;
  }

  if (messageType === 'file') {
    add(input.fileKey, 'file');
    return requests;
  }

  if (messageType === 'audio' || messageType === 'video' || messageType === 'media') {
    add(input.fileKey, messageType);
    return requests;
  }

  if (messageType === 'post') {
    input.imageKeys?.forEach((key) => add(key, 'image'));
    return requests;
  }

  if (messageType === 'interactive') {
    input.imageKeys?.forEach((key) => add(key, 'image'));
    input.fileKeys?.forEach((key) => add(key, 'file'));
  }

  return requests;
}
