/**
 * Mavis CLI client.
 *
 * Spawns the local `mavis` CLI as a child process and parses its stdout
 * (which is sometimes prefixed with a status line and sometimes suffixed
 * with a `Note: ...` line) as JSON. v3 design requires that we use a
 * single robust extractor (`extractFirstCompleteJson` + `sliceAndParse`)
 * for every subcommand — never `lastIndexOf` / `Math.max(lastBrace, lastBracket)`
 * style heuristics, which fail on `[{...},{...}]\nNote` (the array tail
 * gets mistaken for the last object).
 *
 * Token / secret handling: this module never reads `MAVIS_AUTH_TOKEN`,
 * `OPENAI_API_KEY`, `feishuAppSecret`, `tgBotToken`, `discordBotToken`,
 * or `qqAppSecret`. If the caller wants auth they configure it in the
 * underlying mavis daemon, not in the bridge process.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Config } from './config.js';

export interface MavisClientOptions {
  cliPath: string;             // default 'mavis'
  dataDir?: string;
  port?: number;
  commandTimeoutMs: number;    // default 25_000
  extraArgs?: string[];
  config?: Config;             // optional, used only for binding-store paths
}

export interface MavisAgentSummary {
  agentName: string;
  agentRole: string;
  displayName: string;
  title?: string;
  status?: string;
}

export interface MavisSessionSummary {
  sessionId: string;
  agentName: string;
  agentRole: string;
  displayName: string;
  title: string;
  status?: string;
}

export interface MavisModelDescriptor {
  provider_id: string;
  model_id: string;
  variant?: string;
}

export interface MavisSessionInfo {
  session: {
    sessionId: string;
    agentName: string;
    agentRole: string;
    displayName: string;
    title: string;
    status: 'idle' | 'started' | 'finished' | 'error' | 'aborted' | string;
    compressed?: boolean;
    lastActiveAt?: string;
    updatedAt?: string;
    model: MavisModelDescriptor;
  };
}

export interface MavisMessage {
  msg_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  msg_type: 1 | 2 | number;  // 1=text, 2=tool_call
  msg_content?: string;
  tool_calls?: Array<{ name: string; input: unknown; result?: unknown }>;
  thinking_content?: string;
  timestamp?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface MavisCommunicationMessage {
  id: number;
  from_session: string;
  to_session: string;
  command: string;
  content: string;
  status: 'done' | 'failed' | string;
  result?: string | null;
  error?: string | null;
  time_created?: number;
  time_processed?: number;
}
export interface MavisDiff {
  path: string;
  kind: 'add' | 'update' | 'delete' | string;
  before?: string;
  after?: string;
}

export interface MavisClient {
  status(): Promise<{ status: 'running' | string; mode?: string; port?: number; uptimeSeconds?: number }>;
  listAgents(): Promise<MavisAgentSummary[]>;
  listSessions(agentName?: string): Promise<{ sessions: MavisSessionSummary[] }>;
  createSession(input: {
    agent: string;
    from?: 'root' | string;
    prompt: string;
    title?: string;
    workspace?: string;
    model?: string;
  }): Promise<MavisSessionInfo>;
  info(sessionId: string): Promise<MavisSessionInfo>;
  messages(sessionId: string, opts?: { limit?: number; before?: string }): Promise<{ messages: MavisMessage[]; nextCursor?: string }>;
  diff(sessionId: string): Promise<{ diffs: MavisDiff[] }>;
  communicationPeers(): Promise<{ sessions: MavisSessionSummary[]; count: number }>;
  communicationMessages(opts?: {
    from?: string;
    to?: string;
    limit?: number;
    status?: 'done' | 'failed' | 'all';
  }): Promise<{ messages: MavisCommunicationMessage[]; count?: number }>;
  /**
   * v3.2: `from` is **strongly recommended to be omitted** (lets mavis CLI
   * default to `$__MAVIS_PARENT_SESSION_ID`). Do NOT pass the bridge
   * sessionId — bridge sessionId is NOT a Mavis sessionId; mavis daemon
   * will reject or misclassify. If you really need `from`, it must be a
   * valid Mavis sessionId (`mvs_<uuid>`).
   */
  communicationSend(input: {
    from?: string;
    to: string;
    command: 'prompt' | 'abort' | 'kill' | 'summarize' | 'fork' | 'spawn';
    content: string;
  }): Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

export class MavisClientError extends Error {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stderrHead: string;
  readonly stdoutHead: string;

  constructor(
    code: string,
    command: string,
    exitCode: number | null,
    stdoutHead: string,
    stderrHead: string,
    cause?: unknown,
  ) {
    super(`[mavis-client] ${code} (${command}): ${stderrHead || stdoutHead || 'no output'}`);
    this.name = 'MavisClientError';
    this.command = command;
    this.exitCode = exitCode;
    this.stdoutHead = stdoutHead;
    this.stderrHead = stderrHead;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * From `stdout` extract the **first** complete JSON object or array,
 * tolerating both a leading status line and a trailing `Note: ...` line.
 *
 * Why this is the **only** extractor: `sliceAndParse` is depth-based from
 * the root `{` or `[`. As soon as the root closes (depth=0), the function
 * returns. Trailing `Note: ...`, `\n[other]`, etc. is naturally ignored
 * because the for-loop has already returned.
 */
function extractFirstCompleteJson(stdout: string): unknown {
  const text = stdout;
  const start = text.search(/[{[]/);
  if (start < 0) {
    throw new MavisClientError('no_json', 'parse', 0, text.slice(0, 200), '');
  }
  return sliceAndParse(text, start);
}

/**
 * Pair `{`/`}` or `[`/`]` from `start`, skipping string contents and
 * escapes. Stops at the first depth=0 close (root's matching close).
 * `start` must point at the root value's first character.
 */
function sliceAndParse(text: string, start: number): unknown {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (err) {
          throw new MavisClientError('json_parse', 'parse', 0, slice.slice(0, 200), '', err);
        }
      }
    }
  }
  throw new MavisClientError('json_incomplete', 'parse', 0, text.slice(start, start + 200), '');
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface MavisSpawnSpec {
  command: string;
  args: string[];
  displayCommand: string;
  env?: Record<string, string>;
}

interface MavisCreateSessionArgsInput {
  agent: string;
  from?: 'root' | string;
  prompt: string;
  title?: string;
  workspace?: string;
  model?: string;
}

interface MavisCommunicationMessagesArgsInput {
  from?: string;
  to?: string;
  limit?: number;
  status?: 'done' | 'failed' | 'all';
}

function buildMavisSpawnSpec(
  cliPath: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comSpec: string | undefined = process.env.ComSpec,
): MavisSpawnSpec {
  const displayCommand = [cliPath, ...args].join(' ');
  // Windows npm-style shims are often .cmd/.bat files. CreateProcess cannot
  // execute them directly. Prefer bypassing simple shims that only set env and
  // forward `%*` to a real executable: batch `%*` reparses multiline prompts
  // and symbols like `<` / `&`, which can drop the final positional agent.
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(cliPath.trim())) {
    const shim = resolveSimpleWindowsCmdShim(cliPath, args);
    if (shim) return shim;
    return {
      command: comSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', cliPath, ...args],
      displayCommand,
    };
  }
  return { command: cliPath, args, displayCommand };
}

function resolveSimpleWindowsCmdShim(cliPath: string, forwardedArgs: string[]): MavisSpawnSpec | undefined {
  let content = '';
  try {
    content = fs.readFileSync(cliPath, 'utf-8');
  } catch {
    return undefined;
  }

  const shimDir = path.dirname(cliPath);
  const env: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('@') || /^rem\b/i.test(line) || /^chcp\b/i.test(line)) continue;
    const setMatch = /^set\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/i.exec(line);
    if (setMatch) {
      env[setMatch[1]] = expandBatchShimToken(setMatch[2], shimDir, env);
      continue;
    }

    const parsed = parseForwardingCmdShimLine(line);
    if (!parsed) continue;
    const command = expandBatchShimToken(parsed.command, shimDir, env);
    if (!command || /\.(?:cmd|bat)$/i.test(command)) return undefined;
    const prefixArgs = parsed.prefixArgs.map((item) => expandBatchShimToken(item, shimDir, env));
    return {
      command,
      args: [...prefixArgs, ...forwardedArgs],
      displayCommand: [command, ...prefixArgs, ...forwardedArgs].join(' '),
      env: Object.keys(env).length > 0 ? env : undefined,
    };
  }
  return undefined;
}

function parseForwardingCmdShimLine(line: string): { command: string; prefixArgs: string[] } | undefined {
  const normalized = line.replace(/^call\s+/i, '').trim();
  const starIndex = normalized.indexOf('%*');
  if (starIndex < 0) return undefined;
  const prefix = normalized.slice(0, starIndex).trim();
  const tokens = tokenizeCmdShimPrefix(prefix);
  if (tokens.length === 0) return undefined;
  return { command: tokens[0], prefixArgs: tokens.slice(1) };
}

function tokenizeCmdShimPrefix(prefix: string): string[] {
  const tokens: string[] = [];
  let rest = prefix.trim();
  while (rest) {
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      if (end < 0) return [];
      tokens.push(rest.slice(1, end));
      rest = rest.slice(end + 1).trim();
      continue;
    }
    const match = /^(\S+)(?:\s+|$)/.exec(rest);
    if (!match) return [];
    tokens.push(match[1]);
    rest = rest.slice(match[0].length).trim();
  }
  return tokens;
}

function expandBatchShimToken(token: string, shimDir: string, env: Record<string, string>): string {
  const shimDirWithSep = shimDir.endsWith(path.sep) ? shimDir : `${shimDir}${path.sep}`;
  return token
    .replace(/%~dp0/gi, shimDirWithSep)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match, key: string) => env[key] ?? process.env[key] ?? '');
}

function buildMavisListSessionsArgs(agentName?: string): string[] {
  const args = ['list'];
  // Current Mavis CLI declares the agent as a positional `[agentId]`, not an
  // option flag. Keeping this in one helper prevents list/new from drifting
  // when the CLI contract changes again.
  if (agentName) args.push(agentName);
  return args;
}

function buildMavisCreateSessionArgs(input: MavisCreateSessionArgsInput): string[] {
  const args = ['new'];
  if (input.from) args.push('--from', input.from);
  args.push('--prompt', input.prompt);
  if (input.title) args.push('--title', input.title);
  if (input.workspace) args.push('--workspace', input.workspace);
  if (input.model) args.push('--model', input.model);
  // `mavis session new` is `new [options] <agent>` in the installed CLI.
  // Do not use the older `--agent` flag: that path is rejected before dispatch.
  args.push(input.agent);
  return args;
}

function buildMavisCommunicationMessagesArgs(input: MavisCommunicationMessagesArgsInput = {}): string[] {
  const args = ['messages'];
  if (input.from) args.push('--from', input.from);
  if (input.to) args.push('--to', input.to);
  if (input.limit) args.push('--limit', String(input.limit));
  if (input.status) args.push('--status', input.status);
  return args;
}

async function runMavis(
  cliPath: string,
  args: string[],
  commandTimeoutMs: number,
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    const spawnSpec = buildMavisSpawnSpec(cliPath, args);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: spawnSpec.env ? { ...process.env, ...spawnSpec.env } : process.env,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reject(new MavisClientError('spawn_failed', spawnSpec.displayCommand, null, '', message, err));
      return;
    }
    if (!child.stdout || !child.stderr) {
      reject(new MavisClientError('spawn_failed', spawnSpec.displayCommand, null, '', 'stdio pipes were not created'));
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 1_000).unref();
    }, commandTimeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new MavisClientError('spawn_failed', spawnSpec.displayCommand, null, '', err.message, err));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (killed) {
        reject(new MavisClientError('command_timeout', spawnSpec.displayCommand, code ?? null, stdout.slice(0, 200), stderr.slice(0, 200)));
        return;
      }
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

function parseStdoutAsJson(command: string, stdout: string, stderr: string, exitCode: number | null): unknown {
  if (exitCode !== 0) {
    throw new MavisClientError('non_zero_exit', command, exitCode, stdout.slice(0, 200), stderr.slice(0, 200));
  }
  try {
    return extractFirstCompleteJson(stdout);
  } catch (err) {
    if (err instanceof MavisClientError) throw err;
    throw new MavisClientError('json_parse', command, exitCode, stdout.slice(0, 200), stderr.slice(0, 200), err);
  }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asMavisStatus(value: unknown, fallback = 'idle'): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object') {
    const type = (value as Record<string, unknown>).type;
    if (typeof type === 'string' && type.trim()) return type;
  }
  return fallback;
}

function asTimestampString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    if (/^\d+$/.test(value)) {
      const n = Number(value);
      if (Number.isFinite(n)) return new Date(n).toISOString();
    }
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
}

export function createMavisClient(options: MavisClientOptions): MavisClient {
  const cliPath = options.cliPath || 'mavis';
  const commandTimeoutMs = options.commandTimeoutMs || 25_000;
  const baseArgs: string[] = [];
  if (options.dataDir) baseArgs.push('--data-dir', options.dataDir);
  if (options.port) baseArgs.push('--port', String(options.port));
  if (options.extraArgs) baseArgs.push(...options.extraArgs);

  async function exec(subcommand: string, args: string[]): Promise<unknown> {
    const fullArgs = [...baseArgs, subcommand, ...args];
    const result = await runMavis(cliPath, fullArgs, commandTimeoutMs);
    return parseStdoutAsJson(subcommand, result.stdout, result.stderr, result.exitCode);
  }

  return {
    async status() {
      const json = (await exec('status', [])) as Record<string, unknown>;
      return {
        status: asString(json.status, 'unknown'),
        mode: asString(json.mode) || undefined,
        port: asNumber(json.port),
        uptimeSeconds: asNumber(json.uptimeSeconds),
      };
    },

    async listAgents() {
      const json = await exec('agent', ['list']);
      const arr = Array.isArray(json) ? json : (Array.isArray((json as { agents?: unknown }).agents) ? (json as { agents: unknown[] }).agents : []);
      return arr.map((raw): MavisAgentSummary => {
        const r = raw as Record<string, unknown>;
        return {
          agentName: asString(r.agentName || r.name),
          agentRole: asString(r.agentRole || r.role, 'agent'),
          displayName: asString(r.displayName || r.agentName || r.name),
          title: asString(r.title) || undefined,
          status: asString(r.status) || undefined,
        };
      });
    },

    async listSessions(agentName?: string) {
      const json = (await exec('session', buildMavisListSessionsArgs(agentName))) as Record<string, unknown>;
      const arr = Array.isArray(json.sessions) ? json.sessions : [];
      return {
        sessions: arr.map((raw): MavisSessionSummary => {
          const r = raw as Record<string, unknown>;
          return {
            sessionId: asString(r.sessionId || r.id),
            agentName: asString(r.agentName),
            agentRole: asString(r.agentRole, 'agent'),
            displayName: asString(r.displayName || r.agentName),
            title: asString(r.title),
            status: asMavisStatus(r.status, '') || undefined,
          };
        }),
      };
    },

    async createSession(input) {
      const json = (await exec('session', buildMavisCreateSessionArgs(input))) as Record<string, unknown>;
      const sessionRaw = (json.session && typeof json.session === 'object' ? json.session : json) as Record<string, unknown>;
      return {
        session: {
          sessionId: asString(sessionRaw.sessionId || sessionRaw.id),
          agentName: asString(sessionRaw.agentName || input.agent),
          agentRole: asString(sessionRaw.agentRole, 'agent'),
          displayName: asString(sessionRaw.displayName || sessionRaw.agentName || input.agent),
          title: asString(sessionRaw.title || input.title),
          status: asMavisStatus(sessionRaw.status, 'idle'),
          compressed: asBoolean(sessionRaw.compressed),
          lastActiveAt: asTimestampString(sessionRaw.lastActiveAt),
          updatedAt: asTimestampString(sessionRaw.updatedAt),
          model: parseModelDescriptor(sessionRaw.model, input.agent),
        },
      };
    },

    async info(sessionId) {
      const json = (await exec('session', ['info', sessionId])) as Record<string, unknown>;
      const sessionRaw = (json.session && typeof json.session === 'object' ? json.session : json) as Record<string, unknown>;
      return {
        session: {
          sessionId: asString(sessionRaw.sessionId || sessionId),
          agentName: asString(sessionRaw.agentName),
          agentRole: asString(sessionRaw.agentRole, 'agent'),
          displayName: asString(sessionRaw.displayName || sessionRaw.agentName),
          title: asString(sessionRaw.title),
          status: asMavisStatus(sessionRaw.status, 'idle'),
          compressed: asBoolean(sessionRaw.compressed),
          lastActiveAt: asTimestampString(sessionRaw.lastActiveAt),
          updatedAt: asTimestampString(sessionRaw.updatedAt),
          model: parseModelDescriptor(sessionRaw.model, asString(sessionRaw.agentName)),
        },
      };
    },

    async messages(sessionId, opts) {
      const args: string[] = [];
      if (opts?.limit) args.push('--limit', String(opts.limit));
      if (opts?.before) args.push('--before', opts.before);
      const json = (await exec('session', ['messages', sessionId, ...args])) as Record<string, unknown>;
      const arr = Array.isArray(json.messages) ? json.messages : [];
      return {
        messages: arr.map((raw): MavisMessage => {
          const r = raw as Record<string, unknown>;
          return {
            msg_id: asString(r.msg_id || r.id),
            role: (asString(r.role, 'assistant') as MavisMessage['role']),
            msg_type: (typeof r.msg_type === 'number' ? r.msg_type : 1),
            msg_content: asString(r.msg_content || r.content) || undefined,
            tool_calls: Array.isArray(r.tool_calls) ? r.tool_calls as MavisMessage['tool_calls'] : undefined,
            thinking_content: asString(r.thinking_content) || undefined,
            timestamp: asNumber(r.timestamp),
            usage: (r.usage && typeof r.usage === 'object' ? r.usage as MavisMessage['usage'] : undefined),
          };
        }),
        nextCursor: asString(json.nextCursor) || undefined,
      };
    },

    async diff(sessionId) {
      const json = (await exec('session', ['diff', sessionId])) as Record<string, unknown>;
      const arr = Array.isArray(json.diffs) ? json.diffs : [];
      return {
        diffs: arr.map((raw): MavisDiff => {
          const r = raw as Record<string, unknown>;
          return {
            path: asString(r.path),
            kind: asString(r.kind, 'update'),
            before: asString(r.before) || undefined,
            after: asString(r.after) || undefined,
          };
        }),
      };
    },

    async communicationPeers() {
      const json = (await exec('communication', ['peers'])) as Record<string, unknown>;
      const arr = Array.isArray(json.sessions) ? json.sessions : [];
      return {
        sessions: arr.map((raw): MavisSessionSummary => {
          const r = raw as Record<string, unknown>;
          return {
            sessionId: asString(r.sessionId || r.id),
            agentName: asString(r.agentName),
            agentRole: asString(r.agentRole, 'agent'),
            displayName: asString(r.displayName || r.agentName),
            title: asString(r.title),
            status: asMavisStatus(r.status, '') || undefined,
          };
        }),
        count: typeof json.count === 'number' ? json.count : arr.length,
      };
    },

    async communicationMessages(opts) {
      const json = (await exec('communication', buildMavisCommunicationMessagesArgs(opts))) as Record<string, unknown>;
      const arr = Array.isArray(json.messages) ? json.messages : [];
      return {
        messages: arr.map((raw): MavisCommunicationMessage => {
          const r = raw as Record<string, unknown>;
          return {
            id: asNumber(r.id) ?? 0,
            from_session: asString(r.from_session || r.fromSession),
            to_session: asString(r.to_session || r.toSession),
            command: asString(r.command),
            content: asString(r.content),
            status: asString(r.status, 'done') as MavisCommunicationMessage['status'],
            result: r.result === null ? null : (asString(r.result) || undefined),
            error: r.error === null ? null : (asString(r.error) || undefined),
            time_created: asNumber(r.time_created || r.timeCreated),
            time_processed: asNumber(r.time_processed || r.timeProcessed),
          };
        }),
        count: typeof json.count === 'number' ? json.count : arr.length,
      };
    },
    async communicationSend(input) {
      const args: string[] = [];
      // v3.2: do NOT pass `from` — let mavis CLI use default $__MAVIS_PARENT_SESSION_ID.
      // If the caller really wants `from`, they may pass it; it must be a valid
      // Mavis sessionId, not the bridge sessionId.
      if (input.from) args.push('--from', input.from);
      args.push('--to', input.to, '--command', input.command, '--content', input.content);
      try {
        const json = (await exec('communication', ['send', ...args])) as Record<string, unknown>;
        return {
          ok: json.ok !== false,
          result: json.result,
          error: asString(json.error) || undefined,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

function parseModelDescriptor(raw: unknown, fallbackAgent: string): MavisModelDescriptor {
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    return {
      provider_id: asString(r.provider_id, fallbackAgent || 'mavis'),
      model_id: asString(r.model_id, 'unknown'),
      variant: asString(r.variant) || undefined,
    };
  }
  return { provider_id: fallbackAgent || 'mavis', model_id: 'unknown' };
}

// Export for unit tests
export const __internals = {
  extractFirstCompleteJson,
  sliceAndParse,
  buildMavisSpawnSpec,
  buildMavisListSessionsArgs,
  buildMavisCreateSessionArgs,
  buildMavisCommunicationMessagesArgs,
  asMavisStatus,
  asTimestampString,
  asBoolean,
};
