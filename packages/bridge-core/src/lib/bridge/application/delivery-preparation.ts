import path from 'node:path';

import type { OutboundMention } from '../types.js';
import { parseAnalysisView, type AnalysisView } from './analysis-view.js';
import { parseSpeechReplyDirective, type SpeechReplyDirective } from './speech-policy.js';
import { parseSingingReplyDirective, type SingingReplyDirective } from './singing-policy.js';
import {
  parseChoiceFlowDirective,
  parseChoicePrompt,
  parseChoiceSessionDirective,
  type ChoiceFlowDirective,
  type ChoicePrompt,
  type ChoiceSessionDirective,
} from './choice-prompts.js';
import {
  ARTIFACT_PROMOTION_ACTION_FENCE,
  BRIDGE_CONTROL_ACTION_FENCE,
  REMINDER_ACTION_FENCE,
  SCHEDULED_TASK_ACTION_FENCE,
} from './action-blocks.js';
import { parseEnvelopeMentionTargets, parseEnvelopeMentions } from './mentions.js';
import {
  STICKER_ANNOTATION_FENCE,
  STICKER_CANDIDATE_ANALYSIS_FENCE,
} from './stickers.js';

export const FINAL_REPLY_FENCE = 'cti-final';

export type FinalReplyKind = 'text' | 'image' | 'file' | 'mixed';
export type FinalReplyMode = 'plain' | 'markdown' | 'html';

export interface DeliveryCardHero {
  /** 仅允许引用同一 cti-final.images 中的受管图片路径。 */
  imagePath: string;
  alt: string;
}

export interface FinalReplyEnvelope {
  kind: FinalReplyKind;
  text: string;
  images: string[];
  files: string[];
  reply_mode: FinalReplyMode;
  mentions?: OutboundMention[];
  mention_targets?: string[];
  reply_to?: string;
  card_hero?: DeliveryCardHero;
  choice_prompt?: ChoicePrompt;
  choice_flow?: ChoiceFlowDirective;
  choice_session?: ChoiceSessionDirective;
  analysis_view?: AnalysisView;
  /** 仅为呈现意图；Bridge 不接受模型提供的 provider、路径、音色或平台身份。 */
  speech?: SpeechReplyDirective;
  /** 歌词/风格是可见请求内容；Runtime 独占 provider、模型、音色和文件。 */
  singing?: SingingReplyDirective;
}

export interface DeliveryCandidatePayload {
  text: string;
  parseMode: 'plain' | 'Markdown' | 'HTML';
  images: string[];
  files: string[];
  mentions?: OutboundMention[];
  /** 模型选择的显示名提示；不含可信平台身份，只能交给 delivery 再解析。 */
  mentionTargets?: string[];
  replyTo?: string;
  cardHero?: DeliveryCardHero;
  feishuCardJson?: string;
  choicePrompt?: ChoicePrompt;
  choiceFlow?: ChoiceFlowDirective;
  choiceSession?: ChoiceSessionDirective;
  analysisView?: AnalysisView;
  speech?: SpeechReplyDirective;
  singing?: SingingReplyDirective;
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
  const cardHero = parseDeliveryCardHero(raw.card_hero, images);
  return {
    kind,
    text,
    images,
    files,
    reply_mode: replyMode,
    mentions: parseEnvelopeMentions(raw.mentions),
    mention_targets: parseEnvelopeMentionTargets(raw.mentions),
    reply_to: typeof raw.reply_to === 'string' && raw.reply_to.trim() ? raw.reply_to.trim() : undefined,
    card_hero: cardHero,
    choice_prompt: parseChoicePrompt(raw.choices, raw.choice_title),
    choice_flow: parseChoiceFlowDirective(raw.choice_flow),
    choice_session: parseChoiceSessionDirective(raw.choice_session),
    analysis_view: parseAnalysisView(raw.analysis_view),
    speech: parseSpeechReplyDirective(raw.speech),
    singing: parseSingingReplyDirective(raw.singing),
  };
}

function parseDeliveryCardHero(candidate: unknown, images: readonly string[]): DeliveryCardHero | undefined {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const raw = candidate as Record<string, unknown>;
  const imagePath = typeof raw.image === 'string' ? raw.image.trim() : '';
  if (!imagePath || /^(?:https?:|data:|file:)/iu.test(imagePath)) return undefined;
  // 头图只是现有图片交付的一种呈现方式，不能另开任意路径或平台 image_key 旁路。
  if (!images.some((image) => image.trim() === imagePath)) return undefined;
  const alt = typeof raw.alt === 'string'
    ? raw.alt.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim().slice(0, 120)
    : '';
  return { imagePath, alt: alt || '卡片头图' };
}

export function extractFinalReplyEnvelope(text: string): FinalReplyEnvelope | null {
  // 官方 Provider 会把多个 completed agent_message 连续拼接；最终协议块前面
  // 不一定天然带换行。这里按 fence 自身定位，兼容相邻进度文本和单行 JSON。
  const fencePattern = new RegExp(String.raw`\`\`\`${FINAL_REPLY_FENCE}\b([\s\S]*?)\`\`\``, 'gi');
  let lastMatch: RegExpExecArray | null = null;
  for (const match of text.matchAll(fencePattern)) lastMatch = match;
  if (lastMatch) {
    try {
      return parseEnvelopeObject(JSON.parse(lastMatch[1].trim()));
    } catch {
      // 继续尝试无 fence 的兼容 JSON。
    }
  }
  // 兼容官方模型偶发输出的裸结构化对象。不能用非贪婪正则截取，因为
  // mentions 等字段包含嵌套对象；必须按字符串转义和花括号深度找完整 JSON。
  let lastEnvelope: FinalReplyEnvelope | null = null;
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const candidate = extractBalancedJsonObject(text, start);
    if (!candidate) continue;
    try {
      const envelope = parseEnvelopeObject(JSON.parse(candidate));
      if (envelope) lastEnvelope = envelope;
    } catch {
      // 继续扫描后续对象；普通正文里的花括号不应阻断结构化结果恢复。
    }
  }
  return lastEnvelope;
}

function extractBalancedJsonObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
      if (depth < 0) return null;
    }
  }
  return null;
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
      new RegExp(String.raw`\`\`\`${fence}\b[\s\S]*?\`\`\``, 'gi'),
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
  const resolvedCardHeroPath = envelope.card_hero
    ? (path.isAbsolute(envelope.card_hero.imagePath)
      ? envelope.card_hero.imagePath
      : workingDirectory
        ? path.resolve(workingDirectory, envelope.card_hero.imagePath)
        : '')
    : '';
  return {
    text: envelope.text || '',
    parseMode: parseDeliveryReplyMode(envelope.reply_mode),
    images: resolveDeliveryPaths(envelope.images, workingDirectory, additionalDirectories),
    files: resolveDeliveryPaths(envelope.files, workingDirectory, additionalDirectories),
    mentions: envelope.mentions,
    mentionTargets: envelope.mention_targets,
    replyTo: envelope.reply_to,
    ...(resolvedCardHeroPath ? {
      cardHero: {
        imagePath: resolvedCardHeroPath,
        alt: envelope.card_hero?.alt || '卡片头图',
      },
    } : {}),
    choicePrompt: envelope.choice_prompt,
    choiceFlow: envelope.choice_flow,
    choiceSession: envelope.choice_session,
    analysisView: envelope.analysis_view,
    speech: envelope.speech,
    singing: envelope.singing,
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
