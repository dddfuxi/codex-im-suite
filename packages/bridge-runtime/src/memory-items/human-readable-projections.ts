import path from 'node:path';

import type {
  ManagedMemoryDocument,
  MemoryItemArchive,
} from './types.js';
import {
  MEMORY_INDEX_BLOCK_END,
  MEMORY_INDEX_BLOCK_START,
  upsertManagedMarkdownBlock,
  upsertMemoryIndexManagedBlock,
} from '../human-readable-markdown.js';

export interface ProjectionFile {
  path: string;
  content: string;
  kind: 'master_index' | 'memory_guide' | 'archive_index';
}

export interface MemoryHumanReadableSnapshot {
  memoryRoot: string;
  documents: ManagedMemoryDocument[];
  archives: MemoryItemArchive[];
  generatedAt: string;
  existingMasterIndexContent?: string;
  existingGuideContent?: string;
}

const GUIDE_BLOCK_START = '<!-- cti-memory-layout:start -->';
const GUIDE_BLOCK_END = '<!-- cti-memory-layout:end -->';

function relativePath(memoryRoot: string, filePath: string): string {
  return path.relative(path.resolve(memoryRoot), path.resolve(filePath)).replace(/\\/gu, '/');
}

function renderMasterIndex(snapshot: MemoryHumanReadableSnapshot): string {
  const archivesBySource = new Map<string, number>();
  for (const archive of snapshot.archives) {
    archivesBySource.set(archive.sourceRelativePath, (archivesBySource.get(archive.sourceRelativePath) || 0) + 1);
  }
  const sources = snapshot.documents
    .slice()
    .sort((left, right) => relativePath(snapshot.memoryRoot, left.filePath).localeCompare(relativePath(snapshot.memoryRoot, right.filePath), 'zh-CN'))
    .map((document) => {
      const source = relativePath(snapshot.memoryRoot, document.filePath);
      const confirmed = Object.keys(document.state.confirmed).length;
      const candidates = Object.keys(document.state.candidates).length;
      const archived = archivesBySource.get(source) || 0;
      const label = document.metadata.displayName || path.basename(document.filePath, path.extname(document.filePath));
      return {
        scope: document.metadata.scope,
        line: `- ${label} → \`${source}\`（已确认 ${confirmed} / 候选 ${candidates} / 已归档 ${archived} / 兼容项 0；更新：${document.metadata.updatedAt || '未知'}）`,
      };
    });
  const renderSection = (title: string, scope: ManagedMemoryDocument['metadata']['scope']): string[] => {
    const lines = sources.filter((source) => source.scope === scope).map((source) => source.line);
    return [`## ${title}`, '', ...(lines.length > 0 ? lines : ['暂无。']), ''];
  };
  const confirmedCount = snapshot.documents.reduce((total, document) => total + Object.keys(document.state.confirmed).length, 0);
  const candidateCount = snapshot.documents.reduce((total, document) => total + Object.keys(document.state.candidates).length, 0);
  return [
    MEMORY_INDEX_BLOCK_START,
    `生成时间：${snapshot.generatedAt}`,
    '',
    '本文件只保存真实源文件链接、状态计数和更新时间，不复制具体事实，不是第二事实源。',
    '',
    `总计：已确认 ${confirmedCount} / 候选 ${candidateCount} / 已归档 ${snapshot.archives.length}`,
    '',
    ...renderSection('用户印象', 'user'),
    ...renderSection('群聊记忆', 'group'),
    ...renderSection('公共长期记忆', 'long_term'),
    '## 待迁移旧记忆',
    '',
    '暂无。',
    '',
    '## 归档入口',
    '',
    '- `archive/memory-items/记忆归档索引.md`：查看可还原项目。',
    MEMORY_INDEX_BLOCK_END,
  ].join('\n');
}

function updateMasterIndex(snapshot: MemoryHumanReadableSnapshot): string {
  return upsertMemoryIndexManagedBlock(snapshot.existingMasterIndexContent || '', renderMasterIndex(snapshot));
}

function renderGuideManagedBlock(snapshot: MemoryHumanReadableSnapshot): string {
  const confirmedCount = snapshot.documents.reduce((total, document) => total + Object.keys(document.state.confirmed).length, 0);
  const candidateCount = snapshot.documents.reduce((total, document) => total + Object.keys(document.state.candidates).length, 0);
  return [
    GUIDE_BLOCK_START,
    '## 当前布局与状态',
    '',
    '- 生命周期：已确认 → 已归档 → 可还原；候选可确认或归档。',
    '- 主知识索引只读取已确认项；候选和归档不进入默认检索或 Prompt。',
    '- 永久删除只允许已归档项，并写入 tombstone 防止自动复活。',
    `- 当前计数：已确认：${confirmedCount}；候选：${candidateCount}；已归档：${snapshot.archives.length}。`,
    `- 最近同步：${snapshot.generatedAt}。`,
    GUIDE_BLOCK_END,
  ].join('\n');
}

function updateGuide(snapshot: MemoryHumanReadableSnapshot): string {
  const existing = snapshot.existingGuideContent?.trimEnd() || [
    '# 记忆库说明',
    '',
    '- `memory/users/<channel>/<userId>/用户印象.md`：用户分区。',
    '- `memory/groups/<channel>/<chatId>/群聊记忆.md`：群聊分区。',
    '- `memory/long-term/公共长期记忆.md`：公共长期分区。',
  ].join('\n');
  const block = renderGuideManagedBlock(snapshot);
  const start = existing.indexOf(GUIDE_BLOCK_START);
  const end = existing.indexOf(GUIDE_BLOCK_END);
  if (start >= 0 && end >= start) {
    return `${existing.slice(0, start).trimEnd()}\n\n${block}${existing.slice(end + GUIDE_BLOCK_END.length)}`.trimEnd() + '\n';
  }
  return `${existing}\n\n${block}\n`;
}

function renderArchiveIndex(snapshot: MemoryHumanReadableSnapshot): string {
  const lines = snapshot.archives
    .slice()
    .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt))
    .map((archive) => `- 可还原：${archive.key}（原状态：${archive.previousStatus === 'confirmed' ? '已确认' : '候选'}；来源：\`${archive.sourceRelativePath}\`；归档：${archive.archivedAt}；ID：\`${archive.archiveId}\`）`);
  return [
    '# 记忆归档索引',
    '',
    `生成时间：${snapshot.generatedAt}`,
    '',
    '本文件只列可还原项目和真实来源，不保存完整聊天证据、删除审计或敏感身份字段。',
    '',
    ...(lines.length > 0 ? lines : ['暂无可还原项目。']),
    '',
  ].join('\n');
}

export function buildMemoryHumanReadableProjections(snapshot: MemoryHumanReadableSnapshot): ProjectionFile[] {
  const root = path.resolve(snapshot.memoryRoot);
  return [
    {
      path: path.join(root, '记忆总索引.md'),
      content: updateMasterIndex(snapshot),
      kind: 'master_index',
    },
    {
      path: path.join(root, '记忆库说明.md'),
      content: updateGuide(snapshot),
      kind: 'memory_guide',
    },
    {
      path: path.join(root, 'archive', 'memory-items', '记忆归档索引.md'),
      content: renderArchiveIndex(snapshot),
      kind: 'archive_index',
    },
  ];
}
