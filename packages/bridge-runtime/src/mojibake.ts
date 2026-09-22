import iconv from 'iconv-lite';

export interface MojibakeTextRepair {
  text: string;
  changed: boolean;
  unresolved: boolean;
  scoreBefore: number;
  scoreAfter: number;
}

const GB18030_MOJIBAKE_TOKENS = [
  '\u6dc7\u6fc7\u5bd4',
  '\u6d93\ue15f\u6783',
  '\u59ab',
  '\u7ef1',
  '\u9366',
  '\u6d93',
  '\u93c2',
  '\u93b4',
  '\u6d7c',
  '\u6769',
  '\u9356',
  '\u6acc',
  '\u5134',
  '\u70d8',
  '\u6ad9',
  '\u4fd3',
  '\ue15f',
  '\u6783',
  '\ue187',
  '\ue6e7',
  '\ue5c5',
  '\ue100',
  '\ue0bc',
];

const LATIN1_MOJIBAKE_RE = /[\u0080-\u00ff]{2,}/gu;
const REPLACEMENT_RE = /(?:\uFFFD|\u00ef\u00bf\u00bd)/gu;
const GB18030_CHAR_RE = new RegExp(`[${escapeCharClass([...new Set(GB18030_MOJIBAKE_TOKENS.join(''))].join(''))}]+`, 'gu');

function escapeCharClass(value: string): string {
  return value.replace(/[\\\]^$.*+?()[\]{}|-]/g, '\\$&');
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function countTokenOccurrences(text: string, token: string): number {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(token, index)) >= 0) {
    count += 1;
    index += token.length;
  }
  return count;
}

export function mojibakeScore(text: string): number {
  if (!text) return 0;
  let score = countMatches(text, REPLACEMENT_RE) * 4;
  score += countMatches(text, LATIN1_MOJIBAKE_RE) * 2;
  for (const token of GB18030_MOJIBAKE_TOKENS) {
    score += countTokenOccurrences(text, token);
  }
  return score;
}

export function hasLikelyMojibake(text: string): boolean {
  return mojibakeScore(text) >= 2;
}

export function countLikelyMojibake(text: string): number {
  return mojibakeScore(text);
}

function decodeLatin1AsUtf8(segment: string): string | null {
  try {
    return Buffer.from([...segment].map((char) => char.charCodeAt(0) & 0xff)).toString('utf8');
  } catch {
    return null;
  }
}

function decodeGb18030AsUtf8(segment: string): string | null {
  try {
    return iconv.decode(iconv.encode(segment, 'gb18030'), 'utf8');
  } catch {
    return null;
  }
}

function isBetterRepair(original: string, candidate: string | null): candidate is string {
  if (!candidate || candidate === original) return false;
  if (REPLACEMENT_RE.test(candidate)) {
    REPLACEMENT_RE.lastIndex = 0;
    return false;
  }
  REPLACEMENT_RE.lastIndex = 0;
  return mojibakeScore(candidate) < mojibakeScore(original);
}

function replaceRepairableRuns(
  text: string,
  pattern: RegExp,
  repair: (segment: string) => string | null,
): { text: string; changed: boolean } {
  let changed = false;
  const next = text.replace(pattern, (segment) => {
    const candidate = repair(segment);
    if (!isBetterRepair(segment, candidate)) return segment;
    changed = true;
    return candidate;
  });
  return { text: next, changed };
}

export function repairLikelyMojibakeText(text: string): MojibakeTextRepair {
  const scoreBefore = mojibakeScore(text);
  if (!text || scoreBefore === 0) {
    return {
      text,
      changed: false,
      unresolved: false,
      scoreBefore,
      scoreAfter: scoreBefore,
    };
  }

  const latin = replaceRepairableRuns(text, LATIN1_MOJIBAKE_RE, decodeLatin1AsUtf8);
  const gb = replaceRepairableRuns(latin.text, GB18030_CHAR_RE, decodeGb18030AsUtf8);
  const scoreAfter = mojibakeScore(gb.text);
  return {
    text: gb.text,
    changed: latin.changed || gb.changed,
    unresolved: scoreAfter > 0,
    scoreBefore,
    scoreAfter,
  };
}

export function sanitizeTextForMemory(text: string): string | null {
  const repaired = repairLikelyMojibakeText(text);
  return repaired.unresolved ? null : repaired.text;
}
