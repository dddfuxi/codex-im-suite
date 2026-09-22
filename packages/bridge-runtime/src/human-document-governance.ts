import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { ensureMarkdownTitle, upsertManagedMarkdownBlock } from './human-readable-markdown.js';

export const AGENT_HOME_DOCUMENT_NAMES = [
  '机器人身份.md',
  '行为与安全规则.md',
  '工具与环境.md',
  '记忆总索引.md',
  '记忆库说明.md',
] as const;

const GOVERNANCE_START = '<!-- cti-human-document-governance:start -->';
const GOVERNANCE_END = '<!-- cti-human-document-governance:end -->';

export interface HumanReadableDocumentEntry {
  relativePath: string;
  absolutePath: string;
  status: 'managed' | 'unclassified' | 'archived';
}

export interface HumanReadableDocumentInventory {
  root: string;
  managed: HumanReadableDocumentEntry[];
  unclassified: HumanReadableDocumentEntry[];
  archived: HumanReadableDocumentEntry[];
}

interface HumanDocumentArchiveEntry {
  originalRelativePath: string;
  archivedRelativePath: string;
  sha256: string;
}

interface HumanDocumentArchiveManifest {
  schema: 'codex-im-suite/human-document-archive/v1';
  archivedAt: string;
  entries: HumanDocumentArchiveEntry[];
}

function normalizeRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).replace(/\\/gu, '/');
}

function resolveInside(root: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (!normalized || path.isAbsolute(normalized)) throw new Error(`文档路径无效：${relativePath}`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`文档路径越界：${relativePath}`);
  }
  return resolved;
}

function isInsideDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listMarkdown(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(fullPath);
    }
  };
  visit(directory);
  return files;
}

function sortEntries(entries: HumanReadableDocumentEntry[]): HumanReadableDocumentEntry[] {
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN'));
}

export function scanHumanReadableDocuments(memoryRoot: string): HumanReadableDocumentInventory {
  const root = path.resolve(memoryRoot);
  const managed = AGENT_HOME_DOCUMENT_NAMES.map((name) => ({
    relativePath: name,
    absolutePath: path.join(root, name),
    status: 'managed' as const,
  }));
  const managedNames = new Set<string>(AGENT_HOME_DOCUMENT_NAMES.map((name) => name.toLowerCase()));
  const unclassifiedPaths: string[] = [];
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      if (!managedNames.has(entry.name.toLowerCase())) unclassifiedPaths.push(path.join(root, entry.name));
    }
  }
  unclassifiedPaths.push(...listMarkdown(path.join(root, 'docs')));
  const archivedPaths = listMarkdown(path.join(root, 'archive', 'human-documents'));
  return {
    root,
    managed,
    unclassified: sortEntries(unclassifiedPaths.map((absolutePath) => ({
      relativePath: normalizeRelative(root, absolutePath),
      absolutePath,
      status: 'unclassified' as const,
    }))),
    archived: sortEntries(archivedPaths.map((absolutePath) => ({
      relativePath: normalizeRelative(root, absolutePath),
      absolutePath,
      status: 'archived' as const,
    }))),
  };
}

function renderPathList(entries: HumanReadableDocumentEntry[], emptyText: string): string[] {
  return entries.length > 0
    ? entries.map((item) => `- \`${item.relativePath}\``)
    : [`- ${emptyText}`];
}

export function buildHumanDocumentGovernanceBlock(inventory: HumanReadableDocumentInventory): string {
  return [
    GOVERNANCE_START,
    '## 人类阅读文档治理',
    '',
    '- 固定入口由 runtime 受控自更新；只替换机器拥有的稳定区块，保留用户手写正文。',
    '- 未归类文档不会自动进入 Prompt、索引、迁移或工作区，只作为待整理入口展示。',
    '- 已归档文档保留原始文件，不作为当前事实；需要时可依据归档清单还原。',
    '',
    '### 受控自更新入口',
    '',
    ...renderPathList(inventory.managed, '暂无。'),
    '',
    '### 未归类文档',
    '',
    ...renderPathList(inventory.unclassified, '暂无。'),
    '',
    '### 已归档人类文档',
    '',
    ...renderPathList(inventory.archived, '暂无。'),
    GOVERNANCE_END,
  ].join('\n');
}

export function refreshHumanDocumentGovernanceProjection(memoryRoot: string): {
  changed: boolean;
  guidePath: string;
  inventory: HumanReadableDocumentInventory;
} {
  const inventory = scanHumanReadableDocuments(memoryRoot);
  const guidePath = path.join(inventory.root, '记忆库说明.md');
  const existing = fs.existsSync(guidePath) ? fs.readFileSync(guidePath, 'utf8') : '# 记忆库说明\n';
  const next = upsertManagedMarkdownBlock(
    ensureMarkdownTitle(existing, '# 记忆库说明'),
    GOVERNANCE_START,
    GOVERNANCE_END,
    buildHumanDocumentGovernanceBlock(inventory),
  );
  if (next === existing) return { changed: false, guidePath, inventory };
  fs.mkdirSync(path.dirname(guidePath), { recursive: true });
  const tempPath = `${guidePath}.tmp`;
  fs.writeFileSync(tempPath, next, 'utf8');
  fs.renameSync(tempPath, guidePath);
  return { changed: true, guidePath, inventory };
}

export function archiveHumanReadableDocuments(
  memoryRoot: string,
  relativePaths: string[],
  now = new Date(),
): { manifestPath: string; entries: HumanDocumentArchiveEntry[] } {
  const root = path.resolve(memoryRoot);
  const managed = new Set<string>(AGENT_HOME_DOCUMENT_NAMES.map((name) => name.toLowerCase()));
  const requested = [...new Set(relativePaths.map((item) => item.replace(/\\/gu, '/').replace(/^\.\//u, '')))];
  if (requested.length === 0) throw new Error('没有可归档的人类文档。');
  const batchId = now.toISOString().replace(/[-:.]/gu, '');
  const batchRoot = path.join(root, 'archive', 'human-documents', batchId);
  const entries = requested.map((originalRelativePath) => {
    if (managed.has(originalRelativePath.toLowerCase())) {
      throw new Error(`固定入口禁止归档：${originalRelativePath}`);
    }
    if (originalRelativePath.toLowerCase().startsWith('archive/human-documents/')) {
      throw new Error(`文档已位于归档区：${originalRelativePath}`);
    }
    const sourcePath = resolveInside(root, originalRelativePath);
    if (!sourcePath.toLowerCase().endsWith('.md') || !fs.existsSync(sourcePath) || !fs.lstatSync(sourcePath).isFile()) {
      throw new Error(`只能归档真实 Markdown 文件：${originalRelativePath}`);
    }
    const archivedPath = path.join(batchRoot, originalRelativePath);
    return {
      sourcePath,
      archivedPath,
      entry: {
        originalRelativePath,
        archivedRelativePath: normalizeRelative(root, archivedPath),
        sha256: sha256(sourcePath),
      },
    };
  });
  const moved: typeof entries = [];
  const manifestPath = path.join(batchRoot, '归档清单.json');
  try {
    for (const item of entries) {
      fs.mkdirSync(path.dirname(item.archivedPath), { recursive: true });
      if (fs.existsSync(item.archivedPath)) throw new Error(`归档目标已存在：${item.entry.archivedRelativePath}`);
      fs.renameSync(item.sourcePath, item.archivedPath);
      moved.push(item);
    }
    const manifest: HumanDocumentArchiveManifest = {
      schema: 'codex-im-suite/human-document-archive/v1',
      archivedAt: now.toISOString(),
      entries: entries.map((item) => item.entry),
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    refreshHumanDocumentGovernanceProjection(root);
    return { manifestPath, entries: manifest.entries };
  } catch (error) {
    for (const item of moved.reverse()) {
      try {
        fs.mkdirSync(path.dirname(item.sourcePath), { recursive: true });
        if (fs.existsSync(item.archivedPath) && !fs.existsSync(item.sourcePath)) fs.renameSync(item.archivedPath, item.sourcePath);
      } catch {
        // 上层会报告原始错误；现场残留仍由 manifest/hash 审计，不静默覆盖源文件。
      }
    }
    try { fs.rmSync(batchRoot, { recursive: true, force: true }); } catch { /* 保留原错误 */ }
    throw error;
  }
}

export function restoreArchivedHumanDocument(
  memoryRoot: string,
  manifestPath: string,
  originalRelativePath: string,
): { restored: boolean; path: string } {
  const root = path.resolve(memoryRoot);
  const resolvedManifest = resolveInside(root, normalizeRelative(root, path.resolve(manifestPath)));
  const archiveRoot = path.join(root, 'archive', 'human-documents');
  if (!normalizeRelative(root, resolvedManifest).toLowerCase().startsWith('archive/human-documents/')) {
    throw new Error('归档清单不在受控人类文档归档区。');
  }
  const manifest = JSON.parse(fs.readFileSync(resolvedManifest, 'utf8')) as HumanDocumentArchiveManifest;
  if (manifest.schema !== 'codex-im-suite/human-document-archive/v1') throw new Error('人类文档归档清单版本无效。');
  const entry = manifest.entries.find((item) => item.originalRelativePath === originalRelativePath);
  if (!entry) throw new Error(`归档清单中不存在：${originalRelativePath}`);
  const archivedPath = resolveInside(root, entry.archivedRelativePath);
  const destinationPath = resolveInside(root, entry.originalRelativePath);
  if (!isInsideDirectory(archiveRoot, archivedPath)) throw new Error('归档文件路径越界。');
  if (!fs.existsSync(archivedPath) || sha256(archivedPath) !== entry.sha256) throw new Error('归档文件缺失或 Hash 不匹配。');
  if (fs.existsSync(destinationPath)) throw new Error(`还原目标已存在：${entry.originalRelativePath}`);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.renameSync(archivedPath, destinationPath);
  try {
    refreshHumanDocumentGovernanceProjection(root);
    return { restored: true, path: destinationPath };
  } catch (error) {
    fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
    if (fs.existsSync(destinationPath) && !fs.existsSync(archivedPath)) fs.renameSync(destinationPath, archivedPath);
    throw error;
  }
}
