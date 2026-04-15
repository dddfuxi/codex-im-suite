/**
 * Conversation Engine — processes inbound IM messages through Claude.
 *
 * Takes a ChannelBinding + inbound message, calls the LLM provider,
 * consumes the SSE stream server-side, saves messages to DB,
 * and returns the response text for delivery.
 */

import fs from 'fs';
import path from 'path';
import type { ChannelBinding } from './types.js';
import type {
  FileAttachment,
  SSEEvent,
  TokenUsage,
  MessageContentBlock,
  RetrievedMemoryContext,
} from './host.js';
import { getBridgeContext } from './context.js';
import crypto from 'crypto';
import { splitWorkspacePathList } from './security/validators.js';

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
  hasError: boolean;
  errorMessage: string;
  /** Permission request events that were forwarded during streaming */
  permissionRequests: PermissionRequestInfo[];
  /** SDK session ID captured from status/result events, for session resume */
  sdkSessionId: string | null;
  /** Whether the next turn should start a fresh SDK thread while keeping local history. */
  shouldRefreshSession: boolean;
}

export interface ConversationProcessOptions {
  storedUserText?: string;
  historyLimit?: number;
  extraSystemPrompt?: string;
}

const MUTATING_COMMAND_RE = /\b(git\s+(pull|rebase|merge|checkout|switch|reset|clean|stash(?:\s+(?:pop|apply))?)|npm\s+(install|update|uninstall)|pnpm\s+(install|update|add|remove)|yarn\s+(install|add|remove)|mkdir|rmdir|rm|mv|cp|touch|del|copy|move-item|remove-item|copy-item|new-item|set-content|add-content)\b/i;
const DEFAULT_HISTORY_LIMIT = Math.max(8, Number.parseInt(process.env.CTI_CONTEXT_HISTORY_LIMIT || '24', 10) || 24);
const DEFAULT_HISTORY_MAX_CHARS = Math.max(1200, Number.parseInt(process.env.CTI_CONTEXT_HISTORY_MAX_CHARS || '4200', 10) || 4200);
const DEFAULT_HISTORY_MESSAGE_MAX_CHARS = Math.max(120, Number.parseInt(process.env.CTI_CONTEXT_HISTORY_MESSAGE_MAX_CHARS || '420', 10) || 420);
const DEFAULT_MEMORY_PROMPT_MAX_CHARS = Math.max(240, Number.parseInt(process.env.CTI_MEMORY_PROMPT_MAX_CHARS || '1200', 10) || 1200);
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
    '- For Unity MCP requests, always attempt at least one concrete reconnect/start path before declaring failure (for example check existing MCP endpoint, then attempt known local launcher or CLI entry when available), and report the exact failure point if still blocked.',
    '- Hard requirement for Unity MCP tasks: before saying unavailable, include at least one real attempt artifact (a Unity MCP tool call result, or one launcher shell command + its exact error). If no attempt artifact exists, continue trying instead of giving up.',
    '- If Unity MCP tools are absent in the current tool list, perform one concrete bootstrap attempt (locate/start command in allowed workspace) and report that command result, then ask for the minimal missing prerequisite.',
    '- For image annotation tasks, strictly follow user-specified label format and naming conventions. If the user gives an explicit format (such as Furniture_*), keep that format exactly; do not auto-rename to another schema.',
    '- If required inputs are missing for precise annotation (for example a referenced person\'s chat records or the target screenshot), ask for the missing artifact instead of producing speculative labels.',
    '- Default execution posture: prioritize solving the task with concrete attempts. Do not retreat to generic refusal when a safe, bounded troubleshooting step can be executed immediately.',
  ].join('\n');

  return [baseSystemPrompt?.trim(), bridgeGuardrails, extraSystemPrompt?.trim()]
    .filter((part): part is string => !!part)
    .join('\n\n');
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

function buildRetrievedMemoryPrompt(memory: RetrievedMemoryContext | null, maxChars: number): string {
  if (!memory || memory.hits.length === 0) return '';
  const text = [
    'Retrieved memory context:',
    memory.summary,
    'Use these snippets only when relevant. They are selected memory, not the full transcript. If they conflict with the current user request, prefer the current request.',
  ].join('\n\n');
  return truncatePromptText(text, maxChars);
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
      hasError: true,
      errorMessage: 'Session is busy processing another request',
      permissionRequests: [],
      sdkSessionId: null,
      shouldRefreshSession: false,
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
    const historyLimit = options?.historyLimit && options.historyLimit > 0 ? options.historyLimit : DEFAULT_HISTORY_LIMIT;
    const { messages: recentMsgs } = store.getMessages(sessionId, { limit: historyLimit });
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
    const retrievedMemory = store.retrieveRelevantMemory({
      sessionId,
      channelType: binding.channelType,
      chatId: binding.chatId,
      workingDirectory: binding.workingDirectory || session?.working_directory || undefined,
      query: text,
      recentHistoryLimit: historyLimit,
    });
    const memoryPromptMaxChars = parseSettingInt(
      store.getSetting('bridge_memory_prompt_max_chars'),
      DEFAULT_MEMORY_PROMPT_MAX_CHARS,
      240,
    );
    const memoryPrompt = buildRetrievedMemoryPrompt(retrievedMemory, memoryPromptMaxChars);
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

    const stream = llm.streamChat({
      prompt: text,
      sessionId,
      sdkSessionId: binding.sdkSessionId || undefined,
      forceFreshThread: !binding.sdkSessionId,
      model: effectiveModel,
      systemPrompt: buildBridgeScopedSystemPrompt(binding, session?.system_prompt || undefined, mergedExtraSystemPrompt || undefined),
      workingDirectory: binding.workingDirectory || session?.working_directory || undefined,
      additionalDirectories,
      abortController,
      permissionMode,
      provider: resolvedProvider,
      conversationHistory: compactHistory,
      files,
      onRuntimeStatusChange: (status: string) => {
        try { store.setSessionRuntimeStatus(sessionId, status); } catch { /* best effort */ }
      },
    });

    // Consume the stream server-side (replicate collectStreamResponse pattern).
    // Permission requests are forwarded immediately via the callback during streaming
    // because the stream blocks until permission is resolved — we can't wait until after.
    return await consumeStream(stream, sessionId, onPermissionRequest, onPartialText, onToolEvent);
  } finally {
    clearInterval(renewalInterval);
    store.releaseSessionLock(sessionId, lockId);
    store.setSessionRuntimeStatus(sessionId, 'idle');
  }
}

/**
 * Consume an SSE stream and extract response data.
 * Mirrors the collectStreamResponse() logic from chat/route.ts.
 */
async function consumeStream(
  stream: ReadableStream<string>,
  sessionId: string,
  onPermissionRequest?: OnPermissionRequest,
  onPartialText?: OnPartialText,
  onToolEvent?: OnToolEvent,
): Promise<ConversationResult> {
  const { store } = getBridgeContext();
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  /** Monotonically accumulated text for streaming preview — never resets on tool_use. */
  let previewText = '';
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  const seenToolResultIds = new Set<string>();
  const permissionRequests: PermissionRequestInfo[] = [];
  let capturedSdkSessionId: string | null = null;
  let shouldRefreshSession = false;

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
              const newBlock = {
                type: 'tool_result' as const,
                tool_use_id: resultData.tool_use_id,
                content: resultData.content,
                is_error: resultData.is_error || false,
              };
              if (seenToolResultIds.has(resultData.tool_use_id)) {
                const idx = contentBlocks.findIndex(
                  (b) => b.type === 'tool_result' && 'tool_use_id' in b && b.tool_use_id === resultData.tool_use_id
                );
                if (idx >= 0) contentBlocks[idx] = newBlock;
              } else {
                seenToolResultIds.add(resultData.tool_use_id);
                contentBlocks.push(newBlock);
              }
              if (shouldRefreshForToolResult(resultData.content)) {
                shouldRefreshSession = true;
              }
              if (onToolEvent) {
                try {
                  onToolEvent(
                    resultData.tool_use_id,
                    '', // name not available in tool_result, adapter tracks by id
                    resultData.is_error ? 'error' : 'complete',
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
        store.addMessage(sessionId, 'assistant', content, tokenUsage ? JSON.stringify(tokenUsage) : null);
      }
    }

    // Extract text-only response for IM delivery
    const responseText = contentBlocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    return {
      responseText,
      tokenUsage,
      hasError,
      errorMessage,
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
      shouldRefreshSession,
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
        store.addMessage(sessionId, 'assistant', content);
      }
    }

    const isAbort = e instanceof DOMException && e.name === 'AbortError'
      || e instanceof Error && e.name === 'AbortError';

    return {
      responseText: '',
      tokenUsage,
      hasError: true,
      errorMessage: isAbort ? 'Task stopped by user' : (e instanceof Error ? e.message : 'Stream consumption error'),
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
      shouldRefreshSession,
    };
  }
}
