import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { MEMORY_V3_SCHEMA, memoryPartitionSegment } from './memory-source-policy.js';

export type VisibleMemoryScope = 'user' | 'group' | 'long_term';

interface MemoryDocumentEntry {
  value: string;
  updatedAt: string;
  confidence: number;
}

interface MemoryEvidenceEntry {
  text: string;
  createdAt: string;
}

interface ManagedMemoryDocumentState {
  version: 1;
  confirmed: Record<string, MemoryDocumentEntry>;
  tentative: Record<string, MemoryDocumentEntry>;
  evidence: MemoryEvidenceEntry[];
}

export interface ConfirmedMemoryDocumentInput {
  memoryRoot: string;
  scope: VisibleMemoryScope;
  channelType?: string;
  userId?: string;
  chatId?: string;
  displayName?: string;
  pairs: Array<{ key: string; value: string }>;
  evidenceText: string;
  createdAt?: string;
}

export interface DerivedUserImpressionInput {
  memoryRoot: string;
  channelType: string;
  userId: string;
  displayName?: string;
  observations: Array<{ text: string; count: number }>;
  updatedAt?: string;
}

const STATE_RE = /<!--\s*cti-memory-state:([A-Za-z0-9+/=]+)\s*-->/u;

function emptyState(): ManagedMemoryDocumentState {
  return { version: 1, confirmed: {}, tentative: {}, evidence: [] };
}

function normalizeLine(value: string, maxChars = 300): string {
  return value.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, maxChars);
}

function escapeTableCell(value: string): string {
  return normalizeLine(value).replace(/\|/gu, '\\|');
}

function yamlValue(value: string | undefined): string {
  return `"${normalizeLine(value || '', 500).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

function isSensitiveObservation(value: string): boolean {
  const normalized = normalizeLine(value, 1000);
  return /(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|passwd|secret|验证码|口令|密码|密钥|token\s*(?:是|为|:|：|=)|身份证|精确住址|银行卡)/iu.test(normalized);
}

function parseState(content: string): ManagedMemoryDocumentState {
  const match = content.match(STATE_RE);
  if (!match) return emptyState();
  try {
    const parsed = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as Partial<ManagedMemoryDocumentState>;
    return {
      version: 1,
      confirmed: parsed.confirmed && typeof parsed.confirmed === 'object' ? parsed.confirmed : {},
      tentative: parsed.tentative && typeof parsed.tentative === 'object' ? parsed.tentative : {},
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
    };
  } catch {
    return emptyState();
  }
}

function readState(filePath: string): ManagedMemoryDocumentState {
  if (!fs.existsSync(filePath)) return emptyState();
  return parseState(fs.readFileSync(filePath, 'utf8'));
}

function encodeState(state: ManagedMemoryDocumentState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
}

export function resolveMemoryDocumentPath(input: {
  memoryRoot: string;
  scope: VisibleMemoryScope;
  channelType?: string;
  userId?: string;
  chatId?: string;
}): string {
  const root = path.resolve(input.memoryRoot);
  if (input.scope === 'user') {
    if (!input.channelType?.trim() || !input.userId?.trim()) throw new Error('user memory requires channelType and userId');
    return path.join(root, 'memory', 'users', memoryPartitionSegment(input.channelType), memoryPartitionSegment(input.userId), '用户印象.md');
  }
  if (input.scope === 'group') {
    if (!input.channelType?.trim() || !input.chatId?.trim()) throw new Error('group memory requires channelType and chatId');
    return path.join(root, 'memory', 'groups', memoryPartitionSegment(input.channelType), memoryPartitionSegment(input.chatId), '群聊记忆.md');
  }
  return path.join(root, 'memory', 'long-term', '公共长期记忆.md');
}

function documentTitle(scope: VisibleMemoryScope, displayName?: string): string {
  if (scope === 'user') return `用户印象：${normalizeLine(displayName || '未命名用户')}`;
  if (scope === 'group') return `群聊记忆：${normalizeLine(displayName || '未命名群聊')}`;
  return '公共长期记忆';
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

function renderDocument(input: {
  scope: VisibleMemoryScope;
  channelType?: string;
  userId?: string;
  chatId?: string;
  displayName?: string;
  state: ManagedMemoryDocumentState;
  updatedAt: string;
}): string {
  const channelType = input.scope === 'long_term' ? undefined : input.channelType;
  const userId = input.scope === 'user' ? input.userId : undefined;
  const chatId = input.scope === 'group' ? input.chatId : undefined;
  const displayName = input.scope === 'long_term' ? undefined : input.displayName;
  const frontmatter = [
    '---',
    `schema: ${MEMORY_V3_SCHEMA}`,
    `memoryScope: ${input.scope}`,
    ...(channelType ? [`channelType: ${yamlValue(channelType)}`] : []),
    ...(chatId ? [`chatId: ${yamlValue(chatId)}`] : []),
    ...(userId ? [`userId: ${yamlValue(userId)}`] : []),
    ...(displayName ? [`displayName: ${yamlValue(displayName)}`] : []),
    `updatedAt: ${input.updatedAt}`,
    '---',
  ];
  const evidence = input.state.evidence.slice(-30);
  return [
    ...frontmatter,
    '',
    `<!-- cti-memory-state:${encodeState(input.state)} -->`,
    '',
    `# ${documentTitle(input.scope, displayName)}`,
    '',
    '## 身份与称呼',
    '',
    displayName
      ? `- 显示名：${normalizeLine(displayName)}`
      : input.scope === 'long_term'
        ? '公共分区，不绑定单个用户或群聊。'
        : '暂无。',
    '',
    '## 沟通偏好',
    '',
    '由“已确认事实”和“暂定印象”中的相关条目提供。',
    '',
    '## 工作偏好',
    '',
    '由“已确认事实”和“暂定印象”中的相关条目提供。',
    '',
    '## 已确认事实',
    '',
    ...renderTable(input.state.confirmed),
    '',
    '## 暂定印象',
    '',
    ...renderTable(input.state.tentative),
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
      ? evidence.map((item) => `- ${item.createdAt}：${normalizeLine(item.text)}`)
      : ['暂无。']),
    '',
  ].join('\n');
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

export function upsertConfirmedMemoryDocument(input: ConfirmedMemoryDocumentInput): { filePath: string; updated: boolean } {
  const filePath = resolveMemoryDocumentPath(input);
  const state = readState(filePath);
  const timestamp = input.createdAt || new Date().toISOString();
  let updated = false;
  for (const pair of input.pairs) {
    const key = normalizeLine(pair.key, 120);
    const value = normalizeLine(pair.value, 500);
    if (!key || !value || isSensitiveObservation(`${key}: ${value}`)) continue;
    const existing = state.confirmed[key];
    if (!existing || existing.value !== value) updated = true;
    state.confirmed[key] = { value, updatedAt: timestamp, confidence: 1 };
    delete state.tentative[key];
  }
  const evidenceText = normalizeLine(input.evidenceText, 500);
  if (evidenceText && !isSensitiveObservation(evidenceText)) {
    state.evidence = [...state.evidence, { text: evidenceText, createdAt: timestamp }].slice(-50);
  }
  atomicWrite(filePath, renderDocument({ ...input, state, updatedAt: timestamp }));
  return { filePath, updated };
}

export function materializeDerivedUserImpression(input: DerivedUserImpressionInput): { filePath: string; updated: boolean } {
  const filePath = resolveMemoryDocumentPath({
    memoryRoot: input.memoryRoot,
    scope: 'user',
    channelType: input.channelType,
    userId: input.userId,
  });
  const state = readState(filePath);
  const timestamp = input.updatedAt || new Date().toISOString();
  let updated = false;
  for (const observation of input.observations) {
    const value = normalizeLine(observation.text, 500);
    if (observation.count < 3 || !value || isSensitiveObservation(value)) continue;
    const key = `暂定-${crypto.createHash('sha1').update(value, 'utf8').digest('hex').slice(0, 10)}`;
    const confidence = Math.min(0.9, 0.55 + (observation.count - 3) * 0.08);
    const existing = state.tentative[key];
    if (!existing || existing.value !== value || existing.confidence !== confidence) updated = true;
    state.tentative[key] = { value, updatedAt: timestamp, confidence };
  }
  if (updated || fs.existsSync(filePath)) {
    atomicWrite(filePath, renderDocument({
      scope: 'user',
      channelType: input.channelType,
      userId: input.userId,
      displayName: input.displayName,
      state,
      updatedAt: timestamp,
    }));
  }
  return { filePath, updated };
}
