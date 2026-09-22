import crypto from 'node:crypto';

export type CodexProviderProfile = 'primary' | 'official' | 'external' | 'local_primary';
export type CodexModelSource = 'official' | 'external_api' | 'local_api';
export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type CodexExecutionOverrideReason = 'restricted_interaction';

export interface CodexExecutionProfileInput {
  providerProfile: CodexProviderProfile;
  configuredModelSource?: string;
  configuredModel?: string;
  localModel?: string;
  configuredReasoningEffort?: string;
  baseUrl?: string;
  restrictedInteraction?: boolean;
}

export interface CodexExecutionProfile {
  providerProfile: CodexProviderProfile;
  modelSource: CodexModelSource;
  requestedModel?: string;
  submittedModel?: string;
  modelMode: 'source_default' | 'explicit';
  requestedReasoningEffort: CodexReasoningEffort;
  submittedReasoningEffort: CodexReasoningEffort;
  overrideReason?: CodexExecutionOverrideReason;
  baseUrl?: string;
  fingerprint: string;
}

export function normalizeCodexReasoningEffort(value?: string): CodexReasoningEffort {
  const normalized = (value || 'low').trim().toLowerCase();
  return normalized === 'minimal'
    || normalized === 'low'
    || normalized === 'medium'
    || normalized === 'high'
    || normalized === 'xhigh'
    ? normalized
    : 'low';
}

export function resolveCodexModelSource(input: Pick<CodexExecutionProfileInput, 'providerProfile' | 'configuredModelSource'>): CodexModelSource {
  if (input.providerProfile === 'official') return 'official';
  if (input.providerProfile === 'external') return 'external_api';
  if (input.providerProfile === 'local_primary') return 'local_api';
  const configured = (input.configuredModelSource || '').trim().toLowerCase();
  return configured === 'local_api' || configured === 'external_api'
    ? configured
    : 'official';
}

/**
 * 只把端点身份写入 fingerprint；查询参数可能包含 token，不能进入哈希输入或审计。
 */
function normalizeEndpointIdentity(baseUrl?: string): string {
  if (!baseUrl?.trim()) return '';
  try {
    const url = new URL(baseUrl);
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return baseUrl.trim().split(/[?#]/, 1)[0];
  }
}

export function createCodexExecutionProfile(input: CodexExecutionProfileInput): CodexExecutionProfile {
  const modelSource = resolveCodexModelSource(input);
  const requestedModel = (
    modelSource === 'local_api'
      ? input.localModel
      : input.configuredModel
  )?.trim() || undefined;
  const requestedReasoningEffort = normalizeCodexReasoningEffort(input.configuredReasoningEffort);
  const restrictedInteraction = input.restrictedInteraction === true;
  const submittedReasoningEffort = restrictedInteraction ? 'low' : requestedReasoningEffort;
  const normalizedBaseUrl = input.baseUrl?.trim() || undefined;
  const fingerprintPayload = JSON.stringify({
    providerProfile: input.providerProfile,
    modelSource,
    model: requestedModel || 'source_default',
    reasoningEffort: submittedReasoningEffort,
    endpoint: normalizeEndpointIdentity(normalizedBaseUrl),
  });

  return {
    providerProfile: input.providerProfile,
    modelSource,
    requestedModel,
    submittedModel: requestedModel,
    modelMode: requestedModel ? 'explicit' : 'source_default',
    requestedReasoningEffort,
    submittedReasoningEffort,
    ...(restrictedInteraction ? { overrideReason: 'restricted_interaction' as const } : {}),
    ...(normalizedBaseUrl ? { baseUrl: normalizedBaseUrl } : {}),
    fingerprint: crypto.createHash('sha256').update(fingerprintPayload).digest('hex').slice(0, 16),
  };
}
