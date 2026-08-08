import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExecutionRequirementPrompt,
  buildNoEvidenceRetryPrompt,
  classifyToolResultQuality,
  classifyExecutionRequirement,
  inferNestedMcpToolEvidenceNames,
  inheritContinuationExecutionRequirement,
  isExecutionEvidenceSatisfied,
  shouldReplaceWithNoExecutionEvidenceText,
  buildNoExecutionEvidenceText,
  hasDeferredBridgeExecutionAction,
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
  it('requires a verified artifact for explicit visual deliverables', () => {
    const requirement = classifyExecutionRequirement({
      userText: '给北辰附近的餐饮做个排行图表，按性价比排序',
      workingDirectory: 'C:\\workspace',
    });

    assert.equal(requirement.kind, 'artifact_required');
    assert.equal(requirement.strictToolEvidence, true);
    assert.ok(requirement.requiredToolFamilies.includes('artifact'));
  });

  it('inherits artifact evidence for short constraint changes on a recovered completed result', () => {
    const envelope = {
      protocol: 'cti-turn-context/v1' as const,
      channelType: 'feishu',
      chatId: 'oc_group',
      messageId: 'om_current',
      currentText: '打到人均30左右',
      evidence: [{
        id: 'message:om_result',
        kind: 'message' as const,
        relation: 'native_reply' as const,
        source: 'platform_api' as const,
        confidence: 1,
        content: [
          '机器人：榜单做好啦',
          '本地已发送内容摘要：原始请求：给附近餐饮做个排行图表，按性价比排序',
          '上一轮状态：已完成',
          '上一轮结果：榜单做好啦，直接看图。',
        ].join('\n'),
        metadata: {
          contentRecovered: true,
          continuationContextRecovered: true,
        },
      }],
    };
    const focus = {
      protocol: 'cti-turn-focus/v1' as const,
      mode: 'deterministic' as const,
      focus: 'reply_target' as const,
      primaryEvidenceIds: ['message:om_result'],
      supportingEvidenceIds: [],
      conflictingEvidenceIds: [],
      confidence: 1,
      requiresAgentResolution: false,
      reason: 'test',
    };

    for (const userText of ['打到人均30左右', '换成红色', '去掉第三项']) {
      const currentRequirement = classifyExecutionRequirement({ userText, workingDirectory: 'C:\\workspace' });
      assert.equal(currentRequirement.kind, 'none');
      const inherited = inheritContinuationExecutionRequirement({
        currentRequirement,
        userText,
        workingDirectory: 'C:\\workspace',
        envelope: { ...envelope, currentText: userText },
        focus,
      });
      assert.equal(inherited.kind, 'artifact_required', userText);
      assert.equal(inherited.inheritedFromContinuation, true, userText);
      assert.match(buildExecutionRequirementPrompt(inherited), /Deliver the revised result now/u);
    }

    const acknowledgement = inheritContinuationExecutionRequirement({
      currentRequirement: classifyExecutionRequirement({ userText: '看到了，谢谢' }),
      userText: '看到了，谢谢',
      envelope,
      focus,
    });
    assert.equal(acknowledgement.kind, 'none');
  });

  it('does not inherit execution requirements from an unverified card title', () => {
    const currentRequirement = classifyExecutionRequirement({ userText: '换成红色' });
    const inherited = inheritContinuationExecutionRequirement({
      currentRequirement,
      userText: '换成红色',
      envelope: {
        protocol: 'cti-turn-context/v1',
        channelType: 'feishu',
        chatId: 'oc_group',
        messageId: 'om_current',
        currentText: '换成红色',
        evidence: [{
          id: 'message:om_card',
          kind: 'message',
          relation: 'native_reply',
          source: 'platform_api',
          confidence: 1,
          content: '机器人：结果做好啦',
          metadata: { contentRecovered: true },
        }],
      },
      focus: {
        protocol: 'cti-turn-focus/v1',
        mode: 'deterministic',
        focus: 'reply_target',
        primaryEvidenceIds: ['message:om_card'],
        supportingEvidenceIds: [],
        conflictingEvidenceIds: [],
        confidence: 1,
        requiresAgentResolution: false,
        reason: 'test',
      },
    });

    assert.equal(inherited.kind, 'none');
  });

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

  it('treats terse directory questions as agent tool tasks without gating descriptive mentions', () => {
    const terseRequirement = classifyExecutionRequirement({
      userText: '工作目录',
      workingDirectory: 'F:\\unity\\ST4',
    });
    assert.equal(terseRequirement.kind, 'local_read_required');

    const explicitRequirement = classifyExecutionRequirement({
      userText: '当前工作路径是什么？',
      workingDirectory: 'F:\\unity\\ST4',
    });
    assert.equal(explicitRequirement.kind, 'local_read_required');

    for (const userText of [
      '导致构建失败，当前工作目录配置错误',
      '不要走快捷，导致 xxxx，当前工作路径 xxxx，这样的对话会被误触',
      '日志里写着当前工作路径 F:\\old，但这只是报错原文',
      '这个配置的工作目录字段怎么设计',
    ]) {
      assert.equal(classifyExecutionRequirement({
        userText,
        workingDirectory: 'F:\\unity\\ST4',
      }).kind, 'none', userText);
    }

    const initialPrompt = buildExecutionRequirementPrompt(terseRequirement);
    assert.match(initialPrompt, /routing metadata.*not.*tool evidence/i);
    assert.match(initialPrompt, /Get-Location|pwd/i);

    const retryPrompt = buildNoEvidenceRetryPrompt(terseRequirement, {
      recoveryAttempt: 1,
      maxRecoveryAttempts: 2,
      previousEvidence: { toolUseCount: 0, toolResultCount: 0, successfulToolResultCount: 0 },
    });
    assert.match(retryPrompt, /routing metadata.*not.*tool evidence/i);
    assert.match(retryPrompt, /Get-Location|pwd/i);
    assert.match(retryPrompt, /recovery attempt 1 of 2/i);
    assert.match(retryPrompt, /did not call any real tool/i);

    const finalRetryPrompt = buildNoEvidenceRetryPrompt(terseRequirement, {
      recoveryAttempt: 2,
      maxRecoveryAttempts: 2,
      previousEvidence: { toolUseCount: 0, toolResultCount: 0, successfulToolResultCount: 0 },
    });
    assert.match(finalRetryPrompt, /final recovery attempt \(2 of 2\)/i);
    assert.match(finalRetryPrompt, /different compatible route/i);
    assert.match(finalRetryPrompt, /Do not repeat the previous acknowledgement/i);
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

  it('requires provider-accepted input evidence for read-only image analysis', () => {
    const requirement = classifyExecutionRequirement({
      userText: '分析一下图片里的关键信息',
      workingDirectory: 'C:\\unity\\ST3',
      files: [{
        id: 'image-1',
        name: 'build-result.jpg',
        type: 'image/jpeg',
        size: 128,
        data: 'aW1hZ2U=',
      }],
    });

    assert.equal(requirement.kind, 'input_evidence_required');
    assert.deepEqual((requirement as any).requiredInputEvidenceKinds, ['image']);
    assert.deepEqual((requirement as any).requiredInputEvidenceIds, ['image-1']);
    assert.equal(
      isExecutionEvidenceSatisfied(requirement, {
        successfulToolResultCount: 0,
        acceptedInputEvidenceIds: [],
        acceptedInputEvidenceKinds: [],
      } as any),
      false,
    );
    assert.equal(
      isExecutionEvidenceSatisfied(requirement, {
        successfulToolResultCount: 0,
        acceptedInputEvidenceIds: ['image-1'],
        acceptedInputEvidenceKinds: ['image'],
      } as any),
      true,
    );

    assert.equal(
      shouldReplaceWithNoExecutionEvidenceText(
        requirement,
        {
          toolResultCount: 0,
          successfulToolResultCount: 0,
          acceptedInputEvidenceIds: [],
          acceptedInputEvidenceKinds: [],
        } as any,
        '```cti-final\n{"kind":"image","text":"图片分析完成","images":["claimed.png"],"files":[],"reply_mode":"markdown"}\n```',
      ),
      true,
      'A declared output artifact must not bypass missing provider input evidence',
    );

    assert.equal(
      shouldReplaceWithNoExecutionEvidenceText(
        requirement,
        {
          toolResultCount: 0,
          successfulToolResultCount: 0,
          acceptedInputEvidenceIds: ['image-1'],
          acceptedInputEvidenceKinds: ['image'],
        } as any,
        '图片里的构建状态是成功。',
      ),
      false,
    );

    const prompt = buildExecutionRequirementPrompt(requirement);
    assert.match(prompt, /structured input evidence/i);
    assert.doesNotMatch(prompt, /call an appropriate real tool/i);
  });

  it('treats an attached screenshot noun as read-only input evidence', () => {
    const requirement = classifyExecutionRequirement({
      userText: '分析一下这张 Unity 截图里的报错',
      workingDirectory: 'C:\\unity\\ST3',
      files: [{
        id: 'screenshot-1',
        name: 'unity-error.png',
        type: 'image/png',
        size: 128,
        data: 'aW1hZ2U=',
      }],
    });

    assert.equal(requirement.kind, 'input_evidence_required');
    assert.deepEqual(requirement.requiredInputEvidenceIds, ['screenshot-1']);
    assert.deepEqual(requirement.requiredInputEvidenceKinds, ['image']);
    assert.equal(requirement.requiredToolFamilies.length, 0);
  });

  it('keeps explicit Unity or Blender follow-up actions above read-only screenshot analysis', () => {
    const cases = [
      {
        text: '先分析这张截图，再用 Unity 修复当前场景',
        family: 'unity-mcp',
      },
      {
        text: '根据这张截图检查 Unity 当前场景里的对象',
        family: 'unity-mcp',
      },
      {
        text: '根据这张截图通过 Blender 查看当前模型',
        family: 'blender',
      },
      {
        text: '先分析截图，当前场景里的对象也看一下',
        family: 'unity-mcp',
      },
      {
        text: '根据这张截图诊断 MCP 当前连接状态',
        family: 'mcp',
      },
      {
        text: '先分析截图，再查看不同 Unity 当前场景对象',
        family: 'unity-mcp',
      },
      {
        text: '先分析截图，不要改图但请用 Unity 检查当前场景',
        family: 'unity-mcp',
      },
      {
        text: '先分析截图，用 Unity 检查当前场景但不要修改图片',
        family: 'unity-mcp',
      },
      {
        text: '先分析截图但不要修改图片而是通过 Blender 重建模型',
        family: 'blender',
      },
      {
        text: '先分析截图，不修改图片却要用 Unity 检查当前场景',
        family: 'unity-mcp',
      },
      {
        text: '先分析截图，不修改图片而要通过 Blender 重建模型',
        family: 'blender',
      },
      {
        text: '先分析截图，不处理 Blender 模型同时检查 MCP 当前连接状态',
        family: 'mcp',
      },
      {
        text: '先分析截图，不修改图片并且用 Unity 检查当前场景',
        family: 'unity-mcp',
      },
      {
        text: '先分析截图，不要修改图片然后用 Unity 检查当前场景',
        family: 'unity-mcp',
      },
      {
        text: '先分析截图，不用 Unity 改由 Blender 重建模型',
        family: 'blender',
      },
      {
        text: '先分析截图，不处理 Blender 模型接着查询 MCP 当前状态',
        family: 'mcp',
      },
      {
        text: '先分析截图，不要修改图片随后通过 Blender 重建模型',
        family: 'blender',
      },
      {
        text: '先分析截图，不得不用 Unity 检查当前场景',
        family: 'unity-mcp',
      },
      {
        text: '先分析截图，不能不用 Unity 查看当前场景',
        family: 'unity-mcp',
      },
      {
        text: '先分析截图，把不需要的 Unity 场景对象删除',
        family: 'unity-mcp',
      },
      {
        text: '先分析截图，把未使用的 Blender 模型删除',
        family: 'blender',
      },
      {
        text: '先分析截图，对不可见的 Unity 场景对象进行修改',
        family: 'unity-mcp',
      },
      {
        text: '先分析截图，把不是当前场景的 Unity 对象列出来',
        family: 'unity-mcp',
      },
      {
        text: '先分析截图，对 Unity 里未激活的场景对象进行检查',
        family: 'unity-mcp',
      },
      {
        text: '先分析截图，把没有必要保留的 Unity 场景对象删除',
        family: 'unity-mcp',
      },
      {
        text: '先分析截图，把没有必要修改的 Unity 场景对象删除',
        family: 'unity-mcp',
      },
      {
        text: '先分析截图，把不需要检查的 Unity 场景对象列出来',
        family: 'unity-mcp',
      },
      {
        text: '先分析截图，不需要修改图片而是用 Unity 检查当前场景的对象',
        family: 'unity-mcp',
      },
      {
        text: '先分析截图，不需要改图，但用 Unity 查看当前场景的对象',
        family: 'unity-mcp',
      },
      {
        text: '先分析截图，没有必要处理 Blender，同时检查 MCP 连接的状态',
        family: 'mcp',
      },
      {
        text: '分析截图后在 Blender 里修一下模型',
        family: 'blender',
      },
      {
        text: '分析截图后在 Blender 里处理一下模型',
        family: 'blender',
      },
      {
        text: '分析截图后通过 Blender 重建这个模型',
        family: 'blender',
      },
    ];

    for (const testCase of cases) {
      const requirement = classifyExecutionRequirement({
        userText: testCase.text,
        workingDirectory: 'C:\\workspace',
        files: [{
          id: 'screenshot-1',
          name: 'reference.png',
          type: 'image/png',
          size: 128,
          data: 'aW1hZ2U=',
        }],
      });

      assert.notEqual(requirement.kind, 'input_evidence_required', testCase.text);
      assert.ok(requirement.requiredToolFamilies.includes(testCase.family), testCase.text);
    }
  });

  it('keeps Unity or Blender names inside screenshot analysis as read-only input evidence', () => {
    const prompts = [
      '检查一下这张 Unity 截图里的报错',
      '查看这张 Unity 截图里的报错',
      '读取这张 Unity 截图里的文字',
      '看看这张 Blender 截图哪里错了',
      '分析这张 Scene View 截图里的构图',
      '诊断这张 Game View 截图反映的当前状态',
      '分析这张 MCP 截图里的连接错误',
      '看看这张 Unity 截图，不用 Unity，只分析截图内容',
      '只分析截图，不要修改 Unity 模型',
      '看看截图，不处理 Blender 模型',
      '不要用 Unity 查看当前场景，只分析这张截图',
      '不要再用 Unity，只分析截图',
      '别再调用 Blender，只分析截图',
      '分析这张当前场景截图里的布局',
      '看看这张场景里的对象截图哪里有问题',
      '分析这张截图里的当前场景布局',
      '不能用 Unity 查看当前场景，只分析这张截图',
      '不需要用 Unity 检查当前场景，只分析截图',
      '无法用 Blender 修改模型，只分析截图',
      '我不想用 Unity 检查当前场景，只分析截图',
      '我不打算调用 Blender 修改模型，只分析截图',
      '没有必要用 MCP 查询当前状态，只分析截图',
      '不要在 Unity 里查看当前场景，只分析这张截图',
      '我不想让 Blender 修改模型，只分析截图',
      '不需要借助 MCP 查询当前连接状态，只分析截图',
      '无法从 Unity 获取当前场景，只分析截图',
      '禁止对 Blender 模型进行修改，只分析截图',
      '无需在 Unity 当前场景中删除对象，只分析截图',
    ];

    for (const userText of prompts) {
      const requirement = classifyExecutionRequirement({
        userText,
        workingDirectory: 'C:\\workspace',
        files: [{
          id: 'screenshot-1',
          name: 'reference.png',
          type: 'image/png',
          size: 128,
          data: 'aW1hZ2U=',
        }],
      });

      assert.equal(requirement.kind, 'input_evidence_required', userText);
      assert.equal(requirement.requiredToolFamilies.length, 0, userText);
    }
  });

  it('keeps image editing and output requests behind artifact evidence', () => {
    const requirement = classifyExecutionRequirement({
      userText: '把这张图里的重点圈出来并保存成一张新图',
      files: [{
        id: 'image-1',
        name: 'source.png',
        type: 'image/png',
        size: 64,
        data: 'aW1hZ2U=',
      }],
    });

    assert.equal(requirement.kind, 'artifact_required');
    assert.ok(requirement.requiredToolFamilies.includes('artifact'));
  });

  it('does not treat an image noun without actual input as an artifact action', () => {
    const requirement = classifyExecutionRequirement({
      userText: '分析一下图片里的关键信息',
      workingDirectory: 'C:\\unity\\ST3',
    });

    assert.equal(requirement.kind, 'none');
  });

  it('requires Unity MCP evidence by default for concrete Unity actions', () => {
    const previous = process.env.CTI_STRICT_TOOL_ROUTING;
    delete process.env.CTI_STRICT_TOOL_ROUTING;
    try {
      const requirement = classifyExecutionRequirement({
        userText: '我还是要st4项目的，现在电脑里打开了，你检查一下mcp连接状态，能不能用，能用截一张game视角图给我',
        workingDirectory: 'C:\\unity\\ST3\\Game',
      });

      assert.equal(requirement.kind, 'artifact_required');
      assert.ok(requirement.requiredToolFamilies.includes('unity-mcp'));
      assert.equal(
        isExecutionEvidenceSatisfied(requirement, {
          successfulToolResultCount: 2,
          toolNames: ['Bash', 'Edit'],
        }),
        false,
      );
      assert.equal(
        isExecutionEvidenceSatisfied(requirement, {
          successfulToolResultCount: 1,
          toolNames: ['JsonTool:mcp_call'],
        }),
        false,
      );
      assert.equal(
        isExecutionEvidenceSatisfied(requirement, {
          successfulToolResultCount: 1,
          toolNames: ['JsonTool:mcp_call'],
          verifiedOutputArtifactCount: 1,
        }),
        true,
      );
    } finally {
      if (previous === undefined) delete process.env.CTI_STRICT_TOOL_ROUTING;
      else process.env.CTI_STRICT_TOOL_ROUTING = previous;
    }
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

  it('does not turn a controlled memory write containing prefab paths into a Unity tool task', () => {
    const requirement = classifyExecutionRequirement({
      userText: '记住HSScene里面的交互物相关：__ArtData\\_Resources\\Prefab\\HospitalSimulation\\Actor\\Prop，命名格式是 H_Inter_ActualName',
      workingDirectory: 'C:\\unity\\ST3',
      memoryIntentHandled: true,
    });

    assert.equal(requirement.kind, 'none');
    assert.deepEqual(requirement.requiredToolFamilies, []);
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

  it('defers evidence enforcement only for a valid structured artifact promotion action', () => {
    const valid = [
      '```cti-artifact-promote',
      JSON.stringify({
        artifactId: 'artifact-111111111111111111111111',
        targetProjectId: 'st3',
        targetRelativePath: 'Game/Assets/Generated/preview.png',
        expectedSha256: 'a'.repeat(64),
      }),
      '```',
    ].join('\n');
    assert.equal(hasDeferredBridgeExecutionAction(valid), true);
    assert.equal(hasDeferredBridgeExecutionAction(valid.replace('artifact-111111111111111111111111', 'fake-id')), false);
    assert.equal(hasDeferredBridgeExecutionAction('产物已经保存到项目。'), false);
  });

  it('keeps no-evidence blockers actionable without leaking raw tool output', () => {
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

    assert.match(text, /未完成：这次没有获得可验证的执行结果/);
    assert.match(text, /本轮没有通过MCP获得可验证结果/);
    assert.doesNotMatch(text, /Network Error|service URL|tool_use|tool_result|tool_required|JsonTool:mcp_call/);
  });

  it('recognizes a successful Unity MCP JSON-RPC call nested inside a shell tool', () => {
    const names = inferNestedMcpToolEvidenceNames({
      outerToolName: 'Bash',
      toolInput: {
        command: "Invoke-WebRequest -Uri 'http://127.0.0.1:8081/mcp' -Method Post -Body '{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"manage_scene\"}}'",
      },
      toolResultContent: '{"jsonrpc":"2.0","result":{"structuredContent":{"success":true,"message":"Scene saved successfully"}}}',
    });

    assert.deepEqual(names, ['nested-mcp:jsonrpc', 'nested-mcp:manage_scene']);
    assert.equal(isExecutionEvidenceSatisfied({
      kind: 'tool_required',
      reason: 'Unity scene change',
      requiredToolFamilies: ['unity-mcp'],
      strictToolEvidence: true,
    }, {
      successfulToolResultCount: 1,
      toolNames: ['Bash', ...names],
    }), true);
  });

  it('does not promote output text or an explicitly failed nested MCP result', () => {
    assert.deepEqual(inferNestedMcpToolEvidenceNames({
      outerToolName: 'Bash',
      toolInput: { command: "Write-Output 'Unity MCP manage_scene saved successfully'" },
      toolResultContent: 'Unity MCP manage_scene saved successfully',
    }), []);

    assert.deepEqual(inferNestedMcpToolEvidenceNames({
      outerToolName: 'Bash',
      toolInput: {
        command: "curl http://localhost:8081/mcp -d '{\"method\":\"tools/call\",\"params\":{\"name\":\"batch_execute\"}}'",
      },
      toolResultContent: 'success=False message=One or more commands failed.',
    }), []);

    assert.deepEqual(inferNestedMcpToolEvidenceNames({
      outerToolName: 'Bash',
      toolInput: {
        command: "curl https://example.com/mcp -d '{\"method\":\"tools/call\",\"params\":{\"name\":\"manage_scene\"}}'",
      },
      toolResultContent: '{"jsonrpc":"2.0","result":{"success":true}}',
    }), []);

    assert.deepEqual(inferNestedMcpToolEvidenceNames({
      outerToolName: 'Bash',
      toolInput: {
        command: "curl http://localhost:8081/mcp -d '{\"method\":\"tools/call\",\"params\":{\"name\":\"manage_scene\"}}'",
      },
      toolResultContent: 'Done',
    }), []);
  });

  it('treats Unity scene and Prefab mutations as external tool state, not output artifacts', () => {
    const referenceImage = [{
      id: 'reference-1',
      name: 'reference.png',
      type: 'image/png',
      size: 128,
      data: 'aW1hZ2U=',
    }];
    const prompts = [
      '根据这个，在ST4的unity里，HSScene场景的SceneRoot里创建H_Area09，并给房间添加RoomLock和RoomUnlock',
      '在刚刚创建的每一个节点的RoomLock和RoomUnlock里面，添加一个prefab，命名规则为H_RoomLock_xxx、H_RoomUnlock_xxx',
    ];

    for (const userText of prompts) {
      const requirement = classifyExecutionRequirement({
        userText,
        workingDirectory: 'F:\\unity\\ST4',
        files: referenceImage,
      });

      assert.equal(requirement.kind, 'tool_required', userText);
      assert.ok(requirement.requiredToolFamilies.includes('unity-mcp'), userText);
      assert.equal(requirement.requiredToolFamilies.includes('artifact'), false, userText);
    }
  });

  it('accepts a runtime-verified current-turn artifact without weakening non-artifact tool gates', () => {
    const artifactRequirement = classifyExecutionRequirement({
      userText: '截一张当前 Unity 的图',
      workingDirectory: 'C:\\unity\\ST3',
    });
    assert.equal(artifactRequirement.kind, 'artifact_required');
    assert.equal(
      isExecutionEvidenceSatisfied(artifactRequirement, {
        successfulToolResultCount: 1,
        toolNames: ['shell_command'],
        verifiedOutputArtifactCount: 1,
      }),
      true,
    );

    const toolRequirement = classifyExecutionRequirement({
      userText: '检查一下当前 Unity MCP 连接状态',
      workingDirectory: 'C:\\unity\\ST3',
    });
    assert.notEqual(toolRequirement.kind, 'artifact_required');
    assert.equal(
      isExecutionEvidenceSatisfied(toolRequirement, {
        successfulToolResultCount: 1,
        toolNames: ['shell_command'],
        verifiedOutputArtifactCount: 1,
      }),
      false,
    );
    assert.equal(
      isExecutionEvidenceSatisfied(toolRequirement, {
        successfulToolResultCount: 1,
        toolNames: ['mcp__unityMCP__manage_scene'],
      }),
      true,
    );
    assert.equal(
      isExecutionEvidenceSatisfied(toolRequirement, {
        successfulToolResultCount: 1,
        toolNames: ['mcp__pictureMCP__generate_image'],
      }),
      false,
    );
  });

  it('does not expose local-read evidence protocol details in user-visible blockers', () => {
    const text = buildNoExecutionEvidenceText({
      kind: 'local_read_required',
      reason: 'must inspect the current workspace directory',
      requiredToolFamilies: ['read'],
    }, {
      toolUseCount: 0,
      toolResultCount: 0,
      successfulToolResultCount: 0,
      toolNames: [],
    });

    assert.match(text, /系统已尝试受控只读检查/);
    assert.doesNotMatch(text, /local_read_required|tool_use|tool_result|must inspect/);
  });
});
