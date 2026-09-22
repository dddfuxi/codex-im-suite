import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function loadModule() {
  try {
    return await import('../agent-home-rules.js');
  } catch {
    return null;
  }
}

describe('Agent Home 受控规则 patch', () => {
  it('更新稳定规则键时保留用户手写主体和其他受控规则', async () => {
    const module = await loadModule();
    assert.ok(module, 'agent-home-rules module should exist');
    const original = [
      '# 工具与环境',
      '',
      '<!-- cti-agent-home-template:v3 -->',
      '',
      '用户手写：优先使用本机真实工具。',
      '',
      '## Agent 自维护规则',
      '',
      '<!-- cti-agent-home-rule:start key="path-check" updatedAt="2026-07-18T09:00:00.000Z" -->',
      '### path-check',
      '',
      '旧规则：猜测路径。',
      '<!-- cti-agent-home-rule:end -->',
      '',
      '<!-- cti-agent-home-rule:start key="utf8" updatedAt="2026-07-18T09:00:00.000Z" -->',
      '### utf8',
      '',
      '中文文件必须使用 UTF-8。',
      '<!-- cti-agent-home-rule:end -->',
      '',
    ].join('\n');

    const updated = module.upsertManagedAgentHomeRule(original, {
      key: 'path-check',
      content: '新规则：判断路径前必须读取真实文件证据。',
      updatedAt: '2026-07-18T10:00:00.000Z',
    });

    assert.match(updated, /用户手写：优先使用本机真实工具/u);
    assert.match(updated, /中文文件必须使用 UTF-8/u);
    assert.match(updated, /新规则：判断路径前必须读取真实文件证据/u);
    assert.doesNotMatch(updated, /旧规则：猜测路径/u);
    assert.equal((updated.match(/key="path-check"/gu) || []).length, 1);
    assert.match(updated, /cti-agent-home-template:v3/u);
  });
});
