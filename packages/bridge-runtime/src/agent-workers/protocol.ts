import type {
  AgentPromptSection,
  AgentTaskRequest,
  AgentTaskResult,
  AgentTurnPlan,
  CollaborationAgentManifest,
} from '@codex-im-suite/contracts';

import type { AgentManifestRegistry } from './manifest-registry.js';

const FORBIDDEN_KEY_RE = /(?:token|secret|credential|password|cookie|authorization|role|permission|recipient|target(?:id)?|chatid|openid|userid|unionid|workspace|workingdirectory|cwd|absolutepath|filepath|command|tool(?:call|action)?|send|deliver|write|delete|publish)/iu;

function hasForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 8 || value == null) return false;
  if (Array.isArray(value)) return value.some((item) => hasForbiddenKey(item, depth + 1));
  if (typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => (
    FORBIDDEN_KEY_RE.test(key) || hasForbiddenKey(child, depth + 1)
  ));
}

function uniqueStrings(value: unknown, limit: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/\s+/gu, ' ').trim().slice(0, maxChars))
    .filter(Boolean))].slice(0, limit);
}

function normalizePromptSections(value: unknown): AgentPromptSection[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content.trim().slice(0, 6_000) : '';
    if (!content) return [];
    return [{
      id: typeof record.id === 'string' && record.id.trim() ? record.id.trim().slice(0, 120) : `collaboration.section.${index + 1}`,
      title: typeof record.title === 'string' ? record.title.trim().slice(0, 120) : '专业 Agent 结论',
      content,
      priority: typeof record.priority === 'number' && Number.isFinite(record.priority)
        ? Math.max(1, Math.min(100, Math.floor(record.priority)))
        : 25,
    }];
  }).slice(0, 4);
}

export function validateAgentTaskRequest(
  request: AgentTaskRequest,
  registry: AgentManifestRegistry,
): { ok: true; manifest: CollaborationAgentManifest } | { ok: false; errorCode: string } {
  if (request.protocol !== 'codex-im-suite/agent-worker/v1') return { ok: false, errorCode: 'invalid_protocol' };
  const manifest = registry.byId.get(request.agentId);
  if (!manifest || !manifest.enabled) return { ok: false, errorCode: 'unknown_or_disabled_agent' };
  if (!manifest.capabilities.includes(request.capability)) return { ok: false, errorCode: 'unsupported_capability' };
  if (manifest.sideEffectLevel !== 'none') return { ok: false, errorCode: 'side_effect_manifest_rejected' };
  if (!request.runId || !request.turnId || !request.taskId) return { ok: false, errorCode: 'missing_identity' };
  if (!Array.isArray(request.evidenceRefs) || request.evidenceRefs.some((item) => typeof item !== 'string')) {
    return { ok: false, errorCode: 'invalid_evidence_refs' };
  }
  if (!request.input || typeof request.input !== 'object' || hasForbiddenKey(request.input)) {
    return { ok: false, errorCode: 'forbidden_task_input' };
  }
  if (!Number.isFinite(Date.parse(request.deadlineAt))) return { ok: false, errorCode: 'invalid_deadline' };
  return { ok: true, manifest };
}

export function validateAgentTurnPlan(
  output: unknown,
  registry: AgentManifestRegistry,
  allowedEvidenceIds: ReadonlySet<string>,
  maxSpecialists: number,
): AgentTurnPlan | null {
  if (!output || typeof output !== 'object') return null;
  const source = output as Record<string, unknown>;
  if (typeof source.shouldCollaborate !== 'boolean' || typeof source.reason !== 'string' || !Array.isArray(source.tasks)) return null;
  const tasks = source.tasks.slice(0, Math.max(1, Math.min(2, maxSpecialists))).flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const task = item as Record<string, unknown>;
    const agentId = typeof task.agentId === 'string' ? task.agentId.trim() : '';
    const capability = typeof task.capability === 'string' ? task.capability.trim() : '';
    const manifest = registry.byId.get(agentId);
    const evidenceRefs = uniqueStrings(task.evidenceRefs, 24, 160);
    if (
      !manifest
      || !manifest.enabled
      || agentId === 'coordinator'
      || agentId === 'performance'
      || !manifest.capabilities.includes(capability)
      || evidenceRefs.some((id) => !allowedEvidenceIds.has(id))
    ) return [];
    return [{
      taskId: typeof task.taskId === 'string' && task.taskId.trim() ? task.taskId.trim().slice(0, 120) : `specialist-${index + 1}`,
      agentId,
      capability,
      objective: typeof task.objective === 'string' ? task.objective.trim().slice(0, 600) : '',
      evidenceRefs,
    }];
  });
  if (source.shouldCollaborate && tasks.length === 0) return null;
  return {
    protocol: 'codex-im-suite/agent-collaboration/v1',
    shouldCollaborate: source.shouldCollaborate,
    reason: source.reason.trim().slice(0, 600),
    tasks,
  };
}

export function normalizeAgentTaskResult(
  request: AgentTaskRequest,
  output: unknown,
  metrics: AgentTaskResult['metrics'],
  allowedEvidenceIds: ReadonlySet<string>,
): AgentTaskResult {
  const source = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  if (hasForbiddenKey(source)) {
    return {
      protocol: 'codex-im-suite/agent-worker/v1',
      runId: request.runId,
      turnId: request.turnId,
      taskId: request.taskId,
      agentId: request.agentId,
      capability: request.capability,
      status: 'failed',
      findings: [],
      evidenceRefs: [],
      promptSections: [],
      metrics,
      errorCode: 'forbidden_agent_output',
      errorSummary: '专业 Agent 返回了副作用、权限、路径或投递声明。',
    };
  }
  const evidenceRefs = uniqueStrings(
    source.evidenceRefs ?? source.primaryEvidenceIds ?? request.evidenceRefs,
    24,
    160,
  ).filter((id) => allowedEvidenceIds.has(id));
  return {
    protocol: 'codex-im-suite/agent-worker/v1',
    runId: request.runId,
    turnId: request.turnId,
    taskId: request.taskId,
    agentId: request.agentId,
    capability: request.capability,
    status: 'succeeded',
    findings: uniqueStrings(source.findings, 12, 800),
    evidenceRefs,
    promptSections: normalizePromptSections(source.promptSections),
    output: source,
    metrics,
  };
}
