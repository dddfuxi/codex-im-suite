import type { MemoryQueryPlan, RetrievedMemoryHit } from 'claude-to-im/src/lib/bridge/host.js';

import { repairLikelyMojibakeText } from './mojibake.js';
import { inferStructuredMemories, isLowValueMemoryText } from './memory-routing.js';

export type AnswerReviewMode = 'observe' | 'block_or_replace';

export interface AnswerReviewInput {
  channelType: string;
  chatId: string;
  userId?: string;
  userDisplayName?: string;
  messageId?: string;
  sessionId?: string;
  workingDirectory?: string;
  userText: string;
  answerText: string;
  memoryPlan?: MemoryQueryPlan;
  memoryHits?: RetrievedMemoryHit[];
  source?: 'direct_memory' | 'codex' | 'local' | 'system';
  executionEvidence?: {
    toolUseCount: number;
    toolResultCount: number;
    successfulToolResultCount: number;
    failedToolResultCount: number;
    toolNames: string[];
    permissionRequestCount: number;
  };
}

export interface AnswerReviewDecision {
  verdict: 'pass' | 'warn' | 'block' | 'replace';
  reasonCodes: string[];
  mode: AnswerReviewMode;
  createdAt: string;
  replacementText?: string;
  memoryWriteCandidates?: Array<{ key?: string; value?: string; text: string }>;
}

const PROTOCOL_LEAKAGE_RE = /```(?:cti-final|cti-reminder)|\bcti-final\b|\bcti-reminder\b|"reply_mode"|"kind"\s*:/iu;
const TOOL_FAKE_COMPLETION_RE = /(已完成|已经完成|记住了|已记住|已经记下|创建好了).*(未拿到|没有拿到|不可用|失败|无法执行|没法执行)|(?:未完成|失败).*(已完成|记住了)/u;

const CONCRETE_EXECUTION_REQUEST_RE = /(ignis|unity|blender|mcp|截图|图片|图像|关机|关闭电脑|shutdown|文件|文档|txt|\.txt|\.md|\.json|(?:生成|创建|新建|写入|保存|删除|移动|复制|上传|下载|导入|导出|安装|启动|停止|重启|运行|执行).{0,32}(文件|文档|图片|图像|截图|txt|项目|服务|bridge|mcp|命令|脚本|本机|电脑|工作区))/i;
const POSITIVE_EXECUTION_CLAIM_RE = /(已|已经|成功|完成|生成|创建|新建|写入|保存|上传|下载|导入|导出|安装|启动|停止|重启|执行|正在执行|已提交).{0,48}(文件|文档|图片|图像|截图|命令|脚本|操作|任务|请求|shutdown|关机|本地|工作区|路径|生成|创建|写入|保存|执行|完成|成功)/i;
const NEGATIVE_EXECUTION_RESULT_RE = /(未完成|失败|无法|不能|没有|未能|不可用|阻塞|报错|错误|找不到|不存在|未执行|已拦截)/i;

function normalizeText(text: string | undefined): string {
  return (text || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function hasExplicitStructuredAnswer(text: string): boolean {
  return inferStructuredMemories(text).length > 0 || /[A-Za-z0-9_\-/]{2,}\s*(?:==|=|：|:)\s*\S/u.test(text);
}

function answerMentionsExpectedMemory(input: AnswerReviewInput): boolean {
  const key = normalizeText(input.memoryPlan?.normalizedKey || input.memoryPlan?.queryText);
  if (!key) return true;
  const answer = normalizeText(input.answerText);
  if (answer.includes(key)) return true;

  for (const hit of input.memoryHits || []) {
    const hitKey = normalizeText(hit.structuredKey);
    const hitValue = normalizeText(hit.structuredValue);
    if (hitKey && hitKey === key && hitValue && answer.includes(hitValue)) return true;
    for (const pair of hit.structuredPairs || []) {
      const pairKey = normalizeText(pair.key);
      const pairValue = normalizeText(pair.value);
      if (pairKey && pairKey === key && pairValue && answer.includes(pairValue)) return true;
    }
  }

  return false;
}

function shouldCheckMemoryKeyMismatch(input: AnswerReviewInput): boolean {
  return input.memoryPlan?.intent === 'explicit_recall'
    && !!(input.memoryPlan.normalizedKey || input.memoryPlan.queryText)
    && hasExplicitStructuredAnswer(input.answerText);
}

function hasUnsupportedExecutionClaim(input: AnswerReviewInput): boolean {
  if (!input.executionEvidence) return false;
  if (input.executionEvidence.successfulToolResultCount > 0) return false;
  if (!CONCRETE_EXECUTION_REQUEST_RE.test(input.userText || '')) return false;
  if (NEGATIVE_EXECUTION_RESULT_RE.test(input.answerText || '')) return false;
  return POSITIVE_EXECUTION_CLAIM_RE.test(`${input.userText}\n${input.answerText}`);
}

export function reviewOutboundAnswerRules(
  input: AnswerReviewInput,
  options: { mode?: AnswerReviewMode; createdAt?: string } = {},
): AnswerReviewDecision {
  const reasonCodes: string[] = [];
  const answerText = input.answerText || '';

  const repaired = repairLikelyMojibakeText(answerText);
  if (repaired.unresolved || repaired.scoreBefore >= 2) {
    reasonCodes.push('mojibake');
  }

  if (PROTOCOL_LEAKAGE_RE.test(answerText)) {
    reasonCodes.push('protocol_leakage');
  }

  if (isLowValueMemoryText(answerText)) {
    reasonCodes.push('low_value_memory');
  }

  if (TOOL_FAKE_COMPLETION_RE.test(answerText)) {
    reasonCodes.push('tool_fake_completion');
  }

  if (hasUnsupportedExecutionClaim(input)) {
    reasonCodes.push('unsupported_execution_claim');
  }

  if (shouldCheckMemoryKeyMismatch(input) && !answerMentionsExpectedMemory(input)) {
    reasonCodes.push('memory_key_mismatch');
  }

  return {
    verdict: reasonCodes.length > 0 ? 'warn' : 'pass',
    reasonCodes: Array.from(new Set(reasonCodes)),
    mode: options.mode || 'observe',
    createdAt: options.createdAt || new Date().toISOString(),
  };
}
