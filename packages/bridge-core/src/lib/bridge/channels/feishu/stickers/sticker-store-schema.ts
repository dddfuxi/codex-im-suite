export interface FeishuStickerUserAnnotation {
  label?: string;
  description?: string;
  intent?: string;
  tone?: string;
  usage?: string;
  avoidWhen?: string;
  aliases?: string[];
  examples?: string[];
  annotationConfidence?: number;
  learnedFromMessageId?: string;
  userId?: string;
  updatedAt?: string;
}

export interface FeishuStickerRecord {
  fileKey: string;
  aliases: string[];
  label?: string;
  description?: string;
  intent?: string;
  tone?: string;
  usage?: string;
  avoidWhen?: string;
  examples?: string[];
  annotationConfidence?: number;
  annotationSource?: 'vision' | 'manual' | 'user';
  /** 视觉语义实际分析过的媒体 key；必须与 fileKey 一致才可被信任。 */
  visionMediaFileKey?: string;
  annotationVerifiedAt?: string;
  annotationUpdatedAt?: string;
  userAnnotation?: FeishuStickerUserAnnotation;
  learnedFromMessageId?: string;
  disabled?: boolean;
  disabledReason?: string;
  lastEditedAt?: string;
  archived?: boolean;
  archivedAt?: string;
  chatId?: string;
  userId?: string;
  messageId?: string;
  mediaCachedAt?: string;
  mediaMimeType?: string;
  mediaSize?: number;
  mediaDownloadFailedAt?: string;
  mediaDownloadError?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastUsedAt?: string;
  useCount: number;
}

export interface FeishuStickerTombstone {
  deletedAt: string;
  source?: string;
}

export interface FeishuStickerHistoryBackfillRecord {
  chatId: string;
  latestMessageTime?: string;
  completedAt: string;
  candidateCount: number;
}

export interface FeishuStickerStore {
  version: 1;
  updatedAt: string;
  stickers: FeishuStickerRecord[];
  deletedStickers?: Record<string, FeishuStickerTombstone>;
  historyBackfills?: Record<string, FeishuStickerHistoryBackfillRecord>;
}

const STICKER_TEXT_LIMITS = {
  label: 32,
  description: 180,
  intent: 160,
  tone: 80,
  usage: 180,
  avoidWhen: 180,
  disabledReason: 180,
} as const;

export function createEmptyFeishuStickerStore(): FeishuStickerStore {
  return { version: 1, updatedAt: '', stickers: [], deletedStickers: {}, historyBackfills: {} };
}

export function isUnsafeFeishuStickerSemanticText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  // cti-encoding-allow-start
  return /\uFFFD|�|\?{3,}|锟|Ã|Â|鈥|鐚|鐤|琛ㄦ儏|鎰忔|鍚嶇О|璇皵/u.test(text);
  // cti-encoding-allow-end
}

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!text || text.length > maxLength || isUnsafeFeishuStickerSemanticText(text)) return undefined;
  return text;
}

function cleanList(values: unknown, maxItems: number, maxLength: number): string[] {
  return (Array.isArray(values) ? values : [])
    .map((item) => cleanText(item, maxLength))
    .filter((item): item is string => Boolean(item))
    .slice(0, maxItems);
}

function sanitizeUserAnnotation(value: unknown): FeishuStickerUserAnnotation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Partial<FeishuStickerUserAnnotation>;
  const annotation: FeishuStickerUserAnnotation = {};
  const label = cleanText(source.label, STICKER_TEXT_LIMITS.label);
  const description = cleanText(source.description, STICKER_TEXT_LIMITS.description);
  const intent = cleanText(source.intent, STICKER_TEXT_LIMITS.intent);
  const tone = cleanText(source.tone, STICKER_TEXT_LIMITS.tone);
  const usage = cleanText(source.usage, STICKER_TEXT_LIMITS.usage);
  const avoidWhen = cleanText(source.avoidWhen, STICKER_TEXT_LIMITS.avoidWhen);
  const aliases = cleanList(source.aliases, 20, 32);
  const examples = cleanList(source.examples, 8, 120);
  if (label) annotation.label = label;
  if (description) annotation.description = description;
  if (intent) annotation.intent = intent;
  if (tone) annotation.tone = tone;
  if (usage) annotation.usage = usage;
  if (avoidWhen) annotation.avoidWhen = avoidWhen;
  if (aliases.length > 0) annotation.aliases = aliases;
  if (examples.length > 0) annotation.examples = examples;
  if (Number.isFinite(Number(source.annotationConfidence))) {
    annotation.annotationConfidence = Math.max(0, Math.min(1, Number(source.annotationConfidence)));
  }
  if (source.learnedFromMessageId) annotation.learnedFromMessageId = String(source.learnedFromMessageId);
  if (source.userId) annotation.userId = String(source.userId);
  if (source.updatedAt) annotation.updatedAt = String(source.updatedAt);
  return Object.keys(annotation).length > 0 ? annotation : undefined;
}

export function sanitizeFeishuStickerRecord(record: FeishuStickerRecord): FeishuStickerRecord {
  const cleaned: FeishuStickerRecord = {
    ...record,
    fileKey: String(record.fileKey || '').trim(),
  };
  for (const [key, maxLength] of Object.entries(STICKER_TEXT_LIMITS) as Array<[
    keyof typeof STICKER_TEXT_LIMITS,
    number,
  ]>) {
    const value = cleanText(cleaned[key], maxLength);
    if (value) cleaned[key] = value;
    else delete cleaned[key];
  }
  cleaned.annotationSource = ['vision', 'manual', 'user'].includes(String(cleaned.annotationSource))
    ? cleaned.annotationSource
    : undefined;
  // 旧视觉记录如果无法证明“目标记录 = 实际分析媒体”，必须降级，避免串图语义参与自动发送。
  if (cleaned.annotationSource === 'vision' && cleaned.visionMediaFileKey !== cleaned.fileKey) {
    cleaned.annotationSource = undefined;
    delete cleaned.label;
    delete cleaned.description;
    delete cleaned.intent;
    delete cleaned.tone;
    delete cleaned.usage;
    delete cleaned.avoidWhen;
    delete cleaned.annotationConfidence;
    delete cleaned.annotationVerifiedAt;
  }
  cleaned.disabled = cleaned.disabled === true;
  cleaned.archived = cleaned.archived === true;
  if (!cleaned.archived) delete cleaned.archivedAt;
  cleaned.annotationConfidence = Number.isFinite(Number(cleaned.annotationConfidence))
    ? Math.max(0, Math.min(1, Number(cleaned.annotationConfidence)))
    : undefined;
  cleaned.examples = cleanList(cleaned.examples, 8, 120);
  cleaned.aliases = cleanList(cleaned.aliases, 20, 32);

  const legacyUserTextAnnotation = !cleaned.annotationSource
    && Boolean(cleaned.learnedFromMessageId && cleaned.messageId && cleaned.learnedFromMessageId !== cleaned.messageId);
  if (legacyUserTextAnnotation) {
    const migratedUserAnnotation = sanitizeUserAnnotation({
      label: cleaned.label,
      description: cleaned.description,
      intent: cleaned.intent,
      tone: cleaned.tone,
      usage: cleaned.usage,
      avoidWhen: cleaned.avoidWhen,
      aliases: cleaned.aliases,
      examples: cleaned.examples,
      annotationConfidence: cleaned.annotationConfidence,
      learnedFromMessageId: cleaned.learnedFromMessageId,
      userId: cleaned.userId,
      updatedAt: cleaned.annotationUpdatedAt,
    });
    if (migratedUserAnnotation) cleaned.userAnnotation = migratedUserAnnotation;
    cleaned.annotationSource = 'user';
    delete cleaned.label;
    delete cleaned.description;
    delete cleaned.intent;
    delete cleaned.tone;
    delete cleaned.usage;
    delete cleaned.avoidWhen;
    delete cleaned.annotationConfidence;
    delete cleaned.annotationVerifiedAt;
  } else {
    cleaned.userAnnotation = sanitizeUserAnnotation(cleaned.userAnnotation);
  }
  return cleaned;
}

export function normalizeFeishuStickerStore(parsed: Partial<FeishuStickerStore>): FeishuStickerStore {
  const stickers = Array.isArray(parsed.stickers)
    ? parsed.stickers
      .filter((item) => item?.fileKey)
      .map((item) => sanitizeFeishuStickerRecord(item))
      .filter((item) => item.fileKey.length > 0)
    : [];
  const rawDeletedStickers = parsed.deletedStickers && typeof parsed.deletedStickers === 'object' && !Array.isArray(parsed.deletedStickers)
    ? parsed.deletedStickers
    : {};
  const deletedStickers: Record<string, FeishuStickerTombstone> = {};
  for (const [fileKey, value] of Object.entries(rawDeletedStickers)) {
    const normalizedFileKey = fileKey.trim();
    if (!normalizedFileKey || !value || typeof value !== 'object') continue;
    const tombstone = value as Partial<FeishuStickerTombstone>;
    const deletedAt = typeof tombstone.deletedAt === 'string' ? tombstone.deletedAt.trim() : '';
    if (!deletedAt) continue;
    deletedStickers[normalizedFileKey] = {
      deletedAt,
      source: typeof tombstone.source === 'string' ? tombstone.source.trim() || undefined : undefined,
    };
  }

  const rawBackfills = parsed.historyBackfills && typeof parsed.historyBackfills === 'object' && !Array.isArray(parsed.historyBackfills)
    ? parsed.historyBackfills
    : {};
  const historyBackfills: Record<string, FeishuStickerHistoryBackfillRecord> = {};
  for (const [chatId, value] of Object.entries(rawBackfills)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Partial<FeishuStickerHistoryBackfillRecord>;
    const normalizedChatId = String(record.chatId || chatId).trim();
    if (!normalizedChatId) continue;
    historyBackfills[normalizedChatId] = {
      chatId: normalizedChatId,
      latestMessageTime: typeof record.latestMessageTime === 'string' ? record.latestMessageTime : undefined,
      completedAt: typeof record.completedAt === 'string' ? record.completedAt : '',
      candidateCount: Number.isFinite(Number(record.candidateCount)) ? Number(record.candidateCount) : 0,
    };
  }

  return {
    version: 1,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    stickers,
    deletedStickers,
    historyBackfills,
  };
}
