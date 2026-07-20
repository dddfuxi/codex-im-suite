import path from 'node:path';

import type { StickerSemanticSnapshot } from './types.js';

const INDEX_START = '<!-- cti-sticker-semantics-index:start -->';
const INDEX_END = '<!-- cti-sticker-semantics-index:end -->';
const GUIDE_START = '<!-- cti-sticker-semantics-status:start -->';
const GUIDE_END = '<!-- cti-sticker-semantics-status:end -->';

export interface StickerSemanticProjectionFile {
  path: string;
  content: string;
  kind: 'semantic_archive' | 'master_index' | 'memory_guide';
}

function statusLabel(status: string): string {
  return ({ trial: '试用', confirmed: '已确认', regressed: '已回归', rejected: '已拒绝' } as Record<string, string>)[status] || status;
}

function scopeLabel(scope: string): string {
  return scope === 'global' ? '全局' : scope === 'chat' ? '当前群聊范围' : '当前用户范围';
}

export function renderStickerSemanticArchive(snapshot: StickerSemanticSnapshot): string {
  const assetByKey = new Map(snapshot.assets.map((item) => [item.fileKey, item]));
  const revisionLines = snapshot.revisions
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((revision) => {
      const asset = assetByKey.get(revision.fileKey);
      const aliases = revision.patch.aliases?.length ? revision.patch.aliases : asset?.aliases || [];
      const displayName = asset?.label || aliases[0] || '未命名表情包';
      const patch = [
        revision.patch.intent ? `意图：${revision.patch.intent}` : '',
        revision.patch.tone ? `语气：${revision.patch.tone}` : '',
        revision.patch.usage ? `用法：${revision.patch.usage}` : '',
        aliases.length ? `可用称呼：${aliases.join('、')}` : '',
        revision.patch.examples?.length ? `示例：${revision.patch.examples.join('、')}` : '',
        revision.patch.avoidRules?.length ? `避免规则：${revision.patch.avoidRules.map((rule) => `${rule.category}：${rule.condition}（${statusLabel(rule.status)}）`).join('、')}` : '',
      ].filter(Boolean).join('；') || '无可展示 patch。';
      return `- ${displayName}：${statusLabel(revision.status)}；${scopeLabel(revision.scope)}；${patch}；支持会话 ${revision.supportSessionIds.length}；矛盾会话 ${revision.contradictionSessionIds.length}；更新 ${revision.updatedAt}`;
    });
  const counts = snapshot.revisions.reduce((result, item) => {
    result[item.status] = (result[item.status] || 0) + 1;
    return result;
  }, {} as Record<string, number>);
  return [
    '# 表情包语义档案',
    '',
    `生成时间：${snapshot.generatedAt}`,
    '',
    '本文件由机器状态确定性生成，只展示可供人类审核的语义、范围和计数；不保存用户 ID、消息 ID、delivery ID 或 evidence hash。',
    '',
    `资产 ${snapshot.assets.length}；试用 ${counts.trial || 0}；已确认 ${counts.confirmed || 0}；已回归 ${counts.regressed || 0}；已拒绝 ${counts.rejected || 0}。`,
    '',
    '## 当前语义版本',
    '',
    ...(revisionLines.length > 0 ? revisionLines : ['暂无语义 revision。']),
    '',
  ].join('\n');
}

function replaceManagedBlock(existing: string, start: string, end: string, block: string): string {
  const startIndex = existing.indexOf(start);
  const endIndex = startIndex >= 0 ? existing.indexOf(end, startIndex + start.length) : -1;
  if (startIndex >= 0 && endIndex >= startIndex) {
    // 只替换机器受控区块，区块前后的用户手写字节必须原样保留。
    return `${existing.slice(0, startIndex)}${block}${existing.slice(endIndex + end.length)}`;
  }
  const separator = existing.length === 0
    ? ''
    : existing.endsWith('\n\n')
      ? ''
      : existing.endsWith('\n')
        ? '\n'
        : '\n\n';
  return `${existing}${separator}${block}\n`;
}

export function buildStickerSemanticHumanReadableProjections(input: {
  memoryRoot: string;
  snapshot: StickerSemanticSnapshot;
  masterIndexContent: string;
  memoryGuideContent: string;
}): StickerSemanticProjectionFile[] {
  const archiveRelativePath = 'data/im/feishu/stickers/表情包语义档案.md';
  const counts = input.snapshot.revisions.reduce((result, item) => {
    result[item.status] = (result[item.status] || 0) + 1;
    return result;
  }, {} as Record<string, number>);
  const indexBlock = [
    INDEX_START,
    '## 表情包语义档案',
    '',
    `- \`${archiveRelativePath}\`：资产 ${input.snapshot.assets.length} / 试用 ${counts.trial || 0} / 已确认 ${counts.confirmed || 0} / 已回归 ${counts.regressed || 0} / 已拒绝 ${counts.rejected || 0}；更新：${input.snapshot.generatedAt}。`,
    INDEX_END,
  ].join('\n');
  const guideBlock = [
    GUIDE_START,
    '## 表情包语义状态',
    '',
    '- 视觉事实只接受 vision/manual；用户解释只作为待核验证据。',
    '- 语义 revision 支持试用、确认、回归、拒绝和按范围覆盖。',
    `- 当前统计：资产 ${input.snapshot.assets.length}；试用 ${counts.trial || 0}；已确认 ${counts.confirmed || 0}；已回归 ${counts.regressed || 0}；已拒绝 ${counts.rejected || 0}。`,
    `- 最近同步：${input.snapshot.generatedAt}。`,
    GUIDE_END,
  ].join('\n');
  return [
    {
      path: path.join(input.memoryRoot, archiveRelativePath),
      content: `${renderStickerSemanticArchive(input.snapshot)}\n`,
      kind: 'semantic_archive',
    },
    {
      path: path.join(input.memoryRoot, '记忆总索引.md'),
      content: replaceManagedBlock(input.masterIndexContent, INDEX_START, INDEX_END, indexBlock),
      kind: 'master_index',
    },
    {
      path: path.join(input.memoryRoot, '记忆库说明.md'),
      content: replaceManagedBlock(input.memoryGuideContent, GUIDE_START, GUIDE_END, guideBlock),
      kind: 'memory_guide',
    },
  ];
}
