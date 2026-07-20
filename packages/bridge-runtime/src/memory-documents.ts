import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { MEMORY_V3_SCHEMA, memoryPartitionSegment } from './memory-source-policy.js';
import {
  createManagedMemoryDocument,
  isSensitiveMemoryObservation,
  normalizeMemoryLine,
  readManagedMemoryDocument,
  sha256,
  writeManagedMemoryDocument,
} from './memory-items/managed-document.js';
import type {
  ManagedMemoryDocument,
  ManagedMemoryDocumentMetadata,
  MemoryEvidenceEntry,
  VisibleMemoryScope,
} from './memory-items/types.js';

export type { VisibleMemoryScope } from './memory-items/types.js';

export interface ConfirmedMemoryDocumentInput {
  memoryRoot: string;
  scope: VisibleMemoryScope;
  channelType?: string;
  userId?: string;
  chatId?: string;
  displayName?: string;
  pairs: Array<{ key: string; value: string }>;
  evidenceText: string;
  createdAt?: string;
}

export interface DerivedUserImpressionInput {
  memoryRoot: string;
  channelType: string;
  userId: string;
  displayName?: string;
  observations: Array<{ text: string; count: number }>;
  updatedAt?: string;
}

export function resolveMemoryDocumentPath(input: {
  memoryRoot: string;
  scope: VisibleMemoryScope;
  channelType?: string;
  userId?: string;
  chatId?: string;
}): string {
  const root = path.resolve(input.memoryRoot);
  if (input.scope === 'user') {
    if (!input.channelType?.trim() || !input.userId?.trim()) throw new Error('user memory requires channelType and userId');
    return path.join(root, 'memory', 'users', memoryPartitionSegment(input.channelType), memoryPartitionSegment(input.userId), '用户印象.md');
  }
  if (input.scope === 'group') {
    if (!input.channelType?.trim() || !input.chatId?.trim()) throw new Error('group memory requires channelType and chatId');
    return path.join(root, 'memory', 'groups', memoryPartitionSegment(input.channelType), memoryPartitionSegment(input.chatId), '群聊记忆.md');
  }
  return path.join(root, 'memory', 'long-term', '公共长期记忆.md');
}

function buildMetadata(input: {
  scope: VisibleMemoryScope;
  channelType?: string;
  userId?: string;
  chatId?: string;
  displayName?: string;
  updatedAt: string;
}): ManagedMemoryDocumentMetadata {
  return {
    schema: MEMORY_V3_SCHEMA,
    scope: input.scope,
    ...(input.scope !== 'long_term' && input.channelType ? { channelType: input.channelType } : {}),
    ...(input.scope === 'user' && input.userId ? { userId: input.userId } : {}),
    ...(input.scope === 'group' && input.chatId ? { chatId: input.chatId } : {}),
    ...(input.scope !== 'long_term' && input.displayName ? { displayName: input.displayName } : {}),
    updatedAt: input.updatedAt,
  };
}

function readOrCreateDocument(
  filePath: string,
  metadata: ManagedMemoryDocumentMetadata,
): ManagedMemoryDocument {
  if (!fs.existsSync(filePath)) return createManagedMemoryDocument(filePath, metadata);
  const document = readManagedMemoryDocument(filePath);
  document.metadata = {
    ...document.metadata,
    ...metadata,
    displayName: metadata.displayName || document.metadata.displayName,
  };
  return document;
}

function appendEvidence(
  evidence: MemoryEvidenceEntry[],
  text: string,
  createdAt: string,
): MemoryEvidenceEntry[] {
  if (!text || isSensitiveMemoryObservation(text)) return evidence;
  return [...evidence, { text, textHash: sha256(text), createdAt }].slice(-50);
}

export function upsertConfirmedMemoryDocument(input: ConfirmedMemoryDocumentInput): { filePath: string; updated: boolean } {
  const filePath = resolveMemoryDocumentPath(input);
  const timestamp = input.createdAt || new Date().toISOString();
  const document = readOrCreateDocument(filePath, buildMetadata({ ...input, updatedAt: timestamp }));
  let updated = false;
  for (const pair of input.pairs) {
    const key = normalizeMemoryLine(pair.key, 120);
    const value = normalizeMemoryLine(pair.value, 500);
    if (!key || !value || isSensitiveMemoryObservation(`${key}: ${value}`)) continue;
    const existing = document.state.confirmed[key];
    if (!existing || existing.value !== value) updated = true;
    document.state.confirmed[key] = {
      value,
      updatedAt: timestamp,
      confidence: 1,
      status: 'confirmed',
      sourceKind: 'explicit',
      lastEvidenceAt: timestamp,
    };
    delete document.state.candidates[key];
  }
  const evidenceText = normalizeMemoryLine(input.evidenceText, 500);
  document.state.evidence = appendEvidence(document.state.evidence, evidenceText, timestamp);
  writeManagedMemoryDocument(document, document.baseHash);
  return { filePath, updated };
}

export function materializeDerivedUserImpression(input: DerivedUserImpressionInput): { filePath: string; updated: boolean } {
  const filePath = resolveMemoryDocumentPath({
    memoryRoot: input.memoryRoot,
    scope: 'user',
    channelType: input.channelType,
    userId: input.userId,
  });
  const timestamp = input.updatedAt || new Date().toISOString();
  const document = readOrCreateDocument(filePath, buildMetadata({
    scope: 'user',
    channelType: input.channelType,
    userId: input.userId,
    displayName: input.displayName,
    updatedAt: timestamp,
  }));
  let updated = false;
  for (const observation of input.observations) {
    const value = normalizeMemoryLine(observation.text, 500);
    if (observation.count < 3 || !value || isSensitiveMemoryObservation(value)) continue;
    const key = `暂定-${crypto.createHash('sha1').update(value, 'utf8').digest('hex').slice(0, 10)}`;
    const confidence = Math.min(0.9, 0.55 + (observation.count - 3) * 0.08);
    const existing = document.state.candidates[key];
    if (!existing || existing.value !== value || existing.confidence !== confidence) updated = true;
    document.state.candidates[key] = {
      value,
      updatedAt: timestamp,
      confidence,
      status: 'candidate',
      sourceKind: 'candidate_observation',
      distinctSessionCount: observation.count,
      lastEvidenceAt: timestamp,
    };
  }
  if (updated || fs.existsSync(filePath)) {
    writeManagedMemoryDocument(document, document.baseHash);
  }
  return { filePath, updated };
}
