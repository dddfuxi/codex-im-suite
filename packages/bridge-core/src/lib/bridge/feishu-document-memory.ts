import fs from 'node:fs';
import path from 'node:path';
import type { BridgeStore } from './host.js';

export interface FeishuDocumentMemoryEntry {
  id: string;
  title: string;
  url: string;
  documentId?: string;
  chatId: string;
  requesterId?: string;
  workspace?: string;
  sourceSummary?: string;
  tags: string[];
  imageCount: number;
  scenePaths: string[];
  permissionStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeishuDocumentMemoryInput {
  title: string;
  url: string;
  documentId?: string;
  chatId: string;
  requesterId?: string;
  workspace?: string;
  sourceText?: string;
  markdown?: string;
}

const DEFAULT_MEMORY_REPO_DIR = 'E:\\cli-md';
const INDEX_RELATIVE_PATH = path.join('data', 'documents', 'index.json');
const GUIDE_RELATIVE_PATH = path.join('data', 'documents', 'DOCUMENT_GUIDE.md');

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function writeText(filePath: string, text: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, filePath);
}

export function getFeishuDocumentMemoryRepoDir(store: Pick<BridgeStore, 'getSetting'>): string {
  return store.getSetting('bridge_memory_repo_dir')
    || process.env.CTI_MEMORY_REPO_DIR
    || DEFAULT_MEMORY_REPO_DIR;
}

export function getFeishuDocumentIndexPath(store: Pick<BridgeStore, 'getSetting'>): string {
  return path.join(getFeishuDocumentMemoryRepoDir(store), INDEX_RELATIVE_PATH);
}

export function getFeishuDocumentGuidePath(store: Pick<BridgeStore, 'getSetting'>): string {
  return path.join(getFeishuDocumentMemoryRepoDir(store), GUIDE_RELATIVE_PATH);
}

export function getFeishuDocumentGuideMetaPath(store: Pick<BridgeStore, 'getSetting'>): string {
  return path.join(getFeishuDocumentMemoryRepoDir(store), 'data', 'documents', 'guide-meta.json');
}

function compactText(text: string | undefined, maxLen: number): string {
  const cleaned = (text || '')
    .replace(/<!--files:[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 3)}...` : cleaned;
}

function extractTags(text: string): string[] {
  const tags = new Set<string>();
  const normalized = text.toLowerCase();
  const patterns = [
    [/unity|场景|scene|camera|previewcamera|timeline/i, 'Unity'],
    [/截图|image|图片|camera|previewcamera/i, '截图'],
    [/timeline|playabledirector|首帧/i, 'Timeline'],
    [/飞书|文档|docx/i, '飞书文档'],
    [/权限|owner|删除|delete|安全/i, '权限安全'],
  ] as const;
  for (const [pattern, tag] of patterns) {
    if (pattern.test(normalized)) tags.add(tag);
  }

  const codeLike = text.match(/\b[A-Za-z][A-Za-z0-9_./-]{3,}\b/g) || [];
  for (const token of codeLike.slice(0, 8)) {
    if (/^(http|https|docx|image|markdown)$/i.test(token)) continue;
    tags.add(token);
  }
  return Array.from(tags).slice(0, 12);
}

function extractScenePaths(text: string): string[] {
  const paths = new Set<string>();
  const matches = text.match(/[A-Za-z]:\\[^\r\n"'<>|?*]+\.unity\b/gi) || [];
  for (const match of matches) {
    paths.add(match.trim());
  }
  return Array.from(paths).slice(0, 12);
}

function countMarkdownImages(markdown: string | undefined): number {
  if (!markdown) return 0;
  return Array.from(markdown.matchAll(/!\[[^\]]*]\([^)]+\)/g)).length;
}

export function loadFeishuDocumentMemory(store: Pick<BridgeStore, 'getSetting'>): FeishuDocumentMemoryEntry[] {
  const filePath = getFeishuDocumentIndexPath(store);
  const raw = readJson<{ documents?: FeishuDocumentMemoryEntry[] }>(filePath, { documents: [] });
  return Array.isArray(raw.documents) ? raw.documents : [];
}

export function buildFeishuDocumentGuideMarkdown(entries: FeishuDocumentMemoryEntry[]): string {
  const sorted = [...entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const lines = [
    '# 飞书文档导览',
    '',
    '这份索引由飞书桥接自动维护，只记录文档摘要和入口，不保存完整聊天记录。',
    '',
  ];
  if (sorted.length === 0) {
    lines.push('暂无已记录的飞书文档。');
    return lines.join('\n');
  }

  for (const entry of sorted) {
    lines.push(`## ${entry.title}`);
    lines.push(`- 链接：${entry.url}`);
    lines.push(`- 更新时间：${entry.updatedAt}`);
    if (entry.workspace) lines.push(`- 工作区：${entry.workspace}`);
    if (entry.tags.length > 0) lines.push(`- 标签：${entry.tags.join('、')}`);
    if (entry.scenePaths.length > 0) lines.push(`- 相关场景：${entry.scenePaths.join('、')}`);
    if (entry.sourceSummary) lines.push(`- 摘要：${entry.sourceSummary}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

export function recordFeishuDocumentMemory(
  store: Pick<BridgeStore, 'getSetting'>,
  input: FeishuDocumentMemoryInput,
): FeishuDocumentMemoryEntry {
  const now = new Date().toISOString();
  const indexPath = getFeishuDocumentIndexPath(store);
  const existing = loadFeishuDocumentMemory(store);
  const sourceText = [input.sourceText, input.markdown].filter(Boolean).join('\n\n');
  const documentId = input.documentId || input.url.match(/\/docx\/([^/?#]+)/)?.[1] || undefined;
  const id = documentId || input.url;
  const previous = existing.find((entry) => entry.id === id || entry.url === input.url);
  const next: FeishuDocumentMemoryEntry = {
    id,
    title: input.title,
    url: input.url,
    documentId,
    chatId: input.chatId,
    requesterId: input.requesterId,
    workspace: input.workspace,
    sourceSummary: compactText(input.sourceText || input.markdown, 220),
    tags: extractTags(sourceText),
    imageCount: countMarkdownImages(input.markdown),
    scenePaths: extractScenePaths(sourceText),
    permissionStatus: previous?.permissionStatus || 'owner_or_editor_permission_best_effort',
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };

  const merged = [next, ...existing.filter((entry) => entry.id !== id && entry.url !== input.url)];
  writeJson(indexPath, { updatedAt: now, documents: merged });
  writeText(getFeishuDocumentGuidePath(store), buildFeishuDocumentGuideMarkdown(merged));
  return next;
}

export function renderFeishuDocumentMemoryList(
  store: Pick<BridgeStore, 'getSetting'>,
  limit = 12,
): string {
  const entries = loadFeishuDocumentMemory(store)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
  if (entries.length === 0) {
    return '还没有记录到机器人生成的飞书文档。';
  }

  const lines = [
    '已记录的飞书文档：',
    '',
  ];
  for (const entry of entries) {
    lines.push(`- ${entry.title}`);
    lines.push(`  ${entry.url}`);
    if (entry.sourceSummary) lines.push(`  摘要：${entry.sourceSummary}`);
  }
  return lines.join('\n');
}
