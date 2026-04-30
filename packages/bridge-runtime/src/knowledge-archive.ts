import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { rebuildKnowledgeIndex } from './knowledge-index-service.js';
import { readKnowledgeIndex, type KnowledgeItem } from './knowledge-indexer.js';
import { rebuildReminderIndexFromKnowledge } from './todo-reminders.js';

export interface KnowledgeArchiveInput {
  itemId: string;
  archivedAt?: string;
}

export interface KnowledgeArchiveResult {
  ok: boolean;
  itemId?: string;
  archivePath?: string;
  error?: string;
}

export interface KnowledgeArchiveListItem {
  id: string;
  itemId: string;
  kind: string;
  text: string;
  sourcePath: string;
  archivePath: string;
  archivedAt: string;
}

export interface KnowledgeArchiveList {
  archiveRoot: string;
  items: KnowledgeArchiveListItem[];
}

export interface KnowledgeArchiveDeleteInput {
  archivePath: string;
}

export function archiveKnowledgeItem(memoryRoot: string, input: KnowledgeArchiveInput): KnowledgeArchiveResult {
  const root = path.resolve(memoryRoot);
  const index = readKnowledgeIndex(root);
  const item = index?.items.find((candidate) => candidate.id === input.itemId);
  if (!item) return { ok: false, itemId: input.itemId, error: '未找到知识单元。' };

  const sourcePath = path.resolve(item.source.path);
  if (!isInside(root, sourcePath)) {
    return { ok: false, itemId: item.id, error: '源文件不在记忆仓库内，已拒绝归档。' };
  }
  if (!fs.existsSync(sourcePath)) {
    return { ok: false, itemId: item.id, error: '源文件不存在。' };
  }

  const content = fs.readFileSync(sourcePath, 'utf-8');
  const removal = removeItemLine(content, item);
  if (!removal.removed) {
    return { ok: false, itemId: item.id, error: '未能在源文件中精确匹配该知识单元。' };
  }

  const archivedAt = input.archivedAt || new Date().toISOString();
  const archivePath = makeArchivePath(root, item, archivedAt);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, formatArchiveMarkdown(item, removal.originalLine || item.source.snippet, archivedAt), 'utf-8');
  fs.writeFileSync(sourcePath, removal.content, 'utf-8');

  const status = rebuildKnowledgeIndex(root);
  if (status.lastError) {
    return { ok: false, itemId: item.id, archivePath, error: status.lastError };
  }
  const nextIndex = readKnowledgeIndex(root);
  if (nextIndex) {
    rebuildReminderIndexFromKnowledge(root, nextIndex);
  }
  return { ok: true, itemId: item.id, archivePath };
}

export function listKnowledgeArchives(memoryRoot: string): KnowledgeArchiveList {
  const archiveRoot = getKnowledgeArchiveRoot(memoryRoot);
  const items: KnowledgeArchiveListItem[] = [];
  if (!fs.existsSync(archiveRoot)) return { archiveRoot, items };
  for (const file of fs.readdirSync(archiveRoot)) {
    if (!file.toLowerCase().endsWith('.md')) continue;
    const archivePath = path.join(archiveRoot, file);
    try {
      const content = fs.readFileSync(archivePath, 'utf-8');
      const metadata = parseFrontmatter(content);
      items.push({
        id: path.basename(file, '.md'),
        itemId: metadata.itemId || '',
        kind: metadata.kind || '',
        text: metadata.text || '',
        sourcePath: metadata.sourcePath || '',
        archivePath,
        archivedAt: metadata.archivedAt || '',
      });
    } catch {
      // Ignore unreadable archive files; the panel can still open the folder.
    }
  }
  items.sort((left, right) => (right.archivedAt || '').localeCompare(left.archivedAt || ''));
  return { archiveRoot, items };
}

export function deleteKnowledgeArchive(memoryRoot: string, input: KnowledgeArchiveDeleteInput): KnowledgeArchiveResult {
  const archiveRoot = getKnowledgeArchiveRoot(memoryRoot);
  const archivePath = path.resolve(input.archivePath);
  if (!isInside(archiveRoot, archivePath)) {
    return { ok: false, archivePath, error: '归档文件不在知识归档目录内，已拒绝删除。' };
  }
  if (!fs.existsSync(archivePath)) {
    return { ok: false, archivePath, error: '归档文件不存在。' };
  }
  fs.unlinkSync(archivePath);
  return { ok: true, archivePath };
}

export function getKnowledgeArchiveRoot(memoryRoot: string): string {
  return path.join(path.resolve(memoryRoot), 'archive', 'knowledge-units');
}

function removeItemLine(content: string, item: KnowledgeItem): { removed: boolean; content: string; originalLine?: string } {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => lineMatchesItem(line, item));
  if (index < 0) return { removed: false, content };
  const originalLine = lines[index];
  lines.splice(index, 1);
  return { removed: true, content: lines.join(newline), originalLine };
}

function lineMatchesItem(line: string, item: KnowledgeItem): boolean {
  const normalizedLine = normalizeLine(line);
  const snippet = normalizeLine(item.source.snippet);
  if (snippet && normalizedLine === snippet) return true;
  if (item.key && item.value) {
    return normalizedLine.includes(normalizeLine(item.key)) && normalizedLine.includes(normalizeLine(item.value));
  }
  const text = normalizeLine(item.text);
  const value = normalizeLine(item.value || '');
  return (!!text && normalizedLine.includes(text)) || (!!value && normalizedLine.includes(value));
}

function normalizeLine(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*]\s+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeArchivePath(root: string, item: KnowledgeItem, archivedAt: string): string {
  const stamp = archivedAt.replace(/\D/g, '').slice(0, 14) || new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const suffix = crypto.createHash('sha1').update(`${item.id}:${archivedAt}`).digest('hex').slice(0, 8);
  return path.join(getKnowledgeArchiveRoot(root), `${stamp}-${item.kind}-${item.id.slice(0, 8)}-${suffix}.md`);
}

function formatArchiveMarkdown(item: KnowledgeItem, originalLine: string, archivedAt: string): string {
  return [
    '---',
    'schema: codex-im-suite/knowledge-archive/v1',
    `itemId: ${item.id}`,
    `kind: ${item.kind}`,
    `archivedAt: ${archivedAt}`,
    `sourcePath: ${item.source.path}`,
    `text: ${escapeFrontmatterValue(item.value || item.text)}`,
    '---',
    '',
    '# Archived knowledge unit',
    '',
    `Kind: ${item.kind}`,
    `Text: ${item.value || item.text}`,
    `Source: ${item.source.path}`,
    '',
    '```markdown',
    originalLine,
    '```',
    '',
  ].join('\n');
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) return {};
  const metadata: Record<string, string> = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const separator = rawLine.indexOf(':');
    if (separator <= 0) continue;
    metadata[rawLine.slice(0, separator).trim()] = rawLine.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return metadata;
}

function escapeFrontmatterValue(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
