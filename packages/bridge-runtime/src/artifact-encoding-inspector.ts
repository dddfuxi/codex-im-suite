import fs from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import type { ArtifactEncodingInspectorHost, ArtifactEncodingIssue } from 'claude-to-im/host';

export interface ArtifactEncodingInspectionResult {
  ok: boolean;
  issues: ArtifactEncodingIssue[];
}

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.ps1', '.py', '.js', '.mjs', '.ts', '.tsx', '.cs',
]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 256;
const MAX_ZIP_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function sampleAround(text: string, index: number): string {
  return text.slice(Math.max(0, index - 40), Math.min(text.length, index + 80)).replace(/[\r\n\t]+/gu, ' ').trim();
}

function inspectText(filePath: string, bytes: Uint8Array, entryName?: string): ArtifactEncodingIssue[] {
  let text: string;
  try {
    text = STRICT_UTF8_DECODER.decode(bytes);
  } catch {
    return [{ filePath, entryName, kind: 'invalid_utf8', sample: 'strict UTF-8 decode failed' }];
  }

  const replacementIndex = text.indexOf('\uFFFD');
  if (replacementIndex >= 0) {
    return [{ filePath, entryName, kind: 'replacement_character', sample: sampleAround(text, replacementIndex) }];
  }
  const questionLoss = /\?{3,}/u.exec(text);
  if (questionLoss?.index !== undefined) {
    return [{ filePath, entryName, kind: 'question_mark_loss', sample: sampleAround(text, questionLoss.index) }];
  }
  return [];
}

function isUnsafeZipEntry(entryName: string): boolean {
  const normalized = entryName.replace(/\\/gu, '/');
  return normalized.includes('\0')
    || normalized.startsWith('/')
    || /^[a-z]:\//iu.test(normalized)
    || normalized.split('/').some((segment) => segment === '..');
}

function zipReadIssue(filePath: string, error: unknown): ArtifactEncodingIssue {
  const message = error instanceof Error ? error.message : String(error);
  return {
    filePath,
    kind: /invalid relative path|absolute path|path traversal/iu.test(message) ? 'unsafe_zip_entry' : 'zip_limit',
    sample: `zip read failed: ${message}`,
  };
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, zipFile) => {
      if (error || !zipFile) reject(error ?? new Error('zip open failed'));
      else resolve(zipFile);
    });
  });
}

function readZipEntry(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error('zip entry stream unavailable'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_TEXT_BYTES) stream.destroy(new Error('zip text entry exceeds limit'));
        else chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function inspectZip(filePath: string): Promise<ArtifactEncodingIssue[]> {
  let zipFile: yauzl.ZipFile;
  try {
    zipFile = await openZip(filePath);
  } catch (error) {
    return [zipReadIssue(filePath, error)];
  }

  return await new Promise((resolve) => {
    const issues: ArtifactEncodingIssue[] = [];
    let entryCount = 0;
    let totalUncompressedBytes = 0;
    let settled = false;
    const finish = (issue?: ArtifactEncodingIssue): void => {
      if (settled) return;
      settled = true;
      if (issue) issues.push(issue);
      zipFile.close();
      resolve(issues);
    };

    zipFile.once('error', (error) => finish(zipReadIssue(filePath, error)));
    zipFile.once('end', () => finish());
    zipFile.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        entryCount += 1;
        if (entryCount > MAX_ZIP_ENTRIES) {
          finish({ filePath, entryName: entry.fileName, kind: 'zip_limit', sample: `zip exceeds ${MAX_ZIP_ENTRIES} entries` });
          return;
        }
        if (isUnsafeZipEntry(entry.fileName)) {
          finish({ filePath, entryName: entry.fileName, kind: 'unsafe_zip_entry', sample: 'unsafe ZIP entry path' });
          return;
        }
        totalUncompressedBytes += entry.uncompressedSize;
        if (totalUncompressedBytes > MAX_ZIP_UNCOMPRESSED_BYTES) {
          finish({ filePath, entryName: entry.fileName, kind: 'zip_limit', sample: 'ZIP uncompressed size exceeds limit' });
          return;
        }
        if (entry.fileName.endsWith('/')) {
          zipFile.readEntry();
          return;
        }
        const extension = path.posix.extname(entry.fileName.replace(/\\/gu, '/')).toLowerCase();
        if (!TEXT_EXTENSIONS.has(extension)) {
          zipFile.readEntry();
          return;
        }
        if (entry.uncompressedSize > MAX_TEXT_BYTES) {
          finish({ filePath, entryName: entry.fileName, kind: 'zip_limit', sample: `ZIP text entry exceeds ${MAX_TEXT_BYTES} bytes` });
          return;
        }
        try {
          issues.push(...inspectText(filePath, await readZipEntry(zipFile, entry), entry.fileName));
          zipFile.readEntry();
        } catch (error) {
          finish({ filePath, entryName: entry.fileName, kind: 'zip_limit', sample: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
    zipFile.readEntry();
  });
}

export class ArtifactEncodingInspector implements ArtifactEncodingInspectorHost {
  async inspectFiles(input: { files: string[] }): Promise<ArtifactEncodingInspectionResult> {
    const issues: ArtifactEncodingIssue[] = [];
    for (const filePath of input.files) {
      const extension = path.extname(filePath).toLowerCase();
      if (extension === '.zip') {
        issues.push(...await inspectZip(filePath));
        continue;
      }
      if (!TEXT_EXTENSIONS.has(extension)) continue;
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_TEXT_BYTES) {
        issues.push({ filePath, kind: 'zip_limit', sample: `text file exceeds ${MAX_TEXT_BYTES} bytes` });
        continue;
      }
      issues.push(...inspectText(filePath, await fs.readFile(filePath)));
    }
    return { ok: issues.length === 0, issues };
  }
}
