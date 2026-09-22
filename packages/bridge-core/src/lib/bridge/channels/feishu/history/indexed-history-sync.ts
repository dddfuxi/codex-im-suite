export interface FeishuIndexedHistoryMessage {
  message_id: string;
  chat_id: string;
  create_time: string;
  deleted?: boolean;
  msg_type: string;
  body?: { content?: string };
  sender?: {
    id?: string;
    sender_type?: string;
  };
}

interface FeishuIndexedHistoryStore {
  upsertFeishuHistoryMessages?: (data: {
    chatId: string;
    displayName?: string;
    chatType?: string;
    messages: Array<{
      messageId: string;
      chatId: string;
      createTime: string;
      msgType: string;
      senderId?: string;
      senderType?: string;
      senderName?: string;
      text: string;
    }>;
    syncedAt?: string;
  }) => unknown;
  getFeishuHistorySyncStatus?: (chatId?: string) => Array<{ latestMessageTime?: string }>;
}

export interface SyncFeishuIndexedHistoryOptions<TMessage extends FeishuIndexedHistoryMessage> {
  chatId: string;
  chatType: string;
  displayName: string;
  full?: boolean;
  store: FeishuIndexedHistoryStore;
  fetchMemberNames: (chatId: string) => Promise<Map<string, string>>;
  fetchPage: (
    chatId: string,
    pageToken: string,
    pageSize: number,
  ) => Promise<{ items: TMessage[]; nextPageToken: string; hasMore: boolean }>;
  harvestStickers: (items: TMessage[], chatId: string) => Promise<unknown>;
  extractText: (item: TMessage) => string;
  now?: () => Date;
}

export interface SyncFeishuIndexedHistoryResult {
  skipped: boolean;
  collectedCount: number;
  preparedCount: number;
}

/**
 * 把飞书平台分页读取与本地历史索引写入编排收口在一个可复用边界中。
 * 平台鉴权、消息正文解析和表情包持久化继续由 adapter 注入，避免本模块反向依赖平台运行时。
 */
export async function syncFeishuIndexedHistory<TMessage extends FeishuIndexedHistoryMessage>(
  options: SyncFeishuIndexedHistoryOptions<TMessage>,
): Promise<SyncFeishuIndexedHistoryResult> {
  const {
    chatId,
    chatType,
    displayName,
    full = false,
    store,
    fetchMemberNames,
    fetchPage,
    harvestStickers,
    extractText,
    now = () => new Date(),
  } = options;

  if (!store.upsertFeishuHistoryMessages) {
    return { skipped: true, collectedCount: 0, preparedCount: 0 };
  }

  const latestKnownTime = full
    ? 0
    : Number.parseInt(store.getFeishuHistorySyncStatus?.(chatId)?.[0]?.latestMessageTime || '0', 10) || 0;
  const memberNames = await fetchMemberNames(chatId);
  const collected: TMessage[] = [];
  let pageToken = '';

  while (true) {
    const { items, nextPageToken, hasMore } = await fetchPage(chatId, pageToken, 50);
    if (items.length === 0) break;
    collected.push(...items);

    if (!full) {
      const pageHasNewer = items.some(
        (item) => (Number.parseInt(item.create_time, 10) || 0) > latestKnownTime,
      );
      if (!pageHasNewer) break;
    }

    if (!hasMore || !nextPageToken) break;
    pageToken = nextPageToken;
  }

  await harvestStickers(collected, chatId);

  const prepared = collected
    .filter((item) => !item.deleted)
    .filter((item) => item.msg_type !== 'system')
    .map((item) => {
      const senderId = item.sender?.id?.trim() || '';
      const senderName = senderId ? memberNames.get(senderId)?.trim() || '' : '';
      return {
        messageId: item.message_id,
        chatId,
        createTime: item.create_time,
        msgType: item.msg_type,
        senderId,
        senderType: item.sender?.sender_type,
        senderName,
        text: extractText(item),
      };
    })
    .filter((item) => item.text);

  if (prepared.length === 0 && !full) {
    return { skipped: false, collectedCount: collected.length, preparedCount: 0 };
  }

  store.upsertFeishuHistoryMessages({
    chatId,
    displayName,
    chatType,
    messages: prepared,
    syncedAt: now().toISOString(),
  });

  return {
    skipped: false,
    collectedCount: collected.length,
    preparedCount: prepared.length,
  };
}
