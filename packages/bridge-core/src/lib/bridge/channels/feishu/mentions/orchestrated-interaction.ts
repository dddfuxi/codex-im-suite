import {
  extractFeishuOrchestratedStarterTargets,
  hasFeishuCounterpartyMentionHandoff,
  normalizeFeishuMentionTargetKey,
} from '../../../application/mentions.js';
import type { OutboundMention } from '../../../types.js';

export interface FeishuOrchestratedAssistantIdentity {
  displayName?: string;
  appId?: string;
  botOpenId?: string;
}

export type FeishuOrchestratedInteractionStatus =
  | 'not_applicable'
  | 'self_turn'
  | 'wait_turn'
  | 'ambiguous';

export interface FeishuOrchestratedInteractionPlan {
  status: FeishuOrchestratedInteractionStatus;
  reason: string;
  starterName?: string;
  selfParticipant?: OutboundMention;
  counterparty?: OutboundMention;
  participants: OutboundMention[];
}

function uniqueNativeParticipants(mentions: OutboundMention[]): OutboundMention[] {
  const byId = new Map<string, OutboundMention>();
  for (const mention of mentions) {
    const userId = mention.userId?.trim() || '';
    const name = mention.name?.trim() || '';
    if (!userId || !name || mention.atAll || byId.has(userId)) continue;
    byId.set(userId, { userId, name });
  }
  return [...byId.values()];
}

function findSelfParticipant(
  participants: OutboundMention[],
  identity: FeishuOrchestratedAssistantIdentity | null | undefined,
): OutboundMention | null {
  const botOpenId = identity?.botOpenId?.trim() || '';
  if (botOpenId) {
    const byId = participants.filter((participant) => participant.userId === botOpenId);
    if (byId.length === 1) return byId[0];
  }

  const displayNameKey = normalizeFeishuMentionTargetKey(identity?.displayName || '');
  if (!displayNameKey) return null;
  const byName = participants.filter((participant) => (
    normalizeFeishuMentionTargetKey(participant.name || '') === displayNameKey
  ));
  return byName.length === 1 ? byName[0] : null;
}

/**
 * 在 Provider 之前解释“双人开始、某人先手、发言后 @ 对方”的轮次语义。
 * 当前机器人、先手和对方都来自同一条消息的原生 mention 身份；只要任一角色
 * 不能唯一绑定就不猜，交回普通 Agent 路径或标记歧义。
 */
export function resolveFeishuOrchestratedInteraction(input: {
  userText: string;
  nativeMentions: OutboundMention[];
  assistantIdentity?: FeishuOrchestratedAssistantIdentity | null;
}): FeishuOrchestratedInteractionPlan {
  const starterTargets = extractFeishuOrchestratedStarterTargets(input.userText);
  if (starterTargets.length !== 1 || !hasFeishuCounterpartyMentionHandoff(input.userText)) {
    return {
      status: 'not_applicable',
      reason: '当前消息不是可唯一解释的轮次交接编排。',
      participants: [],
    };
  }

  const participants = uniqueNativeParticipants(input.nativeMentions);
  if (participants.length < 2) {
    return {
      status: 'not_applicable',
      reason: '原生 mention 中没有形成至少两位可验证参与者，沿用普通解析。',
      starterName: starterTargets[0],
      participants,
    };
  }

  const selfParticipant = findSelfParticipant(participants, input.assistantIdentity);
  if (!selfParticipant) {
    return {
      status: 'ambiguous',
      reason: '无法把当前机器人唯一绑定到本轮原生参与者。',
      starterName: starterTargets[0],
      participants,
    };
  }

  const starterKey = normalizeFeishuMentionTargetKey(starterTargets[0]);
  const starterMatches = participants.filter((participant) => (
    normalizeFeishuMentionTargetKey(participant.name || '') === starterKey
  ));
  if (starterMatches.length !== 1) {
    return {
      status: 'ambiguous',
      reason: '先手名称不能唯一绑定到本轮原生参与者。',
      starterName: starterTargets[0],
      selfParticipant,
      participants,
    };
  }

  const starter = starterMatches[0];
  if (starter.userId !== selfParticipant.userId) {
    return {
      status: 'wait_turn',
      reason: '本轮指定由另一位参与者先发言，当前机器人应等待对方原生 mention 后再接话。',
      starterName: starter.name,
      selfParticipant,
      participants,
    };
  }

  const counterparties = participants.filter((participant) => participant.userId !== selfParticipant.userId);
  if (counterparties.length !== 1) {
    return {
      status: 'ambiguous',
      reason: '当前机器人是先手，但“对方”不能唯一绑定到一个原生参与者。',
      starterName: starter.name,
      selfParticipant,
      participants,
    };
  }

  return {
    status: 'self_turn',
    reason: '当前机器人是首位发言者，发言后应把原生 mention 交接给唯一对方。',
    starterName: starter.name,
    selfParticipant,
    counterparty: counterparties[0],
    participants,
  };
}
