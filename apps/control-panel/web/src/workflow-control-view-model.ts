import type { WorkflowPanelRunContract } from '@codex-im-suite/contracts/workflow';

export function canCancelActiveReply(run: WorkflowPanelRunContract): boolean {
  return run.status === 'running';
}

export function cancelActiveReplyTitle(run: WorkflowPanelRunContract): string {
  if (run.status === 'cancelled') return '该回复已终止。';
  if (run.status === 'succeeded' || run.status === 'failed') return '该回复已完成，无法终止。';
  if (run.status === 'retry_pending' || run.status === 'retrying') return '该状态不是当前聊天的活动回复，不能从这里终止。';
  return '只终止这个回复，不会停止 Bridge 或影响其他会话。';
}
