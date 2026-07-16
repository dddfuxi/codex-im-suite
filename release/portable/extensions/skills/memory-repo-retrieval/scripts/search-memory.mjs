import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SUMMARY_MARKER = '[[CTI_SUMMARY]]';
const LOW_VALUE_MEMORY_RE = /(没有可用.{0,36}(记忆|功能)|请手动记录|未完成：这个请求需要实际|已拦截通用手动排查步骤|无法访问聊天记录|没有拿到可用工具输出|不能把任务退回给用户|本地记录里没保存.{0,40}(完整|清单|摘要)|完整.{0,16}(列表|清单|名字).{0,24}(没|未)(在)?(归档里)?(命中|找到|保存))/i;
const home = resolveHistoryHome();
const dataDir = path.join(home, 'data');
const messagesDir = path.join(dataDir, 'messages');
const archivesDir = path.join(dataDir, 'message-archives');
const bindingsPath = path.join(dataDir, 'bindings.json');
const sessionsPath = path.join(dataDir, 'sessions.json');

const args = process.argv.slice(2);
const query = args.find((arg) => !arg.startsWith('--')) || '';
const chatId = readFlag('--chat');
const cwd = readFlag('--cwd');

if (!query) {
  console.error('用法: node search-memory.mjs "查询词" [--chat oc_xxx] [--cwd C:\\repo]');
  process.exit(1);
}

const bindings = readJson(bindingsPath, {});
const sessions = readJson(sessionsPath, {});
const tokens = extractTokens(query);
const hits = [];

for (const [sessionId, session] of Object.entries(sessions)) {
  const meta = findMeta(sessionId, bindings, session);
  if (chatId && meta.chatId !== chatId) continue;
  if (cwd && normalizePath(meta.workingDirectory) !== normalizePath(cwd)) continue;

  const filePath = path.join(messagesDir, `${sessionId}.json`);
  const messages = readJson(filePath, []);
  const archivedMessages = readArchivedMessages(sessionId);
  const memoryCandidates = [...selectMessages(messages), ...archivedMessages];
  for (let index = 0; index < memoryCandidates.length; index += 1) {
    const message = memoryCandidates[index];
    const rawContent = searchableMessage(message?.content || '');
    const adjacentAnswer = message?.role !== 'assistant'
      ? summarizeAdjacentAssistantAnswer(memoryCandidates, index)
      : null;
    const searchContent = adjacentAnswer
      ? `${rawContent}\n相邻助手回复：${adjacentAnswer.searchText}`
      : rawContent;
    if (isLowValueMemoryText(searchContent)) continue;
    const content = adjacentAnswer
      ? [
        `用户请求：${summarizeMessage(message?.content || '', 180)}`,
        `相邻助手回复：${adjacentAnswer.content}`,
      ].filter(Boolean).join('；')
      : summarizeMessage(message?.content || '');
    if (!content || !rawContent) continue;
    const score = scoreText(searchContent, tokens, meta, chatId, cwd, sessionId);
    if (score <= 0) continue;
    hits.push({
      sessionId,
      score,
      role: message?.role || 'unknown',
      source: String(message?.content || '').startsWith(SUMMARY_MARKER) ? 'summary' : 'message',
      chatId: meta.chatId,
      workingDirectory: meta.workingDirectory,
      content,
    });
  }
}

for (const hit of hits
  .sort((a, b) => b.score - a.score)
  .slice(0, 8)) {
  const tags = [hit.chatId, hit.workingDirectory ? path.basename(hit.workingDirectory) : '', hit.source]
    .filter(Boolean)
    .join(' / ');
  console.log(`[${tags}] score=${hit.score.toFixed(1)} ${hit.content}`);
}

function readFlag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

function resolveHistoryHome() {
  if (process.env.CTI_HOME && process.env.CTI_HOME.trim()) {
    return process.env.CTI_HOME.trim();
  }

  const defaultBridgeHome = path.join(os.homedir(), '.claude-to-im');
  const legacyMemoryHome = process.platform === 'win32' ? 'E:\\cli-md' : path.join(os.homedir(), '.claude-to-im', 'memory-repo');
  for (const candidate of [defaultBridgeHome, legacyMemoryHome]) {
    if (!candidate) continue;
    const dataRoot = path.join(candidate, 'data');
    // 原始聊天、Feishu history 和压缩归档属于 bridge runtime data。
    // 旧版曾把它们误当成 memory repo 下的数据；这里按真实存在的
    // runtime 数据目录优先，避免回捞历史时落到陈旧 E:\cli-md 副本。
    if (
      fs.existsSync(path.join(dataRoot, 'sessions.json'))
      || fs.existsSync(path.join(dataRoot, 'messages'))
      || fs.existsSync(path.join(dataRoot, 'message-archives'))
      || fs.existsSync(path.join(dataRoot, 'feishu-history'))
    ) {
      return candidate;
    }
  }
  return defaultBridgeHome;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizePath(value) {
  return String(value || '').replace(/\//g, '\\').toLowerCase();
}

function findMeta(sessionId, bindings, session) {
  for (const binding of Object.values(bindings)) {
    if (binding?.codepilotSessionId === sessionId) {
      return {
        chatId: binding.chatId || '',
        workingDirectory: binding.workingDirectory || session?.working_directory || '',
      };
    }
  }
  return {
    chatId: '',
    workingDirectory: session?.working_directory || '',
  };
}

function extractTokens(text) {
  const out = new Set();
  for (const token of text.toLowerCase().match(/[a-z0-9_./-]{3,}/g) || []) out.add(token);
  for (const token of text.match(/[\u4e00-\u9fff]{2,12}/g) || []) out.add(token);
  return [...out];
}

function selectMessages(messages) {
  const summary = messages[0] && String(messages[0].content || '').startsWith(SUMMARY_MARKER)
    ? [messages[0]]
    : [];
  return [...summary, ...messages.slice(-10)];
}

function readArchivedMessages(sessionId) {
  const dir = path.join(archivesDir, sessionId);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort((a, b) => b.localeCompare(a));
  const out = [];
  for (const name of files) {
    out.push(...readJson(path.join(dir, name), []));
  }
  return out;
}

function truncateText(content, maxLen) {
  return content.length > maxLen ? `${content.slice(0, Math.max(0, maxLen - 3))}...` : content;
}

function cleanupMessageText(content) {
  return String(content || '')
    .replace(/<!--files:[\s\S]*?-->/g, ' ')
    .replace(SUMMARY_MARKER, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLowValueMemoryText(text) {
  return LOW_VALUE_MEMORY_RE.test(cleanupMessageText(text));
}

function summarizeMessage(content, maxLen = 240) {
  if (!content) return '';
  const cleaned = cleanupMessageText(structuredText(content));
  return truncateText(cleaned, maxLen);
}

function searchableMessage(content) {
  if (!content) return '';
  const cleaned = cleanupMessageText(structuredText(content));
  return truncateText(cleaned, 4000);
}

function extractCtiFinalVisibleTexts(text) {
  const out = [];
  const fence = /```cti-final\s*([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(String(text || ''))) !== null) {
    const rawJson = String(match[1] || '').trim();
    if (!rawJson) continue;
    try {
      const parsed = JSON.parse(rawJson);
      if (typeof parsed?.text === 'string' && parsed.text.trim()) out.push(cleanupMessageText(parsed.text));
    } catch {
      // 历史里偶尔有截断的 cti-final；解析失败时交给普通文本兜底。
    }
  }
  return out.filter(Boolean);
}

function textBlockForMemory(text) {
  const finals = extractCtiFinalVisibleTexts(text);
  if (finals.length > 0) return finals.join(' | ');
  return String(text || '').replace(/```cti-final\s*[\s\S]*?```/g, ' ');
}

function sanitizeToolResult(content) {
  return truncateText(cleanupMessageText(content), 120);
}

function summarizeAdjacentAssistantAnswer(messages, index) {
  for (let nextIndex = index + 1; nextIndex < messages.length; nextIndex += 1) {
    const next = messages[nextIndex];
    if (!next) break;
    if (next.role !== 'assistant') break;
    const searchText = searchableMessage(next.content || '');
    if (!searchText) continue;
    return {
      content: truncateText(searchText, 700),
      searchText,
    };
  }
  return null;
}

function structuredText(content) {
  const raw = String(content || '');
  const rawFinalTexts = extractCtiFinalVisibleTexts(raw);
  if (rawFinalTexts.length > 0) {
    return rawFinalTexts.join(' | ');
  }
  if (!raw.trim().startsWith('[')) return raw;
  try {
    const blocks = JSON.parse(raw);
    const finalTexts = blocks
      .filter((block) => block?.type === 'text')
      .flatMap((block) => extractCtiFinalVisibleTexts(block.text || ''));
    if (finalTexts.length > 0) {
      // 脚本用于回捞“用户最终看见过什么”，有最终结果块时
      // 不把进度文本和工具输出混入候选，避免路径/日志污染答案。
      return finalTexts.join(' | ');
    }
    const parts = [];
    for (const block of blocks) {
      if (block?.type === 'text' && block.text) parts.push(textBlockForMemory(block.text));
      if (block?.type === 'tool_use' || block?.type === 'tool_result') {
        // 技能检索输出的是历史对话证据，不是工具审计报告；
        // 工具命令/结果容易把旧路径、日志当成“原答案”。
        continue;
      }
    }
    return parts.join(' | ');
  } catch {
    return raw;
  }
}

function scoreText(content, tokens, meta, chatId, cwd, sessionId) {
  const haystack = content.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token.toLowerCase())) score += 2;
  }
  if (chatId && meta.chatId === chatId) score += 3;
  if (cwd && normalizePath(meta.workingDirectory) === normalizePath(cwd)) score += 2;
  if (String(content).startsWith('会话摘要')) score += 1;
  return score;
}
