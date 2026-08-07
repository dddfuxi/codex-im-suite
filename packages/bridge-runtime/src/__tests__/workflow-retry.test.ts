import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FeishuCloudDocumentHost } from 'claude-to-im/host';
import type { WorkflowRun } from '../workflow-status.js';
import { prepareWorkflowRetryExecution } from '../workflow-retry.js';

function createRetryRun(input: Partial<NonNullable<WorkflowRun['recovery']>['input']> = {}): WorkflowRun {
  return {
    id: 'run_1',
    sessionId: 'session_1',
    channelType: 'feishu',
    chatId: 'oc_retry',
    promptPreview: '总结飞书云文档',
    stage: 'failed',
    status: 'retrying',
    startedAt: '2026-05-09T00:00:00.000Z',
    updatedAt: '2026-05-09T00:01:00.000Z',
    recovery: {
      kind: 'recoverable',
      reason: 'test',
      markedAt: '2026-05-09T00:01:00.000Z',
      input: {
        prompt: '总结 https://example.feishu.cn/sheets/sht_abc',
        turnId: 'turn_retry',
        executionRequirement: { kind: 'none', reason: 'test', requiredToolFamilies: [] },
        channelType: 'feishu',
        chatId: 'oc_retry',
        userId: 'ou_liudan',
        userDisplayName: '刘丹',
        messageId: 'm_retry',
        ...input,
      },
    },
    retry: {
      status: 'retrying',
      attempts: 1,
      maxAttempts: 1,
    },
    events: [],
  };
}

describe('workflow retry cloud document precheck', () => {
  it('injects resolved Feishu cloud document context before retrying the LLM', async () => {
    const calls: unknown[] = [];
    const cloudDocuments: FeishuCloudDocumentHost = {
      resolveFeishuCloudLinks: async (input) => {
        calls.push(input);
        return {
          status: 'resolved',
          linkCount: 1,
          systemPrompt: '飞书真实内容：问题收集表',
        };
      },
    };

    const result = await prepareWorkflowRetryExecution({
      run: createRetryRun({ systemPrompt: '原始系统提示' }),
      cloudDocuments,
    });

    assert.equal(result.status, 'ready');
    assert.match(result.params.systemPrompt || '', /原始系统提示/);
    assert.match(result.params.systemPrompt || '', /飞书真实内容/);
    assert.deepEqual(calls[0], {
      text: '总结 https://example.feishu.cn/sheets/sht_abc',
      channelType: 'feishu',
      chatId: 'oc_retry',
      userId: 'ou_liudan',
      userDisplayName: '刘丹',
      messageId: 'm_retry',
    });
  });

  it('blocks workflow retry and returns the Feishu authorization card when cloud document access needs login', async () => {
    const cloudDocuments: FeishuCloudDocumentHost = {
      resolveFeishuCloudLinks: async () => ({
        status: 'auth_required',
        linkCount: 1,
        userMessage: '需要刘丹登录飞书授权',
        feishuCardJson: '{"card":"login"}',
      }),
    };

    const result = await prepareWorkflowRetryExecution({
      run: createRetryRun(),
      cloudDocuments,
    });

    assert.equal(result.status, 'blocked');
    assert.match(result.text, /需要刘丹登录飞书授权/);
    assert.equal(result.feishuCardJson, '{"card":"login"}');
  });

  it('restores managed attachments and the original execution boundary for a manual retry', async () => {
    const refs = [{
      id: 'input-image',
      name: 'scene.png',
      type: 'image/png',
      size: 68,
      filePath: 'C:/managed/scene.png',
      sha256: 'a'.repeat(64),
      createdAt: '2026-05-09T00:00:00.000Z',
      expiresAt: '2026-05-10T00:00:00.000Z',
    }];
    const restoredFiles = [{
      id: 'input-image',
      name: 'scene.png',
      type: 'image/png',
      size: 68,
      data: 'aW1hZ2U=',
      filePath: 'C:/managed/scene.png',
    }];
    const calls: unknown[] = [];
    const result = await prepareWorkflowRetryExecution({
      run: createRetryRun({
        prompt: '分析这张图片',
        workingDirectory: 'C:/workspace',
        additionalDirectories: ['C:/workspace/shared'],
        permissionMode: 'default',
        noEvidenceRetryAttempted: true,
        executionRequirement: {
          kind: 'input_evidence_required',
          reason: '图片是当前请求的输入证据',
          requiredToolFamilies: [],
          requiredInputEvidenceKinds: ['image'],
          requiredInputEvidenceIds: ['input-image'],
        },
        inputEvidenceRefs: refs,
      }),
      turnStorage: {
        restoreRecoveryInputEvidence: (input: unknown) => {
          calls.push(input);
          return restoredFiles;
        },
      } as any,
    });

    assert.equal(result.status, 'ready');
    assert.equal(result.params.turnId, 'turn_retry');
    assert.equal(result.params.forceFreshThread, true);
    assert.equal(result.params.noEvidenceRetryAttempted, true);
    assert.deepEqual(result.params.executionRequirement?.requiredInputEvidenceIds, ['input-image']);
    assert.deepEqual(result.params.files, restoredFiles);
    assert.deepEqual(calls, [{ sessionId: 'session_1', turnId: 'turn_retry', refs }]);
  });

  it('fails closed when managed retry evidence is expired or cannot be verified', async () => {
    const result = await prepareWorkflowRetryExecution({
      run: createRetryRun({
        prompt: '分析这张图片',
        executionRequirement: {
          kind: 'input_evidence_required',
          reason: '图片是当前请求的输入证据',
          requiredToolFamilies: [],
          requiredInputEvidenceKinds: ['image'],
          requiredInputEvidenceIds: ['input-image'],
        },
        inputEvidenceRefs: [{
          id: 'input-image', name: 'scene.png', type: 'image/png', size: 68, filePath: 'C:/managed/scene.png',
          sha256: 'a'.repeat(64), createdAt: '2026-05-09T00:00:00.000Z', expiresAt: '2026-05-10T00:00:00.000Z',
        }],
      }),
      turnStorage: {
        restoreRecoveryInputEvidence: () => { throw new Error('workflow_input_evidence_expired'); },
      } as any,
    });

    assert.equal(result.status, 'blocked');
    assert.match(result.text, /过期|校验失败/u);
  });

  it('refuses a bare retry when the original turn required input evidence', async () => {
    const result = await prepareWorkflowRetryExecution({
      run: createRetryRun({
        prompt: '分析这张图片',
        executionRequirement: {
          kind: 'input_evidence_required',
          reason: '图片是当前请求的输入证据',
          requiredToolFamilies: [],
          requiredInputEvidenceKinds: ['image'],
          requiredInputEvidenceIds: ['input-image'],
        },
        inputEvidenceRefs: [],
      }),
    });

    assert.equal(result.status, 'blocked');
    assert.match(result.text, /未执行裸重试/u);
  });
});
