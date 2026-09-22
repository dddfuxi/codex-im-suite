import crypto from 'node:crypto';

import type { PromptSection, PromptSectionKind } from './prompt-composer.js';
import type { PromptSnapshotRecord, PromptSnapshotSectionRecord } from './host.js';

export interface CreatePromptSnapshotInput {
  sessionId: string;
  sections: PromptSection[];
  maxSectionChars?: number;
  maxSnapshotChars?: number;
  now?: () => Date;
}

function redactPromptText(value: string): { content: string; redacted: boolean } {
  let redacted = false;
  const replace = (pattern: RegExp, replacement: string): void => {
    const next = value.replace(pattern, replacement);
    if (next !== value) redacted = true;
    value = next;
  };
  replace(/((?:token|secret|password|api[_-]?key|app[_-]?secret)\s*[=:]\s*)[^\s,;"']+/giu, '$1[REDACTED]');
  replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/giu, '$1[REDACTED]');
  replace(/\b\d{8,12}:[A-Za-z0-9_-]{20,}\b/gu, '[REDACTED_TELEGRAM_TOKEN]');
  return { content: value, redacted };
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createPromptSnapshot(input: CreatePromptSnapshotInput): PromptSnapshotRecord {
  const maxSectionChars = Math.max(1, input.maxSectionChars ?? 8_000);
  const maxSnapshotChars = Math.max(maxSectionChars, input.maxSnapshotChars ?? 40_000);
  let remaining = maxSnapshotChars;
  const sections: PromptSnapshotSectionRecord[] = input.sections.map((section) => {
    const sanitized = redactPromptText(section.content);
    const sectionLimit = Math.min(maxSectionChars, remaining);
    const truncated = sanitized.content.length > sectionLimit;
    const content = truncated ? sanitized.content.slice(0, sectionLimit) : sanitized.content;
    remaining = Math.max(0, remaining - content.length);
    const truncationReason = truncated
      ? (sectionLimit < maxSectionChars ? 'snapshot_limit' : 'section_limit')
      : sanitized.redacted ? 'redacted' : undefined;
    return {
      id: section.id,
      kind: section.kind as PromptSectionKind,
      source: section.source,
      priority: section.priority,
      charCount: sanitized.content.length,
      hash: hash(sanitized.content),
      injected: section.injected !== false,
      truncated,
      ...(truncationReason ? { truncationReason } : {}),
      content,
    };
  });
  return {
    protocol: 'cti-prompt-snapshot/v1',
    sessionId: input.sessionId,
    createdAt: (input.now || (() => new Date()))().toISOString(),
    totalChars: sections.reduce((sum, section) => sum + section.charCount, 0),
    sections,
  };
}
