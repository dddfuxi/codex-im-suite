using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace CodexImSuiteControlPanel;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}

internal sealed class MainForm : Form
{
    private readonly string _suiteRoot;
    private readonly string _configPath;
    private readonly string _daemonScript;
    private readonly string _registerMcpScript;
    private readonly string _packageScript;
    private readonly string _bootstrapScript;
    private readonly string _manifestDir;
    private readonly string _skillManifestDir;
    private readonly string _pluginManifestDir;
    private readonly string _ctiHome;
    private readonly string _statusJsonPath;
    private readonly string _bridgeLogPath;
    private readonly TextBox _statusBridge = CreateStatusBox();
    private readonly TextBox _statusCodex = CreateStatusBox();
    private readonly TextBox _statusSuite = CreateStatusBox();
    private readonly TextBox _statusInfo = CreateStatusBox();
    private readonly TextBox _workdir = new();
    private readonly TextBox _allowedRoots = new();
    private readonly TextBox _unityProject = new();
    private readonly TextBox _memoryRepo = new();
    private readonly FlowLayoutPanel _extensionList = new();
    private readonly TextBox _log = new();
    private Dictionary<string, string> _config = new(StringComparer.OrdinalIgnoreCase);
    private List<McpManifest> _mcps = [];
    private List<ExtensionItem> _extensions = [];

    public MainForm()
    {
        _suiteRoot = FindSuiteRoot();
        _ctiHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude-to-im");
        _configPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude-to-im", "config.env");
        _daemonScript = ResolveBridgeRuntimeScript(_suiteRoot);
        _registerMcpScript = Path.Combine(_suiteRoot, "scripts", "register-external-mcps.ps1");
        _packageScript = Path.Combine(_suiteRoot, "scripts", "package-release.ps1");
        _bootstrapScript = Path.Combine(_suiteRoot, "scripts", "bootstrap-suite.ps1");
        _manifestDir = Path.Combine(_suiteRoot, "config", "mcp.d");
        _skillManifestDir = Path.Combine(_suiteRoot, "config", "skills.d");
        _pluginManifestDir = Path.Combine(_suiteRoot, "config", "plugins.d");
        _statusJsonPath = Path.Combine(_ctiHome, "runtime", "status.json");
        _bridgeLogPath = Path.Combine(_ctiHome, "logs", "bridge.log");

        Text = "Codex IM 套件中控面板";
        Width = 1180;
        Height = 860;
        MinimumSize = new Size(1000, 720);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Microsoft YaHei UI", 9F);

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6, Padding = new Padding(12) };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 132));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 206));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 76));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 92));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 45));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 55));
        Controls.Add(root);

        root.Controls.Add(BuildStatusPanel(), 0, 0);
        root.Controls.Add(BuildConfigPanel(), 0, 1);
        root.Controls.Add(BuildActionPanel(), 0, 2);
        root.Controls.Add(BuildInfoPanel(), 0, 3);
        root.Controls.Add(BuildMcpPanel(), 0, 4);
        root.Controls.Add(BuildLogPanel(), 0, 5);

        Load += async (_, _) =>
        {
            LoadConfig();
            LoadMcps();
            LoadExtensions();
            RenderExtensionList();
            await RefreshAllAsync();
        };
    }

    private Control BuildStatusPanel()
    {
        var group = new GroupBox { Text = "服务总览", Dock = DockStyle.Fill };
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, Padding = new Padding(8) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.3F));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.3F));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.4F));
        group.Controls.Add(layout);
        AddStatusCard(layout, "飞书桥接", _statusBridge, 0);
        AddStatusCard(layout, "Codex CLI", _statusCodex, 1);
        AddStatusCard(layout, "套件状态", _statusSuite, 2);
        return group;
    }

    private Control BuildConfigPanel()
    {
        var group = new GroupBox { Text = "路径 / 配置", Dock = DockStyle.Fill };
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 5, Padding = new Padding(8) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 180));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 92));
        for (var i = 0; i < 4; i++) layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
        group.Controls.Add(layout);

        AddPathRow(layout, 0, "默认工作目录", _workdir);
        AddPathRow(layout, 1, "允许根目录", _allowedRoots);
        AddPathRow(layout, 2, "Unity 工程目录", _unityProject);
        AddPathRow(layout, 3, "记忆仓库目录", _memoryRepo);
        var hint = new Label { Text = "这里只编辑非敏感路径配置。多个允许根目录可用 ';' 分隔。", Dock = DockStyle.Fill, ForeColor = Color.DimGray, TextAlign = ContentAlignment.MiddleLeft };
        layout.Controls.Add(hint, 1, 4);
        layout.SetColumnSpan(hint, 1);
        var save = new Button { Text = "保存配置", Dock = DockStyle.Fill };
        save.Click += (_, _) => SaveConfig();
        layout.Controls.Add(save, 2, 4);
        return group;
    }

    private Control BuildActionPanel()
    {
        var group = new GroupBox { Text = "操作", Dock = DockStyle.Fill };
        var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(8), WrapContents = true };
        group.Controls.Add(panel);
        AddAction(panel, "刷新状态", async () => await RefreshAllAsync());
        AddAction(panel, "启动桥接", async () => await RunDaemonAsync("start"));
        AddAction(panel, "停止桥接", async () => await RunDaemonAsync("stop"));
        AddAction(panel, "重启桥接", async () => { await RunDaemonAsync("stop"); await RunDaemonAsync("start"); });
        AddAction(panel, "注册 MCP", async () => await RunPowerShellAsync(_registerMcpScript, _suiteRoot, "注册 MCP"));
        AddAction(panel, "新机初始化", async () => await RunPowerShellAsync(_bootstrapScript, _suiteRoot, "新机初始化", 300000));
        AddAction(panel, "重新打包", async () => await RunPowerShellAsync(_packageScript, _suiteRoot, "重新打包", 300000));
        AddAction(panel, "打开套件目录", () => OpenPath(_suiteRoot));
        AddAction(panel, "打开配置文件", () => OpenPath(_configPath));
        return group;
    }

    private Control BuildMcpPanel()
    {
        var group = new GroupBox { Text = "扩展列表（Skills / Plugins / MCP）", Dock = DockStyle.Fill };
        _extensionList.Dock = DockStyle.Fill;
        _extensionList.AutoScroll = true;
        _extensionList.WrapContents = false;
        _extensionList.FlowDirection = FlowDirection.TopDown;
        _extensionList.Padding = new Padding(8);
        group.Controls.Add(_extensionList);
        return group;
    }

    private Control BuildInfoPanel()
    {
        var group = new GroupBox { Text = "状态信息", Dock = DockStyle.Fill };
        _statusInfo.Text = "暂未执行操作。";
        group.Controls.Add(_statusInfo);
        return group;
    }

    private Control BuildLogPanel()
    {
        var group = new GroupBox { Text = "终端输出", Dock = DockStyle.Fill };
        _log.Dock = DockStyle.Fill;
        _log.Multiline = true;
        _log.ReadOnly = true;
        _log.ScrollBars = ScrollBars.Vertical;
        _log.Font = new Font("Consolas", 9F);
        group.Controls.Add(_log);
        return group;
    }

    private void LoadConfig()
    {
        _config = ReadEnvFile(_configPath);
        _workdir.Text = GetConfig("CTI_DEFAULT_WORKDIR", @"C:\unity\ST3");
        _allowedRoots.Text = GetConfig("CTI_ALLOWED_WORKSPACE_ROOTS", @"C:\unity\ST3");
        _unityProject.Text = GetConfig("CTI_UNITY_PROJECT_PATH", @"C:\unity\ST3\Game");
        _memoryRepo.Text = GetConfig("CTI_MEMORY_REPO_DIR", @"E:\cli-md");
        _statusSuite.Text = $"套件根目录\r\n{_suiteRoot}\r\nMCP 清单目录：{_manifestDir}";
    }

    private void LoadMcps()
    {
        _mcps = [];
        if (!Directory.Exists(_manifestDir)) return;
        foreach (var file in Directory.GetFiles(_manifestDir, "*.json").OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
        {
            var m = JsonSerializer.Deserialize<McpManifest>(File.ReadAllText(file, Encoding.UTF8), new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (m is null) continue;
            m.ManifestPath = file;
            m.Id ??= Path.GetFileNameWithoutExtension(file);
            m.DisplayName ??= m.Id;
            m.Type ??= "stdio";
            _mcps.Add(m);
        }
        _statusSuite.Text = $"套件根目录\r\n{_suiteRoot}\r\nMCP 数量：{_mcps.Count}";
    }

    private void LoadExtensions()
    {
        _extensions = [];
        foreach (var m in _mcps)
        {
            _extensions.Add(new ExtensionItem
            {
                Id = m.Id,
                DisplayName = m.DisplayName,
                Category = "mcp",
                Type = m.Type,
                Enabled = m.Enabled,
                Description = m.Description,
                ManifestPath = m.ManifestPath,
                SourcePath = ExpandValue(m.Cwd ?? ""),
                McpManifest = m
            });
        }
        LoadGenericExtensions(_skillManifestDir, "skill");
        LoadGenericExtensions(_pluginManifestDir, "plugin");
        _statusSuite.Text = $"套件根目录\r\n{_suiteRoot}\r\n扩展数量：{_extensions.Count}（MCP {_extensions.Count(e => e.Category == "mcp")} / Skill {_extensions.Count(e => e.Category == "skill")} / Plugin {_extensions.Count(e => e.Category == "plugin")}）";
    }

    private void LoadGenericExtensions(string dir, string category)
    {
        if (!Directory.Exists(dir)) return;
        foreach (var file in Directory.GetFiles(dir, "*.json").OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var item = JsonSerializer.Deserialize<GenericExtensionManifest>(File.ReadAllText(file, Encoding.UTF8), new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                if (item is null) continue;
                _extensions.Add(new ExtensionItem
                {
                    Id = item.Id,
                    DisplayName = item.DisplayName ?? item.Id,
                    Category = category,
                    Type = item.Type,
                    Enabled = item.Enabled,
                    Description = item.Description,
                    ManifestPath = file,
                    SourcePath = item.Source
                });
            }
            catch (Exception ex)
            {
                AppendLog($"extension manifest parse failed: {file} {ex.Message}");
            }
        }
    }

    private void RenderExtensionList()
    {
        _extensionList.SuspendLayout();
        _extensionList.Controls.Clear();
        foreach (var item in _extensions.OrderBy(e => e.Category).ThenBy(e => e.DisplayName, StringComparer.OrdinalIgnoreCase))
        {
            _extensionList.Controls.Add(BuildExtensionRow(item));
        }
        _extensionList.ResumeLayout();
    }

    private Control BuildMcpRow(McpManifest manifest)
    {
        var panel = new TableLayoutPanel { Width = 1080, Height = 78, ColumnCount = 6, RowCount = 2, Margin = new Padding(0, 0, 0, 8), Padding = new Padding(8), BackColor = manifest.Enabled == false ? Color.Gainsboro : Color.WhiteSmoke };
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 240));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));

        var title = new Label { Text = $"{manifest.DisplayName} [{manifest.Type}]", Dock = DockStyle.Fill, Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold), TextAlign = ContentAlignment.MiddleLeft };
        var desc = new Label { Text = manifest.Description ?? "", Dock = DockStyle.Fill, AutoEllipsis = true, ForeColor = Color.DimGray, TextAlign = ContentAlignment.MiddleLeft };
        var cwd = new Label { Text = ExpandValue(manifest.Cwd ?? ""), Dock = DockStyle.Fill, AutoEllipsis = true, ForeColor = Color.DimGray, TextAlign = ContentAlignment.MiddleLeft };
        panel.Controls.Add(title, 0, 0);
        panel.Controls.Add(desc, 1, 0);
        panel.SetColumnSpan(desc, 5);
        panel.Controls.Add(cwd, 0, 1);
        panel.SetColumnSpan(cwd, 2);

        AddMcpAction(panel, "Start", 2, manifest, async () => await StartMcpAsync(manifest));
        AddMcpAction(panel, "Check", 3, manifest, async () => await CheckMcpAsync(manifest));
        AddMcpAction(panel, "Open", 4, manifest, () => OpenPath(Path.GetDirectoryName(manifest.ManifestPath!)!));
        AddMcpAction(panel, "Register", 5, manifest, async () => await RegisterOneMcpAsync(manifest));
        return panel;
    }

    private Control BuildExtensionRow(ExtensionItem item)
    {
        if (item.Category == "mcp" && item.McpManifest is not null)
        {
            return BuildMcpRow(item.McpManifest);
        }

        var panel = new TableLayoutPanel { Width = 1080, Height = 78, ColumnCount = 5, RowCount = 2, Margin = new Padding(0, 0, 0, 8), Padding = new Padding(8), BackColor = item.Enabled == false ? Color.Gainsboro : Color.WhiteSmoke };
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 240));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));

        var title = new Label { Text = $"{item.DisplayName} [{item.Category}]", Dock = DockStyle.Fill, Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold), TextAlign = ContentAlignment.MiddleLeft };
        var desc = new Label { Text = item.Description ?? "", Dock = DockStyle.Fill, AutoEllipsis = true, ForeColor = Color.DimGray, TextAlign = ContentAlignment.MiddleLeft };
        var source = new Label { Text = item.SourcePath ?? item.ManifestPath ?? "", Dock = DockStyle.Fill, AutoEllipsis = true, ForeColor = Color.DimGray, TextAlign = ContentAlignment.MiddleLeft };
        panel.Controls.Add(title, 0, 0);
        panel.Controls.Add(desc, 1, 0);
        panel.SetColumnSpan(desc, 4);
        panel.Controls.Add(source, 0, 1);
        panel.SetColumnSpan(source, 2);
        AddExtensionAction(panel, "清单", 2, item, () => OpenPath(item.ManifestPath ?? ""));
        AddExtensionAction(panel, "来源", 3, item, () => OpenPath(item.SourcePath ?? ""));
        AddExtensionAction(panel, "信息", 4, item, () => SetStatusInfo(item.DisplayName ?? item.Id ?? item.Category ?? "扩展", $"{item.Category} 清单路径：{item.ManifestPath}", item.Enabled != false));
        return panel;
    }

    private async Task RefreshAllAsync()
    {
        LoadConfig();
        LoadMcps();
        LoadExtensions();
        RenderExtensionList();
        await CheckBridgeAsync();
        await CheckCodexAsync();
    }

    private async Task CheckBridgeAsync()
    {
        var result = await RunCommandAsync("powershell.exe", BuildPowerShellFileArguments(_daemonScript, "status"), _suiteRoot);
        var detail = BuildBridgeDiagnostic(result);
        _statusBridge.Text = detail.CardText;
        SetStatusInfo("Bridge health", detail.Summary, detail.Success);
        AppendCommand("bridge status", result);
    }

    private async Task CheckCodexAsync()
    {
        var result = await RunCommandAsync("powershell.exe", BuildPowerShellCommandArguments("codex --version"), _suiteRoot);
        _statusCodex.Text = result.ExitCode == 0 ? result.Stdout.Trim() : "不可用";
        AppendCommand("codex 版本", result);
    }

    private async Task RunDaemonAsync(string action)
    {
        await RunPowerShellAsync(_daemonScript, Path.GetDirectoryName(_daemonScript)!, $"daemon {action}", 120000, action);
        await CheckBridgeAsync();
    }

    private async Task RunPowerShellAsync(string script, string cwd, string label, int timeoutMs = 120000, string? extraArg = null)
    {
        var args = BuildPowerShellFileArguments(script, extraArg);
        var result = await RunCommandAsync("powershell.exe", args, cwd, timeoutMs: timeoutMs);
        AppendCommand(label, result);
    }

    private async Task StartMcpAsync(McpManifest manifest)
    {
        var launcher = ExpandValue(manifest.Launcher ?? "");
        var cwd = ExpandValue(manifest.Cwd ?? _suiteRoot);
        var env = BuildManifestEnv(manifest);
        var result = await RunCommandAsync("powershell.exe", BuildPowerShellFileArguments(launcher), cwd, env, 120000);
        AppendCommand($"start {manifest.DisplayName}", result);
    }

    private async Task CheckMcpAsync(McpManifest manifest)
    {
        ProcessResult result;
        if (string.Equals(manifest.HealthCheck?.Kind, "http", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(manifest.HealthCheck?.Url))
        {
            var url = ExpandValue(manifest.HealthCheck.Url);
            result = await RunCommandAsync("powershell.exe", BuildPowerShellCommandArguments($"try {{ (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 '{url}').StatusCode }} catch {{ $_.Exception.Message }}"), _suiteRoot);
        }
        else
        {
            result = await RunCommandAsync("powershell.exe", BuildPowerShellCommandArguments("codex mcp list"), _suiteRoot);
        }
        AppendCommand($"check {manifest.DisplayName}", result);
    }

    private async Task RegisterOneMcpAsync(McpManifest manifest)
    {
        if (!string.Equals(manifest.Type, "stdio", StringComparison.OrdinalIgnoreCase))
        {
            AppendLog($"{manifest.DisplayName} 是 {manifest.Type} 类型，跳过注册。");
            return;
        }
        await RunPowerShellAsync(_registerMcpScript, _suiteRoot, $"register {manifest.DisplayName}");
    }

    private Dictionary<string, string?> BuildManifestEnv(McpManifest manifest)
    {
        var env = new Dictionary<string, string?>();
        if (manifest.Env is not null)
        {
            foreach (var kv in manifest.Env)
            {
                env[kv.Key] = ExpandValue(kv.Value ?? "");
            }
        }
        env["CTI_DEFAULT_WORKDIR"] = _workdir.Text.Trim();
        env["CTI_UNITY_PROJECT_PATH"] = _unityProject.Text.Trim();
        env["CTI_MEMORY_REPO_DIR"] = _memoryRepo.Text.Trim();
        return env;
    }

    private void SaveConfig()
    {
        _config["CTI_DEFAULT_WORKDIR"] = _workdir.Text.Trim();
        _config["CTI_ALLOWED_WORKSPACE_ROOTS"] = _allowedRoots.Text.Trim();
        _config["CTI_UNITY_PROJECT_PATH"] = _unityProject.Text.Trim();
        _config["CTI_MEMORY_REPO_DIR"] = _memoryRepo.Text.Trim();

        Directory.CreateDirectory(Path.GetDirectoryName(_configPath)!);
        var lines = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (File.Exists(_configPath))
        {
            foreach (var line in File.ReadAllLines(_configPath, Encoding.UTF8))
            {
                var match = Regex.Match(line, @"^\s*([A-Za-z_][A-Za-z0-9_]*)=");
                if (!match.Success)
                {
                    lines.Add(line);
                    continue;
                }
                var key = match.Groups[1].Value;
                if (_config.TryGetValue(key, out var value))
                {
                    lines.Add($"{key}={value}");
                    seen.Add(key);
                }
                else
                {
                    lines.Add(line);
                }
            }
        }
        foreach (var key in new[] { "CTI_DEFAULT_WORKDIR", "CTI_ALLOWED_WORKSPACE_ROOTS", "CTI_UNITY_PROJECT_PATH", "CTI_MEMORY_REPO_DIR" })
        {
            if (_config.TryGetValue(key, out var value) && !seen.Contains(key))
            {
                lines.Add($"{key}={value}");
            }
        }
        File.WriteAllLines(_configPath, lines, new UTF8Encoding(false));
        AppendLog("配置已保存。");
        SetStatusInfo("配置已保存", $"已更新默认工作目录、允许根目录、Unity 工程目录和记忆仓库路径：{_configPath}", true);
    }

    private string ExpandValue(string value)
    {
        var result = value ?? "";
        result = result.Replace("${SUITE_ROOT}", _suiteRoot);
        result = result.Replace("${CTI_HOME}", Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude-to-im"));
        result = result.Replace("${USERPROFILE}", Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
        foreach (var kv in _config) result = result.Replace("${" + kv.Key + "}", kv.Value);
        return Environment.ExpandEnvironmentVariables(result);
    }

    private string GetConfig(string key, string fallback) => _config.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value) ? value : fallback;

    private static Dictionary<string, string> ReadEnvFile(string path)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!File.Exists(path)) return values;
        foreach (var raw in File.ReadAllLines(path, Encoding.UTF8))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith("#")) continue;
            var idx = line.IndexOf('=');
            if (idx <= 0) continue;
            values[line[..idx].Trim()] = line[(idx + 1)..].Trim();
        }
        return values;
    }

    private static async Task<ProcessResult> RunCommandAsync(string fileName, string arguments, string workingDirectory, Dictionary<string, string?>? env = null, int timeoutMs = 30000)
    {
        using var process = new Process();
        var outputEncoding = fileName.EndsWith("powershell.exe", StringComparison.OrdinalIgnoreCase)
            ? new UTF8Encoding(false)
            : Encoding.UTF8;
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
        if (env is not null)
        {
            foreach (var kv in env) process.StartInfo.Environment[kv.Key] = kv.Value ?? "";
        }
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) stdout.AppendLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) stderr.AppendLine(e.Data); };
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        using var cts = new CancellationTokenSource(timeoutMs);
        try
        {
            await process.WaitForExitAsync(cts.Token);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            return new ProcessResult(-1, stdout.ToString(), stderr + $"Timeout after {timeoutMs} ms.");
        }
        return new ProcessResult(process.ExitCode, stdout.ToString(), stderr.ToString());
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
        Dock = DockStyle.Fill,
    };

    private static void AddStatusCard(TableLayoutPanel parent, string title, TextBox value, int col)
    {
        var panel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(8), BackColor = Color.WhiteSmoke };
        panel.Controls.Add(value);
        panel.Controls.Add(new Label { Text = title, Dock = DockStyle.Top, Height = 24, Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold) });
        parent.Controls.Add(panel, col, 0);
    }

    private static void AddPathRow(TableLayoutPanel layout, int row, string label, TextBox box)
    {
        layout.Controls.Add(new Label { Text = label, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight }, 0, row);
        box.Dock = DockStyle.Fill;
        layout.Controls.Add(box, 1, row);
        var browse = new Button { Text = "Browse", Dock = DockStyle.Fill };
        browse.Click += (_, _) =>
        {
            using var dialog = new FolderBrowserDialog { SelectedPath = Directory.Exists(box.Text) ? box.Text : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) };
            if (dialog.ShowDialog() == DialogResult.OK) box.Text = dialog.SelectedPath;
        };
        layout.Controls.Add(browse, 2, row);
    }

    private static void AddAction(FlowLayoutPanel panel, string text, Func<Task> action)
    {
        var button = new Button { Text = text, Width = 120, Height = 34 };
        button.Click += async (_, _) =>
        {
            button.Enabled = false;
            try { await action(); }
            finally { button.Enabled = true; }
        };
        panel.Controls.Add(button);
    }

    private static void AddAction(FlowLayoutPanel panel, string text, Action action)
    {
        AddAction(panel, text, () => { action(); return Task.CompletedTask; });
    }

    private static void AddMcpAction(TableLayoutPanel panel, string text, int col, McpManifest manifest, Func<Task> action)
    {
        var button = new Button { Text = text, Dock = DockStyle.Fill, Enabled = manifest.Enabled != false };
        button.Click += async (_, _) =>
        {
            button.Enabled = false;
            try { await action(); }
            finally { button.Enabled = manifest.Enabled != false; }
        };
        panel.Controls.Add(button, col, 1);
    }

    private static void AddMcpAction(TableLayoutPanel panel, string text, int col, McpManifest manifest, Action action)
    {
        AddMcpAction(panel, text, col, manifest, () => { action(); return Task.CompletedTask; });
    }

    private static void AddExtensionAction(TableLayoutPanel panel, string text, int col, ExtensionItem item, Action action)
    {
        var button = new Button { Text = text, Dock = DockStyle.Fill, Enabled = item.Enabled != false };
        button.Click += (_, _) => action();
        panel.Controls.Add(button, col, 1);
    }

    private void AppendCommand(string title, ProcessResult result)
    {
        AppendLog($"[{DateTime.Now:HH:mm:ss}] {title} exit={result.ExitCode}");
        if (!string.IsNullOrWhiteSpace(result.Stdout)) AppendLog(MaskSecrets(result.Stdout.TrimEnd()));
        if (!string.IsNullOrWhiteSpace(result.Stderr)) AppendLog(MaskSecrets(result.Stderr.TrimEnd()));
        SetStatusFromResult(title, result);
    }

    private void AppendLog(string text)
    {
        if (InvokeRequired) { BeginInvoke(() => AppendLog(text)); return; }
        _log.AppendText(text + Environment.NewLine);
        _log.SelectionStart = _log.TextLength;
        _log.ScrollToCaret();
    }

    private void SetStatusFromResult(string title, ProcessResult result)
    {
        if (title.Contains("bridge status", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }
        var summary = BuildFriendlySummary(title, result);
        SetStatusInfo(title, summary, result.ExitCode == 0);
    }

    private void SetStatusInfo(string title, string summary, bool success)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => SetStatusInfo(title, summary, success));
            return;
        }
        var state = success ? "成功" : "失败";
        _statusInfo.Text = $"[{DateTime.Now:HH:mm:ss}] {title}\r\n{state}\r\n{summary}";
    }

    private static string BuildFriendlySummary(string title, ProcessResult result)
    {
        var output = (result.Stdout + "\n" + result.Stderr).Trim();
        if (title.Contains("bridge status", StringComparison.OrdinalIgnoreCase))
        {
            return output.Contains("Bridge status: running", StringComparison.OrdinalIgnoreCase)
                ? "桥接状态检查已完成。"
                : "桥接状态检查显示当前守护进程未运行。";
        }
        if (title.Contains("daemon start", StringComparison.OrdinalIgnoreCase) || title.Contains("Start Bridge", StringComparison.OrdinalIgnoreCase))
        {
            return result.ExitCode == 0 ? "桥接启动命令已执行完成，请查看左侧桥接状态卡片确认最终状态。" : FirstLine(output);
        }
        if (title.Contains("daemon stop", StringComparison.OrdinalIgnoreCase) || title.Contains("Stop Bridge", StringComparison.OrdinalIgnoreCase))
        {
            return result.ExitCode == 0 ? "桥接停止命令已执行完成。" : FirstLine(output);
        }
        if (title.Contains("codex version", StringComparison.OrdinalIgnoreCase))
        {
            return result.ExitCode == 0 ? $"已检测到 Codex CLI：{FirstLine(output)}" : "Codex CLI 当前不可用。";
        }
        if (title.Contains("register", StringComparison.OrdinalIgnoreCase) && title.Contains("MCP", StringComparison.OrdinalIgnoreCase))
        {
            return result.ExitCode == 0 ? "MCP 注册已完成，Codex 的全局 MCP 配置已刷新。" : FirstLine(output);
        }
        if (title.Contains("package suite", StringComparison.OrdinalIgnoreCase))
        {
            return result.ExitCode == 0 ? "便携包和安装器已在 suite 的 release 目录中重新生成。" : FirstLine(output);
        }
        if (title.Contains("check", StringComparison.OrdinalIgnoreCase))
        {
            return FirstLine(output);
        }
        return FirstLine(output);
    }

    private BridgeDiagnostic BuildBridgeDiagnostic(ProcessResult statusResult)
    {
        var isRunning = statusResult.Stdout.Contains("Bridge status: running", StringComparison.OrdinalIgnoreCase);
        var channels = "未知";
        var startedAt = "未知";

        if (File.Exists(_statusJsonPath))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(_statusJsonPath, Encoding.UTF8));
                if (doc.RootElement.TryGetProperty("channels", out var channelsEl) && channelsEl.ValueKind == JsonValueKind.Array)
                {
                    channels = string.Join(", ", channelsEl.EnumerateArray().Select(x => x.GetString()).Where(x => !string.IsNullOrWhiteSpace(x)));
                }
                if (doc.RootElement.TryGetProperty("startedAt", out var startedEl))
                {
                    startedAt = startedEl.GetString() ?? startedAt;
                }
            }
            catch { }
        }

        var lastLog = ReadLastRelevantLogLine();
        var channelOk = channels.Contains("feishu", StringComparison.OrdinalIgnoreCase);
        var success = isRunning && channelOk;
        var summary = success
            ? $"飞书桥接正在运行。通道：{channels}。启动时间：{startedAt}。最近日志：{lastLog}"
            : $"桥接当前不是完整健康状态。running={isRunning}，channels={channels}，最近日志={lastLog}";
        var card = $"运行中：{isRunning}\r\n通道：{channels}\r\n启动时间：{startedAt}\r\n最近日志：{lastLog}";
        return new BridgeDiagnostic(success, summary, card);
    }

    private string ReadLastRelevantLogLine()
    {
        if (!File.Exists(_bridgeLogPath)) return "没有 bridge.log";
        try
        {
            var lines = File.ReadAllLines(_bridgeLogPath, Encoding.UTF8)
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .TakeLast(40)
                .Reverse()
                .ToList();
            var preferred = lines.FirstOrDefault(x =>
                x.Contains("started", StringComparison.OrdinalIgnoreCase) ||
                x.Contains("running", StringComparison.OrdinalIgnoreCase) ||
                x.Contains("error", StringComparison.OrdinalIgnoreCase) ||
                x.Contains("feishu", StringComparison.OrdinalIgnoreCase));
            return FirstLine(preferred ?? lines.FirstOrDefault() ?? "没有最近日志");
        }
        catch (Exception ex)
        {
            return $"读取日志失败：{ex.Message}";
        }
    }

    private static string MaskSecrets(string text) => Regex.Replace(text, @"(CTI_[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Z0-9_]*=)(.+)", m =>
    {
        var value = m.Groups[2].Value.Trim();
        return m.Groups[1].Value + (value.Length <= 4 ? "****" : "****" + value[^4..]);
    }, RegexOptions.IgnoreCase);

    private static string FirstLine(string text) =>
        text.Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim() ?? "无详细信息";

    private static string BuildPowerShellFileArguments(string scriptPath, string? arg = null)
    {
        var escapedScript = scriptPath.Replace("'", "''");
        var escapedArg = string.IsNullOrWhiteSpace(arg) ? "" : " " + arg!.Replace("'", "''");
        var command = $"[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); & '{escapedScript}'{escapedArg}";
        return $"-NoLogo -NoProfile -ExecutionPolicy Bypass -Command \"{command}\"";
    }

    private static string BuildPowerShellCommandArguments(string command)
    {
        var escaped = command.Replace("\"", "\\\"");
        var prefix = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); ";
        return $"-NoLogo -NoProfile -ExecutionPolicy Bypass -Command \"{prefix}{escaped}\"";
    }

    private static void OpenPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        if (File.Exists(path) || Directory.Exists(path))
        {
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        }
    }

    private static string FindSuiteRoot()
    {
        var current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "suite.manifest.json"))) return current;
            current = Directory.GetParent(current)?.FullName ?? "";
        }
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", ".."));
    }

    private static string ResolveBridgeRuntimeScript(string suiteRoot)
    {
        var portableCandidate = Path.Combine(suiteRoot, "packages", "bridge-runtime", "scripts", "daemon.ps1");
        if (File.Exists(portableCandidate)) return portableCandidate;

        var devCandidate = Path.GetFullPath(Path.Combine(suiteRoot, "..", "Claude-to-IM-skill", "scripts", "daemon.ps1"));
        if (File.Exists(devCandidate)) return devCandidate;

        return portableCandidate;
    }

    private readonly record struct ProcessResult(int ExitCode, string Stdout, string Stderr);
    private readonly record struct BridgeDiagnostic(bool Success, string Summary, string CardText);
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
    public Dictionary<string, string?>? Env { get; set; }
    public McpHealthCheck? HealthCheck { get; set; }
    public string? Description { get; set; }
    public string? ManifestPath { get; set; }
}

internal sealed class McpHealthCheck
{
    public string? Kind { get; set; }
    public string? Url { get; set; }
}

internal sealed class GenericExtensionManifest
{
    public string? Id { get; set; }
    public string? DisplayName { get; set; }
    public string? Type { get; set; }
    public bool? Enabled { get; set; }
    public string? Source { get; set; }
    public string? Description { get; set; }
}

internal sealed class ExtensionItem
{
    public string? Id { get; set; }
    public string? DisplayName { get; set; }
    public string? Category { get; set; }
    public string? Type { get; set; }
    public bool? Enabled { get; set; }
    public string? Description { get; set; }
    public string? ManifestPath { get; set; }
    public string? SourcePath { get; set; }
    public McpManifest? McpManifest { get; set; }
}
