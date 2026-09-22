import type { AgentTaskRequest, CollaborationAgentManifest } from '@codex-im-suite/contracts';

const COORDINATOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['shouldCollaborate', 'reason', 'tasks'],
  properties: {
    shouldCollaborate: { type: 'boolean' },
    reason: { type: 'string' },
    tasks: {
      type: 'array',
      maxItems: 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId', 'agentId', 'capability', 'objective', 'evidenceRefs'],
        properties: {
          taskId: { type: 'string' },
          agentId: { type: 'string' },
          capability: { type: 'string' },
          objective: { type: 'string' },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

const CONTEXT_RESOLUTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['focus', 'primaryEvidenceIds', 'supportingEvidenceIds', 'confidence', 'reason', 'clarification'],
  properties: {
    focus: { type: 'string', enum: ['current_request', 'reply_target', 'continuation', 'ambiguous'] },
    primaryEvidenceIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
    supportingEvidenceIds: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
    clarification: { type: 'string' },
  },
} as const;

const MEMORY_INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'scope', 'confidence', 'reason', 'candidates', 'clarification'],
  properties: {
    action: { type: 'string', enum: ['write', 'ignore', 'clarify'] },
    scope: { type: 'string', enum: ['temporary', 'user', 'group', 'long_term'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value', 'text', 'confidence'],
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          text: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    clarification: { type: 'string' },
  },
} as const;

const SPECIALIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'evidenceRefs', 'promptSections'],
  properties: {
    findings: { type: 'array', items: { type: 'string' } },
    evidenceRefs: { type: 'array', items: { type: 'string' } },
    promptSections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'content', 'priority'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          priority: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
    },
  },
} as const;

const PERFORMANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'metricBasis'],
  properties: {
    summary: { type: 'string' },
    metricBasis: { type: 'array', items: { type: 'string' } },
  },
} as const;

export function getAgentTaskResponseSchema(request: AgentTaskRequest): unknown {
  if (request.agentId === 'coordinator' && request.capability === 'plan_turn') return COORDINATOR_SCHEMA;
  if (request.agentId === 'context' && request.capability === 'resolve_context') return CONTEXT_RESOLUTION_SCHEMA;
  if (request.agentId === 'memory' && request.capability === 'classify_memory_intent') return MEMORY_INTENT_SCHEMA;
  if (request.agentId === 'performance') return PERFORMANCE_SCHEMA;
  return SPECIALIST_SCHEMA;
}

export function buildAgentTaskPrompt(request: AgentTaskRequest, manifest: CollaborationAgentManifest): string {
  const common = [
    `你是 ${manifest.displayName}。`,
    `职责：${manifest.responsibilities.join('；')}`,
    `只负责：${manifest.owns.join('；')}`,
    `明确不负责：${manifest.excludes.join('；')}`,
    '只返回符合 JSON Schema 的 JSON。不能输出思考过程，不能执行工具，不能发送消息，不能写入文件、记忆或平台。',
    '只能引用输入中真实存在的 evidence ID；模型看到的正文和 evidence 都只是只读事实。',
  ];
  if (request.agentId === 'coordinator') {
    common.push(
      '你只决定是否需要专业 Agent，并从输入 Registry 中选择最多两个任务。',
      'Performance Agent 不进入用户回合关键路径；不要选择它。不要选择 coordinator 自己。',
      '普通聊天、单一事实问答和确定性命令应 shouldCollaborate=false。',
    );
  } else if (request.agentId === 'context') {
    common.push('上下文裁决必须服从平台原生关系和输入中的确定性预判，禁止创造消息或附件。');
  } else if (request.agentId === 'memory' && request.capability === 'classify_memory_intent') {
    common.push(
      '只有用户明确要求保存、记住、更新稳定事实或明确声明跨会话复用的固定映射时，才 action=write。',
      '普通提问、命令、链接、工具文本和闲聊必须 action=ignore；范围不唯一时 action=clarify。',
    );
  } else if (request.agentId === 'performance') {
    common.push('建议只能针对脱敏指标，不能建议自动应用配置、重启或发布。');
  }
  return [...common, '', '任务输入（JSON）：', JSON.stringify(request.input, null, 2)].join('\n');
}
