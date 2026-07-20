export interface FeishuHistoryIntent {
  originalPrompt: string;
  taskPrompt: string;
  limit: number;
  startTimeMs?: number;
  endTimeMs?: number;
  scopeText: string;
  responseMode: 'chat' | 'doc';
  docTitle?: string;
  purpose?: 'summary' | 'reference';
  targetSpeakerNames?: string[];
}

/** 从引用式历史请求中提取说话人提示，最终匹配仍由受控历史索引完成。 */
export function extractHistoryTargetSpeakerNames(text: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /(?:根据|按|参考|结合)([^，。；：\s]{1,12}?)(?:的)?(?:聊天记录|群聊记录|消息|对话)/g,
    /(?:参考|按)([^，。；：\s]{1,12}?)(?:说的|提到的|聊过的)/g,
    /@([^\s，。；：]{1,24})/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const cleaned = (match[1] || '').trim()
        .replace(/^(群里|本群|这个群|群聊|聊天)/, '')
        .replace(/(聊天记录|群聊记录|消息|对话|说的|提到的)$/g, '')
        .trim();
      if (cleaned.length >= 2 && cleaned.length <= 12) names.add(cleaned);
    }
  }
  return [...names];
}

export function parseFeishuHistoryIntent(text: string, now: Date = new Date()): FeishuHistoryIntent | null {
  const normalized = text.replace(/\s+/g, '');
  const mentionsUpwardHistory = /((上面|上方|前面|上文|前文|上一条|前一条|上条|前条|上几条|前几条).{0,16}(消息|卡片|回复|内容|记录|题目|thread|线程|那条|这条|这一条)|((消息|卡片|回复|内容|记录|题目|thread|线程).{0,16}(上面|上方|前面|上文|前文|上一条|前一条|上条|前条|上几条|前几条)))/u.test(normalized);
  const wantsUpwardHistory = mentionsUpwardHistory
    && /(看|查|读|翻|找|回看|漏查|对照|分析|总结|汇总|整理|解释|回答|回复|问|题目)/u.test(normalized);
  const wantsSummary = /(总结|汇总|整理|梳理|概括|归纳|回顾|提炼|提取|看一下|看看|看下|在说什么|说什么|在聊什么|聊什么|什么内容)/u.test(normalized)
    || wantsUpwardHistory;
  const mentionsHistory = /(群聊|群里|群内|本群|这个群|聊天|对话|消息|记录|讨论|内容)/u.test(normalized)
    || mentionsUpwardHistory;
  const mentionsTime = /(最近\d{1,3}条|最近|今天|今日|昨天|昨日|前天|上午|下午|晚上|完整|全部)/u.test(normalized)
    || mentionsUpwardHistory;
  // 只有明确要求把历史结果写成文档时才切换输出面，普通文档问题不能抢进历史链。
  const wantsDoc = /((生成|整理成|输出到|写入|创建).{0,16}(飞书)?文档|(飞书)?文档.{0,16}(链接|发链接|回链接)|发链接|回链接)/u.test(normalized)
    && (wantsSummary || mentionsHistory || mentionsTime);
  const actionVerbMatched = /(标注|重标|改标|判断|修改|纠正|核对|校对|命名|对照)/u.test(normalized);
  const targetSpeakerNames = extractHistoryTargetSpeakerNames(text);
  const wantsReferenceAction = (
    /(根据|按|参考|结合).*(聊天记录|群聊记录|消息|对话)/u.test(normalized)
    || (/(根据|按|参考|结合).*(说的|提到的|聊过的)/u.test(normalized) && targetSpeakerNames.length > 0)
  ) && actionVerbMatched;

  if ((!wantsSummary && !wantsDoc && !wantsReferenceAction)
    || (!mentionsHistory && !mentionsTime && !wantsDoc && !wantsReferenceAction)) return null;

  const countMatch = text.match(/(\d{1,3})\s*(条|则|段|个)?/u);
  const requestedCount = countMatch ? Number.parseInt(countMatch[1], 10) : undefined;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfDayBeforeYesterday = new Date(startOfToday);
  startOfDayBeforeYesterday.setDate(startOfDayBeforeYesterday.getDate() - 2);

  let startTimeMs: number | undefined;
  let endTimeMs: number | undefined;
  let scopeText = '本群最近消息';
  if (/(昨天|昨日)/u.test(normalized)) {
    startTimeMs = startOfYesterday.getTime();
    endTimeMs = startOfToday.getTime();
    scopeText = '本群昨天的聊天记录';
  } else if (/前天/u.test(normalized)) {
    startTimeMs = startOfDayBeforeYesterday.getTime();
    endTimeMs = startOfYesterday.getTime();
    scopeText = '本群前天的聊天记录';
  } else if (/(今天|今日)/u.test(normalized)) {
    startTimeMs = startOfToday.getTime();
    endTimeMs = startOfTomorrow.getTime();
    scopeText = '本群今天的聊天记录';
  } else if (mentionsUpwardHistory) {
    scopeText = '本群上方消息';
  }

  if (startTimeMs !== undefined && /(上午|早上|清晨)/u.test(normalized)) {
    const end = new Date(startTimeMs);
    end.setHours(12, 0, 0, 0);
    endTimeMs = end.getTime();
    scopeText = scopeText.replace('聊天记录', '上午聊天记录');
  } else if (startTimeMs !== undefined && /下午/u.test(normalized)) {
    const start = new Date(startTimeMs);
    start.setHours(12, 0, 0, 0);
    startTimeMs = start.getTime();
    const end = new Date(start);
    end.setHours(18, 0, 0, 0);
    endTimeMs = end.getTime();
    scopeText = scopeText.replace('聊天记录', '下午聊天记录');
  } else if (startTimeMs !== undefined && /(晚上|晚间)/u.test(normalized)) {
    const start = new Date(startTimeMs);
    start.setHours(18, 0, 0, 0);
    startTimeMs = start.getTime();
    scopeText = scopeText.replace('聊天记录', '晚间聊天记录');
  }

  const wantsFull = /(完整|全部|所有)/u.test(normalized);
  const defaultLimit = wantsReferenceAction ? 50 : (startTimeMs !== undefined ? 100 : 30);
  const limit = Math.max(5, Math.min(requestedCount ?? (wantsFull ? 100 : defaultLimit), 100));
  return {
    originalPrompt: text,
    taskPrompt: text,
    limit,
    startTimeMs,
    endTimeMs,
    scopeText,
    responseMode: wantsDoc ? 'doc' : 'chat',
    docTitle: undefined,
    purpose: wantsReferenceAction ? 'reference' : 'summary',
    targetSpeakerNames,
  };
}
