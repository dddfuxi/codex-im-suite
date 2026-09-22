/**
 * React effects use this stable key to distinguish filter changes from a
 * user-requested global refresh. Including the revision prevents page-local
 * search results from staying stale when PanelState itself has refreshed.
 */
export function buildMemoryQueryRefreshKey(kind: string, sourceGroup: string, refreshRevision: number): string {
  return JSON.stringify([kind, sourceGroup, refreshRevision]);
}

export async function runPanelRefresh(input: {
  refreshState: () => Promise<unknown>;
  refreshRuntimeUnits: () => Promise<unknown>;
  invalidatePageData: () => void;
}): Promise<void> {
  await input.refreshState();
  await input.refreshRuntimeUnits();
  input.invalidatePageData();
}

export interface WorkspacePathSettings {
  defaultWorkDir: string;
  allowedRoots: string;
  memoryRepo: string;
  additionalDirs: string;
}

export interface WorkspacePathField {
  key: keyof WorkspacePathSettings;
  label: string;
  value: string;
  editable: boolean;
  note: string;
}

export function buildWorkspacePathSections(settings: WorkspacePathSettings): {
  editable: WorkspacePathField[];
  diagnostics: WorkspacePathField[];
} {
  return {
    editable: [
      {
        key: 'defaultWorkDir',
        label: '当前工作区',
        value: settings.defaultWorkDir,
        editable: true,
        note: '每轮默认只挂载这个工作区；明确引用其他项目时才临时挂载。',
      },
      {
        key: 'allowedRoots',
        label: '项目注册根',
        value: settings.allowedRoots,
        editable: true,
        note: '只定义可访问上界，不会自动进入 Prompt 或附加目录。',
      },
      {
        key: 'memoryRepo',
        label: 'Agent Home / 记忆库',
        value: settings.memoryRepo,
        editable: true,
        note: '身份、规则、工具、总索引和分区记忆的集中入口，不作为工作区挂载。',
      },
    ],
    diagnostics: [{
      key: 'additionalDirs',
      label: '旧 Codex 附加目录',
      value: settings.additionalDirs,
      editable: false,
      note: '兼容读取旧配置，但不再自动挂载，也不再从控制面板修改。',
    }],
  };
}

function joinWindowsDisplayPath(root: string, fileName: string): string {
  const normalizedRoot = root.replace(/[\\/]+$/u, '');
  if (!normalizedRoot) return fileName;
  const separator = normalizedRoot.includes('\\') || /^[A-Za-z]:/u.test(normalizedRoot) ? '\\' : '/';
  return `${normalizedRoot}${separator}${fileName}`;
}

export function buildAgentHomeEntries(memoryRoot: string): Array<{ name: string; path: string }> {
  return [
    '机器人身份.md',
    '行为与安全规则.md',
    '工具与环境.md',
    '记忆总索引.md',
    '记忆库说明.md',
  ].map((name) => ({ name, path: joinWindowsDisplayPath(memoryRoot, name) }));
}

export interface MemoryLayoutSummaryInput {
  layoutVersion?: string;
  migrationState?: string;
  v3SourceCount?: number;
  legacySourceCount?: number;
  unclassifiedRootDocuments?: Array<{ name: string; path: string }>;
}

export function buildMemoryLayoutSummary(layout: MemoryLayoutSummaryInput | undefined): {
  migrationLabel: string;
  unclassifiedCount: number;
  unclassifiedRootDocuments: Array<{ name: string; path: string }>;
} {
  const migrationLabel = layout?.migrationState === 'mixed'
    ? 'v3 与旧 v2 并存，等待迁移'
    : layout?.migrationState === 'legacy_only'
      ? '仅旧 v2，等待迁移'
      : layout?.migrationState === 'v3_only'
        ? '已使用 v3 可见布局'
        : '尚无分区记忆';
  const unclassifiedRootDocuments = layout?.unclassifiedRootDocuments || [];
  return {
    migrationLabel,
    unclassifiedCount: unclassifiedRootDocuments.length,
    unclassifiedRootDocuments,
  };
}

export interface SelfMaintenanceMetricsInput {
  dailyReflectionCount?: number;
  workProfileCount?: number;
  correctionDocumentCount?: number;
  versionBackupCount?: number;
  classifierCalls?: number;
  classifierSkips?: number;
  classifierApplied?: number;
  classifierRejected?: number;
  averageDurationMs?: number;
  lockConflicts?: number;
  hashConflicts?: number;
  trialRuleCount?: number;
  confirmedRuleCount?: number;
  regressedRuleCount?: number;
  lastUpdatedAt?: string;
  statusPath?: string;
}

export function buildSelfMaintenanceMetrics(input: SelfMaintenanceMetricsInput | undefined): Array<{
  label: string;
  value: string;
  updatedAt?: string;
  statusPath?: string;
}> {
  return [
    { label: '工作档案', value: String(input?.workProfileCount ?? 0) },
    { label: '每日反思', value: String(input?.dailyReflectionCount ?? 0) },
    { label: '纠错档案', value: String(input?.correctionDocumentCount ?? 0) },
    { label: '可回滚版本', value: String(input?.versionBackupCount ?? 0) },
    { label: '分类器调用', value: `${input?.classifierCalls ?? 0} / 跳过 ${input?.classifierSkips ?? 0}` },
    { label: '平均耗时', value: `${input?.averageDurationMs ?? 0} ms` },
    { label: '规则状态', value: `试用 ${input?.trialRuleCount ?? 0} / 已确认 ${input?.confirmedRuleCount ?? 0} / 回归 ${input?.regressedRuleCount ?? 0}` },
    { label: '并发冲突', value: `锁 ${input?.lockConflicts ?? 0} / 哈希 ${input?.hashConflicts ?? 0}` },
  ].map((item) => ({ ...item, updatedAt: input?.lastUpdatedAt, statusPath: input?.statusPath }));
}

export type MemoryLifecycleStatus = 'confirmed' | 'candidate' | 'archived';
export type MemoryLifecycleAction = 'confirm' | 'archive' | 'restore' | 'delete';

export interface MemoryLifecycleEntry {
  value: string;
  updatedAt: string;
  confidence: number;
  status: 'confirmed' | 'candidate';
  sourceKind: string;
  distinctSessionCount?: number;
  lastEvidenceAt?: string;
}

export interface MemoryLifecycleItemRecord {
  itemId: string;
  key: string;
  entry: MemoryLifecycleEntry;
  status: 'confirmed' | 'candidate';
  scope: string;
  sourceRelativePath: string;
  sourceBaseHash: string;
}

export interface MemoryLifecycleArchiveRecord {
  archiveId: string;
  itemId: string;
  previousStatus: 'confirmed' | 'candidate';
  key: string;
  entry: MemoryLifecycleEntry;
  scope: string;
  sourceRelativePath: string;
  sourceBaseHash: string;
  archivedAt: string;
  archivedBy: string;
}

export interface MemoryLifecycleSnapshot {
  confirmed: MemoryLifecycleItemRecord[];
  candidates: MemoryLifecycleItemRecord[];
  archives: MemoryLifecycleArchiveRecord[];
}

export interface MemoryLifecycleRow {
  id: string;
  itemId: string;
  archiveId?: string;
  key: string;
  value: string;
  status: MemoryLifecycleStatus;
  previousStatus?: 'confirmed' | 'candidate';
  scope: string;
  sourceRelativePath: string;
  sourceBaseHash: string;
  confidence: number;
  updatedAt: string;
  sourceKind: string;
  distinctSessionCount?: number;
  lastEvidenceAt?: string;
  archivedAt?: string;
}

function toLifecycleRow(item: MemoryLifecycleItemRecord): MemoryLifecycleRow {
  return {
    id: item.itemId,
    itemId: item.itemId,
    key: item.key,
    value: item.entry.value,
    status: item.status,
    scope: item.scope,
    sourceRelativePath: item.sourceRelativePath,
    sourceBaseHash: item.sourceBaseHash,
    confidence: item.entry.confidence,
    updatedAt: item.entry.updatedAt,
    sourceKind: item.entry.sourceKind,
    distinctSessionCount: item.entry.distinctSessionCount,
    lastEvidenceAt: item.entry.lastEvidenceAt,
  };
}

function toArchiveRow(item: MemoryLifecycleArchiveRecord): MemoryLifecycleRow {
  return {
    id: item.archiveId,
    archiveId: item.archiveId,
    itemId: item.itemId,
    key: item.key,
    value: item.entry.value,
    status: 'archived',
    previousStatus: item.previousStatus,
    scope: item.scope,
    sourceRelativePath: item.sourceRelativePath,
    sourceBaseHash: item.sourceBaseHash,
    confidence: item.entry.confidence,
    updatedAt: item.entry.updatedAt,
    sourceKind: item.entry.sourceKind,
    distinctSessionCount: item.entry.distinctSessionCount,
    lastEvidenceAt: item.entry.lastEvidenceAt,
    archivedAt: item.archivedAt,
  };
}

export function buildMemoryLifecycleView(snapshot: MemoryLifecycleSnapshot, status: MemoryLifecycleStatus): {
  rows: MemoryLifecycleRow[];
  counts: Record<MemoryLifecycleStatus, number>;
} {
  const rows = status === 'confirmed'
    ? snapshot.confirmed.map(toLifecycleRow)
    : status === 'candidate'
      ? snapshot.candidates.map(toLifecycleRow)
      : snapshot.archives.map(toArchiveRow);
  return {
    rows: rows.sort((left, right) => (right.archivedAt || right.updatedAt).localeCompare(left.archivedAt || left.updatedAt)),
    counts: {
      confirmed: snapshot.confirmed.length,
      candidate: snapshot.candidates.length,
      archived: snapshot.archives.length,
    },
  };
}

export function memoryItemActions(row: MemoryLifecycleRow): MemoryLifecycleAction[] {
  if (row.status === 'candidate') return ['confirm', 'archive'];
  if (row.status === 'confirmed') return ['archive'];
  return ['restore', 'delete'];
}
