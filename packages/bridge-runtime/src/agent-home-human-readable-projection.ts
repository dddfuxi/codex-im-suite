import path from 'node:path';

import { ensureMarkdownTitle, upsertManagedMarkdownBlock } from './human-readable-markdown.js';

const INDEX_START = '<!-- cti-agent-home-index:start -->';
const INDEX_END = '<!-- cti-agent-home-index:end -->';
const GUIDE_START = '<!-- cti-agent-home-status:start -->';
const GUIDE_END = '<!-- cti-agent-home-status:end -->';

export interface AgentHomeHumanReadableProjection {
  path: string;
  content: string;
  kind: 'master_index' | 'memory_guide';
}

export function buildAgentHomeHumanReadableProjections(input: {
  memoryRoot: string;
  generatedAt: string;
  lastAction: string;
  workspaceId?: string;
  masterIndexContent: string;
  memoryGuideContent: string;
}): AgentHomeHumanReadableProjection[] {
  const indexBlock = [
    INDEX_START,
    '## Agent Home 与自维护入口',
    '',
    '- `机器人身份.md`：稳定身份与人格；每轮重新读取。',
    '- `行为与安全规则.md`：行为约束；不能取消代码级安全门禁。',
    '- `工具与环境.md`：稳定工具入口与环境规则。',
    '- `work/`：按稳定 workspaceId 保存当前有效工作档案。',
    '- `daily-reflection/`：每日增量反思。',
    '- `corrections/`：有真实纠错证据的记录。',
    '- `.cti-self-history/versions/`：核心文档受控版本与回滚来源。',
    `- 最近自维护：${input.generatedAt}；动作：${input.lastAction}${input.workspaceId ? `；工作区：${input.workspaceId}` : ''}。`,
    INDEX_END,
  ].join('\n');
  const guideBlock = [
    GUIDE_START,
    '## Agent Home 自维护状态',
    '',
    '- 身份、行为安全、工具环境三份文档由 runtime 每轮重新读取，不使用进程内旧副本。',
    '- 核心文档只能依据真实 human/runtime evidence 受控 patch，并保留版本、审计和回滚入口。',
    '- 工作档案、每日反思和纠错记录只保存可追溯增量；本说明与总索引只是确定性人类投影。',
    `- 最近同步：${input.generatedAt}；动作：${input.lastAction}。`,
    GUIDE_END,
  ].join('\n');
  const master = upsertManagedMarkdownBlock(
    ensureMarkdownTitle(input.masterIndexContent, '# 记忆总索引'),
    INDEX_START,
    INDEX_END,
    indexBlock,
  );
  const guide = upsertManagedMarkdownBlock(
    ensureMarkdownTitle(input.memoryGuideContent, '# 记忆库说明'),
    GUIDE_START,
    GUIDE_END,
    guideBlock,
  );
  return [
    { path: path.join(input.memoryRoot, '记忆总索引.md'), content: master, kind: 'master_index' },
    { path: path.join(input.memoryRoot, '记忆库说明.md'), content: guide, kind: 'memory_guide' },
  ];
}
