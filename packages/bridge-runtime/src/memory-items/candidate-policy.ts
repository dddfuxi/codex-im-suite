import crypto from 'node:crypto';

export interface CandidateEligibilityInput {
  role: 'user' | 'assistant' | string;
  text: string;
}

export type CandidateEligibilityResult =
  | { eligible: true; reason: 'stable_declarative_candidate'; normalizedText: string }
  | {
    eligible: false;
    reason: 'not_human' | 'length' | 'sensitive' | 'tool_or_link' | 'question_or_action' | 'mention_or_protocol' | 'no_stable_signal';
  };

export interface CandidateObservationEvidence {
  sessionId: string;
  text: string;
  sourceMessageHash: string;
  observedAt: string;
}

export interface CandidateObservationState {
  normalizedText: string;
  fingerprint: string;
  sessionIds: string[];
  sourceMessageHashes: string[];
  distinctSessionCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
}

const URL_RE = /(?:https?:\/\/|www\.)\S+/iu;
const COMMAND_RE = /(?:^|[\r\n])\s*(?:powershell|pwsh|cmd(?:\.exe)?|bash|sh|git|npm|pnpm|yarn|node|python|dotnet)\b|(?:^|\s)-(?:File|Command|ExecutionPolicy)\b/iu;
const QUESTION_RE = /[?？]\s*$|(?:叫啥|是什么|怎么|如何|为何|为什么|哪(?:个|些|里)|是否|能否|可不可以|有没有|吗|么|呢)\s*[。.!！]?$/u;
const ACTION_RE = /^(?:请|请你|麻烦|帮我|帮忙|直接|现在|继续|先)?\s*(?:查看|看看|看下|截(?:一张|图)?|执行|运行|打开|关闭|修复|检查|总结|分析|生成|创建|新建|删除|移动|上传|下载|推送|发送|回复|改成|修改|更新|整理)/u;
const MENTION_OR_PROTOCOL_RE = /(?:^|\s)@[_\p{L}\p{N}-]+|```\s*(?:cti-|json|tool)|\b(?:cti-final|tool_use|tool_result|permission_request)\b/iu;
const SENSITIVE_RE = /(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|passwd|secret|验证码|口令|密码|密钥|身份证|银行卡)/iu;
const STABLE_SIGNAL_RE = /(?:我(?:更)?(?:偏好|喜欢|不喜欢|习惯)|我的(?:偏好|习惯)|以后(?:都|统一|默认)?|一直|通常|固定|默认|必须|不要|别在|规则|约定|项目代号|默认项目|默认分支|回复语言|交付格式|==|=>|->)/u;

export function normalizeCandidateText(value: string): string {
  return String(value || '')
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function classifyCandidateEligibility(input: CandidateEligibilityInput): CandidateEligibilityResult {
  const text = normalizeCandidateText(input.text);
  const comparisonText = text.normalize('NFKC');
  if (input.role !== 'user') return { eligible: false, reason: 'not_human' };
  if (text.length < 12 || text.length > 240) return { eligible: false, reason: 'length' };
  if (SENSITIVE_RE.test(comparisonText)) return { eligible: false, reason: 'sensitive' };
  if (URL_RE.test(comparisonText) || COMMAND_RE.test(comparisonText)) return { eligible: false, reason: 'tool_or_link' };
  if (MENTION_OR_PROTOCOL_RE.test(comparisonText)) return { eligible: false, reason: 'mention_or_protocol' };
  if (QUESTION_RE.test(comparisonText) || ACTION_RE.test(comparisonText)) return { eligible: false, reason: 'question_or_action' };
  if (!STABLE_SIGNAL_RE.test(comparisonText)) return { eligible: false, reason: 'no_stable_signal' };
  return { eligible: true, reason: 'stable_declarative_candidate', normalizedText: text };
}

function uniqueBounded(items: string[], maxItems = 100): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean))).slice(-maxItems);
}

export function mergeCandidateObservation(
  previous: CandidateObservationState | undefined,
  evidence: CandidateObservationEvidence,
): CandidateObservationState {
  const normalizedText = normalizeCandidateText(evidence.text);
  const fingerprint = crypto.createHash('sha256').update(normalizedText, 'utf8').digest('hex');
  if (previous && previous.fingerprint !== fingerprint) {
    throw new Error('candidate observation fingerprint mismatch');
  }
  const sessionId = evidence.sessionId.trim();
  const sourceMessageHash = evidence.sourceMessageHash.trim();
  const alreadySeen = Boolean(previous?.sessionIds.includes(sessionId))
    || Boolean(sourceMessageHash && previous?.sourceMessageHashes.includes(sourceMessageHash));
  if (previous && alreadySeen) return previous;
  const sessionIds = uniqueBounded([...(previous?.sessionIds || []), sessionId]);
  const sourceMessageHashes = uniqueBounded([
    ...(previous?.sourceMessageHashes || []),
    ...(sourceMessageHash ? [sourceMessageHash] : []),
  ]);
  return {
    normalizedText,
    fingerprint,
    sessionIds,
    sourceMessageHashes,
    distinctSessionCount: sessionIds.length,
    firstObservedAt: previous?.firstObservedAt || evidence.observedAt,
    lastObservedAt: evidence.observedAt,
  };
}
