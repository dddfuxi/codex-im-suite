import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  Archive,
  ArrowDownUp,
  Bot,
  CheckCircle2,
  Clipboard,
  ExternalLink,
  FileText,
  FolderOpen,
  GitBranch,
  History,
  Image as ImageIcon,
  Layers3,
  ListChecks,
  Logs,
  MoonStar,
  Play,
  PlugZap,
  Power,
  RefreshCw,
  Rocket,
  RotateCw,
  Search,
  Settings,
  ShieldCheck,
  Square,
  SunMedium,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import './styles.css';

type StatusKind = 'ok' | 'warning' | 'error' | 'idle';
type ThemeMode = 'light' | 'dark';

type ActivityRecord = {
  level: string;
  title: string;
  message: string;
  timestamp: string;
};

type ServiceItem = {
  id: string;
  title: string;
  status: StatusKind;
  detail: string;
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
};

type SettingsState = {
  defaultWorkDir: string;
  allowedRoots: string;
  unityProject: string;
  memoryRepo: string;
  additionalDirs: string;
  replyStyleHint: string;
};

type SessionItem = {
  displayName: string;
  channelType: string;
  chatType: string;
  chatId: string;
  sessionId: string;
  source: string;
  localMessageCount: number;
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
  attachments?: MessageAttachment[];
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
  recovery?: {
    kind: 'recoverable' | 'not_recoverable';
    reason: string;
    input?: { prompt?: string; workingDirectory?: string; model?: string; permissionMode?: string; channelType?: string; chatId?: string };
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
  watching: boolean;
  exists: boolean;
  markdownFileCount: number;
  itemCount: number;
  conflictCount: number;
  sourceFileCount?: number;
  kindCounts?: Record<string, number>;
  generatedAt: string;
  lastIndexedAt?: string;
  lastEventAt?: string;
  watcherStartedAt?: string;
  watcherPid?: number;
  statusUpdatedAt?: string;
  lastError: string;
};

type KnowledgeSearchItem = {
  id: string;
  kind: 'fact' | 'conclusion' | 'todo' | 'resource' | string;
  key: string;
  value: string;
  text: string;
  confidence: number;
  conflict: boolean;
  sourcePath: string;
  snippet: string;
};

type KnowledgeSearchResponse = {
  status: KnowledgeIndexStatus;
  items: KnowledgeSearchItem[];
};

type KnowledgeArchiveSnapshot = {
  archiveRoot: string;
  items: KnowledgeArchiveItem[];
};

type KnowledgeArchiveItem = {
  id: string;
  itemId: string;
  kind: string;
  text: string;
  sourcePath: string;
  archivedAt: string;
  archivePath: string;
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

type ExtensionKindFilter = 'all' | 'mcp' | 'skill' | 'plugin' | 'extension';
type ImportKind = '' | 'skill' | 'mcp';
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

type LiveSyncState = {
  status: 'current' | 'outdated' | 'missing' | 'error' | 'unavailable';
  lastSyncedAt: string;
  suiteCommit: string;
  liveCommit: string;
  summary: string;
  canSync: boolean;
  detail: string;
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
  extensions: {
    total: number;
    enabled: number;
    disabled: number;
    missingSources: number;
    items: ExtensionItem[];
  };
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

const navItems = [
  { id: 'overview', label: '总览', icon: Activity },
  { id: 'services', label: '服务', icon: Power },
  { id: 'executors', label: '执行器', icon: Bot },
  { id: 'permissions', label: '权限', icon: ShieldCheck },
  { id: 'extensions', label: '扩展', icon: Layers3 },
  { id: 'release', label: '发布', icon: GitBranch },
  { id: 'sessions', label: '会话', icon: History },
  { id: 'memory', label: '记忆', icon: Search },
  { id: 'settings', label: '设置', icon: Settings },
  { id: 'logs', label: '日志', icon: Terminal },
] as const;

type PageId = (typeof navItems)[number]['id'];
const pageIds = new Set<PageId>(navItems.map((item) => item.id));

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
  extensions: { total: 0, enabled: 0, disabled: 0, missingSources: 0, items: [] },
  mcp: { total: 0, running: 0, items: [], runtimeStatus: '', details: '' },
  release: { publishSummaryExists: false, releaseNotesExists: false, prepareMainReleaseExists: false, tagScriptExists: false, pendingChanges: [] },
  liveSync: { status: 'unavailable', lastSyncedAt: '', suiteCommit: '', liveCommit: '', summary: 'Live 同步状态不可用', canSync: false, detail: '' },
  settings: { defaultWorkDir: '', allowedRoots: '', unityProject: '', memoryRepo: '', additionalDirs: '', replyStyleHint: '' },
  history: { status: '', sessions: [] },
  workflow: { protocol: 'workflow-runtime/v1', updatedAt: '', runs: [] },
  memory: {
    schema: 'codex-im-suite/knowledge-index-status/v1',
    memoryRoot: '',
    indexPath: '',
    statusPath: '',
    watching: false,
    exists: false,
    markdownFileCount: 0,
    itemCount: 0,
    conflictCount: 0,
    sourceFileCount: 0,
    kindCounts: {},
    generatedAt: '',
    lastIndexedAt: '',
    lastEventAt: '',
    watcherStartedAt: '',
    watcherPid: 0,
    statusUpdatedAt: '',
    lastError: '',
  },
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
  executors: { protocol: 'executor-runtime/v1', updatedAt: '', executors: [], sessionDefaults: {} },
  permissions: { protocol: 'cti-permissions/v1', updatedAt: '', subjects: [], candidates: [] },
  paths: { config: '', manifestDir: '', memoryRepo: '', logs: '' },
  activities: [],
};

const themeStorageKey = 'codex-im-suite-control-panel-theme';
const controlApiTokenStorageKey = 'codex-im-suite-control-api-token';

function getInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  const saved = window.localStorage.getItem(themeStorageKey);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getInitialPage(): PageId {
  if (typeof window === 'undefined') return 'overview';
  const hashPage = window.location.hash.replace(/^#\/?/, '') as PageId;
  return pageIds.has(hashPage) ? hashPage : 'overview';
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

function workflowStatusLabel(run: WorkflowRun) {
  if (run.retry?.status === 'auto_pending') return '自动重试排队';
  if (run.retry?.status === 'manual_pending') return '手动重试排队';
  if (run.retry?.status === 'retrying') return '重试中';
  if (run.retry?.status === 'exhausted') return '重试耗尽';
  if (run.recovery?.kind === 'recoverable' && run.status === 'failed') return '可重试';
  if (run.recovery?.kind === 'not_recoverable') return '不可恢复';
  return run.stage || run.status;
}

function canRetryWorkflow(run: WorkflowRun) {
  return !!run.recovery?.input?.prompt
    && run.status !== 'succeeded'
    && run.status !== 'retry_pending'
    && run.status !== 'retrying';
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

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size <= 0) return '-';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
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
  const selectedServiceUnit = runtimeServiceUnits.find((unit) => unit.unitId === selectedServiceUnitId) ?? runtimeServiceUnits[0];
  const selectedExtensionUnit = runtimeExtensionUnits.find((unit) => unit.unitId === selectedExtensionUnitId) ?? runtimeExtensionUnits[0];

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
    const onHashChange = () => setPage(getInitialPage());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (window.location.hash !== `#${page}`) {
      window.history.replaceState(null, '', `#${page}`);
    }
  }, [page]);

  const run = async (command: string, payload: Record<string, unknown> = {}) => sendCommand(command, payload);

  const syncLive = async () => {
    const confirmed = window.confirm('将执行开发版 suite -> live skill 同步；不会提交、推送或打包。');
    if (!confirmed) return;
    await sendCommand('live.sync');
    await sendCommand('state.refresh');
    await loadRuntimeUnits();
  };

  const invokeRuntimeAction = async (unit: RuntimeUnit, action: RuntimeAction) => {
    await sendCommand('runtime.invokeAction', { unitId: unit.unitId, action: action.id });
    await loadRuntimeUnits();
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
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={page === item.id ? 'nav-item active' : 'nav-item'} onClick={() => setPage(item.id)} title={item.label}>
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
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
            <h1>{navItems.find((item) => item.id === page)?.label}</h1>
            <LiveSyncBanner liveSync={state.liveSync} pending={pending['live.sync']} onSync={() => void syncLive()} />
          </div>
          <div className="topbar-actions">
            <button className="theme-button" title="切换白天 / 夜晚模式" onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? <SunMedium size={16} /> : <MoonStar size={16} />}
              <span>{theme === 'dark' ? '夜间' : '白天'}</span>
            </button>
            <button className="icon-button" title="刷新状态" onClick={() => void sendCommand('state.refresh').then(loadRuntimeUnits)} disabled={pending['state.refresh']}>
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
            <button className="primary-button" onClick={() => void run('release.publishBackup').then(loadRuntimeUnits)} disabled={pending['release.publishBackup']}>
              <Rocket size={16} />
              一键发布
            </button>
            <button className="primary-button" onClick={() => void run('release.prepareMainRelease').then(loadRuntimeUnits)} disabled={pending['release.prepareMainRelease']}>
              <ListChecks size={16} />
              主干发布预检
            </button>
          </div>
        </header>

        {page === 'overview' && (
          <OverviewPage
            state={state}
            runtimeUnits={runtimeUnits}
            activities={activities}
            openLogs={() => setPage('logs')}
            refresh={() => void sendCommand('state.refresh').then(loadRuntimeUnits)}
            refreshPending={pending['state.refresh']}
          />
        )}
        {page === 'services' && (
          <ServicesPage
            units={runtimeServiceUnits}
            selectedUnitId={selectedServiceUnit?.unitId ?? ''}
            setSelectedUnitId={setSelectedServiceUnitId}
            invokeAction={invokeRuntimeAction}
            pending={pending}
          />
        )}
        {page === 'executors' && <ExecutorsPage state={state} run={run} pending={pending} />}
        {page === 'permissions' && <PermissionsPage state={state} run={run} pending={pending} />}
        {page === 'extensions' && (
          <ExtensionsPage
            state={state}
            units={runtimeExtensionUnits}
            selectedUnitId={selectedExtensionUnit?.unitId ?? ''}
            setSelectedUnitId={setSelectedExtensionUnitId}
            invokeAction={invokeRuntimeAction}
            run={run}
            refreshUnits={loadRuntimeUnits}
            pending={pending}
          />
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
        {page === 'memory' && <MemoryPage state={state} run={run} pending={pending} />}
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
}: {
  state: PanelState;
  runtimeUnits: RuntimeUnit[];
  activities: ActivityRecord[];
  openLogs: () => void;
  refresh: () => void;
  refreshPending?: boolean;
}) {
  const headlineUnits = runtimeUnits.filter((unit) => ['service', 'tool', 'mcp'].includes(unit.kind)).slice(0, 6);
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
                <span>{getRuntimeKindLabel(unit.kind)} · {getRuntimeCategoryLabel(unit.category)} · {unit.installState || 'installed'}</span>
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
                <div className="detail-meta">{getRuntimeKindLabel(selected.kind)} · {getRuntimeCategoryLabel(selected.category)} · {selected.version || '未标注版本'}</div>
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

function ExecutorsPage({ state, run, pending }: PageProps) {
  const executors = state.executors?.executors ?? [];
  const runs = state.workflow?.runs ?? [];
  const lastSelection = state.executors?.lastSelection;
  const recentRuns = runs.slice(-12).reverse();
  return (
    <section className="content-stack executor-page">
      <section className="panel">
        <SectionHeader title="执行器目录" />
        <div className="summary-grid">
          <SummaryFact label="可用执行器" value={`${executors.filter((item) => item.enabled).length}/${executors.length}`} compact />
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
              <div key={executor.id} className="runtime-row">
                <div>
                  <strong>{executor.displayName}</strong>
                  <span>{executor.kind} · {executor.riskLevel} · priority {executor.priority}</span>
                </div>
                <StatusPill status={executor.enabled ? 'ok' : 'idle'} label={executor.enabled ? '启用' : '停用'} />
              </div>
            ))}
            {executors.length === 0 && <EmptyState icon={<Bot size={28} />} title="暂无执行器状态" text="bridge 运行一次后会写入 executor-status.json。" />}
          </div>
        </section>
        <section className="panel detail-panel">
          <SectionHeader title="能力与最近路由" />
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
          <div className="tag-cloud">
            {executors.flatMap((executor) => executor.capabilities.map((capability) => `${executor.id}:${capability}`)).slice(0, 32).map((item) => (
              <span key={item} className="tag">{item}</span>
            ))}
          </div>
        </section>
      </section>
      <section className="panel executor-workflow-panel">
        <SectionHeader title="最近 Workflow" />
        <div className="runtime-list compact-list workflow-list">
          {recentRuns.map((runItem) => (
            <div key={runItem.id} className="runtime-row">
              <div>
                <strong>{runItem.promptPreview || runItem.id}</strong>
                <span>{runItem.stage} · {runItem.executorId || '未选择'} · {runItem.sessionId}</span>
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
  state,
  units,
  selectedUnitId,
  setSelectedUnitId,
  invokeAction,
  run,
  refreshUnits,
  pending,
}: {
  state: PanelState;
  units: RuntimeUnit[];
  selectedUnitId: string;
  setSelectedUnitId: (value: string) => void;
  invokeAction: (unit: RuntimeUnit, action: RuntimeAction) => Promise<void>;
  run: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  refreshUnits: () => Promise<void>;
  pending: Record<string, boolean>;
}) {
  const [kindFilter, setKindFilter] = useState<ExtensionKindFilter>('all');
  const [importPath, setImportPath] = useState('');
  const [importPreview, setImportPreview] = useState<ExtensionImportPreview | null>(null);
  const [importKind, setImportKind] = useState<ImportKind>('');
  const [importRuntimeType, setImportRuntimeType] = useState<McpRuntimeType>('stdio');
  const filterItems: Array<{ id: ExtensionKindFilter; label: string; count: number }> = useMemo(() => {
    const counts = {
      all: units.length,
      mcp: units.filter((unit) => unit.kind === 'mcp').length,
      skill: units.filter((unit) => unit.kind === 'skill').length,
      plugin: units.filter((unit) => unit.kind === 'plugin').length,
      extension: units.filter((unit) => !['mcp', 'skill', 'plugin'].includes(unit.kind)).length,
    };
    return [
      { id: 'all', label: '全部', count: counts.all },
      { id: 'mcp', label: 'MCP', count: counts.mcp },
      { id: 'skill', label: 'Skill', count: counts.skill },
      { id: 'plugin', label: 'Plugin', count: counts.plugin },
      { id: 'extension', label: '其他扩展', count: counts.extension },
    ];
  }, [units]);
  const filteredUnits = useMemo(() => {
    if (kindFilter === 'all') return units;
    if (kindFilter === 'extension') {
      return units.filter((unit) => !['mcp', 'skill', 'plugin'].includes(unit.kind));
    }
    return units.filter((unit) => unit.kind === kindFilter);
  }, [kindFilter, units]);
  const selected = filteredUnits.find((unit) => unit.unitId === selectedUnitId) ?? filteredUnits[0];

  async function pickImportFolder() {
    const picked = await run('path.pickFolder', { currentPath: importPath }) as string;
    setImportPath(picked || importPath);
  }

  async function inspectImportFolder() {
    if (!importPath.trim()) return;
    const preview = await run('extension.detectImport', { folderPath: importPath.trim() }) as ExtensionImportPreview;
    setImportPreview(preview);
    setImportKind((preview.detectedKind === 'skill' || preview.detectedKind === 'mcp') ? preview.detectedKind : '');
    setImportRuntimeType(preview.runtimeType === 'http' ? 'http' : 'stdio');
  }

  async function importFolderAsExtension() {
    if (!importPreview) return;
    const result = await run('extension.importFromFolder', {
      folderPath: importPath.trim(),
      kind: importKind || importPreview.detectedKind,
      runtimeType: importRuntimeType,
    }) as { kind?: string; id?: string };
    await refreshUnits();
    const importedKind = result?.kind || importKind || importPreview.detectedKind;
    const importedId = result?.id || importPreview.id;
    setSelectedUnitId(importedKind === 'mcp' ? `mcp.${importedId}` : `extension.${importPreview.manifestPath}`);
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
        <SectionHeader title="扩展总览" />
        <div className="summary-grid">
          <SummaryFact label="全部扩展" value={`${state.extensions.total}`} />
          <SummaryFact label="MCP" value={`${filterItems.find((item) => item.id === 'mcp')?.count ?? 0}`} />
          <SummaryFact label="Skill / Plugin" value={`${(filterItems.find((item) => item.id === 'skill')?.count ?? 0) + (filterItems.find((item) => item.id === 'plugin')?.count ?? 0)}`} />
          <SummaryFact label="缺依赖" value={`${state.extensions.missingSources}`} />
        </div>
        <div className="extension-filter-bar">
          {filterItems.map((item) => (
            <button
              key={item.id}
              className={kindFilter === item.id ? 'preset-chip active' : 'preset-chip'}
              onClick={() => setKindFilter(item.id)}
            >
              {item.label} <span>{item.count}</span>
            </button>
          ))}
        </div>
        <div className="field-block import-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={handleImportDrop}>
          <span>导入本地目录</span>
          <div className="command-band dense path-input-group">
            <input value={importPath} onChange={(event) => setImportPath(event.target.value)} placeholder="拖一个 skill / mcp 目录进来，或手动粘贴路径" />
            <MiniButton label="选择目录" icon={<FolderOpen size={14} />} onClick={() => void pickImportFolder()} pending={pending['path.pickFolder']} />
            <MiniButton label="识别" icon={<Search size={14} />} onClick={() => void inspectImportFolder()} pending={pending['extension.detectImport']} disabled={!importPath.trim()} />
          </div>
          <div className="detail-meta">规则：含 `SKILL.md` 识别为 Skill；目录名或 package.json 名称/描述命中 `mcp` 识别为 MCP。</div>
          {importPreview ? (
            <div className="detail-stack import-preview-grid">
              <div className="summary-grid">
                <SummaryFact label="识别结果" value={getRuntimeKindLabel(importPreview.detectedKind || 'extension')} compact />
                <SummaryFact label="ID" value={importPreview.id || '-'} compact />
                <SummaryFact label="安装状态" value={importPreview.installState || '-'} compact />
                <SummaryFact label="可导入" value={importPreview.canImport ? '是' : '否'} compact />
              </div>
              <div className="preset-wall">
                <button className={(importKind || importPreview.detectedKind) === 'skill' ? 'preset-chip active' : 'preset-chip'} onClick={() => setImportKind('skill')}>Skill</button>
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
        </div>
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
                    <span>{getSessionTypeLabel(item)} · {item.source} · {item.localMessageCount} 条 · {item.lastUpdatedAt || '未知时间'}</span>
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
    </section>
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
  const orderedRuns = useMemo(() => {
    if (!detail?.workflowRuns) return [];
    return [...detail.workflowRuns].reverse();
  }, [detail]);

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
          <section className="run-timeline-block">
            <div className="subsection-title">
              <Activity size={15} />
              <strong>运行历程</strong>
            </div>
            <div className="run-timeline">
              {orderedRuns.map((runItem) => (
                <article key={runItem.id} className="run-card">
                  <header>
                    <strong>{runItem.executorId || '未选择执行器'}</strong>
                    <StatusPill status={workflowStatusKind(runItem)} label={workflowStatusLabel(runItem)} />
                  </header>
                  <p>{runItem.promptPreview || runItem.id}</p>
                  {(runItem.recovery?.reason || runItem.retry?.lastError || runItem.error) && (
                    <p>{runItem.recovery?.reason || runItem.retry?.lastError || runItem.error}</p>
                  )}
                  <span>{runItem.startedAt || '-'} · {runItem.id}</span>
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
              ))}
              {orderedRuns.length === 0 && <div className="empty-inline">暂无关联 workflow run。</div>}
            </div>
          </section>
          <div className="message-stream">
            {orderedMessages.map((message) => (
              <article key={`${message.index}-${message.createdAt}`} className="message-card">
                <header>
                  <strong>{message.senderName || message.role}</strong>
                  <span>{message.msgType || 'message'} · {message.createdAt || '-'}</span>
                </header>
                {message.senderId && (
                  <div className="message-sender-meta">
                    <span>{message.role}</span>
                    <code>{message.senderId}</code>
                  </div>
                )}
                <pre>{message.content}</pre>
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
              </article>
            ))}
            {orderedMessages.length === 0 && <div className="empty-inline">这条会话暂无可展示消息，可能是远端历史同步失败或本地索引缺少消息内容。</div>}
          </div>
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

function MemoryPage({ state, run, pending }: { state: PanelState; run: PageProps['run']; pending: Record<string, boolean> }) {
  const [status, setStatus] = useState<KnowledgeIndexStatus>(state.memory);
  const [reminders, setReminders] = useState<TodoReminderSnapshot>(state.memoryReminders);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<(typeof knowledgeKinds)[number]['id']>('all');
  const [items, setItems] = useState<KnowledgeSearchItem[]>([]);
  const [archives, setArchives] = useState<KnowledgeArchiveSnapshot>({ archiveRoot: '', items: [] });
  const [error, setError] = useState('');
  const runRef = useRef(run);

  useEffect(() => setStatus(state.memory), [state.memory]);
  useEffect(() => setReminders(state.memoryReminders), [state.memoryReminders]);
  useEffect(() => {
    runRef.current = run;
  }, [run]);
  useEffect(() => {
    let disposed = false;
    const timer = window.setInterval(() => {
      void runRef.current('memory.status')
        .then((next) => {
          if (!disposed) setStatus(next as KnowledgeIndexStatus);
        })
        .catch(() => undefined);
    }, 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const refreshStatus = async () => {
    setError('');
    const next = await run('memory.status') as KnowledgeIndexStatus;
    setStatus(next);
  };

  const refreshReminders = async () => {
    setError('');
    const next = await run('memory.checkReminders') as TodoReminderSnapshot;
    setReminders(next);
  };

  const refreshArchives = async () => {
    const next = await run('memory.archives') as KnowledgeArchiveSnapshot;
    setArchives(next);
  };

  const testReminder = async (id: string) => {
    setError('');
    await run('memory.testReminder', { id });
    await refreshReminders();
  };

  const completeReminder = async (id: string) => {
    setError('');
    await run('memory.completeReminder', { id });
    await refreshReminders();
  };

  const archiveKnowledgeItem = async (id: string) => {
    setError('');
    await run('memory.archiveItem', { id });
    await search();
    await refreshReminders();
    await refreshArchives();
  };

  const deleteKnowledgeArchive = async (archivePath: string) => {
    setError('');
    await run('memory.deleteArchive', { path: archivePath });
    await refreshArchives();
  };

  const search = async () => {
    setError('');
    try {
      const result = await run('memory.search', {
        query,
        kinds: kind === 'all' ? [] : [kind],
        limit: 40,
      }) as KnowledgeSearchResponse;
      setStatus(result.status);
      setItems(Array.isArray(result.items) ? result.items : []);
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : '搜索失败');
    }
  };

  useEffect(() => {
    void search();
  }, [kind]);

  useEffect(() => {
    void refreshArchives();
  }, []);

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
    { label: 'Markdown', detail: `${status.markdownFileCount ?? 0} 个文件`, ok: (status.markdownFileCount ?? 0) > 0 },
    { label: '索引文件', detail: status.exists ? '已生成' : '未生成', ok: status.exists },
    { label: '监听心跳', detail: status.watching ? '运行中' : '未运行', ok: status.watching },
    { label: 'Codex 注入', detail: status.exists && !status.lastError ? '可注入' : '等待索引', ok: status.exists && !status.lastError },
  ];

  return (
    <section className="content-stack">
      <section className="memory-visual-grid">
        <section className="panel">
          <SectionHeader title="知识分布" />
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
          <SectionHeader title="索引链路" />
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
      <section className="panel">
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
        </div>
        <dl className="kv">
          <dt>仓库</dt><dd>{status.memoryRoot || state.paths.memoryRepo || '-'}</dd>
          <dt>索引</dt><dd>{status.indexPath || '-'}</dd>
          <dt>状态文件</dt><dd>{status.statusPath || '-'}</dd>
          <dt>索引时间</dt><dd>{status.lastIndexedAt || status.generatedAt || '-'}</dd>
          <dt>最近事件</dt><dd>{status.lastEventAt || '-'}</dd>
          <dt>监听启动</dt><dd>{status.watcherStartedAt || '-'}</dd>
          <dt>监听进程</dt><dd>{status.watcherPid ? String(status.watcherPid) : '-'}</dd>
          <dt>状态心跳</dt><dd>{status.statusUpdatedAt || '-'}</dd>
          <dt>状态</dt><dd><StatusPill status={statusKind} label={status.lastError || (status.exists ? '可用' : '等待生成')} /></dd>
        </dl>
      </section>

      <section className="panel">
        <SectionHeader
          title="待办提醒"
          action={<MiniButton label="检查提醒" icon={<RefreshCw size={14} />} onClick={() => void refreshReminders()} pending={pending['memory.checkReminders']} />}
        />
        <div className="summary-grid">
          <Metric label="主动推送" value={reminders.enabled ? '已开启' : '未开启'} compact />
          <Metric label="直接提醒" value={reminders.directReminderPushEnabled ? '已开启' : reminders.directReminderEnabled === false ? '未启用' : '未推送'} compact />
          <Metric label="待发送" value={String(reminders.counts?.pending ?? 0)} compact />
          <Metric label="已发送" value={String(reminders.counts?.sent ?? 0)} compact />
          <Metric label="已完成" value={String(reminders.counts?.completed ?? 0)} compact />
          <Metric label="失败" value={String(reminders.counts?.failed ?? 0)} compact />
          <Metric label="跳过" value={String(reminders.counts?.skipped ?? 0)} compact />
        </div>
        <div className="detail-meta">
          索引 {reminders.exists ? '已生成' : '未生成'} · 渠道 {(reminders.channels ?? []).join(', ') || 'feishu'} · 间隔 {Math.round((reminders.pollMs ?? 0) / 1000)}s
        </div>
        <div className="preset-wall">
          {(reminders.providers ?? []).map((provider) => (
            <span key={provider.channelType} className={provider.state === 'ok' ? 'preset-chip active' : 'preset-chip'}>
              {channelLabel(provider.channelType)} · {provider.state === 'unsupported' ? '未接入' : provider.state === 'ok' ? '可用' : '未开启'}
            </span>
          ))}
        </div>
        {reminders.lastError && <div className="empty-inline">{reminders.lastError}</div>}
        <div className="runtime-list compact-list">
          {(reminders.items ?? []).map((item) => (
            <article key={item.id} className="runtime-row">
              <div>
                <strong>{item.title || '未命名待办'}</strong>
                <span>
                  {item.dueAt || '无提醒时间'} · {item.sourceType === 'direct' ? '直接提醒' : '记忆待办'} · {channelLabel(item.target?.channelType)} · {item.target?.displayName || item.target?.chatId || '缺少来源会话'}
                </span>
                <p>{item.completedAt || item.delivery?.completedAt ? `已完成：${item.completedAt || item.delivery?.completedAt} · ${item.completionSource || item.delivery?.completionSource || 'panel'}` : item.completionError || item.delivery?.completionError || item.skipReason || item.delivery?.error || item.source?.snippet || '等待到点推送。'}</p>
                <code>{item.source?.path || '-'}</code>
              </div>
              <div className="row-actions">
                <StatusPill status={reminderStatusKind(item.status)} label={reminderStatusLabel(item.status)} />
                <MiniButton
                  label="完成"
                  icon={<CheckCircle2 size={14} />}
                  onClick={() => void completeReminder(item.id)}
                  pending={pending['memory.completeReminder']}
                  disabled={item.status === 'completed'}
                />
                <MiniButton
                  label="测试发送"
                  icon={<Play size={14} />}
                  onClick={() => void testReminder(item.id)}
                  pending={pending['memory.testReminder']}
                  disabled={item.status === 'completed' || (item.target?.channelType || '').toLowerCase() !== 'feishu' || !item.target?.chatId}
                />
                <MiniButton label="来源" icon={<ExternalLink size={14} />} onClick={() => void run('memory.openSource', { path: item.source?.path })} pending={pending['memory.openSource']} />
              </div>
            </article>
          ))}
          {(reminders.items ?? []).length === 0 && <div className="empty-inline">暂无待办提醒。给待办添加提醒时间和来源会话后会在这里出现。</div>}
        </div>
      </section>

      <section className="panel">
        <SectionHeader
          title="知识单元 / 搜索"
          action={<MiniButton label="搜索" icon={<Search size={14} />} onClick={() => void search()} pending={pending['memory.search']} />}
        />
        <div className="detail-meta">当前显示 {items.length} / {status.itemCount ?? 0} 个知识单元。</div>
        <div className="filter-row">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter') void search();
          }} placeholder="关键词、场景名、文件名或结论片段" />
        </div>
        <div className="preset-wall">
          {knowledgeKinds.map((item) => (
            <button key={item.id} className={kind === item.id ? 'preset-chip active' : 'preset-chip'} onClick={() => setKind(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        {error && <div className="empty-inline">{error}</div>}
        <div className="runtime-list compact-list">
          {items.map((item) => (
            <article key={item.id} className="runtime-row">
              <div>
                <strong>{item.key ? `${item.key} = ${item.value || item.text}` : item.text}</strong>
                <span>{knowledgeKindLabel(item.kind)} · 置信度 {Math.round((item.confidence || 0) * 100)}% · {item.conflict ? '冲突候选' : '正常'}</span>
                <p>{item.snippet || item.text}</p>
                <code>{item.sourcePath || '-'}</code>
              </div>
              <div className="row-actions">
                <StatusPill status={item.conflict ? 'warning' : 'ok'} label={knowledgeKindLabel(item.kind)} />
                <MiniButton
                  label="归档"
                  icon={<Archive size={14} />}
                  onClick={() => void archiveKnowledgeItem(item.id)}
                  pending={pending['memory.archiveItem']}
                />
                <MiniButton label="来源" icon={<ExternalLink size={14} />} onClick={() => void run('memory.openSource', { path: item.sourcePath })} pending={pending['memory.openSource']} />
              </div>
            </article>
          ))}
          {items.length === 0 && <div className="empty-inline">{status.itemCount ? '暂无匹配结果。清空关键词或切换类型后再搜索。' : '暂无知识单元。'}</div>}
        </div>
      </section>

      <section className="panel">
        <SectionHeader
          title="知识归档"
          action={<MiniButton label="刷新" icon={<RefreshCw size={14} />} onClick={() => void refreshArchives()} pending={pending['memory.archives']} />}
        />
        <div className="detail-meta">归档目录 {archives.archiveRoot || '-'}。这里的文件不会进入知识索引，可手动永久删除。</div>
        <div className="runtime-list compact-list">
          {(archives.items ?? []).map((item) => (
            <article key={item.archivePath} className="runtime-row">
              <div>
                <strong>{item.text || item.itemId || '归档知识单元'}</strong>
                <span>{knowledgeKindLabel(item.kind)} · {item.archivedAt || '未知时间'}</span>
                <p>{item.sourcePath || '无来源记录'}</p>
                <code>{item.archivePath}</code>
              </div>
              <div className="row-actions">
                <StatusPill status="idle" label="已归档" />
                <MiniButton label="打开" icon={<ExternalLink size={14} />} onClick={() => void run('memory.openSource', { path: item.archivePath })} pending={pending['memory.openSource']} />
                <MiniButton label="永久删除" icon={<Trash2 size={14} />} onClick={() => void deleteKnowledgeArchive(item.archivePath)} pending={pending['memory.deleteArchive']} />
              </div>
            </article>
          ))}
          {(archives.items ?? []).length === 0 && <div className="empty-inline">暂无归档知识单元。</div>}
        </div>
      </section>
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
  const [requestText, setRequestText] = useState('');
  const activePreset = presets.find((preset) => settings.replyStyleHint === preset.value);

  useEffect(() => setSettings(state.settings), [state.settings]);
  useEffect(() => reloadPresets(), []);

  const update = (key: keyof SettingsState, value: string) => setSettings((current) => ({ ...current, [key]: value }));

  const applyPreset = async (name: string) => {
    const result = (await run('settings.applyReplyPreset', { name })) as { value: string; settings?: SettingsState };
    if (result.settings) {
      setSettings(result.settings);
      return;
    }
    update('replyStyleHint', result.value);
  };

  const summarize = async () => {
    const result = await run('settings.summarizeReplyStyle', { text: requestText });
    update('replyStyleHint', String(result ?? ''));
  };

  return (
    <section className="settings-layout">
      <section className="panel panel-span-2">
        <SectionHeader
          title="路径配置"
          action={<MiniButton label="保存" icon={<CheckCircle2 size={14} />} onClick={() => void run('settings.save', { settings })} pending={pending['settings.save']} />}
        />
        <div className="path-grid">
          <PathField label="默认工作目录" value={settings.defaultWorkDir} onChange={(value) => update('defaultWorkDir', value)} run={run} />
          <TokenPathField label="允许根目录" value={settings.allowedRoots} onChange={(value) => update('allowedRoots', value)} run={run} />
          <PathField label="Unity 工程" value={settings.unityProject} onChange={(value) => update('unityProject', value)} run={run} />
          <PathField label="记忆仓库" value={settings.memoryRepo} onChange={(value) => update('memoryRepo', value)} run={run} />
          <TokenPathField label="Codex 附加目录" value={settings.additionalDirs} onChange={(value) => update('additionalDirs', value)} run={run} />
        </div>
      </section>
      <section className="panel">
        <SectionHeader title="回复风格快捷设置" />
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
        <SectionHeader title="自定义整理" />
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
  const canShowSync = liveSync.canSync && ['outdated', 'missing', 'error'].includes(liveSync.status);
  const summary = liveSync.summary || 'Live 同步状态不可用';
  return (
    <div className={`live-sync-banner ${liveSync.status}`} title={liveSync.detail || summary}>
      <StatusPill status={liveSyncStatusKind(liveSync.status)} label={liveSync.status === 'current' ? 'Live' : 'Live 待处理'} />
      <span className="live-sync-copy">{summary}</span>
      {canShowSync && (
        <MiniButton
          label="一键同步"
          icon={<ArrowDownUp size={14} />}
          onClick={onSync}
          pending={pending}
        />
      )}
    </div>
  );
}

function StatusPill({ status, label }: { status: StatusKind; label: string }) {
  return <span className={`status-pill ${status}`}>{label}</span>;
}

function CommandButton({ label, command, icon, run, pending }: { label: string; command: string; icon: React.ReactNode; run: PageProps['run']; pending: Record<string, boolean> }) {
  return (
    <button className="command-button" onClick={() => void run(command)} disabled={pending[command]}>
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
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  pending?: boolean;
  disabled?: boolean;
}) {
  return (
    <button className="mini-button" onClick={onClick} disabled={pending || disabled}>
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
