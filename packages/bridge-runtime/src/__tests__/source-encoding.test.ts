import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..');

const scannedFiles = [
  'packages/bridge-core/src/lib/bridge/markdown/feishu.ts',
  'packages/bridge-core/src/lib/bridge/adapters/feishu-adapter.ts',
  'packages/bridge-core/src/lib/bridge/bridge-manager.ts',
  'packages/bridge-core/src/lib/bridge/conversation-engine.ts',
  'packages/bridge-runtime/src/local-agent-tool-protocol.ts',
  'packages/bridge-runtime/src/codex-local-cli-provider.ts',
  'packages/bridge-runtime/src/codex-provider.ts',
  'apps/control-panel/web/src/main.tsx',
  'apps/control-panel/Program.cs',
];

const suspiciousCodePoints = new Set([
  0xfffd, // replacement character
  0x20ac, // €
  0x9239, // 鈹
  0x9365, // 鍥
  0x93c4, // 鏄
  0x951b, // 锛
  0x7039, // 瀹
  0x95c6, // 閆
  0x6b55, // 歕
]);

function stripAllowedMojibakeDetectorSamples(file: string, text: string): string {
  if (!file.endsWith('apps/control-panel/Program.cs')) return text;
  return text.replace(/private static int MojibakeScore\(string text\)[\s\S]*?private static string\? TryRepairUtf8ReadAsGbk/u, 'private static string? TryRepairUtf8ReadAsGbk');
}

describe('source encoding hygiene', () => {
  it('keeps user-visible bridge reply/card source free of mojibake markers', () => {
    const hits: string[] = [];
    for (const relativePath of scannedFiles) {
      const absolutePath = path.join(repoRoot, relativePath);
      const text = stripAllowedMojibakeDetectorSamples(relativePath, fs.readFileSync(absolutePath, 'utf8'));
      for (let index = 0; index < text.length; index += 1) {
        if (!suspiciousCodePoints.has(text.charCodeAt(index))) continue;
        const line = text.slice(0, index).split(/\n/u).length;
        hits.push(`${relativePath}:${line}`);
        break;
      }
    }
    assert.deepEqual(hits, []);
  });
});
