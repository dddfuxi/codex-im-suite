/**
 * 参考文本必须由用户明确确认，并与同一音频的 ASR 结果一致。
 * 这里只忽略不改变内容的排版差异；任何实际字词差异都失败关闭。
 */
export function normalizeReferenceTranscript(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    // 只忽略 ASR 常见的断句/空白差异；符号可能承载实际读音，必须保留。
    .replace(/[\p{P}\s]+/gu, '')
    .trim();
}

export function referenceTranscriptMatches(asrText: unknown, confirmedText: unknown): boolean {
  const normalizedAsr = normalizeReferenceTranscript(asrText);
  const normalizedConfirmed = normalizeReferenceTranscript(confirmedText);
  return Boolean(normalizedAsr && normalizedConfirmed && normalizedAsr === normalizedConfirmed);
}
