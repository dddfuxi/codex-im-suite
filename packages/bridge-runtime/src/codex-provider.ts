/**
 * Codex Provider — LLMProvider implementation backed by @openai/codex-sdk.
 *
 * Maps Codex SDK thread events to the SSE stream format consumed by
 * the bridge conversation engine, making Codex a drop-in alternative
 * to the Claude Code SDK backend.
 *
 * Requires `@openai/codex-sdk` to be installed (optionalDependency).
 * The provider lazily imports the SDK at first use and throws a clear
 * error if it is not available.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';
import { CTI_HOME } from './config.js';
import { sseEvent } from './sse-utils.js';

/** MIME → file extension for temp image files. */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const SUMMARY_MARKER = '[[CTI_SUMMARY]]';
const DEFAULT_REASONING_EFFORT = 'low';
const DEFAULT_CONTEXT_CHAR_BUDGET = 12000;
const MAX_HISTORY_ENTRY_CHARS = 800;
const MAX_TOOL_RESULT_CHARS = 240;
const SHARED_CODEX_HOME_PATHS = ['skills', 'plugins', 'vendor_imports', 'rules'];
const STATE_DB_PATTERNS = [
  /^state_\d+\.sqlite(?:-shm|-wal)?$/i,
  /^logs_\d+\.sqlite(?:-shm|-wal)?$/i,
];

// All SDK types kept as `any` because @openai/codex-sdk is optional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ThreadInstance = any;

/**
 * Map bridge permission modes to Codex approval policies.
 * - 'acceptEdits' (code mode) → 'never' (execute directly unless the tool itself fails)
 * - 'plan' → 'on-request' (ask before executing)
 * - 'default' (ask mode) → 'on-request'
 */
function toApprovalPolicy(permissionMode?: string): string {
  switch (permissionMode) {
    case 'acceptEdits': return 'never';
    case 'plan': return 'on-request';
    case 'default': return 'on-request';
    default: return 'on-request';
  }
}

/**
 * Codex sandbox mode for bridge sessions.
 * Default to danger-full-access so bridge-side coding sessions do not get
 * blocked on repo metadata writes such as `.git/FETCH_HEAD`.
 */
function getSandboxMode(): string {
  return process.env.CTI_CODEX_SANDBOX_MODE || 'danger-full-access';
}

/** Whether to forward bridge model to Codex CLI. Default: false (use Codex current/default model). */
function shouldPassModelToCodex(): boolean {
  return process.env.CTI_CODEX_PASS_MODEL === 'true';
}

/** Allow Codex to run outside a trusted Git repository when explicitly enabled. */
function shouldSkipGitRepoCheck(): boolean {
  return process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK === 'true';
}

function shouldRetryFreshThread(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('resuming session with different model') ||
    lower.includes('no such session') ||
    (lower.includes('resume') && lower.includes('session'))
  );
}

function getReasoningEffort(): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  const raw = (process.env.CTI_CODEX_REASONING_EFFORT || DEFAULT_REASONING_EFFORT).trim().toLowerCase();
  switch (raw) {
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return raw;
    default:
      return DEFAULT_REASONING_EFFORT;
  }
}

function shouldResumeThreads(): boolean {
  return process.env.CTI_CODEX_RESUME_THREADS === 'true';
}

function getContextCharBudget(): number {
  return Math.max(
    4000,
    Number.parseInt(process.env.CTI_CODEX_CONTEXT_MAX_CHARS || `${DEFAULT_CONTEXT_CHAR_BUDGET}`, 10) || DEFAULT_CONTEXT_CHAR_BUDGET,
  );
}

function getGlobalCodexHome(): string {
  return process.env.CTI_CODEX_GLOBAL_HOME || path.join(os.homedir(), '.codex');
}

function getBridgeCodexHome(): string {
  return process.env.CTI_CODEX_HOME || path.join(CTI_HOME, 'runtime', 'codex-home');
}

function normalizeAdditionalDirectories(additionalDirectories?: string[]): string[] {
  if (!Array.isArray(additionalDirectories)) return [];
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const entry of additionalDirectories) {
    if (!entry || typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const absolute = path.resolve(trimmed);
    const dedupeKey = absolute.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    resolved.push(absolute);
  }
  return resolved;
}

function toTextEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function ensureSharedPath(sourcePath: string, targetPath: string): void {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return;
  const stats = fs.statSync(sourcePath);
  if (stats.isDirectory()) {
    try {
      fs.symlinkSync(sourcePath, targetPath, 'junction');
      return;
    } catch {
      fs.cpSync(sourcePath, targetPath, { recursive: true });
      return;
    }
  }
  fs.copyFileSync(sourcePath, targetPath);
}

function syncFileIfNewer(sourcePath: string, targetPath: string): void {
  if (!fs.existsSync(sourcePath)) return;
  if (!fs.existsSync(targetPath)) {
    fs.copyFileSync(sourcePath, targetPath);
    return;
  }
  const sourceStat = fs.statSync(sourcePath);
  const targetStat = fs.statSync(targetPath);
  if (sourceStat.mtimeMs > targetStat.mtimeMs || sourceStat.size !== targetStat.size) {
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function sanitizeCodexConfig(content: string, reasoningEffort: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const topLevel: string[] = [];
  const sections: string[] = [];
  let skipSection = false;
  let inTopLevel = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const sectionName = trimmed.slice(1, -1).trim();
      skipSection = sectionName === 'features' || sectionName.startsWith('features.');
      inTopLevel = false;
      if (!skipSection) sections.push(line);
      continue;
    }
    if (skipSection) continue;
    if (trimmed.startsWith('model_reasoning_effort')) continue;
    (inTopLevel ? topLevel : sections).push(line);
  }

  const normalizedTopLevel = topLevel.join('\n').trim();
  const normalizedSections = sections.join('\n').trim();
  return [
    normalizedTopLevel,
    `model_reasoning_effort = "${reasoningEffort}"`,
    normalizedSections,
  ]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n');
}

function resetBridgeStateDatabases(bridgeHome: string): void {
  if (process.env.CTI_CODEX_RESET_STATE === 'false') return;
  if (!fs.existsSync(bridgeHome)) return;
  for (const entry of fs.readdirSync(bridgeHome)) {
    if (!STATE_DB_PATTERNS.some((pattern) => pattern.test(entry))) continue;
    const target = path.join(bridgeHome, entry);
    try {
      fs.rmSync(target, { force: true });
    } catch {
      // best effort; ignore locked files
    }
  }
}

function ensureBridgeCodexHome(): string {
  const bridgeHome = getBridgeCodexHome();
  const globalHome = getGlobalCodexHome();
  const reasoningEffort = getReasoningEffort();

  fs.mkdirSync(bridgeHome, { recursive: true });
  fs.mkdirSync(path.join(bridgeHome, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(bridgeHome, 'archived_sessions'), { recursive: true });
  fs.mkdirSync(path.join(bridgeHome, 'tmp'), { recursive: true });
  resetBridgeStateDatabases(bridgeHome);

  syncFileIfNewer(path.join(globalHome, 'auth.json'), path.join(bridgeHome, 'auth.json'));

  for (const relativePath of SHARED_CODEX_HOME_PATHS) {
    ensureSharedPath(path.join(globalHome, relativePath), path.join(bridgeHome, relativePath));
  }

  const globalConfigPath = path.join(globalHome, 'config.toml');
  const bridgeConfigPath = path.join(bridgeHome, 'config.toml');
  const bridgeConfig = fs.existsSync(globalConfigPath)
    ? sanitizeCodexConfig(fs.readFileSync(globalConfigPath, 'utf-8'), reasoningEffort)
    : `model_reasoning_effort = "${reasoningEffort}"\n`;
  fs.writeFileSync(bridgeConfigPath, bridgeConfig, 'utf-8');

  return bridgeHome;
}

function normalizeText(text: string): string {
  return text
    .replace(/<!--files:[\s\S]*?-->/g, '[附带文件]')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(text: string, maxLen: number): string {
  const normalized = normalizeText(text);
  if (!normalized) return '';
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 3)}...` : normalized;
}

function getReplyStyleHint(): string {
  return (process.env.CTI_REPLY_STYLE_HINT || '').trim();
}

function buildBridgeReplyGuardrails(): string {
  const lines = [
    'Bridge reply contract:',
    '- User-facing reply must be concise and outcome-first.',
    '- Do not expose hidden reasoning, long planning narration, or step-by-step internal thought.',
    '- Execution details, troubleshooting steps, and intermediate progress belong to bridge logs/panel, not the final chat reply.',
    '- Prefer a short natural Chinese reply that states: what was done, the key result, and at most one next step if needed.',
    '- Keep only the essential result unless the user explicitly asks for a detailed walkthrough.',
    '- If the task is unfinished or blocked, state the exact blocker briefly instead of narrating your whole investigation.',
    '- Tone should be natural and light, similar to: 这个我做好啦…… / 这个已经处理完了……, but avoid repetitive filler.',
    '- If future style or memory hints are provided, follow them as long as they do not conflict with the rules above.',
  ];
  const styleHint = getReplyStyleHint();
  if (styleHint) {
    lines.push(`- Additional reply style hint: ${styleHint}`);
  }
  return lines.join('\n');
}

function summarizeToolBlocks(rawContent: string): string {
  try {
    const blocks = JSON.parse(rawContent) as Array<Record<string, unknown>>;
    const parts: string[] = [];
    for (const block of blocks) {
      if (block?.type === 'text') {
        const text = truncateText(String(block.text || ''), MAX_HISTORY_ENTRY_CHARS);
        if (text) parts.push(text);
        continue;
      }
      if (block?.type === 'tool_use') {
        const name = String(block.name || '');
        const input = block.input as { command?: unknown; files?: Array<{ path?: string; kind?: string }> } | undefined;
        if (name === 'Bash' && typeof input?.command === 'string') {
          parts.push(`工具 Bash: ${truncateText(input.command, 160)}`);
        } else if (name === 'Edit' && Array.isArray(input?.files)) {
          const files = input.files
            .slice(0, 4)
            .map((file) => `${String(file.kind || 'update')}:${String(file.path || '')}`)
            .join(', ');
          if (files) parts.push(`工具 Edit: ${files}`);
        } else if (name) {
          parts.push(`工具 ${name}`);
        }
        continue;
      }
      if (block?.type === 'tool_result') {
        const content = truncateText(String(block.content || ''), MAX_TOOL_RESULT_CHARS);
        if (content) parts.push(`结果: ${content}`);
      }
    }
    return truncateText(parts.join(' | '), MAX_HISTORY_ENTRY_CHARS);
  } catch {
    return truncateText(rawContent, MAX_HISTORY_ENTRY_CHARS);
  }
}

function serializeHistoryEntry(
  message: { role: 'user' | 'assistant'; content: string },
): string {
  const roleLabel = message.role === 'assistant' ? 'Assistant' : 'User';
  const rawContent = message.content || '';
  let content: string;

  if (rawContent.startsWith(SUMMARY_MARKER)) {
    content = truncateText(rawContent.slice(SUMMARY_MARKER.length), MAX_HISTORY_ENTRY_CHARS);
  } else if (rawContent.trim().startsWith('[')) {
    content = summarizeToolBlocks(rawContent);
  } else {
    content = truncateText(rawContent, MAX_HISTORY_ENTRY_CHARS);
  }

  return content ? `${roleLabel}: ${content}` : '';
}

function selectHistoryEntries(
  history: Array<{ role: 'user' | 'assistant'; content: string }> | undefined,
): string[] {
  if (!history || history.length === 0) return [];
  const budget = getContextCharBudget();
  const selected: string[] = [];
  let totalChars = 0;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = serializeHistoryEntry(history[index]);
    if (!entry) continue;
    const nextSize = totalChars + entry.length + 1;
    if (selected.length > 0 && nextSize > budget) break;
    selected.push(entry);
    totalChars = nextSize;
  }

  return selected.reverse();
}

function buildTurnPrompt(params: StreamChatParams): string {
  const sections: string[] = [];
  const systemPrompt = truncateText(params.systemPrompt || '', 4000);
  const historyEntries = selectHistoryEntries(params.conversationHistory);
  const userPrompt = params.prompt.trim();

  if (systemPrompt) {
    sections.push(`System instructions:\n${systemPrompt}`);
  }
  sections.push(`Bridge reply style:\n${buildBridgeReplyGuardrails()}`);
  if (historyEntries.length > 0) {
    sections.push(`Conversation context:\n${historyEntries.join('\n')}`);
  }
  sections.push(`Current user request:\n${userPrompt}`);
  return sections.join('\n\n');
}

export class CodexProvider implements LLMProvider {
  private sdk: CodexModule | null = null;
  private codex: CodexInstance | null = null;

  /** Maps session IDs to Codex thread IDs for resume. */
  private threadIds = new Map<string, string>();

  constructor(private pendingPerms: PendingPermissions) {}

  /**
   * Lazily load the Codex SDK. Throws a clear error if not installed.
   */
  private async ensureSDK(): Promise<{ sdk: CodexModule; codex: CodexInstance }> {
    if (this.sdk && this.codex) {
      return { sdk: this.sdk, codex: this.codex };
    }

    try {
      this.sdk = await (Function('return import("@openai/codex-sdk")')() as Promise<CodexModule>);
    } catch {
      throw new Error(
        '[CodexProvider] @openai/codex-sdk is not installed. ' +
        'Install it with: npm install @openai/codex-sdk'
      );
    }

    // Resolve API key: CTI_CODEX_API_KEY > CODEX_API_KEY > OPENAI_API_KEY > (login auth)
    const apiKey = process.env.CTI_CODEX_API_KEY
      || process.env.CODEX_API_KEY
      || process.env.OPENAI_API_KEY
      || undefined;
    const baseUrl = process.env.CTI_CODEX_BASE_URL || undefined;
    const bridgeCodexHome = ensureBridgeCodexHome();
    process.env.CODEX_HOME = bridgeCodexHome;
    const env = {
      ...toTextEnv(process.env),
      CODEX_HOME: bridgeCodexHome,
    };

    const CodexClass = this.sdk.Codex;
    this.codex = new CodexClass({
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      config: {
        model_reasoning_effort: getReasoningEffort(),
      },
      env,
    });

    return { sdk: this.sdk, codex: this.codex };
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          const tempFiles: string[] = [];
          try {
            const { codex } = await self.ensureSDK();

            // Resolve or create thread
            const inMemoryThreadId = self.threadIds.get(params.sessionId);
            if (params.forceFreshThread) {
              self.threadIds.delete(params.sessionId);
            }
            const resumeThreads = shouldResumeThreads();
            if (!resumeThreads) {
              self.threadIds.delete(params.sessionId);
            }
            let savedThreadId = (params.forceFreshThread || !resumeThreads)
              ? undefined
              : (params.sdkSessionId || inMemoryThreadId || undefined);

            const approvalPolicy = toApprovalPolicy(params.permissionMode);
            const passModel = shouldPassModelToCodex();
            const sandboxMode = getSandboxMode();
            const turnPrompt = buildTurnPrompt(params);
            const additionalDirectories = normalizeAdditionalDirectories(params.additionalDirectories);

            const threadOptions: Record<string, unknown> = {
              ...(passModel && params.model ? { model: params.model } : {}),
              ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
              ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
              ...(shouldSkipGitRepoCheck() ? { skipGitRepoCheck: true } : {}),
              approvalPolicy,
              sandboxMode,
              modelReasoningEffort: getReasoningEffort(),
            };

            // Build input: Codex SDK UserInput supports { type: "text" } and
            // { type: "local_image", path: string }. We write base64 data to
            // temp files so the SDK can read them as local images.
            const imageFiles = params.files?.filter(
              f => f.type.startsWith('image/')
            ) ?? [];

            let input: string | Array<Record<string, string>>;
            if (imageFiles.length > 0) {
              const parts: Array<Record<string, string>> = [
                { type: 'text', text: turnPrompt },
              ];
              for (const file of imageFiles) {
                const ext = MIME_EXT[file.type] || '.png';
                const tmpPath = path.join(os.tmpdir(), `cti-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
                fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
                tempFiles.push(tmpPath);
                parts.push({ type: 'local_image', path: tmpPath });
              }
              input = parts;
            } else {
              input = turnPrompt;
            }

            let retryFresh = false;

            while (true) {
              let thread: ThreadInstance;
              if (savedThreadId) {
                try {
                  thread = codex.resumeThread(savedThreadId, threadOptions);
                } catch {
                  thread = codex.startThread(threadOptions);
                }
              } else {
                thread = codex.startThread(threadOptions);
              }

              let sawAnyEvent = false;
              try {
                const { events } = await thread.runStreamed(input);

                for await (const event of events) {
                  sawAnyEvent = true;
                  if (params.abortController?.signal.aborted) {
                    break;
                  }

                  switch (event.type) {
                    case 'thread.started': {
                      const threadId = event.thread_id as string;
                      self.threadIds.set(params.sessionId, threadId);

                      controller.enqueue(sseEvent('status', {
                        session_id: threadId,
                      }));
                      break;
                    }

                    case 'item.completed': {
                      const item = event.item as Record<string, unknown>;
                      self.handleCompletedItem(controller, item);
                      break;
                    }

                    case 'turn.completed': {
                      const usage = event.usage as Record<string, unknown> | undefined;
                      const threadId = self.threadIds.get(params.sessionId);

                      controller.enqueue(sseEvent('result', {
                        usage: usage ? {
                          input_tokens: usage.input_tokens ?? 0,
                          output_tokens: usage.output_tokens ?? 0,
                          cache_read_input_tokens: usage.cached_input_tokens ?? 0,
                        } : undefined,
                        ...(threadId ? { session_id: threadId } : {}),
                      }));
                      break;
                    }

                    case 'turn.failed': {
                      const error = (event as { message?: string }).message;
                      controller.enqueue(sseEvent('error', error || 'Turn failed'));
                      break;
                    }

                    case 'error': {
                      const error = (event as { message?: string }).message;
                      controller.enqueue(sseEvent('error', error || 'Thread error'));
                      break;
                    }

                    // item.started, item.updated, turn.started — no action needed
                  }
                }
                break;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (savedThreadId && !retryFresh && !sawAnyEvent && shouldRetryFreshThread(message)) {
                  console.warn('[codex-provider] Resume failed, retrying with a fresh thread:', message);
                  savedThreadId = undefined;
                  retryFresh = true;
                  continue;
                }
                throw err;
              }
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[codex-provider] Error:', err instanceof Error ? err.stack || err.message : err);
            try {
              controller.enqueue(sseEvent('error', message));
              controller.close();
            } catch {
              // Controller already closed
            }
          } finally {
            // Clean up temp image files
            for (const tmp of tempFiles) {
              try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            }
          }
        })();
      },
    });
  }

  /**
   * Map a completed Codex item to SSE events.
   */
  private handleCompletedItem(
    controller: ReadableStreamDefaultController<string>,
    item: Record<string, unknown>,
  ): void {
    const itemType = item.type as string;

    switch (itemType) {
      case 'agent_message': {
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('text', text));
        }
        break;
      }

      case 'command_execution': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const command = item.command as string || '';
        const output = item.aggregated_output as string || '';
        const exitCode = item.exit_code as number | undefined;
        const isError = exitCode != null && exitCode !== 0;

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Bash',
          input: { command },
        }));

        const resultContent = output || (isError ? `Exit code: ${exitCode}` : 'Done');
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: resultContent,
          is_error: isError,
        }));
        break;
      }

      case 'file_change': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const changes = item.changes as Array<{ path: string; kind: string }> || [];
        const summary = changes.map(c => `${c.kind}: ${c.path}`).join('\n');

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Edit',
          input: { files: changes },
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: summary || 'File changes applied',
          is_error: false,
        }));
        break;
      }

      case 'mcp_tool_call': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const server = item.server as string || '';
        const tool = item.tool as string || '';
        const args = item.arguments as unknown;
        const result = item.result as { content?: unknown; structured_content?: unknown } | undefined;
        const error = item.error as { message?: string } | undefined;

        const resultContent = result?.content ?? result?.structured_content;
        const resultText = typeof resultContent === 'string' ? resultContent : (resultContent ? JSON.stringify(resultContent) : undefined);

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: `mcp__${server}__${tool}`,
          input: args,
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: error?.message || resultText || 'Done',
          is_error: !!error,
        }));
        break;
      }

      case 'reasoning': {
        // Reasoning is internal; emit as status
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('status', { reasoning: text }));
        }
        break;
      }
    }
  }
}
