export type JevChatMode = 'explicit' | 'pure';

const chatModes = new Map<string, { mode: JevChatMode; enabledAt: number }>();

function key(channelType: string, chatId: string): string {
  return `${channelType}:${chatId}`;
}

export function isJevPureModeEnabled(channelType: string, chatId: string): boolean {
  return chatModes.get(key(channelType, chatId))?.mode === 'pure';
}

export function getJevChatMode(channelType: string, chatId: string): JevChatMode | null {
  return chatModes.get(key(channelType, chatId))?.mode || null;
}

export function setJevChatMode(channelType: string, chatId: string, mode: JevChatMode | null): void {
  const chatKey = key(channelType, chatId);
  if (!mode) chatModes.delete(chatKey);
  else chatModes.set(chatKey, { mode, enabledAt: Date.now() });
}
