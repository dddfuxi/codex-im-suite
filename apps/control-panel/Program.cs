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
    private readonly string _dataDir;
    private readonly string _messagesDir;
    private readonly string _statusJsonPath;
    private readonly string _feishuChatIndexPath;
    private readonly string _feishuHistoryDir;
    private readonly string _feishuHistoryIndexPath;

    private readonly TextBox _workdir = new();
    private readonly TextBox _allowedRoots = new();
    private readonly TextBox _unityProject = new();
    private readonly TextBox _memoryRepo = new();
    private readonly TextBox _additionalDirs = new();

    private readonly TextBox _bridgeStatus = CreateStatusBox();
    private readonly TextBox _codexStatus = CreateStatusBox();
    private readonly TextBox _mcpStatus = CreateStatusBox();
    private readonly TextBox _buildStatus = CreateStatusBox();
    private readonly ListBox _mcpList = new();
    private readonly TextBox _mcpDetails = new();
    private readonly TextBox _log = new();

    private Dictionary<string, string> _config = new(StringComparer.OrdinalIgnoreCase);
    private List<McpManifest> _manifests = [];

    public MainForm()
    {
        _skillDir = FindSkillDir();
        _ctiHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude-to-im");
        _configPath = Path.Combine(_ctiHome, "config.env");
        _daemonScript = Path.Combine(_skillDir, "scripts", "daemon.ps1");
        _registerMcpScript = Path.Combine(_skillDir, "scripts", "register-external-mcps.ps1");
        _manifestDir = Path.Combine(_skillDir, "mcp.d");
        _suiteRoot = FindSuiteRoot(_skillDir);
        _publishBackupScript = string.IsNullOrWhiteSpace(_suiteRoot) ? "" : Path.Combine(_suiteRoot, "scripts", "publish-backup.ps1");
        _dataDir = Path.Combine(_ctiHome, "data");
        _messagesDir = Path.Combine(_dataDir, "messages");
        _statusJsonPath = Path.Combine(_ctiHome, "runtime", "status.json");
        _feishuChatIndexPath = Path.Combine(_dataDir, "feishu-chat-index.json");
        _feishuHistoryDir = Path.Combine(_dataDir, "feishu-history");
        _feishuHistoryIndexPath = Path.Combine(_dataDir, "feishu-history-index.json");

        Text = "飞书 / Codex / MCP 中控面板";
        StartPosition = FormStartPosition.CenterScreen;
        Width = 1260;
        Height = 860;
        MinimumSize = new Size(1120, 760);
        Font = new Font("Microsoft YaHei UI", 9F);

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 5, Padding = new Padding(12) };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 150));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 290));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 120));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 42));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 58));
        Controls.Add(root);

        root.Controls.Add(BuildStatusPanel(), 0, 0);
        root.Controls.Add(BuildConfigPanel(), 0, 1);
        root.Controls.Add(BuildActionPanel(), 0, 2);
        root.Controls.Add(BuildMcpPanel(), 0, 3);
        root.Controls.Add(BuildLogPanel(), 0, 4);

        Load += async (_, _) =>
        {
            LoadConfig();
            LoadManifests();
            RenderMcpList();
            await RefreshAllAsync();
        };
    }

    private Control BuildStatusPanel()
    {
        var group = new GroupBox { Text = "服务总览", Dock = DockStyle.Fill };
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, Padding = new Padding(8) };
        for (var i = 0; i < 4; i++) layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25F));
        group.Controls.Add(layout);
        AddStatusCard(layout, "飞书桥接", _bridgeStatus, 0);
        AddStatusCard(layout, "Codex CLI", _codexStatus, 1);
        AddStatusCard(layout, "MCP 清单", _mcpStatus, 2);
        AddStatusCard(layout, "版本信息", _buildStatus, 3);
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

    private Control BuildActionPanel()
    {
        var group = new GroupBox { Text = "基础操作", Dock = DockStyle.Fill };
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(8), WrapContents = true };
        group.Controls.Add(layout);

        AddAction(layout, "刷新状态", async () => await RefreshAllAsync());
        AddAction(layout, "启动飞书", async () => await RunDaemonAsync("start"));
        AddAction(layout, "停止飞书", async () => await RunDaemonAsync("stop"));
        AddAction(layout, "重启飞书", async () => { await RunDaemonAsync("stop"); await RunDaemonAsync("start"); });
        AddAction(layout, "查看日志", async () => await RunDaemonAsync("logs 120"));
        AddAction(layout, "检查 Codex", async () => await CheckCodexAsync());
        AddAction(layout, "注册全部 MCP", async () => await RegisterAllMcpsAsync());
        AddAction(layout, "一键发布", async () => await PublishSuiteAsync());
        AddAction(layout, "查看会话", async () => await ShowConversationViewerAsync());
        AddAction(layout, "同步全部历史", async () => await SyncAllFeishuHistoryAsync());
        AddAction(layout, "查看同步状态", ShowFeishuHistorySyncStatus);
        AddAction(layout, "帮助", ShowHelp);
        AddAction(layout, "打开配置", () => OpenPath(_configPath));
        AddAction(layout, "打开 mcp.d", () => OpenPath(_manifestDir));
        AddAction(layout, "打开记忆仓库", () => OpenPath(_memoryRepo.Text));
        if (!string.IsNullOrWhiteSpace(_suiteRoot)) AddAction(layout, "打开 Suite", () => OpenPath(_suiteRoot));
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
        _mcpList.SelectedIndexChanged += (_, _) => RenderSelectedMcp();
        layout.Controls.Add(_mcpList, 0, 0);

        _mcpDetails.Dock = DockStyle.Fill;
        _mcpDetails.Multiline = true;
        _mcpDetails.ReadOnly = true;
        _mcpDetails.ScrollBars = ScrollBars.Vertical;
        _mcpDetails.Font = new Font("Consolas", 9F);
        layout.Controls.Add(_mcpDetails, 1, 0);
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

    private static void AddStatusCard(TableLayoutPanel parent, string title, TextBox value, int col)
    {
        var panel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(8), BackColor = Color.WhiteSmoke };
        var titleLabel = new Label { Text = title, Dock = DockStyle.Top, Height = 24, Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold) };
        value.Dock = DockStyle.Fill;
        panel.Controls.Add(value);
        panel.Controls.Add(titleLabel);
        parent.Controls.Add(panel, col, 0);
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
                _manifests.Add(manifest);
            }
            catch (Exception ex)
            {
                AppendLog($"MCP 清单读取失败：{file} {ex.Message}");
            }
        }
        _mcpStatus.Text = $"发现 {_manifests.Count} 个清单{Environment.NewLine}启用 {_manifests.Count(m => m.Enabled != false)} 个";
    }

    private void RenderMcpList()
    {
        _mcpList.BeginUpdate();
        _mcpList.Items.Clear();
        foreach (var manifest in _manifests) _mcpList.Items.Add(manifest);
        _mcpList.EndUpdate();
        if (_mcpList.Items.Count > 0) _mcpList.SelectedIndex = 0;
        else _mcpDetails.Text = "暂无 MCP 清单。";
    }

    private void RenderSelectedMcp()
    {
        if (_mcpList.SelectedItem is not McpManifest manifest)
        {
            _mcpDetails.Text = "未选择 MCP。";
            return;
        }
        _mcpDetails.Text = string.Join(Environment.NewLine, new[]
        {
            $"名称: {manifest.DisplayName}",
            $"ID: {manifest.Id}",
            $"类型: {manifest.Type}",
            $"启用: {manifest.Enabled != false}",
            $"Launcher: {manifest.Launcher}",
            $"CWD: {manifest.Cwd}",
            $"RegisterName: {manifest.RegisterName}",
            $"Manifest: {manifest.ManifestPath}",
            "",
            manifest.Description ?? "",
        });
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
        RenderMcpList();
        await CheckBridgeAsync();
        await CheckCodexAsync(true);
        await RefreshBuildInfoAsync();
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

    private async Task CheckCodexAsync(bool updateOnly = false)
    {
        var result = await RunProcessAsync("powershell.exe", "-NoLogo -NoProfile -Command \"codex --version\"", _skillDir);
        _codexStatus.Text = result.ExitCode == 0 ? FirstLine(result.Stdout) : "不可用";
        if (!updateOnly) AppendCommand("codex version", result);
    }

    private async Task RefreshBuildInfoAsync()
    {
        var exePath = Assembly.GetExecutingAssembly().Location;
        var buildTime = File.Exists(exePath) ? File.GetLastWriteTime(exePath).ToString("yyyy-MM-dd HH:mm:ss") : "unknown";
        var branch = await RunGitTextAsync("branch --show-current");
        var commit = await RunGitTextAsync("rev-parse --short HEAD");
        _buildStatus.Text = $"构建时间: {buildTime}{Environment.NewLine}分支: {branch}{Environment.NewLine}Commit: {commit}";
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
    }

    private async Task PublishSuiteAsync()
    {
        if (string.IsNullOrWhiteSpace(_publishBackupScript) || !File.Exists(_publishBackupScript))
        {
            AppendLog("未找到 publish-backup.ps1。");
            return;
        }
        var result = await RunPowerShellFileAsync(_publishBackupScript, "", _suiteRoot, 900000);
        AppendCommand("一键发布", result);
        await RefreshBuildInfoAsync();
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

        var indexedMessages = LoadIndexedFeishuHistoryMessages(entry.ChatId, 120);
        if (indexedMessages.Count == 0)
        {
            await SyncFeishuChatHistoryAsync(entry.ChatId, entry.DisplayName, entry.ChatType, false);
            indexedMessages = LoadIndexedFeishuHistoryMessages(entry.ChatId, 120);
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

    private void ShowFeishuHistorySyncStatus()
    {
        var index = LoadFeishuHistoryIndex();
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
    public string? Cwd { get; set; }
    public string? RegisterName { get; set; }
    public string? Description { get; set; }
    public string? ManifestPath { get; set; }
    public override string ToString() => $"{DisplayName ?? Id} [{Type}] {(Enabled == false ? "disabled" : "enabled")}";
}

internal sealed class BridgeRuntimeStatus
{
    public bool Running { get; set; }
    public int Pid { get; set; }
    public string[]? Channels { get; set; }
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
