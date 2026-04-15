import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SUMMARY_MARKER = '[[CTI_SUMMARY]]';
const home = process.env.CTI_HOME || 'E:\\cli-md' || path.join(os.homedir(), '.claude-to-im');
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
  for (const message of [...selectMessages(messages), ...archivedMessages]) {
    const rawContent = searchableMessage(message?.content || '');
    const content = summarizeMessage(message?.content || '');
    if (!content || !rawContent) continue;
    const score = scoreText(rawContent, tokens, meta, chatId, cwd, sessionId);
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

function summarizeMessage(content) {
  if (!content) return '';
  const cleaned = structuredText(content)
    .replace(/<!--files:[\s\S]*?-->/g, ' ')
    .replace(SUMMARY_MARKER, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 240 ? `${cleaned.slice(0, 237)}...` : cleaned;
}

function searchableMessage(content) {
  if (!content) return '';
  const cleaned = structuredText(content)
    .replace(/<!--files:[\s\S]*?-->/g, ' ')
    .replace(SUMMARY_MARKER, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 4000 ? cleaned.slice(0, 4000) : cleaned;
}

function structuredText(content) {
  const raw = String(content || '');
  if (!raw.trim().startsWith('[')) return raw;
  try {
    const blocks = JSON.parse(raw);
    const parts = [];
    for (const block of blocks) {
      if (block?.type === 'text' && block.text) parts.push(String(block.text));
      if (block?.type === 'tool_use' && block?.input?.command) parts.push(`执行命令: ${block.input.command}`);
      if (block?.type === 'tool_result' && block.content) parts.push(`工具结果: ${block.content}`);
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
