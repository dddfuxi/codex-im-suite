import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  isIndexableMemoryV2SourceFile,
  isIndexableMemoryV2SourceItem,
  parseMemorySourceFrontmatter,
} from './memory-source-policy.js';
import { repairLikelyMojibakeText } from './mojibake.js';

export type KnowledgeKind = 'fact' | 'conclusion' | 'todo' | 'resource';
export type KnowledgeClassificationSource = 'prefix' | 'table_inference' | 'resource_pattern';

export interface KnowledgeSourceFile {
  path: string;
  content: string;
  updatedAt?: string;
}

export interface KnowledgeItem {
  id: string;
  kind: KnowledgeKind;
  key?: string;
  value?: string;
  text: string;
  confidence: number;
  conflict: boolean;
  classificationReason?: string;
  classificationSource?: KnowledgeClassificationSource;
  source: {
    path: string;
    updatedAt?: string;
    snippet: string;
    metadata?: Record<string, string>;
  };
}

export interface KnowledgeIndex {
  schema: 'codex-im-suite/knowledge-index/v1';
  memoryRoot: string;
  generatedAt: string;
  itemCount: number;
  conflictCount: number;
  items: KnowledgeItem[];
}

export interface KnowledgeSearchQuery {
  query?: string;
  kinds?: KnowledgeKind[];
  limit?: number;
}

interface BuildInput {
  memoryRoot: string;
  files: KnowledgeSourceFile[];
  generatedAt?: string;
}

const KIND_LABELS: Array<{ kind: KnowledgeKind; pattern: RegExp }> = [
  { kind: 'fact', pattern: /^(事实|偏好|约定)\s*[:：]/u },
  { kind: 'conclusion', pattern: /^(结论|决策|决定)\s*[:：]/u },
  { kind: 'todo', pattern: /^(待办|todo|TODO|后续|风险)\s*[:：]/u },
  { kind: 'resource', pattern: /^(资源|文件|图片|链接|场景|Scene)\s*[:：]/iu },
];

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function stripMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*]\s+/u, '')
    .trim();
}

function makeSnippet(text: string, maxChars = 260): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function normalizeIndexedText(text: string): string | null {
  const repaired = repairLikelyMojibakeText(text);
  return repaired.unresolved ? null : repaired.text;
}

function makeItem(
  kind: KnowledgeKind,
  file: KnowledgeSourceFile,
  text: string,
  key?: string,
  value?: string,
  classification?: { reason: string; source: KnowledgeClassificationSource },
): KnowledgeItem | null {
  const normalizedText = normalizeIndexedText(stripMarkdown(text));
  if (!normalizedText) return null;
  let normalizedKey: string | undefined;
  if (key) {
    const candidate = normalizeIndexedText(key);
    if (!candidate) return null;
    normalizedKey = candidate;
  }
  let normalizedValue: string | undefined;
  if (value) {
    const candidate = normalizeIndexedText(value);
    if (!candidate) return null;
    normalizedValue = candidate;
  }
  const sourceKey = `${file.path}:${kind}:${key || ''}:${value || normalizedText}`;
  const snippet = normalizeIndexedText(makeSnippet(text));
  if (!snippet) return null;
  return {
    id: sha1(sourceKey),
    kind,
    key: normalizedKey,
    value: normalizedValue,
    text: normalizedText,
    confidence: kind === 'resource' ? 0.9 : 0.75,
    conflict: false,
    classificationReason: classification?.reason,
    classificationSource: classification?.source,
    source: {
      path: file.path,
      updatedAt: file.updatedAt,
      snippet,
      metadata: parseFrontmatterMetadata(file.content),
    },
  };
}

function stripFrontmatter(content: string): string {
  return content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, '');
}

function parseFrontmatterMetadata(content: string): Record<string, string> | undefined {
  return parseMemorySourceFrontmatter(content);
}

function parseMarkdownTableRows(content: string): Array<{ raw: string; cells: string[] }> {
  const lines = content.split(/\r?\n/);
  const rows: Array<{ raw: string; cells: string[] }> = [];
  for (let index = 0; index < lines.length - 2; index += 1) {
    const header = lines[index].trim();
    const divider = lines[index + 1].trim();
    if (!header.startsWith('|') || !divider.startsWith('|')) continue;
    if (!/^\|\s*[-: ]+(?:\|\s*[-: ]+)+\|\s*$/.test(divider)) continue;
    for (let bodyIndex = index + 2; bodyIndex < lines.length; bodyIndex += 1) {
      const raw = lines[bodyIndex].trim();
      if (!raw.startsWith('|')) break;
      const cells = raw
        .split('|')
        .map((value) => stripMarkdown(value))
        .filter(Boolean);
      if (cells.length >= 2) rows.push({ raw, cells });
    }
  }
  return rows;
}

interface KnowledgeKindInference {
  kind: KnowledgeKind;
  reason: string;
  source: KnowledgeClassificationSource;
}

const PATH_OR_FILE_PATTERN_RE = /https?:\/\/|(?:[A-Za-z]:\\|\.{1,2}\/|Assets\/|Packages\/)|[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif|mp4|mov|glb|gltf|fbx|obj|zip|pdf|md|docx?|xlsx?|cs|ts|tsx|json|prefab|unity)\b/iu;
const TABLE_RESOURCE_HINT_RE = /(?:\bPrefab\b|\bUIScene\b|材质|贴图|图片|模型|文件|路径|链接|文档|预制体)/iu;
const CONCLUSION_PATTERN_RE = /(?:决定|决策|采用|默认|不要|不能|必须|需要|优先|策略|规则|约定|边界|统一|改为|不再|只允许|禁止)/u;
const TODO_PATTERN_RE = /(?:待办|TODO|todo|后续|提醒|待处理|需要处理|风险|修复|跟进|检查|补齐|完善|实现|迁移|清理)/iu;

function inferLineKind(line: string): KnowledgeKindInference | null {
  const normalized = stripMarkdown(line);
  for (const label of KIND_LABELS) {
    if (label.pattern.test(normalized)) {
      return {
        kind: label.kind,
        reason: `显式前缀匹配 ${label.kind}`,
        source: 'prefix',
      };
    }
  }
  if (PATH_OR_FILE_PATTERN_RE.test(normalized)) {
    return {
      kind: 'resource',
      reason: '包含路径、链接或文件名',
      source: 'resource_pattern',
    };
  }
  return null;
}

function inferTableRowKind(key: string, value: string): KnowledgeKindInference {
  const text = `${key} ${value}`;
  if (PATH_OR_FILE_PATTERN_RE.test(text) || TABLE_RESOURCE_HINT_RE.test(text)) {
    return {
      kind: 'resource',
      reason: '表格 key/value 包含路径、链接、文件名或资源标识',
      source: 'table_inference',
    };
  }
  if (TODO_PATTERN_RE.test(text)) {
    return {
      kind: 'todo',
      reason: '表格 key/value 包含待办、提醒、风险或后续动作',
      source: 'table_inference',
    };
  }
  if (CONCLUSION_PATTERN_RE.test(text)) {
    return {
      kind: 'conclusion',
      reason: '表格 key/value 包含决策、默认、规则或优先级表述',
      source: 'table_inference',
    };
  }
  return {
    kind: 'fact',
    reason: '表格 key/value 是普通结构化映射',
    source: 'table_inference',
  };
}

function collectItemsFromFile(file: KnowledgeSourceFile): KnowledgeItem[] {
  const items: KnowledgeItem[] = [];
  const content = stripFrontmatter(file.content);
  for (const row of parseMarkdownTableRows(content)) {
    const [key, value] = row.cells;
    if (!key || !value) continue;
    const inference = inferTableRowKind(key, value);
    const item = makeItem(inference.kind, file, row.raw, key, value, {
      reason: inference.reason,
      source: inference.source,
    });
    if (item) items.push(item);
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('|')) continue;
    const inference = inferLineKind(line);
    if (!inference) continue;
    const text = stripMarkdown(line).replace(/^(事实|偏好|约定|结论|决策|决定|待办|todo|TODO|后续|风险|资源|文件|图片|链接|场景|Scene)\s*[:：]\s*/iu, '');
    if (!text) continue;
    const item = makeItem(inference.kind, file, line, undefined, text, {
      reason: inference.reason,
      source: inference.source,
    });
    if (item) items.push(item);
  }

  return items;
}

function sanitizeItemForSearch(item: KnowledgeItem): KnowledgeItem | null {
  const text = normalizeIndexedText(item.text);
  if (!text) return null;
  let key: string | undefined;
  if (item.key) {
    const candidate = normalizeIndexedText(item.key);
    if (!candidate) return null;
    key = candidate;
  }
  let value: string | undefined;
  if (item.value) {
    const candidate = normalizeIndexedText(item.value);
    if (!candidate) return null;
    value = candidate;
  }
  const snippet = normalizeIndexedText(item.source.snippet);
  if (!snippet) return null;
  return {
    ...item,
    key,
    value,
    text,
    source: {
      ...item.source,
      snippet,
    },
  };
}

function markConflicts(items: KnowledgeItem[]): KnowledgeItem[] {
  const byKey = new Map<string, KnowledgeItem[]>();
  for (const item of items) {
    if (!item.key) continue;
    const key = `${item.kind}:${item.key.toLowerCase()}`;
    byKey.set(key, [...(byKey.get(key) || []), item]);
  }
  const conflictIds = new Set<string>();
  for (const group of byKey.values()) {
    const values = new Set(group.map((item) => (item.value || item.text).toLowerCase()));
    const sources = new Set(group.map((item) => path.resolve(item.source.path).toLowerCase()));
    if (values.size > 1 && sources.size > 1) {
      for (const item of group) conflictIds.add(item.id);
    }
  }
  return items.map((item) => conflictIds.has(item.id) ? { ...item, conflict: true, confidence: Math.min(item.confidence, 0.5) } : item);
}

export function buildKnowledgeIndexFromMarkdown(input: BuildInput): KnowledgeIndex {
  const files = input.files.filter((file) => isIndexableMemoryV2SourceFile(input.memoryRoot, file));
  const items = markConflicts(files.flatMap(collectItemsFromFile));
  return {
    schema: 'codex-im-suite/knowledge-index/v1',
    memoryRoot: input.memoryRoot,
    generatedAt: input.generatedAt || new Date().toISOString(),
    itemCount: items.length,
    conflictCount: items.filter((item) => item.conflict).length,
    items,
  };
}

export function searchKnowledgeIndex(index: KnowledgeIndex, query: KnowledgeSearchQuery): KnowledgeItem[] {
  const normalizedQuery = (query.query || '').trim().toLowerCase();
  const kinds = new Set(query.kinds || []);
  const limit = Math.max(1, query.limit || 20);
  return index.items
    .map(sanitizeItemForSearch)
    .filter((item): item is KnowledgeItem => !!item)
    .filter((item) => kinds.size === 0 || kinds.has(item.kind))
    .map((item) => {
      const haystack = `${item.key || ''} ${item.value || ''} ${item.text} ${item.source.path}`.toLowerCase();
      let score = 0;
      if (!normalizedQuery) score = 1;
      else if (haystack.includes(normalizedQuery)) score = 10 + normalizedQuery.length;
      else {
        for (const token of normalizedQuery.split(/\s+/).filter(Boolean)) {
          if (haystack.includes(token)) score += 2;
        }
      }
      return { item, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.item.confidence - left.item.confidence)
    .slice(0, limit)
    .map(({ item }) => item);
}

export function getKnowledgeIndexPath(memoryRoot: string): string {
  return path.join(memoryRoot, '.cti-index', 'knowledge.json');
}

export function readKnowledgeIndex(memoryRoot: string): KnowledgeIndex | null {
  const indexPath = getKnowledgeIndexPath(memoryRoot);
  try {
    if (!fs.existsSync(indexPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as KnowledgeIndex;
    const root = parsed.memoryRoot || memoryRoot;
    const items = (parsed.items || []).filter((item) =>
      isIndexableMemoryV2SourceItem(root, item.source.path, item.source.metadata),
    );
    return {
      ...parsed,
      memoryRoot: root,
      itemCount: items.length,
      conflictCount: items.filter((item) => item.conflict).length,
      items,
    };
  } catch {
    return null;
  }
}

export function writeKnowledgeIndex(memoryRoot: string, index: KnowledgeIndex): void {
  const indexPath = getKnowledgeIndexPath(memoryRoot);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const tmp = `${indexPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf-8');
  fs.renameSync(tmp, indexPath);
}
