import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  readManagedMemoryDocument,
  renderManagedMemoryDocument,
  writeManagedMemoryDocument,
} from '../memory-items/managed-document.js';

function encodeState(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function writeLegacyDocument(filePath: string): void {
  const state = {
    version: 1,
    confirmed: {},
    tentative: {
      '暂定-abc': {
        value: 'Unity MCP 截图',
        updatedAt: '2026-07-17T12:00:00.000Z',
        confidence: 0.71,
      },
    },
    evidence: [
      { text: 'Unity MCP 截图', createdAt: '2026-07-17T12:00:00.000Z' },
    ],
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    '---',
    'schema: codex-im-suite/memory/v3',
    'memoryScope: user',
    'channelType: "feishu"',
    'userId: "ou_user_a"',
    'displayName: "刘丹"',
    'updatedAt: 2026-07-17T12:00:00.000Z',
    '---',
    '',
    `<!-- cti-memory-state:${encodeState(state)} -->`,
    '',
    '# 用户印象：刘丹',
    '',
    '## 暂定印象',
    '',
    '| key | value | 置信度 | 更新时间 |',
    '| --- | --- | --- | --- |',
    '| 暂定-abc | Unity MCP 截图 | 71% | 2026-07-17T12:00:00.000Z |',
    '',
  ].join('\n'), 'utf8');
}

describe('managed memory v2 documents', () => {
  it('upgrades legacy tentative entries into candidates without confirming them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-managed-memory-upgrade-'));
    const filePath = path.join(root, 'memory', 'users', 'feishu', 'ou_user_a', '用户印象.md');

    try {
      writeLegacyDocument(filePath);
      const parsed = readManagedMemoryDocument(filePath);

      assert.equal(parsed.state.version, 2);
      assert.equal(parsed.state.confirmed['场景映射'], undefined);
      assert.equal(parsed.state.candidates['暂定-abc']?.value, 'Unity MCP 截图');
      assert.equal(parsed.state.candidates['暂定-abc']?.status, 'candidate');
      assert.equal(parsed.state.candidates['暂定-abc']?.sourceKind, 'migration');
      assert.equal(parsed.metadata.scope, 'user');
      assert.equal(parsed.metadata.displayName, '刘丹');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('renders candidates in an explicitly non-indexed human-readable section', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-managed-memory-render-'));
    const filePath = path.join(root, '用户印象.md');

    try {
      writeLegacyDocument(filePath);
      const document = readManagedMemoryDocument(filePath);
      const markdown = renderManagedMemoryDocument(document);

      assert.match(markdown, /## 候选记忆（不参与索引）/u);
      assert.match(markdown, /\| 暂定-abc \| Unity MCP 截图 \|/u);
      assert.doesNotMatch(markdown, /## 暂定印象/u);
      assert.match(markdown, /由“已确认事实”和“候选记忆”中的相关条目提供。/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a stale base hash instead of overwriting concurrent human edits', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-managed-memory-hash-'));
    const filePath = path.join(root, '用户印象.md');

    try {
      writeLegacyDocument(filePath);
      const document = readManagedMemoryDocument(filePath);
      fs.appendFileSync(filePath, '\n用户并发补充。\n', 'utf8');

      assert.throws(
        () => writeManagedMemoryDocument(document, document.baseHash),
        /managed memory source changed/u,
      );
      assert.match(fs.readFileSync(filePath, 'utf8'), /用户并发补充。/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the hidden managed state is corrupt', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-managed-memory-corrupt-'));
    const filePath = path.join(root, '用户印象.md');

    try {
      fs.writeFileSync(filePath, [
        '---',
        'schema: codex-im-suite/memory/v3',
        'memoryScope: user',
        'channelType: "feishu"',
        'userId: "ou_user_a"',
        '---',
        '',
        '<!-- cti-memory-state:not-base64-json -->',
        '',
      ].join('\n'), 'utf8');

      assert.throws(() => readManagedMemoryDocument(filePath), /managed memory state is invalid/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when an existing hidden state has no valid v3 identity metadata', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-managed-memory-metadata-'));
    const filePath = path.join(root, '用户印象.md');

    try {
      fs.writeFileSync(filePath, [
        '# 用户手写文档',
        '',
        `<!-- cti-memory-state:${encodeState({ version: 1, confirmed: {}, tentative: {}, evidence: [] })} -->`,
        '',
      ].join('\n'), 'utf8');

      assert.throws(() => readManagedMemoryDocument(filePath), /managed memory metadata is invalid/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
