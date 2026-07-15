export type SkillSourceClass = 'installed' | 'official_curated' | 'whitelist' | 'self_created' | 'third_party' | 'unknown';
export type SkillRiskLevel = 'low' | 'medium' | 'high';
export type SkillRegistryState = 'discovered' | 'draft' | 'validated' | 'approval_pending' | 'installed' | 'enabled' | 'disabled' | 'quarantined';

export type SkillRegistryItem = {
  id: string;
  displayName: string;
  version?: string;
  sourceClass: SkillSourceClass;
  source?: string;
  path?: string;
  contentHash?: string;
  state: SkillRegistryState;
  risk: SkillRiskLevel;
  enabled: boolean;
  relatedProjects?: string[];
  validation?: { ok: boolean; checkedAt: string; summary: string };
  approval?: { required: 'none' | 'user' | 'owner'; nonce?: string; expiresAt?: string };
  failureSummary?: string;
  rollbackPath?: string;
  updatedAt: string;
};

export type SkillRegistrySnapshot = {
  protocol: 'cti-skill-registry/v1' | string;
  generatedAt: string;
  items: SkillRegistryItem[];
};

export type SkillGovernancePanelState = {
  available: boolean;
  error: string;
  snapshot: SkillRegistrySnapshot | null;
};

export type SkillWorkspace = {
  installed: SkillRegistryItem[];
  drafts: SkillRegistryItem[];
  catalog: SkillRegistryItem[];
  approvals: SkillRegistryItem[];
};

export function buildSkillWorkspace(snapshot: SkillRegistrySnapshot | null | undefined): SkillWorkspace {
  const workspace: SkillWorkspace = { installed: [], drafts: [], catalog: [], approvals: [] };
  for (const item of snapshot?.items ?? []) {
    if (item.state === 'approval_pending' || (item.approval?.required && item.approval.required !== 'none')) {
      workspace.approvals.push(item);
    } else if (item.sourceClass === 'installed' || ['installed', 'enabled', 'disabled'].includes(item.state)) {
      workspace.installed.push(item);
    } else if (item.sourceClass === 'self_created' || ['draft', 'validated', 'quarantined'].includes(item.state)) {
      workspace.drafts.push(item);
    } else {
      workspace.catalog.push(item);
    }
  }
  for (const group of Object.values(workspace)) group.sort((left, right) => left.id.localeCompare(right.id));
  return workspace;
}

export function skillAutonomyLabel(item: SkillRegistryItem): string {
  if (item.risk === 'high' || item.sourceClass === 'third_party' || item.sourceClass === 'unknown') return 'Owner 审批';
  if (item.state === 'approval_pending') return item.approval?.required === 'owner' ? 'Owner 审批' : '等待确认';
  if (item.sourceClass === 'installed' || ['installed', 'enabled', 'disabled'].includes(item.state)) return '已安装可用';
  if (item.sourceClass === 'whitelist' && item.risk === 'low') return '可自动处理';
  if (item.sourceClass === 'official_curated') return '询问后安装';
  if (item.sourceClass === 'self_created') return item.validation?.ok ? '验证后询问' : '先验证';
  return '隔离检查';
}
