import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  ExternalLink,
  FileText,
  GitBranch,
  History,
  Layers3,
  ListChecks,
  MoonStar,
  PackageCheck,
  Play,
  PlugZap,
  Power,
  RefreshCw,
  RotateCw,
  Search,
  Settings,
  Square,
  SunMedium,
  Terminal,
  XCircle,
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
  settings: SettingsState;
  history: {
    status: string;
    sessions: SessionItem[];
  };
  paths: {
    config: string;
    manifestDir: string;
    memoryRepo: string;
    logs: string;
  };
  activities: ActivityRecord[];
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
  { id: 'extensions', label: '扩展', icon: Layers3 },
  { id: 'release', label: '发布', icon: GitBranch },
  { id: 'sessions', label: '会话', icon: History },
  { id: 'settings', label: '设置', icon: Settings },
  { id: 'logs', label: '日志', icon: Terminal },
] as const;

type PageId = (typeof navItems)[number]['id'];

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
  settings: { defaultWorkDir: '', allowedRoots: '', unityProject: '', memoryRepo: '', additionalDirs: '', replyStyleHint: '' },
  history: { status: '', sessions: [] },
  paths: { config: '', manifestDir: '', memoryRepo: '', logs: '' },
  activities: [],
};

const themeStorageKey = 'codex-im-suite-control-panel-theme';

function getInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  const saved = window.localStorage.getItem(themeStorageKey);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function createRequestId() {
  return `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function useHostBridge() {
  const [state, setState] = useState<PanelState>(fallbackState);
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [results] = useState(() => new Map<string, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>());

  useEffect(() => {
    window.chrome?.webview?.addEventListener('message', (event: MessageEvent) => {
      const message = event.data as HostResult | HostStateMessage | HostActivityMessage;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'state') {
        setState(message.data);
        setActivities(message.data.activities ?? []);
        return;
      }
      if (message.type === 'activity') {
        setActivities((current) => [...current.slice(-220), { level: message.level, title: message.title, message: message.message, timestamp: message.timestamp }]);
        return;
      }
      if (message.type === 'result') {
        const waiter = results.get(message.id);
        if (!waiter) return;
        results.delete(message.id);
        if (message.ok) waiter.resolve(message.data);
        else waiter.reject(new Error(message.error || '命令执行失败'));
      }
    });
  }, [results]);

  const sendCommand = async (command: string, payload: Record<string, unknown> = {}) => {
    const id = createRequestId();
    setPending((current) => ({ ...current, [command]: true }));
    try {
      return await new Promise((resolve, reject) => {
        results.set(id, { resolve, reject });
        if (!window.chrome?.webview) {
          results.delete(id);
          reject(new Error('当前不在 WebView2 宿主中运行'));
          return;
        }
        window.chrome.webview.postMessage({ id, type: 'command', command, payload });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActivities((current) => [
        ...current.slice(-220),
        { level: 'error', title: '命令失败', message: `${command}: ${message}`, timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }) },
      ]);
      throw error;
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

  return { state, activities, pending, sendCommand, clearActivities };
}

function App() {
  const { state, activities, pending, sendCommand, clearActivities } = useHostBridge();
  const [page, setPage] = useState<PageId>('overview');
  const [selectedMcpId, setSelectedMcpId] = useState<string>('');
  const [theme, setTheme] = useState<ThemeMode>(() => getInitialTheme());
  const selectedMcp = useMemo(() => state.mcp.items.find((item) => item.id === selectedMcpId) ?? state.mcp.items[0], [selectedMcpId, state.mcp.items]);

  useEffect(() => {
    void sendCommand('state.refresh').catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!selectedMcpId && state.mcp.items.length > 0) setSelectedMcpId(state.mcp.items[0].id);
  }, [selectedMcpId, state.mcp.items]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  const run = (command: string, payload: Record<string, unknown> = {}) => sendCommand(command, payload).catch((error) => console.error(error));

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">CI</div>
          <div>
            <div className="brand-title">Codex IM Suite</div>
            <div className="brand-meta">Control Panel</div>
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
          <div>
            <div className="eyebrow">Suite {state.suite.version}</div>
            <h1>{navItems.find((item) => item.id === page)?.label}</h1>
          </div>
          <div className="topbar-actions">
            <button
              className="theme-button"
              title="切换白天 / 夜晚模式"
              aria-label="切换白天 / 夜晚模式"
              onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <SunMedium size={16} /> : <MoonStar size={16} />}
              <span>{theme === 'dark' ? '夜间模式' : '白天模式'}</span>
            </button>
            <button className="icon-button" title="刷新状态" onClick={() => run('state.refresh')} disabled={pending['state.refresh']}>
              <RefreshCw size={17} className={pending['state.refresh'] ? 'spin' : ''} />
            </button>
            <button className="primary-button" onClick={() => run('release.prepareMainRelease')} disabled={pending['release.prepareMainRelease']}>
              <ListChecks size={16} />
              主干发布预检
            </button>
          </div>
        </header>

        {page === 'overview' && <OverviewPage state={state} run={run} pending={pending} openLogs={() => setPage('logs')} />}
        {page === 'services' && <ServicesPage state={state} run={run} pending={pending} />}
        {page === 'extensions' && <ExtensionsPage state={state} selectedMcp={selectedMcp} setSelectedMcpId={setSelectedMcpId} run={run} pending={pending} />}
        {page === 'release' && <ReleasePage state={state} run={run} pending={pending} />}
        {page === 'sessions' && <SessionsPage state={state} run={run} pending={pending} />}
        {page === 'settings' && <SettingsPage state={state} run={run} pending={pending} />}
        {page === 'logs' && <LogsPage activities={activities} run={run} pending={pending} clearActivities={clearActivities} />}
      </main>
    </div>
  );
}

function OverviewPage({ state, run, pending, openLogs }: PageProps & { openLogs: () => void }) {
  return (
    <section className="page-grid overview-grid">
      <div className="hero-panel hero-panel-plain">
        <div className="hero-copy hero-copy-plain">
          <div className="eyebrow">运营控制台</div>
          <h2>桥接、扩展、发布状态集中到一个工作台。</h2>
          <p>当前协议 {state.suite.protocol}，最近刷新 {state.generatedAt}。主界面只保留运维动作和状态判断需要的信息。</p>
        </div>
        <div className="summary-grid">
          <SummaryFact label="Suite" value={state.suite.version} />
          <SummaryFact label="分支" value={state.suite.branch || 'loading'} />
          <SummaryFact label="Commit" value={state.suite.commit || 'loading'} />
          <SummaryFact label="发布门禁" value={state.release.prepareMainReleaseExists ? '就绪' : '缺失'} />
        </div>
      </div>
      <div className="metric-strip">
        <Metric label="扩展启用" value={`${state.extensions.enabled}/${state.extensions.total}`} />
        <Metric label="MCP 运行" value={`${state.mcp.running}/${state.mcp.total}`} />
        <Metric label="待提交" value={`${state.suite.gitDirty}`} />
        <Metric label="会话索引" value={`${state.history.sessions.length}`} />
      </div>
      <section className="panel service-overview">
        <SectionHeader title="服务状态" action={<MiniButton label="刷新" icon={<RefreshCw size={14} />} onClick={() => run('state.refresh')} pending={pending['state.refresh']} />} />
        <div className="service-list">
          {state.services.map((service) => <ServiceRow key={service.id} service={service} />)}
        </div>
      </section>
      <section className="panel activity-panel">
        <SectionHeader title="最近活动" action={<MiniButton label="日志" icon={<Terminal size={14} />} onClick={openLogs} />} />
        <ActivityList activities={state.activities.slice(-8)} compact />
      </section>
    </section>
  );
}

type PageProps = {
  state: PanelState;
  run: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
  pending: Record<string, boolean>;
};

function ServicesPage({ state, run, pending }: PageProps) {
  return (
    <section className="content-stack">
      <div className="command-band">
        <CommandButton label="启动桥接" command="bridge.start" icon={<Play size={16} />} run={run} pending={pending} />
        <CommandButton label="停止桥接" command="bridge.stop" icon={<Square size={16} />} run={run} pending={pending} />
        <CommandButton label="重启桥接" command="bridge.restart" icon={<RotateCw size={16} />} run={run} pending={pending} />
        <CommandButton label="注册全部 MCP" command="mcp.registerAll" icon={<PlugZap size={16} />} run={run} pending={pending} />
      </div>
      <section className="panel">
        <SectionHeader title="服务控制" />
        <div className="service-control-list">
          {state.services.slice(0, 4).map((service) => (
            <div className="service-control" key={service.id}>
              <ServiceRow service={service} />
              <div className="inline-actions">
                {service.id === 'bridge' && (
                  <>
                    <MiniButton label="状态" icon={<RefreshCw size={14} />} onClick={() => run('bridge.status')} pending={pending['bridge.status']} />
                    <MiniButton label="日志" icon={<FileText size={14} />} onClick={() => run('bridge.logs')} pending={pending['bridge.logs']} />
                  </>
                )}
                {service.id === 'codex' && <MiniButton label="检查" icon={<Search size={14} />} onClick={() => run('codex.check')} pending={pending['codex.check']} />}
                {service.id === 'localLlm' && (
                  <>
                    <MiniButton label="启动" icon={<Play size={14} />} onClick={() => run('localLlm.start')} pending={pending['localLlm.start']} />
                    <MiniButton label="停止" icon={<Square size={14} />} onClick={() => run('localLlm.stop')} pending={pending['localLlm.stop']} />
                    <MiniButton label="检查" icon={<Search size={14} />} onClick={() => run('localLlm.check')} pending={pending['localLlm.check']} />
                  </>
                )}
                {service.id === 'mcp' && <MiniButton label="刷新" icon={<RefreshCw size={14} />} onClick={() => run('mcp.list')} pending={pending['mcp.list']} />}
              </div>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}

function ExtensionsPage({ state, selectedMcp, setSelectedMcpId, run, pending }: PageProps & { selectedMcp?: McpItem; setSelectedMcpId: (id: string) => void }) {
  return (
    <section className="extensions-layout">
      <section className="panel list-panel">
        <SectionHeader title="扩展清单" action={<MiniButton label="刷新" icon={<RefreshCw size={14} />} onClick={() => run('mcp.list')} pending={pending['mcp.list']} />} />
        {state.extensions.items.length === 0 ? (
          <EmptyState icon={<Layers3 size={28} />} title="没有扩展清单" text="config/*.d 里没有可读取的 manifest。" />
        ) : (
          <div className="extension-table">
            {state.extensions.items.map((item) => (
              <div className="extension-row" key={item.manifestPath}>
                <div>
                  <strong>{item.displayName || item.id}</strong>
                  <span>{item.category || item.type}</span>
                </div>
                <StatusPill status={!item.sourceExists ? 'error' : item.enabled ? 'ok' : 'warning'} label={!item.sourceExists ? '缺依赖' : item.enabled ? '启用' : '禁用'} />
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="panel list-panel">
        <SectionHeader title="MCP 运维" />
        <div className="mcp-list">
          {state.mcp.items.map((item) => (
            <button className={selectedMcp?.id === item.id ? 'mcp-row active' : 'mcp-row'} key={item.id} onClick={() => setSelectedMcpId(item.id)}>
              <span>{item.displayName}</span>
              <StatusPill status={item.isRunning ? 'ok' : item.enabled ? 'warning' : 'idle'} label={item.isRunning ? '运行' : item.enabled ? '待机' : '禁用'} />
            </button>
          ))}
        </div>
      </section>
      <aside className="inspector">
        {selectedMcp ? (
          <>
            <div className="inspector-title">{selectedMcp.displayName}</div>
            <div className="inspector-meta">{selectedMcp.id} · {selectedMcp.type} · {selectedMcp.installState}</div>
            <p>{selectedMcp.description}</p>
            <div className="inline-actions wrap">
              <MiniButton label="启动" icon={<Play size={14} />} onClick={() => run('mcp.start', { id: selectedMcp.id })} pending={pending['mcp.start']} />
              <MiniButton label="停止" icon={<Square size={14} />} onClick={() => run('mcp.stop', { id: selectedMcp.id })} pending={pending['mcp.stop']} />
              <MiniButton label="检查" icon={<Search size={14} />} onClick={() => run('mcp.check', { id: selectedMcp.id })} pending={pending['mcp.check']} />
              <MiniButton label="打开目录" icon={<ExternalLink size={14} />} onClick={() => run('mcp.openLocation', { id: selectedMcp.id })} pending={pending['mcp.openLocation']} />
            </div>
            <dl className="kv">
              <dt>协议</dt><dd>{selectedMcp.protocol}</dd>
              <dt>版本</dt><dd>{selectedMcp.version}</dd>
              <dt>Suite</dt><dd>{selectedMcp.suiteRange}</dd>
              <dt>Source</dt><dd>{selectedMcp.source}</dd>
              <dt>Aliases</dt><dd>{selectedMcp.aliases.join(', ') || '-'}</dd>
            </dl>
          </>
        ) : (
          <EmptyState icon={<PlugZap size={28} />} title="选择一个 MCP" text="选择左侧 MCP 后查看状态和操作入口。" />
        )}
      </aside>
    </section>
  );
}

function ReleasePage({ state, run, pending }: PageProps) {
  return (
    <section className="release-layout">
      <div className="release-hero release-hero-plain">
        <div className="release-hero-copy">
          <div className="eyebrow">Release Gate</div>
          <h2>预检先生成产物和摘要，tag 只在干净主干执行。</h2>
          <p>当前分支 {state.suite.branch}，待提交 {state.suite.gitDirty} 项。主干动作只保留预检、摘要和历史入口。</p>
        </div>
        <div className="release-gates">
          <GateItem label="发布摘要" ok={state.release.publishSummaryExists} />
          <GateItem label="发布历史" ok={state.release.releaseNotesExists} />
          <GateItem label="预检脚本" ok={state.release.prepareMainReleaseExists} />
          <GateItem label="标签脚本" ok={state.release.tagScriptExists} />
        </div>
      </div>
      <section className="panel">
        <SectionHeader title="发布动作" />
        <div className="command-band tight">
          <CommandButton label="本机备份发布" command="release.publishBackup" icon={<PackageCheck size={16} />} run={run} pending={pending} />
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

function SessionsPage({ state, run, pending }: PageProps) {
  return (
    <section className="content-stack">
      <div className="command-band">
        <CommandButton label="同步全部历史" command="history.syncAll" icon={<RefreshCw size={16} />} run={run} pending={pending} />
        <CommandButton label="刷新同步状态" command="history.status" icon={<ListChecks size={16} />} run={run} pending={pending} />
        <CommandButton label="打开记忆仓库" command="path.openMemoryRepo" icon={<ExternalLink size={16} />} run={run} pending={pending} />
      </div>
      <section className="panel">
        <SectionHeader title="同步状态" />
        <pre className="code-block compact-code">{state.history.status || '暂无同步状态'}</pre>
      </section>
      <section className="panel">
        <SectionHeader title="会话索引" />
        <div className="session-list">
          {state.history.sessions.map((item) => (
            <div className="session-row" key={`${item.chatId}-${item.sessionId}`}>
              <div>
                <strong>{item.displayName || item.chatId}</strong>
                <span>{item.source} · {item.localMessageCount} 条 · {item.lastUpdatedAt}</span>
              </div>
              <code>{item.chatType || item.channelType}</code>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}

function SettingsPage({ state, run, pending }: PageProps) {
  const [settings, setSettings] = useState<SettingsState>(state.settings);
  useEffect(() => setSettings(state.settings), [state.settings]);
  const update = (key: keyof SettingsState, value: string) => setSettings((current) => ({ ...current, [key]: value }));
  return (
    <section className="settings-layout">
      <section className="panel">
        <SectionHeader title="路径配置" action={<MiniButton label="保存" icon={<CheckCircle2 size={14} />} onClick={() => run('settings.save', { settings })} pending={pending['settings.save']} />} />
        <Field label="默认工作目录" value={settings.defaultWorkDir} onChange={(value) => update('defaultWorkDir', value)} />
        <Field label="允许根目录" value={settings.allowedRoots} onChange={(value) => update('allowedRoots', value)} />
        <Field label="Unity 工程" value={settings.unityProject} onChange={(value) => update('unityProject', value)} />
        <Field label="记忆仓库" value={settings.memoryRepo} onChange={(value) => update('memoryRepo', value)} />
        <Field label="Codex 附加目录" value={settings.additionalDirs} onChange={(value) => update('additionalDirs', value)} />
      </section>
      <section className="panel">
        <SectionHeader title="回复风格" />
        <textarea className="text-area" value={settings.replyStyleHint} onChange={(event) => update('replyStyleHint', event.target.value)} />
      </section>
      <section className="panel">
        <SectionHeader title="快速打开" />
        <div className="command-band tight">
          <CommandButton label="配置文件" command="path.openConfig" icon={<ExternalLink size={16} />} run={run} pending={pending} />
          <CommandButton label="Manifest 目录" command="path.openManifestDir" icon={<ExternalLink size={16} />} run={run} pending={pending} />
          <CommandButton label="记忆仓库" command="path.openMemoryRepo" icon={<ExternalLink size={16} />} run={run} pending={pending} />
        </div>
      </section>
    </section>
  );
}

function LogsPage({ activities, run, pending, clearActivities }: { activities: ActivityRecord[]; run: PageProps['run']; pending: Record<string, boolean>; clearActivities: () => void }) {
  const [filter, setFilter] = useState('');
  const filtered = activities.filter((item) => `${item.title} ${item.message}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <section className="content-stack">
      <div className="filter-row">
        <Search size={16} />
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="过滤日志" />
        <button className="mini-button" onClick={() => run('bridge.logs')} disabled={pending['bridge.logs']}>
          <ExternalLink size={14} />打开
        </button>
        <button className="mini-button" onClick={() => navigator.clipboard?.writeText(filtered.map((item) => `[${item.timestamp}] ${item.title} ${item.message}`).join('\n'))}>
          <Clipboard size={14} />复制
        </button>
        <button className="mini-button" onClick={clearActivities}>
          <XCircle size={14} />清空
        </button>
      </div>
      <section className="panel">
        <ActivityList activities={filtered} />
      </section>
    </section>
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

function SummaryFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="summary-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({ status, label }: { status: StatusKind; label: string }) {
  const Icon = status === 'ok' ? CheckCircle2 : status === 'error' ? XCircle : status === 'warning' ? AlertTriangle : Activity;
  return (
    <span className={`status-pill ${status}`}>
      <Icon size={13} />{label}
    </span>
  );
}

function GateItem({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className={ok ? 'gate-item ok' : 'gate-item'}>
      {ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
      <span>{label}</span>
    </div>
  );
}

function ServiceRow({ service }: { service: ServiceItem }) {
  return (
    <div className="service-row">
      <div>
        <div className="service-title">{service.title}</div>
        <pre>{service.detail || '未检测'}</pre>
      </div>
      <StatusPill status={service.status} label={statusLabel(service.status)} />
    </div>
  );
}

function statusLabel(status: StatusKind) {
  if (status === 'ok') return '正常';
  if (status === 'warning') return '注意';
  if (status === 'error') return '异常';
  return '待检';
}

function CommandButton({ label, command, icon, run, pending }: { label: string; command: string; icon: React.ReactNode; run: PageProps['run']; pending: Record<string, boolean> }) {
  return (
    <button className="command-button" onClick={() => run(command)} disabled={pending[command]} title={label}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function MiniButton({ label, icon, onClick, pending }: { label: string; icon: React.ReactNode; onClick: () => void; pending?: boolean }) {
  return (
    <button className="mini-button" onClick={onClick} disabled={pending} title={label}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function ActivityList({ activities, compact = false }: { activities: ActivityRecord[]; compact?: boolean }) {
  if (activities.length === 0) return <div className="empty-inline">暂无活动记录</div>;
  return (
    <div className={compact ? 'activity-list compact' : 'activity-list'}>
      {[...activities].reverse().map((item, index) => (
        <div className={`activity-item ${item.level}`} key={`${item.timestamp}-${index}`}>
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

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
