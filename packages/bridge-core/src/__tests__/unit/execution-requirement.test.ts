import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExecutionRequirementPrompt,
  classifyToolResultQuality,
  classifyExecutionRequirement,
  isExecutionEvidenceSatisfied,
  shouldReplaceWithNoExecutionEvidenceText,
  buildNoExecutionEvidenceText,
} from '../../lib/bridge/execution-requirement.js';

function withStrictToolRouting<T>(fn: () => T): T {
  const previous = process.env.CTI_STRICT_TOOL_ROUTING;
  process.env.CTI_STRICT_TOOL_ROUTING = 'true';
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CTI_STRICT_TOOL_ROUTING;
    else process.env.CTI_STRICT_TOOL_ROUTING = previous;
  }
}

describe('execution requirement classifier', () => {
  it('classifies tool result quality from structured protocol fields instead of text phrases', () => {
    const protocolError = classifyToolResultQuality('plain diagnostic text', true);
    assert.equal(protocolError.ok, false);
    assert.match(protocolError.errorSummary || '', /plain diagnostic text/);

    const structuredError = classifyToolResultQuality(JSON.stringify({
      ok: false,
      message: 'backend unavailable',
    }), false);
    assert.equal(structuredError.ok, false);
    assert.equal(structuredError.errorSummary, 'backend unavailable');

    const plainText = classifyToolResultQuality('Error searching returned no usable data', false);
    assert.equal(plainText.ok, true);
  });

  it('classifies clean Chinese local read and command requests', () => {
    withStrictToolRouting(() => {
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
  });

  it('requires tool evidence for local directory listing requests', () => {
    withStrictToolRouting(() => {
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
  });

  it('requires artifact evidence for Unity screenshot tasks', () => {
    withStrictToolRouting(() => {
      const requirement = classifyExecutionRequirement({
        userText: 'unity game视角截个图',
        workingDirectory: 'C:\\unity\\ST3\\Game',
      });

      assert.equal(requirement.kind, 'artifact_required');
      assert.ok(requirement.requiredToolFamilies.includes('unity-mcp'));
      assert.ok(requirement.requiredToolFamilies.includes('artifact'));
    });
  });

  it('does not auto-route time-sensitive questions into MCP tools without an explicit tool request', () => {
    const headlineRequirement = classifyExecutionRequirement({
      userText: '查一下今天的三个头条',
      workingDirectory: 'C:\\unity\\ST3',
    });
    assert.equal(headlineRequirement.kind, 'none');
    assert.equal(isExecutionEvidenceSatisfied(headlineRequirement, { successfulToolResultCount: 0 }), true);

    const vagueRequirement = classifyExecutionRequirement({
      userText: '查一下今天有什么新消息',
      workingDirectory: 'C:\\unity\\ST3',
    });
    assert.equal(vagueRequirement.kind, 'none');
  });

  it('allows low-risk local probing when the request names an available workspace object', () => {
    const workspaceRequirement = classifyExecutionRequirement({
      userText: '查一下当前工作目录里有哪些文件夹',
      workingDirectory: 'C:\\unity\\ST3',
    });
    assert.equal(workspaceRequirement.kind, 'local_read_required');
    assert.match(workspaceRequirement.reason, /low-risk/i);

    const fileRequirement = classifyExecutionRequirement({
      userText: '看一下 packages/bridge-core/package.json 里配置了什么',
      workingDirectory: 'C:\\Users\\admin\\Documents\\New project\\codex-im-suite',
    });
    assert.equal(fileRequirement.kind, 'local_read_required');

    const vagueRequirement = classifyExecutionRequirement({
      userText: '查一下今天有什么新消息',
      workingDirectory: 'C:\\unity\\ST3',
    });
    assert.equal(vagueRequirement.kind, 'none');
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
        answerMode: 'evidence_if_confident',
        minConfidence: 0.78,
        allowHighConfidenceEvidence: true,
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
      userText: '用户发送了一个飞书表情包，file_key=v3_image，记忆仓库中已有该表情包图片，并已作为本轮图片附件提供给模型。',
      messageKind: 'feishu_sticker_image',
      files: [{ id: 'img', name: 'sticker.png', type: 'image/png', size: 4, data: 'AAAA' }],
      workingDirectory: 'C:\\unity\\ST3\\Game',
    });
    assert.equal(imageBacked.kind, 'none');
  });

  it('requires tool evidence for current Unity scene object inspection even when asking for names', () => {
    withStrictToolRouting(() => {
      const requirement = classifyExecutionRequirement({
        userText: 'unity场景里找有相机组件的物体\n总结成节点名称发我',
        workingDirectory: 'C:\\unity\\ST3',
      });

      assert.equal(requirement.kind, 'tool_required');
      assert.ok(requirement.requiredToolFamilies.includes('unity-mcp'));
    });
  });

  it('preserves concrete failed tool output instead of replacing it with no-evidence text', () => {
    withStrictToolRouting(() => {
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

  it('does not let cti-final bypass missing required tool evidence', () => {
    withStrictToolRouting(() => {
      const requirement = classifyExecutionRequirement({
        userText: 'powershell -NoProfile -Command "Write-Output ok"',
        workingDirectory: 'C:\\unity\\ST3',
      });

      assert.equal(
        shouldReplaceWithNoExecutionEvidenceText(
          requirement,
          { toolResultCount: 0, successfulToolResultCount: 0 },
          '```cti-final\n{"kind":"text","text":"今天三个头条是 A、B、C。","images":[],"files":[],"reply_mode":"markdown"}\n```',
        ),
        true,
      );
    });
  });

  it('includes failed tool reasons in no-evidence blockers', () => {
    const requirement = {
      kind: 'tool_required' as const,
      reason: 'compatibility test requirement',
      requiredToolFamilies: ['mcp'],
    };

    const text = buildNoExecutionEvidenceText(requirement, {
      toolUseCount: 1,
      toolResultCount: 1,
      successfulToolResultCount: 0,
      failedToolErrors: ['Network Error: fetch failed. Check if the configured service URL is correct.'],
      toolNames: ['JsonTool:mcp_call'],
    });

    assert.match(text, /失败原因：Network Error: fetch failed/);
    assert.match(text, /JsonTool:mcp_call/);
  });
});
