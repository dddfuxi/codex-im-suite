import {
  isUnsafeFeishuStickerSemanticText,
  type FeishuStickerRecord,
  type FeishuStickerStore,
  type FeishuStickerUserAnnotation,
} from './sticker-store-schema.js';
import {
  compactFeishuStickerStoreRecords,
  hasFeishuStickerAnnotation,
  isFeishuStickerActive,
  isFeishuStickerDeleted,
} from './sticker-selection-policy.js';

export interface FeishuStickerAnnotationInput {
  fileKey: string;
  chatId: string;
  userId?: string;
  learnedFromMessageId?: string;
  label?: string;
  description?: string;
  intent?: string;
  tone?: string;
  usage?: string;
  avoidWhen?: string;
  aliases?: string[];
  examples?: string[];
  annotationConfidence?: number;
  source?: 'vision' | 'user' | 'manual';
  visionMediaFileKey?: string;
}

export interface FeishuStickerEvolutionOptions {
  nowIso: string;
  hasCachedMedia?: (fileKey: string) => boolean;
  maxRecords?: number;
}

export interface FeishuStickerEvolutionResult {
  accepted: boolean;
  reason?: 'invalid_file_key' | 'empty_semantics' | 'deleted' | 'archived' | 'vision_media_mismatch';
  store: FeishuStickerStore;
  record?: FeishuStickerRecord;
}

export interface FeishuStickerUserAnnotationTargetInput {
  chatId: string;
  replyToMessageId?: string | null;
  text: string;
  nowMs: number;
  freshnessMs?: number;
}

function cloneRecord(record: FeishuStickerRecord): FeishuStickerRecord {
  const cloned: FeishuStickerRecord = {
    ...record,
    aliases: [...(record.aliases || [])],
  };
  if (record.examples) cloned.examples = [...record.examples];
  if (record.userAnnotation) {
    cloned.userAnnotation = {
      ...record.userAnnotation,
    };
    if (record.userAnnotation.aliases) cloned.userAnnotation.aliases = [...record.userAnnotation.aliases];
    if (record.userAnnotation.examples) cloned.userAnnotation.examples = [...record.userAnnotation.examples];
  }
  return cloned;
}

function cloneStore(store: FeishuStickerStore): FeishuStickerStore {
  const cloned: FeishuStickerStore = {
    ...store,
    stickers: store.stickers.map(cloneRecord),
  };
  if (store.deletedStickers) cloned.deletedStickers = { ...store.deletedStickers };
  if (store.historyBackfills) cloned.historyBackfills = { ...store.historyBackfills };
  return cloned;
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

function sanitizeAnnotation(input: FeishuStickerAnnotationInput) {
  return {
    label: cleanText(input.label, 32),
    description: cleanText(input.description, 180),
    intent: cleanText(input.intent, 160),
    tone: cleanText(input.tone, 80),
    usage: cleanText(input.usage, 180),
    avoidWhen: cleanText(input.avoidWhen, 180),
    aliases: cleanList(input.aliases, 20, 32),
    examples: cleanList(input.examples, 8, 120),
    annotationConfidence: Number.isFinite(Number(input.annotationConfidence))
      ? Math.max(0, Math.min(1, Number(input.annotationConfidence)))
      : undefined,
  };
}

function hasUsableSemantics(annotation: ReturnType<typeof sanitizeAnnotation>): boolean {
  return Boolean(annotation.label || annotation.description || annotation.intent || annotation.tone || annotation.usage);
}

export function parseFeishuStickerUserAnnotation(text: string): Partial<FeishuStickerRecord> | null {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 240 || /^[/?#]/u.test(normalized) || /[?？]$/u.test(normalized)) return null;
  const labelMatch = /(?:表情包|表情|sticker|这个|刚才|上个|上一个|this|previous).{0,12}(?:叫|名称是|名字是|name|label)\s*[:：]?\s*([^，,。；;]{2,32})/iu.exec(normalized);
  const intentMatch = /(?:表示|代表|意思是|含义是|means?|meaning)\s*[:：]?\s*([^，,。；;]{2,80})/iu.exec(normalized);
  const toneMatch = /(?:语气是|tone)\s*[:：]?\s*([^，,。；;]{2,60})/iu.exec(normalized);
  const usageMatch = /(?:适合(?:在|用于)?|用于|用来|usage|use when)\s*[:：]?\s*(?:在)?([^。；;]{2,120})/iu.exec(normalized);
  if (labelMatch || intentMatch || toneMatch || usageMatch) {
    const label = labelMatch?.[1]?.trim();
    const intent = intentMatch?.[1]?.trim();
    const tone = toneMatch?.[1]?.trim();
    const usage = usageMatch?.[1]?.trim();
    const annotation: Partial<FeishuStickerRecord> = {
      description: intent || usage || label || normalized,
      intent: intent || usage || label,
      annotationConfidence: 0.82,
    };
    if (label) annotation.label = label;
    const inferredTone = tone || (usage && usage.length <= 40 ? usage : undefined);
    if (inferredTone) annotation.tone = inferredTone;
    if (usage) annotation.usage = usage;
    return annotation;
  }
  const match = normalized.match(/(?:表情包|表情|sticker).{0,12}(?:叫|名称是|名字是|是|表示|代表|意思是|含义是|语气是|用于|用来|means?|meaning|label|name)\s*[:：]?\s*(.+)$/iu)
    || normalized.match(/(?:这个|刚才|上个|上一个|this|previous).{0,12}(?:叫|名称是|名字是|表示|代表|意思是|含义是|语气是|用于|用来|means?|meaning|label|name)\s*[:：]?\s*(.+)$/iu);
  const value = match?.[1]?.trim().replace(/^["'“”‘’]+|["'“”‘’。.,，、]+$/gu, '');
  if (!value || value.length < 2) return null;
  return {
    label: value.length <= 24 ? value : undefined,
    description: value,
    intent: value,
    tone: value.length <= 40 ? value : undefined,
    annotationConfidence: 0.72,
  };
}

export function hasExplicitFeishuStickerAnnotationSubject(text: string): boolean {
  return /(?:表情包|表情|sticker)/iu.test(text.normalize('NFKC'));
}

export function resolveFeishuStickerUserAnnotationTarget(
  records: FeishuStickerRecord[],
  input: FeishuStickerUserAnnotationTargetInput,
): FeishuStickerRecord | null {
  if (input.replyToMessageId) {
    return records.find((item) => isFeishuStickerActive(item) && item.messageId === input.replyToMessageId) || null;
  }
  if (!hasExplicitFeishuStickerAnnotationSubject(input.text)) return null;
  const freshnessMs = input.freshnessMs ?? 10 * 60 * 1000;
  return records
    .filter((item) => isFeishuStickerActive(item) && item.chatId === input.chatId && !hasFeishuStickerAnnotation(item))
    .filter((item) => {
      const lastSeen = Date.parse(item.lastSeenAt || '');
      return !Number.isFinite(lastSeen) || input.nowMs - lastSeen <= freshnessMs;
    })
    .sort((a, b) => (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0))[0]
    || null;
}

function buildUserAnnotation(
  annotation: ReturnType<typeof sanitizeAnnotation>,
  input: FeishuStickerAnnotationInput,
  nowIso: string,
): FeishuStickerUserAnnotation {
  return {
    ...annotation,
    learnedFromMessageId: input.learnedFromMessageId,
    userId: input.userId,
    updatedAt: nowIso,
  };
}

export function evolveFeishuStickerAnnotation(
  currentStore: FeishuStickerStore,
  input: FeishuStickerAnnotationInput,
  options: FeishuStickerEvolutionOptions,
): FeishuStickerEvolutionResult {
  const fileKey = input.fileKey?.trim();
  const unchanged = (): FeishuStickerEvolutionResult => ({ accepted: false, store: cloneStore(currentStore) });
  if (!fileKey) return { ...unchanged(), reason: 'invalid_file_key' };
  const annotation = sanitizeAnnotation(input);
  if (!hasUsableSemantics(annotation)) return { ...unchanged(), reason: 'empty_semantics' };
  if (input.source === 'vision' && input.visionMediaFileKey?.trim() !== fileKey) {
    return { ...unchanged(), reason: 'vision_media_mismatch' };
  }

  const store = cloneStore(currentStore);
  if (isFeishuStickerDeleted(store, fileKey)) return { accepted: false, reason: 'deleted', store };
  let record = store.stickers.find((item) => item.fileKey === fileKey);
  if (record?.archived) return { accepted: false, reason: 'archived', store };
  if (!record) {
    record = {
      fileKey,
      aliases: [],
      chatId: input.chatId,
      userId: input.userId,
      messageId: input.learnedFromMessageId,
      firstSeenAt: options.nowIso,
      lastSeenAt: options.nowIso,
      useCount: 0,
    };
    store.stickers.push(record);
  }

  if (input.source === 'user') {
    record.userAnnotation = buildUserAnnotation(annotation, input, options.nowIso);
    if (!record.annotationSource || record.annotationSource === 'user') record.annotationSource = 'user';
  } else {
    const trustedSource: 'vision' | 'manual' = input.source === 'vision' ? 'vision' : 'manual';
    const existingIsManual = record.annotationSource === 'manual';
    const canReplaceExisting = trustedSource === 'manual' || !existingIsManual;
    const assign = (key: 'label' | 'description' | 'intent' | 'tone' | 'usage' | 'avoidWhen', value?: string): void => {
      if (value && (canReplaceExisting || !record?.[key])) record![key] = value;
    };
    assign('label', annotation.label);
    assign('description', annotation.description);
    assign('intent', annotation.intent);
    assign('tone', annotation.tone);
    assign('usage', annotation.usage);
    assign('avoidWhen', annotation.avoidWhen);
    record.examples = Array.from(new Set([...(record.examples || []), ...annotation.examples])).slice(0, 8);
    if (canReplaceExisting || record.annotationConfidence === undefined) {
      record.annotationConfidence = annotation.annotationConfidence ?? record.annotationConfidence;
    }
    if (!existingIsManual || trustedSource === 'manual') record.annotationSource = trustedSource;
    if (trustedSource === 'vision') record.visionMediaFileKey = fileKey;
    record.annotationVerifiedAt = options.nowIso;
    const aliasSource = [
      ...annotation.aliases,
      record.label,
      record.intent,
      record.description,
      record.usage,
    ]
      .filter((item): item is string => Boolean(item?.trim()))
      .flatMap((item) => item.split(/[，,、;；\s]+/u).map((part) => part.trim()).filter((part) => part.length >= 2 && part.length <= 24));
    record.aliases = Array.from(new Set([...(record.aliases || []), ...aliasSource])).slice(0, 20);
  }

  record.annotationUpdatedAt = options.nowIso;
  record.learnedFromMessageId = input.learnedFromMessageId || record.learnedFromMessageId;
  record.lastSeenAt = options.nowIso;
  record.chatId = input.chatId || record.chatId;
  record.userId = input.userId || record.userId;
  store.updatedAt = options.nowIso;
  store.stickers = compactFeishuStickerStoreRecords(store.stickers, {
    hasCachedMedia: options.hasCachedMedia,
    maxRecords: options.maxRecords,
  });
  return {
    accepted: true,
    store,
    record: store.stickers.find((item) => item.fileKey === fileKey),
  };
}
