import crypto from 'node:crypto';
import path from 'node:path';

export const MEMORY_V2_SCHEMA = 'codex-im-suite/memory/v2';
export const MEMORY_V2_RELATIVE_DIR = path.join('data', 'memory', 'v2');

export type DurableMemoryScope = 'user' | 'group' | 'long_term';
export type MemoryV2SourceGroup = 'memory_user' | 'memory_group' | 'memory_long_term';

export interface MemorySourceFileLike {
  path: string;
  content: string;
}

export interface MemoryVisibilityQuery {
  channelType?: string;
  chatId?: string;
  userId?: string;
}

export interface MemoryV2SourcePolicyResult {
  ok: boolean;
  scope?: DurableMemoryScope;
  sourceGroup?: MemoryV2SourceGroup;
  reason?: string;
}

export function memoryPartitionSegment(value: string): string {
  const normalized = value.normalize('NFKC').trim();
  const safe = normalized
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/[\u0000-\u001F]/g, '')
    .slice(0, 96);
  return safe || crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 20);
}

export function parseMemorySourceFrontmatter(content: string): Record<string, string> | undefined {
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
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

function relativeSegments(memoryRoot: string, sourcePath: string): string[] {
  const root = path.resolve(memoryRoot);
  const resolved = path.resolve(sourcePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return [];
  return relative.replace(/\\/g, '/').split('/').filter(Boolean);
}

function normalizeScope(value: string | undefined): DurableMemoryScope | null {
  if (value === 'user' || value === 'group' || value === 'long_term') return value;
  return null;
}

function sourceGroupForScope(scope: DurableMemoryScope): MemoryV2SourceGroup {
  if (scope === 'user') return 'memory_user';
  if (scope === 'group') return 'memory_group';
  return 'memory_long_term';
}

export function classifyMemoryV2Source(
  memoryRoot: string,
  sourcePath: string,
  metadata: Record<string, string> | undefined,
): MemoryV2SourcePolicyResult {
  if (!sourcePath || !sourcePath.toLowerCase().endsWith('.md')) {
    return { ok: false, reason: 'source is not a markdown file' };
  }
  if (metadata?.schema !== MEMORY_V2_SCHEMA) {
    return { ok: false, reason: 'memory v2 schema is required' };
  }
  const scope = normalizeScope(metadata.memoryScope);
  if (!scope) return { ok: false, reason: 'memoryScope is missing or invalid' };

  const segments = relativeSegments(memoryRoot, sourcePath);
  if (segments[0] !== 'data' || segments[1] !== 'memory' || segments[2] !== 'v2') {
    return { ok: false, reason: 'source is outside data/memory/v2' };
  }

  if (scope === 'long_term') {
    if (segments[3] !== 'long-term' || segments.length < 5) {
      return { ok: false, reason: 'long-term memory must live under data/memory/v2/long-term' };
    }
    return { ok: true, scope, sourceGroup: sourceGroupForScope(scope) };
  }

  const channel = metadata.channelType?.trim();
  if (!channel) return { ok: false, reason: 'channelType is required for scoped memory' };
  const expectedChannel = memoryPartitionSegment(channel);

  if (scope === 'user') {
    const userId = metadata.userId?.trim();
    if (!userId) return { ok: false, reason: 'user memory requires userId' };
    if (segments[3] !== 'users' || segments[4] !== expectedChannel || segments[5] !== memoryPartitionSegment(userId) || segments.length < 7) {
      return { ok: false, reason: 'user memory path does not match channelType/userId metadata' };
    }
    return { ok: true, scope, sourceGroup: sourceGroupForScope(scope) };
  }

  const chatId = metadata.chatId?.trim();
  if (!chatId) return { ok: false, reason: 'group memory requires chatId' };
  if (segments[3] !== 'groups' || segments[4] !== expectedChannel || segments[5] !== memoryPartitionSegment(chatId) || segments.length < 7) {
    return { ok: false, reason: 'group memory path does not match channelType/chatId metadata' };
  }
  return { ok: true, scope, sourceGroup: sourceGroupForScope(scope) };
}

export function isIndexableMemoryV2SourceFile(memoryRoot: string, file: MemorySourceFileLike): boolean {
  return classifyMemoryV2Source(memoryRoot, file.path, parseMemorySourceFrontmatter(file.content)).ok;
}

export function isIndexableMemoryV2SourceItem(
  memoryRoot: string,
  sourcePath: string,
  metadata: Record<string, string> | undefined,
): boolean {
  return classifyMemoryV2Source(memoryRoot, sourcePath, metadata).ok;
}

export function isVisibleMemoryV2PathToQuery(
  memoryRoot: string,
  sourcePath: string,
  query: MemoryVisibilityQuery,
): boolean {
  const segments = relativeSegments(memoryRoot, sourcePath);
  if (segments[0] !== 'data' || segments[1] !== 'memory' || segments[2] !== 'v2') return false;
  if (segments[3] === 'long-term') return true;
  const expectedChannel = memoryPartitionSegment(query.channelType || 'unknown');
  if (segments[3] === 'users') {
    return !!query.userId
      && segments[4] === expectedChannel
      && segments[5] === memoryPartitionSegment(query.userId);
  }
  if (segments[3] === 'groups') {
    return !!query.chatId
      && segments[4] === expectedChannel
      && segments[5] === memoryPartitionSegment(query.chatId);
  }
  return false;
}

export function isVisibleMemoryV2SourceToQuery(
  memoryRoot: string,
  sourcePath: string,
  metadata: Record<string, string> | undefined,
  query: MemoryVisibilityQuery,
): boolean {
  const classification = classifyMemoryV2Source(memoryRoot, sourcePath, metadata);
  if (!classification.ok) return false;
  return isVisibleMemoryV2PathToQuery(memoryRoot, sourcePath, query);
}
