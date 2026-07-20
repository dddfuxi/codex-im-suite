import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BRIDGE_CHARACTERIZATION_CATALOG } from '../support/bridge-characterization-catalog.js';

const unitTestRoot = path.dirname(fileURLToPath(import.meta.url));

describe('Bridge Core characterization coverage', () => {
  it('pins every Task 8 public behavior domain to a real regression test', () => {
    assert.deepEqual(
      BRIDGE_CHARACTERIZATION_CATALOG.map((entry) => entry.domain).sort(),
      ['artifact', 'attachment', 'card', 'delivery', 'direct_message', 'history', 'inbound', 'permission', 'reminder', 'sticker'],
    );

    for (const entry of BRIDGE_CHARACTERIZATION_CATALOG) {
      const sourcePath = path.resolve(unitTestRoot, entry.testFile);
      assert.equal(fs.existsSync(sourcePath), true, `${entry.domain} characterization file should exist`);
      const source = fs.readFileSync(sourcePath, 'utf8');
      assert.equal(source.includes(entry.testTitle), true, `${entry.domain} characterization should remain executable`);
    }
  });
});
