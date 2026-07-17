import fs from 'node:fs';
import path from 'node:path';

import type { KnowledgeIndex, KnowledgeItem } from './knowledge-indexer.js';
import { classifyMemoryV2Source } from './memory-source-policy.js';

const AGENT_HOME_TEMPLATES: Record<string, string> = {
  '机器人身份.md': [
    '# 机器人身份',
    '',
    '本文件保存稳定的机器人定位与人格。平台显示名和当前会话身份仍以真实 adapter evidence 为准。',
    '',
  ].join('\n'),
  '行为与安全规则.md': [
    '# 行为与安全规则',
    '',
    '- 每轮只挂载当前工作区。',
    '- 允许根目录不等于已挂载目录。',
    '- 其他项目只有在本轮存在可靠证据时临时挂载。',
    '- 记忆库、运行数据、日志和发布产物不得作为普通工作区挂载。',
    '- 用户印象、群聊记忆和公共记忆必须遵守身份边界。',
    '',
  ].join('\n'),
  '工具与环境.md': [
    '# 工具与环境',
    '',
    '记录稳定的工具入口、环境约束与使用偏好。禁止在此保存密钥、Token、验证码或私有授权票据。',
    '',
  ].join('\n'),
  '记忆总索引.md': [
    '# 记忆总索引',
    '',
    '当前尚未生成记忆索引。索引器会根据真实记忆源文件更新本文件。',
    '',
  ].join('\n'),
  '记忆库说明.md': [
    '# 记忆库说明',
    '',
    '<!-- cti-agent-home-template:v2 -->',
    '',
    '- `memory/users/<channel>/<userId>/用户印象.md`：当前用户的独立印象与已确认事实。',
    '- `memory/groups/<channel>/<chatId>/群聊记忆.md`：当前群的公共协作事实。',
    '- `memory/long-term/公共长期记忆.md`：明确允许跨用户复用的非敏感事实。',
    '- `.cti-index`：机器生成索引，不是事实源。',
    '',
  ].join('\n'),
};

const LEGACY_AGENT_HOME_TEMPLATES: Record<string, string[]> = {
  '记忆库说明.md': [[
    '# 记忆库说明',
    '',
    '- `memory/users/<channel>/<userId>/用户印象.md`：当前用户的独立印象与已确认事实。',
    '- `memory/groups/<channel>/<chatId>/群聊记忆.md`：当前群的公共协作事实。',
    '- `memory/projects/<projectId>/项目记忆.md`：项目事实与约束。',
    '- `memory/topics/<topicId>/主题记忆.md`：跨项目主题知识。',
    '- `memory/long-term/公共长期记忆.md`：明确允许跨用户复用的非敏感事实。',
    '- `.cti-index`：机器生成索引，不是事实源。',
    '',
  ].join('\n')],
};

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

export function ensureAgentHome(memoryRoot: string): { root: string; files: string[]; created: string[]; updated: string[] } {
  const root = path.resolve(memoryRoot);
  fs.mkdirSync(root, { recursive: true });
  const files: string[] = [];
  const created: string[] = [];
  const updated: string[] = [];
  for (const [name, content] of Object.entries(AGENT_HOME_TEMPLATES)) {
    const filePath = path.join(root, name);
    files.push(filePath);
    if (!fs.existsSync(filePath)) {
      atomicWrite(filePath, content);
      created.push(filePath);
      continue;
    }
    const existing = fs.readFileSync(filePath, 'utf8');
    if ((LEGACY_AGENT_HOME_TEMPLATES[name] || []).includes(existing)) {
      atomicWrite(filePath, content);
      updated.push(filePath);
    }
  }
  return { root, files, created, updated };
}

interface SourceSummary {
  path: string;
  relativePath: string;
  label: string;
  summary: string;
  group: 'user' | 'group' | 'long_term' | 'legacy';
  updatedAt: string;
}

function sourceGroup(memoryRoot: string, item: KnowledgeItem): SourceSummary['group'] {
  const classification = classifyMemoryV2Source(memoryRoot, item.source.path, item.source.metadata);
  if (classification.legacy) return 'legacy';
  if (classification.scope === 'user') return 'user';
  if (classification.scope === 'group') return 'group';
  if (classification.scope === 'long_term') return 'long_term';
  return 'legacy';
}

function summarizeSources(memoryRoot: string, index: KnowledgeIndex): SourceSummary[] {
  const grouped = new Map<string, KnowledgeItem[]>();
  for (const item of index.items) {
    const key = path.resolve(item.source.path);
    grouped.set(key, [...(grouped.get(key) || []), item]);
  }
  return [...grouped.entries()].map(([sourcePath, items]) => {
    const metadata = items[0].source.metadata || {};
    const relativePath = path.relative(memoryRoot, sourcePath).replace(/\\/gu, '/');
    const label = metadata.displayName
      || metadata.userId
      || metadata.chatId
      || path.basename(sourcePath, path.extname(sourcePath));
    const summary = items
      .slice(0, 2)
      .map((item) => item.key && item.value ? `${item.key}：${item.value}` : item.text)
      .join('；')
      .replace(/\s+/gu, ' ')
      .slice(0, 180);
    return {
      path: sourcePath,
      relativePath,
      label,
      summary,
      group: sourceGroup(memoryRoot, items[0]),
      updatedAt: items.map((item) => item.source.updatedAt || '').sort().at(-1) || index.generatedAt,
    };
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN'));
}

function renderSection(title: string, sources: SourceSummary[]): string[] {
  return [
    `## ${title}`,
    '',
    ...(sources.length > 0
      ? sources.map((item) => `- ${item.label}：${item.summary || '暂无摘要'} → \`${item.relativePath}\`（更新：${item.updatedAt || '未知'}）`)
      : ['暂无。']),
    '',
  ];
}

export function writeMemoryMasterIndex(memoryRoot: string, index: KnowledgeIndex): { filePath: string; sourceCount: number } {
  const root = path.resolve(memoryRoot);
  ensureAgentHome(root);
  const sources = summarizeSources(root, index);
  const byGroup = (group: SourceSummary['group']) => sources.filter((item) => item.group === group);
  const content = [
    '# 记忆总索引',
    '',
    `生成时间：${index.generatedAt}`,
    '',
    '本文件只保存分类摘要和真实源文件引用，不是第二事实源。',
    '',
    ...renderSection('用户印象', byGroup('user')),
    ...renderSection('群聊记忆', byGroup('group')),
    ...renderSection('公共长期记忆', byGroup('long_term')),
    ...renderSection('待迁移旧记忆', byGroup('legacy')),
  ].join('\n');
  const filePath = path.join(root, '记忆总索引.md');
  atomicWrite(filePath, content);
  return { filePath, sourceCount: sources.length };
}
