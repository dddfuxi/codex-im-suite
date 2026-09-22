import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

async function loadModule() {
  try {
    return await import('../self-maintenance-rule-lifecycle.js');
  } catch {
    return null;
  }
}

describe('自维护规则成熟度', () => {
  it('只用独立会话的重复真实支持把试用规则提升为已确认', async () => {
    const module = await loadModule();
    assert.ok(module, 'rule lifecycle module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-rule-lifecycle-'));
    const base = {
      memoryRoot: root,
      target: 'tool_rules' as const,
      key: 'path-check',
      contentHash: 'a'.repeat(64),
      timestamp: '2026-07-18T10:00:00.000Z',
    };

    try {
      const first = module.recordManagedRuleSupport({ ...base, sessionId: 'session-1' });
      const repeatedSameSession = module.recordManagedRuleSupport({ ...base, sessionId: 'session-1' });
      const secondSession = module.recordManagedRuleSupport({
        ...base,
        sessionId: 'session-2',
        timestamp: '2026-07-18T11:00:00.000Z',
      });

      assert.equal(first.status, 'trial');
      assert.equal(first.supportCount, 1);
      assert.equal(repeatedSameSession.supportCount, 1);
      assert.equal(secondSession.status, 'confirmed');
      assert.equal(secondSession.supportCount, 2);
      assert.deepEqual(secondSession.supportSessionIds.sort(), ['session-1', 'session-2']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('规则内容变化时保留旧版本摘要并重新进入试用', async () => {
    const module = await loadModule();
    assert.ok(module, 'rule lifecycle module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-rule-lifecycle-reset-'));

    try {
      module.recordManagedRuleSupport({
        memoryRoot: root,
        target: 'identity',
        key: 'persona-tone',
        contentHash: 'a'.repeat(64),
        sessionId: 'session-1',
        timestamp: '2026-07-18T10:00:00.000Z',
      });
      const updated = module.recordManagedRuleSupport({
        memoryRoot: root,
        target: 'identity',
        key: 'persona-tone',
        contentHash: 'b'.repeat(64),
        sessionId: 'session-2',
        timestamp: '2026-07-18T11:00:00.000Z',
      });

      assert.equal(updated.status, 'trial');
      assert.equal(updated.supportCount, 1);
      assert.equal(updated.previousVersions.length, 1);
      assert.equal(updated.previousVersions[0].contentHash, 'a'.repeat(64));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('按唯一运行证据记录支持和回归结果且不重复计数', async () => {
    const module = await loadModule();
    assert.ok(module, 'rule lifecycle module should exist');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-rule-lifecycle-evaluation-'));

    try {
      module.recordManagedRuleSupport({
        memoryRoot: root,
        target: 'tool_rules',
        key: 'path-check',
        contentHash: 'a'.repeat(64),
        sessionId: 'session-1',
        timestamp: '2026-07-18T10:00:00.000Z',
      });
      const supported = module.recordManagedRuleEvaluation({
        memoryRoot: root,
        target: 'tool_rules',
        key: 'path-check',
        outcome: 'supported',
        evidenceId: 'runtime:success:1',
        timestamp: '2026-07-18T11:00:00.000Z',
      });
      const duplicate = module.recordManagedRuleEvaluation({
        memoryRoot: root,
        target: 'tool_rules',
        key: 'path-check',
        outcome: 'supported',
        evidenceId: 'runtime:success:1',
        timestamp: '2026-07-18T11:01:00.000Z',
      });
      const regressed = module.recordManagedRuleEvaluation({
        memoryRoot: root,
        target: 'tool_rules',
        key: 'path-check',
        outcome: 'regressed',
        evidenceId: 'runtime:failure:2',
        timestamp: '2026-07-18T12:00:00.000Z',
      });

      assert.equal(supported.successCount, 1);
      assert.equal(duplicate.successCount, 1);
      assert.equal(regressed.regressionCount, 1);
      assert.equal(regressed.status, 'regressed');
      assert.deepEqual(regressed.evaluationEvidenceIds.sort(), ['runtime:failure:2', 'runtime:success:1']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
