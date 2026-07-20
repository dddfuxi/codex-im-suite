import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  findDependencyBoundaryViolations,
  findPackageExportViolations,
} from '../check-dependency-boundaries.mjs';

function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('dependency boundaries', () => {
  it('rejects deep package imports and bridge-core reverse dependencies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-dependency-boundaries-'));
    try {
      write(root, 'packages/bridge-runtime/src/deep.ts', "import type { LLMProvider } from 'claude-to-im/src/lib/bridge/host.js';\n");
      write(root, 'apps/control-panel/web/src/deep.tsx', "import { x } from '../../../../../packages/bridge-core/src/internal.js';\n");
      write(root, 'apps/control-panel/web/src/node-policy.tsx', "import { AGENT_ARCHITECTURE_LAYERS } from 'claude-to-im/policy';\n");
      write(root, 'packages/bridge-core/src/reverse.ts', "import { start } from '../../bridge-runtime/src/main.js';\n");
      write(root, 'packages/bridge-runtime/src/stable.ts', "import type { LLMProvider } from 'claude-to-im/host';\n");

      const violations = findDependencyBoundaryViolations(root);
      assert.deepEqual(violations.map((item) => item.rule).sort(), [
        'bridge-core-no-runtime-dependency',
        'no-cross-package-source-import',
        'no-deep-package-import',
        'web-browser-safe-core-entry',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the repository on stable package exports only', () => {
    const root = path.resolve(import.meta.dirname, '..', '..');
    assert.deepEqual(findDependencyBoundaryViolations(root), []);
    assert.deepEqual(findPackageExportViolations(root), []);
  });

  it('rejects public exports that expose package source internals', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-package-exports-'));
    try {
      write(root, 'packages/bridge-core/package.json', JSON.stringify({
        name: 'claude-to-im',
        exports: {
          '.': './dist/index.js',
          './src/lib/bridge/*.js': './dist/lib/bridge/*.js',
        },
        files: ['dist', 'src/lib'],
      }));
      assert.deepEqual(findPackageExportViolations(root).map((item) => item.rule).sort(), [
        'package-exports-no-source-internals',
        'package-files-no-source-internals',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
