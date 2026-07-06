/**
 * mavis session binding store.
 *
 * Maps `bridgeSessionId` → mavis session metadata so the bridge can resume
 * the same mavis session across Feishu turns.
 *
 * File: `${CTI_HOME}/runtime/mavis-session-bindings.json`
 *
 * Hard constraints (v3 design):
 * - **No secrets** in this file. The binding type only carries
 *   `bridgeSessionId / mvsSessionId / agentName / createdAt / ...` —
 *   tokens, app secrets, and full diff payloads are forbidden.
 * - Atomic writes via `tmp + rename` (same pattern as
 *   `executor-status.ts:70-76` and `executor-registry.ts:199-201`).
 * - 24-hour sliding window for resumption is enforced at the **caller**
 *   (`MavisExecutorProvider.preDispatch`), not here, so the store stays
 *   a dumb key/value.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME, type Config } from './config.js';

/**
 * Resolve the binding file path. We deliberately read
 * `process.env.CTI_HOME` at call time (rather than the imported
 * `CTI_HOME` constant) so unit tests can swap the home directory via
 * `process.env.CTI_HOME` between tests without re-importing the module.
 */
function getBindingsHome(): string {
  return process.env.CTI_HOME || CTI_HOME;
}

export interface MavisSessionBinding {
  bridgeSessionId: string;
  sourceChannelType?: string;
  sourceChatId?: string;
  sourceThreadId?: string;
  feishuChatId?: string;
  feishuThreadId?: string;
  channelType?: string;
  mvsSessionId: string;
  agentName: string;
  createdAt: string;
  lastTurnAt: string;
  // v2: 续聊游标
  lastDispatchAt?: string;
  lastSeenMessageId?: string;
  lastSeenMessageTimestamp?: number;
  lastUserMessageTimestamp?: number;
  lastSeenCommunicationId?: number;
  lastSeenCommunicationTimestamp?: number;
  lastFinalText?: string;
  model: { provider_id: string; model_id: string; variant?: string };
}

const SECRET_FIELD_BLACKLIST = [
  'token', 'secret', 'password', 'cookie', 'apikey', 'api_key',
  'auth', 'session_key', 'private',
];

function assertNoSecrets(binding: MavisSessionBinding): void {
  for (const key of Object.keys(binding)) {
    const lower = key.toLowerCase();
    if (SECRET_FIELD_BLACKLIST.some((needle) => lower.includes(needle))) {
      throw new Error(`[mavis-session-store] forbidden secret-like field: ${key}`);
    }
  }
  // Diff / raw tool result should never be in the binding model
  for (const forbidden of ['diffs', 'diff', 'rawToolResult', 'stdout', 'stderr'] as const) {
    if ((binding as unknown as Record<string, unknown>)[forbidden] !== undefined) {
      throw new Error(`[mavis-session-store] forbidden field on binding: ${forbidden}`);
    }
  }
}

function resolveFilePath(config?: Config): string {
  const home = (config && (config as unknown as { ctiHome?: string }).ctiHome) || getBindingsHome();
  return path.join(home, 'runtime', 'mavis-session-bindings.json');
}

function readRaw(filePath: string): Record<string, MavisSessionBinding> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.trim()) return {};
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, MavisSessionBinding>;
  } catch {
    return {};
  }
}

function writeRaw(filePath: string, data: Record<string, MavisSessionBinding>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

export function readBindings(config?: Config): Record<string, MavisSessionBinding> {
  return readRaw(resolveFilePath(config));
}

export function upsertBinding(binding: MavisSessionBinding, config?: Config): void {
  assertNoSecrets(binding);
  const filePath = resolveFilePath(config);
  const current = readRaw(filePath);
  current[binding.bridgeSessionId] = { ...current[binding.bridgeSessionId], ...binding };
  writeRaw(filePath, current);
}

export function removeBinding(bridgeSessionId: string, config?: Config): void {
  const filePath = resolveFilePath(config);
  const current = readRaw(filePath);
  if (!(bridgeSessionId in current)) return;
  delete current[bridgeSessionId];
  writeRaw(filePath, current);
}

export function findBindingByMvs(mvsSessionId: string, config?: Config): MavisSessionBinding | undefined {
  if (!mvsSessionId) return undefined;
  const all = readRaw(resolveFilePath(config));
  for (const binding of Object.values(all)) {
    if (binding.mvsSessionId === mvsSessionId) return binding;
  }
  return undefined;
}

export function findBindingBySource(
  source: { channelType?: string; chatId?: string; threadId?: string },
  config?: Config,
): MavisSessionBinding | undefined {
  const channelType = source.channelType?.trim();
  const chatId = source.chatId?.trim();
  if (!channelType || !chatId) return undefined;

  const all = Object.values(readRaw(resolveFilePath(config)));
  const candidates = all.filter((binding) => {
    const bindingChannelType = binding.sourceChannelType || binding.channelType;
    const bindingChatId = binding.sourceChatId || binding.feishuChatId;
    return bindingChannelType === channelType && bindingChatId === chatId;
  });
  if (candidates.length === 0) return undefined;

  const threadId = source.threadId?.trim();
  const threadMatched = threadId
    ? candidates.filter((binding) => (binding.sourceThreadId || binding.feishuThreadId) === threadId)
    : [];
  const pool = threadMatched.length > 0 ? threadMatched : candidates;
  return pool.sort((a, b) => {
    const aTime = Date.parse(a.lastTurnAt || a.createdAt || '');
    const bTime = Date.parse(b.lastTurnAt || b.createdAt || '');
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  })[0];
}
