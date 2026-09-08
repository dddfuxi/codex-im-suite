export const DEFAULT_LYRICS_ALIGNMENT_THRESHOLD = 0.8;

function normalizedLyrics(value: string): string {
  return value.normalize('NFKC')
    // Verse/Chorus 等结构标签不是实际发音内容。
    .replace(/\[[^\]\n]{1,40}\]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function levenshteinDistance(left: string[], right: string[]): number {
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

export interface LyricsAlignmentResult {
  score: number;
  threshold: number;
  passed: boolean;
}

/**
 * 歌词对齐只比较 Unicode 字符序列，不用音量、时长或文件名冒充内容证据。
 * 对中文按字符 CER 计算；其它语言同样保持可预测、无模型特例。
 */
export function evaluateLyricsAlignment(
  expectedLyrics: string,
  recognizedLyrics: string,
  threshold = DEFAULT_LYRICS_ALIGNMENT_THRESHOLD,
): LyricsAlignmentResult {
  const expected = Array.from(normalizedLyrics(expectedLyrics));
  const recognized = Array.from(normalizedLyrics(recognizedLyrics));
  if (expected.length === 0 || recognized.length === 0 || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    return { score: 0, threshold: DEFAULT_LYRICS_ALIGNMENT_THRESHOLD, passed: false };
  }
  const distance = levenshteinDistance(expected, recognized);
  const score = Math.max(0, Math.min(1, 1 - distance / Math.max(expected.length, recognized.length)));
  return { score, threshold, passed: score >= threshold };
}
