import type { TurnEvidenceEnvelope, TurnFocusDecision } from '../turn-context.js';

export type DirectMessageTargetKind = 'user' | 'chat' | 'any';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 判断当前用户原文是否明确授权了本轮私发或群聊投递。
 * 目标类型参与语义判断，避免把“在某群里发”降级成对同名成员私聊。
 */
export function isExplicitDirectMessageRequestText(
  text: string,
  targetText = '',
  targetKind: DirectMessageTargetKind = 'any',
): boolean {
  const normalized = (text || '').normalize('NFKC').replace(/\s+/g, '');
  if (!normalized) return false;
  const broadIntent = /(?:私发|私信|单独发|悄悄发|发私聊|DM|directmessage|给.{1,32}发(?:一条)?消息|发(?:一条)?消息给|转告|转发给|发到(?:会话|群|群聊|chat|channel|session)|发送到(?:会话|群|群聊|chat|channel|session)|跨群发|跨会话发)/iu;
  const target = (targetText || '').normalize('NFKC').replace(/\s+/g, '').replace(/^[@＠]+/u, '').trim();
  if (!target) return broadIntent.test(normalized);

  const safeTarget = escapeRegExp(target);
  const targetAppears = new RegExp(`(?:@|＠)?${safeTarget}`, 'iu').test(normalized);
  if (targetKind === 'chat' && targetAppears) {
    const namedGroupSendIntent = /(?:在|往|向|去).{1,64}(?:群|群聊|群组|会话|频道|chat|channel|session)(?:里|中|内)?(?:发|发送|发布|投递|说|回复)|(?:给|向).{1,64}(?:群|群聊|群组|会话|频道|chat|channel|session)(?:发|发送|发布|投递)|(?:发|发送|发布|投递)(?:一条)?(?:消息|信息|内容|文字|文本)?(?:到|至).{1,64}(?:群|群聊|群组|会话|频道|chat|channel|session)/iu;
    return namedGroupSendIntent.test(normalized) || broadIntent.test(normalized);
  }
  if (targetAppears && broadIntent.test(normalized)) return true;

  const mediaOrContent = '(?:表情包|表情|sticker|图片|照片|图|文件|附件|消息|文字|文本|链接|内容)';
  const sendToTarget = new RegExp(`(?:给|向)(?:@|＠)?${safeTarget}(?:发|发送|来|回)(?:一|1)?(?:个|张|份|条)?${mediaOrContent}`, 'iu');
  const targetAfterContent = new RegExp(`(?:发|发送)(?:一|1)?(?:个|张|份|条)?${mediaOrContent}(?:给|到)(?:@|＠)?${safeTarget}`, 'iu');
  const explicitlyNegated = new RegExp(`(?:不要|别|不想|不用|禁止)(?:给|向)(?:@|＠)?${safeTarget}(?:发|发送|来|回)`, 'iu').test(normalized);
  return !explicitlyNegated && (sendToTarget.test(normalized) || targetAfterContent.test(normalized));
}

/** 模型声明的目标只有与本轮可信来源 chatId 完全一致时，才可归为当前会话。 */
export function isCurrentConversationTargetId(targetId: string | undefined, sourceChatId: string): boolean {
  const target = (targetId || '').normalize('NFKC').trim();
  const source = (sourceChatId || '').normalize('NFKC').trim();
  return Boolean(target && source && target === source);
}

function isExplicitActionContinuationText(text: string): boolean {
  const normalized = (text || '').normalize('NFKC').replace(/\s+/g, '').trim();
  if (!normalized || normalized.length > 80) return false;
  if (/(?:不要|别|取消|停止|不想|不用|禁止).{0,12}(?:发|发送|投递|执行|运行|测试|重试|继续|提醒)/u.test(normalized)) {
    return false;
  }
  if (/(?:为什么|为何|怎么回事|什么意思|原因|是否|能否|可否).{0,16}(?:发|发送|投递|执行|运行|测试|重试|继续|提醒)/u.test(normalized)) {
    return false;
  }
  const action = /(?:发送|发出去|投递|执行|运行|跑一下|测试|试一次|试一下|重试|继续|接着|确认)/u.test(normalized);
  const immediacy = /(?:现在|立即|马上|这次|那就|再|重新|倒是|赶紧|请|确认|继续|接着|一次|一下|试试|吧|啊|呀)/u.test(normalized);
  return action && immediacy;
}

/**
 * 短句续办可继承本机器人已持久化结果的动作授权，但不能从普通历史或引用文本继承。
 * 这里只允许动作进入后续目标/权限裁决；跨会话发送仍必须经过 Owner 和二次确认。
 */
export function hasTrustedDirectMessageContinuationAuthorization(input: {
  userText: string;
  envelope?: TurnEvidenceEnvelope;
  focus?: TurnFocusDecision;
}): boolean {
  const { envelope, focus } = input;
  if (!envelope || !focus || !isExplicitActionContinuationText(input.userText)) return false;
  if (!['reply_target', 'continuation'].includes(focus.focus)) return false;
  if (focus.requiresAgentResolution || focus.confidence < 0.8) return false;
  if (focus.primaryEvidenceIds.length !== 1 || focus.conflictingEvidenceIds.length > 0) return false;

  const evidence = envelope.evidence.find((item) => item.id === focus.primaryEvidenceIds[0]);
  if (!evidence || evidence.relation !== 'native_reply' || evidence.confidence < 0.8) return false;
  if (evidence.metadata?.contentRecovered === false) return false;
  if (evidence.source !== 'local_outbound_ref' && evidence.metadata?.continuationContextRecovered !== true) return false;
  return ['bot', 'app', 'system'].includes(evidence.actor?.type || '');
}
