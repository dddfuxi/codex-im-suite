import fs from 'node:fs';
import path from 'node:path';

export type SourceEncodingIssueKind =
  | 'utf8-bom'
  | 'replacement-character'
  | 'mojibake-token'
  | 'long-question-run'
  | 'unclosed-allow-block';

export interface SourceEncodingIssue {
  file: string;
  line: number;
  kind: SourceEncodingIssueKind;
  sample: string;
}

export interface SourceEncodingScanOptions {
  rootDir: string;
  includePaths: string[];
  extensions?: string[];
  excludeDirNames?: string[];
  allowStartMarker?: string;
  allowEndMarker?: string;
}

const DEFAULT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.cs', '.ps1', '.md', '.json']);
const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git',
  '.cti-index',
  'bin',
  'dist',
  'node_modules',
  'obj',
  'release',
  '__tests__',
]);

const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);
const MOJIBAKE_TOKENS = [
  [0x9365, 0x73aa],
  [0x9358, 0x56e7],
  [0x934f, 0x5cf0],
  [0x9359, 0x6a3a],
  [0x93c8, 0x612c],
  [0x95c6, 0x6a40],
  [0x7039, 0x744c],
  [0x9428, 0x52ec],
  [0x6d93, 0xe15f],
  [0x6d93, 0x581d],
  [0x6d93, 0x5d88],
  [0x9365],
  [0x93c4],
  [0x951b],
].map((codes) => String.fromCharCode(...codes));

const LATIN_MOJIBAKE_TOKENS = [
  [0x00c3],
  [0x00c2],
  [0x00e2, 0x20ac],
].map((codes) => String.fromCharCode(...codes));

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function lineForIndex(text: string, index: number): number {
  return text.slice(0, Math.max(0, index)).split(/\n/u).length;
}

function enumerateFiles(rootDir: string, includePaths: string[], extensions: Set<string>, excludedDirs: Set<string>): string[] {
  const files: string[] = [];
  const visit = (absolutePath: string) => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      if (excludedDirs.has(path.basename(absolutePath))) return;
      let entries: string[];
      try {
        entries = fs.readdirSync(absolutePath);
      } catch {
        return;
      }
      for (const entry of entries) visit(path.join(absolutePath, entry));
      return;
    }
    if (!stat.isFile() || !extensions.has(path.extname(absolutePath).toLowerCase())) return;
    files.push(absolutePath);
  };

  for (const includePath of includePaths) {
    visit(path.resolve(rootDir, includePath));
  }
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

function stripAllowedEncodingSamples(
  text: string,
  file: string,
  issues: SourceEncodingIssue[],
  allowStartMarker: string,
  allowEndMarker: string,
): string {
  let output = '';
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(allowStartMarker, cursor);
    if (start < 0) {
      output += text.slice(cursor);
      break;
    }
    output += text.slice(cursor, start);
    const end = text.indexOf(allowEndMarker, start + allowStartMarker.length);
    if (end < 0) {
      issues.push({
        file,
        line: lineForIndex(text, start),
        kind: 'unclosed-allow-block',
        sample: allowStartMarker,
      });
      break;
    }
    cursor = end + allowEndMarker.length;
  }
  return output;
}

function pushIssue(
  issues: SourceEncodingIssue[],
  file: string,
  text: string,
  index: number,
  kind: SourceEncodingIssueKind,
  sample: string,
): void {
  issues.push({
    file,
    line: lineForIndex(text, index),
    kind,
    sample: sample.slice(0, 40),
  });
}

export function scanSourceEncoding(options: SourceEncodingScanOptions): SourceEncodingIssue[] {
  const rootDir = path.resolve(options.rootDir);
  const extensions = new Set(options.extensions || [...DEFAULT_EXTENSIONS]);
  const excludedDirs = new Set(options.excludeDirNames || [...DEFAULT_EXCLUDED_DIRS]);
  const allowStartMarker = options.allowStartMarker || 'cti-encoding-allow-start';
  const allowEndMarker = options.allowEndMarker || 'cti-encoding-allow-end';
  const issues: SourceEncodingIssue[] = [];

  for (const absolutePath of enumerateFiles(rootDir, options.includePaths, extensions, excludedDirs)) {
    const relativePath = normalizeRelativePath(path.relative(rootDir, absolutePath));
    const bytes = fs.readFileSync(absolutePath);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      issues.push({ file: relativePath, line: 1, kind: 'utf8-bom', sample: 'EF BB BF' });
    }
    const rawText = bytes.toString('utf8');
    const text = stripAllowedEncodingSamples(rawText, relativePath, issues, allowStartMarker, allowEndMarker);

    const replacementIndex = text.indexOf(REPLACEMENT_CHARACTER);
    if (replacementIndex >= 0) {
      pushIssue(issues, relativePath, text, replacementIndex, 'replacement-character', REPLACEMENT_CHARACTER);
    }

    for (const token of [...MOJIBAKE_TOKENS, ...LATIN_MOJIBAKE_TOKENS]) {
      const index = text.indexOf(token);
      if (index >= 0) pushIssue(issues, relativePath, text, index, 'mojibake-token', token);
    }

    const questionRun = /\?{6,}/u.exec(text);
    if (questionRun?.index != null) {
      pushIssue(issues, relativePath, text, questionRun.index, 'long-question-run', questionRun[0]);
    }
  }

  return issues;
}
