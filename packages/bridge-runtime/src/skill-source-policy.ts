import {
  decideSkillLifecycleAction,
  type SkillChangeKind,
  type SkillLifecycleAction,
  type SkillRiskLevel,
  type SkillSourceClass,
} from 'claude-to-im/src/lib/bridge/agent-architecture.js';
import path from 'node:path';

export interface SkillSourcePolicyInput {
  installed: boolean;
  sourceClass: SkillSourceClass;
  risk: SkillRiskLevel;
  changeKind: SkillChangeKind;
}

export function decideSkillSourcePolicy(input: SkillSourcePolicyInput): SkillLifecycleAction {
  return decideSkillLifecycleAction(input);
}

export interface ResolveSkillSourceClassInput {
  source: string;
  skillId: string;
  draftRoot: string;
  whitelistedSources?: readonly string[];
}

function normalizeUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') return null;
    parsed.hash = '';
    return parsed.toString().replace(/\/$/u, '');
  } catch {
    return null;
  }
}

function normalizeSourceKey(value: string): string {
  return normalizeUrl(value) || `file:${path.resolve(value).toLowerCase()}`;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveSkillSourceClass(input: ResolveSkillSourceClassInput): SkillSourceClass {
  const localSource = path.resolve(input.source);
  const expectedDraft = path.resolve(input.draftRoot, input.skillId);
  if (localSource === expectedDraft && isInside(localSource, input.draftRoot)) return 'self_created';

  const normalized = normalizeUrl(input.source);
  if (normalized && /^https:\/\/github\.com\/openai\/skills\/tree\/[^/]+\/skills\/\.curated\/[a-z0-9-]+$/iu.test(normalized)) {
    return 'official_curated';
  }
  const whitelist = new Set((input.whitelistedSources || []).map(normalizeSourceKey));
  if (whitelist.has(normalizeSourceKey(input.source))) return 'whitelist';
  return normalized ? 'third_party' : 'unknown';
}
