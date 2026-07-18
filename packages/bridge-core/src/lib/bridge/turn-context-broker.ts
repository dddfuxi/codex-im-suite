import type {
  FileAttachment,
  TurnReferenceResolverHost,
} from './host.js';
import {
  createTurnEvidenceEnvelope,
  formatStructuredTurnContext,
  resolveUnrecoveredReplyFallback,
  resolveTurnFocus,
  validateAgentTurnFocusDecision,
  type TurnEvidenceActor,
  type TurnEvidenceEnvelope,
  type TurnEvidenceItem,
  type TurnFocusDecision,
} from './turn-context.js';

export interface TurnMentionEvidenceInput {
  key?: string;
  name?: string;
  openId?: string;
  userId?: string;
  unionId?: string;
}

export interface RetrievedTurnEvidenceInput {
  id: string;
  kind: TurnEvidenceItem['kind'];
  source: TurnEvidenceItem['source'];
  content: string;
  confidence?: number;
}

export interface ResolveStructuredTurnContextInput {
  sessionId: string;
  channelType: string;
  chatId: string;
  messageId: string;
  currentText: string;
  currentTimestamp?: number;
  currentActor?: TurnEvidenceActor;
  abortSignal?: AbortSignal;
  platformEvidence?: TurnEvidenceItem[];
  mentions?: TurnMentionEvidenceInput[];
  attachments?: FileAttachment[];
  replyAttachmentCount?: number;
  replyMessageId?: string;
  retrievedEvidence?: RetrievedTurnEvidenceInput[];
  resolver?: TurnReferenceResolverHost;
}

export interface ResolvedStructuredTurnContext {
  envelope: TurnEvidenceEnvelope;
  decision: TurnFocusDecision;
  prompt: string;
  hasPlatformEvidence: boolean;
}

function appendEvidence(
  evidence: TurnEvidenceItem[],
  evidenceIds: Set<string>,
  item: TurnEvidenceItem,
): void {
  if (!item.id || evidenceIds.has(item.id)) return;
  evidence.push(item);
  evidenceIds.add(item.id);
}

/**
 * Context Broker 的单一编排入口：归一化证据、做确定性裁决，并只在需要时
 * 调用解析 Agent。bridge-manager 只负责提供本轮事实和消费最终 Prompt。
 */
export async function resolveStructuredTurnContext(
  input: ResolveStructuredTurnContextInput,
): Promise<ResolvedStructuredTurnContext> {
  const currentTimestamp = Number.isFinite(input.currentTimestamp)
    ? input.currentTimestamp as number
    : undefined;
  const evidence = (input.platformEvidence || []).filter((item) =>
    currentTimestamp === undefined
    || !Number.isFinite(item.timestamp)
    || (item.timestamp as number) <= currentTimestamp);
  const evidenceIds = new Set(evidence.map((item) => item.id));

  for (const [index, mention] of (input.mentions || []).entries()) {
    const actorId = mention.openId || mention.userId || mention.unionId || mention.key || '';
    appendEvidence(evidence, evidenceIds, {
      id: `mention:${actorId || index}`,
      kind: 'mention',
      relation: 'native_mention',
      source: 'platform_event',
      confidence: 1,
      content: mention.name || mention.key || actorId,
      actor: {
        id: actorId || undefined,
        displayName: mention.name || mention.key || undefined,
        type: 'unknown',
      },
      metadata: {
        key: mention.key,
        openId: mention.openId,
        userId: mention.userId,
        unionId: mention.unionId,
      },
    });
  }

  const replyAttachmentCount = Math.max(0, input.replyAttachmentCount || 0);
  for (const [index, attachment] of (input.attachments || []).entries()) {
    const belongsToReply = index < replyAttachmentCount;
    appendEvidence(evidence, evidenceIds, {
      id: `attachment:${attachment.id || index}`,
      kind: 'attachment',
      relation: belongsToReply ? 'reply_attachment' : 'current_attachment',
      source: belongsToReply ? 'platform_api' : 'platform_event',
      confidence: 1,
      content: attachment.name || attachment.id || `attachment-${index + 1}`,
      metadata: {
        mimeType: attachment.type,
        size: attachment.size,
        replyMessageId: belongsToReply ? input.replyMessageId : undefined,
      },
    });
  }

  for (const retrieved of input.retrievedEvidence || []) {
    const content = retrieved.content.trim();
    if (!content) continue;
    appendEvidence(evidence, evidenceIds, {
      id: retrieved.id,
      kind: retrieved.kind,
      relation: 'retrieved',
      source: retrieved.source,
      confidence: retrieved.confidence ?? 0.9,
      content,
    });
  }

  const envelope = createTurnEvidenceEnvelope({
    channelType: input.channelType,
    chatId: input.chatId,
    messageId: input.messageId,
    currentText: input.currentText,
    currentTimestamp,
    currentActor: input.currentActor,
    evidence,
  });
  let decision = resolveTurnFocus(envelope);

  if (decision.requiresAgentResolution && input.resolver?.resolveTurnFocus) {
    try {
      const rawDecision = await input.resolver.resolveTurnFocus({
        sessionId: input.sessionId,
        channelType: input.channelType,
        chatId: input.chatId,
        currentText: input.currentText,
        envelope,
        deterministicDecision: decision,
        abortSignal: input.abortSignal,
      });
      const validatedDecision = validateAgentTurnFocusDecision(envelope, rawDecision);
      if (validatedDecision) {
        decision = validatedDecision;
      } else {
        console.warn('[context-broker] Turn reference resolver returned an invalid evidence decision');
      }
    } catch (error) {
      // 解析 Agent 是增强层；失败时保留 ambiguous 决策，让主 Agent只追问最小缺口。
      console.warn('[context-broker] Turn reference resolver failed:', error instanceof Error ? error.message : error);
    }
  }

  if (decision.requiresAgentResolution) {
    decision = resolveUnrecoveredReplyFallback(envelope, decision);
  }

  return {
    envelope,
    decision,
    prompt: formatStructuredTurnContext(envelope, decision),
    hasPlatformEvidence: Boolean(
      input.platformEvidence?.length
      || input.mentions?.length
      || input.attachments?.length,
    ),
  };
}
