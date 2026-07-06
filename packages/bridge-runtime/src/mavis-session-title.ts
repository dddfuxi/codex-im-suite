/**
 * Build a short mavis session title from `StreamChatParams`.
 *
 * `StreamChatParams` does **not** have a `title` field — codex-im-suite
 * `mavis session new` requires one. This helper derives a stable,
 * human-readable title from prompt / sourceMessageId / sessionId.
 *
 * Priority: prompt summary → sourceMessageId → sessionId tail.
 *
 * Title is **always** prefixed with `mavis:` so users can recognize
 * mavis-created sessions when listing them.
 */

import type { StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';

const MAX_TITLE_LEN = 64;
const MAX_PROMPT_SUMMARY_LEN = 30;
const FALLBACK_PREFIX = 'mavis:';

export function buildMavisSessionTitle(params: StreamChatParams): string {
  const base = summarizePrompt(params.prompt);
  if (base) return clamp(`${FALLBACK_PREFIX}${base}`, MAX_TITLE_LEN);

  if (params.sourceMessageId) {
    return clamp(`${FALLBACK_PREFIX}msg-${params.sourceMessageId}`, MAX_TITLE_LEN);
  }

  const tail = (params.sessionId || 'unknown').split(/[-_:]/).pop() || params.sessionId || 'unknown';
  return clamp(`${FALLBACK_PREFIX}${tail}`, MAX_TITLE_LEN);
}

function summarizePrompt(prompt: string | undefined): string {
  if (!prompt || typeof prompt !== 'string') return '';
  const flat = prompt.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  if (flat.length <= MAX_PROMPT_SUMMARY_LEN) return flat;
  return `${flat.slice(0, MAX_PROMPT_SUMMARY_LEN - 1)}…`;
}

function clamp(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen - 1)}…`;
}
