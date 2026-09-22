import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { assertCleanupProcessesStopped } from '../process-stop-guard.js';
import { createStickerSemanticStore } from './store.js';
import type { StickerAvoidRuleV1, StickerSemanticRevisionV1 } from './types.js';

export type StickerSemanticMigrationAction =
  | 'seed_confirmed_revision'
  | 'convert_free_text_avoid_when'
  | 'preserve_manual'
  | 'blocked';

export interface StickerSemanticMigrationPlan {
  schema: 'codex-im-suite/sticker-semantic-migration/v1';
  createdAt: string;
  memoryRoot: string;
  operations: Array<{
    operationId: string;
    fileKey: string;
    sourceHash: string;
    action: StickerSemanticMigrationAction;
    reason?: string;
  }>;
}

export interface StickerSemanticMigrationResult {
  seededConfirmed: number;
  convertedRules: number;
  preservedManual: number;
  blocked: number;
  skippedExisting: number;
  backupPath: string;
}

export interface ApplyStickerSemanticMigrationPlanOptions {
  now?: () => string;
  assertProcessesStopped?: (memoryRoot: string) => void;
}

interface LegacyStickerRecord {
  fileKey?: string;
  label?: string;
  description?: string;
  intent?: string;
  tone?: string;
  usage?: string;
  aliases?: string[];
  examples?: string[];
  avoidWhen?: string;
  annotationSource?: string;
  annotationConfidence?: number;
}

interface LegacyStickerFile {
  stickers?: LegacyStickerRecord[];
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function recordHash(record: LegacyStickerRecord): string {
  return sha256(JSON.stringify(record));
}

function readLegacy(memoryRoot: string): { stickerPath: string; records: LegacyStickerRecord[] } {
  const stickerPath = path.join(memoryRoot, 'data', 'im', 'feishu', 'stickers', 'stickers.json');
  if (!fs.existsSync(stickerPath)) return { stickerPath, records: [] };
  const parsed = JSON.parse(fs.readFileSync(stickerPath, 'utf8')) as LegacyStickerFile;
  return { stickerPath, records: Array.isArray(parsed.stickers) ? parsed.stickers : [] };
}

function deterministicOperationId(fileKey: string, sourceHash: string, action: StickerSemanticMigrationAction): string {
  return sha256(`sticker-semantic-migration:${action}:${fileKey}:${sourceHash}`);
}

function hasSemantic(record: LegacyStickerRecord): boolean {
  return [record.label, record.description, record.intent, record.tone, record.usage, ...(record.aliases || []), ...(record.examples || [])]
    .some((value) => typeof value === 'string' && value.trim().length > 0);
}

export function buildStickerSemanticMigrationPlan(input: { memoryRoot: string; now?: () => string }): StickerSemanticMigrationPlan {
  const memoryRoot = path.resolve(input.memoryRoot);
  const { records } = readLegacy(memoryRoot);
  const operations: StickerSemanticMigrationPlan['operations'] = [];
  for (const record of records) {
    const fileKey = record.fileKey?.trim();
    if (!fileKey) continue;
    const sourceHash = recordHash(record);
    const source = record.annotationSource?.trim().toLowerCase();
    if (source === 'manual') {
      operations.push({
        operationId: deterministicOperationId(fileKey, sourceHash, 'preserve_manual'),
        fileKey,
        sourceHash,
        action: 'preserve_manual',
        reason: '人工语义作为 confirmed baseline 保留并锁定视觉事实',
      });
    } else if (source === 'vision' && hasSemantic(record)) {
      operations.push({
        operationId: deterministicOperationId(fileKey, sourceHash, 'seed_confirmed_revision'),
        fileKey,
        sourceHash,
        action: 'seed_confirmed_revision',
        reason: '可信视觉语义生成 confirmed baseline',
      });
    } else {
      operations.push({
        operationId: deterministicOperationId(fileKey, sourceHash, 'blocked'),
        fileKey,
        sourceHash,
        action: 'blocked',
        reason: source === 'user' ? '用户解释仍是未核验证据，不进入主语义' : '缺少 vision/manual 可信语义',
      });
    }
    if ((source === 'vision' || source === 'manual') && record.avoidWhen?.trim()) {
      operations.push({
        operationId: deterministicOperationId(fileKey, sourceHash, 'convert_free_text_avoid_when'),
        fileKey,
        sourceHash,
        action: 'convert_free_text_avoid_when',
        reason: '旧自由文本 avoidWhen 转为 trial 结构化规则',
      });
    }
  }
  return {
    schema: 'codex-im-suite/sticker-semantic-migration/v1',
    createdAt: (input.now || (() => new Date().toISOString()))(),
    memoryRoot,
    operations,
  };
}

function avoidCategory(condition: string): StickerAvoidRuleV1['category'] {
  if (/正式|通知|公告|维护|发布|formal|notice/iu.test(condition)) return 'formal_notice';
  if (/严重|事故|故障|宕机|incident|outage/iu.test(condition)) return 'serious_incident';
  if (/难过|痛苦|焦虑|崩溃|悲伤|distress/iu.test(condition)) return 'user_distress';
  if (/投诉|不满|抱怨|生气|complaint/iu.test(condition)) return 'complaint';
  if (/重复|刚发过|recent|repeat/iu.test(condition)) return 'recent_repeat';
  return 'scope_preference';
}

function makeRevision(input: {
  operation: StickerSemanticMigrationPlan['operations'][number];
  record: LegacyStickerRecord;
  baseHash: string;
  now: string;
}): StickerSemanticRevisionV1 {
  const confirmed = input.operation.action !== 'convert_free_text_avoid_when';
  const revisionId = input.operation.operationId;
  const avoidCondition = input.record.avoidWhen?.trim();
  return {
    schema: 'codex-im-suite/sticker-semantic-revision/v1',
    revisionId,
    fileKey: input.operation.fileKey,
    scope: 'global',
    status: confirmed ? 'confirmed' : 'trial',
    versionId: sha256(`version:${revisionId}`),
    baseHash: input.baseHash,
    patch: confirmed ? {
      intent: input.record.intent?.trim() || undefined,
      tone: input.record.tone?.trim() || undefined,
      usage: input.record.usage?.trim() || undefined,
      aliases: input.record.aliases?.map((item) => item.trim()).filter(Boolean),
      examples: input.record.examples?.map((item) => item.trim()).filter(Boolean),
    } : {
      avoidRules: avoidCondition ? [{
        id: sha256(`avoid:${revisionId}`),
        condition: avoidCondition,
        category: avoidCategory(avoidCondition),
        scope: 'global',
        status: 'trial',
        confidence: 0.6,
        supportCount: 0,
        contradictionCount: 0,
        evidenceHashes: [],
        createdAt: input.now,
        updatedAt: input.now,
      }] : [],
    },
    supportEvidenceHashes: [],
    contradictionEvidenceHashes: [],
    supportSessionIds: [],
    contradictionSessionIds: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function createBackup(memoryRoot: string, now: string): string {
  const stamp = now.replace(/[^0-9]/gu, '').slice(0, 17) || String(Date.now());
  const backupPath = path.join(memoryRoot, 'backups', 'sticker-semantic-migration', stamp);
  fs.mkdirSync(backupPath, { recursive: true });
  const stickerRoot = path.join(memoryRoot, 'data', 'im', 'feishu', 'stickers');
  if (fs.existsSync(stickerRoot)) fs.cpSync(stickerRoot, path.join(backupPath, 'stickers'), { recursive: true, errorOnExist: true });
  for (const name of ['记忆总索引.md', '记忆库说明.md']) {
    const source = path.join(memoryRoot, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(backupPath, name));
  }
  return backupPath;
}

export function applyStickerSemanticMigrationPlan(
  plan: StickerSemanticMigrationPlan,
  options: ApplyStickerSemanticMigrationPlanOptions = {},
): StickerSemanticMigrationResult {
  if (plan.schema !== 'codex-im-suite/sticker-semantic-migration/v1') throw new Error('invalid_migration_manifest');
  const memoryRoot = path.resolve(plan.memoryRoot);
  // 迁移会同时改机器状态和人类投影，必须先停止所有可能并发写入的 live 进程。
  (options.assertProcessesStopped || ((root: string) => assertCleanupProcessesStopped({
    ctiHome: process.env.CTI_HOME?.trim() || path.join(os.homedir(), '.claude-to-im'),
    memoryRoot: root,
  })))(memoryRoot);
  const { records } = readLegacy(memoryRoot);
  const recordsByKey = new Map(records.flatMap((record) => record.fileKey?.trim() ? [[record.fileKey.trim(), record] as const] : []));
  for (const operation of plan.operations) {
    const record = recordsByKey.get(operation.fileKey);
    if (!record || recordHash(record) !== operation.sourceHash) throw new Error(`migration_source_changed: ${operation.fileKey}`);
    if (deterministicOperationId(operation.fileKey, operation.sourceHash, operation.action) !== operation.operationId) {
      throw new Error(`migration_operation_tampered: ${operation.fileKey}`);
    }
  }

  const store = createStickerSemanticStore({ memoryRoot, now: options.now });
  const existingIds = new Set(store.readSnapshot().revisions.map((item) => item.revisionId));
  const pending = plan.operations.filter((item) => item.action !== 'blocked' && !existingIds.has(item.operationId));
  const now = (options.now || (() => new Date().toISOString()))();
  const backupPath = pending.length > 0 ? createBackup(memoryRoot, now) : '';
  const result: StickerSemanticMigrationResult = {
    seededConfirmed: 0,
    convertedRules: 0,
    preservedManual: 0,
    blocked: plan.operations.filter((item) => item.action === 'blocked').length,
    skippedExisting: plan.operations.filter((item) => existingIds.has(item.operationId)).length,
    backupPath,
  };
  for (const operation of pending) {
    const record = recordsByKey.get(operation.fileKey)!;
    const snapshot = store.readSnapshot();
    const revision = makeRevision({ operation, record, baseHash: snapshot.baseHash, now });
    store.applyRevision(revision, 'migration');
    if (operation.action === 'convert_free_text_avoid_when') result.convertedRules += 1;
    else if (operation.action === 'preserve_manual') result.preservedManual += 1;
    else result.seededConfirmed += 1;
  }
  // 人工语义也是 confirmed baseline，单独统计保留数，同时计入 seededConfirmed 总量。
  result.seededConfirmed += result.preservedManual;
  return result;
}
