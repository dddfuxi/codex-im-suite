using System.Diagnostics;
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
    private readonly TextBox _workdir = new();
    private readonly TextBox _allowedRoots = new();
    private readonly TextBox _unityProject = new();
    private readonly TextBox _memoryRepo = new();
    private readonly TextBox _additionalDirs = new();
    private readonly TextBox _bridgeStatus = CreateStatusBox();
    private readonly TextBox _codexStatus = CreateStatusBox();
    private readonly TextBox _mcpSummaryStatus = CreateStatusBox();
    private readonly FlowLayoutPanel _mcpList = new();
    private readonly TextBox _log = new();
    private Dictionary<string, string> _config = new(StringComparer.OrdinalIgnoreCase);
    private List<McpManifest> _manifests = [];

    public MainForm()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        _skillDir = FindSkillDir();
        _ctiHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude-to-im");
        _configPath = Path.Combine(_ctiHome, "config.env");
        _daemonScript = Path.Combine(_skillDir, "scripts", "daemon.ps1");
        _registerMcpScript = Path.Combine(_skillDir, "scripts", "register-external-mcps.ps1");
        _manifestDir = Path.Combine(_skillDir, "mcp.d");

        Text = "飞书 / Codex / MCP 中控面板";
        StartPosition = FormStartPosition.CenterScreen;
        Width = 1120;
        Height = 840;
        MinimumSize = new Size(980, 720);
        Font = new Font("Microsoft YaHei UI", 9F);

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 5,
            Padding = new Padding(12),
        };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 132));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 276));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 76));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 48));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 52));
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
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, Padding = new Padding(8) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.3F));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.3F));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.4F));
        group.Controls.Add(layout);
        AddStatusCard(layout, "飞书桥接", _bridgeStatus, 0);
        AddStatusCard(layout, "Codex CLI", _codexStatus, 1);
        AddStatusCard(layout, "MCP 清单", _mcpSummaryStatus, 2);
        return group;
    }

    private static TextBox CreateStatusBox()
    {
        return new TextBox
        {
            BorderStyle = BorderStyle.None,
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Vertical,
            WordWrap = true,
            BackColor = SystemColors.Control,
            Font = new Font("Microsoft YaHei UI", 9F),
        };
    }

    private static void AddStatusCard(TableLayoutPanel parent, string title, TextBox value, int col)
    {
        var panel = new Panel { Dock = DockStyle.Fill, Padding = new Padding(8), BackColor = Color.WhiteSmoke };
        var titleLabel = new Label { Text = title, Dock = DockStyle.Top, Height = 24, Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold) };
        value.Text = "未检测";
        value.Dock = DockStyle.Fill;
        panel.Controls.Add(value);
        panel.Controls.Add(titleLabel);
        parent.Controls.Add(panel, col, 0);
    }

    private Control BuildConfigPanel()
    {
        var group = new GroupBox { Text = "路径 / 配置", Dock = DockStyle.Fill };
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 6, Padding = new Padding(8) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 160));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 118));
        for (var i = 0; i < 5; i++) layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 68));
        group.Controls.Add(layout);

        AddPathRow(layout, 0, "默认工作目录", _workdir, true);
        AddPathRow(layout, 1, "允许仓库根目录", _allowedRoots, false);
        AddPathRow(layout, 2, "Unity 工程目录", _unityProject, true);
        AddPathRow(layout, 3, "聊天记忆仓库", _memoryRepo, true);
        AddPathRow(layout, 4, "Codex 附加目录", _additionalDirs, false);

        var hint = new Label
        {
            Text = "面板只写路径类配置，不回显或改写 App Secret / Token。",
            Dock = DockStyle.Fill,
            ForeColor = Color.DimGray,
            TextAlign = ContentAlignment.TopLeft,
        };
        layout.Controls.Add(hint, 1, 5);

        var save = new Button { Text = "保存配置", Dock = DockStyle.Fill };
        save.Click += (_, _) => SaveConfigFromUi();
        layout.Controls.Add(save, 2, 5);
        return group;
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
            }
            else
            {
                var first = box.Text.Split(';', ',').Select(s => s.Trim()).FirstOrDefault(Directory.Exists);
                if (!string.IsNullOrWhiteSpace(first)) Process.Start(new ProcessStartInfo("explorer.exe", first) { UseShellExecute = true });
            }
        };
        layout.Controls.Add(browse, 2, row);
    }

    private Control BuildActionPanel()
    {
        var group = new GroupBox { Text = "基础操作", Dock = DockStyle.Fill };
        var layout = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(8), WrapContents = true };
        group.Controls.Add(layout);

        AddAction(layout, "刷新状态", async () => await RefreshAllAsync());
        AddAction(layout, "启动飞书", async () => await RunDaemonAsync("start"));
        AddAction(layout, "停止飞书", async () => await RunDaemonAsync("stop"));
        AddAction(layout, "重启飞书", async () =>
        {
            await RunDaemonAsync("stop");
            await RunDaemonAsync("start");
        });
        AddAction(layout, "查看日志", async () => await RunDaemonAsync("logs 120"));
        AddAction(layout, "检查 Codex", async () => await CheckCodexAsync());
        AddAction(layout, "注册全部 MCP", async () => await RegisterAllMcpsAsync());
        AddAction(layout, "打开配置", () => OpenPath(_configPath));
        AddAction(layout, "打开 mcp.d", () => OpenPath(_manifestDir));
        AddAction(layout, "打开记忆仓库", () => OpenPath(_memoryRepo.Text));
        return group;
    }

    private Control BuildMcpPanel()
    {
        var group = new GroupBox { Text = "MCP 列表（来自 mcp.d/*.json）", Dock = DockStyle.Fill };
        _mcpList.Dock = DockStyle.Fill;
        _mcpList.AutoScroll = true;
        _mcpList.WrapContents = false;
        _mcpList.FlowDirection = FlowDirection.TopDown;
        _mcpList.Padding = new Padding(8);
        group.Controls.Add(_mcpList);
        return group;
    }

    private Control BuildLogPanel()
    {
        var group = new GroupBox { Text = "输出", Dock = DockStyle.Fill };
        _log.Dock = DockStyle.Fill;
        _log.Multiline = true;
        _log.ScrollBars = ScrollBars.Vertical;
        _log.ReadOnly = true;
        _log.Font = new Font("Consolas", 9F);
        group.Controls.Add(_log);
        return group;
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
    {
        AddAction(layout, text, () =>
        {
            action();
            return Task.CompletedTask;
        });
    }

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
                manifest.ManifestPath = file;
                manifest.Id ??= Path.GetFileNameWithoutExtension(file);
                manifest.DisplayName ??= manifest.Id;
                manifest.Type ??= "stdio";
                manifest.Enabled ??= true;
                _manifests.Add(manifest);
            }
            catch (Exception ex)
            {
                AppendLog($"MCP 清单读取失败：{file} {ex.Message}");
            }
        }
        _mcpSummaryStatus.Text = $"发现 {_manifests.Count} 个 MCP 清单\r\n启用 {_manifests.Count(m => m.Enabled != false)} 个";
    }

    private void RenderMcpList()
    {
        _mcpList.SuspendLayout();
        _mcpList.Controls.Clear();
        foreach (var manifest in _manifests)
        {
            _mcpList.Controls.Add(BuildMcpRow(manifest));
        }
        _mcpList.ResumeLayout();
    }

    private Control BuildMcpRow(McpManifest manifest)
    {
        var panel = new TableLayoutPanel
        {
            Width = 1030,
            Height = 78,
            ColumnCount = 7,
            RowCount = 2,
            Margin = new Padding(0, 0, 0, 8),
            Padding = new Padding(8),
            BackColor = manifest.Enabled == false ? Color.Gainsboro : Color.WhiteSmoke,
        };
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 220));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 82));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 104));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 82));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 82));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 82));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));

        var title = new Label
        {
            Text = $"{manifest.DisplayName} [{manifest.Type}]",
            Dock = DockStyle.Fill,
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold),
            TextAlign = ContentAlignment.MiddleLeft,
        };
        var description = new Label
        {
            Text = manifest.Description ?? "",
            Dock = DockStyle.Fill,
            AutoEllipsis = true,
            ForeColor = Color.DimGray,
            TextAlign = ContentAlignment.MiddleLeft,
        };
        var cwd = new Label
        {
            Text = $"cwd: {ExpandValue(manifest.Cwd ?? "")}",
            Dock = DockStyle.Fill,
            AutoEllipsis = true,
            ForeColor = Color.DimGray,
            TextAlign = ContentAlignment.MiddleLeft,
        };
        panel.Controls.Add(title, 0, 0);
        panel.Controls.Add(description, 1, 0);
        panel.SetColumnSpan(description, 6);
        panel.Controls.Add(cwd, 0, 1);
        panel.SetColumnSpan(cwd, 2);

        AddMcpButton(panel, "启动", 2, manifest, async () => await StartMcpAsync(manifest));
        AddMcpButton(panel, "注册", 3, manifest, async () => await RegisterMcpAsync(manifest));
        AddMcpButton(panel, "检查", 4, manifest, async () => await CheckMcpAsync(manifest));
        AddMcpButton(panel, "目录", 5, manifest, () => OpenPath(ExpandValue(manifest.Cwd ?? Path.GetDirectoryName(manifest.ManifestPath) ?? _skillDir)));
        AddMcpButton(panel, "日志", 6, manifest, () => OpenMcpLog(manifest));
        return panel;
    }

    private static void AddMcpButton(TableLayoutPanel panel, string text, int col, McpManifest manifest, Func<Task> action)
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

    private static void AddMcpButton(TableLayoutPanel panel, string text, int col, McpManifest manifest, Action action)
    {
        AddMcpButton(panel, text, col, manifest, () =>
        {
            action();
            return Task.CompletedTask;
        });
    }

    private string GetConfig(string key, string fallback) => _config.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value) ? value : fallback;

    private void SaveConfigFromUi()
    {
        _config["CTI_DEFAULT_WORKDIR"] = _workdir.Text.Trim();
        _config["CTI_ALLOWED_WORKSPACE_ROOTS"] = _allowedRoots.Text.Trim();
        _config["CTI_UNITY_PROJECT_PATH"] = _unityProject.Text.Trim();
        _config["CTI_MEMORY_REPO_DIR"] = _memoryRepo.Text.Trim();
        if (string.IsNullOrWhiteSpace(_additionalDirs.Text)) _config.Remove("CTI_CODEX_ADDITIONAL_DIRECTORIES");
        else _config["CTI_CODEX_ADDITIONAL_DIRECTORIES"] = _additionalDirs.Text.Trim();

        Directory.CreateDirectory(Path.GetDirectoryName(_configPath)!);
        var lines = new List<string>();
        var existingKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
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
                    existingKeys.Add(key);
                }
                else
                {
                    lines.Add(line);
                }
            }
        }

        foreach (var key in new[] { "CTI_DEFAULT_WORKDIR", "CTI_ALLOWED_WORKSPACE_ROOTS", "CTI_UNITY_PROJECT_PATH", "CTI_MEMORY_REPO_DIR", "CTI_CODEX_ADDITIONAL_DIRECTORIES" })
        {
            if (_config.TryGetValue(key, out var value) && !existingKeys.Contains(key)) lines.Add($"{key}={value}");
        }

        File.WriteAllLines(_configPath, lines, new UTF8Encoding(false));
        AppendLog("配置已保存。路径配置修改后建议点击“重启飞书”。");
        LoadConfig();
        LoadManifests();
        RenderMcpList();
    }

    private async Task RefreshAllAsync()
    {
        LoadConfig();
        LoadManifests();
        RenderMcpList();
        await CheckBridgeAsync();
        await CheckCodexAsync(updateOnly: true);
        foreach (var manifest in _manifests.Where(m => m.Enabled != false))
        {
            await CheckMcpAsync(manifest, updateSummaryOnly: true);
        }
    }

    private async Task CheckBridgeAsync()
    {
        var result = await RunProcessAsync("powershell.exe", $"-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"{_daemonScript}\" status", _skillDir);
        _bridgeStatus.Text = result.Stdout.Contains("Bridge status: running", StringComparison.OrdinalIgnoreCase) ? "运行中" : "未运行";
        AppendCommand("桥接状态", result);
    }

    private async Task RunDaemonAsync(string action)
    {
        var result = await RunProcessAsync("powershell.exe", $"-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"{_daemonScript}\" {action}", _skillDir, timeoutMs: 60000);
        AppendCommand($"daemon {action}", result);
        await CheckBridgeAsync();
    }

    private async Task CheckCodexAsync(bool updateOnly = false)
    {
        var result = await RunProcessAsync("powershell.exe", "-NoLogo -NoProfile -Command \"codex --version\"", _skillDir);
        _codexStatus.Text = result.ExitCode == 0 ? FirstLine(result.Stdout) : "不可用";
        if (!updateOnly) AppendCommand("Codex CLI", result);
    }

    private async Task RegisterAllMcpsAsync()
    {
        var result = await RunProcessAsync("powershell.exe", $"-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"{_registerMcpScript}\"", _skillDir, timeoutMs: 90000);
        AppendCommand("注册全部 MCP", result);
    }

    private async Task RegisterMcpAsync(McpManifest manifest)
    {
        if (!string.Equals(manifest.Type, "stdio", StringComparison.OrdinalIgnoreCase))
        {
            AppendLog($"{manifest.DisplayName} 是 {manifest.Type} 类型，不需要注册到 codex mcp list。");
            return;
        }
        var name = manifest.RegisterName ?? manifest.Id ?? manifest.DisplayName ?? "mcp";
        var launcher = ResolvePath(manifest.Launcher ?? "");
        if (!File.Exists(launcher))
        {
            AppendLog($"MCP launcher 不存在：{launcher}");
            return;
        }

        var list = await RunProcessAsync("powershell.exe", "-NoLogo -NoProfile -Command \"codex mcp list\"", _skillDir);
        if (Regex.IsMatch(list.Stdout, "(?m)^" + Regex.Escape(name) + @"\s"))
        {
            var remove = await RunProcessAsync("powershell.exe", $"-NoLogo -NoProfile -Command \"codex mcp remove {PowerShellQuote(name)}\"", _skillDir);
            AppendCommand($"移除旧 MCP {name}", remove);
        }
        var add = await RunProcessAsync("powershell.exe", $"-NoLogo -NoProfile -Command \"codex mcp add {PowerShellQuote(name)} -- powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File {PowerShellQuote(launcher)}\"", _skillDir);
        AppendCommand($"注册 MCP {name}", add);
    }

    private async Task StartMcpAsync(McpManifest manifest)
    {
        var launcher = ResolvePath(manifest.Launcher ?? "");
        if (!File.Exists(launcher))
        {
            AppendLog($"MCP launcher 不存在：{launcher}");
            return;
        }
        var env = BuildManifestEnvironment(manifest);
        var cwd = ResolveWorkingDirectory(manifest);
        var result = await RunProcessAsync("powershell.exe", $"-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"{launcher}\"", cwd, env, timeoutMs: 90000);
        AppendCommand($"启动 MCP {manifest.DisplayName}", result);
    }

    private async Task CheckMcpAsync(McpManifest manifest, bool updateSummaryOnly = false)
    {
        var health = manifest.HealthCheck;
        ProcessResult result;
        if (health?.Kind?.Equals("http", StringComparison.OrdinalIgnoreCase) == true && !string.IsNullOrWhiteSpace(health.Url))
        {
            var url = ExpandValue(health.Url);
            result = await RunProcessAsync("powershell.exe", $"-NoLogo -NoProfile -Command \"try {{ (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 '{url}').StatusCode }} catch {{ $_.Exception.Message }}\"", _skillDir);
        }
        else
        {
            var name = manifest.RegisterName ?? manifest.Id ?? "";
            result = await RunProcessAsync("powershell.exe", "-NoLogo -NoProfile -Command \"codex mcp list\"", _skillDir);
            var registered = !string.IsNullOrWhiteSpace(name) && Regex.IsMatch(result.Stdout, "(?m)^" + Regex.Escape(name) + @"\s");
            result = result with { Stdout = registered ? $"{name} registered in codex mcp list" : $"{name} not registered in codex mcp list" };
        }
        if (!updateSummaryOnly) AppendCommand($"检查 MCP {manifest.DisplayName}", result);
    }

    private Dictionary<string, string?> BuildManifestEnvironment(McpManifest manifest)
    {
        var env = new Dictionary<string, string?>();
        if (manifest.Env is not null)
        {
            foreach (var pair in manifest.Env)
            {
                env[pair.Key] = ExpandValue(pair.Value ?? "");
            }
        }
        env["CTI_DEFAULT_WORKDIR"] = _workdir.Text.Trim();
        env["CTI_UNITY_PROJECT_PATH"] = _unityProject.Text.Trim();
        env["CTI_MEMORY_REPO_DIR"] = _memoryRepo.Text.Trim();
        return env;
    }

    private string ResolveWorkingDirectory(McpManifest manifest)
    {
        var cwd = ExpandValue(manifest.Cwd ?? "");
        if (!string.IsNullOrWhiteSpace(cwd) && Directory.Exists(cwd)) return cwd;
        return _skillDir;
    }

    private string ResolvePath(string value)
    {
        var expanded = ExpandValue(value);
        if (string.IsNullOrWhiteSpace(expanded)) return expanded;
        return Path.IsPathRooted(expanded) ? expanded : Path.GetFullPath(Path.Combine(_skillDir, expanded));
    }

    private string ExpandValue(string value)
    {
        if (string.IsNullOrEmpty(value)) return value;
        var result = value
            .Replace("${SKILL_DIR}", _skillDir)
            .Replace("${CTI_HOME}", _ctiHome)
            .Replace("${USERPROFILE}", Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
        foreach (var pair in _config)
        {
            result = result.Replace("${" + pair.Key + "}", pair.Value);
        }
        result = result.Replace("${CTI_DEFAULT_WORKDIR}", _workdir.Text.Trim());
        result = result.Replace("${CTI_UNITY_PROJECT_PATH}", _unityProject.Text.Trim());
        result = result.Replace("${CTI_MEMORY_REPO_DIR}", _memoryRepo.Text.Trim());
        return Environment.ExpandEnvironmentVariables(result);
    }

    private void OpenMcpLog(McpManifest manifest)
    {
        var runtimeDir = Path.Combine(_ctiHome, "runtime");
        if (Directory.Exists(runtimeDir)) OpenPath(runtimeDir);
        else OpenPath(_ctiHome);
        AppendLog($"已打开运行目录。MCP={manifest.DisplayName}");
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

    private static async Task<ProcessResult> RunProcessAsync(string fileName, string arguments, string workingDirectory, Dictionary<string, string?>? environment = null, int timeoutMs = 30000)
    {
        using var process = new Process();
        var outputEncoding = fileName.EndsWith("powershell.exe", StringComparison.OrdinalIgnoreCase)
            ? Encoding.Default
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

    private void AppendCommand(string title, ProcessResult result)
    {
        AppendLog($"[{DateTime.Now:HH:mm:ss}] {title} exit={result.ExitCode}");
        if (!string.IsNullOrWhiteSpace(result.Stdout)) AppendLog(MaskSecrets(result.Stdout.TrimEnd()));
        if (!string.IsNullOrWhiteSpace(result.Stderr)) AppendLog(MaskSecrets(result.Stderr.TrimEnd()));
    }

    private void AppendLog(string text)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => AppendLog(text));
            return;
        }
        _log.AppendText(text + Environment.NewLine);
        _log.SelectionStart = _log.TextLength;
        _log.ScrollToCaret();
    }

    private static string MaskSecrets(string text)
    {
        return Regex.Replace(text, @"(CTI_[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Z0-9_]*=)(.+)", m =>
        {
            var value = m.Groups[2].Value.Trim();
            return m.Groups[1].Value + (value.Length <= 4 ? "****" : "****" + value[^4..]);
        }, RegexOptions.IgnoreCase);
    }

    private static string FirstLine(string text) => text.Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim() ?? "可用";

    private static string PowerShellQuote(string value) => "'" + value.Replace("'", "''") + "'";

    private static void OpenPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        if (File.Exists(path) || Directory.Exists(path))
        {
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        }
    }

    private static string FindSkillDir()
    {
        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex", "skills", "claude-to-im"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "skills", "claude-to-im"),
            AppContext.BaseDirectory,
        };
        foreach (var candidate in candidates)
        {
            if (File.Exists(Path.Combine(candidate, "scripts", "daemon.ps1"))) return candidate;
            var parent = Directory.GetParent(candidate)?.FullName;
            if (parent is not null && File.Exists(Path.Combine(parent, "scripts", "daemon.ps1"))) return parent;
        }
        return AppContext.BaseDirectory;
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

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
