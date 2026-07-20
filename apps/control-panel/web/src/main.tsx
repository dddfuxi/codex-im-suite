import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import {
  Activity,
  Archive,
  ArrowDownUp,
  ArrowLeftRight,
  Bell,
  Bot,
  BrainCircuit,
  CalendarClock,
  CheckCircle2,
  Clipboard,
  Database,
  ExternalLink,
  FileText,
  FolderOpen,
  GitBranch,
  History,
  Image as ImageIcon,
  Layers3,
  ListChecks,
  Logs,
  MessageCircle,
  MoonStar,
  Network,
  Play,
  PlugZap,
  Power,
  RefreshCw,
  Rocket,
  RotateCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Square,
  SunMedium,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import {
  panelNavigation,
  panelPageMeta,
  resolveLegacyServiceTab,
  resolvePageId,
  type PageId,
  type ServiceTabId,
} from './panel-navigation.js';
import { ArchitecturePage } from './pages/ArchitecturePage.js';
import { McpPage } from './pages/McpPage.js';
import { ModelsPluginsPage } from './pages/ModelsPluginsPage.js';
import { PromptPage } from './pages/PromptPage.js';
import { SkillsPage } from './pages/SkillsPage.js';
import { ScheduledTasksPage } from './pages/ScheduledTasksPage.js';
import type { PromptSnapshotPanelState } from './prompt-view-model.js';
import type { SkillGovernancePanelState } from './skill-view-model.js';
import type { ScheduledTaskPanelState } from './scheduled-task-view-model.js';
import {
  buildAgentHomeEntries,
  buildMemoryLayoutSummary,
  buildMemoryLifecycleView,
  buildMemoryQueryRefreshKey,
  buildSelfMaintenanceMetrics,
  buildWorkspacePathSections,
  memoryItemActions,
  runPanelRefresh,
  type MemoryLifecycleArchiveRecord,
  type MemoryLifecycleItemRecord,
  type MemoryLifecycleRow,
  type MemoryLifecycleSnapshot,
  type MemoryLifecycleStatus,
} from './memory-page-view-model.js';
import {
  buildStickerEvolutionSummary,
  getStickerLifecycleActions,
  getStickerRevisionActions,
  matchesStickerStatusFilter,
  type StickerRevisionAction,
  type StickerStatusFilter,
} from './sticker-library-view-model.js';
import './styles.css';

type StatusKind = 'ok' | 'warning' | 'error' | 'idle';
type ThemeMode = 'light' | 'dark';
type CommandNoticeStatus = 'running' | 'success' | 'error';

type ActivityRecord = {
  level: string;
  title: string;
  message: string;
  timestamp: string;
};

type CommandNotice = {
  command: string;
  label: string;
  status: CommandNoticeStatus;
  message: string;
  startedAt: number;
};

type ServiceItem = {
  id: string;
  title: string;
  status: StatusKind;
  detail: string;
};

type NodeCapability = {
  id: string;
  displayName: string;
  category: string;
  status: 'online' | 'degraded' | 'offline' | 'unknown';
  detail: string;
  risk: 'low' | 'medium' | 'high';
};

type NodeAgent = {
  nodeId: string;
  displayName: string;
  kind: 'local' | 'remote' | 'fake';
  status: 'online' | 'degraded' | 'offline' | 'unknown';
  version: string;
  host: string;
  lastSeenAt: string;
  capabilities: NodeCapability[];
  detail: string;
  isLocal: boolean;
  canManage: boolean;
};

type NodeSnapshot = {
  schema: 'codex-im-suite/control-plane-state/v1';
  generatedAt: string;
  activeNodeId: string;
  nodes: NodeAgent[];
};

type McpItem = {
  id: string;
  displayName: string;
  type: string;
  category: string;
  enabled: boolean;
  isRunning: boolean;
  processId?: number;
  isRegistered: boolean;
  installState: string;
  source: string;
  version: string;
  protocol: string;
  suiteRange: string;
  aliases: string[];
  description: string;
};

type ExtensionItem = {
  id: string;
  displayName: string;
  type: string;
  category: string;
  enabled: boolean;
  installState: string;
  source: string;
  sourceExists: boolean;
  description: string;
  manifestPath: string;
  canInstall?: boolean;
  canRemove?: boolean;
};

type SettingsState = {
  defaultWorkDir: string;
  allowedRoots: string;
  memoryRepo: string;
  additionalDirs: string;
  replyStyleHint: string;
  defaultExecutorId: string;
  localAiKind: string;
  localAiBaseUrl: string;
  ollamaModelsDir: string;
  localAiModel: string;
  localAiApiKeyAction: 'keep' | 'set' | 'clear';
  localAiApiKeyValue: string;
  localAiApiKeyMasked: string;
  localAiApiKeySet: boolean;
  localAiTimeoutMs: string;
  codexModelSource: 'official' | 'local_api' | 'external_api' | string;
  codexRoutingMode: 'manual' | 'auto_failover' | string;
  codexApiFallbackChain: string;
  codexBaseUrl: string;
  codexModel: string;
  codexPassModel: boolean;
  codexReasoningEffort: string;
  memoryOptimizerEnabled: boolean;
  memoryOptimizerIntervalDays: string;
  memoryOptimizerModelSource: 'codex_primary' | 'local_ai' | 'external_api' | string;
  codexApiKeyAction: 'keep' | 'set' | 'clear';
  codexApiKeyValue: string;
  codexApiKeyMasked: string;
  codexApiKeySet: boolean;
};

type AiStrategy = 'official' | 'local_api' | 'external_api' | 'auto_failover';
type CodexSource = 'local_api' | 'external_api' | 'official';

const CODEX_SOURCE_LABELS: Record<CodexSource, string> = {
  local_api: '本地模型 API',
  external_api: '外部 API',
  official: '官方 Codex',
};

const LOCAL_AI_PRESETS: Record<string, { label: string; baseUrl: string; timeoutMs: string }> = {
  ollama: { label: 'Ollama', baseUrl: 'http://127.0.0.1:11434', timeoutMs: '45000' },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', timeoutMs: '45000' },
  vllm: { label: 'vLLM / OpenAI-compatible', baseUrl: 'http://127.0.0.1:8000/v1', timeoutMs: '45000' },
  'openai-compatible': { label: 'OpenAI-compatible', baseUrl: 'http://127.0.0.1:8000/v1', timeoutMs: '45000' },
  custom: { label: '自定义', baseUrl: '', timeoutMs: '45000' },
};

function inferAiStrategy(settings: SettingsState): AiStrategy {
  if ((settings.codexRoutingMode || '').trim() === 'auto_failover') return 'auto_failover';
  const source = (settings.codexModelSource || '').trim();
  if (source === 'local_api' || source === 'external_api') return source;
  if (settings.codexBaseUrl.trim() || settings.codexModel.trim() || settings.codexApiKeySet || settings.codexApiKeyAction === 'set') return 'external_api';
  return 'official';
}

function strategyLabel(strategy: AiStrategy): string {
  if (strategy === 'local_api') return '本地模型 API';
  if (strategy === 'external_api') return '外部 API';
  if (strategy === 'auto_failover') return '自动切换';
  return '官方 Codex';
}

function localAiLabel(kind: string): string {
  return LOCAL_AI_PRESETS[kind]?.label || '自定义';
}

function localAiCapabilityLabel(kind: string): string {
  const normalized = (kind || '').trim().toLowerCase();
  if (normalized === 'ollama' || normalized === 'lmstudio') return '支持 Codex agent';
  if (normalized === 'vllm' || normalized === 'openai-compatible' || normalized === 'custom') return '仅 Chat Completions';
  return '不可用';
}

function localAiCapabilityHint(kind: string): string {
  const normalized = (kind || '').trim().toLowerCase();
  if (normalized === 'ollama' || normalized === 'lmstudio') {
    return '会通过 codex exec --oss --local-provider 使用本地模型，不调用 Codex SDK /v1/responses。';
  }
  return '该 provider 当前不能作为 Codex CLI OSS agent 执行器；手动本地 API 会直接阻断，自动切换只会继续尝试链里的其他来源。';
}

function parseCodexChain(value: string): CodexSource[] {
  const valid = new Set<CodexSource>(['local_api', 'external_api', 'official']);
  const seen = new Set<CodexSource>();
  const chain: CodexSource[] = [];
  for (const part of (value || '').split(',')) {
    const source = part.trim() as CodexSource;
    if (valid.has(source) && !seen.has(source)) {
      seen.add(source);
      chain.push(source);
    }
  }
  return chain.length ? chain : ['local_api', 'external_api'];
}

function formatCodexChain(value: string): string {
  return parseCodexChain(value).join(',');
}

type SessionItem = {
  displayName: string;
  channelType: string;
  chatType: string;
  chatId: string;
  sessionId: string;
  source: string;
  localMessageCount: number;
  remoteMessageCount: number;
  lastUpdatedAt: string;
  summary: string;
};

type ConversationMessage = {
  index: number;
  messageId: string;
  role: string;
  msgType: string;
  senderId: string;
  senderType: string;
  senderName: string;
  createdAt: string;
  content: string;
  cardContent?: string;
  rawContentPreview?: string;
  attachments?: MessageAttachment[];
  canRecall?: boolean;
  recallStatus?: 'none' | 'recalled' | 'failed';
  recallError?: string;
};

type MessageAttachment = {
  kind: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
  url: string;
  resourceKey: string;
  status: string;
};

type SessionDetail = {
  displayName: string;
  channelType: string;
  chatType: string;
  chatId: string;
  sessionId: string;
  sdkSessionId: string;
  workingDirectory: string;
  source: string;
  hasLocalBinding: boolean;
  localMessageCount: number;
  remoteMessageCount: number;
  lastUpdatedAt: string;
  summary: string;
  messages: ConversationMessage[];
  people?: FeishuPerson[];
  workflowRuns?: WorkflowRun[];
};

type FeishuPerson = {
  userId: string;
  senderType: string;
  displayName: string;
  role: PermissionRole | '';
  isOwner: boolean;
  messageCount: number;
};

type PermissionRole = 'viewer' | 'operator' | 'owner';

type PermissionSubject = {
  channelType: string;
  userId: string;
  displayName: string;
  role: PermissionRole;
  source: string;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
};

type PermissionCandidate = {
  channelType: string;
  userId: string;
  displayName: string;
  source: string;
  messageCount: number;
};

type PermissionSnapshot = {
  protocol: string;
  updatedAt: string;
  subjects: PermissionSubject[];
  candidates: PermissionCandidate[];
};

type ReplyPresetItem = {
  name: string;
  value: string;
};

type RuntimeAction = {
  id: string;
  label: string;
  enabled: boolean;
  reason?: string;
};

type RuntimeUnit = {
  unitId: string;
  id: string;
  displayName: string;
  kind: string;
  category: string;
  status: StatusKind;
  detail: string;
  enabled: boolean;
  installState: string;
  source: string;
  cwd: string;
  version: string;
  description: string;
  canInstall: boolean;
  actions: RuntimeAction[];
};

type ExecutorItem = {
  id: string;
  displayName: string;
  kind: string;
  capabilities: string[];
  riskLevel: string;
  enabled: boolean;
  priority: number;
  description: string;
};

type ExecutorStatus = {
  protocol: string;
  updatedAt: string;
  defaultExecutorId?: string;
  executors: ExecutorItem[];
  sessionDefaults: Record<string, string>;
  lastSelection?: {
    sessionId: string;
    executorId: string;
    reason: string;
    explicit: boolean;
    fallbackExecutorIds: string[];
    selectedAt: string;
  };
};

type WorkflowRun = {
  id: string;
  sessionId: string;
  channelType?: string;
  chatId?: string;
  promptPreview: string;
  stage: string;
  status: string;
  executorId?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  error?: string;
  execution?: {
    executorId?: string;
    executorName?: string;
    executorKind?: string;
    provider?: string;
    codexProfile?: string;
    modelSource?: string;
    attemptedSources?: string[];
    selectedSource?: 'local_api' | 'external_api' | 'official';
    model?: string;
    baseUrl?: string;
    requiredEvidenceKind?: 'none' | 'input_evidence_required' | 'local_read_required' | 'tool_required' | 'artifact_required';
    evidenceSatisfied?: boolean;
    noEvidenceRetryAttempted?: boolean;
    requiredToolFamilies?: string[];
    requiredInputEvidenceKinds?: string[];
    requiredInputEvidenceIds?: string[];
    acceptedInputEvidenceKinds?: string[];
    acceptedInputEvidenceIds?: string[];
    inputEvidenceProvider?: string;
    toolUseCount?: number;
    toolResultCount?: number;
    successfulToolResultCount?: number;
    failedToolResultCount?: number;
    toolNames?: string[];
    evidenceProtocol?: string;
    requestedTool?: string;
    executedTool?: string;
    jsonToolRetryAttempted?: boolean;
    jsonToolFallbackUsed?: boolean;
    shellExitCode?: number;
    shellDurationMs?: number;
    promptProfile?: string;
  };
  tokenUsage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    total_tokens?: number;
  };
  recovery?: {
    kind: 'recoverable' | 'not_recoverable';
    reason: string;
    input?: {
      prompt?: string;
      workingDirectory?: string;
      model?: string;
      permissionMode?: string;
      channelType?: string;
      chatId?: string;
      messageId?: string;
    };
    runtimeRunId?: string;
    markedAt: string;
  };
  retry?: {
    status: 'none' | 'auto_pending' | 'manual_pending' | 'retrying' | 'succeeded' | 'failed' | 'exhausted' | 'unavailable';
    attempts: number;
    maxAttempts: number;
    requestedBy?: string;
    requestedAt?: string;
    claimedBy?: string;
    claimedAt?: string;
    lastAttemptAt?: string;
    lastError?: string;
  };
  events?: Array<{ id: string; stage: string; type: string; message: string; at: string }>;
};

type WorkflowStatus = {
  protocol: string;
  updatedAt: string;
  runs: WorkflowRun[];
};

type KnowledgeIndexStatus = {
  schema: string;
  memoryRoot: string;
  indexPath: string;
  statusPath?: string;
  memoryGraphPath?: string;
  watching: boolean;
  exists: boolean;
  markdownFileCount: number;
  itemCount: number;
  conflictCount: number;
  memoryGraphNodeCount?: number;
  memoryGraphEdgeCount?: number;
  memoryGraphPreview?: {
    nodes: Array<{ id: string; label: string; kind: string }>;
    edges: Array<{ from: string; to: string; fromLabel?: string; toLabel?: string; type: string; weight: number }>;
  };
  sourceFileCount?: number;
  sourceCoverage?: MemorySourceSummaryItem[];
  skippedDirectories?: string[];
  kindCounts?: Record<string, number>;
  recentReviewWarnings?: Array<{
    createdAt: string;
    verdict: string;
    reasonCodes: string[];
    userText: string;
    answerText: string;
  }>;
  generatedAt: string;
  lastIndexedAt?: string;
  lastEventAt?: string;
  watcherStartedAt?: string;
  watcherPid?: number;
  statusUpdatedAt?: string;
  lastError: string;
  optimization?: MemoryOptimizationStatus;
  layout?: {
    layoutVersion: string;
    migrationState: 'mixed' | 'v3_only' | 'legacy_only' | 'empty' | string;
    v3SourceCount: number;
    legacySourceCount: number;
    agentHome: Array<{ name: string; path: string; exists: boolean }>;
    unclassifiedRootDocuments?: Array<{ name: string; path: string }>;
    selfMaintenance?: {
      dailyReflectionCount: number;
      workProfileCount: number;
      correctionDocumentCount: number;
      versionBackupCount: number;
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
    };
  };
};

type KnowledgeSearchItem = {
  id: string;
  kind: 'fact' | 'conclusion' | 'todo' | 'resource' | string;
  key: string;
  value: string;
  text: string;
  sourceGroup?: MemorySourceGroup;
  confidence: number;
  conflict: boolean;
  classificationReason?: string;
  classificationSource?: string;
  sourcePath: string;
  sourceUpdatedAt?: string;
  snippet: string;
  related?: Array<{ label: string; kind: string; type: string; score: number }>;
};

type KnowledgeSearchResponse = {
  status: KnowledgeIndexStatus;
  items: KnowledgeSearchItem[];
  totalMatched?: number;
  offset?: number;
  limit?: number;
};

type MemorySourceGroup = 'memory_user' | 'memory_group' | 'memory_long_term' | 'direct_reminder' | 'other' | string;

type MemorySourceSummaryItem = {
  sourcePath: string;
  sourceGroup: MemorySourceGroup;
  itemCount: number;
  updatedAt?: string;
  autoSelectable: boolean;
  defaultRisk: 'low' | 'medium' | 'high' | string;
};

type MemoryOptimizationAction = {
  id: string;
  type: 'add' | 'update' | 'archive';
  title: string;
  reason: string;
  confidence: number;
  risk: 'low' | 'medium' | 'high';
  sourceGroup?: MemorySourceGroup;
  defaultSelected?: boolean;
  requiresManualReview?: boolean;
  source?: { itemId?: string; path?: string; snippet?: string };
  targetPath?: string;
  before?: string;
  after?: string;
};

type MemoryOptimizationDraft = {
  draftId: string;
  generatedAt: string;
  generatedBy?: 'manual' | 'schedule';
  status: 'draft' | 'applied' | 'discarded' | 'undone';
  sourceIndexGeneratedAt?: string;
  summary: string;
  sourceSummary?: MemorySourceSummaryItem[];
  actions: MemoryOptimizationAction[];
  appliedAt?: string;
  discardedAt?: string;
  appliedActionIds?: string[];
  skippedActionIds?: string[];
  undoneAt?: string;
  undoRestoredActionIds?: string[];
  undoManualActionIds?: string[];
  undoMissingArchiveActionIds?: string[];
};

type MemoryOptimizationStatus = {
  schema: string;
  memoryRoot: string;
  statePath: string;
  draftsDir: string;
  enabled: boolean;
  intervalDays: number;
  modelSource: 'codex_primary' | 'local_ai' | 'external_api' | string;
  lastGeneratedAt?: string;
  nextRunAt?: string;
  draftCount: number;
  recentError?: string;
  drafts: MemoryOptimizationDraft[];
};

type FeishuStickerLibraryItem = {
  fileKey: string;
  mediaPath: string;
  previewUrl: string;
  mediaMimeType: string;
  aliases: string[];
  chatId: string;
  userId: string;
  label: string;
  description: string;
  intent: string;
  tone: string;
  usage: string;
  avoidWhen: string;
  examples: string[];
  annotationConfidence: number;
  annotationSource: string;
  annotationVerifiedAt: string;
  hasUserAnnotation: boolean;
  hasTrustedSemantic: boolean;
  hasMedia: boolean;
  isLibraryAsset: boolean;
  isHistoryOnly: boolean;
  hasMediaDownloadFailure: boolean;
  mediaExtensionMismatch: boolean;
  statusLabel: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastUsedAt: string;
  mediaCachedAt: string;
  mediaDownloadFailedAt: string;
  mediaDownloadError: string;
  useCount: number;
  disabled: boolean;
  disabledReason: string;
  lastEditedAt: string;
  archived: boolean;
  archivedAt: string;
};

type FeishuStickerLibrarySnapshot = {
  schema: string;
  storePath: string;
  mediaDir: string;
  updatedAt: string;
  stickers: FeishuStickerLibraryItem[];
};

type StickerSemanticAvoidRule = {
  id: string;
  condition: string;
  category: string;
  status: 'trial' | 'confirmed' | 'regressed';
  confidence: number;
  supportCount: number;
  contradictionCount: number;
};

type StickerSemanticRevision = {
  revisionId: string;
  fileKey: string;
  scope: 'global' | 'chat' | 'user';
  scopeId?: string;
  status: 'trial' | 'confirmed' | 'regressed' | 'rejected';
  patch: {
    intent?: string;
    tone?: string;
    usage?: string;
    aliases?: string[];
    examples?: string[];
    avoidRules?: StickerSemanticAvoidRule[];
  };
  supportSessionIds: string[];
  contradictionSessionIds: string[];
  updatedAt: string;
};

type StickerSemanticAsset = {
  fileKey: string;
  label?: string;
  aliases: string[];
  archived: boolean;
  disabled: boolean;
  visual: { source: 'vision' | 'manual' | 'unverified'; description?: string; confidence?: number };
};

type StickerSemanticPanelState = {
  baseHash: string;
  generatedAt: string;
  humanArchivePath: string;
  humanArchiveExists: boolean;
  assets: StickerSemanticAsset[];
  revisions: StickerSemanticRevision[];
};

type StickerSemanticCliEnvelope<T> = { ok: boolean; data: T };

function readStickerSemanticCliData<T>(value: unknown): T {
  const envelope = value as StickerSemanticCliEnvelope<T>;
  if (!envelope?.ok || !envelope.data) throw new Error('表情包语义 CLI 返回无效。');
  return envelope.data;
}

type UserFacingStatus = 'normal' | 'attention' | 'disabled';

type BlueprintActionKind = 'runtime' | 'command' | 'navigate';

type BlueprintAction = {
  id: string;
  label: string;
  kind: BlueprintActionKind;
  unitId?: string;
  actionId?: string;
  command?: string;
  targetPage?: PageId;
  targetUnitId?: string;
  description?: string;
};

type SystemBlueprintNode = {
  id: 'entry' | 'bridge' | 'brain' | 'assist' | 'reply';
  title: string;
  detail: string;
  status: UserFacingStatus;
  helpText?: string;
  targetPage?: PageId;
  targetUnitId?: string;
  primaryAction?: BlueprintAction;
  secondaryActions?: BlueprintAction[];
  children?: Array<{
    id: string;
    title: string;
    detail: string;
    status: UserFacingStatus;
    helpText?: string;
    targetPage?: PageId;
    targetUnitId?: string;
    primaryAction?: BlueprintAction;
    secondaryActions?: BlueprintAction[];
  }>;
};

type BlueprintNodeView = {
  id: string;
  title: string;
  detail: string;
  status: UserFacingStatus;
  helpText?: string;
  targetPage?: PageId;
  targetUnitId?: string;
  primaryAction?: BlueprintAction;
  secondaryActions?: BlueprintAction[];
  parentTitle?: string;
};

type MemoryRelationGroup = {
  id: string;
  title: string;
  status: UserFacingStatus;
  items: Array<{
    id: string;
    label: string;
    detail: string;
    relation: string;
    status: UserFacingStatus;
  }>;
};

type TodoReminderSnapshot = {
  schema: string;
  memoryRoot: string;
  indexPath: string;
  statePath: string;
  exists: boolean;
  enabled: boolean;
  memoryPushEnabled?: boolean;
  directReminderEnabled?: boolean;
  directReminderPushEnabled?: boolean;
  pollMs: number;
  windowMs: number;
  channels: string[];
  providers: Array<{ channelType: string; state: string; detail: string }>;
  counts: { total: number; pending: number; sent: number; failed: number; skipped: number; completed?: number };
  items: TodoReminderItem[];
  lastError: string;
};

type TodoReminderItem = {
  id: string;
  title: string;
  dueAt: string;
  todoStatus: string;
  status: string;
  sourceType?: string;
  createdAt?: string;
  createdByMessageId?: string;
  completedAt?: string;
  completedByUserId?: string;
  completionSource?: string;
  completionError?: string;
  skipReason: string;
  target: { channelType: string; chatId: string; displayName: string; messageId: string };
  source: { path: string; snippet: string; updatedAt: string };
  delivery?: { status?: string; messageId?: string; cardId?: string; lastAttemptAt?: string; error?: string; attempts?: number; completedAt?: string; completedByUserId?: string; completionSource?: string; completionError?: string };
};

type ExtensionCatalogFilter = 'all' | 'mcp' | 'skill' | 'plugin' | 'model';
type ImportKind = '' | 'mcp';
type McpRuntimeType = 'stdio' | 'http';

type ExtensionImportPreview = {
  folderPath: string;
  detectedKind: string;
  runtimeType: string;
  id: string;
  displayName: string;
  source: string;
  manifestPath: string;
  description: string;
  installState: string;
  suggestedKinds: string[];
  canImport: boolean;
  reason: string;
};

type ExtensionCatalogItem = {
  id: string;
  type: string;
  displayName: string;
  version: string;
  category: string;
  description: string;
  installHandler: string;
  artifactUrl?: string;
  catalogSource: string;
  sourceLayer: 'seed' | 'dynamic' | 'custom_url' | string;
  sourceName: string;
  fetchedAt: string;
  rankBasis: string;
  rankOrder: number;
  trusted: boolean;
  trustReason: string;
  canInstall: boolean;
  installed: boolean;
  canRemove: boolean;
  installedVersion: string;
  installedAt: string;
  installPath: string;
};

type ExtensionInstallJob = {
  jobId: string;
  itemId: string;
  type: string;
  displayName: string;
  model: string;
  installPath: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | string;
  stage: string;
  message: string;
  percent: number;
  canCancel: boolean;
  useAfterInstall: boolean;
  exitCode?: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string;
  recentLines: string[];
};

type ExtensionCatalogSnapshot = {
  protocol: string;
  refreshedAt: string;
  sourceCount: number;
  layerCounts: {
    seed: number;
    dynamic: number;
    customUrl: number;
    local?: number;
  };
  items: ExtensionCatalogItem[];
};

type RemoteExtensionPreview = {
  id: string;
  type: string;
  displayName: string;
  version: string;
  category: string;
  description: string;
  installHandler: string;
  artifactUrl?: string;
  sourceUrl: string;
  trusted: boolean;
  reason: string;
};

type LiveSyncState = {
  status: 'current' | 'outdated' | 'missing' | 'error' | 'unavailable';
  lastSyncedAt: string;
  suiteCommit: string;
  liveCommit: string;
  summary: string;
  canSync: boolean;
  detail: string;
  legacyEntryPresent?: boolean;
  legacyEntryPath?: string;
};

type SkillAssetIndexSnapshot = {
  protocol: string;
  generatedAt: string;
  items: Array<{
    id: string;
    displayName: string;
    sourceClass: string;
    state: string;
    risk: string;
    enabled: boolean;
    sourcePath: string;
    version: string;
    updatedAt: string;
    skillBody: null;
  }>;
};

type PanelState = {
  generatedAt: string;
  suite: {
    version: string;
    protocol: string;
    branch: string;
    commit: string;
    gitDirty: number;
    suiteRoot: string;
    skillDir: string;
  };
  services: ServiceItem[];
  nodes: NodeSnapshot;
  extensions: {
    total: number;
    enabled: number;
    disabled: number;
    missingSources: number;
    items: ExtensionItem[];
  };
  skillGovernance: SkillGovernancePanelState;
  promptSnapshots: PromptSnapshotPanelState;
  scheduledTasks: ScheduledTaskPanelState;
  mcp: {
    total: number;
    running: number;
    items: McpItem[];
    selectedId?: string;
    runtimeStatus: string;
    details: string;
  };
  release: {
    publishSummaryExists: boolean;
    releaseNotesExists: boolean;
    prepareMainReleaseExists: boolean;
    tagScriptExists: boolean;
    pendingChanges: string[];
  };
  liveSync: LiveSyncState;
  settings: SettingsState;
  history: {
    status: string;
    sessions: SessionItem[];
  };
  workflow: WorkflowStatus;
  memory: KnowledgeIndexStatus;
  memorySkillAssets: SkillAssetIndexSnapshot;
  memoryReminders: TodoReminderSnapshot;
  executors: ExecutorStatus;
  permissions: PermissionSnapshot;
  paths: {
    config: string;
    manifestDir: string;
    memoryRepo: string;
    logs: string;
  };
  activities: ActivityRecord[];
  diagnostics?: {
    webNavigationCount?: number;
    webStatePushCount?: number;
    sessionDetailRequestCount?: number;
  };
};

type HostResult = {
  id: string;
  type: 'result';
  ok: boolean;
  data?: unknown;
  error?: string;
};

type HostStateMessage = {
  type: 'state';
  data: PanelState;
};

type HostActivityMessage = {
  type: 'activity';
  level: string;
  title: string;
  message: string;
  timestamp: string;
};

declare global {
  interface Window {
    chrome?: {
      webview?: {
        postMessage: (message: unknown) => void;
        addEventListener: (event: 'message', callback: (event: MessageEvent) => void) => void;
      };
    };
  }
}

const pageIcons = {
  overview: Activity,
  services: Power,
  sessions: History,
  scheduledTasks: CalendarClock,
  architecture: Network,
  prompts: FileText,
  memory: Search,
  skills: Layers3,
  mcp: PlugZap,
  modelsPlugins: Bot,
  permissions: ShieldCheck,
  release: GitBranch,
  logs: Terminal,
  settings: Settings,
} as const;

const fallbackState: PanelState = {
  generatedAt: '-',
  suite: {
    version: 'loading',
    protocol: 'loading',
    branch: 'loading',
    commit: 'loading',
    gitDirty: 0,
    suiteRoot: '',
    skillDir: '',
  },
  services: [],
  nodes: { schema: 'codex-im-suite/control-plane-state/v1', generatedAt: '', activeNodeId: 'local', nodes: [] },
  extensions: { total: 0, enabled: 0, disabled: 0, missingSources: 0, items: [] },
  skillGovernance: { available: false, error: '', snapshot: null },
  promptSnapshots: {
    available: false,
    path: '',
    error: '',
    data: {
      protocol: 'cti-prompt-snapshot-store/v1',
      policy: { maxItems: 100, maxAgeDays: 7 },
      snapshots: [],
    },
  },
  scheduledTasks: { available: false, error: '计划任务状态尚未加载', status: {}, items: [] },
  mcp: { total: 0, running: 0, items: [], runtimeStatus: '', details: '' },
  release: { publishSummaryExists: false, releaseNotesExists: false, prepareMainReleaseExists: false, tagScriptExists: false, pendingChanges: [] },
  liveSync: { status: 'unavailable', lastSyncedAt: '', suiteCommit: '', liveCommit: '', summary: 'Live 同步状态不可用', canSync: false, detail: '' },
  settings: {
    defaultWorkDir: '',
    allowedRoots: '',
    memoryRepo: '',
    additionalDirs: '',
    replyStyleHint: '',
    defaultExecutorId: '',
    localAiKind: 'ollama',
    localAiBaseUrl: 'http://127.0.0.1:11434',
    ollamaModelsDir: '',
    localAiModel: 'qwen2.5-coder:7b',
    localAiApiKeyAction: 'keep',
    localAiApiKeyValue: '',
    localAiApiKeyMasked: '',
    localAiApiKeySet: false,
    localAiTimeoutMs: '45000',
    codexModelSource: 'official',
    codexRoutingMode: 'manual',
    codexApiFallbackChain: 'local_api,external_api',
    codexBaseUrl: '',
    codexModel: '',
    codexPassModel: false,
    codexReasoningEffort: 'low',
    memoryOptimizerEnabled: false,
    memoryOptimizerIntervalDays: '7',
    memoryOptimizerModelSource: 'codex_primary',
    codexApiKeyAction: 'keep',
    codexApiKeyValue: '',
    codexApiKeyMasked: '',
    codexApiKeySet: false,
  },
  history: { status: '', sessions: [] },
  workflow: { protocol: 'workflow-runtime/v1', updatedAt: '', runs: [] },
  memory: {
    schema: 'codex-im-suite/knowledge-index-status/v1',
    memoryRoot: '',
    indexPath: '',
    statusPath: '',
    memoryGraphPath: '',
    watching: false,
    exists: false,
    markdownFileCount: 0,
    itemCount: 0,
    conflictCount: 0,
    memoryGraphNodeCount: 0,
    memoryGraphEdgeCount: 0,
    memoryGraphPreview: { nodes: [], edges: [] },
    sourceFileCount: 0,
    kindCounts: {},
    recentReviewWarnings: [],
    generatedAt: '',
    lastIndexedAt: '',
    lastEventAt: '',
    watcherStartedAt: '',
    watcherPid: 0,
    statusUpdatedAt: '',
    lastError: '',
    optimization: {
      schema: 'codex-im-suite/memory-optimization-status/v1',
      memoryRoot: '',
      statePath: '',
      draftsDir: '',
      enabled: false,
      intervalDays: 7,
      modelSource: 'codex_primary',
      draftCount: 0,
      drafts: [],
    },
  },
  memorySkillAssets: { protocol: 'cti-memory-skill-asset-index/v1', generatedAt: '', items: [] },
  memoryReminders: {
    schema: 'codex-im-suite/reminders-panel/v1',
    memoryRoot: '',
    indexPath: '',
    statePath: '',
    exists: false,
    enabled: false,
    pollMs: 60000,
    windowMs: 300000,
    channels: ['feishu'],
    providers: [],
    counts: { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0, completed: 0 },
    items: [],
    lastError: '',
  },
  executors: { protocol: 'executor-runtime/v1', updatedAt: '', defaultExecutorId: '', executors: [], sessionDefaults: {} },
  permissions: { protocol: 'cti-permissions/v1', updatedAt: '', subjects: [], candidates: [] },
  paths: { config: '', manifestDir: '', memoryRepo: '', logs: '' },
  activities: [],
};

const themeStorageKey = 'codex-im-suite-control-panel-theme';
const controlApiTokenStorageKey = 'codex-im-suite-control-api-token';
const commandLabels: Record<string, string> = {
  'live.sync': 'Live 同步',
  'release.publishBackup': '一键发布',
  'release.prepareMainRelease': '主干发布预检',
  'history.recallBotMessage': '撤回消息',
  'scheduledTasks.pause': '暂停计划任务',
  'scheduledTasks.resume': '恢复计划任务',
  'scheduledTasks.runNow': '立即运行计划任务',
  'scheduledTasks.cancelRun': '取消计划任务运行',
  'scheduledTasks.delete': '删除计划任务',
  'scheduledTasks.retryDelivery': '重试计划任务投递',
};
const trackedCommands = new Set(Object.keys(commandLabels));

function confirmReleaseCommand(command: string): boolean {
  if (command === 'release.publishBackup') {
    return window.confirm('将执行一键发布：开发版 -> live skill 同步、构建、打包、git add/commit、git push。\n\n如果目标发布目录、live skill 或 portable/installer 里的 exe 正在运行，脚本会自动关闭这些目标目录内的进程后继续；若当前窗口来自被更新目录，窗口可能关闭。');
  }
  if (command === 'release.prepareMainRelease') {
    return window.confirm('将执行主干发布预检：扩展协议校验、架构文档检查、构建、打包和发布摘要生成。\n\n不会同步 live skill，不会自动 git commit、push 或打标签。如果目标发布目录、portable 或 installer 里的 exe 正在运行，脚本会自动关闭这些目标目录内的进程后继续。');
  }
  return true;
}

function getInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  const saved = window.localStorage.getItem(themeStorageKey);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getInitialPage(): PageId {
  if (typeof window === 'undefined') return 'overview';
  return resolvePageId(window.location.hash);
}

function getInitialServiceTab(): ServiceTabId {
  if (typeof window === 'undefined') return 'services';
  return resolveLegacyServiceTab(window.location.hash);
}

function createRequestId() {
  return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getControlApiToken() {
  if (typeof window === 'undefined') return '';
  const queryToken = new URLSearchParams(window.location.search).get('token') ?? '';
  if (queryToken) {
    window.localStorage.setItem(controlApiTokenStorageKey, queryToken);
    return queryToken;
  }
  return window.localStorage.getItem(controlApiTokenStorageKey) ?? '';
}

function buildApiUrl(path: string, token: string) {
  if (!token) return path;
  const url = new URL(path, window.location.origin);
  url.searchParams.set('token', token);
  return `${url.pathname}${url.search}`;
}

function splitPaths(value: string) {
  return value
    .split(/[;\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinPaths(values: string[]) {
  return values.filter(Boolean).join(';');
}

function isControlPanelWebViewHost() {
  if (typeof window === 'undefined') return false;
  return window.location.hostname === 'control-panel.local' && !!window.chrome?.webview;
}

function normalizeChatType(value: string) {
  return value.trim().toLowerCase();
}

function isPrivateSession(item: { chatType?: string; channelType?: string }) {
  const chatType = normalizeChatType(item.chatType ?? '');
  return chatType === 'p2p' || chatType === 'private' || chatType === 'single';
}

function isGroupSession(item: { chatType?: string; channelType?: string }) {
  const chatType = normalizeChatType(item.chatType ?? '');
  return chatType === 'group' || chatType === 'chat' || chatType === 'topic_group';
}

function getSessionTypeLabel(item: { chatType?: string; channelType?: string }) {
  if (isPrivateSession(item)) return '私聊';
  if (isGroupSession(item)) return '群聊';
  return item.channelType || '会话';
}

function formatSessionMessageCount(item: { localMessageCount?: number; remoteMessageCount?: number }) {
  const local = item.localMessageCount ?? 0;
  const remote = item.remoteMessageCount ?? 0;
  if (remote > 0 && local > 0 && remote !== local) return `远端 ${remote} 条 · 本地 ${local} 条`;
  if (remote > 0) return `远端 ${remote} 条`;
  return `${local} 条`;
}

function isLocalModelSourceActive(settings: SettingsState): boolean {
  const strategy = inferAiStrategy(settings);
  return strategy === 'local_api' || (strategy === 'auto_failover' && parseCodexChain(settings.codexApiFallbackChain).includes('local_api'));
}

function getSessionDisplayTitle(item: { displayName?: string; chatId?: string; sessionId?: string; chatType?: string; channelType?: string }) {
  const rawName = item.displayName?.trim();
  const fallback = rawName || item.chatId || item.sessionId || '未命名会话';
  if (isPrivateSession(item)) {
    if (!rawName || rawName === item.chatId) return '私聊';
    return `私聊 · ${rawName}`;
  }
  return fallback;
}

function roleLabel(role: PermissionRole | '') {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'operator':
      return 'Operator';
    case 'viewer':
      return 'Viewer';
    default:
      return '未授权';
  }
}

function roleStatus(role: PermissionRole | ''): StatusKind {
  switch (role) {
    case 'owner':
      return 'ok';
    case 'operator':
      return 'warning';
    case 'viewer':
      return 'idle';
    default:
      return 'idle';
  }
}

function channelLabel(channelType: string) {
  switch ((channelType || '').toLowerCase()) {
    case 'feishu':
      return '飞书';
    case 'telegram':
      return 'Telegram';
    case 'discord':
      return 'Discord';
    case 'qq':
      return 'QQ';
    case 'weixin':
      return '微信';
    default:
      return channelType || '未知渠道';
  }
}

function workflowStatusKind(run: WorkflowRun): StatusKind {
  if (run.status === 'succeeded') return 'ok';
  if (run.status === 'failed') return run.recovery?.kind === 'recoverable' ? 'warning' : 'error';
  if (run.status === 'retry_pending' || run.status === 'retrying') return 'warning';
  return 'warning';
}

function nodeStatusKind(status: NodeAgent['status'] | NodeCapability['status']): StatusKind {
  if (status === 'online') return 'ok';
  if (status === 'degraded') return 'warning';
  if (status === 'offline') return 'error';
  return 'idle';
}

function nodeStatusLabel(status: NodeAgent['status'] | NodeCapability['status']) {
  switch (status) {
    case 'online':
      return '在线';
    case 'degraded':
      return '降级';
    case 'offline':
      return '离线';
    default:
      return '未知';
  }
}

function nodeKindLabel(kind: NodeAgent['kind']) {
  switch (kind) {
    case 'local':
      return '本机';
    case 'remote':
      return '远端';
    case 'fake':
      return '模拟';
    default:
      return kind;
  }
}

function userStatusKind(status: UserFacingStatus): StatusKind {
  switch (status) {
    case 'normal':
      return 'ok';
    case 'attention':
      return 'warning';
    case 'disabled':
    default:
      return 'idle';
  }
}

function userStatusLabel(status: UserFacingStatus) {
  switch (status) {
    case 'normal':
      return '正常';
    case 'attention':
      return '需要处理';
    case 'disabled':
    default:
      return '未启用';
  }
}

function toUserStatus(status?: StatusKind, idleMeansDisabled = true): UserFacingStatus {
  if (status === 'ok') return 'normal';
  if (status === 'warning' || status === 'error') return 'attention';
  return idleMeansDisabled ? 'disabled' : 'attention';
}

function combineUserStatuses(statuses: UserFacingStatus[]): UserFacingStatus {
  if (statuses.some((status) => status === 'attention')) return 'attention';
  if (statuses.some((status) => status === 'normal')) return 'normal';
  return 'disabled';
}

function findService(state: PanelState, id: string) {
  return state.services.find((service) => service.id === id || service.title.toLowerCase().includes(id.toLowerCase()));
}

function runtimeAction(id: string, label: string, unitId: string, actionId: string, description?: string): BlueprintAction {
  return { id, label, kind: 'runtime', unitId, actionId, description };
}

function commandAction(id: string, label: string, command: string, description?: string): BlueprintAction {
  return { id, label, kind: 'command', command, description };
}

function navigateAction(id: string, label: string, targetPage: PageId, targetUnitId?: string, description?: string): BlueprintAction {
  return { id, label, kind: 'navigate', targetPage, targetUnitId, description };
}

function blueprintActionKey(action: BlueprintAction) {
  return `${action.kind}:${action.unitId ?? ''}:${action.actionId ?? ''}:${action.command ?? ''}:${action.targetPage ?? ''}:${action.targetUnitId ?? ''}`;
}

function buildSystemBlueprint(state: PanelState, runtimeUnits: RuntimeUnit[]): SystemBlueprintNode[] {
  const bridgeService = findService(state, 'bridge');
  const codexService = findService(state, 'codex');
  const localService = findService(state, 'localLlm');
  const localModelActive = isLocalModelSourceActive(state.settings);
  const bridgeStatus = toUserStatus(bridgeService?.status, false);
  const codexStatus = toUserStatus(codexService?.status, false);
  const localStatus = localModelActive ? toUserStatus(localService?.status) : 'disabled';
  const aiStatus = codexStatus === 'normal'
    ? 'normal'
    : localStatus === 'normal'
      ? 'attention'
      : combineUserStatuses([codexStatus, localStatus]);
  const mcpUnits = runtimeUnits.filter((unit) => unit.kind === 'mcp');
  const okMcpUnits = mcpUnits.filter((unit) => unit.status === 'ok');
  const mcpStatus: UserFacingStatus = mcpUnits.length > 0
    ? okMcpUnits.length === mcpUnits.length
      ? 'normal'
      : 'attention'
    : state.mcp.total <= 0
      ? 'disabled'
      : toUserStatus(findService(state, 'mcp')?.status, false);
  const memoryStatus: UserFacingStatus = state.memory.lastError
    ? 'attention'
    : state.memory.exists
      ? 'normal'
      : 'disabled';
  const reminderStatus: UserFacingStatus = state.memoryReminders.lastError
    ? 'attention'
    : state.memoryReminders.enabled || state.memoryReminders.directReminderPushEnabled
      ? 'normal'
      : 'disabled';
  const assistStatus = combineUserStatuses([mcpStatus, memoryStatus, reminderStatus]);
  const replyStatus = bridgeStatus === 'normal' && aiStatus !== 'disabled' ? 'normal' : 'attention';
  const activeExecutors = runtimeUnits.filter((unit) => unit.kind === 'tool' && unit.status === 'ok').length;
  const mcpAttentionUnits = mcpUnits
    .filter((unit) => unit.status !== 'ok')
    .slice(0, 3);
  const firstMcpUnitId = mcpAttentionUnits[0]?.unitId || runtimeUnits.find((unit) => unit.kind === 'mcp')?.unitId;
  const mcpRuntimeActions = mcpAttentionUnits.flatMap((unit) => [
    runtimeAction(`mcp-check-${unit.unitId}`, `检查 ${unit.displayName}`, unit.unitId, 'check', '查看这个 MCP 当前是否可用。'),
    runtimeAction(`mcp-start-${unit.unitId}`, unit.displayName.includes('Unity') ? `修复 ${unit.displayName}` : `启动 ${unit.displayName}`, unit.unitId, 'start', '尝试启动或修复这个 MCP。'),
  ]);

  return [
    {
      id: 'entry',
      title: '用户入口',
      detail: bridgeStatus === 'normal' ? '飞书消息可以进入桥接服务。' : '先检查飞书桥接是否在线。',
      status: bridgeStatus,
      helpText: '入口异常通常意味着飞书长连接或 Bridge 服务需要检查。',
      targetPage: 'services',
      targetUnitId: 'service.bridge',
      primaryAction: runtimeAction('entry-check-bridge', '检查入口', 'service.bridge', 'status', '检查 Bridge 是否能接收飞书消息。'),
      secondaryActions: [
        runtimeAction('entry-logs', '查看日志', 'service.bridge', 'logs', '打开最近 Bridge 日志。'),
        navigateAction('entry-open-service', '打开服务页', 'services', 'service.bridge', '查看完整 Bridge 操作。'),
      ],
    },
    {
      id: 'bridge',
      title: 'Bridge 收发',
      detail: bridgeService?.detail?.split('\n').find(Boolean) || '负责接收消息、判断权限并收口回复。',
      status: bridgeStatus,
      helpText: 'Bridge 是飞书收发的核心。需要处理时，优先查看状态和日志，再决定启动或重启。',
      targetPage: 'services',
      targetUnitId: 'service.bridge',
      primaryAction: bridgeStatus === 'normal'
        ? runtimeAction('bridge-status', '检查状态', 'service.bridge', 'status', '刷新 Bridge 状态。')
        : runtimeAction('bridge-start', '启动 Bridge', 'service.bridge', 'start', '启动 Bridge 服务。'),
      secondaryActions: [
        runtimeAction('bridge-restart', '重启 Bridge', 'service.bridge', 'restart', '重启后重新加载配置和运行时代码。'),
        runtimeAction('bridge-logs', '查看日志', 'service.bridge', 'logs', '查看最近 Bridge 日志。'),
        runtimeAction('bridge-location', '打开位置', 'service.bridge', 'openLocation', '打开 live skill 目录。'),
        navigateAction('bridge-open-service', '打开服务页', 'services', 'service.bridge', '查看完整 Bridge 操作。'),
      ],
    },
    {
      id: 'brain',
      title: 'AI 执行',
      detail: codexStatus === 'normal'
        ? `Codex agent 可用，${activeExecutors || 1} 个执行入口处于可用状态。`
        : localStatus === 'normal'
          ? 'Codex 需要检查；本地模型 API 可作为 Codex CLI 的模型来源或自动切换来源。'
          : localModelActive
            ? 'Codex 和本地模型 API 都需要检查。'
            : 'Codex 需要检查；当前未启用本地模型来源。',
      status: aiStatus,
      helpText: 'AI 执行负责把用户请求交给同一个 Codex agent；本地模型 API 和外部 API 只是可切换的模型来源。',
      targetPage: 'settings',
      targetUnitId: 'ai',
      primaryAction: runtimeAction('ai-check-codex', '检查 Codex', 'service.codex', 'check', '确认 Codex CLI 和路由状态。'),
      secondaryActions: [
        runtimeAction('ai-update-codex', '更新 Codex', 'service.codex', 'update', '仅在 Codex CLI 支持 npm 更新时可用。'),
        runtimeAction('ai-check-local', '检查本地模型', 'service.localLlm', 'check', '检查本地模型 API 是否可用。'),
        runtimeAction('ai-start-local', '启动本地模型', 'service.localLlm', 'start', '启动本地模型 API。'),
        navigateAction('ai-open-settings', '设置 AI', 'settings', 'ai', '调整 Codex 模型来源和自动切换链。'),
      ],
    },
    {
      id: 'assist',
      title: '辅助能力',
      detail: 'MCP 工具、记忆和提醒会按需参与，不直接抢答普通请求。',
      status: assistStatus,
      helpText: '辅助能力负责扩展工具、检索记忆和发送提醒；异常时可以分别处理。',
      targetPage: 'skills',
      targetUnitId: firstMcpUnitId,
      primaryAction: navigateAction('assist-open-extensions', '处理辅助能力', 'skills', firstMcpUnitId, '查看 MCP、Skill 和插件状态。'),
      secondaryActions: [
        commandAction('assist-refresh-state', '刷新状态', 'state.refresh', '刷新整个平台状态。'),
        navigateAction('assist-open-memory', '查看记忆', 'memory', 'memory', '打开记忆关系树。'),
        navigateAction('assist-open-settings', '打开设置', 'settings', 'paths', '检查记忆仓库和运行路径。'),
      ],
      children: [
        {
          id: 'mcp',
          title: 'MCP 工具',
          detail: mcpUnits.length > 0 ? `${okMcpUnits.length}/${mcpUnits.length} 个 MCP 可用` : '暂未配置 MCP 清单',
          status: mcpStatus,
          helpText: 'MCP 负责连接 Unity、Blender、图片等外部工具。需要处理时优先检查异常 MCP。',
          targetPage: 'mcp',
          targetUnitId: firstMcpUnitId,
          primaryAction: firstMcpUnitId
            ? runtimeAction('mcp-check-first', '检查 MCP', firstMcpUnitId, 'check', '检查选中的 MCP。')
            : navigateAction('mcp-open-extensions', '处理 MCP', 'mcp', undefined, '查看 MCP 清单。'),
          secondaryActions: [
            ...mcpRuntimeActions,
            firstMcpUnitId ? runtimeAction('mcp-register', '注册 MCP', firstMcpUnitId, 'register', '把 MCP 清单注册到 Codex。') : navigateAction('mcp-register-help', '查看 MCP', 'mcp'),
            navigateAction('mcp-open-extensions', '打开 MCP 页', 'mcp', firstMcpUnitId, '查看所有 MCP。'),
          ],
        },
        {
          id: 'memory',
          title: '记忆仓库',
          detail: state.memory.exists ? `${state.memory.itemCount ?? 0} 条记忆可检索` : '等待生成记忆索引',
          status: memoryStatus,
          helpText: '记忆仓库用于给 Codex 提供上下文；不存在索引时先检查仓库路径和监听状态。',
          targetPage: 'memory',
          targetUnitId: 'memory',
          primaryAction: commandAction('memory-refresh', '刷新记忆', 'memory.status', '重新读取记忆索引状态。'),
          secondaryActions: [
            navigateAction('memory-open-page', '查看记忆', 'memory', 'memory', '打开记忆关系树。'),
            navigateAction('memory-open-settings', '设置记忆仓库', 'settings', 'memoryRepo', '检查记忆仓库路径。'),
          ],
        },
        {
          id: 'reminder',
          title: '提醒',
          detail: state.memoryReminders.enabled || state.memoryReminders.directReminderPushEnabled
            ? `${state.memoryReminders.counts?.pending ?? 0} 条待发送`
            : '主动提醒未开启',
          status: reminderStatus,
          helpText: '提醒来自记忆待办和直接提醒请求；未启用时先查看记忆页和配置提示。',
          targetPage: 'memory',
          targetUnitId: 'reminders',
          primaryAction: commandAction('reminder-check', '检查提醒', 'memory.checkReminders', '刷新提醒状态。'),
          secondaryActions: [
            navigateAction('reminder-open-memory', '查看提醒', 'memory', 'reminders', '打开记忆页提醒区。'),
            navigateAction('reminder-open-settings', '打开设置', 'settings', 'memoryRepo', '检查记忆和提醒相关路径。'),
          ],
        },
      ],
    },
    {
      id: 'reply',
      title: '回复用户',
      detail: replyStatus === 'normal' ? '最终只发送用户可见结果。' : '回复链路依赖前面的桥接和执行状态。',
      status: replyStatus,
      helpText: '回复收口由 Bridge 统一处理。回复异常时先看 Bridge 状态和日志。',
      targetPage: 'services',
      targetUnitId: 'service.bridge',
      primaryAction: runtimeAction('reply-check-bridge', '检查回复链路', 'service.bridge', 'status', '确认 Bridge 是否正常。'),
      secondaryActions: [
        runtimeAction('reply-logs', '查看日志', 'service.bridge', 'logs', '查看最近出站和回复日志。'),
        navigateAction('reply-open-service', '打开服务页', 'services', 'service.bridge', '查看完整 Bridge 操作。'),
      ],
    },
  ];

  return [
    {
      id: 'entry',
      title: '用户入口',
      detail: bridgeStatus === 'normal' ? '飞书消息可以进入桥接服务。' : '先检查飞书桥接是否在线。',
      status: bridgeStatus,
    },
    {
      id: 'bridge',
      title: 'Bridge 收发',
      detail: bridgeService?.detail?.split('\n').find(Boolean) || '负责接收消息、判断权限并收口回复。',
      status: bridgeStatus,
    },
    {
      id: 'brain',
      title: 'AI 执行',
      detail: codexStatus === 'normal'
        ? `Codex agent 可用，${activeExecutors || 1} 个执行入口处于可用状态。`
        : localStatus === 'normal'
          ? 'Codex 需要检查；本地 API 可作为 Codex CLI 的模型来源或自动切换来源。'
          : 'Codex 和本地 API 都需要检查。',
      status: aiStatus,
    },
    {
      id: 'assist',
      title: '辅助能力',
      detail: 'MCP 工具、记忆和提醒会按需参与，不直接抢答普通请求。',
      status: assistStatus,
      children: [
        {
          id: 'mcp',
          title: 'MCP 工具',
          detail: state.mcp.total > 0 ? `${state.mcp.running}/${state.mcp.total} 个清单运行中` : '暂未配置 MCP 清单',
          status: mcpStatus,
        },
        {
          id: 'memory',
          title: '记忆仓库',
          detail: state.memory.exists ? `${state.memory.itemCount ?? 0} 条记忆可检索` : '等待生成记忆索引',
          status: memoryStatus,
        },
        {
          id: 'reminder',
          title: '提醒',
          detail: state.memoryReminders.enabled || state.memoryReminders.directReminderPushEnabled
            ? `${state.memoryReminders.counts?.pending ?? 0} 条待发送`
            : '主动提醒未开启',
          status: reminderStatus,
        },
      ],
    },
    {
      id: 'reply',
      title: '回复用户',
      detail: replyStatus === 'normal' ? '最终只发送用户可见结果。' : '回复链路依赖前面的桥接和执行状态。',
      status: replyStatus,
    },
  ];
}

function BlueprintIcon({ id }: { id: SystemBlueprintNode['id'] | string }) {
  const props = { size: 20, strokeWidth: 2 };
  switch (id) {
    case 'entry':
      return <MessageCircle {...props} />;
    case 'bridge':
      return <Network {...props} />;
    case 'brain':
      return <BrainCircuit {...props} />;
    case 'assist':
      return <PlugZap {...props} />;
    case 'reply':
      return <Send {...props} />;
    case 'memory':
      return <Database {...props} />;
    case 'reminder':
      return <Bell {...props} />;
    default:
      return <Activity {...props} />;
  }
}

function relationTypeLabel(type: string) {
  switch (type) {
    case 'maps_to':
      return '对应到';
    case 'reverse_lookup':
      return '可反查';
    case 'related_to':
      return '同一上下文';
    case 'conflicts_with':
      return '可能冲突';
    case 'mentions':
      return '提到';
    case 'alias_of':
      return '别名';
    default:
      return type || '相关';
  }
}

function memoryNodeKindLabel(kind: string) {
  switch (kind) {
    case 'path':
      return '路径';
    case 'command':
      return '命令';
    case 'scene':
      return '场景';
    case 'project':
      return '项目';
    case 'alias':
      return '别名';
    case 'knowledge':
      return '记忆';
    case 'entity':
      return '对象';
    default:
      return kind || '对象';
  }
}

function displayMemoryTitle(item?: KnowledgeSearchItem | null) {
  if (!item) return '选择一条记忆';
  if (item.key) return item.key;
  return (item.text || item.snippet || '未命名记忆').slice(0, 80);
}

function displayMemoryValue(item: KnowledgeSearchItem) {
  return item.value || item.text || item.snippet || '暂无内容';
}

function compactPathLabel(pathValue: string) {
  if (!pathValue) return '暂无来源文件';
  const parts = pathValue.split(/[\\/]+/).filter(Boolean);
  return parts.slice(-2).join('\\') || pathValue;
}

function buildMemoryRelationGroups(item: KnowledgeSearchItem | undefined, reminders: TodoReminderSnapshot): MemoryRelationGroup[] {
  if (!item) return [];
  const memoryText = `${item.key} ${item.value} ${item.text} ${item.snippet} ${item.sourcePath}`.toLowerCase();
  const relatedReminders = (reminders.items ?? []).filter((reminder) => {
    const reminderText = `${reminder.title} ${reminder.source?.snippet ?? ''} ${reminder.source?.path ?? ''}`.toLowerCase();
    return (!!item.sourcePath && reminder.source?.path === item.sourcePath)
      || (!!reminder.title && memoryText.includes(reminder.title.toLowerCase()))
      || (!!item.key && reminderText.includes(item.key.toLowerCase()));
  }).slice(0, 4);

  return [
    {
      id: 'value',
      title: '对应内容',
      status: 'normal',
      items: [{
        id: `${item.id}:value`,
        label: displayMemoryValue(item),
        detail: item.key ? `${item.key} 的记录值` : '这条记忆的正文内容',
        relation: item.key ? '对应到' : '记录为',
        status: 'normal',
      }],
    },
    {
      id: 'related',
      title: '相关对象',
      status: (item.related ?? []).length > 0 ? 'normal' : 'disabled',
      items: (item.related ?? []).slice(0, 6).map((related, index) => ({
        id: `${item.id}:related:${index}`,
        label: related.label,
        detail: memoryNodeKindLabel(related.kind),
        relation: relationTypeLabel(related.type),
        status: 'normal',
      })),
    },
    {
      id: 'reminders',
      title: '待办提醒',
      status: relatedReminders.length > 0 ? 'normal' : 'disabled',
      items: relatedReminders.map((reminder) => ({
        id: `${item.id}:reminder:${reminder.id}`,
        label: reminder.title || '未命名提醒',
        detail: reminder.dueAt || reminder.skipReason || '等待提醒时间',
        relation: reminder.sourceType === 'direct' ? '直接提醒' : '记忆待办',
        status: reminder.status === 'failed' ? 'attention' : reminder.status === 'completed' ? 'disabled' : 'normal',
      })),
    },
    {
      id: 'conflict',
      title: '可能冲突',
      status: item.conflict ? 'attention' : 'disabled',
      items: item.conflict
        ? [{
            id: `${item.id}:conflict`,
            label: '需要人工确认',
            detail: item.classificationReason || item.classificationSource || '这条记忆被标记为可能冲突。',
            relation: '可能冲突',
            status: 'attention',
          }]
        : [],
    },
    {
      id: 'source',
      title: '来源文件',
      status: item.sourcePath ? 'normal' : 'disabled',
      items: [{
        id: `${item.id}:source`,
        label: compactPathLabel(item.sourcePath),
        detail: item.sourceUpdatedAt || item.snippet || '可从来源文件继续追溯。',
        relation: '来自',
        status: item.sourcePath ? 'normal' : 'disabled',
      }],
    },
  ];
}

function workflowStatusLabel(run: WorkflowRun) {
  if (run.retry?.status === 'auto_pending') return '自动重试排队';
  if (run.retry?.status === 'manual_pending') return '手动重试排队';
  if (run.retry?.status === 'retrying') return '重试中';
  if (run.retry?.status === 'exhausted') return '重试耗尽';
  if (run.recovery?.kind === 'recoverable' && run.status === 'failed') return '可重试';
  if (run.recovery?.kind === 'not_recoverable') return '不可恢复';
  return run.stage || run.status;
}

function workflowModelLabel(run: WorkflowRun) {
  return run.execution?.model || '未知';
}

function workflowModelSourceLabel(run: WorkflowRun) {
  const executorName = run.execution?.executorName || run.executorId;
  const executorId = run.execution?.executorId || run.executorId;
  if (executorName && executorId && executorName !== executorId) return `${executorName} (${executorId})`;
  return executorName || executorId || run.execution?.provider || run.execution?.modelSource || '未知';
}

function formatWorkflowTimestamp(value?: string) {
  if (!value) return '未知';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function workflowDurationSummary(run: WorkflowRun) {
  const startedAt = Date.parse(run.startedAt || '');
  if (!Number.isFinite(startedAt)) return '未知';
  const endedAt = run.endedAt ? Date.parse(run.endedAt) : NaN;
  if (Number.isFinite(endedAt)) {
    return formatDuration(Math.max(1000, endedAt - startedAt));
  }
  return `进行中 ${formatDuration(Math.max(1000, Date.now() - startedAt))}`;
}

function formatWorkflowTokenPart(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '未知';
}

function workflowTokenSummary(run: WorkflowRun) {
  const usage = run.tokenUsage;
  if (!usage) return '未知';
  const input = typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)
    ? usage.input_tokens
    : undefined;
  const output = typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)
    ? usage.output_tokens
    : undefined;
  const total = typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens)
    ? usage.total_tokens
    : (input !== undefined || output !== undefined)
      ? (input || 0) + (output || 0)
      : undefined;
  if (total === undefined && input === undefined && output === undefined) return '未知';
  return `总 ${formatWorkflowTokenPart(total)}（入 ${formatWorkflowTokenPart(input)} / 出 ${formatWorkflowTokenPart(output)}）`;
}

function workflowCacheTokenSummary(run: WorkflowRun) {
  const usage = run.tokenUsage;
  if (!usage) return '';
  const cacheRead = typeof usage.cache_read_input_tokens === 'number' && Number.isFinite(usage.cache_read_input_tokens)
    ? usage.cache_read_input_tokens
    : 0;
  const cacheCreation = typeof usage.cache_creation_input_tokens === 'number' && Number.isFinite(usage.cache_creation_input_tokens)
    ? usage.cache_creation_input_tokens
    : 0;
  if (cacheRead <= 0 && cacheCreation <= 0) return '';
  return `读 ${cacheRead} / 写 ${cacheCreation}`;
}

function workflowEvidenceSummary(run: WorkflowRun) {
  const kind = run.execution?.requiredEvidenceKind;
  if (!kind || kind === 'none') return '证据：不要求';
  if (kind === 'input_evidence_required') {
    const accepted = run.execution?.acceptedInputEvidenceIds?.length || 0;
    const required = run.execution?.requiredInputEvidenceIds?.length || 0;
    const provider = run.execution?.inputEvidenceProvider ? `，Provider：${run.execution.inputEvidenceProvider}` : '';
    if (run.execution?.evidenceSatisfied === true) return `证据：输入已接收（${accepted}/${required}${provider}）`;
    if (run.execution?.noEvidenceRetryAttempted) return `证据：重试后输入仍未被 Provider 接收（${accepted}/${required}${provider}）`;
    return `证据：输入尚未被 Provider 接收（${accepted}/${required}${provider}）`;
  }
  if (run.execution?.evidenceSatisfied === true) return `证据：已满足（${kind}）`;
  if (run.execution?.noEvidenceRetryAttempted) return `证据：重试后仍缺少工具结果（${kind}）`;
  return `证据：缺少工具结果（${kind}）`;
}

function workflowEvidenceSummaryV2(run: WorkflowRun) {
  const kind = run.execution?.requiredEvidenceKind;
  if (kind === 'input_evidence_required') {
    const accepted = run.execution?.acceptedInputEvidenceIds?.length || 0;
    const required = run.execution?.requiredInputEvidenceIds?.length || 0;
    const kinds = run.execution?.acceptedInputEvidenceKinds?.join('、') || '无';
    const provider = run.execution?.inputEvidenceProvider || '未确认';
    if (run.execution?.evidenceSatisfied === true) {
      return `证据：结构化输入已接收（${accepted}/${required}，类型：${kinds}，Provider：${provider}）`;
    }
    if (run.execution?.noEvidenceRetryAttempted) {
      return `证据：重试后输入仍未接收（${accepted}/${required}，Provider：${provider}）`;
    }
    return `证据：等待 Provider 接收输入（${accepted}/${required}，Provider：${provider}）`;
  }
  const tool = run.execution?.executedTool || run.execution?.requestedTool;
  const counts = run.execution
    ? [
      typeof run.execution.successfulToolResultCount === 'number' ? `成功：${run.execution.successfulToolResultCount}` : '',
      typeof run.execution.toolResultCount === 'number' ? `结果：${run.execution.toolResultCount}` : '',
      typeof run.execution.toolUseCount === 'number' ? `调用：${run.execution.toolUseCount}` : '',
    ].filter(Boolean).join('，')
    : '';
  const shellSuffix = tool === 'shell' || tool === 'JsonTool:shell'
    ? [
      typeof run.execution?.shellExitCode === 'number' ? `exitCode：${run.execution.shellExitCode}` : '',
      typeof run.execution?.shellDurationMs === 'number' ? `耗时：${formatDuration(run.execution.shellDurationMs)}` : '',
    ].filter(Boolean).join('，')
    : '';
  const toolSuffix = tool || shellSuffix || counts
    ? `，${[tool ? `工具：${tool}` : '', counts, shellSuffix].filter(Boolean).join('，')}`
    : '';
  if (!kind || kind === 'none') return '证据：不要求';
  if (run.execution?.evidenceProtocol === 'json_tool_request' && run.execution?.evidenceSatisfied === true) {
    const fallback = run.execution?.jsonToolFallbackUsed ? '，runtime 保守补全' : '';
    return `证据：JSON 工具协议已满足（${kind}${toolSuffix}${fallback}）`;
  }
  if (run.execution?.evidenceSatisfied === true) return `证据：已满足（${kind}${toolSuffix}）`;
  if (run.execution?.jsonToolRetryAttempted) return `证据：JSON 工具协议重试后失败（${kind}${toolSuffix}）`;
  if (run.execution?.noEvidenceRetryAttempted) return `证据：重试后仍缺少工具结果（${kind}${toolSuffix}）`;
  return `证据：缺少工具结果（${kind}${toolSuffix}）`;
}

function canRetryWorkflow(run: WorkflowRun) {
  return !!run.recovery?.input?.prompt
    && run.status !== 'succeeded'
    && run.status !== 'retry_pending'
    && run.status !== 'retrying';
}

type WorkflowRunLink = {
  run: WorkflowRun;
  linkReason: 'message_id' | 'time_window';
};

type ConversationTimeline = {
  messageRuns: Map<string, WorkflowRunLink[]>;
  unlinkedRuns: WorkflowRunLink[];
};

function conversationMessageKey(message: ConversationMessage) {
  return message.messageId || `${message.index}-${message.createdAt}`;
}

function parseConversationTime(value?: string) {
  if (!value) return Number.NaN;
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) return direct;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const fallback = Date.parse(normalized);
  return Number.isFinite(fallback) ? fallback : Number.NaN;
}

function normalizeComparableText(value?: string) {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function shouldShowPlainMessageContent(message: ConversationMessage) {
  const content = normalizeComparableText(message.content);
  const cardContent = normalizeComparableText(message.cardContent);
  if (!content) return false;
  if (!cardContent) return true;
  return !content.includes(cardContent);
}

function textOverlapScore(left?: string, right?: string) {
  const a = normalizeComparableText(left);
  const b = normalizeComparableText(right);
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 40;
  const tokens = Array.from(new Set(a.split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length >= 2)));
  if (tokens.length === 0) return 0;
  const matched = tokens.filter((token) => b.includes(token)).length;
  return Math.min(30, Math.round((matched / tokens.length) * 30));
}

function workflowRunMessageId(run: WorkflowRun) {
  return run.recovery?.input?.messageId?.trim() || '';
}

function buildConversationTimeline(messages: ConversationMessage[], runs: WorkflowRun[] = []): ConversationTimeline {
  const byMessageId = new Map<string, ConversationMessage>();
  const chronologicalMessages = [...messages].sort((left, right) => {
    const leftTime = parseConversationTime(left.createdAt);
    const rightTime = parseConversationTime(right.createdAt);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    return left.index - right.index;
  });
  for (const message of chronologicalMessages) {
    if (message.messageId) byMessageId.set(message.messageId, message);
  }

  const messageRuns = new Map<string, WorkflowRunLink[]>();
  const unlinkedRuns: WorkflowRunLink[] = [];
  const addLink = (message: ConversationMessage, link: WorkflowRunLink) => {
    const key = conversationMessageKey(message);
    messageRuns.set(key, [...(messageRuns.get(key) ?? []), link]);
  };

  for (const run of runs) {
    const exactMessageId = workflowRunMessageId(run);
    const exactMessage = exactMessageId ? byMessageId.get(exactMessageId) : undefined;
    if (exactMessage) {
      addLink(exactMessage, { run, linkReason: 'message_id' });
      continue;
    }

    const runStartedAt = parseConversationTime(run.startedAt);
    if (!Number.isFinite(runStartedAt)) {
      unlinkedRuns.push({ run, linkReason: 'time_window' });
      continue;
    }

    let best: { message: ConversationMessage; score: number } | undefined;
    for (const message of chronologicalMessages) {
      const messageTime = parseConversationTime(message.createdAt);
      if (!Number.isFinite(messageTime)) continue;
      const distanceMs = runStartedAt - messageTime;
      if (distanceMs < -30_000 || distanceMs > 10 * 60_000) continue;
      const roleBonus = /user|human|member/i.test(message.role || message.senderType) ? 20 : 0;
      const proximityScore = Math.max(0, 30 - Math.floor(Math.abs(distanceMs) / 20_000));
      const score = proximityScore + roleBonus + textOverlapScore(run.promptPreview, message.content);
      if (!best || score > best.score) best = { message, score };
    }

    if (best && best.score >= 25) {
      addLink(best.message, { run, linkReason: 'time_window' });
    } else {
      unlinkedRuns.push({ run, linkReason: 'time_window' });
    }
  }

  for (const links of messageRuns.values()) {
    links.sort((left, right) => parseConversationTime(left.run.startedAt) - parseConversationTime(right.run.startedAt));
  }
  unlinkedRuns.sort((left, right) => parseConversationTime(right.run.startedAt) - parseConversationTime(left.run.startedAt));
  return { messageRuns, unlinkedRuns };
}

function permissionKey(item: { channelType: string; userId: string }) {
  return `${item.channelType.toLowerCase()}::${item.userId}`;
}

function needsRoleConfirm(currentRole: PermissionRole | '', nextRole: PermissionRole) {
  return currentRole !== nextRole && (currentRole === 'owner' || nextRole === 'owner' || currentRole === 'operator' || nextRole === 'operator');
}

function getRuntimeKindLabel(kind: string) {
  switch (kind) {
    case 'service':
      return '服务';
    case 'tool':
      return '工具';
    case 'mcp':
      return 'MCP';
    case 'skill':
      return 'Skill';
    case 'plugin':
      return 'Plugin';
    case 'extension':
      return '其他扩展';
    default:
      return kind || '未分类';
  }
}

function formatRuntimeVersion(version: string) {
  return version ? `v${version}` : '未标注版本';
}

function getCatalogLayerLabel(layer: string) {
  switch (layer) {
    case 'local':
      return '本机已安装';
    case 'seed':
      return '静态种子';
    case 'dynamic':
      return '动态排行';
    case 'custom_url':
      return '自定义 URL';
    default:
      return layer || '未知来源';
  }
}

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size <= 0) return '-';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function formatCommandResult(result: unknown) {
  if (result && typeof result === 'object' && 'message' in result) {
    return String((result as { message?: unknown }).message ?? '');
  }
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2);
}

function getRuntimeCategoryLabel(category: string) {
  return category || '未分类';
}

function normalizeDroppedPath(raw: string) {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('file:///')) {
    return decodeURIComponent(value.replace('file:///', '').replaceAll('/', '\\'));
  }
  return value.replace(/^"+|"+$/g, '');
}

function useHostBridge() {
  const [state, setState] = useState<PanelState>(fallbackState);
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [results] = useState(() => new Map<string, { command: string; resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>());
  const pageInstanceIdRef = useRef(createRequestId());
  const isWebViewHost = isControlPanelWebViewHost();
  const controlApiToken = useMemo(() => getControlApiToken(), []);
  const [debug, setDebug] = useState(() => ({
    stateMessageCount: 0,
    activityMessageCount: 0,
    sessionDetailRequestCount: 0,
    sessionDetailResultCount: 0,
  }));

  useEffect(() => {
    if (!isWebViewHost) {
      let disposed = false;
      const loadState = async () => {
        try {
          const response = await fetch(buildApiUrl('/api/state', controlApiToken), {
            cache: 'no-store',
            headers: controlApiToken ? { Authorization: `Bearer ${controlApiToken}` } : undefined,
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = (await response.json()) as PanelState;
          if (!disposed) {
            setDebug((current) => ({ ...current, stateMessageCount: current.stateMessageCount + 1 }));
            setState(data);
            setActivities(data.activities ?? []);
          }
        } catch (error) {
          if (!disposed) {
            setActivities((current) => [...current.slice(-220), {
              level: 'error',
              title: 'Control API',
              message: error instanceof Error ? error.message : '状态读取失败',
              timestamp: new Date().toLocaleTimeString(),
            }]);
          }
        }
      };
      void loadState();
      const events = new EventSource(buildApiUrl('/api/events', controlApiToken));
      events.addEventListener('state', (event) => {
        try {
          const message = JSON.parse((event as MessageEvent).data) as HostStateMessage;
          if (message.type === 'state') {
            setDebug((current) => ({ ...current, stateMessageCount: current.stateMessageCount + 1 }));
            setState(message.data);
            setActivities(message.data.activities ?? []);
          }
        } catch {
          // Ignore malformed event frames.
        }
      });
      events.onerror = () => {
        setActivities((current) => [...current.slice(-220), {
          level: 'warning',
          title: 'Control API',
          message: '事件流已断开，继续使用按需刷新。',
          timestamp: new Date().toLocaleTimeString(),
        }]);
      };
      return () => {
        disposed = true;
        events.close();
      };
    }
    window.chrome?.webview?.addEventListener('message', (event: MessageEvent) => {
      const message = event.data as HostResult | HostStateMessage | HostActivityMessage;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'state') {
        setDebug((current) => ({ ...current, stateMessageCount: current.stateMessageCount + 1 }));
        setState(message.data);
        setActivities(message.data.activities ?? []);
        return;
      }
      if (message.type === 'activity') {
        setDebug((current) => ({ ...current, activityMessageCount: current.activityMessageCount + 1 }));
        setActivities((current) => [...current.slice(-220), { level: message.level, title: message.title, message: message.message, timestamp: message.timestamp }]);
        return;
      }
      if (message.type === 'result') {
        const waiter = results.get(message.id);
        if (!waiter) return;
        results.delete(message.id);
        if (waiter.command === 'history.getSessionDetail') {
          setDebug((current) => ({ ...current, sessionDetailResultCount: current.sessionDetailResultCount + 1 }));
        }
        if (message.ok) waiter.resolve(message.data);
        else waiter.reject(new Error(message.error || '命令执行失败'));
      }
    });
  }, [controlApiToken, isWebViewHost, results]);

  const sendCommand = async (command: string, payload: Record<string, unknown> = {}) => {
    const id = createRequestId();
    setPending((current) => ({ ...current, [command]: true }));
    try {
      if (!isWebViewHost) {
        if (command === 'state.refresh') {
          const response = await fetch(buildApiUrl('/api/state', controlApiToken), {
            cache: 'no-store',
            headers: controlApiToken ? { Authorization: `Bearer ${controlApiToken}` } : undefined,
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = (await response.json()) as PanelState;
          setState(data);
          setActivities(data.activities ?? []);
          return data;
        }
        const response = await fetch(buildApiUrl('/api/commands', controlApiToken), {
          method: 'POST',
          headers: controlApiToken ? { 'Content-Type': 'application/json', Authorization: `Bearer ${controlApiToken}` } : { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, type: 'command', command, payload }),
        });
        const message = (await response.json()) as { ok: boolean; data?: unknown; error?: string };
        if (!response.ok || !message.ok) throw new Error(message.error || `HTTP ${response.status}`);
        if (command === 'history.getSessionDetail') {
          setDebug((current) => ({ ...current, sessionDetailResultCount: current.sessionDetailResultCount + 1 }));
        } else {
          void fetch(buildApiUrl('/api/state', controlApiToken), {
            cache: 'no-store',
            headers: controlApiToken ? { Authorization: `Bearer ${controlApiToken}` } : undefined,
          })
            .then((stateResponse) => stateResponse.ok ? stateResponse.json() : null)
            .then((nextState: PanelState | null) => {
              if (nextState) {
                setState(nextState);
                setActivities(nextState.activities ?? []);
              }
            })
            .catch(() => undefined);
        }
        return message.data;
      }
      return await new Promise((resolve, reject) => {
        results.set(id, { command, resolve, reject });
        if (command === 'history.getSessionDetail') {
          setDebug((current) => ({ ...current, sessionDetailRequestCount: current.sessionDetailRequestCount + 1 }));
        }
        if (!window.chrome?.webview) {
          results.delete(id);
          reject(new Error('当前不在 WebView2 宿主中运行'));
          return;
        }
        window.chrome.webview.postMessage({ id, type: 'command', command, payload });
      });
    } finally {
      setPending((current) => {
        const next = { ...current };
        delete next[command];
        return next;
      });
    }
  };

  const clearActivities = () => {
    setActivities([]);
    setState((current) => ({ ...current, activities: [] }));
  };

  return { state, activities, pending, sendCommand, clearActivities, debug, pageInstanceId: pageInstanceIdRef.current };
}

function App() {
  const { state, activities, pending, sendCommand, clearActivities, debug, pageInstanceId } = useHostBridge();
  const [page, setPage] = useState<PageId>(() => getInitialPage());
  const [serviceTab, setServiceTab] = useState<ServiceTabId>(() => getInitialServiceTab());
  const [theme, setTheme] = useState<ThemeMode>(() => getInitialTheme());
  const [runtimeUnits, setRuntimeUnits] = useState<RuntimeUnit[]>([]);
  const [replyPresets, setReplyPresets] = useState<ReplyPresetItem[]>([]);
  const [selectedServiceUnitId, setSelectedServiceUnitId] = useState('');
  const [selectedExtensionUnitId, setSelectedExtensionUnitId] = useState('');
  const [sessionQuery, setSessionQuery] = useState('');
  const [selectedSessionKey, setSelectedSessionKey] = useState('');
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionDrawerOpen, setSessionDrawerOpen] = useState(false);
  const [commandNotice, setCommandNotice] = useState<CommandNotice | null>(null);
  const [pageRefreshRevision, setPageRefreshRevision] = useState(0);
  const lastLoadedSessionKeyRef = useRef('');
  const sessionsRef = useRef<SessionItem[]>([]);
  const inFlightSessionKeyRef = useRef('');

  const runtimeServiceUnits = useMemo(
    () => runtimeUnits.filter((unit) => unit.kind === 'service' || unit.kind === 'tool'),
    [runtimeUnits],
  );
  const runtimeExtensionUnits = useMemo(
    () => runtimeUnits.filter((unit) => !['service', 'tool'].includes(unit.kind)),
    [runtimeUnits],
  );
  const runtimeMcpUnits = useMemo(
    () => runtimeExtensionUnits.filter((unit) => unit.kind === 'mcp'),
    [runtimeExtensionUnits],
  );
  const runtimeModelPluginUnits = useMemo(
    () => runtimeExtensionUnits.filter((unit) => unit.kind === 'model' || unit.kind === 'plugin'),
    [runtimeExtensionUnits],
  );
  const selectedServiceUnit = runtimeServiceUnits.find((unit) => unit.unitId === selectedServiceUnitId) ?? runtimeServiceUnits[0];
  const selectedExtensionUnit = runtimeExtensionUnits.find((unit) => unit.unitId === selectedExtensionUnitId) ?? runtimeExtensionUnits[0];
  const architectureBlueprint = useMemo(() => buildSystemBlueprint(state, runtimeUnits), [state, runtimeUnits]);

  const filteredSessions = useMemo(() => {
    const query = sessionQuery.trim().toLowerCase();
    if (!query) return state.history.sessions;
    return state.history.sessions.filter((item) =>
      `${item.displayName} ${item.chatId} ${item.sessionId} ${item.summary} ${item.source}`.toLowerCase().includes(query),
    );
  }, [sessionQuery, state.history.sessions]);

  async function loadRuntimeUnits() {
    const data = (await sendCommand('runtime.listUnits')) as RuntimeUnit[];
    setRuntimeUnits(Array.isArray(data) ? data : []);
  }

  async function loadReplyPresets() {
    const data = (await sendCommand('settings.listReplyPresets')) as ReplyPresetItem[];
    setReplyPresets(Array.isArray(data) ? data : []);
  }

  async function refreshPanelState() {
    await runPanelRefresh({
      refreshState: () => sendCommand('state.refresh'),
      refreshRuntimeUnits: loadRuntimeUnits,
      // 页面内部缓存（例如记忆搜索结果和表情包列表）需要显式收到刷新信号。
      invalidatePageData: () => setPageRefreshRevision((current) => current + 1),
    });
  }

  async function openSessionDetail(sessionKey: string, force = false) {
    const active = sessionsRef.current.find((item) => `${item.chatId}::${item.sessionId}` === sessionKey);
    if (!active) {
      setSessionDetail(null);
      setSessionError('未在当前会话列表中找到这条记录，请刷新会话列表后重试。');
      setSelectedSessionKey(sessionKey);
      return;
    }

    setSelectedSessionKey(sessionKey);
    setSessionDrawerOpen(true);
    setSessionError('');

    if (!force && lastLoadedSessionKeyRef.current === sessionKey && sessionDetail) {
      return;
    }
    if (!force && inFlightSessionKeyRef.current === sessionKey) {
      return;
    }

    inFlightSessionKeyRef.current = sessionKey;
    lastLoadedSessionKeyRef.current = sessionKey;
    if (!sessionDetail || selectedSessionKey !== sessionKey) {
      setSessionLoading(true);
    }
    try {
      const detail = await sendCommand('history.getSessionDetail', { chatId: active.chatId, sessionId: active.sessionId, force });
      setSessionDetail(detail as SessionDetail);
      setSessionError('');
    } catch (error) {
      setSessionDetail(null);
      setSessionError(error instanceof Error ? error.message : '会话详情加载失败。');
      lastLoadedSessionKeyRef.current = '';
    } finally {
      inFlightSessionKeyRef.current = '';
      setSessionLoading(false);
    }
  }

  async function deleteSelectedSession() {
    if (!sessionDetail) return;
    const title = getSessionDisplayTitle(sessionDetail);
    const confirmed = window.confirm(`删除会话“${title}”？\n\n这只会从本机面板隐藏当前会话；如果远端后续有新消息，重新同步后会再次出现。`);
    if (!confirmed) return;

    await sendCommand('history.deleteSession', { chatId: sessionDetail.chatId, sessionId: sessionDetail.sessionId });
    setSessionDetail(null);
    setSessionError('');
    setSelectedSessionKey('');
    setSessionDrawerOpen(false);
    lastLoadedSessionKeyRef.current = '';
    inFlightSessionKeyRef.current = '';
  }

  async function setSessionPersonRole(user: FeishuPerson, role: PermissionRole) {
    const label = user.displayName ? `${user.displayName} (${user.userId})` : user.userId;
    if (needsRoleConfirm(user.role, role)) {
      const confirmed = window.confirm(`把“${label}”设置为 ${roleLabel(role)}？\n\n这会修改权限库和兼容配置，并重启桥接后生效。`);
      if (!confirmed) return;
    }
    await sendCommand('permissions.upsert', {
      channelType: 'feishu',
      userId: user.userId,
      displayName: user.displayName,
      role,
      source: 'session-detail',
    });
    await sendCommand('permissions.applyAndRestart');
    if (sessionDetail) {
      await openSessionDetail(`${sessionDetail.chatId}::${sessionDetail.sessionId}`, true);
    }
    await sendCommand('state.refresh');
  }

  useEffect(() => {
    void sendCommand('state.refresh').catch(() => undefined);
    void loadRuntimeUnits().catch(() => undefined);
    void loadReplyPresets().catch(() => undefined);
  }, []);

  useEffect(() => {
    sessionsRef.current = state.history.sessions;
  }, [state.history.sessions]);

  useEffect(() => {
    if (!selectedServiceUnitId && runtimeServiceUnits.length > 0) {
      setSelectedServiceUnitId(runtimeServiceUnits[0].unitId);
    }
  }, [runtimeServiceUnits, selectedServiceUnitId]);

  useEffect(() => {
    if (!selectedExtensionUnitId && runtimeExtensionUnits.length > 0) {
      setSelectedExtensionUnitId(runtimeExtensionUnits[0].unitId);
    }
  }, [runtimeExtensionUnits, selectedExtensionUnitId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  useEffect(() => {
    const onHashChange = () => {
      setPage(getInitialPage());
      setServiceTab(getInitialServiceTab());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (window.location.hash !== `#${page}`) {
      window.history.replaceState(null, '', `#${page}`);
    }
  }, [page]);

  const run = async (command: string, payload: Record<string, unknown> = {}) => {
    const label = commandLabels[command] ?? command;
    const tracked = trackedCommands.has(command);
    const startedAt = Date.now();
    if (tracked) {
      setCommandNotice({
        command,
        label,
        status: 'running',
        message: `${label}正在执行，请不要重复点击。`,
        startedAt,
      });
    }
    try {
      const result = await sendCommand(command, payload);
      if (tracked) {
        setCommandNotice({
          command,
          label,
          status: 'success',
          message: `${label}已完成 · 用时 ${formatDuration(Date.now() - startedAt)}`,
          startedAt,
        });
      }
      return result;
    } catch (error) {
      if (tracked) {
        setCommandNotice({
          command,
          label,
          status: 'error',
          message: `${label}失败：${error instanceof Error ? error.message : String(error)}`,
          startedAt,
        });
      }
      throw error;
    }
  };

  const syncLive = async () => {
    const confirmed = window.confirm('将执行开发版 suite -> live skill 同步；不会提交、推送或打包。\n\n如果 live skill、portable 或相关发布目录里的 exe 正在运行，脚本会自动关闭这些目标目录内的进程后继续；若当前窗口来自被更新目录，窗口可能关闭。');
    if (!confirmed) return;
    await run('live.sync');
    await sendCommand('state.refresh');
    await loadRuntimeUnits();
  };

  const invokeRuntimeAction = async (unit: RuntimeUnit, action: RuntimeAction) => {
    await sendCommand('runtime.invokeAction', { unitId: unit.unitId, action: action.id });
    await sendCommand('state.refresh');
    await loadRuntimeUnits();
  };

  const navigateFromBlueprint = (targetPage: PageId, targetUnitId?: string) => {
    if (targetPage === 'services' && targetUnitId) {
      setSelectedServiceUnitId(targetUnitId);
    }
    if ((targetPage === 'skills' || targetPage === 'mcp' || targetPage === 'modelsPlugins') && targetUnitId) {
      setSelectedExtensionUnitId(targetUnitId);
    }
    setPage(targetPage);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">CI</div>
          <div>
            <div className="brand-title">Codex IM Suite</div>
            <div className="brand-meta">WebView2 Console</div>
          </div>
        </div>
        <nav className="nav-list">
          {panelNavigation.map((group) => (
            <section className="nav-group" key={group.id} aria-label={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.pages.map((pageId) => {
                const Icon = pageIcons[pageId];
                const label = panelPageMeta[pageId].label;
                return (
                  <button key={pageId} className={page === pageId ? 'nav-item active' : 'nav-item'} onClick={() => setPage(pageId)} title={label}>
                    <Icon size={17} />
                    <span>{label}</span>
                  </button>
                );
              })}
            </section>
          ))}
        </nav>
        <div className="sidebar-footer">
          <StatusPill status={state.suite.gitDirty > 0 ? 'warning' : 'ok'} label={state.suite.gitDirty > 0 ? `${state.suite.gitDirty} 项待提交` : '工作区干净'} />
          <div className="micro-copy">{state.suite.branch} · {state.suite.commit}</div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <div className="eyebrow">Suite {state.suite.version} · 协议 {state.suite.protocol}</div>
            <h1>{panelPageMeta[page].label}</h1>
            <LiveSyncBanner liveSync={state.liveSync} pending={pending['live.sync']} onSync={() => void syncLive()} />
          </div>
          <div className="topbar-actions">
            <button className="theme-button" title="切换白天 / 夜晚模式" onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? <SunMedium size={16} /> : <MoonStar size={16} />}
              <span>{theme === 'dark' ? '夜间' : '白天'}</span>
            </button>
            <button className="icon-button" title="刷新状态" onClick={() => void refreshPanelState()} disabled={pending['state.refresh']}>
              <RefreshCw size={16} className={pending['state.refresh'] ? 'spin' : ''} />
            </button>
            <button
              className="theme-button"
              title="重启控制面板"
              onClick={() => {
                if (window.confirm('重启控制面板？\n\n新面板启动后，当前窗口会自动关闭。')) {
                  void run('panel.restart');
                }
              }}
              disabled={pending['panel.restart']}
            >
              <RotateCw size={16} className={pending['panel.restart'] ? 'spin' : ''} />
              <span>重启面板</span>
            </button>
            <button className="primary-button" onClick={() => {
              if (confirmReleaseCommand('release.publishBackup')) {
                void run('release.publishBackup').then(loadRuntimeUnits).catch(() => undefined);
              }
            }} disabled={pending['release.publishBackup']}>
              <Rocket size={16} className={pending['release.publishBackup'] ? 'spin' : ''} />
              一键发布
            </button>
            <button className="primary-button" onClick={() => {
              if (confirmReleaseCommand('release.prepareMainRelease')) {
                void run('release.prepareMainRelease').then(loadRuntimeUnits).catch(() => undefined);
              }
            }} disabled={pending['release.prepareMainRelease']}>
              <ListChecks size={16} className={pending['release.prepareMainRelease'] ? 'spin' : ''} />
              主干发布预检
            </button>
          </div>
        </header>
        {commandNotice && <CommandStatusBanner notice={commandNotice} onDismiss={() => setCommandNotice(null)} />}

        {page === 'overview' && (
          <OverviewPage
            state={state}
            runtimeUnits={runtimeUnits}
            activities={activities}
            openLogs={() => setPage('logs')}
            refresh={() => void refreshPanelState()}
            refreshPending={pending['state.refresh']}
            run={run}
            invokeAction={invokeRuntimeAction}
            navigate={navigateFromBlueprint}
            pending={pending}
          />
        )}
        {page === 'services' && (
          <ServiceWorkspacePage
            activeTab={serviceTab}
            setActiveTab={setServiceTab}
            state={state}
            run={run}
            units={runtimeServiceUnits}
            selectedUnitId={selectedServiceUnit?.unitId ?? ''}
            setSelectedUnitId={setSelectedServiceUnitId}
            invokeAction={invokeRuntimeAction}
            pending={pending}
          />
        )}
        {page === 'scheduledTasks' && (
          <ScheduledTasksPage
            state={state.scheduledTasks}
            run={run}
            refresh={async () => { await run('state.refresh'); }}
            pending={pending}
          />
        )}
        {page === 'architecture' && <ArchitecturePage blueprint={architectureBlueprint} />}
        {page === 'prompts' && (
          <PromptPage
            state={state.promptSnapshots}
            refresh={async () => { await run('state.refresh'); }}
            openPath={async (path) => { await run('path.openAny', { path }); }}
          />
        )}
        {page === 'permissions' && <PermissionsPage state={state} run={run} pending={pending} />}
        {page === 'skills' && (
          <SkillsPage
            governance={state.skillGovernance}
            run={run}
            refresh={async () => {
              await sendCommand('state.refresh');
              await loadRuntimeUnits();
            }}
            pending={pending}
          />
        )}
        {page === 'mcp' && (
          <McpPage>
            <ExtensionsPage
              mode="mcp"
              state={state}
              units={runtimeMcpUnits}
              selectedUnitId={selectedExtensionUnit?.unitId ?? ''}
              setSelectedUnitId={setSelectedExtensionUnitId}
              invokeAction={invokeRuntimeAction}
              run={run}
              refreshUnits={loadRuntimeUnits}
              pending={pending}
            />
          </McpPage>
        )}
        {page === 'modelsPlugins' && (
          <ModelsPluginsPage>
            <ExtensionsPage
              mode="models_plugins"
              state={state}
              units={runtimeModelPluginUnits}
              selectedUnitId={selectedExtensionUnit?.unitId ?? ''}
              setSelectedUnitId={setSelectedExtensionUnitId}
              invokeAction={invokeRuntimeAction}
              run={run}
              refreshUnits={loadRuntimeUnits}
              pending={pending}
            />
          </ModelsPluginsPage>
        )}
        {page === 'release' && <ReleasePage state={state} run={run} pending={pending} />}
        {page === 'sessions' && (
          <SessionsPage
            state={state}
            run={run}
            pending={pending}
            debug={debug}
            pageInstanceId={pageInstanceId}
            query={sessionQuery}
            setQuery={setSessionQuery}
            sessions={filteredSessions}
            selectedSessionKey={selectedSessionKey}
            openSessionDetail={openSessionDetail}
            detail={sessionDetail}
            detailError={sessionError}
            detailLoading={sessionLoading}
            drawerOpen={sessionDrawerOpen}
            setDrawerOpen={setSessionDrawerOpen}
            deleteSession={deleteSelectedSession}
            setSessionPersonRole={setSessionPersonRole}
          />
        )}
        {page === 'memory' && <MemoryPage state={state} run={run} pending={pending} refreshRevision={pageRefreshRevision} />}
        {page === 'settings' && (
          <SettingsPage
            state={state}
            run={run}
            pending={pending}
            presets={replyPresets}
            reloadPresets={() => void loadReplyPresets()}
          />
        )}
        {page === 'logs' && <LogsPage activities={activities} clearActivities={clearActivities} />}
      </main>
    </div>
  );
}

type PageProps = {
  state: PanelState;
  run: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  pending: Record<string, boolean>;
};

function OverviewPage({
  state,
  runtimeUnits,
  activities,
  openLogs,
  refresh,
  refreshPending,
  run,
  invokeAction,
  navigate,
  pending,
}: {
  state: PanelState;
  runtimeUnits: RuntimeUnit[];
  activities: ActivityRecord[];
  openLogs: () => void;
  refresh: () => void;
  refreshPending?: boolean;
  run: PageProps['run'];
  invokeAction: (unit: RuntimeUnit, action: RuntimeAction) => Promise<void>;
  navigate: (targetPage: PageId, targetUnitId?: string) => void;
  pending: Record<string, boolean>;
}) {
  const headlineUnits = runtimeUnits.filter((unit) => ['service', 'tool', 'mcp'].includes(unit.kind)).slice(0, 6);
  const systemBlueprint = useMemo(() => buildSystemBlueprint(state, runtimeUnits), [state, runtimeUnits]);
  const [selectedBlueprintNodeId, setSelectedBlueprintNodeId] = useState<string>(systemBlueprint[0]?.id ?? '');
  const blueprintNodes = useMemo(() => flattenBlueprintNodes(systemBlueprint), [systemBlueprint]);
  const selectedBlueprintNode = blueprintNodes.find((node) => node.id === selectedBlueprintNodeId) ?? blueprintNodes[0];

  useEffect(() => {
    if (!blueprintNodes.length) return;
    if (!blueprintNodes.some((node) => node.id === selectedBlueprintNodeId)) {
      setSelectedBlueprintNodeId(blueprintNodes[0].id);
    }
  }, [blueprintNodes, selectedBlueprintNodeId]);

  const runBlueprintAction = async (action: BlueprintAction) => {
    if (action.kind === 'navigate' && action.targetPage) {
      navigate(action.targetPage, action.targetUnitId);
      return;
    }
    if (action.kind === 'command' && action.command) {
      await run(action.command);
      refresh();
      return;
    }
    if (action.kind === 'runtime' && action.unitId && action.actionId) {
      const unit = runtimeUnits.find((item) => item.unitId === action.unitId);
      const runtime = unit?.actions.find((item) => item.id === action.actionId);
      if (unit && runtime && runtime.enabled) {
        await invokeAction(unit, runtime);
      }
    }
  };

  return (
    <section className="page-grid overview-grid">
      <section className="panel panel-hero">
        <div className="section-header">
          <div>
            <div className="eyebrow">运营控制台</div>
            <h2>桥接、扩展、发布和会话运维集中在一个界面。</h2>
          </div>
          <MiniButton label="刷新" icon={<RefreshCw size={14} />} onClick={refresh} pending={refreshPending} />
        </div>
        <div className="summary-grid wide">
          <SummaryFact label="Suite" value={state.suite.version} />
          <SummaryFact label="分支" value={state.suite.branch || 'loading'} />
          <SummaryFact label="Commit" value={state.suite.commit || 'loading'} />
          <SummaryFact label="协议" value={state.suite.protocol || 'loading'} />
          <SummaryFact label="MCP 运行" value={`${state.mcp.running}/${state.mcp.total}`} />
          <SummaryFact label="会话索引" value={`${state.history.sessions.length}`} />
        </div>
      </section>
      <section className="panel panel-span-2">
        <SectionHeader title="系统蓝图" />
        <p className="panel-intro">这张图按普通用户路径展示一次请求如何流转，专业诊断细节仍保留在各功能页。</p>
        <div className="blueprint-board">
          <div className="blueprint-stream">
            <InteractiveSystemBlueprint
              nodes={systemBlueprint}
              selectedNodeId={selectedBlueprintNode?.id ?? ''}
              onSelect={setSelectedBlueprintNodeId}
            />
          </div>
          {selectedBlueprintNode && (
            <BlueprintActionPanel
              node={selectedBlueprintNode}
              runtimeUnits={runtimeUnits}
              onRunAction={(action) => void runBlueprintAction(action)}
              onNavigate={navigate}
              pending={pending}
            />
          )}
        </div>
      </section>
      <section className="metric-strip">
        <Metric label="扩展启用" value={`${state.extensions.enabled}/${state.extensions.total}`} />
        <Metric label="缺失依赖" value={`${state.extensions.missingSources}`} />
        <Metric label="待提交" value={`${state.suite.gitDirty}`} />
        <Metric label="最近刷新" value={state.generatedAt || '-'} compact />
      </section>
      <section className="panel panel-span-2">
        <SectionHeader title="关键运行单元" />
        <div className="runtime-grid compact">
          {headlineUnits.map((unit) => (
            <RuntimeTile key={unit.unitId} unit={unit} />
          ))}
        </div>
      </section>
      <section className="panel">
        <SectionHeader title="发布门禁" />
        <div className="release-gates">
          <GateItem label="发布摘要" ok={state.release.publishSummaryExists} />
          <GateItem label="发布历史" ok={state.release.releaseNotesExists} />
          <GateItem label="预检脚本" ok={state.release.prepareMainReleaseExists} />
          <GateItem label="标签脚本" ok={state.release.tagScriptExists} />
        </div>
      </section>
      <section className="panel">
        <SectionHeader title="最近活动" action={<MiniButton label="日志" icon={<Logs size={14} />} onClick={openLogs} />} />
        <ActivityList activities={activities.slice(-8)} compact />
      </section>
    </section>
  );
}

function flattenBlueprintNodes(nodes: SystemBlueprintNode[]): BlueprintNodeView[] {
  return nodes.flatMap((node) => [
    { ...node, children: undefined },
    ...(node.children ?? []).map((child) => ({ ...child, parentTitle: node.title })),
  ]);
}

function resolveBlueprintAction(action: BlueprintAction, runtimeUnits: RuntimeUnit[]): { enabled: boolean; reason?: string } {
  if (action.kind === 'navigate' || action.kind === 'command') return { enabled: true };
  const unit = runtimeUnits.find((item) => item.unitId === action.unitId);
  if (!unit) return { enabled: false, reason: '暂未找到对应运行单元' };
  const runtime = unit.actions.find((item) => item.id === action.actionId);
  if (!runtime) return { enabled: false, reason: '当前运行单元没有这个操作' };
  return { enabled: runtime.enabled, reason: runtime.enabled ? undefined : '当前状态下不可用' };
}

function uniqueBlueprintActions(actions: BlueprintAction[]) {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = blueprintActionKey(action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type BlueprintActionBucket = 'jump' | 'refresh' | 'process';

function classifyBlueprintAction(action: BlueprintAction): BlueprintActionBucket {
  if (action.kind === 'navigate') return 'jump';
  const token = `${action.label} ${action.actionId ?? ''} ${action.command ?? ''} ${action.description ?? ''}`.toLowerCase();
  if (action.actionId === 'openLocation') return 'jump';
  if (/(check|status|refresh|reload|sync|update)/.test(token)) return 'refresh';
  return 'process';
}

function blueprintBucketLabel(bucket: BlueprintActionBucket) {
  if (bucket === 'jump') return '跳转';
  if (bucket === 'refresh') return '刷新';
  return '处理';
}

function InteractiveSystemBlueprint({
  nodes,
  selectedNodeId,
  onSelect,
}: {
  nodes: SystemBlueprintNode[];
  selectedNodeId: string;
  onSelect: (nodeId: string) => void;
}) {
  return (
    <div className="system-blueprint" aria-label="系统蓝图">
      {nodes.map((node, index) => (
        <React.Fragment key={node.id}>
          <article className={`blueprint-node ${node.status} ${selectedNodeId === node.id ? 'active' : ''}`}>
            <button className="blueprint-node-button" onClick={() => onSelect(node.id)} aria-pressed={selectedNodeId === node.id}>
              <div className="blueprint-node-head">
                <span className="blueprint-icon"><BlueprintIcon id={node.id} /></span>
                <StatusPill status={userStatusKind(node.status)} label={userStatusLabel(node.status)} />
              </div>
              <strong>{node.title}</strong>
              <p>{node.detail}</p>
              <span className="blueprint-action-hint">点击处理</span>
            </button>
            {node.children && node.children.length > 0 && (
              <div className="blueprint-children">
                {node.children.map((child) => (
                  <button
                    key={child.id}
                    className={`blueprint-child ${child.status} ${selectedNodeId === child.id ? 'active' : ''}`}
                    onClick={() => onSelect(child.id)}
                    aria-pressed={selectedNodeId === child.id}
                  >
                    <span><BlueprintIcon id={child.id} /></span>
                    <div>
                      <strong>{child.title}</strong>
                      <p>{child.detail}</p>
                    </div>
                    <StatusPill status={userStatusKind(child.status)} label={userStatusLabel(child.status)} />
                  </button>
                ))}
              </div>
            )}
          </article>
          {index < nodes.length - 1 && <div className="blueprint-connector" aria-hidden="true" />}
        </React.Fragment>
      ))}
    </div>
  );
}

function BlueprintActionPanel({
  node,
  runtimeUnits,
  onRunAction,
  onNavigate,
  pending,
}: {
  node: BlueprintNodeView;
  runtimeUnits: RuntimeUnit[];
  onRunAction: (action: BlueprintAction) => void;
  onNavigate: (targetPage: PageId, targetUnitId?: string) => void;
  pending: Record<string, boolean>;
}) {
  const primaryKey = node.primaryAction ? blueprintActionKey(node.primaryAction) : '';
  const busy = pending['runtime.invokeAction'] || pending['state.refresh'] || pending['memory.status'] || pending['memory.checkReminders'];
  const secondaryActions = uniqueBlueprintActions(node.secondaryActions ?? []).filter((action) => blueprintActionKey(action) !== primaryKey);
  const groupedActions = secondaryActions.reduce<Record<BlueprintActionBucket, BlueprintAction[]>>(
    (groups, action) => {
      const bucket = classifyBlueprintAction(action);
      groups[bucket].push(action);
      return groups;
    },
    { jump: [], refresh: [], process: [] },
  );

  return (
    <aside className={`blueprint-action-panel ${node.status}`}>
      <div className="blueprint-action-copy">
        <span>{node.parentTitle ? `${node.parentTitle} / ${node.title}` : node.title}</span>
        <strong>{userStatusLabel(node.status)}</strong>
        <p>{node.helpText || node.detail}</p>
      </div>
      <div className="blueprint-action-stack">
        {node.primaryAction && (() => {
          const resolved = resolveBlueprintAction(node.primaryAction, runtimeUnits);
          return (
            <div className="blueprint-primary-action">
              <MiniButton
                label={node.primaryAction.label}
                icon={actionIcon(node.primaryAction.kind === 'navigate' ? 'openLocation' : node.primaryAction.actionId || node.primaryAction.command || node.primaryAction.id)}
                onClick={() => onRunAction(node.primaryAction!)}
                pending={busy}
                disabled={!resolved.enabled}
                title={resolved.reason ? `${node.primaryAction.label}：${resolved.reason}` : node.primaryAction.label}
              />
              {resolved.reason && <small>{resolved.reason}</small>}
            </div>
          );
        })()}
        <div className="blueprint-action-groups">
          {(['jump', 'refresh', 'process'] as BlueprintActionBucket[]).map((bucket) => {
            const actions = groupedActions[bucket];
            if (actions.length === 0) return null;
            return (
              <div key={bucket} className="blueprint-action-group">
                <span>{blueprintBucketLabel(bucket)}</span>
                <div className="blueprint-action-buttons">
                  {actions.map((action) => {
                    const resolved = resolveBlueprintAction(action, runtimeUnits);
                    return (
                      <MiniButton
                        key={action.id}
                        label={action.label}
                        icon={actionIcon(action.kind === 'navigate' ? 'openLocation' : action.actionId || action.command || action.id)}
                        onClick={() => onRunAction(action)}
                        pending={busy && action.kind !== 'navigate'}
                        disabled={!resolved.enabled}
                        title={resolved.reason ? `${action.label}：${resolved.reason}` : action.label}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {node.targetPage && (
          <MiniButton
            label="查看详情"
            icon={<ExternalLink size={14} />}
            onClick={() => onNavigate(node.targetPage!, node.targetUnitId)}
          />
        )}
      </div>
    </aside>
  );
}

function SystemBlueprint({ nodes }: { nodes: SystemBlueprintNode[] }) {
  return (
    <div className="system-blueprint" aria-label="系统蓝图">
      {nodes.map((node, index) => (
        <React.Fragment key={node.id}>
          <article className={`blueprint-node ${node.status}`}>
            <div className="blueprint-node-head">
              <span className="blueprint-icon"><BlueprintIcon id={node.id} /></span>
              <StatusPill status={userStatusKind(node.status)} label={userStatusLabel(node.status)} />
            </div>
            <strong>{node.title}</strong>
            <p>{node.detail}</p>
            {node.children && node.children.length > 0 && (
              <div className="blueprint-children">
                {node.children.map((child) => (
                  <div key={child.id} className={`blueprint-child ${child.status}`}>
                    <span><BlueprintIcon id={child.id} /></span>
                    <div>
                      <strong>{child.title}</strong>
                      <p>{child.detail}</p>
                    </div>
                    <StatusPill status={userStatusKind(child.status)} label={userStatusLabel(child.status)} />
                  </div>
                ))}
              </div>
            )}
          </article>
          {index < nodes.length - 1 && <div className="blueprint-connector" aria-hidden="true" />}
        </React.Fragment>
      ))}
    </div>
  );
}

function ServiceWorkspacePage({
  activeTab,
  setActiveTab,
  state,
  run,
  units,
  selectedUnitId,
  setSelectedUnitId,
  invokeAction,
  pending,
}: {
  activeTab: ServiceTabId;
  setActiveTab: (value: ServiceTabId) => void;
  state: PanelState;
  run: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  units: RuntimeUnit[];
  selectedUnitId: string;
  setSelectedUnitId: (value: string) => void;
  invokeAction: (unit: RuntimeUnit, action: RuntimeAction) => Promise<void>;
  pending: Record<string, boolean>;
}) {
  const tabs: Array<{ id: ServiceTabId; label: string }> = [
    { id: 'services', label: '服务' },
    { id: 'nodes', label: '节点' },
    { id: 'executors', label: '执行器' },
  ];
  return (
    <section className="content-stack">
      <nav className="domain-tabs" aria-label="服务分区">
        {tabs.map((tab) => (
          <button key={tab.id} type="button" className={activeTab === tab.id ? 'domain-tab active' : 'domain-tab'} onClick={() => setActiveTab(tab.id)}>
            {tab.label}
          </button>
        ))}
      </nav>
      {activeTab === 'services' && (
        <ServicesPage
          units={units}
          selectedUnitId={selectedUnitId}
          setSelectedUnitId={setSelectedUnitId}
          invokeAction={invokeAction}
          pending={pending}
        />
      )}
      {activeTab === 'nodes' && <NodesPage state={state} run={run} pending={pending} />}
      {activeTab === 'executors' && <ExecutorsPage state={state} run={run} pending={pending} />}
    </section>
  );
}

function ServicesPage({
  units,
  selectedUnitId,
  setSelectedUnitId,
  invokeAction,
  pending,
}: {
  units: RuntimeUnit[];
  selectedUnitId: string;
  setSelectedUnitId: (value: string) => void;
  invokeAction: (unit: RuntimeUnit, action: RuntimeAction) => Promise<void>;
  pending: Record<string, boolean>;
}) {
  const selected = units.find((unit) => unit.unitId === selectedUnitId) ?? units[0];
  return (
    <section className="services-layout">
      <section className="panel list-panel">
        <SectionHeader title="统一服务模块" />
        <div className="runtime-list">
          {units.map((unit) => (
            <button key={unit.unitId} className={selected?.unitId === unit.unitId ? 'runtime-row active' : 'runtime-row'} onClick={() => setSelectedUnitId(unit.unitId)}>
              <div>
                <strong>{unit.displayName}</strong>
                <span>{getRuntimeKindLabel(unit.kind)} · {getRuntimeCategoryLabel(unit.category)} · {formatRuntimeVersion(unit.version)} · {unit.installState || 'installed'}</span>
              </div>
              <StatusPill status={unit.status} label={runtimeStatusText(unit)} />
            </button>
          ))}
        </div>
      </section>
      <section className="panel">
        {selected ? (
          <>
            <SectionHeader title={selected.displayName} />
            <div className="detail-stack">
              <div className="detail-summary">
                <StatusPill status={selected.status} label={runtimeStatusText(selected)} />
                <div className="detail-meta">{getRuntimeKindLabel(selected.kind)} · {getRuntimeCategoryLabel(selected.category)} · {formatRuntimeVersion(selected.version)}</div>
              </div>
              <p className="detail-copy">{selected.description || selected.detail || '暂无说明。'}</p>
              <div className="command-band dense">
                {selected.actions.map((action) => (
                  <MiniButton
                    key={action.id}
                    label={action.label}
                    icon={actionIcon(action.id)}
                    onClick={() => void invokeAction(selected, action)}
                    pending={pending['runtime.invokeAction']}
                    disabled={!action.enabled}
                    title={!action.enabled ? (action.reason || `${action.label} 当前不可用`) : action.label}
                  />
                ))}
              </div>
              <dl className="kv">
                <dt>状态</dt><dd>{selected.detail || '-'}</dd>
                <dt>Source</dt><dd>{selected.source || '-'}</dd>
                <dt>CWD</dt><dd>{selected.cwd || '-'}</dd>
              </dl>
            </div>
          </>
        ) : (
          <EmptyState icon={<Power size={28} />} title="暂无服务模块" text="当前没有可呈现的运行单元。" />
        )}
      </section>
    </section>
  );
}

function NodesPage({ state, run, pending }: PageProps) {
  const nodes = state.nodes?.nodes ?? [];
  const [selectedNodeId, setSelectedNodeId] = useState(state.nodes?.activeNodeId || nodes[0]?.nodeId || '');
  const selected = nodes.find((node) => node.nodeId === selectedNodeId) ?? nodes[0];

  useEffect(() => {
    if (!nodes.length) return;
    if (!nodes.some((node) => node.nodeId === selectedNodeId)) {
      setSelectedNodeId(state.nodes.activeNodeId || nodes[0].nodeId);
    }
  }, [nodes, selectedNodeId, state.nodes.activeNodeId]);

  return (
    <section className="services-layout">
      <section className="panel list-panel">
        <SectionHeader
          title="运行节点"
          action={<MiniButton label="刷新" icon={<RefreshCw size={14} />} onClick={() => void run('state.refresh')} pending={pending['state.refresh']} />}
        />
        <div className="summary-grid">
          <SummaryFact label="节点数" value={`${nodes.length}`} compact />
          <SummaryFact label="活动节点" value={state.nodes?.activeNodeId || 'local'} compact />
        </div>
        <div className="runtime-list">
          {nodes.map((node) => (
            <button key={node.nodeId} className={selected?.nodeId === node.nodeId ? 'runtime-row active' : 'runtime-row'} onClick={() => setSelectedNodeId(node.nodeId)}>
              <div>
                <strong>{node.displayName}</strong>
                <span>{nodeKindLabel(node.kind)} · {node.host || node.nodeId}</span>
              </div>
              <StatusPill status={nodeStatusKind(node.status)} label={nodeStatusLabel(node.status)} />
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        {selected ? (
          <>
            <SectionHeader title={selected.displayName} />
            <div className="detail-stack">
              <div className="detail-summary">
                <StatusPill status={nodeStatusKind(selected.status)} label={nodeStatusLabel(selected.status)} />
                <div className="detail-meta">{nodeKindLabel(selected.kind)} · v{selected.version} · {selected.lastSeenAt || '未上报心跳'}</div>
              </div>
              <p className="detail-copy">{selected.detail}</p>
              <div className="summary-grid wide">
                <SummaryFact label="节点 ID" value={selected.nodeId} compact />
                <SummaryFact label="能力数" value={`${selected.capabilities.length}`} compact />
                <SummaryFact label="可管理" value={selected.canManage ? '是' : '否'} compact />
              </div>
              <SectionHeader title="能力清单" />
              <div className="runtime-list">
                {selected.capabilities.map((capability) => (
                  <div key={capability.id} className="runtime-row">
                    <div>
                      <strong>{capability.displayName}</strong>
                      <span>{capability.category} · risk={capability.risk}</span>
                      <p>{capability.detail}</p>
                    </div>
                    <StatusPill status={nodeStatusKind(capability.status)} label={nodeStatusLabel(capability.status)} />
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <EmptyState icon={<PlugZap size={30} />} title="没有节点" text="控制面还没有读到本机或远端 runtime 节点。" />
        )}
      </section>
    </section>
  );
}

function ExecutorsPage({ state, run, pending }: PageProps) {
  const executors = state.executors?.executors ?? [];
  const runs = state.workflow?.runs ?? [];
  const lastSelection = state.executors?.lastSelection;
  const recentRuns = runs.slice(-40).reverse();
  const [selectedExecutorId, setSelectedExecutorId] = useState('');
  const selectedExecutor = executors.find((executor) => executor.id === selectedExecutorId) ?? executors[0];
  const defaultExecutorId = (state.executors?.defaultExecutorId || state.settings.defaultExecutorId || '').trim();
  const defaultExecutor = executors.find((executor) => executor.id === defaultExecutorId);

  const saveDefaultExecutor = async (executorId: string) => {
    const result = await run('settings.saveAndRestartBridge', {
      settings: { ...state.settings, defaultExecutorId: executorId },
    });
    await run('state.refresh');
    return result;
  };

  useEffect(() => {
    if (executors.length === 0) {
      setSelectedExecutorId('');
      return;
    }
    const currentStillExists = executors.some((executor) => executor.id === selectedExecutorId);
    if (currentStillExists) return;
    const recentExecutor = executors.find((executor) => executor.id === lastSelection?.executorId);
    setSelectedExecutorId(recentExecutor?.id ?? executors[0].id);
  }, [executors, lastSelection?.executorId, selectedExecutorId]);

  return (
    <section className="content-stack executor-page">
      <section className="panel">
        <SectionHeader title="执行器目录" />
        <p className="detail-copy">执行器是请求路由候选，不是可启动或停止的服务。</p>
        <div className="summary-grid">
          <SummaryFact label="可用执行器" value={`${executors.filter((item) => item.enabled).length}/${executors.length}`} compact />
          <SummaryFact label="默认执行器" value={defaultExecutor?.displayName || defaultExecutorId || '自动'} compact />
          <SummaryFact label="最近选择" value={lastSelection?.executorId || '-'} compact />
          <SummaryFact label="Workflow" value={`${runs.length}`} compact />
          <SummaryFact label="协议" value={state.executors?.protocol || 'executor-runtime/v1'} compact />
        </div>
        <div className="command-band dense">
          <CommandButton label="刷新执行器" command="executor.check" icon={<RefreshCw size={16} />} run={run} pending={pending} />
        </div>
      </section>
      <section className="executor-main-layout">
        <section className="panel list-panel">
          <SectionHeader title="Executor Registry" />
          <div className="runtime-list">
            {executors.map((executor) => (
              <button key={executor.id} type="button" className={selectedExecutor?.id === executor.id ? 'runtime-row active' : 'runtime-row'} onClick={() => setSelectedExecutorId(executor.id)}>
                <div>
                  <strong>{executor.displayName}</strong>
                  <span>{executor.kind} · {executor.riskLevel} · priority {executor.priority}</span>
                </div>
                <div className="runtime-row-status">
                  {executor.id === defaultExecutorId && <StatusPill status="ok" label="默认" />}
                  <StatusPill status={executor.enabled ? 'ok' : 'idle'} label={executor.enabled ? '启用' : '停用'} />
                </div>
              </button>
            ))}
            {executors.length === 0 && <EmptyState icon={<Bot size={28} />} title="暂无执行器状态" text="bridge 运行一次后会写入 executor-status.json。" />}
          </div>
        </section>
        <section className="panel detail-panel">
          <SectionHeader title="能力与最近路由" />
          {selectedExecutor ? (
            <div className="detail-stack">
              <div className="runtime-tile-head">
                <strong>{selectedExecutor.displayName}</strong>
                <StatusPill status={selectedExecutor.enabled ? 'ok' : 'idle'} label={selectedExecutor.enabled ? '启用' : '停用'} />
              </div>
              <p className="detail-copy">{selectedExecutor.description || '暂无说明。'}</p>
              <div className="command-band dense executor-source-actions">
                <MiniButton
                  label={selectedExecutor.id === defaultExecutorId ? '当前默认' : '设为默认'}
                  icon={<CheckCircle2 size={14} />}
                  onClick={() => void saveDefaultExecutor(selectedExecutor.id)}
                  pending={pending['settings.saveAndRestartBridge']}
                  disabled={!selectedExecutor.enabled || selectedExecutor.id === defaultExecutorId}
                />
                <MiniButton
                  label="恢复自动"
                  icon={<X size={14} />}
                  onClick={() => void saveDefaultExecutor('')}
                  pending={pending['settings.saveAndRestartBridge']}
                  disabled={!defaultExecutorId}
                />
              </div>
              <dl className="kv">
                <dt>ID</dt><dd>{selectedExecutor.id}</dd>
                <dt>类型</dt><dd>{selectedExecutor.kind || '-'}</dd>
                <dt>风险</dt><dd>{selectedExecutor.riskLevel || '-'}</dd>
                <dt>优先级</dt><dd>{selectedExecutor.priority}</dd>
              </dl>
              <div className="tag-cloud">
                {(selectedExecutor.capabilities ?? []).map((capability) => (
                  <span key={`${selectedExecutor.id}:${capability}`} className="tag">{capability}</span>
                ))}
                {(selectedExecutor.capabilities ?? []).length === 0 && <span className="tag">暂无能力声明</span>}
              </div>
            </div>
          ) : (
            <EmptyState icon={<Bot size={28} />} title="暂无执行器详情" text="bridge 运行一次后会写入 executor-status.json。" />
          )}
          <div className="subsection-title">
            <Activity size={14} />
            <span>最近路由</span>
          </div>
          {lastSelection ? (
            <dl className="kv">
              <dt>Session</dt><dd>{lastSelection.sessionId}</dd>
              <dt>Executor</dt><dd>{lastSelection.executorId}</dd>
              <dt>原因</dt><dd>{lastSelection.reason}</dd>
              <dt>Fallback</dt><dd>{lastSelection.fallbackExecutorIds?.join(', ') || '-'}</dd>
            </dl>
          ) : (
            <p className="detail-copy">暂无路由选择记录。</p>
          )}
        </section>
      </section>
      <section className="panel executor-workflow-panel">
        <SectionHeader title={`最近 Workflow（${recentRuns.length}/${runs.length}）`} />
        <div className="runtime-list compact-list workflow-list">
          {recentRuns.map((runItem) => (
            <div key={runItem.id} className="runtime-row">
              <div>
                <strong>{runItem.promptPreview || runItem.id}</strong>
                <span>{runItem.stage} · {runItem.executorId || '未选择'} · {runItem.sessionId}</span>
                <span className="workflow-inline-summary">
                  模型：{workflowModelLabel(runItem)}　Token：{workflowTokenSummary(runItem)}　来源：{workflowModelSourceLabel(runItem)}
                </span>
                <span className="workflow-inline-summary">
                  开始：{formatWorkflowTimestamp(runItem.startedAt)}　耗时：{workflowDurationSummary(runItem)}
                </span>
                <span className="workflow-inline-summary">
                  {workflowEvidenceSummaryV2(runItem)}
                </span>
                {(runItem.recovery?.reason || runItem.retry?.lastError || runItem.error) && (
                  <p>{runItem.recovery?.reason || runItem.retry?.lastError || runItem.error}</p>
                )}
              </div>
              <div className="row-actions">
                <StatusPill status={workflowStatusKind(runItem)} label={workflowStatusLabel(runItem)} />
                <MiniButton
                  label="重试"
                  icon={<RotateCw size={14} />}
                  onClick={() => void run('workflow.retryRun', { id: runItem.id }).then(() => run('state.refresh'))}
                  pending={pending['workflow.retryRun']}
                  disabled={!canRetryWorkflow(runItem)}
                />
              </div>
            </div>
          ))}
          {recentRuns.length === 0 && <EmptyState icon={<Activity size={28} />} title="暂无 Workflow" text="新的飞书请求进入执行器路由后会在这里出现。" />}
        </div>
      </section>
    </section>
  );
}

function PermissionsPage({ state, run, pending }: PageProps) {
  const [query, setQuery] = useState('');
  const [channel, setChannel] = useState('all');
  const [role, setRole] = useState<'all' | PermissionRole>('all');
  const subjects = state.permissions?.subjects ?? [];
  const candidates = state.permissions?.candidates ?? [];
  const granted = useMemo(() => new Set(subjects.map(permissionKey)), [subjects]);
  const filteredSubjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return subjects.filter((item) => {
      if (channel !== 'all' && item.channelType !== channel) return false;
      if (role !== 'all' && item.role !== role) return false;
      if (!normalizedQuery) return true;
      return `${item.channelType} ${item.userId} ${item.displayName} ${item.source} ${item.role}`.toLowerCase().includes(normalizedQuery);
    });
  }, [channel, query, role, subjects]);
  const visibleCandidates = candidates
    .filter((item) => !granted.has(permissionKey(item)))
    .filter((item) => {
      const normalizedQuery = query.trim().toLowerCase();
      if (channel !== 'all' && item.channelType !== channel) return false;
      if (!normalizedQuery) return true;
      return `${item.channelType} ${item.userId} ${item.displayName} ${item.source}`.toLowerCase().includes(normalizedQuery);
    })
    .slice(0, 24);

  const saveRole = async (item: PermissionSubject | PermissionCandidate, nextRole: PermissionRole, currentRole: PermissionRole | '' = '') => {
    const label = item.displayName ? `${item.displayName} (${item.userId})` : item.userId;
    if (needsRoleConfirm(currentRole, nextRole)) {
      const confirmed = window.confirm(`把“${label}”设置为 ${roleLabel(nextRole)}？\n\n权限变更会写入本机权限库和兼容 env。Operator/Owner 会扩大可执行范围。`);
      if (!confirmed) return;
    }
    await run('permissions.upsert', {
      channelType: item.channelType,
      userId: item.userId,
      displayName: item.displayName,
      role: nextRole,
      source: 'control-panel',
    });
    await run('state.refresh');
  };

  const removeSubject = async (item: PermissionSubject) => {
    const label = item.displayName ? `${item.displayName} (${item.userId})` : item.userId;
    const confirmed = window.confirm(`移除“${label}”的 ${channelLabel(item.channelType)} 权限？\n\n这会同步更新兼容 env。`);
    if (!confirmed) return;
    await run('permissions.remove', { channelType: item.channelType, userId: item.userId });
    await run('state.refresh');
  };

  return (
    <section className="content-stack permissions-page">
      <section className="panel">
        <SectionHeader
          title="权限总览"
          action={<MiniButton label="应用并重启" icon={<RotateCw size={14} />} onClick={() => void run('permissions.applyAndRestart').then(() => run('state.refresh'))} pending={pending['permissions.applyAndRestart']} />}
        />
        <div className="summary-grid wide">
          <SummaryFact label="Viewer" value={`${subjects.filter((item) => item.role === 'viewer').length}`} compact />
          <SummaryFact label="Operator" value={`${subjects.filter((item) => item.role === 'operator').length}`} compact />
          <SummaryFact label="Owner" value={`${subjects.filter((item) => item.role === 'owner').length}`} compact />
        </div>
        <div className="command-band dense">
          <MiniButton label="从配置同步" icon={<RefreshCw size={14} />} onClick={() => void run('permissions.syncFromConfig').then(() => run('state.refresh'))} pending={pending['permissions.syncFromConfig']} />
          <MiniButton label="刷新状态" icon={<ListChecks size={14} />} onClick={() => void run('permissions.list').then(() => run('state.refresh'))} pending={pending['permissions.list']} />
        </div>
      </section>

      <div className="permission-filter-row">
        <div className="filter-row">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、用户 ID、渠道或来源" />
        </div>
        <select className="role-select" value={channel} onChange={(event) => setChannel(event.target.value)}>
          <option value="all">全部渠道</option>
          <option value="feishu">飞书</option>
          <option value="telegram">Telegram</option>
          <option value="discord">Discord</option>
          <option value="qq">QQ</option>
          <option value="weixin">微信</option>
        </select>
        <select className="role-select" value={role} onChange={(event) => setRole(event.target.value as 'all' | PermissionRole)}>
          <option value="all">全部角色</option>
          <option value="viewer">Viewer</option>
          <option value="operator">Operator</option>
          <option value="owner">Owner</option>
        </select>
      </div>

      <section className="permissions-layout">
        <section className="panel">
          <SectionHeader title="已授权用户" />
          <div className="permission-table">
            {filteredSubjects.map((item) => (
              <div key={permissionKey(item)} className="permission-row">
                <div className="permission-user">
                  <strong>{item.displayName || item.userId}</strong>
                  <span>{channelLabel(item.channelType)} · {item.userId}</span>
                  <span>{item.source || 'manual'} · 更新 {item.updatedAt || '-'}</span>
                </div>
                <StatusPill status={roleStatus(item.role)} label={roleLabel(item.role)} />
                <select
                  className="role-select"
                  value={item.role}
                  onChange={(event) => void saveRole(item, event.target.value as PermissionRole, item.role)}
                >
                  <option value="viewer">Viewer</option>
                  <option value="operator">Operator</option>
                  <option value="owner">Owner</option>
                </select>
                <MiniButton label="移除" icon={<Trash2 size={14} />} onClick={() => void removeSubject(item)} pending={pending['permissions.remove']} />
              </div>
            ))}
            {filteredSubjects.length === 0 && <EmptyState icon={<ShieldCheck size={28} />} title="没有匹配的权限记录" text="可以从最近会话参与人中添加，或先同步配置。" />}
          </div>
        </section>

        <section className="panel">
          <SectionHeader title="最近会话参与人" />
          <div className="candidate-list">
            {visibleCandidates.map((item) => (
              <div key={permissionKey(item)} className="candidate-row">
                <div>
                  <strong>{item.displayName || item.userId}</strong>
                  <span>{channelLabel(item.channelType)} · {item.userId}</span>
                  <span>{item.source || 'history'} · {item.messageCount} 条</span>
                </div>
                <div className="role-button-row">
                  <MiniButton label="Viewer" icon={<ShieldCheck size={14} />} onClick={() => void saveRole(item, 'viewer')} />
                  <MiniButton label="Operator" icon={<Power size={14} />} onClick={() => void saveRole(item, 'operator')} />
                  <MiniButton label="Owner" icon={<CheckCircle2 size={14} />} onClick={() => void saveRole(item, 'owner')} />
                </div>
              </div>
            ))}
            {visibleCandidates.length === 0 && <div className="empty-inline">暂无可添加的最近参与人。</div>}
          </div>
        </section>
      </section>
    </section>
  );
}

function ExtensionsPage({
  mode,
  state,
  units,
  selectedUnitId,
  setSelectedUnitId,
  invokeAction,
  run,
  refreshUnits,
  pending,
}: {
  mode: 'mcp' | 'models_plugins';
  state: PanelState;
  units: RuntimeUnit[];
  selectedUnitId: string;
  setSelectedUnitId: (value: string) => void;
  invokeAction: (unit: RuntimeUnit, action: RuntimeAction) => Promise<void>;
  run: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  refreshUnits: () => Promise<void>;
  pending: Record<string, boolean>;
}) {
  const [importPath, setImportPath] = useState('');
  const [importPreview, setImportPreview] = useState<ExtensionImportPreview | null>(null);
  const [importKind, setImportKind] = useState<ImportKind>('');
  const [importRuntimeType, setImportRuntimeType] = useState<McpRuntimeType>('stdio');
  const [catalog, setCatalog] = useState<ExtensionCatalogSnapshot | null>(null);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogFilter, setCatalogFilter] = useState<ExtensionCatalogFilter>(mode === 'mcp' ? 'mcp' : 'all');
  const [catalogLayerFilter, setCatalogLayerFilter] = useState<'all' | 'local' | 'seed' | 'dynamic' | 'custom_url'>('all');
  const [installJobs, setInstallJobs] = useState<ExtensionInstallJob[]>([]);
  const refreshedTerminalInstallJobsRef = useRef<Set<string>>(new Set());
  const [modelInstallPath, setModelInstallPath] = useState(state.settings.ollamaModelsDir || '');
  const [useModelAfterInstall, setUseModelAfterInstall] = useState(true);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remotePreview, setRemotePreview] = useState<RemoteExtensionPreview | null>(null);
  const allowedCatalogTypes = useMemo<ExtensionCatalogFilter[]>(
    () => mode === 'mcp' ? ['mcp'] : ['plugin', 'model'],
    [mode],
  );
  const filteredUnits = units;
  const selected = filteredUnits.find((unit) => unit.unitId === selectedUnitId) ?? filteredUnits[0];
  const filteredCatalogItems = useMemo(() => {
    const query = catalogQuery.trim().toLowerCase();
    return (catalog?.items ?? []).filter((item) => {
      if (!allowedCatalogTypes.includes(item.type as ExtensionCatalogFilter)) return false;
      if (catalogFilter !== 'all' && item.type !== catalogFilter) return false;
      if (catalogLayerFilter !== 'all' && item.sourceLayer !== catalogLayerFilter) return false;
      if (!query) return true;
      return `${item.id} ${item.displayName} ${item.category} ${item.description} ${item.installHandler} ${item.sourceName} ${item.rankBasis}`.toLowerCase().includes(query);
    });
  }, [allowedCatalogTypes, catalog?.items, catalogFilter, catalogLayerFilter, catalogQuery]);

  async function loadCatalog(refresh = false) {
    const snapshot = await run(refresh ? 'extension.catalog.refresh' : 'extension.catalog.list') as ExtensionCatalogSnapshot;
    setCatalog(snapshot);
  }

  async function loadInstallJobs() {
    const jobs = await run('extension.installJobs') as ExtensionInstallJob[];
    setInstallJobs(Array.isArray(jobs) ? jobs : []);
  }

  useEffect(() => {
    void loadCatalog(false);
    if (mode === 'models_plugins') void loadInstallJobs();
  }, [mode]);

  useEffect(() => {
    if (mode !== 'models_plugins') return undefined;
    const timer = window.setInterval(() => {
      void loadInstallJobs().catch(() => undefined);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'models_plugins') return;
    const terminalJobs = installJobs.filter((job) => job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled');
    const unseen = terminalJobs.filter((job) => !refreshedTerminalInstallJobsRef.current.has(job.jobId));
    if (unseen.length === 0) return;
    for (const job of unseen) refreshedTerminalInstallJobsRef.current.add(job.jobId);
    void loadCatalog(false).catch(() => undefined);
  }, [installJobs, mode]);

  async function pickImportFolder() {
    const picked = await run('path.pickFolder', { currentPath: importPath }) as string;
    setImportPath(picked || importPath);
  }

  async function inspectImportFolder() {
    if (!importPath.trim()) return;
    const preview = await run('extension.detectImport', { folderPath: importPath.trim() }) as ExtensionImportPreview;
    setImportPreview(preview);
    setImportKind('mcp');
    setImportRuntimeType(preview.runtimeType === 'http' ? 'http' : 'stdio');
  }

  async function importFolderAsExtension() {
    if (!importPreview) return;
    const result = await run('extension.importFromFolder', {
      folderPath: importPath.trim(),
      kind: 'mcp',
      runtimeType: importRuntimeType,
    }) as { kind?: string; id?: string };
    await refreshUnits();
    const importedKind = result?.kind || 'mcp';
    const importedId = result?.id || importPreview.id;
    setSelectedUnitId(importedKind === 'mcp' ? `mcp.${importedId}` : `extension.${importPreview.manifestPath}`);
  }

  function catalogModelName(item: ExtensionCatalogItem) {
    return (item.artifactUrl || item.installPath || item.id || '').trim();
  }

  function installJobForItem(item: ExtensionCatalogItem) {
    const model = catalogModelName(item);
    return installJobs
      .filter((job) => job.itemId === item.id || (!!model && job.model === model))
      .sort((left, right) => (right.updatedAt || '').localeCompare(left.updatedAt || ''))[0];
  }

  function shouldShowInstallJob(item: ExtensionCatalogItem, job?: ExtensionInstallJob) {
    if (!job) return false;
    if (job.status === 'succeeded' && item.installed) return false;
    return job.status === 'running' || job.status === 'failed' || job.status === 'cancelled' || job.status === 'succeeded';
  }

  function installJobStatusLabel(job: ExtensionInstallJob) {
    if (job.status === 'running') return '安装中';
    if (job.status === 'failed') return '安装失败';
    if (job.status === 'cancelled') return '已暂停';
    if (job.status === 'succeeded') return '安装完成';
    return job.status || '安装任务';
  }

  function installJobStatusKind(job: ExtensionInstallJob): StatusKind {
    if (job.status === 'succeeded') return 'ok';
    if (job.status === 'failed') return 'error';
    if (job.status === 'cancelled') return 'warning';
    return 'warning';
  }

  async function installCatalogItem(item: ExtensionCatalogItem) {
    if (item.type === 'skill') {
      window.alert('Skill 安装必须进入 Skills 页并通过 lifecycle 审批。');
      return;
    }
    if (!allowedCatalogTypes.includes(item.type as ExtensionCatalogFilter)) {
      window.alert(`当前页面不处理 ${getRuntimeKindLabel(item.type)} 安装。`);
      return;
    }
    if (item.type === 'model' && item.installHandler === 'ollama.pull') {
      const confirmed = window.confirm(`安装 Ollama 模型“${item.displayName}”？\n\n模型：${catalogModelName(item)}\n目录：${modelInstallPath.trim() || 'Ollama 默认模型目录'}\n\n安装会显示进度，可暂停；完成后默认会设为本地 API 模型并重启 Bridge。`);
      if (!confirmed) return;
      await run('extension.model.install.start', {
        id: item.id,
        allowUntrusted: !item.trusted,
        installPath: modelInstallPath.trim(),
        useAfterInstall: useModelAfterInstall,
      });
      await Promise.all([loadCatalog(false), loadInstallJobs()]);
      return;
    }
    const trustLine = item.trusted ? '来源含校验信息，安装时会校验。' : '该条目没有 sha256，将按不可信来源安装。';
    const confirmed = window.confirm(`安装“${item.displayName}”？\n\n类型：${getRuntimeKindLabel(item.type)}\n来源：${item.artifactUrl || item.catalogSource || '-'}\n${trustLine}\n\n安装内容会写入本机 CTI_HOME 扩展目录。`);
    if (!confirmed) return;
    await run('extension.remote.install', { id: item.id, allowUntrusted: !item.trusted });
    await Promise.all([loadCatalog(true), refreshUnits()]);
  }

  async function removeCatalogItem(item: ExtensionCatalogItem) {
    if (item.type === 'model' && item.installHandler === 'ollama.pull') {
      const model = catalogModelName(item);
      const confirmed = window.confirm(`卸载 Ollama 模型“${item.displayName}”？\n\n模型：${model}\n\n这会执行 ollama rm，删除本机模型本体，并在完成后重启 Bridge。`);
      if (!confirmed) return;
      await run('extension.model.remove', { id: item.id, model });
      await Promise.all([loadCatalog(true), loadInstallJobs(), refreshUnits()]);
      return;
    }
    const confirmed = window.confirm(`移除“${item.displayName}”的 suite 记录？\n\n只会删除由套件生成的用户覆盖层 manifest、launcher 或安装锁记录；不会删除 Ollama 模型本体、OpenAI bundled 插件缓存或外部包管理器内容。`);
    if (!confirmed) return;
    await run('extension.remote.remove', { id: item.id, type: item.type });
    await Promise.all([loadCatalog(true), refreshUnits()]);
  }

  async function useCatalogModel(item: ExtensionCatalogItem) {
    const model = catalogModelName(item);
    if (!model) return;
    await run('extension.model.use', { model });
    await Promise.all([loadCatalog(false), refreshUnits()]);
  }

  async function cancelInstallJob(job: ExtensionInstallJob) {
    await run('extension.model.install.cancel', { jobId: job.jobId });
    await loadInstallJobs();
  }

  async function pickModelInstallPath() {
    const picked = await run('path.pickFolder', { currentPath: modelInstallPath || state.settings.ollamaModelsDir || '' }) as string;
    if (picked) setModelInstallPath(picked);
  }

  async function previewRemoteUrl() {
    if (!remoteUrl.trim()) return;
    const preview = await run('extension.remote.preview', { url: remoteUrl.trim() }) as RemoteExtensionPreview;
    setRemotePreview(preview);
  }

  async function installRemotePreview() {
    if (!remotePreview) return;
    if (remotePreview.type === 'skill') {
      window.alert('远程 Skill 不能从通用 URL 安装；请进入 Skills 页走来源校验和审批。');
      return;
    }
    if (!allowedCatalogTypes.includes(remotePreview.type as ExtensionCatalogFilter)) {
      window.alert(`当前页面不处理 ${getRuntimeKindLabel(remotePreview.type)} 安装。`);
      return;
    }
    if (remotePreview.type === 'model' && remotePreview.installHandler === 'ollama.pull') {
      const confirmed = window.confirm(`从 URL 安装 Ollama 模型“${remotePreview.displayName}”？\n\n来源：${remotePreview.artifactUrl || remotePreview.sourceUrl}`);
      if (!confirmed) return;
      await run('extension.model.install.start', {
        url: remotePreview.sourceUrl,
        allowUntrusted: !remotePreview.trusted,
        installPath: modelInstallPath.trim(),
        useAfterInstall: useModelAfterInstall,
      });
      setRemotePreview(null);
      await Promise.all([loadCatalog(false), loadInstallJobs()]);
      return;
    }
    const confirmed = window.confirm(`从 URL 安装“${remotePreview.displayName}”？\n\n${remotePreview.reason}\n来源：${remotePreview.artifactUrl || remotePreview.sourceUrl}`);
    if (!confirmed) return;
    await run('extension.remote.install', { url: remotePreview.sourceUrl, allowUntrusted: !remotePreview.trusted });
    setRemotePreview(null);
    await Promise.all([loadCatalog(true), refreshUnits()]);
  }

  function handleImportDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0] as File & { path?: string };
    const dropped = normalizeDroppedPath(file?.path || event.dataTransfer.getData('text/plain') || event.dataTransfer.getData('text/uri-list'));
    if (dropped) {
      setImportPath(dropped);
    }
  }

  return (
    <section className="extensions-layout">
      <section className="panel">
        <SectionHeader title={mode === 'mcp' ? 'MCP 管理' : '模型与插件总览'} />
        <div className="summary-grid">
          <SummaryFact label={mode === 'mcp' ? 'MCP 单元' : '模型 / Plugin'} value={`${units.length}`} />
          <SummaryFact label="目录条目" value={`${filteredCatalogItems.length}`} />
          <SummaryFact label="已安装" value={`${filteredCatalogItems.filter((item) => item.installed).length}`} />
          <SummaryFact label="缺依赖" value={`${state.extensions.missingSources}`} />
        </div>
        <div className="field-block catalog-panel">
          <span>在线目录</span>
          <div className="summary-grid">
            <SummaryFact label="目录源" value={`${catalog?.sourceCount ?? 0}`} compact />
            <SummaryFact label="条目" value={`${catalog?.items.length ?? 0}`} compact />
            <SummaryFact label="本机模型" value={`${catalog?.items.filter((item) => item.sourceLayer === 'local').length ?? 0}`} compact />
            <SummaryFact label="静态种子" value={`${catalog?.layerCounts.seed ?? 0}`} compact />
            <SummaryFact label="动态排行" value={`${catalog?.layerCounts.dynamic ?? 0}`} compact />
            <SummaryFact label="自定义 URL" value={`${catalog?.layerCounts.customUrl ?? 0}`} compact />
          </div>
          {mode === 'models_plugins' && <div className="model-install-config">
            <label className="stack-field">
              <span>Ollama 模型安装目录</span>
              <div className="path-input-group">
                <input value={modelInstallPath} onChange={(event) => setModelInstallPath(event.target.value)} placeholder="留空使用 Ollama 默认目录，或选择自定义模型目录" />
                <MiniButton label="选择目录" icon={<FolderOpen size={14} />} onClick={() => void pickModelInstallPath()} pending={pending['path.pickFolder']} />
              </div>
            </label>
            <label className="inline-field model-install-toggle">
              <input type="checkbox" checked={useModelAfterInstall} onChange={(event) => setUseModelAfterInstall(event.target.checked)} />
              <span>模型安装完成后设为本地 API 模型并自动重启 Bridge</span>
            </label>
          </div>}
          <div className="command-band dense path-input-group">
            <input value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} placeholder={mode === 'mcp' ? '搜索 MCP' : '搜索模型或 Plugin'} />
            <MiniButton label="刷新目录" icon={<RefreshCw size={14} />} onClick={() => void loadCatalog(true)} pending={pending['extension.catalog.refresh']} />
          </div>
          <div className="preset-wall">
            {((mode === 'mcp' ? ['mcp'] : ['all', 'plugin', 'model']) as ExtensionCatalogFilter[]).map((item) => (
              <button key={item} className={catalogFilter === item ? 'preset-chip active' : 'preset-chip'} onClick={() => setCatalogFilter(item)}>
                {item === 'all' ? '全部' : getRuntimeKindLabel(item)}
              </button>
            ))}
          </div>
          <div className="preset-wall">
            {([
              { id: 'all', label: '全部层' },
              { id: 'local', label: '本机已安装' },
              { id: 'seed', label: '静态种子' },
              { id: 'dynamic', label: '动态排行' },
              { id: 'custom_url', label: '自定义 URL' },
            ] as const).map((item) => (
              <button key={item.id} className={catalogLayerFilter === item.id ? 'preset-chip active' : 'preset-chip'} onClick={() => setCatalogLayerFilter(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
          <div className="runtime-list compact-list catalog-list">
            {filteredCatalogItems.slice(0, 12).map((item) => {
              const installJob = installJobForItem(item);
              const visibleInstallJob = shouldShowInstallJob(item, installJob) ? installJob : undefined;
              const isOllamaModel = item.type === 'model' && item.installHandler === 'ollama.pull';
              return (
                <div key={`${item.type}-${item.id}`} className="runtime-row">
                  <div>
                    <strong>{item.displayName}</strong>
                    <span>{getRuntimeKindLabel(item.type)} · {getCatalogLayerLabel(item.sourceLayer)} · {item.sourceName || item.installHandler} · {item.version}</span>
                    <p>{item.description || item.artifactUrl || item.catalogSource}</p>
                    <span>{`抓取 ${item.fetchedAt || '-'} · 排行 ${item.rankBasis || '-'}${item.rankOrder > 0 ? ` · #${item.rankOrder}` : ''}`}</span>
                    {visibleInstallJob && (
                      <div className="install-progress">
                        <div className="install-progress-head">
                          <span>{visibleInstallJob.message || installJobStatusLabel(visibleInstallJob)}</span>
                          <strong>{visibleInstallJob.percent > 0 ? `${visibleInstallJob.percent}%` : installJobStatusLabel(visibleInstallJob)}</strong>
                        </div>
                        <div className="install-progress-track">
                          <div className="install-progress-fill" style={{ width: `${Math.max(4, Math.min(100, visibleInstallJob.percent || 4))}%` }} />
                        </div>
                        {visibleInstallJob.recentLines?.length ? <p>{visibleInstallJob.recentLines[visibleInstallJob.recentLines.length - 1]}</p> : null}
                      </div>
                    )}
                  </div>
                  <div className="row-actions">
                    <StatusPill status={visibleInstallJob ? installJobStatusKind(visibleInstallJob) : item.installed ? 'ok' : item.canInstall ? (item.trusted ? 'idle' : 'warning') : 'idle'} label={visibleInstallJob ? installJobStatusLabel(visibleInstallJob) : item.installed ? '已安装' : item.canInstall ? (item.trusted ? '可安装' : '需确认') : '只读'} />
                    {visibleInstallJob ? (
                      visibleInstallJob.status === 'running' ? (
                        <MiniButton label="暂停" icon={<RotateCw size={14} />} onClick={() => void cancelInstallJob(visibleInstallJob)} pending={pending['extension.model.install.cancel']} disabled={!visibleInstallJob.canCancel} />
                      ) : (
                        <MiniButton label={visibleInstallJob.status === 'failed' ? '重试' : '继续安装'} icon={<Layers3 size={14} />} onClick={() => void installCatalogItem(item)} pending={pending['extension.model.install.start']} disabled={!item.canInstall} />
                      )
                    ) : item.installed ? (
                      <>
                        {isOllamaModel && <MiniButton label="使用" icon={<CheckCircle2 size={14} />} onClick={() => void useCatalogModel(item)} pending={pending['extension.model.use']} />}
                        {isOllamaModel ? (
                          <MiniButton label="卸载" icon={<Trash2 size={14} />} onClick={() => void removeCatalogItem(item)} pending={pending['extension.model.remove']} />
                        ) : item.canRemove ? (
                          <MiniButton label="移除记录" icon={<Trash2 size={14} />} onClick={() => void removeCatalogItem(item)} pending={pending['extension.remote.remove']} />
                        ) : (
                          <MiniButton label="本机已有" icon={<ListChecks size={14} />} onClick={() => {}} disabled />
                        )}
                      </>
                    ) : (
                      <MiniButton label={item.canInstall ? '安装' : '记录'} icon={<Layers3 size={14} />} onClick={() => void installCatalogItem(item)} pending={pending['extension.remote.install'] || pending['extension.model.install.start']} disabled={!item.canInstall} />
                    )}
                  </div>
                </div>
              );
            })}
            {filteredCatalogItems.length === 0 && <div className="empty-inline">暂无在线目录条目。可配置 CTI_EXTENSION_CATALOG_URLS 或粘贴 URL 预览。</div>}
          </div>
          <div className="field-block remote-url-box">
            <span>URL 预览</span>
            <div className="command-band dense path-input-group">
              <input value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="粘贴 HTTPS catalog item JSON 或带 extension.json 的 zip" />
              <MiniButton label="预览" icon={<Search size={14} />} onClick={() => void previewRemoteUrl()} pending={pending['extension.remote.preview']} disabled={!remoteUrl.trim()} />
            </div>
            {remotePreview ? (
              <div className="detail-stack remote-preview">
                <div className="summary-grid">
                  <SummaryFact label="名称" value={remotePreview.displayName} compact />
                  <SummaryFact label="信任" value={remotePreview.trusted ? 'sha256' : '未校验'} compact />
                </div>
                <dl className="kv">
                  <dt>类型</dt><dd>{getRuntimeKindLabel(remotePreview.type)}</dd>
                  <dt>Handler</dt><dd>{remotePreview.installHandler}</dd>
                  <dt>来源</dt><dd>{remotePreview.artifactUrl || remotePreview.sourceUrl}</dd>
                  <dt>说明</dt><dd>{remotePreview.reason}</dd>
                </dl>
                <MiniButton
                  label={remotePreview.type === 'skill' ? '请到 Skills 页' : '安装预览项'}
                  icon={<Layers3 size={14} />}
                  onClick={() => void installRemotePreview()}
                  pending={pending['extension.remote.install']}
                  disabled={remotePreview.type === 'skill' || !allowedCatalogTypes.includes(remotePreview.type as ExtensionCatalogFilter)}
                />
              </div>
            ) : null}
          </div>
        </div>
        {mode === 'mcp' && <div className="field-block import-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={handleImportDrop}>
          <span>导入本地目录</span>
          <div className="command-band dense path-input-group">
            <input value={importPath} onChange={(event) => setImportPath(event.target.value)} placeholder="拖一个 skill / mcp 目录进来，或手动粘贴路径" />
            <MiniButton label="选择目录" icon={<FolderOpen size={14} />} onClick={() => void pickImportFolder()} pending={pending['path.pickFolder']} />
            <MiniButton label="识别" icon={<Search size={14} />} onClick={() => void inspectImportFolder()} pending={pending['extension.detectImport']} disabled={!importPath.trim()} />
          </div>
          <div className="detail-meta">规则：目录名或 package.json 名称/描述命中 `mcp` 识别为 MCP；本页不会导入 Skill。</div>
          {importPreview ? (
            <div className="detail-stack import-preview-grid">
              <div className="summary-grid">
                <SummaryFact label="识别结果" value={getRuntimeKindLabel(importPreview.detectedKind || 'extension')} compact />
                <SummaryFact label="ID" value={importPreview.id || '-'} compact />
                <SummaryFact label="安装状态" value={importPreview.installState || '-'} compact />
                <SummaryFact label="可导入" value={importPreview.canImport ? '是' : '否'} compact />
              </div>
              <div className="preset-wall">
                <button className={(importKind || importPreview.detectedKind) === 'mcp' ? 'preset-chip active' : 'preset-chip'} onClick={() => setImportKind('mcp')}>MCP</button>
                {((importKind || importPreview.detectedKind) === 'mcp') && (
                  <>
                    <button className={importRuntimeType === 'stdio' ? 'preset-chip active' : 'preset-chip'} onClick={() => setImportRuntimeType('stdio')}>stdio</button>
                    <button className={importRuntimeType === 'http' ? 'preset-chip active' : 'preset-chip'} onClick={() => setImportRuntimeType('http')}>http</button>
                  </>
                )}
              </div>
              <dl className="kv">
                <dt>名称</dt><dd>{importPreview.displayName || '-'}</dd>
                <dt>Source</dt><dd>{importPreview.source || '-'}</dd>
                <dt>Manifest</dt><dd>{importPreview.manifestPath || '-'}</dd>
                <dt>说明</dt><dd>{importPreview.reason || importPreview.description || '-'}</dd>
              </dl>
              <div className="command-band dense">
                <MiniButton
                  label="生成 Manifest"
                  icon={<Layers3 size={14} />}
                  onClick={() => void importFolderAsExtension()}
                  pending={pending['extension.importFromFolder']}
                  disabled={!importPreview.canImport}
                />
              </div>
            </div>
          ) : null}
        </div>}
      </section>
      <section className="panel list-panel">
        <SectionHeader title="扩展清单" />
        <div className="runtime-list">
          {filteredUnits.map((unit) => (
            <button key={unit.unitId} className={selected?.unitId === unit.unitId ? 'runtime-row active' : 'runtime-row'} onClick={() => setSelectedUnitId(unit.unitId)}>
              <div>
                <strong>{unit.displayName}</strong>
                <span>{getRuntimeKindLabel(unit.kind)} · {getRuntimeCategoryLabel(unit.category)} · {unit.installState || '-'}</span>
              </div>
              <StatusPill status={unit.status} label={runtimeStatusText(unit)} />
            </button>
          ))}
        </div>
      </section>
      <aside className="panel">
        {selected ? (
          <>
            <SectionHeader title={selected.displayName} />
            <div className="detail-stack">
              <div className="detail-summary">
                <StatusPill status={selected.status} label={statusText(selected.status, selected.enabled)} />
                <div className="detail-meta">{getRuntimeKindLabel(selected.kind)} · {getRuntimeCategoryLabel(selected.category)}</div>
              </div>
              <p className="detail-copy">{selected.description || selected.detail || '暂无说明。'}</p>
              <div className="command-band dense">
                {selected.actions.map((action) => (
                  <MiniButton
                    key={action.id}
                    label={action.label}
                    icon={actionIcon(action.id)}
                    onClick={() => void invokeAction(selected, action)}
                    pending={pending['runtime.invokeAction']}
                    disabled={!action.enabled}
                    title={!action.enabled ? (action.reason || `${action.label} 当前不可用`) : action.label}
                  />
                ))}
              </div>
              <dl className="kv">
                <dt>Manifest</dt><dd>{selected.cwd || '-'}</dd>
                <dt>Source</dt><dd>{selected.source || '-'}</dd>
                <dt>版本</dt><dd>{selected.version || '-'}</dd>
              </dl>
            </div>
          </>
        ) : (
          <EmptyState icon={<Layers3 size={28} />} title="暂无扩展条目" text="当前筛选下没有可显示的 MCP、Skill、Plugin 或其他扩展。" />
        )}
      </aside>
    </section>
  );
}

function ReleasePage({ state, run, pending }: PageProps) {
  return (
    <section className="release-layout">
      <section className="panel panel-hero">
        <SectionHeader title="发布门禁" />
        <div className="release-gates wide">
          <GateItem label="发布摘要" ok={state.release.publishSummaryExists} />
          <GateItem label="发布历史" ok={state.release.releaseNotesExists} />
          <GateItem label="预检脚本" ok={state.release.prepareMainReleaseExists} />
          <GateItem label="标签脚本" ok={state.release.tagScriptExists} />
        </div>
      </section>
      <section className="panel">
        <SectionHeader title="发布动作" />
        <div className="command-band">
          <CommandButton label="一键发布" command="release.publishBackup" icon={<Rocket size={16} />} run={run} pending={pending} />
          <CommandButton label="主干发布预检" command="release.prepareMainRelease" icon={<ListChecks size={16} />} run={run} pending={pending} />
          <CommandButton label="打开摘要" command="release.openSummary" icon={<FileText size={16} />} run={run} pending={pending} />
          <CommandButton label="打开历史" command="release.openNotes" icon={<History size={16} />} run={run} pending={pending} />
          <CommandButton label="打开 Suite" command="release.openSuite" icon={<ExternalLink size={16} />} run={run} pending={pending} />
        </div>
      </section>
      <section className="panel">
        <SectionHeader title="Git 变更" />
        <pre className="code-block">{state.release.pendingChanges.length > 0 ? state.release.pendingChanges.join('\n') : '工作区无待提交变更'}</pre>
      </section>
    </section>
  );
}

function SessionsPage({
  state,
  run,
  pending,
  debug,
  pageInstanceId,
  query,
  setQuery,
  sessions,
  selectedSessionKey,
  openSessionDetail,
  detail,
  detailError,
  detailLoading,
  drawerOpen,
  setDrawerOpen,
  deleteSession,
  setSessionPersonRole,
}: {
  state: PanelState;
  run: PageProps['run'];
  pending: Record<string, boolean>;
  debug: {
    stateMessageCount: number;
    activityMessageCount: number;
    sessionDetailRequestCount: number;
    sessionDetailResultCount: number;
  };
  pageInstanceId: string;
  query: string;
  setQuery: (value: string) => void;
  sessions: SessionItem[];
  selectedSessionKey: string;
  openSessionDetail: (value: string, force?: boolean) => void | Promise<void>;
  detail: SessionDetail | null;
  detailError: string;
  detailLoading: boolean;
  drawerOpen: boolean;
  setDrawerOpen: (value: boolean) => void;
  deleteSession: () => void | Promise<void>;
  setSessionPersonRole: (user: FeishuPerson, role: PermissionRole) => void | Promise<void>;
}) {
  return (
    <section className="content-stack">
      <div className="command-band">
        <CommandButton label="同步全部历史" command="history.syncAll" icon={<RefreshCw size={16} />} run={run} pending={pending} />
        <CommandButton label="刷新同步状态" command="history.status" icon={<ListChecks size={16} />} run={run} pending={pending} />
        <CommandButton label="旧查看器" command="history.openConversationViewer" icon={<ExternalLink size={16} />} run={run} pending={pending} />
        <CommandButton label="打开记忆仓库" command="path.openMemoryRepo" icon={<FolderOpen size={16} />} run={run} pending={pending} />
      </div>
      <section className="sessions-layout">
        <section className="panel">
          <SectionHeader title="同步摘要" />
          <pre className="code-block compact-code">{state.history.status || '暂无同步状态'}</pre>
          <pre className="code-block compact-code diagnostics-block">
{[
  `前端实例: ${pageInstanceId}`,
  `前端 state 推送: ${debug.stateMessageCount}`,
  `前端 activity 推送: ${debug.activityMessageCount}`,
  `前端详情请求: ${debug.sessionDetailRequestCount}`,
  `前端详情回包: ${debug.sessionDetailResultCount}`,
  `宿主导航次数: ${state.diagnostics?.webNavigationCount ?? 0}`,
  `宿主 state 推送: ${state.diagnostics?.webStatePushCount ?? 0}`,
  `宿主详情请求: ${state.diagnostics?.sessionDetailRequestCount ?? 0}`,
].join('\n')}
          </pre>
          <div className="mini-stats">
            <SummaryFact label="会话数" value={`${state.history.sessions.length}`} compact />
            <SummaryFact label="索引来源" value="飞书 + 本地" compact />
          </div>
        </section>
        <section className="panel list-panel">
          <SectionHeader title="会话列表" />
          <div className="filter-bar">
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="检索会话、群名、摘要、chatId" />
          </div>
          <div className="session-list">
            {sessions.map((item) => {
              const key = `${item.chatId}::${item.sessionId}`;
              return (
                <button key={key} className={selectedSessionKey === key ? 'session-row active' : 'session-row'} onClick={() => void openSessionDetail(key)}>
                  <div className="session-primary">
                    <strong>{getSessionDisplayTitle(item)}</strong>
                    <span>{getSessionTypeLabel(item)} · {item.source} · {formatSessionMessageCount(item)} · {item.lastUpdatedAt || '未知时间'}</span>
                    <p>{item.summary || '暂无摘要'}</p>
                  </div>
                  <code>{item.displayName || item.chatId || item.sessionId || '-'}</code>
                </button>
              );
            })}
          </div>
        </section>
        <SessionDetailPane
          detail={detail}
          run={run}
          pending={pending}
          detailError={detailError}
          detailLoading={detailLoading}
          drawerOpen={drawerOpen}
          setDrawerOpen={setDrawerOpen}
          deleteSession={deleteSession}
          setSessionPersonRole={setSessionPersonRole}
          refreshDetail={() => detail ? openSessionDetail(`${detail.chatId}::${detail.sessionId}`, true) : undefined}
        />
      </section>
      <ReminderPanel initial={state.memoryReminders} run={run} pending={pending} />
    </section>
  );
}

function ReminderPanel({ initial, run, pending }: { initial: TodoReminderSnapshot; run: PageProps['run']; pending: Record<string, boolean> }) {
  const [reminders, setReminders] = useState(initial);
  useEffect(() => setReminders(initial), [initial]);

  const refresh = async () => setReminders(await run('memory.checkReminders') as TodoReminderSnapshot);
  const complete = async (id: string) => {
    await run('memory.completeReminder', { id });
    await refresh();
  };
  const test = async (id: string) => {
    await run('memory.testReminder', { id });
    await refresh();
  };

  return (
    <section className="panel">
      <SectionHeader title="提醒" action={<MiniButton label="检查提醒" icon={<RefreshCw size={14} />} onClick={() => void refresh()} pending={pending['memory.checkReminders']} />} />
      <div className="summary-grid">
        <Metric label="主动推送" value={reminders.enabled ? '已开启' : '未开启'} compact />
        <Metric label="直接提醒" value={reminders.directReminderPushEnabled ? '已开启' : reminders.directReminderEnabled === false ? '未启用' : '未推送'} compact />
        <Metric label="待发送" value={String(reminders.counts?.pending ?? 0)} compact />
        <Metric label="已发送" value={String(reminders.counts?.sent ?? 0)} compact />
        <Metric label="已完成" value={String(reminders.counts?.completed ?? 0)} compact />
        <Metric label="失败" value={String(reminders.counts?.failed ?? 0)} compact />
      </div>
      {reminders.lastError && <div className="inline-notice warning">{reminders.lastError}</div>}
      <div className="runtime-list compact-list">
        {(reminders.items ?? []).map((item) => (
          <article key={item.id} className="runtime-row">
            <div>
              <strong>{item.title || '未命名提醒'}</strong>
              <span>{item.dueAt || '无提醒时间'} · {item.sourceType === 'direct' ? '直接提醒' : '记忆待办'} · {item.target?.displayName || item.target?.chatId || '缺少来源会话'}</span>
              <p>{item.completedAt || item.delivery?.completedAt ? `已完成：${item.completedAt || item.delivery?.completedAt}` : item.skipReason || item.delivery?.error || item.source?.snippet || '等待到点推送。'}</p>
            </div>
            <div className="row-actions">
              <StatusPill status={reminderStatusKind(item.status)} label={reminderStatusLabel(item.status)} />
              <MiniButton label="完成" icon={<CheckCircle2 size={14} />} onClick={() => void complete(item.id)} pending={pending['memory.completeReminder']} disabled={item.status === 'completed'} />
              <MiniButton label="测试发送" icon={<Play size={14} />} onClick={() => void test(item.id)} pending={pending['memory.testReminder']} disabled={item.status === 'completed' || (item.target?.channelType || '').toLowerCase() !== 'feishu' || !item.target?.chatId} />
              <MiniButton label="来源" icon={<ExternalLink size={14} />} onClick={() => void run('memory.openSource', { path: item.source?.path })} pending={pending['memory.openSource']} />
            </div>
          </article>
        ))}
        {(reminders.items ?? []).length === 0 && <div className="empty-inline">暂无提醒。自然语言提醒仍由 agent 生成受控动作，不在面板里绕过主链路。</div>}
      </div>
    </section>
  );
}

function WorkflowRunCard({
  runItem,
  run,
  pending,
  refreshDetail,
  linkReason,
}: {
  runItem: WorkflowRun;
  run: PageProps['run'];
  pending: Record<string, boolean>;
  refreshDetail: () => void | Promise<void> | undefined;
  linkReason?: WorkflowRunLink['linkReason'];
}) {
  return (
    <article className="run-card">
      <header>
        <strong>{runItem.executorId || '未选择执行器'}</strong>
        <div className="run-card-status">
          {linkReason && (
            <StatusPill
              status={linkReason === 'message_id' ? 'ok' : 'idle'}
              label={linkReason === 'message_id' ? '消息 ID 匹配' : '按时间匹配'}
            />
          )}
          <StatusPill status={workflowStatusKind(runItem)} label={workflowStatusLabel(runItem)} />
        </div>
      </header>
      <p>{runItem.promptPreview || runItem.id}</p>
      <dl className="workflow-run-meta">
        <div>
          <dt>开始</dt>
          <dd>{formatWorkflowTimestamp(runItem.startedAt)}</dd>
        </div>
        <div>
          <dt>结束</dt>
          <dd>{runItem.endedAt ? formatWorkflowTimestamp(runItem.endedAt) : '进行中'}</dd>
        </div>
        <div>
          <dt>耗时</dt>
          <dd>{workflowDurationSummary(runItem)}</dd>
        </div>
        <div>
          <dt>模型</dt>
          <dd>{workflowModelLabel(runItem)}</dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd>{workflowModelSourceLabel(runItem)}</dd>
        </div>
        {runItem.execution?.promptProfile && (
          <div>
            <dt>Profile</dt>
            <dd>{runItem.execution.promptProfile}</dd>
          </div>
        )}
        <div>
          <dt>Token</dt>
          <dd>{workflowTokenSummary(runItem)}</dd>
        </div>
        <div>
          <dt>证据</dt>
          <dd>{workflowEvidenceSummaryV2(runItem)}</dd>
        </div>
        {workflowCacheTokenSummary(runItem) && (
          <div>
            <dt>Cache</dt>
            <dd>{workflowCacheTokenSummary(runItem)}</dd>
          </div>
        )}
      </dl>
      {(runItem.recovery?.reason || runItem.retry?.lastError || runItem.error) && (
        <p>{runItem.recovery?.reason || runItem.retry?.lastError || runItem.error}</p>
      )}
      <span>{runItem.id}</span>
      <div className="command-band tight">
        <MiniButton
          label="重试"
          icon={<RotateCw size={14} />}
          onClick={() => void run('workflow.retryRun', { id: runItem.id }).then(() => refreshDetail())}
          pending={pending['workflow.retryRun']}
          disabled={!canRetryWorkflow(runItem)}
        />
      </div>
      <div className="event-list">
        {(runItem.events ?? []).map((event) => (
          <div key={event.id} className="event-row">
            <time>{event.at || '-'}</time>
            <strong>{event.stage}</strong>
            <span>{event.message || event.type}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

const SessionDetailPane = memo(function SessionDetailPane({
  detail,
  run,
  pending,
  detailError,
  detailLoading,
  drawerOpen,
  setDrawerOpen,
  deleteSession,
  setSessionPersonRole,
  refreshDetail,
}: {
  detail: SessionDetail | null;
  run: PageProps['run'];
  pending: Record<string, boolean>;
  detailError: string;
  detailLoading: boolean;
  drawerOpen: boolean;
  setDrawerOpen: (value: boolean) => void;
  deleteSession: () => void | Promise<void>;
  setSessionPersonRole: (user: FeishuPerson, role: PermissionRole) => void | Promise<void>;
  refreshDetail: () => void | Promise<void> | undefined;
}) {
  const [messageSortOrder, setMessageSortOrder] = useState<'desc' | 'asc'>('desc');
  const orderedMessages = useMemo(() => {
    if (!detail) return [];
    const copied = [...detail.messages];
    return messageSortOrder === 'desc' ? copied.reverse() : copied;
  }, [detail, messageSortOrder]);
  const conversationTimeline = useMemo(
    () => buildConversationTimeline(detail?.messages ?? [], detail?.workflowRuns ?? []),
    [detail],
  );
  const unlinkedRuns = conversationTimeline.unlinkedRuns;

  return (
    <aside className={drawerOpen ? 'panel detail-drawer open' : 'panel detail-drawer'}>
      <div className="section-header">
        <h2>会话详情</h2>
        <div className="detail-header-actions">
          <MiniButton
            label={messageSortOrder === 'desc' ? '最新在上' : '最早在上'}
            icon={<ArrowDownUp size={14} />}
            onClick={() => setMessageSortOrder((current) => current === 'desc' ? 'asc' : 'desc')}
          />
          <MiniButton
            label="刷新详情"
            icon={<RefreshCw size={14} />}
            onClick={() => void refreshDetail()}
            disabled={!detail || detailLoading}
          />
          <MiniButton
            label="删除"
            icon={<Trash2 size={14} />}
            onClick={() => void deleteSession()}
            disabled={!detail}
          />
          <button className="icon-button drawer-close" onClick={() => setDrawerOpen(false)} title="关闭详情">
            <X size={16} />
          </button>
        </div>
      </div>
      {detail ? (
        <div className="detail-stack">
          <div className="detail-summary">
            <StatusPill status="ok" label={detail.source || '已加载'} />
            <div className="detail-meta">{getSessionDisplayTitle(detail)} · {getSessionTypeLabel(detail)} · {detail.lastUpdatedAt || '-'}</div>
          </div>
          <p className="detail-copy">{detail.summary || '暂无摘要'}</p>
          {detail.people && detail.people.length > 0 && (
            <section className="people-block">
              <div className="subsection-title">
                <Bot size={15} />
                <strong>出现的用户 ID</strong>
              </div>
              <div className="person-list">
                {detail.people.map((person) => (
                  <div key={person.userId} className="person-row">
                    <div>
                      <strong>{person.displayName || person.userId}</strong>
                      <span>{person.senderType || 'user'} · {person.userId} · {person.messageCount} 条</span>
                    </div>
                    {person.senderType === 'app' ? (
                      <StatusPill status="idle" label="应用" />
                    ) : (
                      <div className="role-control">
                        <StatusPill status={roleStatus(person.role)} label={roleLabel(person.role)} />
                        <select
                          className="role-select"
                          value={person.role || ''}
                          onChange={(event) => {
                            const nextRole = event.target.value as PermissionRole | '';
                            if (nextRole) void setSessionPersonRole(person, nextRole);
                          }}
                        >
                          <option value="">设置权限</option>
                          <option value="viewer">Viewer</option>
                          <option value="operator">Operator</option>
                          <option value="owner">Owner</option>
                        </select>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
          <div className="command-band dense">
            <MiniButton label="复制摘要" icon={<Clipboard size={14} />} onClick={() => void navigator.clipboard.writeText(detail.summary || '')} />
            <MiniButton label="复制消息" icon={<Clipboard size={14} />} onClick={() => void navigator.clipboard.writeText(detail.messages.map((item) => `[${item.index}] ${item.role} ${item.createdAt}\n${item.content}`).join('\n\n'))} />
          </div>
          <dl className="kv">
            <dt>ChatId</dt><dd>{detail.chatId || '-'}</dd>
            <dt>Session</dt><dd>{detail.sessionId || '-'}</dd>
            <dt>SDK</dt><dd>{detail.sdkSessionId || '-'}</dd>
            <dt>CWD</dt><dd>{detail.workingDirectory || '-'}</dd>
            <dt>本地绑定</dt><dd>{detail.hasLocalBinding ? '是' : '否'}</dd>
            <dt>消息数</dt><dd>{detail.messages.length}</dd>
            <dt>运行记录</dt><dd>{detail.workflowRuns?.length ?? 0}</dd>
          </dl>
          <div className="message-stream">
            {orderedMessages.map((message) => (
              <article key={`${message.index}-${message.createdAt}`} className="message-card">
                <header>
                  <div>
                    <strong>{message.senderName || message.role}</strong>
                    <span>{message.msgType || 'message'} · {message.createdAt || '-'}</span>
                  </div>
                  <div className="message-card-actions">
                    {message.recallStatus === 'recalled' && <StatusPill status="idle" label="已撤回" />}
                    {message.recallStatus === 'failed' && <StatusPill status="warning" label="撤回失败" />}
                    {message.canRecall && (
                      <MiniButton
                        label="撤回"
                        icon={<Trash2 size={14} />}
                        onClick={() => {
                          if (!detail) return;
                          if (!window.confirm('撤回这条机器人消息？撤回后群里将不再显示这条消息。')) return;
                          void run('history.recallBotMessage', {
                            channelType: detail.channelType,
                            chatId: detail.chatId,
                            sessionId: detail.sessionId,
                            messageId: message.messageId,
                            senderType: message.senderType,
                            senderId: message.senderId,
                          })
                            .then(() => refreshDetail())
                            .catch(() => refreshDetail());
                        }}
                        pending={pending['history.recallBotMessage']}
                      />
                    )}
                  </div>
                </header>
                {message.recallError && <div className="message-recall-error">{message.recallError}</div>}
                {message.senderId && (
                  <div className="message-sender-meta">
                    <span>{message.role}</span>
                    <code>{message.senderId}</code>
                  </div>
                )}
                {message.cardContent && (
                  <section className="message-card-content">
                    <div className="message-card-content-title">
                      <FileText size={14} />
                      <strong>卡片内容</strong>
                    </div>
                    <pre>{message.cardContent}</pre>
                    {message.rawContentPreview && (
                      <details className="message-raw-preview">
                        <summary>原始卡片摘要</summary>
                        <code>{message.rawContentPreview}</code>
                      </details>
                    )}
                  </section>
                )}
                {shouldShowPlainMessageContent(message) && <pre>{message.content}</pre>}
                {message.attachments && message.attachments.length > 0 && (
                  <div className="attachment-grid">
                    {message.attachments.map((attachment, index) => (
                      <div key={`${message.index}-${attachment.resourceKey || attachment.path || index}`} className="attachment-item">
                        {attachment.kind === 'image' && attachment.url ? (
                          <a href={attachment.url} target="_blank" rel="noreferrer" title={attachment.path || attachment.name}>
                            <img src={attachment.url} alt={attachment.name || '图片'} />
                          </a>
                        ) : (
                          <div className="attachment-file-icon">
                            {attachment.kind === 'image' ? <ImageIcon size={20} /> : <FileText size={20} />}
                          </div>
                        )}
                        <div>
                          <strong>{attachment.name || attachment.resourceKey || '附件'}</strong>
                          <span>{attachment.mimeType || attachment.kind} · {formatBytes(attachment.size)} · {attachment.status || '-'}</span>
                          {attachment.path && <code>{attachment.path}</code>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {(conversationTimeline.messageRuns.get(conversationMessageKey(message)) ?? []).length > 0 && (
                  <section className="message-run-block">
                    <div className="subsection-title">
                      <Activity size={15} />
                      <strong>这条消息触发的运行历程</strong>
                    </div>
                    <div className="run-timeline">
                      {(conversationTimeline.messageRuns.get(conversationMessageKey(message)) ?? []).map((link) => (
                        <WorkflowRunCard
                          key={link.run.id}
                          runItem={link.run}
                          run={run}
                          pending={pending}
                          refreshDetail={refreshDetail}
                          linkReason={link.linkReason}
                        />
                      ))}
                    </div>
                  </section>
                )}
              </article>
            ))}
            {orderedMessages.length === 0 && <div className="empty-inline">这条会话暂无可展示消息，可能是远端历史同步失败或本地索引缺少消息内容。</div>}
          </div>
          <section className="run-timeline-block">
            <div className="subsection-title">
              <Activity size={15} />
              <strong>未归并到具体消息的运行记录</strong>
            </div>
            <div className="run-timeline">
              {unlinkedRuns.map((link) => (
                <WorkflowRunCard
                  key={link.run.id}
                  runItem={link.run}
                  run={run}
                  pending={pending}
                  refreshDetail={refreshDetail}
                  linkReason={undefined}
                />
              ))}
              {unlinkedRuns.length === 0 && <div className="empty-inline">所有 workflow run 都已归并到对应消息。</div>}
            </div>
          </section>
        </div>
      ) : (
        <div className="empty-inline">{detailLoading ? '加载中…' : detailError || '点击左侧会话后，在这里查看完整消息流。'}</div>
      )}
    </aside>
  );
});

const knowledgeKinds = [
  { id: 'all', label: '全部' },
  { id: 'fact', label: '事实' },
  { id: 'conclusion', label: '结论' },
  { id: 'todo', label: '待办' },
  { id: 'resource', label: '资源' },
] as const;

const visualKnowledgeKinds = knowledgeKinds.filter((item) => item.id !== 'all');

const memorySourceGroups = [
  { id: 'all', label: '全部来源' },
  { id: 'memory_user', label: '用户记忆' },
  { id: 'memory_group', label: '群聊记忆' },
  { id: 'memory_long_term', label: '长期记忆' },
  { id: 'direct_reminder', label: '直接提醒' },
  { id: 'other', label: '其他来源' },
] as const;

function memorySourceGroupLabel(group: string) {
  return memorySourceGroups.find((item) => item.id === group)?.label || group || '未知来源';
}

type MemorySourceBucket = 'primary' | 'summary' | 'context';

function memorySourceBucket(group: string): MemorySourceBucket {
  switch (group) {
    case 'memory_user':
    case 'memory_group':
    case 'memory_long_term':
    case 'direct_reminder':
      return 'primary';
    // 只把显式声明为摘要类的旧/外部来源放进摘要分区；v2 主记忆不再生成 summary 源。
    case 'generated_summary':
    case 'memory_summary':
      return 'summary';
    case 'other':
    default:
      return 'context';
  }
}

function pickDefaultMemoryItem(items: KnowledgeSearchItem[]) {
  return items.find((item) => memorySourceBucket(item.sourceGroup || 'other') === 'primary') ?? items[0];
}

function knowledgeKindLabel(kind: string) {
  switch (kind) {
    case 'fact':
      return '事实';
    case 'conclusion':
      return '结论';
    case 'todo':
      return '待办';
    case 'resource':
      return '资源';
    default:
      return kind || '未分类';
  }
}

function reminderStatusLabel(status: string) {
  switch ((status || '').toLowerCase()) {
    case 'pending':
      return '待发送';
    case 'sent':
      return '已发送';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'skipped':
      return '跳过';
    default:
      return status || '未知';
  }
}

function reminderStatusKind(status: string): StatusKind {
  switch ((status || '').toLowerCase()) {
    case 'completed':
    case 'sent':
      return 'ok';
    case 'failed':
      return 'error';
    case 'skipped':
      return 'warning';
    case 'pending':
      return 'idle';
    default:
      return 'idle';
  }
}

function MemoryDataGrid<T extends object>({
  data,
  columns,
  emptyText,
}: {
  data: T[];
  columns: Array<ColumnDef<T>>;
  emptyText: string;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="memory-grid-shell">
      <table className="memory-data-grid">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th key={header.id} style={{ width: header.getSize() || undefined }}>
                  {header.isPlaceholder ? null : (
                    <button
                      type="button"
                      className={header.column.getCanSort() ? 'grid-sort-button' : 'grid-sort-button disabled'}
                      onClick={header.column.getToggleSortingHandler()}
                      disabled={!header.column.getCanSort()}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getCanSort() && <ArrowDownUp size={12} />}
                    </button>
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.length === 0 && <div className="empty-inline">{emptyText}</div>}
    </div>
  );
}

function MemoryRelationTree({
  selected,
  groups,
  items,
  selectedId,
  onSelect,
  onOpenSource,
  pending,
}: {
  selected?: KnowledgeSearchItem;
  groups: MemoryRelationGroup[];
  items: KnowledgeSearchItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  onOpenSource: (pathValue: string) => void;
  pending: boolean;
}) {
  const primaryItems = items.filter((item) => memorySourceBucket(item.sourceGroup || 'other') === 'primary');
  const summaryItems = items.filter((item) => memorySourceBucket(item.sourceGroup || 'other') === 'summary');
  const contextItems = items.filter((item) => memorySourceBucket(item.sourceGroup || 'other') === 'context');
  const renderPick = (item: KnowledgeSearchItem) => (
    <button
      key={item.id}
      className={item.id === selectedId ? 'memory-pick active' : 'memory-pick'}
      type="button"
      onClick={() => onSelect(item.id)}
    >
      <span>{displayMemoryTitle(item)}</span>
      <small>{memorySourceGroupLabel(item.sourceGroup || 'other')} · {knowledgeKindLabel(item.kind)} · {Math.round((item.confidence || 0) * 100)}%</small>
    </button>
  );

  return (
    <div className="memory-tree-layout">
      <aside className="memory-tree-picker" aria-label="记忆选择">
        <strong>记忆列表</strong>
        <div className="memory-tree-picker-list">
          <section className="memory-source-section">
            <header>
              <span>普通记忆</span>
              <small>{primaryItems.length}</small>
            </header>
            {primaryItems.length > 0 ? primaryItems.map(renderPick) : (
              <div className="empty-inline">当前结果里没有显式记忆或直接提醒。</div>
            )}
          </section>
          {summaryItems.length > 0 && (
            <details className="memory-source-section" open={summaryItems.some((item) => item.id === selectedId)}>
              <summary>
                <span>生成摘要</span>
                <small>{summaryItems.length}</small>
              </summary>
              <div className="memory-source-section-body">
                {summaryItems.map(renderPick)}
              </div>
            </details>
          )}
          {contextItems.length > 0 && (
            <details className="memory-source-section" open={contextItems.some((item) => item.id === selectedId)}>
              <summary>
                <span>上下文 / 索引资料</span>
                <small>{contextItems.length}</small>
              </summary>
              <p>这些条目用于让 Codex 理解工程、文档和历史索引，默认不当成普通记忆整理。</p>
              <div className="memory-source-section-body">
                {contextItems.map(renderPick)}
              </div>
            </details>
          )}
          {items.length === 0 && <div className="empty-inline">先搜索或等待记忆索引生成后，这里会出现可展开的记忆。</div>}
        </div>
      </aside>
      <div className="memory-tree-canvas">
        {selected ? (
          <>
            <article className={selected.conflict ? 'memory-center attention' : 'memory-center normal'}>
              <span className="blueprint-icon"><Database size={20} /></span>
              <div>
                <strong>{displayMemoryTitle(selected)}</strong>
                <p>{displayMemoryValue(selected)}</p>
                <div className="memory-center-meta">
                  <StatusPill status={selected.conflict ? 'warning' : 'ok'} label={knowledgeKindLabel(selected.kind)} />
                  <span>{Math.round((selected.confidence || 0) * 100)}% 可信</span>
                  {selected.sourcePath && (
                    <MiniButton
                      label="来源"
                      icon={<ExternalLink size={14} />}
                      onClick={() => onOpenSource(selected.sourcePath)}
                      pending={pending}
                    />
                  )}
                </div>
              </div>
            </article>
            <div className="memory-branches">
              {groups.map((group) => (
                <section key={group.id} className={`memory-branch-group ${group.status}`}>
                  <header>
                    <span>{group.title}</span>
                    <StatusPill status={userStatusKind(group.status)} label={userStatusLabel(group.status)} />
                  </header>
                  <div className="memory-branch-items">
                    {group.items.length > 0 ? group.items.map((item) => (
                      <article key={item.id} className={`memory-branch-item ${item.status}`}>
                        <span>{item.relation}</span>
                        <strong>{item.label}</strong>
                        <p>{item.detail}</p>
                      </article>
                    )) : (
                      <article className="memory-branch-item disabled">
                        <span>暂无</span>
                        <strong>没有发现{group.title}</strong>
                        <p>这不是错误，只表示当前记忆没有这类联系。</p>
                      </article>
                    )}
                  </div>
                </section>
              ))}
            </div>
          </>
        ) : (
          <EmptyState icon={<Database size={30} />} title="还没有可展开的记忆" text="搜索关键词或等待索引生成后，关系树会围绕选中的记忆展开。" />
        )}
      </div>
    </div>
  );
}

function MemoryPage({
  state,
  run,
  pending,
  refreshRevision,
}: {
  state: PanelState;
  run: PageProps['run'];
  pending: Record<string, boolean>;
  refreshRevision: number;
}) {
  const [status, setStatus] = useState<KnowledgeIndexStatus>(state.memory);
  const reminders = state.memoryReminders;
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<(typeof knowledgeKinds)[number]['id']>('all');
  const [sourceGroup, setSourceGroup] = useState<MemorySourceGroup>('all');
  const [gridView, setGridView] = useState<'items' | 'nodes' | 'edges'>('items');
  const [selectedMemoryId, setSelectedMemoryId] = useState('');
  const [items, setItems] = useState<KnowledgeSearchItem[]>([]);
  const [searchMeta, setSearchMeta] = useState({ totalMatched: 0, offset: 0, limit: 200 });
  const [stickerLibrary, setStickerLibrary] = useState<FeishuStickerLibrarySnapshot>({ schema: '', storePath: '', mediaDir: '', updatedAt: '', stickers: [] });
  const [stickerSemantics, setStickerSemantics] = useState<StickerSemanticPanelState>({
    baseHash: '', generatedAt: '', humanArchivePath: '', humanArchiveExists: false, assets: [], revisions: [],
  });
  const [stickerQuery, setStickerQuery] = useState('');
  const [stickerStatusFilter, setStickerStatusFilter] = useState<StickerStatusFilter>('asset');
  const [stickerChatFilter, setStickerChatFilter] = useState('all');
  const [editingStickerKey, setEditingStickerKey] = useState('');
  const [editingSticker, setEditingSticker] = useState<Partial<FeishuStickerLibraryItem>>({});
  const [aliasDrafts, setAliasDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const memoryQueryRefreshKey = buildMemoryQueryRefreshKey(kind, sourceGroup, refreshRevision);

  useEffect(() => setStatus(state.memory), [state.memory]);

  const refreshStatus = async () => {
    setError('');
    const next = await run('memory.status') as KnowledgeIndexStatus;
    setStatus(next);
  };

  const refreshStickerLibrary = async () => {
    const next = await run('memory.feishuStickers') as FeishuStickerLibrarySnapshot;
    setStickerLibrary({
      ...next,
      stickers: Array.isArray(next.stickers) ? next.stickers : [],
    });
  };

  const refreshStickerSemantics = async () => {
    const [statusEnvelope, listEnvelope] = await Promise.all([
      run('memory.stickerSemantics.status'),
      run('memory.stickerSemantics.list'),
    ]);
    const semanticStatus = readStickerSemanticCliData<{
      baseHash: string;
      generatedAt: string;
      humanArchivePath: string;
      humanArchiveExists?: boolean;
    }>(statusEnvelope);
    const semanticList = readStickerSemanticCliData<{
      assets?: StickerSemanticAsset[];
      revisions?: StickerSemanticRevision[];
    }>(listEnvelope);
    setStickerSemantics({
      baseHash: semanticStatus.baseHash || '',
      generatedAt: semanticStatus.generatedAt || '',
      humanArchivePath: semanticStatus.humanArchivePath || '',
      humanArchiveExists: semanticStatus.humanArchiveExists === true,
      assets: Array.isArray(semanticList.assets) ? semanticList.assets : [],
      revisions: Array.isArray(semanticList.revisions) ? semanticList.revisions : [],
    });
  };

  const refreshStickerWorkspace = async () => {
    await Promise.all([refreshStickerLibrary(), refreshStickerSemantics()]);
  };

  const beginEditSticker = (item: FeishuStickerLibraryItem) => {
    setEditingStickerKey(item.fileKey);
    setEditingSticker({
      label: item.label,
      description: item.description,
      intent: item.intent,
      tone: item.tone,
      usage: item.usage,
      avoidWhen: item.avoidWhen,
      disabled: item.disabled,
      disabledReason: item.disabledReason,
    });
  };

  const updateStickerDraft = (key: keyof FeishuStickerLibraryItem, value: string | boolean) => {
    setEditingSticker((current) => ({ ...current, [key]: value }));
  };

  const saveSticker = async (fileKey: string) => {
    setError('');
    if (!stickerSemantics.baseHash) throw new Error('表情包语义状态尚未加载，请先刷新。');
    await run('memory.stickerSemantics.updateManual', {
      fileKey,
      expectedBaseHash: stickerSemantics.baseHash,
      patch: {
        label: editingSticker.label ?? '',
        description: editingSticker.description ?? '',
        intent: editingSticker.intent ?? '',
        tone: editingSticker.tone ?? '',
        usage: editingSticker.usage ?? '',
        avoidWhen: editingSticker.avoidWhen ?? '',
        disabled: editingSticker.disabled === true,
        disabledReason: editingSticker.disabledReason ?? '',
      },
    });
    await refreshStickerWorkspace();
    setEditingStickerKey('');
    setEditingSticker({});
  };

  const toggleStickerDisabled = async (item: FeishuStickerLibraryItem) => {
    setError('');
    const disabled = !item.disabled;
    await run('memory.stickerSemantics.updateManual', {
      fileKey: item.fileKey,
      expectedBaseHash: stickerSemantics.baseHash,
      patch: {
        disabled,
        disabledReason: disabled ? (item.disabledReason || '控制面板禁用') : '',
      },
    });
    await refreshStickerWorkspace();
  };

  const mergeStickerAliases = async (fileKey: string) => {
    const aliases = (aliasDrafts[fileKey] || '').trim();
    if (!aliases) return;
    setError('');
    const nextAliases = aliases.split(/[,，\n]+/u).map((item) => item.trim()).filter(Boolean);
    const currentAliases = stickerLibrary.stickers.find((item) => item.fileKey === fileKey)?.aliases || [];
    await run('memory.stickerSemantics.updateManual', {
      fileKey,
      expectedBaseHash: stickerSemantics.baseHash,
      patch: { aliases: Array.from(new Set([...currentAliases, ...nextAliases])) },
    });
    await refreshStickerWorkspace();
    setAliasDrafts((current) => ({ ...current, [fileKey]: '' }));
  };

  const archiveSticker = async (item: FeishuStickerLibraryItem) => {
    setError('');
    await run('memory.stickerSemantics.archive', { fileKey: item.fileKey, expectedBaseHash: stickerSemantics.baseHash });
    await refreshStickerWorkspace();
    if (editingStickerKey === item.fileKey) {
      setEditingStickerKey('');
      setEditingSticker({});
    }
  };

  const restoreSticker = async (item: FeishuStickerLibraryItem) => {
    setError('');
    await run('memory.stickerSemantics.restore', { fileKey: item.fileKey, expectedBaseHash: stickerSemantics.baseHash });
    await refreshStickerWorkspace();
  };

  const deleteSticker = async (item: FeishuStickerLibraryItem) => {
    const title = item.label || item.aliases[0] || item.fileKey;
    if (!window.confirm(`永久删除已归档表情包“${title}”？\n\n记录和本地缓存图片会被删除，并保留防止历史同步复活的删除标记。该操作不可恢复。`)) return;
    setError('');
    await run('memory.stickerSemantics.deleteArchived', { fileKey: item.fileKey, expectedBaseHash: stickerSemantics.baseHash });
    await refreshStickerWorkspace();
    setAliasDrafts((current) => {
      const copy = { ...current };
      delete copy[item.fileKey];
      return copy;
    });
  };

  const applyStickerRevisionAction = async (revision: StickerSemanticRevision, action: StickerRevisionAction) => {
    const command = action === 'accept'
      ? 'memory.stickerSemantics.acceptRevision'
      : action === 'reject'
        ? 'memory.stickerSemantics.rejectRevision'
        : 'memory.stickerSemantics.rollback';
    await run(command, { revisionId: revision.revisionId, expectedBaseHash: stickerSemantics.baseHash });
    await refreshStickerSemantics();
  };

  const search = async (nextOffset = searchMeta.offset) => {
    setError('');
    try {
      const result = await run('memory.search', {
        query,
        kinds: kind === 'all' ? [] : [kind],
        sourceGroup,
        offset: nextOffset,
        limit: 200,
      }) as KnowledgeSearchResponse;
      const nextItems = Array.isArray(result.items) ? result.items : [];
      setStatus(result.status);
      setItems(nextItems);
      setSearchMeta({
        totalMatched: result.totalMatched ?? nextItems.length,
        offset: result.offset ?? nextOffset,
        limit: result.limit ?? 200,
      });
      setSelectedMemoryId((current) => nextItems.some((item) => item.id === current) ? current : pickDefaultMemoryItem(nextItems)?.id ?? '');
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : '搜索失败');
    }
  };

  useEffect(() => {
    void search(0);
  }, [memoryQueryRefreshKey]);

  useEffect(() => {
    void refreshStickerWorkspace();
  }, [refreshRevision]);
  const statusKind: StatusKind = status.lastError
    ? 'error'
    : status.exists
      ? 'ok'
      : 'warning';
  const kindCounts = status.kindCounts ?? {};
  const visibleKindCounts = visualKnowledgeKinds.map((item) => ({
    ...item,
    count: kindCounts[item.id] ?? 0,
  }));
  const maxKindCount = Math.max(1, ...visibleKindCounts.map((item) => item.count));
  const conflictRatio = status.itemCount > 0 ? Math.round(((status.conflictCount ?? 0) / status.itemCount) * 100) : 0;
  const pipelineSteps = [
    { label: '文件读取', detail: `${status.markdownFileCount ?? 0} 个文件`, ok: (status.markdownFileCount ?? 0) > 0 },
    { label: '关系整理', detail: status.exists ? '已生成' : '未生成', ok: status.exists },
    { label: '自动监听', detail: status.watching ? '运行中' : '未运行', ok: status.watching },
    { label: '可供使用', detail: status.exists && !status.lastError ? '已就绪' : '等待整理', ok: status.exists && !status.lastError },
  ];
  const graphNodes = status.memoryGraphPreview?.nodes ?? [];
  const graphEdges = status.memoryGraphPreview?.edges ?? [];
  const selectedMemory = items.find((item) => item.id === selectedMemoryId) ?? pickDefaultMemoryItem(items);
  const stickerChatOptions = useMemo(() => {
    return Array.from(new Set(stickerLibrary.stickers.map((item) => item.chatId).filter(Boolean))).sort();
  }, [stickerLibrary.stickers]);
  const visibleStickers = useMemo(() => {
    const queryText = stickerQuery.trim().toLowerCase();
    return stickerLibrary.stickers.filter((item) => {
      if (!matchesStickerStatusFilter(item, stickerStatusFilter)) return false;
      if (stickerChatFilter !== 'all' && item.chatId !== stickerChatFilter) return false;
      if (!queryText) return true;
      const haystack = [
        item.label,
        item.description,
        item.intent,
        item.tone,
        item.usage,
        item.avoidWhen,
        item.chatId,
        ...item.aliases,
        ...item.examples,
      ].join('\n').toLowerCase();
      return haystack.includes(queryText);
    });
  }, [stickerLibrary.stickers, stickerQuery, stickerStatusFilter, stickerChatFilter]);
  const stickerStats = useMemo(() => {
    const total = stickerLibrary.stickers.length;
    const disabled = stickerLibrary.stickers.filter((item) => item.disabled && !item.archived).length;
    const archived = stickerLibrary.stickers.filter((item) => item.archived).length;
    const trusted = stickerLibrary.stickers.filter((item) => item.hasTrustedSemantic).length;
    const cached = stickerLibrary.stickers.filter((item) => item.hasMedia).length;
    const userOnly = stickerLibrary.stickers.filter((item) => item.hasUserAnnotation && !item.hasTrustedSemantic).length;
    const failed = stickerLibrary.stickers.filter((item) => item.hasMediaDownloadFailure || item.mediaDownloadFailedAt || item.mediaDownloadError).length;
    const historyOnly = stickerLibrary.stickers.filter((item) => item.isHistoryOnly === true).length;
    const assets = stickerLibrary.stickers.filter((item) => item.isLibraryAsset !== false && !item.archived).length;
    const enabled = stickerLibrary.stickers.filter((item) => item.isLibraryAsset !== false && !item.disabled && !item.archived).length;
    return { total, assets, enabled, disabled, archived, trusted, cached, userOnly, failed, historyOnly };
  }, [stickerLibrary.stickers]);
  const stickerEvolutionSummary = useMemo(
    () => buildStickerEvolutionSummary(stickerSemantics.revisions),
    [stickerSemantics.revisions],
  );
  const stickerSemanticAssets = useMemo(
    () => new Map(stickerSemantics.assets.map((asset) => [asset.fileKey, asset])),
    [stickerSemantics.assets],
  );
  const memoryRelationGroups = useMemo(() => buildMemoryRelationGroups(selectedMemory, reminders), [selectedMemory, reminders]);
  const memoryLayout = status.layout;
  const agentHomeEntries = memoryLayout?.agentHome?.length
    ? memoryLayout.agentHome
    : buildAgentHomeEntries(status.memoryRoot || state.paths.memoryRepo).map((item) => ({ ...item, exists: false }));
  const memoryLayoutSummary = buildMemoryLayoutSummary(memoryLayout);
  const selfMaintenanceMetrics = buildSelfMaintenanceMetrics(memoryLayout?.selfMaintenance);
  const itemColumns = useMemo<Array<ColumnDef<KnowledgeSearchItem>>>(() => [
    {
      accessorKey: 'kind',
      header: '类型',
      cell: ({ row }) => <StatusPill status={row.original.conflict ? 'warning' : 'ok'} label={knowledgeKindLabel(row.original.kind)} />,
      size: 92,
    },
    {
      id: 'memory',
      header: '记忆',
      accessorFn: (row) => row.key ? `${row.key} = ${row.value || row.text}` : row.text,
      cell: ({ row }) => (
        <div className="grid-main-cell">
          <strong>{row.original.key ? `${row.original.key} = ${row.original.value || row.original.text}` : row.original.text}</strong>
          <span>{row.original.snippet || row.original.text}</span>
        </div>
      ),
      size: 360,
    },
    {
      id: 'confidence',
      header: '置信度',
      accessorFn: (row) => row.confidence || 0,
      cell: ({ row }) => `${Math.round((row.original.confidence || 0) * 100)}%`,
      size: 88,
    },
    {
      id: 'related',
      header: '相关对象',
      accessorFn: (row) => row.related?.length ?? 0,
      cell: ({ row }) => (row.original.related ?? []).slice(0, 4).map((related) => `${related.label}（${relationTypeLabel(related.type)}）`).join('；') || '-',
      size: 240,
    },
    {
      id: 'classification',
      header: '分类原因',
      accessorFn: (row) => row.classificationReason || row.classificationSource || '',
      cell: ({ row }) => row.original.classificationReason || row.original.classificationSource || '-',
      size: 210,
    },
    {
      id: 'source',
      header: '来源',
      accessorFn: (row) => row.sourcePath,
      cell: ({ row }) => (
        <div className="grid-main-cell">
          <span>{memorySourceGroupLabel(row.original.sourceGroup || 'other')}</span>
          <code>{row.original.sourcePath || '-'}</code>
        </div>
      ),
      size: 260,
    },
    {
      id: 'updated',
      header: '更新时间',
      accessorFn: (row) => row.sourceUpdatedAt || '',
      cell: ({ row }) => row.original.sourceUpdatedAt || '-',
      size: 180,
    },
    {
      id: 'actions',
      header: '操作',
      enableSorting: false,
      cell: ({ row }) => (
        <div className="grid-actions">
          <MiniButton label="来源" icon={<ExternalLink size={14} />} onClick={() => void run('memory.openSource', { path: row.original.sourcePath })} pending={pending['memory.openSource']} />
        </div>
      ),
      size: 110,
    },
  ], [pending, run]);
  const nodeColumns = useMemo<Array<ColumnDef<{ id: string; label: string; kind: string }>>>(() => [
    { accessorKey: 'label', header: '相关对象', cell: ({ row }) => <strong>{row.original.label}</strong>, size: 260 },
    { accessorKey: 'kind', header: '类型', cell: ({ row }) => row.original.kind || '-', size: 120 },
    { accessorKey: 'id', header: 'ID', cell: ({ row }) => <code>{row.original.id}</code>, size: 220 },
  ], []);
  const edgeColumns = useMemo<Array<ColumnDef<{ from: string; to: string; fromLabel?: string; toLabel?: string; type: string; weight: number }>>>(() => [
    { id: 'from', header: '从', accessorFn: (row) => row.fromLabel || row.from, cell: ({ row }) => row.original.fromLabel || row.original.from, size: 240 },
    { id: 'type', header: '联系', accessorFn: (row) => row.type, cell: ({ row }) => relationTypeLabel(row.original.type), size: 140 },
    { id: 'to', header: '到', accessorFn: (row) => row.toLabel || row.to, cell: ({ row }) => row.original.toLabel || row.original.to, size: 240 },
    { id: 'weight', header: '权重', accessorFn: (row) => row.weight || 0, cell: ({ row }) => (row.original.weight || 0).toFixed(2), size: 90 },
  ], []);

  return (
    <section className="content-stack">
      <section className="panel">
        <SectionHeader title="Agent Home 与记忆布局" />
        <p className="panel-intro">身份、规则、工具、说明和总索引集中放在记忆库根目录；总索引只引用真实分区文件，不作为第二事实源。</p>
        <div className="summary-grid wide">
          <Metric label="布局" value={memoryLayout?.layoutVersion || 'none'} compact />
          <Metric label="v3 来源" value={String(memoryLayout?.v3SourceCount ?? 0)} compact />
          <Metric label="待迁移 v2" value={String(memoryLayout?.legacySourceCount ?? 0)} compact />
          <Metric label="迁移状态" value={memoryLayoutSummary.migrationLabel} compact />
          <Metric label="未归类根文档" value={String(memoryLayoutSummary.unclassifiedCount)} compact />
        </div>
        <p className="panel-intro">身份、规则和工具文档每轮重新读取；只有确认是 Agent 自身错误且引用真实证据时才自动改写。所有核心改写都会保留版本、纠错记录和审计，可从受控历史回滚。</p>
        <div className="summary-grid wide">
          {selfMaintenanceMetrics.map((item) => (
            <Metric key={item.label} label={item.label} value={item.value} compact />
          ))}
          <Metric label="最近自维护" value={memoryLayout?.selfMaintenance?.lastUpdatedAt || '尚无'} compact />
        </div>
        <div className="runtime-list compact-list">
          {agentHomeEntries.map((item) => (
            <article key={item.name} className="runtime-row">
              <div><strong>{item.name}</strong><code>{item.path}</code></div>
              <div className="row-actions">
                <StatusPill status={item.exists ? 'ok' : 'warning'} label={item.exists ? '已创建' : '缺失'} />
                <MiniButton label="打开" icon={<ExternalLink size={14} />} onClick={() => void run('path.openAny', { path: item.path })} disabled={!item.exists} />
              </div>
            </article>
          ))}
        </div>
        {memoryLayoutSummary.unclassifiedRootDocuments.length > 0 && (
          <div className="runtime-list compact-list">
            {memoryLayoutSummary.unclassifiedRootDocuments.map((item) => (
              <article key={item.path} className="runtime-row">
                <div><strong>{item.name}</strong><code>{item.path}</code></div>
                <div className="row-actions">
                  <StatusPill status="warning" label="未归类" />
                  <MiniButton label="打开" icon={<ExternalLink size={14} />} onClick={() => void run('path.openAny', { path: item.path })} />
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <MemoryLifecyclePanel run={run} pending={pending} refreshRevision={refreshRevision} />
      <section className="panel memory-tree-primary">
        <SectionHeader
          title="记忆关系树"
          action={<MiniButton label="搜索" icon={<Search size={14} />} onClick={() => void search()} pending={pending['memory.search']} />}
        />
        <p className="panel-intro">左侧按来源分开：普通记忆默认展开，上下文文档和索引资料默认折叠；选中一条后，右侧展开它对应到什么、关联了哪些资源、是否带提醒或冲突。</p>
        <div className="filter-row">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter') void search();
          }} placeholder="搜索场景名、文件名、结论或记忆片段" />
        </div>
        <div className="preset-wall">
          {knowledgeKinds.map((item) => (
            <button key={item.id} className={kind === item.id ? 'preset-chip active' : 'preset-chip'} onClick={() => setKind(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        <div className="preset-wall">
          {memorySourceGroups.map((item) => (
            <button key={item.id} className={sourceGroup === item.id ? 'preset-chip active' : 'preset-chip'} onClick={() => setSourceGroup(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        {error && <div className="empty-inline">{error}</div>}
        <MemoryRelationTree
          selected={selectedMemory}
          groups={memoryRelationGroups}
          items={items}
          selectedId={selectedMemory?.id ?? selectedMemoryId}
          onSelect={setSelectedMemoryId}
          onOpenSource={(pathValue) => void run('memory.openSource', { path: pathValue })}
          pending={pending['memory.openSource']}
        />
        {searchMeta.totalMatched > items.length && (
          <div className="detail-meta">当前已显示 {items.length} / {searchMeta.totalMatched} 条。结果过多时，请用搜索或来源筛选缩小范围。</div>
        )}
      </section>

      <section className="panel">
        <SectionHeader title="Skill 资产索引" />
        <p className="panel-intro">这里只引用 Registry 元数据和真实来源路径，不读取或复制 SKILL.md 正文。安装、启停、审批和更新统一在“能力 → Skills”中维护。</p>
        <div className="detail-meta">协议 {state.memorySkillAssets.protocol || '-'} · 索引时间 {state.memorySkillAssets.generatedAt || '-'} · 共 {state.memorySkillAssets.items.length} 项</div>
        <div className="runtime-list compact-list">
          {state.memorySkillAssets.items.map((item) => (
            <article key={item.id} className="runtime-row">
              <div>
                <strong>{item.displayName || item.id}</strong>
                <span>ID {item.id} · 状态 {item.state || '-'} · 来源类别 {item.sourceClass || '-'} · 风险 {item.risk || '-'}</span>
                <p>{item.version ? `版本 ${item.version} · ` : ''}{item.enabled ? '当前启用' : '当前未启用'}{item.updatedAt ? ` · 更新 ${item.updatedAt}` : ''}</p>
                <code>{item.sourcePath || '-'}</code>
              </div>
              <div className="row-actions">
                <StatusPill
                  status={item.risk === 'high' || item.state === 'quarantined' ? 'warning' : item.enabled ? 'ok' : 'idle'}
                  label={item.state || (item.enabled ? 'enabled' : 'disabled')}
                />
                <MiniButton
                  label="来源"
                  icon={<ExternalLink size={14} />}
                  onClick={() => void run('memory.openSource', { path: item.sourcePath })}
                  pending={pending['memory.openSource']}
                  disabled={!item.sourcePath}
                />
              </div>
            </article>
          ))}
          {state.memorySkillAssets.items.length === 0 && <div className="empty-inline">暂无 Skill 资产引用。Registry 可用后会在这里显示元数据索引。</div>}
        </div>
      </section>

      <section className="panel sticker-evolution-panel">
        <SectionHeader
          title="表情包语义进化"
          action={<MiniButton label="刷新" icon={<RefreshCw size={14} />} onClick={() => void refreshStickerSemantics()} pending={pending['memory.stickerSemantics.status'] || pending['memory.stickerSemantics.list']} />}
        />
        <p className="panel-intro">机器 revision 是唯一事实源；每次变更都会同步更新人类可读《表情包语义档案》、记忆总索引和记忆库说明。沉默不自动确认，只有绑定反馈与人工审核推动状态变化。</p>
        <div className="memory-optimizer-summary sticker-evolution-summary">
          <Metric label="试用" value={String(stickerEvolutionSummary.counts.trial)} compact />
          <Metric label="已确认" value={String(stickerEvolutionSummary.counts.confirmed)} compact />
          <Metric label="已回归" value={String(stickerEvolutionSummary.counts.regressed)} compact />
          <Metric label="已拒绝" value={String(stickerEvolutionSummary.counts.rejected)} compact />
          <Metric label="资产" value={String(stickerSemantics.assets.length)} compact />
        </div>
        <div className={stickerSemantics.humanArchiveExists ? 'sticker-archive-status ok' : 'sticker-archive-status warning'}>
          <div>
            <strong>{stickerSemantics.humanArchiveExists ? '人类档案已同步' : '档案未同步'}</strong>
            <span>最近状态时间 {stickerSemantics.generatedAt || '-'}</span>
          </div>
          <code>{stickerSemantics.humanArchivePath || '尚未返回档案路径'}</code>
        </div>
        <div className="sticker-evolution-list">
          {stickerSemantics.revisions
            .slice()
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .map((revision) => {
              const asset = stickerSemanticAssets.get(revision.fileKey);
              const manualLocked = asset?.visual.source === 'manual';
              const actions = getStickerRevisionActions({ status: revision.status, manualLocked });
              const scopeLabel = revision.scope === 'global' ? '全局' : revision.scope === 'chat' ? '当前群聊范围' : '当前用户范围';
              const statusLabel = revision.status === 'trial' ? '试用' : revision.status === 'confirmed' ? '已确认' : revision.status === 'regressed' ? '已回归' : '已拒绝';
              const patchParts = [
                revision.patch.intent ? `意图：${revision.patch.intent}` : '',
                revision.patch.tone ? `语气：${revision.patch.tone}` : '',
                revision.patch.usage ? `用途：${revision.patch.usage}` : '',
                revision.patch.aliases?.length ? `别名：${revision.patch.aliases.join('、')}` : '',
              ].filter(Boolean);
              return (
                <article key={revision.revisionId} className={`sticker-evolution-card ${revision.status}`}>
                  <header>
                    <div>
                      <strong>{asset?.label || asset?.aliases?.[0] || '未命名表情包'}</strong>
                      <span>{scopeLabel} · 更新 {revision.updatedAt || '-'}</span>
                    </div>
                    <StatusPill status={revision.status === 'confirmed' ? 'ok' : revision.status === 'trial' ? 'warning' : 'idle'} label={statusLabel} />
                  </header>
                  <p>{patchParts.length ? patchParts.join('；') : '当前 revision 没有普通语义字段变更。'}</p>
                  <div className="sticker-evidence-counts">
                    <span>支持会话 {revision.supportSessionIds.length}</span>
                    <span>矛盾会话 {revision.contradictionSessionIds.length}</span>
                    {manualLocked && <span>人工事实锁定</span>}
                  </div>
                  {(revision.patch.avoidRules || []).length > 0 && (
                    <div className="sticker-avoid-rules">
                      {revision.patch.avoidRules?.map((rule) => (
                        <div key={rule.id}>
                          <strong>{rule.category}</strong>
                          <span>{rule.condition}</span>
                          <small>{rule.status} · 置信度 {Math.round((rule.confidence || 0) * 100)}% · 支持 {rule.supportCount} / 矛盾 {rule.contradictionCount}</small>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="row-actions">
                    {actions.includes('accept') && <MiniButton label="接受" icon={<CheckCircle2 size={14} />} onClick={() => void applyStickerRevisionAction(revision, 'accept')} pending={pending['memory.stickerSemantics.acceptRevision']} />}
                    {actions.includes('reject') && <MiniButton label="拒绝" icon={<X size={14} />} onClick={() => void applyStickerRevisionAction(revision, 'reject')} pending={pending['memory.stickerSemantics.rejectRevision']} />}
                    {actions.includes('rollback') && <MiniButton label="回滚" icon={<RotateCw size={14} />} onClick={() => void applyStickerRevisionAction(revision, 'rollback')} pending={pending['memory.stickerSemantics.rollback']} />}
                  </div>
                </article>
              );
            })}
          {stickerSemantics.revisions.length === 0 && <div className="empty-inline">暂无语义 revision。旧可信语义迁移后会在这里形成 confirmed baseline。</div>}
        </div>
      </section>

      <section className="panel feishu-sticker-panel">
        <SectionHeader
          title="Feishu 表情包库"
          action={<MiniButton label="刷新" icon={<RefreshCw size={14} />} onClick={() => void refreshStickerWorkspace()} pending={pending['memory.feishuStickers'] || pending['memory.stickerSemantics.status']} />}
        />
        <p className="panel-intro">管理已学习表情包的名称、别名和语义档案；禁用用于暂停发送，归档用于移出日常资产列表。归档项可恢复，再次操作可永久删除。</p>
        <div className="memory-optimizer-summary">
          <Metric label="可管理" value={String(stickerStats.assets)} compact />
          <Metric label="历史 key" value={String(stickerStats.historyOnly)} compact />
          <Metric label="启用" value={String(stickerStats.enabled)} compact />
          <Metric label="禁用" value={String(stickerStats.disabled)} compact />
          <Metric label="归档" value={String(stickerStats.archived)} compact />
          <Metric label="可信语义" value={String(stickerStats.trusted)} compact />
          <Metric label="已缓存图" value={String(stickerStats.cached)} compact />
          <Metric label="仅用户解释" value={String(stickerStats.userOnly)} compact />
          <Metric label="下载失败" value={String(stickerStats.failed)} compact />
        </div>
        <div className="sticker-library-toolbar">
          <div className="filter-row">
            <Search size={14} />
            <input
              value={stickerQuery}
              onChange={(event) => setStickerQuery(event.target.value)}
              placeholder="搜索名称、别名、意图、语气、用法或群聊"
            />
          </div>
          <select value={stickerStatusFilter} onChange={(event) => setStickerStatusFilter(event.target.value as StickerStatusFilter)}>
            <option value="asset">可管理资产</option>
            <option value="all">全部记录</option>
            <option value="enabled">仅启用</option>
            <option value="disabled">仅禁用</option>
            <option value="archived">已归档</option>
            <option value="failed">媒体失败</option>
            <option value="history">仅历史 key</option>
          </select>
          <select value={stickerChatFilter} onChange={(event) => setStickerChatFilter(event.target.value)}>
            <option value="all">全部 chat</option>
            {stickerChatOptions.map((chatId) => <option key={chatId} value={chatId}>{chatId}</option>)}
          </select>
        </div>
        <div className="feishu-sticker-list">
          {visibleStickers.map((item) => {
            const isEditing = editingStickerKey === item.fileKey;
            const title = item.label || item.aliases[0] || '未命名表情包';
            const lifecycleActions = getStickerLifecycleActions(item);
            return (
              <article key={item.fileKey} className={item.archived || item.disabled ? 'feishu-sticker-row disabled' : 'feishu-sticker-row'}>
                <div className="sticker-row-main">
                  <div className="sticker-row-title">
                    <span className="sticker-preview">
                      {item.previewUrl ? <img src={item.previewUrl} alt={title} /> : <ImageIcon size={18} />}
                    </span>
                    <div>
                      <strong>{title}</strong>
                      <span>{item.intent || item.tone || item.usage || item.statusLabel || (item.previewUrl ? '已缓存图片，待视觉标注' : '仅历史 key，无媒体')}</span>
                    </div>
                    <StatusPill status={item.archived || item.disabled || !item.hasTrustedSemantic ? 'warning' : 'ok'} label={item.statusLabel || (item.archived ? '已归档' : item.disabled ? '已禁用' : '启用')} />
                  </div>
                  <div className="sticker-alias-row">
                    {item.aliases.length > 0 ? item.aliases.slice(0, 12).map((alias) => <code key={alias}>{alias}</code>) : <span>暂无别名</span>}
                  </div>
                  {isEditing ? (
                    <div className="sticker-editor-grid">
                      <label>名称<input value={String(editingSticker.label ?? '')} onChange={(event) => updateStickerDraft('label', event.target.value)} /></label>
                      <label>意图<input value={String(editingSticker.intent ?? '')} onChange={(event) => updateStickerDraft('intent', event.target.value)} /></label>
                      <label>语气<input value={String(editingSticker.tone ?? '')} onChange={(event) => updateStickerDraft('tone', event.target.value)} /></label>
                      <label>用法<input value={String(editingSticker.usage ?? '')} onChange={(event) => updateStickerDraft('usage', event.target.value)} /></label>
                      <label>避免场景<input value={String(editingSticker.avoidWhen ?? '')} onChange={(event) => updateStickerDraft('avoidWhen', event.target.value)} /></label>
                      <label>禁用原因<input value={String(editingSticker.disabledReason ?? '')} onChange={(event) => updateStickerDraft('disabledReason', event.target.value)} /></label>
                      <label className="wide">描述<textarea value={String(editingSticker.description ?? '')} onChange={(event) => updateStickerDraft('description', event.target.value)} /></label>
                      <label className="toggle-line">
                        <input type="checkbox" checked={editingSticker.disabled === true} onChange={(event) => updateStickerDraft('disabled', event.target.checked)} />
                        禁用这条语义
                      </label>
                    </div>
                  ) : (
                    <div className="sticker-semantic-grid">
                      <span><strong>描述</strong>{item.description || '-'}</span>
                      <span><strong>语气</strong>{item.tone || '-'}</span>
                      <span><strong>用法</strong>{item.usage || '-'}</span>
                      <span><strong>避免</strong>{item.avoidWhen || '-'}</span>
                    </div>
                  )}
                  <details className="sticker-diagnostics">
                    <summary>诊断字段</summary>
                    <code>{item.fileKey}</code>
                    <span>media: {item.mediaPath || '-'}</span>
                    <span>mediaType: {item.mediaMimeType || '-'}{item.mediaExtensionMismatch ? '（扩展名与真实格式不一致）' : ''}</span>
                    <span>语义来源: {item.annotationSource || '-'}，核验时间 {item.annotationVerifiedAt || '-'}</span>
                    <span>媒体缓存 {item.mediaCachedAt || '-'}，下载失败 {item.mediaDownloadFailedAt || item.mediaDownloadError || '-'}</span>
                    <span>chat: {item.chatId || '-'}</span>
                    <span>使用 {item.useCount} 次，最近收到 {item.lastSeenAt || '-'}，最近发送 {item.lastUsedAt || '-'}</span>
                    <span>置信度 {Math.round((item.annotationConfidence || 0) * 100)}%，最近编辑 {item.lastEditedAt || '-'}</span>
                    <span>归档时间 {item.archivedAt || '-'}</span>
                  </details>
                </div>
                <div className="sticker-row-actions">
                  {isEditing ? (
                    <>
                      <MiniButton label="保存" icon={<CheckCircle2 size={14} />} onClick={() => void saveSticker(item.fileKey)} pending={pending['memory.stickerSemantics.updateManual']} />
                      <MiniButton label="取消" icon={<X size={14} />} onClick={() => { setEditingStickerKey(''); setEditingSticker({}); }} />
                    </>
                  ) : (
                    <>
                      {!item.archived && <MiniButton label="编辑" icon={<Settings size={14} />} onClick={() => beginEditSticker(item)} />}
                      {!item.archived && (
                        <MiniButton
                          label={item.disabled ? '恢复启用' : '禁用'}
                          icon={item.disabled ? <CheckCircle2 size={14} /> : <Trash2 size={14} />}
                          onClick={() => void toggleStickerDisabled(item)}
                          pending={pending['memory.stickerSemantics.updateManual']}
                        />
                      )}
                      {lifecycleActions.includes('archive') && (
                        <MiniButton label="一键归档" icon={<Archive size={14} />} onClick={() => void archiveSticker(item)} pending={pending['memory.stickerSemantics.archive']} />
                      )}
                      {lifecycleActions.includes('restore') && (
                        <MiniButton label="恢复" icon={<RotateCw size={14} />} onClick={() => void restoreSticker(item)} pending={pending['memory.stickerSemantics.restore']} />
                      )}
                      {lifecycleActions.includes('delete') && (
                        <MiniButton label="永久删除" icon={<Trash2 size={14} />} onClick={() => void deleteSticker(item)} pending={pending['memory.stickerSemantics.deleteArchived']} />
                      )}
                    </>
                  )}
                  {!item.archived && <div className="alias-merge-box">
                    <input
                      value={aliasDrafts[item.fileKey] || ''}
                      onChange={(event) => setAliasDrafts((current) => ({ ...current, [item.fileKey]: event.target.value }))}
                      placeholder="合并别名，逗号或换行分隔"
                    />
                    <MiniButton
                      label="合并"
                      icon={<ArrowDownUp size={14} />}
                      onClick={() => void mergeStickerAliases(item.fileKey)}
                      pending={pending['memory.stickerSemantics.updateManual']}
                      disabled={!String(aliasDrafts[item.fileKey] || '').trim()}
                    />
                  </div>}
                </div>
              </article>
            );
          })}
          {visibleStickers.length === 0 && (
            <div className="empty-inline">当前筛选下没有可管理的表情包。收到或导入表情包后，这里会显示可编辑的语义档案。</div>
          )}
        </div>
      </section>

      <section className="memory-visual-grid">
        <section className="panel">
          <SectionHeader title="记忆分布" />
          <div className="memory-bars">
            {visibleKindCounts.map((item) => (
              <div key={item.id} className="memory-bar-row">
                <span>{item.label}</span>
                <div className="memory-bar-track">
                  <div className={`memory-bar-fill kind-${item.id}`} style={{ width: `${Math.max(4, Math.round((item.count / maxKindCount) * 100))}%` }} />
                </div>
                <strong>{item.count}</strong>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <SectionHeader title="来源覆盖" />
          <div className="memory-radar">
            <div>
              <strong>{status.sourceFileCount ?? 0}</strong>
              <span>来源文件</span>
            </div>
            <div>
              <strong>{conflictRatio}%</strong>
              <span>冲突占比</span>
            </div>
            <div>
              <strong>{status.itemCount ?? 0}</strong>
              <span>知识单元</span>
            </div>
          </div>
        </section>
        <section className="panel">
          <SectionHeader title="记忆链路" />
          <div className="memory-pipeline">
            {pipelineSteps.map((step) => (
              <div key={step.label} className={step.ok ? 'memory-pipeline-step ok' : 'memory-pipeline-step'}>
                <span>{step.label}</span>
                <strong>{step.detail}</strong>
              </div>
            ))}
          </div>
        </section>
      </section>

      <details className="panel advanced-diagnostics">
        <summary>
          <span>高级诊断</span>
          <small>索引路径、关系缓存、需要检查的回复</small>
        </summary>
        <div className="advanced-diagnostics-body">
          <section className="diagnostic-section">
        <SectionHeader
          title="索引状态"
          action={<MiniButton label="刷新" icon={<RefreshCw size={14} />} onClick={() => void refreshStatus()} pending={pending['memory.status']} />}
        />
        <div className="summary-grid">
          <Metric label="索引" value={status.exists ? '已生成' : '未生成'} compact />
          <Metric label="监听" value={status.watching ? '运行中' : '未运行'} compact />
          <Metric label="Markdown" value={String(status.markdownFileCount ?? 0)} compact />
          <Metric label="知识单元" value={String(status.itemCount ?? 0)} compact />
          <Metric label="冲突" value={String(status.conflictCount ?? 0)} compact />
          <Metric label="相关对象" value={String(status.memoryGraphNodeCount ?? 0)} compact />
          <Metric label="联系" value={String(status.memoryGraphEdgeCount ?? 0)} compact />
        </div>
        <dl className="kv">
          <dt>仓库</dt><dd>{status.memoryRoot || state.paths.memoryRepo || '-'}</dd>
          <dt>索引</dt><dd>{status.indexPath || '-'}</dd>
          <dt>关系缓存</dt><dd>{status.memoryGraphPath || '-'}</dd>
          <dt>状态文件</dt><dd>{status.statusPath || '-'}</dd>
          <dt>索引时间</dt><dd>{status.lastIndexedAt || status.generatedAt || '-'}</dd>
          <dt>最近事件</dt><dd>{status.lastEventAt || '-'}</dd>
          <dt>监听启动</dt><dd>{status.watcherStartedAt || '-'}</dd>
          <dt>监听进程</dt><dd>{status.watcherPid ? String(status.watcherPid) : '-'}</dd>
          <dt>状态心跳</dt><dd>{status.statusUpdatedAt || '-'}</dd>
          <dt>状态</dt><dd><StatusPill status={statusKind} label={status.lastError || (status.exists ? '可用' : '等待生成')} /></dd>
        </dl>
        {(((status.memoryGraphPreview?.nodes ?? []).length > 0) || ((status.memoryGraphPreview?.edges ?? []).length > 0)) && (
          <div className="runtime-list compact-list">
            <article className="runtime-row">
              <div>
                <strong>相关对象</strong>
                <p>{(status.memoryGraphPreview?.nodes ?? []).slice(0, 8).map((node) => `${node.label} (${node.kind})`).join('；') || '-'}</p>
              </div>
              <StatusPill status="ok" label={`${status.memoryGraphNodeCount ?? 0} 个`} />
            </article>
            <article className="runtime-row">
              <div>
                <strong>联系</strong>
                <p>{(status.memoryGraphPreview?.edges ?? []).slice(0, 8).map((edge) => `${edge.fromLabel || edge.from} -> ${edge.toLabel || edge.to} (${relationTypeLabel(edge.type)})`).join('；') || '-'}</p>
              </div>
              <StatusPill status="ok" label={`${status.memoryGraphEdgeCount ?? 0} 条`} />
            </article>
          </div>
        )}
        {(status.recentReviewWarnings ?? []).length > 0 && (
          <div className="runtime-list compact-list">
            {(status.recentReviewWarnings ?? []).map((item, index) => (
              <article key={`${item.createdAt}-${index}`} className="runtime-row">
                <div>
                <strong>{item.reasonCodes?.join(', ') || item.verdict}</strong>
                <span>{item.createdAt || '-'}</span>
                <p>{item.userText || '-'}</p>
                <code>{item.answerText || '-'}</code>
              </div>
                <StatusPill status="warning" label="需要检查" />
              </article>
            ))}
          </div>
        )}
          </section>
        </div>
      </details>

      <details className="panel advanced-diagnostics">
        <summary>
          <span>高级表格</span>
          <small>知识单元、相关对象和联系明细</small>
        </summary>
        <div className="advanced-diagnostics-body">
          <section className="diagnostic-section">
        <SectionHeader
          title="网格明细 / 搜索"
          action={<MiniButton label="搜索" icon={<Search size={14} />} onClick={() => void search()} pending={pending['memory.search']} />}
        />
        <div className="detail-meta">当前显示 {items.length} / {status.itemCount ?? 0} 条记忆；关系缓存包含 {graphNodes.length} 个相关对象、{graphEdges.length} 条联系。</div>
        <div className="filter-row">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter') void search();
          }} placeholder="关键词、场景名、文件名或结论片段" />
        </div>
        <div className="preset-wall">
          {[
            { id: 'items', label: '知识单元' },
            { id: 'nodes', label: '相关对象' },
            { id: 'edges', label: '联系' },
          ].map((item) => (
            <button key={item.id} className={gridView === item.id ? 'preset-chip active' : 'preset-chip'} onClick={() => setGridView(item.id as typeof gridView)}>
              {item.label}
            </button>
          ))}
        </div>
        {gridView === 'items' && (
          <div className="preset-wall">
          {knowledgeKinds.map((item) => (
            <button key={item.id} className={kind === item.id ? 'preset-chip active' : 'preset-chip'} onClick={() => setKind(item.id)}>
              {item.label}
            </button>
          ))}
          </div>
        )}
        {gridView === 'items' && (
          <div className="preset-wall">
            {memorySourceGroups.map((item) => (
              <button key={item.id} className={sourceGroup === item.id ? 'preset-chip active' : 'preset-chip'} onClick={() => setSourceGroup(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
        )}
        {error && <div className="empty-inline">{error}</div>}
        {gridView === 'items' && (
          <>
            <div className="detail-meta">当前页 {searchMeta.offset + 1} - {Math.min(searchMeta.offset + items.length, searchMeta.totalMatched)} / {searchMeta.totalMatched} 条匹配。</div>
            <MemoryDataGrid
              data={items}
              columns={itemColumns}
              emptyText={status.itemCount ? '暂无匹配结果。清空关键词或切换类型后再搜索。' : '暂无知识单元。'}
            />
            <div className="row-actions">
              <MiniButton
                label="上一页"
                icon={<ArrowLeftRight size={14} />}
                onClick={() => void search(Math.max(0, searchMeta.offset - searchMeta.limit))}
                disabled={searchMeta.offset <= 0}
                pending={pending['memory.search']}
              />
              <MiniButton
                label="下一页"
                icon={<ArrowLeftRight size={14} />}
                onClick={() => void search(searchMeta.offset + searchMeta.limit)}
                disabled={searchMeta.offset + searchMeta.limit >= searchMeta.totalMatched}
                pending={pending['memory.search']}
              />
            </div>
          </>
        )}
        {gridView === 'nodes' && (
          <MemoryDataGrid data={graphNodes} columns={nodeColumns} emptyText="暂无相关对象。整理记忆关系后会在这里出现。" />
        )}
        {gridView === 'edges' && (
          <MemoryDataGrid data={graphEdges} columns={edgeColumns} emptyText="暂无联系。结构化记忆建立映射后会在这里出现。" />
        )}
          </section>
        </div>
      </details>

    </section>
  );
}

type MemoryItemCliEnvelope<T> = { ok: true; data: T };
type MemoryItemListPayload<T> = { items: T[]; count: number };

function memoryLifecycleStatusLabel(status: MemoryLifecycleStatus) {
  if (status === 'confirmed') return '已确认';
  if (status === 'candidate') return '候选收件箱';
  return '已归档';
}

function memoryScopeLabel(scope: string) {
  if (scope === 'user') return '用户记忆';
  if (scope === 'group') return '群聊记忆';
  if (scope === 'long_term') return '公共长期记忆';
  return scope || '未知分区';
}

function MemoryLifecyclePanel({ run, pending, refreshRevision }: {
  run: PageProps['run'];
  pending: Record<string, boolean>;
  refreshRevision: number;
}) {
  const [snapshot, setSnapshot] = useState<MemoryLifecycleSnapshot>({ confirmed: [], candidates: [], archives: [] });
  const [status, setStatus] = useState<MemoryLifecycleStatus>('confirmed');
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const view = useMemo(() => buildMemoryLifecycleView(snapshot, status), [snapshot, status]);

  const readList = <T,>(value: unknown): T[] => {
    const envelope = value as MemoryItemCliEnvelope<MemoryItemListPayload<T>>;
    if (envelope?.ok !== true || !Array.isArray(envelope.data?.items)) throw new Error('记忆生命周期接口返回格式无效。');
    return envelope.data.items;
  };

  const refresh = async () => {
    setError('');
    try {
      const [confirmed, candidates, archives] = await Promise.all([
        run('memory.items.listConfirmed'),
        run('memory.items.listCandidates'),
        run('memory.items.listArchives'),
      ]);
      setSnapshot({
        confirmed: readList<MemoryLifecycleItemRecord>(confirmed),
        candidates: readList<MemoryLifecycleItemRecord>(candidates),
        archives: readList<MemoryLifecycleArchiveRecord>(archives),
      });
      setSelectedCandidateIds((current) => current.filter((id) => readList<MemoryLifecycleItemRecord>(candidates).some((item) => item.itemId === id)));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : '记忆生命周期读取失败');
    }
  };

  useEffect(() => { void refresh(); }, [refreshRevision]);
  useEffect(() => {
    if (status !== 'candidate') setSelectedCandidateIds([]);
  }, [status]);

  const mutate = async (command: string, payload: Record<string, unknown>) => {
    setError('');
    try {
      await run(command, payload);
      await refresh();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : '记忆生命周期操作失败');
    }
  };

  const confirm = (row: MemoryLifecycleRow) => mutate('memory.items.confirmCandidate', {
    itemId: row.itemId,
    expectedBaseHash: row.sourceBaseHash,
  });
  const archive = (row: MemoryLifecycleRow) => mutate('memory.items.archive', {
    itemId: row.itemId,
    expectedBaseHash: row.sourceBaseHash,
  });
  const restore = (row: MemoryLifecycleRow) => mutate('memory.items.restore', { archiveId: row.archiveId });
  const deleteArchive = (row: MemoryLifecycleRow) => {
    const previousStatus = row.previousStatus === 'candidate' ? '候选' : '已确认';
    if (!window.confirm(`永久删除归档记忆“${row.key}”？\n\n原状态：${previousStatus}\n该操作不可恢复，并会保留防止候选自动复活的删除标记。`)) return Promise.resolve();
    return mutate('memory.items.deleteArchive', { archiveId: row.archiveId });
  };
  const archiveSelectedCandidates = async () => {
    if (selectedCandidateIds.length === 0) return;
    if (!window.confirm(`归档已选择的 ${selectedCandidateIds.length} 条候选记忆？归档后仍可还原。`)) return;
    await mutate('memory.items.archiveCandidatesBatch', { itemIds: selectedCandidateIds });
    setSelectedCandidateIds([]);
  };

  return (
    <section className="panel memory-lifecycle-panel">
      <SectionHeader
        title="记忆生命周期"
        action={<MiniButton
          label="刷新"
          icon={<RefreshCw size={14} />}
          onClick={() => void refresh()}
          pending={pending['memory.items.listConfirmed'] || pending['memory.items.listCandidates'] || pending['memory.items.listArchives']}
        />}
      />
      <p className="panel-intro">机器状态是唯一事实源；这里展示同步生成的人类可读投影。候选和归档不会进入主知识索引或默认 Prompt。</p>
      <div className="preset-wall memory-lifecycle-tabs" role="tablist" aria-label="记忆生命周期状态">
        {(['confirmed', 'candidate', 'archived'] as MemoryLifecycleStatus[]).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={status === item}
            className={status === item ? 'preset-chip active' : 'preset-chip'}
            onClick={() => setStatus(item)}
          >
            {memoryLifecycleStatusLabel(item)} {view.counts[item]}
          </button>
        ))}
      </div>
      {status === 'candidate' && (
        <div className="command-band dense memory-lifecycle-batch">
          <span>已选择 {selectedCandidateIds.length} 条</span>
          <MiniButton
            label="批量归档"
            icon={<Archive size={14} />}
            onClick={() => void archiveSelectedCandidates()}
            disabled={selectedCandidateIds.length === 0}
            pending={pending['memory.items.archiveCandidatesBatch']}
          />
        </div>
      )}
      {error && <div className="empty-inline">{error}</div>}
      <div className="runtime-list compact-list memory-lifecycle-list">
        {view.rows.map((row) => {
          const actions = memoryItemActions(row);
          const isSelected = selectedCandidateIds.includes(row.itemId);
          return (
            <article className="runtime-row memory-lifecycle-row" key={row.id}>
              {row.status === 'candidate' && (
                <label className="memory-lifecycle-select" title="选择候选记忆">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(event) => setSelectedCandidateIds((current) => event.target.checked
                      ? [...new Set([...current, row.itemId])]
                      : current.filter((id) => id !== row.itemId))}
                  />
                </label>
              )}
              <div className="memory-lifecycle-row-main">
                <div className="detail-summary">
                  <strong>{row.key}</strong>
                  <StatusPill
                    status={row.status === 'confirmed' ? 'ok' : row.status === 'candidate' ? 'warning' : 'idle'}
                    label={memoryLifecycleStatusLabel(row.status)}
                  />
                </div>
                <p>{row.value}</p>
                <div className="memory-lifecycle-meta">
                  <span>{memoryScopeLabel(row.scope)}</span>
                  <span>置信度 {Math.round((row.confidence || 0) * 100)}%</span>
                  {row.status === 'candidate' && <span>独立 session {row.distinctSessionCount ?? 0}</span>}
                  {row.status === 'candidate' && <span>最后证据 {row.lastEvidenceAt || row.updatedAt || '-'}</span>}
                  {row.status === 'archived' && <span>原状态 {row.previousStatus === 'candidate' ? '候选' : '已确认'}</span>}
                  {row.status === 'archived' && <span>归档时间 {row.archivedAt || '-'}</span>}
                  <span>来源 {row.sourceKind || '-'}</span>
                </div>
                <code>{row.sourceRelativePath || '-'}</code>
              </div>
              <div className="row-actions">
                {actions.includes('confirm') && <MiniButton label="确认为记忆" icon={<CheckCircle2 size={14} />} onClick={() => void confirm(row)} pending={pending['memory.items.confirmCandidate']} />}
                {actions.includes('archive') && <MiniButton label="归档" icon={<Archive size={14} />} onClick={() => void archive(row)} pending={pending['memory.items.archive']} />}
                {actions.includes('restore') && <MiniButton label="还原" icon={<RotateCw size={14} />} onClick={() => void restore(row)} pending={pending['memory.items.restore']} />}
                {actions.includes('delete') && <MiniButton label="永久删除" icon={<Trash2 size={14} />} onClick={() => void deleteArchive(row)} pending={pending['memory.items.deleteArchive']} />}
              </div>
            </article>
          );
        })}
        {view.rows.length === 0 && <div className="empty-inline">当前分区没有记忆条目。</div>}
      </div>
    </section>
  );
}

function MemoryGovernancePanel({ initial, run, pending }: { initial?: MemoryOptimizationStatus; run: PageProps['run']; pending: Record<string, boolean> }) {
  const [optimization, setOptimization] = useState<MemoryOptimizationStatus | undefined>(initial);
  const [selectedActions, setSelectedActions] = useState<string[]>([]);
  const activeDraft = (optimization?.drafts ?? []).find((draft) => draft.status === 'draft') ?? (optimization?.drafts ?? [])[0];

  const refresh = async () => {
    const nextOptimization = await run('memory.optimizeStatus') as MemoryOptimizationStatus;
    setOptimization(nextOptimization);
    const draft = (nextOptimization.drafts ?? []).find((item) => item.status === 'draft');
    setSelectedActions((draft?.actions ?? []).filter((action) => action.defaultSelected !== false).map((action) => action.id));
  };

  useEffect(() => { void refresh(); }, []);

  const generate = async () => {
    const result = await run('memory.optimizePreview', { modelSource: optimization?.modelSource || 'codex_primary' }) as { status?: MemoryOptimizationStatus };
    if (result.status) setOptimization(result.status);
    await refresh();
  };
  const apply = async (draft: MemoryOptimizationDraft) => {
    if (!window.confirm(`应用 ${selectedActions.length} 个已选记忆治理动作？归档项仍可恢复。`)) return;
    const result = await run('memory.optimizeApply', { draftId: draft.draftId, selectedActionIds: selectedActions }) as { status?: MemoryOptimizationStatus };
    if (result.status) setOptimization(result.status);
    await refresh();
  };
  const undo = async (draft: MemoryOptimizationDraft) => {
    const result = await run('memory.optimizeUndo', { draftId: draft.draftId }) as { status?: MemoryOptimizationStatus };
    if (result.status) setOptimization(result.status);
    await refresh();
  };
  const discard = async (draftId: string) => {
    const result = await run('memory.optimizeDiscard', { draftId }) as { status?: MemoryOptimizationStatus };
    if (result.status) setOptimization(result.status);
    setSelectedActions([]);
  };
  const schedule = async (enabled: boolean) => {
    const result = await run('memory.optimizeSchedule', {
      enabled,
      intervalDays: optimization?.intervalDays || 7,
      modelSource: optimization?.modelSource || 'codex_primary',
    }) as { status?: MemoryOptimizationStatus };
    if (result.status) setOptimization(result.status);
  };
  return (
    <section className="panel panel-span-2 memory-governance-panel">
      <SectionHeader title="数据治理" action={<MiniButton label="刷新" icon={<RefreshCw size={14} />} onClick={() => void refresh()} pending={pending['memory.optimizeStatus']} />} />
      <p className="panel-intro">这里保留模型辅助整理草稿和定期计划；逐条确认、归档、还原与永久删除统一在 Memory 页的“记忆生命周期”中执行。</p>
      <div className="summary-grid wide">
        <Metric label="定期整理" value={optimization?.enabled ? '已启用' : '未启用'} compact />
        <Metric label="间隔" value={`${optimization?.intervalDays ?? 7} 天`} compact />
        <Metric label="草稿" value={`${optimization?.draftCount ?? optimization?.drafts?.length ?? 0}`} compact />
      </div>
      <div className="command-band dense">
        <MiniButton label="生成整理草稿" icon={<BrainCircuit size={14} />} onClick={() => void generate()} pending={pending['memory.optimizePreview']} />
        <MiniButton label={optimization?.enabled ? '停用定期整理' : '启用定期整理'} icon={<RotateCw size={14} />} onClick={() => void schedule(!optimization?.enabled)} pending={pending['memory.optimizeSchedule']} />
      </div>
      {activeDraft && (
        <div className="detail-stack memory-governance-draft">
          <div className="detail-summary"><strong>{activeDraft.summary || '记忆治理草稿'}</strong><StatusPill status={activeDraft.status === 'draft' ? 'warning' : 'ok'} label={activeDraft.status} /></div>
          <div className="optimizer-action-list">
            {(activeDraft.actions ?? []).map((action) => (
              <label key={action.id} className={selectedActions.includes(action.id) ? `optimizer-action risk-${action.risk}` : 'optimizer-action excluded'}>
                <input
                  type="checkbox"
                  checked={selectedActions.includes(action.id)}
                  disabled={activeDraft.status !== 'draft'}
                  onChange={(event) => setSelectedActions((current) => event.target.checked ? [...new Set([...current, action.id])] : current.filter((id) => id !== action.id))}
                />
                <div><strong>{action.title}</strong><span>{action.type} · 风险 {action.risk} · {Math.round((action.confidence || 0) * 100)}%</span><p>{action.reason}</p></div>
              </label>
            ))}
          </div>
          <div className="command-band dense">
            <MiniButton label="应用所选" icon={<CheckCircle2 size={14} />} onClick={() => void apply(activeDraft)} pending={pending['memory.optimizeApply']} disabled={activeDraft.status !== 'draft' || selectedActions.length === 0} />
            <MiniButton label="撤销已应用" icon={<RotateCw size={14} />} onClick={() => void undo(activeDraft)} pending={pending['memory.optimizeUndo']} disabled={activeDraft.status !== 'applied'} />
            <MiniButton label="丢弃草稿" icon={<Trash2 size={14} />} onClick={() => void discard(activeDraft.draftId)} pending={pending['memory.optimizeDiscard']} disabled={activeDraft.status !== 'draft'} />
          </div>
        </div>
      )}
    </section>
  );
}

function SettingsPage({
  state,
  run,
  pending,
  presets,
  reloadPresets,
}: {
  state: PanelState;
  run: PageProps['run'];
  pending: Record<string, boolean>;
  presets: ReplyPresetItem[];
  reloadPresets: () => void;
}) {
  const [settings, setSettings] = useState<SettingsState>(state.settings);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [requestText, setRequestText] = useState('');
  const [modelCatalogItems, setModelCatalogItems] = useState<ExtensionCatalogItem[]>([]);
  const [modelCatalogError, setModelCatalogError] = useState('');
  const settingsDirtyRef = useRef(false);
  const activePreset = presets.find((preset) => settings.replyStyleHint === preset.value);

  useEffect(() => {
    settingsDirtyRef.current = settingsDirty;
  }, [settingsDirty]);
  useEffect(() => {
    if (!settingsDirtyRef.current) setSettings(state.settings);
  }, [state.settings]);
  useEffect(() => reloadPresets(), []);

  const update = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    setSettingsDirty(true);
    setSettings((current) => ({ ...current, [key]: value }));
  };
  const aiStrategy = inferAiStrategy(settings);
  const localPreset = LOCAL_AI_PRESETS[settings.localAiKind] || LOCAL_AI_PRESETS.custom;
  const fallbackChain = parseCodexChain(settings.codexApiFallbackChain);
  const executorOptions = state.executors?.executors ?? [];
  const pathSections = buildWorkspacePathSections(settings);
  const localModelOptions = useMemo(() => {
    const byModel = new Map<string, ExtensionCatalogItem>();
    for (const item of modelCatalogItems) {
      if (item.type !== 'model') continue;
      if (item.installHandler !== 'ollama.pull') continue;
      const model = (item.artifactUrl || '').trim();
      if (!model) continue;
      if (!byModel.has(model) || item.installed) byModel.set(model, item);
    }
    return Array.from(byModel.entries())
      .sort(([, left], [, right]) => {
        if (left.installed !== right.installed) return left.installed ? -1 : 1;
        return (left.displayName || left.artifactUrl || '').localeCompare(right.displayName || right.artifactUrl || '');
      });
  }, [modelCatalogItems]);
  const installedLocalModelOptions = useMemo(
    () => localModelOptions.filter(([, item]) => item.installed),
    [localModelOptions],
  );

  const loadModelCatalog = async (refresh = false) => {
    try {
      const snapshot = await run(refresh ? 'extension.catalog.refresh' : 'extension.catalog.list') as ExtensionCatalogSnapshot;
      setModelCatalogItems(snapshot.items ?? []);
      setModelCatalogError('');
    } catch (error) {
      setModelCatalogError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    void loadModelCatalog(false);
  }, []);

  const setFallbackChain = (chain: CodexSource[]) => {
    const unique = Array.from(new Set(chain));
    update('codexApiFallbackChain', (unique.length ? unique : ['local_api', 'external_api']).join(','));
  };

  const toggleFallbackSource = (source: CodexSource, checked: boolean) => {
    const next = checked ? [...fallbackChain, source] : fallbackChain.filter((item) => item !== source);
    setFallbackChain(next);
  };

  const moveFallbackSource = (source: CodexSource, delta: number) => {
    const index = fallbackChain.indexOf(source);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= fallbackChain.length) return;
    const next = [...fallbackChain];
    [next[index], next[target]] = [next[target], next[index]];
    setFallbackChain(next);
  };

  const applyLocalAiKind = (kind: string) => {
    const preset = LOCAL_AI_PRESETS[kind] || LOCAL_AI_PRESETS.custom;
    setSettingsDirty(true);
    setSettings((current) => ({
      ...current,
      localAiKind: kind,
      localAiBaseUrl: preset.baseUrl || current.localAiBaseUrl,
      localAiTimeoutMs: preset.timeoutMs,
    }));
  };

  const applyAiStrategy = (strategy: AiStrategy) => {
    setSettingsDirty(true);
    setSettings((current) => {
      const clearCodexKey = current.codexApiKeySet ? 'clear' : current.codexApiKeyAction;
      if (strategy === 'official') {
        return {
          ...current,
          codexModelSource: 'official',
          codexRoutingMode: 'manual',
          codexBaseUrl: '',
          codexModel: '',
          codexPassModel: false,
          codexReasoningEffort: 'low',
          codexApiKeyAction: clearCodexKey,
          codexApiKeyValue: '',
        };
      }
      if (strategy === 'local_api') {
        return {
          ...current,
          codexModelSource: 'local_api',
          codexRoutingMode: 'manual',
          codexBaseUrl: '',
          codexModel: '',
          codexPassModel: true,
          codexReasoningEffort: 'low',
          codexApiKeyAction: clearCodexKey,
          codexApiKeyValue: '',
        };
      }
      if (strategy === 'auto_failover') {
        return {
          ...current,
          codexRoutingMode: 'auto_failover',
          codexApiFallbackChain: formatCodexChain(current.codexApiFallbackChain || 'local_api,external_api'),
          codexPassModel: true,
        };
      }
      return {
        ...current,
        codexModelSource: 'external_api',
        codexRoutingMode: 'manual',
        codexPassModel: true,
        codexReasoningEffort: current.codexReasoningEffort || 'low',
      };
    });
  };

  const applyPreset = async (name: string) => {
    const result = (await run('settings.applyReplyPreset', { name })) as { value: string; settings?: SettingsState };
    if (result.settings) {
      setSettings(result.settings);
      setSettingsDirty(false);
      return;
    }
    update('replyStyleHint', result.value);
  };

  const summarize = async () => {
    const result = await run('settings.summarizeReplyStyle', { text: requestText });
    setSettings((current) => ({ ...current, replyStyleHint: String(result ?? '') }));
    setSettingsDirty(false);
  };

  const testLocalAi = async () => {
    const result = await run('settings.testLocalAi', { settings });
    window.alert(formatCommandResult(result));
  };

  const testLocalTools = async () => {
    const result = await run('settings.testLocalTools', { settings });
    window.alert(formatCommandResult(result));
    await run('state.refresh');
  };

  const testCodexApi = async () => {
    const result = await run('settings.testCodexApi', { settings });
    window.alert(formatCommandResult(result));
  };

  const testAiStrategy = async () => {
    const results: string[] = [];
    if (aiStrategy === 'local_api' || (aiStrategy === 'auto_failover' && fallbackChain.includes('local_api'))) {
      const localResult = await run('settings.testLocalAi', { settings });
      results.push(`本地 API（真实请求）：${formatCommandResult(localResult)}`);
    }
    if (aiStrategy === 'external_api' || aiStrategy === 'official' || (aiStrategy === 'auto_failover' && (fallbackChain.includes('external_api') || fallbackChain.includes('official')))) {
      const codexResult = await run('settings.testCodexApi', { settings });
      results.push(`Codex API（真实请求）：${formatCommandResult(codexResult)}`);
    }
    window.alert(results.join('\n\n'));
  };

  const saveSettings = async (restartBridge: boolean) => {
    const result = await run(restartBridge ? 'settings.saveAndRestartBridge' : 'settings.save', { settings });
    setSettings(result as SettingsState);
    setSettingsDirty(false);
  };

  const saveAndRestartBridge = async () => {
    await saveSettings(true);
  };

  return (
    <section className="settings-layout">
      <section className="panel panel-span-2">
        <SectionHeader
          title="路径配置"
          action={<MiniButton label={settingsDirty ? '保存未应用修改' : '保存'} icon={<CheckCircle2 size={14} />} onClick={() => void saveSettings(false)} pending={pending['settings.save']} />}
        />
        <div className="path-grid">
          {pathSections.editable.map((field) => field.key === 'allowedRoots' ? (
            <div key={field.key} className="detail-stack">
              <TokenPathField label={field.label} value={field.value} onChange={(value) => update(field.key, value)} run={run} />
              <span className="micro-copy">{field.note}</span>
            </div>
          ) : (
            <div key={field.key} className="detail-stack">
              <PathField label={field.label} value={field.value} onChange={(value) => update(field.key, value)} run={run} />
              <span className="micro-copy">{field.note}</span>
            </div>
          ))}
        </div>
        <details className="advanced-settings">
          <summary>高级诊断</summary>
          {pathSections.diagnostics.map((field) => (
            <div key={field.key} className="detail-stack">
              <strong>{field.label}</strong>
              <code>{field.value || '未配置'}</code>
              <span className="micro-copy">{field.note}</span>
            </div>
          ))}
        </details>
        <div className="project-fact-hint">
          <strong>项目事实</strong>
          <span>当前工作区是每轮唯一默认挂载；项目注册根只是权限上界。明确引用其他项目时，Bridge 才会为当前回合建立临时挂载，回合结束即失效。临时附件进入运行态 uploads，长期事实进入 Agent Home/记忆库，二者都不会自动注入工作区。</span>
        </div>
      </section>
      <section className="panel panel-span-2">
        <SectionHeader
          title="AI 执行与模型来源"
          action={<MiniButton label="保存并重启 Bridge" icon={<RotateCw size={14} />} onClick={() => void saveAndRestartBridge()} pending={pending['settings.saveAndRestartBridge']} />}
        />
        <div className="ai-strategy-shell">
          <label className="stack-field">
            <span>默认执行器</span>
            <select value={settings.defaultExecutorId || ''} onChange={(event) => update('defaultExecutorId', event.target.value)}>
              <option value="">自动选择</option>
              {executorOptions.map((executor) => (
                <option key={executor.id} value={executor.id} disabled={!executor.enabled}>
                  {executor.displayName}{executor.enabled ? '' : '（停用）'}
                </option>
              ))}
            </select>
          </label>
          <label className="stack-field">
            <span>运行策略</span>
            <select value={aiStrategy} onChange={(event) => applyAiStrategy(event.target.value as AiStrategy)}>
              <option value="official">官方 Codex</option>
              <option value="local_api">本地 API</option>
              <option value="external_api">外部 API</option>
              <option value="auto_failover">自动切换</option>
            </select>
          </label>
          <div className="ai-summary-grid">
            <div>
              <span>当前策略</span>
              <strong>{strategyLabel(aiStrategy)}</strong>
            </div>
            <div>
              <span>主脑</span>
              <strong>{aiStrategy === 'local_api' ? `${localAiLabel(settings.localAiKind)} ${settings.localAiModel || ''}`.trim() : aiStrategy === 'external_api' ? (settings.codexModel || '外部 API') : aiStrategy === 'auto_failover' ? fallbackChain.map((source) => CODEX_SOURCE_LABELS[source]).join(' -> ') : 'Codex 默认'}</strong>
            </div>
            <div>
              <span>失败后切换</span>
              <strong>{aiStrategy === 'auto_failover' ? fallbackChain.map((source) => CODEX_SOURCE_LABELS[source]).join(' -> ') : '关闭'}</strong>
            </div>
          </div>
          {aiStrategy === 'official' && (
            <p className="field-hint">使用官方 Codex 登录态和默认模型。除非选择自动切换，否则不会自动改用其他模型来源。</p>
          )}
          {aiStrategy === 'local_api' && (
            <>
              <div className="path-grid">
                <label className="stack-field">
                  <span>本地模型服务</span>
                  <select value={settings.localAiKind} onChange={(event) => applyLocalAiKind(event.target.value)}>
                    <option value="ollama">Ollama</option>
                    <option value="lmstudio">LM Studio</option>
                    <option value="vllm">vLLM / OpenAI-compatible</option>
                    <option value="openai-compatible">OpenAI-compatible</option>
                    <option value="custom">自定义</option>
                  </select>
                </label>
                <label className="stack-field">
                  <span>模型</span>
                  <div className="path-input-group">
                    <input
                      list="local-ai-model-catalog"
                      value={settings.localAiModel}
                      onChange={(event) => update('localAiModel', event.target.value)}
                      placeholder="例如 qwen3-coder:30b"
                    />
                    <MiniButton label="刷新目录" icon={<RefreshCw size={14} />} onClick={() => void loadModelCatalog(true)} pending={pending['extension.catalog.refresh']} />
                  </div>
                  <datalist id="local-ai-model-catalog">
                    {localModelOptions.map(([model, item]) => (
                      <option
                        key={model}
                        value={model}
                        label={`${item.displayName || model}${item.installed ? ' · 已安装' : ''}`}
                      />
                    ))}
                  </datalist>
                </label>
                <label className="stack-field">
                  <span>已安装模型</span>
                  <div className="path-input-group">
                    <select value="" onChange={(event) => event.target.value && update('localAiModel', event.target.value)}>
                      <option value="">{installedLocalModelOptions.length ? '选择本机已安装模型' : '暂无本机已安装模型'}</option>
                      {installedLocalModelOptions.map(([model, item]) => (
                        <option key={model} value={model}>{item.displayName || model}</option>
                      ))}
                    </select>
                    <MiniButton label="应用并重启" icon={<RotateCw size={14} />} onClick={() => void saveAndRestartBridge()} pending={pending['settings.saveAndRestartBridge']} disabled={!settings.localAiModel.trim()} />
                  </div>
                </label>
                <label className="stack-field">
                  <span>地址</span>
                  <input value={settings.localAiBaseUrl} onChange={(event) => update('localAiBaseUrl', event.target.value)} placeholder={localPreset.baseUrl || 'http://127.0.0.1:8000/v1'} />
                </label>
                <label className="stack-field">
                  <span>Ollama 模型目录</span>
                  <div className="path-input-group">
                    <input value={settings.ollamaModelsDir} onChange={(event) => update('ollamaModelsDir', event.target.value)} placeholder="留空使用 Ollama 默认模型目录" />
                    <MiniButton label="选择目录" icon={<FolderOpen size={14} />} onClick={() => void run('path.pickFolder', { currentPath: settings.ollamaModelsDir }).then((next) => update('ollamaModelsDir', String(next ?? settings.ollamaModelsDir)))} pending={pending['path.pickFolder']} />
                  </div>
                </label>
              </div>
              <p className="field-hint">
                Provider 能力：{localAiCapabilityLabel(settings.localAiKind)}。{localAiCapabilityHint(settings.localAiKind)}
                模型候选来自扩展在线目录；仍可手动输入任意 Ollama 模型名。
                {modelCatalogError ? ` 目录读取失败：${modelCatalogError}` : ''}
              </p>
            </>
          )}
          {aiStrategy === 'auto_failover' && (
            <div className="failover-chain-panel">
              {(['local_api', 'external_api', 'official'] as CodexSource[]).map((source) => {
                const enabled = fallbackChain.includes(source);
                const index = fallbackChain.indexOf(source);
                return (
                  <div key={source} className="failover-chain-row">
                    <label className="inline-field">
                      <input type="checkbox" checked={enabled} onChange={(event) => toggleFallbackSource(source, event.target.checked)} />
                      <span>{CODEX_SOURCE_LABELS[source]}</span>
                    </label>
                    <div className="chain-order-actions">
                      <button type="button" disabled={!enabled || index <= 0} onClick={() => moveFallbackSource(source, -1)}>↑</button>
                      <button type="button" disabled={!enabled || index < 0 || index >= fallbackChain.length - 1} onClick={() => moveFallbackSource(source, 1)}>↓</button>
                    </div>
                  </div>
                );
              })}
              <p className="field-hint">自动切换只在模型/API 请求失败后按顺序尝试链内来源；官方 Codex 不会默认加入，勾选后才可能消耗官方流量。</p>
              {fallbackChain.includes('local_api') && (
                <p className="field-hint">本地模型 provider：{localAiLabel(settings.localAiKind)} · {localAiCapabilityLabel(settings.localAiKind)}。</p>
              )}
            </div>
          )}
          {aiStrategy === 'external_api' && (
            <div className="path-grid">
              <label className="stack-field">
                <span>主 API Base URL</span>
                <input value={settings.codexBaseUrl} onChange={(event) => update('codexBaseUrl', event.target.value)} placeholder="例如 http://127.0.0.1:11434/v1 或 https://api.example.com/v1" />
              </label>
              <label className="stack-field">
                <span>主 API Model</span>
                <input value={settings.codexModel} onChange={(event) => update('codexModel', event.target.value)} placeholder="例如 qwen3:8b / gpt-4.1" />
              </label>
              <label className="stack-field">
                <span>主 API Key · {settings.codexApiKeySet ? `已设置 ${settings.codexApiKeyMasked}` : '未设置'}</span>
                <select value={settings.codexApiKeyAction} onChange={(event) => update('codexApiKeyAction', event.target.value as SettingsState['codexApiKeyAction'])}>
                  <option value="keep">保持不变</option>
                  <option value="set">设置新值</option>
                  <option value="clear">清除</option>
                </select>
              </label>
              {settings.codexApiKeyAction === 'set' && (
                <label className="stack-field">
                  <span>主 API Key 新值</span>
                  <input type="password" value={settings.codexApiKeyValue} onChange={(event) => update('codexApiKeyValue', event.target.value)} />
                </label>
              )}
            </div>
          )}
          <details className="advanced-settings">
            <summary>高级设置</summary>
            <div className="path-grid">
              <div className="settings-subhead">本地 API（模型来源）</div>
              <label className="stack-field">
                <span>本地模型 API Timeout(ms)</span>
                <input value={settings.localAiTimeoutMs} onChange={(event) => update('localAiTimeoutMs', event.target.value)} />
              </label>
              <label className="stack-field">
                <span>本地模型 API Key · {settings.localAiApiKeySet ? `已设置 ${settings.localAiApiKeyMasked}` : '未设置'}</span>
                <select value={settings.localAiApiKeyAction} onChange={(event) => update('localAiApiKeyAction', event.target.value as SettingsState['localAiApiKeyAction'])}>
                  <option value="keep">保持不变</option>
                  <option value="set">设置新值</option>
                  <option value="clear">清除</option>
                </select>
              </label>
              {settings.localAiApiKeyAction === 'set' && (
                <label className="stack-field">
                  <span>本地模型 API Key 新值</span>
                  <input type="password" value={settings.localAiApiKeyValue} onChange={(event) => update('localAiApiKeyValue', event.target.value)} />
                </label>
              )}
              <div className="settings-subhead">Codex 主 API</div>
              <label className="stack-field">
                <span>Codex 主 API Reasoning</span>
                <select value={settings.codexReasoningEffort} onChange={(event) => update('codexReasoningEffort', event.target.value)}>
                  <option value="minimal">minimal</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                </select>
              </label>
              <label className="stack-field inline-field">
                <input type="checkbox" checked={settings.codexPassModel} onChange={(event) => update('codexPassModel', event.target.checked)} />
                <span>向 Codex 显式传递 model</span>
              </label>
            </div>
          </details>
        </div>
        <div className="command-band tight">
          <MiniButton label="一键检测" icon={<Bot size={14} />} onClick={() => void testAiStrategy()} pending={pending['settings.testLocalAi'] || pending['settings.testCodexApi']} />
          <MiniButton label="测试本地 API（真实请求）" icon={<Bot size={14} />} onClick={() => void testLocalAi()} pending={pending['settings.testLocalAi']} />
          <MiniButton label="测试工具调用" icon={<ListChecks size={14} />} onClick={() => void testLocalTools()} pending={pending['settings.testLocalTools']} />
          <MiniButton label="测试 Codex API" icon={<Bot size={14} />} onClick={() => void testCodexApi()} pending={pending['settings.testCodexApi']} />
        </div>
      </section>
      <section className="panel">
        <SectionHeader
          title="回复风格快捷设置"
          action={<MiniButton label="保存自定义" icon={<CheckCircle2 size={14} />} onClick={() => void saveSettings(false)} pending={pending['settings.save']} />}
        />
        <div className="preset-wall">
          <button className={!activePreset && settings.replyStyleHint.trim() ? 'preset-chip active' : 'preset-chip'} disabled>
            自定义
          </button>
          {presets.map((preset) => (
            <button key={preset.name} className={settings.replyStyleHint === preset.value ? 'preset-chip active' : 'preset-chip'} onClick={() => void applyPreset(preset.name)}>
              {preset.name}
            </button>
          ))}
        </div>
        <label className="stack-field">
          <span>当前生效摘要{activePreset ? ` · ${activePreset.name}` : settings.replyStyleHint.trim() ? ' · 自定义' : ''}</span>
          <textarea className="text-area compact" value={settings.replyStyleHint} onChange={(event) => update('replyStyleHint', event.target.value)} />
        </label>
      </section>
      <section className="panel">
        <SectionHeader
          title="自定义整理"
          action={<MiniButton label="保存整理结果" icon={<CheckCircle2 size={14} />} onClick={() => void saveSettings(false)} pending={pending['settings.save']} />}
        />
        <label className="stack-field">
          <span>原始要求</span>
          <textarea className="text-area compact" value={requestText} onChange={(event) => setRequestText(event.target.value)} placeholder="例如：回复像项目助理，先说结果，再说一句影响，不要解释思考过程。" />
        </label>
        <div className="command-band tight">
          <MiniButton label="本地 AI 整理" icon={<Bot size={14} />} onClick={() => void summarize()} pending={pending['settings.summarizeReplyStyle']} />
          <MiniButton label="配置文件" icon={<ExternalLink size={14} />} onClick={() => void run('path.openConfig')} pending={pending['path.openConfig']} />
          <MiniButton label="Manifest 目录" icon={<ExternalLink size={14} />} onClick={() => void run('path.openManifestDir')} pending={pending['path.openManifestDir']} />
          <MiniButton label="记忆仓库" icon={<ExternalLink size={14} />} onClick={() => void run('path.openMemoryRepo')} pending={pending['path.openMemoryRepo']} />
        </div>
      </section>
      <MemoryGovernancePanel initial={state.memory.optimization} run={run} pending={pending} />
    </section>
  );
}

function LogsPage({ activities, clearActivities }: { activities: ActivityRecord[]; clearActivities: () => void }) {
  const [filter, setFilter] = useState('');
  const filtered = activities.filter((item) => `${item.title} ${item.message}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <section className="content-stack">
      <div className="filter-row">
        <Search size={14} />
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选标题或消息内容" />
        <MiniButton label="清空" icon={<Trash2 size={14} />} onClick={clearActivities} />
      </div>
      <section className="panel">
        <SectionHeader title="统一活动流" />
        <ActivityList activities={filtered.slice().reverse()} />
      </section>
    </section>
  );
}

function PathField({
  label,
  value,
  onChange,
  run,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  run: PageProps['run'];
}) {
  const handleDrop = (event: React.DragEvent<HTMLInputElement>) => {
    event.preventDefault();
    const data = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain');
    if (data) onChange(data.replace(/^file:\/\/\//, '').trim());
  };

  return (
    <label className="field-block">
      <span>{label}</span>
      <div className="path-input-group">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
          placeholder="拖拽文件夹、粘贴路径或点击选择目录"
        />
        <MiniButton label="选择目录" icon={<FolderOpen size={14} />} onClick={() => void run('path.pickFolder', { currentPath: value }).then((next) => onChange(String(next ?? value)))} />
        <MiniButton label="打开" icon={<ExternalLink size={14} />} onClick={() => void run('path.openAny', { path: value })} />
        <MiniButton label="清空" icon={<X size={14} />} onClick={() => onChange('')} />
      </div>
    </label>
  );
}

function TokenPathField({
  label,
  value,
  onChange,
  run,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  run: PageProps['run'];
}) {
  const items = splitPaths(value);
  const [draft, setDraft] = useState('');

  useEffect(() => setDraft(''), [value]);

  const addValue = (next: string) => {
    const merged = Array.from(new Set([...items, ...splitPaths(next)]));
    onChange(joinPaths(merged));
  };

  return (
    <label className="field-block">
      <span>{label}</span>
      <div className="token-field">
        <div className="token-list">
          {items.map((item) => (
            <span key={item} className="token-chip">
              {item}
              <button onClick={() => onChange(joinPaths(items.filter((candidate) => candidate !== item)))}><X size={12} /></button>
            </span>
          ))}
        </div>
        <div className="path-input-group">
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="输入路径后回车，或点击选择目录追加" onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addValue(draft);
            }
          }} />
          <MiniButton label="追加目录" icon={<FolderOpen size={14} />} onClick={() => void run('path.pickFolder', { currentPath: items[0] ?? '' }).then((next) => addValue(String(next ?? '')))} />
          <MiniButton label="清空" icon={<X size={14} />} onClick={() => onChange('')} />
        </div>
      </div>
    </label>
  );
}

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="section-header">
      <h2>{title}</h2>
      {action}
    </div>
  );
}

function liveSyncStatusKind(status: LiveSyncState['status']): StatusKind {
  switch (status) {
    case 'current':
      return 'ok';
    case 'outdated':
    case 'missing':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

function LiveSyncBanner({ liveSync, pending, onSync }: { liveSync: LiveSyncState; pending?: boolean; onSync: () => void }) {
  const canShowSync = liveSync.canSync;
  const summary = liveSync.summary || 'Live 同步状态不可用';
  const syncLabel = liveSync.status === 'current' ? '重新同步' : '一键同步';
  return (
    <div className={`live-sync-banner ${liveSync.status}`} title={liveSync.detail || summary}>
      <StatusPill status={liveSyncStatusKind(liveSync.status)} label={liveSync.status === 'current' ? 'Live' : 'Live 待处理'} />
      <span className="live-sync-copy">{summary}</span>
      {liveSync.legacyEntryPresent && (
        <span className="live-sync-legacy" title={liveSync.legacyEntryPath || '旧兼容入口仍存在'}>旧兼容入口可删除</span>
      )}
      {canShowSync && (
        <MiniButton
          label={syncLabel}
          icon={<ArrowDownUp size={14} />}
          onClick={onSync}
          pending={pending}
        />
      )}
    </div>
  );
}

function CommandStatusBanner({ notice, onDismiss }: { notice: CommandNotice; onDismiss: () => void }) {
  return (
    <div className={`command-status-banner ${notice.status}`}>
      <StatusPill status={notice.status === 'running' ? 'warning' : notice.status === 'success' ? 'ok' : 'error'} label={notice.status === 'running' ? '执行中' : notice.status === 'success' ? '完成' : '失败'} />
      <span>{notice.message}</span>
      {notice.status !== 'running' && (
        <button className="icon-button compact" title="关闭提示" onClick={onDismiss}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function StatusPill({ status, label }: { status: StatusKind; label: string }) {
  return <span className={`status-pill ${status}`}>{label}</span>;
}

function CommandButton({ label, command, icon, run, pending }: { label: string; command: string; icon: React.ReactNode; run: PageProps['run']; pending: Record<string, boolean> }) {
  return (
    <button className="command-button" onClick={() => {
      if (confirmReleaseCommand(command)) {
        void run(command);
      }
    }} disabled={pending[command]}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function MiniButton({
  label,
  icon,
  onClick,
  pending,
  disabled,
  title,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  pending?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button className="mini-button" onClick={onClick} disabled={pending || disabled} title={title || label}>
      <span className={pending ? 'spin' : ''}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function SummaryFact({ label, value, compact }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className={compact ? 'summary-fact compact' : 'summary-fact'}>
      <span>{label}</span>
      <strong>{value || '-'}</strong>
    </div>
  );
}

function Metric({ label, value, compact }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className={compact ? 'metric compact' : 'metric'}>
      <span>{label}</span>
      <strong>{value || '-'}</strong>
    </div>
  );
}

function GateItem({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className={ok ? 'gate-item ok' : 'gate-item'}>
      {ok ? <CheckCircle2 size={16} /> : <FileText size={16} />}
      <span>{label}</span>
    </div>
  );
}

function ActivityList({ activities, compact }: { activities: ActivityRecord[]; compact?: boolean }) {
  if (activities.length === 0) {
    return <div className="empty-inline">暂无活动记录</div>;
  }

  return (
    <div className={compact ? 'activity-list compact' : 'activity-list'}>
      {activities.map((item, index) => (
        <div key={`${item.timestamp}-${item.title}-${index}`} className={`activity-item ${item.level}`}>
          <time>{item.timestamp}</time>
          <strong>{item.title}</strong>
          <span>{item.message}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">{icon}</div>
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

function RuntimeTile({ unit }: { unit: RuntimeUnit }) {
  return (
    <div className="runtime-tile">
      <div className="runtime-tile-head">
        <strong>{unit.displayName}</strong>
        <StatusPill status={unit.status} label={runtimeStatusText(unit)} />
      </div>
      <span>{getRuntimeKindLabel(unit.kind)} · {getRuntimeCategoryLabel(unit.category)}</span>
      <p>{unit.detail || unit.description || '暂无细节。'}</p>
    </div>
  );
}

function actionIcon(actionId: string) {
  switch (actionId) {
    case 'start':
      return <Play size={14} />;
    case 'stop':
      return <Square size={14} />;
    case 'restart':
      return <RotateCw size={14} />;
    case 'update':
      return <RefreshCw size={14} />;
    case 'check':
    case 'status':
      return <Search size={14} />;
    case 'register':
      return <PlugZap size={14} />;
    case 'remove':
      return <Trash2 size={14} />;
    case 'install':
      return <Layers3 size={14} />;
    case 'openManifest':
    case 'openSource':
    case 'openLocation':
      return <ExternalLink size={14} />;
    case 'logs':
      return <Logs size={14} />;
    default:
      return <Power size={14} />;
  }
}

function statusText(status: StatusKind, enabled: boolean) {
  if (!enabled && status !== 'error') return '禁用';
  switch (status) {
    case 'ok':
      return '正常';
    case 'warning':
      return '待处理';
    case 'error':
      return '异常';
    default:
      return '待机';
  }
}

function runtimeStatusText(unit: RuntimeUnit) {
  if (!unit.enabled && unit.status !== 'error') return '禁用';
  if (unit.kind === 'mcp') {
    if (unit.status === 'ok') return unit.detail ? '可用' : '已启用';
    if (unit.status === 'warning') return '需检查';
  }
  return statusText(unit.status, unit.enabled);
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing root element');
createRoot(rootElement).render(<App />);
