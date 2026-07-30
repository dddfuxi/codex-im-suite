export interface FeishuInteractiveCardResourceRef {
  kind: 'image' | 'file';
  key: string;
  name?: string;
}

export interface FeishuInteractiveCardEvidence {
  visibleText: string;
  rawText: string;
  textParts: string[];
  presentationTextParts: string[];
  imageKeys: string[];
  fileKeys: string[];
  resourceRefs: FeishuInteractiveCardResourceRef[];
  cardRefs: string[];
  rawPreview: string;
  compatibilityPlaceholderRemoved: boolean;
  presentationMetadataRemoved: boolean;
  parseWarnings: string[];
}

const MAX_NESTED_JSON_CHARS = 20_000;
const RAW_PREVIEW_MAX_CHARS = 800;

const FEISHU_CARD_COMPATIBILITY_PLACEHOLDER_RE =
  /(?:请升级至(?:最新版本|最新版)客户端[，,]?\s*以查看内容|please\s+upgrade\s+.*?(?:client|app).*?(?:view|see).*?content|\[(?:card message|卡片消息|鍗＄墖娑堟伅)\])/giu;

export function parseFeishuInteractiveCardEvidence(content: string): FeishuInteractiveCardEvidence {
  const parseWarnings: string[] = [];
  const rawPreview = buildRawPreview(content);
  const initial = parseJsonLike(content, parseWarnings, 'root');
  if (initial === undefined) {
    return emptyEvidence(rawPreview, parseWarnings);
  }

  const state = createCollectState(parseWarnings);
  collectCardEvidence(initial, state, {
    fieldName: '',
    tag: '',
    depth: 0,
  });

  const rawTextParts = deduplicateTextParts([
    ...state.textParts,
    ...state.presentationTextParts,
  ]);
  const visibleTextParts = deduplicateTextParts(
    state.textParts.map(removeFeishuCardCompatibilityPlaceholder),
  ).filter(Boolean);
  const presentationTextParts = deduplicateTextParts(
    state.presentationTextParts.map(removeFeishuCardCompatibilityPlaceholder),
  ).filter(Boolean);
  const rawText = normalizeText(rawTextParts.join(' '));
  const visibleText = normalizeText(visibleTextParts.join(' '));
  return {
    visibleText,
    rawText,
    textParts: visibleTextParts,
    presentationTextParts,
    imageKeys: [...state.imageKeys],
    fileKeys: [...state.fileKeys],
    resourceRefs: [...state.resourceRefs.values()],
    cardRefs: [...state.cardRefs],
    rawPreview,
    compatibilityPlaceholderRemoved: rawText !== visibleText && containsFeishuCardCompatibilityPlaceholder(rawText),
    presentationMetadataRemoved: presentationTextParts.length > 0,
    parseWarnings,
  };
}

export function removeFeishuCardCompatibilityPlaceholder(text: string): string {
  const cleaned = normalizeText(text).replace(FEISHU_CARD_COMPATIBILITY_PLACEHOLDER_RE, ' ');
  return normalizeText(cleaned);
}

export function containsFeishuCardCompatibilityPlaceholder(text: string): boolean {
  FEISHU_CARD_COMPATIBILITY_PLACEHOLDER_RE.lastIndex = 0;
  return FEISHU_CARD_COMPATIBILITY_PLACEHOLDER_RE.test(text);
}

interface CollectState {
  textParts: string[];
  presentationTextParts: string[];
  imageKeys: Set<string>;
  fileKeys: Set<string>;
  resourceRefs: Map<string, FeishuInteractiveCardResourceRef>;
  cardRefs: Set<string>;
  parseWarnings: string[];
}

interface CollectContext {
  fieldName: string;
  tag: string;
  depth: number;
  presentationOnly?: boolean;
}

function emptyEvidence(rawPreview: string, parseWarnings: string[]): FeishuInteractiveCardEvidence {
  return {
    visibleText: '',
    rawText: '',
    textParts: [],
    presentationTextParts: [],
    imageKeys: [],
    fileKeys: [],
    resourceRefs: [],
    cardRefs: [],
    rawPreview,
    compatibilityPlaceholderRemoved: false,
    presentationMetadataRemoved: false,
    parseWarnings,
  };
}

function createCollectState(parseWarnings: string[]): CollectState {
  return {
    textParts: [],
    presentationTextParts: [],
    imageKeys: new Set<string>(),
    fileKeys: new Set<string>(),
    resourceRefs: new Map<string, FeishuInteractiveCardResourceRef>(),
    cardRefs: new Set<string>(),
    parseWarnings,
  };
}

function collectCardEvidence(value: unknown, state: CollectState, context: CollectContext): boolean {
  if (typeof value === 'string') {
    return collectStringEvidence(value, state, context);
  }
  if (Array.isArray(value)) {
    let collected = false;
    const presentationIndexes = findPresentationMetadataIndexes(value);
    for (let index = 0; index < value.length; index += 1) {
      collected = collectCardEvidence(value[index], state, {
        ...context,
        presentationOnly: context.presentationOnly || presentationIndexes.has(index),
      }) || collected;
    }
    return collected;
  }
  if (!value || typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  const tag = typeof record.tag === 'string' ? normalizeCardPropertyName(record.tag) : context.tag;
  const presentationOnly = context.presentationOnly || isStrongPresentationMetadataRecord(record, tag);
  const fileName = resolveFileName(record);
  let collected = false;
  for (const [key, child] of Object.entries(record)) {
    if (key === 'tag') continue;
    const childContext = {
      fieldName: key,
      tag,
      depth: context.depth + 1,
      presentationOnly,
    };
    if (typeof child === 'string') {
      collected = collectStringEvidence(child, state, childContext, fileName) || collected;
    } else {
      collected = collectCardEvidence(child, state, childContext) || collected;
    }
  }
  return collected;
}

function collectStringEvidence(
  rawValue: string,
  state: CollectState,
  context: CollectContext,
  fileName = '',
): boolean {
  const value = rawValue.trim();
  if (!value) return false;

  const normalizedKey = normalizeCardPropertyName(context.fieldName);
  if (isImageResourceProperty(normalizedKey)) {
    addResourceRef(state, 'image', value);
    return true;
  }
  if (isFileResourceProperty(normalizedKey)) {
    addResourceRef(state, 'file', value, fileName);
    return true;
  }
  if (isCardReferenceProperty(normalizedKey)) {
    state.cardRefs.add(value);
    return true;
  }

  if (looksLikeJson(value)) {
    const before = snapshotCounts(state);
    const nested = parseJsonLike(value, state.parseWarnings, context.fieldName);
    if (nested !== undefined) {
      collectCardEvidence(nested, state, {
        fieldName: context.fieldName,
        tag: context.tag,
        depth: context.depth + 1,
        presentationOnly: context.presentationOnly,
      });
      if (hasNewEvidence(state, before)) return true;
    }
  }

  if (!isVisibleTextProperty(normalizedKey, context.tag)) return false;
  if (context.presentationOnly) {
    state.presentationTextParts.push(value);
  } else {
    state.textParts.push(value);
  }
  return true;
}

/**
 * 飞书不会为卡片的“业务正文”和“状态/耗时/运行摘要”提供统一语义字段。
 * 因此只在卡片元素数组的末端、且前面已有可见正文时识别严格的展示元数据块；
 * 普通文本消息以及只有一个正文元素的卡片不会经过该过滤。
 */
function findPresentationMetadataIndexes(items: unknown[]): Set<number> {
  const indexes = new Set<number>();
  let hasPriorVisibleText = false;
  let afterDivider = false;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (isDividerRecord(item)) {
      afterDivider = hasPriorVisibleText;
      continue;
    }

    const presentationRecord = isPresentationMetadataValue(item);
    const isTerminalRegion = index === items.length - 1 || afterDivider;
    if (hasPriorVisibleText && isTerminalRegion && presentationRecord) {
      indexes.add(index);
      continue;
    }

    if (containsPotentialVisibleText(item)) {
      hasPriorVisibleText = true;
      afterDivider = false;
    }
  }

  return indexes;
}

function isDividerRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const tag = (value as Record<string, unknown>).tag;
  return typeof tag === 'string' && normalizeCardPropertyName(tag) === 'hr';
}

function isPresentationMetadataValue(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const tag = typeof record.tag === 'string' ? normalizeCardPropertyName(record.tag) : '';
  return isPresentationMetadataRecord(record, tag);
}

function isPresentationMetadataRecord(record: Record<string, unknown>, tag: string): boolean {
  if (tag !== 'markdown' && tag !== 'plaintext' && tag !== 'larkmd') return false;
  const text = firstDirectText(record);
  if (!text || !isPresentationMetadataText(text)) return false;

  const textSize = typeof record.text_size === 'string'
    ? normalizeCardPropertyName(record.text_size)
    : '';
  // notation 是强结构证据；legacy 卡片没有 text_size 时仍可由严格内容签名识别。
  return !textSize || textSize === 'notation';
}

function isStrongPresentationMetadataRecord(record: Record<string, unknown>, tag: string): boolean {
  if (!isPresentationMetadataRecord(record, tag)) return false;
  const textSize = typeof record.text_size === 'string'
    ? normalizeCardPropertyName(record.text_size)
    : '';
  return textSize === 'notation';
}

function firstDirectText(record: Record<string, unknown>): string {
  for (const key of ['content', 'text', 'summary']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function containsPotentialVisibleText(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(containsPotentialVisibleText);
  if (!value || typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  const tag = typeof record.tag === 'string' ? normalizeCardPropertyName(record.tag) : '';
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === 'string') {
      if (isVisibleTextProperty(normalizeCardPropertyName(key), tag) && child.trim()) return true;
      continue;
    }
    if (containsPotentialVisibleText(child)) return true;
  }
  return false;
}

function isPresentationMetadataText(rawText: string): boolean {
  const normalized = normalizeText(rawText)
    .replace(/<\/?font\b[^>]*>/giu, ' ')
    .replace(/[*_`~]/gu, '')
    .replace(/^[\s✓✔✅☑●•·｜|—-]+/gu, '')
    .trim();
  if (!normalized) return false;

  const parts = normalized
    .split(/\s*[·•●｜|]\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;

  let hasPresentationSignal = false;
  for (const part of parts) {
    if (isCompletionStatusPart(part) || isElapsedMetricPart(part)) {
      hasPresentationSignal = true;
      continue;
    }
    if (isEvidenceBadgePart(part)) {
      hasPresentationSignal = true;
      continue;
    }
    if (isRunSummaryPart(part)) continue;
    return false;
  }
  return hasPresentationSignal;
}

function isCompletionStatusPart(part: string): boolean {
  return /^(?:[✓✔✅☑]\s*)?(?:已完成|执行完成|处理完成|未完成|执行失败|失败|已中断|处理中|completed|done|failed|interrupted|running)$/iu.test(part);
}

function isElapsedMetricPart(part: string): boolean {
  return /^(?:(?:耗时|用时|elapsed|duration)\s*[:：]?\s*)?(?:\d+(?:\.\d+)?\s*(?:ms|s|秒|毫秒|m|min|分钟|h|小时)|\d+\s*(?:m|min|分钟|分)\s*\d+(?:\.\d+)?\s*(?:s|秒))$/iu.test(part);
}

function isRunSummaryPart(part: string): boolean {
  return /^(?:来源|模型|provider|model|token|cache)\s*[:：]\s*\S[\s\S]*$/iu.test(part);
}

function isEvidenceBadgePart(part: string): boolean {
  const normalized = part.replace(/^[\s●•]+/gu, '').trim();
  return /^(?:结果已生成|结果未完成|仅文本回复|工具证据\s*\d+\s*\/\s*\d+|工具失败\s*\d+\s*\/\s*\d+|工具进行中\s*\d+\s*\/\s*\d+)$/u.test(normalized);
}

function addResourceRef(
  state: CollectState,
  kind: 'image' | 'file',
  key: string,
  name = '',
): void {
  const normalizedKey = key.trim();
  if (!normalizedKey) return;
  if (kind === 'image') state.imageKeys.add(normalizedKey);
  if (kind === 'file') state.fileKeys.add(normalizedKey);
  const mapKey = `${kind}:${normalizedKey}`;
  if (state.resourceRefs.has(mapKey)) return;
  state.resourceRefs.set(mapKey, {
    kind,
    key: normalizedKey,
    ...(name.trim() ? { name: name.trim() } : {}),
  });
}

function parseJsonLike(value: string, parseWarnings: string[], label: string): unknown | undefined {
  const trimmed = value.trim();
  if (!looksLikeJson(trimmed)) {
    parseWarnings.push(`${label || 'content'} is not JSON`);
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (err) {
    parseWarnings.push(`${label || 'content'} JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 1
    && trimmed.length <= MAX_NESTED_JSON_CHARS
    && ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')));
}

function isVisibleTextProperty(key: string, tag: string): boolean {
  if (tag === 'markdown' && key === 'content') return true;
  if ((tag === 'plain_text' || tag === 'lark_md') && (key === 'content' || key === 'text')) return true;
  return new Set([
    'content',
    'text',
    'title',
    'subtitle',
    'summary',
    'description',
    'placeholder',
    'label',
    'alt',
  ]).has(key);
}

function isImageResourceProperty(key: string): boolean {
  return key === 'imagekey' || key === 'imgkey';
}

function isFileResourceProperty(key: string): boolean {
  return key === 'filekey';
}

function isFileNameProperty(key: string): boolean {
  return key === 'filename' || key === 'name';
}

function isCardReferenceProperty(key: string): boolean {
  return key === 'cardid' || key === 'templateid';
}

function resolveFileName(record: Record<string, unknown>): string {
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') continue;
    if (isFileNameProperty(normalizeCardPropertyName(key))) return normalizeText(value);
  }
  return '';
}

function normalizeCardPropertyName(key: string): string {
  return key.trim().replace(/[_-]/g, '').toLowerCase();
}

function deduplicateTextParts(parts: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const normalized = normalizeText(part);
    if (!normalized) continue;
    const comparable = normalized.replace(/\s+/g, ' ').trim();
    if (seen.has(comparable)) continue;
    seen.add(comparable);
    deduped.push(normalized);
  }
  return deduped;
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildRawPreview(raw: string): string {
  const preview = raw.replace(/\s+/g, ' ').trim();
  return preview.length <= RAW_PREVIEW_MAX_CHARS ? preview : `${preview.slice(0, RAW_PREVIEW_MAX_CHARS - 3)}...`;
}

function snapshotCounts(state: CollectState): {
  text: number;
  images: number;
  files: number;
  cards: number;
} {
  return {
    text: state.textParts.length,
    images: state.imageKeys.size,
    files: state.fileKeys.size,
    cards: state.cardRefs.size,
  };
}

function hasNewEvidence(
  state: CollectState,
  before: ReturnType<typeof snapshotCounts>,
): boolean {
  return state.textParts.length > before.text
    || state.imageKeys.size > before.images
    || state.fileKeys.size > before.files
    || state.cardRefs.size > before.cards;
}
