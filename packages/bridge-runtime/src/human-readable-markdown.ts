/**
 * 只替换机器拥有的 Markdown 区块，区块之外的用户内容与其他领域投影保持原样。
 * 这是 Agent Home 多个事实源共享同一人类入口时的基础合并原语。
 */
export function upsertManagedMarkdownBlock(
  existing: string,
  startMarker: string,
  endMarker: string,
  block: string,
): string {
  const normalizedBlock = block.trimEnd();
  const startIndex = existing.indexOf(startMarker);
  const endIndex = startIndex >= 0 ? existing.indexOf(endMarker, startIndex + startMarker.length) : -1;
  if (startIndex >= 0 && endIndex >= startIndex) {
    return `${existing.slice(0, startIndex)}${normalizedBlock}${existing.slice(endIndex + endMarker.length)}`;
  }
  const separator = existing.length === 0
    ? ''
    : existing.endsWith('\n\n')
      ? ''
      : existing.endsWith('\n')
        ? '\n'
        : '\n\n';
  return `${existing}${separator}${normalizedBlock}\n`;
}

export function ensureMarkdownTitle(existing: string, title: string): string {
  if (existing.trim()) return existing;
  return `${title}\n`;
}

export const MEMORY_INDEX_BLOCK_START = '<!-- cti-memory-index:start -->';
export const MEMORY_INDEX_BLOCK_END = '<!-- cti-memory-index:end -->';

/** 把旧版整篇生成的总索引迁移为可与其他领域共存的受控区块。 */
export function upsertMemoryIndexManagedBlock(existingContent: string, block: string): string {
  const existing = ensureMarkdownTitle(existingContent, '# 记忆总索引');
  const generatedLegacy = existing.includes('本文件只保存真实源文件链接、状态计数和更新时间，不复制具体事实，不是第二事实源。')
    || existing.includes('本文件只保存真实源文件引用、状态计数和更新时间，不复制具体事实，不是第二事实源。')
    || existing.includes('当前尚未生成记忆索引。索引器会根据真实记忆源文件更新本文件。');
  if (!existing.includes(MEMORY_INDEX_BLOCK_START) && generatedLegacy) {
    const nextManagedBlock = existing.search(/<!-- cti-(?!memory-index:)[^>]+:start -->/u);
    const preservedTail = nextManagedBlock >= 0 ? existing.slice(nextManagedBlock) : '';
    return `# 记忆总索引\n\n${block.trimEnd()}\n${preservedTail}`;
  }
  return upsertManagedMarkdownBlock(existing, MEMORY_INDEX_BLOCK_START, MEMORY_INDEX_BLOCK_END, block);
}
