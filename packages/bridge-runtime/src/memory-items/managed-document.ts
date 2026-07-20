import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  MEMORY_V3_SCHEMA,
  parseMemorySourceFrontmatter,
} from '../memory-source-policy.js';
import type {
  ManagedMemoryDocument,
  ManagedMemoryDocumentMetadata,
  ManagedMemoryDocumentStateV2,
  MemoryDocumentEntry,
  MemoryDocumentSourceKind,
  MemoryEvidenceEntry,
  MemoryItemStatus,
  VisibleMemoryScope,
} from './types.js';

const STATE_RE = /<!--\s*cti-memory-state:([^\s]+)\s*-->/u;
const VALID_SCOPES = new Set<VisibleMemoryScope>(['user', 'group', 'long_term']);
const VALID_SOURCE_KINDS = new Set<MemoryDocumentSourceKind>(['explicit', 'candidate_observation', 'migration']);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function memoryCandidateFingerprint(key: string, value: string): string {
  return sha256(`${normalizeMemoryLine(key, 120)}\n${normalizeMemoryLine(value, 500)}`);
}

export function normalizeMemoryLine(value: string, maxChars = 300): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxChars);
}

export function isSensitiveMemoryObservation(value: string): boolean {
  const normalized = normalizeMemoryLine(value, 1000);
  return /(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|passwd|secret|验证码|口令|密码|密钥|token\s*(?:是|为|:|：|=)|身份证|精确住址|银行卡)/iu.test(normalized);
}

export function emptyManagedMemoryState(): ManagedMemoryDocumentStateV2 {
  return {
    version: 2,
    confirmed: {},
    candidates: {},
    evidence: [],
    deletedCandidateFingerprints: {},
  };
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizeMemoryLine(item, 200))
    .filter(Boolean)));
  return items.length > 0 ? items : undefined;
}

function normalizeEntry(
  value: unknown,
  status: MemoryItemStatus,
  fallbackSourceKind: MemoryDocumentSourceKind,
): MemoryDocumentEntry | null {
  if (!isRecord(value)) return null;
  const normalizedValue = normalizeMemoryLine(typeof value.value === 'string' ? value.value : '', 500);
  if (!normalizedValue) return null;
  const rawConfidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence)
    ? value.confidence
    : status === 'confirmed' ? 1 : 0.55;
  const sourceKind = typeof value.sourceKind === 'string' && VALID_SOURCE_KINDS.has(value.sourceKind as MemoryDocumentSourceKind)
    ? value.sourceKind as MemoryDocumentSourceKind
    : fallbackSourceKind;
  const distinctSessionCount = typeof value.distinctSessionCount === 'number' && Number.isInteger(value.distinctSessionCount)
    ? Math.max(0, value.distinctSessionCount)
    : undefined;
  const sessionIds = normalizeStringArray(value.sessionIds);
  const sourceMessageHashes = normalizeStringArray(value.sourceMessageHashes);
  return {
    value: normalizedValue,
    updatedAt: normalizeMemoryLine(typeof value.updatedAt === 'string' ? value.updatedAt : '', 80),
    confidence: Math.max(0, Math.min(1, rawConfidence)),
    status,
    sourceKind,
    ...(typeof value.candidateFingerprint === 'string' && value.candidateFingerprint.trim()
      ? { candidateFingerprint: normalizeMemoryLine(value.candidateFingerprint, 128) }
      : {}),
    ...(distinctSessionCount === undefined ? {} : { distinctSessionCount }),
    ...(typeof value.lastEvidenceAt === 'string' && value.lastEvidenceAt.trim()
      ? { lastEvidenceAt: normalizeMemoryLine(value.lastEvidenceAt, 80) }
      : {}),
    ...(sessionIds ? { sessionIds } : {}),
    ...(sourceMessageHashes ? { sourceMessageHashes } : {}),
  };
}

function normalizeEntries(
  value: unknown,
  status: MemoryItemStatus,
  fallbackSourceKind: MemoryDocumentSourceKind,
): Record<string, MemoryDocumentEntry> {
  if (!isRecord(value)) return {};
  const entries: Record<string, MemoryDocumentEntry> = {};
  for (const [rawKey, rawEntry] of Object.entries(value)) {
    const key = normalizeMemoryLine(rawKey, 120);
    const entry = normalizeEntry(rawEntry, status, fallbackSourceKind);
    if (key && entry) {
      if (status === 'candidate' && !entry.candidateFingerprint) {
        entry.candidateFingerprint = memoryCandidateFingerprint(key, entry.value);
      }
      entries[key] = entry;
    }
  }
  return entries;
}

function normalizeEvidence(value: unknown): MemoryEvidenceEntry[] {
  if (!Array.isArray(value)) return [];
  const evidence: MemoryEvidenceEntry[] = [];
  for (const rawEntry of value) {
    if (!isRecord(rawEntry)) continue;
    const text = typeof rawEntry.text === 'string' ? normalizeMemoryLine(rawEntry.text, 500) : '';
    const textHash = typeof rawEntry.textHash === 'string' && rawEntry.textHash.trim()
      ? normalizeMemoryLine(rawEntry.textHash, 128)
      : text ? sha256(text) : '';
    const createdAt = typeof rawEntry.createdAt === 'string'
      ? normalizeMemoryLine(rawEntry.createdAt, 80)
      : '';
    if (!textHash || !createdAt) continue;
    evidence.push({
      ...(text ? { text } : {}),
      textHash,
      createdAt,
      ...(typeof rawEntry.sessionId === 'string' && rawEntry.sessionId.trim()
        ? { sessionId: normalizeMemoryLine(rawEntry.sessionId, 200) }
        : {}),
    });
  }
  return evidence.slice(-50);
}

function normalizeDeletedFingerprints(value: unknown): Record<string, { deletedAt: string }> {
  if (!isRecord(value)) return {};
  const result: Record<string, { deletedAt: string }> = {};
  for (const [rawFingerprint, rawEntry] of Object.entries(value)) {
    if (!isRecord(rawEntry) || typeof rawEntry.deletedAt !== 'string') continue;
    const fingerprint = normalizeMemoryLine(rawFingerprint, 128);
    const deletedAt = normalizeMemoryLine(rawEntry.deletedAt, 80);
    if (fingerprint && deletedAt) result[fingerprint] = { deletedAt };
  }
  return result;
}

export function upgradeManagedMemoryState(value: unknown): ManagedMemoryDocumentStateV2 {
  if (!isRecord(value)) return emptyManagedMemoryState();
  if (value.version === 2) {
    return {
      version: 2,
      confirmed: normalizeEntries(value.confirmed, 'confirmed', 'explicit'),
      candidates: normalizeEntries(value.candidates, 'candidate', 'candidate_observation'),
      evidence: normalizeEvidence(value.evidence),
      deletedCandidateFingerprints: normalizeDeletedFingerprints(value.deletedCandidateFingerprints),
    };
  }
  return {
    version: 2,
    confirmed: normalizeEntries(value.confirmed, 'confirmed', 'explicit'),
    candidates: normalizeEntries(value.tentative, 'candidate', 'migration'),
    evidence: normalizeEvidence(value.evidence),
    deletedCandidateFingerprints: {},
  };
}

export function tryReadManagedStateFromContent(content: string): ManagedMemoryDocumentStateV2 | null {
  const match = content.match(STATE_RE);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    return upgradeManagedMemoryState(JSON.parse(decoded));
  } catch (error) {
    throw new Error('managed memory state is invalid', { cause: error });
  }
}

function metadataFromContent(content: string): ManagedMemoryDocumentMetadata {
  const frontmatter = parseMemorySourceFrontmatter(content) || {};
  const scope = VALID_SCOPES.has(frontmatter.memoryScope as VisibleMemoryScope)
    ? frontmatter.memoryScope as VisibleMemoryScope
    : null;
  const scopedIdentityMissing = scope === 'user'
    ? !frontmatter.channelType || !frontmatter.userId
    : scope === 'group'
      ? !frontmatter.channelType || !frontmatter.chatId
      : false;
  if (frontmatter.schema !== MEMORY_V3_SCHEMA || !scope || scopedIdentityMissing) {
    throw new Error('managed memory metadata is invalid');
  }
  return {
    schema: MEMORY_V3_SCHEMA,
    scope,
    ...(frontmatter.channelType ? { channelType: frontmatter.channelType } : {}),
    ...(frontmatter.userId ? { userId: frontmatter.userId } : {}),
    ...(frontmatter.chatId ? { chatId: frontmatter.chatId } : {}),
    ...(frontmatter.displayName ? { displayName: frontmatter.displayName } : {}),
    updatedAt: frontmatter.updatedAt || '',
  };
}

export function createManagedMemoryDocument(
  filePath: string,
  metadata: ManagedMemoryDocumentMetadata,
  state: ManagedMemoryDocumentStateV2 = emptyManagedMemoryState(),
): ManagedMemoryDocument {
  return {
    filePath: path.resolve(filePath),
    content: '',
    baseHash: sha256(''),
    metadata,
    state,
  };
}

export function readManagedMemoryDocument(filePath: string): ManagedMemoryDocument {
  const resolvedPath = path.resolve(filePath);
  const content = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, 'utf8') : '';
  return {
    filePath: resolvedPath,
    content,
    baseHash: sha256(content),
    metadata: metadataFromContent(content),
    state: tryReadManagedStateFromContent(content) || emptyManagedMemoryState(),
  };
}

function yamlValue(value: string | undefined): string {
  return `"${normalizeMemoryLine(value || '', 500).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

function escapeTableCell(value: string): string {
  return normalizeMemoryLine(value).replace(/\|/gu, '\\|');
}

function renderTable(entries: Record<string, MemoryDocumentEntry>): string[] {
  const rows = Object.entries(entries).sort(([left], [right]) => left.localeCompare(right, 'zh-CN'));
  if (rows.length === 0) return ['暂无。'];
  return [
    '| key | value | 置信度 | 更新时间 |',
    '| --- | --- | --- | --- |',
    ...rows.map(([key, entry]) => `| ${escapeTableCell(key)} | ${escapeTableCell(entry.value)} | ${Math.round(entry.confidence * 100)}% | ${entry.updatedAt} |`),
  ];
}

function documentTitle(metadata: ManagedMemoryDocumentMetadata): string {
  if (metadata.scope === 'user') return `用户印象：${normalizeMemoryLine(metadata.displayName || '未命名用户')}`;
  if (metadata.scope === 'group') return `群聊记忆：${normalizeMemoryLine(metadata.displayName || '未命名群聊')}`;
  return '公共长期记忆';
}

function encodeState(state: ManagedMemoryDocumentStateV2): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
}

export function renderManagedMemoryDocument(document: ManagedMemoryDocument): string {
  const { metadata, state } = document;
  const channelType = metadata.scope === 'long_term' ? undefined : metadata.channelType;
  const userId = metadata.scope === 'user' ? metadata.userId : undefined;
  const chatId = metadata.scope === 'group' ? metadata.chatId : undefined;
  const displayName = metadata.scope === 'long_term' ? undefined : metadata.displayName;
  const frontmatter = [
    '---',
    `schema: ${MEMORY_V3_SCHEMA}`,
    `memoryScope: ${metadata.scope}`,
    ...(channelType ? [`channelType: ${yamlValue(channelType)}`] : []),
    ...(chatId ? [`chatId: ${yamlValue(chatId)}`] : []),
    ...(userId ? [`userId: ${yamlValue(userId)}`] : []),
    ...(displayName ? [`displayName: ${yamlValue(displayName)}`] : []),
    `updatedAt: ${metadata.updatedAt}`,
    '---',
  ];
  const evidence = state.evidence.slice(-30);
  return [
    ...frontmatter,
    '',
    `<!-- cti-memory-state:${encodeState(state)} -->`,
    '',
    `# ${documentTitle(metadata)}`,
    '',
    '## 身份与称呼',
    '',
    displayName
      ? `- 显示名：${normalizeMemoryLine(displayName)}`
      : metadata.scope === 'long_term'
        ? '公共分区，不绑定单个用户或群聊。'
        : '暂无。',
    '',
    '## 沟通偏好',
    '',
    '由“已确认事实”和“候选记忆”中的相关条目提供。',
    '',
    '## 工作偏好',
    '',
    '由“已确认事实”和“候选记忆”中的相关条目提供。',
    '',
    '## 已确认事实',
    '',
    ...renderTable(state.confirmed),
    '',
    '## 候选记忆（不参与索引）',
    '',
    ...renderTable(state.candidates),
    '',
    '## 当前关注',
    '',
    '暂无。',
    '',
    '## 待跟进事项',
    '',
    '暂无。',
    '',
    '## 证据与更新时间',
    '',
    ...(evidence.length > 0
      ? evidence.map((item) => item.text
        ? `- ${item.createdAt}：${normalizeMemoryLine(item.text)}`
        : `- ${item.createdAt}：已记录脱敏证据。`)
      : ['暂无。']),
    '',
  ].join('\n');
}

export function writeManagedMemoryDocument(
  document: ManagedMemoryDocument,
  expectedBaseHash: string,
): void {
  const current = fs.existsSync(document.filePath) ? fs.readFileSync(document.filePath, 'utf8') : '';
  if (sha256(current) !== expectedBaseHash) {
    throw new Error('managed memory source changed; refresh required');
  }
  const content = renderManagedMemoryDocument(document);
  fs.mkdirSync(path.dirname(document.filePath), { recursive: true });
  const tempPath = `${document.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, document.filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
  document.content = content;
  document.baseHash = sha256(content);
}
