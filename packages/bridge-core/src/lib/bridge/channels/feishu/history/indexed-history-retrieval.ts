import type { FeishuHistoryIntent } from '../../../application/history-intent.js';
import type { FeishuIndexedHistoryRetrieval } from './indexed-history-prompt.js';

export interface FeishuIndexedHistoryQuery {
  chatId: string;
  query: string;
  limit: number;
  startTimeMs?: number;
  endTimeMs?: number;
  targetSpeakerNames?: string[];
}

export type FeishuIndexedHistoryRetriever = (
  query: FeishuIndexedHistoryQuery,
) => FeishuIndexedHistoryRetrieval | null;

export interface RetrieveFeishuIndexedHistoryOptions {
  chatId: string;
  intent: FeishuHistoryIntent;
  retrieve?: FeishuIndexedHistoryRetriever;
}

/**
 * 只允许从当前 chat 的受控索引检索历史。
 * 云端分页同步由 adapter 在调用前完成；Host 无索引能力时失败关闭。
 */
export function retrieveFeishuIndexedHistory(
  options: RetrieveFeishuIndexedHistoryOptions,
): FeishuIndexedHistoryRetrieval | null {
  const chatId = options.chatId.trim();
  if (!chatId || !options.retrieve) return null;

  return options.retrieve({
    chatId,
    query: options.intent.taskPrompt,
    limit: options.intent.limit,
    startTimeMs: options.intent.startTimeMs,
    endTimeMs: options.intent.endTimeMs,
    targetSpeakerNames: options.intent.targetSpeakerNames,
  });
}
