export interface FeishuLightContextMessage {
  message_id: string;
  create_time: string;
  deleted?: boolean;
  msg_type: string;
  sender?: {
    id?: string;
    sender_type?: string;
  };
}

export interface SelectFeishuLightContextItemsOptions<TMessage extends FeishuLightContextMessage> {
  recentMessages: TMessage[];
  repliedMessage: TMessage | null;
  currentMessageId: string;
  currentMessageTimestamp?: number;
  limit: number;
  isShortReplyCommand: boolean;
  includeBotMessages: boolean;
  extractText: (item: TMessage) => string;
  isFromSelf: (sender: TMessage['sender']) => boolean;
}

export interface SelectFeishuLightContextItemsResult<TMessage extends FeishuLightContextMessage> {
  items: TMessage[];
  likelyContextMessageId: string;
}

function isSelectableHistoryItem<TMessage extends FeishuLightContextMessage>(
  item: TMessage,
  options: Pick<
    SelectFeishuLightContextItemsOptions<TMessage>,
    'currentMessageId' | 'includeBotMessages' | 'extractText' | 'isFromSelf'
  >,
): boolean {
  if (!item || item.deleted) return false;
  if (item.message_id === options.currentMessageId) return false;
  if (item.msg_type === 'system') return false;
  if (!options.includeBotMessages && options.isFromSelf(item.sender)) return false;
  return Boolean(options.extractText(item));
}

function findLikelyLightContextAnchor<TMessage extends FeishuLightContextMessage>(
  items: TMessage[],
  extractText: (item: TMessage) => string,
): TMessage | null {
  let best: { item: TMessage; score: number; time: number } | null = null;
  for (const item of items) {
    const text = extractText(item);
    if (!text || /^\[[^\]]+\]$/u.test(text)) continue;
    let score = 0;
    if (/[?？]/u.test(text)) score += 4;
    if (/(?:吗|么|嘛|是不是|是否|怎么|咋|如何|哪个|哪种|还是|能不能|可不可以|有没有|什么|啥|why|how|which|\bor\b)/iu.test(text)) score += 3;
    if (text.length >= 8) score += 1;
    if (/^(?:好|嗯|哦|行|可以|收到|哈哈|哈|ok|yes|no|[？?。.!！]+)$/iu.test(text.trim())) score -= 3;
    const time = Number.parseInt(item.create_time, 10) || 0;
    if (!best || score > best.score || (score === best.score && time > best.time)) {
      best = { item, score, time };
    }
  }
  return best && best.score > 0 ? best.item : null;
}

/**
 * 为短接话选择同群 light context，统一处理当前消息时间边界和 reply/nearby 优先级。
 * 平台正文解析和机器人身份判断由 adapter 注入，避免纯模块依赖凭据或运行态。
 */
export function selectFeishuLightContextItems<TMessage extends FeishuLightContextMessage>(
  options: SelectFeishuLightContextItemsOptions<TMessage>,
): SelectFeishuLightContextItemsResult<TMessage> {
  const {
    recentMessages,
    repliedMessage,
    currentMessageTimestamp,
    limit,
    isShortReplyCommand,
    extractText,
  } = options;
  const selected = new Map<string, TMessage>();
  const selectionLimit = !repliedMessage && isShortReplyCommand
    ? Math.max(limit + 8, 12)
    : limit + (repliedMessage ? 1 : 0);

  if (repliedMessage && !repliedMessage.deleted && repliedMessage.msg_type !== 'system') {
    selected.set(repliedMessage.message_id, repliedMessage);
  }

  for (const item of recentMessages) {
    if (selected.size >= selectionLimit) break;
    const itemTimestamp = Number.parseInt(item.create_time, 10);
    if (
      Number.isFinite(currentMessageTimestamp)
      && Number.isFinite(itemTimestamp)
      && itemTimestamp > (currentMessageTimestamp as number)
    ) continue;
    if (!isSelectableHistoryItem(item, options)) continue;
    selected.set(item.message_id, item);
  }

  const finalLimit = Math.max(
    limit,
    repliedMessage
      ? limit + 1
      : isShortReplyCommand
        ? Math.min(selectionLimit, limit + 4)
        : limit,
  );
  const items = [...selected.values()]
    .filter((item) => extractText(item))
    .sort((a, b) => (Number.parseInt(a.create_time, 10) || 0) - (Number.parseInt(b.create_time, 10) || 0))
    .slice(-finalLimit);
  const likelyContextMessageId = !repliedMessage && isShortReplyCommand
    ? findLikelyLightContextAnchor(items, extractText)?.message_id || ''
    : '';

  return { items, likelyContextMessageId };
}
