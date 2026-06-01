import type {
  MemoryQueryPlan,
  MemoryReplyDecision,
  RetrievedMemoryContext,
  RetrievedMemoryHit,
} from 'claude-to-im/src/lib/bridge/host.js';

const EXPLICIT_RECALL_PATTERNS = [
  /你还记得/u,
  /还记得/u,
  /帮我(找|查|回忆|回捞)/u,
  /(找|查)(一下)?(上次|之前|以前|历史|记忆)/u,
  /上次(记录|说的|提到的|那份|那个)/u,
  /之前(记录|说过|提到|让我记|让你记)/u,
  /我之前记的/u,
  /我记过的/u,
  /再发我一次/u,
  /固定对应表/u,
  /记忆/u,
  /历史/u,
  /\bremember\b/i,
  /\brecall\b/i,
  /\bhistory\b/i,
  /\bprevious\b/i,
];

const MEMORY_WRITE_PATTERNS = [
  /(?:^|[\s，。；;,.!?！？])(?:请你|你也|也|帮我|麻烦你)?(?:记住|记一下|记下来|保存记忆|记录一下)(?:$|[\s，。；;,.!?！？])/u,
  /\bremember this\b/i,
];

const QUESTION_SUFFIX_RE = /(是什么|是啥|多少|哪个|哪一个|叫什么|叫啥|怎么写|发我|给我|列一下|列表|对应表|吗|？|\?)$/u;
const TASK_ACTION_RE = /(帮我|麻烦|请|处理|执行|运行|启动|停止|重启|发布|同步|安装|升级|修|修复|改|修改|替换|检查|排查|诊断|看一下|看一眼|分析|生成|创建|写|删除|添加|上传|下载|截图|导入|导出|unity|mcp|bridge|飞书|代码|仓库|git)/i;
const LOW_VALUE_MEMORY_RE = /(没有可用.{0,36}(记忆|功能)|请手动记录|未完成：这个请求需要实际|已拦截通用手动排查步骤|无法访问聊天记录|没有拿到可用工具输出|不能把任务退回给用户)/i;
const STRUCTURED_MAPPING_RE = /`?([A-Za-z0-9][A-Za-z0-9_./ -]{1,120}|[\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9_./ -]{1,80})`?(?:\s*(?:==|=>|->)\s*|\s+=\s+)`?([^`\n，,。；;|]{2,160})`?/gu;
const STRUCTURED_COLON_LINE_RE = /^\s*(?:[-*]\s*)?`?([A-Za-z0-9][A-Za-z0-9_./ -]{1,120}|[\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9_./ -]{1,80})`?\s*[：:]\s*`?([^`\n，,。；;|]{2,160})`?\s*$/u;

interface StructuredMemoryPair {
  key: string;
  value: string;
}

function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
}

function stripMentionNoise(text: string): string {
  return normalizeText(text)
    .replace(/<at\b[^>]*>.*?<\/at>/giu, ' ')
    .replace(/<at\b[^/>]*\/>/giu, ' ')
    .replace(/(?:\s*@(?:_[A-Za-z0-9_-]+|[\u4e00-\u9fffA-Za-z0-9_-]{1,24}))+$/u, '')
    .trim();
}

function stripRecallPrefix(text: string): string {
  return stripMentionNoise(text)
    .replace(/^(帮我|麻烦|请你|请|你)?\s*(找一下|查一下|回忆一下|回捞一下|找|查|回忆|回捞)\s*/u, '')
    .replace(/^(你还记得|还记得|记忆|历史|上次|之前|以前|我之前记的|我记过的)\s*/u, '')
    .replace(/^(的|那个|那份)\s*/u, '')
    .replace(/(是什么|是啥|是多少|是哪一个|是哪个|叫什么|叫啥|怎么写|吗|呢|？|\?)$/u, '')
    .trim();
}

function looksLikeNamedMemoryKey(text: string): boolean {
  const normalized = stripMentionNoise(text);
  if (!normalized || normalized.length > 40) return false;
  if (TASK_ACTION_RE.test(normalized)) return false;
  if (/^(什么|怎么|如何|为什么|哪里|哪个)/u.test(normalized)) return false;
  return /[\u4e00-\u9fffA-Za-z0-9]/u.test(normalized)
    && /(名称|名字|命令|路径|地址|链接|账号|配置|版本|对应表|清单|列表|偏好|约定|规则)$/u.test(normalized);
}

function looksLikeKnowledgeLookupQuestion(text: string): boolean {
  const normalized = stripMentionNoise(text);
  if (!normalized || normalized.length > 60) return false;
  if (TASK_ACTION_RE.test(normalized)) return false;
  if (!QUESTION_SUFFIX_RE.test(normalized)) return false;
  if (/^(什么|怎么|如何|为什么|哪里|哪个|哪一个)/u.test(normalized)) return false;
  const key = stripRecallPrefix(normalized);
  if (!key || key.length > 40) return false;
  if (/(名称|名字|命令|路径|地址|链接|账号|配置|版本|对应表|清单|列表)$/u.test(key)
    && /(是什么|是啥|吗|？|\?)$/u.test(normalized)) {
    return false;
  }
  return /[\u4e00-\u9fffA-Za-z0-9]/u.test(key);
}

function isExplicitRecall(text: string): boolean {
  const normalized = stripMentionNoise(text);
  if (!normalized) return false;
  if (EXPLICIT_RECALL_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  if (looksLikeNamedMemoryKey(normalized)) return true;
  if (looksLikeKnowledgeLookupQuestion(normalized)) return true;
  if (QUESTION_SUFFIX_RE.test(normalized) && /(上次|之前|以前|历史|记忆|记过|记的)/u.test(normalized)) return true;
  return false;
}

function extractNormalizedKey(text: string, explicitRecall: boolean): string | undefined {
  const normalized = stripMentionNoise(text);
  if (!normalized) return undefined;
  if (!explicitRecall && !looksLikeNamedMemoryKey(normalized)) return undefined;
  const stripped = stripRecallPrefix(normalized)
    .replace(/^(的|那个|那份)\s*/u, '')
    .trim();
  if (!stripped || stripped.length > 60) return undefined;
  return stripped;
}

export function planMemoryQuery(prompt: string): MemoryQueryPlan {
  const queryText = normalizeText(prompt);
  if (!queryText) {
    return {
      intent: 'none',
      queryText,
      answerMode: 'none',
      minConfidence: 1,
      allowDirectAnswer: false,
    };
  }

  if (MEMORY_WRITE_PATTERNS.some((pattern) => pattern.test(queryText))) {
    return {
      intent: 'memory_write',
      queryText,
      normalizedKey: extractNormalizedKey(queryText, true),
      answerMode: 'augment_only',
      minConfidence: 0.7,
      allowDirectAnswer: false,
    };
  }

  const explicitRecall = isExplicitRecall(queryText);
  if (explicitRecall) {
    return {
      intent: 'explicit_recall',
      queryText,
      normalizedKey: extractNormalizedKey(queryText, true),
      answerMode: 'direct_if_confident',
      minConfidence: 0.78,
      allowDirectAnswer: true,
    };
  }

  if (TASK_ACTION_RE.test(queryText)) {
    return {
      intent: 'context_augment',
      queryText,
      normalizedKey: extractNormalizedKey(queryText, false),
      answerMode: 'augment_only',
      minConfidence: 0.55,
      allowDirectAnswer: false,
    };
  }

  return {
    intent: 'none',
    queryText,
    answerMode: 'none',
    minConfidence: 1,
    allowDirectAnswer: false,
  };
}

export function shouldRetrieveMemoryForPrompt(prompt: string): boolean {
  const plan = planMemoryQuery(prompt);
  return plan.intent === 'explicit_recall' || plan.intent === 'memory_write' || plan.intent === 'context_augment';
}

export function shouldDirectAnswerFromMemory(_prompt: string): boolean {
  return false;
}

export function isLowValueMemoryText(text: string): boolean {
  return LOW_VALUE_MEMORY_RE.test(normalizeText(text));
}

function cleanStructuredPart(text: string): string {
  return text
    .replace(/^`|`$/g, '')
    .replace(/\s*(?:✅|✔|✓)+\s*$/u, '')
    .replace(/[。；;，,、]+$/u, '')
    .trim();
}

function isLikelyHeadingPair(key: string, value: string): boolean {
  return /(对应表|列表|清单|名称|名字)$/u.test(key)
    && /^[A-Za-z0-9_./-]{2,80}$/u.test(value)
    && !/(场景|命令|路径|地址|链接|配置|版本|规则|约定|医院|外城|timeline|pve)/iu.test(value);
}

function addStructuredPair(
  pairs: StructuredMemoryPair[],
  seen: Set<string>,
  key: string,
  value: string,
  options: { allowHeadingLike?: boolean } = {},
): void {
  const cleanedKey = cleanStructuredPart(key);
  const cleanedValue = cleanStructuredPart(value);
  if (!cleanedKey || !cleanedValue || isLowValueMemoryText(cleanedValue)) return;
  if (!options.allowHeadingLike && isLikelyHeadingPair(cleanedKey, cleanedValue)) return;
  const dedupKey = `${cleanedKey.toLowerCase()}\n${cleanedValue.toLowerCase()}`;
  if (seen.has(dedupKey)) return;
  seen.add(dedupKey);
  pairs.push({ key: cleanedKey, value: cleanedValue });
}

export function inferStructuredMemories(content: string): StructuredMemoryPair[] {
  const normalized = content.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '');
  const pairs: StructuredMemoryPair[] = [];
  const seen = new Set<string>();

  for (const line of normalized.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    STRUCTURED_MAPPING_RE.lastIndex = 0;
    for (const match of trimmed.matchAll(STRUCTURED_MAPPING_RE)) {
      addStructuredPair(pairs, seen, match[1], match[2], { allowHeadingLike: true });
    }
    if (!/(?:==|=>|->|=)/u.test(trimmed)) {
      const colonMatch = trimmed.match(STRUCTURED_COLON_LINE_RE);
      if (colonMatch) addStructuredPair(pairs, seen, colonMatch[1], colonMatch[2]);
    }
  }

  if (pairs.length === 0) {
    STRUCTURED_MAPPING_RE.lastIndex = 0;
    for (const match of normalized.matchAll(STRUCTURED_MAPPING_RE)) {
      addStructuredPair(pairs, seen, match[1], match[2], { allowHeadingLike: true });
    }
  }

  return pairs;
}

export function inferStructuredMemory(content: string): { key: string; value: string } | null {
  return inferStructuredMemories(content)[0] || null;
}

function hitConfidence(hit: RetrievedMemoryHit): number {
  if (typeof hit.confidence === 'number') return hit.confidence;
  const scoreConfidence = Math.max(0, Math.min(0.95, hit.score / 16));
  if (hit.answerability === 'structured') return Math.max(scoreConfidence, 0.8);
  return scoreConfidence;
}

function normalizedMatchText(text: string | undefined): string {
  return normalizeText(text || '').toLowerCase();
}

function asciiTerms(text: string): string[] {
  return Array.from(new Set((text.match(/[a-z0-9][a-z0-9_-]{1,}/giu) || []).map((term) => term.toLowerCase())));
}

function cjkDescriptorTerms(text: string): string[] {
  const descriptors = ['场景', '关卡', '名称', '名字', '命令', '路径', '地址', '链接', '账号', '配置', '版本', '对应表', '清单', '列表', '预制体', '材质', '贴图', '节点'];
  return descriptors.filter((term) => text.includes(term));
}

function pairMatchesPlan(plan: MemoryQueryPlan, pair: StructuredMemoryPair): boolean {
  if (!plan.normalizedKey) return true;
  if (/^(user|assistant|system|human|用户|助手)$/iu.test(pair.key.trim())) return false;
  const key = normalizedMatchText(plan.normalizedKey);
  const pairKey = normalizedMatchText(pair.key);
  const pairValue = normalizedMatchText(pair.value);
  const pairText = `${pairKey} ${pairValue}`;
  if (!key || !pairText.trim()) return false;
  if (pairText.includes(key) || key.includes(pairKey) || key.includes(pairValue)) return true;

  const queryAsciiTerms = asciiTerms(key);
  const pairAsciiText = pairText.toLowerCase();
  if (queryAsciiTerms.length > 0 && queryAsciiTerms.some((term) => pairAsciiText.includes(term))) {
    const queryDescriptors = cjkDescriptorTerms(key);
    if (queryDescriptors.length === 0) return true;
    return queryDescriptors.some((term) => pairText.includes(term));
  }

  const queryDescriptors = cjkDescriptorTerms(key).filter((term) => term !== '名称' && term !== '名字');
  return queryDescriptors.length > 0
    && queryDescriptors.every((term) => pairText.includes(term))
    && key.length <= pairText.length + 8;
}

function structuredPairsForHit(hit: RetrievedMemoryHit): StructuredMemoryPair[] {
  return hit.structuredPairs && hit.structuredPairs.length > 0
    ? hit.structuredPairs
    : inferStructuredMemories(hit.content);
}

function findStructuredPairMatch(plan: MemoryQueryPlan, hit: RetrievedMemoryHit): StructuredMemoryPair | null {
  return structuredPairsForHit(hit).find((pair) => pairMatchesPlan(plan, pair)) || null;
}

function keyMatchesPlan(plan: MemoryQueryPlan, hit: RetrievedMemoryHit): boolean {
  if (!plan.normalizedKey) return true;
  const key = plan.normalizedKey.toLowerCase();
  const haystack = `${hit.structuredKey || ''} ${hit.content || ''}`.toLowerCase();
  return haystack.includes(key) || key.includes((hit.structuredKey || '').toLowerCase()) || !!findStructuredPairMatch(plan, hit);
}

function structuredKeyMatchesPlan(plan: MemoryQueryPlan, hit: RetrievedMemoryHit): boolean {
  if (!plan.normalizedKey) return true;
  const key = plan.normalizedKey.toLowerCase();
  const keys = [
    hit.structuredKey,
    ...(hit.structuredPairs || []).map((pair) => pair.key),
  ]
    .filter((value): value is string => !!value?.trim())
    .map((value) => value.toLowerCase());
  if (keys.length === 0) return false;
  return keys.some((candidate) => candidate.includes(key) || key.includes(candidate));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function structuredTableTitleMatchesPlan(plan: MemoryQueryPlan, hit: RetrievedMemoryHit): boolean {
  if (!plan.normalizedKey) return true;
  const pairs = hit.structuredPairs && hit.structuredPairs.length > 1
    ? hit.structuredPairs
    : inferStructuredMemories(hit.content);
  if (pairs.length <= 1) return false;
  const heading = hit.content.split(/\r?\n/).slice(0, 3).join(' ');
  const keyPattern = escapeRegExp(plan.normalizedKey);
  return new RegExp(`${keyPattern}\\s*(?:对应表|列表|清单|[:：])`, 'iu').test(heading);
}

function directReplyText(plan: MemoryQueryPlan, hit: RetrievedMemoryHit): string {
  const pairs = hit.structuredPairs && hit.structuredPairs.length > 0
    ? hit.structuredPairs
    : inferStructuredMemories(hit.content);
  if (pairs.length > 1) {
    const title = plan.normalizedKey || hit.structuredKey || '记忆';
    return [
      `${title}对应表：`,
      '',
      ...pairs.slice(0, 20).map((pair) => `\`${pair.key}\` == ${pair.value}`),
    ].join('\n');
  }
  const key = hit.structuredKey || plan.normalizedKey;
  if (hit.structuredValue && key) return `${key}：${hit.structuredValue}`;
  return hit.content.trim();
}

export function buildMemoryRecallSystemPrompt(memory: RetrievedMemoryContext | null): string {
  const memoryText = memory?.summary?.trim() || 'No relevant memory snippets were found.';
  return [
    'Memory recall request policy:',
    'The user is asking to recall prior memory or chat history.',
    'Answer only from the retrieved memory snippets below. Do not run tools, inspect files, search the repository, or invent missing facts.',
    'If the snippets are insufficient, say that no matching memory was found.',
    '',
    memoryText,
  ].join('\n');
}

export function decideMemoryReply(
  plan: MemoryQueryPlan,
  memory: RetrievedMemoryContext | null,
): MemoryReplyDecision {
  if (plan.intent !== 'explicit_recall') {
    return { type: 'augment_codex', memory, plan };
  }

  const hits = (memory?.hits || [])
    .filter((hit) => hit.content?.trim())
    .filter((hit) => hit.quality !== 'low')
    .filter((hit) => !isLowValueMemoryText(hit.content))
    .filter((hit) => keyMatchesPlan(plan, hit))
    .sort((left, right) => {
      const leftStructured = left.answerability === 'structured' ? 1 : 0;
      const rightStructured = right.answerability === 'structured' ? 1 : 0;
      return rightStructured - leftStructured || hitConfidence(right) - hitConfidence(left) || right.score - left.score;
    });

  const directHit = hits.find((hit) => {
    const confidence = hitConfidence(hit);
    return plan.allowDirectAnswer
      && confidence >= plan.minConfidence
      && hit.answerability === 'structured'
      && hit.quality === 'high'
      && (structuredKeyMatchesPlan(plan, hit) || structuredTableTitleMatchesPlan(plan, hit) || !!findStructuredPairMatch(plan, hit))
      && !!(hit.structuredValue || inferStructuredMemory(hit.content)?.value);
  });

  if (directHit) {
    const exactKeyMatch = structuredKeyMatchesPlan(plan, directHit);
    const tableTitleMatch = structuredTableTitleMatchesPlan(plan, directHit);
    const matchingPair = !exactKeyMatch && !tableTitleMatch ? findStructuredPairMatch(plan, directHit) : null;
    if (matchingPair) {
      return {
        type: 'direct_reply',
        text: directReplyText(plan, {
          ...directHit,
          structuredKey: matchingPair.key,
          structuredValue: matchingPair.value,
          structuredPairs: [matchingPair],
        }),
        hit: directHit,
        plan,
      };
    }
    const inferred = directHit.structuredValue ? null : inferStructuredMemory(directHit.content);
    const hit = inferred
      ? { ...directHit, structuredKey: directHit.structuredKey || inferred.key, structuredValue: inferred.value }
      : directHit;
    return {
      type: 'direct_reply',
      text: directReplyText(plan, hit),
      hit,
      plan,
    };
  }

  if (hits.length > 0) {
    return {
      type: 'augment_codex',
      systemPrompt: buildMemoryRecallSystemPrompt(memory),
      memory,
      plan,
    };
  }

  return {
    type: 'no_memory_answer',
    text: plan.normalizedKey
      ? `没找到「${plan.normalizedKey}」相关记忆。`
      : '没找到相关记忆。',
    plan,
  };
}
