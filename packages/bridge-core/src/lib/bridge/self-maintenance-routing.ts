export interface CorrectionMaintenanceRoutingInput {
  currentUserText: string;
  previousAssistantText?: string;
}

const DIRECT_CORRECTION_RE = /(?:你|刚才|上一条|上次|还是|又).{0,28}(?:错(?:了|误)?|不对|误判|说错|弄错|搞错|漏掉|遗漏|没有生效|没效果|并不存在)|(?:wrong|incorrect|mistaken|you\s+(?:missed|forgot|claimed))/iu;
const CONTRASTIVE_FACT_RE = /(?:^|[。！？!?;；\n])\s*(?:其实|实际(?:上)?|事实上|明明|正确(?:答案|结果|路径|做法)?是|应该是|并不是|不是这个|并非如此)|(?:^|[.!?;\n]\s*)(?:actually|in fact|the correct|it is not|that is incorrect)/iu;
const FAILURE_FEEDBACK_RE = /(?:还是|依然|仍然|又).{0,18}(?:错|失败|不行|没用|没有效果|未生效)|(?:still|again).{0,18}(?:wrong|failed|broken|not working)/iu;

/**
 * 这里只判断是否值得调用独立纠错 classifier，不直接认定用户正确，
 * 也不授予任何写权限；最终改写仍需双片段 evidence 和存储层门禁。
 */
export function shouldRunCorrectionMaintenance(input: CorrectionMaintenanceRoutingInput): boolean {
  const current = input.currentUserText.trim();
  if (!current || !input.previousAssistantText?.trim()) return false;
  return DIRECT_CORRECTION_RE.test(current)
    || CONTRASTIVE_FACT_RE.test(current)
    || FAILURE_FEEDBACK_RE.test(current);
}
