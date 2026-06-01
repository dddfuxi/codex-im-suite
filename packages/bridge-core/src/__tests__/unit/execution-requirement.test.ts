import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExecutionRequirementPrompt,
  classifyExecutionRequirement,
  isExecutionEvidenceSatisfied,
  shouldReplaceWithNoExecutionEvidenceText,
} from '../../lib/bridge/execution-requirement.js';

describe('execution requirement classifier', () => {
  it('classifies clean Chinese local read and command requests', () => {
    const readRequirement = classifyExecutionRequirement({
      userText: '看一下工作目录',
      workingDirectory: 'C:\\unity\\ST3',
    });
    assert.equal(readRequirement.kind, 'local_read_required');

    const commandRequirement = classifyExecutionRequirement({
      userText: 'powershell -NoProfile -Command "Write-Output ok"',
      workingDirectory: 'C:\\unity\\ST3',
    });
    assert.equal(commandRequirement.kind, 'tool_required');
    assert.ok(commandRequirement.requiredToolFamilies.includes('shell'));
  });

  it('requires tool evidence for local directory listing requests', () => {
    const requirement = classifyExecutionRequirement({
      userText: '你能看一眼本地工作目录Game里都有哪些文件夹吗',
      workingDirectory: 'C:\\unity\\ST3',
    });

    assert.equal(requirement.kind, 'local_read_required');
    assert.deepEqual(requirement.requiredToolFamilies, ['shell', 'read', 'search']);
    assert.match(buildExecutionRequirementPrompt(requirement), /must call an appropriate real tool/i);
    assert.equal(isExecutionEvidenceSatisfied(requirement, { successfulToolResultCount: 0 }), false);
    assert.equal(isExecutionEvidenceSatisfied(requirement, { successfulToolResultCount: 1 }), true);
  });

  it('requires artifact evidence for Unity screenshot tasks', () => {
    const requirement = classifyExecutionRequirement({
      userText: 'unity game视角截个图',
      workingDirectory: 'C:\\unity\\ST3\\Game',
    });

    assert.equal(requirement.kind, 'artifact_required');
    assert.ok(requirement.requiredToolFamilies.includes('unity-mcp'));
    assert.ok(requirement.requiredToolFamilies.includes('artifact'));
  });

  it('does not require tool evidence for ordinary explanations', () => {
    const requirement = classifyExecutionRequirement({
      userText: '解释一下自动切换模型来源怎么工作',
      workingDirectory: 'C:\\unity\\ST3',
    });

    assert.equal(requirement.kind, 'none');
    assert.equal(isExecutionEvidenceSatisfied(requirement, { successfulToolResultCount: 0 }), true);
  });

  it('does not require tool evidence for scene-name recall questions', () => {
    const requirement = classifyExecutionRequirement({
      userText: 'pve关卡场景叫啥',
      workingDirectory: 'C:\\unity\\ST3\\Game',
    });

    assert.equal(requirement.kind, 'none');
  });

  it('preserves concrete failed tool output instead of replacing it with no-evidence text', () => {
    const requirement = classifyExecutionRequirement({
      userText: 'powershell -ExecutionPolicy Bypass -File "C:\\unity\\ST3\\Game\\Assets\\FXTools\\Cli\\fxtools-cli.ps1" doctor',
      workingDirectory: 'C:\\unity\\ST3',
    });

    assert.equal(requirement.kind, 'tool_required');
    assert.equal(
      shouldReplaceWithNoExecutionEvidenceText(
        requirement,
        { toolResultCount: 1, successfulToolResultCount: 0 },
        '未完成：shell command exited with code 1\nstderr:\nCannot locate Unity.exe.',
      ),
      false,
    );
    assert.equal(
      shouldReplaceWithNoExecutionEvidenceText(
        requirement,
        { toolResultCount: 0, successfulToolResultCount: 0 },
        '检查好了。',
      ),
      true,
    );
  });
});
