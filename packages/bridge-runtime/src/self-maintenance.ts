import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ensureAgentHome } from './agent-home.js';
import { buildAgentHomeHumanReadableProjections } from './agent-home-human-readable-projection.js';
import { upsertManagedAgentHomeRule } from './agent-home-rules.js';
import { resolveWorkspaceIdentity } from './workspace-identity.js';
import { upsertWorkProfileEntry } from './work-profile.js';
import {
  recordManagedRuleEvaluation,
  recordManagedRuleSupport,
  resolveManagedRuleStatePath,
  type ManagedRuleState,
} from './self-maintenance-rule-lifecycle.js';
import { rotateSelfMaintenanceHistory } from './self-maintenance-retention.js';

export type SelfMaintenancePhase = 'correction' | 'outcome';
export type SelfMaintenanceTarget =
  | 'identity'
  | 'safety_rules'
  | 'tool_rules'
  | 'work_profile'
  | 'daily_reflection'
  | 'correction_log';

export interface SelfMaintenanceEvidence {
  id: string;
  kind: 'assistant_output' | 'human_message' | 'runtime_result' | 'quoted_text' | 'history';
  source: 'assistant' | 'human' | 'runtime' | 'history';
  content: string;
  success?: boolean;
}

export interface SelfMaintenanceCorrection {
  errorType: 'factual' | 'tool_selection' | 'behavior' | 'execution';
  claimEvidenceId: string;
  claimText: string;
  correctionEvidenceId: string;
  correctionText: string;
}

export interface SelfMaintenanceMutation {
  target: SelfMaintenanceTarget;
  mode: 'replace' | 'append' | 'upsert' | 'patch';
  key?: string;
  baseHash?: string;
  content: string;
}

export interface SelfMaintenanceDecision {
  action: 'apply' | 'ignore';
  confidence: number;
  errorConfirmed: boolean;
  reason: string;
  evidenceIds: string[];
  correction?: SelfMaintenanceCorrection;
  ruleEvaluations?: Array<{
    target: 'identity' | 'safety_rules' | 'tool_rules';
    key: string;
    outcome: 'supported' | 'regressed';
    evidenceId: string;
  }>;
  mutations: SelfMaintenanceMutation[];
}

export interface ApplySelfMaintenanceInput {
  memoryRoot: string;
  phase: SelfMaintenancePhase;
  sessionId: string;
  workingDirectory?: string;
  evidence: SelfMaintenanceEvidence[];
  decision: SelfMaintenanceDecision;
  now?: () => Date;
  onChanged?: () => void;
}

export interface ApplySelfMaintenanceResult {
  applied: boolean;
  reason: string;
  changedPaths: string[];
  backupPaths: string[];
  workspaceId: string;
}

export interface RollbackSelfMaintenanceInput {
  memoryRoot: string;
  backupPath: string;
  now?: () => Date;
  onChanged?: () => void;
}

export interface RollbackSelfMaintenanceResult {
  restored: boolean;
  targetPath: string;
  currentVersionBackupPath: string;
}

const CORE_TARGETS = new Set<SelfMaintenanceTarget>(['identity', 'safety_rules', 'tool_rules']);
const SECRET_PATTERN = /(?:bearer\s+[a-z0-9._~+\/-]{12,}|(?:token|secret|password|api[_-]?key|app[_-]?secret)\s*[=:]\s*\S{4,}|\b\d{8,12}:[A-Za-z0-9_-]{20,}\b)/iu;
const MAX_MUTATION_CHARS = 20_000;
const WRITE_LOCK_STALE_MS = 30_000;

type WriteLockResult =
  | { acquired: true; release: () => void }
  | { acquired: false; reason: string };

function redactSensitiveText(value: string): string {
  return value
    .replace(/((?:token|secret|password|api[_-]?key|app[_-]?secret)\s*[=:]\s*)[^\s,;"']+/giu, '$1[REDACTED]')
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+/giu, '$1[REDACTED]')
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{20,}\b/gu, '[REDACTED]');
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function appendText(filePath: string, header: string, block: string): void {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').trimEnd() : header.trimEnd();
  atomicWrite(filePath, `${existing}\n\n${block.trim()}\n`);
}

function appendJsonLine(filePath: string, record: unknown): void {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').trimEnd() : '';
  const line = JSON.stringify(record);
  atomicWrite(filePath, existing ? `${existing}\n${line}\n` : `${line}\n`);
}

function isWriteLockOwnerAlive(lockPath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    const pid = typeof parsed.pid === 'number' ? parsed.pid : Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  } catch {
    return false;
  }
}

function acquireSelfMaintenanceWriteLock(root: string): WriteLockResult {
  const lockPath = path.join(root, '.cti-self-history', 'write.lock');
  const lockToken = `${process.pid}:${Date.now()}:${crypto.randomUUID()}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({
          protocol: 'cti-self-maintenance-write-lock/v1',
          token: lockToken,
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        })}\n`, 'utf8');
      } finally {
        fs.closeSync(descriptor);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { acquired: false, reason: `无法获取自维护写锁：${error instanceof Error ? error.message : String(error)}` };
      }
      const stale = (() => {
        try {
          return Date.now() - fs.statSync(lockPath).mtimeMs > WRITE_LOCK_STALE_MS;
        } catch {
          return false;
        }
      })();
      if (!stale || isWriteLockOwnerAlive(lockPath) || attempt > 0) {
        return { acquired: false, reason: '自维护写锁正被其他回合占用，本轮不写入' };
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        return { acquired: false, reason: '自维护 stale 写锁清理失败，本轮不写入' };
      }
    }
  }

  return {
    acquired: true,
    release: () => {
      try {
        const current = fs.readFileSync(lockPath, 'utf8');
        if (current.includes(lockToken)) fs.unlinkSync(lockPath);
      } catch {
        // 锁已被外部清理或运行时正在退出时，不影响主回复和已完成的原子写入。
      }
    },
  };
}

function beijingDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function ensureSelfMaintenanceLayout(memoryRoot: string): {
  root: string;
  directories: string[];
} {
  const root = ensureAgentHome(memoryRoot).root;
  const directories = [
    path.join(root, 'daily-reflection'),
    path.join(root, 'work'),
    path.join(root, 'corrections'),
    path.join(root, '.cti-self-history'),
    path.join(root, '.cti-self-history', 'versions'),
    path.join(root, '.cti-self-history', 'transactions'),
  ];
  for (const directory of directories) fs.mkdirSync(directory, { recursive: true });
  return { root, directories };
}

function coreTargetPath(root: string, target: SelfMaintenanceTarget): string | null {
  if (target === 'identity') return path.join(root, '机器人身份.md');
  if (target === 'safety_rules') return path.join(root, '行为与安全规则.md');
  if (target === 'tool_rules') return path.join(root, '工具与环境.md');
  return null;
}

export function readSelfMaintenanceCoreBaseHashes(memoryRoot: string): Record<'identity' | 'safety_rules' | 'tool_rules', string> {
  const { root } = ensureSelfMaintenanceLayout(memoryRoot);
  const readHash = (target: 'identity' | 'safety_rules' | 'tool_rules'): string => {
    const targetPath = coreTargetPath(root, target)!;
    return hashSelfMaintenanceContent(fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '');
  };
  return {
    identity: readHash('identity'),
    safety_rules: readHash('safety_rules'),
    tool_rules: readHash('tool_rules'),
  };
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

interface SelfMaintenanceTransactionFile {
  target: string;
  beforeKind: 'missing' | 'file' | 'other';
  backup?: string;
}

interface SelfMaintenanceTransactionManifest {
  protocol: 'cti-self-maintenance-transaction/v1';
  state: 'committing' | 'committed';
  files: SelfMaintenanceTransactionFile[];
}

export interface SelfMaintenanceTransaction {
  directory: string;
  capture(filePath: string): void;
  commit(): void;
  rollback(): boolean;
}

function restoreTransactionFiles(root: string, transactionDir: string, files: SelfMaintenanceTransactionFile[]): boolean {
  let failed = false;
  for (const file of [...files].reverse()) {
    try {
      const targetPath = path.resolve(root, file.target);
      if (!isPathInside(targetPath, root)) throw new Error('transaction target escaped memory root');
      if (file.beforeKind === 'file') {
        if (!file.backup) throw new Error('transaction backup missing');
        const backupPath = path.resolve(transactionDir, file.backup);
        if (!isPathInside(backupPath, transactionDir)) throw new Error('transaction backup escaped transaction root');
        atomicWrite(targetPath, fs.readFileSync(backupPath, 'utf8'));
      } else if (file.beforeKind === 'missing' && fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
        fs.unlinkSync(targetPath);
      }
    } catch {
      failed = true;
    }
  }
  return !failed;
}

export function beginSelfMaintenanceTransaction(memoryRoot: string): SelfMaintenanceTransaction {
  const { root } = ensureSelfMaintenanceLayout(memoryRoot);
  const directory = path.join(
    root,
    '.cti-self-history',
    'transactions',
    `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(path.join(directory, 'before'), { recursive: true });
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest: SelfMaintenanceTransactionManifest = {
    protocol: 'cti-self-maintenance-transaction/v1',
    state: 'committing',
    files: [],
  };
  const persist = (): void => atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  persist();

  return {
    directory,
    capture: (filePath: string): void => {
      const resolved = path.resolve(filePath);
      if (!isPathInside(resolved, root)) throw new Error('事务目标超出 Agent Home');
      const target = path.relative(root, resolved).replace(/\\/gu, '/');
      if (manifest.files.some((item) => item.target === target)) return;
      if (!fs.existsSync(resolved)) {
        manifest.files.push({ target, beforeKind: 'missing' });
      } else if (fs.statSync(resolved).isFile()) {
        const backup = `before/${manifest.files.length}.txt`;
        atomicWrite(path.join(directory, backup), fs.readFileSync(resolved, 'utf8'));
        manifest.files.push({ target, beforeKind: 'file', backup });
      } else {
        manifest.files.push({ target, beforeKind: 'other' });
      }
      persist();
    },
    commit: (): void => {
      manifest.state = 'committed';
      persist();
      fs.rmSync(directory, { recursive: true, force: true });
    },
    rollback: (): boolean => {
      const restored = restoreTransactionFiles(root, directory, manifest.files);
      if (restored) fs.rmSync(directory, { recursive: true, force: true });
      return restored;
    },
  };
}

export function recoverSelfMaintenanceTransactions(memoryRoot: string): { recovered: number; failed: number } {
  const { root } = ensureSelfMaintenanceLayout(memoryRoot);
  const transactionsRoot = path.join(root, '.cti-self-history', 'transactions');
  let recovered = 0;
  let failed = 0;
  for (const entry of fs.readdirSync(transactionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const transactionDir = path.join(transactionsRoot, entry.name);
    const manifestPath = path.join(transactionDir, 'manifest.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SelfMaintenanceTransactionManifest;
      if (manifest.protocol !== 'cti-self-maintenance-transaction/v1' || !Array.isArray(manifest.files)) {
        failed += 1;
        continue;
      }
      if (manifest.state !== 'committed') {
        if (!restoreTransactionFiles(root, transactionDir, manifest.files)) throw new Error('transaction restore failed');
        recovered += 1;
      }
      fs.rmSync(transactionDir, { recursive: true, force: true });
    } catch {
      failed += 1;
    }
  }
  return { recovered, failed };
}

function mutationTargetPath(
  root: string,
  target: SelfMaintenanceTarget,
  dateKey: string,
  workspaceId: string,
): string {
  const corePath = coreTargetPath(root, target);
  if (corePath) return corePath;
  if (target === 'work_profile') return path.join(root, 'work', workspaceId, '工作档案.md');
  if (target === 'daily_reflection') return path.join(root, 'daily-reflection', `每日反思-${dateKey}.md`);
  return path.join(root, 'corrections', `纠错记录-${dateKey}.md`);
}

function writeAgentHomeHumanReadableProjections(input: {
  root: string;
  generatedAt: string;
  lastAction: string;
  workspaceId?: string;
  captureOriginalPath: (filePath: string) => void;
}): string[] {
  const masterIndexPath = path.join(input.root, '记忆总索引.md');
  const memoryGuidePath = path.join(input.root, '记忆库说明.md');
  const projections = buildAgentHomeHumanReadableProjections({
    memoryRoot: input.root,
    generatedAt: input.generatedAt,
    lastAction: input.lastAction,
    workspaceId: input.workspaceId,
    masterIndexContent: fs.existsSync(masterIndexPath) ? fs.readFileSync(masterIndexPath, 'utf8') : '',
    memoryGuideContent: fs.existsSync(memoryGuidePath) ? fs.readFileSync(memoryGuidePath, 'utf8') : '',
  });
  for (const projection of projections) {
    input.captureOriginalPath(projection.path);
    atomicWrite(projection.path, projection.content);
  }
  return projections.map((projection) => projection.path);
}

function validateDecision(input: ApplySelfMaintenanceInput): string | null {
  const { decision, evidence, phase } = input;
  if (decision.action !== 'apply') return '裁决未要求应用修改';
  if (!Number.isFinite(decision.confidence) || decision.confidence < 0.85) return '自维护裁决置信度不足';
  const ruleEvaluations = decision.ruleEvaluations || [];
  if (!decision.mutations?.length && ruleEvaluations.length === 0) return '没有可应用的自维护修改或规则评估';
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  if (!decision.evidenceIds?.length || decision.evidenceIds.some((id) => !evidenceById.has(id))) {
    return '裁决引用了不存在的 evidence id';
  }
  const cited = decision.evidenceIds.map((id) => evidenceById.get(id)!);
  const hasCoreMutation = decision.mutations.some((item) => CORE_TARGETS.has(item.target));
  if (hasCoreMutation && !decision.errorConfirmed) {
    return '核心文档改写必须确认是 Agent 自身错误';
  }
  if (hasCoreMutation) {
    const correction = decision.correction;
    if (!correction) return '核心文档改写必须绑定错误声明片段与纠正片段双重证据';
    const claimEvidence = evidenceById.get(correction.claimEvidenceId);
    const correctionEvidence = evidenceById.get(correction.correctionEvidenceId);
    if (!claimEvidence || claimEvidence.kind !== 'assistant_output' || claimEvidence.source !== 'assistant') {
      return '错误声明片段必须引用真实 assistant_output evidence';
    }
    if (!correction.claimText.trim() || !claimEvidence.content.includes(correction.claimText.trim())) {
      return '错误声明片段不在所引用的 assistant_output evidence 中';
    }
    const trustedHumanCorrection = correctionEvidence?.kind === 'human_message' && correctionEvidence.source === 'human';
    const trustedRuntimeCorrection = correctionEvidence?.kind === 'runtime_result'
      && correctionEvidence.source === 'runtime'
      && correctionEvidence.success === false;
    if (!correctionEvidence || (!trustedHumanCorrection && !trustedRuntimeCorrection)) {
      return '纠正片段必须引用当前 human_message 或失败的 runtime_result evidence';
    }
    if (!correction.correctionText.trim() || !correctionEvidence.content.includes(correction.correctionText.trim())) {
      return '纠正片段不在所引用的可信 evidence 中';
    }
    if (!decision.evidenceIds.includes(correction.claimEvidenceId)
      || !decision.evidenceIds.includes(correction.correctionEvidenceId)) {
      return '纠错双重证据必须同时列入 evidenceIds';
    }
  }
  if (phase === 'outcome') {
    const hasRuntimeResult = cited.some((item) => item.kind === 'runtime_result' && item.source === 'runtime');
    const hasAssistantOutput = cited.some((item) => item.kind === 'assistant_output' && item.source === 'assistant');
    if (!hasRuntimeResult || !hasAssistantOutput) return '工作档案维护必须引用真实运行结果和本轮 Agent 输出';
  }
  for (const evaluation of ruleEvaluations) {
    const evaluationEvidence = evidenceById.get(evaluation.evidenceId);
    if (!evaluation.key?.trim()) return '规则评估缺少稳定 key';
    if (!decision.evidenceIds.includes(evaluation.evidenceId) || !evaluationEvidence) {
      return '规则评估引用了不存在或未列入 evidenceIds 的证据';
    }
    if (evaluationEvidence.kind !== 'runtime_result' || evaluationEvidence.source !== 'runtime') {
      return '规则效果只能由真实 runtime_result evidence 评估';
    }
    if (evaluation.outcome === 'supported' && evaluationEvidence.success !== true) {
      return 'supported 规则评估必须引用成功 runtime_result';
    }
    if (evaluation.outcome === 'regressed' && evaluationEvidence.success !== false) {
      return 'regressed 规则评估必须引用失败 runtime_result';
    }
  }
  for (const mutation of decision.mutations) {
    if (!mutation.content?.trim()) return `目标 ${mutation.target} 的内容为空`;
    if (mutation.content.length > MAX_MUTATION_CHARS) return `目标 ${mutation.target} 的内容超过上限`;
    if (SECRET_PATTERN.test(mutation.content)) return `目标 ${mutation.target} 包含疑似密钥或授权信息`;
    if (CORE_TARGETS.has(mutation.target) && mutation.mode !== 'patch') {
      return `核心文档 ${mutation.target} 禁止整篇 replace，只允许受控 patch`;
    }
    if (CORE_TARGETS.has(mutation.target) && mutation.mode === 'patch' && !mutation.key?.trim()) {
      return `核心文档 ${mutation.target} 的 patch 缺少稳定 key`;
    }
    if (mutation.target === 'work_profile' && mutation.mode === 'upsert' && !mutation.key?.trim()) {
      return '工作档案 upsert 必须提供稳定 key';
    }
    if (CORE_TARGETS.has(mutation.target) && !mutation.baseHash?.trim()) {
      return `核心文档 ${mutation.target} 缺少 baseHash，拒绝覆盖未知版本`;
    }
  }
  return null;
}

function mutationAuditHash(mutation: SelfMaintenanceMutation): string {
  return crypto.createHash('sha256').update(mutation.content, 'utf8').digest('hex');
}

export function hashSelfMaintenanceContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function applySelfMaintenanceDecision(input: ApplySelfMaintenanceInput): ApplySelfMaintenanceResult {
  const layout = ensureSelfMaintenanceLayout(input.memoryRoot);
  const workspace = resolveWorkspaceIdentity(input.workingDirectory);
  const rejected = validateDecision(input);
  if (rejected) {
    return { applied: false, reason: rejected, changedPaths: [], backupPaths: [], workspaceId: workspace.id };
  }

  const writeLock = acquireSelfMaintenanceWriteLock(layout.root);
  if (!writeLock.acquired) {
    return { applied: false, reason: writeLock.reason, changedPaths: [], backupPaths: [], workspaceId: workspace.id };
  }

  const transactionState: { current: SelfMaintenanceTransaction | null } = { current: null };
  const captureOriginalPath = (filePath: string): void => {
    transactionState.current ??= beginSelfMaintenanceTransaction(layout.root);
    transactionState.current.capture(filePath);
  };

  try {
    const recovery = recoverSelfMaintenanceTransactions(layout.root);
    if (recovery.failed > 0) {
      return {
        applied: false,
        reason: '检测到无法恢复的自维护事务，本轮失败关闭',
        changedPaths: [],
        backupPaths: [],
        workspaceId: workspace.id,
      };
    }
    for (const mutation of input.decision.mutations) {
      if (!CORE_TARGETS.has(mutation.target)) continue;
      const targetPath = coreTargetPath(layout.root, mutation.target)!;
      const currentContent = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
      if (mutation.baseHash !== hashSelfMaintenanceContent(currentContent)) {
        return {
          applied: false,
          reason: `核心文档 ${mutation.target} 的 baseHash 已过期，拒绝覆盖并发更新`,
          changedPaths: [],
          backupPaths: [],
          workspaceId: workspace.id,
        };
      }
    }

    const now = (input.now || (() => new Date()))();
    const dateKey = beijingDateKey(now);
    const timestamp = now.toISOString();
    const sanitizedReason = redactSensitiveText(input.decision.reason || '未提供原因');
    const safeTimestamp = timestamp.replace(/[:.]/gu, '-');
    const changedPaths: string[] = [];
    const backupPaths: string[] = [];
    const ruleStates: ManagedRuleState[] = [];

    for (const mutation of input.decision.mutations) {
      const targetPath = mutationTargetPath(layout.root, mutation.target, dateKey, workspace.id);
      captureOriginalPath(targetPath);
      if (mutation.target === 'work_profile' && mutation.mode === 'upsert') {
        const result = upsertWorkProfileEntry(targetPath, {
          workspaceId: workspace.id,
          workspaceLabel: workspace.label,
          key: mutation.key!,
          content: mutation.content,
          timestamp,
          reason: sanitizedReason,
          evidenceIds: input.decision.evidenceIds,
        });
        if (result.changed) changedPaths.push(targetPath);
        continue;
      }
      if (CORE_TARGETS.has(mutation.target)) {
        const previous = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
        const backupPath = path.join(
          layout.root,
          '.cti-self-history',
          'versions',
          safeTimestamp,
          path.basename(targetPath),
        );
        captureOriginalPath(backupPath);
        atomicWrite(backupPath, previous);
        backupPaths.push(backupPath);
        const nextContent = mutation.mode === 'patch'
          ? upsertManagedAgentHomeRule(previous, {
            key: mutation.key!,
            content: mutation.content,
            updatedAt: timestamp,
          })
          : `${mutation.content.trim()}\n`;
        atomicWrite(targetPath, nextContent);
        if (mutation.mode === 'patch') {
          const ruleStatePath = resolveManagedRuleStatePath(
            layout.root,
            mutation.target as 'identity' | 'safety_rules' | 'tool_rules',
            mutation.key!,
          );
          captureOriginalPath(ruleStatePath);
          ruleStates.push(recordManagedRuleSupport({
            memoryRoot: layout.root,
            target: mutation.target as 'identity' | 'safety_rules' | 'tool_rules',
            key: mutation.key!,
            contentHash: hashSelfMaintenanceContent(mutation.content.trim()),
            sessionId: input.sessionId,
            timestamp,
          }));
        }
      } else if (mutation.mode === 'replace') {
        atomicWrite(targetPath, `${mutation.content.trim()}\n`);
      } else {
        const header = mutation.target === 'work_profile'
          ? `# 工作档案\n\n工作区：${workspace.label}\n工作区标识：${workspace.id}`
          : mutation.target === 'daily_reflection'
            ? `# 每日反思 ${dateKey}`
            : `# 纠错记录 ${dateKey}`;
        appendText(targetPath, header, [
          `## ${timestamp}`,
          '',
          `- 原因：${sanitizedReason}`,
          `- 证据：${input.decision.evidenceIds.join('、')}`,
          '',
          mutation.content,
        ].join('\n'));
      }
      changedPaths.push(targetPath);
    }

    for (const evaluation of input.decision.ruleEvaluations || []) {
      const ruleStatePath = resolveManagedRuleStatePath(layout.root, evaluation.target, evaluation.key);
      captureOriginalPath(ruleStatePath);
      ruleStates.push(recordManagedRuleEvaluation({
        memoryRoot: layout.root,
        target: evaluation.target,
        key: evaluation.key,
        outcome: evaluation.outcome,
        evidenceId: evaluation.evidenceId,
        timestamp,
      }));
    }

    if (input.decision.errorConfirmed && !input.decision.mutations.some((item) => item.target === 'correction_log')) {
      const correctionPath = mutationTargetPath(layout.root, 'correction_log', dateKey, workspace.id);
      captureOriginalPath(correctionPath);
      appendText(correctionPath, `# 纠错记录 ${dateKey}`, [
        `## ${timestamp}`,
        '',
        `- 判断：确认是 Agent 自身错误`,
        `- 原因：${sanitizedReason}`,
        `- 证据：${input.decision.evidenceIds.join('、')}`,
        `- 修改目标：${input.decision.mutations.map((item) => item.target).join('、')}`,
      ].join('\n'));
      changedPaths.push(correctionPath);
    }

    changedPaths.push(...writeAgentHomeHumanReadableProjections({
      root: layout.root,
      generatedAt: timestamp,
      lastAction: input.decision.action,
      workspaceId: workspace.id,
      captureOriginalPath,
    }));

    const auditPath = path.join(layout.root, '.cti-self-history', '自维护审计.jsonl');
    captureOriginalPath(auditPath);
    const auditRecord = {
      protocol: 'cti-self-maintenance-audit/v1',
      timestamp,
      action: input.decision.action,
      phase: input.phase,
      sessionId: input.sessionId,
      workspaceId: workspace.id,
      confidence: input.decision.confidence,
      errorConfirmed: input.decision.errorConfirmed,
      reason: sanitizedReason,
      evidenceIds: input.decision.evidenceIds,
      correction: input.decision.correction ? {
        errorType: input.decision.correction.errorType,
        claimEvidenceId: input.decision.correction.claimEvidenceId,
        claimTextHash: hashSelfMaintenanceContent(input.decision.correction.claimText.trim()),
        correctionEvidenceId: input.decision.correction.correctionEvidenceId,
        correctionTextHash: hashSelfMaintenanceContent(input.decision.correction.correctionText.trim()),
      } : undefined,
      ruleLifecycle: ruleStates.map((state) => ({
        target: state.target,
        key: state.key,
        status: state.status,
        supportCount: state.supportCount,
        contentHash: state.contentHash,
      })),
      mutations: input.decision.mutations.map((item) => ({
      target: item.target,
      mode: item.mode,
      key: item.key,
        contentHash: mutationAuditHash(item),
        charCount: item.content.length,
      })),
      changedPaths: changedPaths.map((item) => path.relative(layout.root, item).replace(/\\/gu, '/')),
      backupPaths: backupPaths.map((item) => path.relative(layout.root, item).replace(/\\/gu, '/')),
    };
    appendJsonLine(auditPath, auditRecord);

    const statusPath = path.join(layout.root, '.cti-self-history', 'status.json');
    captureOriginalPath(statusPath);
    atomicWrite(statusPath, `${JSON.stringify({
      protocol: 'cti-self-maintenance-status/v1',
      updatedAt: timestamp,
      lastAction: input.decision.action,
      lastPhase: input.phase,
      lastWorkspaceId: workspace.id,
      lastChangedPaths: auditRecord.changedPaths,
      backupCount: backupPaths.length,
    }, null, 2)}\n`);

    transactionState.current?.commit();
    try {
      input.onChanged?.();
    } catch {
      // 索引属于派生数据；提交已完成时不回滚事实源，后续 watcher 会重新构建。
    }
    try {
      rotateSelfMaintenanceHistory(layout.root, { now });
    } catch {
      // 轮转是非破坏性归档维护，失败不影响已经提交的事实源。
    }
    return {
      applied: true,
      reason: sanitizedReason,
      changedPaths: [...new Set(changedPaths)],
      backupPaths,
      workspaceId: workspace.id,
    };
  } catch (error) {
    const rollbackFailed = transactionState.current ? !transactionState.current.rollback() : false;
    const detail = error instanceof Error ? error.message : String(error);
    return {
      applied: false,
      reason: rollbackFailed
        ? `自维护事务写入失败且回滚不完整：${detail}`
        : `自维护事务写入失败，已回滚：${detail}`,
      changedPaths: [],
      backupPaths: [],
      workspaceId: workspace.id,
    };
  } finally {
    writeLock.release();
  }
}

export function rollbackSelfMaintenanceVersion(input: RollbackSelfMaintenanceInput): RollbackSelfMaintenanceResult {
  const layout = ensureSelfMaintenanceLayout(input.memoryRoot);
  const versionsRoot = path.join(layout.root, '.cti-self-history', 'versions');
  const backupPath = path.resolve(input.backupPath);
  if (!isPathInside(backupPath, versionsRoot)) {
    throw new Error('只允许从 .cti-self-history/versions 受控版本目录回滚');
  }
  if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isFile()) {
    throw new Error('待回滚版本不存在或不是文件');
  }
  const targetByName: Record<string, SelfMaintenanceTarget> = {
    '机器人身份.md': 'identity',
    '行为与安全规则.md': 'safety_rules',
    '工具与环境.md': 'tool_rules',
  };
  const target = targetByName[path.basename(backupPath)];
  const targetPath = target ? coreTargetPath(layout.root, target) : null;
  if (!targetPath) throw new Error('该备份不属于可回滚的 Agent Home 核心文档');

  const writeLock = acquireSelfMaintenanceWriteLock(layout.root);
  if (!writeLock.acquired) throw new Error(writeLock.reason);

  let transaction: SelfMaintenanceTransaction | null = null;
  try {
    const recovery = recoverSelfMaintenanceTransactions(layout.root);
    if (recovery.failed > 0) throw new Error('检测到无法恢复的自维护事务，本轮回滚失败关闭');
    transaction = beginSelfMaintenanceTransaction(layout.root);
    const captureOriginalPath = (filePath: string): void => transaction!.capture(filePath);
    const now = (input.now || (() => new Date()))();
    const timestamp = now.toISOString();
    const safeTimestamp = timestamp.replace(/[:.]/gu, '-');
    const currentVersionBackupPath = path.join(
      layout.root,
      '.cti-self-history',
      'rollbacks',
      safeTimestamp,
      path.basename(targetPath),
    );
    const currentContent = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';
    captureOriginalPath(currentVersionBackupPath);
    captureOriginalPath(targetPath);
    atomicWrite(currentVersionBackupPath, currentContent);
    atomicWrite(targetPath, fs.readFileSync(backupPath, 'utf8'));

    writeAgentHomeHumanReadableProjections({
      root: layout.root,
      generatedAt: timestamp,
      lastAction: 'rollback',
      captureOriginalPath,
    });

    const auditPath = path.join(layout.root, '.cti-self-history', '自维护审计.jsonl');
    captureOriginalPath(auditPath);
    appendJsonLine(auditPath, {
      protocol: 'cti-self-maintenance-audit/v1',
      timestamp,
      action: 'rollback',
      target,
      restoredFrom: path.relative(layout.root, backupPath).replace(/\\/gu, '/'),
      currentVersionBackup: path.relative(layout.root, currentVersionBackupPath).replace(/\\/gu, '/'),
    });
    transaction.commit();
    transaction = null;
    try {
      rotateSelfMaintenanceHistory(layout.root, { now });
    } catch {
      // 回滚事实已经落盘时，归档维护失败不能反向破坏回滚结果。
    }
    input.onChanged?.();
    return { restored: true, targetPath, currentVersionBackupPath };
  } catch (error) {
    const restored = transaction?.rollback() ?? true;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(restored ? `自维护回滚写入失败，已恢复原状态：${detail}` : `自维护回滚写入失败且恢复不完整：${detail}`);
  } finally {
    writeLock.release();
  }
}
