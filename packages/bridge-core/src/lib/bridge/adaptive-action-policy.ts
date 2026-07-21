/**
 * 通用的“动作风险 × 证据强度”裁决协议。
 *
 * 该模块只做纯策略判断，不读取配置、平台 API 或文件系统。调用方必须先把
 * 模型输出降级为候选，再用本轮真实 evidence 与平台结果构造输入。
 */
export type AdaptiveSafetyProfile = 'strict' | 'balanced' | 'fluent';

export type AdaptiveActionRisk = 'low' | 'reversible' | 'external' | 'high';

export type AdaptiveEvidenceStrength = 'strong' | 'reliable' | 'weak' | 'untrusted';

export type AdaptiveVerificationStatus =
  | 'verified'
  | 'conflict'
  | 'not_found'
  | 'unavailable'
  | 'failed'
  | 'not_required';

export type AdaptivePolicyDecisionKind =
  | 'allow'
  | 'allow_with_audit'
  | 'clarify'
  | 'confirm'
  | 'deny';

export interface AdaptiveActionPolicyInput {
  profile: AdaptiveSafetyProfile;
  risk: AdaptiveActionRisk;
  evidence: AdaptiveEvidenceStrength;
  verification: AdaptiveVerificationStatus;
  /** 多个同级候选或证据互相冲突时，不能靠放宽档位猜目标。 */
  ambiguous?: boolean;
}

export interface AdaptiveActionPolicyDecision {
  decision: AdaptivePolicyDecisionKind;
  reasonCode:
    | 'ambiguous_target'
    | 'untrusted_evidence'
    | 'identity_conflict'
    | 'identity_not_found'
    | 'high_risk_confirmation'
    | 'external_effect_confirmation'
    | 'reversible_verified'
    | 'reversible_confirmation'
    | 'verified_low_risk'
    | 'strong_evidence_degraded'
    | 'reliable_evidence_degraded'
    | 'strict_verification_required'
    | 'weak_evidence_clarification';
}

export function normalizeAdaptiveSafetyProfile(value: string | null | undefined): AdaptiveSafetyProfile {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'strict' || normalized === 'fluent') return normalized;
  return 'balanced';
}

/**
 * 低风险动作允许在强平台 evidence 下进行可审计降级；高风险、跨边界动作仍保留确认。
 * “流畅”只扩大可靠 evidence 的低风险降级，不会接受伪造 ID、身份冲突或真实歧义。
 */
export function decideAdaptiveActionPolicy(
  input: AdaptiveActionPolicyInput,
): AdaptiveActionPolicyDecision {
  if (input.ambiguous) return { decision: 'clarify', reasonCode: 'ambiguous_target' };
  if (input.evidence === 'untrusted') return { decision: 'deny', reasonCode: 'untrusted_evidence' };
  if (input.verification === 'conflict') return { decision: 'deny', reasonCode: 'identity_conflict' };
  if (input.verification === 'not_found') return { decision: 'deny', reasonCode: 'identity_not_found' };

  if (input.risk === 'high') {
    return { decision: 'confirm', reasonCode: 'high_risk_confirmation' };
  }
  if (input.risk === 'external') {
    return { decision: 'confirm', reasonCode: 'external_effect_confirmation' };
  }
  if (input.risk === 'reversible') {
    return input.verification === 'verified'
      ? { decision: 'allow_with_audit', reasonCode: 'reversible_verified' }
      : { decision: 'confirm', reasonCode: 'reversible_confirmation' };
  }

  if (input.verification === 'verified') {
    return { decision: 'allow', reasonCode: 'verified_low_risk' };
  }
  if (input.evidence === 'weak') {
    return { decision: 'clarify', reasonCode: 'weak_evidence_clarification' };
  }
  if (input.profile === 'strict') {
    return { decision: 'deny', reasonCode: 'strict_verification_required' };
  }
  if (input.evidence === 'strong') {
    return { decision: 'allow_with_audit', reasonCode: 'strong_evidence_degraded' };
  }
  if (input.profile === 'fluent' && input.evidence === 'reliable') {
    return { decision: 'allow_with_audit', reasonCode: 'reliable_evidence_degraded' };
  }
  return { decision: 'clarify', reasonCode: 'weak_evidence_clarification' };
}
