import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface WorkProfileEntryInput {
  workspaceId: string;
  workspaceLabel: string;
  key: string;
  content: string;
  timestamp: string;
  reason: string;
  evidenceIds: string[];
}

export interface WorkProfileUpsertResult {
  changed: boolean;
  key: string;
  contentHash: string;
}

interface WorkProfileEntry {
  key: string;
  content: string;
  contentHash: string;
  updatedAt: string;
}

const PROFILE_MARKER = '<!-- cti-work-profile:v2 -->';
const ENTRY_RE = /<!-- cti-work-profile-entry:start key="([^"]+)" contentHash="([a-f0-9]{64})" updatedAt="([^"]+)" -->\n([\s\S]*?)\n<!-- cti-work-profile-entry:end -->/gu;
const RECENT_CHANGE_LIMIT = 12;

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

export function normalizeWorkProfileKey(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80) || 'general';
}

function parseEntries(existing: string): Map<string, WorkProfileEntry> {
  const entries = new Map<string, WorkProfileEntry>();
  for (const match of existing.matchAll(ENTRY_RE)) {
    const body = match[4].replace(/^### .*?\n\n/u, '').trim();
    entries.set(match[1], {
      key: match[1],
      content: body,
      contentHash: match[2],
      updatedAt: match[3],
    });
  }
  return entries;
}

function parseRecentChanges(existing: string): string[] {
  const match = existing.match(/## 最近变更\n\n([\s\S]*?)(?:\n\n## |$)/u);
  return match ? match[1].split(/\r?\n/gu).map((line) => line.trim()).filter((line) => line.startsWith('- ')) : [];
}

function extractLegacy(existing: string): string {
  if (!existing.trim() || existing.includes(PROFILE_MARKER)) return '';
  return existing.trim();
}

function renderDocument(input: {
  workspaceId: string;
  workspaceLabel: string;
  entries: WorkProfileEntry[];
  recentChanges: string[];
  legacy: string;
}): string {
  const entryBlocks = input.entries
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((entry) => [
      `<!-- cti-work-profile-entry:start key="${entry.key}" contentHash="${entry.contentHash}" updatedAt="${entry.updatedAt}" -->`,
      `### ${entry.key}`,
      '',
      entry.content,
      '<!-- cti-work-profile-entry:end -->',
    ].join('\n'));
  const sections = [
    '# 工作档案',
    '',
    PROFILE_MARKER,
    '',
    `工作区：${input.workspaceLabel}`,
    `工作区标识：${input.workspaceId}`,
    '',
    '## 当前有效状态',
    '',
    entryBlocks.length > 0 ? entryBlocks.join('\n\n') : '暂无已验证状态。',
    '',
    '## 最近变更',
    '',
    input.recentChanges.length > 0 ? input.recentChanges.join('\n') : '暂无变更记录。',
  ];
  if (input.legacy) {
    sections.push('', '## 历史兼容记录', '', input.legacy);
  }
  return `${sections.join('\n').trimEnd()}\n`;
}

export function upsertWorkProfileEntry(filePath: string, input: WorkProfileEntryInput): WorkProfileUpsertResult {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const key = normalizeWorkProfileKey(input.key);
  const normalizedContent = input.content.trim();
  const nextHash = contentHash(normalizedContent);
  const entries = parseEntries(existing);
  const current = entries.get(key);
  if (current?.contentHash === nextHash) {
    return { changed: false, key, contentHash: nextHash };
  }
  entries.set(key, {
    key,
    content: normalizedContent,
    contentHash: nextHash,
    updatedAt: input.timestamp,
  });
  const reason = input.reason.replace(/\s+/gu, ' ').trim().slice(0, 180) || '已验证更新';
  const evidence = input.evidenceIds.slice(0, 6).join('、') || '未记录';
  const recentLine = `- ${input.timestamp} | \`${key}\` | ${nextHash.slice(0, 12)} | ${reason} | evidence: ${evidence}`;
  const recentChanges = [recentLine, ...parseRecentChanges(existing)]
    .filter((line, index, all) => all.indexOf(line) === index)
    .slice(0, RECENT_CHANGE_LIMIT);
  atomicWrite(filePath, renderDocument({
    workspaceId: input.workspaceId,
    workspaceLabel: input.workspaceLabel,
    entries: [...entries.values()],
    recentChanges,
    legacy: extractLegacy(existing),
  }));
  return { changed: true, key, contentHash: nextHash };
}
