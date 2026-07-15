/**
 * JSON file-backed BridgeStore implementation.
 *
 * Uses in-memory Maps as cache with write-through persistence
 * to JSON files in ~/.claude-to-im/data/.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  BridgeStore,
  BridgeSession,
  BridgeMessage,
  BridgeApiProvider,
  ConversationMemoryEvent,
  MemoryReplyDecision,
  MemoryRetrievalQuery,
  RetrievedMemoryContext,
  RetrievedMemoryHit,
  FeishuHistoryIndexedMessage,
  FeishuHistoryQuery,
  RetrievedFeishuHistoryContext,
  FeishuHistorySyncStatus,
  FeishuP2pUserAliasRecord,
  AuditLogInput,
  PermissionLinkInput,
  PermissionLinkRecord,
  OutboundRefInput,
  OutboundRefRecord,
  OutboundRefFilter,
  MarkOutboundRefRecalledInput,
  UpsertChannelBindingInput,
  MemoryWriteCandidate,
  MemoryWriteClassification,
} from 'claude-to-im/src/lib/bridge/host.js';
import type { ChannelBinding, ChannelType } from 'claude-to-im/src/lib/bridge/types.js';
import { CTI_HOME } from './config.js';
import { reviewOutboundAnswerRules, type AnswerReviewDecision, type AnswerReviewInput } from './answer-review.js';
import { readKnowledgeIndex, searchKnowledgeIndex, type KnowledgeItem } from './knowledge-indexer.js';
import { rebuildKnowledgeIndex } from './knowledge-index-service.js';
import { readMemoryGraphIndex, searchMemoryGraph, type MemoryGraphContext, type MemoryGraphIndex } from './memory-graph.js';
import {
  MEMORY_V2_SCHEMA,
  memoryPartitionSegment,
  isVisibleMemoryV2PathToQuery,
  isVisibleMemoryV2SourceToQuery,
} from './memory-source-policy.js';
import { repairLikelyMojibakeText } from './mojibake.js';
import {
  decideMemoryReply as decideMemoryReplyFromHits,
  inferStructuredMemories,
  isLowValueMemoryText,
  planMemoryQuery,
} from './memory-routing.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const MESSAGE_ARCHIVES_DIR = path.join(DATA_DIR, 'message-archives');
const MEMORY_PROFILES_PATH = path.join(DATA_DIR, 'memory-profiles.json');
const PERMISSION_LINKS_PATH = path.join(DATA_DIR, 'permission-links.json');
const OUTBOUND_REFS_PATH = path.join(DATA_DIR, 'outbound-refs.json');
const FEISHU_CHAT_INDEX_PATH = path.join(DATA_DIR, 'feishu-chat-index.json');
const FEISHU_P2P_USER_INDEX_PATH = path.join(DATA_DIR, 'feishu-p2p-user-index.json');
const FEISHU_HISTORY_DIR = path.join(DATA_DIR, 'feishu-history');
const FEISHU_HISTORY_INDEX_PATH = path.join(DATA_DIR, 'feishu-history-index.json');
const ANSWER_REVIEW_AUDIT_PATH = path.join(DATA_DIR, 'answer-review-audit.json');
const SUMMARY_MARKER = '[[CTI_SUMMARY]]';
const MAX_ACTIVE_MESSAGES = Math.max(20, Number.parseInt(process.env.CTI_HISTORY_MAX_MESSAGES || '36', 10) || 36);
const MAX_ACTIVE_CHARS = Math.max(8000, Number.parseInt(process.env.CTI_HISTORY_MAX_CHARS || '12000', 10) || 12000);
const KEEP_RECENT_MESSAGES = Math.max(8, Number.parseInt(process.env.CTI_HISTORY_KEEP_RECENT || '12', 10) || 12);
const SUMMARY_REFRESH_EVERY = Math.max(6, Number.parseInt(process.env.CTI_SUMMARY_REFRESH_EVERY || '12', 10) || 12);
const MEMORY_MAX_HITS = Math.max(2, Number.parseInt(process.env.CTI_MEMORY_MAX_HITS || '6', 10) || 6);
const MEMORY_MAX_CHARS = Math.max(600, Number.parseInt(process.env.CTI_MEMORY_MAX_CHARS || '2200', 10) || 2200);
const MEMORY_ARCHIVE_MAX_FILES = Math.max(0, Number.parseInt(process.env.CTI_MEMORY_ARCHIVE_MAX_FILES || '5', 10) || 5);
const MEMORY_MIN_SCORE = Number.parseFloat(process.env.CTI_MEMORY_MIN_SCORE || '6') || 6;
const MEMORY_PROFILE_MAX_ITEMS = Math.max(6, Number.parseInt(process.env.CTI_MEMORY_PROFILE_MAX_ITEMS || '24', 10) || 24);
const MEMORY_PROFILE_EVENT_MIN_CHARS = Math.max(2, Number.parseInt(process.env.CTI_MEMORY_PROFILE_EVENT_MIN_CHARS || '2', 10) || 2);
const ENGLISH_STOP_TOKENS = new Set(['this', 'that', 'with', 'from', 'then', 'just', 'into', 'them', 'they', 'what', 'when', 'where', 'which', 'have', 'will', 'your', 'about', 'please']);
const CHINESE_STOP_TOKENS = new Set(['这个', '那个', '现在', '刚才', '继续', '直接', '帮我', '处理', '一下', '看看', '这里', '当前', '应该', '进行', '根据', '然后', '就是', '可以', '能够']);
const MEMORY_RECALL_RE = /(记得|回忆|历史|上次|之前|以前|刚才|说过|提到|对应表|常用|查一下|找一下|回溯|总结|汇总)/i;
const MEMORY_PARTITION_DIR = path.join('data', 'memory', 'v2');

// Helpers

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2));
}

function readPermissionLinks(): Record<string, PermissionLinkRecord> {
  const current = readJson<Record<string, PermissionLinkRecord> | null>(PERMISSION_LINKS_PATH, null);
  if (current) return current;

  const legacyPath = path.join(DATA_DIR, 'permissions.json');
  const legacy = readJson<unknown>(legacyPath, null);
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return {};
  if ((legacy as { protocol?: unknown; Protocol?: unknown }).protocol === 'cti-permissions/v1'
    || (legacy as { protocol?: unknown; Protocol?: unknown }).Protocol === 'cti-permissions/v1'
    || Array.isArray((legacy as { subjects?: unknown; Subjects?: unknown }).subjects)
    || Array.isArray((legacy as { subjects?: unknown; Subjects?: unknown }).Subjects)) {
    return {};
  }
  return legacy as Record<string, PermissionLinkRecord>;
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function slugForFileName(text: string): string {
  const ascii = text
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9\u4e00-\u9fff_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return ascii || 'memory';
}

function resolveDurableMemoryDirectory(
  memoryRoot: string,
  input: Pick<MemoryWriteInput, 'channelType' | 'chatId' | 'userId' | 'classification'>,
): { dir?: string; error?: string } {
  const classification = input.classification;
  if (!classification) return { error: 'memory intent classification is required' };
  if (classification.actorKind !== 'human') return { error: 'only human-originated messages may write durable memory' };
  if (classification.confidence < 0.8) return { error: 'memory intent confidence is below the durable-write threshold' };

  const channel = memoryPartitionSegment(input.channelType || 'unknown');
  switch (classification.scope) {
    case 'temporary':
      return { error: 'temporary memory must remain in runtime session context' };
    case 'user':
      if (!input.userId?.trim()) return { error: 'user memory requires a verified user id' };
      return { dir: path.join(memoryRoot, MEMORY_PARTITION_DIR, 'users', channel, memoryPartitionSegment(input.userId)) };
    case 'group':
      if (!input.chatId?.trim()) return { error: 'group memory requires a verified chat id' };
      return { dir: path.join(memoryRoot, MEMORY_PARTITION_DIR, 'groups', channel, memoryPartitionSegment(input.chatId)) };
    case 'long_term':
      return { dir: path.join(memoryRoot, MEMORY_PARTITION_DIR, 'long-term') };
    default:
      return { error: 'unknown memory partition scope' };
  }
}

function escapeMarkdownTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function inferExplicitMemoryPrefixedLine(text: string): string | null {
  if (/[\r\n|]/.test(text)) return null;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 240 || /^(事实|偏好|约定|结论|决策|决定|待办|todo|TODO|后续|风险|资源|文件|图片|链接|场景|Scene)\s*[:：]/u.test(normalized)) {
    return null;
  }
  const content = normalized
    .replace(/^(?:请你|你也|也|帮我|麻烦你)?(?:记住|记一下|记下来|保存记忆|记录一下)[，,。.\s]*/u, '')
    .replace(/[，,。.\s]*(?:请你|你也|也|帮我|麻烦你)?(?:记住|记一下|记下来|保存记忆|记录一下)[，,。.\s]*$/u, '')
    .trim();
  if (!content || content.length > 220 || /\r?\n|\|/.test(content)) return null;
  if (/(?:待办|TODO|todo|后续|提醒|待处理|需要处理|风险|修复|跟进|检查|补齐|完善|实现|迁移|清理)/iu.test(content)) {
    return `待办: ${content}`;
  }
  if (/(?:决定|决策|采用|默认|不要|不能|必须|需要|优先|策略|规则|约定|边界|统一|改为|不再|只允许|禁止)/u.test(content)) {
    return `结论: ${content}`;
  }
  return `事实: ${content}`;
}

function cleanMemoryWriteText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:请你|麻烦你|帮我|你也|也)?(?:重新|再|更新|覆盖)?(?:记住|记一下|记下来|保存记忆|记录一下)[，,。.\s]*/u, '')
    .replace(/[，,。.\s]*(?:请你|麻烦你|帮我|你也|也)?(?:重新|再|更新|覆盖)?(?:记住|记一下|记下来|保存记忆|记录一下)[，,。.\s]*$/u, '')
    .trim();
}

function cleanMemoryCandidatePart(text: string | undefined): string {
  return (text || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^`|`$/g, '')
    .replace(/^[：:，,。.\s]+|[：:，,。.\s]+$/g, '')
    .trim();
}

function addMemoryCandidatePair(
  pairs: Array<{ key: string; value: string }>,
  seen: Set<string>,
  key: string | undefined,
  value: string | undefined,
): void {
  const cleanedKey = cleanMemoryCandidatePart(key);
  const cleanedValue = cleanMemoryCandidatePart(value);
  if (!cleanedKey || !cleanedValue || isLowValueMemoryText(cleanedValue)) return;
  const dedupKey = `${cleanedKey.toLowerCase()}\n${cleanedValue.toLowerCase()}`;
  if (seen.has(dedupKey)) return;
  seen.add(dedupKey);
  pairs.push({ key: cleanedKey, value: cleanedValue });
}

function inferNaturalMemoryPairs(text: string): Array<{ key: string; value: string }> {
  const normalized = cleanMemoryWriteText(text.replace(/\r\n/g, '\n'));
  const pairs: Array<{ key: string; value: string }> = [];
  const seen = new Set<string>();
  const valueToken = '([A-Za-z0-9][A-Za-z0-9_.\\-/]{1,120})';
  const keyToken = '([\\u4e00-\\u9fffA-Za-z0-9 _-]{2,80}(?:名称|名字|分支名|git分支名|路径|地址|链接|配置|版本|命令))';

  const valueFirst = new RegExp(`${valueToken}\\s*(?:\\n|\\s+)${keyToken}`, 'iu');
  const valueFirstMatch = normalized.match(valueFirst);
  if (valueFirstMatch) addMemoryCandidatePair(pairs, seen, valueFirstMatch[2], valueFirstMatch[1]);

  const keyFirst = new RegExp(`${keyToken}\\s*(?:是|为|叫|=|==|:|：)\\s*${valueToken}`, 'iu');
  const keyFirstMatch = normalized.match(keyFirst);
  if (keyFirstMatch) addMemoryCandidatePair(pairs, seen, keyFirstMatch[1], keyFirstMatch[2]);

  return pairs;
}

function normalizeMemoryWriteCandidates(
  candidates: MemoryWriteCandidate[] | undefined,
): Array<{ key: string; value: string }> {
  const pairs: Array<{ key: string; value: string }> = [];
  const seen = new Set<string>();

  for (const candidate of candidates || []) {
    addMemoryCandidatePair(pairs, seen, candidate.key, candidate.value);
    if ((!candidate.key || !candidate.value) && candidate.text) {
      for (const pair of inferStructuredMemories(candidate.text)) {
        addMemoryCandidatePair(pairs, seen, pair.key, pair.value);
      }
      for (const pair of inferNaturalMemoryPairs(candidate.text)) {
        addMemoryCandidatePair(pairs, seen, pair.key, pair.value);
      }
    }
  }

  return pairs;
}

// Lock entry

interface LockEntry {
  lockId: string;
  owner: string;
  expiresAt: number;
}

interface FeishuChatIndexRecord {
  chatId: string;
  chatType?: string;
  displayName?: string;
  lastMessageAt?: string;
  lastSenderId?: string;
  updatedAt: string;
}

interface FeishuHistoryIndexRecord extends FeishuHistorySyncStatus {}
interface FeishuP2pUserAliasIndexRecord extends FeishuP2pUserAliasRecord {}

type MemoryProfileScope = 'user' | 'chat' | 'global';

interface MemoryProfileRecord {
  scope: MemoryProfileScope;
  key: string;
  channelType?: string;
  chatId?: string;
  userId?: string;
  displayName?: string;
  workingDirectory?: string;
  topics: string[];
  facts: string[];
  pending: string[];
  messageCount: number;
  updatedAt: string;
  lastEventAt: string;
}

interface AnswerReviewAuditRecord extends AnswerReviewDecision {
  id: string;
  channelType: string;
  chatId: string;
  userId?: string;
  userText: string;
  answerText: string;
  source?: AnswerReviewInput['source'];
  executionEvidence?: AnswerReviewInput['executionEvidence'];
}

interface MemoryWriteInput {
  sessionId: string;
  channelType: string;
  chatId: string;
  chatDisplayName?: string;
  userId?: string;
  userDisplayName?: string;
  text: string;
  workingDirectory?: string;
  createdAt?: string;
  candidates?: MemoryWriteCandidate[];
  classification?: MemoryWriteClassification;
}

interface MemoryWriteResult {
  ok: boolean;
  skipped?: boolean;
  memoryRoot?: string;
  filePath?: string;
  knowledgeRebuilt?: boolean;
  scope?: MemoryWriteClassification['scope'];
  error?: string;
}

// Store

export class JsonFileStore implements BridgeStore {
  private settings: Map<string, string>;
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private permissionLinks = new Map<string, PermissionLinkRecord>();
  private offsets = new Map<string, string>();
  private dedupKeys = new Map<string, number>();
  private locks = new Map<string, LockEntry>();
  private memoryProfiles = new Map<string, MemoryProfileRecord>();
  private feishuChatIndex = new Map<string, FeishuChatIndexRecord>();
  private feishuP2pUserIndex = new Map<string, FeishuP2pUserAliasIndexRecord>();
  private feishuHistoryIndex = new Map<string, FeishuHistoryIndexRecord>();
  private outboundRefs = new Map<string, OutboundRefRecord>();
  private auditLog: Array<AuditLogInput & { id: string; createdAt: string }> = [];

  constructor(settingsMap: Map<string, string>) {
    this.settings = settingsMap;
    ensureDir(DATA_DIR);
    ensureDir(MESSAGES_DIR);
    ensureDir(MESSAGE_ARCHIVES_DIR);
    ensureDir(FEISHU_HISTORY_DIR);
    this.loadAll();
  }

  // Persistence

  private loadAll(): void {
    // Sessions
    const sessions = readJson<Record<string, BridgeSession>>(
      path.join(DATA_DIR, 'sessions.json'),
      {},
    );
    for (const [id, s] of Object.entries(sessions)) {
      this.sessions.set(id, s);
    }

    // Bindings
    const bindings = readJson<Record<string, ChannelBinding>>(
      path.join(DATA_DIR, 'bindings.json'),
      {},
    );
    for (const [key, b] of Object.entries(bindings)) {
      this.bindings.set(key, b);
    }

    // Permission links
    const perms = readPermissionLinks();
    for (const [id, p] of Object.entries(perms)) {
      this.permissionLinks.set(id, p);
    }

    // Offsets
    const offsets = readJson<Record<string, string>>(
      path.join(DATA_DIR, 'offsets.json'),
      {},
    );
    for (const [k, v] of Object.entries(offsets)) {
      this.offsets.set(k, v);
    }

    // Dedup
    const dedup = readJson<Record<string, number>>(
      path.join(DATA_DIR, 'dedup.json'),
      {},
    );
    for (const [k, v] of Object.entries(dedup)) {
      this.dedupKeys.set(k, v);
    }

    const memoryProfiles = readJson<Record<string, MemoryProfileRecord>>(
      MEMORY_PROFILES_PATH,
      {},
    );
    for (const [key, value] of Object.entries(memoryProfiles)) {
      if (value?.scope && value?.key) {
        if (value.scope === 'global') continue;
        this.memoryProfiles.set(key, {
          ...value,
          topics: Array.isArray(value.topics) ? value.topics : [],
          facts: Array.isArray(value.facts) ? value.facts : [],
          pending: Array.isArray(value.pending) ? value.pending : [],
          messageCount: Number.isFinite(value.messageCount) ? value.messageCount : 0,
          updatedAt: value.updatedAt || now(),
          lastEventAt: value.lastEventAt || value.updatedAt || now(),
        });
      }
    }

    const feishuChatIndex = readJson<Record<string, FeishuChatIndexRecord>>(
      FEISHU_CHAT_INDEX_PATH,
      {},
    );
    for (const [key, value] of Object.entries(feishuChatIndex)) {
      this.feishuChatIndex.set(key, value);
    }

    const feishuP2pUserIndex = readJson<Record<string, FeishuP2pUserAliasIndexRecord>>(
      FEISHU_P2P_USER_INDEX_PATH,
      {},
    );
    for (const [key, value] of Object.entries(feishuP2pUserIndex)) {
      this.feishuP2pUserIndex.set(key, value);
    }

    const feishuHistoryIndex = readJson<Record<string, FeishuHistoryIndexRecord>>(
      FEISHU_HISTORY_INDEX_PATH,
      {},
    );
    for (const [key, value] of Object.entries(feishuHistoryIndex)) {
      this.feishuHistoryIndex.set(key, value);
    }

    const outboundRefs = readJson<Record<string, OutboundRefRecord>>(OUTBOUND_REFS_PATH, {});
    for (const [key, value] of Object.entries(outboundRefs)) {
      if (value?.channelType && value?.chatId && value?.platformMessageId) {
        this.outboundRefs.set(key, value);
      }
    }

    // Audit
    this.auditLog = readJson(path.join(DATA_DIR, 'audit.json'), []);
  }

  private persistSessions(): void {
    writeJson(
      path.join(DATA_DIR, 'sessions.json'),
      Object.fromEntries(this.sessions),
    );
  }

  private persistBindings(): void {
    writeJson(
      path.join(DATA_DIR, 'bindings.json'),
      Object.fromEntries(this.bindings),
    );
  }

  private persistPermissions(): void {
    writeJson(
      PERMISSION_LINKS_PATH,
      Object.fromEntries(this.permissionLinks),
    );
  }

  private persistOffsets(): void {
    writeJson(
      path.join(DATA_DIR, 'offsets.json'),
      Object.fromEntries(this.offsets),
    );
  }

  private persistDedup(): void {
    writeJson(
      path.join(DATA_DIR, 'dedup.json'),
      Object.fromEntries(this.dedupKeys),
    );
  }

  private persistFeishuChatIndex(): void {
    writeJson(
      FEISHU_CHAT_INDEX_PATH,
      Object.fromEntries(this.feishuChatIndex),
    );
  }

  private persistFeishuP2pUserIndex(): void {
    writeJson(
      FEISHU_P2P_USER_INDEX_PATH,
      Object.fromEntries(this.feishuP2pUserIndex),
    );
  }

  private persistFeishuHistoryIndex(): void {
    writeJson(
      FEISHU_HISTORY_INDEX_PATH,
      Object.fromEntries(this.feishuHistoryIndex),
    );
  }

  private persistOutboundRefs(): void {
    writeJson(OUTBOUND_REFS_PATH, Object.fromEntries(this.outboundRefs));
  }

  private outboundRefKey(channelType: string, chatId: string, platformMessageId: string): string {
    return `${channelType}:${chatId}:${platformMessageId}`;
  }

  private getFeishuHistoryPath(chatId: string): string {
    return path.join(FEISHU_HISTORY_DIR, `${chatId}.json`);
  }

  private loadFeishuHistoryMessages(chatId: string): FeishuHistoryIndexedMessage[] {
    return readJson<FeishuHistoryIndexedMessage[]>(this.getFeishuHistoryPath(chatId), []);
  }

  private persistFeishuHistoryMessages(chatId: string, messages: FeishuHistoryIndexedMessage[]): void {
    writeJson(this.getFeishuHistoryPath(chatId), messages);
  }

  private persistAudit(): void {
    writeJson(path.join(DATA_DIR, 'audit.json'), this.auditLog);
  }

  private persistMessages(sessionId: string): void {
    const msgs = this.messages.get(sessionId) || [];
    writeJson(path.join(MESSAGES_DIR, `${sessionId}.json`), msgs);
  }

  private persistMemoryProfiles(): void {
    const boundedProfiles = [...this.memoryProfiles].filter(([, profile]) => profile.scope !== 'global');
    this.memoryProfiles = new Map(boundedProfiles);
    writeJson(MEMORY_PROFILES_PATH, Object.fromEntries(boundedProfiles));
  }

  private loadMessages(sessionId: string): BridgeMessage[] {
    if (this.messages.has(sessionId)) {
      return this.messages.get(sessionId)!;
    }
    const msgs = readJson<BridgeMessage[]>(
      path.join(MESSAGES_DIR, `${sessionId}.json`),
      [],
    );
    const beforeCount = msgs.length;
    const beforeChars = msgs.reduce((sum, message) => sum + (message.content?.length || 0), 0);
    this.maybeCompactMessages(sessionId, msgs);
    this.messages.set(sessionId, msgs);
    const afterCount = msgs.length;
    const afterChars = msgs.reduce((sum, message) => sum + (message.content?.length || 0), 0);
    if (afterCount !== beforeCount || afterChars !== beforeChars) {
      this.persistMessages(sessionId);
    }
    return msgs;
  }

  private archiveCompactedMessages(sessionId: string, removed: BridgeMessage[]): void {
    if (removed.length === 0) return;
    const archiveDir = path.join(MESSAGE_ARCHIVES_DIR, sessionId);
    ensureDir(archiveDir);
    writeJson(path.join(archiveDir, `${Date.now()}.json`), removed);
  }

  private loadArchivedMessagesForMemory(sessionId: string): BridgeMessage[] {
    const archiveDir = path.join(MESSAGE_ARCHIVES_DIR, sessionId);
    if (!fs.existsSync(archiveDir)) return [];

    const files = fs.readdirSync(archiveDir)
      .filter((name) => name.endsWith('.json'))
      .sort((left, right) => right.localeCompare(left))
      .slice(0, MEMORY_ARCHIVE_MAX_FILES);

    const collected: BridgeMessage[] = [];
    for (const name of files) {
      const archived = readJson<BridgeMessage[]>(path.join(archiveDir, name), []);
      collected.unshift(...archived);
    }
    return collected;
  }

  private summarizeMessageContent(content: string, maxLen = 160): string {
    const cleaned = content
      .replace(/<!--files:[\s\S]*?-->/g, '')
      .replace(SUMMARY_MARKER, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return '';
    const repaired = repairLikelyMojibakeText(cleaned);
    if (repaired.unresolved) return '';
    return repaired.text.length > maxLen ? `${repaired.text.slice(0, maxLen - 3)}...` : repaired.text;
  }

  private sanitizePersistedText(content: string): string {
    const repaired = repairLikelyMojibakeText(content || '');
    return repaired.unresolved ? '' : repaired.text;
  }

  private memoryProfileKey(scope: MemoryProfileScope, channelType: string, id = ''): string {
    const normalizedId = id.trim() || 'all';
    return `${scope}:${channelType || 'all'}:${normalizedId}`;
  }

  private appendMemoryItems(existing: string[], incoming: string[]): string[] {
    const seen = new Set<string>();
    const combined: string[] = [];
    for (const item of [...existing, ...incoming]) {
      const normalized = this.summarizeMessageContent(item, 180);
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      combined.push(normalized);
    }
    return combined.slice(-MEMORY_PROFILE_MAX_ITEMS);
  }

  private extractMemoryProfileItems(text: string, role: 'user' | 'assistant'): {
    topics: string[];
    facts: string[];
    pending: string[];
  } {
    const normalized = this.summarizeMessageContent(text, 520);
    if (!normalized || normalized.length < MEMORY_PROFILE_EVENT_MIN_CHARS) {
      return { topics: [], facts: [], pending: [] };
    }
    if (isLowValueMemoryText(normalized)) {
      return { topics: [], facts: [], pending: [] };
    }

    const facts: string[] = [];
    const pending: string[] = [];
    const topics: string[] = [];
    const lower = normalized.toLowerCase();

    if (
      /记住|以后|以后.*就|固定|对应表|常用|叫|命名|偏好|喜欢|不要|别|必须|默认|约定|规则|==|=>|->/.test(normalized)
      || /prefab|scene|mcp|unity|codex|feishu|家具|场景|权限|发布/i.test(normalized)
    ) {
      facts.push(normalized);
    }

    if (/未完成|阻塞|失败|报错|不可用|待办|下次|继续|还没|需要后续/.test(normalized)) {
      pending.push(normalized);
    }

    if (role === 'assistant' && /(已|已经|完成|修复|同步|发布|重启|生成|整理|改好|通过|成功)/.test(normalized)) {
      facts.push(normalized);
    }

    if (
      role === 'user'
      && normalized.length >= 8
      && !/^(你好|你好呀|hi|hello|在吗|谢谢|好的|收到|嗯|哈哈|晚安|早上好)$/i.test(lower)
    ) {
      topics.push(normalized);
    }

    return { topics, facts, pending };
  }

  private upsertMemoryProfile(
    scope: MemoryProfileScope,
    key: string,
    event: ConversationMemoryEvent,
    items: { topics: string[]; facts: string[]; pending: string[] },
  ): void {
    const existing = this.memoryProfiles.get(key);
    const timestamp = event.createdAt || now();
    const record: MemoryProfileRecord = {
      scope,
      key,
      channelType: event.channelType || existing?.channelType,
      chatId: scope === 'chat' ? event.chatId : existing?.chatId,
      userId: scope === 'user' ? event.userId : existing?.userId,
      displayName: scope === 'user'
        ? (event.userDisplayName || existing?.displayName || event.userId)
        : scope === 'chat'
          ? (event.chatDisplayName || existing?.displayName || event.chatId)
          : (existing?.displayName || '所有会话'),
      workingDirectory: event.workingDirectory || existing?.workingDirectory,
      topics: this.appendMemoryItems(existing?.topics || [], items.topics),
      facts: this.appendMemoryItems(existing?.facts || [], items.facts),
      pending: this.appendMemoryItems(existing?.pending || [], items.pending),
      messageCount: (existing?.messageCount || 0) + 1,
      updatedAt: now(),
      lastEventAt: timestamp,
    };
    this.memoryProfiles.set(key, record);
  }

  private recordFeishuHistoryProfiles(chatId: string, displayName: string | undefined, messages: FeishuHistoryIndexedMessage[]): void {
    let changed = false;
    for (const item of messages) {
      const safeText = this.summarizeMessageContent(item.text || '', 800);
      if (!safeText) continue;
      const createdAt = item.createTime && /^\d+$/.test(item.createTime)
        ? new Date(Number.parseInt(item.createTime, 10)).toISOString()
        : undefined;
      changed = this.applyMemoryEvent({
        sessionId: `feishu-history:${chatId}`,
        channelType: 'feishu',
        chatId,
        chatDisplayName: displayName,
        userId: item.senderId,
        userDisplayName: item.senderName,
        role: item.senderType === 'app' ? 'assistant' : 'user',
        text: safeText,
        createdAt,
      }) || changed;
    }
    if (changed) {
      this.persistMemoryProfiles();
    }
  }

  private extractCtiFinalVisibleTexts(text: string): string[] {
    const out: string[] = [];
    const fence = /```cti-final\s*([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = fence.exec(text)) !== null) {
      const rawJson = (match[1] || '').trim();
      if (!rawJson) continue;
      try {
        const parsed = JSON.parse(rawJson) as { text?: unknown };
        const visibleText = typeof parsed.text === 'string' ? parsed.text : '';
        const normalized = this.summarizeMessageContent(visibleText, 4000);
        if (normalized) out.push(normalized);
      } catch {
        // Ignore malformed historical result blocks. The raw text block below
        // still contributes a safe, shortened fallback.
      }
    }
    return out;
  }

  private extractStructuredTextBlockForMemory(text: string, maxLen: number): string {
    const ctiFinalTexts = this.extractCtiFinalVisibleTexts(text);
    const withoutResultBlocks = text.replace(/```cti-final\s*[\s\S]*?```/g, ' ');
    const normalText = this.summarizeMessageContent(withoutResultBlocks, Math.min(maxLen, 1200));
    // The user-visible final answer is the highest quality memory signal.
    // Keep it before progress chatter so matched excerpts show the answer
    // instead of "我先查一下..." style process text.
    return [ctiFinalTexts.join(' | '), normalText].filter(Boolean).join(' | ');
  }

  private extractPlainMessageTextForMemory(content: string): string {
    const ctiFinalTexts = this.extractCtiFinalVisibleTexts(content);
    if (ctiFinalTexts.length > 0) {
      // 有些历史记录不是 Claude/Codex block 数组，而是直接保存了
      // ```cti-final``` 文本。检索时仍然只取用户可见 text。
      return ctiFinalTexts.join(' | ');
    }
    return content;
  }

  private extractStructuredMessageText(content: string, maxLen: number): string {
    try {
      const blocks = JSON.parse(content) as Array<Record<string, unknown>>;
      const finalTexts = blocks
        .filter((block) => block?.type === 'text')
        .flatMap((block) => this.extractCtiFinalVisibleTexts(String(block.text || '')));
      if (finalTexts.length > 0) {
        // 历史检索需要优先还原用户真正看到的最终答复。
        // 一旦结构化消息里存在 cti-final，就不要把进度话术、
        // tool_use 或 tool_result 当成主记忆文本，避免工具日志污染旧答案。
        return this.summarizeMessageContent(finalTexts.join(' | '), maxLen);
      }
      const parts: string[] = [];
      const textBudget = Math.max(4000, maxLen);
      for (const block of blocks) {
        if (block?.type === 'text') {
          const text = this.extractStructuredTextBlockForMemory(String(block.text || ''), textBudget);
          if (text) parts.push(text);
          continue;
        }
        if (block?.type === 'tool_use' || block?.type === 'tool_result') {
          // 记忆检索的主证据只回答“用户当时看见了什么结论”。
          // 工具命令和原始结果留给 audit / workflow / compact summary，
          // 不进入历史问答检索摘要，避免旧路径或日志盖过正文。
          continue;
        }
      }
      return this.summarizeMessageContent(parts.join(' | '), maxLen);
    } catch {
      return this.summarizeMessageContent(content, maxLen);
    }
  }

  private normalizePreviousSummary(previousSummary: string): string {
    return previousSummary
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('- 继承上次摘要:') && !line.startsWith('- 会话摘要（自动升级'))
      .join(' | ');
  }

  private sanitizeToolResultContent(content: string): string {
    const normalized = content
      .replace(/Access is denied\.[\s\S]*/i, 'Access is denied. (后续大量拒绝细节已省略)')
      .replace(/The token '&&' is not a valid statement separator[\s\S]*/i, "PowerShell 不支持 '&&'，后续错误细节已省略")
      .replace(/\s+/g, ' ')
      .trim();
    return this.summarizeMessageContent(normalized, 120);
  }

  private collectToolHints(messages: BridgeMessage[]): string[] {
    const hints: string[] = [];
    for (const message of messages) {
      if (typeof message.content !== 'string' || !message.content.trim().startsWith('[')) continue;
      try {
        const blocks = JSON.parse(message.content) as Array<Record<string, unknown>>;
        for (const block of blocks) {
          if (block?.type === 'tool_use') {
            const name = typeof block.name === 'string' ? block.name : '';
            if (name === 'Edit') {
              hints.push('执行了文件修改');
            } else if (name === 'Bash') {
              const input = block.input as { command?: unknown } | undefined;
              const command = typeof input?.command === 'string' ? this.summarizeMessageContent(input.command, 120) : '';
              if (command) hints.push(`执行命令: ${command}`);
            }
          } else if (block?.type === 'tool_result') {
            const content = typeof block.content === 'string' ? this.sanitizeToolResultContent(block.content) : '';
            if (content) hints.push(`工具结果: ${content}`);
          }
        }
      } catch {
        continue;
      }
    }
    return Array.from(new Set(hints)).slice(-6);
  }

  private collectRecentUserTopics(messages: BridgeMessage[]): string[] {
    return Array.from(new Set(
      messages
        .filter((message) => message.role === 'user')
        .map((message) => this.summarizeMessageContent(message.content, 120))
        .filter(Boolean)
        .slice(-8)
    )).slice(-4);
  }

  private collectConstraints(messages: BridgeMessage[]): string[] {
    const constraintRegex = /(不要|必须|需要|要求|只能|保留|继续|直到)[^。！；\n]{0,80}/g;
    const snippets: string[] = [];
    for (const message of messages) {
      if (message.role !== 'user') continue;
      const cleaned = this.summarizeMessageContent(message.content, 200);
      const matches = cleaned.match(constraintRegex) || [];
      for (const match of matches) {
        const normalized = match.trim();
        if (normalized) snippets.push(normalized);
      }
    }
    return Array.from(new Set(snippets)).slice(-5);
  }

  private collectCompletedWork(messages: BridgeMessage[]): string[] {
    const outputs = messages
      .filter((message) => message.role === 'assistant' && !message.content.startsWith(SUMMARY_MARKER))
      .map((message) => this.summarizeMessageContent(message.content, 120))
      .filter(Boolean)
      .slice(-6);
    return Array.from(new Set(outputs)).slice(-4);
  }

  private collectPendingWork(messages: BridgeMessage[]): string[] {
    const pendingRegex = /(下一步|接下来|继续|还需要|待办|TODO|todo)[^。！；\n]{0,80}/ig;
    const items: string[] = [];
    for (const message of messages) {
      const cleaned = this.summarizeMessageContent(message.content, 200);
      const matches = cleaned.match(pendingRegex) || [];
      for (const match of matches) {
        const normalized = match.trim();
        if (normalized) items.push(normalized);
      }
    }
    return Array.from(new Set(items)).slice(-5);
  }

  private buildMemorySessionMeta(): Map<string, {
    channelType?: string;
    chatId?: string;
    workingDirectory?: string;
    updatedAt?: string;
  }> {
    const meta = new Map<string, {
      channelType?: string;
      chatId?: string;
      workingDirectory?: string;
      updatedAt?: string;
    }>();

    for (const session of this.sessions.values()) {
      meta.set(session.id, {
        workingDirectory: session.working_directory,
      });
    }

    for (const binding of this.bindings.values()) {
      const existing = meta.get(binding.codepilotSessionId) || {};
      meta.set(binding.codepilotSessionId, {
        ...existing,
        channelType: binding.channelType,
        chatId: binding.chatId,
        workingDirectory: binding.workingDirectory || existing.workingDirectory,
        updatedAt: binding.updatedAt,
      });
    }

    return meta;
  }

  private extractMemoryTokens(text: string): string[] {
    const repaired = repairLikelyMojibakeText(text);
    if (repaired.unresolved) return [];
    const normalized = repaired.text
      .replace(/<!--files:[\s\S]*?-->/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const tokens = new Set<string>();
    const english = normalized.toLowerCase().match(/[a-z0-9_./-]{3,}/g) || [];
    for (const token of english) {
      if (!ENGLISH_STOP_TOKENS.has(token)) tokens.add(token);
    }

    const chineseChunks = normalized.match(/[\u4e00-\u9fff]{2,12}/g) || [];
    for (const chunk of chineseChunks) {
      if (!CHINESE_STOP_TOKENS.has(chunk)) tokens.add(chunk);
      const maxWindow = Math.min(4, chunk.length);
      for (let size = 2; size <= maxWindow; size += 1) {
        for (let index = 0; index <= chunk.length - size; index += 1) {
          const token = chunk.slice(index, index + size);
          if (!CHINESE_STOP_TOKENS.has(token)) tokens.add(token);
        }
      }
    }

    return Array.from(tokens).slice(0, 36);
  }

  private summarizeMessageForMemory(message: BridgeMessage): {
    content: string;
    searchText: string;
    source: 'summary' | 'message';
  } | null {
    if (!message.content) return null;
    if (message.content.startsWith(SUMMARY_MARKER)) {
      const raw = message.content.slice(SUMMARY_MARKER.length);
      const content = this.summarizeMessageContent(raw, 280);
      const searchText = this.summarizeMessageContent(raw, 12000);
      return content ? { content, searchText, source: 'summary' } : null;
    }
    if (message.content.trim().startsWith('[')) {
      const raw = this.extractStructuredMessageText(message.content, 250000);
      const content = this.summarizeMessageContent(raw, 220);
      const searchText = raw;
      return content ? { content, searchText, source: 'message' } : null;
    }
    const memoryText = this.extractPlainMessageTextForMemory(message.content);
    const content = this.summarizeMessageContent(memoryText, 220);
    const searchText = this.summarizeMessageContent(memoryText, 12000);
    return content ? { content, searchText, source: 'message' } : null;
  }

  private summarizeAdjacentAssistantAnswer(messages: BridgeMessage[], index: number): {
    content: string;
    searchText: string;
  } | null {
    for (let nextIndex = index + 1; nextIndex < messages.length; nextIndex += 1) {
      const next = messages[nextIndex];
      if (!next) break;
      if (next.role !== 'assistant') break;
      const summarized = this.summarizeMessageForMemory(next);
      if (!summarized) continue;
      return {
        content: this.summarizeMessageContent(summarized.searchText, 700),
        searchText: summarized.searchText,
      };
    }
    return null;
  }

  private selectMessagesForMemory(
    isCurrentSession: boolean,
    messages: BridgeMessage[],
    recentHistoryLimit: number,
  ): BridgeMessage[] {
    const currentTrimmed = isCurrentSession
      ? messages.slice(0, Math.max(0, messages.length - recentHistoryLimit))
      : messages;

    if (currentTrimmed.length === 0) return [];

    const summaryMessage = currentTrimmed[0]?.content.startsWith(SUMMARY_MARKER)
      ? [currentTrimmed[0]]
      : [];
    const tail = currentTrimmed.slice(summaryMessage.length > 0 ? 1 : 0).slice(-10);
    return [...summaryMessage, ...tail];
  }

  private scoreMemoryHit(
    query: MemoryRetrievalQuery,
    tokens: string[],
    hitContent: string,
    meta: { channelType?: string; chatId?: string; workingDirectory?: string; updatedAt?: string },
    sessionId: string,
    source: 'summary' | 'message',
    role: string,
  ): number {
    const haystack = hitContent.toLowerCase();
    let score = 0;

    for (const token of tokens) {
      const needle = /[a-z]/i.test(token) ? token.toLowerCase() : token;
      if (!needle) continue;
      if (haystack.includes(needle.toLowerCase())) {
        score += /[a-z]/i.test(token)
          ? Math.min(5, Math.max(2, token.length / 2))
          : Math.min(4, Math.max(1.5, token.length));
      }
    }

    if (meta.channelType === query.channelType && meta.chatId === query.chatId) score += 10;
    if (meta.workingDirectory && query.workingDirectory && meta.workingDirectory.toLowerCase() === query.workingDirectory.toLowerCase()) score += 6;
    if (sessionId === query.sessionId) score += 3;
    if (source === 'summary') score += 1.5;
    if (role === 'user') score += 1;

    if (meta.updatedAt) {
      const ageMs = Date.now() - Date.parse(meta.updatedAt);
      if (!Number.isNaN(ageMs)) {
        if (ageMs < 24 * 60 * 60 * 1000) score += 2;
        else if (ageMs < 7 * 24 * 60 * 60 * 1000) score += 1;
      }
    }

    return score;
  }

  private buildMemorySummary(hits: RetrievedMemoryHit[]): string {
    const lines = ['Relevant memory from local history repository (selected, not full history):'];
    for (const hit of hits) {
      const tags: string[] = [];
      if (hit.channelType && hit.chatId) tags.push(hit.chatId);
      if (hit.workingDirectory) tags.push(path.basename(hit.workingDirectory));
      tags.push(hit.source === 'summary' ? '摘要' : '记录');
      lines.push(`- [${tags.join(' / ')}] ${hit.content}`);
    }
    return lines.join('\n');
  }

  private formatKnowledgeHit(item: KnowledgeItem): string {
    const source = item.source.path ? path.basename(item.source.path) : 'knowledge';
    const exact = item.key && item.value
      ? `${item.key} = ${item.value}`
      : item.text;
    const conflict = item.conflict ? '（冲突候选）' : '';
    return `[知识库/${item.kind}/${source}] ${exact}${conflict}`;
  }

  /**
   * Knowledge indexes are shared implementation artifacts, not permission
   * boundaries. Enforce the memory partition boundary again before a query can
   * see an indexed item or graph node.
   */
  private isMemorySourceVisibleToQuery(sourcePath: string, memoryRoot: string, query: MemoryRetrievalQuery): boolean {
    return isVisibleMemoryV2PathToQuery(memoryRoot, sourcePath, query);
  }

  private isMemoryItemVisibleToQuery(item: KnowledgeItem, memoryRoot: string, query: MemoryRetrievalQuery): boolean {
    return isVisibleMemoryV2SourceToQuery(memoryRoot, item.source.path, item.source.metadata, query);
  }

  private filterMemoryGraphForQuery(
    graph: MemoryGraphIndex,
    memoryRoot: string,
    query: MemoryRetrievalQuery,
  ): MemoryGraphIndex {
    // A graph node merged from two partitions is ambiguous. Excluding it is
    // safer than using one user's relation to reveal another user's fact.
    const nodes = graph.nodes.filter((node) => {
      const sources = node.sourcePaths || [];
      return sources.length > 0 && sources.every((source) => this.isMemorySourceVisibleToQuery(source, memoryRoot, query));
    });
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter((edge) => {
      const sources = edge.sourcePaths || [];
      return nodeIds.has(edge.from)
        && nodeIds.has(edge.to)
        && sources.length > 0
        && sources.every((source) => this.isMemorySourceVisibleToQuery(source, memoryRoot, query));
    });
    return { ...graph, nodeCount: nodes.length, edgeCount: edges.length, nodes, edges };
  }

  private searchKnowledgeIndexForMemory(query: MemoryRetrievalQuery, tokens: string[]): RetrievedMemoryHit[] {
    const memoryRoot = this.settings.get('bridge_memory_repo_dir');
    if (!memoryRoot) return [];
    const index = readKnowledgeIndex(memoryRoot);
    if (!index || index.items.length === 0) return [];

    const scopedIndex = {
      ...index,
      items: index.items.filter((item) => this.isMemoryItemVisibleToQuery(item, memoryRoot, query)),
    };
    const hits = searchKnowledgeIndex(scopedIndex, {
      query: query.query,
      limit: MEMORY_RECALL_RE.test(query.query) ? 6 : 4,
    });
    if (hits.length === 0) return [];

    return hits
      .map((item) => {
        const haystack = `${item.key || ''} ${item.value || ''} ${item.text}`.toLowerCase();
        const normalizedQuery = query.query.trim().toLowerCase();
        const itemKey = (item.key || '').trim().toLowerCase();
        let score = item.confidence * 6;
        if (normalizedQuery && itemKey) {
          if (itemKey === normalizedQuery) score += 42;
          else if (itemKey.includes(normalizedQuery) || normalizedQuery.includes(itemKey)) score += 24;
        }
        for (const token of tokens) {
          if (haystack.includes(token.toLowerCase())) score += /[a-z]/i.test(token) ? 2 : 1.5;
        }
        if (MEMORY_RECALL_RE.test(query.query)) score += 4;
        return {
          sessionId: `knowledge-index:${item.id}`,
          channelType: query.channelType,
          chatId: query.chatId,
          workingDirectory: query.workingDirectory,
          role: 'assistant' as const,
          source: 'summary' as const,
          sourceType: 'knowledge' as const,
          score,
          confidence: Math.max(0, Math.min(0.98, item.confidence + (item.key && item.value ? 0.08 : 0))),
          answerability: item.key && item.value ? 'structured' as const : 'summary' as const,
          quality: item.conflict ? 'medium' as const : 'high' as const,
          structuredKey: item.key,
          structuredValue: item.value,
          content: this.summarizeMessageContent(this.formatKnowledgeHit(item), 300),
        };
      })
      .filter((hit) => hit.score >= (MEMORY_RECALL_RE.test(query.query) ? 4 : MEMORY_MIN_SCORE));
  }

  private summarizeProfileForMemory(profile: MemoryProfileRecord): string {
    const parts: string[] = [];
    const label = profile.displayName || profile.userId || profile.chatId || profile.key;
    if (profile.facts.length > 0) {
      parts.push(`事实/偏好: ${profile.facts.slice(-6).join(' | ')}`);
    }
    if (profile.pending.length > 0) {
      parts.push(`待跟进: ${profile.pending.slice(-4).join(' | ')}`);
    }
    if (profile.topics.length > 0) {
      parts.push(`近期主题: ${profile.topics.slice(-5).join(' | ')}`);
    }
    if (parts.length === 0) return '';
    return `${label}: ${parts.join('；')}`;
  }

  private scoreMemoryProfile(query: MemoryRetrievalQuery, tokens: string[], profile: MemoryProfileRecord, text: string): number {
    const haystack = `${profile.displayName || ''} ${profile.userId || ''} ${profile.chatId || ''} ${text}`;
    const lower = haystack.toLowerCase();
    let score = 0;

    for (const token of tokens) {
      const needle = /[a-z]/i.test(token) ? token.toLowerCase() : token;
      if (!needle) continue;
      if (lower.includes(needle.toLowerCase())) {
        score += /[a-z]/i.test(token)
          ? Math.min(5, Math.max(2, token.length / 2))
          : Math.min(4, Math.max(1.5, token.length));
      }
    }

    if (profile.channelType && profile.channelType === query.channelType) score += 1;
    if (profile.chatId && profile.chatId === query.chatId) score += 5;
    if (query.userId && profile.userId && profile.userId === query.userId) score += 6;
    if (
      query.userDisplayName
      && profile.displayName
      && (profile.displayName.includes(query.userDisplayName) || query.userDisplayName.includes(profile.displayName))
    ) {
      score += 3;
    }
    if (
      profile.workingDirectory
      && query.workingDirectory
      && profile.workingDirectory.toLowerCase() === query.workingDirectory.toLowerCase()
    ) {
      score += 3;
    }
    if (MEMORY_RECALL_RE.test(query.query)) {
      if (profile.scope === 'user' && query.userId && profile.userId === query.userId) score += 4;
      if (profile.scope === 'chat' && profile.chatId === query.chatId) score += 3;
      if (profile.scope === 'global') score += 1;
    }

    const ageMs = Date.now() - Date.parse(profile.lastEventAt || profile.updatedAt);
    if (!Number.isNaN(ageMs)) {
      if (ageMs < 24 * 60 * 60 * 1000) score += 1.5;
      else if (ageMs < 14 * 24 * 60 * 60 * 1000) score += 0.5;
    }

    return score;
  }

  private searchMemoryProfiles(query: MemoryRetrievalQuery, tokens: string[]): RetrievedMemoryHit[] {
    if (this.memoryProfiles.size === 0) return [];
    if (tokens.length === 0 && !MEMORY_RECALL_RE.test(query.query)) return [];

    const hits: RetrievedMemoryHit[] = [];
    for (const profile of this.memoryProfiles.values()) {
      if (profile.scope === 'user' && profile.userId !== query.userId) continue;
      if (profile.scope === 'chat' && profile.chatId !== query.chatId) continue;
      if (profile.scope === 'global') continue;
      const text = this.summarizeProfileForMemory(profile);
      if (!text) continue;
      const score = this.scoreMemoryProfile(query, tokens, profile, text);
      if (score < MEMORY_MIN_SCORE) continue;
      const structuredPairs = inferStructuredMemories(text);
      const structured = structuredPairs[0] || null;
      hits.push({
        sessionId: `memory-profile:${profile.key}`,
        channelType: profile.channelType,
        chatId: profile.chatId,
        workingDirectory: profile.workingDirectory,
        role: 'assistant',
        source: 'summary',
        sourceType: 'profile',
        score,
        confidence: Math.max(0, Math.min(0.9, score / 18)),
        answerability: structured ? 'structured' : 'summary',
        quality: isLowValueMemoryText(text) ? 'low' : (structured ? 'high' : 'medium'),
        structuredKey: structured?.key,
        structuredValue: structured?.value,
        structuredPairs,
        content: this.summarizeMessageContent(text, 260),
      });
    }
    return hits;
  }

  private searchAuditLogForMemory(query: MemoryRetrievalQuery, tokens: string[]): RetrievedMemoryHit[] {
    if (this.auditLog.length === 0) return [];
    if (tokens.length === 0 && !MEMORY_RECALL_RE.test(query.query)) return [];

    const hits: RetrievedMemoryHit[] = [];
    const dedup = new Set<string>();
    for (const entry of this.auditLog) {
      if (entry.direction !== 'outbound') continue;
      if (entry.channelType !== query.channelType || entry.chatId !== query.chatId) continue;
      const searchText = this.summarizeMessageContent(entry.summary || '', 12000);
      if (!searchText || isLowValueMemoryText(searchText)) continue;
      const contentKey = crypto
        .createHash('sha1')
        .update(`${entry.channelType}:${entry.chatId}:${entry.direction}:${searchText}`)
        .digest('hex');
      if (dedup.has(contentKey)) continue;

      let score = this.scoreMemoryHit(
        query,
        tokens,
        searchText,
        {
          channelType: entry.channelType,
          chatId: entry.chatId,
          updatedAt: entry.createdAt,
        },
        `audit:${entry.id}`,
        'message',
        entry.direction === 'outbound' ? 'assistant' : 'user',
      );
      if (entry.direction === 'outbound') score += 1;
      if (MEMORY_RECALL_RE.test(query.query) && /(对应表|常用|==|=>|->)/.test(searchText)) score += 3;
      if (score < (MEMORY_RECALL_RE.test(query.query) ? 4 : MEMORY_MIN_SCORE)) continue;

      dedup.add(contentKey);
      const structuredPairs = inferStructuredMemories(searchText);
      const structured = structuredPairs[0] || null;
      hits.push({
        sessionId: `audit:${entry.id}`,
        channelType: entry.channelType,
        chatId: entry.chatId,
        role: entry.direction === 'outbound' ? 'assistant' : 'user',
        source: 'message',
        sourceType: 'audit',
        score,
        confidence: Math.max(0, Math.min(0.92, score / 16)),
        answerability: structured ? 'structured' : 'summary',
        quality: structured ? 'high' : 'medium',
        structuredKey: structured?.key,
        structuredValue: structured?.value,
        structuredPairs,
        content: this.buildMatchedMemoryExcerpt(searchText, tokens, 300),
      });
    }
    return hits;
  }

  private buildMatchedMemoryExcerpt(searchText: string, tokens: string[], maxLen = 220): string {
    const normalized = searchText.replace(/\s+/g, ' ').trim();
    if (!normalized) return '';

    const orderedTokens = [...tokens].sort((left, right) => right.length - left.length);
    const lower = normalized.toLowerCase();
    let matchIndex = -1;
    let matchLength = 0;

    for (const token of orderedTokens) {
      const candidateIndex = lower.indexOf(token.toLowerCase());
      if (candidateIndex >= 0) {
        matchIndex = candidateIndex;
        matchLength = token.length;
        break;
      }
    }

    if (matchIndex < 0) {
      return this.summarizeMessageContent(normalized, maxLen);
    }

    const half = Math.max(40, Math.floor(maxLen / 2));
    const start = Math.max(0, matchIndex - half);
    const end = Math.min(normalized.length, matchIndex + matchLength + half);
    const snippet = normalized.slice(start, end).trim();
    return `${start > 0 ? '...' : ''}${snippet}${end < normalized.length ? '...' : ''}`;
  }

  private buildCompactedSummary(previousSummary: string, removed: BridgeMessage[]): string {
    return this.buildAdaptiveCompactedSummary(previousSummary, removed);
  }

  private buildAdaptiveCompactedSummary(previousSummary: string, removed: BridgeMessage[]): string {
    const userSnippets = this.collectRecentUserTopics(removed);
    const assistantSnippets = this.collectCompletedWork(removed);
    const constraintSnippets = this.collectConstraints(removed);
    const pendingSnippets = this.collectPendingWork(removed);
    const toolHints = this.collectToolHints(removed);
    const normalizedPreviousSummary = this.normalizePreviousSummary(previousSummary);

    const sections = [
      '会话摘要（自动升级，完整原记录已归档）',
      `- 本轮已压缩较早消息: ${removed.length} 条`,
    ];

    if (normalizedPreviousSummary) {
      sections.push(`- 继承上次摘要: ${this.summarizeMessageContent(normalizedPreviousSummary, 240)}`);
    }
    if (userSnippets.length > 0) {
      sections.push(`- 当前目标: ${userSnippets.join(' | ')}`);
    }
    if (constraintSnippets.length > 0) {
      sections.push(`- 约束要求: ${constraintSnippets.join(' | ')}`);
    }
    if (assistantSnippets.length > 0) {
      sections.push(`- 已完成工作: ${assistantSnippets.join(' | ')}`);
    }
    if (toolHints.length > 0) {
      sections.push(`- 关键操作: ${toolHints.join(' | ')}`);
    }
    if (pendingSnippets.length > 0) {
      sections.push(`- 后续待办: ${pendingSnippets.join(' | ')}`);
    }

    return `${SUMMARY_MARKER}\n${sections.join('\n')}`;
  }

  private maybeCompactMessages(sessionId: string, msgs: BridgeMessage[]): void {
    const totalChars = msgs.reduce((sum, message) => sum + (message.content?.length || 0), 0);
    if (msgs.length <= MAX_ACTIVE_MESSAGES && totalChars <= MAX_ACTIVE_CHARS) {
      return;
    }

    const existingSummary = msgs[0]?.role === 'assistant' && msgs[0].content.startsWith(SUMMARY_MARKER)
      ? msgs[0].content.slice(SUMMARY_MARKER.length).trim()
      : '';
    const summaryOffset = existingSummary ? 1 : 0;
    const cutIndex = Math.max(summaryOffset, msgs.length - KEEP_RECENT_MESSAGES);
    if (cutIndex <= summaryOffset) {
      return;
    }

    const removed = msgs.slice(summaryOffset, cutIndex);
    if (removed.length === 0) {
      return;
    }

    this.archiveCompactedMessages(sessionId, removed);

    const summaryMessage: BridgeMessage = {
      role: 'assistant',
      content: this.buildCompactedSummary(existingSummary, removed),
    };

    msgs.splice(0, cutIndex, summaryMessage);
  }

  // Settings

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  // Channel Bindings

  getChannelBinding(channelType: string, chatId: string): ChannelBinding | null {
    return this.bindings.get(`${channelType}:${chatId}`) ?? null;
  }

  upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding {
    const key = `${data.channelType}:${data.chatId}`;
    const existing = this.bindings.get(key);
    const nextMode = (data.mode as ChannelBinding['mode'] | undefined)
      ?? existing?.mode
      ?? (this.settings.get('bridge_default_mode') as ChannelBinding['mode'] | null)
      ?? 'code';
    if (existing) {
      const updated: ChannelBinding = {
        ...existing,
        displayName: data.displayName ?? existing.displayName,
        chatType: data.chatType ?? existing.chatType,
        codepilotSessionId: data.codepilotSessionId,
        sdkSessionId: data.sdkSessionId ?? existing.sdkSessionId,
        workingDirectory: data.workingDirectory,
        model: data.model,
        mode: nextMode,
        bridgeFingerprint: data.bridgeFingerprint ?? existing.bridgeFingerprint,
        toolingFingerprint: data.toolingFingerprint ?? existing.toolingFingerprint,
        updatedAt: now(),
      };
      this.bindings.set(key, updated);
      this.persistBindings();
      return updated;
    }
    const binding: ChannelBinding = {
      id: uuid(),
      channelType: data.channelType,
      chatId: data.chatId,
      displayName: data.displayName,
      chatType: data.chatType,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: data.sdkSessionId || '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: nextMode,
      bridgeFingerprint: data.bridgeFingerprint,
      toolingFingerprint: data.toolingFingerprint,
      active: true,
      createdAt: now(),
      updatedAt: now(),
    };
    this.bindings.set(key, binding);
    this.persistBindings();
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [key, b] of this.bindings) {
      if (b.id === id) {
        this.bindings.set(key, { ...b, ...updates, updatedAt: now() });
        this.persistBindings();
        break;
      }
    }
  }

  listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
    const all = Array.from(this.bindings.values());
    if (!channelType) return all;
    return all.filter((b) => b.channelType === channelType);
  }

  upsertFeishuChatIndex(data: {
    chatId: string;
    chatType?: string;
    displayName?: string;
    lastMessageAt?: string;
    lastSenderId?: string;
  }): void {
    const chatId = data.chatId.trim();
    if (!chatId) return;
    const existing = this.feishuChatIndex.get(chatId);
    const record: FeishuChatIndexRecord = {
      chatId,
      chatType: data.chatType ?? existing?.chatType,
      displayName: data.displayName ?? existing?.displayName ?? chatId,
      lastMessageAt: data.lastMessageAt ?? existing?.lastMessageAt,
      lastSenderId: data.lastSenderId ?? existing?.lastSenderId,
      updatedAt: now(),
    };
    this.feishuChatIndex.set(chatId, record);
    this.persistFeishuChatIndex();
  }

  getFeishuP2pUserAlias(userId: string): FeishuP2pUserAliasRecord | null {
    const key = userId.trim();
    if (!key) return null;
    return this.feishuP2pUserIndex.get(key) ?? null;
  }

  upsertFeishuP2pUserAlias(data: {
    userId: string;
    latestChatId: string;
    canonicalChatId?: string;
    displayName?: string;
  }): FeishuP2pUserAliasRecord | null {
    const userId = data.userId.trim();
    const latestChatId = data.latestChatId.trim();
    if (!userId || !latestChatId) return null;
    const existing = this.feishuP2pUserIndex.get(userId);
    const record: FeishuP2pUserAliasIndexRecord = {
      userId,
      latestChatId,
      canonicalChatId: data.canonicalChatId?.trim() || existing?.canonicalChatId || latestChatId,
      displayName: data.displayName ?? existing?.displayName,
      updatedAt: now(),
    };
    this.feishuP2pUserIndex.set(userId, record);
    this.persistFeishuP2pUserIndex();
    return record;
  }

  upsertFeishuHistoryMessages(data: {
    chatId: string;
    displayName?: string;
    chatType?: string;
    messages: FeishuHistoryIndexedMessage[];
    syncedAt?: string;
  }): FeishuHistorySyncStatus | null {
    const chatId = data.chatId.trim();
    if (!chatId) return null;

    const existing = this.loadFeishuHistoryMessages(chatId);
    const merged = new Map<string, FeishuHistoryIndexedMessage>();
    for (const item of existing) merged.set(item.messageId, item);
    for (const item of data.messages) {
      if (!item.messageId?.trim()) continue;
      const text = this.sanitizePersistedText(item.text || '');
      merged.set(item.messageId, {
        ...item,
        chatId,
        text,
      });
    }

    const nextMessages = [...merged.values()]
      .sort((left, right) => Number.parseInt(left.createTime || '0', 10) - Number.parseInt(right.createTime || '0', 10));
    this.persistFeishuHistoryMessages(chatId, nextMessages);

    const status: FeishuHistoryIndexRecord = {
      chatId,
      displayName: data.displayName || this.feishuChatIndex.get(chatId)?.displayName || chatId,
      chatType: data.chatType || this.feishuChatIndex.get(chatId)?.chatType,
      messageCount: nextMessages.length,
      oldestMessageTime: nextMessages[0]?.createTime,
      latestMessageTime: nextMessages[nextMessages.length - 1]?.createTime,
      lastSyncAt: data.syncedAt || now(),
    };
    this.feishuHistoryIndex.set(chatId, status);
    this.persistFeishuHistoryIndex();
    this.upsertFeishuChatIndex({
      chatId,
      chatType: status.chatType,
      displayName: status.displayName,
      lastMessageAt: status.latestMessageTime,
    });
    this.recordFeishuHistoryProfiles(chatId, status.displayName, data.messages);
    return status;
  }

  getFeishuHistorySyncStatus(chatId?: string): FeishuHistorySyncStatus[] {
    const all = [...this.feishuHistoryIndex.values()].sort((left, right) =>
      Date.parse(right.lastSyncAt || right.latestMessageTime || '') - Date.parse(left.lastSyncAt || left.latestMessageTime || '')
    );
    if (!chatId) return all;
    return all.filter((item) => item.chatId === chatId);
  }

  retrieveRelevantFeishuHistory(query: FeishuHistoryQuery): RetrievedFeishuHistoryContext | null {
    const chatId = query.chatId.trim();
    if (!chatId) return null;
    const allMessages = this.loadFeishuHistoryMessages(chatId)
      .map((item) => ({
        ...item,
        senderName: this.sanitizePersistedText(item.senderName || ''),
        text: this.sanitizePersistedText(item.text || ''),
      }))
      .filter((item) => item.text);
    if (allMessages.length === 0) return null;

    const tokens = this.extractMemoryTokens(query.query);
    const targetSpeakerNames = (query.targetSpeakerNames || []).map((name) => name.trim()).filter(Boolean);
    const filtered = allMessages.filter((item) => {
      const ts = Number.parseInt(item.createTime || '0', 10);
      if (query.startTimeMs !== undefined && ts < query.startTimeMs) return false;
      if (query.endTimeMs !== undefined && ts >= query.endTimeMs) return false;
      if (targetSpeakerNames.length === 0) return true;
      const speakerHaystack = `${item.senderName || ''} ${item.senderId || ''}`.trim();
      return targetSpeakerNames.some((target) =>
        speakerHaystack.includes(target)
        || target.includes(item.senderName || '')
        || (item.text || '').includes(target)
      );
    });
    if (filtered.length === 0) return null;

    const scored = filtered.map((item) => {
      const haystack = `${item.senderName || ''} ${item.senderId || ''} ${item.text || ''}`;
      let score = 0;
      for (const token of tokens) {
        const needle = /[a-z]/i.test(token) ? token.toLowerCase() : token;
        const source = /[a-z]/i.test(token) ? haystack.toLowerCase() : haystack;
        if (source.includes(needle)) {
          score += /[a-z]/i.test(token)
            ? Math.min(5, Math.max(2, token.length / 2))
            : Math.min(4, Math.max(1.5, token.length));
        }
      }
      if (targetSpeakerNames.length > 0) score += 4;
      return { item, score };
    });

    const selected = scored
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, query.limit))
      .map((entry) => entry.item)
      .sort((left, right) => Number.parseInt(left.createTime || '0', 10) - Number.parseInt(right.createTime || '0', 10));

    const formattedHistory = selected
      .map((item) => {
        const date = Number.parseInt(item.createTime || '0', 10);
        const label = Number.isFinite(date) && date > 0
          ? new Date(date).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
          : '未知时间';
        const speaker = item.senderName || item.senderId || (item.senderType === 'app' ? '机器人' : '用户');
        return `[${label}] ${speaker}: ${item.text}`;
      })
      .join('\n');

    if (!formattedHistory) return null;
    const syncStatus = this.feishuHistoryIndex.get(chatId);
    return {
      summary: formattedHistory,
      items: selected,
      syncStatus,
    };
  }

  // Sessions

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  createSession(
    _name: string,
    model: string,
    systemPrompt?: string,
    cwd?: string,
    _mode?: string,
  ): BridgeSession {
    const session: BridgeSession = {
      id: uuid(),
      working_directory: cwd || this.settings.get('bridge_default_work_dir') || process.cwd(),
      model,
      system_prompt: systemPrompt,
    };
    this.sessions.set(session.id, session);
    this.persistSessions();
    return session;
  }

  updateSessionProviderId(sessionId: string, providerId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.provider_id = providerId;
      this.persistSessions();
    }
  }

  // Messages

  addMessage(sessionId: string, role: string, content: string, _usage?: string | null): void {
    const msgs = this.loadMessages(sessionId);
    msgs.push({ role, content });
    this.maybeCompactMessages(sessionId, msgs);
    this.persistMessages(sessionId);
  }

  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const msgs = this.loadMessages(sessionId);
    if (opts?.limit && opts.limit > 0) {
      return { messages: msgs.slice(-opts.limit) };
    }
    return { messages: [...msgs] };
  }

  private applyMemoryEvent(event: ConversationMemoryEvent): boolean {
    const text = this.summarizeMessageContent(event.text || '', 800);
    if (!text) return false;

    // Conversation capture is temporary/profile evidence only. Durable memory
    // may be promoted exclusively by the classified write path in bridge-core.
    const items = this.extractMemoryProfileItems(text, event.role);
    const hasUsefulItems = items.topics.length > 0 || items.facts.length > 0 || items.pending.length > 0;
    if (!hasUsefulItems && text.length < 12) return false;

    const timestampedEvent: ConversationMemoryEvent = {
      ...event,
      text,
      createdAt: event.createdAt || now(),
    };

    if (event.chatId?.trim()) {
      const chatKey = this.memoryProfileKey('chat', event.channelType, event.chatId);
      this.upsertMemoryProfile('chat', chatKey, timestampedEvent, items);
    }

    if (event.userId?.trim() && event.role === 'user') {
      const userKey = this.memoryProfileKey('user', event.channelType, event.userId);
      this.upsertMemoryProfile('user', userKey, timestampedEvent, items);
    }

    return true;
  }

  private persistExplicitMemoryWrite(
    event: ConversationMemoryEvent,
    text: string,
    candidates?: MemoryWriteCandidate[],
    classification?: MemoryWriteClassification,
  ): MemoryWriteResult {
    if (event.role !== 'user') return { ok: false, skipped: true, error: 'not_user_message' };
    const memoryRoot = this.settings.get('bridge_memory_repo_dir');
    if (!memoryRoot) return { ok: false, error: 'bridge_memory_repo_dir is not configured' };
    const partition = resolveDurableMemoryDirectory(memoryRoot, {
      channelType: event.channelType,
      chatId: event.chatId,
      userId: event.userId,
      classification,
    });
    if (!partition.dir) return { ok: false, skipped: true, error: partition.error };

    const candidatePairs = normalizeMemoryWriteCandidates(candidates);
    if (candidatePairs.length === 0) {
      return { ok: false, skipped: true, error: 'classified durable memory requires structured candidates' };
    }

    const pairSeen = new Set<string>();
    const pairs: Array<{ key: string; value: string }> = [];
    for (const pair of candidatePairs) {
      addMemoryCandidatePair(pairs, pairSeen, pair.key, pair.value);
    }
    const cleanedText = cleanMemoryWriteText(text) || text;
    const firstContentLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || cleanedText;
    const cleanedTitle = cleanMemoryWriteText(firstContentLine) || cleanedText;
    const bodyText = /\r?\n/.test(text) ? text : cleanedText;
    const title = candidatePairs[0]?.key || cleanedTitle.slice(0, 40);
    const dir = partition.dir;
    const filePath = path.join(dir, `${slugForFileName(title)}.md`);
    const createdAt = event.createdAt || now();
    const frontmatter = [
      '---',
      `schema: ${MEMORY_V2_SCHEMA}`,
      `createdAt: ${createdAt}`,
      `updatedAt: ${now()}`,
      `memoryScope: ${classification!.scope}`,
      `intentConfidence: ${classification!.confidence}`,
      `channelType: ${event.channelType || ''}`,
      `chatId: ${event.chatId || ''}`,
      `userId: ${event.userId || ''}`,
      `displayName: ${event.userDisplayName || ''}`,
      '---',
      '',
    ].join('\n');
    const body: string[] = [
      `# ${title}`,
      '',
      bodyText,
      '',
    ];
    const prefixedLine = inferExplicitMemoryPrefixedLine(bodyText);
    if (prefixedLine) {
      body.push(prefixedLine, '');
    }

    if (pairs.length > 0) {
      body.push('| key | value |', '| --- | --- |');
      for (const pair of pairs) {
        body.push(`| ${escapeMarkdownTableCell(pair.key)} | ${escapeMarkdownTableCell(pair.value)} |`);
      }
      body.push('');
    }

    try {
      ensureDir(dir);
      atomicWrite(filePath, `${frontmatter}${body.join('\n')}`);
      rebuildKnowledgeIndex(memoryRoot);
      return {
        ok: true,
        memoryRoot,
        filePath,
        knowledgeRebuilt: true,
        scope: classification!.scope,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[store] Failed to persist explicit memory write:', message);
      return {
        ok: false,
        memoryRoot,
        filePath,
        knowledgeRebuilt: false,
        scope: classification!.scope,
        error: message,
      };
    }
  }

  persistMemoryWrite(input: MemoryWriteInput): MemoryWriteResult {
    return this.persistExplicitMemoryWrite({
      sessionId: input.sessionId,
      channelType: input.channelType,
      chatId: input.chatId,
      chatDisplayName: input.chatDisplayName,
      userId: input.userId,
      userDisplayName: input.userDisplayName,
      role: 'user',
      text: input.text,
      workingDirectory: input.workingDirectory,
      createdAt: input.createdAt || now(),
    }, this.sanitizePersistedText(input.text || ''), input.candidates, input.classification);
  }

  recordMemoryEvent(event: ConversationMemoryEvent): void {
    if (!this.applyMemoryEvent(event)) return;
    this.persistMemoryProfiles();
  }

  retrieveRelevantMemory(query: MemoryRetrievalQuery): RetrievedMemoryContext | null {
    const tokens = this.extractMemoryTokens(query.query);
    const knowledgeHits = this.searchKnowledgeIndexForMemory(query, tokens);
    const graphContext = this.retrieveMemoryGraphContext(query);
    const graphHits: RetrievedMemoryHit[] = (graphContext?.related || [])
      .slice(0, 4)
      .map((item) => ({
        sessionId: `memory-graph:${item.id}`,
        channelType: query.channelType,
        chatId: query.chatId,
        workingDirectory: query.workingDirectory,
        role: 'assistant' as const,
        source: 'summary' as const,
        sourceType: 'knowledge' as const,
        score: Math.max(0, item.score) + 3,
        confidence: Math.max(0.45, Math.min(0.88, item.score / 12)),
        answerability: item.edgeTypes.includes('maps_to') || item.edgeTypes.includes('reverse_lookup') ? 'structured' as const : 'summary' as const,
        quality: 'medium' as const,
        structuredKey: query.query,
        structuredValue: item.label,
        content: `[记忆关系图] ${query.query} -> ${item.label}（${item.edgeTypes.join(', ')}）`,
      }));
    if (tokens.length === 0 && !MEMORY_RECALL_RE.test(query.query) && knowledgeHits.length === 0 && graphHits.length === 0) return null;

    const metaBySession = this.buildMemorySessionMeta();
    const sameChatHits: RetrievedMemoryHit[] = [];
    const currentSessionHits: RetrievedMemoryHit[] = [];
    const auditHits = this.searchAuditLogForMemory(query, tokens);
    const profileHits = this.searchMemoryProfiles(query, tokens);
    const dedup = new Set<string>();
    const recentHistoryLimit = Math.max(0, query.recentHistoryLimit || 0);

    for (const [sessionId, session] of this.sessions) {
      const meta = metaBySession.get(sessionId) || {
        workingDirectory: session.working_directory,
      };

      const sameChat = meta.channelType === query.channelType && meta.chatId === query.chatId;
      const isCurrentSession = sessionId === query.sessionId;

      if (!sameChat && !isCurrentSession) continue;

      const messages = this.loadMessages(sessionId);
      const candidates = this.selectMessagesForMemory(isCurrentSession, messages, recentHistoryLimit);
      const archivedCandidates = this.loadArchivedMessagesForMemory(sessionId);

      const memoryCandidates = [...candidates, ...archivedCandidates];
      for (let index = 0; index < memoryCandidates.length; index += 1) {
        const message = memoryCandidates[index];
        const summarized = this.summarizeMessageForMemory(message);
        if (!summarized) continue;
        const adjacentAnswer = message.role !== 'assistant'
          ? this.summarizeAdjacentAssistantAnswer(memoryCandidates, index)
          : null;
        const combinedSearchText = adjacentAnswer
          ? `${summarized.searchText}\n相邻助手回复：${adjacentAnswer.searchText}`
          : summarized.searchText;
        const contentKey = crypto
          .createHash('sha1')
          .update(`${summarized.source}:${message.role}:${combinedSearchText}`)
          .digest('hex');
        if (dedup.has(contentKey)) continue;

        const score = this.scoreMemoryHit(
          query,
          tokens,
          combinedSearchText,
          meta,
          sessionId,
          summarized.source,
          message.role,
        );
        if (score < MEMORY_MIN_SCORE) continue;

        dedup.add(contentKey);
        const structuredPairs = inferStructuredMemories(combinedSearchText);
        const structured = structuredPairs[0] || null;
        const hit: RetrievedMemoryHit = {
          sessionId,
          channelType: meta.channelType,
          chatId: meta.chatId,
          workingDirectory: meta.workingDirectory,
          role: message.role === 'assistant' ? 'assistant' : 'user',
          source: summarized.source,
          sourceType: sameChat ? 'chat' : (isCurrentSession ? 'session' : 'workdir'),
          score,
          confidence: Math.max(0, Math.min(0.9, score / 18)),
          answerability: structured ? 'structured' : 'summary',
          quality: isLowValueMemoryText(combinedSearchText) ? 'low' : (structured ? 'high' : 'medium'),
          structuredKey: structured?.key,
          structuredValue: structured?.value,
          structuredPairs,
          content: adjacentAnswer
            ? [
              `用户请求：${this.buildMatchedMemoryExcerpt(summarized.searchText, tokens, 220)}`,
              `相邻助手回复：${adjacentAnswer.content}`,
            ].join('；')
            : this.buildMatchedMemoryExcerpt(combinedSearchText, tokens),
        };
        if (sameChat) sameChatHits.push(hit);
        else if (isCurrentSession) currentSessionHits.push(hit);
      }
    }

    const hits = [
      ...knowledgeHits,
      ...graphHits,
      ...sameChatHits,
      ...currentSessionHits,
      ...auditHits,
      ...profileHits,
    ];

    const selected: RetrievedMemoryHit[] = [];
    let usedChars = 0;
    for (const hit of hits.sort((left, right) => right.score - left.score)) {
      if (hit.quality === 'low' || isLowValueMemoryText(hit.content)) continue;
      const nextChars = usedChars + hit.content.length;
      if (selected.length > 0 && nextChars > MEMORY_MAX_CHARS) break;
      selected.push(hit);
      usedChars = nextChars;
      if (selected.length >= MEMORY_MAX_HITS) break;
    }

    if (selected.length === 0) return null;
    return {
      summary: this.buildMemorySummary(selected),
      hits: selected,
    };
  }

  decideMemoryReply(query: MemoryRetrievalQuery): MemoryReplyDecision {
    const plan = planMemoryQuery(query.query);
    if (plan.intent !== 'explicit_recall') {
      return {
        type: 'augment_codex',
        memory: null,
        plan,
      };
    }
    const memory = this.retrieveRelevantMemory({
      ...query,
      query: plan.normalizedKey || plan.queryText,
      recentHistoryLimit: plan.intent === 'explicit_recall' ? 0 : query.recentHistoryLimit,
    });
    return decideMemoryReplyFromHits(plan, memory);
  }

  retrieveMemoryGraphContext(query: MemoryRetrievalQuery): MemoryGraphContext | null {
    const memoryRoot = this.settings.get('bridge_memory_repo_dir');
    if (!memoryRoot) return null;
    const graph = readMemoryGraphIndex(memoryRoot);
    if (!graph) return null;
    const context = searchMemoryGraph(this.filterMemoryGraphForQuery(graph, memoryRoot, query), query.query, { limit: MEMORY_MAX_HITS });
    return context.related.length > 0 ? context : null;
  }

  reviewOutboundAnswer(input: AnswerReviewInput): AnswerReviewDecision {
    const modeSetting = this.settings.get('bridge_answer_review_mode') || process.env.CTI_ANSWER_REVIEW_MODE || '';
    const configuredMode = modeSetting === 'block_or_replace'
      ? 'block_or_replace'
      : 'observe';
    const decision = reviewOutboundAnswerRules(input, { mode: configuredMode });
    this.appendAnswerReviewAudit(input, decision);
    return decision;
  }

  private appendAnswerReviewAudit(input: AnswerReviewInput, decision: AnswerReviewDecision): void {
    if (decision.verdict === 'pass' && decision.reasonCodes.length === 0) return;
    const existing = readJson<AnswerReviewAuditRecord[]>(ANSWER_REVIEW_AUDIT_PATH, []);
    const record: AnswerReviewAuditRecord = {
      ...decision,
      id: uuid(),
      channelType: input.channelType,
      chatId: input.chatId,
      userId: input.userId,
      userText: this.summarizeMessageContent(input.userText || '', 800),
      answerText: this.summarizeMessageContent(input.answerText || '', 1200),
      source: input.source,
      executionEvidence: input.executionEvidence,
    };
    writeJson(ANSWER_REVIEW_AUDIT_PATH, [...existing, record].slice(-500));
  }

  // Session Locking

  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean {
    const existing = this.locks.get(sessionId);
    if (existing && existing.expiresAt > Date.now()) {
      // Lock held by someone else
      if (existing.lockId !== lockId) return false;
    }
    this.locks.set(sessionId, {
      lockId,
      owner,
      expiresAt: Date.now() + ttlSecs * 1000,
    });
    return true;
  }

  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      lock.expiresAt = Date.now() + ttlSecs * 1000;
    }
  }

  releaseSessionLock(sessionId: string, lockId: string): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      this.locks.delete(sessionId);
    }
  }

  setSessionRuntimeStatus(_sessionId: string, _status: string): void {
    // no-op for file-based store
  }

  // SDK Session

  updateSdkSessionId(sessionId: string, sdkSessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      // Store sdkSessionId on the session object
      (s as unknown as Record<string, unknown>)['sdk_session_id'] = sdkSessionId;
      this.persistSessions();
    }
    // Also update any bindings that reference this session
    for (const [key, b] of this.bindings) {
      if (b.codepilotSessionId === sessionId) {
        this.bindings.set(key, { ...b, sdkSessionId, updatedAt: now() });
      }
    }
    this.persistBindings();
  }

  updateSessionModel(sessionId: string, model: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.model = model;
      this.persistSessions();
    }
  }

  syncSdkTasks(_sessionId: string, _todos: unknown): void {
    // no-op
  }

  // Provider

  getProvider(_id: string): BridgeApiProvider | undefined {
    return undefined;
  }

  getDefaultProviderId(): string | null {
    return null;
  }

  // Audit & Dedup

  insertAuditLog(entry: AuditLogInput): void {
    this.auditLog.push({
      ...entry,
      id: uuid(),
      createdAt: now(),
    });
    // Ring buffer: keep last 1000
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
    this.persistAudit();
  }

  listAuditLogs(filter: {
    channelType?: string;
    chatId?: string;
    direction?: 'inbound' | 'outbound';
    messageId?: string;
    limit?: number;
  } = {}): Array<AuditLogInput & { id?: string; createdAt?: string }> {
    const limit = Number.isFinite(filter.limit)
      ? Math.max(1, Math.min(200, Math.floor(filter.limit as number)))
      : 50;
    return [...this.auditLog]
      .reverse()
      .filter((entry) => !filter.channelType || entry.channelType === filter.channelType)
      .filter((entry) => !filter.chatId || entry.chatId === filter.chatId)
      .filter((entry) => !filter.direction || entry.direction === filter.direction)
      .filter((entry) => !filter.messageId || entry.messageId === filter.messageId)
      .slice(0, limit);
  }

  checkDedup(key: string): boolean {
    const ts = this.dedupKeys.get(key);
    if (ts === undefined) return false;
    // 5 minute window
    if (Date.now() - ts > 5 * 60 * 1000) {
      this.dedupKeys.delete(key);
      return false;
    }
    return true;
  }

  insertDedup(key: string): void {
    this.dedupKeys.set(key, Date.now());
    this.persistDedup();
  }

  cleanupExpiredDedup(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    let changed = false;
    for (const [key, ts] of this.dedupKeys) {
      if (ts < cutoff) {
        this.dedupKeys.delete(key);
        changed = true;
      }
    }
    if (changed) this.persistDedup();
  }

  insertOutboundRef(ref: OutboundRefInput): void {
    const channelType = ref.channelType?.trim();
    const chatId = ref.chatId?.trim();
    const platformMessageId = ref.platformMessageId?.trim();
    if (!channelType || !chatId || !platformMessageId) return;
    const key = this.outboundRefKey(channelType, chatId, platformMessageId);
    const existing = this.outboundRefs.get(key);
    const createdAt = existing?.createdAt || ref.createdAt || now();
    this.outboundRefs.set(key, {
      ...existing,
      ...ref,
      channelType,
      chatId,
      platformMessageId,
      codepilotSessionId: ref.codepilotSessionId || existing?.codepilotSessionId || '',
      purpose: ref.purpose || existing?.purpose || 'response',
      createdAt,
      updatedAt: now(),
    });
    this.persistOutboundRefs();
  }

  listOutboundRefs(filter: OutboundRefFilter = {}): OutboundRefRecord[] {
    return [...this.outboundRefs.values()]
      .filter((ref) => !filter.channelType || ref.channelType === filter.channelType)
      .filter((ref) => !filter.chatId || ref.chatId === filter.chatId)
      .filter((ref) => !filter.platformMessageId || ref.platformMessageId === filter.platformMessageId)
      .filter((ref) => !filter.codepilotSessionId || ref.codepilotSessionId === filter.codepilotSessionId)
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
  }

  markOutboundRefRecalled(input: MarkOutboundRefRecalledInput): boolean {
    const key = this.outboundRefKey(input.channelType, input.chatId, input.platformMessageId);
    const existing = this.outboundRefs.get(key);
    if (!existing) return false;
    this.outboundRefs.set(key, {
      ...existing,
      recalledAt: input.ok ? (input.recalledAt || now()) : existing.recalledAt,
      recallError: input.ok ? undefined : (input.error || '撤回失败'),
      updatedAt: now(),
    });
    this.persistOutboundRefs();
    return true;
  }

  // Permission Links

  insertPermissionLink(link: PermissionLinkInput): void {
    const record: PermissionLinkRecord = {
      permissionRequestId: link.permissionRequestId,
      channelType: link.channelType,
      chatId: link.chatId,
      messageId: link.messageId,
      resolved: false,
      toolName: link.toolName,
      toolInputJson: link.toolInputJson,
      suggestions: link.suggestions,
    };
    this.permissionLinks.set(link.permissionRequestId, record);
    this.persistPermissions();
  }

  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null {
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }

  markPermissionLinkResolved(permissionRequestId: string): boolean {
    const link = this.permissionLinks.get(permissionRequestId);
    if (!link || link.resolved) return false;
    link.resolved = true;
    this.persistPermissions();
    return true;
  }

  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[] {
    const result: PermissionLinkRecord[] = [];
    for (const link of this.permissionLinks.values()) {
      if (link.chatId === chatId && !link.resolved) {
        result.push(link);
      }
    }
    return result;
  }

  // Channel Offsets

  getChannelOffset(key: string): string {
    return this.offsets.get(key) ?? '0';
  }

  setChannelOffset(key: string, offset: string): void {
    this.offsets.set(key, offset);
    this.persistOffsets();
  }
}

