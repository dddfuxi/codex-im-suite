import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type KnowledgeKind = 'fact' | 'conclusion' | 'todo' | 'resource';

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

function makeItem(
  kind: KnowledgeKind,
  file: KnowledgeSourceFile,
  text: string,
  key?: string,
  value?: string,
): KnowledgeItem {
  const normalizedText = stripMarkdown(text);
  const sourceKey = `${file.path}:${kind}:${key || ''}:${value || normalizedText}`;
  return {
    id: sha1(sourceKey),
    kind,
    key,
    value,
    text: normalizedText,
    confidence: kind === 'resource' ? 0.9 : 0.75,
    conflict: false,
    source: {
      path: file.path,
      updatedAt: file.updatedAt,
      snippet: makeSnippet(text),
      metadata: parseFrontmatterMetadata(file.content),
    },
  };
}

function parseFrontmatterMetadata(content: string): Record<string, string> | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) return undefined;
  const metadata: Record<string, string> = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && value) metadata[key] = value;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
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

function inferLineKind(line: string): KnowledgeKind | null {
  const normalized = stripMarkdown(line);
  for (const label of KIND_LABELS) {
    if (label.pattern.test(normalized)) return label.kind;
  }
  if (/https?:\/\/|[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif|mp4|mov|glb|gltf|fbx|obj|zip|pdf|md)\b/u.test(normalized)) {
    return 'resource';
  }
  return null;
}

function collectItemsFromFile(file: KnowledgeSourceFile): KnowledgeItem[] {
  const items: KnowledgeItem[] = [];
  for (const row of parseMarkdownTableRows(file.content)) {
    const [key, value] = row.cells;
    if (!key || !value) continue;
    items.push(makeItem('resource', file, row.raw, key, value));
  }

  for (const rawLine of file.content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('|')) continue;
    const kind = inferLineKind(line);
    if (!kind) continue;
    const text = stripMarkdown(line).replace(/^(事实|偏好|约定|结论|决策|决定|待办|todo|TODO|后续|风险|资源|文件|图片|链接|场景|Scene)\s*[:：]\s*/iu, '');
    if (!text) continue;
    items.push(makeItem(kind, file, line, undefined, text));
  }

  return items;
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
  const items = markConflicts(input.files.flatMap(collectItemsFromFile));
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
    return JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as KnowledgeIndex;
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
