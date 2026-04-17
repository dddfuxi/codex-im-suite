using System.Diagnostics;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace ClaudeToImControlPanel;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}

internal sealed class MainForm : Form
{
    private readonly string _skillDir;
    private readonly string _ctiHome;
    private readonly string _configPath;
    private readonly string _daemonScript;
    private readonly string _registerMcpScript;
    private readonly string _manifestDir;
    private readonly string _suiteRoot;
    private readonly string _publishBackupScript;
    private readonly string _localLlmStartScript;
    private readonly string _localLlmStopScript;
    private readonly string _localLlmHealthcheckScript;
    private readonly string _localLlmReadmePath;
    private readonly string _dataDir;
    private readonly string _messagesDir;
    private readonly string _statusJsonPath;
    private readonly string _mcpServiceStatePath;
    private readonly string _localLlmStatusPath;
    private readonly string _feishuChatIndexPath;
    private readonly string _feishuHistoryDir;
    private readonly string _feishuHistoryIndexPath;
    private FileSystemWatcher? _manifestWatcher;
    private System.Windows.Forms.Timer? _manifestReloadTimer;
    private string _pendingManifestReloadReason = "初始化";

    private readonly TextBox _workdir = new();
    private readonly TextBox _allowedRoots = new();
    private readonly TextBox _unityProject = new();
    private readonly TextBox _memoryRepo = new();
    private readonly TextBox _additionalDirs = new();

    private readonly TextBox _bridgeStatus = CreateStatusBox();
    private readonly TextBox _codexStatus = CreateStatusBox();
    private readonly TextBox _mcpStatus = CreateStatusBox();
    private readonly TextBox _localLlmStatus = CreateStatusBox();
    private readonly TextBox _buildStatus = CreateStatusBox();
    private readonly ListBox _mcpList = new();
    private readonly TextBox _mcpRuntimeStatus = new();
    private readonly TextBox _mcpDetails = new();
    private readonly TextBox _log = new();
    private readonly TextBox _historySyncStatus = new();
    private readonly TextBox _historySearchChat = new();
    private readonly TextBox _historySearchKeyword = new();
    private readonly TextBox _historySearchSpeaker = new();
    private readonly TextBox _historySearchStart = new();
    private readonly TextBox _historySearchEnd = new();
    private readonly TextBox _historySearchResults = new();

    private Dictionary<string, string> _config = new(StringComparer.OrdinalIgnoreCase);
    private List<McpManifest> _manifests = [];

    public MainForm()
    {
        _skillDir = FindSkillDir();
        _suiteRoot = FindSuiteRoot(_skillDir);
        _ctiHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude-to-im");
        _configPath = Path.Combine(_ctiHome, "config.env");
        _daemonScript = Path.Combine(_skillDir, "scripts", "daemon.ps1");
        _registerMcpScript = string.IsNullOrWhiteSpace(_suiteRoot)
            ? Path.Combine(_skillDir, "scripts", "register-external-mcps.ps1")
            : Path.Combine(_suiteRoot, "scripts", "register-external-mcps.ps1");
        _manifestDir = string.IsNullOrWhiteSpace(_suiteRoot)
            ? Path.Combine(_skillDir, "mcp.d")
            : Path.Combine(_suiteRoot, "config", "mcp.d");
        _publishBackupScript = string.IsNullOrWhiteSpace(_suiteRoot) ? "" : Path.Combine(_suiteRoot, "scripts", "publish-backup.ps1");
        var localLlmScriptRoot = string.IsNullOrWhiteSpace(_suiteRoot)
            ? Path.Combine(_skillDir, "scripts", "local-llm")
            : Path.Combine(_suiteRoot, "scripts", "local-llm");
        _localLlmStartScript = Path.Combine(localLlmScriptRoot, "start-local-llm.ps1");
        _localLlmStopScript = Path.Combine(localLlmScriptRoot, "stop-local-llm.ps1");
        _localLlmHealthcheckScript = Path.Combine(localLlmScriptRoot, "healthcheck-local-llm.ps1");
        _localLlmReadmePath = Path.Combine(localLlmScriptRoot, "README.md");
        _dataDir = Path.Combine(_ctiHome, "data");
        _messagesDir = Path.Combine(_dataDir, "messages");
        _statusJsonPath = Path.Combine(_ctiHome, "runtime", "status.json");
        _mcpServiceStatePath = Path.Combine(_ctiHome, "runtime", "mcp-services.json");
        _localLlmStatusPath = Path.Combine(_ctiHome, "runtime", "local-llm-status.json");
        _feishuChatIndexPath = Path.Combine(_dataDir, "feishu-chat-index.json");
        _feishuHistoryDir = Path.Combine(_dataDir, "feishu-history");
        _feishuHistoryIndexPath = Path.Combine(_dataDir, "feishu-history-index.json");

        Text = "飞书 / Codex / MCP 中控面板";
        StartPosition = FormStartPosition.CenterScreen;
        Width = 1380;
        Height = 1080;
        MinimumSize = new Size(1240, 920);
        Font = new Font("Microsoft YaHei UI", 9F);

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(12) };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 282));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 290));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Controls.Add(root);

        root.Controls.Add(BuildToolbarPanel(), 0, 0);
        root.Controls.Add(BuildStatusPanel(), 0, 1);
        root.Controls.Add(BuildConfigPanel(), 0, 2);
        root.Controls.Add(BuildWorkspacePanel(), 0, 3);

        Load += async (_, _) =>
        {
            LoadConfig();
            LoadManifests();
            RenderMcpList();
            InitializeManifestWatcher();
            await RefreshAllAsync();
        };
    }

    private Control BuildStatusPanel()
    {
        var group = new GroupBox { Text = "服务总览", Dock = DockStyle.Fill };
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 5, Padding = new Padding(8) };
        for (var i = 0; i < 5; i++) layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 20F));
        group.Controls.Add(layout);
        AddStatusCard(layout, "飞书桥接", _bridgeStatus, 0,
            CreateCardButton("启动", async () => await RunDaemonAsync("start")),
            CreateCardButton("停止", async () => await RunDaemonAsync("stop")),
            CreateCardButton("重启", async () => await RestartBridgeAsync()),
            CreateCardButton("日志", async () => await RunDaemonAsync("logs 120")));
        AddStatusCard(layout, "Codex CLI", _codexStatus, 1,
            CreateCardButton("检查", async () => await CheckCodexAsync()),
            CreateCardButton("混合模式", async () => await SetRouterModeAsync("hybrid")),
            CreateCardButton("仅本地", async () => await SetRouterModeAsync("local_only")),
            CreateCardButton("仅 Codex", async () => await SetRouterModeAsync("codex_only")),
            CreateCardButton("路由摘要", ShowLocalRouterSummary));
        AddStatusCard(layout, "MCP 清单", _mcpStatus, 2,
            CreateCardButton("注册全部", async () => await RegisterAllMcpsAsync()),
            CreateCardButton("刷新", async () => await RefreshAllAsync()));
        AddStatusCard(layout, "本地辅助执行器", _localLlmStatus, 3,
            CreateCardButton("启动", async () => await StartLocalLlmAsync()),
            CreateCardButton("停止", async () => await StopLocalLlmAsync()),
            CreateCardButton("检查", async () => await CheckLocalLlmAsync()),
            CreateCardButton("说明", OpenLocalLlmDocs),
            CreateCardButton("路由摘要", ShowLocalRouterSummary));
        AddStatusCard(layout, "版本信息", _buildStatus, 4);
        return group;
    }

    private Control BuildConfigPanel()
    {
        var group = new GroupBox { Text = "路径 / 配置", Dock = DockStyle.Fill };
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 6, Padding = new Padding(8) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 170));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 152));
        for (var i = 0; i < 5; i++) layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 80));
        group.Controls.Add(layout);

        AddPathRow(layout, 0, "默认工作目录", _workdir, true);
        AddPathRow(layout, 1, "允许仓库根目录", _allowedRoots, false);
        AddPathRow(layout, 2, "Unity 工程目录", _unityProject, true);
        AddPathRow(layout, 3, "聊天记忆仓库", _memoryRepo, true);
        AddPathRow(layout, 4, "Codex 附加目录", _additionalDirs, false);

        var hint = new Label { Text = "这里只保存非敏感路径配置。多个目录可用分号分隔，改完后点击“保存配置”，再重启飞书。", Dock = DockStyle.Fill, ForeColor = Color.DimGray, TextAlign = ContentAlignment.TopLeft };
        layout.Controls.Add(hint, 1, 5);

        var save = new Button { Text = "保存配置", Dock = DockStyle.Fill };
        save.Click += (_, _) => SaveConfigFromUi();
        layout.Controls.Add(save, 2, 5);
        return group;
    }

    private Control BuildToolbarPanel()
    {
        var host = new Panel { Dock = DockStyle.Fill, Padding = new Padding(0) };
        var strip = new ToolStrip
        {
            Dock = DockStyle.Fill,
            GripStyle = ToolStripGripStyle.Hidden,
            RenderMode = ToolStripRenderMode.System,
            Padding = new Padding(4, 2, 4, 2),
            CanOverflow = true,
            Stretch = true,
        };
        host.Controls.Add(strip);

        AddToolAction(strip, "刷新状态", async () => await RefreshAllAsync());
        AddToolAction(strip, "一键发布", async () => await PublishSuiteAsync());
        AddToolAction(strip, "查看会话", async () => await ShowConversationViewerAsync());
        AddToolAction(strip, "同步全部历史", async () => await SyncAllFeishuHistoryAsync());
        AddToolAction(strip, "查看同步状态", ShowFeishuHistorySyncStatus);
        AddToolAction(strip, "帮助", ShowHelp);
        strip.Items.Add(new ToolStripSeparator());
        AddToolAction(strip, "打开配置", () => OpenPath(_configPath));
        AddToolAction(strip, "打开 mcp.d", () => OpenPath(_manifestDir));
        AddToolAction(strip, "打开记忆仓库", () => OpenPath(_memoryRepo.Text));
        if (!string.IsNullOrWhiteSpace(_suiteRoot))
        {
            AddToolAction(strip, "打开最近发布摘要", OpenLatestPublishSummary);
            AddToolAction(strip, "打开发布历史", OpenReleaseNotes);
            AddToolAction(strip, "打开 Suite", () => OpenPath(_suiteRoot));
        }
        return host;
    }

    private Control BuildWorkspacePanel()
    {
        var outer = new SplitContainer
        {
            Dock = DockStyle.Fill,
            Orientation = Orientation.Horizontal,
            SplitterWidth = 8,
            FixedPanel = FixedPanel.None,
        };
        outer.Panel1.Controls.Add(BuildHistoryPanel());

        var lower = new SplitContainer
        {
            Dock = DockStyle.Fill,
            Orientation = Orientation.Horizontal,
            SplitterWidth = 8,
            FixedPanel = FixedPanel.None,
        };
        lower.Panel1.Controls.Add(BuildMcpPanel());
        lower.Panel2.Controls.Add(BuildLogPanel());
        outer.Panel2.Controls.Add(lower);

        return outer;
    }

    private Control BuildHistoryPanel()
    {
        var group = new GroupBox { Text = "历史索引", Dock = DockStyle.Fill };
        var container = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Padding = new Padding(8) };
        container.RowStyles.Add(new RowStyle(SizeType.Percent, 32));
        container.RowStyles.Add(new RowStyle(SizeType.Percent, 68));
        group.Controls.Add(container);

        var syncGroup = new GroupBox { Text = "历史同步状态", Dock = DockStyle.Fill };
        _historySyncStatus.Dock = DockStyle.Fill;
        _historySyncStatus.Multiline = true;
        _historySyncStatus.ReadOnly = true;
        _historySyncStatus.ScrollBars = ScrollBars.Both;
        _historySyncStatus.WordWrap = false;
        _historySyncStatus.Font = new Font("Consolas", 9F);
        syncGroup.Controls.Add(_historySyncStatus);
        container.Controls.Add(syncGroup, 0, 0);

        container.Controls.Add(BuildHistorySearchPanel(), 0, 1);
        return group;
    }

    private Control BuildHistorySearchPanel()
    {
        var group = new GroupBox { Text = "本地历史检索", Dock = DockStyle.Fill };
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 6, RowCount = 4, Padding = new Padding(6) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 78));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 34));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 78));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 34));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 78));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 32));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        group.Controls.Add(layout);

        layout.Controls.Add(new Label { Text = "群名/Chat", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight }, 0, 0);
        _historySearchChat.Dock = DockStyle.Fill;
        layout.Controls.Add(_historySearchChat, 1, 0);

        layout.Controls.Add(new Label { Text = "关键词", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight }, 2, 0);
        _historySearchKeyword.Dock = DockStyle.Fill;
        layout.Controls.Add(_historySearchKeyword, 3, 0);

        layout.Controls.Add(new Label { Text = "发言人", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight }, 4, 0);
        _historySearchSpeaker.Dock = DockStyle.Fill;
        layout.Controls.Add(_historySearchSpeaker, 5, 0);

        layout.Controls.Add(new Label { Text = "开始时间", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight }, 0, 1);
        _historySearchStart.Dock = DockStyle.Fill;
        _historySearchStart.PlaceholderText = "2026-04-15 09:00";
        layout.Controls.Add(_historySearchStart, 1, 1);

        layout.Controls.Add(new Label { Text = "结束时间", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight }, 2, 1);
        _historySearchEnd.Dock = DockStyle.Fill;
        _historySearchEnd.PlaceholderText = "2026-04-15 18:00";
        layout.Controls.Add(_historySearchEnd, 3, 1);

        var buttonPanel = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, AutoSize = true };
        var searchButton = new Button { Text = "检索历史", Width = 96, Height = 28 };
        searchButton.Click += (_, _) => RunHistorySearch();
        var clearButton = new Button { Text = "清空条件", Width = 96, Height = 28 };
        clearButton.Click += (_, _) =>
        {
            _historySearchChat.Clear();
            _historySearchKeyword.Clear();
            _historySearchSpeaker.Clear();
            _historySearchStart.Clear();
            _historySearchEnd.Clear();
            _historySearchResults.Clear();
        };
        buttonPanel.Controls.Add(searchButton);
        buttonPanel.Controls.Add(clearButton);
        layout.SetColumnSpan(buttonPanel, 3);
        layout.Controls.Add(buttonPanel, 3, 2);

        _historySearchResults.Dock = DockStyle.Fill;
        _historySearchResults.Multiline = true;
        _historySearchResults.ReadOnly = true;
        _historySearchResults.ScrollBars = ScrollBars.Both;
        _historySearchResults.WordWrap = false;
        _historySearchResults.Font = new Font("Consolas", 9F);
        layout.SetColumnSpan(_historySearchResults, 6);
        layout.Controls.Add(_historySearchResults, 0, 3);

        return group;
    }
    private Control BuildMcpPanel()
    {
        var group = new GroupBox { Text = "MCP 列表", Dock = DockStyle.Fill };
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Padding = new Padding(8) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 340));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        group.Controls.Add(layout);

        _mcpList.Dock = DockStyle.Fill;
        _mcpList.HorizontalScrollbar = true;
        _mcpList.SelectedIndexChanged += async (_, _) => await RenderSelectedMcpAsync();
        layout.Controls.Add(_mcpList, 0, 0);

        var right = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3 };
        right.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        right.RowStyles.Add(new RowStyle(SizeType.Absolute, 88));
        right.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.Controls.Add(right, 1, 0);

        var buttonBar = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, AutoScroll = true };
        AddAction(buttonBar, "启动", async () => await StartSelectedMcpAsync());
        AddAction(buttonBar, "停止", async () => await StopSelectedMcpAsync());
        AddAction(buttonBar, "检查", async () => await CheckSelectedMcpAsync());
        AddAction(buttonBar, "注册", async () => await RegisterSelectedMcpAsync());
        AddAction(buttonBar, "打开目录", OpenSelectedMcpPath);
        right.Controls.Add(buttonBar, 0, 0);

        _mcpRuntimeStatus.Dock = DockStyle.Fill;
        _mcpRuntimeStatus.Multiline = true;
        _mcpRuntimeStatus.ReadOnly = true;
        _mcpRuntimeStatus.ScrollBars = ScrollBars.Vertical;
        _mcpRuntimeStatus.Font = new Font("Consolas", 9F);
        right.Controls.Add(_mcpRuntimeStatus, 0, 1);

        _mcpDetails.Dock = DockStyle.Fill;
        _mcpDetails.Multiline = true;
        _mcpDetails.ReadOnly = true;
        _mcpDetails.ScrollBars = ScrollBars.Vertical;
        _mcpDetails.Font = new Font("Consolas", 9F);
        right.Controls.Add(_mcpDetails, 0, 2);
        return group;
    }

    private Control BuildLogPanel()
    {
        var group = new GroupBox { Text = "面板记录 / 执行过程", Dock = DockStyle.Fill };
        _log.Dock = DockStyle.Fill;
        _log.Multiline = true;
        _log.ScrollBars = ScrollBars.Vertical;
        _log.ReadOnly = true;
        _log.Font = new Font("Consolas", 9F);
        group.Controls.Add(_log);
        return group;
    }

    private static TextBox CreateStatusBox() => new()
    {
        BorderStyle = BorderStyle.None,
        Multiline = true,
        ReadOnly = true,
        ScrollBars = ScrollBars.Vertical,
        WordWrap = true,
        BackColor = SystemColors.Control,
        Font = new Font("Microsoft YaHei UI", 9F),
        Text = "未检测",
    };

    private static void AddStatusCard(TableLayoutPanel parent, string title, TextBox value, int col, params Button[] actions)
    {
        var panel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(8), BackColor = Color.WhiteSmoke };
        var titleLabel = new Label { Text = title, Dock = DockStyle.Top, Height = 24, Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold), TextAlign = ContentAlignment.MiddleLeft };
        value.Dock = DockStyle.Fill;
        panel.Controls.Add(value);
        if (actions.Length > 0)
        {
            var actionPanel = new FlowLayoutPanel
            {
                Dock = DockStyle.Top,
                WrapContents = true,
                AutoScroll = false,
                AutoSize = false,
                Height = 86,
                Margin = new Padding(0),
                Padding = new Padding(0),
                FlowDirection = FlowDirection.LeftToRight,
            };
            foreach (var button in actions) actionPanel.Controls.Add(button);
            panel.Controls.Add(actionPanel);
        }
        panel.Controls.Add(titleLabel);
        parent.Controls.Add(panel, col, 0);
    }

    private static Button CreateCardButton(string text, Action action)
    {
        var button = new Button { Text = text, AutoSize = true, Height = 26, Margin = new Padding(0, 0, 6, 0) };
        button.Click += (_, _) => action();
        return button;
    }

    private static Button CreateCardButton(string text, Func<Task> action)
    {
        var button = new Button { Text = text, AutoSize = true, Height = 26, Margin = new Padding(0, 0, 6, 0) };
        button.Click += async (_, _) => await action();
        return button;
    }

    private static void AddPathRow(TableLayoutPanel layout, int row, string label, TextBox box, bool browseFolder)
    {
        layout.Controls.Add(new Label { Text = label, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight }, 0, row);
        box.Dock = DockStyle.Fill;
        layout.Controls.Add(box, 1, row);
        var browse = new Button { Text = browseFolder ? "浏览" : "打开", Dock = DockStyle.Fill };
        browse.Click += (_, _) =>
        {
            if (browseFolder)
            {
                using var dialog = new FolderBrowserDialog { SelectedPath = Directory.Exists(box.Text) ? box.Text : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) };
                if (dialog.ShowDialog() == DialogResult.OK) box.Text = dialog.SelectedPath;
                return;
            }
            var first = box.Text.Split(';', ',').Select(s => s.Trim()).FirstOrDefault(p => File.Exists(p) || Directory.Exists(p));
            if (!string.IsNullOrWhiteSpace(first)) OpenPath(first);
        };
        layout.Controls.Add(browse, 2, row);
    }

    private static void AddAction(FlowLayoutPanel layout, string text, Func<Task> action)
    {
        var button = new Button { Text = text, Width = 118, Height = 34 };
        button.Click += async (_, _) =>
        {
            button.Enabled = false;
            try { await action(); }
            finally { button.Enabled = true; }
        };
        layout.Controls.Add(button);
    }

    private static void AddAction(FlowLayoutPanel layout, string text, Action action)
        => AddAction(layout, text, () => { action(); return Task.CompletedTask; });

    private static void AddToolAction(ToolStrip strip, string text, Func<Task> action)
    {
        var button = new ToolStripButton(text)
        {
            DisplayStyle = ToolStripItemDisplayStyle.Text,
            AutoSize = true,
        };
        button.Click += async (_, _) =>
        {
            button.Enabled = false;
            try { await action(); }
            finally { button.Enabled = true; }
        };
        strip.Items.Add(button);
    }

    private static void AddToolAction(ToolStrip strip, string text, Action action)
        => AddToolAction(strip, text, () => { action(); return Task.CompletedTask; });

    private void LoadConfig()
    {
        _config = ReadEnvFile(_configPath);
        _workdir.Text = GetConfig("CTI_DEFAULT_WORKDIR", @"C:\unity\ST3");
        _allowedRoots.Text = GetConfig("CTI_ALLOWED_WORKSPACE_ROOTS", @"C:\unity\ST3");
        _unityProject.Text = GetConfig("CTI_UNITY_PROJECT_PATH", @"C:\unity\ST3\Game");
        _memoryRepo.Text = GetConfig("CTI_MEMORY_REPO_DIR", @"E:\cli-md");
        _additionalDirs.Text = GetConfig("CTI_CODEX_ADDITIONAL_DIRECTORIES", "");
        AppendLog($"已读取配置：{_configPath}");
    }

    private void LoadManifests()
    {
        _manifests = [];
        Directory.CreateDirectory(_manifestDir);
        foreach (var file in Directory.GetFiles(_manifestDir, "*.json").OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var manifest = JsonSerializer.Deserialize<McpManifest>(File.ReadAllText(file, Encoding.UTF8), JsonOptions);
                if (manifest is null) continue;
                manifest.Id ??= Path.GetFileNameWithoutExtension(file);
                manifest.DisplayName ??= manifest.Id;
                manifest.ManifestPath = file;
                manifest.ServiceStatePath = _mcpServiceStatePath;
                _manifests.Add(manifest);
            }
            catch (Exception ex)
            {
                AppendLog($"MCP 清单读取失败：{file} {ex.Message}");
            }
        }
        var states = LoadMcpServiceStates();
        var running = _manifests.Count(m => TryGetRunningServiceState(m, states, out _));
        _mcpStatus.Text = $"发现 {_manifests.Count} 个清单{Environment.NewLine}启用 {_manifests.Count(m => m.Enabled != false)} 个{Environment.NewLine}运行 {running} 个";
    }

    private void RenderMcpList()
    {
        var selectedId = (_mcpList.SelectedItem as McpManifest)?.Id;
        _mcpList.BeginUpdate();
        _mcpList.Items.Clear();
        foreach (var manifest in _manifests) _mcpList.Items.Add(manifest);
        _mcpList.EndUpdate();
        if (_mcpList.Items.Count == 0)
        {
            _mcpDetails.Text = "暂无 MCP 清单。";
            _mcpRuntimeStatus.Text = "未选择 MCP。";
            return;
        }

        var selectedIndex = 0;
        if (!string.IsNullOrWhiteSpace(selectedId))
        {
            for (var i = 0; i < _mcpList.Items.Count; i++)
            {
                if (_mcpList.Items[i] is McpManifest item && string.Equals(item.Id, selectedId, StringComparison.OrdinalIgnoreCase))
                {
                    selectedIndex = i;
                    break;
                }
            }
        }
        _mcpList.SelectedIndex = selectedIndex;
    }

    private void InitializeManifestWatcher()
    {
        _manifestReloadTimer?.Stop();
        _manifestReloadTimer?.Dispose();
        _manifestWatcher?.Dispose();

        Directory.CreateDirectory(_manifestDir);

        _manifestReloadTimer = new System.Windows.Forms.Timer { Interval = 600 };
        _manifestReloadTimer.Tick += (_, _) =>
        {
            _manifestReloadTimer?.Stop();
            ReloadManifestList();
        };

        _manifestWatcher = new FileSystemWatcher(_manifestDir, "*.json")
        {
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.CreationTime | NotifyFilters.Size,
            IncludeSubdirectories = false,
            EnableRaisingEvents = true,
        };

        _manifestWatcher.Created += (_, e) => QueueManifestReload($"新增: {Path.GetFileName(e.FullPath)}");
        _manifestWatcher.Changed += (_, e) => QueueManifestReload($"更新: {Path.GetFileName(e.FullPath)}");
        _manifestWatcher.Deleted += (_, e) => QueueManifestReload($"删除: {Path.GetFileName(e.FullPath)}");
        _manifestWatcher.Renamed += (_, e) => QueueManifestReload($"重命名: {Path.GetFileName(e.OldFullPath)} -> {Path.GetFileName(e.FullPath)}");

        AppendLog($"已监听 MCP 清单目录：{_manifestDir}");
    }

    private void QueueManifestReload(string reason)
    {
        if (IsDisposed) return;

        void Schedule()
        {
            _pendingManifestReloadReason = reason;
            _manifestReloadTimer?.Stop();
            _manifestReloadTimer?.Start();
        }

        if (InvokeRequired) BeginInvoke((Action)Schedule);
        else Schedule();
    }

    private void ReloadManifestList()
    {
        try
        {
            LoadManifests();
            RenderMcpList();
            AppendLog($"自动导入 MCP 清单完成：{_pendingManifestReloadReason}");
        }
        catch (Exception ex)
        {
            AppendLog($"自动导入 MCP 清单失败：{ex.Message}");
        }
    }

    private async Task RenderSelectedMcpAsync()
    {
        if (_mcpList.SelectedItem is not McpManifest manifest)
        {
            _mcpDetails.Text = "未选择 MCP。";
            _mcpRuntimeStatus.Text = "未选择 MCP。";
            return;
        }
        _mcpDetails.Text = string.Join(Environment.NewLine, new[]
        {
            $"名称: {manifest.DisplayName}",
            $"ID: {manifest.Id}",
            $"类型: {manifest.Type}",
            $"启用: {manifest.Enabled != false}",
            $"Launcher: {ResolveManifestPath(manifest.Launcher, manifest)}",
            $"StopLauncher: {ResolveManifestPath(manifest.StopLauncher, manifest)}",
            $"CWD: {ResolveManifestDirectory(manifest.Cwd, manifest)}",
            $"RegisterName: {manifest.RegisterName}",
            $"Manifest: {manifest.ManifestPath}",
            "",
            manifest.Description ?? "",
        });
        await RefreshSelectedMcpRuntimeStatusAsync(manifest);
    }
    private string GetConfig(string key, string fallback)
        => _config.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value) ? value : fallback;

    private void SaveConfigFromUi()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_configPath)!);
        var lines = File.Exists(_configPath) ? File.ReadAllLines(_configPath, Encoding.UTF8).ToList() : [];
        SetOrAppendEnv(lines, "CTI_DEFAULT_WORKDIR", _workdir.Text.Trim());
        SetOrAppendEnv(lines, "CTI_ALLOWED_WORKSPACE_ROOTS", _allowedRoots.Text.Trim());
        SetOrAppendEnv(lines, "CTI_UNITY_PROJECT_PATH", _unityProject.Text.Trim());
        SetOrAppendEnv(lines, "CTI_MEMORY_REPO_DIR", _memoryRepo.Text.Trim());
        SetOrAppendEnv(lines, "CTI_CODEX_ADDITIONAL_DIRECTORIES", _additionalDirs.Text.Trim());
        File.WriteAllLines(_configPath, lines, new UTF8Encoding(false));
        AppendLog("配置已保存。建议随后重启飞书桥接。");
        LoadConfig();
    }

    private static void SetOrAppendEnv(List<string> lines, string key, string value)
    {
        var index = lines.FindIndex(line => line.TrimStart().StartsWith(key + "=", StringComparison.OrdinalIgnoreCase));
        var next = key + "=" + value;
        if (index >= 0) lines[index] = next; else lines.Add(next);
    }

    private async Task RefreshAllAsync()
    {
        LoadConfig();
        LoadManifests();
        await UpdateMcpManifestStatesAsync();
        RenderMcpList();
        await CheckBridgeAsync();
        await CheckCodexAsync(true);
        await CheckLocalLlmAsync(true);
        await RefreshBuildInfoAsync();
        RefreshFeishuHistorySyncStatusPanel();
        if (_mcpList.SelectedItem is McpManifest selected) await RefreshSelectedMcpRuntimeStatusAsync(selected);
    }

    private async Task CheckBridgeAsync()
    {
        var result = await RunPowerShellFileAsync(_daemonScript, "status", _skillDir, 60000);
        string statusText;
        try
        {
            var raw = File.Exists(_statusJsonPath) ? File.ReadAllText(_statusJsonPath, Encoding.UTF8) : "";
            var status = string.IsNullOrWhiteSpace(raw) ? null : JsonSerializer.Deserialize<BridgeRuntimeStatus>(raw, JsonOptions);
            var channels = status?.Channels is { Length: > 0 } ? string.Join(", ", status.Channels) : "(none)";
            statusText = status?.Running == true ? $"运行中{Environment.NewLine}PID {status.Pid}{Environment.NewLine}Channels: {channels}" : "未运行";
        }
        catch
        {
            statusText = result.Stdout.Contains("Bridge status: running", StringComparison.OrdinalIgnoreCase) ? "运行中" : "未运行";
        }
        _bridgeStatus.Text = statusText;
        AppendCommand("bridge status", result);
    }

    private async Task RunDaemonAsync(string action)
    {
        var result = await RunPowerShellFileAsync(_daemonScript, action, _skillDir, 90000);
        AppendCommand($"daemon {action}", result);
        await CheckBridgeAsync();
    }

    private async Task RestartBridgeAsync()
    {
        await RunDaemonAsync("stop");
        await RunDaemonAsync("start");
        await CheckCodexAsync(true);
        await CheckLocalLlmAsync(true);
    }

    private async Task CheckCodexAsync(bool updateOnly = false)
    {
        var routerMode = GetConfig("CTI_LOCAL_LLM_ROUTER_MODE", "hybrid");
        var result = await RunProcessAsync("powershell.exe", "-NoLogo -NoProfile -Command \"codex --version\"", _skillDir);
        var version = result.ExitCode == 0 ? FirstLine(result.Stdout) : "不可用";
        var codexPrimary = routerMode != "local_only";
        var stats = ReadLocalLlmStatus();
        var degradation = result.ExitCode == 0
            ? "降级: 正常"
            : (routerMode == "local_only" ? "降级: 已固定仅本地" : "降级: Codex 不可用，将回退本地");
        _codexStatus.Text = string.Join(Environment.NewLine, new[]
        {
            version,
            $"模式: {RouterModeToLabel(routerMode)}",
            $"主脑: {(codexPrimary ? "Codex" : "本地")}",
            $"最近一次请求: {FormatLastBrainStatus(stats)}",
            routerMode == "local_only" ? "升级: 关闭" : "升级: 允许",
            degradation,
        });
        if (!updateOnly) AppendCommand("codex version", result);
    }

    private async Task CheckLocalLlmAsync(bool updateOnly = false)
    {
        var enabled = !string.Equals(GetConfig("CTI_LOCAL_LLM_ENABLED", "true"), "false", StringComparison.OrdinalIgnoreCase);
        var routerMode = GetConfig("CTI_LOCAL_LLM_ROUTER_MODE", "hybrid");
        var baseUrl = GetConfig("CTI_LOCAL_LLM_BASE_URL", "http://127.0.0.1:8080");
        var model = GetConfig("CTI_LOCAL_LLM_MODEL", "qwen2.5-coder-7b-instruct");

        if (!enabled)
        {
            _localLlmStatus.Text = $"未启用{Environment.NewLine}{model}";
            if (!updateOnly) AppendLog("本地模型未启用。");
            return;
        }

        var (ok, message) = await ProbeLocalLlmAsync(baseUrl);
        var stats = ReadLocalLlmStatus();
        _localLlmStatus.Text = string.Join(Environment.NewLine, new[]
        {
            ok ? "在线" : "离线",
            model,
            $"角色: {(routerMode == "local_only" ? "本地执行主力" : "辅助执行器")}",
            $"模式 {RouterModeToLabel(stats.RouterMode ?? routerMode)}",
            "范围: 仅显式小活",
            $"本地 {stats.RouteHits} / 升级 {stats.EscalationCount}",
            $"执行 {stats.ExecutionCount} / 失败 {stats.ExecutionFailures}",
            $"兜底 {stats.LocalOnlyAnswers} / 拒答 {stats.LocalRefusals}",
            string.IsNullOrWhiteSpace(stats.LastRefusalReason)
                ? (string.IsNullOrWhiteSpace(stats.LastFallbackReason) ? TrimForStatus(stats.LastRouteReason ?? "暂无最近路由", 42) : TrimForStatus(stats.LastFallbackReason, 42))
                : TrimForStatus(stats.LastRefusalReason, 42),
        });

        if (!updateOnly)
        {
            AppendLog($"本地模型检查：{(ok ? "通过" : "失败")} | {message}");
        }
    }

    private async Task RefreshBuildInfoAsync()
    {
        var exePath = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(exePath))
        {
            exePath = Path.Combine(AppContext.BaseDirectory, "ClaudeToImControlPanel.exe");
        }
        var buildTime = File.Exists(exePath) ? File.GetLastWriteTime(exePath).ToString("yyyy-MM-dd HH:mm:ss") : "unknown";
        var branch = await RunGitTextAsync("branch --show-current");
        var commit = await RunGitTextAsync("rev-parse --short HEAD");
        _buildStatus.Text = $"构建时间: {buildTime}{Environment.NewLine}分支: {branch}{Environment.NewLine}Commit: {commit}";
    }

    private LocalLlmStatusRecord ReadLocalLlmStatus()
    {
        try
        {
            if (!File.Exists(_localLlmStatusPath)) return new LocalLlmStatusRecord();
            var raw = File.ReadAllText(_localLlmStatusPath, Encoding.UTF8);
            return string.IsNullOrWhiteSpace(raw)
                ? new LocalLlmStatusRecord()
                : JsonSerializer.Deserialize<LocalLlmStatusRecord>(raw, JsonOptions) ?? new LocalLlmStatusRecord();
        }
        catch
        {
            return new LocalLlmStatusRecord();
        }
    }

    private async Task<(bool Ok, string Message)> ProbeLocalLlmAsync(string baseUrl)
    {
        var targets = new[]
        {
            $"{baseUrl.TrimEnd('/')}/health",
            $"{baseUrl.TrimEnd('/')}/v1/models",
            baseUrl,
        };

        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        foreach (var target in targets)
        {
            try
            {
                using var response = await client.GetAsync(target);
                var code = (int)response.StatusCode;
                if (response.IsSuccessStatusCode || code is 400 or 401 or 403 or 404 or 405 or 406)
                {
                    return (true, $"在线 {code} | {target}");
                }
            }
            catch (Exception ex)
            {
                if (target == targets[^1]) return (false, $"{target} | {ex.Message}");
            }
        }

        return (false, $"{baseUrl} | 无有效响应");
    }

    private async Task<string> RunGitTextAsync(string args)
    {
        var cwd = string.IsNullOrWhiteSpace(_suiteRoot) ? _skillDir : _suiteRoot;
        var result = await RunProcessAsync("powershell.exe", $"-NoLogo -NoProfile -Command \"git {args}\"", cwd);
        return result.ExitCode == 0 ? FirstLine(result.Stdout) : "unknown";
    }

    private async Task RegisterAllMcpsAsync()
    {
        var result = await RunPowerShellFileAsync(_registerMcpScript, "", _skillDir, 120000);
        AppendCommand("注册全部 MCP", result);
        LoadManifests();
        await UpdateMcpManifestStatesAsync();
        RenderMcpList();
        if (_mcpList.SelectedItem is McpManifest selected) await RefreshSelectedMcpRuntimeStatusAsync(selected);
    }

    private async Task RegisterSelectedMcpAsync()
    {
        await RegisterAllMcpsAsync();
    }

    private async Task StartLocalLlmAsync()
    {
        if (!File.Exists(_localLlmStartScript))
        {
            AppendLog($"本地模型启动脚本不存在：{_localLlmStartScript}");
            return;
        }
        var result = await RunPowerShellFileAsync(_localLlmStartScript, "", _suiteRoot, 120000);
        AppendCommand("启动本地模型", result);
        await CheckLocalLlmAsync(true);
    }

    private async Task StopLocalLlmAsync()
    {
        if (!File.Exists(_localLlmStopScript))
        {
            AppendLog($"本地模型停止脚本不存在：{_localLlmStopScript}");
            return;
        }
        var result = await RunPowerShellFileAsync(_localLlmStopScript, "", _suiteRoot, 120000);
        AppendCommand("停止本地模型", result);
        await CheckLocalLlmAsync(true);
    }

    private void OpenLocalLlmDocs()
    {
        if (File.Exists(_localLlmReadmePath)) OpenPath(_localLlmReadmePath);
    }

    private async Task SetRouterModeAsync(string mode)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_configPath)!);
        var lines = File.Exists(_configPath) ? File.ReadAllLines(_configPath, Encoding.UTF8).ToList() : [];
        SetOrAppendEnv(lines, "CTI_LOCAL_LLM_ROUTER_ENABLED", "true");
        SetOrAppendEnv(lines, "CTI_LOCAL_LLM_FORCE_HUB", "true");
        SetOrAppendEnv(lines, "CTI_LOCAL_LLM_ROUTER_MODE", mode);
        SetOrAppendEnv(lines, "CTI_LOCAL_LLM_FALLBACK_TO_CODEX", mode == "local_only" ? "false" : "true");
        File.WriteAllLines(_configPath, lines, new UTF8Encoding(false));
        AppendLog($"已切换运行模式：{RouterModeToLabel(mode)}");
        LoadConfig();
        await CheckLocalLlmAsync(true);
        await CheckCodexAsync(true);
        await RestartBridgeAsync();
    }

    private void ShowLocalRouterSummary()
    {
        var status = ReadLocalLlmStatus();
        var lines = new List<string>
        {
            $"当前模式: {RouterModeToLabel(status.RouterMode ?? GetConfig("CTI_LOCAL_LLM_ROUTER_MODE", "hybrid"))}",
            $"最近本地命中: {status.RouteHits}",
            $"最近升级 Codex: {status.EscalationCount}",
            $"最近本地执行: {status.ExecutionCount}",
            $"最近执行失败: {status.ExecutionFailures}",
            $"最近本地兜底: {status.LocalOnlyAnswers}",
            $"最近本地拒答: {status.LocalRefusals}",
            "",
            "最近路由摘要:",
        };

        var routes = status.RecentRoutes ?? [];
        if (routes.Count == 0)
        {
            lines.Add("暂无路由记录。");
        }
        else
        {
            foreach (var route in routes.TakeLast(12).Reverse())
            {
                lines.Add($"[{route.Timestamp}] {FormatRouteLabel(route)} | {route.TaskKind}");
                lines.Add($"  原因: {route.Reason}");
                lines.Add($"  压缩: prompt={route.CompressedPromptChars}, history={route.CompressedHistoryChars}");
                if (!string.IsNullOrWhiteSpace(route.FallbackReason))
                {
                    lines.Add($"  回退: {route.FallbackReason}");
                }
            }
        }

        lines.Add("");
        lines.Add("最近本地执行摘要:");
        var executions = status.RecentExecutions ?? [];
        if (executions.Count == 0)
        {
            lines.Add("暂无执行记录。");
        }
        else
        {
            foreach (var execution in executions.TakeLast(12).Reverse())
            {
                lines.Add($"[{execution.Timestamp}] {(execution.Success ? "success" : "failed")} | {execution.Action} | steps={execution.StepCount}");
                lines.Add($"  原因: {execution.Reason}");
                lines.Add($"  摘要: {execution.Summary}");
            }
        }

        using var dialog = new Form
        {
            Text = "最近路由摘要",
            Width = 920,
            Height = 620,
            StartPosition = FormStartPosition.CenterParent,
            Font = new Font("Microsoft YaHei UI", 9F),
        };
        var box = new TextBox
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Both,
            WordWrap = false,
            Font = new Font("Consolas", 9F),
            Text = string.Join(Environment.NewLine, lines),
        };
        dialog.Controls.Add(box);
        dialog.ShowDialog(this);
    }

    private void OpenSelectedMcpPath()
    {
        if (_mcpList.SelectedItem is not McpManifest manifest) return;
        var cwd = ResolveManifestDirectory(manifest.Cwd, manifest);
        var launcher = ResolveManifestPath(manifest.Launcher, manifest);
        if (!string.IsNullOrWhiteSpace(cwd) && Directory.Exists(cwd))
        {
            OpenPath(cwd);
            return;
        }
        if (!string.IsNullOrWhiteSpace(launcher))
        {
            OpenPath(Path.GetDirectoryName(launcher) ?? launcher);
        }
    }

    private void OpenLatestPublishSummary()
    {
        if (string.IsNullOrWhiteSpace(_suiteRoot)) return;
        var path = Path.Combine(_suiteRoot, "publish-summary.md");
        if (File.Exists(path))
        {
            OpenPath(path);
            return;
        }
        MessageBox.Show(this, "还没有生成 publish-summary.md。请先执行一次一键发布。", "暂无发布摘要", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private void OpenReleaseNotes()
    {
        if (string.IsNullOrWhiteSpace(_suiteRoot)) return;
        var path = Path.Combine(_suiteRoot, "release-notes.md");
        if (File.Exists(path))
        {
            OpenPath(path);
            return;
        }
        MessageBox.Show(this, "还没有生成 release-notes.md。请先执行一次一键发布。", "暂无发布历史", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private async Task StartSelectedMcpAsync()
    {
        if (_mcpList.SelectedItem is not McpManifest manifest) return;
        if (manifest.Enabled == false)
        {
            AppendLog($"MCP 未启用，跳过启动：{manifest.DisplayName}");
            return;
        }

        var states = LoadMcpServiceStates();
        if (TryGetRunningServiceState(manifest, states, out var running))
        {
            AppendLog($"MCP 已在运行：{manifest.DisplayName} PID={running!.ProcessId}");
            await RefreshSelectedMcpRuntimeStatusAsync(manifest);
            return;
        }

        var launcher = ResolveManifestPath(manifest.Launcher, manifest);
        if (string.IsNullOrWhiteSpace(launcher) || !File.Exists(launcher))
        {
            AppendLog($"MCP 启动失败，launcher 不存在：{manifest.DisplayName} -> {launcher}");
            await RefreshSelectedMcpRuntimeStatusAsync(manifest);
            return;
        }

        var cwd = ResolveManifestDirectory(manifest.Cwd, manifest);
        if (string.IsNullOrWhiteSpace(cwd) || !Directory.Exists(cwd))
        {
            cwd = !string.IsNullOrWhiteSpace(_suiteRoot) && Directory.Exists(_suiteRoot) ? _suiteRoot : _skillDir;
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"{launcher.Replace("\"", "\"\"")}\"",
            WorkingDirectory = cwd,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        foreach (var pair in BuildManifestEnvironment(manifest))
        {
            startInfo.Environment[pair.Key] = pair.Value ?? "";
        }

        using var process = Process.Start(startInfo);
        if (process is null)
        {
            AppendLog($"MCP 启动失败：{manifest.DisplayName}");
            return;
        }

        await Task.Delay(1200);
        if (process.HasExited)
        {
            await UpdateMcpManifestStatesAsync();
            var healthAfterExit = await RunManifestHealthCheckAsync(manifest);
            if (IsHostManagedMcp(manifest) && healthAfterExit.Success)
            {
                AppendLog($"MCP 启动检查完成：{manifest.DisplayName} | 宿主服务已在线");
            }
            else
            {
                AppendLog($"MCP 启动后立即退出：{manifest.DisplayName} exit={process.ExitCode}");
            }
        }
        else
        {
            states[manifest.Id ?? manifest.DisplayName ?? Guid.NewGuid().ToString("N")] = new McpServiceState
            {
                Id = manifest.Id,
                DisplayName = manifest.DisplayName,
                ProcessId = process.Id,
                Launcher = launcher,
                WorkingDirectory = cwd,
                StartedAt = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
            };
            SaveMcpServiceStates(states);
            AppendLog($"MCP 已启动：{manifest.DisplayName} PID={process.Id}");
        }

        LoadManifests();
        await UpdateMcpManifestStatesAsync();
        RenderMcpList();
        await RefreshSelectedMcpRuntimeStatusAsync(manifest);
    }

    private async Task StopSelectedMcpAsync()
    {
        if (_mcpList.SelectedItem is not McpManifest manifest) return;
        var states = LoadMcpServiceStates();
        var key = manifest.Id ?? manifest.DisplayName ?? "";

        if (TryGetRunningServiceState(manifest, states, out var running))
        {
            try
            {
                var process = Process.GetProcessById(running!.ProcessId);
                process.Kill(entireProcessTree: true);
                process.WaitForExit(5000);
                AppendLog($"MCP 已停止：{manifest.DisplayName} PID={running.ProcessId}");
            }
            catch (Exception ex)
            {
                AppendLog($"MCP 停止失败：{manifest.DisplayName} {ex.Message}");
            }
            states.Remove(key);
            SaveMcpServiceStates(states);
            LoadManifests();
            await UpdateMcpManifestStatesAsync();
            RenderMcpList();
            await RefreshSelectedMcpRuntimeStatusAsync(manifest);
            return;
        }

        var stopLauncher = ResolveManifestPath(manifest.StopLauncher, manifest);
        if (!string.IsNullOrWhiteSpace(stopLauncher) && File.Exists(stopLauncher))
        {
            var result = await RunPowerShellFileAsync(stopLauncher, "", ResolveManifestDirectory(manifest.Cwd, manifest), 120000, BuildManifestEnvironment(manifest));
            AppendCommand($"停止 MCP {manifest.DisplayName}", result);
        }
        else
        {
            AppendLog($"MCP 没有可停止的托管进程：{manifest.DisplayName}");
        }

        states.Remove(key);
        SaveMcpServiceStates(states);
        LoadManifests();
        await UpdateMcpManifestStatesAsync();
        RenderMcpList();
        await RefreshSelectedMcpRuntimeStatusAsync(manifest);
    }

    private async Task CheckSelectedMcpAsync()
    {
        if (_mcpList.SelectedItem is not McpManifest manifest) return;
        await RefreshSelectedMcpRuntimeStatusAsync(manifest, appendLog: true);
        RenderMcpList();
    }

    private async Task RefreshSelectedMcpRuntimeStatusAsync(McpManifest manifest, bool appendLog = false)
    {
        var lines = new List<string>();
        var states = LoadMcpServiceStates();
        var tracked = TryGetRunningServiceState(manifest, states, out var state);
        manifest.IsRunning = tracked;
        var hostManaged = IsHostManagedMcp(manifest);
        lines.Add(hostManaged
            ? $"宿主服务: {(tracked ? "托管进程运行中" : "依赖外部宿主")}"
            : $"托管进程: {(tracked ? "运行中" : "未运行")}");

        if (tracked && state is not null)
        {
            lines.Add($"PID: {state.ProcessId}");
            lines.Add($"Started: {state.StartedAt}");
        }

        var health = await RunManifestHealthCheckAsync(manifest);
        manifest.HealthOk = health.Success;
        manifest.HealthSummary = health.Message;
        lines.Add($"检查结果: {(health.Success ? "通过" : "失败")}");
        lines.Add(health.Message);
        manifest.StatusBadge = BuildManifestStatusBadge(manifest);

        _mcpRuntimeStatus.Text = string.Join(Environment.NewLine, lines);
        if (appendLog)
        {
            AppendLog($"MCP 检查：{manifest.DisplayName} -> {(health.Success ? "通过" : "失败")} | {health.Message}");
        }
    }

    private async Task UpdateMcpManifestStatesAsync()
    {
        var states = LoadMcpServiceStates();
        HashSet<string> registered = new(StringComparer.OrdinalIgnoreCase);

        var codexList = await RunProcessAsync("powershell.exe", "-NoLogo -NoProfile -Command \"codex mcp list\"", _skillDir);
        if (codexList.ExitCode == 0)
        {
            foreach (var line in codexList.Stdout.Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries))
            {
                var name = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
                if (!string.IsNullOrWhiteSpace(name))
                {
                    registered.Add(name.Trim());
                }
            }
        }

        foreach (var manifest in _manifests)
        {
            manifest.IsRunning = TryGetRunningServiceState(manifest, states, out _);
            var registerName = !string.IsNullOrWhiteSpace(manifest.RegisterName) ? manifest.RegisterName! : manifest.Id ?? "";
            manifest.IsRegistered = !string.IsNullOrWhiteSpace(registerName) && registered.Contains(registerName);
            var health = await RunManifestHealthCheckAsync(manifest);
            manifest.HealthOk = health.Success;
            manifest.HealthSummary = health.Message;
            manifest.StatusBadge = BuildManifestStatusBadge(manifest);
        }
    }

    private static string BuildManifestStatusBadge(McpManifest manifest)
    {
        var parts = new List<string>();
        if (IsHostManagedMcp(manifest))
        {
            parts.Add(manifest.HealthOk == true ? "[宿主在线]" : "[宿主离线]");
        }
        else
        {
            parts.Add(manifest.IsRunning ? "[运行中]" : "[未运行]");
        }
        if (!string.IsNullOrWhiteSpace(manifest.RegisterName))
        {
            parts.Add(manifest.IsRegistered ? "[已注册]" : "[未注册]");
        }
        if (manifest.HealthOk.HasValue)
        {
            parts.Add(manifest.HealthOk.Value ? "[检查通过]" : "[检查失败]");
        }
        return string.Join("", parts);
    }

    private static bool IsHostManagedMcp(McpManifest manifest)
        => string.Equals(manifest.Type, "http", StringComparison.OrdinalIgnoreCase);

    private async Task<(bool Success, string Message)> RunManifestHealthCheckAsync(McpManifest manifest)
    {
        if (manifest.HealthCheck is null || string.IsNullOrWhiteSpace(manifest.HealthCheck.Kind))
        {
            return (false, "未配置 healthCheck");
        }

        var kind = manifest.HealthCheck.Kind.Trim().ToLowerInvariant();
        if (kind == "http")
        {
            var url = ExpandManifestValue(manifest.HealthCheck.Url);
            if (string.IsNullOrWhiteSpace(url)) return (false, "healthCheck.url 为空");
            try
            {
                using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
                using var response = await client.GetAsync(url);
                var code = (int)response.StatusCode;
                var online = code is >= 200 and < 300 or 400 or 401 or 403 or 404 or 405 or 406;
                var statusLabel = online ? "HTTP 在线" : "HTTP 异常";
                return (online, $"{statusLabel} {(int)response.StatusCode} {response.ReasonPhrase} | {url}");
            }
            catch (HttpRequestException ex) when (ex.StatusCode.HasValue)
            {
                var code = (int)ex.StatusCode.Value;
                var online = code is 400 or 401 or 403 or 404 or 405 or 406;
                var statusLabel = online ? "HTTP 在线" : "HTTP 异常";
                return (online, $"{statusLabel} {code} | {url} | {ex.Message}");
            }
            catch (TaskCanceledException ex)
            {
                return (false, $"HTTP 超时 | {url} | {ex.Message}");
            }
            catch (Exception ex)
            {
                return (false, $"HTTP 连接失败 | {url} | {ex.Message}");
            }
        }

        if (kind == "codex-mcp-list")
        {
            var name = !string.IsNullOrWhiteSpace(manifest.RegisterName) ? manifest.RegisterName! : manifest.Id ?? "";
            var result = await RunProcessAsync("powershell.exe", "-NoLogo -NoProfile -Command \"codex mcp list\"", _skillDir);
            var found = result.ExitCode == 0 && Regex.IsMatch(result.Stdout, $"(?m)^{Regex.Escape(name)}\\s");
            return found
                ? (true, $"已注册到 Codex: {name}")
                : (false, $"未在 Codex MCP 列表中发现: {name}");
        }

        return (false, $"未知 healthCheck.kind: {manifest.HealthCheck.Kind}");
    }

    private bool TryGetRunningServiceState(McpManifest manifest, Dictionary<string, McpServiceState> states, out McpServiceState? state)
    {
        state = null;
        var key = manifest.Id ?? manifest.DisplayName ?? "";
        if (!states.TryGetValue(key, out var candidate))
        {
            return false;
        }

        try
        {
            var process = Process.GetProcessById(candidate.ProcessId);
            if (process.HasExited)
            {
                states.Remove(key);
                SaveMcpServiceStates(states);
                return false;
            }
            state = candidate;
            return true;
        }
        catch
        {
            states.Remove(key);
            SaveMcpServiceStates(states);
            return false;
        }
    }

    private Dictionary<string, McpServiceState> LoadMcpServiceStates()
    {
        try
        {
            if (!File.Exists(_mcpServiceStatePath))
            {
                return new Dictionary<string, McpServiceState>(StringComparer.OrdinalIgnoreCase);
            }
            var raw = File.ReadAllText(_mcpServiceStatePath, Encoding.UTF8);
            return JsonSerializer.Deserialize<Dictionary<string, McpServiceState>>(raw, JsonOptions)
                   ?? new Dictionary<string, McpServiceState>(StringComparer.OrdinalIgnoreCase);
        }
        catch
        {
            return new Dictionary<string, McpServiceState>(StringComparer.OrdinalIgnoreCase);
        }
    }

    private void SaveMcpServiceStates(Dictionary<string, McpServiceState> states)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_mcpServiceStatePath)!);
        File.WriteAllText(_mcpServiceStatePath, JsonSerializer.Serialize(states, JsonOptions), new UTF8Encoding(false));
    }

    private Dictionary<string, string?> BuildManifestEnvironment(McpManifest manifest)
    {
        var env = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        if (manifest.Env is null) return env;
        foreach (var pair in manifest.Env)
        {
            env[pair.Key] = ExpandManifestValue(pair.Value);
        }
        return env;
    }

    private string ExpandManifestValue(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";
        var expanded = value
            .Replace("${SUITE_ROOT}", _suiteRoot ?? "")
            .Replace("${CTI_HOME}", _ctiHome)
            .Replace("${USERPROFILE}", Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));

        foreach (var pair in _config)
        {
            expanded = expanded.Replace("${" + pair.Key + "}", pair.Value ?? "");
        }

        return Environment.ExpandEnvironmentVariables(expanded);
    }

    private string ResolveManifestPath(string? value, McpManifest manifest)
    {
        var expanded = ExpandManifestValue(value);
        if (string.IsNullOrWhiteSpace(expanded)) return "";
        if (Uri.TryCreate(expanded, UriKind.Absolute, out var uri) && (uri.Scheme == "http" || uri.Scheme == "https")) return expanded;
        if (Path.IsPathRooted(expanded)) return Path.GetFullPath(expanded);
        var baseDir = manifest.ManifestPath is not null ? Path.GetDirectoryName(manifest.ManifestPath)! : (!string.IsNullOrWhiteSpace(_suiteRoot) ? _suiteRoot : _skillDir);
        return Path.GetFullPath(Path.Combine(baseDir, expanded));
    }

    private string ResolveManifestDirectory(string? value, McpManifest manifest)
    {
        var expanded = ExpandManifestValue(value);
        if (string.IsNullOrWhiteSpace(expanded)) return "";
        if (Path.IsPathRooted(expanded)) return Path.GetFullPath(expanded);
        var baseDir = manifest.ManifestPath is not null ? Path.GetDirectoryName(manifest.ManifestPath)! : (!string.IsNullOrWhiteSpace(_suiteRoot) ? _suiteRoot : _skillDir);
        return Path.GetFullPath(Path.Combine(baseDir, expanded));
    }

    private async Task PublishSuiteAsync()
    {
        if (string.IsNullOrWhiteSpace(_publishBackupScript) || !File.Exists(_publishBackupScript))
        {
            AppendLog("未找到 publish-backup.ps1。");
            return;
        }

        var preflight = await ValidatePowerShellScriptAsync(_publishBackupScript);
        if (!preflight.Success)
        {
            AppendLog($"发布前语法预检失败：{preflight.Message}");
            MessageBox.Show(
                this,
                $"发布前语法预检失败，已阻止继续发布。\n\n{preflight.Message}",
                "发布预检失败",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }
        AppendLog("发布前语法预检通过：PARSE_OK");

        var preview = await BuildPublishPreviewAsync();
        var confirm = MessageBox.Show(
            this,
            preview,
            "一键发布预览",
            MessageBoxButtons.OKCancel,
            MessageBoxIcon.Information);
        if (confirm != DialogResult.OK)
        {
            AppendLog("已取消一键发布。");
            return;
        }

        var result = await RunPowerShellFileAsync(_publishBackupScript, "", _suiteRoot, 900000);
        AppendCommand("一键发布", result);
        await RefreshBuildInfoAsync();
    }

    private async Task<(bool Success, string Message)> ValidatePowerShellScriptAsync(string scriptPath)
    {
        var escaped = scriptPath.Replace("'", "''");
        var command = "$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('" + escaped + "', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count -eq 0) { 'PARSE_OK'; exit 0 } else { $errors | Select-Object -First 8 | ForEach-Object { $_.Message }; exit 1 }";
        var result = await RunProcessAsync("powershell.exe", $"-NoLogo -NoProfile -Command \"{command}\"", _suiteRoot);
        if (result.ExitCode == 0)
        {
            return (true, "PARSE_OK");
        }

        var details = FirstNonEmptyLine(result.Stdout)
            ?? FirstNonEmptyLine(result.Stderr)
            ?? "Unknown PowerShell parse error.";
        return (false, details);
    }

    private async Task<string> BuildPublishPreviewAsync()
    {
        var cwd = string.IsNullOrWhiteSpace(_suiteRoot) ? _skillDir : _suiteRoot;
        var result = await RunProcessAsync("powershell.exe", "-NoLogo -NoProfile -Command \"git status --short\"", cwd);
        var lines = result.ExitCode == 0
            ? result.Stdout.Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries)
            : Array.Empty<string>();

        if (lines.Length == 0)
        {
            return "当前没有待发布改动。继续执行会只触发同步和打包，不会生成新的 git 提交。";
        }

        var mcpLines = lines.Where(line => Regex.IsMatch(line, @"config[\\/]+mcp\.d[\\/].+\.json|scripts[\\/]+(launch|stop)-.+-mcp\.ps1|extensions[\\/]+blender|packages[\\/]+mcp-")).ToList();
        var panelLines = lines.Where(line => Regex.IsMatch(line, @"apps[\\/]+control-panel[\\/]|packages[\\/]+bridge-runtime[\\/]+scripts[\\/]+build-control-panel\.ps1|scripts[\\/]+sync-live-skill\.ps1")).ToList();
        var otherLines = lines.Where(line => !mcpLines.Contains(line) && !panelLines.Contains(line)).ToList();

        var builder = new StringBuilder();
        builder.AppendLine("发布前摘要");
        builder.AppendLine();

        builder.AppendLine("MCP 相关改动：");
        if (mcpLines.Count == 0) builder.AppendLine("- 无");
        else
        {
            foreach (var line in mcpLines.Take(12)) builder.AppendLine("- " + line.Trim());
            if (mcpLines.Count > 12) builder.AppendLine($"- ... 其余 {mcpLines.Count - 12} 条");
        }

        builder.AppendLine();
        builder.AppendLine("面板相关改动：");
        if (panelLines.Count == 0) builder.AppendLine("- 无");
        else
        {
            foreach (var line in panelLines.Take(10)) builder.AppendLine("- " + line.Trim());
            if (panelLines.Count > 10) builder.AppendLine($"- ... 其余 {panelLines.Count - 10} 条");
        }

        if (otherLines.Count > 0)
        {
            builder.AppendLine();
            builder.AppendLine("其他改动：");
            foreach (var line in otherLines.Take(10)) builder.AppendLine("- " + line.Trim());
            if (otherLines.Count > 10) builder.AppendLine($"- ... 其余 {otherLines.Count - 10} 条");
        }

        builder.AppendLine();
        builder.AppendLine("确认后将执行：同步 -> 打包 -> git add/commit -> git push");
        builder.AppendLine("git 提交信息会自动整理包含 MCP/面板更新摘要。");
        return builder.ToString().TrimEnd();
    }

    private void ShowHelp()
    {
        var helpText = string.Join(Environment.NewLine, new[]
        {
            "常用操作",
            "1. 启动飞书后，先点刷新状态，确认飞书桥接为运行中。",
            "2. 改路径后先保存配置，再重启飞书。",
            "3. 注册全部 MCP 用于重新加载外部 MCP。",
            "4. 查看会话优先读取飞书远端会话，再叠加本地 session / 工作目录 / 记忆信息。",
            "5. 一键发布会先同步当前运行 skill，再打包并推送 suite。",
        });
        MessageBox.Show(this, helpText, "中控面板帮助", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private async Task ShowConversationViewerAsync()
    {
        try
        {
            var localEntries = LoadConversationEntries();
            var entries = await LoadRemoteConversationEntriesAsync(localEntries);
            using var form = new ConversationViewerForm(entries, _dataDir, LoadConversationDetailAsync);
            form.ShowDialog(this);
        }
        catch (Exception ex)
        {
            AppendLog($"打开会话查看器失败：{ex}");
            MessageBox.Show(this, ex.Message, "会话查看失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private List<ConversationEntry> LoadConversationEntries()
    {
        var bindingsPath = Path.Combine(_dataDir, "bindings.json");
        var sessionsPath = Path.Combine(_dataDir, "sessions.json");
        var feishuChatIndex = File.Exists(_feishuChatIndexPath)
            ? JsonSerializer.Deserialize<Dictionary<string, FeishuChatIndexRecord>>(File.ReadAllText(_feishuChatIndexPath, Encoding.UTF8), JsonOptions)
            : new Dictionary<string, FeishuChatIndexRecord>(StringComparer.OrdinalIgnoreCase);
        var bindings = File.Exists(bindingsPath) ? JsonSerializer.Deserialize<Dictionary<string, ChannelBindingRecord>>(File.ReadAllText(bindingsPath, Encoding.UTF8), JsonOptions) : new Dictionary<string, ChannelBindingRecord>(StringComparer.OrdinalIgnoreCase);
        var sessions = File.Exists(sessionsPath) ? JsonSerializer.Deserialize<Dictionary<string, SessionRecord>>(File.ReadAllText(sessionsPath, Encoding.UTF8), JsonOptions) : new Dictionary<string, SessionRecord>(StringComparer.OrdinalIgnoreCase);
        feishuChatIndex ??= new Dictionary<string, FeishuChatIndexRecord>(StringComparer.OrdinalIgnoreCase);
        bindings ??= new Dictionary<string, ChannelBindingRecord>(StringComparer.OrdinalIgnoreCase);
        sessions ??= new Dictionary<string, SessionRecord>(StringComparer.OrdinalIgnoreCase);

        var entries = new List<ConversationEntry>();
        var boundSessionIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in bindings.OrderByDescending(p => p.Value?.UpdatedAt))
        {
            var binding = pair.Value ?? new ChannelBindingRecord();
            var sessionId = binding.CodepilotSessionId ?? "";
            if (!string.IsNullOrWhiteSpace(sessionId)) boundSessionIds.Add(sessionId);
            sessions.TryGetValue(sessionId, out var session);
            entries.Add(BuildConversationEntry(pair.Key, binding, session));
        }
        foreach (var pair in sessions.OrderByDescending(p => ReadMessageFileTimestamp(p.Key)))
        {
            if (boundSessionIds.Contains(pair.Key)) continue;
            entries.Add(BuildConversationEntry(null, null, pair.Value));
        }

        foreach (var pair in feishuChatIndex.OrderByDescending(p => ParseDateTime(p.Value?.UpdatedAt) ?? ParseDateTime(p.Value?.LastMessageAt)))
        {
            var chatId = pair.Key;
            if (entries.Any(entry => string.Equals(entry.ChatId, chatId, StringComparison.OrdinalIgnoreCase))) continue;
            entries.Add(new ConversationEntry
            {
                BindingKey = "",
                ChannelType = "feishu",
                ChatId = chatId,
                ChatType = pair.Value?.ChatType ?? "",
                DisplayName = pair.Value?.DisplayName ?? chatId,
                SessionId = "",
                WorkingDirectory = "",
                SdkSessionId = "",
                LastUpdatedAt = ParseDateTime(pair.Value?.LastMessageAt) ?? ParseDateTime(pair.Value?.UpdatedAt),
                Summary = "仅本地会话索引",
                Messages = [],
                Source = "仅本地索引",
                HasLocalBinding = false,
                LocalMessageCount = 0,
                RemoteLoaded = false,
            });
        }
        return entries.OrderByDescending(e => e.LastUpdatedAt ?? DateTime.MinValue).ToList();
    }

    private async Task<List<ConversationEntry>> LoadRemoteConversationEntriesAsync(List<ConversationEntry> localEntries)
    {
        var localByChatId = localEntries
            .Where(entry => string.Equals(entry.ChannelType, "feishu", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(entry.ChatId))
            .GroupBy(entry => entry.ChatId, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.OrderByDescending(entry => entry.LastUpdatedAt ?? DateTime.MinValue).First(), StringComparer.OrdinalIgnoreCase);

        var merged = new List<ConversationEntry>();
        try
        {
            var remoteChats = await FetchFeishuRemoteChatsAsync();
            var remoteChatIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var chat in remoteChats)
            {
                if (string.IsNullOrWhiteSpace(chat.ChatId)) continue;
                remoteChatIds.Add(chat.ChatId);
                localByChatId.TryGetValue(chat.ChatId, out var local);
                merged.Add(new ConversationEntry
                {
                    BindingKey = local?.BindingKey ?? "",
                    ChannelType = "feishu",
                    ChatId = chat.ChatId,
                    ChatType = chat.ChatType,
                    DisplayName = string.IsNullOrWhiteSpace(chat.DisplayName) ? (local?.DisplayName ?? chat.ChatId) : chat.DisplayName,
                    SessionId = local?.SessionId ?? "",
                    WorkingDirectory = local?.WorkingDirectory ?? "",
                    SdkSessionId = local?.SdkSessionId ?? "",
                    LastUpdatedAt = chat.LastUpdatedAt ?? local?.LastUpdatedAt,
                    Summary = local?.Summary ?? "远端飞书会话",
                    Messages = local?.Messages ?? [],
                    Source = local is null ? "远端" : "远端 + 本地绑定",
                    HasLocalBinding = local is not null,
                    LocalMessageCount = local?.Messages.Count ?? 0,
                    RemoteLoaded = false,
                });
            }

            foreach (var local in localEntries)
            {
                if (!string.Equals(local.ChannelType, "feishu", StringComparison.OrdinalIgnoreCase) || string.IsNullOrWhiteSpace(local.ChatId) || !remoteChatIds.Contains(local.ChatId))
                {
                    local.Source = string.Equals(local.ChannelType, "feishu", StringComparison.OrdinalIgnoreCase)
                        ? "仅本地（远端当前不可见）"
                        : "仅本地";
                    local.HasLocalBinding = !string.IsNullOrWhiteSpace(local.BindingKey);
                    local.LocalMessageCount = local.Messages.Count;
                    merged.Add(local);
                }
            }
        }
        catch (Exception ex)
        {
            AppendLog($"飞书远端会话读取失败，回退到本地视图：{ex.Message}");
            foreach (var local in localEntries)
            {
                local.Source = "仅本地";
                local.HasLocalBinding = !string.IsNullOrWhiteSpace(local.BindingKey);
                local.LocalMessageCount = local.Messages.Count;
            }
            merged.AddRange(localEntries);
        }

        return merged.OrderByDescending(entry => entry.LastUpdatedAt ?? DateTime.MinValue).ToList();
    }

    private ConversationEntry BuildConversationEntry(string? bindingKey, ChannelBindingRecord? binding, SessionRecord? session)
    {
        var sessionId = binding?.CodepilotSessionId ?? session?.Id ?? "";
        var messages = LoadConversationMessages(sessionId);
        return new ConversationEntry
        {
            BindingKey = bindingKey ?? "",
            ChannelType = binding?.ChannelType ?? "",
            ChatId = binding?.ChatId ?? "",
            ChatType = binding?.ChatType ?? "",
            DisplayName = binding?.DisplayName ?? binding?.ChatId ?? sessionId,
            SessionId = sessionId,
            WorkingDirectory = binding?.WorkingDirectory ?? session?.WorkingDirectory ?? "",
            SdkSessionId = binding?.SdkSessionId ?? session?.SdkSessionId ?? "",
            LastUpdatedAt = ParseDateTime(binding?.UpdatedAt) ?? ReadMessageFileTimestamp(sessionId),
            Summary = BuildConversationSummary(messages),
            Messages = messages,
            Source = "仅本地",
            HasLocalBinding = !string.IsNullOrWhiteSpace(bindingKey),
            LocalMessageCount = messages.Count,
            RemoteLoaded = false,
        };
    }

    private async Task<ConversationEntry> LoadConversationDetailAsync(ConversationEntry entry)
    {
        if (!string.Equals(entry.ChannelType, "feishu", StringComparison.OrdinalIgnoreCase) || string.IsNullOrWhiteSpace(entry.ChatId))
        {
            entry.RemoteLoaded = true;
            return entry;
        }

        var indexedMessages = LoadIndexedFeishuHistoryMessages(entry.ChatId, 400);
        if (indexedMessages.Count == 0)
        {
            await SyncFeishuChatHistoryAsync(entry.ChatId, entry.DisplayName, entry.ChatType, false);
            indexedMessages = LoadIndexedFeishuHistoryMessages(entry.ChatId, 400);
        }
        entry.Messages = indexedMessages;
        entry.Summary = BuildConversationSummary(indexedMessages);
        entry.RemoteLoaded = true;
        return entry;
    }
    private List<ConversationMessageView> LoadConversationMessages(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId)) return [];
        var filePath = Path.Combine(_messagesDir, $"{sessionId}.json");
        if (!File.Exists(filePath)) return [];
        try
        {
            var items = JsonSerializer.Deserialize<List<StoredBridgeMessage>>(File.ReadAllText(filePath, Encoding.UTF8), JsonOptions) ?? [];
            return items.Select((item, index) => new ConversationMessageView
            {
                Index = index + 1,
                Role = item.Role ?? "unknown",
                CreatedAt = ParseDateTime(item.CreatedAt),
                Content = FormatStoredMessageContent(item.Content ?? ""),
            }).ToList();
        }
        catch (Exception ex)
        {
            return [new ConversationMessageView { Index = 1, Role = "system", Content = $"读取消息失败：{ex.Message}" }];
        }
    }

    private static string BuildConversationSummary(List<ConversationMessageView> messages)
    {
        if (messages.Count == 0) return "暂无消息";
        var lastUser = messages.LastOrDefault(m => string.Equals(m.Role, "user", StringComparison.OrdinalIgnoreCase));
        var lastAssistant = messages.LastOrDefault(m => string.Equals(m.Role, "assistant", StringComparison.OrdinalIgnoreCase));
        var parts = new List<string>();
        if (lastUser is not null) parts.Add("用户：" + TrimForSummary(lastUser.Content, 40));
        if (lastAssistant is not null) parts.Add("助手：" + TrimForSummary(lastAssistant.Content, 40));
        return parts.Count > 0 ? string.Join(" | ", parts) : "暂无有效摘要";
    }

    private static string FormatStoredMessageContent(string raw)
    {
        var trimmed = raw.Trim();
        if (string.IsNullOrWhiteSpace(trimmed)) return "";
        if (trimmed.StartsWith("[[CTI_SUMMARY]]", StringComparison.Ordinal)) return trimmed["[[CTI_SUMMARY]]".Length..].Trim();
        if (!trimmed.StartsWith("[", StringComparison.Ordinal)) return trimmed;
        try
        {
            var blocks = JsonSerializer.Deserialize<List<StoredContentBlock>>(trimmed, JsonOptions) ?? [];
            var parts = new List<string>();
            foreach (var block in blocks)
            {
                switch ((block.Type ?? "").Trim())
                {
                    case "text":
                        if (!string.IsNullOrWhiteSpace(block.Text)) parts.Add(block.Text.Trim());
                        break;
                    case "tool_use":
                        parts.Add($"[工具开始] {block.Name ?? "tool"}");
                        break;
                    case "tool_result":
                        parts.Add($"[工具结果] {TrimForSummary(block.Content ?? "", 240)}");
                        break;
                }
            }
            return parts.Count > 0 ? string.Join(Environment.NewLine + Environment.NewLine, parts) : trimmed;
        }
        catch
        {
            return trimmed;
        }
    }

    private DateTime? ReadMessageFileTimestamp(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId)) return null;
        var filePath = Path.Combine(_messagesDir, $"{sessionId}.json");
        return File.Exists(filePath) ? File.GetLastWriteTime(filePath) : null;
    }

    private async Task<List<ConversationEntry>> FetchFeishuRemoteChatsAsync()
    {
        var auth = await FetchFeishuTenantAccessTokenAsync();
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        var entries = new List<ConversationEntry>();
        string? pageToken = null;

        while (true)
        {
            var url = $"{auth.BaseUrl}/open-apis/im/v1/chats?page_size=50";
            if (!string.IsNullOrWhiteSpace(pageToken)) url += $"&page_token={Uri.EscapeDataString(pageToken)}";
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {auth.Token}");
            using var response = await http.SendAsync(request);
            var payload = await response.Content.ReadAsStringAsync();
            using var document = JsonDocument.Parse(payload);
            var root = document.RootElement;
            var code = root.TryGetProperty("code", out var codeEl) ? codeEl.GetInt32() : response.IsSuccessStatusCode ? 0 : (int)response.StatusCode;
            if (!response.IsSuccessStatusCode || code != 0)
            {
                var msg = root.TryGetProperty("msg", out var msgEl) ? msgEl.GetString() : response.ReasonPhrase;
                throw new InvalidOperationException($"Feishu chats.list failed [{code}]: {msg}");
            }

            var data = root.TryGetProperty("data", out var dataEl) ? dataEl : default;
            if (data.ValueKind == JsonValueKind.Object && data.TryGetProperty("items", out var itemsEl) && itemsEl.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in itemsEl.EnumerateArray())
                {
                    var chatId = GetJsonString(item, "chat_id");
                    if (string.IsNullOrWhiteSpace(chatId)) continue;
                    entries.Add(new ConversationEntry
                    {
                        ChannelType = "feishu",
                        ChatId = chatId,
                        ChatType = GetJsonString(item, "chat_type") ?? GetJsonString(item, "chat_mode") ?? "",
                        DisplayName = GetJsonString(item, "name") ?? chatId,
                        LastUpdatedAt = ParseUnixMsOrIso(GetJsonString(item, "last_message_time")),
                    });
                }
            }

            var hasMore = data.ValueKind == JsonValueKind.Object
                && data.TryGetProperty("has_more", out var hasMoreEl)
                && hasMoreEl.ValueKind is JsonValueKind.True or JsonValueKind.False
                && hasMoreEl.GetBoolean();
            pageToken = data.ValueKind == JsonValueKind.Object ? GetJsonString(data, "page_token") : null;
            if (!hasMore || string.IsNullOrWhiteSpace(pageToken)) break;
        }

        return entries;
    }

    private async Task<List<FeishuIndexedMessageRecord>> FetchFeishuRemoteMessagesAsync(string chatId, int limit, string? pageToken = null)
    {
        var auth = await FetchFeishuTenantAccessTokenAsync();
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        var url = $"{auth.BaseUrl}/open-apis/im/v1/messages?container_id_type=chat&container_id={Uri.EscapeDataString(chatId)}&sort_type=ByCreateTimeDesc&page_size={Math.Min(50, Math.Max(1, limit))}";
        if (!string.IsNullOrWhiteSpace(pageToken)) url += $"&page_token={Uri.EscapeDataString(pageToken)}";
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {auth.Token}");
        using var response = await http.SendAsync(request);
        var payload = await response.Content.ReadAsStringAsync();
        using var document = JsonDocument.Parse(payload);
        var root = document.RootElement;
        var code = root.TryGetProperty("code", out var codeEl) ? codeEl.GetInt32() : response.IsSuccessStatusCode ? 0 : (int)response.StatusCode;
        if (!response.IsSuccessStatusCode || code != 0)
        {
            var msg = root.TryGetProperty("msg", out var msgEl) ? msgEl.GetString() : response.ReasonPhrase;
            throw new InvalidOperationException($"Feishu message.list failed [{code}]: {msg}");
        }

        var result = new List<FeishuIndexedMessageRecord>();
        var data = root.TryGetProperty("data", out var dataEl) ? dataEl : default;
        if (data.ValueKind == JsonValueKind.Object && data.TryGetProperty("items", out var itemsEl) && itemsEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in itemsEl.EnumerateArray())
            {
                if (item.TryGetProperty("deleted", out var deletedEl) && deletedEl.ValueKind is JsonValueKind.True) continue;
                if (string.Equals(GetJsonString(item, "msg_type"), "system", StringComparison.OrdinalIgnoreCase)) continue;
                result.Add(new FeishuIndexedMessageRecord
                {
                    MessageId = GetJsonString(item, "message_id") ?? "",
                    ChatId = chatId,
                    CreateTime = GetJsonString(item, "create_time") ?? "",
                    MsgType = GetJsonString(item, "msg_type") ?? "",
                    SenderId = item.TryGetProperty("sender", out var senderEl) ? GetJsonString(senderEl, "id") : "",
                    SenderType = item.TryGetProperty("sender", out senderEl) ? GetJsonString(senderEl, "sender_type") : "",
                    Text = ExtractFeishuMessageText(item),
                });
            }
        }

        var hasMore = data.ValueKind == JsonValueKind.Object
            && data.TryGetProperty("has_more", out var hasMoreEl)
            && hasMoreEl.ValueKind is JsonValueKind.True or JsonValueKind.False
            && hasMoreEl.GetBoolean();
        var nextPageToken = data.ValueKind == JsonValueKind.Object ? GetJsonString(data, "page_token") : null;
        if (result.Count > 0)
        {
            result[^1].HasMore = hasMore;
            result[^1].NextPageToken = nextPageToken;
        }
        return result;
    }

    private async Task SyncAllFeishuHistoryAsync()
    {
        var chats = await FetchFeishuRemoteChatsAsync();
        var synced = 0;
        foreach (var chat in chats.Where(chat => !string.IsNullOrWhiteSpace(chat.ChatId)))
        {
            await SyncFeishuChatHistoryAsync(chat.ChatId, chat.DisplayName, chat.ChatType, true);
            synced += 1;
            AppendLog($"已同步飞书历史：{chat.DisplayName} ({chat.ChatId})");
        }
        AppendLog($"飞书全历史同步完成，共 {synced} 个会话。");
        RefreshFeishuHistorySyncStatusPanel();
    }

    private async Task SyncFeishuChatHistoryAsync(string chatId, string? displayName, string? chatType, bool full)
    {
        Directory.CreateDirectory(_feishuHistoryDir);
        var existing = LoadIndexedFeishuHistoryRaw(chatId);
        var latestKnown = existing.Count > 0
            ? existing.Max(item => long.TryParse(item.CreateTime, out var parsed) ? parsed : 0L)
            : 0L;
        var merged = existing.ToDictionary(item => item.MessageId, StringComparer.OrdinalIgnoreCase);
        var speakerNames = await FetchFeishuChatMemberNamesAsync(chatId);
        string? pageToken = null;

        while (true)
        {
            var page = await FetchFeishuRemoteMessagesAsync(chatId, 50, pageToken);
            if (page.Count == 0) break;

            foreach (var item in page)
            {
                if (!string.IsNullOrWhiteSpace(item.SenderId) && speakerNames.TryGetValue(item.SenderId, out var speakerName))
                {
                    item.SenderName = speakerName;
                }
                merged[item.MessageId] = item;
            }

            if (!full)
            {
                var hasNewer = page.Any(item => long.TryParse(item.CreateTime, out var parsed) && parsed > latestKnown);
                if (!hasNewer) break;
            }

            var marker = page.LastOrDefault();
            if (marker is null || !marker.HasMore || string.IsNullOrWhiteSpace(marker.NextPageToken)) break;
            pageToken = marker.NextPageToken;
        }

        var ordered = merged.Values
            .OrderBy(item => long.TryParse(item.CreateTime, out var parsed) ? parsed : 0L)
            .ToList();
        File.WriteAllText(GetFeishuHistoryChatPath(chatId), JsonSerializer.Serialize(ordered, JsonOptions), new UTF8Encoding(false));

        var index = LoadFeishuHistoryIndex();
        index[chatId] = new FeishuHistorySyncRecord
        {
            ChatId = chatId,
            ChatType = chatType ?? index.GetValueOrDefault(chatId)?.ChatType,
            DisplayName = displayName ?? index.GetValueOrDefault(chatId)?.DisplayName ?? chatId,
            MessageCount = ordered.Count,
            OldestMessageTime = ordered.FirstOrDefault()?.CreateTime,
            LatestMessageTime = ordered.LastOrDefault()?.CreateTime,
            LastSyncAt = DateTime.UtcNow.ToString("o"),
        };
        SaveFeishuHistoryIndex(index);
        RefreshFeishuHistorySyncStatusPanel();
    }

    private async Task<Dictionary<string, string>> FetchFeishuChatMemberNamesAsync(string chatId)
    {
        var auth = await FetchFeishuTenantAccessTokenAsync();
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string? pageToken = null;
        while (true)
        {
            var url = $"{auth.BaseUrl}/open-apis/im/v1/chats/{chatId}/members?member_id_type=open_id&page_size=50";
            if (!string.IsNullOrWhiteSpace(pageToken)) url += $"&page_token={Uri.EscapeDataString(pageToken)}";
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {auth.Token}");
            using var response = await http.SendAsync(request);
            var payload = await response.Content.ReadAsStringAsync();
            using var document = JsonDocument.Parse(payload);
            var root = document.RootElement;
            var code = root.TryGetProperty("code", out var codeEl) ? codeEl.GetInt32() : response.IsSuccessStatusCode ? 0 : (int)response.StatusCode;
            if (!response.IsSuccessStatusCode || code != 0) break;
            var data = root.TryGetProperty("data", out var dataEl) ? dataEl : default;
            if (data.ValueKind == JsonValueKind.Object && data.TryGetProperty("items", out var itemsEl) && itemsEl.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in itemsEl.EnumerateArray())
                {
                    var memberId = GetJsonString(item, "member_id");
                    var name = GetJsonString(item, "name");
                    if (!string.IsNullOrWhiteSpace(memberId) && !string.IsNullOrWhiteSpace(name)) names[memberId] = name;
                }
            }
            var hasMore = data.ValueKind == JsonValueKind.Object
                && data.TryGetProperty("has_more", out var hasMoreEl)
                && hasMoreEl.ValueKind is JsonValueKind.True or JsonValueKind.False
                && hasMoreEl.GetBoolean();
            pageToken = data.ValueKind == JsonValueKind.Object ? GetJsonString(data, "page_token") : null;
            if (!hasMore || string.IsNullOrWhiteSpace(pageToken)) break;
        }
        return names;
    }

    private string GetFeishuHistoryChatPath(string chatId) => Path.Combine(_feishuHistoryDir, $"{chatId}.json");

    private Dictionary<string, FeishuHistorySyncRecord> LoadFeishuHistoryIndex()
        => File.Exists(_feishuHistoryIndexPath)
            ? JsonSerializer.Deserialize<Dictionary<string, FeishuHistorySyncRecord>>(File.ReadAllText(_feishuHistoryIndexPath, Encoding.UTF8), JsonOptions) ?? new Dictionary<string, FeishuHistorySyncRecord>(StringComparer.OrdinalIgnoreCase)
            : new Dictionary<string, FeishuHistorySyncRecord>(StringComparer.OrdinalIgnoreCase);

    private void SaveFeishuHistoryIndex(Dictionary<string, FeishuHistorySyncRecord> index)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_feishuHistoryIndexPath)!);
        File.WriteAllText(_feishuHistoryIndexPath, JsonSerializer.Serialize(index, JsonOptions), new UTF8Encoding(false));
    }

    private List<FeishuIndexedMessageRecord> LoadIndexedFeishuHistoryRaw(string chatId)
    {
        var filePath = GetFeishuHistoryChatPath(chatId);
        return File.Exists(filePath)
            ? JsonSerializer.Deserialize<List<FeishuIndexedMessageRecord>>(File.ReadAllText(filePath, Encoding.UTF8), JsonOptions) ?? []
            : [];
    }

    private List<ConversationMessageView> LoadIndexedFeishuHistoryMessages(string chatId, int limit)
    {
        var selected = LoadIndexedFeishuHistoryRaw(chatId)
            .OrderBy(item => long.TryParse(item.CreateTime, out var parsed) ? parsed : 0L)
            .ToList();
        if (limit > 0 && selected.Count > limit) selected = selected[^limit..];
        return selected.Select((item, index) => new ConversationMessageView
        {
            Index = index + 1,
            Role = string.Equals(item.SenderType, "app", StringComparison.OrdinalIgnoreCase) ? "assistant" : "user",
            CreatedAt = ParseUnixMsOrIso(item.CreateTime),
            Content = $"{(string.IsNullOrWhiteSpace(item.SenderName) ? item.SenderId : item.SenderName)}: {item.Text}",
        }).ToList();
    }

    private void RefreshFeishuHistorySyncStatusPanel()
    {
        var index = LoadFeishuHistoryIndex()
            .Values
            .OrderByDescending(item => ParseUnixMsOrIso(item.LastSyncAt) ?? DateTime.MinValue)
            .ThenBy(item => item.DisplayName ?? item.ChatId)
            .ToList();

        if (index.Count == 0)
        {
            _historySyncStatus.Text = "暂无本地飞书历史索引。";
            return;
        }

        var lines = new List<string>
        {
            $"已同步会话: {index.Count}",
            $"累计消息: {index.Sum(item => item.MessageCount)}",
            "",
        };
        foreach (var item in index.Take(8))
        {
            var latest = ParseUnixMsOrIso(item.LatestMessageTime)?.ToString("yyyy-MM-dd HH:mm:ss") ?? "-";
            var syncedAt = ParseUnixMsOrIso(item.LastSyncAt)?.ToString("yyyy-MM-dd HH:mm:ss") ?? item.LastSyncAt ?? "-";
            lines.Add($"{item.DisplayName ?? item.ChatId} | {item.MessageCount} 条 | 最新 {latest} | 同步 {syncedAt}");
        }
        if (index.Count > 8) lines.Add($"... 其余 {index.Count - 8} 个会话请点“查看同步状态”");
        _historySyncStatus.Text = string.Join(Environment.NewLine, lines);
    }

    private void RunHistorySearch()
    {
        var chatFilter = _historySearchChat.Text.Trim();
        var keywordFilter = _historySearchKeyword.Text.Trim();
        var speakerFilter = _historySearchSpeaker.Text.Trim();
        var startAt = ParseDateTime(_historySearchStart.Text.Trim());
        var endAt = ParseDateTime(_historySearchEnd.Text.Trim());

        var keywordTokens = Regex.Split(keywordFilter, @"\s+")
            .Select(token => token.Trim())
            .Where(token => !string.IsNullOrWhiteSpace(token))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var candidates = LoadFeishuHistoryIndex()
            .Values
            .Where(item =>
                string.IsNullOrWhiteSpace(chatFilter)
                || (item.ChatId?.Contains(chatFilter, StringComparison.OrdinalIgnoreCase) ?? false)
                || (item.DisplayName?.Contains(chatFilter, StringComparison.OrdinalIgnoreCase) ?? false))
            .ToList();

        var hits = new List<HistorySearchHit>();
        foreach (var chat in candidates)
        {
            if (string.IsNullOrWhiteSpace(chat.ChatId)) continue;
            foreach (var item in LoadIndexedFeishuHistoryRaw(chat.ChatId))
            {
                var createdAt = ParseUnixMsOrIso(item.CreateTime);
                if (startAt.HasValue && (!createdAt.HasValue || createdAt.Value < startAt.Value)) continue;
                if (endAt.HasValue && (!createdAt.HasValue || createdAt.Value > endAt.Value)) continue;

                var speakerText = $"{item.SenderName} {item.SenderId}".Trim();
                if (!string.IsNullOrWhiteSpace(speakerFilter)
                    && !speakerText.Contains(speakerFilter, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var haystack = $"{item.Text}\n{speakerText}";
                var score = 0;
                foreach (var token in keywordTokens)
                {
                    if (haystack.Contains(token, StringComparison.OrdinalIgnoreCase)) score += 10;
                }

                if (keywordTokens.Length > 0 && score == 0) continue;
                if (keywordTokens.Length == 0 && string.IsNullOrWhiteSpace(speakerFilter) && !startAt.HasValue && !endAt.HasValue) score = 1;

                hits.Add(new HistorySearchHit
                {
                    ChatId = chat.ChatId,
                    DisplayName = chat.DisplayName ?? chat.ChatId,
                    CreatedAt = createdAt,
                    SenderName = item.SenderName,
                    SenderId = item.SenderId,
                    Text = item.Text,
                    Score = score,
                });
            }
        }

        var ordered = hits
            .OrderByDescending(item => item.Score)
            .ThenByDescending(item => item.CreatedAt ?? DateTime.MinValue)
            .Take(60)
            .ToList();

        if (ordered.Count == 0)
        {
            _historySearchResults.Text = "没有命中本地历史索引。";
            return;
        }

        var builder = new StringBuilder();
        builder.AppendLine($"命中 {ordered.Count} 条");
        builder.AppendLine();
        for (var index = 0; index < ordered.Count; index++)
        {
            var hit = ordered[index];
            builder.AppendLine($"[{index + 1}] {hit.DisplayName} | {hit.CreatedAt:yyyy-MM-dd HH:mm:ss} | {hit.SenderName ?? hit.SenderId ?? "-"} | score={hit.Score}");
            builder.AppendLine(TrimForSummary(hit.Text, 280));
            builder.AppendLine();
        }
        _historySearchResults.Text = builder.ToString().TrimEnd();
    }

    private void ShowFeishuHistorySyncStatus()
    {
        var index = LoadFeishuHistoryIndex();
        RefreshFeishuHistorySyncStatusPanel();
        if (index.Count == 0)
        {
            AppendLog("飞书历史索引为空。");
            MessageBox.Show(this, "飞书历史索引为空。", "同步状态", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var lines = index.Values
            .OrderByDescending(item => ParseDateTime(item.LastSyncAt) ?? ParseUnixMsOrIso(item.LatestMessageTime) ?? DateTime.MinValue)
            .Select(item => $"{item.DisplayName} | {item.ChatId} | {item.MessageCount} 条 | 最近同步 {item.LastSyncAt}")
            .ToArray();
        var text = string.Join(Environment.NewLine, lines);
        AppendLog(text);
        MessageBox.Show(this, text, "飞书历史同步状态", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private async Task<(string Token, string BaseUrl)> FetchFeishuTenantAccessTokenAsync()
    {
        var appId = GetConfig("CTI_FEISHU_APP_ID", "");
        var appSecret = GetConfig("CTI_FEISHU_APP_SECRET", "");
        if (string.IsNullOrWhiteSpace(appId) || string.IsNullOrWhiteSpace(appSecret))
        {
            throw new InvalidOperationException("未配置飞书 App ID / App Secret。");
        }

        var configuredDomain = GetConfig("CTI_FEISHU_DOMAIN", "https://open.feishu.cn");
        var baseUrl = configuredDomain.Contains("larksuite", StringComparison.OrdinalIgnoreCase)
            ? "https://open.larksuite.com"
            : "https://open.feishu.cn";

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/open-apis/auth/v3/tenant_access_token/internal");
        request.Content = new StringContent(JsonSerializer.Serialize(new
        {
            app_id = appId,
            app_secret = appSecret,
        }), Encoding.UTF8, "application/json");

        using var response = await http.SendAsync(request);
        var payload = await response.Content.ReadAsStringAsync();
        using var document = JsonDocument.Parse(payload);
        var root = document.RootElement;
        var token = GetJsonString(root, "tenant_access_token");
        if (!response.IsSuccessStatusCode || string.IsNullOrWhiteSpace(token))
        {
            var msg = GetJsonString(root, "msg") ?? response.ReasonPhrase ?? "unknown error";
            throw new InvalidOperationException($"获取飞书 tenant_access_token 失败：{msg}");
        }

        return (token, baseUrl);
    }

    private static string InferFeishuRole(JsonElement item)
    {
        if (item.TryGetProperty("sender", out var sender))
        {
            var senderType = GetJsonString(sender, "sender_type");
            if (string.Equals(senderType, "app", StringComparison.OrdinalIgnoreCase)) return "assistant";
        }
        return "user";
    }

    private static string ExtractFeishuMessageText(JsonElement item)
    {
        var msgType = GetJsonString(item, "msg_type") ?? "";
        if (!item.TryGetProperty("body", out var body) || body.ValueKind != JsonValueKind.Object)
        {
            return $"[{msgType}]";
        }

        var content = GetJsonString(body, "content") ?? "";
        if (string.IsNullOrWhiteSpace(content)) return $"[{msgType}]";
        if (string.Equals(msgType, "text", StringComparison.OrdinalIgnoreCase))
        {
            return ParseFeishuTextContent(content);
        }
        if (string.Equals(msgType, "post", StringComparison.OrdinalIgnoreCase))
        {
            return ParseFeishuPostContent(content);
        }

        return msgType switch
        {
            "image" => "[图片]",
            "file" => "[文件]",
            "audio" => "[语音]",
            "video" or "media" => "[视频]",
            "interactive" => "[卡片消息]",
            _ => $"[{msgType}]",
        };
    }

    private static string ParseFeishuTextContent(string raw)
    {
        try
        {
            using var document = JsonDocument.Parse(raw);
            if (document.RootElement.ValueKind == JsonValueKind.Object && document.RootElement.TryGetProperty("text", out var textEl))
            {
                return Regex.Replace(textEl.GetString() ?? "", @"\s+", " ").Trim();
            }
        }
        catch
        {
            return Regex.Replace(raw, @"\s+", " ").Trim();
        }
        return Regex.Replace(raw, @"\s+", " ").Trim();
    }

    private static string ParseFeishuPostContent(string raw)
    {
        try
        {
            using var document = JsonDocument.Parse(raw);
            var parts = new List<string>();
            CollectTextRuns(document.RootElement, parts);
            var merged = string.Join(" ", parts.Where(part => !string.IsNullOrWhiteSpace(part)).Select(part => part.Trim()));
            return Regex.Replace(merged, @"\s+", " ").Trim();
        }
        catch
        {
            return Regex.Replace(raw, @"\s+", " ").Trim();
        }
    }

    private static void CollectTextRuns(JsonElement element, List<string> parts)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                if (element.TryGetProperty("text", out var textEl) && textEl.ValueKind == JsonValueKind.String)
                {
                    parts.Add(textEl.GetString() ?? "");
                }
                foreach (var property in element.EnumerateObject()) CollectTextRuns(property.Value, parts);
                break;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray()) CollectTextRuns(item, parts);
                break;
        }
    }

    private static string? GetJsonString(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var property)) return null;
        return property.ValueKind switch
        {
            JsonValueKind.String => property.GetString(),
            JsonValueKind.Number => property.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => null,
        };
    }

    private static DateTime? ParseUnixMsOrIso(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (long.TryParse(raw, out var unix))
        {
            try { return DateTimeOffset.FromUnixTimeMilliseconds(unix).LocalDateTime; } catch { }
        }
        return ParseDateTime(raw);
    }

    private static DateTime? ParseDateTime(string? raw)
        => string.IsNullOrWhiteSpace(raw) ? null : DateTime.TryParse(raw, out var parsed) ? parsed : null;

    private static string TrimForSummary(string text, int maxChars)
    {
        var normalized = Regex.Replace(text ?? "", @"\s+", " ").Trim();
        return normalized.Length <= maxChars ? normalized : normalized[..Math.Max(0, maxChars - 3)] + "...";
    }

    private static Dictionary<string, string> ReadEnvFile(string path)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!File.Exists(path)) return values;
        foreach (var rawLine in File.ReadAllLines(path, Encoding.UTF8))
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith("#")) continue;
            var index = line.IndexOf('=');
            if (index <= 0) continue;
            values[line[..index].Trim()] = line[(index + 1)..].Trim();
        }
        return values;
    }

    private static async Task<ProcessResult> RunPowerShellFileAsync(string scriptPath, string trailingArgs, string workingDirectory, int timeoutMs, Dictionary<string, string?>? environment = null)
    {
        var escapedPath = scriptPath.Replace("\"", "\"\"");
        var arguments = string.IsNullOrWhiteSpace(trailingArgs) ? $"-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"{escapedPath}\"" : $"-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"{escapedPath}\" {trailingArgs}";
        return await RunProcessAsync("powershell.exe", arguments, workingDirectory, environment, timeoutMs);
    }

    private static async Task<ProcessResult> RunProcessAsync(string fileName, string arguments, string workingDirectory, Dictionary<string, string?>? environment = null, int timeoutMs = 30000)
    {
        using var process = new Process();
        var outputEncoding = fileName.EndsWith("powershell.exe", StringComparison.OrdinalIgnoreCase) ? Encoding.Default : Encoding.UTF8;
        process.StartInfo = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            WorkingDirectory = Directory.Exists(workingDirectory) ? workingDirectory : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = outputEncoding,
            StandardErrorEncoding = outputEncoding,
            CreateNoWindow = true,
        };
        if (environment is not null)
        {
            foreach (var pair in environment) process.StartInfo.Environment[pair.Key] = pair.Value ?? "";
        }
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) stdout.AppendLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) stderr.AppendLine(e.Data); };
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        using var cts = new CancellationTokenSource(timeoutMs);
        try { await process.WaitForExitAsync(cts.Token); }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            return new ProcessResult(-1, stdout.ToString(), stderr + $"Timeout after {timeoutMs} ms.");
        }
        return new ProcessResult(process.ExitCode, stdout.ToString(), stderr.ToString());
    }

    private void AppendCommand(string title, ProcessResult result)
    {
        AppendLog($"[{DateTime.Now:HH:mm:ss}] {title} exit={result.ExitCode}");
        if (!string.IsNullOrWhiteSpace(result.Stdout)) AppendLog(MaskSecrets(result.Stdout.TrimEnd()));
        if (!string.IsNullOrWhiteSpace(result.Stderr)) AppendLog(MaskSecrets(result.Stderr.TrimEnd()));
    }

    private void AppendLog(string text)
    {
        if (InvokeRequired) { BeginInvoke(() => AppendLog(text)); return; }
        _log.AppendText(text + Environment.NewLine);
        _log.SelectionStart = _log.TextLength;
        _log.ScrollToCaret();
    }

    private static string MaskSecrets(string text)
        => Regex.Replace(text, @"(CTI_[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Z0-9_]*=)(.+)", m =>
        {
            var value = m.Groups[2].Value.Trim();
            return m.Groups[1].Value + (value.Length <= 4 ? "****" : "****" + value[^4..]);
        }, RegexOptions.IgnoreCase);

    private static string FirstLine(string text)
        => text.Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim() ?? "可用";

    private static string? FirstNonEmptyLine(string text)
        => text.Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries).FirstOrDefault(line => !string.IsNullOrWhiteSpace(line))?.Trim();

    private static string TrimForStatus(string text, int maxLen)
    {
        var value = text.Trim();
        return value.Length > maxLen ? value[..(maxLen - 3)] + "..." : value;
    }

    private static string RouterModeToLabel(string? mode)
        => (mode ?? "").Trim().ToLowerInvariant() switch
        {
            "local_only" => "仅本地",
            "codex_only" => "仅 Codex",
            _ => "混合模式（Codex 主脑）",
        };

    private static string FormatLastBrainStatus(LocalLlmStatusRecord status)
    {
        var routeLabel = (status.LastRouteLabel ?? "").Trim().ToLowerInvariant();
        if (routeLabel.Length > 0)
        {
            return routeLabel switch
            {
                "codex_primary" => "Codex 主脑",
                "local_explicit_task" => "本地辅助执行",
                "local_fallback_no_codex" => "本地兜底",
                "local_refused_out_of_scope" => "本地拒绝（超范围）",
                _ => "暂无记录",
            };
        }

        var provider = (status.LastProvider ?? "").Trim().ToLowerInvariant();
        return provider switch
        {
            "codex" or "codex_only" => "Codex 主脑",
            "local" => "本地辅助执行",
            "local_best_effort" => "本地兜底",
            "refuse_local" => "本地拒绝（超范围）",
            _ => "暂无记录",
        };
    }

    private static string FormatRouteLabel(LocalLlmRouteSummaryRecord route)
    {
        var provider = (route.Provider ?? "").Trim().ToLowerInvariant();
        var mode = (route.Mode ?? "").Trim().ToLowerInvariant();
        return provider switch
        {
            "codex" => "codex_primary",
            "local_best_effort" => "local_fallback_no_codex",
            "refuse_local" => "local_refused_out_of_scope",
            "local" when mode == "hybrid" => "local_explicit_task",
            "local" when mode == "local_only" => "local_fallback_no_codex",
            "codex_only" => "codex_primary",
            _ => $"{provider}:{route.Decision}",
        };
    }

    private static void OpenPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        if (File.Exists(path) || Directory.Exists(path)) Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
    }

    private static string FindSkillDir()
    {
        var candidates = new[] { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex", "skills", "claude-to-im"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "skills", "claude-to-im"), AppContext.BaseDirectory };
        foreach (var candidate in candidates)
        {
            if (File.Exists(Path.Combine(candidate, "scripts", "daemon.ps1"))) return candidate;
            var parent = Directory.GetParent(candidate)?.FullName;
            if (parent is not null && File.Exists(Path.Combine(parent, "scripts", "daemon.ps1"))) return parent;
        }
        return AppContext.BaseDirectory;
    }

    private static string FindSuiteRoot(string skillDir)
    {
        var candidates = new[] { Environment.GetEnvironmentVariable("CODEX_IM_SUITE_ROOT") ?? "", Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Documents", "New project", "codex-im-suite"), Path.Combine(Environment.CurrentDirectory, "codex-im-suite"), Path.Combine(skillDir, "codex-im-suite") };
        foreach (var candidate in candidates.Where(c => !string.IsNullOrWhiteSpace(c)))
        {
            if (File.Exists(Path.Combine(candidate, "scripts", "publish-backup.ps1"))) return Path.GetFullPath(candidate);
        }
        return "";
    }

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true, ReadCommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };
    private readonly record struct ProcessResult(int ExitCode, string Stdout, string Stderr);
}
internal sealed class McpManifest
{
    public string? Id { get; set; }
    public string? DisplayName { get; set; }
    public string? Type { get; set; }
    public bool? Enabled { get; set; }
    public string? Launcher { get; set; }
    public string? StopLauncher { get; set; }
    public string? Cwd { get; set; }
    public string? RegisterName { get; set; }
    public Dictionary<string, string>? Env { get; set; }
    public McpHealthCheck? HealthCheck { get; set; }
    public string? Description { get; set; }
    public string? ManifestPath { get; set; }
    public string? ServiceStatePath { get; set; }
    public string? StatusBadge { get; set; }
    public bool IsRegistered { get; set; }
    public bool IsRunning { get; set; }
    public bool? HealthOk { get; set; }
    public string? HealthSummary { get; set; }
    public override string ToString()
        => $"{StatusBadge ?? ""} {(DisplayName ?? Id)} [{Type}] {(Enabled == false ? "disabled" : "enabled")}".Trim();
}

internal sealed class McpHealthCheck
{
    public string? Kind { get; set; }
    public string? Url { get; set; }
}

internal sealed class McpServiceState
{
    public string? Id { get; set; }
    public string? DisplayName { get; set; }
    public int ProcessId { get; set; }
    public string? Launcher { get; set; }
    public string? WorkingDirectory { get; set; }
    public string? StartedAt { get; set; }
}

internal sealed class BridgeRuntimeStatus
{
    public bool Running { get; set; }
    public int Pid { get; set; }
    public string[]? Channels { get; set; }
}

internal sealed class LocalLlmStatusRecord
{
    public bool Enabled { get; set; }
    public bool AutoRoute { get; set; }
    public bool RouterEnabled { get; set; }
    public string? RouterMode { get; set; }
    public bool ForceHub { get; set; }
    public string? BaseUrl { get; set; }
    public string? Model { get; set; }
    public int RouteHits { get; set; }
    public int RouteMisses { get; set; }
    public int RouteFailures { get; set; }
    public int EscalationCount { get; set; }
    public int LocalOnlyAnswers { get; set; }
    public int LocalRefusals { get; set; }
    public int ExecutionCount { get; set; }
    public int ExecutionFailures { get; set; }
    public int FallbackCount { get; set; }
    public bool? ServerReachable { get; set; }
    public string? LastCheckAt { get; set; }
    public string? LastRouteReason { get; set; }
    public string? LastFallbackReason { get; set; }
    public string? LastDecision { get; set; }
    public string? LastRefusalReason { get; set; }
    public int LastCompressedPromptChars { get; set; }
    public int LastCompressedHistoryChars { get; set; }
    public string? LastProvider { get; set; }
    public string? LastRouteLabel { get; set; }
    public bool? LastCodexPrimary { get; set; }
    public string? LastRequestKind { get; set; }
    public string? LastError { get; set; }
    public string? UpdatedAt { get; set; }
    public List<LocalLlmRouteSummaryRecord>? RecentRoutes { get; set; }
    public List<LocalLlmExecutionSummaryRecord>? RecentExecutions { get; set; }
}

internal sealed class LocalLlmRouteSummaryRecord
{
    public string? Timestamp { get; set; }
    public string? Mode { get; set; }
    public string? TaskKind { get; set; }
    public string? Decision { get; set; }
    public string? Provider { get; set; }
    public string? Reason { get; set; }
    public int CompressedPromptChars { get; set; }
    public int CompressedHistoryChars { get; set; }
    public string? FallbackReason { get; set; }
}

internal sealed class LocalLlmExecutionSummaryRecord
{
    public string? Timestamp { get; set; }
    public string? Action { get; set; }
    public int StepCount { get; set; }
    public bool Success { get; set; }
    public string? Provider { get; set; }
    public string? Reason { get; set; }
    public string? Summary { get; set; }
}

internal sealed class ChannelBindingRecord
{
    public string? ChannelType { get; set; }
    public string? ChatId { get; set; }
    public string? DisplayName { get; set; }
    public string? ChatType { get; set; }
    public string? CodepilotSessionId { get; set; }
    public string? WorkingDirectory { get; set; }
    public string? SdkSessionId { get; set; }
    public string? UpdatedAt { get; set; }
}

internal sealed class FeishuChatIndexRecord
{
    public string? ChatId { get; set; }
    public string? ChatType { get; set; }
    public string? DisplayName { get; set; }
    public string? LastMessageAt { get; set; }
    public string? UpdatedAt { get; set; }
}

internal sealed class FeishuHistorySyncRecord
{
    public string? ChatId { get; set; }
    public string? ChatType { get; set; }
    public string? DisplayName { get; set; }
    public int MessageCount { get; set; }
    public string? OldestMessageTime { get; set; }
    public string? LatestMessageTime { get; set; }
    public string? LastSyncAt { get; set; }
}

internal sealed class HistorySearchHit
{
    public string ChatId { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public DateTime? CreatedAt { get; set; }
    public string? SenderName { get; set; }
    public string? SenderId { get; set; }
    public string Text { get; set; } = "";
    public int Score { get; set; }
}

internal sealed class SessionRecord
{
    public string? Id { get; set; }
    public string? WorkingDirectory { get; set; }
    public string? SdkSessionId { get; set; }
}

internal sealed class StoredBridgeMessage
{
    public string? Role { get; set; }
    public string? Content { get; set; }
    public string? CreatedAt { get; set; }
}

internal sealed class FeishuIndexedMessageRecord
{
    public string MessageId { get; set; } = "";
    public string ChatId { get; set; } = "";
    public string CreateTime { get; set; } = "";
    public string MsgType { get; set; } = "";
    public string? SenderId { get; set; }
    public string? SenderType { get; set; }
    public string? SenderName { get; set; }
    public string Text { get; set; } = "";
    public bool HasMore { get; set; }
    public string? NextPageToken { get; set; }
}

internal sealed class StoredContentBlock
{
    public string? Type { get; set; }
    public string? Name { get; set; }
    public string? Text { get; set; }
    public string? Content { get; set; }
}

internal sealed class ConversationEntry
{
    public string BindingKey { get; set; } = "";
    public string ChannelType { get; set; } = "";
    public string ChatId { get; set; } = "";
    public string ChatType { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string SessionId { get; set; } = "";
    public string WorkingDirectory { get; set; } = "";
    public string SdkSessionId { get; set; } = "";
    public DateTime? LastUpdatedAt { get; set; }
    public string Summary { get; set; } = "";
    public string Source { get; set; } = "";
    public bool HasLocalBinding { get; set; }
    public int LocalMessageCount { get; set; }
    public bool RemoteLoaded { get; set; }
    public List<ConversationMessageView> Messages { get; set; } = [];
    public override string ToString()
        => $"{LastUpdatedAt:yyyy-MM-dd HH:mm} | {(string.IsNullOrWhiteSpace(DisplayName) ? ChatId : DisplayName)} | {Summary}";
}

internal sealed class ConversationMessageView
{
    public int Index { get; set; }
    public string Role { get; set; } = "";
    public DateTime? CreatedAt { get; set; }
    public string Content { get; set; } = "";
}

internal sealed class ConversationViewerForm : Form
{
    public ConversationViewerForm(List<ConversationEntry> entries, string dataDir, Func<ConversationEntry, Task<ConversationEntry>>? detailLoader)
    {
        Text = "会话记录查看";
        Width = 1180;
        Height = 760;
        StartPosition = FormStartPosition.CenterParent;
        Font = new Font("Microsoft YaHei UI", 9F);

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Padding = new Padding(10) };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Controls.Add(root);

        var header = new Label { Dock = DockStyle.Fill, Text = $"远端飞书会话优先，本地存档为辅：{dataDir}", TextAlign = ContentAlignment.MiddleLeft, ForeColor = Color.DimGray };
        root.Controls.Add(header, 0, 0);

        var contentLayout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 };
        contentLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 380));
        contentLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        root.Controls.Add(contentLayout, 0, 1);

        var list = new ListBox { Dock = DockStyle.Fill, HorizontalScrollbar = true, DataSource = entries };
        contentLayout.Controls.Add(list, 0, 0);

        var rightPanel = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 2, ColumnCount = 1 };
        rightPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 120));
        rightPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        contentLayout.Controls.Add(rightPanel, 1, 0);

        var metaBox = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Font = new Font("Consolas", 9F) };
        rightPanel.Controls.Add(metaBox, 0, 0);

        var contentBox = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false, Font = new Font("Consolas", 9F) };
        rightPanel.Controls.Add(contentBox, 0, 1);

        void RenderSync(ConversationEntry? entry)
        {
            if (entry is null)
            {
                metaBox.Text = "未选择会话";
                contentBox.Text = "";
                return;
            }
            metaBox.Text = string.Join(Environment.NewLine, new[]
            {
                $"名称: {entry.DisplayName}",
                $"Channel: {entry.ChannelType}",
                $"ChatType: {entry.ChatType}",
                $"ChatId: {entry.ChatId}",
                $"来源: {entry.Source}",
                $"本地绑定: {(entry.HasLocalBinding ? "是" : "否")}",
                $"Session: {entry.SessionId}",
                $"SDK Session: {entry.SdkSessionId}",
                $"CWD: {entry.WorkingDirectory}",
                $"本地消息数: {entry.LocalMessageCount}",
                $"Updated: {entry.LastUpdatedAt:yyyy-MM-dd HH:mm:ss}",
                $"Summary: {entry.Summary}",
            });
            var builder = new StringBuilder();
            foreach (var message in entry.Messages)
            {
                builder.AppendLine($"[{message.Index}] {message.Role} {message.CreatedAt:yyyy-MM-dd HH:mm:ss}");
                builder.AppendLine(message.Content);
                builder.AppendLine();
            }
            contentBox.Text = builder.ToString().TrimEnd();
        }

        async Task RenderAsync(ConversationEntry? entry)
        {
            if (entry is null)
            {
                RenderSync(null);
                return;
            }

            if (!entry.RemoteLoaded && detailLoader is not null && string.Equals(entry.ChannelType, "feishu", StringComparison.OrdinalIgnoreCase) && !entry.Source.StartsWith("仅本地", StringComparison.OrdinalIgnoreCase))
            {
                metaBox.Text = $"正在读取远端飞书消息：{entry.DisplayName} ({entry.ChatId})";
                contentBox.Text = "";
                try
                {
                    await detailLoader(entry);
                }
                catch (Exception ex)
                {
                    entry.RemoteLoaded = true;
                    entry.Messages = [new ConversationMessageView { Index = 1, Role = "system", Content = $"读取远端消息失败：{ex.Message}" }];
                }
            }

            RenderSync(entry);
        }

        list.SelectedIndexChanged += async (_, _) => await RenderAsync(list.SelectedItem as ConversationEntry);
        Shown += async (_, _) =>
        {
            if (entries.Count > 0) await RenderAsync(entries[0]);
            else RenderSync(null);
        };
    }
}
