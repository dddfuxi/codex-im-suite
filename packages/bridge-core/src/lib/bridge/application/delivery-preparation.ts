import path from 'node:path';

import type { OutboundMention } from '../types.js';
import {
  ARTIFACT_PROMOTION_ACTION_FENCE,
  BRIDGE_CONTROL_ACTION_FENCE,
  REMINDER_ACTION_FENCE,
  SCHEDULED_TASK_ACTION_FENCE,
} from './action-blocks.js';
import { parseEnvelopeMentions } from './mentions.js';
import {
  STICKER_ANNOTATION_FENCE,
  STICKER_CANDIDATE_ANALYSIS_FENCE,
} from './stickers.js';

export const FINAL_REPLY_FENCE = 'cti-final';

export type FinalReplyKind = 'text' | 'image' | 'file' | 'mixed';
export type FinalReplyMode = 'plain' | 'markdown' | 'html';

export interface FinalReplyEnvelope {
  kind: FinalReplyKind;
  text: string;
  images: string[];
  files: string[];
  reply_mode: FinalReplyMode;
  mentions?: OutboundMention[];
  reply_to?: string;
}

export interface DeliveryCandidatePayload {
  text: string;
  parseMode: 'plain' | 'Markdown' | 'HTML';
  images: string[];
  files: string[];
  mentions?: OutboundMention[];
  replyTo?: string;
  feishuCardJson?: string;
}

export interface DeliveryCandidateStatus {
  parsed: boolean;
  kind?: FinalReplyKind | null;
  usedRawFallback: boolean;
  usedLegacyCompactor: boolean;
}

export function parseDeliveryReplyMode(mode: string | undefined | null): 'plain' | 'Markdown' | 'HTML' {
  switch ((mode || 'plain').trim().toLowerCase()) {
    case 'markdown': return 'Markdown';
    case 'html': return 'HTML';
    default: return 'plain';
  }
}

export function extractVisibleAssistantText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  const matches = Array.from(normalized.matchAll(/\[\{"type":"text","text":"([\s\S]*?)"\}(?:,[\s\S]*?)?\]/g));
  if (matches.length > 0) {
    return (matches[matches.length - 1]?.[1] || '')
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .trim();
  }
  return normalized;
}

function parseEnvelopeObject(candidate: unknown): FinalReplyEnvelope | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const raw = candidate as Record<string, unknown>;
  const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() as FinalReplyKind : null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  const images = Array.isArray(raw.images)
    ? raw.images.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const files = Array.isArray(raw.files)
    ? raw.files.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const replyMode = typeof raw.reply_mode === 'string' ? raw.reply_mode.trim().toLowerCase() as FinalReplyMode : null;
  if (!kind || !['text', 'image', 'file', 'mixed'].includes(kind)) return null;
  if (!replyMode || !['plain', 'markdown', 'html'].includes(replyMode)) return null;
  if (!text.trim() && images.length === 0 && files.length === 0) return null;
  return {
    kind,
    text,
    images,
    files,
    reply_mode: replyMode,
    mentions: parseEnvelopeMentions(raw.mentions),
    reply_to: typeof raw.reply_to === 'string' && raw.reply_to.trim() ? raw.reply_to.trim() : undefined,
  };
}

export function extractFinalReplyEnvelope(text: string): FinalReplyEnvelope | null {
  const fencePattern = new RegExp(String.raw`(?:^|\n)\`\`\`${FINAL_REPLY_FENCE}\s*\n([\s\S]*?)\n\`\`\``, 'g');
  let lastMatch: RegExpExecArray | null = null;
  for (const match of text.matchAll(fencePattern)) lastMatch = match;
  if (lastMatch) {
    try {
      return parseEnvelopeObject(JSON.parse(lastMatch[1].trim()));
    } catch {
      // 继续尝试无 fence 的兼容 JSON。
    }
  }
  const rawJsonPattern = /(\{[\s\S]*?"kind"\s*:\s*"(?:text|image|file|mixed)"[\s\S]*?"reply_mode"\s*:\s*"(?:plain|markdown|html)"[\s\S]*?\})/g;
  let rawJsonMatch: RegExpExecArray | null = null;
  for (const match of text.matchAll(rawJsonPattern)) rawJsonMatch = match;
  if (!rawJsonMatch) return null;
  try {
    return parseEnvelopeObject(JSON.parse(rawJsonMatch[1].trim()));
  } catch {
    return null;
  }
}

export function stripDeliveryProtocolArtifacts(text: string): string {
  const fences = [
    FINAL_REPLY_FENCE,
    STICKER_ANNOTATION_FENCE,
    STICKER_CANDIDATE_ANALYSIS_FENCE,
    REMINDER_ACTION_FENCE,
    SCHEDULED_TASK_ACTION_FENCE,
    BRIDGE_CONTROL_ACTION_FENCE,
    ARTIFACT_PROMOTION_ACTION_FENCE,
  ];
  let cleaned = text;
  for (const fence of fences) {
    cleaned = cleaned.replace(
      new RegExp(String.raw`(?:^|\n)\s*\`\`\`${fence}\s*\n[\s\S]*?\n\s*\`\`\``, 'gi'),
      '\n',
    );
  }
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

export function resolveDeliveryPaths(
  items: string[],
  workingDirectory: string,
  additionalDirectories: string[] = [],
): string[] {
  const resolved = new Set<string>();
  for (const item of items) {
    const trimmed = typeof item === 'string' ? item.trim() : '';
    if (!trimmed) continue;
    if (path.isAbsolute(trimmed)) {
      resolved.add(trimmed);
      continue;
    }
    if (workingDirectory) resolved.add(path.resolve(workingDirectory, trimmed));
    for (const directory of additionalDirectories) {
      if (directory) resolved.add(path.resolve(directory, trimmed));
    }
  }
  return [...resolved];
}

function isProcessNarrationLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) return false;
  return /^(我先|我会|我正在|我继续|我再|我开始|我已经找到|我确认到|下一步|接下来|现在我|当前我|先看|先查|我改用|我准备|我补查|我切到|我定位到|启动尝试|直连服务|刚确认|刚才|随后|Then |Next )/i.test(normalized);
}

function isOutcomeLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) return false;
  return /(已完成|已处理|已修复|已生成|已同步|已发送|已重启|已更新|运行中|成功|失败|报错|错误|文件在|图片在|文档在|链接|PID|channel|当前状态|结论|原因|结果|可用|不可用|命中|同步完成|请直接|你现在可以)/i.test(normalized);
}

export function compactBridgeReplyForDelivery(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const normalized = trimmed.replace(/\r\n/g, '\n');
  const blocks = normalized.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const strongBlocks = blocks.filter((block) => isOutcomeLine(block) && !isProcessNarrationLine(block));
  if (strongBlocks.length > 0) {
    const compact = strongBlocks.slice(-3).join('\n\n').trim();
    return compact.length > 420 ? `${compact.slice(0, 417)}...` : compact;
  }
  const strongLines = lines.filter((line) => isOutcomeLine(line) && !isProcessNarrationLine(line));
  if (strongLines.length > 0) {
    const compact = strongLines.slice(-4).join('\n').trim();
    return compact.length > 420 ? `${compact.slice(0, 417)}...` : compact;
  }
  if (blocks.length >= 3 || lines.length >= 8) {
    const filtered = lines.filter((line) => !isProcessNarrationLine(line));
    const compact = (filtered.length > 0 ? filtered.slice(-4) : lines.slice(-3)).join('\n').trim();
    return compact.length > 420 ? `${compact.slice(0, 417)}...` : compact;
  }
  return trimmed.length > 420 ? `${trimmed.slice(0, 417)}...` : trimmed;
}

function payloadFromEnvelope(
  envelope: FinalReplyEnvelope,
  workingDirectory: string,
  additionalDirectories: string[],
): DeliveryCandidatePayload {
  return {
    text: envelope.text || '',
    parseMode: parseDeliveryReplyMode(envelope.reply_mode),
    images: resolveDeliveryPaths(envelope.images, workingDirectory, additionalDirectories),
    files: resolveDeliveryPaths(envelope.files, workingDirectory, additionalDirectories),
    mentions: envelope.mentions,
    replyTo: envelope.reply_to,
  };
}

export function prepareDeliveryCandidate(
  text: string,
  workingDirectory: string,
  additionalDirectories: string[] = [],
): { payload: DeliveryCandidatePayload; status: DeliveryCandidateStatus } {
  const envelope = extractFinalReplyEnvelope(text);
  if (envelope) return {
    payload: payloadFromEnvelope(envelope, workingDirectory, additionalDirectories),
    status: { parsed: true, kind: envelope.kind, usedRawFallback: false, usedLegacyCompactor: false },
  };
  const visible = extractVisibleAssistantText(text);
  const visibleEnvelope = visible ? extractFinalReplyEnvelope(visible) : null;
  if (visibleEnvelope) return {
    payload: payloadFromEnvelope(visibleEnvelope, workingDirectory, additionalDirectories),
    status: { parsed: true, kind: visibleEnvelope.kind, usedRawFallback: false, usedLegacyCompactor: false },
  };
  const safeVisible = visible ? stripDeliveryProtocolArtifacts(visible) : '';
  if (safeVisible) return {
    payload: { text: safeVisible, parseMode: 'plain', images: [], files: [] },
    status: { parsed: false, kind: null, usedRawFallback: true, usedLegacyCompactor: false },
  };
  const compacted = compactBridgeReplyForDelivery(stripDeliveryProtocolArtifacts(text) || text);
  return {
    payload: { text: compacted, parseMode: 'plain', images: [], files: [] },
    status: { parsed: false, kind: null, usedRawFallback: false, usedLegacyCompactor: true },
  };
}
