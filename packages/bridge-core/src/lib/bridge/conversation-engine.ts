/**
 * Conversation Engine — processes inbound IM messages through Claude.
 *
 * Takes a ChannelBinding + inbound message, calls the LLM provider,
 * consumes the SSE stream server-side, saves messages to DB,
 * and returns the response text for delivery.
 */

import fs from 'fs';
import path from 'path';
import type { ChannelBinding, RunSummary } from './types.js';
import type {
  FileAttachment,
  SSEEvent,
  TokenUsage,
  MessageContentBlock,
  RetrievedMemoryContext,
  RetrievedFeishuHistoryContext,
  MemoryQueryPlan,
} from './host.js';
import { getBridgeContext } from './context.js';
import crypto from 'crypto';
import { splitWorkspacePathList } from './security/validators.js';
import {
  buildExecutionRequirementPrompt,
  buildNoEvidenceRetryPrompt,
  buildNoExecutionEvidenceText,
  classifyExecutionRequirement,
  classifyToolResultQuality,
  isExecutionEvidenceSatisfied,
  requiresSuccessfulToolEvidence,
  shouldReplaceWithNoExecutionEvidenceText,
  type ExecutionRequirement,
} from './execution-requirement.js';

export interface PermissionRequestInfo {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: unknown[];
}

/**
 * Callback invoked immediately when a permission_request SSE event arrives.
 * This breaks the deadlock: the stream blocks until the permission is resolved,
 * so we must forward the request to the IM *during* stream consumption,
 * not after it returns.
 */
export type OnPermissionRequest = (perm: PermissionRequestInfo) => Promise<void>;

/**
 * Callback invoked on each `text` SSE event with the full accumulated text so far.
 * Must return synchronously — the bridge-manager handles throttling and fire-and-forget.
 */
export type OnPartialText = (fullText: string) => void;

/**
 * Callback invoked when tool_use or tool_result SSE events arrive.
 * Used by bridge-manager to forward tool progress to adapters for real-time display.
 */
export type OnToolEvent = (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => void;

export interface ConversationResult {
  responseText: string;
  tokenUsage: TokenUsage | null;
  runSummary: RunSummary;
  hasError: boolean;
  errorMessage: string;
  /** Permission request events that were forwarded during streaming */
  permissionRequests: PermissionRequestInfo[];
  /** SDK session ID captured from status/result events, for session resume */
  sdkSessionId: string | null;
  /** Whether the next turn should start a fresh SDK thread while keeping local history. */
  shouldRefreshSession: boolean;
  executionEvidence: {
    toolUseCount: number;
    toolResultCount: number;
    successfulToolResultCount: number;
    failedToolResultCount: number;
    failedToolErrors?: string[];
    toolNames: string[];
    permissionRequestCount: number;
    requiredEvidenceKind?: ExecutionRequirement['kind'];
    evidenceSatisfied?: boolean;
    noEvidenceRetryAttempted?: boolean;
    requiredToolFamilies?: string[];
  };
}

interface InternalConversationResult extends ConversationResult {
  assistantStorageContent?: string;
  assistantStorageTokenUsage?: TokenUsage | null;
}

export interface ConversationProcessOptions {
  storedUserText?: string;
  historyLimit?: number;
  memoryMode?: 'auto' | 'off' | 'recall' | 'augment';
  extraSystemPrompt?: string;
  memoryPlan?: MemoryQueryPlan;
  memoryUserId?: string;
  memoryUserDisplayName?: string;
  sourceMessageId?: string;
  sourceChannelType?: string;
  sourceChatId?: string;
  sourceThreadId?: string;
  messageKind?: string;
}

function emptyExecutionEvidence(requirement?: ExecutionRequirement, noEvidenceRetryAttempted = false): ConversationResult['executionEvidence'] {
  return {
    toolUseCount: 0,
    toolResultCount: 0,
    successfulToolResultCount: 0,
    failedToolResultCount: 0,
    failedToolErrors: [],
    toolNames: [],
    permissionRequestCount: 0,
    ...(requirement ? {
      requiredEvidenceKind: requirement.kind,
      evidenceSatisfied: requirement.kind === 'none',
      noEvidenceRetryAttempted,
      requiredToolFamilies: requirement.requiredToolFamilies,
    } : {}),
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeTokenUsage(value: unknown): RunSummary['tokenUsage'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const input = readOptionalNumber(source.input_tokens);
  const output = readOptionalNumber(source.output_tokens);
  const cacheRead = readOptionalNumber(source.cache_read_input_tokens);
  const cacheCreation = readOptionalNumber(source.cache_creation_input_tokens);
  const total = readOptionalNumber(source.total_tokens)
    ?? (input !== undefined || output !== undefined ? (input || 0) + (output || 0) : undefined);
  const usage: NonNullable<RunSummary['tokenUsage']> = {};
  if (input !== undefined) usage.input_tokens = input;
  if (output !== undefined) usage.output_tokens = output;
  if (cacheRead !== undefined) usage.cache_read_input_tokens = cacheRead;
  if (cacheCreation !== undefined) usage.cache_creation_input_tokens = cacheCreation;
  if (total !== undefined) usage.total_tokens = total;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function mergeRunSummary(target: RunSummary, data: unknown): RunSummary {
  if (!data || typeof data !== 'object') return target;
  const source = data as Record<string, unknown>;
  const tokenUsage = normalizeTokenUsage(source.usage ?? source.tokenUsage);
  return {
    ...target,
    ...(readOptionalString(source.executorId) ? { executorId: readOptionalString(source.executorId) } : {}),
    ...(readOptionalString(source.executorName) ? { executorName: readOptionalString(source.executorName) } : {}),
    ...(readOptionalString(source.executorKind) ? { executorKind: readOptionalString(source.executorKind) } : {}),
    ...(readOptionalString(source.provider) ? { provider: readOptionalString(source.provider) } : {}),
    ...(readOptionalString(source.modelSource) ? { modelSource: readOptionalString(source.modelSource) } : {}),
    ...(readOptionalString(source.selectedSource) ? { selectedSource: readOptionalString(source.selectedSource) } : {}),
    ...(readOptionalString(source.model) ? { model: readOptionalString(source.model) } : {}),
    ...(readOptionalString(source.codexProfile) ? { codexProfile: readOptionalString(source.codexProfile) } : {}),
    ...(readOptionalString(source.baseUrl) ? { baseUrl: readOptionalString(source.baseUrl) } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
  };
}

const MUTATING_COMMAND_RE = /\b(git\s+(pull|rebase|merge|checkout|switch|reset|clean|stash(?:\s+(?:pop|apply))?)|npm\s+(install|update|uninstall)|pnpm\s+(install|update|add|remove)|yarn\s+(install|add|remove)|mkdir|rmdir|rm|mv|cp|touch|del|copy|move-item|remove-item|copy-item|new-item|set-content|add-content)\b/i;
const DEFAULT_HISTORY_LIMIT = Math.max(4, Number.parseInt(process.env.CTI_CONTEXT_HISTORY_LIMIT || '8', 10) || 8);
const DEFAULT_HISTORY_MAX_CHARS = Math.max(800, Number.parseInt(process.env.CTI_CONTEXT_HISTORY_MAX_CHARS || '1800', 10) || 1800);
const DEFAULT_HISTORY_MESSAGE_MAX_CHARS = Math.max(80, Number.parseInt(process.env.CTI_CONTEXT_HISTORY_MESSAGE_MAX_CHARS || '220', 10) || 220);
const DEFAULT_MEMORY_PROMPT_MAX_CHARS = Math.max(160, Number.parseInt(process.env.CTI_MEMORY_PROMPT_MAX_CHARS || '600', 10) || 600);
const MAX_STORED_TOOL_RESULT_CHARS = Math.max(160, Number.parseInt(process.env.CTI_STORED_TOOL_RESULT_CHARS || '320', 10) || 320);
const MAX_STORED_TEXT_CHARS = Math.max(400, Number.parseInt(process.env.CTI_STORED_TEXT_CHARS || '4000', 10) || 4000);

function buildBridgeScopedSystemPrompt(binding: ChannelBinding, baseSystemPrompt?: string, extraSystemPrompt?: string): string {
  const { store } = getBridgeContext();
  const additionalDirectories = splitWorkspacePathList(store.getSetting('bridge_default_additional_directories'));
  const allowedWorkspaceRoots = splitWorkspacePathList(store.getSetting('bridge_allowed_workspace_roots'));
  const workspaceLines = [
    `- Primary working directory for this turn: ${binding.workingDirectory || '(unset)'}`,
  ];
  if (additionalDirectories.length > 0) {
    workspaceLines.push(`- Additional accessible directories: ${additionalDirectories.join(' | ')}`);
  }
  if (allowedWorkspaceRoots.length > 0) {
    workspaceLines.push(`- Allowed workspace roots for edits: ${allowedWorkspaceRoots.join(' | ')}`);
    workspaceLines.push('- If the user specifies a project under an allowed root, operate there via absolute paths or an explicit repo/path switch. Do not edit paths outside those roots.');
  }
  if (store.getSetting('bridge_self_optimize_on_failure') === 'true') {
    workspaceLines.push('- If the user is trying to make the bridge/tooling gain a missing capability, and the relevant code lives inside an allowed workspace, prefer a minimal safe implementation or repair instead of only refusing.');
  }

  const bridgeGuardrails = [
    'Bridge channel context (authoritative):',
    `- Current inbound channel: ${binding.channelType}`,
    `- Current inbound chatId: ${binding.chatId}`,
    ...workspaceLines,
    '- This turn originated from the inbound chat above. Treat it as the only current chat unless the user explicitly provides another target chat ID or asks for cross-chat forwarding.',
    '- If the user says "发到当前对话"、"发到这里"、"发到这个聊天"、"回这个会话"，it refers to the inbound chat above, not the desktop terminal conversation.',
    '- Normal text replies, generated local image paths, and document-generation replies from this turn are automatically delivered by the bridge back to the same inbound chat.',
    '- Do not inspect bindings, logs, "最近活跃会话", or timestamps to guess a destination chat.',
    '- Do not manually call platform APIs to reroute content to another chat unless the user explicitly provides the target and asks for cross-chat forwarding.',
    '- If the target chat is ambiguous, ask the user to send a message from that target chat or provide explicit target info. Never guess.',
    '- Tool execution policy: when the user explicitly requests a named tool or MCP workflow (for example Unity MCP, picture annotation MCP), do not skip it silently and do not replace it with a weaker fallback before trying to initialize/reconnect the requested tool path.',
    '- Execution posture: you are responsible for solving the task, not coaching the user to do it. Do not turn actionable requests into generic tutorials, manual checklists, placeholder tables, or sample scripts unless the user explicitly asks for instructions.',
    '- Low-risk proactive context policy: when the request names an explicit readable context object such as current chat history, a replied message, an attachment, a URL/link, a local path, the current workspace, config/mcp.d, or an available MCP manifest, make a bounded low-risk read/list/check before asking for clarification.',
    '- Do not ask the user to restate context that is already present in the inbound chat, reply target, attachment, link, current workspace, or manifest. Use the available context first; ask only when the target is absent or still ambiguous after the bounded check.',
    '- If a task requires Unity, Blender, MCP, repository, local file, image, or history access, either use the requested tool path and report real findings, or say "未完成" with the exact concrete blocker. Do not fabricate example findings.',
    '- For Unity MCP requests, always attempt at least one concrete reconnect/start path before declaring failure (for example check existing MCP endpoint, then attempt known local launcher or CLI entry when available), and report the exact failure point if still blocked.',
    '- For Unity MCP HTTP endpoints, do not treat a bare 406 Not Acceptable from /mcp as offline. It means the service answered but the request probably missed Accept: application/json, text/event-stream; retry a real MCP initialize/list-tools handshake before reporting unavailable.',
    '- Hard requirement for Unity MCP tasks: before saying unavailable, include at least one real attempt artifact (a Unity MCP tool call result, or one launcher shell command + its exact error). If no attempt artifact exists, continue trying instead of giving up.',
    '- If Unity MCP tools are absent in the current tool list, perform one concrete bootstrap attempt (locate/start command in allowed workspace) and report that command result, then ask for the minimal missing prerequisite.',
    '- For screenshot/preview requests, only send images captured in the current turn or an explicitly requested exact historical file. Never attach a stale screenshot found by scanning capture folders when the user asked to refresh or inspect current Unity state.',
    '- If scene refresh, play/preview state, or screenshot capture is blocked, reply text-only with the blocker. Do not reuse a previous screenshot as if it validates the current state.',
    '- For image annotation tasks, strictly follow user-specified label format and naming conventions. If the user gives an explicit format (such as Furniture_*), keep that format exactly; do not auto-rename to another schema.',
    '- If required inputs are missing for precise annotation (for example a referenced person\'s chat records or the target screenshot), ask for the missing artifact instead of producing speculative labels.',
    '- Default execution posture: prioritize solving the task with concrete attempts. Do not retreat to generic refusal when a safe, bounded troubleshooting step can be executed immediately.',
    '- Reminder action protocol: when the user clearly asks to create a future reminder, do not use schtasks, Register-ScheduledTask, temporary PowerShell scripts, or direct platform APIs. Instead output one fenced ```cti-reminder JSON block with title, dueAt, timezone, target="current_chat", and sourcePrompt. The bridge will create and send the reminder.',
    '- Do not claim that a reminder, scheduled task, or proactive message has been created unless you used the cti-reminder action protocol or the user explicitly asked only for example code.',
    '- Direct-message action protocol: when a Feishu user explicitly asks you to privately/directly message a named person, do not use Bash, PowerShell, temporary scripts, hand-written platform API calls, or ordinary text to fake the send. Instead output one fenced ```cti-direct-message JSON block with target and text. The bridge will resolve the target from Feishu context and send the private message.',
    '- Do not claim a private/direct message has been sent unless you used the cti-direct-message action protocol and the bridge reports success. If the target is not explicit or may match multiple people, ask for a direct @ mention or exact display name.',
  ].join('\n');

  return [
    // Channel identity and turn-specific context must stay near the front
    // because downstream providers may trim long system prompts.
    extraSystemPrompt?.trim(),
    baseSystemPrompt?.trim(),
    bridgeGuardrails,
    buildReplyPresentationPrompt(getReplyStyleHintFromStore()),
  ]
    .filter((part): part is string => !!part)
    .join('\n\n');
}

function getReplyStyleHintFromStore(): string {
  const { store } = getBridgeContext();
  return (
    store.getSetting('bridge_reply_style_hint')
    || store.getSetting('reply_style_hint')
    || process.env.CTI_REPLY_STYLE_HINT
    || ''
  ).trim();
}

function buildReplyPresentationPrompt(replyStyleHint: string): string {
  const lines = [
    'Reply presentation contract:',
    '- Final user-facing replies must follow the configured reply style when one is provided.',
    '- For Feishu turns, decide the visible intent/state first: chat / investigate / need_info / done. Use chat for lightweight conversation, investigate when tools or context checks are needed, need_info only for the minimal missing detail, and done when no reply is needed or the result is complete.',
    '- Progress updates should stay high-level and user-readable. Do not expose tool names, file paths, raw commands, agent phase names, or step-by-step internal execution status.',
    '- Do not narrate tool process or dump intermediate流水 to the user. When investigation is needed, do the checks and only answer with the result; mention blockers only when they change what the user can do next.',
    '- Final replies should be outcome-first and concise; do not repeat the progress-card rationale unless the user explicitly asks for a detailed walkthrough.',
    '- On Feishu, when a real mention is needed, reflect on who should be mentioned from the explicit name, replied message, or unique group-member match. Use either structured cti-final mentions with real IDs, or an exact visible @display-name when the target is explicit; the bridge will resolve @display-name through Feishu context before sending. Do not put bare strings or Feishu @_user_N placeholders in cti-final.mentions. If the target is vague such as "someone else" or "another person", ask for the exact person instead of guessing from the sender or replied-message header.',
    '- On Feishu, native mentions require a bridge-resolvable Feishu mention ID or @all. Bots and app agents may be mentioned only when the bridge can resolve a valid mention ID from Feishu context or structured cti-final mentions; otherwise say the target cannot be confirmed and use a plain name only when helpful.',
    '- If the user explicitly asks you to mention someone, do the mention once when the target is explicit and resolvable. Do not refuse only because the target is a bot or app agent, and do not speculate about whether that other agent will react to the notification.',
    '- If the user asks to private-message someone, use cti-direct-message with the intended target and private text; the visible group result should be only a success/failure confirmation, not the private content.',
    '- On Feishu, you may make lightweight replies more lively by starting the final visible result with a native reaction hint or sticker hint when it fits the actual intent. Use `[表情包:alias]` only when the alias is explicitly listed in the Feishu sticker library prompt; use bare `[表情包]` only when that prompt says semantic sticker selection is available. If no reliable semantic sticker fits, prefer text or a reaction hint.',
    '- Choose reaction hints by actual intent. Do not default to SMILE; use no hint when the tone is neutral, formal, blocked, or unclear.',
    '- Use Feishu reaction/sticker hints only for casual chat, acknowledgements, greetings, playful sticker replies, and short emotional responses. Do not add them to formal tool results, blockers, file paths, command output, or safety-sensitive replies.',
    '- Do not invent sticker aliases or sticker file_key values. If a sticker hint cannot be resolved by the bridge, the visible text must still stand on its own.',
    '- Feishu sticker messages may include an image attachment when the bridge can download the sticker resource. If the inbound text says a sticker image is attached, inspect that image first to identify the visual content and intent.',
    '- If the inbound text says the Feishu sticker is not semantically annotated and no sticker image attachment is available, do not claim you can see its image, caption, or intent. Ask the user to explain the sticker meaning or use any learned sticker semantics provided in the message context.',
  ];
  if (replyStyleHint) {
    lines.push(`- Required reply style: ${replyStyleHint}`);
    lines.push('- Apply this style to the first sentence of the final user-facing reply while preserving truthfulness and safety.');
  }
  return lines.join('\n');
}

function shouldRefreshForToolUse(toolName: string, toolInput: unknown): boolean {
  const normalizedName = toolName.trim().toLowerCase();
  if (!normalizedName) return false;
  if (normalizedName === 'edit' || normalizedName === 'write' || normalizedName === 'multiedit') {
    return true;
  }
  if (normalizedName === 'bash' || normalizedName === 'shell' || normalizedName === 'shell_command' || normalizedName === 'powershell') {
    const command = typeof toolInput === 'object' && toolInput !== null && 'command' in toolInput
      ? String((toolInput as { command?: unknown }).command ?? '')
      : '';
    return MUTATING_COMMAND_RE.test(command);
  }
  return false;
}

function shouldRefreshForToolResult(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  return /(^|\n)(add|update|delete|rename|move):\s/i.test(content) || /file changes applied/i.test(content);
}

function normalizeStoredText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 3)}...` : normalized;
}

function parseSettingInt(raw: string | null, fallback: number, min: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function normalizePromptText(text: string): string {
  return text
    .replace(/<!--files:[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncatePromptText(text: string, maxChars: number): string {
  const normalized = normalizePromptText(text);
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function compactHistoryEntryForPrompt(
  role: 'user' | 'assistant',
  content: string,
  messageMaxChars: number,
): { role: 'user' | 'assistant'; content: string } | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('[')) {
    try {
      const blocks = JSON.parse(trimmed) as Array<Record<string, unknown>>;
      const parts: string[] = [];
      for (const block of blocks) {
        if (block?.type === 'text') {
          const text = truncatePromptText(String(block.text || ''), Math.min(messageMaxChars, 220));
          if (text) parts.push(text);
          continue;
        }
        if (block?.type === 'tool_use') {
          const name = String(block.name || '');
          const input = block.input as { command?: unknown; files?: Array<{ path?: string; kind?: string }> } | undefined;
          if (name === 'Bash' && typeof input?.command === 'string') {
            parts.push(`Cmd: ${truncatePromptText(input.command, 120)}`);
          } else if (name === 'Edit' && Array.isArray(input?.files)) {
            const files = input.files.slice(0, 6).map((file) => `${file.kind}:${file.path}`).join(', ');
            if (files) parts.push(`Edit: ${truncatePromptText(files, 120)}`);
          } else if (name) {
            parts.push(`Tool: ${truncatePromptText(name, 60)}`);
          }
          continue;
        }
        if (block?.type === 'tool_result') {
          const resultText = truncatePromptText(String(block.content || ''), 120);
          if (resultText) parts.push(`Result: ${resultText}`);
        }
      }
      const combined = truncatePromptText(parts.join(' | '), messageMaxChars);
      if (!combined) return null;
      return { role, content: combined };
    } catch {
      // Fall through to plain-text compacting.
    }
  }

  const plain = truncatePromptText(content, messageMaxChars);
  if (!plain) return null;
  return { role, content: plain };
}

function compactConversationHistory(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  totalMaxChars: number,
  messageMaxChars: number,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (history.length === 0) return [];
  const reversed = [...history].reverse();
  const selected: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let usedChars = 0;

  for (const item of reversed) {
    const compacted = compactHistoryEntryForPrompt(item.role, item.content, messageMaxChars);
    if (!compacted) continue;
    const additional = compacted.content.length;
    if (selected.length > 0 && usedChars + additional > totalMaxChars) {
      break;
    }
    selected.push(compacted);
    usedChars += additional;
  }

  return selected.reverse();
}

function compactBlockForStorage(block: MessageContentBlock): MessageContentBlock {
  switch (block.type) {
    case 'text':
      return {
        ...block,
        text: normalizeStoredText(block.text, MAX_STORED_TEXT_CHARS),
      };
    case 'tool_use': {
      if (block.name === 'Bash') {
        const input = block.input as { command?: unknown } | undefined;
        const command = typeof input?.command === 'string'
          ? normalizeStoredText(input.command, 200)
          : undefined;
        return {
          ...block,
          input: command ? { command } : block.input,
        };
      }
      if (block.name === 'Edit') {
        const input = block.input as { files?: Array<{ path?: string; kind?: string }> } | undefined;
        if (Array.isArray(input?.files)) {
          return {
            ...block,
            input: {
              files: input.files.slice(0, 8).map((file) => ({
                path: file.path,
                kind: file.kind,
              })),
            },
          };
        }
      }
      return block;
    }
    case 'tool_result':
      return {
        ...block,
        content: normalizeStoredText(block.content, MAX_STORED_TOOL_RESULT_CHARS),
      };
    default:
      return block;
  }
}

function buildRetrievedMemoryPrompt(
  memory: RetrievedMemoryContext | null,
  feishuHistory: RetrievedFeishuHistoryContext | null,
  maxChars: number,
): string {
  const sections: string[] = [];
  if (memory && memory.hits.length > 0) {
    sections.push(memory.summary);
  }
  if (feishuHistory && feishuHistory.items.length > 0) {
    sections.push([
      'Relevant Feishu history snippets:',
      feishuHistory.summary,
    ].join('\n'));
  }
  if (sections.length === 0) return '';
  const text = [
    'Retrieved memory context:',
    sections.join('\n\n'),
    'Use these snippets only when relevant. They are selected memory, not the full transcript. If they conflict with the current user request, prefer the current request.',
  ].join('\n\n');
  return truncatePromptText(text, maxChars);
}

function shouldRetrieveMemoryForTurn(
  mode: ConversationProcessOptions['memoryMode'],
  executionRequirement: ExecutionRequirement,
  memoryPlan?: MemoryQueryPlan,
): boolean {
  if (mode === 'off') return false;
  if (mode === 'recall') return true;
  if (memoryPlan?.intent === 'explicit_recall') return true;
  if (mode === 'augment') return true;
  return executionRequirement.kind !== 'none';
}

/**
 * Process an inbound message: send to Claude, consume the response stream,
 * save to DB, and return the result.
 */
export async function processMessage(
  binding: ChannelBinding,
  text: string,
  onPermissionRequest?: OnPermissionRequest,
  abortSignal?: AbortSignal,
  files?: FileAttachment[],
  onPartialText?: OnPartialText,
  onProgressText?: OnPartialText,
  onToolEvent?: OnToolEvent,
  options?: ConversationProcessOptions,
): Promise<ConversationResult> {
  const { store, llm } = getBridgeContext();
  const sessionId = binding.codepilotSessionId;

  // Acquire session lock
  const lockId = crypto.randomBytes(8).toString('hex');
  const lockAcquired = store.acquireSessionLock(sessionId, lockId, `bridge-${binding.channelType}`, 600);
  if (!lockAcquired) {
    return {
      responseText: '',
      tokenUsage: null,
      runSummary: {},
      hasError: true,
      errorMessage: 'Session is busy processing another request',
      permissionRequests: [],
      sdkSessionId: null,
      shouldRefreshSession: false,
      executionEvidence: emptyExecutionEvidence(),
    };
  }

  store.setSessionRuntimeStatus(sessionId, 'running');

  // Lock renewal interval
  const renewalInterval = setInterval(() => {
    try { store.renewSessionLock(sessionId, lockId, 600); } catch { /* best effort */ }
  }, 60_000);

  try {
    // Resolve session early — needed for workingDirectory and provider resolution
    const session = store.getSession(sessionId);

    // Save user message — persist file attachments to disk using the same
    // <!--files:JSON--> format as the desktop chat route, so the UI can render them.
    const storedUserText = options?.storedUserText || text;
    let savedContent = storedUserText;
    if (files && files.length > 0) {
      const workDir = binding.workingDirectory || session?.working_directory || '';
      if (workDir) {
        try {
          const uploadDir = path.join(workDir, '.codepilot-uploads');
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }
          const fileMeta = files.map((f) => {
            const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
            const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
            const buffer = Buffer.from(f.data, 'base64');
            fs.writeFileSync(filePath, buffer);
            return { id: f.id, name: f.name, type: f.type, size: buffer.length, filePath };
          });
          savedContent = `<!--files:${JSON.stringify(fileMeta)}-->${storedUserText}`;
        } catch (err) {
          console.warn('[conversation-engine] Failed to persist file attachments:', err instanceof Error ? err.message : err);
          savedContent = `[${files.length} image(s) attached] ${storedUserText}`;
        }
      } else {
        savedContent = `[${files.length} image(s) attached] ${storedUserText}`;
      }
    }
    store.addMessage(sessionId, 'user', savedContent);

    // Resolve provider
    let resolvedProvider: import('./host.js').BridgeApiProvider | undefined;
    const providerId = session?.provider_id || '';
    if (providerId && providerId !== 'env') {
      resolvedProvider = store.getProvider(providerId);
    }
    if (!resolvedProvider) {
      const defaultId = store.getDefaultProviderId();
      if (defaultId) resolvedProvider = store.getProvider(defaultId);
    }

    // Effective model
    const effectiveModel = binding.model || session?.model || store.getSetting('default_model') || undefined;

    // Permission mode from binding mode
    let permissionMode: string;
    switch (binding.mode) {
      case 'plan': permissionMode = 'plan'; break;
      case 'ask': permissionMode = 'default'; break;
      default: permissionMode = 'acceptEdits'; break;
    }

    // Load conversation history for context
    const historyLimit = typeof options?.historyLimit === 'number'
      ? Math.max(0, Math.floor(options.historyLimit))
      : DEFAULT_HISTORY_LIMIT;
    const recentMsgs = historyLimit > 0
      ? store.getMessages(sessionId, { limit: historyLimit }).messages
      : [];
    const historyMsgs = recentMsgs.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
    const historyTotalMaxChars = parseSettingInt(
      store.getSetting('bridge_context_history_max_chars'),
      DEFAULT_HISTORY_MAX_CHARS,
      1200,
    );
    const historyMessageMaxChars = parseSettingInt(
      store.getSetting('bridge_context_history_message_max_chars'),
      DEFAULT_HISTORY_MESSAGE_MAX_CHARS,
      120,
    );
    const compactHistory = compactConversationHistory(
      historyMsgs,
      historyTotalMaxChars,
      historyMessageMaxChars,
    );
    const executionRequirement = classifyExecutionRequirement({
      userText: options?.storedUserText || text,
      workingDirectory: binding.workingDirectory || session?.working_directory || undefined,
      files,
      memoryPlan: options?.memoryPlan,
      messageKind: options?.messageKind,
    });
    const shouldRetrieveMemory = shouldRetrieveMemoryForTurn(
      options?.memoryMode || 'auto',
      executionRequirement,
      options?.memoryPlan,
    );
    const retrievedMemory = shouldRetrieveMemory
      ? store.retrieveRelevantMemory({
        sessionId,
        channelType: binding.channelType,
        chatId: binding.chatId,
        userId: options?.memoryUserId,
        userDisplayName: options?.memoryUserDisplayName,
        workingDirectory: binding.workingDirectory || session?.working_directory || undefined,
        query: text,
        recentHistoryLimit: historyLimit,
      })
      : null;
    const retrievedFeishuHistory = shouldRetrieveMemory && binding.channelType === 'feishu' && store.retrieveRelevantFeishuHistory
      ? store.retrieveRelevantFeishuHistory({
        chatId: binding.chatId,
        query: text,
        limit: options?.memoryMode === 'recall' ? 4 : 2,
      })
      : null;
    const memoryPromptMaxChars = parseSettingInt(
      store.getSetting('bridge_memory_prompt_max_chars'),
      DEFAULT_MEMORY_PROMPT_MAX_CHARS,
      240,
    );
    const memoryPrompt = buildRetrievedMemoryPrompt(retrievedMemory, retrievedFeishuHistory, memoryPromptMaxChars);
    const executionRequirementPrompt = buildExecutionRequirementPrompt(executionRequirement);
    const mergedExtraSystemPrompt = [options?.extraSystemPrompt?.trim(), memoryPrompt]
      .filter((part): part is string => !!part)
      .join('\n\n');
    const additionalDirectories = splitWorkspacePathList(store.getSetting('bridge_default_additional_directories'));

    const abortController = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort();
      } else {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    const runAttempt = async (attempt: 'initial' | 'no_evidence_retry'): Promise<InternalConversationResult> => {
      const attemptPrompt = [
        mergedExtraSystemPrompt,
        executionRequirementPrompt,
        attempt === 'no_evidence_retry' ? buildNoEvidenceRetryPrompt(executionRequirement) : '',
      ].filter(Boolean).join('\n\n');
      const stream = llm.streamChat({
      prompt: text,
      sessionId,
      sdkSessionId: attempt === 'initial' ? binding.sdkSessionId || undefined : undefined,
      forceFreshThread: attempt === 'initial' ? !binding.sdkSessionId : true,
      model: effectiveModel,
      systemPrompt: buildBridgeScopedSystemPrompt(binding, session?.system_prompt || undefined, attemptPrompt || undefined),
      workingDirectory: binding.workingDirectory || session?.working_directory || undefined,
      additionalDirectories,
      abortController,
      permissionMode,
      provider: resolvedProvider,
      conversationHistory: compactHistory,
      files,
      sourceUserId: options?.memoryUserId,
      sourceUserDisplayName: options?.memoryUserDisplayName,
      sourceMessageId: options?.sourceMessageId,
      sourceChannelType: options?.sourceChannelType,
      sourceChatId: options?.sourceChatId,
      sourceThreadId: options?.sourceThreadId,
      replyPresentation: {
        replyStyleHint: getReplyStyleHintFromStore(),
      },
      executionRequirement,
      noEvidenceRetryAttempted: attempt === 'no_evidence_retry',
      onRuntimeStatusChange: (status: string) => {
        try { store.setSessionRuntimeStatus(sessionId, status); } catch { /* best effort */ }
      },
    });

    // Consume the stream server-side (replicate collectStreamResponse pattern).
    // Permission requests are forwarded immediately via the callback during streaming
    // because the stream blocks until permission is resolved — we can't wait until after.
      return await consumeStream(
        stream,
        sessionId,
        onPermissionRequest,
        attempt === 'initial' && requiresSuccessfulToolEvidence(executionRequirement) ? undefined : onPartialText,
        onProgressText,
        onToolEvent,
        executionRequirement,
        attempt === 'no_evidence_retry',
      );
    };

    let result = await runAttempt('initial');
    if (
      requiresSuccessfulToolEvidence(executionRequirement)
      && !isExecutionEvidenceSatisfied(executionRequirement, result.executionEvidence)
      && !abortController.signal.aborted
    ) {
      result = await runAttempt('no_evidence_retry');
    }

    if (
      shouldReplaceWithNoExecutionEvidenceText(
        executionRequirement,
        result.executionEvidence,
        result.responseText,
      )
    ) {
      const blockedText = buildNoExecutionEvidenceText(executionRequirement, result.executionEvidence);
      result = {
        ...result,
        responseText: blockedText,
        hasError: false,
        errorMessage: '',
        assistantStorageContent: blockedText,
        assistantStorageTokenUsage: result.tokenUsage,
        executionEvidence: {
          ...result.executionEvidence,
          evidenceSatisfied: false,
          noEvidenceRetryAttempted: true,
        },
      };
    }

    if (!result.hasError && !result.responseText.trim()) {
      const blockedText = '未完成：模型没有返回可展示结果。';
      result = {
        ...result,
        responseText: blockedText,
        hasError: true,
        errorMessage: '模型没有返回可展示结果。',
        assistantStorageContent: blockedText,
        assistantStorageTokenUsage: result.tokenUsage,
        executionEvidence: {
          ...result.executionEvidence,
          evidenceSatisfied: false,
        },
      };
    }

    if (result.assistantStorageContent) {
      store.addMessage(sessionId, 'assistant', result.assistantStorageContent, result.assistantStorageTokenUsage ? JSON.stringify(result.assistantStorageTokenUsage) : null);
    }

    return result;
  } finally {
    clearInterval(renewalInterval);
    store.releaseSessionLock(sessionId, lockId);
    store.setSessionRuntimeStatus(sessionId, 'idle');
  }
}

export const _testOnly = {
  buildBridgeScopedSystemPrompt,
};

/**
 * Consume an SSE stream and extract response data.
 * Mirrors the collectStreamResponse() logic from chat/route.ts.
 */
async function consumeStream(
  stream: ReadableStream<string>,
  sessionId: string,
  onPermissionRequest?: OnPermissionRequest,
  onPartialText?: OnPartialText,
  onProgressText?: OnPartialText,
  onToolEvent?: OnToolEvent,
  executionRequirement?: ExecutionRequirement,
  noEvidenceRetryAttempted = false,
): Promise<InternalConversationResult> {
  const { store } = getBridgeContext();
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  /** Monotonically accumulated text for streaming preview — never resets on tool_use. */
  let previewText = '';
  let tokenUsage: TokenUsage | null = null;
  let runSummary: RunSummary = {};
  let hasError = false;
  let errorMessage = '';
  const seenToolResultIds = new Set<string>();
  const permissionRequests: PermissionRequestInfo[] = [];
  let capturedSdkSessionId: string | null = null;
  let shouldRefreshSession = false;
  const executionEvidence = emptyExecutionEvidence(executionRequirement, noEvidenceRetryAttempted);
  const seenToolNames = new Set<string>();
  let assistantStorageContent = '';
  let assistantStorageTokenUsage: TokenUsage | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = value.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        let event: SSEEvent;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        switch (event.type) {
          case 'text':
            currentText += event.data;
            if (onPartialText) {
              previewText += event.data;
              try { onPartialText(previewText); } catch { /* non-critical */ }
            }
            break;

          case 'progress':
            if (onProgressText && event.data) {
              previewText += event.data;
              try { onProgressText(previewText); } catch { /* non-critical */ }
            }
            break;

          case 'tool_use': {
            if (currentText.trim()) {
              contentBlocks.push({ type: 'text', text: currentText });
              currentText = '';
            }
            try {
              const toolData = JSON.parse(event.data);
              contentBlocks.push({
                type: 'tool_use',
                id: toolData.id,
                name: toolData.name,
                input: toolData.input,
              });
              executionEvidence.toolUseCount += 1;
              const toolName = String(toolData.name || '').trim();
              if (toolName && !seenToolNames.has(toolName)) {
                seenToolNames.add(toolName);
                executionEvidence.toolNames.push(toolName);
              }
              if (shouldRefreshForToolUse(String(toolData.name || ''), toolData.input)) {
                shouldRefreshSession = true;
              }
              if (onToolEvent) {
                try { onToolEvent(toolData.id, toolData.name, 'running'); } catch { /* non-critical */ }
              }
            } catch { /* skip */ }
            break;
          }

          case 'tool_result': {
            try {
              const resultData = JSON.parse(event.data);
              const resultQuality = classifyToolResultQuality(resultData.content, resultData.is_error);
              const newBlock = {
                type: 'tool_result' as const,
                tool_use_id: resultData.tool_use_id,
                content: resultData.content,
                is_error: !resultQuality.ok,
              };
              if (seenToolResultIds.has(resultData.tool_use_id)) {
                const idx = contentBlocks.findIndex(
                  (b) => b.type === 'tool_result' && 'tool_use_id' in b && b.tool_use_id === resultData.tool_use_id
                );
                if (idx >= 0) contentBlocks[idx] = newBlock;
              } else {
                seenToolResultIds.add(resultData.tool_use_id);
                contentBlocks.push(newBlock);
                executionEvidence.toolResultCount += 1;
                if (!resultQuality.ok) {
                  executionEvidence.failedToolResultCount += 1;
                  const errorSummary = resultQuality.errorSummary;
                  if (errorSummary && !(executionEvidence.failedToolErrors || []).includes(errorSummary)) {
                    executionEvidence.failedToolErrors = [
                      ...(executionEvidence.failedToolErrors || []),
                      errorSummary,
                    ].slice(0, 3);
                  }
                } else {
                  executionEvidence.successfulToolResultCount += 1;
                }
              }
              if (shouldRefreshForToolResult(resultData.content)) {
                shouldRefreshSession = true;
              }
              if (onToolEvent) {
                try {
                  onToolEvent(
                    resultData.tool_use_id,
                    '', // name not available in tool_result, adapter tracks by id
                    resultQuality.ok ? 'complete' : 'error',
                  );
                } catch { /* non-critical */ }
              }
            } catch { /* skip */ }
            break;
          }

          case 'permission_request': {
            try {
              const permData = JSON.parse(event.data);
              const perm: PermissionRequestInfo = {
                permissionRequestId: permData.permissionRequestId,
                toolName: permData.toolName,
                toolInput: permData.toolInput,
                suggestions: permData.suggestions,
              };
              permissionRequests.push(perm);
              executionEvidence.permissionRequestCount += 1;
              // Forward immediately — the stream blocks until the permission is
              // resolved, so we must send the IM prompt *now*, not after the stream ends.
              if (onPermissionRequest) {
                onPermissionRequest(perm).catch((err) => {
                  console.error('[conversation-engine] Failed to forward permission request:', err);
                });
              }
            } catch { /* skip */ }
            break;
          }

          case 'status': {
            try {
              const statusData = JSON.parse(event.data);
              runSummary = mergeRunSummary(runSummary, statusData);
              if (statusData.session_id) {
                capturedSdkSessionId = statusData.session_id;
                store.updateSdkSessionId(sessionId, statusData.session_id);
              }
              if (statusData.model) {
                store.updateSessionModel(sessionId, statusData.model);
              }
            } catch { /* skip */ }
            break;
          }

          case 'task_update': {
            try {
              const taskData = JSON.parse(event.data);
              if (taskData.session_id && taskData.todos) {
                store.syncSdkTasks(taskData.session_id, taskData.todos);
              }
            } catch { /* skip */ }
            break;
          }

          case 'error':
            hasError = true;
            errorMessage = event.data || 'Unknown error';
            break;

          case 'result': {
            try {
              const resultData = JSON.parse(event.data);
              if (resultData.usage) tokenUsage = resultData.usage;
              runSummary = mergeRunSummary(runSummary, resultData);
              if (resultData.is_error) hasError = true;
              if (resultData.session_id) {
                capturedSdkSessionId = resultData.session_id;
                store.updateSdkSessionId(sessionId, resultData.session_id);
              }
            } catch { /* skip */ }
            break;
          }

          // tool_output, tool_timeout, mode_changed, done — ignored for bridge
        }
      }
    }

    // Flush remaining text
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    // Save assistant message
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const storedBlocks = hasToolBlocks ? contentBlocks.map(compactBlockForStorage) : contentBlocks;
      const content = hasToolBlocks
        ? JSON.stringify(storedBlocks)
        : storedBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();

      if (content) {
        assistantStorageContent = content;
        assistantStorageTokenUsage = tokenUsage;
      }
    }

    // Extract text-only response for IM delivery
    const responseText = contentBlocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    executionEvidence.evidenceSatisfied = executionRequirement
      ? isExecutionEvidenceSatisfied(executionRequirement, executionEvidence)
      : true;

    return {
      responseText,
      tokenUsage,
      runSummary: {
        ...runSummary,
        ...(tokenUsage ? { tokenUsage: normalizeTokenUsage(tokenUsage) } : {}),
      },
      hasError,
      errorMessage,
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
      shouldRefreshSession,
      executionEvidence,
      assistantStorageContent,
      assistantStorageTokenUsage,
    };
  } catch (e) {
    // Best-effort save on stream error
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const storedBlocks = hasToolBlocks ? contentBlocks.map(compactBlockForStorage) : contentBlocks;
      const content = hasToolBlocks
        ? JSON.stringify(storedBlocks)
        : storedBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();
      if (content) {
        assistantStorageContent = content;
        assistantStorageTokenUsage = tokenUsage;
      }
    }

    const isAbort = e instanceof DOMException && e.name === 'AbortError'
      || e instanceof Error && e.name === 'AbortError';

    executionEvidence.evidenceSatisfied = executionRequirement
      ? isExecutionEvidenceSatisfied(executionRequirement, executionEvidence)
      : true;

    return {
      responseText: '',
      tokenUsage,
      runSummary: {
        ...runSummary,
        ...(tokenUsage ? { tokenUsage: normalizeTokenUsage(tokenUsage) } : {}),
      },
      hasError: true,
      errorMessage: isAbort ? 'Task stopped by user' : (e instanceof Error ? e.message : 'Stream consumption error'),
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
      shouldRefreshSession,
      executionEvidence,
      assistantStorageContent,
      assistantStorageTokenUsage,
    };
  }
}
