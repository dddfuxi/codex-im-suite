export interface FeishuInteractiveCardResourceRef {
  kind: 'image' | 'file';
  key: string;
  name?: string;
}

export interface FeishuInteractiveCardEvidence {
  visibleText: string;
  rawText: string;
  textParts: string[];
  imageKeys: string[];
  fileKeys: string[];
  resourceRefs: FeishuInteractiveCardResourceRef[];
  cardRefs: string[];
  rawPreview: string;
  compatibilityPlaceholderRemoved: boolean;
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

  const rawText = normalizeText(deduplicateTextParts(state.textParts).join(' '));
  const visibleText = removeFeishuCardCompatibilityPlaceholder(rawText);
  return {
    visibleText,
    rawText,
    textParts: deduplicateTextParts(state.textParts.map(removeFeishuCardCompatibilityPlaceholder)).filter(Boolean),
    imageKeys: [...state.imageKeys],
    fileKeys: [...state.fileKeys],
    resourceRefs: [...state.resourceRefs.values()],
    cardRefs: [...state.cardRefs],
    rawPreview,
    compatibilityPlaceholderRemoved: rawText !== visibleText && containsFeishuCardCompatibilityPlaceholder(rawText),
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
}

function emptyEvidence(rawPreview: string, parseWarnings: string[]): FeishuInteractiveCardEvidence {
  return {
    visibleText: '',
    rawText: '',
    textParts: [],
    imageKeys: [],
    fileKeys: [],
    resourceRefs: [],
    cardRefs: [],
    rawPreview,
    compatibilityPlaceholderRemoved: false,
    parseWarnings,
  };
}

function createCollectState(parseWarnings: string[]): CollectState {
  return {
    textParts: [],
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
    for (const item of value) {
      collected = collectCardEvidence(item, state, context) || collected;
    }
    return collected;
  }
  if (!value || typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  const tag = typeof record.tag === 'string' ? normalizeCardPropertyName(record.tag) : context.tag;
  const fileName = resolveFileName(record);
  let collected = false;
  for (const [key, child] of Object.entries(record)) {
    if (key === 'tag') continue;
    const childContext = {
      fieldName: key,
      tag,
      depth: context.depth + 1,
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
      });
      if (hasNewEvidence(state, before)) return true;
    }
  }

  if (!isVisibleTextProperty(normalizedKey, context.tag)) return false;
  state.textParts.push(value);
  return true;
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
