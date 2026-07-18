import {
  isExecutionEvidenceSatisfied,
  type ExecutionRequirement,
} from 'claude-to-im/src/lib/bridge/execution-requirement.js';
import type { InputEvidenceKind } from 'claude-to-im/src/lib/bridge/input-evidence.js';

export interface RuntimeExecutionEvidenceInput {
  requirement?: ExecutionRequirement;
  successfulToolResultCount: number;
  toolNames?: string[];
  acceptedInputEvidenceIds?: string[];
  acceptedInputEvidenceKinds?: InputEvidenceKind[];
}

/**
 * runtime 状态与 bridge-core 最终交付必须复用同一证据裁决，避免面板显示成功、
 * 最终卡片却因工具家族不匹配被判失败。
 */
export function computeRuntimeExecutionEvidenceSatisfied(input: RuntimeExecutionEvidenceInput): boolean {
  if (!input.requirement) return true;
  return isExecutionEvidenceSatisfied(input.requirement, {
    successfulToolResultCount: input.successfulToolResultCount,
    toolNames: input.toolNames,
    acceptedInputEvidenceIds: input.acceptedInputEvidenceIds,
    acceptedInputEvidenceKinds: input.acceptedInputEvidenceKinds,
  });
}
