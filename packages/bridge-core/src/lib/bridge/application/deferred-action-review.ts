import {
  extractCtiArtifactPromotionAction,
  extractCtiBridgeControlAction,
  extractCtiDirectMessageAction,
  extractCtiReminderAction,
  extractCtiScheduledTaskAction,
} from './action-blocks.js';
import { containsUnverifiedReminderCompletion } from './reminders.js';

export interface DeferredActionReviewFailure {
  code: string;
  retryable: boolean;
  repairInstruction: string;
  userMessage: string;
}

export type DeferredActionReviewResult =
  | { ok: true }
  | { ok: false; failure: DeferredActionReviewFailure };

type ActionBlockReview = {
  family: string;
  hadBlock: boolean;
  valid: boolean;
  error?: string;
};

function inspectActionBlocks(responseText: string): ActionBlockReview[] {
  const reminder = extractCtiReminderAction(responseText);
  const scheduledTask = extractCtiScheduledTaskAction(responseText);
  const directMessage = extractCtiDirectMessageAction(responseText);
  const bridgeControl = extractCtiBridgeControlAction(responseText);
  const artifactPromotion = extractCtiArtifactPromotionAction(responseText);
  return [
    { family: 'cti-reminder', hadBlock: reminder.hadBlock, valid: Boolean(reminder.action), error: reminder.error },
    { family: 'cti-scheduled-task', hadBlock: scheduledTask.hadBlock, valid: Boolean(scheduledTask.action), error: scheduledTask.error },
    { family: 'cti-direct-message', hadBlock: directMessage.hadBlock, valid: Boolean(directMessage.action), error: directMessage.error },
    { family: 'cti-bridge-control', hadBlock: bridgeControl.hadBlock, valid: Boolean(bridgeControl.action), error: bridgeControl.error },
    { family: 'cti-artifact-promotion', hadBlock: artifactPromotion.hadBlock, valid: Boolean(artifactPromotion.action), error: artifactPromotion.error },
  ];
}

/**
 * 审查尚未被 Bridge 执行的模型动作协议。这里只判断“能否进入可信执行边界”，
 * 不执行动作，也不放宽 Owner、身份、授权、目标或高风险门禁。
 */
export function reviewDeferredBridgeActionProtocol(responseText: string): DeferredActionReviewResult {
  const actionBlocks = inspectActionBlocks(responseText);
  const invalidBlock = actionBlocks.find((item) => item.hadBlock && !item.valid);
  if (invalidBlock) {
    return {
      ok: false,
      failure: {
        code: `invalid_deferred_action:${invalidBlock.family}`,
        retryable: true,
        repairInstruction: [
          `The ${invalidBlock.family} action block is invalid${invalidBlock.error ? `: ${invalidBlock.error}` : ''}.`,
          'Rebuild one complete valid action block from the original user request, preserving only model-controlled fields.',
          'If the request does not actually require this action, remove the action block and answer without claiming that any action completed.',
        ].join(' '),
        userMessage: `未完成：${invalidBlock.family} 动作协议无效；已自动修复一次，但仍未能形成可执行动作。`,
      },
    };
  }

  const hasVerifiedReminderAction = actionBlocks.some((item) => (
    (item.family === 'cti-reminder' || item.family === 'cti-scheduled-task')
    && item.valid
  ));
  if (!hasVerifiedReminderAction && containsUnverifiedReminderCompletion(responseText)) {
    return {
      ok: false,
      failure: {
        code: 'unverified_reminder_completion',
        retryable: true,
        repairInstruction: [
          'Re-evaluate whether the user asked to query, create, or modify a reminder/scheduled task.',
          'For a query, report only the trusted task evidence already present in the prompt and do not claim creation.',
          'For a creation request, return a valid cti-reminder or cti-scheduled-task action block instead of claiming completion in prose.',
          'Do not invent task state, IDs, delivery receipts, authorization, or platform targets.',
        ].join(' '),
        userMessage: '未完成：模型输出缺少可由统一调度系统验证的提醒或计划任务动作；自动协议修复后结果仍不完整。',
      },
    };
  }

  return { ok: true };
}
