import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyCodexSourceStrategy,
  describeCodexWorkflowExecution,
} from './codex-model-settings.js';

describe('Codex model settings', () => {
  it('keeps model, endpoint and reasoning when switching to official', () => {
    const current = {
      codexModelSource: 'external_api',
      codexRoutingMode: 'manual',
      codexBaseUrl: 'https://example.test/v1',
      codexModel: 'gpt-5.4',
      codexReasoningEffort: 'xhigh',
    };

    const next = applyCodexSourceStrategy(current, 'official');

    assert.equal(next.codexModelSource, 'official');
    assert.equal(next.codexRoutingMode, 'manual');
    assert.equal(next.codexModel, 'gpt-5.4');
    assert.equal(next.codexReasoningEffort, 'xhigh');
    assert.equal(next.codexBaseUrl, 'https://example.test/v1');
  });

  it('describes source default without guessing a model', () => {
    const summary = describeCodexWorkflowExecution({
      modelMode: 'source_default',
      submittedReasoningEffort: 'high',
      parameterEvidence: 'sdk_thread_options',
      threadMode: 'fresh',
    });

    assert.equal(summary.model, 'Codex 来源默认模型（未显式传 model）');
    assert.equal(summary.reasoning, 'high（已提交给 Codex）');
    assert.equal(summary.thread, '新建 Thread');
    assert.equal(summary.parameterEvidence, 'SDK ThreadOptions');
  });

  it('shows restricted override honestly', () => {
    const summary = describeCodexWorkflowExecution({
      requestedReasoningEffort: 'xhigh',
      submittedReasoningEffort: 'low',
      executionOverrideReason: 'restricted_interaction',
    });

    assert.equal(summary.reasoning, '请求 xhigh；受限回合使用 low');
  });

  it('shows an explicit submitted model without claiming provider confirmation', () => {
    const summary = describeCodexWorkflowExecution({
      submittedModel: 'gpt-5.4',
      modelMode: 'explicit',
      parameterEvidence: 'sdk_thread_options',
    });

    assert.equal(summary.model, 'gpt-5.4（已提交给 Codex）');
    assert.doesNotMatch(summary.model, /服务端已确认/);
  });
});
