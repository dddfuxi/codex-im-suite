import fs from 'node:fs';
import path from 'node:path';

import { normalizeManagedAgentHomeRuleKey } from './agent-home-rules.js';

export type ManagedRuleTarget = 'identity' | 'safety_rules' | 'tool_rules';
export type ManagedRuleStatus = 'trial' | 'confirmed' | 'regressed';

export interface ManagedRuleVersionSummary {
  contentHash: string;
  status: ManagedRuleStatus;
  supportCount: number;
  replacedAt: string;
}

export interface ManagedRuleState {
  protocol: 'cti-self-maintenance-rule-state/v1';
  target: ManagedRuleTarget;
  key: string;
  contentHash: string;
  status: ManagedRuleStatus;
  supportCount: number;
  supportSessionIds: string[];
  firstSupportedAt: string;
  lastSupportedAt: string;
  successCount: number;
  regressionCount: number;
  evaluationEvidenceIds: string[];
  previousVersions: ManagedRuleVersionSummary[];
}

export interface RecordManagedRuleSupportInput {
  memoryRoot: string;
  target: ManagedRuleTarget;
  key: string;
  contentHash: string;
  sessionId: string;
  timestamp: string;
}

export interface RecordManagedRuleEvaluationInput {
  memoryRoot: string;
  target: ManagedRuleTarget;
  key: string;
  outcome: 'supported' | 'regressed';
  evidenceId: string;
  timestamp: string;
}

const CONFIRMATION_SUPPORT_COUNT = 2;
const MAX_SUPPORT_SESSIONS = 12;
const MAX_PREVIOUS_VERSIONS = 10;

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

export function resolveManagedRuleStatePath(memoryRoot: string, target: ManagedRuleTarget, key: string): string {
  return path.join(memoryRoot, '.cti-self-history', 'rules', target, `${normalizeManagedAgentHomeRuleKey(key)}.json`);
}

function readState(filePath: string): ManagedRuleState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ManagedRuleState;
    return parsed.protocol === 'cti-self-maintenance-rule-state/v1' ? parsed : null;
  } catch {
    return null;
  }
}

export function recordManagedRuleSupport(input: RecordManagedRuleSupportInput): ManagedRuleState {
  const key = normalizeManagedAgentHomeRuleKey(input.key);
  const filePath = resolveManagedRuleStatePath(input.memoryRoot, input.target, key);
  const previous = readState(filePath);
  const sameContent = previous?.contentHash === input.contentHash;
  const previousVersions = previous && !sameContent
    ? [{
      contentHash: previous.contentHash,
      status: previous.status,
      supportCount: previous.supportCount,
      replacedAt: input.timestamp,
    }, ...(previous.previousVersions || [])].slice(0, MAX_PREVIOUS_VERSIONS)
    : previous?.previousVersions || [];
  const supportSessionIds = sameContent
    ? [...new Set([...(previous?.supportSessionIds || []), input.sessionId])].slice(-MAX_SUPPORT_SESSIONS)
    : [input.sessionId];
  const supportCount = supportSessionIds.length;
  const state: ManagedRuleState = {
    protocol: 'cti-self-maintenance-rule-state/v1',
    target: input.target,
    key,
    contentHash: input.contentHash,
    status: supportCount >= CONFIRMATION_SUPPORT_COUNT ? 'confirmed' : 'trial',
    supportCount,
    supportSessionIds,
    firstSupportedAt: sameContent && previous ? previous.firstSupportedAt : input.timestamp,
    lastSupportedAt: input.timestamp,
    successCount: sameContent && previous ? previous.successCount || 0 : 0,
    regressionCount: sameContent && previous ? previous.regressionCount || 0 : 0,
    evaluationEvidenceIds: sameContent && previous ? previous.evaluationEvidenceIds || [] : [],
    previousVersions,
  };
  atomicWrite(filePath, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function recordManagedRuleEvaluation(input: RecordManagedRuleEvaluationInput): ManagedRuleState {
  const key = normalizeManagedAgentHomeRuleKey(input.key);
  const filePath = resolveManagedRuleStatePath(input.memoryRoot, input.target, key);
  const current = readState(filePath);
  if (!current) throw new Error(`待评估规则不存在：${input.target}/${key}`);
  if ((current.evaluationEvidenceIds || []).includes(input.evidenceId)) return current;
  const state: ManagedRuleState = {
    ...current,
    status: input.outcome === 'regressed' ? 'regressed' : current.status,
    successCount: (current.successCount || 0) + (input.outcome === 'supported' ? 1 : 0),
    regressionCount: (current.regressionCount || 0) + (input.outcome === 'regressed' ? 1 : 0),
    evaluationEvidenceIds: [...(current.evaluationEvidenceIds || []), input.evidenceId].slice(-24),
    lastSupportedAt: input.timestamp,
  };
  atomicWrite(filePath, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function listManagedRuleStates(memoryRoot: string): ManagedRuleState[] {
  const rulesRoot = path.join(memoryRoot, '.cti-self-history', 'rules');
  if (!fs.existsSync(rulesRoot)) return [];
  const states: ManagedRuleState[] = [];
  for (const target of ['identity', 'safety_rules', 'tool_rules'] as const) {
    const targetRoot = path.join(rulesRoot, target);
    if (!fs.existsSync(targetRoot)) continue;
    for (const entry of fs.readdirSync(targetRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const state = readState(path.join(targetRoot, entry.name));
      if (state) states.push(state);
    }
  }
  return states.sort((left, right) => right.lastSupportedAt.localeCompare(left.lastSupportedAt)).slice(0, 50);
}
