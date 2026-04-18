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
  UpsertChannelBindingInput,
} from 'claude-to-im/src/lib/bridge/host.js';
import type { ChannelBinding, ChannelType } from 'claude-to-im/src/lib/bridge/types.js';
import { CTI_HOME } from './config.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const MESSAGE_ARCHIVES_DIR = path.join(DATA_DIR, 'message-archives');
const FEISHU_CHAT_INDEX_PATH = path.join(DATA_DIR, 'feishu-chat-index.json');
const FEISHU_P2P_USER_INDEX_PATH = path.join(DATA_DIR, 'feishu-p2p-user-index.json');
const FEISHU_HISTORY_DIR = path.join(DATA_DIR, 'feishu-history');
const FEISHU_HISTORY_INDEX_PATH = path.join(DATA_DIR, 'feishu-history-index.json');
const SUMMARY_MARKER = '[[CTI_SUMMARY]]';
const MAX_ACTIVE_MESSAGES = Math.max(20, Number.parseInt(process.env.CTI_HISTORY_MAX_MESSAGES || '80', 10) || 80);
const MAX_ACTIVE_CHARS = Math.max(8000, Number.parseInt(process.env.CTI_HISTORY_MAX_CHARS || '32000', 10) || 32000);
const KEEP_RECENT_MESSAGES = Math.max(12, Number.parseInt(process.env.CTI_HISTORY_KEEP_RECENT || '24', 10) || 24);
const SUMMARY_REFRESH_EVERY = Math.max(6, Number.parseInt(process.env.CTI_SUMMARY_REFRESH_EVERY || '12', 10) || 12);
const MEMORY_MAX_HITS = Math.max(2, Number.parseInt(process.env.CTI_MEMORY_MAX_HITS || '6', 10) || 6);
const MEMORY_MAX_CHARS = Math.max(600, Number.parseInt(process.env.CTI_MEMORY_MAX_CHARS || '2200', 10) || 2200);
const MEMORY_MIN_SCORE = Number.parseFloat(process.env.CTI_MEMORY_MIN_SCORE || '6') || 6;
const ENGLISH_STOP_TOKENS = new Set(['this', 'that', 'with', 'from', 'then', 'just', 'into', 'them', 'they', 'what', 'when', 'where', 'which', 'have', 'will', 'your', 'about', 'please']);
const CHINESE_STOP_TOKENS = new Set(['这个', '那个', '现在', '刚才', '继续', '直接', '帮我', '处理', '一下', '看看', '这里', '当前', '应该', '进行', '根据', '然后', '就是', '可以', '能够']);

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

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
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
  private feishuChatIndex = new Map<string, FeishuChatIndexRecord>();
  private feishuP2pUserIndex = new Map<string, FeishuP2pUserAliasIndexRecord>();
  private feishuHistoryIndex = new Map<string, FeishuHistoryIndexRecord>();
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
    const perms = readJson<Record<string, PermissionLinkRecord>>(
      path.join(DATA_DIR, 'permissions.json'),
      {},
    );
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
      path.join(DATA_DIR, 'permissions.json'),
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
      .sort((left, right) => right.localeCompare(left));

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
    return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 3)}...` : cleaned;
  }

  private extractStructuredMessageText(content: string, maxLen: number): string {
    try {
      const blocks = JSON.parse(content) as Array<Record<string, unknown>>;
      const parts: string[] = [];
      const textBudget = Math.max(4000, maxLen);
      const toolBudget = Math.max(4000, maxLen);
      for (const block of blocks) {
        if (block?.type === 'text') {
          const text = this.summarizeMessageContent(String(block.text || ''), textBudget);
          if (text) parts.push(text);
          continue;
        }
        if (block?.type === 'tool_use') {
          const name = String(block.name || '');
          const input = block.input as { command?: unknown; files?: Array<{ path?: string; kind?: string }> } | undefined;
          if (name === 'Bash' && typeof input?.command === 'string') {
            parts.push(`执行命令: ${this.summarizeMessageContent(input.command, 400)}`);
          } else if (name === 'Edit' && Array.isArray(input?.files)) {
            parts.push(`文件修改: ${input.files.slice(0, 8).map((file) => `${file.kind}:${file.path}`).join(', ')}`);
          } else if (name) {
            parts.push(`工具: ${name}`);
          }
          continue;
        }
        if (block?.type === 'tool_result') {
          const text = this.summarizeMessageContent(String(block.content || ''), toolBudget);
          if (text) parts.push(`工具结果: ${text}`);
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
    const normalized = text
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
    const content = this.summarizeMessageContent(message.content, 220);
    const searchText = this.summarizeMessageContent(message.content, 12000);
    return content ? { content, searchText, source: 'message' } : null;
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
      merged.set(item.messageId, {
        ...item,
        chatId,
        text: item.text || '',
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
    const allMessages = this.loadFeishuHistoryMessages(chatId);
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

  retrieveRelevantMemory(query: MemoryRetrievalQuery): RetrievedMemoryContext | null {
    const tokens = this.extractMemoryTokens(query.query);
    if (tokens.length === 0) return null;

    const metaBySession = this.buildMemorySessionMeta();
    const sameChatHits: RetrievedMemoryHit[] = [];
    const currentSessionHits: RetrievedMemoryHit[] = [];
    const sameWorkdirHits: RetrievedMemoryHit[] = [];
    const dedup = new Set<string>();
    const recentHistoryLimit = Math.max(0, query.recentHistoryLimit || 0);

    for (const [sessionId, session] of this.sessions) {
      const meta = metaBySession.get(sessionId) || {
        workingDirectory: session.working_directory,
      };

      const sameChat = meta.channelType === query.channelType && meta.chatId === query.chatId;
      const sameWorkdir = !!meta.workingDirectory && !!query.workingDirectory
        && meta.workingDirectory.toLowerCase() === query.workingDirectory.toLowerCase();
      const isCurrentSession = sessionId === query.sessionId;

      if (!sameChat && !sameWorkdir && !isCurrentSession) continue;

      const messages = this.loadMessages(sessionId);
      const candidates = this.selectMessagesForMemory(isCurrentSession, messages, recentHistoryLimit);
      const archivedCandidates = this.loadArchivedMessagesForMemory(sessionId);

      for (const message of [...candidates, ...archivedCandidates]) {
        const summarized = this.summarizeMessageForMemory(message);
        if (!summarized) continue;
        const contentKey = crypto
          .createHash('sha1')
          .update(`${summarized.source}:${message.role}:${summarized.searchText}`)
          .digest('hex');
        if (dedup.has(contentKey)) continue;

        const score = this.scoreMemoryHit(
          query,
          tokens,
          summarized.searchText,
          meta,
          sessionId,
          summarized.source,
          message.role,
        );
        if (score < MEMORY_MIN_SCORE) continue;

        dedup.add(contentKey);
        const hit: RetrievedMemoryHit = {
          sessionId,
          channelType: meta.channelType,
          chatId: meta.chatId,
          workingDirectory: meta.workingDirectory,
          role: message.role === 'assistant' ? 'assistant' : 'user',
          source: summarized.source,
          score,
          content: this.buildMatchedMemoryExcerpt(summarized.searchText, tokens),
        };
        if (sameChat) sameChatHits.push(hit);
        else if (isCurrentSession) currentSessionHits.push(hit);
        else sameWorkdirHits.push(hit);
      }
    }

    const hits = sameChatHits.length > 0
      ? sameChatHits
      : currentSessionHits.length > 0
        ? currentSessionHits
        : sameWorkdirHits;

    const selected: RetrievedMemoryHit[] = [];
    let usedChars = 0;
    for (const hit of hits.sort((left, right) => right.score - left.score)) {
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

  insertOutboundRef(_ref: OutboundRefInput): void {
    // no-op for file-based store
  }

  // Permission Links

  insertPermissionLink(link: PermissionLinkInput): void {
    const record: PermissionLinkRecord = {
      permissionRequestId: link.permissionRequestId,
      chatId: link.chatId,
      messageId: link.messageId,
      resolved: false,
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

