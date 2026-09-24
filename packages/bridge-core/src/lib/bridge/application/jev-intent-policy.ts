import type { DecisionQuestion, DecisionQuestionPlanningFailure, DecisionQuestionType } from '../host.js';

/** Only fixed, safe error messages may cross the planner delivery boundary. */
export function renderJevPlannerFailure(input: unknown): string {
  const code = input && typeof input === 'object' && 'errorCode' in input ? input.errorCode : '';
  const messages: Record<DecisionQuestionPlanningFailure['errorCode'], string> = {
    timeout: 'AI 生成判断题超时，请稍后重试。',
    cancelled: '本次判断已取消。',
    provider_error: 'AI 题目生成服务暂时不可用，请稍后重试。',
    invalid_output: 'AI 返回的判断题格式不符合要求，请重试。',
  };
  const message = typeof code === 'string' && Object.hasOwn(messages, code)
    ? messages[code as DecisionQuestionPlanningFailure['errorCode']]
    : '未获得有效的判断题，请重试。';
  return `${message}本次未调用 Jev 评估，也未生成概率。`;
}

/**
 * Pure, provider-neutral Jev intent classification.
 *
 * This layer only recognizes the communicative intent of one message and
 * organizes a bounded question for a DecisionProvider. It has no access to
 * channels, providers, credentials, tools, or delivery side effects.
 */
export type JevIntentKind =
  | 'greeting'
  | 'question'
  | 'request'
  | 'feedback'
  | 'thanks'
  | 'choice'
  | 'score'
  | 'statement'
  | 'unknown';

export interface JevIntentContext {
  /** Optional text recovered from the message being replied to. */
  replyText?: string;
  /** Optional short recent context; callers should provide only trusted text. */
  recentText?: string;
  /** One-turn debug override requested by the operator. */
  requestedType?: DecisionQuestionType;
}

export interface JevIntentAnalysis {
  kind: JevIntentKind;
  text: string;
  confidence: number;
  decisionQuestion: DecisionQuestion | null;
}

export type JevPlannerPurpose = 'intent' | 'answer_options';

const MAX_DYNAMIC_INSTRUCTIONS_CHARS = 1_200;
const MAX_DYNAMIC_CRITERION_KEY_CHARS = 80;
const MAX_DYNAMIC_CRITERION_LABEL_CHARS = 180;
const DYNAMIC_QUESTION_UNSAFE_TEXT = /(?:callback_data|https?:\/\/|\\\\|(?:^|[\s_])(token|secret|password)(?:$|[\s_:：])|命令|路径|密钥|凭据)/iu;

function cleanDynamicText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxChars)
    .trim();
}

/**
 * Re-validate a Runtime-generated question before it reaches Jev.
 *
 * This is intentionally stricter than the shared JSON schema: pure-mode
 * planning is allowed to create useful labels, but never platform actions,
 * credentials, paths, URLs, or an unbounded free-form answer.
 */
export function normalizeJevDecisionQuestion(
  input: unknown,
  options: { purpose?: JevPlannerPurpose } = {},
): DecisionQuestion | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const type = raw.type === 'noul' || raw.type === 'choice' || raw.type === 'score' ? raw.type : null;
  const instructions = cleanDynamicText(raw.instructions, MAX_DYNAMIC_INSTRUCTIONS_CHARS);
  if (!type || !instructions || DYNAMIC_QUESTION_UNSAFE_TEXT.test(instructions)) return null;
  if (options.purpose === 'answer_options' && type !== 'choice') return null;
  const criteria = raw.criteria;
  if (type === 'choice' || type === 'noul') {
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) return null;
    const entries = Object.entries(criteria as Record<string, unknown>)
      .map(([key, value]) => [
        cleanDynamicText(key, MAX_DYNAMIC_CRITERION_KEY_CHARS),
        cleanDynamicText(value, MAX_DYNAMIC_CRITERION_LABEL_CHARS),
      ] as const)
      .filter(([key, value]) => key && value && !DYNAMIC_QUESTION_UNSAFE_TEXT.test(key) && !DYNAMIC_QUESTION_UNSAFE_TEXT.test(value));
    const unique = new Map<string, string>();
    const labels = new Set<string>();
    for (const [key, value] of entries) {
      if (!unique.has(key) && !labels.has(value)) {
        unique.set(key, value);
        labels.add(value);
      }
    }
    if (type === 'noul') {
      if (!unique.has('true') || !unique.has('false') || unique.size !== 2) return null;
    } else if (options.purpose === 'answer_options'
      ? unique.size < 3 || unique.size > 5
      : unique.size < 2 || unique.size > 8) {
      return null;
    }
    return {
      id: 'jev_dynamic',
      type,
      instructions,
      criteria: Object.fromEntries(unique),
    };
  }
  if (!Array.isArray(criteria)) return null;
  const levels = criteria
    .map((value) => cleanDynamicText(value, MAX_DYNAMIC_CRITERION_LABEL_CHARS))
    .filter((value) => value && !DYNAMIC_QUESTION_UNSAFE_TEXT.test(value));
  const uniqueLevels = Array.from(new Set(levels));
  if (uniqueLevels.length < 2 || uniqueLevels.length > 6) return null;
  return { id: 'jev_dynamic', type, instructions, criteria: uniqueLevels };
}

/** Candidate labels are stable machine keys; values are user-facing labels. */
export const JEV_INTENT_CRITERIA: Readonly<Record<string, string>> = Object.freeze({
  greeting: '问候或打招呼',
  agreement: '赞同、确认或表示认可',
  disagreement: '反对、否定或表示不认可',
  question: '提问、求解释或表达疑惑',
  request: '请求帮助、执行动作或继续处理',
  feedback: '反馈体验、结果或问题',
  supplement: '补充信息、条件或上下文',
  thanks: '感谢、致谢或礼貌回应',
  casual: '闲聊、玩笑或轻量回应',
  unclear: '信息不足，暂时无法确定更具体意图',
});

const MAX_TEXT_CHARS = 16_000;
const MAX_CONTEXT_CHARS = 2_000;

function cleanText(value: unknown, maxChars = MAX_TEXT_CHARS): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxChars)
    .trim();
}

function requestedType(value: unknown): DecisionQuestionType | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'noul' || normalized === 'choice' || normalized === 'score'
    ? normalized
    : undefined;
}

function isGreeting(text: string): boolean {
  return /^(?:你好|您好|嗨|哈喽|哈啰|hello|hi|hey|早上好|早安|晚上好|晚安|在吗|有人吗|辛苦了|收到|好的|好嘞|ok|okay|哈哈|呵呵)[！!。,.，？?~～\s]*$/iu.test(text);
}

function isThanks(text: string): boolean {
  return /(?:谢谢|感谢|多谢|辛苦了|麻烦你了|谢啦|感恩)/iu.test(text)
    && !/(?:为什么|怎么|如何|吗[？?]?$)/iu.test(text);
}

function isYesNoQuestion(text: string): boolean {
  return /(?:是否|是不是|能否|可否|能不能|可不可以|应该不应该|会不会|有没有|需不需要|对不对|行不行|可以吗|好吗|吗[？?]?$)/iu.test(text);
}

function isScoreQuestion(text: string): boolean {
  return /(?:评分|打分|几分|分数|等级|程度|强度|满意度|评价一下|评估一下|0\s*[-~至到]\s*10|1\s*[-~至到]\s*5)/iu.test(text);
}

function isChoiceQuestion(text: string): boolean {
  return /(?:选择|选哪个|选哪一个|哪一个|哪种|哪类|属于哪|分类|归类|更适合|哪个好|还是)/iu.test(text);
}

function isQuestion(text: string): boolean {
  return /[？?]$/u.test(text)
    || /^(?:请问|想问|我想知道|能告诉我|为什么|怎么|如何|什么|哪个|哪种|谁|哪里|何时|多少)/iu.test(text)
    || /(?:能解释|如何理解|什么意思|怎么回事|什么原因)/iu.test(text);
}

function isRequest(text: string): boolean {
  return /(?:请|帮我|麻烦|能帮|可以帮|需要你|请你|给我|发我|告诉我|查一下|看一下|做一下|继续|处理|安排|准备)/iu.test(text)
    && !isThanks(text);
}

function isNegativeFeedback(text: string): boolean {
  return /(?:不行|不对|错误|失败|有问题|不满意|太慢|糟糕|奇怪|不准确|不太对|不喜欢|崩了|坏了|报错)/iu.test(text);
}

function isPositiveFeedback(text: string): boolean {
  return /(?:不错|很好|挺好|太快|厉害|赞|满意|完美|接入成功|搞定|对了|正确|靠谱)/iu.test(text);
}

function isSupplement(text: string): boolean {
  return /(?:补充|另外|还有|以及|顺便|其实|对了|条件是|前提是|具体是|再加上)/iu.test(text);
}

function classifyIntent(text: string): { kind: JevIntentKind; confidence: number } {
  if (!text) return { kind: 'unknown', confidence: 1 };
  if (isGreeting(text)) return { kind: 'greeting', confidence: 0.98 };
  if (isThanks(text)) return { kind: 'thanks', confidence: 0.96 };
  if (isScoreQuestion(text)) return { kind: 'score', confidence: 0.97 };
  if (isChoiceQuestion(text)) return { kind: 'choice', confidence: 0.94 };
  if (isYesNoQuestion(text) || isQuestion(text)) return { kind: 'question', confidence: 0.9 };
  if (isRequest(text)) return { kind: 'request', confidence: 0.88 };
  if (isNegativeFeedback(text) || isPositiveFeedback(text)) return { kind: 'feedback', confidence: 0.82 };
  if (isSupplement(text)) return { kind: 'statement', confidence: 0.72 };
  if (text.length < 2 || /^[\p{P}\p{S}\d]+$/u.test(text)) return { kind: 'unknown', confidence: 0.6 };
  return { kind: 'statement', confidence: 0.62 };
}

function questionId(type: DecisionQuestionType): string {
  return type === 'noul' ? 'jev_intent_judgement' : type === 'score' ? 'jev_intent_score' : 'jev_intent';
}

function buildChoiceQuestion(text: string, context: JevIntentContext = {}): DecisionQuestion {
  const reply = cleanText(context.replyText, MAX_CONTEXT_CHARS);
  const recent = cleanText(context.recentText, MAX_CONTEXT_CHARS);
  const state = reply || recent;
  const contextHint = state ? `。结合相关上下文：${state}` : '';
  return {
    id: questionId('choice'),
    type: 'choice',
    instructions: `识别这条消息在当前对话中的主要意图：${text}${contextHint}`.slice(0, MAX_TEXT_CHARS),
    criteria: { ...JEV_INTENT_CRITERIA },
  };
}

/** Build a bounded DecisionQuestion. Empty input intentionally returns null. */
export function buildJevDecisionQuestion(
  text: string,
  analysis?: Pick<JevIntentAnalysis, 'kind'> | null,
  context: JevIntentContext = {},
): DecisionQuestion | null {
  const normalized = cleanText(text);
  if (!normalized) return null;
  const explicit = requestedType(context.requestedType);
  const kind = analysis?.kind || classifyIntent(normalized).kind;
  if (explicit === 'score' || kind === 'score') {
    return {
      id: questionId('score'),
      type: 'score',
      instructions: `评估这条消息表达的程度或满意度：${normalized}`.slice(0, MAX_TEXT_CHARS),
      criteria: ['极低', '低', '中', '高', '极高'],
    };
  }
  if (explicit === 'noul' || (kind === 'question' && isYesNoQuestion(normalized))) {
    return {
      id: questionId('noul'),
      type: 'noul',
      instructions: `判断这条消息所涉及的命题是否成立或可接受：${normalized}`.slice(0, MAX_TEXT_CHARS),
      criteria: { true: '是', false: '否' },
    };
  }
  return buildChoiceQuestion(normalized, context);
}

/** One pass used by pure mode and the one-turn debug auto-intent path. */
export function analyzeJevIntent(text: string, context: JevIntentContext = {}): JevIntentAnalysis {
  const normalized = cleanText(text);
  const classified = classifyIntent(normalized);
  const decisionQuestion = buildJevDecisionQuestion(normalized, classified, context);
  return {
    kind: classified.kind,
    text: normalized,
    confidence: classified.confidence,
    decisionQuestion,
  };
}

/** Convenience helper for callers that only need the organized question. */
export function inferJevIntentQuestion(text: string, context: JevIntentContext = {}): DecisionQuestion | null {
  return analyzeJevIntent(text, context).decisionQuestion;
}

/** Exported for tests and lightweight route gates without exposing regex details. */
export function isJevGreeting(text: string): boolean {
  return isGreeting(cleanText(text));
}

export function jevIntentKindLabel(kind: JevIntentKind): string {
  const labels: Record<JevIntentKind, string> = {
    greeting: '问候或打招呼',
    question: '提问或求解释',
    request: '请求帮助或处理',
    feedback: '反馈体验或结果',
    thanks: '感谢或礼貌回应',
    choice: '选择或分类问题',
    score: '评分或程度问题',
    statement: '陈述或补充信息',
    unknown: '暂时无法确定',
  };
  return labels[kind];
}
