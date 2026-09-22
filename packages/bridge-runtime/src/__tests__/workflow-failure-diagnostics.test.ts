import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diagnoseWorkflowFailures } from '../workflow-failure-diagnostics.js';

describe('workflow failure diagnostics', () => {
  it('keeps provider authentication separate from tool runtime failures', () => {
    const diagnostics = diagnoseWorkflowFailures({
      providerError: new Error('Codex 登录已失效，请重新登录。'),
      toolErrors: [
        "Get-Content: Cannot find path 'C:\\runtime\\skills\\tool\\SKILL.md' because it does not exist.",
        'Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data, and node are supported.',
        'Windows helper runtime is unavailable',
      ],
    });

    assert.deepEqual(diagnostics.map((item) => item.code), [
      'provider.authentication_requires_user_action',
      'tool.dependency_path_missing',
      'tool.module_loader_incompatible',
      'tool.runtime_unavailable',
    ]);
    assert.equal(diagnostics[0]?.source, 'provider');
    assert.ok(diagnostics.slice(1).every((item) => item.source === 'tool'));
  });

  it('deduplicates repeated raw failures by stable diagnostic code', () => {
    const diagnostics = diagnoseWorkflowFailures({
      toolErrors: ['ENOENT: first path', 'ENOENT: second path'],
    });

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.code, 'tool.dependency_path_missing');
  });
});
