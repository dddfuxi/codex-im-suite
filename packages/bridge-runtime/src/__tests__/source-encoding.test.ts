import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanSourceEncoding } from '../source-encoding.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..');

const sourceIncludePaths = [
  'packages/bridge-core/src/lib',
  'packages/bridge-runtime/src',
  'apps/control-panel',
  'scripts',
];

describe('source encoding hygiene', () => {
  it('keeps user-visible bridge/runtime/control-panel sources free of mojibake markers', () => {
    const issues = scanSourceEncoding({
      rootDir: repoRoot,
      includePaths: sourceIncludePaths,
    });

    assert.deepEqual(issues, []);
  });

  it('does not keep temporary disabled branches in bridge/runtime sources', () => {
    const checkedFiles: string[] = [];
    const visit = (absolutePath: string) => {
      const stat = fs.statSync(absolutePath);
      if (stat.isDirectory()) {
        if (['__tests__', 'dist', 'node_modules'].includes(path.basename(absolutePath))) return;
        for (const entry of fs.readdirSync(absolutePath)) visit(path.join(absolutePath, entry));
        return;
      }
      if (!/\.(?:ts|tsx)$/i.test(absolutePath)) return;
      checkedFiles.push(absolutePath);
    };
    visit(path.join(repoRoot, 'packages/bridge-core/src/lib'));
    visit(path.join(repoRoot, 'packages/bridge-runtime/src'));

    const hits = checkedFiles
      .map((file) => ({
        file: path.relative(repoRoot, file).replace(/\\/g, '/'),
        text: fs.readFileSync(file, 'utf8'),
      }))
      .filter((item) => /\bif\s*\(\s*false\s*&&/u.test(item.text))
      .map((item) => item.file);

    assert.deepEqual(hits, []);
  });

  it('detects common encoding regressions and respects explicit allow blocks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-source-encoding-'));
    const sampleDir = path.join(root, 'src');
    fs.mkdirSync(sampleDir, { recursive: true });

    try {
      fs.writeFileSync(path.join(sampleDir, 'bom.ts'), Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('export const value = 1;\n')]));
      fs.writeFileSync(path.join(sampleDir, 'replacement.ts'), `export const text = "broken ${String.fromCharCode(0xfffd)}";\n`, 'utf8');
      fs.writeFileSync(path.join(sampleDir, 'question.ts'), 'export const text = "????????";\n', 'utf8');
      fs.writeFileSync(path.join(sampleDir, 'mojibake.ts'), `export const text = "${String.fromCharCode(0x9358, 0x56e7)}";\n`, 'utf8');
      fs.writeFileSync(path.join(sampleDir, 'allowed.ts'), [
        '// cti-encoding-allow-start',
        `export const detectorSample = "${String.fromCharCode(0x9358, 0x56e7)}";`,
        '// cti-encoding-allow-end',
      ].join('\n'), 'utf8');

      const issues = scanSourceEncoding({
        rootDir: root,
        includePaths: ['src'],
      });

      assert.deepEqual(
        issues.map((issue) => `${issue.file}:${issue.kind}`).sort(),
        [
          'src/bom.ts:utf8-bom',
          'src/mojibake.ts:mojibake-token',
          'src/question.ts:long-question-run',
          'src/replacement.ts:replacement-character',
        ],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
