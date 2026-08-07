const BOT_NAME_WAKE_INVESTIGATE_RE = /(?:帮|看看|看一下|查|搜索|搜|找|总结|梳理|分析|解释|处理|排查|检查|修|改|写|生成|创建|读取|打开|截图|提醒|记录|记住|发给|转发|同步|部署|运行|测试|构建|发布|瞅|弄|搞|做)/iu;
const BOT_NAME_WAKE_CHAT_RE = /(?:你觉得|你看|怎么想|在吗|你好|哈喽|hi|hello|说说|聊聊|回复|回答|为什么|怎么|能不能|可不可以|可以|是否|是不是|吗|呢|\?|？)/iu;
const BOT_NAME_WAKE_MENTION_ACTION_RE = /(?:艾特|@|＠|mention|提到|点名|叫|喊|通知)/iu;
const BOT_NAME_WAKE_DONE_RE = /^(?:不用回|不用回复|别回|别回复|不用处理|不用管|没事|算了|好了|结束|先这样)/iu;
const BOT_NAME_WAKE_NARRATIVE_AFTER_RE = /^(?:说的|说过|讲的|讲过|提过|发的|回复的|给的|那个|这个|这些|那些|刚才|之前|上次|前面)/iu;
const BOT_NAME_WAKE_OTHER_PERSON_BEFORE_RE = /(?:问|问问|叫|喊|找|联系|通知)$/iu;
const BOT_NAME_WAKE_OTHER_PERSON_AFTER_RE = /^(?:了吗|了没|没有|没|过吗|一下|下)/iu;

export interface FeishuInboundMention {
  id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
}

export interface FeishuInboundMentionMessage {
  content?: string;
  mentions?: FeishuInboundMention[];
}

export interface FeishuBotNameWakeClassification {
  mode: 'name';
  state: 'investigate' | 'chat' | 'need_info' | 'done';
  alias: string;
  reason: 'actionable_request' | 'direct_chat' | 'mention_target_missing' | 'done_ack' | 'non_actionable';
  shouldHandle: boolean;
}

export interface FeishuNativeMentionOnlyWakeInput {
  isGroup: boolean;
  isOtherBotSender: boolean;
  messageType: string;
  nativeBotMentioned: boolean;
  hasVisibleText: boolean;
  hasAttachments: boolean;
  replyTargetMessageId?: string | null;
}

export type FeishuNativeMentionOnlyWakeResolution =
  | {
    kind: 'light_chat';
    reason: 'native_mention_only_light_chat';
    text: string;
  }
  | {
    kind: 'reply_target';
    reason: 'native_mention_only_reply';
    text: string;
  };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeFeishuBotNameAliases(rawAliases: unknown[]): string[] {
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawAliases) {
    for (const item of String(raw || '').split(/[,，;；、\n\r|]+/u)) {
      const alias = item.replace(/^@+/, '').trim();
      // 名字唤醒只接受足够具体的别名，避免单字或空配置在群里误触发。
      if (Array.from(alias).length < 2) continue;
      const key = alias.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      aliases.push(alias);
    }
  }
  return aliases.sort((a, b) => Array.from(b).length - Array.from(a).length);
}

export function isFeishuBotMentioned(
  mentions: FeishuInboundMention[] | undefined,
  botIds: ReadonlySet<string>,
): boolean {
  if (!mentions || botIds.size === 0) return false;
  return mentions.some((mention) => {
    const ids = [mention.id?.open_id, mention.id?.user_id, mention.id?.union_id]
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return ids.some((id) => botIds.has(id));
  });
}

export function extractFeishuMentionIdsFromAtMarkup(text: string): string[] {
  return Array.from(text.matchAll(/<at\b[^>]*(?:user_id|open_id|union_id|id)=["']?([^"'\s>]+)["']?[^>]*>/giu))
    .map((match) => match[1]?.trim())
    .filter((id): id is string => Boolean(id));
}

export function isFeishuBotMentionedInStructuredContent(
  value: unknown,
  botIds: ReadonlySet<string>,
): boolean {
  if (typeof value === 'string') {
    return extractFeishuMentionIdsFromAtMarkup(value).some((id) => botIds.has(id));
  }
  if (Array.isArray(value)) {
    return value.some((item) => isFeishuBotMentionedInStructuredContent(item, botIds));
  }
  if (!value || typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  const tag = typeof record.tag === 'string' ? record.tag.trim().toLowerCase() : '';
  if (tag === 'at') {
    const ids = [
      record.user_id,
      record.userId,
      record.open_id,
      record.openId,
      record.union_id,
      record.unionId,
      record.id,
    ].filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
    if (ids.some((id) => botIds.has(id.trim()))) return true;
  }

  return Object.values(record).some((child) => isFeishuBotMentionedInStructuredContent(child, botIds));
}

export function isFeishuBotMentionedFromMessage(
  message: FeishuInboundMentionMessage,
  botIds: ReadonlySet<string>,
): boolean {
  if (isFeishuBotMentioned(message.mentions, botIds)) return true;
  if (botIds.size === 0 || !message.content) return false;
  try {
    return isFeishuBotMentionedInStructuredContent(JSON.parse(message.content) as unknown, botIds);
  } catch {
    return false;
  }
}

export function stripFeishuMentionMarkers(text: string): string {
  // Feishu text/post 使用 @_user_N，占位卡片 Markdown 使用 <at ...>。
  return text
    .replace(/<at\b[^>]*>(.*?)<\/at>/giu, '$1')
    .replace(/<at\b[^>]*\/>/giu, '')
    .replace(/<at\b[^>]*>/giu, '')
    .replace(/@_user_\d+/giu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 将人类在群里只原生 @ 当前机器人的动作还原成可进入会话层的明确意图。
 * 这里只生成平台无副作用的语义输入，不直接决定最终回复；普通轻聊仍由
 * 当前已选 Provider 的轻量协调器处理，原生 reply 则继续优先处理引用目标。
 */
export function resolveFeishuNativeMentionOnlyWake(
  input: FeishuNativeMentionOnlyWakeInput,
): FeishuNativeMentionOnlyWakeResolution | null {
  if (
    !input.isGroup
    || input.isOtherBotSender
    || input.messageType !== 'text'
    || !input.nativeBotMentioned
    || input.hasVisibleText
    || input.hasAttachments
  ) {
    return null;
  }

  if (input.replyTargetMessageId?.trim()) {
    return {
      kind: 'reply_target',
      reason: 'native_mention_only_reply',
      text: '请处理我在本条飞书话题中回复或引用的消息。',
    };
  }

  return {
    kind: 'light_chat',
    reason: 'native_mention_only_light_chat',
    // 使用自然的等价轻聊输入，避免 adapter 写死最终回复或触发工具链。
    text: '在吗？',
  };
}

function normalizeWakeText(text: string): string {
  return (text || '')
    .replace(/<at\b[^>]*>.*?<\/at>/giu, ' ')
    .replace(/@_user_\d+/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findBotNameAlias(text: string, aliases: string[]): { alias: string; index: number; length: number } | null {
  for (const alias of aliases) {
    if (/^[A-Za-z0-9_.-]+$/u.test(alias)) {
      const match = new RegExp(`(^|[^A-Za-z0-9_])(${escapeRegExp(alias)})(?=$|[^A-Za-z0-9_])`, 'iu').exec(text);
      if (match) return { alias, index: match.index + match[1].length, length: match[2].length };
      continue;
    }
    const index = text.toLocaleLowerCase().indexOf(alias.toLocaleLowerCase());
    if (index >= 0) return { alias, index, length: alias.length };
  }
  return null;
}

function isDirectBotNameAddress(beforeAlias: string): boolean {
  const before = beforeAlias.trim();
  if (!before) return true;
  if (/[@＠,，:：;；。.!！?？、(（\[]$/u.test(before)) return true;
  return /(?:^|[\s,，])(?:hey|hi|hello|哈喽|你好|在吗)$/iu.test(before);
}

function isBotNameAsSubject(afterAlias: string): boolean {
  return /^(?:你|帮|能|可以|可不可以|要不要|来|看|查|搜|找|总结|分析|解释|处理|修|改|写|生成|创建|读取|打开|截图|检查|排查|回复|说|讲|评价|建议|提醒|记录|记住|艾特|@|＠|mention|提到|点名|叫|喊|问|回答|看看|弄|搞|做|发|转发|怎么|为什么|是否|是不是|吗|呢|\?|？)/iu.test(afterAlias);
}

function isBotNameWakeMissingMentionTarget(afterAlias: string): boolean {
  const remaining = afterAlias.replace(BOT_NAME_WAKE_MENTION_ACTION_RE, '').trim();
  if (!remaining) return true;
  return /^(?:一下|下|个人|别人|另一个人|某个人|谁|他|她|ta|TA|对方|那个人|一个人)/u.test(remaining);
}

function isBotNameUsedAsObject(beforeAlias: string): boolean {
  const before = beforeAlias.replace(/\s+/g, '');
  if (!before) return false;
  return /(?:让你|叫你|喊你|要你|问你|请你|你能|你可以|能不能|可不可以|帮我|帮忙|拜托你).{0,16}(?:@|＠|at|艾特|提到|点名|喷|骂|怼|叫|喊|联系|通知|找|问)$/iu.test(before);
}

function isNonActionableBotCorrection(text: string, aliases: string[]): boolean {
  const compact = text.replace(/[^\S\r\n]+/gu, '');
  if (/(?:不用|不要|别再|先别|别(?!人|的|处|家|名))[^，,。；;！!？?\r\n#|—–-]{0,8}(?:回复|处理|管|说话)/u.test(compact)) return true;
  if (/(?:搞错|搞混|误判|误会|看清(?:楚)?(?:聊天)?记录|不是让你|没让你|不是叫你|没叫你|不是问你|没问你|不是at你|不是@你|不是艾特你)/iu.test(compact)) return true;
  return aliases.some((alias) => {
    const safeAlias = escapeRegExp(alias.replace(/\s+/g, ''));
    return new RegExp(`(?:你自己(?:就)?是|你就是|你已经是)${safeAlias}`, 'iu').test(compact);
  });
}

export function classifyFeishuNativeBotMentionText(
  text: string,
  aliases: string[],
  fallbackAlias = 'bot',
): FeishuBotNameWakeClassification | null {
  const normalized = normalizeWakeText(text);
  if (!normalized || !isNonActionableBotCorrection(normalized, aliases)) return null;
  return {
    mode: 'name',
    state: 'done',
    alias: aliases[0] || fallbackAlias,
    reason: 'non_actionable',
    shouldHandle: false,
  };
}

export function classifyFeishuBotNameWake(
  text: string,
  aliases: string[],
): FeishuBotNameWakeClassification | null {
  const normalized = normalizeWakeText(text);
  if (!normalized) return null;
  const match = findBotNameAlias(normalized, aliases);
  if (!match) return null;

  const beforeAlias = normalized.slice(0, match.index);
  const afterAlias = normalized.slice(match.index + match.length);
  const beforeCompact = beforeAlias.replace(/\s+/g, '');
  const afterLead = afterAlias.replace(/^[\s,，:：;；。.!！?？、]+/u, '').trim();
  const directAddress = isDirectBotNameAddress(beforeAlias);
  const nameAsSubject = isBotNameAsSubject(afterLead);
  const done = (reason: FeishuBotNameWakeClassification['reason']): FeishuBotNameWakeClassification => ({
    mode: 'name', state: 'done', alias: match.alias, reason, shouldHandle: false,
  });

  if (isBotNameUsedAsObject(beforeCompact) || isNonActionableBotCorrection(normalized, [match.alias])) {
    return done('non_actionable');
  }
  if (BOT_NAME_WAKE_DONE_RE.test(afterLead) && (directAddress || nameAsSubject)) return done('done_ack');

  const thirdPersonReference = (!directAddress && BOT_NAME_WAKE_NARRATIVE_AFTER_RE.test(afterLead))
    || (BOT_NAME_WAKE_OTHER_PERSON_BEFORE_RE.test(beforeCompact) && BOT_NAME_WAKE_OTHER_PERSON_AFTER_RE.test(afterLead));
  if (thirdPersonReference || (!directAddress && !nameAsSubject)) return done('non_actionable');

  const directedText = directAddress ? `${afterLead} ${normalized}` : afterLead;
  if (BOT_NAME_WAKE_MENTION_ACTION_RE.test(directedText) && isBotNameWakeMissingMentionTarget(afterLead)) {
    return { mode: 'name', state: 'need_info', alias: match.alias, reason: 'mention_target_missing', shouldHandle: true };
  }
  if (BOT_NAME_WAKE_INVESTIGATE_RE.test(directedText)) {
    return { mode: 'name', state: 'investigate', alias: match.alias, reason: 'actionable_request', shouldHandle: true };
  }
  if (BOT_NAME_WAKE_CHAT_RE.test(directedText) || directAddress) {
    return { mode: 'name', state: 'chat', alias: match.alias, reason: 'direct_chat', shouldHandle: true };
  }
  return done('non_actionable');
}
