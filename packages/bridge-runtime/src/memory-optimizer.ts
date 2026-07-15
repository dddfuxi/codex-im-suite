import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  archiveKnowledgeItem,
  listKnowledgeArchives,
  restoreKnowledgeArchive,
} from './knowledge-archive.js';
import { readKnowledgeIndex, type KnowledgeIndex, type KnowledgeItem } from './knowledge-indexer.js';
import { rebuildKnowledgeIndex } from './knowledge-index-service.js';
import { rebuildReminderIndexFromKnowledge } from './todo-reminders.js';
import type { Config } from './config.js';
import { classifyMemoryV2Source } from './memory-source-policy.js';

export type MemoryOptimizationActionType = 'add' | 'update' | 'archive';
export type MemoryOptimizationRisk = 'low' | 'medium' | 'high';
export type MemoryOptimizerModelSource = 'codex_primary' | 'local_ai' | 'external_api';
export type MemorySourceGroup = 'memory_user' | 'memory_group' | 'memory_long_term' | 'direct_reminder' | 'other';

export interface MemorySourceSummaryItem {
  sourcePath: string;
  sourceGroup: MemorySourceGroup;
  itemCount: number;
  updatedAt?: string;
  autoSelectable: boolean;
  defaultRisk: MemoryOptimizationRisk;
}

export interface MemoryOptimizationAction {
  id: string;
  type: MemoryOptimizationActionType;
  title: string;
  reason: string;
  confidence: number;
  risk: MemoryOptimizationRisk;
  sourceGroup?: MemorySourceGroup;
  defaultSelected?: boolean;
  requiresManualReview?: boolean;
  source?: {
    itemId?: string;
    path?: string;
    snippet?: string;
  };
  targetPath?: string;
  before?: string;
  after?: string;
}

export interface MemoryOptimizationDraft {
  schema: 'codex-im-suite/memory-optimization-draft/v1';
  draftId: string;
  generatedAt: string;
  generatedBy: 'manual' | 'schedule';
  status: 'draft' | 'applied' | 'discarded' | 'undone';
  sourceIndexGeneratedAt: string;
  summary: string;
  sourceSummary?: MemorySourceSummaryItem[];
  actions: MemoryOptimizationAction[];
  appliedAt?: string;
  discardedAt?: string;
  undoneAt?: string;
  appliedActionIds?: string[];
  skippedActionIds?: string[];
  undoRestoredActionIds?: string[];
  undoManualActionIds?: string[];
  undoMissingArchiveActionIds?: string[];
}

export interface MemoryOptimizerState {
  schema: 'codex-im-suite/memory-optimizer-state/v1';
  enabled: boolean;
  intervalDays: number;
  modelSource: MemoryOptimizerModelSource;
  lastGeneratedAt?: string;
  nextRunAt?: string;
  draftCount: number;
  recentError?: string;
  lastAppliedAt?: string;
  lastDiscardedAt?: string;
  lastUndoAt?: string;
  updatedAt: string;
}

export interface MemoryOptimizationStatus {
  schema: 'codex-im-suite/memory-optimization-status/v1';
  memoryRoot: string;
  statePath: string;
  draftsDir: string;
  enabled: boolean;
  intervalDays: number;
  modelSource: MemoryOptimizerModelSource;
  lastGeneratedAt?: string;
  nextRunAt?: string;
  draftCount: number;
  recentError?: string;
  drafts: MemoryOptimizationDraft[];
}

export interface MemoryOptimizerService {
  close: () => void;
  status: () => MemoryOptimizationStatus;
}

const DRAFT_SCHEMA: MemoryOptimizationDraft['schema'] = 'codex-im-suite/memory-optimization-draft/v1';
const STATE_SCHEMA: MemoryOptimizerState['schema'] = 'codex-im-suite/memory-optimizer-state/v1';
const STATUS_SCHEMA: MemoryOptimizationStatus['schema'] = 'codex-im-suite/memory-optimization-status/v1';
const DEFAULT_INTERVAL_DAYS = 7;
const SERVICE_TICK_MS = 60 * 60 * 1000;

export function getMemoryOptimizationDraftsDir(memoryRoot: string): string {
  return path.join(path.resolve(memoryRoot), '.cti-index', 'memory-optimization-drafts');
}

export function getMemoryOptimizerStatePath(memoryRoot: string): string {
  return path.join(path.resolve(memoryRoot), '.cti-index', 'memory-optimizer-state.json');
}

export function readMemoryOptimizationStatus(memoryRoot: string): MemoryOptimizationStatus {
  const root = path.resolve(memoryRoot);
  const state = readMemoryOptimizerState(root);
  const drafts = listMemoryOptimizationDrafts(root);
  return {
    schema: STATUS_SCHEMA,
    memoryRoot: root,
    statePath: getMemoryOptimizerStatePath(root),
    draftsDir: getMemoryOptimizationDraftsDir(root),
    enabled: state.enabled,
    intervalDays: state.intervalDays,
    modelSource: state.modelSource,
    lastGeneratedAt: state.lastGeneratedAt,
    nextRunAt: state.nextRunAt,
    draftCount: drafts.filter((draft) => draft.status === 'draft').length,
    recentError: state.recentError,
    drafts,
  };
}

export function createMemoryOptimizationDraft(
  memoryRoot: string,
  options: { generatedBy?: 'manual' | 'schedule'; modelSource?: MemoryOptimizerModelSource } = {},
): MemoryOptimizationDraft {
  const root = path.resolve(memoryRoot);
  let index = readKnowledgeIndex(root);
  if (!index) {
    const status = rebuildKnowledgeIndex(root);
    if (status.lastError) throw new Error(status.lastError);
    index = readKnowledgeIndex(root);
  }
  if (!index) {
    throw new Error('记忆索引不存在，无法生成整理草稿。');
  }

  const generatedAt = new Date().toISOString();
  const draftId = makeDraftId(generatedAt);
  const sourceSummary = buildSourceSummary(root, index);
  const actions = buildOptimizationActions(root, index, draftId);
  const draft: MemoryOptimizationDraft = {
    schema: DRAFT_SCHEMA,
    draftId,
    generatedAt,
    generatedBy: options.generatedBy || 'manual',
    status: 'draft',
    sourceIndexGeneratedAt: index.generatedAt,
    summary: summarizeActions(index, actions),
    sourceSummary,
    actions,
  };
  writeDraft(root, draft);

  const state = readMemoryOptimizerState(root);
  const nextState: MemoryOptimizerState = {
    ...state,
    modelSource: options.modelSource || state.modelSource,
    lastGeneratedAt: generatedAt,
    nextRunAt: computeNextRun(generatedAt, state.intervalDays),
    draftCount: listMemoryOptimizationDrafts(root).filter((item) => item.status === 'draft').length,
    recentError: '',
    updatedAt: new Date().toISOString(),
  };
  writeMemoryOptimizerState(root, nextState);
  return draft;
}

export function applyMemoryOptimizationDraft(
  memoryRoot: string,
  input: { draftId: string; selectedActionIds?: string[]; excludedActionIds?: string[] },
): { ok: true; draft: MemoryOptimizationDraft; appliedActionIds: string[]; skippedActionIds: string[] } {
  const root = path.resolve(memoryRoot);
  const draft = readDraft(root, input.draftId);
  if (!draft) throw new Error('未找到记忆整理草稿。');
  if (draft.status !== 'draft') throw new Error('该草稿已经处理，不能重复应用。');

  const currentIndex = ensureCurrentIndex(root);
  if (currentIndex.generatedAt !== draft.sourceIndexGeneratedAt) {
    throw new Error('记忆索引已变化，请重新生成整理草稿后再应用。');
  }

  const selected = resolveSelectedActionIds(draft, input);
  const appliedActionIds: string[] = [];
  const skippedActionIds: string[] = [];

  for (const action of draft.actions) {
    if (!selected.has(action.id)) {
      skippedActionIds.push(action.id);
      continue;
    }
    if (action.type === 'add' || action.type === 'update') {
      if (!action.targetPath || action.after === undefined) {
        throw new Error(`草稿动作缺少目标内容：${action.id}`);
      }
      const targetPath = assertMarkdownPathInside(root, action.targetPath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, action.after, 'utf-8');
      appliedActionIds.push(action.id);
      continue;
    }
    if (action.type === 'archive') {
      const itemId = action.source?.itemId;
      if (!itemId) throw new Error(`归档动作缺少 itemId：${action.id}`);
      const result = archiveKnowledgeItem(root, { itemId });
      if (!result.ok) throw new Error(result.error || `归档失败：${itemId}`);
      appliedActionIds.push(action.id);
    }
  }

  const status = rebuildKnowledgeIndex(root);
  if (status.lastError) throw new Error(status.lastError);
  const nextIndex = readKnowledgeIndex(root);
  if (nextIndex) rebuildReminderIndexFromKnowledge(root, nextIndex);

  const appliedAt = new Date().toISOString();
  const appliedDraft: MemoryOptimizationDraft = {
    ...draft,
    status: 'applied',
    appliedAt,
    appliedActionIds,
    skippedActionIds,
  };
  writeDraft(root, appliedDraft);
  const state = readMemoryOptimizerState(root);
  writeMemoryOptimizerState(root, {
    ...state,
    draftCount: listMemoryOptimizationDrafts(root).filter((item) => item.status === 'draft').length,
    lastAppliedAt: appliedAt,
    recentError: '',
    updatedAt: new Date().toISOString(),
  });
  return { ok: true, draft: appliedDraft, appliedActionIds, skippedActionIds };
}

export function undoMemoryOptimizationDraft(
  memoryRoot: string,
  draftId: string,
): {
  ok: true;
  draft: MemoryOptimizationDraft;
  restoredActionIds: string[];
  manualActionIds: string[];
  missingArchiveActionIds: string[];
} {
  const root = path.resolve(memoryRoot);
  const draft = readDraft(root, draftId);
  if (!draft) throw new Error('未找到记忆整理草稿。');
  if (draft.status !== 'applied') throw new Error('只有已应用的草稿可以撤销。');

  const applied = new Set(draft.appliedActionIds || []);
  const archives = listKnowledgeArchives(root).items;
  const restoredActionIds: string[] = [];
  const manualActionIds: string[] = [];
  const missingArchiveActionIds: string[] = [];

  for (const action of draft.actions) {
    if (!applied.has(action.id)) continue;
    if (action.type !== 'archive') {
      manualActionIds.push(action.id);
      continue;
    }
    const itemId = action.source?.itemId || '';
    const archive = archives.find((candidate) => candidate.itemId === itemId);
    if (!archive) {
      missingArchiveActionIds.push(action.id);
      continue;
    }
    const restored = restoreKnowledgeArchive(root, { archivePath: archive.archivePath });
    if (!restored.ok) throw new Error(restored.error || `恢复归档失败：${itemId}`);
    restoredActionIds.push(action.id);
  }

  const undoneAt = new Date().toISOString();
  const undoneDraft: MemoryOptimizationDraft = {
    ...draft,
    status: 'undone',
    undoneAt,
    undoRestoredActionIds: restoredActionIds,
    undoManualActionIds: manualActionIds,
    undoMissingArchiveActionIds: missingArchiveActionIds,
  };
  writeDraft(root, undoneDraft);
  const state = readMemoryOptimizerState(root);
  writeMemoryOptimizerState(root, {
    ...state,
    lastUndoAt: undoneAt,
    recentError: '',
    updatedAt: new Date().toISOString(),
  });
  return { ok: true, draft: undoneDraft, restoredActionIds, manualActionIds, missingArchiveActionIds };
}

export function discardMemoryOptimizationDraft(memoryRoot: string, draftId: string): MemoryOptimizationDraft {
  const root = path.resolve(memoryRoot);
  const draft = readDraft(root, draftId);
  if (!draft) throw new Error('未找到记忆整理草稿。');
  if (draft.status !== 'draft') return draft;
  const discardedAt = new Date().toISOString();
  const next: MemoryOptimizationDraft = {
    ...draft,
    status: 'discarded',
    discardedAt,
  };
  writeDraft(root, next);
  const state = readMemoryOptimizerState(root);
  writeMemoryOptimizerState(root, {
    ...state,
    draftCount: listMemoryOptimizationDrafts(root).filter((item) => item.status === 'draft').length,
    lastDiscardedAt: discardedAt,
    updatedAt: new Date().toISOString(),
  });
  return next;
}

export function updateMemoryOptimizerSchedule(
  memoryRoot: string,
  input: { enabled?: boolean; intervalDays?: number; modelSource?: MemoryOptimizerModelSource },
): MemoryOptimizerState {
  const root = path.resolve(memoryRoot);
  const current = readMemoryOptimizerState(root);
  const enabled = input.enabled ?? current.enabled;
  const intervalDays = normalizeIntervalDays(input.intervalDays ?? current.intervalDays);
  const lastGeneratedAt = current.lastGeneratedAt;
  const nextRunAt = enabled
    ? computeNextRun(lastGeneratedAt || new Date().toISOString(), intervalDays)
    : undefined;
  const next: MemoryOptimizerState = {
    ...current,
    enabled,
    intervalDays,
    modelSource: normalizeModelSource(input.modelSource || current.modelSource),
    nextRunAt,
    draftCount: listMemoryOptimizationDrafts(root).filter((item) => item.status === 'draft').length,
    updatedAt: new Date().toISOString(),
  };
  writeMemoryOptimizerState(root, next);
  return next;
}

export function startMemoryOptimizerService(memoryRoot: string, config: Pick<Config, 'memoryOptimizerEnabled' | 'memoryOptimizerIntervalDays' | 'memoryOptimizerModelSource'>): MemoryOptimizerService {
  const root = path.resolve(memoryRoot);
  updateMemoryOptimizerSchedule(root, {
    enabled: config.memoryOptimizerEnabled === true,
    intervalDays: config.memoryOptimizerIntervalDays,
    modelSource: config.memoryOptimizerModelSource,
  });

  const tick = () => {
    const state = readMemoryOptimizerState(root);
    if (!state.enabled) return;
    const drafts = listMemoryOptimizationDrafts(root);
    if (drafts.some((draft) => draft.status === 'draft')) return;
    const dueAt = Date.parse(state.nextRunAt || '');
    if (Number.isFinite(dueAt) && Date.now() < dueAt) return;
    try {
      createMemoryOptimizationDraft(root, { generatedBy: 'schedule', modelSource: state.modelSource });
    } catch (error) {
      writeMemoryOptimizerState(root, {
        ...state,
        recentError: error instanceof Error ? error.message : String(error),
        nextRunAt: computeNextRun(new Date().toISOString(), state.intervalDays),
        updatedAt: new Date().toISOString(),
      });
    }
  };

  setTimeout(tick, 10_000).unref?.();
  const timer = setInterval(tick, SERVICE_TICK_MS);
  timer.unref?.();
  return {
    close: () => clearInterval(timer),
    status: () => readMemoryOptimizationStatus(root),
  };
}

function ensureCurrentIndex(root: string): KnowledgeIndex {
  let index = readKnowledgeIndex(root);
  if (!index) {
    const status = rebuildKnowledgeIndex(root);
    if (status.lastError) throw new Error(status.lastError);
    index = readKnowledgeIndex(root);
  }
  if (!index) throw new Error('记忆索引不存在。');
  return index;
}

function resolveSelectedActionIds(
  draft: MemoryOptimizationDraft,
  input: { selectedActionIds?: string[]; excludedActionIds?: string[] },
): Set<string> {
  if (Array.isArray(input.selectedActionIds)) {
    return new Set(input.selectedActionIds);
  }
  const excluded = new Set(input.excludedActionIds || []);
  return new Set(draft.actions
    .filter((action) => action.defaultSelected !== false && !excluded.has(action.id))
    .map((action) => action.id));
}

function buildOptimizationActions(root: string, index: KnowledgeIndex, draftId: string): MemoryOptimizationAction[] {
  const actions: MemoryOptimizationAction[] = [];

  for (const item of findDuplicateArchiveCandidates(index)) {
    const sourceGroup = classifyMemorySource(root, item.source.path);
    actions.push(withActionPolicy({
      id: actionId(draftId, 'archive-duplicate', item.id),
      type: 'archive',
      title: `归档重复记忆：${formatItemTitle(item)}`,
      reason: '同一 v2 记忆分区内内容重复，保留较新的或更可信的一条；归档不会永久删除，可从归档区恢复。',
      confidence: isDurableMemorySourceGroup(sourceGroup) ? 0.78 : 0.62,
      risk: isDurableMemorySourceGroup(sourceGroup) ? 'low' : 'medium',
      sourceGroup,
      source: {
        itemId: item.id,
        path: item.source.path,
        snippet: item.source.snippet,
      },
    }));
  }

  for (const item of findConflictArchiveCandidates(index)) {
    const sourceGroup = classifyMemorySource(root, item.source.path);
    actions.push(withActionPolicy({
      id: actionId(draftId, 'archive-conflict', item.id),
      type: 'archive',
      title: `建议归档冲突旧记忆：${formatItemTitle(item)}`,
      reason: '同一键名存在不同取值，草稿建议保留较新的来源；该动作风险较高，确认前可单独取消。',
      confidence: 0.62,
      risk: 'medium',
      sourceGroup,
      source: {
        itemId: item.id,
        path: item.source.path,
        snippet: item.source.snippet,
      },
    }));
  }

  return actions.slice(0, 80);
}

function withActionPolicy(action: MemoryOptimizationAction): MemoryOptimizationAction {
  const sourceGroup = action.sourceGroup || classifyMemorySource('', action.source?.path || action.targetPath || '');
  const autoSelectable = action.type === 'archive'
    ? isDurableMemorySourceGroup(sourceGroup) || sourceGroup === 'direct_reminder'
    : isDurableMemorySourceGroup(sourceGroup) || sourceGroup === 'direct_reminder';
  return {
    ...action,
    sourceGroup,
    defaultSelected: action.defaultSelected ?? autoSelectable,
    requiresManualReview: action.requiresManualReview ?? !autoSelectable,
  };
}

function findDuplicateArchiveCandidates(index: KnowledgeIndex): KnowledgeItem[] {
  const groups = new Map<string, KnowledgeItem[]>();
  for (const item of index.items) {
    const key = `${item.kind}:${normalizeText(item.key || '')}:${normalizeText(item.value || item.text)}`;
    if (!normalizeText(item.value || item.text)) continue;
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  const candidates: KnowledgeItem[] = [];
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const sorted = [...group].sort(compareKnowledgeFreshness);
    candidates.push(...sorted.slice(1));
  }
  return candidates.slice(0, 24);
}

function findConflictArchiveCandidates(index: KnowledgeIndex): KnowledgeItem[] {
  const groups = new Map<string, KnowledgeItem[]>();
  for (const item of index.items) {
    if (!item.conflict || !item.key) continue;
    const key = `${item.kind}:${normalizeText(item.key)}`;
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  const candidates: KnowledgeItem[] = [];
  for (const group of groups.values()) {
    if (new Set(group.map((item) => normalizeText(item.value || item.text))).size <= 1) continue;
    const sorted = [...group].sort(compareKnowledgeFreshness);
    candidates.push(...sorted.slice(1));
  }
  return candidates.slice(0, 16);
}

function compareKnowledgeFreshness(left: KnowledgeItem, right: KnowledgeItem): number {
  const leftTime = Date.parse(left.source.updatedAt || '');
  const rightTime = Date.parse(right.source.updatedAt || '');
  const leftScore = (Number.isFinite(leftTime) ? leftTime : 0) + left.confidence * 1000;
  const rightScore = (Number.isFinite(rightTime) ? rightTime : 0) + right.confidence * 1000;
  return rightScore - leftScore;
}

function summarizeActions(index: KnowledgeIndex, actions: MemoryOptimizationAction[]): string {
  const addCount = actions.filter((item) => item.type === 'add').length;
  const updateCount = actions.filter((item) => item.type === 'update').length;
  const archiveCount = actions.filter((item) => item.type === 'archive').length;
  const defaultCount = actions.filter((item) => item.defaultSelected !== false).length;
  return `整理草稿基于 ${index.itemCount} 条记忆生成：新增 ${addCount} 项，更新 ${updateCount} 项，建议归档 ${archiveCount} 项；默认勾选 ${defaultCount} 项，未勾选项需要人工确认。`;
}

function buildSourceSummary(root: string, index: KnowledgeIndex): MemorySourceSummaryItem[] {
  const byPath = new Map<string, MemorySourceSummaryItem>();
  for (const item of index.items) {
    const sourcePath = item.source.path || '';
    const sourceGroup = classifyMemorySource(root, sourcePath);
    const current = byPath.get(sourcePath) || {
      sourcePath,
      sourceGroup,
      itemCount: 0,
      updatedAt: item.source.updatedAt,
      autoSelectable: isAutoSelectableSource(sourceGroup),
      defaultRisk: defaultRiskForSource(sourceGroup),
    };
    current.itemCount += 1;
    if ((item.source.updatedAt || '') > (current.updatedAt || '')) current.updatedAt = item.source.updatedAt;
    byPath.set(sourcePath, current);
  }
  return [...byPath.values()].sort((left, right) => right.itemCount - left.itemCount || left.sourcePath.localeCompare(right.sourcePath));
}

function classifyMemorySource(root: string, sourcePath: string): MemorySourceGroup {
  const normalized = path.normalize(sourcePath).toLowerCase();
  const resolvedRoot = root ? path.normalize(path.resolve(root)).toLowerCase() : '';
  const relative = resolvedRoot && normalized.startsWith(resolvedRoot)
    ? path.relative(resolvedRoot, normalized).replace(/\\/g, '/')
    : normalized.replace(/\\/g, '/');
  if (root) {
    const metadata = readSourceMetadata(sourcePath);
    const classification = classifyMemoryV2Source(root, sourcePath, metadata);
    if (classification.ok && classification.sourceGroup) return classification.sourceGroup;
  }
  if (relative.includes('data/todos/direct-reminders/')) return 'direct_reminder';
  return 'other';
}

function isAutoSelectableSource(sourceGroup: MemorySourceGroup): boolean {
  return isDurableMemorySourceGroup(sourceGroup) || sourceGroup === 'direct_reminder';
}

function defaultRiskForSource(sourceGroup: MemorySourceGroup): MemoryOptimizationRisk {
  return isAutoSelectableSource(sourceGroup) ? 'low' : 'medium';
}

function isDurableMemorySourceGroup(sourceGroup: MemorySourceGroup): boolean {
  return sourceGroup === 'memory_user'
    || sourceGroup === 'memory_group'
    || sourceGroup === 'memory_long_term';
}

function readSourceMetadata(sourcePath: string): Record<string, string> | undefined {
  try {
    if (!fs.existsSync(sourcePath)) return undefined;
    const match = fs.readFileSync(sourcePath, 'utf-8').match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
    if (!match) return undefined;
    const metadata: Record<string, string> = {};
    for (const rawLine of match[1].split(/\r?\n/)) {
      const separator = rawLine.indexOf(':');
      if (separator <= 0) continue;
      const key = rawLine.slice(0, separator).trim();
      const value = rawLine.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && value) metadata[key] = value;
    }
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  } catch {
    return undefined;
  }
}

function readMemoryOptimizerState(memoryRoot: string): MemoryOptimizerState {
  const statePath = getMemoryOptimizerStatePath(memoryRoot);
  try {
    if (fs.existsSync(statePath)) {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Partial<MemoryOptimizerState>;
      return normalizeState(parsed);
    }
  } catch {
    // Fall through to defaults.
  }
  return normalizeState({});
}

function writeMemoryOptimizerState(memoryRoot: string, state: MemoryOptimizerState): void {
  const statePath = getMemoryOptimizerStatePath(memoryRoot);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
  fs.renameSync(tmp, statePath);
}

function normalizeState(input: Partial<MemoryOptimizerState>): MemoryOptimizerState {
  return {
    schema: STATE_SCHEMA,
    enabled: input.enabled === true,
    intervalDays: normalizeIntervalDays(input.intervalDays),
    modelSource: normalizeModelSource(input.modelSource),
    lastGeneratedAt: input.lastGeneratedAt,
    nextRunAt: input.nextRunAt,
    draftCount: Math.max(0, Math.floor(input.draftCount || 0)),
    recentError: input.recentError || '',
    lastAppliedAt: input.lastAppliedAt,
    lastDiscardedAt: input.lastDiscardedAt,
    lastUndoAt: input.lastUndoAt,
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

function normalizeIntervalDays(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_INTERVAL_DAYS;
  return Math.max(1, Math.min(90, Math.floor(value || DEFAULT_INTERVAL_DAYS)));
}

function normalizeModelSource(value: unknown): MemoryOptimizerModelSource {
  return value === 'local_ai' || value === 'external_api' || value === 'codex_primary'
    ? value
    : 'codex_primary';
}

function listMemoryOptimizationDrafts(memoryRoot: string): MemoryOptimizationDraft[] {
  const draftsDir = getMemoryOptimizationDraftsDir(memoryRoot);
  if (!fs.existsSync(draftsDir)) return [];
  return fs.readdirSync(draftsDir)
    .filter((file) => file.toLowerCase().endsWith('.json'))
    .map((file) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(draftsDir, file), 'utf-8')) as MemoryOptimizationDraft;
        return parsed?.schema === DRAFT_SCHEMA ? parsed : null;
      } catch {
        return null;
      }
    })
    .filter((draft): draft is MemoryOptimizationDraft => !!draft)
    .sort((left, right) => (right.generatedAt || '').localeCompare(left.generatedAt || ''))
    .slice(0, 20);
}

function readDraft(memoryRoot: string, draftId: string): MemoryOptimizationDraft | null {
  const draftsDir = getMemoryOptimizationDraftsDir(memoryRoot);
  const draftPath = assertDraftPath(draftsDir, draftId);
  try {
    if (!fs.existsSync(draftPath)) return null;
    const draft = JSON.parse(fs.readFileSync(draftPath, 'utf-8')) as MemoryOptimizationDraft;
    return draft?.schema === DRAFT_SCHEMA ? draft : null;
  } catch {
    return null;
  }
}

function writeDraft(memoryRoot: string, draft: MemoryOptimizationDraft): void {
  const draftsDir = getMemoryOptimizationDraftsDir(memoryRoot);
  fs.mkdirSync(draftsDir, { recursive: true });
  const draftPath = assertDraftPath(draftsDir, draft.draftId);
  const tmp = `${draftPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(draft, null, 2), 'utf-8');
  fs.renameSync(tmp, draftPath);
}

function assertDraftPath(draftsDir: string, draftId: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(draftId)) throw new Error('草稿 ID 不合法。');
  const draftPath = path.resolve(draftsDir, `${draftId}.json`);
  if (!isInside(path.resolve(draftsDir), draftPath)) throw new Error('草稿路径越界。');
  return draftPath;
}

function assertMarkdownPathInside(root: string, filePath: string): string {
  const fullPath = path.resolve(filePath);
  if (!isInside(root, fullPath)) throw new Error('目标文件不在记忆仓库内。');
  if (!fullPath.toLowerCase().endsWith('.md')) throw new Error('目标文件必须是 Markdown。');
  if (path.relative(path.join(root, '.cti-index'), fullPath).split(path.sep)[0] !== '..') {
    throw new Error('禁止把草稿应用到 .cti-index 内部。');
  }
  return fullPath;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function makeDraftId(generatedAt: string): string {
  const stamp = generatedAt.replace(/\D/g, '').slice(0, 14);
  return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function actionId(draftId: string, kind: string, key: string): string {
  return `${kind}-${crypto.createHash('sha1').update(`${draftId}:${kind}:${key}`).digest('hex').slice(0, 10)}`;
}

function computeNextRun(fromIso: string, intervalDays: number): string {
  const start = Date.parse(fromIso);
  const base = Number.isFinite(start) ? start : Date.now();
  return new Date(base + normalizeIntervalDays(intervalDays) * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function formatItemTitle(item: KnowledgeItem): string {
  const text = item.key ? `${item.key}: ${item.value || item.text}` : item.text;
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
