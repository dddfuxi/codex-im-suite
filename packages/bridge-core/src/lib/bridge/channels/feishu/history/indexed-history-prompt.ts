import type { FeishuHistoryIntent } from '../../../application/history-intent.js';

export interface FeishuIndexedHistoryRetrieval {
  summary: string;
  items: Array<{ messageId: string }>;
  syncStatus?: {
    lastSyncAt?: string;
    messageCount?: number;
  };
}

export interface BuildFeishuIndexedHistoryPromptOptions {
  intent: FeishuHistoryIntent;
  retrieved: FeishuIndexedHistoryRetrieval | null | undefined;
}

/**
 * 把受控历史索引结果转换为 Provider prompt。
 * 本模块只负责可见文本约束，不读取平台、存储、附件或当前工作区。
 */
export function buildFeishuIndexedHistoryPrompt(
  options: BuildFeishuIndexedHistoryPromptOptions,
): string {
  const { intent, retrieved } = options;
  const formattedHistory = retrieved?.summary || '';
  const targetSpeakerNames = intent.targetSpeakerNames ?? [];

  if (!formattedHistory) {
    return [
      `用户当前请求：${intent.taskPrompt}`,
      '',
      targetSpeakerNames.length > 0
        ? `说明：本地历史索引里没有筛到与 ${targetSpeakerNames.join('、')} 相关的有效消息。请直接说明这一点，并给出最短下一步建议。`
        : '说明：我已尝试读取群聊历史，但当前没有拿到可用于回答的有效消息。请直接说明这次没读到内容，并给出最短下一步建议。',
    ].join('\n');
  }

  const selectedCount = retrieved?.items.length ?? 0;
  const speakerScope = targetSpeakerNames.length > 0
    ? `与 ${targetSpeakerNames.join('、')} 相关的`
    : '';
  const syncInfo = retrieved?.syncStatus?.messageCount
    ? `（本地索引已同步 ${retrieved.syncStatus.messageCount} 条）`
    : '';
  const scopeText = `${intent.scopeText}中索引命中的${speakerScope}${selectedCount}条相关消息${syncInfo}`;

  if (intent.responseMode === 'doc') {
    return [
      `请基于下面提供的 ${scopeText}，生成一份适合直接写入飞书文档的 Markdown 正文。`,
      '要求：',
      '1. 第一行必须是一级标题。',
      '2. 正文默认包含“结论摘要”“重点信息”“待办事项”三个部分；如果某部分确实为空，也要如实写明。',
      '3. 只输出文档正文本身，不要写“下面是”“已为你生成”“请查收”等客套句。',
      '4. 不要输出代码块，不要编造群里没有出现的信息。',
      '',
      '=== 群聊历史开始 ===',
      formattedHistory,
      '=== 群聊历史结束 ===',
      '',
      `用户当前请求：${intent.taskPrompt}`,
    ].join('\n');
  }

  if (intent.purpose === 'reference' && targetSpeakerNames.length > 0) {
    return [
      `请优先依据下面提供的 ${scopeText} 来完成用户请求。`,
      '要求：直接给出结论或修改结果，不要先说“我去找记录”或“我没看到聊天记录”。',
      `如果这些记录不足以支撑最终判断，再用一句话说明“当前只读到了 ${targetSpeakerNames.join('、')} 的这些相关记录，仍缺少哪类信息”。`,
      '不要把本地文件搜索结果误当成群聊记录，不要编造聊天内容。',
      '如果群聊历史中已经出现了明确的英文标识、资源名、配置名、ID、token 或代码风格命名，必须优先原样保留，不要自己改写成另一种格式。',
      '',
      '=== 相关群聊记录开始 ===',
      formattedHistory,
      '=== 相关群聊记录结束 ===',
      '',
      `用户当前请求：${intent.taskPrompt}`,
    ].join('\n');
  }

  return [
    `请基于下面提供的 ${scopeText} 回答用户请求。`,
    '要求：直接给出结论和摘要，少讲过程，不要让用户重复贴记录。',
    '如果信息不完整，可以在结尾用一句话简短说明边界，但不要把整段回答写成拒答或免责声明。',
    '不要编造未出现的内容，也不要说“我现在看不到本群记录”之类的泛化废话；你现在看到的就是下面这段历史。',
    '',
    '=== 群聊历史开始 ===',
    formattedHistory,
    '=== 群聊历史结束 ===',
    '',
    `用户当前请求：${intent.taskPrompt}`,
  ].join('\n');
}
