import type {
  FeishuStickerRecord,
  FeishuStickerStore,
  FeishuStickerUserAnnotation,
} from './sticker-store-schema.js';

export const FEISHU_STICKER_AUTO_SEND_MIN_CONFIDENCE = 0.45;

const FEISHU_STICKER_SEMANTIC_STOP_TOKENS = new Set([
  '表达', '表示', '代表', '用于', '用来', '适合', '时候', '场景', '回复', '聊天',
  '一下', '一个', '这个', '那个', '可以', '需要', '进行', '比较', '感觉',
]);

export interface FeishuStickerSelectionOptions {
  chatId?: string;
  contextText?: string;
  nowMs?: number;
  minimumVisionConfidence?: number;
}

export interface FeishuStickerRetentionOptions {
  hasCachedMedia?: (fileKey: string) => boolean;
  maxRecords?: number;
}

export function looksLikeFeishuStickerFileKey(value: string): boolean {
  const trimmed = value.trim();
  return /^(?:file_v\d+_[A-Za-z0-9_-]+|v\d+_[A-Za-z0-9]+_[A-Za-z0-9-]+g|[0-9a-f]{8}-[0-9a-f-]{20,})$/i.test(trimmed);
}

export function hasSpecificFeishuStickerSemanticConstraint(text: string): boolean {
  const compact = text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  if (!compact) return false;
  // 这些是用途、情绪或语气约束；命中后必须有真实语义匹配，不能随机兜底。
  return /(夸|夸奖|称赞|表扬|赞美|真棒|棒呀|厉害|优秀|鼓励|加油|安慰|抱抱|难过|委屈|生气|愤怒|吐槽|嘲讽|反讽|疑惑|迷惑|懵|尴尬|无语|震惊|惊讶|开心|快乐|高兴|笑|哈哈|感谢|谢谢|抱歉|对不起|庆祝|恭喜|告别|晚安|早安|可爱|撒娇|害羞|期待|拒绝|警告|严肃|催促|困|累|破防|离谱)/iu.test(compact);
}

export function isFeishuStickerActive(record: FeishuStickerRecord): boolean {
  return record.disabled !== true && record.archived !== true;
}

export function isFeishuStickerDeleted(store: FeishuStickerStore, fileKey: string): boolean {
  const normalized = fileKey.trim();
  return Boolean(normalized && store.deletedStickers?.[normalized]);
}

export function feishuStickerUserAnnotationText(annotation?: FeishuStickerUserAnnotation): string {
  if (!annotation) return '';
  return [
    annotation.label,
    annotation.description,
    annotation.intent,
    annotation.tone,
    annotation.usage,
    annotation.avoidWhen,
    ...(annotation.aliases || []),
    ...(annotation.examples || []),
  ].filter((item): item is string => Boolean(item?.trim())).join(' ');
}

export function feishuStickerSemanticText(record: FeishuStickerRecord): string {
  return [
    record.label,
    record.description,
    record.intent,
    record.tone,
    record.usage,
    record.avoidWhen,
    ...(record.aliases || []),
    ...(record.examples || []),
  ].filter((item): item is string => Boolean(item?.trim())).join(' ');
}

export function hasFeishuStickerAnnotation(record: FeishuStickerRecord | null): boolean {
  const legacyTrusted = !!record
    && !record.annotationSource
    && !record.annotationVerifiedAt
    && !(record.learnedFromMessageId && record.messageId && record.learnedFromMessageId !== record.messageId);
  const trustedSource = record?.annotationSource === 'vision'
    || record?.annotationSource === 'manual'
    || Boolean(record?.annotationVerifiedAt)
    || legacyTrusted;
  return !!record && trustedSource && Boolean(
    record.label?.trim()
    || record.description?.trim()
    || record.intent?.trim()
    || record.tone?.trim()
    || record.usage?.trim(),
  );
}

export function hasTrustedFeishuStickerSemanticSource(record: FeishuStickerRecord | null): boolean {
  return (record?.annotationSource === 'vision' && record.visionMediaFileKey === record.fileKey)
    || record?.annotationSource === 'manual'
    || Boolean(record?.annotationVerifiedAt);
}

export function hasSpecificFeishuStickerSemanticText(value: string): boolean {
  const compact = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s，,。.;；:：、"'“”‘’()[\]{}<>《》【】!！?？~～_-]+/gu, '')
    .replace(/(?:飞书|表情包|表情|sticker|贴纸|图片|图像|动图|一张|一个|这个|那个|用于|用来|使用|发送|回复|回话|聊天|消息|默认|随便|普通|轻量|发个|发|给你|来一个|来)/gu, '')
    .trim();
  return compact.length >= 2;
}

export function hasReliableFeishuStickerSemantics(
  record: FeishuStickerRecord | null,
  minimumVisionConfidence = FEISHU_STICKER_AUTO_SEND_MIN_CONFIDENCE,
): boolean {
  if (!record || !isFeishuStickerActive(record) || !hasFeishuStickerAnnotation(record)) return false;
  if (!hasTrustedFeishuStickerSemanticSource(record)) return false;
  if (!hasSpecificFeishuStickerSemanticText(feishuStickerSemanticText(record))) return false;
  if (record.annotationSource === 'vision') {
    const confidence = Number(record.annotationConfidence);
    if (!Number.isFinite(confidence) || confidence < minimumVisionConfidence) return false;
  }
  return true;
}

export function tokenizeFeishuStickerSemanticText(value: string): Set<string> {
  const normalized = value.normalize('NFKC').toLowerCase();
  const tokens = new Set<string>();
  for (const token of normalized.split(/[^\p{L}\p{N}_+-]+/u)) {
    const trimmed = token.trim();
    if (trimmed.length >= 2 && !FEISHU_STICKER_SEMANTIC_STOP_TOKENS.has(trimmed)) tokens.add(trimmed);
  }
  const compact = normalized.replace(/[^\p{L}\p{N}]/gu, '');
  const compactVariants = new Set([compact]);
  const colloquialParticleVariant = compact.replace(/[啦喽咯]/gu, '了');
  if (colloquialParticleVariant !== compact) compactVariants.add(colloquialParticleVariant);
  for (const variant of compactVariants) {
    for (let size = 2; size <= 4; size += 1) {
      for (let index = 0; index + size <= variant.length; index += 1) {
        const token = variant.slice(index, index + size);
        if (!FEISHU_STICKER_SEMANTIC_STOP_TOKENS.has(token)) tokens.add(token);
      }
    }
  }
  return tokens;
}

export function feishuStickerTextOverlapScore(left: string, right: string): number {
  const normalizedLeft = left.normalize('NFKC').toLowerCase().trim();
  const normalizedRight = right.normalize('NFKC').toLowerCase().trim();
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return 80;
  const leftTokens = tokenizeFeishuStickerSemanticText(normalizedLeft);
  const rightTokens = tokenizeFeishuStickerSemanticText(normalizedRight);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let score = 0;
  for (const token of leftTokens) {
    if (!rightTokens.has(token)) continue;
    score += token.length >= 4 ? 8 : token.length === 3 ? 5 : 3;
  }
  return score;
}

export function feishuStickerAvoidsContext(record: FeishuStickerRecord, contextText: string): boolean {
  return Boolean(record.avoidWhen?.trim() && feishuStickerTextOverlapScore(contextText, record.avoidWhen) >= 12);
}

export function feishuStickerSemanticMatchScore(record: FeishuStickerRecord, contextText: string): number {
  if (!hasFeishuStickerAnnotation(record)) return 0;
  if (!contextText.trim() || feishuStickerAvoidsContext(record, contextText)) return 0;
  return feishuStickerTextOverlapScore(contextText, feishuStickerSemanticText(record));
}

export function feishuStickerSemanticScore(
  record: FeishuStickerRecord,
  options: FeishuStickerSelectionOptions = {},
): number {
  const contextText = options.contextText || '';
  if (!isFeishuStickerActive(record)) return Number.NEGATIVE_INFINITY;
  if (contextText.trim() && feishuStickerAvoidsContext(record, contextText)) return Number.NEGATIVE_INFINITY;
  const semanticScore = contextText.trim()
    ? feishuStickerTextOverlapScore(contextText, feishuStickerSemanticText(record))
    : 0;
  const nowMs = options.nowMs ?? Date.now();
  return semanticScore
    + (record.chatId === options.chatId ? 20 : 0)
    + (hasFeishuStickerAnnotation(record) ? 16 : 0)
    + Math.round((Number(record.annotationConfidence) || 0) * 8)
    - Math.min(Number(record.useCount || 0), 20) * 0.25
    - (nowMs - (Date.parse(record.lastUsedAt || '') || 0) < 60 * 60 * 1000 ? 3 : 0);
}

function feishuStickerRetentionScore(record: FeishuStickerRecord, options: FeishuStickerRetentionOptions): number {
  let score = 0;
  if (hasTrustedFeishuStickerSemanticSource(record) && hasFeishuStickerAnnotation(record)) score += 1000;
  else if (hasFeishuStickerAnnotation(record)) score += 700;
  if (feishuStickerUserAnnotationText(record.userAnnotation)) score += 650;
  if (record.mediaCachedAt || record.mediaMimeType || record.mediaSize || options.hasCachedMedia?.(record.fileKey)) score += 600;
  if (record.disabled) score += 500;
  if (record.archived) score += 550;
  if (record.mediaDownloadFailedAt || record.mediaDownloadError) score += 250;
  if (record.lastUsedAt) score += 120;
  if ((record.aliases || []).some((alias) => !/^(?:最近|默认|表情包)$/u.test(alias))) score += 60;
  return score;
}

function compareFeishuStickerRetention(
  left: FeishuStickerRecord,
  right: FeishuStickerRecord,
  options: FeishuStickerRetentionOptions,
): number {
  return feishuStickerRetentionScore(right, options) - feishuStickerRetentionScore(left, options)
    || (Date.parse(right.lastSeenAt || '') || 0) - (Date.parse(left.lastSeenAt || '') || 0)
    || (Date.parse(right.annotationUpdatedAt || right.annotationVerifiedAt || '') || 0)
      - (Date.parse(left.annotationUpdatedAt || left.annotationVerifiedAt || '') || 0)
    || left.fileKey.localeCompare(right.fileKey);
}

export function compactFeishuStickerStoreRecords(
  records: FeishuStickerRecord[],
  options: FeishuStickerRetentionOptions = {},
): FeishuStickerRecord[] {
  const normalized = new Map<string, FeishuStickerRecord>();
  for (const record of records) {
    const fileKey = record.fileKey?.trim();
    if (!fileKey) continue;
    const existing = normalized.get(fileKey);
    if (!existing || compareFeishuStickerRetention(record, existing, options) < 0) normalized.set(fileKey, record);
  }
  return Array.from(normalized.values())
    .sort((left, right) => compareFeishuStickerRetention(left, right, options))
    .slice(0, options.maxRecords ?? 80);
}

export function resolveFeishuStickerFileKey(
  store: FeishuStickerStore,
  target: string,
  options: FeishuStickerSelectionOptions = {},
): string | null {
  const normalized = target.trim();
  const minimumVisionConfidence = options.minimumVisionConfidence ?? FEISHU_STICKER_AUTO_SEND_MIN_CONFIDENCE;
  const reliable = (record: FeishuStickerRecord | null): boolean => (
    hasReliableFeishuStickerSemantics(record, minimumVisionConfidence)
  );
  if (looksLikeFeishuStickerFileKey(normalized)) {
    const record = store.stickers.find((item) => item.fileKey === normalized) || null;
    return reliable(record) ? normalized : null;
  }

  const alias = normalized || '最近';
  const genericTarget = /^(?:最近|默认|表情包|sticker|飞书表情包)$/iu.test(alias);
  const wantsRecent = /^最近$/u.test(alias);
  const contextText = options.contextText || '';
  const compareCommon = (a: FeishuStickerRecord, b: FeishuStickerRecord): number =>
    Number(b.chatId === options.chatId) - Number(a.chatId === options.chatId)
    || Number(hasFeishuStickerAnnotation(b)) - Number(hasFeishuStickerAnnotation(a));
  const compareSemantic = (a: FeishuStickerRecord, b: FeishuStickerRecord): number =>
    feishuStickerSemanticScore(b, options) - feishuStickerSemanticScore(a, options)
    || compareCommon(a, b)
    || Number(a.useCount || 0) - Number(b.useCount || 0)
    || (Date.parse(a.lastUsedAt || '') || 0) - (Date.parse(b.lastUsedAt || '') || 0)
    || (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0);
  const compareRecent = (a: FeishuStickerRecord, b: FeishuStickerRecord): number =>
    compareCommon(a, b)
    || (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0);
  const compareRotating = (a: FeishuStickerRecord, b: FeishuStickerRecord): number =>
    compareCommon(a, b)
    || Number(a.useCount || 0) - Number(b.useCount || 0)
    || (Date.parse(a.lastUsedAt || '') || 0) - (Date.parse(b.lastUsedAt || '') || 0)
    || (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0);
  const compareSpecific = (a: FeishuStickerRecord, b: FeishuStickerRecord): number =>
    compareCommon(a, b)
    || Number(b.useCount || 0) - Number(a.useCount || 0)
    || (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0);
  const compareCandidate = wantsRecent
    ? compareRecent
    : genericTarget
      ? contextText.trim() ? compareSemantic : compareRotating
      : compareSpecific;
  const active = store.stickers.filter(isFeishuStickerActive);

  if (genericTarget) {
    const minimumSemanticScore = contextText.trim().length <= 8 ? 3 : 6;
    const matched = active
      .filter((item) => reliable(item))
      .filter((item) => feishuStickerSemanticMatchScore(item, contextText) >= minimumSemanticScore)
      .sort(compareSemantic);
    if (matched[0]?.fileKey) return matched[0].fileKey;
    if (hasSpecificFeishuStickerSemanticConstraint(contextText)) return null;
    const annotatedFallback = active
      .filter((item) => reliable(item))
      .filter((item) => !contextText.trim() || !feishuStickerAvoidsContext(item, contextText))
      .sort(compareSemantic);
    return annotatedFallback[0]?.fileKey || null;
  }

  const byAlias = active
    .filter((item) => reliable(item))
    .filter((item) => (item.aliases || []).some((name) => name.toLowerCase() === alias.toLowerCase()))
    .filter((item) => !contextText.trim() || !feishuStickerAvoidsContext(item, contextText))
    .sort(compareCandidate);
  return byAlias[0]?.fileKey || null;
}
