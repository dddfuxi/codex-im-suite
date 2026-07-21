import type { WorkflowExecutionSummaryContract } from '@codex-im-suite/contracts';

export type AiStrategy = 'official' | 'local_api' | 'external_api' | 'auto_failover';

export interface CodexStrategySettings {
  codexModelSource: string;
  codexRoutingMode: string;
  codexBaseUrl: string;
  codexModel: string;
  codexReasoningEffort: string;
}

export interface CodexWorkflowExecutionDescription {
  model: string;
  reasoning: string;
  thread: string;
  parameterEvidence: string;
}

/**
 * 切换来源只改变路由选择，不删除暂时未启用来源的配置，避免来回切换时丢失模型或端点。
 */
export function applyCodexSourceStrategy<T extends CodexStrategySettings>(current: T, strategy: AiStrategy): T {
  if (strategy === 'auto_failover') {
    return { ...current, codexRoutingMode: 'auto_failover' };
  }
  return {
    ...current,
    codexModelSource: strategy,
    codexRoutingMode: 'manual',
  };
}

function describeThreadMode(mode: WorkflowExecutionSummaryContract['threadMode']): string {
  switch (mode) {
    case 'fresh': return '新建 Thread';
    case 'resumed': return '复用兼容 Thread';
    case 'fresh_profile_changed': return '配置变化，新建 Thread';
    case 'fresh_resume_failed': return '恢复失败，新建 Thread';
    default: return '未知';
  }
}

export function describeCodexWorkflowExecution(
  execution: Partial<WorkflowExecutionSummaryContract> | undefined,
): CodexWorkflowExecutionDescription {
  const hasSdkEvidence = execution?.parameterEvidence === 'sdk_thread_options';
  const model = execution?.submittedModel
    ? `${execution.submittedModel}${hasSdkEvidence ? '（已提交给 Codex）' : ''}`
    : execution?.modelMode === 'source_default'
      ? 'Codex 来源默认模型（未显式传 model）'
      : execution?.model || '未知';
  const reasoning = execution?.executionOverrideReason === 'restricted_interaction'
    ? `请求 ${execution.requestedReasoningEffort || '未知'}；受限回合使用 ${execution.submittedReasoningEffort || 'low'}`
    : execution?.submittedReasoningEffort
      ? `${execution.submittedReasoningEffort}${hasSdkEvidence ? '（已提交给 Codex）' : ''}`
      : execution?.requestedReasoningEffort || '未知';

  return {
    model,
    reasoning,
    thread: describeThreadMode(execution?.threadMode),
    parameterEvidence: hasSdkEvidence ? 'SDK ThreadOptions' : '未记录',
  };
}
