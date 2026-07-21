/**
 * Agent architecture registry.
 *
 * This module is intentionally declarative: it gives the bridge one generic
 * place to classify responsibilities before behavior is gradually migrated
 * out of manager, adapter, prompt, and runtime files.
 */

export const AGENT_ARCHITECTURE_LAYER_IDS = [
  'agent_kernel',
  'policy_registry',
  'context_broker',
  'capability_router',
  'memory_system',
  'scratchpad',
  'prompt_composer',
  'delivery_layer',
] as const;

export type AgentArchitectureLayerId = typeof AGENT_ARCHITECTURE_LAYER_IDS[number];

export interface AgentArchitectureLayer {
  id: AgentArchitectureLayerId;
  title: string;
  responsibility: string;
  owns: readonly string[];
  excludes: readonly string[];
}

export interface AgentPolicyDefinition {
  id: string;
  layerId: AgentArchitectureLayerId;
  title: string;
  responsibility: string;
  promptLines: readonly string[];
  tags: readonly string[];
}

export type SuitePathCategoryId =
  | 'development_repo'
  | 'live_skill'
  | 'memory_repo'
  | 'runtime_data'
  | 'temporary_upload_cache'
  | 'documentation'
  | 'rules'
  | 'logs'
  | 'release_artifact'
  | 'unknown';

export interface SuitePathCategory {
  id: SuitePathCategoryId;
  title: string;
  responsibility: string;
  writePolicy: string;
}

export interface SuitePathRoots {
  suiteRoot?: string;
  liveSkillRoots?: readonly string[];
  memoryRepoRoots?: readonly string[];
  runtimeDataRoots?: readonly string[];
  logRoots?: readonly string[];
  releaseRoots?: readonly string[];
}

export interface SuitePathClassification {
  categoryId: SuitePathCategoryId;
  category: SuitePathCategory;
  normalizedPath: string;
  matchedRoot?: string;
  reason: string;
}

export interface CompiledAgentArchitectureRegistry {
  layers: readonly AgentArchitectureLayer[];
  policies: readonly AgentPolicyDefinition[];
  pathCategories: readonly SuitePathCategory[];
  layerById: Readonly<Record<AgentArchitectureLayerId, AgentArchitectureLayer>>;
  policyById: Readonly<Record<string, AgentPolicyDefinition>>;
  pathCategoryById: Readonly<Record<SuitePathCategoryId, SuitePathCategory>>;
}

export type SkillSourceClass = 'installed' | 'official_curated' | 'whitelist' | 'self_created' | 'third_party' | 'unknown';
export type SkillRiskLevel = 'low' | 'medium' | 'high';
export type SkillChangeKind = 'none' | 'docs' | 'compatibility' | 'install' | 'enable' | 'trigger' | 'permissions' | 'scripts' | 'write_scope';
export type SkillLifecycleAction = 'use' | 'auto_update' | 'auto_install' | 'confirm_user' | 'confirm_owner' | 'quarantine';

export interface SkillLifecyclePolicyInput {
  installed: boolean;
  sourceClass: SkillSourceClass;
  risk: SkillRiskLevel;
  changeKind: SkillChangeKind;
}

export interface SkillCapabilityGapInput {
  taskRequiresCapability: boolean;
  installedCandidateCount: number;
}

/** External catalog search is allowed only when the current task needs a capability that no installed skill provides. */
export function shouldSearchSkillCatalog(input: SkillCapabilityGapInput): boolean {
  return input.taskRequiresCapability && input.installedCandidateCount === 0;
}

/** Keep lifecycle approval rules platform-independent so Feishu, CLI, and panel callers share one decision. */
export function decideSkillLifecycleAction(input: SkillLifecyclePolicyInput): SkillLifecycleAction {
  if (input.risk === 'high' || ['permissions', 'scripts', 'write_scope'].includes(input.changeKind)) return 'confirm_owner';
  if (input.installed && input.changeKind === 'none') return 'use';
  if (input.installed && ['docs', 'compatibility'].includes(input.changeKind)) return 'auto_update';
  if (input.sourceClass === 'third_party' || input.sourceClass === 'unknown') return 'confirm_owner';
  if (input.changeKind === 'trigger') return 'confirm_user';
  if (input.sourceClass === 'whitelist' && input.risk === 'low') return 'auto_install';
  if (input.sourceClass === 'official_curated' || input.sourceClass === 'self_created') return 'confirm_user';
  return 'quarantine';
}

export const AGENT_ARCHITECTURE_LAYERS: readonly AgentArchitectureLayer[] = [
  {
    id: 'agent_kernel',
    title: 'Agent Kernel',
    responsibility: 'Defines the worker posture, identity-independent behavior contract, execution lifecycle, and completion semantics.',
    owns: ['agent intent/state contract', 'proactive completion posture', 'result truthfulness invariant'],
    excludes: ['platform API details', 'filesystem persistence layout', 'platform-specific rendering'],
  },
  {
    id: 'policy_registry',
    title: 'Policy Registry',
    responsibility: 'Owns reusable permission, safety, evidence, and delivery policies as named rules instead of scattered keyword gates.',
    owns: ['role gates', 'risk levels', 'adaptive evidence decisions', 'tool evidence policy', 'low-risk reminder boundary'],
    excludes: ['adapter event parsing', 'model prompt assembly', 'runtime process supervision'],
  },
  {
    id: 'context_broker',
    title: 'Context Broker',
    responsibility: 'Turns inbound event evidence, reply targets, attachments, history, and platform identity into bounded context packages.',
    owns: ['actor context', 'reply context', 'attachment evidence', 'history snippets'],
    excludes: ['long-term memory storage', 'model source selection', 'outbound card rendering'],
  },
  {
    id: 'capability_router',
    title: 'Capability Router',
    responsibility: 'Selects the required capability family and evidence level for a turn before provider execution.',
    owns: ['execution requirement classification', 'manifest/action matching', 'tool family requirements'],
    excludes: ['provider implementation', 'permission approval persistence', 'final message formatting'],
  },
  {
    id: 'memory_system',
    title: 'Memory System',
    responsibility: 'Stores durable user, chat, global, history, sticker, document, and knowledge evidence with retrieval boundaries.',
    owns: ['memory repository', 'history index', 'knowledge index', 'artifact-backed semantic records'],
    excludes: ['temporary upload staging', 'per-turn scratch notes', 'prompt style text'],
  },
  {
    id: 'scratchpad',
    title: 'Scratchpad',
    responsibility: 'Holds temporary per-turn work products, upload candidates, drafts, and intermediate artifacts before promotion or cleanup.',
    owns: ['temporary upload cache', 'per-turn attachments', 'draft work documents', 'candidate artifacts'],
    excludes: ['durable memory facts', 'release payloads', 'source documentation'],
  },
  {
    id: 'prompt_composer',
    title: 'Prompt Composer',
    responsibility: 'Composes model-facing system/developer/context prompt sections from registered policies and bounded context.',
    owns: ['prompt section ordering', 'policy prompt lines', 'reply style hint', 'result protocol instructions'],
    excludes: ['policy decision logic', 'platform send retries', 'memory indexing'],
  },
  {
    id: 'delivery_layer',
    title: 'Delivery Layer',
    responsibility: 'Owns user-facing output envelopes, card/text/file delivery, chunking, retry, dedup, and outbound references.',
    owns: ['cti-final envelope', 'platform rendering', 'attachment delivery', 'outbound audit references'],
    excludes: ['agent reasoning policy', 'context retrieval', 'capability selection'],
  },
];

export const AGENT_POLICY_REGISTRY: readonly AgentPolicyDefinition[] = [
  {
    id: 'agent_kernel.proactive_completion',
    layerId: 'agent_kernel',
    title: 'Proactive Completion',
    responsibility: 'The agent should safely try the smallest useful action before retreating into tutorials or broad clarification.',
    promptLines: [
      '- Proactive completion policy: attempt the safest useful action that can move the request forward before asking for more input. Use available context, attachments, reply metadata, memory evidence, manifests, and low-risk read/list/check tools first.',
      '- Ask for clarification only for the minimal missing detail that blocks safe execution. If several interpretations are safe, choose the most likely one, state the assumption briefly, and continue.',
      '- When a request cannot be fully completed, keep any verified partial progress in the answer and name the exact blocker plus the smallest next confirmation needed. Do not make the user re-do work that the bridge or agent can safely do.',
    ],
    tags: ['prompt', 'completion', 'default_behavior'],
  },
  {
    id: 'policy_registry.role_gate',
    layerId: 'policy_registry',
    title: 'Role Gate',
    responsibility: 'Route privileged actions through Viewer, Operator, or Owner rules based on effect and evidence, not entry point.',
    promptLines: [],
    tags: ['permission', 'safety'],
  },
  {
    id: 'context_broker.bounded_evidence',
    layerId: 'context_broker',
    title: 'Bounded Evidence',
    responsibility: 'Only inject context that is directly relevant, attributable, and safe for the current turn.',
    promptLines: [],
    tags: ['context', 'history', 'attachments'],
  },
  {
    id: 'context_broker.reference_resolution',
    layerId: 'context_broker',
    title: 'Structured Reference Resolution',
    responsibility: 'Normalize current-message, reply, mention, attachment, history, document, and memory evidence into structured records, then resolve one primary reference focus before provider execution.',
    promptLines: [],
    tags: ['context', 'evidence', 'reply', 'reference', 'resolution'],
  },
  {
    id: 'capability_router.execution_evidence',
    layerId: 'capability_router',
    title: 'Execution Evidence',
    responsibility: 'Require real tool results for local state, artifacts, commands, MCP, Unity, Blender, and filesystem tasks.',
    promptLines: [],
    tags: ['tools', 'evidence', 'routing'],
  },
  {
    id: 'capability_router.skill_catalog_gap_search',
    layerId: 'capability_router',
    title: 'Skill Catalog Gap Search',
    responsibility: 'Search external skill catalogs only for a capability the current task requires and installed skills cannot provide.',
    promptLines: [],
    tags: ['capability', 'skills', 'search', 'routing'],
  },
  {
    id: 'capability_router.existing_sticker_delivery',
    layerId: 'capability_router',
    title: 'Existing Sticker Delivery',
    responsibility: 'A sticker-send request may select only verified existing channel sticker candidates; it must not silently turn into a new image-generation task.',
    promptLines: [
      '- Existing sticker delivery policy: when a chat asks for a sticker, select only an existing, verified sticker candidate actually supplied by the channel context.',
      '- A sticker-send request must not substitute image generation, imagegen, or any other asset-creation tool. Creating a new image is a separate request that requires explicit user intent.',
      '- When channel context already supplies a trusted existing sticker for a generic send request, treat delivery as a bridge-owned action and do not read skills, call tools, or create assets before the bridge sends it.',
      '- If no existing verified sticker is available, reply with the concrete availability boundary instead of inventing, generating, or claiming to send a new sticker.',
    ],
    tags: ['capability', 'stickers', 'delivery', 'asset-boundary'],
  },
  {
    id: 'policy_registry.adaptive_action_decision',
    layerId: 'policy_registry',
    title: 'Adaptive Action Decision',
    responsibility: 'Combine action risk, evidence strength, platform verification, ambiguity, and the configured safety profile without weakening hard identity or high-risk boundaries.',
    promptLines: [],
    tags: ['policy', 'risk', 'evidence', 'adaptive-safety'],
  },
  {
    id: 'policy_registry.outbound_mention_targets',
    layerId: 'policy_registry',
    title: 'Outbound Mention Target Validation',
    responsibility: 'Resolve explicit names, evidence-bound contextual pronouns, and verified bot-to-bot return mentions through current-chat evidence; low-risk same-chat mentions may use auditable strong-evidence degradation while broadcasts, conflicts, unrelated model identities, and invented IDs remain non-addressable.',
    promptLines: [
      '- Outbound mention target policy: a current-turn explicit request to execute @ may use either a concrete display name or one person selected from real current-turn evidence for contextual words such as 他、她、对方、刚才那个人. Delivery verifies by platform ID when available; the balanced/fluent profile may degrade only a low-risk same-chat mention with strong attributable platform evidence when roster lookup is temporarily unavailable.',
      '- Bot-to-bot return mention policy: when another bot/app natively mentions this bot, delivery may mention that sender back only after its sender app_id uniquely maps to a mentionable member_id in the current official chat roster.',
      '- A model may select a real evidence ID but may not create a trusted platform identity. Invented IDs, ordinary bare @ text without evidence binding, unbounded history-only names, broadcast audiences such as 各位、大家、全体、群成员、所有机器人, and unsupported relationship descriptions are not trusted mention targets.',
    ],
    tags: ['policy', 'mentions', 'delivery', 'target-validation'],
  },
  {
    id: 'policy_registry.scheduled_task_actions',
    layerId: 'policy_registry',
    title: 'Scheduled Task Actions',
    responsibility: 'Route one-shot reminders, recurring schedules, dynamic agent turns, and controlled tools through one trusted runtime Host.',
    promptLines: [
      '- Scheduled task action protocol: for periodic, recurring, cron, interval, or dynamic future work, output one fenced ```cti-scheduled-task JSON block. Use action="create", name, schedule, and taskAction; use taskAction.kind="agent_turn" when the future run must inspect current state or produce a fresh result.',
      '- A low-risk one-shot notification may continue to use ```cti-reminder with title, dueAt, timezone, target="current_chat", and sourcePrompt; the bridge converts it into the same unified scheduled task runtime.',
      '- Never place chatId, userId, owner role, sourceSessionId, workingDirectory, additionalDirectories, or platform credentials in either action block. The bridge rebuilds target, actor, session, workspace, and evidence from the current inbound turn.',
      '- Controlled-tool scheduled tasks require Owner authorization and a runtime allowlist. Do not substitute shell, temporary scripts, operating-system schedulers, or handwritten platform APIs.',
      '- Do not claim a reminder, periodic task, scheduled run, or proactive delivery was created unless the scheduled task Host success result is returned for this turn.',
    ],
    tags: ['policy', 'scheduled-task', 'reminder', 'cron', 'delivery'],
  },
  {
    id: 'policy_registry.artifact_promotion',
    layerId: 'policy_registry',
    title: 'Managed Artifact Promotion',
    responsibility: 'Promote only registered turn artifacts into registered writable projects through a strict Owner-gated bridge action.',
    promptLines: [
      '- Managed artifact promotion protocol: only when the current user explicitly asks to copy or save an existing managed turn artifact into a registered project, output one fenced ```cti-artifact-promote JSON block.',
      '- The JSON object must contain only artifactId, targetProjectId, targetRelativePath, and optional expectedSha256. Never include workingDirectory, absolute target paths, user IDs, roles, credentials, or alternate source paths.',
      '- Project writes through cti-artifact-promote are Owner-only. The Artifact Store re-resolves the real artifact and project, verifies Hash and path boundaries, rejects read-only or denied projects, and must not overwrite an existing target.',
      '- Do not claim that an artifact was saved into a project unless the bridge reports a successful promotion result for this turn.',
    ],
    tags: ['policy', 'artifact', 'promotion', 'workspace', 'owner'],
  },
  {
    id: 'memory_system.durable_recall',
    layerId: 'memory_system',
    title: 'Durable Recall',
    responsibility: 'Keep memory retrieval explicit, bounded, and evidence-preserving instead of using memory as a hidden fast answer.',
    promptLines: [],
    tags: ['memory', 'history'],
  },
  {
    id: 'memory_system.partitioned_memory_intent',
    layerId: 'memory_system',
    title: 'Partitioned Memory Intent',
    responsibility: 'Classify each memory operation before storage or retrieval, isolate user/chat/temporary/long-term partitions, and require clarification when scope is not unique.',
    promptLines: [
      '- Memory partition policy: classify the requested memory operation before reading or writing. Keep temporary context, current-user memory, current-group memory, and public long-term memory as separate scopes.',
      '- Never infer a durable scope from a keyword, chat name, display name, or historical text alone. You must not write durable memory unless the classified scope, human source, and concrete fact are verified.',
      '- For IM/bridge memory save requests, Do not use github-memory-protocol and do not write ~/.codex/memory, C:\\Users\\admin\\.codex\\memory, project Markdown files, or chat transcripts as the memory store.',
      '- Only say a fact has been remembered or saved when this turn includes successful controlled memory v3 write evidence from the bridge memory repository. If that evidence is absent, report that it was not saved and ask the smallest clarification or name the blocker.',
      '- If the memory scope, subject, or fact is ambiguous, ask one minimal clarification. Do not write a fallback record, choose a likely owner, or claim that it was saved.',
      '- Retrieved memory is evidence for the primary agent, not a shortcut answer. Preserve scope boundaries and do not reveal another user or chat partition.',
    ],
    tags: ['memory', 'intent', 'partition', 'privacy'],
  },
  {
    id: 'scratchpad.temporary_artifacts',
    layerId: 'scratchpad',
    title: 'Temporary Artifacts',
    responsibility: 'Treat uploads, candidates, and drafts as temporary until promoted into memory, source docs, or delivery attachments.',
    promptLines: [],
    tags: ['scratchpad', 'uploads', 'artifacts'],
  },
  {
    id: 'prompt_composer.section_order',
    layerId: 'prompt_composer',
    title: 'Prompt Section Order',
    responsibility: 'Compose identity, policy, evidence, style, and result protocol sections in a predictable order.',
    promptLines: [],
    tags: ['prompt', 'composition'],
  },
  {
    id: 'delivery_layer.feishu_text_presentation',
    layerId: 'delivery_layer',
    title: 'Feishu Text Presentation',
    responsibility: 'Use Feishu-supported rich text deliberately so structured answers are easier to scan without turning lightweight chat into report templates.',
    promptLines: [
      '- Feishu text presentation policy: when a reply contains two or more independent information groups, divide it into concise sections with bold labels or small headings; keep one short lead sentence before the sections when it helps orientation.',
      '- Use blockquotes (`>`) for exact source text, prior-message excerpts, constraints, or the specific statement being answered. Do not use blockquotes as decorative indentation.',
      '- Use bold for conclusions, statuses, field labels, and actions; use italic for brief caveats or secondary interpretation. Use strikethrough only when showing a real correction or superseded value.',
      '- Underline is not reliably supported by Feishu card Markdown. When underline-like emphasis is genuinely useful, use the supported blue accent plus bold form `<font color=\'blue\'>**text**</font>`; never emit raw `<u>` or `<ins>` tags.',
      '- Prefer lists for parallel items and numbered lists for ordered procedures. Use tables only for genuine field-by-field comparison, not for ordinary prose.',
      '- Keep formatting semantic and sparse: do not stack multiple emphasis styles on the same phrase, do not add empty sections, and do not force headings or lists into short conversational replies.',
    ],
    tags: ['delivery', 'feishu', 'presentation', 'markdown', 'rich-text'],
  },
  {
    id: 'delivery_layer.result_envelope',
    layerId: 'delivery_layer',
    title: 'Result Envelope',
    responsibility: 'Keep final user delivery in cti-final/card/file/image envelopes and strip internal protocols from visible text.',
    promptLines: [],
    tags: ['delivery', 'cti-final', 'attachments'],
  },
];

export type SlashCommandRequiredRole = 'operator' | 'owner';
export type PermissionApprovalRequiredRole = 'operator' | 'owner';

export interface PermissionApprovalEvidence {
  toolName?: unknown;
  toolInputJson?: unknown;
}

const SLASH_COMMAND_REQUIRED_ROLES = new Map<string, SlashCommandRequiredRole>([
  ['/new', 'operator'],
  ['/bind', 'operator'],
  ['/cwd', 'operator'],
  ['/mode', 'operator'],
  ['/status', 'operator'],
  ['/docs', 'operator'],
  ['/projects', 'operator'],
  ['/sessions', 'operator'],
  ['/stop', 'operator'],
  ['/feishu', 'owner'],
]);

export function getSlashCommandRequiredRole(command: string): SlashCommandRequiredRole | null {
  const normalized = (command || '').trim().split(/\s+/u)[0]?.split('@')[0]?.toLowerCase() || '';
  return SLASH_COMMAND_REQUIRED_ROLES.get(normalized) ?? null;
}

function policyTextField(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function normalizePolicyRiskText(value: string): string {
  return value.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const DANGEROUS_CHINESE_ACTION_SOURCE = [
  '删除',
  '删掉',
  '永久删除',
  '物理删除',
  '清空',
  '删库',
  '重置会话',
  '清会话',
  '清记忆',
  '修改代码',
  '改代码',
  '写代码',
  '提交代码',
  '提交变更',
  'git\\s*提交',
  '关机',
  '关闭电脑',
  '关闭屏幕',
  '关掉屏幕',
  '熄屏',
  '锁屏',
  '锁定屏幕',
  '重启电脑',
  '重启机器',
].join('|');

const DANGEROUS_CHINESE_ACTION_AT_START_RE = new RegExp(`^(?:${DANGEROUS_CHINESE_ACTION_SOURCE})`, 'iu');
const DANGEROUS_CHINESE_TRANSITIVE_RE = new RegExp(`^(?:把|将).{0,80}(?:${DANGEROUS_CHINESE_ACTION_SOURCE})`, 'iu');
const LEADING_REQUEST_DIRECTIVE_RE = /^(?:(?:请|帮我|帮忙|麻烦|给我|替我|为我|你|现在|马上|立刻|直接|先|继续|执行|运行|安排|设置|定时|提醒我|提醒一下|叫我|通知我|待会儿|稍后|一会儿|[0-9一二两三四五六七八九十半]+\s*(?:秒|分钟|小时|天)后|今天|明天|后天|今晚|凌晨|早上|上午|中午|下午|晚上)\s*)+/iu;
const ENGLISH_REQUEST_DIRECTIVE_RE = /^(?:(?:please|pls|run|execute|do|perform|start|schedule|now|later|tonight|tomorrow)\s+)+/iu;
const DANGEROUS_COMMAND_AT_START_RE = /^(?:git\s+(?:commit|push|pull|rebase|merge|checkout|switch)\b|npm\s+install\b|pnpm\s+install\b|yarn\s+add\b|rm\s+-rf\b|del\s+\/s\b|remove-item\b|icacls\b|takeown\b|chmod\b|chown\b|drop\s+database\b|truncate\b|shutdown\s*\/[srg]\b|\bshutdown\b)/iu;
const DANGEROUS_ENGLISH_ACTION_AT_START_RE = /^(?:delete|remove|commit|push|pull|rebase|merge|checkout|switch|shutdown|reboot|lock)\b/iu;

function splitDangerousRequestClauses(text: string): string[] {
  return text.split(/[。！？!?；;\n\r]+/u).map((part) => part.trim()).filter(Boolean);
}

function stripLeadingRequestDirectives(text: string): string {
  let remaining = text.trim();
  for (;;) {
    const next = remaining
      .replace(LEADING_REQUEST_DIRECTIVE_RE, '')
      .replace(ENGLISH_REQUEST_DIRECTIVE_RE, '')
      .trim();
    if (next === remaining) return remaining;
    remaining = next;
  }
}

function isDangerousRequestClause(clause: string): boolean {
  const actionable = stripLeadingRequestDirectives(clause);
  if (!actionable) return false;

  // Only gate requests that ask the robot to act; quoted logs or stories
  // mentioning dangerous words should remain evidence for the agent.
  return DANGEROUS_COMMAND_AT_START_RE.test(actionable)
    || DANGEROUS_ENGLISH_ACTION_AT_START_RE.test(actionable)
    || DANGEROUS_CHINESE_ACTION_AT_START_RE.test(actionable)
    || DANGEROUS_CHINESE_TRANSITIVE_RE.test(actionable);
}

export function isDangerousUserRequest(text: string): boolean {
  const normalized = normalizePolicyRiskText(text);
  if (!normalized) return false;
  return splitDangerousRequestClauses(normalized).some(isDangerousRequestClause);
}

export function isHighRiskPermissionToolName(toolName: string): boolean {
  const normalized = normalizePolicyRiskText(toolName);
  if (!normalized) return false;
  if (/^(?:read|view|grep|glob|list|ls|find|search|query|fetch|inspect|status|get|head|tail)(?:\b|[_:.-])/iu.test(normalized)) {
    return false;
  }
  return /(?:^|[_:.\-\s])(?:bash|shell|powershell|cmd|terminal|exec|execute|run|write|edit|multi_edit|patch|apply_patch|delete|remove|move|rename|create|mkdir|upload|send|publish|release|install|uninstall|restart|shutdown|reboot|kill|manage|mutate)(?:$|[_:.\-\s])/iu.test(normalized);
}

export function isHighRiskPermissionInput(toolInputText: string): boolean {
  const normalized = normalizePolicyRiskText(toolInputText);
  if (!normalized) return false;
  if (isDangerousUserRequest(normalized)) return true;

  // Permission input is structured tool evidence, so use broad verb/object
  // patterns here; the user-intent gate has already happened before tool use.
  return /(?:rm\s+-rf|remove-item|del\s+\/[sq]|shutdown\s*\/|reboot\b|restart-computer|stop-computer|git\s+(?:push|commit|rebase|merge|checkout|switch|reset)|npm\s+install|pnpm\s+install|yarn\s+add|pip\s+install|publish|release|deploy|upload|send\s+(?:file|message)|direct[-_ ]?message|conversation[-_ ]?send|write[_-]?file|edit[_-]?file|delete[_-]?(?:file|path)|remove[_-]?(?:file|path)|move[_-]?(?:file|path)|rename[_-]?(?:file|path)|create[_-]?(?:file|directory)|manage_(?:script|asset|scene|gameobject|editor)|execute_(?:code|menu)|运行|执行|写入|修改|删除|移除|重命名|移动|上传|发送文件|私发|跨会话|发布|安装|卸载|重启|关机|关闭屏幕|锁屏)/iu.test(normalized);
}

export function getPermissionApprovalRequiredRole(
  evidence: PermissionApprovalEvidence | null | undefined,
): PermissionApprovalRequiredRole {
  if (!evidence) return 'operator';
  const toolName = policyTextField(evidence.toolName);
  const toolInputText = policyTextField(evidence.toolInputJson);
  return isHighRiskPermissionToolName(toolName) || isHighRiskPermissionInput(`${toolName}\n${toolInputText}`)
    ? 'owner'
    : 'operator';
}

export function isSystemAffectingReminderRequest(rawText: string, reminderTitle = ''): boolean {
  const normalized = normalizePolicyRiskText(`${rawText}\n${reminderTitle}`);
  if (!normalized) return false;
  if (isDangerousUserRequest(normalized)) return true;
  return /(?:发送|发|私发|转发|上传|下载|运行|执行|启动|停止|重启|关闭|打开).{0,16}(?:文件|命令|脚本|程序|服务|屏幕|应用|电脑|机器|链接|附件)/iu.test(normalized)
    || /(?:文件|命令|脚本|程序|服务|屏幕|应用|电脑|机器|附件).{0,16}(?:发送|私发|转发|上传|下载|运行|执行|启动|停止|重启|关闭|打开)/iu.test(normalized)
    || /(?:shutdown|reboot|restart-computer|stop-computer|lock\s*(?:screen|workstation)|rundll32\.exe|nircmd|powershell|cmd\.exe|bash|shell|rm\s+-rf|remove-item|git\s+(?:push|commit|rebase|merge|reset)|npm\s+install|pnpm\s+install|yarn\s+add|pip\s+install)/iu.test(normalized);
}

/**
 * Broadcast audiences and instruction objects describe who should read or how
 * to answer; neither identifies one account that an adapter can mention.
 */
export function isNonAddressableMentionTarget(value: string): boolean {
  const normalized = (value || '')
    .normalize('NFKC')
    .replace(/^[@＠]+/u, '')
    .replace(/[\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, '')
    .trim()
    .toLocaleLowerCase();
  if (!normalized) return true;

  const chineseBroadcastAudience = /^(?:各位|诸位|大家|全体|所有|全部|本群|群里|群内|当前群|在场|每位|每个)(?:的?(?:其他|其余|所有|全部|当前|在场))*(?:的)?(?:(?:飞书|群内|本群|当前群))?(?:(?:成员|群成员|机器人|智能体|agent|bot|应用|用户|人))?$/iu;
  const chineseInstructionObject = /^(?:按(?:照)?|根据|依照|以|用|照|遵循|参照)(?:(?:这|此|本|该|上|下|以上|以下|如下|前述|给定|要求|指定|对应|这个|那个|格式|模板|规则|方式|内容|说明|步骤|问题|答案|要求))+$/iu;
  const englishBroadcastAudience = /^(?:everyone|everybody|all|allmembers|allusers|allbots|thegroup|groupmembers|members|bots|agents)$/iu;
  return chineseBroadcastAudience.test(normalized)
    || chineseInstructionObject.test(normalized)
    || englishBroadcastAudience.test(normalized);
}

export const SUITE_PATH_CATEGORIES: readonly SuitePathCategory[] = [
  {
    id: 'development_repo',
    title: 'Development Repository',
    responsibility: 'Source of truth for code, tests, manifests, scripts, and maintained project docs.',
    writePolicy: 'Agents may edit this workspace when the task targets the development suite.',
  },
  {
    id: 'live_skill',
    title: 'Live Skill',
    responsibility: 'Generated running copy consumed by the local Codex/IM bridge.',
    writePolicy: 'Only sync scripts should write here; do not hand-edit runtime copies.',
  },
  {
    id: 'memory_repo',
    title: 'Memory Repository',
    responsibility: 'Durable knowledge, reminders, document memory, and long-term semantic evidence.',
    writePolicy: 'Write only through memory/index/reminder APIs that preserve provenance.',
  },
  {
    id: 'runtime_data',
    title: 'Runtime Data',
    responsibility: 'Operational state such as sessions, bindings, workflow runs, permission links, and transient service state.',
    writePolicy: 'Runtime services own these files; tests must redirect roots to temporary directories.',
  },
  {
    id: 'temporary_upload_cache',
    title: 'Temporary Upload Cache',
    responsibility: 'Short-lived files and candidates awaiting validation, delivery, or promotion.',
    writePolicy: 'May be read for evidence; only promote validated artifacts into memory or delivery outputs.',
  },
  {
    id: 'documentation',
    title: 'Documentation',
    responsibility: 'User- and maintainer-facing Markdown that explains current architecture, entry points, or development state.',
    writePolicy: 'Keep in the approved documentation files unless the user explicitly asks for a new document.',
  },
  {
    id: 'rules',
    title: 'Rules And Manifests',
    responsibility: 'Agent maintenance rules, manifests, policy configuration, and extension catalogs.',
    writePolicy: 'Edit as source-controlled policy/configuration, never as a one-off live workaround.',
  },
  {
    id: 'logs',
    title: 'Logs',
    responsibility: 'Append-only or generated diagnostics used to verify runtime behavior.',
    writePolicy: 'Read for evidence; avoid committing or rewriting operational logs.',
  },
  {
    id: 'release_artifact',
    title: 'Release Artifact',
    responsibility: 'Generated portable, installer, zip, and payload outputs.',
    writePolicy: 'Generated by release scripts; do not manually patch as source.',
  },
  {
    id: 'unknown',
    title: 'Unknown',
    responsibility: 'Path is outside the known suite, runtime, memory, log, live, or release roots.',
    writePolicy: 'Do not write until a caller supplies an explicit root and owner.',
  },
];

function uniqueById<T extends { id: string }>(items: readonly T[], label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`Duplicate ${label} id: ${item.id}`);
    seen.add(item.id);
  }
}

function buildRecord<T extends { id: string }>(items: readonly T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item])) as Record<string, T>;
}

export function compileAgentArchitectureRegistry(): CompiledAgentArchitectureRegistry {
  uniqueById(AGENT_ARCHITECTURE_LAYERS, 'agent architecture layer');
  uniqueById(AGENT_POLICY_REGISTRY, 'agent policy');
  uniqueById(SUITE_PATH_CATEGORIES, 'suite path category');

  const layerById = buildRecord(AGENT_ARCHITECTURE_LAYERS) as Record<AgentArchitectureLayerId, AgentArchitectureLayer>;
  for (const id of AGENT_ARCHITECTURE_LAYER_IDS) {
    if (!layerById[id]) throw new Error(`Missing required agent architecture layer: ${id}`);
  }
  for (const policy of AGENT_POLICY_REGISTRY) {
    if (!layerById[policy.layerId]) {
      throw new Error(`Policy ${policy.id} references unknown layer ${policy.layerId}`);
    }
  }

  return {
    layers: AGENT_ARCHITECTURE_LAYERS,
    policies: AGENT_POLICY_REGISTRY,
    pathCategories: SUITE_PATH_CATEGORIES,
    layerById,
    policyById: buildRecord(AGENT_POLICY_REGISTRY),
    pathCategoryById: buildRecord(SUITE_PATH_CATEGORIES) as Record<SuitePathCategoryId, SuitePathCategory>,
  };
}

function normalizePathForCompare(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/u, '')
    .toLowerCase();
}

function normalizeDisplayPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/u, '');
}

function isInsidePath(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePathForCompare(candidate);
  const normalizedRoot = normalizePathForCompare(root);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function findMatchingRoot(candidate: string, roots?: readonly string[]): string | undefined {
  return roots?.find((root) => root.trim() && isInsidePath(candidate, root));
}

function hasPathSegment(candidate: string, segment: string): boolean {
  return normalizePathForCompare(candidate).split('/').includes(segment.toLowerCase());
}

function getSuiteRelativePath(candidate: string, suiteRoot?: string): string {
  const normalized = normalizeDisplayPath(candidate);
  if (suiteRoot && isInsidePath(normalized, suiteRoot)) {
    const root = normalizeDisplayPath(suiteRoot);
    return normalized.slice(root.length).replace(/^\/+/u, '');
  }
  return normalized.replace(/^\.\//u, '');
}

function classifyRelativeSuitePath(relativePath: string): SuitePathCategoryId | null {
  const normalized = normalizePathForCompare(relativePath);
  if (!normalized) return 'development_repo';
  if (normalized === 'agents.md' || normalized === 'claude.md' || normalized === 'gemini.md') return 'rules';
  if (normalized.startsWith('config/') || normalized.startsWith('.agents/') || normalized.startsWith('.codex/')) return 'rules';
  if (normalized.startsWith('docs/') || normalized === 'readme.md') return 'documentation';
  if (normalized.startsWith('release/')) return 'release_artifact';
  return null;
}

export function classifySuitePath(candidatePath: string, roots: SuitePathRoots = {}): SuitePathClassification {
  const registry = compileAgentArchitectureRegistry();
  const normalizedPath = normalizeDisplayPath(candidatePath);

  const make = (categoryId: SuitePathCategoryId, reason: string, matchedRoot?: string): SuitePathClassification => ({
    categoryId,
    category: registry.pathCategoryById[categoryId],
    normalizedPath,
    matchedRoot,
    reason,
  });

  // Upload caches can appear under a workspace, session binding, or live runtime.
  if (hasPathSegment(normalizedPath, '.codepilot-uploads')) {
    return make('temporary_upload_cache', 'path contains a .codepilot-uploads segment');
  }

  const logRoot = findMatchingRoot(normalizedPath, roots.logRoots);
  if (logRoot) return make('logs', 'path is under a configured log root', logRoot);

  const runtimeRoot = findMatchingRoot(normalizedPath, roots.runtimeDataRoots);
  if (runtimeRoot) return make('runtime_data', 'path is under a configured runtime data root', runtimeRoot);

  const memoryRoot = findMatchingRoot(normalizedPath, roots.memoryRepoRoots);
  if (memoryRoot) return make('memory_repo', 'path is under a configured memory repository root', memoryRoot);

  const liveRoot = findMatchingRoot(normalizedPath, roots.liveSkillRoots);
  if (liveRoot) return make('live_skill', 'path is under a configured live skill root', liveRoot);

  const releaseRoot = findMatchingRoot(normalizedPath, roots.releaseRoots);
  if (releaseRoot) return make('release_artifact', 'path is under a configured release artifact root', releaseRoot);

  if (roots.suiteRoot && isInsidePath(normalizedPath, roots.suiteRoot)) {
    const relative = getSuiteRelativePath(normalizedPath, roots.suiteRoot);
    const suiteCategory = classifyRelativeSuitePath(relative);
    return make(suiteCategory || 'development_repo', suiteCategory ? `suite-relative path ${relative} has a specialized category` : 'path is under the development suite root', roots.suiteRoot);
  }

  const relativeCategory = classifyRelativeSuitePath(normalizedPath);
  if (relativeCategory) return make(relativeCategory, 'relative suite path has a specialized category');

  return make('unknown', 'path did not match any configured suite, live, memory, runtime, log, or release root');
}

export function getAgentPolicyPromptLines(policyIds: readonly string[]): string[] {
  const registry = compileAgentArchitectureRegistry();
  const lines: string[] = [];
  for (const policyId of policyIds) {
    const policy = registry.policyById[policyId];
    if (!policy) throw new Error(`Unknown agent policy: ${policyId}`);
    lines.push(...policy.promptLines);
  }
  return lines;
}
