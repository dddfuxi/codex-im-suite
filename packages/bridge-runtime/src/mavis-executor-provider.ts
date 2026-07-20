/**
 * MavisExecutorProvider — first external agent executor for codex-im-suite.
 *
 * Implements the `LLMProvider.streamChat` contract by delegating the
 * work to a remote mavis session:
 *   1. `preDispatch(params)` runs the pre-dispatch phase:
 *      - assert workingDirectory is inside `allowedWorkspaceRoots`
 *      - look up binding for `params.sessionId`
 *      - if binding is fresh (< 24h) and mavis session still exists →
 *        `client.communicationSend({ to, command: 'prompt', content })`
 *      - else → `client.createSession({ agent, from: 'root', prompt, title, workspace })`
 *        and write a new binding.
 *      - any failure here is **recoverable** — caller may fall back to
 *        the Codex main chain.
 *
 *   2. `streamUntilFinish(params, binding, controller)` runs the
 *      post-dispatch phase:
 *      - poll `client.info(mvsSessionId)` until `status.type` is
 *        terminal (`finished` / `error` / `aborted`)
 *      - on success: emit `sseEvent('text', finalText)`, then map
 *        `client.diff()` to `sseEvent('tool_use', { name: 'Edit' })`
 *        pairs, then `sseEvent('result', { usage, session_id })`
 *      - on failure: `summarizeMavisFailureMessage(...)` →
 *        `sseEvent('error', { code, short })` (no raw stdout/stderr)
 *      - any failure here is **non-recoverable** — mavis has already
 *        taken the prompt; we must not duplicate work by falling back
 *        to Codex.
 *
 *   3. `streamChat(params)` is the `LLMProvider` entry point. The
 *      caller (`HubLlmProvider`) is expected to have decided to use us
 *      (via `ExecutorProviderRegistry.resolveForRequest`) and is OK
 *      with the two-phase model. We expose `preDispatch` so the
 *      caller can drive the pre-dispatch phase and decide on fallback
 *      between phases.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  LLMProvider,
  StreamChatParams,
  TurnStorageHost,
} from 'claude-to-im/src/lib/bridge/host.js';
import { formatPriorityTurnContext } from 'claude-to-im/src/lib/bridge/host.js';

import type { Config } from './config.js';
import { buildToolSandboxPolicy, inferCapabilities, listMavisReadOnlyForbiddenCapabilities, MAVIS_READ_ONLY_ALLOWED_CAPABILITIES } from './executor-registry.js';
import { sanitizeToolResult, summarizeMavisFailureMessage } from './mavis-failure-summarizer.js';
import { findBindingByMvs, findBindingBySource, readBindings, removeBinding, upsertBinding, type MavisSessionBinding } from './mavis-session-store.js';
import { buildMavisSessionTitle } from './mavis-session-title.js';
import { resolveProviderWorkspace } from './provider-workspace.js';
import { sseEvent } from './sse-utils.js';
import { createRuntimeTurnStorage } from './turn-storage.js';
import type {
  MavisClient,
  MavisCommunicationMessage,
  MavisDiff,
  MavisMessage,
  MavisSessionInfo,
} from './mavis-cli-client.js';

export interface MavisExecutorOptions {
  client: MavisClient;
  config: Config;
  agentName: string;             // default 'mavis'
  pollIntervalMs: number;        // default 1500
  hardTimeoutMs: number;         // default 480_000 (8 min)
  quietTimeoutMs: number;        // default 90_000
  maxDiffBytes: number;          // default 32_000
  turnStorage?: TurnStorageHost;
}

export type MavisSseErrorCode =
  | 'not_ready'
  | 'dispatch_failed'
  | 'remote_error'
  | 'aborted'
  | 'timeout'
  | 'send_failed'
  | 'evidence_lost'
  | 'partial_result'
  | 'workspace_denied'
  | 'workspace_empty'
  | 'read_only_violation'
  | 'json_parse'
  | 'unknown';

/**
 * v3.7 P1 fix: structured terminal result returned by `streamUntilFinish`.
 *
 * The previous implementation only emitted `sse('error', ...)` on
 * timeout / aborted / error / partial_result and then returned — the
 * caller (`streamExternalDispatch`) had no way to tell a failed remote
 * turn from a successful one, so it would still call
 * `completeWorkflowRun` and the panel would record `status: succeeded`
 * for what is actually a failed turn. That is a live-pre blocker: the
 * user sees an error SSE, but workflow / audit / control panel say
 * "succeeded".
 *
 * Now every exit path of `streamUntilFinish` returns a `MavisStreamResult`
 * whose `terminal` discriminates between `finished` and the failure
 * modes. Callers use this to drive workflow outcome
 * (`completeWorkflowRun` vs `failWorkflowRun` + auto-retry).
 */
export type MavisTerminalState =
  | 'finished'
  | 'timeout'
  | 'error'
  | 'aborted'
  | 'partial_result';

export interface MavisStreamResult {
  terminal: MavisTerminalState;
  errorCode?: MavisSseErrorCode;
  errorShort?: string;
}

/**
 * v3.8 P2 fix: explicit retryability map for Mavis terminal states.
 *
 * The previous implementation routed every non-`finished` terminal
 * through `shouldAutoRetryWorkflowError(workflowFailureError)`, which
 * defaults to `true` for unknown errors (its denylist is a narrow set
 * of `usage limit` / `401` / `405` / `/v1/responses` / `invalid request
 * parameter` strings). That meant a turn that was explicitly
 * **aborted** by the user or the remote would still enter
 * `requestWorkflowRetry(..., 'auto')`, and the daemon's retry worker
 * would claim and re-execute a cancelled prompt. Same risk for
 * `error` / `partial_result` if the prompt was a deterministic failure.
 *
 * This map pins the policy per terminal state. Callers
 * (`streamExternalDispatch`) MUST consult it instead of falling back to
 * the generic text-based heuristic. Adding a new `MavisTerminalState`
 * without updating this map becomes a TypeScript error.
 *
 * Per-terminal rationale:
 * - `aborted`      → **false**. User or remote explicitly cancelled.
 *                              Re-running the prompt would re-execute a
 *                              cancelled task — the exact "aborted gets
 *                              retried" bug codex called out at round 10.
 * - `timeout`      → **false**. `streamUntilFinish` already sends an
 *                              abort to the remote Mavis session on hard
 *                              timeout. Auto-retrying would re-dispatch
 *                              the same user turn and can create visible
 *                              bridge retry loops.
 * - `error`        → **false**. Remote reported `status: error`. Usually
 *                              a deterministic LLM-side failure (rate
 *                              limit, content filter, tool exception).
 *                              Auto-retry would burn tokens on a
 *                              failure we already have evidence for;
 *                              user can retry manually from the panel.
 * - `partial_result` → **false**. Status=finished but the message fetch
 *                              failed or the assistant never emitted text.
 *                              Re-running produces a *different*
 *                              partial result that's hard to merge; better
 *                              to surface as a hard failure and let the
 *                              user decide.
 * - `finished`     → **false**. Caller must not call this with `finished`,
 *                              but listed for completeness so the
 *                              function is total over `MavisTerminalState`.
 */
export const MAVIS_TERMINAL_AUTO_RETRYABLE: Readonly<Record<MavisTerminalState, boolean>> = {
  finished: false,
  timeout: false,
  error: false,
  aborted: false,
  partial_result: false,
};

export function isMavisTerminalAutoRetryable(terminal: MavisTerminalState): boolean {
  return MAVIS_TERMINAL_AUTO_RETRYABLE[terminal];
}

export class MavisSafetyError extends Error {
  readonly code: MavisSseErrorCode;
  constructor(code: MavisSseErrorCode, message: string) {
    super(message);
    this.name = 'MavisSafetyError';
    this.code = code;
  }
}

function sse(event: string, data: unknown): string {
  return sseEvent(event, data);
}

const RESUMPTION_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAVIS_PROGRESS_MAX_CHARS = 900;
const MAVIS_TEXT_STREAM_MIN_CHARS = 48;
const MAVIS_TEXT_STREAM_MAX_CHUNKS = 80;
const MAVIS_TEXT_STREAM_MAX_DELAY_MS = 80;

function isFresh(binding: MavisSessionBinding): boolean {
  const created = Date.parse(binding.createdAt);
  if (!Number.isFinite(created)) return false;
  return Date.now() - created < RESUMPTION_WINDOW_MS;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseMavisTimeMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function latestSessionActivityMs(info: MavisSessionInfo): number | undefined {
  const times = [
    parseMavisTimeMs(info.session?.lastActiveAt),
    parseMavisTimeMs(info.session?.updatedAt),
  ].filter((value): value is number => value !== undefined);
  return times.length > 0 ? Math.max(...times) : undefined;
}

function selectNewMavisMessages(
  messages: MavisMessage[],
  binding: MavisSessionBinding,
): { newMessages: MavisMessage[]; cursorFallback: boolean } {
  const sorted = [...messages].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const lastSeenId = binding.lastSeenMessageId;
  const cutoff = binding.lastSeenMessageTimestamp ?? binding.lastUserMessageTimestamp ?? 0;

  if (!lastSeenId) {
    return {
      newMessages: sorted.filter((m) => (m.timestamp ?? 0) > cutoff),
      cursorFallback: false,
    };
  }

  const idx = sorted.findIndex((m) => m.msg_id === lastSeenId);
  if (idx >= 0) {
    return { newMessages: sorted.slice(idx + 1), cursorFallback: false };
  }
  return {
    newMessages: sorted.filter((m) => (m.timestamp ?? 0) > cutoff),
    cursorFallback: true,
  };
}

function findFinalAssistantMessage(messages: MavisMessage[]): MavisMessage | undefined {
  return [...messages].reverse().find(
    (m) => m.role === 'assistant' && m.msg_type === 1 && !!m.msg_content,
  );
}

function sanitizeMavisProgressText(text: string): string {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return '';
  return normalized.length > MAVIS_PROGRESS_MAX_CHARS
    ? `${normalized.slice(0, MAVIS_PROGRESS_MAX_CHARS - 3)}...`
    : normalized;
}

function buildMavisProgressText(messages: MavisMessage[]): string {
  const toolNames = new Set<string>();
  let thinking = '';
  for (const message of messages) {
    for (const toolCall of message.tool_calls || []) {
      if (toolCall.name?.trim()) toolNames.add(toolCall.name.trim());
    }
    if (message.thinking_content?.trim()) {
      thinking = message.thinking_content;
    }
  }

  const parts: string[] = [];
  if (toolNames.size > 0) {
    parts.push(`工具进展：${Array.from(toolNames).slice(0, 6).join('、')} 已返回阶段性结果。`);
  }
  if (thinking) {
    // Mavis exposes this as user-visible thinking/progress. Keep it concise
    // and sanitized before it is appended to Feishu streaming cards.
    parts.push(`处理思路：${sanitizeMavisProgressText(thinking)}`);
  }
  return sanitizeMavisProgressText(parts.join('\n'));
}

function splitTextForStreaming(text: string): string[] {
  if (!text) return [];
  const chars = [...text];
  const chunkSize = Math.max(
    MAVIS_TEXT_STREAM_MIN_CHARS,
    Math.ceil(chars.length / MAVIS_TEXT_STREAM_MAX_CHUNKS),
  );
  const chunks: string[] = [];
  for (let index = 0; index < chars.length; index += chunkSize) {
    chunks.push(chars.slice(index, index + chunkSize).join(''));
  }
  return chunks;
}

function mavisCommunicationTimestampMs(message: MavisCommunicationMessage): number | undefined {
  const times = [message.time_created, message.time_processed]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return times.length > 0 ? Math.max(...times) : undefined;
}

function selectNewCommunicationMessages(
  messages: MavisCommunicationMessage[],
  binding: MavisSessionBinding,
  bridgeSenderSessionId: string | undefined,
): MavisCommunicationMessage[] {
  if (!bridgeSenderSessionId) return [];

  const dispatchAt = Date.parse(binding.lastDispatchAt || '');
  const timestampCutoff = Math.max(
    binding.lastSeenCommunicationTimestamp ?? 0,
    Number.isFinite(dispatchAt) ? dispatchAt : 0,
  );
  const lastSeenId = binding.lastSeenCommunicationId;

  return [...messages]
    .sort((a, b) => {
      const timeDelta = (mavisCommunicationTimestampMs(a) ?? 0) - (mavisCommunicationTimestampMs(b) ?? 0);
      return timeDelta !== 0 ? timeDelta : a.id - b.id;
    })
    .filter((message) => {
      if (message.from_session !== binding.mvsSessionId) return false;
      if (message.to_session !== bridgeSenderSessionId) return false;
      if (message.command !== 'prompt') return false;
      if (!message.content.trim()) return false;
      if (lastSeenId !== undefined && message.id <= lastSeenId) return false;

      const timestamp = mavisCommunicationTimestampMs(message);
      // Without a timestamp, only an increasing id cursor can prove this is
      // fresher than the last harvested communication reply.
      if (timestamp === undefined) return lastSeenId !== undefined && message.id > lastSeenId;
      return timestamp > timestampCutoff;
    });
}

function findFinalCommunicationMessage(messages: MavisCommunicationMessage[]): MavisCommunicationMessage | undefined {
  // Mavis may send the concise user answer to the source session before it
  // writes a later meta assistant message about a delivery failure.
  return messages.find((message) => !!message.content.trim());
}

function getLastMavisMessageCursor(messages: MavisMessage[]): {
  lastSeenId?: string;
  lastSeenTs?: number;
  lastUserTs?: number;
} {
  const sorted = [...messages].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const lastSeen = [...sorted].reverse().find((m) => !!m.msg_id);
  const lastUser = [...sorted].reverse().find((m) => m.role === 'user' && typeof m.timestamp === 'number');
  return {
    lastSeenId: lastSeen?.msg_id,
    lastSeenTs: typeof lastSeen?.timestamp === 'number' ? lastSeen.timestamp : undefined,
    lastUserTs: typeof lastUser?.timestamp === 'number' ? lastUser.timestamp : undefined,
  };
}

function buildTurnPrompt(params: StreamChatParams): string {
  // v3.1: we deliberately do not invent a "title" or wrap the prompt;
  // mavis daemon treats the content as the user turn. Conversation
  // history is already in mavis (binding.sessionId is the same
  // mavis session), so the daemon has full context.
  const priorityTurnContext = formatPriorityTurnContext(params.priorityTurnContext);
  const artifactBoundary = params.artifactDirectory?.trim()
    ? [
        'Runtime artifact boundary:',
        `- Generated deliverables / 生成产物默认写入：${path.resolve(params.artifactDirectory)}`,
        '- 生成产物不得默认写入项目工作区。只有当前用户明确要求修改该项目源码或资产时，才允许编辑项目内容。',
      ].join('\n')
    : '';
  const userRequest = priorityTurnContext
    ? `Current user request:\n${params.prompt || ''}`
    : params.prompt || '';
  return [priorityTurnContext, artifactBoundary, userRequest]
    .filter((part) => part.trim())
    .join('\n\n');
}

type SourceAwareStreamChatParams = StreamChatParams & {
  sourceChannelType?: string;
  sourceChatId?: string;
  sourceThreadId?: string;
};

function getSourceIdentity(params: StreamChatParams): { channelType?: string; chatId?: string; threadId?: string } {
  const source = params as SourceAwareStreamChatParams;
  return {
    channelType: source.sourceChannelType?.trim() || undefined,
    chatId: source.sourceChatId?.trim() || undefined,
    threadId: source.sourceThreadId?.trim() || undefined,
  };
}

function applySourceIdentity(binding: MavisSessionBinding, params: StreamChatParams): MavisSessionBinding {
  const source = getSourceIdentity(params);
  if (!source.channelType || !source.chatId) return binding;
  return {
    ...binding,
    sourceChannelType: source.channelType,
    sourceChatId: source.chatId,
    sourceThreadId: source.threadId,
    channelType: source.channelType,
    feishuChatId: source.channelType === 'feishu' ? source.chatId : binding.feishuChatId,
    feishuThreadId: source.channelType === 'feishu' ? source.threadId : binding.feishuThreadId,
  };
}

interface MavisInputFileRef {
  id: string;
  name: string;
  type: string;
  size: number;
  localPath: string;
}

function materializeMavisInputFiles(params: StreamChatParams, turnStorage: TurnStorageHost): MavisInputFileRef[] {
  const files = params.files?.filter((file) => file.type.toLowerCase().startsWith('image/')) ?? [];
  if (files.length === 0) return [];

  return turnStorage.stageInputFiles({
    sessionId: params.sessionId,
    turnId: params.turnId || params.sourceMessageId || crypto.randomUUID(),
    files,
  }).map((file): MavisInputFileRef => {
    return {
      id: file.id,
      name: file.name,
      type: file.type,
      size: file.size,
      localPath: file.filePath,
    };
  });
}

function buildTurnPromptWithInputFiles(params: StreamChatParams, inputFiles: MavisInputFileRef[]): string {
  const prompt = buildTurnPrompt(params);
  if (inputFiles.length === 0) return prompt;

  // Mavis `session new` / `communication send` currently accept text only.
  // Persisting bridge attachments and passing absolute local paths is the
  // only lossless CLI bridge until Mavis exposes a native attachment flag.
  const attachmentLines = [
    'Bridge-provided local input files:',
    ...inputFiles.flatMap((file, index) => [
      `- ${index + 1}. ${file.name || file.id} (${file.type}, ${file.size} bytes)`,
      `  Local path: ${file.localPath}`,
    ]),
    'Use these local paths as the actual attached media. For image or sticker turns, inspect the image before replying; if a vision MCP/tool is available (for example matrix_describe_images), call it with the absolute file path. Do not infer image content from file_key alone.',
  ];

  return [prompt, attachmentLines.join('\n')].filter((part) => part.trim()).join('\n\n');
}

function assertWorkspaceAllowed(workingDirectory: string, allowedRoots: string[]): void {
  if (!workingDirectory) {
    throw new MavisSafetyError('workspace_empty', '未提供 workingDirectory');
  }
  const normalized = path.resolve(workingDirectory);
  const roots = allowedRoots.map((r) => path.resolve(r));
  const ok = roots.some((root) => {
    const a = normalized.toLowerCase();
    const b = root.toLowerCase();
    return a === b || a.startsWith(b + path.sep);
  });
  if (!ok) {
    throw new MavisSafetyError(
      'workspace_denied',
      `workingDirectory ${normalized} 不在 allowedWorkspaceRoots ${JSON.stringify(roots)} 内`,
    );
  }
}

async function readDiffEvidence(
  client: MavisClient,
  sessionId: string,
  maxBytes: number,
): Promise<{ ok: boolean; diffs: MavisDiff[]; error?: string }> {
  try {
    const raw = await client.diff(sessionId);
    if (!raw || !Array.isArray(raw.diffs)) {
      return { ok: false, diffs: [], error: 'diff_payload_not_array' };
    }
    const sanitized: MavisDiff[] = [];
    for (const d of raw.diffs.slice(0, 200)) {
      if (typeof d?.path !== 'string' || !d.path) continue;
      if (!['add', 'update', 'delete'].includes(d.kind)) continue;
      sanitized.push({
        path: d.path.slice(0, 1000),
        kind: d.kind as MavisDiff['kind'],
        before: typeof d.before === 'string' ? d.before.slice(0, maxBytes) : undefined,
        after: typeof d.after === 'string' ? d.after.slice(0, maxBytes) : undefined,
      });
    }
    return { ok: true, diffs: sanitized };
  } catch (err) {
    return {
      ok: false,
      diffs: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function inferTaskKind(prompt: string): string | undefined {
  if (!prompt) return undefined;
  if (/\bgit\b|分支|提交|仓库|状态/u.test(prompt)) return 'repo_query';
  return undefined;
}

/**
 * v3.5 P1 fix: validate that a Mavis sessionId returned by the CLI is
 * non-empty AND has the canonical `mvs_*` shape. Without this check
 * `preDispatchNew` would write a binding with an empty `mvsSessionId`,
 * which the post-dispatch phase would then use to call `client.info('')`
 * / `client.messages('')`, polluting the audit log and breaking the
 * "post-dispatch is non-recoverable" invariant (the failure would be
 * observed AFTER `binding` is persisted, so a codex fallback would
 * risk double-execution).
 *
 * Returns `true` only for well-formed `mvs_<token>` strings; empty,
 * non-string, or malformed values return `false`.
 */
export function isValidMvsSessionId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (id.length < 5 || id.length > 256) return false;
  // First char of the token MUST be alphanumeric; subsequent chars may
  // include `_` and `-`. This rejects `mvs_` (empty token), `mvs__` (token
  // starts with `_`), and other shapes that are not plausible mavis
  // sessionIds. Real mavis sessionIds look like `mvs_<uuid>`.
  return /^mvs_[a-zA-Z0-9][a-zA-Z0-9_\-]*$/.test(id);
}

type BridgeSenderResolution =
  | { ok: true; from?: string }
  | { ok: false; reason: 'invalid' | 'unavailable' | 'archived' };

export class MavisExecutorProvider implements LLMProvider {
  private readonly opts: MavisExecutorOptions;
  private readonly allowedRoots: string[];
  private readonly turnStorage: TurnStorageHost;
  binding?: MavisSessionBinding;

  constructor(opts: MavisExecutorOptions) {
    this.opts = opts;
    this.allowedRoots = buildToolSandboxPolicy(opts.config).allowedWorkspaceRoots || [];
    this.turnStorage = opts.turnStorage || createRuntimeTurnStorage(opts.config);
  }

  async probe(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const status = await this.opts.client.status();
      if (status.status !== 'running') {
        return { ok: false, reason: `mavis daemon status: ${status.status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Look up the active binding for `sessionId` if any. */
  readBinding(sessionId: string): MavisSessionBinding | undefined {
    const all = readBindings(this.opts.config);
    return all[sessionId];
  }

  private async resolveBridgeSenderForResume(): Promise<BridgeSenderResolution> {
    const configuredSender = this.opts.config.mavisBridgeSessionId?.trim();
    if (!configuredSender) {
      return { ok: true, from: undefined };
    }
    if (!isValidMvsSessionId(configuredSender)) {
      return { ok: false, reason: 'invalid' };
    }
    try {
      const senderInfo = await this.opts.client.info(configuredSender);
      // Mavis marks archived sessions as `compressed`. Sending from such a
      // session makes the target agent try to report back to an address that
      // can no longer receive messages, which delays the Feishu turn and
      // returns meta failure text instead of the user's answer.
      if (!senderInfo.session || senderInfo.session.compressed === true) {
        return { ok: false, reason: 'archived' };
      }
      return { ok: true, from: configuredSender };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  /**
   * Pre-dispatch phase — recoverable. Caller may fall back to default
   * Codex chain on any thrown error.
   *
   * Two paths:
   * - Resume path: existing binding within 24h window → `communication send`
   * - New path: no binding (or expired / GC'd) → `session new`
   */
  async preDispatch(params: StreamChatParams): Promise<void> {
    // 1) workspace gate
    const providerWorkspace = resolveProviderWorkspace(params);
    const workingDirectory = providerWorkspace.workingDirectory || this.opts.config.defaultWorkDir;
    assertWorkspaceAllowed(workingDirectory, this.allowedRoots);

    // 2) readOnly gate — v3.5 + v3.6 P1 fix: capability allow-list + permissionMode.
    //
    // The v3.5 implementation rejected `file_write` / `mcp_ops` but kept
    // every other capability as implicitly allowed. That is a *blacklist*
    // gate — safe today but fragile: any future capability added to the
    // manifest that we forget to enumerate here would silently bypass
    // read-only mode. Worse, a prompt that inferred no write capability
    // (e.g. "删除 package.json" before v3.6 broadened the heuristic) would
    // also slip through.
    //
    // v3.6: switch to a strict allow-list. The mavis executor in read-only
    // mode may ONLY use capabilities in
    // `MAVIS_READ_ONLY_ALLOWED_CAPABILITIES` (`chat`, `repo_query`,
    // `file_read`, `image_input`). Anything else — `file_write`,
    // `mcp_ops`, or any new capability we add later — is rejected up
    // front. This is still a prompt-heuristic gate; the airtight fix is
    // passing a read-only sandbox flag to the mavis CLI in `createSession`,
    // which is tracked separately.
    if (this.opts.config.mavisReadOnly) {
      const required = inferCapabilities(params, undefined);
      const forbidden = listMavisReadOnlyForbiddenCapabilities(required);
      if (forbidden.length > 0) {
        throw new MavisSafetyError(
          'read_only_violation',
          `只读 executor 拒绝 capability：${forbidden.join(', ')}（允许：${Array.from(MAVIS_READ_ONLY_ALLOWED_CAPABILITIES).join(', ')}）`,
        );
      }
      // Belt-and-braces for explicit-mode callers — same as v3.5.
      if (params.permissionMode === 'acceptEdits') {
        throw new MavisSafetyError('read_only_violation', '只读 executor 拒绝 acceptEdits 模式');
      }
    }

    // 3) resume or new
    let existing = this.readBinding(params.sessionId);
    if (!existing) {
      existing = findBindingBySource(getSourceIdentity(params), this.opts.config);
    }
    if (existing && isFresh(existing)) {
      // Resume: probe, then send prompt
      let info: MavisSessionInfo;
      try {
        info = await this.opts.client.info(existing.mvsSessionId);
      } catch (err) {
        // info failed (likely 404 / GC'd) → drop binding and fall through to new path
        removeBinding(existing.bridgeSessionId, this.opts.config);
        return this.preDispatchNew(params, workingDirectory);
      }
      if (!info.session) {
        removeBinding(existing.bridgeSessionId, this.opts.config);
        return this.preDispatchNew(params, workingDirectory);
      }
      const bridgeSender = await this.resolveBridgeSenderForResume();
      if (!bridgeSender.ok) {
        removeBinding(existing.bridgeSessionId, this.opts.config);
        return this.preDispatchNew(params, workingDirectory);
      }
      let resumeCursor: ReturnType<typeof getLastMavisMessageCursor> | undefined;
      try {
        const { messages } = await this.opts.client.messages(existing.mvsSessionId, { limit: 50 });
        resumeCursor = getLastMavisMessageCursor(messages);
      } catch {
        // Cursor seeding is best-effort. Existing binding cursor still applies.
      }
      const sendResult = await this.opts.client.communicationSend({
        from: bridgeSender.from,
        to: existing.mvsSessionId,
        command: 'prompt',
        content: buildTurnPromptWithInputFiles(
          params,
          materializeMavisInputFiles(params, this.turnStorage),
        ),
        // Use a configured Mavis sender when the bridge process does not
        // inherit $__MAVIS_PARENT_SESSION_ID; never pass the bridge sessionId.
      });
      if (!sendResult.ok) {
        throw new MavisSafetyError(
          'send_failed',
          `mavis 端续聊入队失败：${sendResult.error || 'unknown'}`,
        );
      }
      this.binding = upsertBindingForResume(existing, this.opts.config, params, resumeCursor);
      return;
    }

    if (existing) {
      // Expired binding — drop and create new
      removeBinding(existing.bridgeSessionId, this.opts.config);
    }
    return this.preDispatchNew(params, workingDirectory);
  }

  private async preDispatchNew(params: StreamChatParams, workingDirectory: string): Promise<void> {
    const title = buildMavisSessionTitle(params);
    const turnPrompt = buildTurnPromptWithInputFiles(
      params,
      materializeMavisInputFiles(params, this.turnStorage),
    );
    const created = await this.opts.client.createSession({
      agent: this.opts.agentName,
      from: 'root',
      prompt: turnPrompt,
      title,
      workspace: workingDirectory,
    });
    // v3.5 P1 fix: validate the sessionId the CLI returned. The previous
    // implementation wrote a binding with whatever `created.session.sessionId`
    // was — including the empty string fallback in `MavisClient.createSession`.
    // That made `mavisSessionId: ''` indistinguishable from a successful
    // dispatch, so a downstream `client.info('')` failure would land in
    // post-dispatch (non-recoverable) instead of pre-dispatch (recoverable),
    // risking double-execution if the caller falls back to Codex.
    //
    // Reject malformed sessionId here so the caller can fall back.
    if (!isValidMvsSessionId(created.session?.sessionId)) {
      throw new MavisSafetyError(
        'dispatch_failed',
        `mavis CLI session new 未返回合法 sessionId：${JSON.stringify(created.session?.sessionId)}`,
      );
    }
    const model = created.session?.model || { provider_id: this.opts.agentName, model_id: 'unknown' };
    const now = nowIso();
    const next: MavisSessionBinding = applySourceIdentity({
      bridgeSessionId: params.sessionId,
      mvsSessionId: created.session.sessionId,
      agentName: this.opts.agentName,
      createdAt: now,
      lastTurnAt: now,
      lastDispatchAt: now,
      model: {
        provider_id: model.provider_id,
        model_id: model.model_id,
        variant: model.variant,
      },
    }, params);
    upsertBinding(next, this.opts.config);
    this.binding = next;
  }

  /**
   * Post-dispatch phase — non-recoverable. mavis has already taken
   * the prompt; any failure here must NOT fall back to Codex (that
   * would cause double-execution).
   */
  async streamUntilFinish(
    params: StreamChatParams,
    binding: MavisSessionBinding,
    controller: ReadableStreamDefaultController<string>,
  ): Promise<MavisStreamResult> {
    const startedAt = Date.now();
    let lastActiveAt = Date.now();
    let pollInterval = this.opts.pollIntervalMs;
    let finishedMessages: MavisMessage[] | undefined;
    let finishedCommunicationMessage: MavisCommunicationMessage | undefined;
    let lastProgressText = '';

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const emitProgress = (nextText: string): void => {
      const normalized = sanitizeMavisProgressText(nextText);
      if (!normalized || normalized === lastProgressText) return;
      const delta = lastProgressText && normalized.startsWith(lastProgressText)
        ? normalized.slice(lastProgressText.length)
        : `${lastProgressText ? '\n' : ''}${normalized}`;
      lastProgressText = normalized;
      if (delta.trim()) controller.enqueue(sse('progress', delta));
    };
    const emitFinalText = async (text: string): Promise<void> => {
      const chunks = splitTextForStreaming(text);
      const delayMs = Math.min(
        MAVIS_TEXT_STREAM_MAX_DELAY_MS,
        Math.max(0, this.opts.pollIntervalMs),
      );
      for (let index = 0; index < chunks.length; index += 1) {
        controller.enqueue(sse('text', chunks[index]));
        if (index < chunks.length - 1 && delayMs > 0) {
          await sleep(delayMs);
        }
      }
    };

    // initial info (to capture lastActiveAt)
    try {
      const initial = await this.opts.client.info(binding.mvsSessionId);
      lastActiveAt = latestSessionActivityMs(initial) ?? lastActiveAt;
    } catch {
      // tolerate — we still have a binding
    }

    let terminal: 'finished' | 'error' | 'aborted' | 'timeout' | null = null;
    while (true) {
      if (Date.now() - startedAt > this.opts.hardTimeoutMs) {
        terminal = 'timeout';
        break;
      }
      let info: MavisSessionInfo;
      try {
        info = await this.opts.client.info(binding.mvsSessionId);
      } catch (err) {
        // transient — keep polling until hard timeout
        await sleep(pollInterval);
        continue;
      }
      const status = info.session?.status || 'idle';
      if (status === 'finished') {
        terminal = 'finished';
        break;
      }
      if (status === 'error' || status === 'aborted') {
        terminal = status as 'error' | 'aborted';
        break;
      }

      try {
        const { messages } = await this.opts.client.messages(binding.mvsSessionId, { limit: 50 });
        const selected = selectNewMavisMessages(messages, binding);
        emitProgress(buildMavisProgressText(selected.newMessages));
        const finalAssistant = findFinalAssistantMessage(selected.newMessages);
        if (finalAssistant) {
          finishedMessages = messages;
          terminal = 'finished';
          break;
        }
        const latestMessageTs = Math.max(
          0,
          ...selected.newMessages
            .map((m) => m.timestamp ?? 0)
            .filter((timestamp) => timestamp > 0),
        );
        if (latestMessageTs > lastActiveAt) {
          lastActiveAt = latestMessageTs;
          pollInterval = this.opts.pollIntervalMs;
        }
      } catch {
        // Message peeking is best-effort. Status polling remains authoritative.
      }

      try {
        const bridgeSenderSessionId = this.opts.config.mavisBridgeSessionId;
        if (bridgeSenderSessionId) {
          const { messages } = await this.opts.client.communicationMessages({
            from: binding.mvsSessionId,
            to: bridgeSenderSessionId,
            limit: 20,
            status: 'all',
          });
          const newCommunicationMessages = selectNewCommunicationMessages(messages, binding, bridgeSenderSessionId);
          const finalCommunication = findFinalCommunicationMessage(newCommunicationMessages);
          if (finalCommunication) {
            finishedCommunicationMessage = finalCommunication;
            const activityMs = mavisCommunicationTimestampMs(finalCommunication);
            if (activityMs !== undefined) lastActiveAt = Math.max(lastActiveAt, activityMs);
            terminal = 'finished';
            break;
          }
          const latestCommunicationTs = Math.max(
            0,
            ...newCommunicationMessages
              .map((message) => mavisCommunicationTimestampMs(message) ?? 0)
              .filter((timestamp) => timestamp > 0),
          );
          if (latestCommunicationTs > lastActiveAt) {
            lastActiveAt = latestCommunicationTs;
            pollInterval = this.opts.pollIntervalMs;
          }
        }
      } catch {
        // Communication harvest is best-effort; normal session polling remains authoritative.
      }

      const activityMs = latestSessionActivityMs(info);
      if (activityMs !== undefined) {
        if (activityMs > lastActiveAt) {
          lastActiveAt = activityMs;
          pollInterval = this.opts.pollIntervalMs;
        } else if (Date.now() - lastActiveAt > this.opts.quietTimeoutMs) {
          // Quiet timeout is only a soft idle signal. Mavis communication
          // replies can arrive after session status/activity stops moving,
          // so only slow down polling here; hardTimeoutMs decides failure.
          if (pollInterval < 3000) {
            pollInterval = Math.min(3000, Math.floor(pollInterval * 1.5));
          }
        } else if (pollInterval < 3000) {
          // exponential-ish backoff after 3 idle polls
          pollInterval = Math.min(3000, Math.floor(pollInterval * 1.5));
        }
      }
      await sleep(pollInterval);
    }

    if (terminal === 'timeout') {
      try {
        await this.opts.client.communicationSend({
          to: binding.mvsSessionId,
          command: 'abort',
          content: '',
        });
      } catch { /* ignore */ }
      controller.enqueue(sse('error', {
        code: 'timeout',
        short: '远端调用超时',
      } satisfies { code: MavisSseErrorCode; short: string }));
      return { terminal: 'timeout', errorCode: 'timeout', errorShort: '远端调用超时' };
    }

    if (terminal === 'error' || terminal === 'aborted') {
      const errorCode: MavisSseErrorCode = terminal === 'aborted' ? 'aborted' : 'remote_error';
      const errorShort = terminal === 'aborted' ? '任务被中止' : '远端任务失败';
      controller.enqueue(sse('error', {
        code: errorCode,
        short: errorShort,
      } satisfies { code: MavisSseErrorCode; short: string }));
      return { terminal, errorCode, errorShort };
    }

    // finished: pull messages, find assistant final, emit SSE
    let finalText = '';
    let lastSeenId: string | undefined = binding.lastSeenMessageId;
    let lastSeenTs: number | undefined = binding.lastSeenMessageTimestamp;
    let lastUserTs: number | undefined = binding.lastUserMessageTimestamp;
    let lastSeenCommunicationId: number | undefined = binding.lastSeenCommunicationId;
    let lastSeenCommunicationTs: number | undefined = binding.lastSeenCommunicationTimestamp;
    let usage: { input_tokens?: number; output_tokens?: number } | undefined;
    let thinkingText: string | undefined;

    const applyCommunicationFinal = (message: MavisCommunicationMessage | undefined): void => {
      if (!message?.content.trim()) return;
      finalText = message.content;
      lastSeenCommunicationId = message.id || lastSeenCommunicationId;
      lastSeenCommunicationTs = mavisCommunicationTimestampMs(message) ?? lastSeenCommunicationTs;
    };

    try {
      const messages = finishedMessages
        ?? (await this.opts.client.messages(binding.mvsSessionId, { limit: 50 })).messages;
      const selected = selectNewMavisMessages(messages, binding);
      const newMessages = selected.newMessages;
      if (selected.cursorFallback) {
        controller.enqueue(sse('status', { cursorFallback: true }));
      }

      // tool calls
      for (const msg of newMessages) {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            const sanitized = sanitizeToolResult(
              typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result ?? ''),
            );
            controller.enqueue(sse('tool_use', {
              name: tc.name,
              input: tc.input,
            }));
            controller.enqueue(sse('tool_result', {
              content: sanitized,
              is_error: false,
            }));
          }
        }
        if (msg.thinking_content) thinkingText = msg.thinking_content;
        if (msg.usage) usage = msg.usage;
      }

      const finalAssistant = findFinalAssistantMessage(newMessages);
      if (finalAssistant?.msg_content) {
        finalText = finalAssistant.msg_content;
        lastSeenId = finalAssistant.msg_id || lastSeenId;
        lastSeenTs = finalAssistant.timestamp ?? lastSeenTs;
      }
      if (!finalText) {
        applyCommunicationFinal(finishedCommunicationMessage);
      }
      if (!finalText) {
        try {
          const bridgeSenderSessionId = this.opts.config.mavisBridgeSessionId;
          if (bridgeSenderSessionId) {
            const { messages: communicationMessages } = await this.opts.client.communicationMessages({
              from: binding.mvsSessionId,
              to: bridgeSenderSessionId,
              limit: 20,
              status: 'all',
            });
            applyCommunicationFinal(findFinalCommunicationMessage(
              selectNewCommunicationMessages(communicationMessages, binding, bridgeSenderSessionId),
            ));
          }
        } catch {
          // Keep the ordinary messages() result authoritative; communication
          // replies are an additional completion source, not a hard dependency.
        }
      }
      const ourUser = newMessages.find((m) => m.role === 'user');
      if (ourUser?.timestamp) lastUserTs = ourUser.timestamp;
    } catch (err) {
      controller.enqueue(sse('error', {
        code: 'partial_result',
        short: '终态完成但消息拉取失败',
      } satisfies { code: MavisSseErrorCode; short: string }));
      // still try to update binding
      writePostDispatchBinding(binding, {
        lastFinalText: finalText.slice(0, 500),
        lastSeenId,
        lastSeenTs,
        lastUserTs,
        lastSeenCommunicationId,
        lastSeenCommunicationTs,
      }, this.opts.config);
      return {
        terminal: 'partial_result',
        errorCode: 'partial_result',
        errorShort: '终态完成但消息拉取失败',
      };
    }

    // Emit thinking → text → result
    if (thinkingText) {
      emitProgress(buildMavisProgressText([
        { msg_id: 'final-thinking', role: 'assistant', msg_type: 1, thinking_content: thinkingText } as MavisMessage,
      ]));
      controller.enqueue(sse('status', { reasoning: thinkingText }));
    }
    if (finalText) {
      await emitFinalText(finalText);
    } else {
      // No text but status=finished — partial_result
      controller.enqueue(sse('error', {
        code: 'partial_result',
        short: '远端完成但未返回文本',
      } satisfies { code: MavisSseErrorCode; short: string }));
      // v3.7 P1: also persist binding + report a non-finished terminal
      // state so the caller records this turn as failed in workflow /
      // audit. The previous return-without-result path silently
      // produced a "succeeded" workflow even though no text was emitted.
      writePostDispatchBinding(binding, {
        lastFinalText: '',
        lastSeenId,
        lastSeenTs,
        lastUserTs,
        lastSeenCommunicationId,
        lastSeenCommunicationTs,
      }, this.opts.config);
      return {
        terminal: 'partial_result',
        errorCode: 'partial_result',
        errorShort: '远端完成但未返回文本',
      };
    }

    // diff evidence
    const diff = await readDiffEvidence(this.opts.client, binding.mvsSessionId, this.opts.maxDiffBytes);
    if (diff.ok) {
      for (const d of diff.diffs) {
        controller.enqueue(sse('tool_use', {
          name: 'Edit',
          input: { files: [d] },
        }));
        controller.enqueue(sse('tool_result', {
          content: '[diff 证据已记录]',
          is_error: false,
        }));
      }
    } else {
      controller.enqueue(sse('status', { evidence: 'lost', reason: diff.error }));
    }

    controller.enqueue(sse('result', {
      usage: usage || {},
      session_id: binding.mvsSessionId,
    }));

    writePostDispatchBinding(binding, {
      lastFinalText: finalText.slice(0, 500),
      lastSeenId,
      lastSeenTs,
      lastUserTs,
      lastSeenCommunicationId,
      lastSeenCommunicationTs,
    }, this.opts.config);
    return { terminal: 'finished' };
  }

  /**
   * `LLMProvider.streamChat` — exposed for direct use (e.g. tests).
   * In production the caller is `HubLlmProvider` which orchestrates
   * the two phases itself via `preDispatch` + `streamUntilFinish`.
   */
  streamChat(params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream<string>({
      start: async (controller) => {
        try {
          await this.preDispatch(params);
          if (!this.binding) {
            controller.enqueue(sse('error', {
              code: 'unknown',
              short: 'pre-dispatch 未产生 binding',
            } satisfies { code: MavisSseErrorCode; short: string }));
            controller.close();
            return;
          }
          await this.streamUntilFinish(params, this.binding, controller);
          controller.close();
        } catch (err) {
          const code: MavisSseErrorCode = err instanceof MavisSafetyError ? err.code : 'unknown';
          const short = err instanceof MavisSafetyError
            ? err.message
            : summarizeMavisFailureMessage(err instanceof Error ? err.message : String(err));
          controller.enqueue(sse('error', { code, short }));
          controller.close();
        }
      },
    });
  }
}

function upsertBindingForResume(
  existing: MavisSessionBinding,
  config: Config,
  params: StreamChatParams,
  cursor?: ReturnType<typeof getLastMavisMessageCursor>,
): MavisSessionBinding {
  const now = nowIso();
  const previousBridgeSessionId = existing.bridgeSessionId;
  const next: MavisSessionBinding = applySourceIdentity({
    ...existing,
    bridgeSessionId: params.sessionId,
    lastDispatchAt: now,
    lastSeenMessageId: cursor?.lastSeenId ?? existing.lastSeenMessageId,
    lastSeenMessageTimestamp: cursor?.lastSeenTs ?? existing.lastSeenMessageTimestamp,
    lastUserMessageTimestamp: cursor?.lastUserTs ?? existing.lastUserMessageTimestamp,
    lastTurnAt: now,
  }, params);
  upsertBinding(next, config);
  if (previousBridgeSessionId !== next.bridgeSessionId) {
    removeBinding(previousBridgeSessionId, config);
  }
  return next;
}

function writePostDispatchBinding(
  existing: MavisSessionBinding,
  patch: {
    lastFinalText: string;
    lastSeenId?: string;
    lastSeenTs?: number;
    lastUserTs?: number;
    lastSeenCommunicationId?: number;
    lastSeenCommunicationTs?: number;
  },
  config: Config,
): void {
  upsertBinding({
    ...existing,
    lastFinalText: patch.lastFinalText,
    lastSeenMessageId: patch.lastSeenId ?? existing.lastSeenMessageId,
    lastSeenMessageTimestamp: patch.lastSeenTs ?? existing.lastSeenMessageTimestamp,
    lastUserMessageTimestamp: patch.lastUserTs ?? existing.lastUserMessageTimestamp,
    lastSeenCommunicationId: patch.lastSeenCommunicationId ?? existing.lastSeenCommunicationId,
    lastSeenCommunicationTimestamp: patch.lastSeenCommunicationTs ?? existing.lastSeenCommunicationTimestamp,
    lastTurnAt: nowIso(),
  }, config);
}

// Export for tests
export const __internals = {
  assertWorkspaceAllowed,
  buildTurnPrompt,
  buildTurnPromptWithInputFiles,
  materializeMavisInputFiles,
  isFresh,
  RESUMPTION_WINDOW_MS,
  inferTaskKind,
  isValidMvsSessionId,
};

// Re-export findBindingByMvs for callers that want the reverse lookup
export { findBindingByMvs };

// Quiet unused-import warning when fs is referenced via fs.existsSync checks
void fs;
