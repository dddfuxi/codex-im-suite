import type { OutboundMention } from '../types.js';
import { isNonAddressableMentionTarget } from '../agent-architecture.js';
import { hasSchedulingTimeHint, hasTaskSchedulingIntent } from './reminders.js';

export interface FeishuMentionIntentOptions {
  invocationAliases?: string[];
}

const FEISHU_MENTION_ID_FIELDS = [
  'userId',
  'user_id',
  'openId',
  'open_id',
  'unionId',
  'union_id',
] as const;
const FEISHU_MENTION_ACTION_RE = /(?:艾特|@|＠|\bat\b|mention|提到|点名|通知|叫|喊)/iu;
const FEISHU_OTHER_PERSON_TARGET_RE = /(?:另一个人|另个人|别人|其他人|其他成员|群里的人|某个人|随便一个人|一个(?:成员|群成员|机器人|参与者|玩家|用户|人)|一位(?:成员|群成员|机器人|参与者|玩家|用户|人)|某个(?:成员|群成员|机器人|参与者|玩家|用户|人))/iu;
const FEISHU_BARE_AT_TARGET_RE = /(?:^|[\s([{（【,，.。!！?？~～:：;；])@([^\s@,，.。!！?？~～:：;；<>\])）】]{1,64})(?=$|[\s,，.。!！?？~～:：;；<>\])）】])/gu;
const FEISHU_BARE_AT_BOUNDARY_CLASS = '[\\s([{（【,，.。!！?？~～:：;；]';
const FEISHU_BARE_AT_END_BOUNDARY_CLASS = '[\\s,，.。!！?？~～:：;；<>\\])）】]';
const FEISHU_EXPLICIT_MENTION_TARGET_TOKEN = '[@＠]?[\\p{L}\\p{N}_.$·-]{1,64}?';
const FEISHU_EXPLICIT_MENTION_TARGET_STOP = '(?=$|[\\s,，.。!！?？~～:：;；、<>\\])）】]|一下|下|一声|看看|看一下|回复|回答|处理|吗|呢|吧|啊|呀|哈|哦|噢)';
const FEISHU_EXPLICIT_MENTION_TARGET_FOLLOWUP_RE = /(?:让|叫|喊|通知|请|麻烦|要)(?:他|她|它|ta|TA|对方|其|那个人|这个人|该成员)|(?:跟|和)(?:你|我|他|她|它|ta|TA|对方)|(?:去|来|帮|帮忙|帮我)(?:看|看看|处理|回复|聊|聊天|说|问|确认|查|检查|修|改|做|发|转发)/iu;
const FEISHU_EXPLICIT_MENTION_AFTER_VERB_RE = new RegExp(
  `(?:艾特|\\bat\\b|mention|提到|点名|通知|叫|喊)\\s*(?:一下|下|一声|一下子|给|把|请|麻烦)?\\s*(${FEISHU_EXPLICIT_MENTION_TARGET_TOKEN})${FEISHU_EXPLICIT_MENTION_TARGET_STOP}`,
  'giu',
);
const FEISHU_EXPLICIT_MENTION_BEFORE_VERB_RE = new RegExp(
  `(?:把|给)\\s*(${FEISHU_EXPLICIT_MENTION_TARGET_TOKEN})\\s*(?:艾特|\\bat\\b|mention|提到|点名|通知|叫|喊)(?:一下|下|一声)?`,
  'giu',
);
const FEISHU_THIRD_PARTY_SPEAK_TARGET_RE = new RegExp(
  `(?:让|叫|喊|请|找|通知|麻烦)\\s*(${FEISHU_EXPLICIT_MENTION_TARGET_TOKEN})\\s*(?:出来\\s*)?(?:说话|发言|回复|回应|回(?:复)?一下|吱一声|看(?:一)?下|处理(?:一)?下)`,
  'giu',
);
const FEISHU_LEADING_THIRD_PARTY_SPEAK_TARGET_RE = new RegExp(
  `^(?:让|叫|喊|请|找|通知|麻烦)\\s*(${FEISHU_EXPLICIT_MENTION_TARGET_TOKEN})\\s*(?:出来\\s*)?(?:说话|发言|回复|回应|回(?:复)?一下|吱一声|看(?:一)?下|处理(?:一)?下)`,
  'iu',
);
const FEISHU_PLACEHOLDER_MENTION_TEXT_RE = /(^|[^\p{L}\p{N}_])@?_user_\d+(?=$|[^\p{L}\p{N}_])/giu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 只归一化字段拼写；是否可信仍必须与当前回合原生 evidence 求交集。 */
export function readFeishuMentionIds(raw: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const field of FEISHU_MENTION_ID_FIELDS) {
    const value = raw[field];
    if (typeof value === 'string' && value.trim()) ids.add(value.trim());
  }
  return [...ids];
}

export function readFeishuMentionId(raw: Record<string, unknown>): string {
  return readFeishuMentionIds(raw)[0] || '';
}

export function normalizeFeishuMentionTargetKey(target: string): string {
  return (target || '').normalize('NFKC').replace(/^[@＠]+/u, '').replace(/\s+/g, '').trim().toLocaleLowerCase();
}

export function isFeishuPlaceholderMentionTarget(target: string): boolean {
  return /^_user_\d+$/iu.test(normalizeFeishuMentionTargetKey(target));
}

export function parseEnvelopeMentions(rawMentions: unknown): OutboundMention[] | undefined {
  if (!Array.isArray(rawMentions)) return undefined;
  const mentions: OutboundMention[] = [];
  for (const item of rawMentions) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const userId = readFeishuMentionId(raw);
    const name = typeof raw.name === 'string'
      ? raw.name.trim()
      : typeof raw.user_name === 'string'
        ? raw.user_name.trim()
        : '';
    const atAll = raw.atAll === true || raw.at_all === true;
    if (!atAll && (isFeishuPlaceholderMentionTarget(userId) || isFeishuPlaceholderMentionTarget(name))) continue;
    if (!atAll && !userId) continue;
    mentions.push({
      ...(userId ? { userId } : {}),
      ...(name ? { name } : {}),
      ...(atAll ? { atAll: true } : {}),
    });
  }
  return mentions.length > 0 ? mentions : undefined;
}

export function hasStructuredMentions(mentions: OutboundMention[] | undefined): boolean {
  return Array.isArray(mentions) && mentions.some((mention) => mention?.atAll || !!mention?.userId?.trim());
}

function getFeishuMentionInvocationAliases(options: FeishuMentionIntentOptions = {}): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const alias of options.invocationAliases || []) {
    const normalized = (alias || '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const key = normalizeFeishuMentionTargetKey(normalized);
    if (!normalized || !key || seen.has(key)) continue;
    seen.add(key);
    aliases.push(normalized);
  }
  return aliases.sort((a, b) => normalizeFeishuMentionTargetKey(b).length - normalizeFeishuMentionTargetKey(a).length);
}

function stripLeadingFeishuMentionInvocation(text: string, options: FeishuMentionIntentOptions = {}): string {
  const compact = (text || '').normalize('NFKC').replace(/\s+/g, '').trim();
  if (!compact) return compact;
  const lowerCompact = compact.toLocaleLowerCase();
  for (const alias of getFeishuMentionInvocationAliases(options)) {
    const aliasKey = normalizeFeishuMentionTargetKey(alias);
    if (!aliasKey || !lowerCompact.startsWith(aliasKey)) continue;
    const rest = compact.slice(aliasKey.length).replace(/^[,，、:：]+/u, '');
    if (/^(?:请|帮我|帮忙|麻烦|劳驾|直接|去|艾特|@|＠|\bat\b|mention|提到|点名|通知|叫|喊|让|找)/iu.test(rest)) return rest;
  }
  return compact;
}

function hasFeishuDirectInvocationPrefix(compact: string, options: FeishuMentionIntentOptions = {}): boolean {
  if (/^(?:请|帮我|帮忙|麻烦|劳驾|你|机器人|bot|直接|去)/iu.test(compact)) return true;
  return stripLeadingFeishuMentionInvocation(compact, options) !== compact;
}

function isFeishuMentionDeliveryDiagnosticText(userText: string): boolean {
  const compact = (userText || '').normalize('NFKC').replace(/\s+/g, '');
  if (!compact || !/(?:艾特|@|＠|\bat\b|mention|提到|点名)/iu.test(compact)) return false;
  const startsWithCurrentMentionCommand = /^(?:请|帮我|帮忙|麻烦|劳驾|你|机器人|bot|直接|去)?(?:艾特|@|＠|\bat\b|mention|提到|点名|叫|喊)/iu.test(compact);
  const hasPlatformDeliveryDiagnosticSignal = /(?:技术诊断|事件管线|事件订阅|事件回调|回调事件|长连接|webhook|入站|路由规则|消息投递|通知投递|投递失败|未投递|未送达|没送进来|未送进来|群内@|群里@|群聊@|@通知|艾特通知)/iu.test(compact);
  if (startsWithCurrentMentionCommand && !hasPlatformDeliveryDiagnosticSignal) return false;
  return /(?:没收到|收不到|没有收到|未收到|没看见|看不见|没触发|未触发|触发不了|没进来|未进来|没送进来|未送进来|未送达|没送达|未投递|投递失败).{0,32}(?:群内|群里|群聊|@|＠|艾特|at|mention|提到|点名|通知|事件|回调|入站|路由)/iu.test(compact)
    || /(?:群内|群里|群聊|@|＠|艾特|at|mention|提到|点名|通知|事件|回调|入站|路由).{0,32}(?:没收到|收不到|没有收到|未收到|没看见|看不见|没触发|未触发|触发不了|没进来|未进来|没送进来|未送进来|未送达|没送达|未投递|投递失败)/iu.test(compact)
    || /(?:事件管线|事件订阅|事件回调|回调事件|长连接|webhook|入站|路由规则|消息投递|通知投递).{0,32}(?:没有|未|没|缺少|未开|没开|未配置|没配置|没触发|未触发|没进来|未进来|没送进来|未送进来)/iu.test(compact)
    || /(?:没有|未|没|缺少|未开|没开|未配置|没配置|没触发|未触发|没进来|未进来|没送进来|未送进来).{0,32}(?:事件管线|事件订阅|事件回调|回调事件|长连接|webhook|入站|路由规则|消息投递|通知投递)/iu.test(compact)
    || /(?:技术诊断|诊断|原因|排查).{0,32}(?:群内|群里|群聊|@|＠|艾特|at|mention|提到|点名|通知|事件|回调|入站|投递)/iu.test(compact);
}

function isFeishuMentionHowToOrDiagnosticRequest(userText: string): boolean {
  const compact = (userText || '').normalize('NFKC').replace(/\s+/g, '');
  if (!compact) return false;
  return /(?:怎么|如何|怎样|咋|教(?:一教|一下)?|教程|方法|做到).{0,32}(?:艾特|@|＠|at|mention|提到|点名)/iu.test(compact)
    || /(?:艾特|@|＠|at|mention|提到|点名).{0,32}(?:怎么|如何|怎样|为什么|为啥|不行|不能|失败|没反应|不回复|教程|方法)/iu.test(compact)
    || /(?:不能|不行|失败|没反应|不回复).{0,24}(?:艾特|@|＠|at|mention|提到|点名)/iu.test(compact)
    || isFeishuMentionDeliveryDiagnosticText(compact);
}

function splitFeishuMentionIntentClauses(text: string): string[] {
  return (text || '').normalize('NFKC')
    .split(/[\r\n。！？!?；;]+/u)
    .flatMap((part) => part.split(/(?<=[，,、])\s*/u))
    .map((part) => part.replace(/^[，,、\s]+|[，,、\s]+$/gu, '').trim())
    .filter(Boolean);
}

function isFeishuNarrativeMentionClause(clause: string, options: FeishuMentionIntentOptions = {}): boolean {
  const compact = (clause || '').normalize('NFKC').replace(/\s+/g, '');
  if (!compact || !FEISHU_MENTION_ACTION_RE.test(compact)) return false;
  FEISHU_MENTION_ACTION_RE.lastIndex = 0;
  if (/^(?:当|等|等待|直到|如果|若|每当|轮到|之后|然后|接下来|随后|后面|这时|此时|按顺序|依次|轮流)/u.test(compact)) return true;
  if (/(?:我(?:会|将|再|来|要|准备)|我们(?:会|将|再|来|要)|[\p{L}\p{N}_]{1,12}(?:人|者|员|官|方|角色)|玩家|参与者|成员|用户|大家|所有人).{0,16}(?:艾特|@|＠|\bat\b|mention|提到|点名|通知|叫|喊)/iu.test(compact)
    && !hasFeishuDirectInvocationPrefix(compact, options)) return true;
  return /(?:规则|流程|步骤|玩法|说明|要求|必须|需要|等待|按顺序|依次|轮流|继续).{0,24}(?:艾特|@|＠|\bat\b|mention|提到|点名|通知|叫|喊)/iu.test(compact)
    && /(?:一个|一位|一名|某个|任意|随机|另一个|另一位|下一个|上一个|你们|他们|她们|大家|所有人|参与者|玩家|成员|机器人|用户)/iu.test(compact);
}

function isFeishuDirectMentionExecutionClause(clause: string, options: FeishuMentionIntentOptions = {}): boolean {
  const compact = (clause || '').normalize('NFKC').replace(/\s+/g, '');
  if (!compact) return false;
  const directCompact = stripLeadingFeishuMentionInvocation(compact, options);
  if (FEISHU_LEADING_THIRD_PARTY_SPEAK_TARGET_RE.test(directCompact) && !isFeishuNarrativeMentionClause(clause, options)) return true;
  if (/^(?:请|帮我|帮忙|麻烦|劳驾|你|机器人|bot)?(?:把|给)(?:他|她|它|ta|TA|对方|那个人|这个人)(?:艾特|@|＠|\bat\b|mention|提到|点名|通知|叫|喊)/iu.test(directCompact)) return true;
  if (!FEISHU_MENTION_ACTION_RE.test(compact)) return false;
  FEISHU_MENTION_ACTION_RE.lastIndex = 0;
  if (isFeishuNarrativeMentionClause(clause, options)) return false;
  return /^(?:请|帮我|帮忙|麻烦|劳驾|你|机器人|bot|直接|去)?(?:艾特|@|＠|\bat\b|mention|提到|点名|通知|叫|喊)/iu.test(directCompact)
    || FEISHU_LEADING_THIRD_PARTY_SPEAK_TARGET_RE.test(directCompact)
    || /^(?:请|帮我|帮忙|麻烦|劳驾|你|机器人|bot).{0,16}(?:另一个人|另个人|别人|其他人|其他成员|群里的人|某个人|随便一个人|一个(?:成员|群成员|机器人|参与者|玩家|用户|人)|一位(?:成员|群成员|机器人|参与者|玩家|用户|人)|某个(?:成员|群成员|机器人|参与者|玩家|用户|人))/iu.test(directCompact);
}

function isFeishuTaskSchedulingContext(userText: string): boolean {
  const normalized = (userText || '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  return Boolean(normalized) && hasTaskSchedulingIntent(normalized) && hasSchedulingTimeHint(normalized);
}

export function isFeishuMentionExecutionRequest(userText: string, options: FeishuMentionIntentOptions = {}): boolean {
  if (isFeishuTaskSchedulingContext(userText) || isFeishuMentionHowToOrDiagnosticRequest(userText)) return false;
  return splitFeishuMentionIntentClauses(userText).some((clause) => isFeishuDirectMentionExecutionClause(clause, options));
}

function isFeishuAmbiguousPronounTarget(target: string): boolean {
  return /^(?:我|你|他|她|它|ta|TA|对方|那个人|这个人)$/u.test(target.trim());
}

function isFeishuGenericMentionTarget(target: string): boolean {
  const cleaned = (target || '').normalize('NFKC').replace(/^[@＠]+/u, '').replace(/\s+/g, '').trim();
  if (!cleaned || isNonAddressableMentionTarget(cleaned)) return true;
  if (/^(?:我|你|您|他|她|它|ta|TA|对方|那个人|这个人|你们|我们|他们|她们|它们|大家|所有人|全体|某人|别人|其他人|其他成员|群里的人|群成员)$/u.test(cleaned)) return true;
  if (/^(?:一个|一位|一名|某个|某位|某名|任意|随机|另一个|另一位|另一名|下一个|上一个|那位|这位|对应的|胜出的|当前|相关).{0,24}$/u.test(cleaned)) return true;
  if (/^(?:我|你|您|他|她|它|ta|TA|自己|本(?:人|机|机器人)|这(?:个|位)?(?:机器人|智能体|agent|bot)?|该(?:机器人|智能体|agent|bot)?)(?:自己)?(?:的)?(?:主人|主子|开发者|作者|创建者|维护者|管理员|负责人|老板|owner|creator|developer|maintainer|admin|娘|妈妈|妈|爸爸|爸)$/iu.test(cleaned)) return true;
  return /^(?:人|成员|群成员|机器人|bot|智能体|应用|玩家|参与者|用户|主持人|发起人|组织者|出题人|出题官)$/iu.test(cleaned);
}

function cleanExplicitFeishuMentionTarget(target: string): string {
  let cleaned = target.normalize('NFKC').replace(/^[@＠]+/, '').replace(/[<>"'`]/g, '').trim()
    .replace(/^(?:一下|下|一声|一下子|给|把|请|麻烦|帮我|帮忙)+/u, '')
    .replace(/(?:一下|下|一声|看看|看一下|回复(?:一下)?|回答(?:一下)?|处理一下|吧|呀|呢|吗|啊|哈|哦|噢)$/u, '')
    .replace(/(?:这个|那个|该|对应的)?(?:机器人|智能体|agent|bot|应用)(?:人)?(?:的)?$/iu, '')
    .trim();
  if (/^(?:一|一下|下|一声|一下子)$/u.test(cleaned)) return '';
  const followup = FEISHU_EXPLICIT_MENTION_TARGET_FOLLOWUP_RE.exec(cleaned);
  if (followup) cleaned = cleaned.slice(0, followup.index).trim();
  if (!cleaned || FEISHU_OTHER_PERSON_TARGET_RE.test(cleaned) || isFeishuGenericMentionTarget(cleaned)) return '';
  if (/^(?:谁|他|她|它|ta|TA|对方|那个人|这个人|某人)$/u.test(cleaned)) return '';
  return cleaned;
}

export function extractBareFeishuAtTargets(text: string): string[] {
  const targets: string[] = [];
  FEISHU_BARE_AT_TARGET_RE.lastIndex = 0;
  for (const match of (text || '').matchAll(FEISHU_BARE_AT_TARGET_RE)) {
    const target = cleanExplicitFeishuMentionTarget(match[1] || '');
    if (target) targets.push(target);
  }
  return targets;
}

export function replaceBareFeishuAtTarget(text: string, target: string, replacementName: string): string {
  const safeTarget = escapeRegExp(target);
  const pattern = new RegExp(`(^|${FEISHU_BARE_AT_BOUNDARY_CLASS})@${safeTarget}(?=$|${FEISHU_BARE_AT_END_BOUNDARY_CLASS})`, 'giu');
  return text.replace(pattern, (_match, prefix: string) => `${prefix}@${replacementName}`);
}

export function stripBareFeishuAtTarget(text: string, target: string): string {
  const safeTarget = escapeRegExp(target);
  const pattern = new RegExp(`(^|${FEISHU_BARE_AT_BOUNDARY_CLASS})@${safeTarget}(?=$|${FEISHU_BARE_AT_END_BOUNDARY_CLASS})`, 'giu');
  return text.replace(pattern, (_match, prefix: string) => `${prefix}${target}`);
}

export function extractExplicitFeishuMentionTargetsFromRequest(
  userText: string,
  options: FeishuMentionIntentOptions = {},
): string[] {
  const normalized = (userText || '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!isFeishuMentionExecutionRequest(normalized, options)) return [];
  const targets = new Map<string, string>();
  const addTarget = (target: string) => {
    const cleaned = cleanExplicitFeishuMentionTarget(target);
    if (cleaned) targets.set(cleaned.replace(/\s+/g, '').toLocaleLowerCase(), cleaned);
  };
  for (const target of extractBareFeishuAtTargets(normalized)) addTarget(target);
  FEISHU_THIRD_PARTY_SPEAK_TARGET_RE.lastIndex = 0;
  for (const match of normalized.matchAll(FEISHU_THIRD_PARTY_SPEAK_TARGET_RE)) {
    const target = cleanExplicitFeishuMentionTarget(match[1] || '');
    if (target && !isFeishuAmbiguousPronounTarget(target)) addTarget(target);
  }
  FEISHU_EXPLICIT_MENTION_AFTER_VERB_RE.lastIndex = 0;
  for (const match of normalized.matchAll(FEISHU_EXPLICIT_MENTION_AFTER_VERB_RE)) addTarget(match[1] || '');
  FEISHU_EXPLICIT_MENTION_BEFORE_VERB_RE.lastIndex = 0;
  for (const match of normalized.matchAll(FEISHU_EXPLICIT_MENTION_BEFORE_VERB_RE)) addTarget(match[1] || '');
  return [...targets.values()];
}

export function stripFeishuPlaceholderMentionText(text: string): string {
  if (!text || !/@?_user_\d+/iu.test(text)) return text;
  return text.replace(FEISHU_PLACEHOLDER_MENTION_TEXT_RE, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+(\r?\n)/g, '$1')
    .replace(/[ \t]+([,，。！？!?;；:：])/gu, '$1')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

export function stripFeishuGenericBareMentionText(text: string): string {
  if (!text || !/[@＠]/u.test(text)) return text;
  FEISHU_BARE_AT_TARGET_RE.lastIndex = 0;
  return text.replace(FEISHU_BARE_AT_TARGET_RE, (match, target: string) => {
    const rawTarget = (target || '').trim();
    if (!rawTarget || isFeishuPlaceholderMentionTarget(rawTarget)) return match;
    return cleanExplicitFeishuMentionTarget(rawTarget) ? match : match.replace(/[@＠]/u, '');
  });
}

export function needsExplicitFeishuMentionTarget(userText: string, options: FeishuMentionIntentOptions = {}): boolean {
  return isFeishuMentionExecutionRequest(userText, options) && FEISHU_OTHER_PERSON_TARGET_RE.test(userText);
}
