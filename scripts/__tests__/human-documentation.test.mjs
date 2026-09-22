import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessHumanDocumentationChanges } from '../check-human-documentation.mjs';

describe('人类文档漂移门禁', () => {
  it('运行时代码变化要求同步开发日志和架构文档', () => {
    const result = assessHumanDocumentationChanges([
      'packages/bridge-runtime/src/human-document-governance.ts',
    ]);

    assert.equal(result.relevantChange, true);
    assert.equal(result.architectureChange, true);
    assert.deepEqual(result.missing, [
      'docs/DEVELOPMENT-LOG.md',
      'docs/PROJECT-ARCHITECTURE.md',
    ]);
  });

  it('对应人类入口随同修改后通过门禁', () => {
    const result = assessHumanDocumentationChanges([
      'packages/bridge-runtime/src/human-document-governance.ts',
      'docs/DEVELOPMENT-LOG.md',
      'docs/PROJECT-ARCHITECTURE.md',
    ]);

    assert.equal(result.ok, true);
    assert.deepEqual(result.missing, []);
  });

  it('纯测试和实施计划变化不伪造架构影响', () => {
    const result = assessHumanDocumentationChanges([
      'packages/bridge-runtime/src/__tests__/human-document-governance.test.ts',
      'docs/superpowers/plans/2026-07-18-多Agent协作与工作区治理总路线图.md',
    ]);

    assert.equal(result.relevantChange, false);
    assert.equal(result.ok, true);
  });

  it('Manifest 或用户入口脚本变化至少要求开发日志', () => {
    const result = assessHumanDocumentationChanges([
      'config/skills.d/example.json',
    ]);

    assert.equal(result.relevantChange, true);
    assert.equal(result.architectureChange, false);
    assert.deepEqual(result.missing, ['docs/DEVELOPMENT-LOG.md']);
  });
});
