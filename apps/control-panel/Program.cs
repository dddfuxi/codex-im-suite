using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ClaudeToImControlPanel;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        ApplicationConfiguration.Initialize();
        if (args.Any(arg => string.Equals(arg, "--api-only", StringComparison.OrdinalIgnoreCase)))
        {
            using var form = new MainForm();
            form.RunControlApiOnlyAsync().GetAwaiter().GetResult();
            return;
        }
        Application.Run(new MainForm());
    }
}

internal sealed class MainForm : Form
{
    private const string WebHostName = "control-panel.local";
    private const string MediaHostName = "control-panel-media.local";
    private const uint CodePageGb2312 = 936;
    private readonly string _skillDir;
    private readonly string _ctiHome;
    private readonly string _configPath;
    private readonly string _daemonScript;
    private readonly string _registerMcpScript;
    private readonly string _manifestDir;
    private readonly string _skillsManifestDir;
    private readonly string _pluginsManifestDir;
    private readonly string _suiteRoot;
    private readonly string _publishBackupScript;
    private readonly string _mainReleaseScript;
    private readonly string _localLlmStartScript;
    private readonly string _localLlmStopScript;
    private readonly string _localLlmHealthcheckScript;
    private readonly string _localLlmReadmePath;
    private readonly string _dataDir;
    private readonly string _messagesDir;
    private readonly string _auditJsonPath;
    private readonly string _statusJsonPath;
    private readonly string _mcpServiceStatePath;
    private readonly string _localLlmStatusPath;
    private readonly string _executorStatusPath;
    private readonly string _executorSessionDefaultsPath;
    private readonly string _workflowStatusPath;
    private readonly string _finalEnvelopeStatusPath;
    private readonly string _bridgeRuntimeAuditPath;
    private readonly string _mediaCacheDir;
    private readonly string _feishuChatIndexPath;
    private readonly string _feishuHistoryDir;
    private readonly string _feishuHistoryIndexPath;
    private readonly string _webDiagnosticsLogPath;
    private readonly string _deletedSessionsPath;
    private readonly string _permissionsPath;
    private FileSystemWatcher? _manifestWatcher;
    private System.Windows.Forms.Timer? _manifestReloadTimer;
    private string _pendingManifestReloadReason = "初始化";

    private readonly TextBox _memoryRepo = new();

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
    private readonly WebView2 _webView = new();
    private readonly Panel _webFallback = new();
    private readonly List<WebActivityRecord> _activities = [];
    private readonly Dictionary<string, WebSessionDetail> _sessionDetailCache = new(StringComparer.OrdinalIgnoreCase);
    private Dictionary<string, string>? _auditSummaryByMessageId;
    private WebApplication? _controlApi;
    private string _controlApiBaseUrl = "";
    private string _controlApiBindHost = "127.0.0.1";
    private int _controlApiPort = 8788;
    private bool _webReady;
    private int _webNavigationCount;
    private int _webStatePushCount;
    private int _webSessionDetailRequestCount;

    private Dictionary<string, string> _config = new(StringComparer.OrdinalIgnoreCase);
    private List<McpManifest> _manifests = [];
    private static readonly Dictionary<string, string> ReplyStylePresets = new(StringComparer.Ordinal)
    {
        ["专业简洁"] = "回复保持专业简洁，先说结果，再说一句必要影响，不展开思考过程。",
        ["自然轻松"] = "语气自然轻松一点，像在直接回消息，但仍然先说结果，不要啰嗦。",
        ["像助理汇报"] = "回复像项目助理汇报，先说结果，再说一句影响或下一步，不解释思考过程。",
        ["更口语一点"] = "语气更口语一点，可以说“这个我处理好了”，但不要拖长，不要卖萌。",
        ["严格短句"] = "尽量使用严格短句，只保留结果和必要结论，不加铺垫。",
    };

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
        _skillsManifestDir = string.IsNullOrWhiteSpace(_suiteRoot)
            ? Path.Combine(_skillDir, "skills.d")
            : Path.Combine(_suiteRoot, "config", "skills.d");
        _pluginsManifestDir = string.IsNullOrWhiteSpace(_suiteRoot)
            ? Path.Combine(_skillDir, "plugins.d")
            : Path.Combine(_suiteRoot, "config", "plugins.d");
        _publishBackupScript = string.IsNullOrWhiteSpace(_suiteRoot) ? "" : Path.Combine(_suiteRoot, "scripts", "publish-backup.ps1");
        _mainReleaseScript = string.IsNullOrWhiteSpace(_suiteRoot) ? "" : Path.Combine(_suiteRoot, "scripts", "prepare-main-release.ps1");
        var localLlmScriptRoot = string.IsNullOrWhiteSpace(_suiteRoot)
            ? Path.Combine(_skillDir, "scripts", "local-llm")
            : Path.Combine(_suiteRoot, "scripts", "local-llm");
        _localLlmStartScript = Path.Combine(localLlmScriptRoot, "start-local-llm.ps1");
        _localLlmStopScript = Path.Combine(localLlmScriptRoot, "stop-local-llm.ps1");
        _localLlmHealthcheckScript = Path.Combine(localLlmScriptRoot, "healthcheck-local-llm.ps1");
        _localLlmReadmePath = Path.Combine(localLlmScriptRoot, "README.md");
        _dataDir = Path.Combine(_ctiHome, "data");
        _messagesDir = Path.Combine(_dataDir, "messages");
        _auditJsonPath = Path.Combine(_dataDir, "audit.json");
        _statusJsonPath = Path.Combine(_ctiHome, "runtime", "status.json");
        _mcpServiceStatePath = Path.Combine(_ctiHome, "runtime", "mcp-services.json");
        _localLlmStatusPath = Path.Combine(_ctiHome, "runtime", "local-llm-status.json");
        _executorStatusPath = Path.Combine(_ctiHome, "runtime", "executor-status.json");
        _executorSessionDefaultsPath = Path.Combine(_ctiHome, "runtime", "executor-session-defaults.json");
        _workflowStatusPath = Path.Combine(_ctiHome, "runtime", "workflow-runs.json");
        _finalEnvelopeStatusPath = Path.Combine(_ctiHome, "runtime", "final-envelope-status.json");
        _bridgeRuntimeAuditPath = Path.Combine(_ctiHome, "runtime", "bridge-runtime-audit.json");
        _mediaCacheDir = Path.Combine(_ctiHome, "runtime", "control-panel-media");
        _feishuChatIndexPath = Path.Combine(_dataDir, "feishu-chat-index.json");
        _feishuHistoryDir = Path.Combine(_dataDir, "feishu-history");
        _feishuHistoryIndexPath = Path.Combine(_dataDir, "feishu-history-index.json");
        _webDiagnosticsLogPath = Path.Combine(_ctiHome, "runtime", "control-panel-webview.log");
        _deletedSessionsPath = Path.Combine(_ctiHome, "runtime", "control-panel-deleted-sessions.json");
        _permissionsPath = Path.Combine(_dataDir, "permissions.json");

        Text = "飞书 / Codex / MCP 中控面板";
        StartPosition = FormStartPosition.CenterScreen;
        Width = 1380;
        Height = 1080;
        MinimumSize = new Size(760, 640);
        Font = new Font("Microsoft YaHei UI", 9F);

        var legacyRoot = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, Padding = new Padding(12), Visible = false };
        legacyRoot.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        legacyRoot.RowStyles.Add(new RowStyle(SizeType.Absolute, 282));
        legacyRoot.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Controls.Add(legacyRoot);

        legacyRoot.Controls.Add(BuildToolbarPanel(), 0, 0);
        legacyRoot.Controls.Add(BuildStatusPanel(), 0, 1);
        legacyRoot.Controls.Add(BuildWorkspacePanel(), 0, 2);
        Controls.Add(BuildWebShellPanel());

        Load += async (_, _) =>
        {
            LoadConfig();
            LoadManifests();
            RenderMcpList();
            InitializeManifestWatcher();
            await StartControlApiAsync();
            await InitializeWebViewAsync();
            await RefreshAllAsync();
            await PushWebStateAsync();
        };
        FormClosed += async (_, _) =>
        {
            if (_controlApi is not null)
            {
                await _controlApi.StopAsync();
                await _controlApi.DisposeAsync();
            }
        };
    }

    public async Task RunControlApiOnlyAsync()
    {
        LoadConfig();
        LoadManifests();
        await StartControlApiAsync();
        if (_controlApi is null)
        {
            throw new InvalidOperationException("Control API 启动失败，请检查 CTI_CONTROL_API_* 配置和 wwwroot。");
        }
        await Task.Delay(Timeout.Infinite);
    }

    private Control BuildWebShellPanel()
    {
        var host = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(247, 248, 250) };
        _webView.Dock = DockStyle.Fill;
        _webFallback.Dock = DockStyle.Fill;
        _webFallback.Visible = false;
        host.Controls.Add(_webView);
        host.Controls.Add(_webFallback);
        return host;
    }

    private async Task StartControlApiAsync()
    {
        if (_controlApi is not null) return;

        var webRoot = ResolveWebRootPath();
        if (string.IsNullOrWhiteSpace(webRoot) || !Directory.Exists(webRoot))
        {
            AddWebActivity("warning", "Control API 未启动", "前端 wwwroot 不存在，暂时只保留 WebView 兜底页。");
            return;
        }

        var enabled = !string.Equals(GetConfig("CTI_CONTROL_API_ENABLED", "true"), "false", StringComparison.OrdinalIgnoreCase);
        if (!enabled) return;

        _controlApiBindHost = GetConfig("CTI_CONTROL_API_HOST", GetConfig("CTI_CONTROL_API_BIND", "127.0.0.1")).Trim();
        if (string.IsNullOrWhiteSpace(_controlApiBindHost)) _controlApiBindHost = "127.0.0.1";
        _controlApiPort = int.TryParse(GetConfig("CTI_CONTROL_API_PORT", "8788"), out var configuredPort) && configuredPort > 0
            ? configuredPort
            : 8788;
        var allowRemote = string.Equals(GetConfig("CTI_CONTROL_API_ALLOW_REMOTE", "false"), "true", StringComparison.OrdinalIgnoreCase);
        var token = GetConfig("CTI_CONTROL_API_AUTH_TOKEN", "").Trim();
        if (!IsLoopbackBindHost(_controlApiBindHost) && (!allowRemote || string.IsNullOrWhiteSpace(token)))
        {
            AddWebActivity("error", "Control API 拒绝公网监听", "非本机监听必须同时配置 CTI_CONTROL_API_ALLOW_REMOTE=true 和 CTI_CONTROL_API_AUTH_TOKEN。");
            return;
        }

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            Args = [],
            ContentRootPath = AppContext.BaseDirectory,
        });
        builder.WebHost.UseUrls($"http://{_controlApiBindHost}:{_controlApiPort}");
        var app = builder.Build();
        ConfigureControlApi(app, webRoot);
        await app.StartAsync();
        _controlApi = app;
        _controlApiBaseUrl = GetConfig("CTI_CONTROL_API_PUBLIC_BASE_URL", "").Trim().TrimEnd('/');
        if (string.IsNullOrWhiteSpace(_controlApiBaseUrl))
        {
            var browserHost = IsWildcardBindHost(_controlApiBindHost) ? "127.0.0.1" : _controlApiBindHost;
            _controlApiBaseUrl = $"http://{browserHost}:{_controlApiPort}";
        }
        AddWebActivity("info", "Control API 已启动", _controlApiBaseUrl);
    }

    private void ConfigureControlApi(WebApplication app, string webRoot)
    {
        var webFiles = new PhysicalFileProvider(webRoot);
        app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = webFiles });
        app.UseStaticFiles(new StaticFileOptions { FileProvider = webFiles });
        Directory.CreateDirectory(_mediaCacheDir);
        app.Use(async (context, next) =>
        {
            if (context.Request.Path.StartsWithSegments("/media")
                && !AuthorizeControlApi(context, "history.getSessionDetail", out var failure))
            {
                await failure.ExecuteAsync(context);
                return;
            }
            await next();
        });
        app.UseStaticFiles(new StaticFileOptions
        {
            FileProvider = new PhysicalFileProvider(_mediaCacheDir),
            RequestPath = "/media",
            ServeUnknownFileTypes = true,
            ContentTypeProvider = new FileExtensionContentTypeProvider(),
        });

        app.MapGet("/healthz", () => Results.Json(new
        {
            ok = true,
            protocol = "cti-control-api/v1",
            generatedAt = DateTime.UtcNow.ToString("o"),
        }, WebJsonOptions));

        app.MapGet("/api/state", async (HttpContext context) =>
        {
            if (!AuthorizeControlApi(context, "state.refresh", out var failure)) return failure;
            return Results.Json(await BuildWebStateAsync(), WebJsonOptions);
        });

        app.MapPost("/api/commands", async (HttpContext context) =>
        {
            WebCommandRequest? request;
            try
            {
                request = await JsonSerializer.DeserializeAsync<WebCommandRequest>(context.Request.Body, WebJsonOptions);
            }
            catch (Exception ex)
            {
                return Results.BadRequest(new { ok = false, error = $"请求解析失败：{ex.Message}" });
            }
            if (request is null || string.IsNullOrWhiteSpace(request.Command))
            {
                return Results.BadRequest(new { ok = false, error = "缺少 command。" });
            }
            if (!AuthorizeControlApi(context, request.Command, out var failure)) return failure;
            try
            {
                var data = await ExecuteWebCommandAsync(request.Command, request.Payload);
                AddControlApiAudit(context, request.Command, request.Payload, true, "");
                return Results.Json(new { ok = true, data }, WebJsonOptions);
            }
            catch (Exception ex)
            {
                AddControlApiAudit(context, request.Command, request.Payload, false, ex.Message);
                return Results.Json(new { ok = false, error = ex.Message }, WebJsonOptions, statusCode: 500);
            }
        });

        app.MapGet("/api/session/{chatId}/{sessionId}", async (HttpContext context, string chatId, string sessionId) =>
        {
            if (!AuthorizeControlApi(context, "history.getSessionDetail", out var failure)) return failure;
            var payload = JsonSerializer.SerializeToElement(new { chatId, sessionId, force = false }, WebJsonOptions);
            return Results.Json(await ExecuteWebCommandAsync("history.getSessionDetail", payload), WebJsonOptions);
        });

        app.MapGet("/api/events", async (HttpContext context) =>
        {
            if (!AuthorizeControlApi(context, "state.refresh", out var failure))
            {
                context.Response.StatusCode = failure is IStatusCodeHttpResult statusResult ? statusResult.StatusCode ?? 403 : 403;
                await context.Response.WriteAsJsonAsync(new { ok = false, error = "unauthorized" }, WebJsonOptions);
                return;
            }
            context.Response.Headers.CacheControl = "no-cache";
            context.Response.Headers.ContentType = "text/event-stream";
            while (!context.RequestAborted.IsCancellationRequested)
            {
                var state = await BuildWebStateAsync();
                var json = JsonSerializer.Serialize(new { type = "state", data = state }, WebJsonOptions);
                await context.Response.WriteAsync($"event: state\ndata: {json}\n\n", context.RequestAborted);
                await context.Response.Body.FlushAsync(context.RequestAborted);
                await Task.Delay(TimeSpan.FromSeconds(5), context.RequestAborted);
            }
        });
    }

    private bool AuthorizeControlApi(HttpContext context, string command, out IResult failure)
    {
        failure = Results.Empty;
        var remoteIp = context.Connection.RemoteIpAddress;
        var isLoopback = remoteIp is null || IPAddress.IsLoopback(remoteIp);
        var requiredRole = RequiredRoleForControlCommand(command);
        if (!isLoopback)
        {
            var token = GetConfig("CTI_CONTROL_API_AUTH_TOKEN", "").Trim();
            var auth = context.Request.Headers.Authorization.ToString();
            var queryToken = context.Request.Query["token"].ToString();
            var presented = auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? auth[7..].Trim() : queryToken.Trim();
            if (string.IsNullOrWhiteSpace(token) || !CryptographicEquals(token, presented))
            {
                failure = Results.Json(new { ok = false, error = "Control API 需要有效 token。" }, WebJsonOptions, statusCode: 401);
                return false;
            }
            var authRole = NormalizeControlApiRole(GetConfig("CTI_CONTROL_API_AUTH_ROLE", "viewer"));
            if (!ControlRoleAllows(authRole, requiredRole))
            {
                failure = Results.Json(new { ok = false, error = $"当前 Control API token 角色为 {authRole}，不能执行 {requiredRole} 命令。" }, WebJsonOptions, statusCode: 403);
                return false;
            }
            var allowDangerous = string.Equals(GetConfig("CTI_CONTROL_API_ALLOW_REMOTE_DANGEROUS", "false"), "true", StringComparison.OrdinalIgnoreCase);
            if (requiredRole == "owner" && !allowDangerous)
            {
                failure = Results.Json(new { ok = false, error = "远程 Owner 高危命令默认关闭，请显式配置 CTI_CONTROL_API_ALLOW_REMOTE_DANGEROUS=true。" }, WebJsonOptions, statusCode: 403);
                return false;
            }
        }
        return true;
    }

    private static string NormalizeControlApiRole(string value)
    {
        var normalized = value.Trim().ToLowerInvariant();
        return normalized is "owner" or "operator" or "viewer" ? normalized : "viewer";
    }

    private static bool ControlRoleAllows(string actualRole, string requiredRole)
    {
        static int Rank(string role) => role switch
        {
            "owner" => 3,
            "operator" => 2,
            "viewer" => 1,
            _ => 0,
        };
        return Rank(actualRole) >= Rank(requiredRole);
    }

    private static string RequiredRoleForControlCommand(string command)
    {
        if (command.StartsWith("permissions.", StringComparison.OrdinalIgnoreCase)
            || command.StartsWith("release.", StringComparison.OrdinalIgnoreCase)
            || string.Equals(command, "security.addFeishuOwner", StringComparison.OrdinalIgnoreCase))
        {
            return "owner";
        }
        if (command.StartsWith("bridge.", StringComparison.OrdinalIgnoreCase)
            || command.StartsWith("mcp.", StringComparison.OrdinalIgnoreCase)
            || command.StartsWith("localLlm.", StringComparison.OrdinalIgnoreCase)
            || string.Equals(command, "runtime.invokeAction", StringComparison.OrdinalIgnoreCase)
            || string.Equals(command, "settings.save", StringComparison.OrdinalIgnoreCase)
            || command.StartsWith("extension.", StringComparison.OrdinalIgnoreCase))
        {
            return "operator";
        }
        return "viewer";
    }

    private void AddControlApiAudit(HttpContext context, string command, JsonElement payload, bool ok, string error)
    {
        var role = RequiredRoleForControlCommand(command);
        var summary = payload.ValueKind == JsonValueKind.Undefined ? "" : payload.GetRawText();
        if (summary.Length > 500) summary = summary[..500] + "...";
        AddWebActivity(ok ? "info" : "error", $"Control API {command}", $"{role} · {context.Connection.RemoteIpAddress} · {(ok ? "ok" : error)} · {MaskSecrets(summary)}");
    }

    private static bool IsLoopbackBindHost(string host)
        => string.Equals(host, "127.0.0.1", StringComparison.OrdinalIgnoreCase)
            || string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)
            || string.Equals(host, "::1", StringComparison.OrdinalIgnoreCase);

    private static bool IsWildcardBindHost(string host)
        => string.Equals(host, "0.0.0.0", StringComparison.OrdinalIgnoreCase)
            || string.Equals(host, "*", StringComparison.OrdinalIgnoreCase)
            || string.Equals(host, "+", StringComparison.OrdinalIgnoreCase);

    private static bool CryptographicEquals(string expected, string actual)
    {
        var expectedBytes = Encoding.UTF8.GetBytes(expected);
        var actualBytes = Encoding.UTF8.GetBytes(actual);
        return expectedBytes.Length == actualBytes.Length && CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            _ = CoreWebView2Environment.GetAvailableBrowserVersionString();
        }
        catch
        {
            ShowWebFallback(
                "缺少 WebView2 Runtime",
                "新版控制面板需要 Microsoft Edge WebView2 Runtime。请安装后重启面板。",
                "https://developer.microsoft.com/microsoft-edge/webview2/");
            return;
        }

        var webRoot = ResolveWebRootPath();
        if (string.IsNullOrWhiteSpace(webRoot) || !Directory.Exists(webRoot))
        {
            ShowWebFallback(
                "前端资源未构建",
                "未找到 wwwroot/index.html。请先运行 scripts/build-packages.ps1 或在 apps/control-panel/web 执行 npm run build。",
                string.IsNullOrWhiteSpace(_suiteRoot) ? "" : _suiteRoot);
            return;
        }

        try
        {
            await _webView.EnsureCoreWebView2Async();
            _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            _webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
            Directory.CreateDirectory(_mediaCacheDir);
            _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                WebHostName,
                webRoot,
                CoreWebView2HostResourceAccessKind.Allow);
            _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                MediaHostName,
                _mediaCacheDir,
                CoreWebView2HostResourceAccessKind.Allow);
            _webView.CoreWebView2.WebMessageReceived += async (_, args) => await HandleWebMessageAsync(args.WebMessageAsJson);
            _webView.CoreWebView2.NavigationCompleted += async (_, args) =>
            {
                var navigationCount = Interlocked.Increment(ref _webNavigationCount);
                AppendWebDiagnostics($"navigation completed success={args.IsSuccess} count={navigationCount} status={args.WebErrorStatus}");
                if (!args.IsSuccess)
                {
                    ShowWebFallback("前端加载失败", $"WebView2 无法加载控制面板页面：{args.WebErrorStatus}", webRoot);
                    return;
                }

                await PushWebStateAsync();
            };
            _webReady = true;
            _webView.Source = new Uri(string.IsNullOrWhiteSpace(_controlApiBaseUrl)
                ? $"https://{WebHostName}/index.html"
                : $"{_controlApiBaseUrl}/index.html");
        }
        catch (Exception ex)
        {
            ShowWebFallback("WebView2 初始化失败", ex.Message, "");
        }
    }

    private string ResolveWebRootPath()
    {
        var candidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "wwwroot"),
            string.IsNullOrWhiteSpace(_suiteRoot) ? "" : Path.Combine(_suiteRoot, "apps", "control-panel", "wwwroot"),
        };
        return candidates.FirstOrDefault(Directory.Exists) ?? "";
    }

    private void ShowWebFallback(string title, string detail, string target)
    {
        _webFallback.Controls.Clear();
        _webFallback.Visible = true;
        _webFallback.BringToFront();
        _webView.Visible = false;

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(42) };
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 84));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        _webFallback.Controls.Add(layout);

        var titleLabel = new Label
        {
            Text = title,
            Dock = DockStyle.Fill,
            Font = new Font("Microsoft YaHei UI", 18F, FontStyle.Bold),
            TextAlign = ContentAlignment.BottomCenter,
        };
        var detailLabel = new Label
        {
            Text = detail,
            Dock = DockStyle.Fill,
            ForeColor = Color.DimGray,
            TextAlign = ContentAlignment.TopCenter,
        };
        var buttonBar = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false };
        var openTarget = new Button { Text = "打开相关位置", Width = 132, Height = 34 };
        openTarget.Click += (_, _) =>
        {
            if (!string.IsNullOrWhiteSpace(target)) OpenPath(target);
        };
        var refresh = new Button { Text = "重试加载", Width = 108, Height = 34 };
        refresh.Click += async (_, _) =>
        {
            _webFallback.Visible = false;
            _webView.Visible = true;
            await InitializeWebViewAsync();
        };
        buttonBar.Controls.Add(openTarget);
        buttonBar.Controls.Add(refresh);

        layout.Controls.Add(titleLabel, 0, 0);
        layout.Controls.Add(detailLabel, 0, 1);
        layout.Controls.Add(buttonBar, 0, 2);
    }

    private async Task HandleWebMessageAsync(string json)
    {
        WebCommandRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<WebCommandRequest>(json, WebJsonOptions);
        }
        catch (Exception ex)
        {
            PostWebMessage(new { type = "result", id = "", ok = false, error = $"请求解析失败：{ex.Message}" });
            return;
        }

        if (request is null || request.Type != "command" || string.IsNullOrWhiteSpace(request.Command))
        {
            PostWebMessage(new { type = "result", id = request?.Id ?? "", ok = false, error = "无效的 WebView 命令。" });
            return;
        }

        try
        {
            var quietCommand = IsQuietWebCommand(request.Command);
            AppendWebDiagnostics($"command received quiet={quietCommand} command={request.Command}");
            if (!quietCommand)
            {
                AddWebActivity("info", "开始执行", request.Command);
            }
            var data = await ExecuteWebCommandAsync(request.Command, request.Payload);
            PostWebMessage(new { type = "result", id = request.Id, ok = true, data });
            if (!quietCommand)
            {
                await PushWebStateAsync();
            }
        }
        catch (Exception ex)
        {
            if (!IsQuietWebCommand(request.Command))
            {
                AddWebActivity("error", request.Command, ex.Message);
            }
            PostWebMessage(new { type = "result", id = request.Id, ok = false, error = ex.Message });
            if (!IsQuietWebCommand(request.Command))
            {
                await PushWebStateAsync();
            }
        }
    }

    private static bool IsQuietWebCommand(string? command)
        => string.Equals(command, "history.getSessionDetail", StringComparison.OrdinalIgnoreCase);

    private async Task<object?> ExecuteWebCommandAsync(string command, JsonElement payload)
    {
        switch (command)
        {
            case "state.refresh":
                await RefreshAllAsync();
                return await BuildWebStateAsync();
            case "bridge.start":
                await RunDaemonAsync("start");
                return "bridge start requested";
            case "bridge.stop":
                await RunDaemonAsync("stop");
                return "bridge stop requested";
            case "bridge.restart":
                await RestartBridgeAsync();
                return "bridge restarted";
            case "bridge.logs":
                await RunDaemonAsync("logs 120");
                return "bridge logs loaded";
            case "bridge.status":
                await CheckBridgeAsync();
                return _bridgeStatus.Text;
            case "codex.check":
                await CheckCodexAsync();
                return _codexStatus.Text;
            case "codex.setRouterMode":
                await SetRouterModeAsync(ReadPayloadString(payload, "mode", "hybrid"));
                return _codexStatus.Text;
            case "localLlm.start":
                await StartLocalLlmAsync();
                return _localLlmStatus.Text;
            case "localLlm.stop":
                await StopLocalLlmAsync();
                return _localLlmStatus.Text;
            case "localLlm.check":
                await CheckLocalLlmAsync();
                return _localLlmStatus.Text;
            case "mcp.list":
                LoadManifests();
                await UpdateMcpManifestStatesAsync();
                RenderMcpList();
                return BuildMcpItems();
            case "mcp.start":
                SelectMcpById(ReadPayloadString(payload, "id", ""));
                await StartSelectedMcpAsync();
                return _mcpRuntimeStatus.Text;
            case "mcp.stop":
                SelectMcpById(ReadPayloadString(payload, "id", ""));
                await StopSelectedMcpAsync();
                return _mcpRuntimeStatus.Text;
            case "mcp.check":
                SelectMcpById(ReadPayloadString(payload, "id", ""));
                await CheckSelectedMcpAsync();
                return _mcpRuntimeStatus.Text;
            case "mcp.registerAll":
                await RegisterAllMcpsAsync();
                return _mcpStatus.Text;
            case "mcp.openLocation":
                SelectMcpById(ReadPayloadString(payload, "id", ""));
                OpenSelectedMcpPath();
                return "opened";
            case "release.publishBackup":
                await PublishSuiteAsync();
                return "publish backup finished";
            case "release.prepareMainRelease":
                await PrepareMainReleaseAsync();
                return "main release preflight finished";
            case "release.openSummary":
                OpenLatestPublishSummary();
                return "opened";
            case "release.openNotes":
                OpenReleaseNotes();
                return "opened";
            case "release.openSuite":
                OpenPath(_suiteRoot);
                return "opened";
            case "settings.read":
                return GetSettingsSnapshot();
            case "settings.save":
                SaveSettingsFromDialog(ReadSettingsPayload(payload));
                return GetSettingsSnapshot();
            case "history.syncAll":
                await SyncAllFeishuHistoryAsync();
                return GetFeishuHistorySyncStatusText(full: true);
            case "history.status":
                return GetFeishuHistorySyncStatusText(full: true);
            case "history.listSessions":
                return await BuildSessionItemsAsync();
            case "history.getSessionDetail":
                return await GetSessionDetailAsync(payload);
            case "history.deleteSession":
                return await DeleteSessionAsync(payload);
            case "security.addFeishuOwner":
                return await AddFeishuOwnerAsync(payload);
            case "permissions.list":
                return LoadPermissionSnapshot(syncFromConfig: true);
            case "permissions.upsert":
                return UpsertPermissionSubject(payload);
            case "permissions.remove":
                return RemovePermissionSubject(payload);
            case "permissions.syncFromConfig":
                return LoadPermissionSnapshot(syncFromConfig: true);
            case "permissions.applyAndRestart":
                SyncPermissionSnapshotToConfig(LoadPermissionSnapshot(syncFromConfig: true));
                await RestartBridgeAsync();
                return LoadPermissionSnapshot(syncFromConfig: false);
            case "history.openConversationViewer":
                await ShowConversationViewerAsync();
                return "opened";
            case "path.openConfig":
                OpenPath(_configPath);
                return "opened";
            case "path.openManifestDir":
                OpenPath(_manifestDir);
                return "opened";
            case "path.openMemoryRepo":
                OpenPath(_memoryRepo.Text);
                return "opened";
            case "path.openAny":
                OpenPath(ReadPayloadString(payload, "path", ""));
                return "opened";
            case "path.pickFolder":
                return PickFolder(ReadPayloadString(payload, "currentPath", ""));
            case "path.pickFile":
                return PickFile(ReadPayloadString(payload, "currentPath", ""));
            case "settings.listReplyPresets":
                return BuildReplyPresetItems();
            case "settings.applyReplyPreset":
                return ApplyReplyPreset(ReadPayloadString(payload, "name", ""));
            case "settings.summarizeReplyStyle":
                return await SummarizeReplyStyleAsync(ReadPayloadString(payload, "text", ""));
            case "runtime.listUnits":
                return BuildRuntimeUnits();
            case "runtime.invokeAction":
                return await InvokeRuntimeUnitActionAsync(payload);
            case "extension.enable":
                await SetExtensionEnabledAsync(ReadPayloadString(payload, "manifestPath", ""), true);
                return "enabled";
            case "extension.disable":
                await SetExtensionEnabledAsync(ReadPayloadString(payload, "manifestPath", ""), false);
                return "disabled";
            case "extension.remove":
                await RemoveExtensionAsync(ReadPayloadString(payload, "manifestPath", ""));
                return "removed";
            case "extension.install":
                await InstallExtensionAsync(ReadPayloadString(payload, "manifestPath", ""));
                return "installed";
            case "extension.detectImport":
                return DetectExtensionImport(ReadPayloadString(payload, "folderPath", ""));
            case "extension.importFromFolder":
                return await ImportExtensionFromFolderAsync(
                    ReadPayloadString(payload, "folderPath", ""),
                    ReadPayloadString(payload, "kind", ""),
                    ReadPayloadString(payload, "runtimeType", ""));
            case "workflow.listRuns":
                return ListWorkflowRuns();
            case "workflow.getRun":
                return GetWorkflowRun(payload);
            case "workflow.getEvents":
                return GetWorkflowEvents(payload);
            case "executor.list":
                return ReadExecutorStatusPayload();
            case "executor.check":
                return ReadExecutorStatusPayload();
            case "executor.setSessionDefault":
                return SetExecutorSessionDefault(payload);
            default:
                throw new InvalidOperationException($"未知或未授权命令：{command}");
        }
    }

    private async Task PushWebStateAsync()
    {
        if (!_webReady || _webView.CoreWebView2 is null) return;
        var pushCount = Interlocked.Increment(ref _webStatePushCount);
        AppendWebDiagnostics($"push state count={pushCount}");
        var state = await BuildWebStateAsync();
        PostWebMessage(new { type = "state", data = state });
    }

    private async Task<object> BuildWebStateAsync()
    {
        var branch = !string.IsNullOrWhiteSpace(_suiteRoot) ? await RunGitTextAsync("branch --show-current") : "unknown";
        var commit = !string.IsNullOrWhiteSpace(_suiteRoot) ? await RunGitTextAsync("rev-parse --short HEAD") : "unknown";
        var status = !string.IsNullOrWhiteSpace(_suiteRoot)
            ? await RunProcessAsync("powershell.exe", "-NoLogo -NoProfile -Command \"git status --short\"", _suiteRoot)
            : new ProcessResult(1, "", "");
        var statusLines = status.ExitCode == 0
            ? status.Stdout.Split(["\r\n", "\n"], StringSplitOptions.RemoveEmptyEntries)
            : Array.Empty<string>();
        var suite = ReadSuiteVersionInfo();
        var extensions = ReadExtensionStatus();
        var mcpItems = BuildMcpItems();
        var sessionItems = await BuildSessionItemsAsync();
        return new
        {
            generatedAt = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
            suite = new
            {
                version = suite.Version,
                protocol = suite.Protocol,
                branch,
                commit,
                gitDirty = statusLines.Length,
                suiteRoot = _suiteRoot,
                skillDir = _skillDir,
            },
            services = new[]
            {
                BuildServiceItem("bridge", "飞书桥接", _bridgeStatus.Text),
                BuildServiceItem("codex", "Codex CLI", _codexStatus.Text),
                BuildServiceItem("localLlm", "本地辅助执行器", _localLlmStatus.Text),
                BuildServiceItem("mcp", "MCP 清单", _mcpStatus.Text),
                BuildServiceItem("version", "版本 / 扩展", _buildStatus.Text),
            },
            extensions = new
            {
                total = extensions.Total,
                enabled = extensions.Enabled,
                disabled = extensions.Disabled,
                missingSources = extensions.MissingSources,
                items = BuildExtensionItems(),
            },
            mcp = new
            {
                total = mcpItems.Length,
                running = mcpItems.Count(item => item.IsRunning),
                items = mcpItems,
                selectedId = (_mcpList.SelectedItem as McpManifest)?.Id,
                runtimeStatus = _mcpRuntimeStatus.Text,
                details = _mcpDetails.Text,
            },
            release = new
            {
                publishSummaryExists = File.Exists(Path.Combine(_suiteRoot, "publish-summary.md")),
                releaseNotesExists = File.Exists(Path.Combine(_suiteRoot, "release-notes.md")),
                prepareMainReleaseExists = File.Exists(_mainReleaseScript),
                tagScriptExists = File.Exists(Path.Combine(_suiteRoot, "scripts", "create-main-release-tag.ps1")),
                pendingChanges = statusLines.Take(80).ToArray(),
            },
            settings = GetSettingsSnapshot(),
            history = new
            {
                status = GetFeishuHistorySyncStatusText(full: false),
                sessions = sessionItems.Take(80).ToArray(),
            },
            workflow = ListWorkflowRuns(),
            executors = ReadExecutorStatusPayload(),
            permissions = LoadPermissionSnapshot(syncFromConfig: true),
            diagnostics = new
            {
                webNavigationCount = Volatile.Read(ref _webNavigationCount),
                webStatePushCount = Volatile.Read(ref _webStatePushCount),
                sessionDetailRequestCount = Volatile.Read(ref _webSessionDetailRequestCount),
            },
            paths = new
            {
                config = _configPath,
                manifestDir = _manifestDir,
                memoryRepo = _memoryRepo.Text,
                logs = Path.Combine(_ctiHome, "logs"),
            },
            activities = _activities.TakeLast(220).ToArray(),
        };
    }

    private WebServiceItem BuildServiceItem(string id, string title, string text)
        => new(id, title, ClassifyStatus(id, text), text);

    private static string ClassifyStatus(string id, string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return "idle";

        var firstLine = FirstNonEmptyLine(text) ?? "";
        if (string.Equals(id, "codex", StringComparison.OrdinalIgnoreCase))
        {
            if (Regex.IsMatch(firstLine, "不可用|失败|异常|错误|未找到", RegexOptions.IgnoreCase)) return "error";
            if (Regex.IsMatch(text, "(^|\\n)主脑[:：]\\s*Codex|(^|\\n)降级[:：]\\s*正常", RegexOptions.IgnoreCase)) return "ok";
        }
        if (Regex.IsMatch(firstLine, "离线|失败|异常|错误|不可用|缺少|未找到", RegexOptions.IgnoreCase)) return "error";
        if (Regex.IsMatch(firstLine, "未运行|未启用", RegexOptions.IgnoreCase)) return "warning";
        if (Regex.IsMatch(firstLine, "在线|运行中|通过|可用|online", RegexOptions.IgnoreCase)) return "ok";

        if (string.Equals(id, "version", StringComparison.OrdinalIgnoreCase))
        {
            if (Regex.IsMatch(text, "dirty|缺依赖", RegexOptions.IgnoreCase)) return "warning";
            if (Regex.IsMatch(text, "Suite|扩展协议", RegexOptions.IgnoreCase)) return "ok";
        }

        if (Regex.IsMatch(text, "(^|\\n)状态[:：].*(失败|异常|错误|不可用)|(^|\\n)健康[:：].*(失败|异常|错误|不可用)", RegexOptions.IgnoreCase)) return "error";
        if (Regex.IsMatch(text, "(^|\\n)(运行中|通过|可用|online|已注册|启用)(\\b|$)", RegexOptions.IgnoreCase)) return "ok";
        return "idle";
    }

    private WebMcpItem[] BuildMcpItems()
    {
        var states = LoadMcpServiceStates();
        return _manifests.Select(manifest =>
        {
            var running = TryGetRunningServiceState(manifest, states, out var state);
            return new WebMcpItem(
                manifest.Id ?? "",
                manifest.DisplayName ?? manifest.Id ?? "",
                manifest.Type ?? "",
                manifest.Category ?? "",
                manifest.Enabled != false,
                running,
                state?.ProcessId,
                manifest.IsRegistered,
                manifest.InstallState ?? "",
                manifest.Source ?? "",
                manifest.Version ?? "",
                manifest.Compatibility?.Protocol ?? "",
                manifest.Compatibility?.Suite ?? "",
                manifest.Aliases ?? [],
                manifest.Description ?? "");
        }).ToArray();
    }

    private WebExtensionItem[] BuildExtensionItems()
    {
        var items = new List<WebExtensionItem>();
        foreach (var dir in new[] { _manifestDir, _skillsManifestDir, _pluginsManifestDir }.Where(Directory.Exists))
        {
            var manifestKind = string.Equals(dir, _skillsManifestDir, StringComparison.OrdinalIgnoreCase)
                ? "skill"
                : string.Equals(dir, _pluginsManifestDir, StringComparison.OrdinalIgnoreCase)
                    ? "plugin"
                    : "extension";
            foreach (var file in Directory.GetFiles(dir, "*.json").OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                try
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(file, Encoding.UTF8));
                    var root = doc.RootElement;
                    var source = ReadJsonString(root, "source");
                    var enabled = !root.TryGetProperty("enabled", out var enabledElement) || enabledElement.ValueKind != JsonValueKind.False;
                    var sourceExists = true;
                    if (IsLocalManifestSource(source))
                    {
                        var expanded = ExpandManifestValue(source);
                        sourceExists = File.Exists(expanded) || Directory.Exists(expanded);
                    }
                    var canInstall =
                        (root.TryGetProperty("installer", out var installerElement) && installerElement.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(installerElement.GetString()))
                        || (root.TryGetProperty("bootstrap", out var bootstrapElement) && bootstrapElement.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(bootstrapElement.GetString()));
                    items.Add(new WebExtensionItem(
                        ReadJsonString(root, "id"),
                        ReadJsonString(root, "displayName"),
                        manifestKind,
                        ReadJsonString(root, "type"),
                        ReadJsonString(root, "category"),
                        enabled,
                        ReadJsonString(root, "installState"),
                        source,
                        sourceExists,
                        ReadJsonString(root, "description"),
                        file,
                        canInstall));
                }
                catch (Exception ex)
                {
                    items.Add(new WebExtensionItem(Path.GetFileNameWithoutExtension(file), Path.GetFileName(file), manifestKind, "unknown", "", false, "missing", "", false, ex.Message, file, false));
                }
            }
        }
        return items.ToArray();
    }

    private async Task<WebSessionItem[]> BuildSessionItemsAsync()
    {
        try
        {
            var localEntries = LoadConversationEntries();
            var mergedEntries = await LoadRemoteConversationEntriesAsync(localEntries);
            var deletedSessions = LoadDeletedSessions();
            return mergedEntries
                .Where(item => !IsSessionDeleted(item, deletedSessions))
                .OrderByDescending(item => item.LastUpdatedAt)
                .Take(160)
                .Select(item => new WebSessionItem(item.DisplayName, item.ChannelType, item.ChatType, item.ChatId, item.SessionId, item.Source, item.LocalMessageCount, item.LastUpdatedAt?.ToString("yyyy-MM-dd HH:mm:ss") ?? "", item.Summary))
                .ToArray();
        }
        catch (Exception ex)
        {
            AddWebActivity("warning", "会话索引读取失败", ex.Message);
            return [];
        }
    }

    private async Task<object> DeleteSessionAsync(JsonElement payload)
    {
        var sessionId = ReadPayloadString(payload, "sessionId", "");
        var chatId = ReadPayloadString(payload, "chatId", "");
        if (string.IsNullOrWhiteSpace(sessionId) && string.IsNullOrWhiteSpace(chatId))
        {
            throw new InvalidOperationException("缺少要删除的会话 ID。");
        }

        var entries = await LoadRemoteConversationEntriesAsync(LoadConversationEntries());
        var entry = entries.FirstOrDefault(item =>
            (!string.IsNullOrWhiteSpace(sessionId) && string.Equals(item.SessionId, sessionId, StringComparison.OrdinalIgnoreCase))
            || (!string.IsNullOrWhiteSpace(chatId) && string.Equals(item.ChatId, chatId, StringComparison.OrdinalIgnoreCase)));

        var key = MakeDeletedSessionKey(chatId, sessionId);
        var deletedSessions = LoadDeletedSessions();
        deletedSessions[key] = new DeletedSessionRecord
        {
            ChatId = chatId,
            SessionId = sessionId,
            DisplayName = entry?.DisplayName ?? "",
            DeletedAt = DateTime.UtcNow.ToString("o"),
            LastSeenAt = (entry?.LastUpdatedAt ?? DateTime.MinValue).ToUniversalTime().ToString("o"),
        };
        SaveDeletedSessions(deletedSessions);

        if (!string.IsNullOrWhiteSpace(chatId))
        {
            _sessionDetailCache.Remove($"{chatId}::{sessionId}");
        }

        AddWebActivity("info", "会话已删除", entry?.DisplayName ?? chatId ?? sessionId);
        return "deleted";
    }

    private bool SelectMcpById(string id)
    {
        if (string.IsNullOrWhiteSpace(id)) return false;
        for (var i = 0; i < _mcpList.Items.Count; i++)
        {
            if (_mcpList.Items[i] is McpManifest manifest && string.Equals(manifest.Id, id, StringComparison.OrdinalIgnoreCase))
            {
                _mcpList.SelectedIndex = i;
                return true;
            }
        }
        return false;
    }

    private static string ReadPayloadString(JsonElement payload, string name, string fallback)
    {
        return payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? fallback
            : fallback;
    }

    private SettingsSnapshot ReadSettingsPayload(JsonElement payload)
    {
        if (payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("settings", out var settings))
        {
            payload = settings;
        }
        var current = GetSettingsSnapshot();
        return new SettingsSnapshot(
            ReadPayloadString(payload, "defaultWorkDir", current.DefaultWorkDir),
            ReadPayloadString(payload, "allowedRoots", current.AllowedRoots),
            ReadPayloadString(payload, "unityProject", current.UnityProject),
            ReadPayloadString(payload, "memoryRepo", current.MemoryRepo),
            ReadPayloadString(payload, "additionalDirs", current.AdditionalDirs),
            ReadPayloadString(payload, "replyStyleHint", current.ReplyStyleHint));
    }

    private async Task<WebSessionDetail> GetSessionDetailAsync(JsonElement payload)
    {
        var requestCount = Interlocked.Increment(ref _webSessionDetailRequestCount);
        var sessionId = ReadPayloadString(payload, "sessionId", "");
        var chatId = ReadPayloadString(payload, "chatId", "");
        var forceRefresh = payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty("force", out var forceElement)
            && forceElement.ValueKind is JsonValueKind.True;
        var cacheKey = $"{chatId}::{sessionId}";
        if (!forceRefresh && _sessionDetailCache.TryGetValue(cacheKey, out var cached))
        {
            AppendWebDiagnostics($"session detail cache-hit count={requestCount} key={cacheKey}");
            return cached;
        }
        AppendWebDiagnostics($"session detail load count={requestCount} key={cacheKey}");
        var entries = await LoadRemoteConversationEntriesAsync(LoadConversationEntries());
        var entry = entries.FirstOrDefault(item =>
            (!string.IsNullOrWhiteSpace(sessionId) && string.Equals(item.SessionId, sessionId, StringComparison.OrdinalIgnoreCase))
            || (!string.IsNullOrWhiteSpace(chatId) && string.Equals(item.ChatId, chatId, StringComparison.OrdinalIgnoreCase)));

        if (entry is null)
        {
            throw new InvalidOperationException("未找到对应会话。");
        }

        if (!entry.RemoteLoaded)
        {
            entry = await LoadConversationDetailAsync(entry);
        }

        var detail = new WebSessionDetail(
            entry.DisplayName,
            entry.ChannelType,
            entry.ChatType,
            entry.ChatId,
            entry.SessionId,
            entry.SdkSessionId,
            entry.WorkingDirectory,
            entry.Source,
            entry.HasLocalBinding,
            entry.LocalMessageCount,
            entry.LastUpdatedAt?.ToString("yyyy-MM-dd HH:mm:ss") ?? "",
            entry.Summary,
            entry.Messages.Select(message => new WebConversationMessage(
                message.Index,
                message.MessageId,
                message.Role,
                message.MsgType,
                message.SenderId,
                message.SenderType,
                message.SenderName,
                message.CreatedAt?.ToString("yyyy-MM-dd HH:mm:ss") ?? "",
                message.Content,
                message.Attachments.Select(attachment => new WebMessageAttachment(
                    attachment.Kind,
                    attachment.Name,
                    attachment.MimeType,
                    attachment.Size,
                    attachment.Path,
                    attachment.Url,
                    attachment.ResourceKey,
                    attachment.Status)).ToArray())).ToArray(),
            BuildFeishuPeople(entry.Messages),
            FindWorkflowRunsForSession(entry.SessionId, entry.ChatId));
        _sessionDetailCache[cacheKey] = detail;
        if (_sessionDetailCache.Count > 64)
        {
            var firstKey = _sessionDetailCache.Keys.FirstOrDefault();
            if (!string.IsNullOrWhiteSpace(firstKey))
            {
                _sessionDetailCache.Remove(firstKey);
            }
        }
        return detail;
    }

    private async Task<object> AddFeishuOwnerAsync(JsonElement payload)
    {
        var userId = ReadPayloadString(payload, "userId", "").Trim();
        var displayName = ReadPayloadString(payload, "displayName", "").Trim();
        if (string.IsNullOrWhiteSpace(userId))
        {
            throw new InvalidOperationException("缺少 Feishu 用户 ID。");
        }

        var snapshot = UpsertPermission("feishu", userId, displayName, "owner", "session-detail");
        await RestartBridgeAsync();
        var label = string.IsNullOrWhiteSpace(displayName) ? userId : $"{displayName} ({userId})";
        AddWebActivity("info", "Owner 已添加", $"{label}；桥接已重启。");
        return new
        {
            userId,
            displayName,
            ownerUserIds = snapshot.Subjects.Where(item => item.ChannelType == "feishu" && item.Role == "owner").Select(item => item.UserId).ToArray(),
            message = "已加入 owner 列表并重启桥接。",
        };
    }

    private WebFeishuPerson[] BuildFeishuPeople(IEnumerable<ConversationMessageView> messages)
    {
        var permissions = LoadPermissionSnapshot(syncFromConfig: true).Subjects
            .Where(item => string.Equals(item.ChannelType, "feishu", StringComparison.OrdinalIgnoreCase))
            .ToDictionary(item => item.UserId, item => item, StringComparer.OrdinalIgnoreCase);
        return messages
            .Where(message => !string.IsNullOrWhiteSpace(message.SenderId))
            .GroupBy(message => message.SenderId, StringComparer.OrdinalIgnoreCase)
            .Select(group =>
            {
                var latest = group.Last();
                var displayName = group
                    .Select(message => message.SenderName)
                    .FirstOrDefault(name => !string.IsNullOrWhiteSpace(name)) ?? "";
                return new WebFeishuPerson(
                    group.Key,
                    latest.SenderType,
                    displayName,
                    permissions.TryGetValue(group.Key, out var subject) ? subject.Role : "",
                    permissions.TryGetValue(group.Key, out subject) && string.Equals(subject.Role, "owner", StringComparison.OrdinalIgnoreCase),
                    group.Count());
            })
            .OrderBy(person => string.Equals(person.SenderType, "app", StringComparison.OrdinalIgnoreCase) ? 1 : 0)
            .ThenBy(person => string.IsNullOrWhiteSpace(person.DisplayName) ? person.UserId : person.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private PermissionSnapshot LoadPermissionSnapshot(bool syncFromConfig)
    {
        var snapshot = ReadPermissionSnapshotFile();
        if (syncFromConfig)
        {
            snapshot = MergeConfigPermissions(snapshot);
            SavePermissionSnapshot(snapshot);
            SyncPermissionSnapshotToConfig(snapshot);
        }
        return snapshot;
    }

    private PermissionSnapshot ReadPermissionSnapshotFile()
    {
        try
        {
            if (File.Exists(_permissionsPath))
            {
                var loaded = JsonSerializer.Deserialize<PermissionSnapshot>(File.ReadAllText(_permissionsPath, Encoding.UTF8), JsonOptions);
                if (loaded is not null)
                {
                    loaded.Subjects = NormalizePermissionSubjects(loaded.Subjects);
                    loaded.Candidates = BuildPermissionCandidates(loaded.Subjects);
                    loaded.UpdatedAt = string.IsNullOrWhiteSpace(loaded.UpdatedAt) ? DateTime.UtcNow.ToString("o") : loaded.UpdatedAt;
                    return loaded;
                }
            }
        }
        catch
        {
            // fall through to a clean snapshot
        }

        return new PermissionSnapshot
        {
            Protocol = "cti-permissions/v1",
            UpdatedAt = DateTime.UtcNow.ToString("o"),
            Subjects = [],
            Candidates = [],
        };
    }

    private PermissionSnapshot MergeConfigPermissions(PermissionSnapshot snapshot)
    {
        var subjects = NormalizePermissionSubjects(snapshot.Subjects)
            .ToDictionary(item => MakePermissionKey(item.ChannelType, item.UserId), item => item, StringComparer.OrdinalIgnoreCase);

        foreach (var (channel, allowedKey, ownerKey) in PermissionEnvKeys)
        {
            foreach (var id in SplitConfigList(GetConfig(allowedKey, "")))
            {
                MergePermission(subjects, channel, id, "", "viewer", "config");
            }
            foreach (var id in SplitConfigList(GetConfig(ownerKey, "")))
            {
                MergePermission(subjects, channel, id, "", "owner", "config");
            }
        }

        var merged = subjects.Values
            .OrderBy(item => ChannelSortRank(item.ChannelType))
            .ThenByDescending(item => RoleRank(item.Role))
            .ThenBy(item => string.IsNullOrWhiteSpace(item.DisplayName) ? item.UserId : item.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return new PermissionSnapshot
        {
            Protocol = "cti-permissions/v1",
            UpdatedAt = DateTime.UtcNow.ToString("o"),
            Subjects = merged,
            Candidates = BuildPermissionCandidates(merged),
        };
    }

    private static void MergePermission(Dictionary<string, PermissionSubject> subjects, string channelType, string userId, string displayName, string role, string source)
    {
        channelType = NormalizePermissionChannel(channelType);
        userId = userId.Trim();
        if (string.IsNullOrWhiteSpace(channelType) || string.IsNullOrWhiteSpace(userId)) return;

        var key = MakePermissionKey(channelType, userId);
        var nextRole = NormalizePermissionRole(role);
        if (subjects.TryGetValue(key, out var existing))
        {
            if (RoleRank(nextRole) > RoleRank(existing.Role)) existing.Role = nextRole;
            if (string.IsNullOrWhiteSpace(existing.DisplayName) && !string.IsNullOrWhiteSpace(displayName)) existing.DisplayName = displayName.Trim();
            existing.Source = string.IsNullOrWhiteSpace(existing.Source) ? source : existing.Source;
            existing.UpdatedAt = DateTime.UtcNow.ToString("o");
            return;
        }

        var now = DateTime.UtcNow.ToString("o");
        subjects[key] = new PermissionSubject
        {
            ChannelType = channelType,
            UserId = userId,
            DisplayName = displayName.Trim(),
            Role = nextRole,
            Source = source,
            FirstSeenAt = now,
            LastSeenAt = now,
            UpdatedAt = now,
        };
    }

    private PermissionSnapshot UpsertPermissionSubject(JsonElement payload)
    {
        var channelType = ReadPayloadString(payload, "channelType", "feishu");
        var userId = ReadPayloadString(payload, "userId", "");
        var displayName = ReadPayloadString(payload, "displayName", "");
        var role = ReadPayloadString(payload, "role", "viewer");
        return UpsertPermission(channelType, userId, displayName, role, "panel");
    }

    private PermissionSnapshot UpsertPermission(string channelType, string userId, string displayName, string role, string source)
    {
        channelType = NormalizePermissionChannel(channelType);
        userId = userId.Trim();
        if (string.IsNullOrWhiteSpace(channelType) || string.IsNullOrWhiteSpace(userId))
        {
            throw new InvalidOperationException("缺少渠道或用户 ID。");
        }

        var snapshot = LoadPermissionSnapshot(syncFromConfig: true);
        var subjects = snapshot.Subjects.ToDictionary(item => MakePermissionKey(item.ChannelType, item.UserId), item => item, StringComparer.OrdinalIgnoreCase);
        var key = MakePermissionKey(channelType, userId);
        var now = DateTime.UtcNow.ToString("o");
        if (subjects.TryGetValue(key, out var existing))
        {
            existing.Role = NormalizePermissionRole(role);
            if (!string.IsNullOrWhiteSpace(displayName)) existing.DisplayName = displayName.Trim();
            existing.Source = source;
            existing.LastSeenAt = now;
            existing.UpdatedAt = now;
        }
        else
        {
            subjects[key] = new PermissionSubject
            {
                ChannelType = channelType,
                UserId = userId,
                DisplayName = displayName.Trim(),
                Role = NormalizePermissionRole(role),
                Source = source,
                FirstSeenAt = now,
                LastSeenAt = now,
                UpdatedAt = now,
            };
        }
        snapshot.Subjects = NormalizePermissionSubjects(subjects.Values);
        snapshot.Candidates = BuildPermissionCandidates(snapshot.Subjects);
        snapshot.UpdatedAt = DateTime.UtcNow.ToString("o");
        SavePermissionSnapshot(snapshot);
        SyncPermissionSnapshotToConfig(snapshot);
        _sessionDetailCache.Clear();
        AddWebActivity("info", "权限已保存", $"{channelType}:{userId} -> {NormalizePermissionRole(role)}");
        return snapshot;
    }

    private PermissionSnapshot RemovePermissionSubject(JsonElement payload)
    {
        var channelType = NormalizePermissionChannel(ReadPayloadString(payload, "channelType", ""));
        var userId = ReadPayloadString(payload, "userId", "").Trim();
        if (string.IsNullOrWhiteSpace(channelType) || string.IsNullOrWhiteSpace(userId))
        {
            throw new InvalidOperationException("缺少渠道或用户 ID。");
        }

        var snapshot = LoadPermissionSnapshot(syncFromConfig: true);
        snapshot.Subjects = snapshot.Subjects
            .Where(item => !string.Equals(MakePermissionKey(item.ChannelType, item.UserId), MakePermissionKey(channelType, userId), StringComparison.OrdinalIgnoreCase))
            .ToList();
        snapshot.Candidates = BuildPermissionCandidates(snapshot.Subjects);
        snapshot.UpdatedAt = DateTime.UtcNow.ToString("o");
        SavePermissionSnapshot(snapshot);
        SyncPermissionSnapshotToConfig(snapshot);
        _sessionDetailCache.Clear();
        AddWebActivity("info", "权限已移除", $"{channelType}:{userId}");
        return snapshot;
    }

    private void SavePermissionSnapshot(PermissionSnapshot snapshot)
    {
        snapshot.Protocol = "cti-permissions/v1";
        snapshot.Subjects = NormalizePermissionSubjects(snapshot.Subjects);
        snapshot.Candidates = BuildPermissionCandidates(snapshot.Subjects);
        snapshot.UpdatedAt = DateTime.UtcNow.ToString("o");
        Directory.CreateDirectory(Path.GetDirectoryName(_permissionsPath)!);
        File.WriteAllText(_permissionsPath, JsonSerializer.Serialize(snapshot, JsonOptions), new UTF8Encoding(false));
    }

    private void SyncPermissionSnapshotToConfig(PermissionSnapshot snapshot)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_configPath)!);
        var lines = File.Exists(_configPath) ? File.ReadAllLines(_configPath, Encoding.UTF8).ToList() : [];
        foreach (var (channel, allowedKey, ownerKey) in PermissionEnvKeys)
        {
            var subjects = snapshot.Subjects
                .Where(item => string.Equals(item.ChannelType, channel, StringComparison.OrdinalIgnoreCase))
                .ToList();
            SetOrAppendEnv(lines, allowedKey, string.Join(",", subjects.Select(item => item.UserId).Distinct(StringComparer.OrdinalIgnoreCase)));
            SetOrAppendEnv(lines, ownerKey, string.Join(",", subjects.Where(item => string.Equals(item.Role, "owner", StringComparison.OrdinalIgnoreCase)).Select(item => item.UserId).Distinct(StringComparer.OrdinalIgnoreCase)));
        }
        File.WriteAllLines(_configPath, lines, new UTF8Encoding(false));
        LoadConfig();
    }

    private List<PermissionCandidate> BuildPermissionCandidates(IReadOnlyCollection<PermissionSubject> subjects)
    {
        var granted = subjects
            .Select(item => MakePermissionKey(item.ChannelType, item.UserId))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var candidates = new Dictionary<string, PermissionCandidate>(StringComparer.OrdinalIgnoreCase);

        foreach (var file in Directory.Exists(_feishuHistoryDir) ? Directory.GetFiles(_feishuHistoryDir, "*.json") : [])
        {
            foreach (var message in LoadIndexedFeishuHistoryRaw(Path.GetFileNameWithoutExtension(file)))
            {
                if (string.IsNullOrWhiteSpace(message.SenderId)) continue;
                var key = MakePermissionKey("feishu", message.SenderId);
                if (granted.Contains(key)) continue;
                if (!candidates.TryGetValue(key, out var candidate))
                {
                    candidate = new PermissionCandidate
                    {
                        ChannelType = "feishu",
                        UserId = message.SenderId,
                        DisplayName = message.SenderName ?? "",
                        Source = "history",
                        MessageCount = 0,
                    };
                    candidates[key] = candidate;
                }
                if (string.IsNullOrWhiteSpace(candidate.DisplayName) && !string.IsNullOrWhiteSpace(message.SenderName))
                {
                    candidate.DisplayName = message.SenderName;
                }
                candidate.MessageCount += 1;
            }
        }

        return candidates.Values
            .OrderBy(item => ChannelSortRank(item.ChannelType))
            .ThenBy(item => string.IsNullOrWhiteSpace(item.DisplayName) ? item.UserId : item.DisplayName, StringComparer.OrdinalIgnoreCase)
            .Take(200)
            .ToList();
    }

    private object ListWorkflowRuns()
    {
        var root = ReadJsonObjectFile(_workflowStatusPath);
        var runs = root?["runs"] as JsonArray ?? [];
        return new
        {
            protocol = ReadJsonString(root, "protocol", "workflow-runtime/v1"),
            updatedAt = ReadJsonString(root, "updatedAt", ""),
            runs = runs.Select(node => node?.DeepClone()).Where(node => node is not null).TakeLast(80).ToArray(),
        };
    }

    private object GetWorkflowRun(JsonElement payload)
    {
        var runId = ReadPayloadString(payload, "id", ReadPayloadString(payload, "runId", ""));
        if (string.IsNullOrWhiteSpace(runId)) return new { found = false, run = (object?)null };
        var run = FindWorkflowRun(runId);
        return new { found = run is not null, run };
    }

    private object GetWorkflowEvents(JsonElement payload)
    {
        var runId = ReadPayloadString(payload, "id", ReadPayloadString(payload, "runId", ""));
        var run = FindWorkflowRun(runId) as JsonObject;
        var events = run?["events"] as JsonArray ?? [];
        return new
        {
            runId,
            events = events.Select(node => node?.DeepClone()).Where(node => node is not null).ToArray(),
        };
    }

    private JsonNode[] FindWorkflowRunsForSession(string sessionId, string chatId)
    {
        var root = ReadJsonObjectFile(_workflowStatusPath);
        var runs = root?["runs"] as JsonArray;
        if (runs is null) return [];
        return runs
            .OfType<JsonObject>()
            .Where(run =>
                (!string.IsNullOrWhiteSpace(sessionId) && string.Equals(ReadJsonString(run, "sessionId", ""), sessionId, StringComparison.OrdinalIgnoreCase))
                || (!string.IsNullOrWhiteSpace(chatId) && string.Equals(ReadJsonString(run, "chatId", ""), chatId, StringComparison.OrdinalIgnoreCase)))
            .Select(run => run.DeepClone())
            .TakeLast(30)
            .ToArray();
    }

    private JsonNode? FindWorkflowRun(string runId)
    {
        var root = ReadJsonObjectFile(_workflowStatusPath);
        var runs = root?["runs"] as JsonArray;
        if (runs is null) return null;
        foreach (var run in runs)
        {
            if (run is not JsonObject obj) continue;
            if (string.Equals(ReadJsonString(obj, "id", ""), runId, StringComparison.OrdinalIgnoreCase))
            {
                return obj.DeepClone();
            }
        }
        return null;
    }

    private object ReadExecutorStatusPayload()
    {
        var root = ReadJsonObjectFile(_executorStatusPath);
        var defaults = ReadJsonObjectFile(_executorSessionDefaultsPath) ?? new JsonObject();
        if (root is null)
        {
            return new
            {
                protocol = "executor-runtime/v1",
                updatedAt = "",
                executors = Array.Empty<object>(),
                sessionDefaults = defaults,
                lastSelection = (object?)null,
            };
        }
        root["sessionDefaults"] = defaults.DeepClone();
        return root;
    }

    private object SetExecutorSessionDefault(JsonElement payload)
    {
        var sessionId = ReadPayloadString(payload, "sessionId", "");
        var executorId = ReadPayloadString(payload, "executorId", "");
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            throw new InvalidOperationException("sessionId 不能为空");
        }
        var defaults = ReadJsonObjectFile(_executorSessionDefaultsPath) ?? new JsonObject();
        if (string.IsNullOrWhiteSpace(executorId))
        {
            defaults.Remove(sessionId);
        }
        else
        {
            defaults[sessionId] = executorId;
        }
        Directory.CreateDirectory(Path.GetDirectoryName(_executorSessionDefaultsPath)!);
        var tmp = _executorSessionDefaultsPath + ".tmp";
        File.WriteAllText(tmp, defaults.ToJsonString(WebJsonOptions), Encoding.UTF8);
        File.Move(tmp, _executorSessionDefaultsPath, overwrite: true);
        return new { ok = true, sessionId, executorId, sessionDefaults = defaults };
    }

    private static JsonObject? ReadJsonObjectFile(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            return JsonNode.Parse(File.ReadAllText(path, Encoding.UTF8)) as JsonObject;
        }
        catch
        {
            return null;
        }
    }

    private static string ReadJsonString(JsonObject? root, string name, string fallback)
    {
        if (root is null || !root.TryGetPropertyValue(name, out var node)) return fallback;
        return node?.GetValue<string>() ?? fallback;
    }

    private void AppendWebDiagnostics(string message)
    {
        try
        {
            var directory = Path.GetDirectoryName(_webDiagnosticsLogPath);
            if (!string.IsNullOrWhiteSpace(directory))
            {
                Directory.CreateDirectory(directory);
            }

            File.AppendAllText(
                _webDiagnosticsLogPath,
                $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {message}{Environment.NewLine}",
                Encoding.UTF8);
        }
        catch
        {
        }
    }

    private Dictionary<string, DeletedSessionRecord> LoadDeletedSessions()
        => File.Exists(_deletedSessionsPath)
            ? JsonSerializer.Deserialize<Dictionary<string, DeletedSessionRecord>>(File.ReadAllText(_deletedSessionsPath, Encoding.UTF8), JsonOptions) ?? new Dictionary<string, DeletedSessionRecord>(StringComparer.OrdinalIgnoreCase)
            : new Dictionary<string, DeletedSessionRecord>(StringComparer.OrdinalIgnoreCase);

    private void SaveDeletedSessions(Dictionary<string, DeletedSessionRecord> deletedSessions)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_deletedSessionsPath)!);
        File.WriteAllText(_deletedSessionsPath, JsonSerializer.Serialize(deletedSessions, JsonOptions), new UTF8Encoding(false));
    }

    private static string MakeDeletedSessionKey(string chatId, string sessionId)
        => !string.IsNullOrWhiteSpace(chatId)
            ? $"chat:{chatId.Trim()}"
            : $"session:{sessionId.Trim()}";

    private static bool IsSessionDeleted(ConversationEntry entry, IReadOnlyDictionary<string, DeletedSessionRecord> deletedSessions)
    {
        var keys = new[]
        {
            MakeDeletedSessionKey(entry.ChatId ?? "", entry.SessionId ?? ""),
            string.IsNullOrWhiteSpace(entry.SessionId) ? "" : MakeDeletedSessionKey("", entry.SessionId),
        };

        foreach (var key in keys.Where(key => !string.IsNullOrWhiteSpace(key)))
        {
            if (!deletedSessions.TryGetValue(key, out var deleted))
            {
                continue;
            }

            var lastSeenAt = ParseDateTime(deleted.LastSeenAt) ?? DateTime.MinValue;
            var entryUpdatedAt = entry.LastUpdatedAt ?? DateTime.MinValue;
            if (entryUpdatedAt.ToUniversalTime() <= lastSeenAt.ToUniversalTime())
            {
                return true;
            }
        }

        return false;
    }

    private static string PickFolder(string currentPath)
    {
        using var dialog = new FolderBrowserDialog
        {
            SelectedPath = Directory.Exists(currentPath) ? currentPath : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        };
        return dialog.ShowDialog() == DialogResult.OK ? dialog.SelectedPath : currentPath;
    }

    private static string PickFile(string currentPath)
    {
        using var dialog = new OpenFileDialog
        {
            CheckFileExists = true,
            FileName = File.Exists(currentPath) ? currentPath : "",
            InitialDirectory = Directory.Exists(Path.GetDirectoryName(currentPath) ?? "")
                ? Path.GetDirectoryName(currentPath)
                : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        };
        return dialog.ShowDialog() == DialogResult.OK ? dialog.FileName : currentPath;
    }

    private WebReplyPresetItem[] BuildReplyPresetItems()
        => ReplyStylePresets.Select(pair => new WebReplyPresetItem(pair.Key, pair.Value)).ToArray();

    private object ApplyReplyPreset(string name)
    {
        if (string.IsNullOrWhiteSpace(name) || !ReplyStylePresets.TryGetValue(name, out var value))
        {
            throw new InvalidOperationException("未找到对应的回复风格预设。");
        }

        var current = GetSettingsSnapshot();
        SaveSettingsFromDialog(current with { ReplyStyleHint = value });
        return new { name, value, settings = GetSettingsSnapshot() };
    }

    private WebRuntimeUnit[] BuildRuntimeUnits()
    {
        var units = new List<WebRuntimeUnit>
        {
            new(
                "service.bridge",
                "bridge",
                "飞书桥接",
                "service",
                "bridge",
                ClassifyStatus("bridge", _bridgeStatus.Text),
                _bridgeStatus.Text,
                true,
                "installed",
                _skillDir,
                _skillDir,
                "",
                "负责 Feishu / Codex / 本地执行链路的主桥接服务。",
                false,
                new[]
                {
                    new WebRuntimeAction("status", "状态", true),
                    new WebRuntimeAction("logs", "日志", true),
                    new WebRuntimeAction("start", "启动", true),
                    new WebRuntimeAction("stop", "停止", true),
                    new WebRuntimeAction("restart", "重启", true),
                    new WebRuntimeAction("openLocation", "打开位置", true),
                }),
            new(
                "service.codex",
                "codex",
                "Codex CLI",
                "tool",
                "codex",
                ClassifyStatus("codex", _codexStatus.Text),
                _codexStatus.Text,
                true,
                "installed",
                _skillDir,
                _skillDir,
                "",
                "Codex CLI 工具型服务，默认提供检查与工作目录入口，不伪造常驻 daemon 开关。",
                false,
                new[]
                {
                    new WebRuntimeAction("check", "检查", true),
                    new WebRuntimeAction("update", "更新", CodexSupportsNpmUpdate()),
                    new WebRuntimeAction("openLocation", "打开位置", true),
                }),
            new(
                "service.localLlm",
                "localLlm",
                "本地辅助执行器",
                "service",
                "local-llm",
                ClassifyStatus("localLlm", _localLlmStatus.Text),
                _localLlmStatus.Text,
                true,
                File.Exists(_localLlmStartScript) ? "installed" : "missing",
                _localLlmReadmePath,
                Path.GetDirectoryName(_localLlmStartScript) ?? "",
                "",
                "仅用于明确小活和 Codex 不可用时的兜底辅助执行。",
                false,
                new[]
                {
                    new WebRuntimeAction("check", "检查", true),
                    new WebRuntimeAction("start", "启动", File.Exists(_localLlmStartScript)),
                    new WebRuntimeAction("stop", "停止", File.Exists(_localLlmStopScript)),
                    new WebRuntimeAction("openLocation", "打开位置", true),
                }),
        };

        foreach (var manifest in _manifests)
        {
            var hasLauncher = !string.IsNullOrWhiteSpace(ResolveManifestPath(manifest.Launcher, manifest)) && File.Exists(ResolveManifestPath(manifest.Launcher, manifest));
            var canInstall = ManifestSupportsInstall(manifest.ManifestPath);
            units.Add(new WebRuntimeUnit(
                $"mcp.{manifest.Id}",
                manifest.Id ?? "",
                manifest.DisplayName ?? manifest.Id ?? "",
                "mcp",
                manifest.Category ?? manifest.Type ?? "",
                ClassifyMcpRuntimeStatus(manifest),
                manifest.HealthSummary ?? manifest.StatusBadge ?? "",
                manifest.Enabled != false,
                manifest.InstallState ?? "",
                FormatManifestSource(manifest.Source, manifest),
                ResolveManifestDirectory(manifest.Cwd, manifest),
                manifest.Version ?? "",
                manifest.Description ?? "",
                canInstall,
                new[]
                {
                    new WebRuntimeAction("check", "检查", true),
                    new WebRuntimeAction("start", "启动", manifest.Enabled != false && hasLauncher),
                    new WebRuntimeAction("stop", "停止", manifest.Enabled != false),
                    new WebRuntimeAction("install", "安装", canInstall),
                    new WebRuntimeAction("register", "注册", true),
                    new WebRuntimeAction("openLocation", "打开位置", true),
                }));
        }

        foreach (var item in BuildExtensionItems())
        {
            units.Add(new WebRuntimeUnit(
                $"extension.{item.ManifestPath}",
                item.Id,
                string.IsNullOrWhiteSpace(item.DisplayName) ? item.Id : item.DisplayName,
                item.ManifestKind,
                item.Category,
                !item.SourceExists ? "error" : item.Enabled ? "ok" : "warning",
                item.Description,
                item.Enabled,
                item.InstallState,
                item.Source,
                item.ManifestPath,
                "",
                item.Description,
                item.CanInstall,
                new[]
                {
                    new WebRuntimeAction("enable", "启用", !item.Enabled),
                    new WebRuntimeAction("disable", "禁用", item.Enabled),
                    new WebRuntimeAction("install", "安装", item.CanInstall),
                    new WebRuntimeAction("remove", "删除", true),
                    new WebRuntimeAction("openManifest", "Manifest", true),
                    new WebRuntimeAction("openSource", "Source", item.SourceExists),
                }));
        }

        return units.ToArray();
    }

    private static string ClassifyMcpRuntimeStatus(McpManifest manifest)
    {
        if (manifest.Enabled == false) return "idle";
        if (manifest.HealthOk == false) return "error";
        if (manifest.HealthOk == true || manifest.IsRunning || manifest.IsRegistered) return "ok";
        return "warning";
    }

    private object DetectExtensionImport(string folderPath)
    {
        if (string.IsNullOrWhiteSpace(folderPath) || !Directory.Exists(folderPath))
        {
            throw new InvalidOperationException("未找到要导入的目录。");
        }

        var detection = BuildExtensionImportPreview(folderPath, "", "");
        return new
        {
            folderPath = detection.FolderPath,
            detectedKind = detection.Kind,
            runtimeType = detection.RuntimeType,
            id = detection.Id,
            displayName = detection.DisplayName,
            source = detection.Source,
            manifestPath = detection.ManifestPath,
            description = detection.Description,
            installState = detection.InstallState,
            suggestedKinds = new[] { "skill", "mcp" },
            canImport = detection.CanImport,
            reason = detection.Reason,
        };
    }

    private async Task<object> ImportExtensionFromFolderAsync(string folderPath, string kind, string runtimeType)
    {
        var preview = BuildExtensionImportPreview(folderPath, kind, runtimeType);
        if (!preview.CanImport)
        {
            throw new InvalidOperationException(preview.Reason);
        }

        Directory.CreateDirectory(Path.GetDirectoryName(preview.ManifestPath)!);
        var root = new JsonObject
        {
            ["id"] = preview.Id,
            ["displayName"] = preview.DisplayName,
            ["type"] = preview.Kind == "skill" ? "skill" : preview.RuntimeType,
            ["version"] = "1.0.0",
            ["compatibility"] = new JsonObject
            {
                ["protocol"] = "extension-manifest/v1",
                ["suite"] = ">=0.2.0 <1.0.0",
            },
            ["category"] = preview.Kind == "skill" ? "skill.imported" : "mcp.imported",
            ["optional"] = true,
            ["installState"] = preview.InstallState,
            ["installer"] = "..\\..\\scripts\\install-suite-extension.ps1",
            ["source"] = preview.Source,
            ["enabled"] = true,
            ["description"] = preview.Description,
        };

        if (preview.Kind == "mcp")
        {
            root["aliases"] = new JsonArray(preview.Id, preview.DisplayName.ToLowerInvariant());
        }

        SaveManifestNode(preview.ManifestPath, root);
        LoadManifests();
        await UpdateMcpManifestStatesAsync();
        AddWebActivity("info", "扩展已导入", $"{preview.DisplayName} -> {preview.ManifestPath}");
        return new
        {
            manifestPath = preview.ManifestPath,
            id = preview.Id,
            displayName = preview.DisplayName,
            kind = preview.Kind,
        };
    }

    private ExtensionImportPreview BuildExtensionImportPreview(string folderPath, string explicitKind, string explicitRuntimeType)
    {
        if (string.IsNullOrWhiteSpace(folderPath) || !Directory.Exists(folderPath))
        {
            throw new InvalidOperationException("未找到要导入的目录。");
        }

        var skillFile = Path.Combine(folderPath, "SKILL.md");
        var packageJsonPath = Path.Combine(folderPath, "package.json");
        var packageJson = File.Exists(packageJsonPath) ? JsonNode.Parse(File.ReadAllText(packageJsonPath, Encoding.UTF8)) as JsonObject : null;
        var packageName = packageJson?["name"]?.GetValue<string?>() ?? "";
        var packageDescription = packageJson?["description"]?.GetValue<string?>() ?? "";
        var rawName = !string.IsNullOrWhiteSpace(packageName) ? packageName : Path.GetFileName(folderPath);

        var detectedKind = !string.IsNullOrWhiteSpace(explicitKind)
            ? explicitKind.Trim().ToLowerInvariant()
            : File.Exists(skillFile)
                ? "skill"
                : Regex.IsMatch($"{rawName} {packageDescription}", @"\bmcp\b", RegexOptions.IgnoreCase)
                    ? "mcp"
                    : "";

        var canImport = detectedKind is "skill" or "mcp";
        var reason = canImport
            ? ""
            : "未识别为 skill 或 mcp。当前规则是：目录下有 SKILL.md 视为 skill；目录名或 package.json 名称/描述命中 mcp 视为 mcp。";
        var normalizedId = NormalizeImportedExtensionId(rawName, folderPath, detectedKind);
        var displayName = BuildImportedDisplayName(rawName, folderPath);
        var source = ToManifestSourcePath(folderPath);
        var manifestDirectory = detectedKind == "skill" ? _skillsManifestDir : _manifestDir;
        var manifestPath = Path.Combine(manifestDirectory, $"{normalizedId}.json");
        var runtimeType = detectedKind == "mcp"
            ? (string.IsNullOrWhiteSpace(explicitRuntimeType) ? "stdio" : explicitRuntimeType.Trim().ToLowerInvariant())
            : "skill";
        var installState = source.StartsWith("${SUITE_ROOT}", StringComparison.OrdinalIgnoreCase) ? "bundled" : "external";
        var description = !string.IsNullOrWhiteSpace(packageDescription)
            ? packageDescription
            : detectedKind == "skill"
                ? "Imported local skill."
                : "Imported local MCP.";

        return new ExtensionImportPreview(folderPath, detectedKind, runtimeType, normalizedId, displayName, source, manifestPath, description, installState, canImport, reason);
    }

    private string ToManifestSourcePath(string path)
    {
        var fullPath = Path.GetFullPath(path);
        if (!string.IsNullOrWhiteSpace(_suiteRoot))
        {
            var suiteRoot = Path.GetFullPath(_suiteRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (fullPath.StartsWith(suiteRoot, StringComparison.OrdinalIgnoreCase))
            {
                var relative = Path.GetRelativePath(suiteRoot, fullPath);
                return "${SUITE_ROOT}\\" + relative.Replace('/', '\\');
            }
        }
        return fullPath;
    }

    private static string NormalizeImportedExtensionId(string rawName, string folderPath, string kind)
    {
        var seed = string.IsNullOrWhiteSpace(rawName) ? Path.GetFileName(folderPath) : rawName;
        seed = seed.Replace("@", "").Replace("/", "-").Replace("\\", "-");
        var normalized = Regex.Replace(seed.ToLowerInvariant(), @"[^a-z0-9._-]+", "-").Trim('-');
        if (string.IsNullOrWhiteSpace(normalized))
        {
            normalized = $"{kind}-{Guid.NewGuid():N}"[..12];
        }
        return normalized;
    }

    private static string BuildImportedDisplayName(string rawName, string folderPath)
    {
        if (!string.IsNullOrWhiteSpace(rawName))
        {
            return rawName.Trim();
        }
        return Path.GetFileName(folderPath);
    }

    private async Task<object?> InvokeRuntimeUnitActionAsync(JsonElement payload)
    {
        var unitId = ReadPayloadString(payload, "unitId", "");
        var action = ReadPayloadString(payload, "action", "");
        if (string.IsNullOrWhiteSpace(unitId) || string.IsNullOrWhiteSpace(action))
        {
            throw new InvalidOperationException("缺少运行单元或动作参数。");
        }

        if (string.Equals(unitId, "service.bridge", StringComparison.OrdinalIgnoreCase))
        {
            switch (action)
            {
                case "status":
                    await CheckBridgeAsync();
                    return _bridgeStatus.Text;
                case "logs":
                    await RunDaemonAsync("logs 120");
                    return _log.Text;
                case "start":
                    await RunDaemonAsync("start");
                    return _bridgeStatus.Text;
                case "stop":
                    await RunDaemonAsync("stop");
                    return _bridgeStatus.Text;
                case "restart":
                    await RestartBridgeAsync();
                    return _bridgeStatus.Text;
                case "openLocation":
                    OpenPath(_skillDir);
                    return "opened";
            }
        }

        if (string.Equals(unitId, "service.codex", StringComparison.OrdinalIgnoreCase))
        {
            switch (action)
            {
                case "check":
                    await CheckCodexAsync();
                    return _codexStatus.Text;
                case "update":
                    await UpdateCodexCliAsync();
                    return _codexStatus.Text;
                case "openLocation":
                    OpenPath(_skillDir);
                    return "opened";
            }
        }

        if (string.Equals(unitId, "service.localLlm", StringComparison.OrdinalIgnoreCase))
        {
            switch (action)
            {
                case "check":
                    await CheckLocalLlmAsync();
                    return _localLlmStatus.Text;
                case "start":
                    await StartLocalLlmAsync();
                    return _localLlmStatus.Text;
                case "stop":
                    await StopLocalLlmAsync();
                    return _localLlmStatus.Text;
                case "openLocation":
                    OpenPath(Path.GetDirectoryName(_localLlmStartScript) ?? "");
                    return "opened";
            }
        }

        if (unitId.StartsWith("mcp.", StringComparison.OrdinalIgnoreCase))
        {
            var id = unitId["mcp.".Length..];
            SelectMcpById(id);
            switch (action)
            {
                case "check":
                    await CheckSelectedMcpAsync();
                    return _mcpRuntimeStatus.Text;
                case "start":
                    await StartSelectedMcpAsync();
                    return _mcpRuntimeStatus.Text;
                case "stop":
                    await StopSelectedMcpAsync();
                    return _mcpRuntimeStatus.Text;
                case "register":
                    await RegisterAllMcpsAsync();
                    return _mcpStatus.Text;
                case "openLocation":
                    OpenSelectedMcpPath();
                    return "opened";
                case "install":
                    var selectedManifest = _manifests.FirstOrDefault(candidate => string.Equals(candidate.Id, id, StringComparison.OrdinalIgnoreCase));
                    if (selectedManifest is null || string.IsNullOrWhiteSpace(selectedManifest.ManifestPath))
                    {
                        throw new InvalidOperationException("当前未选中可安装的 MCP。");
                    }
                    await InstallExtensionAsync(selectedManifest.ManifestPath);
                    return "installed";
            }
        }

        if (unitId.StartsWith("extension.", StringComparison.OrdinalIgnoreCase))
        {
            var manifestPath = unitId["extension.".Length..];
            switch (action)
            {
                case "enable":
                    await SetExtensionEnabledAsync(manifestPath, true);
                    return "enabled";
                case "disable":
                    await SetExtensionEnabledAsync(manifestPath, false);
                    return "disabled";
                case "remove":
                    await RemoveExtensionAsync(manifestPath);
                    return "removed";
                case "install":
                    await InstallExtensionAsync(manifestPath);
                    return "installed";
                case "openManifest":
                    OpenPath(manifestPath);
                    return "opened";
                case "openSource":
                    var item = BuildExtensionItems().FirstOrDefault(candidate => string.Equals(candidate.ManifestPath, manifestPath, StringComparison.OrdinalIgnoreCase));
                    if (item is not null)
                    {
                        OpenPath(ExpandManifestValue(item.Source));
                    }
                    return "opened";
            }
        }

        throw new InvalidOperationException($"不支持的运行单元动作：{unitId} / {action}");
    }

    private async Task SetExtensionEnabledAsync(string manifestPath, bool enabled)
    {
        var root = LoadManifestNode(manifestPath);
        root["enabled"] = enabled;
        SaveManifestNode(manifestPath, root);
        LoadManifests();
        await UpdateMcpManifestStatesAsync();
    }

    private async Task RemoveExtensionAsync(string manifestPath)
    {
        if (string.IsNullOrWhiteSpace(manifestPath) || !File.Exists(manifestPath))
        {
            throw new InvalidOperationException("未找到 manifest 文件。");
        }

        File.Delete(manifestPath);
        LoadManifests();
        await UpdateMcpManifestStatesAsync();
    }

    private async Task InstallExtensionAsync(string manifestPath)
    {
        var root = LoadManifestNode(manifestPath);
        var installer = root["installer"]?.GetValue<string?>() ?? root["bootstrap"]?.GetValue<string?>();
        if (string.IsNullOrWhiteSpace(installer))
        {
            throw new InvalidOperationException("该扩展未声明 installer/bootstrap 元数据，当前不能自动安装。");
        }

        var resolved = ResolveManifestSiblingPath(manifestPath, installer);
        var environment = BuildExtensionInstallerEnvironment(manifestPath, root);
        ProcessResult result;
        if (resolved.EndsWith(".ps1", StringComparison.OrdinalIgnoreCase))
        {
            result = await RunProcessAsync("powershell.exe", $"-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"{resolved}\"", Path.GetDirectoryName(resolved)!, environment, 120000);
        }
        else if (resolved.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) || resolved.EndsWith(".bat", StringComparison.OrdinalIgnoreCase))
        {
            result = await RunProcessAsync("cmd.exe", $"/c \"{resolved}\"", Path.GetDirectoryName(resolved)!, environment, 120000);
        }
        else
        {
            result = await RunProcessAsync(resolved, "", Path.GetDirectoryName(resolved)!, environment, 120000);
        }

        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(result.Stderr) ? result.Stdout : result.Stderr);
        }

        LoadManifests();
        await UpdateMcpManifestStatesAsync();
    }

    private Dictionary<string, string?> BuildExtensionInstallerEnvironment(string manifestPath, JsonObject root)
        => new(StringComparer.OrdinalIgnoreCase)
        {
            ["CTI_EXTENSION_MANIFEST"] = manifestPath,
            ["CTI_EXTENSION_ID"] = root["id"]?.GetValue<string?>() ?? "",
            ["CTI_EXTENSION_TYPE"] = root["type"]?.GetValue<string?>() ?? "",
            ["CTI_EXTENSION_SOURCE"] = ExpandManifestValue(root["source"]?.GetValue<string?>() ?? ""),
            ["CTI_EXTENSION_DISPLAY_NAME"] = root["displayName"]?.GetValue<string?>() ?? "",
            ["CTI_SUITE_ROOT"] = _suiteRoot,
        };

    private bool ManifestSupportsInstall(string? manifestPath)
    {
        if (string.IsNullOrWhiteSpace(manifestPath) || !File.Exists(manifestPath)) return false;
        try
        {
            var root = LoadManifestNode(manifestPath);
            var installer = root["installer"]?.GetValue<string?>() ?? root["bootstrap"]?.GetValue<string?>();
            return !string.IsNullOrWhiteSpace(installer);
        }
        catch
        {
            return false;
        }
    }

    private JsonObject LoadManifestNode(string manifestPath)
    {
        if (string.IsNullOrWhiteSpace(manifestPath) || !File.Exists(manifestPath))
        {
            throw new InvalidOperationException("未找到 manifest 文件。");
        }

        var root = JsonNode.Parse(File.ReadAllText(manifestPath, Encoding.UTF8)) as JsonObject;
        if (root is null)
        {
            throw new InvalidOperationException("manifest 结构无效。");
        }

        return root;
    }

    private static void SaveManifestNode(string manifestPath, JsonObject root)
    {
        var json = root.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(manifestPath, json, new UTF8Encoding(false));
    }

    private static string ResolveManifestSiblingPath(string manifestPath, string value)
    {
        if (Path.IsPathRooted(value)) return value;
        var baseDir = Path.GetDirectoryName(manifestPath) ?? Environment.CurrentDirectory;
        return Path.GetFullPath(Path.Combine(baseDir, value));
    }

    private static string ReadJsonString(JsonElement root, string name)
        => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";

    private void PostWebMessage(object message)
    {
        if (!_webReady || _webView.CoreWebView2 is null) return;
        var json = JsonSerializer.Serialize(message, WebJsonOptions);
        if (InvokeRequired)
        {
            BeginInvoke(() => _webView.CoreWebView2.PostWebMessageAsJson(json));
            return;
        }
        _webView.CoreWebView2.PostWebMessageAsJson(json);
    }

    private void AddWebActivity(string level, string title, string message)
    {
        var record = new WebActivityRecord(level, title, MaskSecrets(message), DateTime.Now.ToString("HH:mm:ss"));
        _activities.Add(record);
        if (_activities.Count > 500) _activities.RemoveRange(0, _activities.Count - 500);
        PostWebMessage(new { type = "activity", level = record.Level, title = record.Title, message = record.Message, timestamp = record.Timestamp });
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
            CreateCardButton("更新", async () => await UpdateCodexCliAsync()),
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
        AddStatusCard(layout, "版本 / 扩展", _buildStatus, 4);
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
        AddToolAction(strip, "本机备份发布", async () => await PublishSuiteAsync());
        AddToolAction(strip, "主干发布预检", async () => await PrepareMainReleaseAsync());
        AddToolAction(strip, "设置", ShowSettingsDialog);
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
        var workspace = new SplitContainer
        {
            Dock = DockStyle.Fill,
            Orientation = Orientation.Horizontal,
            SplitterWidth = 8,
            FixedPanel = FixedPanel.None,
        };
        workspace.Panel1.Controls.Add(BuildMcpPanel());
        workspace.Panel2.Controls.Add(BuildLogPanel());
        return workspace;
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
        _memoryRepo.Text = ResolveEffectiveMemoryRepoPath(
            GetConfig("CTI_MEMORY_REPO_DIR", GetDefaultMemoryRepoPath()),
            GetConfig("CTI_DEFAULT_WORKDIR", @"C:\unity\ST3"),
            GetConfig("CTI_UNITY_PROJECT_PATH", @"C:\unity\ST3\Game"),
            appendLog: true);
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
            $"协议版本: {manifest.Compatibility?.Protocol ?? "-"}",
            $"扩展版本: {manifest.Version ?? "-"}",
            $"分类: {manifest.Category ?? "-"}",
            $"安装状态: {manifest.InstallState ?? "-"}",
            $"可选: {(manifest.Optional == true ? "是" : "否")}",
            $"启用: {manifest.Enabled != false}",
            $"Source: {FormatManifestSource(manifest.Source, manifest)}",
            $"Aliases: {string.Join(", ", manifest.Aliases ?? [])}",
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

    private SettingsSnapshot GetSettingsSnapshot() => new(
        GetConfig("CTI_DEFAULT_WORKDIR", @"C:\unity\ST3"),
        GetConfig("CTI_ALLOWED_WORKSPACE_ROOTS", @"C:\unity\ST3"),
        GetConfig("CTI_UNITY_PROJECT_PATH", @"C:\unity\ST3\Game"),
        ResolveEffectiveMemoryRepoPath(
            GetConfig("CTI_MEMORY_REPO_DIR", GetDefaultMemoryRepoPath()),
            GetConfig("CTI_DEFAULT_WORKDIR", @"C:\unity\ST3"),
            GetConfig("CTI_UNITY_PROJECT_PATH", @"C:\unity\ST3\Game")),
        GetConfig("CTI_CODEX_ADDITIONAL_DIRECTORIES", ""),
        GetConfig("CTI_REPLY_STYLE_HINT", "")
    );

    private void ShowSettingsDialog()
    {
        using var form = new SettingsForm(
            GetSettingsSnapshot(),
            ReplyStylePresets,
            SummarizeReplyStyleAsync,
            SaveSettingsFromDialog,
            OpenPath);
        form.ShowDialog(this);
    }

    private void SaveSettingsFromDialog(SettingsSnapshot settings)
    {
        var memoryRepo = ResolveEffectiveMemoryRepoPath(settings.MemoryRepo.Trim(), settings.DefaultWorkDir.Trim(), settings.UnityProject.Trim());
        Directory.CreateDirectory(Path.GetDirectoryName(_configPath)!);
        var lines = File.Exists(_configPath) ? File.ReadAllLines(_configPath, Encoding.UTF8).ToList() : [];
        SetOrAppendEnv(lines, "CTI_DEFAULT_WORKDIR", settings.DefaultWorkDir.Trim());
        SetOrAppendEnv(lines, "CTI_ALLOWED_WORKSPACE_ROOTS", settings.AllowedRoots.Trim());
        SetOrAppendEnv(lines, "CTI_UNITY_PROJECT_PATH", settings.UnityProject.Trim());
        SetOrAppendEnv(lines, "CTI_MEMORY_REPO_DIR", memoryRepo);
        SetOrAppendEnv(lines, "CTI_CODEX_ADDITIONAL_DIRECTORIES", settings.AdditionalDirs.Trim());
        SetOrAppendEnv(lines, "CTI_REPLY_STYLE_HINT", settings.ReplyStyleHint.Trim());
        File.WriteAllLines(_configPath, lines, new UTF8Encoding(false));
        AppendLog("配置已保存。回复风格将在重启飞书桥接后生效。");
        LoadConfig();
    }

    private async Task<string> SummarizeReplyStyleAsync(string requestText)
    {
        requestText = requestText.Trim();
        if (string.IsNullOrWhiteSpace(requestText))
        {
            throw new InvalidOperationException("先输入用户对机器人说话方式的要求。");
        }

        var baseUrl = GetConfig("CTI_LOCAL_LLM_BASE_URL", "http://127.0.0.1:8080");
        var model = GetConfig("CTI_LOCAL_LLM_MODEL", "qwen2.5-coder-7b-instruct");
        var probe = await ProbeLocalLlmAsync(baseUrl);
        if (!probe.Ok)
        {
            AppendLog($"本地AI整理失败：本地模型不可用 | {probe.Message}");
            throw new InvalidOperationException($"本地模型当前不可用：{probe.Message}");
        }

        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
            var payload = new
            {
                model,
                temperature = 0.2,
                max_tokens = 180,
                messages = new object[]
                {
                    new
                    {
                        role = "system",
                        content = "你负责把用户对机器人说话方式的原始要求，压缩成一段可直接写入配置的中文回复风格规则。输出要求：1. 只输出最终规则文本；2. 60字以内；3. 不要解释原因；4. 不要用项目符号；5. 重点约束语气、长度、是否暴露思考过程。"
                    },
                    new
                    {
                        role = "user",
                        content = requestText
                    }
                }
            };
            using var response = await client.PostAsync(
                $"{baseUrl.TrimEnd('/')}/v1/chat/completions",
                new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json"));
            var body = await response.Content.ReadAsStringAsync();
            response.EnsureSuccessStatusCode();

            var summarized = ExtractChatCompletionText(body).Trim();
            if (string.IsNullOrWhiteSpace(summarized))
            {
                throw new InvalidOperationException("本地模型没有返回可用的风格摘要。");
            }

            AppendLog($"本地AI已整理回复风格：{summarized}");
            return summarized;
        }
        catch (Exception ex)
        {
            AppendLog($"本地AI整理失败：{ex.Message}");
            throw;
        }
    }

    private static void SetOrAppendEnv(List<string> lines, string key, string value)
    {
        var index = lines.FindIndex(line => line.TrimStart().StartsWith(key + "=", StringComparison.OrdinalIgnoreCase));
        var next = key + "=" + value;
        if (index >= 0) lines[index] = next; else lines.Add(next);
    }

    private static readonly (string Channel, string AllowedKey, string OwnerKey)[] PermissionEnvKeys =
    [
        ("telegram", "CTI_TG_ALLOWED_USERS", "CTI_TG_OWNER_USERS"),
        ("discord", "CTI_DISCORD_ALLOWED_USERS", "CTI_DISCORD_OWNER_USERS"),
        ("feishu", "CTI_FEISHU_ALLOWED_USERS", "CTI_FEISHU_OWNER_USERS"),
        ("qq", "CTI_QQ_ALLOWED_USERS", "CTI_QQ_OWNER_USERS"),
        ("weixin", "CTI_WEIXIN_ALLOWED_USERS", "CTI_WEIXIN_OWNER_USERS"),
    ];

    private static List<string> SplitConfigList(string value)
        => value
            .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

    private static string NormalizePermissionChannel(string value)
    {
        var normalized = value.Trim().ToLowerInvariant();
        return normalized switch
        {
            "tg" => "telegram",
            "telegram" => "telegram",
            "discord" => "discord",
            "lark" => "feishu",
            "feishu" => "feishu",
            "qq" => "qq",
            "wechat" => "weixin",
            "weixin" => "weixin",
            _ => normalized,
        };
    }

    private static string NormalizePermissionRole(string value)
    {
        var normalized = value.Trim().ToLowerInvariant();
        return normalized switch
        {
            "owner" => "owner",
            "operator" => "operator",
            _ => "viewer",
        };
    }

    private static int RoleRank(string value)
        => NormalizePermissionRole(value) switch
        {
            "owner" => 3,
            "operator" => 2,
            _ => 1,
        };

    private static int ChannelSortRank(string value)
        => NormalizePermissionChannel(value) switch
        {
            "feishu" => 0,
            "telegram" => 1,
            "discord" => 2,
            "qq" => 3,
            "weixin" => 4,
            _ => 9,
        };

    private static string MakePermissionKey(string channelType, string userId)
        => $"{NormalizePermissionChannel(channelType)}::{userId.Trim()}";

    private static List<PermissionSubject> NormalizePermissionSubjects(IEnumerable<PermissionSubject>? subjects)
        => (subjects ?? [])
            .Where(item => !string.IsNullOrWhiteSpace(item.ChannelType) && !string.IsNullOrWhiteSpace(item.UserId))
            .GroupBy(item => MakePermissionKey(item.ChannelType, item.UserId), StringComparer.OrdinalIgnoreCase)
            .Select(group =>
            {
                var strongest = group.OrderByDescending(item => RoleRank(item.Role)).First();
                var now = DateTime.UtcNow.ToString("o");
                strongest.ChannelType = NormalizePermissionChannel(strongest.ChannelType);
                strongest.UserId = strongest.UserId.Trim();
                strongest.DisplayName = group.Select(item => item.DisplayName).FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))?.Trim() ?? "";
                strongest.Role = NormalizePermissionRole(strongest.Role);
                strongest.Source = string.IsNullOrWhiteSpace(strongest.Source) ? "panel" : strongest.Source;
                strongest.FirstSeenAt = string.IsNullOrWhiteSpace(strongest.FirstSeenAt) ? now : strongest.FirstSeenAt;
                strongest.LastSeenAt = string.IsNullOrWhiteSpace(strongest.LastSeenAt) ? strongest.FirstSeenAt : strongest.LastSeenAt;
                strongest.UpdatedAt = string.IsNullOrWhiteSpace(strongest.UpdatedAt) ? now : strongest.UpdatedAt;
                return strongest;
            })
            .OrderBy(item => ChannelSortRank(item.ChannelType))
            .ThenByDescending(item => RoleRank(item.Role))
            .ThenBy(item => string.IsNullOrWhiteSpace(item.DisplayName) ? item.UserId : item.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ToList();

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
            var audit = ReadBridgeRuntimeAudit();
            var channels = status?.Channels is { Length: > 0 } ? string.Join(", ", status.Channels) : "(none)";
            var daemonSaysRunning = result.Stdout.Contains("Bridge status: running", StringComparison.OrdinalIgnoreCase);
            var pidAlive = status is not null && status.Pid > 0 && IsProcessAlive(status.Pid);
            statusText = (status?.Running == true && pidAlive && daemonSaysRunning)
                ? $"运行中{Environment.NewLine}PID {status.Pid}{Environment.NewLine}Channels: {channels}"
                : "未运行";
            if (audit is not null)
            {
                var recentStage = string.IsNullOrWhiteSpace(audit.LastStage) ? "(none)" : audit.LastStage;
                var wsState = string.IsNullOrWhiteSpace(audit.FeishuWs?.State) ? "(unknown)" : audit.FeishuWs?.State;
                var p2pPoll = string.IsNullOrWhiteSpace(audit.FeishuP2pPoll?.State)
                    ? "(unknown)"
                    : audit.FeishuP2pPoll?.State;
                var p2pRecovered = string.IsNullOrWhiteSpace(audit.FeishuP2pPoll?.LastRecoveredMessageId)
                    ? ""
                    : $" / {audit.FeishuP2pPoll?.LastRecoveredChatId} / {audit.FeishuP2pPoll?.LastRecoveredMessageId}";
                var active = audit.LastActiveRequest is null
                    ? "(none)"
                    : $"{audit.LastActiveRequest.DisplayName} / {audit.LastActiveRequest.Stage}";
                var exitReason = string.IsNullOrWhiteSpace(audit.LastExitReason) ? "(none)" : audit.LastExitReason;
                statusText +=
                    $"{Environment.NewLine}最近阶段: {recentStage}" +
                    $"{Environment.NewLine}最近活跃请求: {active}" +
                    $"{Environment.NewLine}最近 WS 状态: {wsState}" +
                    $"{Environment.NewLine}私聊补捞状态: {p2pPoll}{p2pRecovered}" +
                    $"{Environment.NewLine}最近退出原因: {exitReason}";
            }
        }
        catch
        {
            statusText = result.Stdout.Contains("Bridge status: running", StringComparison.OrdinalIgnoreCase) ? "运行中" : "未运行";
        }
        _bridgeStatus.Text = statusText;
        AppendCommand("bridge status", result);
    }

    private BridgeRuntimeAuditRecord? ReadBridgeRuntimeAudit()
    {
        try
        {
            if (!File.Exists(_bridgeRuntimeAuditPath)) return null;
            var raw = File.ReadAllText(_bridgeRuntimeAuditPath, Encoding.UTF8);
            return string.IsNullOrWhiteSpace(raw)
                ? null
                : JsonSerializer.Deserialize<BridgeRuntimeAuditRecord>(raw, JsonOptions);
        }
        catch
        {
            return null;
        }
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

    private static bool IsProcessAlive(int pid)
    {
        try
        {
            var process = Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch
        {
            return false;
        }
    }

    private async Task CheckCodexAsync(bool updateOnly = false)
    {
        var routerMode = GetConfig("CTI_LOCAL_LLM_ROUTER_MODE", "hybrid");
        var result = await RunProcessAsync("powershell.exe", "-NoLogo -NoProfile -Command \"codex --version\"", _skillDir);
        var version = result.ExitCode == 0 ? FirstLine(result.Stdout) : "不可用";
        var codexPrimary = routerMode != "local_only";
        var stats = ReadLocalLlmStatus();
        var envelope = ReadFinalEnvelopeStatus();
        var degradation = result.ExitCode == 0
            ? "降级: 正常"
            : (routerMode == "local_only" ? "降级: 已固定仅本地" : "降级: Codex 不可用，将回退本地");
        _codexStatus.Text = string.Join(Environment.NewLine, new[]
        {
            version,
            $"模式: {RouterModeToLabel(routerMode)}",
            $"主脑: {(codexPrimary ? "Codex" : "本地")}",
            $"最近一次请求: {FormatLastBrainStatus(stats)}",
            $"结果块: {FormatFinalEnvelopeStatus(envelope)}",
            routerMode == "local_only" ? "升级: 关闭" : "升级: 允许",
            degradation,
        });
        if (!updateOnly) AppendCommand("codex version", result);
    }

    private async Task UpdateCodexCliAsync()
    {
        if (!CodexSupportsNpmUpdate())
        {
            _codexStatus.Text = string.Join(Environment.NewLine, new[]
            {
                "Codex CLI 当前来源不支持面板自动更新",
                "仅支持 npm 全局安装的 @openai/codex",
                "请先检查 codex 命令来源。",
            });
            AppendLog("Codex CLI 更新跳过：当前 codex 命令不是 npm 全局 @openai/codex。");
            return;
        }

        _codexStatus.Text = "正在更新 Codex CLI...";
        var result = await RunProcessAsync("cmd.exe", "/c npm install -g @openai/codex@latest", _skillDir, timeoutMs: 300000);
        AppendCommand("更新 Codex CLI", result);
        await CheckCodexAsync(true);
        if (result.ExitCode != 0)
        {
            _codexStatus.Text = string.Join(Environment.NewLine, new[]
            {
                "Codex CLI 更新失败",
                FirstNonEmptyLine(result.Stderr) ?? FirstNonEmptyLine(result.Stdout) ?? "未知错误",
                _codexStatus.Text,
            });
        }
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
            FormatLocalLlmLastStatus(stats),
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
        var suite = ReadSuiteVersionInfo();
        var extensions = ReadExtensionStatus();
        var localOverrides = CountLocalConfigOverrides();
        _buildStatus.Text = string.Join(Environment.NewLine, new[]
        {
            $"Suite: {suite.Version}",
            $"扩展协议: {suite.Protocol}",
            $"扩展: 启用 {extensions.Enabled}/{extensions.Total}，缺依赖 {extensions.MissingSources}",
            $"本机配置覆盖: {localOverrides} 项",
            $"构建时间: {buildTime}",
            $"分支: {branch}",
            $"Commit: {commit}",
        });
    }

    private (string Version, string Protocol) ReadSuiteVersionInfo()
    {
        if (string.IsNullOrWhiteSpace(_suiteRoot)) return ("unknown", "unknown");
        var manifestPath = Path.Combine(_suiteRoot, "suite.manifest.json");
        if (!File.Exists(manifestPath)) return ("unknown", "unknown");
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(manifestPath, Encoding.UTF8));
            var root = doc.RootElement;
            var version = root.TryGetProperty("version", out var versionElement) ? versionElement.GetString() ?? "unknown" : "unknown";
            var protocol = "unknown";
            if (root.TryGetProperty("extensionProtocol", out var protocolElement)
                && protocolElement.TryGetProperty("id", out var idElement)
                && protocolElement.TryGetProperty("version", out var protocolVersionElement))
            {
                protocol = $"{idElement.GetString()}@{protocolVersionElement.GetString()}";
            }
            return (version, protocol);
        }
        catch
        {
            return ("unreadable", "unreadable");
        }
    }

    private (int Total, int Enabled, int Disabled, int MissingSources) ReadExtensionStatus()
    {
        var dirs = new[] { _manifestDir, _skillsManifestDir, _pluginsManifestDir };
        var total = 0;
        var enabled = 0;
        var disabled = 0;
        var missingSources = 0;
        foreach (var dir in dirs.Where(Directory.Exists))
        {
            foreach (var file in Directory.GetFiles(dir, "*.json"))
            {
                total++;
                try
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(file, Encoding.UTF8));
                    var root = doc.RootElement;
                    var isEnabled = !root.TryGetProperty("enabled", out var enabledElement) || enabledElement.ValueKind != JsonValueKind.False;
                    if (isEnabled) enabled++;
                    else disabled++;

                    if (isEnabled
                        && root.TryGetProperty("source", out var sourceElement)
                        && sourceElement.ValueKind == JsonValueKind.String
                        && IsLocalManifestSource(sourceElement.GetString()))
                    {
                        var source = ExpandManifestValue(sourceElement.GetString());
                        if (!File.Exists(source) && !Directory.Exists(source)) missingSources++;
                    }
                }
                catch
                {
                    missingSources++;
                }
            }
        }
        return (total, enabled, disabled, missingSources);
    }

    private static bool IsLocalManifestSource(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        return !Regex.IsMatch(value, @"^(external|uvx|codex-plugin|npm|git|https?)[:/]", RegexOptions.IgnoreCase);
    }

    private int CountLocalConfigOverrides()
    {
        var keys = new[]
        {
            "CTI_DEFAULT_WORKDIR",
            "CTI_ALLOWED_WORKSPACE_ROOTS",
            "CTI_UNITY_PROJECT_PATH",
            "CTI_MEMORY_REPO_DIR",
            "CTI_CODEX_ADDITIONAL_DIRECTORIES",
            "CTI_REPLY_STYLE_HINT",
            "CTI_LOCAL_LLM_ROUTER_MODE",
        };
        return keys.Count(key => _config.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value));
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

    private FinalEnvelopeStatusRecord ReadFinalEnvelopeStatus()
    {
        try
        {
            if (!File.Exists(_finalEnvelopeStatusPath)) return new FinalEnvelopeStatusRecord();
            var raw = File.ReadAllText(_finalEnvelopeStatusPath, Encoding.UTF8);
            return string.IsNullOrWhiteSpace(raw)
                ? new FinalEnvelopeStatusRecord()
                : JsonSerializer.Deserialize<FinalEnvelopeStatusRecord>(raw, JsonOptions) ?? new FinalEnvelopeStatusRecord();
        }
        catch
        {
            return new FinalEnvelopeStatusRecord();
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

    private static string ExtractChatCompletionText(string json)
    {
        using var document = JsonDocument.Parse(json);
        if (!document.RootElement.TryGetProperty("choices", out var choices) || choices.ValueKind != JsonValueKind.Array || choices.GetArrayLength() == 0)
        {
            return "";
        }

        var first = choices[0];
        if (!first.TryGetProperty("message", out var message) || !message.TryGetProperty("content", out var content))
        {
            return "";
        }

        return content.ValueKind switch
        {
            JsonValueKind.String => content.GetString() ?? "",
            JsonValueKind.Array => string.Join("", content.EnumerateArray()
                .Where(item => item.ValueKind == JsonValueKind.Object && item.TryGetProperty("text", out _))
                .Select(item => item.GetProperty("text").GetString() ?? "")),
            _ => ""
        };
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

    private string FormatManifestSource(string? value, McpManifest manifest)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";
        if (!IsLocalManifestSource(value)) return value;
        return ResolveManifestPath(value, manifest);
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
        AppendCommand("本机备份发布", result);
        await RefreshBuildInfoAsync();
    }

    private async Task PrepareMainReleaseAsync()
    {
        if (string.IsNullOrWhiteSpace(_mainReleaseScript) || !File.Exists(_mainReleaseScript))
        {
            AppendLog("未找到 prepare-main-release.ps1。");
            return;
        }

        var preflight = await ValidatePowerShellScriptAsync(_mainReleaseScript);
        if (!preflight.Success)
        {
            AppendLog($"主干发布预检脚本语法失败：{preflight.Message}");
            MessageBox.Show(
                this,
                $"主干发布预检脚本语法失败，已阻止继续执行。\n\n{preflight.Message}",
                "主干发布预检失败",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        var confirm = MessageBox.Show(
            this,
            "将执行主干发布预检：扩展协议校验、架构文档检查、构建、打包和发布摘要生成。\n\n不会同步 live skill，不会自动 git commit、push 或打标签。",
            "主干发布预检",
            MessageBoxButtons.OKCancel,
            MessageBoxIcon.Information);
        if (confirm != DialogResult.OK)
        {
            AppendLog("已取消主干发布预检。");
            return;
        }

        var result = await RunPowerShellFileAsync(_mainReleaseScript, "", _suiteRoot, 900000);
        AppendCommand("主干发布预检", result);
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
            return "当前没有待发布改动。继续执行会触发本机 live 同步和打包，不会生成新的 git 提交。";
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
        builder.AppendLine("确认后将执行：开发版 -> live skill 同步、打包、git add/commit、git push");
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
            "5. 本机备份发布会用开发版生成 live skill、构建并推送当前分支；主干发布预检只验证和打包，不会自动同步 live 或推送。",
        });
        MessageBox.Show(this, helpText, "中控面板帮助", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private async Task ShowConversationViewerAsync()
    {
        try
        {
            var localEntries = LoadConversationEntries();
            var entries = await LoadRemoteConversationEntriesAsync(localEntries);
            using var form = new ConversationViewerForm(
                entries,
                _dataDir,
                LoadConversationDetailAsync,
                SearchHistory,
                FormatHistorySearchResults,
                GetFeishuHistorySyncStatusText,
                async () =>
                {
                    await SyncAllFeishuHistoryAsync();
                    return GetFeishuHistorySyncStatusText(full: true);
                });
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
        var feishuHistoryIndex = LoadFeishuHistoryIndex();
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
            entries.Add(BuildConversationEntry(pair.Key, binding, session, feishuChatIndex, feishuHistoryIndex));
        }
        foreach (var pair in sessions.OrderByDescending(p => ReadMessageFileTimestamp(p.Key)))
        {
            if (boundSessionIds.Contains(pair.Key)) continue;
            entries.Add(BuildConversationEntry(null, null, pair.Value, feishuChatIndex, feishuHistoryIndex));
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

    private ConversationEntry BuildConversationEntry(
        string? bindingKey,
        ChannelBindingRecord? binding,
        SessionRecord? session,
        IReadOnlyDictionary<string, FeishuChatIndexRecord> feishuChatIndex,
        IReadOnlyDictionary<string, FeishuHistorySyncRecord> feishuHistoryIndex)
    {
        var sessionId = binding?.CodepilotSessionId ?? session?.Id ?? "";
        var messages = LoadConversationMessages(sessionId);
        var chatId = binding?.ChatId ?? "";
        var resolvedDisplayName = ResolveConversationDisplayName(binding, session, feishuChatIndex, feishuHistoryIndex, chatId, sessionId);
        return new ConversationEntry
        {
            BindingKey = bindingKey ?? "",
            ChannelType = binding?.ChannelType ?? "",
            ChatId = chatId,
            ChatType = binding?.ChatType ?? "",
            DisplayName = resolvedDisplayName,
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

    private static string ResolveConversationDisplayName(
        ChannelBindingRecord? binding,
        SessionRecord? session,
        IReadOnlyDictionary<string, FeishuChatIndexRecord> feishuChatIndex,
        IReadOnlyDictionary<string, FeishuHistorySyncRecord> feishuHistoryIndex,
        string chatId,
        string sessionId)
    {
        var candidates = new[]
        {
            binding?.DisplayName,
            !string.IsNullOrWhiteSpace(chatId) && feishuChatIndex.TryGetValue(chatId, out var chatIndex) ? chatIndex?.DisplayName : null,
            !string.IsNullOrWhiteSpace(chatId) && feishuHistoryIndex.TryGetValue(chatId, out var historyIndex) ? historyIndex?.DisplayName : null,
            binding?.ChatId,
            sessionId,
        };

        foreach (var candidate in candidates)
        {
            if (!string.IsNullOrWhiteSpace(candidate))
            {
                return candidate.Trim();
            }
        }

        return "";
    }

    private async Task<ConversationEntry> LoadConversationDetailAsync(ConversationEntry entry)
    {
        if (!string.Equals(entry.ChannelType, "feishu", StringComparison.OrdinalIgnoreCase) || string.IsNullOrWhiteSpace(entry.ChatId))
        {
            entry.RemoteLoaded = true;
            return entry;
        }

        var rawMessages = LoadIndexedFeishuHistoryRaw(entry.ChatId);
        if (rawMessages.Count == 0 || NeedsHistoryMediaRefresh(rawMessages))
        {
            await SyncFeishuChatHistoryAsync(entry.ChatId, entry.DisplayName, entry.ChatType, rawMessages.Count > 0);
            rawMessages = LoadIndexedFeishuHistoryRaw(entry.ChatId);
        }
        var indexedMessages = await BuildIndexedFeishuHistoryMessagesAsync(rawMessages, 400);
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
            return items.Select((item, index) =>
            {
                var parsed = ParseStoredMessageContent(item.Content ?? "");
                return new ConversationMessageView
                {
                    Index = index + 1,
                    Role = item.Role ?? "unknown",
                    MsgType = "local",
                    CreatedAt = ParseDateTime(item.CreatedAt),
                    Content = NormalizeDisplayText(parsed.Content),
                    Attachments = parsed.Attachments,
                };
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

    private (string Content, List<ConversationAttachmentView> Attachments) ParseStoredMessageContent(string raw)
    {
        var trimmed = raw.Trim();
        var attachments = new List<ConversationAttachmentView>();
        if (string.IsNullOrWhiteSpace(trimmed)) return ("", attachments);
        if (trimmed.StartsWith("<!--files:", StringComparison.Ordinal))
        {
            var end = trimmed.IndexOf("-->", StringComparison.Ordinal);
            if (end > "<!--files:".Length)
            {
                var json = trimmed["<!--files:".Length..end];
                foreach (var attachment in BuildStoredFileAttachments(json))
                {
                    attachments.Add(attachment);
                }
                trimmed = trimmed[(end + "-->".Length)..].Trim();
            }
        }
        if (trimmed.StartsWith("[[CTI_SUMMARY]]", StringComparison.Ordinal))
        {
            return (NormalizeDisplayText(trimmed["[[CTI_SUMMARY]]".Length..].Trim()), attachments);
        }
        if (!trimmed.StartsWith("[", StringComparison.Ordinal)) return (NormalizeDisplayText(trimmed), attachments);
        try
        {
            var blocks = JsonSerializer.Deserialize<List<StoredContentBlock>>(trimmed, JsonOptions) ?? [];
            var parts = new List<string>();
            foreach (var block in blocks)
            {
                switch ((block.Type ?? "").Trim())
                {
                    case "text":
                        if (!string.IsNullOrWhiteSpace(block.Text)) parts.Add(NormalizeDisplayText(block.Text.Trim()));
                        break;
                    case "image":
                    case "local_image":
                        if (!string.IsNullOrWhiteSpace(block.Path))
                        {
                            attachments.Add(BuildLocalAttachment("image", block.Path, block.Name ?? Path.GetFileName(block.Path), block.Type ?? GuessMimeType(block.Path), "", "本地图片"));
                        }
                        break;
                    case "tool_use":
                        parts.Add($"[工具开始] {block.Name ?? "tool"}");
                        break;
                    case "tool_result":
                        parts.Add($"[工具结果] {TrimForSummary(NormalizeDisplayText(block.Content ?? ""), 240)}");
                        break;
                }
            }
            return (parts.Count > 0 ? string.Join(Environment.NewLine + Environment.NewLine, parts) : NormalizeDisplayText(trimmed), attachments);
        }
        catch
        {
            return (NormalizeDisplayText(trimmed), attachments);
        }
    }

    private List<ConversationAttachmentView> BuildStoredFileAttachments(string rawJson)
    {
        try
        {
            var items = JsonSerializer.Deserialize<List<StoredFileAttachmentMeta>>(rawJson, JsonOptions) ?? [];
            return items
                .Where(item => !string.IsNullOrWhiteSpace(item.FilePath))
                .Select(item =>
                {
                    var path = item.FilePath ?? "";
                    var kind = (item.Type ?? GuessMimeType(path)).StartsWith("image/", StringComparison.OrdinalIgnoreCase)
                        ? "image"
                        : "file";
                    return BuildLocalAttachment(kind, path, item.Name ?? Path.GetFileName(path), item.Type ?? GuessMimeType(path), item.Id ?? "", File.Exists(path) ? "已缓存" : "文件不存在");
                })
                .ToList();
        }
        catch
        {
            return [];
        }
    }

    private ConversationAttachmentView BuildLocalAttachment(
        string kind,
        string filePath,
        string name,
        string mimeType,
        string resourceKey,
        string status)
    {
        var size = File.Exists(filePath) ? new FileInfo(filePath).Length : 0L;
        var url = "";
        if (File.Exists(filePath))
        {
            url = TryBuildMediaCacheUrl(filePath)
                ?? TryBuildImageDataUrl(filePath, mimeType)
                ?? new Uri(Path.GetFullPath(filePath)).AbsoluteUri;
        }
        return new ConversationAttachmentView(kind, name, mimeType, size, filePath, url, resourceKey, status);
    }

    private string? TryBuildMediaCacheUrl(string filePath)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(filePath) || !File.Exists(filePath)) return null;
            var fullPath = Path.GetFullPath(filePath);
            var mediaRoot = Path.GetFullPath(_mediaCacheDir);
            var relativePath = Path.GetRelativePath(mediaRoot, fullPath);
            if (relativePath.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(relativePath)) return null;
            var segments = relativePath
                .Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries)
                .Select(Uri.EscapeDataString);
            var resourcePath = string.Join("/", segments);
            if (!string.IsNullOrWhiteSpace(_controlApiBaseUrl))
            {
                var url = $"{_controlApiBaseUrl}/media/{resourcePath}";
                var token = GetConfig("CTI_CONTROL_API_AUTH_TOKEN", "").Trim();
                if (!IsLoopbackBindHost(_controlApiBindHost) && !string.IsNullOrWhiteSpace(token))
                {
                    url += $"?token={Uri.EscapeDataString(token)}";
                }
                return url;
            }
            return $"https://{MediaHostName}/{resourcePath}";
        }
        catch
        {
            return null;
        }
    }

    private string? TryBuildImageDataUrl(string filePath, string mimeType)
    {
        try
        {
            if (!File.Exists(filePath)) return null;
            if (!mimeType.StartsWith("image/", StringComparison.OrdinalIgnoreCase)) return null;
            var info = new FileInfo(filePath);
            if (info.Length > 8 * 1024 * 1024) return null;
            var bytes = File.ReadAllBytes(filePath);
            return $"data:{mimeType};base64,{Convert.ToBase64String(bytes)}";
        }
        catch
        {
            return null;
        }
    }

    private static string GuessMimeType(string path)
    {
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".jpg" or ".jpeg" => "image/jpeg",
            ".png" => "image/png",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".bmp" => "image/bmp",
            ".svg" => "image/svg+xml",
            ".mp4" => "video/mp4",
            ".ogg" => "audio/ogg",
            ".pdf" => "application/pdf",
            ".txt" => "text/plain",
            ".json" => "application/json",
            _ => "application/octet-stream",
        };
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
                var msgType = GetJsonString(item, "msg_type") ?? "";
                var rawContent = ExtractFeishuBodyContentRaw(item);
                var itemRaw = item.GetRawText();
                var hasDirectResource = IsDirectFeishuResourceMessage(msgType);
                var resourceKey = hasDirectResource ? ExtractFeishuResourceKey(rawContent) : "";
                if (hasDirectResource && string.IsNullOrWhiteSpace(resourceKey))
                {
                    resourceKey = ExtractFeishuResourceKey(itemRaw);
                }
                var fileName = hasDirectResource ? ExtractFeishuFileName(rawContent) : "";
                if (hasDirectResource && string.IsNullOrWhiteSpace(fileName))
                {
                    fileName = ExtractFeishuFileName(itemRaw);
                }
                result.Add(new FeishuIndexedMessageRecord
                {
                    MessageId = GetJsonString(item, "message_id") ?? "",
                    ChatId = chatId,
                    CreateTime = GetJsonString(item, "create_time") ?? "",
                    MsgType = msgType,
                    SenderId = item.TryGetProperty("sender", out var senderEl) ? GetJsonString(senderEl, "id") : "",
                    SenderType = item.TryGetProperty("sender", out senderEl) ? GetJsonString(senderEl, "sender_type") : "",
                    Text = ExtractFeishuMessageText(item),
                    RawContent = rawContent,
                    ResourceKey = resourceKey,
                    ResourceType = ResolveFeishuResourceType(msgType),
                    FileName = fileName,
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
        var merged = new Dictionary<string, FeishuIndexedMessageRecord>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in existing)
        {
            if (string.IsNullOrWhiteSpace(item.MessageId)) continue;
            merged[item.MessageId] = item;
        }
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
        if (full)
        {
            ReviveDeletedSessionAfterFullSync(chatId, ordered.LastOrDefault()?.CreateTime, displayName);
        }
        RefreshFeishuHistorySyncStatusPanel();
    }

    private void ReviveDeletedSessionAfterFullSync(string chatId, string? latestMessageTime, string? displayName)
    {
        if (string.IsNullOrWhiteSpace(chatId))
        {
            return;
        }

        var key = MakeDeletedSessionKey(chatId, "");
        var deletedSessions = LoadDeletedSessions();
        if (!deletedSessions.Remove(key))
        {
            return;
        }

        SaveDeletedSessions(deletedSessions);
        var label = string.IsNullOrWhiteSpace(displayName) ? chatId : displayName;
        AppendLog($"全量同步已恢复会话：{label}");
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
        var records = File.Exists(filePath)
            ? JsonSerializer.Deserialize<List<FeishuIndexedMessageRecord>>(File.ReadAllText(filePath, Encoding.UTF8), JsonOptions) ?? []
            : [];
        RepairCardMessagePlaceholders(records);
        return records;
    }

    private void RepairCardMessagePlaceholders(List<FeishuIndexedMessageRecord> records)
    {
        if (records.Count == 0) return;
        var auditIndex = LoadAuditSummaryByMessageId();
        if (auditIndex.Count == 0) return;

        foreach (var record in records)
        {
            if (!string.Equals(record.MsgType, "interactive", StringComparison.OrdinalIgnoreCase)) continue;
            if (!IsFeishuInteractiveFallbackText(record.Text)) continue;
            if (string.IsNullOrWhiteSpace(record.MessageId)) continue;
            if (!auditIndex.TryGetValue(record.MessageId, out var summary)) continue;
            if (string.IsNullOrWhiteSpace(summary)) continue;
            record.Text = summary;
        }
    }

    private static bool IsFeishuInteractiveFallbackText(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return true;
        var trimmed = text.Trim();
        return string.Equals(trimmed, "[卡片消息]", StringComparison.Ordinal)
            || trimmed.Contains("请升级至最新版本客户端", StringComparison.Ordinal)
            || trimmed.Contains("upgrade", StringComparison.OrdinalIgnoreCase);
    }

    private Dictionary<string, string> LoadAuditSummaryByMessageId()
    {
        if (_auditSummaryByMessageId is not null) return _auditSummaryByMessageId;

        var index = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!File.Exists(_auditJsonPath))
        {
            _auditSummaryByMessageId = index;
            return index;
        }

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(_auditJsonPath, Encoding.UTF8));
            if (document.RootElement.ValueKind != JsonValueKind.Array)
            {
                _auditSummaryByMessageId = index;
                return index;
            }

            foreach (var item in document.RootElement.EnumerateArray())
            {
                var messageId = GetJsonString(item, "messageId");
                var summary = GetJsonString(item, "summary");
                if (string.IsNullOrWhiteSpace(messageId) || string.IsNullOrWhiteSpace(summary)) continue;
                if (summary.StartsWith("[FILTERED]", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(summary, "[卡片消息]", StringComparison.Ordinal)) continue;
                index[messageId] = summary;
            }
        }
        catch
        {
            // ignore audit parse failures; history can still fall back to stored text
        }

        _auditSummaryByMessageId = index;
        return index;
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
            MessageId = item.MessageId,
            Role = string.Equals(item.SenderType, "app", StringComparison.OrdinalIgnoreCase) ? "assistant" : "user",
            MsgType = item.MsgType,
            SenderId = item.SenderId ?? "",
            SenderType = item.SenderType ?? "",
            SenderName = item.SenderName ?? "",
            CreatedAt = ParseUnixMsOrIso(item.CreateTime),
            Content = NormalizeDisplayText($"{(string.IsNullOrWhiteSpace(item.SenderName) ? item.SenderId : item.SenderName)}: {item.Text}"),
            Attachments = BuildFeishuAttachmentPlaceholders(item),
        }).ToList();
    }

    private async Task<List<ConversationMessageView>> BuildIndexedFeishuHistoryMessagesAsync(List<FeishuIndexedMessageRecord> rawMessages, int limit)
    {
        var selected = rawMessages
            .OrderBy(item => long.TryParse(item.CreateTime, out var parsed) ? parsed : 0L)
            .ToList();
        if (limit > 0 && selected.Count > limit) selected = selected[^limit..];
        var messages = new List<ConversationMessageView>();
        var downloadBudget = 12;
        for (var index = 0; index < selected.Count; index++)
        {
            var item = selected[index];
            var shouldTryDownload = downloadBudget > 0 && selected.Count - index <= 80;
            var attachments = await BuildFeishuAttachmentsAsync(item, shouldTryDownload);
            if (shouldTryDownload && attachments.Count > 0)
            {
                downloadBudget--;
            }
            messages.Add(new ConversationMessageView
            {
                Index = index + 1,
                MessageId = item.MessageId,
                Role = string.Equals(item.SenderType, "app", StringComparison.OrdinalIgnoreCase) ? "assistant" : "user",
                MsgType = item.MsgType,
                SenderId = item.SenderId ?? "",
                SenderType = item.SenderType ?? "",
                SenderName = item.SenderName ?? "",
                CreatedAt = ParseUnixMsOrIso(item.CreateTime),
                Content = NormalizeDisplayText($"{(string.IsNullOrWhiteSpace(item.SenderName) ? item.SenderId : item.SenderName)}: {item.Text}"),
                Attachments = attachments,
            });
        }
        return messages;
    }

    private static bool NeedsHistoryMediaRefresh(List<FeishuIndexedMessageRecord> records)
        => records.Any(item =>
            (string.Equals(item.MsgType, "image", StringComparison.OrdinalIgnoreCase)
                || string.Equals(item.MsgType, "file", StringComparison.OrdinalIgnoreCase)
                || string.Equals(item.MsgType, "post", StringComparison.OrdinalIgnoreCase))
            && (string.IsNullOrWhiteSpace(item.RawContent) || string.IsNullOrWhiteSpace(item.ResourceKey))
            && (string.Equals(item.Text, "[图片]", StringComparison.Ordinal)
                || string.Equals(item.Text, "[文件]", StringComparison.Ordinal)
                || string.Equals(item.Text, "[卡片消息]", StringComparison.Ordinal)));

    private List<ConversationAttachmentView> BuildFeishuAttachmentPlaceholders(FeishuIndexedMessageRecord item)
    {
        if (!IsDirectFeishuResourceMessage(item.MsgType)) return [];
        if (string.IsNullOrWhiteSpace(item.ResourceKey)) return [];
        var kind = string.Equals(item.ResourceType, "image", StringComparison.OrdinalIgnoreCase) ? "image" : "file";
        var name = !string.IsNullOrWhiteSpace(item.FileName)
            ? item.FileName!
            : $"{item.ResourceKey}.{(kind == "image" ? "png" : "bin")}";
        return [new ConversationAttachmentView(kind, name, GuessMimeType(name), 0, "", "", item.ResourceKey, "未下载")];
    }

    private async Task<List<ConversationAttachmentView>> BuildFeishuAttachmentsAsync(FeishuIndexedMessageRecord item, bool allowDownload)
    {
        var placeholders = BuildFeishuAttachmentPlaceholders(item);
        if (placeholders.Count == 0) return [];
        var first = placeholders[0];
        var resourceType = string.Equals(item.ResourceType, "image", StringComparison.OrdinalIgnoreCase) ? "image" : "file";
        var cached = TryGetCachedFeishuResource(item.MessageId, item.ResourceKey, resourceType, first.Name);
        if (cached is not null) return [cached];
        if (!allowDownload)
        {
            return placeholders.Select(attachment => attachment with { Status = "未下载，点击刷新详情会优先加载最近附件" }).ToList();
        }
        var downloaded = await TryDownloadFeishuResourceAsync(item.MessageId, item.ResourceKey, resourceType, first.Name);
        return downloaded is not null ? [downloaded] : placeholders.Select(attachment => attachment with { Status = "下载失败或无权限" }).ToList();
    }

    private ConversationAttachmentView? TryGetCachedFeishuResource(string messageId, string? resourceKey, string resourceType, string fallbackName)
    {
        if (string.IsNullOrWhiteSpace(messageId) || string.IsNullOrWhiteSpace(resourceKey)) return null;
        try
        {
            var safeKey = Regex.Replace(resourceKey, @"[^a-zA-Z0-9._-]", "_");
            var ext = Path.GetExtension(fallbackName);
            if (string.IsNullOrWhiteSpace(ext)) ext = string.Equals(resourceType, "image", StringComparison.OrdinalIgnoreCase) ? ".png" : ".bin";
            var cachePath = Path.Combine(_mediaCacheDir, $"{messageId}-{safeKey}{ext}");
            if (!File.Exists(cachePath) || new FileInfo(cachePath).Length == 0) return null;
            var mimeType = GuessMimeType(cachePath);
            return BuildLocalAttachment(
                string.Equals(resourceType, "image", StringComparison.OrdinalIgnoreCase) ? "image" : "file",
                cachePath,
                fallbackName,
                mimeType,
                resourceKey,
                "已缓存");
        }
        catch
        {
            return null;
        }
    }

    private async Task<ConversationAttachmentView?> TryDownloadFeishuResourceAsync(string messageId, string? resourceKey, string resourceType, string fallbackName)
    {
        if (string.IsNullOrWhiteSpace(messageId) || string.IsNullOrWhiteSpace(resourceKey)) return null;
        try
        {
            Directory.CreateDirectory(_mediaCacheDir);
            var safeKey = Regex.Replace(resourceKey, @"[^a-zA-Z0-9._-]", "_");
            var ext = Path.GetExtension(fallbackName);
            if (string.IsNullOrWhiteSpace(ext)) ext = string.Equals(resourceType, "image", StringComparison.OrdinalIgnoreCase) ? ".png" : ".bin";
            var cachePath = Path.Combine(_mediaCacheDir, $"{messageId}-{safeKey}{ext}");
            if (!File.Exists(cachePath) || new FileInfo(cachePath).Length == 0)
            {
                var auth = await FetchFeishuTenantAccessTokenAsync();
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
                var typeParam = string.Equals(resourceType, "image", StringComparison.OrdinalIgnoreCase) ? "image" : "file";
                var url = $"{auth.BaseUrl}/open-apis/im/v1/messages/{Uri.EscapeDataString(messageId)}/resources/{Uri.EscapeDataString(resourceKey)}?type={typeParam}";
                using var request = new HttpRequestMessage(HttpMethod.Get, url);
                request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {auth.Token}");
                using var response = await http.SendAsync(request);
                if (!response.IsSuccessStatusCode) return null;
                var bytes = await response.Content.ReadAsByteArrayAsync();
                if (bytes.Length == 0 || bytes.Length > 100 * 1024 * 1024) return null;
                await File.WriteAllBytesAsync(cachePath, bytes);
            }
            var mimeType = GuessMimeType(cachePath);
            return BuildLocalAttachment(
                string.Equals(resourceType, "image", StringComparison.OrdinalIgnoreCase) ? "image" : "file",
                cachePath,
                fallbackName,
                mimeType,
                resourceKey,
                "已缓存");
        }
        catch
        {
            return null;
        }
    }

    private void RefreshFeishuHistorySyncStatusPanel()
        => _historySyncStatus.Text = GetFeishuHistorySyncStatusText();

    private string GetFeishuHistorySyncStatusText(bool full = false)
    {
        var index = LoadFeishuHistoryIndex()
            .Values
            .OrderByDescending(item => ParseUnixMsOrIso(item.LastSyncAt) ?? DateTime.MinValue)
            .ThenBy(item => item.DisplayName ?? item.ChatId)
            .ToList();

        if (index.Count == 0)
        {
            return "暂无本地飞书历史索引。";
        }

        var lines = new List<string>
        {
            $"已同步会话: {index.Count}",
            $"累计消息: {index.Sum(item => item.MessageCount)}",
            "",
        };
        foreach (var item in (full ? index : index.Take(8)))
        {
            var latest = ParseUnixMsOrIso(item.LatestMessageTime)?.ToString("yyyy-MM-dd HH:mm:ss") ?? "-";
            var syncedAt = ParseUnixMsOrIso(item.LastSyncAt)?.ToString("yyyy-MM-dd HH:mm:ss") ?? item.LastSyncAt ?? "-";
            lines.Add($"{item.DisplayName ?? item.ChatId} | {item.MessageCount} 条 | 最新 {latest} | 同步 {syncedAt}");
        }
        if (!full && index.Count > 8) lines.Add($"... 其余 {index.Count - 8} 个会话请点“查看同步状态”");
        return string.Join(Environment.NewLine, lines);
    }

    private List<HistorySearchHit> SearchHistory(HistorySearchQuery query)
    {
        var chatFilter = query.Chat.Trim();
        var keywordFilter = query.Keyword.Trim();
        var speakerFilter = query.Speaker.Trim();
        var startAt = ParseDateTime(query.Start.Trim());
        var endAt = ParseDateTime(query.End.Trim());

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

        return ordered;
    }

    private static string FormatHistorySearchResults(List<HistorySearchHit> ordered)
    {
        if (ordered.Count == 0)
        {
            return "没有命中本地历史索引。";
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
        return builder.ToString().TrimEnd();
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

    private static string ExtractFeishuBodyContentRaw(JsonElement item)
    {
        if (!item.TryGetProperty("body", out var body) || body.ValueKind != JsonValueKind.Object) return "";
        if (!body.TryGetProperty("content", out var content)) return "";
        return content.ValueKind == JsonValueKind.String
            ? content.GetString() ?? ""
            : content.GetRawText();
    }

    private static string ExtractFeishuMessageText(JsonElement item)
    {
        var msgType = GetJsonString(item, "msg_type") ?? "";
        if (!item.TryGetProperty("body", out var body) || body.ValueKind != JsonValueKind.Object)
        {
            return $"[{msgType}]";
        }

        var content = ExtractFeishuBodyContentRaw(item);
        if (string.IsNullOrWhiteSpace(content)) return $"[{msgType}]";
        if (string.Equals(msgType, "text", StringComparison.OrdinalIgnoreCase))
        {
            return ParseFeishuTextContent(content);
        }
        if (string.Equals(msgType, "post", StringComparison.OrdinalIgnoreCase))
        {
            return ParseFeishuPostContent(content);
        }
        if (string.Equals(msgType, "interactive", StringComparison.OrdinalIgnoreCase))
        {
            return ParseFeishuInteractiveContent(content);
        }

        return msgType switch
        {
            "image" => "[图片]",
            "file" => "[文件]",
            "audio" => "[语音]",
            "video" or "media" => "[视频]",
            _ => $"[{msgType}]",
        };
    }

    private static bool IsDirectFeishuResourceMessage(string? msgType)
        => string.Equals(msgType, "image", StringComparison.OrdinalIgnoreCase)
            || string.Equals(msgType, "file", StringComparison.OrdinalIgnoreCase)
            || string.Equals(msgType, "media", StringComparison.OrdinalIgnoreCase);

    private static string ResolveFeishuResourceType(string msgType)
        => string.Equals(msgType, "image", StringComparison.OrdinalIgnoreCase)
            ? "image"
            : "file";

    private static string ExtractFeishuResourceKey(string rawContent)
    {
        if (string.IsNullOrWhiteSpace(rawContent)) return "";
        try
        {
            using var document = JsonDocument.Parse(rawContent);
            return FindFirstJsonString(document.RootElement, "image_key", "file_key", "imageKey", "fileKey") ?? "";
        }
        catch
        {
            return "";
        }
    }

    private static string ExtractFeishuFileName(string rawContent)
    {
        if (string.IsNullOrWhiteSpace(rawContent)) return "";
        try
        {
            using var document = JsonDocument.Parse(rawContent);
            return FindFirstJsonString(document.RootElement, "file_name", "name", "fileName") ?? "";
        }
        catch
        {
            return "";
        }
    }

    private static string? FindFirstJsonString(JsonElement element, params string[] names)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var name in names)
                {
                    if (element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String)
                    {
                        var result = value.GetString();
                        if (!string.IsNullOrWhiteSpace(result)) return result;
                    }
                }
                foreach (var property in element.EnumerateObject())
                {
                    var nested = FindFirstJsonString(property.Value, names);
                    if (!string.IsNullOrWhiteSpace(nested)) return nested;
                }
                break;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                {
                    var nested = FindFirstJsonString(item, names);
                    if (!string.IsNullOrWhiteSpace(nested)) return nested;
                }
                break;
        }
        return null;
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

    private static string ParseFeishuInteractiveContent(string raw)
    {
        try
        {
            using var document = JsonDocument.Parse(raw);
            var parts = new List<string>();
            CollectTextRuns(document.RootElement, parts);
            var merged = string.Join(" ", parts.Where(part => !string.IsNullOrWhiteSpace(part)).Select(part => part.Trim()));
            merged = Regex.Replace(merged, @"\s+", " ").Trim();
            return string.IsNullOrWhiteSpace(merged) ? "[卡片消息]" : merged;
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

    private static string NormalizeDisplayText(string text)
    {
        if (string.IsNullOrWhiteSpace(text) || !LooksLikeMojibake(text)) return text;
        var repaired = TryRepairUtf8ReadAsGbk(text);
        if (string.IsNullOrWhiteSpace(repaired)) return text;
        return MojibakeScore(repaired) < MojibakeScore(text) ? repaired : text;
    }

    private static bool LooksLikeMojibake(string text) => MojibakeScore(text) >= 3;

    private static int MojibakeScore(string text)
    {
        if (string.IsNullOrEmpty(text)) return 0;
        var score = 0;
        foreach (var token in new[] { "妫", "绱", "鍦", "涓", "鏂", "鎴", "浼", "杩", "鍖", "櫌", "儴", "烘", "櫙", "€", "俓", "", "", "", "", "" })
        {
            var index = 0;
            while ((index = text.IndexOf(token, index, StringComparison.Ordinal)) >= 0)
            {
                score++;
                index += token.Length;
            }
        }
        return score;
    }

    private static string? TryRepairUtf8ReadAsGbk(string text)
    {
        if (!OperatingSystem.IsWindows()) return null;
        try
        {
            var byteCount = WideCharToMultiByte(CodePageGb2312, 0, text, text.Length, null, 0, IntPtr.Zero, IntPtr.Zero);
            if (byteCount <= 0) return null;
            var bytes = new byte[byteCount];
            var written = WideCharToMultiByte(CodePageGb2312, 0, text, text.Length, bytes, bytes.Length, IntPtr.Zero, IntPtr.Zero);
            if (written <= 0) return null;
            return Encoding.UTF8.GetString(bytes, 0, written);
        }
        catch
        {
            return null;
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int WideCharToMultiByte(
        uint codePage,
        uint flags,
        string wideCharString,
        int wideCharCount,
        byte[]? multiByteString,
        int multiByteCount,
        IntPtr defaultChar,
        IntPtr usedDefaultChar);

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
        AddWebActivity("info", "日志", text);
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

    private static string FormatLocalLlmLastStatus(LocalLlmStatusRecord status)
    {
        if (!HasRecentRouteSignal(status))
        {
            return "暂无最近路由";
        }

        if (!string.IsNullOrWhiteSpace(status.LastRefusalReason))
        {
            return TrimForStatus(status.LastRefusalReason, 42);
        }

        var provider = (status.LastProvider ?? "").Trim().ToLowerInvariant();
        if (provider == "local_best_effort" && !string.IsNullOrWhiteSpace(status.LastFallbackReason))
        {
            return TrimForStatus(status.LastFallbackReason, 42);
        }

        if (!string.IsNullOrWhiteSpace(status.LastRouteReason))
        {
            return TrimForStatus(status.LastRouteReason, 42);
        }

        return "暂无最近路由";
    }

    private static bool HasRecentRouteSignal(LocalLlmStatusRecord status)
    {
        if ((status.RecentRoutes?.Count ?? 0) > 0) return true;
        if (!string.IsNullOrWhiteSpace(status.LastRouteReason)) return true;
        if (!string.IsNullOrWhiteSpace(status.LastFallbackReason)) return true;
        if (!string.IsNullOrWhiteSpace(status.LastRefusalReason)) return true;
        return !string.IsNullOrWhiteSpace(status.LastDecision) || !string.IsNullOrWhiteSpace(status.LastProvider);
    }

    private static string RouterModeToLabel(string? mode)
        => (mode ?? "").Trim().ToLowerInvariant() switch
        {
            "local_only" => "仅本地",
            "codex_only" => "仅 Codex",
            _ => "混合模式（Codex 主脑）",
        };

    private static bool CodexSupportsNpmUpdate()
    {
        try
        {
            var npmRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "npm");
            var codexShim = Path.Combine(npmRoot, "codex.ps1");
            var codexPackage = Path.Combine(npmRoot, "node_modules", "@openai", "codex", "package.json");
            return File.Exists(codexShim) && File.Exists(codexPackage);
        }
        catch
        {
            return false;
        }
    }

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

    private static string FormatFinalEnvelopeStatus(FinalEnvelopeStatusRecord status)
    {
        var kind = string.IsNullOrWhiteSpace(status.Kind) ? "none" : status.Kind!.Trim().ToLowerInvariant();
        if (status.Parsed)
        {
            return $"命中 {kind}";
        }
        if (status.UsedRawFallback)
        {
            return "原文兜底";
        }
        if (status.UsedLegacyCompactor)
        {
            return "旧裁剪兼容";
        }
        return "暂无记录";
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

    private string GetDefaultMemoryRepoPath()
        => Path.Combine(_ctiHome, "memory-repo");

    private string ResolveEffectiveMemoryRepoPath(string configuredPath, string defaultWorkDir, string unityProjectPath, bool appendLog = false)
    {
        var fallback = Path.GetFullPath(GetDefaultMemoryRepoPath());
        var normalized = string.IsNullOrWhiteSpace(configuredPath) ? fallback : Path.GetFullPath(configuredPath.Trim());
        var blockedRoots = new[] { defaultWorkDir, unityProjectPath }
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Select(value => Path.GetFullPath(value.Trim()))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        if (blockedRoots.Any(root => IsSameOrChildPath(normalized, root)))
        {
            if (appendLog)
            {
                AppendLog($"记忆仓库路径已自动改回工作目录外：{normalized} -> {fallback}");
            }
            return fallback;
        }

        return normalized;
    }

    private static bool IsSameOrChildPath(string candidatePath, string rootPath)
    {
        if (string.IsNullOrWhiteSpace(candidatePath) || string.IsNullOrWhiteSpace(rootPath)) return false;
        var candidate = Path.GetFullPath(candidatePath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var root = Path.GetFullPath(rootPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return string.Equals(candidate, root, StringComparison.OrdinalIgnoreCase)
            || candidate.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            || candidate.StartsWith(root + Path.AltDirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
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
    private static readonly JsonSerializerOptions WebJsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };
    private readonly record struct ProcessResult(int ExitCode, string Stdout, string Stderr);
}

internal sealed class WebCommandRequest
{
    public string? Id { get; set; }
    public string? Type { get; set; }
    public string? Command { get; set; }
    public JsonElement Payload { get; set; }
}

internal sealed record WebActivityRecord(string Level, string Title, string Message, string Timestamp);
internal sealed record WebServiceItem(string Id, string Title, string Status, string Detail);
internal sealed record WebMcpItem(
    string Id,
    string DisplayName,
    string Type,
    string Category,
    bool Enabled,
    bool IsRunning,
    int? ProcessId,
    bool IsRegistered,
    string InstallState,
    string Source,
    string Version,
    string Protocol,
    string SuiteRange,
    string[] Aliases,
    string Description);

internal sealed record WebExtensionItem(
    string Id,
    string DisplayName,
    string ManifestKind,
    string Type,
    string Category,
    bool Enabled,
    string InstallState,
    string Source,
    bool SourceExists,
    string Description,
    string ManifestPath,
    bool CanInstall);

internal sealed record ExtensionImportPreview(
    string FolderPath,
    string Kind,
    string RuntimeType,
    string Id,
    string DisplayName,
    string Source,
    string ManifestPath,
    string Description,
    string InstallState,
    bool CanImport,
    string Reason);

internal sealed record WebSessionItem(
    string DisplayName,
    string ChannelType,
    string ChatType,
    string ChatId,
    string SessionId,
    string Source,
    int LocalMessageCount,
    string LastUpdatedAt,
    string Summary);
internal sealed record WebSessionDetail(
    string DisplayName,
    string ChannelType,
    string ChatType,
    string ChatId,
    string SessionId,
    string SdkSessionId,
    string WorkingDirectory,
    string Source,
    bool HasLocalBinding,
    int LocalMessageCount,
    string LastUpdatedAt,
    string Summary,
    WebConversationMessage[] Messages,
    WebFeishuPerson[] People,
    JsonNode[] WorkflowRuns);
internal sealed record WebConversationMessage(
    int Index,
    string MessageId,
    string Role,
    string MsgType,
    string SenderId,
    string SenderType,
    string SenderName,
    string CreatedAt,
    string Content,
    WebMessageAttachment[] Attachments);
internal sealed record WebFeishuPerson(
    string UserId,
    string SenderType,
    string DisplayName,
    string Role,
    bool IsOwner,
    int MessageCount);
internal sealed record WebMessageAttachment(
    string Kind,
    string Name,
    string MimeType,
    long Size,
    string Path,
    string Url,
    string ResourceKey,
    string Status);

internal sealed class DeletedSessionRecord
{
    public string? ChatId { get; set; }
    public string? SessionId { get; set; }
    public string? DisplayName { get; set; }
    public string? DeletedAt { get; set; }
    public string? LastSeenAt { get; set; }
}

internal sealed record WebReplyPresetItem(string Name, string Value);
internal sealed class PermissionSnapshot
{
    public string Protocol { get; set; } = "cti-permissions/v1";
    public string UpdatedAt { get; set; } = "";
    public List<PermissionSubject> Subjects { get; set; } = [];
    public List<PermissionCandidate> Candidates { get; set; } = [];
}

internal sealed class PermissionSubject
{
    public string ChannelType { get; set; } = "";
    public string UserId { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string Role { get; set; } = "viewer";
    public string Source { get; set; } = "";
    public string FirstSeenAt { get; set; } = "";
    public string LastSeenAt { get; set; } = "";
    public string UpdatedAt { get; set; } = "";
}

internal sealed class PermissionCandidate
{
    public string ChannelType { get; set; } = "";
    public string UserId { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string Source { get; set; } = "";
    public int MessageCount { get; set; }
}

internal sealed record WebRuntimeAction(string Id, string Label, bool Enabled);
internal sealed record WebRuntimeUnit(
    string UnitId,
    string Id,
    string DisplayName,
    string Kind,
    string Category,
    string Status,
    string Detail,
    bool Enabled,
    string InstallState,
    string Source,
    string Cwd,
    string Version,
    string Description,
    bool CanInstall,
    WebRuntimeAction[] Actions);
internal sealed class McpManifest
{
    public string? Id { get; set; }
    public string? DisplayName { get; set; }
    public string? Type { get; set; }
    public string? Version { get; set; }
    public ExtensionCompatibility? Compatibility { get; set; }
    public string? Category { get; set; }
    public bool? Optional { get; set; }
    public string? InstallState { get; set; }
    public string? Source { get; set; }
    public string[]? Aliases { get; set; }
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
        => $"{StatusBadge ?? ""} {(DisplayName ?? Id)} [{Category ?? Type}] {(Enabled == false ? "disabled" : "enabled")}".Trim();
}

internal sealed class ExtensionCompatibility
{
    public string? Protocol { get; set; }
    public string? Suite { get; set; }
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

internal sealed class BridgeRuntimeAuditRecord
{
    public string? RunId { get; set; }
    public int Pid { get; set; }
    public string? StartedAt { get; set; }
    public string? LastHeartbeatAt { get; set; }
    public string? LastStage { get; set; }
    public string? LastStageAt { get; set; }
    public BridgeRuntimeRequestRecord? LastActiveRequest { get; set; }
    public BridgeRuntimeRequestRecord? LastCompletedRequest { get; set; }
    public string? LastExitReason { get; set; }
    public string? LastExitAt { get; set; }
    public BridgeRuntimeFeishuWsRecord? FeishuWs { get; set; }
    public BridgeRuntimeFeishuP2pPollRecord? FeishuP2pPoll { get; set; }
}

internal sealed class BridgeRuntimeRequestRecord
{
    public string? MessageId { get; set; }
    public string? ChatId { get; set; }
    public string? ChannelType { get; set; }
    public string? DisplayName { get; set; }
    public string? TextPreview { get; set; }
    public string? StartedAt { get; set; }
    public string? Stage { get; set; }
    public string? StageUpdatedAt { get; set; }
}

internal sealed class BridgeRuntimeFeishuWsRecord
{
    public string? State { get; set; }
    public string? UpdatedAt { get; set; }
    public string? LastEventType { get; set; }
    public string? LastEventAt { get; set; }
    public string? LastError { get; set; }
    public string? LastDisconnectReason { get; set; }
}

internal sealed class BridgeRuntimeFeishuP2pPollRecord
{
    public string? State { get; set; }
    public string? UpdatedAt { get; set; }
    public string? LastPollAt { get; set; }
    public string? LastRecoveredMessageId { get; set; }
    public string? LastRecoveredChatId { get; set; }
    public string? LastError { get; set; }
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

internal sealed class FinalEnvelopeStatusRecord
{
    public bool Parsed { get; set; }
    public string? Kind { get; set; }
    public bool UsedRawFallback { get; set; }
    public bool UsedLegacyCompactor { get; set; }
    public string? UpdatedAt { get; set; }
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

internal sealed class StoredFileAttachmentMeta
{
    public string? Id { get; set; }
    public string? Name { get; set; }
    public string? Type { get; set; }
    public long Size { get; set; }
    public string? FilePath { get; set; }
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
    public string RawContent { get; set; } = "";
    public string ResourceKey { get; set; } = "";
    public string ResourceType { get; set; } = "";
    public string FileName { get; set; } = "";
    public bool HasMore { get; set; }
    public string? NextPageToken { get; set; }
}

internal sealed class StoredContentBlock
{
    public string? Type { get; set; }
    public string? Name { get; set; }
    public string? Text { get; set; }
    public string? Content { get; set; }
    public string? Path { get; set; }
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
    public string MessageId { get; set; } = "";
    public string Role { get; set; } = "";
    public string MsgType { get; set; } = "";
    public string SenderId { get; set; } = "";
    public string SenderType { get; set; } = "";
    public string SenderName { get; set; } = "";
    public DateTime? CreatedAt { get; set; }
    public string Content { get; set; } = "";
    public List<ConversationAttachmentView> Attachments { get; set; } = [];
}

internal sealed record ConversationAttachmentView(
    string Kind,
    string Name,
    string MimeType,
    long Size,
    string Path,
    string Url,
    string ResourceKey,
    string Status);

internal sealed record SettingsSnapshot(
    string DefaultWorkDir,
    string AllowedRoots,
    string UnityProject,
    string MemoryRepo,
    string AdditionalDirs,
    string ReplyStyleHint);

internal sealed record HistorySearchQuery(
    string Chat,
    string Keyword,
    string Speaker,
    string Start,
    string End);

internal sealed class SettingsForm : Form
{
    private readonly TextBox _workdir = new();
    private readonly TextBox _allowedRoots = new();
    private readonly TextBox _unityProject = new();
    private readonly TextBox _memoryRepo = new();
    private readonly TextBox _additionalDirs = new();
    private readonly ComboBox _replyStylePreset = new();
    private readonly TextBox _replyStyleRequest = new();
    private readonly TextBox _replyStyleHint = new();
    private readonly IReadOnlyDictionary<string, string> _presets;
    private readonly Func<string, Task<string>> _summarizeReplyStyleAsync;
    private readonly Action<SettingsSnapshot> _saveSettings;
    private readonly Action<string> _openPath;

    public SettingsForm(
        SettingsSnapshot settings,
        IReadOnlyDictionary<string, string> presets,
        Func<string, Task<string>> summarizeReplyStyleAsync,
        Action<SettingsSnapshot> saveSettings,
        Action<string> openPath)
    {
        _presets = presets;
        _summarizeReplyStyleAsync = summarizeReplyStyleAsync;
        _saveSettings = saveSettings;
        _openPath = openPath;

        Text = "设置";
        Width = 920;
        Height = 640;
        MinimumSize = new Size(820, 560);
        StartPosition = FormStartPosition.CenterParent;
        Font = new Font("Microsoft YaHei UI", 9F);

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, Padding = new Padding(10) };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 220));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
        Controls.Add(root);

        root.Controls.Add(BuildPathGroup(), 0, 0);
        root.Controls.Add(BuildReplyStyleGroup(), 0, 1);

        var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false };
        var save = new Button { Text = "保存配置", Width = 110, Height = 30 };
        save.Click += (_, _) =>
        {
            _saveSettings(ReadSnapshot());
            MessageBox.Show(this, "配置已保存。回复风格将在重启飞书桥接后生效。", "设置", MessageBoxButtons.OK, MessageBoxIcon.Information);
            Close();
        };
        var cancel = new Button { Text = "取消", Width = 88, Height = 30 };
        cancel.Click += (_, _) => Close();
        buttons.Controls.Add(save);
        buttons.Controls.Add(cancel);
        root.Controls.Add(buttons, 0, 2);

        LoadSnapshot(settings);
    }

    private Control BuildPathGroup()
    {
        var group = new GroupBox { Text = "路径配置", Dock = DockStyle.Fill };
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 5, Padding = new Padding(8) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 100));
        for (var i = 0; i < 5; i++) layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        group.Controls.Add(layout);

        AddPathRow(layout, 0, "默认工作目录", _workdir, true);
        AddPathRow(layout, 1, "允许仓库根目录", _allowedRoots, false);
        AddPathRow(layout, 2, "Unity 工程目录", _unityProject, true);
        AddPathRow(layout, 3, "聊天记忆仓库", _memoryRepo, true);
        AddPathRow(layout, 4, "Codex 附加目录", _additionalDirs, false);
        return group;
    }

    private Control BuildReplyStyleGroup()
    {
        var group = new GroupBox { Text = "回复风格", Dock = DockStyle.Fill };
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 5, Padding = new Padding(8) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 92));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        group.Controls.Add(layout);

        layout.Controls.Add(new Label { Text = "风格预设", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight }, 0, 0);
        _replyStylePreset.Dock = DockStyle.Fill;
        _replyStylePreset.DropDownStyle = ComboBoxStyle.DropDownList;
        _replyStylePreset.Items.Add("自定义");
        foreach (var key in _presets.Keys) _replyStylePreset.Items.Add(key);
        _replyStylePreset.SelectedIndexChanged += (_, _) =>
        {
            var selected = _replyStylePreset.SelectedItem as string;
            if (string.IsNullOrWhiteSpace(selected) || selected == "自定义") return;
            if (_presets.TryGetValue(selected, out var preset)) _replyStyleHint.Text = preset;
        };
        layout.Controls.Add(_replyStylePreset, 1, 0);

        layout.Controls.Add(new Label { Text = "风格要求", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight }, 0, 1);
        _replyStyleRequest.Dock = DockStyle.Fill;
        _replyStyleRequest.Multiline = true;
        _replyStyleRequest.ScrollBars = ScrollBars.Vertical;
        _replyStyleRequest.PlaceholderText = "例如：回复像项目助理，先说结果，再说一句影响，不要解释思考过程。";
        layout.Controls.Add(_replyStyleRequest, 1, 1);

        var summarize = new Button { Text = "本地AI整理", Dock = DockStyle.Fill };
        summarize.Click += async (_, _) =>
        {
            try
            {
                summarize.Enabled = false;
                _replyStyleHint.Text = await _summarizeReplyStyleAsync(_replyStyleRequest.Text);
                _replyStylePreset.SelectedItem = "自定义";
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, "本地AI整理", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            finally
            {
                summarize.Enabled = true;
            }
        };
        layout.Controls.Add(summarize, 2, 1);

        layout.Controls.Add(new Label { Text = "当前风格", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight }, 0, 2);
        _replyStyleHint.Dock = DockStyle.Fill;
        _replyStyleHint.Multiline = true;
        _replyStyleHint.ScrollBars = ScrollBars.Vertical;
        _replyStyleHint.PlaceholderText = "例如：回复像项目助理，先说结果，再说一句影响，不要解释思考过程。";
        layout.Controls.Add(_replyStyleHint, 1, 2);

        var hint = new Label { Text = "保存后重启飞书桥接生效。", Dock = DockStyle.Fill, ForeColor = Color.DimGray, TextAlign = ContentAlignment.MiddleLeft };
        layout.SetColumnSpan(hint, 2);
        layout.Controls.Add(hint, 1, 3);
        return group;
    }

    private void AddPathRow(TableLayoutPanel layout, int row, string label, TextBox box, bool browseFolder)
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
                if (dialog.ShowDialog(this) == DialogResult.OK) box.Text = dialog.SelectedPath;
                return;
            }
            var first = box.Text.Split(';', ',').Select(s => s.Trim()).FirstOrDefault(p => File.Exists(p) || Directory.Exists(p));
            if (!string.IsNullOrWhiteSpace(first)) _openPath(first);
        };
        layout.Controls.Add(browse, 2, row);
    }

    private void LoadSnapshot(SettingsSnapshot settings)
    {
        _workdir.Text = settings.DefaultWorkDir;
        _allowedRoots.Text = settings.AllowedRoots;
        _unityProject.Text = settings.UnityProject;
        _memoryRepo.Text = settings.MemoryRepo;
        _additionalDirs.Text = settings.AdditionalDirs;
        _replyStyleHint.Text = settings.ReplyStyleHint;
        _replyStylePreset.SelectedItem = ResolveReplyStylePreset(settings.ReplyStyleHint);
    }

    private SettingsSnapshot ReadSnapshot() => new(
        _workdir.Text,
        _allowedRoots.Text,
        _unityProject.Text,
        _memoryRepo.Text,
        _additionalDirs.Text,
        _replyStyleHint.Text);

    private string ResolveReplyStylePreset(string value)
    {
        foreach (var pair in _presets)
        {
            if (string.Equals(pair.Value, value, StringComparison.Ordinal)) return pair.Key;
        }
        return "自定义";
    }
}

internal sealed class ConversationViewerForm : Form
{
    public ConversationViewerForm(
        List<ConversationEntry> entries,
        string dataDir,
        Func<ConversationEntry, Task<ConversationEntry>>? detailLoader,
        Func<HistorySearchQuery, List<HistorySearchHit>> searchHistory,
        Func<List<HistorySearchHit>, string> formatHistoryResults,
        Func<bool, string> getSyncStatusText,
        Func<Task<string>> syncAllHistoryAsync)
    {
        Text = "会话记录查看";
        Width = 1220;
        Height = 820;
        StartPosition = FormStartPosition.CenterParent;
        Font = new Font("Microsoft YaHei UI", 9F);

        var tabs = new TabControl { Dock = DockStyle.Fill, Padding = new Point(12, 4) };
        Controls.Add(tabs);

        var header = new Label { Dock = DockStyle.Fill, Text = $"远端飞书会话优先，本地存档为辅：{dataDir}", TextAlign = ContentAlignment.MiddleLeft, ForeColor = Color.DimGray };
        var conversationPage = new TabPage("会话记录");
        var conversationRoot = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Padding = new Padding(10) };
        conversationRoot.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        conversationRoot.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        conversationPage.Controls.Add(conversationRoot);
        conversationRoot.Controls.Add(header, 0, 0);

        var contentLayout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 };
        contentLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 380));
        contentLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        conversationRoot.Controls.Add(contentLayout, 0, 1);

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

        tabs.TabPages.Add(conversationPage);
        tabs.TabPages.Add(BuildHistorySearchPage(searchHistory, formatHistoryResults));
        tabs.TabPages.Add(BuildSyncStatusPage(getSyncStatusText, syncAllHistoryAsync));
    }

    private static TabPage BuildHistorySearchPage(Func<HistorySearchQuery, List<HistorySearchHit>> searchHistory, Func<List<HistorySearchHit>, string> formatHistoryResults)
    {
        var page = new TabPage("历史索引");
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 6, RowCount = 4, Padding = new Padding(10) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 78));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 34));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 78));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 34));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 78));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 32));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        page.Controls.Add(layout);

        var chat = new TextBox { Dock = DockStyle.Fill };
        var keyword = new TextBox { Dock = DockStyle.Fill };
        var speaker = new TextBox { Dock = DockStyle.Fill };
        var start = new TextBox { Dock = DockStyle.Fill, PlaceholderText = "2026-04-15 09:00" };
        var end = new TextBox { Dock = DockStyle.Fill, PlaceholderText = "2026-04-15 18:00" };
        var results = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false, Font = new Font("Consolas", 9F) };

        layout.Controls.Add(new Label { Text = "群名/Chat", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight }, 0, 0);
        layout.Controls.Add(chat, 1, 0);
        layout.Controls.Add(new Label { Text = "关键词", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight }, 2, 0);
        layout.Controls.Add(keyword, 3, 0);
        layout.Controls.Add(new Label { Text = "发言人", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight }, 4, 0);
        layout.Controls.Add(speaker, 5, 0);
        layout.Controls.Add(new Label { Text = "开始时间", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight }, 0, 1);
        layout.Controls.Add(start, 1, 1);
        layout.Controls.Add(new Label { Text = "结束时间", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleRight }, 2, 1);
        layout.Controls.Add(end, 3, 1);

        var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
        var search = new Button { Text = "检索历史", Width = 96, Height = 28 };
        search.Click += (_, _) =>
        {
            try
            {
                var hits = searchHistory(new HistorySearchQuery(chat.Text, keyword.Text, speaker.Text, start.Text, end.Text));
                results.Text = formatHistoryResults(hits);
            }
            catch (Exception ex)
            {
                results.Text = $"检索失败：{ex.Message}";
            }
        };
        var clear = new Button { Text = "清空条件", Width = 96, Height = 28 };
        clear.Click += (_, _) =>
        {
            chat.Clear();
            keyword.Clear();
            speaker.Clear();
            start.Clear();
            end.Clear();
            results.Clear();
        };
        buttons.Controls.Add(search);
        buttons.Controls.Add(clear);
        layout.SetColumnSpan(buttons, 3);
        layout.Controls.Add(buttons, 3, 2);
        layout.SetColumnSpan(results, 6);
        layout.Controls.Add(results, 0, 3);
        return page;
    }

    private static TabPage BuildSyncStatusPage(Func<bool, string> getSyncStatusText, Func<Task<string>> syncAllHistoryAsync)
    {
        var page = new TabPage("同步状态");
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Padding = new Padding(10) };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        page.Controls.Add(layout);

        var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
        var refresh = new Button { Text = "刷新状态", Width = 96, Height = 28 };
        var syncAll = new Button { Text = "同步全部历史", Width = 118, Height = 28 };
        var status = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, WordWrap = false, Font = new Font("Consolas", 9F) };
        refresh.Click += (_, _) => status.Text = getSyncStatusText(true);
        syncAll.Click += async (_, _) =>
        {
            syncAll.Enabled = false;
            try { status.Text = await syncAllHistoryAsync(); }
            catch (Exception ex) { status.Text = $"同步失败：{ex.Message}"; }
            finally { syncAll.Enabled = true; }
        };
        buttons.Controls.Add(refresh);
        buttons.Controls.Add(syncAll);
        layout.Controls.Add(buttons, 0, 0);
        layout.Controls.Add(status, 0, 1);
        status.Text = getSyncStatusText(true);
        return page;
    }
}
