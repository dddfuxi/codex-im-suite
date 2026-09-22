import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

async function loadModule() {
  try {
    return await import('../work-profile.js');
  } catch {
    return null;
  }
}

describe('结构化工作档案', () => {
  it('按稳定键更新当前有效状态而不是无限追加旧结论', async () => {
    const module = await loadModule();
    assert.ok(module, 'work-profile module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-work-profile-upsert-'));
    const filePath = path.join(root, '工作档案.md');

    try {
      module.upsertWorkProfileEntry(filePath, {
        workspaceId: 'alpha-123',
        workspaceLabel: 'Alpha',
        key: 'build-command',
        content: '构建命令：npm run build-old。',
        timestamp: '2026-07-18T10:00:00.000Z',
        reason: '首次验证。',
        evidenceIds: ['runtime:result'],
      });
      module.upsertWorkProfileEntry(filePath, {
        workspaceId: 'alpha-123',
        workspaceLabel: 'Alpha',
        key: 'build-command',
        content: '构建命令：npm run build。',
        timestamp: '2026-07-18T10:05:00.000Z',
        reason: '命令已更新并重新验证。',
        evidenceIds: ['runtime:result'],
      });

      const content = fs.readFileSync(filePath, 'utf8');
      assert.match(content, /cti-work-profile:v2/u);
      assert.match(content, /## 当前有效状态/u);
      assert.match(content, /构建命令：npm run build。/u);
      assert.doesNotMatch(content, /build-old/u);
      assert.equal((content.match(/key="build-command"/gu) || []).length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('相同键和值重复写入时保持幂等且不增加最近变更记录', async () => {
    const module = await loadModule();
    assert.ok(module, 'work-profile module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-work-profile-dedup-'));
    const filePath = path.join(root, '工作档案.md');
    const input = {
      workspaceId: 'alpha-123',
      workspaceLabel: 'Alpha',
      key: 'test-command',
      content: '测试命令：npm test。',
      timestamp: '2026-07-18T10:00:00.000Z',
      reason: '测试通过。',
      evidenceIds: ['runtime:result'],
    };

    try {
      const first = module.upsertWorkProfileEntry(filePath, input);
      const before = fs.readFileSync(filePath, 'utf8');
      const second = module.upsertWorkProfileEntry(filePath, {
        ...input,
        timestamp: '2026-07-18T10:05:00.000Z',
      });
      const after = fs.readFileSync(filePath, 'utf8');

      assert.equal(first.changed, true);
      assert.equal(second.changed, false);
      assert.equal(after, before);
      assert.equal((after.match(/`test-command`/gu) || []).length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
