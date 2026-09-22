import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  WorkflowFailureLedgerContract,
  WorkflowFailureLedgerEntryContract,
  WorkflowFailureLedgerKind,
  WorkflowReplaySafety,
  WorkflowRetryDisposition,
  WorkflowRunStatus,
  WorkflowStage,
} from '@codex-im-suite/contracts';

import { CTI_HOME } from './config.js';
import { writeUtf8TextAtomic } from './atomic-text-file.js';

const MAX_LEDGER_ENTRIES = 5_000;

function nowIso(): string {
  return new Date().toISOString();
}

export function getWorkflowFailureLedgerPath(): string {
  const ctiHome = process.env.CTI_HOME?.trim() || CTI_HOME;
  return path.join(ctiHome, 'runtime', 'workflow-failure-ledger.json');
}

function emptyLedger(): WorkflowFailureLedgerContract {
  return {
    protocol: 'workflow-failure-ledger/v1',
    updatedAt: nowIso(),
    nextSequence: 1,
    retainedFromSequence: 1,
    entries: [],
  };
}

export function readWorkflowFailureLedger(): WorkflowFailureLedgerContract {
  const ledgerPath = getWorkflowFailureLedgerPath();
  if (!fs.existsSync(ledgerPath)) return emptyLedger();
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as Partial<WorkflowFailureLedgerContract>;
    if (parsed.protocol !== 'workflow-failure-ledger/v1' || !Array.isArray(parsed.entries)) {
      throw new Error('workflow failure ledger protocol mismatch');
    }
    const entries = parsed.entries.slice(-MAX_LEDGER_ENTRIES);
    const highestSequence = entries.reduce((maximum, entry) => Math.max(maximum, Number(entry.sequence) || 0), 0);
    return {
      protocol: 'workflow-failure-ledger/v1',
      updatedAt: parsed.updatedAt || nowIso(),
      nextSequence: Math.max(highestSequence + 1, Number(parsed.nextSequence) || 1),
      retainedFromSequence: entries[0]?.sequence || Math.max(1, Number(parsed.retainedFromSequence) || 1),
      entries,
    };
  } catch {
    // 确认 JSON/协议损坏后先备份；下一次写入才用新账本替换，避免每次创建
    // 客户端都删除可重建状态，也不给主 Workflow 增加失败依赖。
    try {
      fs.copyFileSync(ledgerPath, `${ledgerPath}.corrupt-${Date.now()}.bak`, fs.constants.COPYFILE_EXCL);
    } catch {
      // 备份失败时仍允许观察链以内存空状态继续，主链不受影响。
    }
    return emptyLedger();
  }
}

function stableFingerprint(input: {
  kind: WorkflowFailureLedgerKind;
  stage: WorkflowStage;
  workflowStatus: WorkflowRunStatus;
  failureCodes: string[];
  replaySafety?: WorkflowReplaySafety;
  retryDisposition?: WorkflowRetryDisposition;
}): string {
  const normalized = JSON.stringify({
    kind: input.kind,
    stage: input.stage,
    workflowStatus: input.workflowStatus,
    failureCodes: [...input.failureCodes].sort(),
    replaySafety: input.replaySafety || null,
    retryDisposition: input.retryDisposition || null,
  });
  return `sha256:${crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

export function recordWorkflowFailureLedgerEntry(input: {
  kind: WorkflowFailureLedgerKind;
  stage: WorkflowStage;
  workflowStatus: WorkflowRunStatus;
  failureCodes: readonly string[];
  replaySafety?: WorkflowReplaySafety;
  retryDisposition?: WorkflowRetryDisposition;
  occurredAt?: string;
}): WorkflowFailureLedgerEntryContract {
  const current = readWorkflowFailureLedger();
  const failureCodes = Array.from(new Set(input.failureCodes.map((item) => item.trim()).filter(Boolean))).sort().slice(0, 12);
  const entry: WorkflowFailureLedgerEntryContract = {
    sequence: current.nextSequence,
    fingerprint: stableFingerprint({ ...input, failureCodes }),
    occurredAt: input.occurredAt || nowIso(),
    kind: input.kind,
    state: 'observed',
    stage: input.stage,
    workflowStatus: input.workflowStatus,
    failureCodes,
    replaySafety: input.replaySafety,
    retryDisposition: input.retryDisposition,
  };
  const entries = [...current.entries, entry].slice(-MAX_LEDGER_ENTRIES);
  const next: WorkflowFailureLedgerContract = {
    protocol: 'workflow-failure-ledger/v1',
    updatedAt: nowIso(),
    nextSequence: entry.sequence + 1,
    retainedFromSequence: entries[0]?.sequence || entry.sequence,
    entries,
  };
  writeUtf8TextAtomic(getWorkflowFailureLedgerPath(), JSON.stringify(next, null, 2));
  return entry;
}

export function recordWorkflowFailureLedgerEntryBestEffort(
  input: Parameters<typeof recordWorkflowFailureLedgerEntry>[0],
): void {
  try {
    recordWorkflowFailureLedgerEntry(input);
  } catch {
    // 失败账本是观察链，状态库锁或写入异常不能覆盖 Primary 的真实终态。
  }
}
