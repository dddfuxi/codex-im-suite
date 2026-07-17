import crypto from 'node:crypto';
import path from 'node:path';

export const MEMORY_V2_SCHEMA = 'codex-im-suite/memory/v2';
export const MEMORY_V2_RELATIVE_DIR = path.join('data', 'memory', 'v2');
export const MEMORY_V3_SCHEMA = 'codex-im-suite/memory/v3';
export const MEMORY_V3_RELATIVE_DIR = 'memory';

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
  layoutVersion?: 'v2' | 'v3';
  legacy?: boolean;
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
  const layoutVersion = metadata?.schema === MEMORY_V3_SCHEMA
    ? 'v3'
    : metadata?.schema === MEMORY_V2_SCHEMA
      ? 'v2'
      : null;
  if (!layoutVersion) return { ok: false, reason: 'supported memory schema is required' };
  const sourceMetadata = metadata || {};
  const scope = normalizeScope(sourceMetadata.memoryScope);
  if (!scope) return { ok: false, reason: 'memoryScope is missing or invalid' };

  const segments = relativeSegments(memoryRoot, sourcePath);
  const layoutOffset = layoutVersion === 'v3' ? 1 : 3;
  if (layoutVersion === 'v3' && segments[0] !== 'memory') {
    return { ok: false, reason: 'v3 source is outside memory' };
  }
  if (layoutVersion === 'v2' && (segments[0] !== 'data' || segments[1] !== 'memory' || segments[2] !== 'v2')) {
    return { ok: false, reason: 'v2 source is outside data/memory/v2' };
  }

  if (scope === 'long_term') {
    if (segments[layoutOffset] !== 'long-term' || segments.length < layoutOffset + 2) {
      return { ok: false, reason: `long-term memory must live under ${layoutVersion === 'v3' ? 'memory/long-term' : 'data/memory/v2/long-term'}` };
    }
    return { ok: true, scope, sourceGroup: sourceGroupForScope(scope), layoutVersion, legacy: layoutVersion === 'v2' };
  }

  const channel = sourceMetadata.channelType?.trim();
  if (!channel) return { ok: false, reason: 'channelType is required for scoped memory' };
  const expectedChannel = memoryPartitionSegment(channel);

  if (scope === 'user') {
    const userId = sourceMetadata.userId?.trim();
    if (!userId) return { ok: false, reason: 'user memory requires userId' };
    if (
      segments[layoutOffset] !== 'users'
      || segments[layoutOffset + 1] !== expectedChannel
      || segments[layoutOffset + 2] !== memoryPartitionSegment(userId)
      || segments.length < layoutOffset + 4
    ) {
      return { ok: false, reason: 'user memory path does not match channelType/userId metadata' };
    }
    return { ok: true, scope, sourceGroup: sourceGroupForScope(scope), layoutVersion, legacy: layoutVersion === 'v2' };
  }

  const chatId = sourceMetadata.chatId?.trim();
  if (!chatId) return { ok: false, reason: 'group memory requires chatId' };
  if (
    segments[layoutOffset] !== 'groups'
    || segments[layoutOffset + 1] !== expectedChannel
    || segments[layoutOffset + 2] !== memoryPartitionSegment(chatId)
    || segments.length < layoutOffset + 4
  ) {
    return { ok: false, reason: 'group memory path does not match channelType/chatId metadata' };
  }
  return { ok: true, scope, sourceGroup: sourceGroupForScope(scope), layoutVersion, legacy: layoutVersion === 'v2' };
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
  const isV3 = segments[0] === 'memory';
  const isV2 = segments[0] === 'data' && segments[1] === 'memory' && segments[2] === 'v2';
  if (!isV3 && !isV2) return false;
  const offset = isV3 ? 1 : 3;
  if (segments[offset] === 'long-term') return true;
  const expectedChannel = memoryPartitionSegment(query.channelType || 'unknown');
  if (segments[offset] === 'users') {
    return !!query.userId
      && segments[offset + 1] === expectedChannel
      && segments[offset + 2] === memoryPartitionSegment(query.userId);
  }
  if (segments[offset] === 'groups') {
    return !!query.chatId
      && segments[offset + 1] === expectedChannel
      && segments[offset + 2] === memoryPartitionSegment(query.chatId);
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
