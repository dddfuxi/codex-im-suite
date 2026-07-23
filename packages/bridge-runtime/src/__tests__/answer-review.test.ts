import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reviewOutboundAnswerRules } from '../answer-review.js';

describe('answer review', () => {
  it('warns when a memory answer returns an unrelated structured table', () => {
    const decision = reviewOutboundAnswerRules({
      channelType: 'feishu',
      chatId: 'oc_group',
      userText: '第十三条龙叫啥@小虾米',
      answerText: '项目 HSScene：医院内部场景 city3d_citystage_ST2H_Scene == 外城场景',
      memoryPlan: {
        intent: 'explicit_recall',
        queryText: '第十三条龙叫啥@小虾米',
        normalizedKey: '第十三条龙',
        answerMode: 'evidence_if_confident',
        minConfidence: 0.78,
        allowHighConfidenceEvidence: true,
      },
      memoryHits: [{
        sessionId: 'knowledge-index:dragon',
        role: 'assistant',
        source: 'summary',
        sourceType: 'knowledge',
        score: 20,
        confidence: 0.95,
        answerability: 'structured',
        quality: 'high',
        structuredKey: '第十三条龙',
        structuredValue: '雷霆龙',
        content: '第十三条龙 = 雷霆龙',
      }],
    });

    assert.equal(decision.verdict, 'warn');
    assert.ok(decision.reasonCodes.includes('memory_key_mismatch'));
  });

  it('warns on mojibake and protocol leakage', () => {
    const decision = reviewOutboundAnswerRules({
      channelType: 'feishu',
      chatId: 'oc_group',
      userText: '整理一下你现在都记得啥',
      answerText: 'HSScene = 鍖婚櫌鍐呴儴鍦烘櫙\n```cti-final\n{}',
    });

    assert.equal(decision.verdict, 'warn');
    assert.ok(decision.reasonCodes.includes('mojibake'));
    assert.ok(decision.reasonCodes.includes('protocol_leakage'));
  });

  it('replaces provider-internal tool failure text without leaking internal names', () => {
    const decision = reviewOutboundAnswerRules({
      channelType: 'feishu',
      chatId: 'oc_group',
      userText: 'pve关卡场景叫啥',
      answerText: 'I notice that the multi_agent_v1 tool is not supported in this environment. Could you please let me know what specific task or question you would like help with?',
    });

    assert.equal(decision.verdict, 'replace');
    assert.ok(decision.reasonCodes.includes('internal_tool_leakage'));
    assert.match(decision.replacementText || '', /未完成/);
    assert.doesNotMatch(decision.replacementText || '', /multi_agent|tool|unsupported/i);
  });

  it('recomposes quick memory lookup answers from structured hits during review', () => {
    const decision = reviewOutboundAnswerRules({
      channelType: 'feishu',
      chatId: 'oc_group',
      userText: 'pve关卡场景叫啥',
      answerText: 'unsupported call: multi_agent_v1',
      memoryPlan: {
        intent: 'explicit_recall',
        queryText: 'pve关卡场景叫啥',
        normalizedKey: 'pve关卡场景',
        answerMode: 'evidence_if_confident',
        minConfidence: 0.78,
        allowHighConfidenceEvidence: true,
      },
      memoryHits: [{
        sessionId: 'knowledge-index:scene',
        role: 'assistant',
        source: 'summary',
        sourceType: 'knowledge',
        score: 18,
        confidence: 0.92,
        answerability: 'structured',
        quality: 'high',
        content: [
          '常用场景名称对应表：',
          '',
          '`HSScene` == 医院内部场景',
          '`pve_gunship` == pve场景',
        ].join('\n'),
      }],
    });

    assert.equal(decision.verdict, 'replace');
    assert.equal(decision.replacementText, 'pve_gunship：pve场景');
    assert.doesNotMatch(decision.replacementText || '', /multi_agent|unsupported|tool/i);
  });

  it('warns when an execution completion claim has no successful tool evidence', () => {
    const decision = reviewOutboundAnswerRules({
      channelType: 'feishu',
      chatId: 'oc_group',
      userText: '在工作区新建一个txt文档并在里面写一个1，命名为测试',
      answerText: '已成功在工作区新建了一个名为“测试”的txt文档，并在其中写入了数字1。',
      executionEvidence: {
        toolUseCount: 0,
        toolResultCount: 0,
        successfulToolResultCount: 0,
        failedToolResultCount: 0,
        toolNames: [],
        permissionRequestCount: 0,
      },
    });

    assert.equal(decision.verdict, 'warn');
    assert.ok(decision.reasonCodes.includes('unsupported_execution_claim'));
  });

  it('warns when a local read answer lacks required tool evidence', () => {
    const decision = reviewOutboundAnswerRules({
      channelType: 'feishu',
      chatId: 'oc_group',
      userText: '你能看一眼本地工作目录Game里都有哪些文件夹吗',
      answerText: 'Game 文件夹下有 Assets、Library、Scripts、Scenes。',
      executionEvidence: {
        toolUseCount: 0,
        toolResultCount: 0,
        successfulToolResultCount: 0,
        failedToolResultCount: 0,
        toolNames: [],
        permissionRequestCount: 0,
        requiredEvidenceKind: 'local_read_required',
        evidenceSatisfied: false,
        noEvidenceRetryAttempted: true,
        requiredToolFamilies: ['shell', 'read', 'search'],
      },
    });

    assert.equal(decision.verdict, 'warn');
    assert.ok(decision.reasonCodes.includes('unsupported_execution_claim'));
  });

  it('accepts image analysis when structured input evidence was accepted', () => {
    const decision = reviewOutboundAnswerRules({
      channelType: 'feishu',
      chatId: 'oc_group',
      userText: '分析一下图片里的关键信息',
      answerText: '图片分析完成：构建状态成功，当前进度 100%。',
      executionEvidence: {
        toolUseCount: 0,
        toolResultCount: 0,
        successfulToolResultCount: 0,
        failedToolResultCount: 0,
        toolNames: [],
        permissionRequestCount: 0,
        requiredEvidenceKind: 'input_evidence_required',
        evidenceSatisfied: true,
        requiredInputEvidenceKinds: ['image'],
        requiredInputEvidenceIds: ['image-1'],
        acceptedInputEvidenceKinds: ['image'],
        acceptedInputEvidenceIds: ['image-1'],
        inputEvidenceProvider: 'codex',
      },
    });

    assert.equal(decision.verdict, 'pass');
    assert.ok(!decision.reasonCodes.includes('unsupported_execution_claim'));
  });

  it('does not treat completed-input wording in the user prompt as an assistant completion claim', () => {
    const decision = reviewOutboundAnswerRules({
      channelType: 'feishu',
      chatId: 'oc_group',
      userText: '图片已经作为本轮附件提供给模型，请根据图片轻量回应。',
      answerText: '嘿嘿，真棒～继续稳稳推进。',
      executionEvidence: {
        toolUseCount: 0,
        toolResultCount: 0,
        successfulToolResultCount: 0,
        failedToolResultCount: 0,
        toolNames: [],
        permissionRequestCount: 0,
        requiredEvidenceKind: 'none',
        evidenceSatisfied: true,
      },
    });

    assert.equal(decision.verdict, 'pass');
    assert.ok(!decision.reasonCodes.includes('unsupported_execution_claim'));
  });
});
