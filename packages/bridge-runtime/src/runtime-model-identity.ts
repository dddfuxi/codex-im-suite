import { getAgentPolicyPromptLines } from 'claude-to-im/architecture';

/** Runtime-only evidence, captured from the same options sent to the provider. */
export interface RuntimeModelIdentity {
  submittedModel?: string;
  modelSource?: string;
}

export function buildRuntimeModelIdentityPrompt(identity?: RuntimeModelIdentity): string {
  const model = identity?.submittedModel?.trim();
  // A malformed or oversized identifier cannot become model-facing instructions.
  const submittedModel = model && /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,199}$/u.test(model)
    ? model
    : null;
  const modelSource = ['official', 'external_api', 'local_api'].includes(identity?.modelSource || '')
    ? identity!.modelSource
    : null;
  return [
    'Runtime model identity (current request evidence):',
    JSON.stringify({ submittedModel, modelSource, evidenceLevel: submittedModel ? 'submitted' : 'unknown' }),
    ...getAgentPolicyPromptLines(['agent_kernel.runtime_model_identity']),
  ].join('\n');
}
