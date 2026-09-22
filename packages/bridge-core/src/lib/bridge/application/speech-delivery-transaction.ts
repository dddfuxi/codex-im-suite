export interface SpeechDeliverySendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export type SpeechCardReplacementResult =
  | { kind: 'card_preserved'; error?: string }
  | { kind: 'audio'; messageId: string }
  | { kind: 'text_fallback'; messageId: string }
  | { kind: 'unresolved'; error?: string };

async function safeAttempt(action: () => Promise<SpeechDeliverySendResult>): Promise<SpeechDeliverySendResult> {
  try {
    return await action();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 流式语音唯一终态事务：先撤回临时卡，再发音频；撤卡失败时保留并更新原卡，
 * 音频失败时只发一次完整文字。调用方不得在本事务后再并行补发另一份终态。
 */
export async function replaceProgressCardWithSpeech(input: {
  recallProgressCard: () => Promise<SpeechDeliverySendResult>;
  sendAudio: () => Promise<SpeechDeliverySendResult>;
  sendTextFallback: () => Promise<SpeechDeliverySendResult>;
}): Promise<SpeechCardReplacementResult> {
  const recalled = await safeAttempt(input.recallProgressCard);
  if (!recalled.ok) return { kind: 'card_preserved', error: recalled.error };

  const audio = await safeAttempt(input.sendAudio);
  if (audio.ok && audio.messageId) return { kind: 'audio', messageId: audio.messageId };

  const fallback = await safeAttempt(input.sendTextFallback);
  if (fallback.ok && fallback.messageId) return { kind: 'text_fallback', messageId: fallback.messageId };
  return { kind: 'unresolved', error: fallback.error || audio.error };
}

/** 非流式链路只在音频没有成功回执时发送一次文字 fallback。 */
export async function deliverSpeechWithTextFallback(input: {
  sendAudio: () => Promise<SpeechDeliverySendResult>;
  sendTextFallback: () => Promise<SpeechDeliverySendResult>;
}): Promise<Extract<SpeechCardReplacementResult, { kind: 'audio' | 'text_fallback' | 'unresolved' }>> {
  const audio = await safeAttempt(input.sendAudio);
  if (audio.ok && audio.messageId) return { kind: 'audio', messageId: audio.messageId };
  const fallback = await safeAttempt(input.sendTextFallback);
  if (fallback.ok && fallback.messageId) return { kind: 'text_fallback', messageId: fallback.messageId };
  return { kind: 'unresolved', error: fallback.error || audio.error };
}
