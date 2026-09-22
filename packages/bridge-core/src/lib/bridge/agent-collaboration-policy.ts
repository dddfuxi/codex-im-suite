import type { AgentCollaborationMode } from '@codex-im-suite/contracts';

import type { TurnFocusDecision } from './turn-context.js';

export interface CollaborationEligibilityInput {
  mode: AgentCollaborationMode;
  text: string;
  evidenceCount: number;
  focus: TurnFocusDecision;
  hasAttachments?: boolean;
  memoryIntentCandidate?: boolean;
}

export interface CollaborationEligibilityDecision {
  eligible: boolean;
  reason: string;
}

const MULTI_STEP_CONNECTOR_RE = /(?:先.+再|同时|并且|然后|以及|分别|一边.+一边|first.+then|and\s+also|in\s+parallel)/isu;
const ANALYSIS_STRUCTURE_RE = /(?:架构|权衡|比较|评估|诊断|规划|方案|全局|上下文|记忆|性能|依赖|工作流|architecture|trade-?off|compare|evaluate|diagnos|plan|context|memory|performance|workflow)/iu;

/**
 * 确定性准入只负责节流，不替代 Coordinator 的任务规划。
 * 简单聊天、单一事实问答和确定性命令必须保持零 Worker 调用。
 */
export function decideCollaborationEligibility(input: CollaborationEligibilityInput): CollaborationEligibilityDecision {
  if (input.mode === 'off') return { eligible: false, reason: '协作模式关闭' };
  const text = input.text.replace(/\s+/gu, ' ').trim();
  if (!text) return { eligible: false, reason: '当前消息没有可分析正文' };
  if (input.memoryIntentCandidate) return { eligible: true, reason: '当前消息存在受控记忆意图候选' };
  if (input.focus.requiresAgentResolution || input.focus.focus === 'ambiguous' || input.focus.confidence < 0.75) {
    return { eligible: true, reason: '当前回合存在冲突或低置信上下文证据' };
  }
  if ((input.hasAttachments && input.evidenceCount >= 3) || input.evidenceCount >= 5) {
    return { eligible: true, reason: '当前回合包含多源 evidence，需要协作整理' };
  }
  if (text.length >= 40 && MULTI_STEP_CONNECTOR_RE.test(text)) {
    return { eligible: true, reason: '当前请求包含多个相互关联的步骤' };
  }
  if (text.length >= 80 && ANALYSIS_STRUCTURE_RE.test(text)) {
    return { eligible: true, reason: '当前请求需要跨职责的结构化分析' };
  }
  return { eligible: false, reason: '单一、低复杂度回合继续使用现有主 Agent 链路' };
}
