const REPLACEMENT_CHARACTER = '\uFFFD';

/**
 * 将孤立的 UTF-16 代理项替换为 Unicode replacement character。
 * JSON.stringify 会保留孤立代理项的转义形式，因此持久化边界必须主动归一化。
 */
export function normalizeWellFormedUtf16(value: string): string {
  let normalized = '';
  let changed = false;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : -1;
      if (next >= 0xDC00 && next <= 0xDFFF) {
        normalized += value[index] + value[index + 1];
        index += 1;
      } else {
        normalized += REPLACEMENT_CHARACTER;
        changed = true;
      }
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) {
      normalized += REPLACEMENT_CHARACTER;
      changed = true;
      continue;
    }
    normalized += value[index];
  }

  return changed ? normalized : value;
}

/**
 * 按 UTF-16 长度预算截断文本，但永远不在合法代理对中间切开。
 */
export function truncateUtf16Safe(value: string, maxCodeUnits: number, suffix = ''): string {
  const normalized = normalizeWellFormedUtf16(value);
  const limit = Math.max(0, Math.floor(maxCodeUnits));
  if (normalized.length <= limit) return normalized;

  const safeSuffix = normalizeWellFormedUtf16(suffix);
  const contentLimit = Math.max(0, limit - safeSuffix.length);
  let end = contentLimit;
  if (
    end > 0
    && end < normalized.length
    && normalized.charCodeAt(end - 1) >= 0xD800
    && normalized.charCodeAt(end - 1) <= 0xDBFF
    && normalized.charCodeAt(end) >= 0xDC00
    && normalized.charCodeAt(end) <= 0xDFFF
  ) {
    end -= 1;
  }
  return `${normalized.slice(0, end)}${safeSuffix}`;
}
