export type PromptSectionKind =
  | 'identity'
  | 'base'
  | 'policy'
  | 'skills'
  | 'memory'
  | 'style'
  | 'protocol'
  | 'priority_context'
  | 'execution';

export type PromptSnapshotSection = {
  id: string;
  kind: PromptSectionKind;
  source: string;
  priority: number;
  charCount: number;
  hash: string;
  injected: boolean;
  truncated: boolean;
  truncationReason?: 'section_limit' | 'snapshot_limit' | 'redacted';
  content: string;
};

export type PromptSnapshotRecord = {
  protocol: 'cti-prompt-snapshot/v1' | string;
  sessionId: string;
  createdAt: string;
  totalChars: number;
  sections: PromptSnapshotSection[];
};

export type PromptSnapshotStoreState = {
  protocol: 'cti-prompt-snapshot-store/v1' | string;
  policy: { maxItems: number; maxAgeDays: number };
  snapshots: PromptSnapshotRecord[];
};

export type PromptSnapshotPanelState = {
  available: boolean;
  path: string;
  error: string;
  data: PromptSnapshotStoreState | null;
};

export type PromptSectionRow = PromptSnapshotSection & {
  kindLabel: string;
  shortHash: string;
  warning: '' | '未注入' | '已截断' | '已脱敏';
};

const kindLabels: Record<PromptSectionKind, string> = {
  identity: '身份与入口',
  base: '基础提示',
  policy: '策略规则',
  skills: 'Skill 能力',
  memory: '记忆上下文',
  style: '回复风格',
  protocol: '结果协议',
  priority_context: '高优先上下文',
  execution: '执行要求',
};

export function buildPromptSectionRows(snapshot: PromptSnapshotRecord): PromptSectionRow[] {
  return snapshot.sections
    .map((section, index) => ({ section, index }))
    .sort((left, right) => left.section.priority - right.section.priority || left.index - right.index)
    .map(({ section }) => ({
      ...section,
      kindLabel: kindLabels[section.kind] ?? section.kind,
      shortHash: section.hash.slice(0, 12),
      warning: !section.injected
        ? '未注入'
        : section.truncated
          ? '已截断'
          : section.truncationReason === 'redacted'
            ? '已脱敏'
            : '',
    }));
}
