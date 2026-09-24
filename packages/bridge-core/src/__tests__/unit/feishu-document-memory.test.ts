import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getFeishuDocumentGuidePath,
  getFeishuDocumentIndexPath,
  loadFeishuDocumentMemory,
  recordFeishuDocumentMemory,
  removeFeishuDocumentMemory,
} from '../../lib/bridge/feishu-document-memory.js';

const tempDirs: string[] = [];

function createStore(repoDir: string): { getSetting: (key: string) => string | null } {
  return { getSetting: (key) => key === 'bridge_memory_repo_dir' ? repoDir : null };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Feishu document memory deletion', () => {
  it('removes exactly the indexed entry and refreshes the guide', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-doc-memory-'));
    tempDirs.push(repoDir);
    const store = createStore(repoDir);
    const first = recordFeishuDocumentMemory(store, {
      title: '第一份文档',
      url: 'https://www.feishu.cn/docx/doc-first',
      documentId: 'doc-first',
      chatId: 'chat-1',
      sourceText: '第一份摘要',
    });
    recordFeishuDocumentMemory(store, {
      title: '第二份文档',
      url: 'https://www.feishu.cn/docx/doc-second',
      documentId: 'doc-second',
      chatId: 'chat-1',
      sourceText: '第二份摘要',
    });

    const removed = removeFeishuDocumentMemory(store, first.id);
    assert.equal(removed?.documentId, 'doc-first');
    assert.deepEqual(loadFeishuDocumentMemory(store).map((entry) => entry.documentId), ['doc-second']);
    assert.equal(fs.existsSync(getFeishuDocumentIndexPath(store)), true);
    const guide = fs.readFileSync(getFeishuDocumentGuidePath(store), 'utf8');
    assert.equal(guide.includes('第一份文档'), false);
    assert.equal(guide.includes('第二份文档'), true);
  });

  it('does not modify the index when the stable entry id is unknown', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-doc-memory-'));
    tempDirs.push(repoDir);
    const store = createStore(repoDir);
    recordFeishuDocumentMemory(store, {
      title: '保留文档',
      url: 'https://www.feishu.cn/docx/doc-keep',
      documentId: 'doc-keep',
      chatId: 'chat-1',
    });
    const before = fs.readFileSync(getFeishuDocumentIndexPath(store), 'utf8');
    assert.equal(removeFeishuDocumentMemory(store, 'https://www.feishu.cn/docx/doc-keep'), null);
    assert.equal(fs.readFileSync(getFeishuDocumentIndexPath(store), 'utf8'), before);
  });
});
