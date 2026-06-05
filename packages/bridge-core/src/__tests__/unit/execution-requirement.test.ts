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

  it('uses explicit memory recall intent instead of scene keyword tool gating', () => {
    const requirement = classifyExecutionRequirement({
      userText: '所有的常用场景名发给我',
      workingDirectory: 'C:\\unity\\ST3\\Game',
      memoryPlan: {
        intent: 'explicit_recall',
        queryText: '常用场景名',
        normalizedKey: '常用场景名',
        answerMode: 'direct_if_confident',
        minConfidence: 0.78,
        allowDirectAnswer: true,
      },
    });

    assert.equal(requirement.kind, 'none');
  });

  it('does not require tool evidence for Feishu sticker semantic events', () => {
    const unknown = classifyExecutionRequirement({
      userText: [
        '用户发送了一个尚未标注语义的飞书表情包，file_key=v3_unknown。',
        '飞书事件只提供 file_key，且不支持机器人下载表情包图片；当前不能可靠识别图案、文字和意图。',
      ].join('\n'),
      messageKind: 'feishu_sticker_unknown',
      workingDirectory: 'C:\\unity\\ST3\\Game',
    });
    assert.equal(unknown.kind, 'none');

    const known = classifyExecutionRequirement({
      userText: [
        '用户发送了一个已记录语义的飞书表情包，file_key=v3_known。',
        '表情包语义：图案/名称：称赞表情；通常意图：表达称赞、认可。',
      ].join('\n'),
      messageKind: 'feishu_sticker_known',
      workingDirectory: 'C:\\unity\\ST3\\Game',
    });
    assert.equal(known.kind, 'none');

    const imageBacked = classifyExecutionRequirement({
      userText: '用户发送了一个飞书表情包，file_key=v3_image，表情包图片已作为本轮图片附件提供给模型。',
      messageKind: 'feishu_sticker_image',
      files: [{ id: 'img', name: 'sticker.png', type: 'image/png', size: 4, data: 'AAAA' }],
      workingDirectory: 'C:\\unity\\ST3\\Game',
    });
    assert.equal(imageBacked.kind, 'none');
  });

  it('requires tool evidence for current Unity scene object inspection even when asking for names', () => {
    const requirement = classifyExecutionRequirement({
      userText: 'unity场景里找有相机组件的物体\n总结成节点名称发我',
      workingDirectory: 'C:\\unity\\ST3',
    });

    assert.equal(requirement.kind, 'tool_required');
    assert.ok(requirement.requiredToolFamilies.includes('unity-mcp'));
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
