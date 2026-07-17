using System.Diagnostics;
using System.Globalization;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using System.Xml.Linq;
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

internal sealed partial class MainForm : Form
{
    private const string WebHostName = "control-panel.local";
    private const string MediaHostName = "control-panel-media.local";
    private const string OfficialControlPanelExeName = "CodexImSuiteControlPanel.exe";
    private const string LegacyControlPanelExeName = "ClaudeToImControlPanel.exe";
    private const string MemoryV2Schema = "codex-im-suite/memory/v2";
    private const uint CodePageGb2312 = 936;
    private static readonly string[] OllamaRelativeExecutableCandidates =
    [
        @"Programs\OllamaPortable\app\ollama.exe",
        @"Programs\Ollama\ollama.exe",
        @"Ollama\ollama.exe",
    ];
    private readonly string _skillDir;
    private readonly string _ctiHome;
    private readonly string _configPath;
    private readonly string _daemonScript;
    private readonly string _registerMcpScript;
    private readonly string _manifestDir;
    private readonly string _skillsManifestDir;
    private readonly string _pluginsManifestDir;
    private readonly string _userExtensionRoot;
    private readonly string _extensionDownloadsDir;
    private readonly string _extensionPackagesDir;
    private readonly string _extensionLaunchersDir;
    private readonly string _extensionManifestRoot;
    private readonly string _userMcpManifestDir;
    private readonly string _userSkillsManifestDir;
    private readonly string _userPluginsManifestDir;
    private readonly string _extensionCatalogSeedPath;
    private readonly string _extensionCatalogDynamicCachePath;
    private readonly string _extensionLockPath;
    private readonly object _extensionInstallJobLock = new();
    private readonly Dictionary<string, ExtensionInstallJobState> _extensionInstallJobs = new(StringComparer.OrdinalIgnoreCase);
    private readonly string _suiteRoot;
    private readonly string _publishBackupScript;
    private readonly string _mainReleaseScript;
    private readonly string _syncLiveSkillScript;
    private readonly string _localLlmStartScript;
    private readonly string _localLlmStopScript;
    private readonly string _localLlmHealthcheckScript;
    private readonly string _localLlmReadmePath;
    private readonly string _dataDir;
    private readonly string _messagesDir;
    private readonly string _auditJsonPath;
    private readonly string _outboundRefsPath;
    private readonly string _statusJsonPath;
    private readonly string _mcpServiceStatePath;
    private readonly string _localLlmStatusPath;
    private readonly string _localModelCapabilityPath;
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
    private readonly object _permissionFileLock = new();
    private FileSystemWatcher? _manifestWatcher;
    private readonly List<FileSystemWatcher> _manifestWatchers = [];
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
        _userExtensionRoot = Path.Combine(_ctiHome, "extensions");
        _extensionDownloadsDir = Path.Combine(_userExtensionRoot, "downloads");
        _extensionPackagesDir = Path.Combine(_userExtensionRoot, "packages");
        _extensionLaunchersDir = Path.Combine(_userExtensionRoot, "launchers");
        _extensionManifestRoot = Path.Combine(_userExtensionRoot, "manifests");
        _userMcpManifestDir = Path.Combine(_extensionManifestRoot, "mcp.d");
        _userSkillsManifestDir = Path.Combine(_extensionManifestRoot, "skills.d");
        _userPluginsManifestDir = Path.Combine(_extensionManifestRoot, "plugins.d");
        _extensionCatalogSeedPath = string.IsNullOrWhiteSpace(_suiteRoot)
            ? Path.Combine(_skillDir, "config", "extension-catalog.json")
            : Path.Combine(_suiteRoot, "config", "extension-catalog.json");
        _extensionCatalogDynamicCachePath = Path.Combine(_ctiHome, "runtime", "extension-catalog-dynamic-cache.json");
        _extensionLockPath = Path.Combine(_userExtensionRoot, "installed-lock.json");
        _publishBackupScript = string.IsNullOrWhiteSpace(_suiteRoot) ? "" : Path.Combine(_suiteRoot, "scripts", "publish-backup.ps1");
        _mainReleaseScript = string.IsNullOrWhiteSpace(_suiteRoot) ? "" : Path.Combine(_suiteRoot, "scripts", "prepare-main-release.ps1");
        _syncLiveSkillScript = string.IsNullOrWhiteSpace(_suiteRoot) ? "" : Path.Combine(_suiteRoot, "scripts", "sync-live-skill.ps1");
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
        _outboundRefsPath = Path.Combine(_dataDir, "outbound-refs.json");
        _statusJsonPath = Path.Combine(_ctiHome, "runtime", "status.json");
        _mcpServiceStatePath = Path.Combine(_ctiHome, "runtime", "mcp-services.json");
        _localLlmStatusPath = Path.Combine(_ctiHome, "runtime", "local-llm-status.json");
        _localModelCapabilityPath = Path.Combine(_ctiHome, "runtime", "local-model-capabilities.json");
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

        var requestedPort = _controlApiPort;
        var maxAttempts = IsLoopbackBindHost(_controlApiBindHost) && string.IsNullOrWhiteSpace(GetConfig("CTI_CONTROL_API_PUBLIC_BASE_URL", "").Trim())
            ? 20
            : 1;
        Exception? lastError = null;
        for (var attempt = 0; attempt < maxAttempts; attempt++)
        {
            var candidatePort = requestedPort + attempt;
            try
            {
                _controlApi = await StartControlApiOnPortAsync(webRoot, candidatePort);
                _controlApiPort = candidatePort;
                if (attempt > 0)
                {
                    AddWebActivity("warning", "Control API 端口自动切换", $"端口 {requestedPort} 已被占用，已改用 {_controlApiPort}。");
                }
                break;
            }
            catch (Exception ex) when (IsPortInUseException(ex))
            {
                lastError = ex;
                if (attempt + 1 >= maxAttempts) break;
            }
            catch (Exception ex)
            {
                lastError = ex;
                break;
            }
        }
        if (_controlApi is null)
        {
            var message = lastError is null ? "未知错误" : lastError.Message;
            AddWebActivity("error", "Control API 启动失败", message);
            if (maxAttempts == 1 || !IsLoopbackBindHost(_controlApiBindHost))
            {
                throw new InvalidOperationException($"Control API 启动失败：{message}", lastError);
            }
            return;
        }
        _controlApiBaseUrl = GetConfig("CTI_CONTROL_API_PUBLIC_BASE_URL", "").Trim().TrimEnd('/');
        if (string.IsNullOrWhiteSpace(_controlApiBaseUrl))
        {
            var browserHost = IsWildcardBindHost(_controlApiBindHost) ? "127.0.0.1" : _controlApiBindHost;
            _controlApiBaseUrl = $"http://{browserHost}:{_controlApiPort}";
        }
        AddWebActivity("info", "Control API 已启动", _controlApiBaseUrl);
    }

    private async Task<WebApplication> StartControlApiOnPortAsync(string webRoot, int port)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            Args = [],
            ContentRootPath = AppContext.BaseDirectory,
        });
        builder.WebHost.UseUrls($"http://{_controlApiBindHost}:{port}");
        var app = builder.Build();
        ConfigureControlApi(app, webRoot);
        try
        {
            await app.StartAsync();
            return app;
        }
        catch
        {
            await app.DisposeAsync();
            throw;
        }
    }

    private static bool IsPortInUseException(Exception ex)
    {
        for (var current = ex; current is not null; current = current.InnerException)
        {
            if (current is SocketException socket && socket.SocketErrorCode == SocketError.AddressAlreadyInUse)
            {
                return true;
            }
            if (current is IOException io && io.Message.Contains("address", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
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
            if (!AuthorizeControlApi(context, request.Command, out var failure, request.Payload)) return failure;
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

    private bool AuthorizeControlApi(HttpContext context, string command, out IResult failure, JsonElement payload = default)
    {
        failure = Results.Empty;
        var remoteIp = context.Connection.RemoteIpAddress;
        var isLoopback = remoteIp is null || IPAddress.IsLoopback(remoteIp);
        var requiredRole = RequiredRoleForControlCommand(command, payload);
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

    private static string RequiredRoleForControlCommand(string command, JsonElement payload = default)
    {
        var skillRole = SkillControlCommandPolicy.GetRequiredRole(command);
        if (!string.IsNullOrWhiteSpace(skillRole)) return skillRole;
        if (string.Equals(command, "runtime.invokeAction", StringComparison.OrdinalIgnoreCase)
            && payload.ValueKind == JsonValueKind.Object)
        {
            var action = ReadJsonString(payload, "action").Trim().ToLowerInvariant();
            if (action is "install" or "update" or "enable" or "disable" or "remove" or "rollback")
            {
                return "owner";
            }
        }
        if (string.Equals(command, "extension.remote.install", StringComparison.OrdinalIgnoreCase)
            || string.Equals(command, "extension.remote.remove", StringComparison.OrdinalIgnoreCase))
        {
            return "owner";
        }
        if (command.StartsWith("permissions.", StringComparison.OrdinalIgnoreCase)
            || command.StartsWith("release.", StringComparison.OrdinalIgnoreCase)
            || command.StartsWith("live.", StringComparison.OrdinalIgnoreCase)
            || string.Equals(command, "security.addFeishuOwner", StringComparison.OrdinalIgnoreCase))
        {
            return "owner";
        }
        if (command.StartsWith("bridge.", StringComparison.OrdinalIgnoreCase)
            || string.Equals(command, "history.recallBotMessage", StringComparison.OrdinalIgnoreCase)
            || command.StartsWith("panel.", StringComparison.OrdinalIgnoreCase)
            || command.StartsWith("mcp.", StringComparison.OrdinalIgnoreCase)
            || command.StartsWith("localLlm.", StringComparison.OrdinalIgnoreCase)
            || command.StartsWith("ollama.", StringComparison.OrdinalIgnoreCase)
            || string.Equals(command, "runtime.invokeAction", StringComparison.OrdinalIgnoreCase)
            || string.Equals(command, "settings.save", StringComparison.OrdinalIgnoreCase)
            || string.Equals(command, "settings.saveAndRestartBridge", StringComparison.OrdinalIgnoreCase)
            || string.Equals(command, "memory.updateFeishuSticker", StringComparison.OrdinalIgnoreCase)
            || string.Equals(command, "memory.auditFeishuStickers", StringComparison.OrdinalIgnoreCase)
            || string.Equals(command, "memory.mergeFeishuStickerAliases", StringComparison.OrdinalIgnoreCase)
            || string.Equals(command, "memory.archiveFeishuSticker", StringComparison.OrdinalIgnoreCase)
            || string.Equals(command, "memory.restoreFeishuSticker", StringComparison.OrdinalIgnoreCase)
            || command.StartsWith("extension.", StringComparison.OrdinalIgnoreCase))
        {
            return "operator";
        }
        if (string.Equals(command, "memory.deleteFeishuSticker", StringComparison.OrdinalIgnoreCase))
        {
            return "owner";
        }
        return "viewer";
    }

    private void AddControlApiAudit(HttpContext context, string command, JsonElement payload, bool ok, string error)
    {
        var role = RequiredRoleForControlCommand(command, payload);
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
        => string.Equals(command, "history.getSessionDetail", StringComparison.OrdinalIgnoreCase)
           || string.Equals(command, "extension.installJobs", StringComparison.OrdinalIgnoreCase);

    private async Task<object?> ExecuteWebCommandAsync(string command, JsonElement payload)
    {
        switch (command)
        {
            case "state.refresh":
                await RefreshAllAsync();
                return await BuildWebStateAsync();
            case "nodes.list":
                {
                    var suite = ReadSuiteVersionInfo();
                    var services = new[]
                    {
                        BuildServiceItem("bridge", "飞书桥接", _bridgeStatus.Text),
                        BuildServiceItem("codex", "Codex CLI", _codexStatus.Text),
                        BuildServiceItem("localLlm", "本地模型 API", _localLlmStatus.Text),
                        BuildServiceItem("mcp", "MCP 清单", _mcpStatus.Text),
                        BuildServiceItem("version", "版本 / 扩展", _buildStatus.Text),
                    };
                    return BuildNodeSnapshot(suite.Version, services, BuildMcpItems(), ReadExtensionStatus());
                }
            case "panel.restart":
                return await RestartControlPanelAsync();
            case "live.sync":
                return await SyncLiveSkillAsync();
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
            case "localLlm.probeTools":
                return await ProbeLocalLlmToolCallingAsync(payload);
            case "ollama.start":
                await StartLocalLlmAsync();
                return _localLlmStatus.Text;
            case "ollama.stop":
                await StopLocalLlmAsync();
                return _localLlmStatus.Text;
            case "ollama.check":
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
                await PublishSuiteAsync(requireConfirmation: false);
                return "publish backup finished";
            case "release.prepareMainRelease":
                await PrepareMainReleaseAsync(requireConfirmation: false);
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
            case "settings.saveAndRestartBridge":
                var settingsForRestart = ReadSettingsPayload(payload);
                SaveSettingsFromDialog(settingsForRestart);
                await EnsureLocalApiReadyForSettingsAsync(settingsForRestart);
                await RestartBridgeAsync();
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
            case "history.recallBotMessage":
                return await RecallBotMessageAsync(payload);
            case "history.deleteSession":
                return await DeleteSessionAsync(payload);
            case "memory.status":
                return BuildKnowledgeIndexStatus();
            case "memory.search":
                return SearchKnowledgeIndex(payload);
            case "memory.feishuStickers":
                return FeishuStickerLibrary.Read(GetMemoryArtifactStore());
            case "memory.auditFeishuStickers":
                return FeishuStickerLibrary.Audit(GetMemoryArtifactStore());
            case "memory.updateFeishuSticker":
                return FeishuStickerLibrary.Update(GetMemoryArtifactStore(), ReadFeishuStickerUpdatePayload(payload));
            case "memory.mergeFeishuStickerAliases":
                return FeishuStickerLibrary.MergeAliases(GetMemoryArtifactStore(), ReadFeishuStickerAliasMergePayload(payload));
            case "memory.archiveFeishuSticker":
                return FeishuStickerLibrary.Archive(GetMemoryArtifactStore(), ReadFeishuStickerLifecyclePayload(payload));
            case "memory.restoreFeishuSticker":
                return FeishuStickerLibrary.Restore(GetMemoryArtifactStore(), ReadFeishuStickerLifecyclePayload(payload));
            case "memory.deleteFeishuSticker":
                return FeishuStickerLibrary.DeleteArchived(GetMemoryArtifactStore(), ReadFeishuStickerLifecyclePayload(payload));
            case "memory.archiveItem":
                return ArchiveKnowledgeItem(payload);
            case "memory.archives":
                return BuildKnowledgeArchiveSnapshot();
            case "memory.deleteArchive":
                return DeleteKnowledgeArchive(payload);
            case "memory.restoreArchive":
                return await RunMemoryOptimizerCliAsync("restore-archive", payload);
            case "memory.optimizeStatus":
                return BuildMemoryOptimizationStatusSnapshot();
            case "memory.optimizePreview":
                return await RunMemoryOptimizerCliAsync("preview", payload);
            case "memory.optimizeApply":
                return await RunMemoryOptimizerCliAsync("apply", payload);
            case "memory.optimizeUndo":
                return await RunMemoryOptimizerCliAsync("undo", payload);
            case "memory.optimizeDiscard":
                return await RunMemoryOptimizerCliAsync("discard", payload);
            case "memory.optimizeSchedule":
                return await RunMemoryOptimizerCliAsync("schedule", payload);
            case "memory.reminders":
            case "memory.checkReminders":
                return BuildTodoReminderSnapshot();
            case "memory.testReminder":
                return await TestTodoReminderAsync(payload);
            case "memory.completeReminder":
                return CompleteTodoReminder(payload);
            case "memory.openSource":
                OpenPath(ReadPayloadString(payload, "path", ""));
                return "opened";
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
                return await PickFolderAsync(ReadPayloadString(payload, "currentPath", ""));
            case "path.pickFile":
                return await PickFileAsync(ReadPayloadString(payload, "currentPath", ""));
            case "settings.listReplyPresets":
                return BuildReplyPresetItems();
            case "settings.applyReplyPreset":
                return ApplyReplyPreset(ReadPayloadString(payload, "name", ""));
            case "settings.summarizeReplyStyle":
                return await SummarizeReplyStyleAsync(ReadPayloadString(payload, "text", ""));
            case "settings.testLocalAi":
                return await TestLocalAiSettingsAsync(payload);
            case "settings.testLocalTools":
                return await ProbeLocalLlmToolCallingAsync(payload);
            case "settings.testCodexApi":
                return TestCodexApiSettings(payload);
            case "runtime.listUnits":
                return BuildRuntimeUnits();
            case "runtime.invokeAction":
                return await InvokeRuntimeUnitActionAsync(payload);
            case "skill.registry.snapshot":
                return await RunSkillLifecycleCommandAsync("snapshot", payload, includePanelActor: false);
            case "skill.catalog.search":
                return await RunSkillLifecycleCommandAsync("search", payload, includePanelActor: false);
            case "skill.draft.create":
                return await RunSkillLifecycleCommandAsync("create-draft", payload, includePanelActor: true);
            case "skill.lifecycle.validate":
                return await RunSkillLifecycleCommandAsync("validate", payload, includePanelActor: false);
            case "skill.lifecycle.prepareInstall":
                return await RunSkillLifecycleCommandAsync("prepare-install", payload, includePanelActor: true);
            case "skill.lifecycle.confirmInstall":
                return await RunSkillLifecycleCommandAsync("confirm-install", payload, includePanelActor: true);
            case "skill.lifecycle.enable":
                return await RunSkillLifecycleCommandAsync("enable", payload, includePanelActor: true);
            case "skill.lifecycle.disable":
                return await RunSkillLifecycleCommandAsync("disable", payload, includePanelActor: true);
            case "skill.lifecycle.rollback":
                return await RunSkillLifecycleCommandAsync("rollback", payload, includePanelActor: true);
            case "extension.enable":
                if (TryGetSkillManifestItem(ReadPayloadString(payload, "manifestPath", ""), out var enabledSkill))
                {
                    return await RunSkillLifecycleCommandAsync("enable", JsonSerializer.SerializeToElement(new { id = enabledSkill.Id }), includePanelActor: true);
                }
                await SetExtensionEnabledAsync(ReadPayloadString(payload, "manifestPath", ""), true);
                return "enabled";
            case "extension.disable":
                if (TryGetSkillManifestItem(ReadPayloadString(payload, "manifestPath", ""), out var disabledSkill))
                {
                    return await RunSkillLifecycleCommandAsync("disable", JsonSerializer.SerializeToElement(new { id = disabledSkill.Id }), includePanelActor: true);
                }
                await SetExtensionEnabledAsync(ReadPayloadString(payload, "manifestPath", ""), false);
                return "disabled";
            case "extension.remove":
                await RemoveExtensionAsync(ReadPayloadString(payload, "manifestPath", ""));
                return "removed";
            case "extension.install":
                if (TryGetSkillManifestItem(ReadPayloadString(payload, "manifestPath", ""), out var installSkill))
                {
                    return await PrepareSkillManifestInstallAsync(installSkill);
                }
                await InstallExtensionAsync(ReadPayloadString(payload, "manifestPath", ""));
                return "installed";
            case "extension.detectImport":
                return DetectExtensionImport(ReadPayloadString(payload, "folderPath", ""));
            case "extension.importFromFolder":
                return await ImportExtensionFromFolderAsync(
                    ReadPayloadString(payload, "folderPath", ""),
                    ReadPayloadString(payload, "kind", ""),
                    ReadPayloadString(payload, "runtimeType", ""));
            case "extension.catalog.list":
            case "extension.catalog.refresh":
                return await BuildExtensionCatalogSnapshotAsync(forceRefresh: string.Equals(command, "extension.catalog.refresh", StringComparison.OrdinalIgnoreCase));
            case "extension.remote.preview":
                return await PreviewRemoteExtensionAsync(ReadPayloadString(payload, "url", ""));
            case "extension.remote.install":
                return await InstallRemoteExtensionAsync(payload);
            case "extension.remote.remove":
                return RemoveRemoteExtension(payload);
            case "extension.installJobs":
                return GetExtensionInstallJobs();
            case "extension.model.install.start":
                return await StartModelInstallJobAsync(payload);
            case "extension.model.install.cancel":
                return CancelModelInstallJob(payload);
            case "extension.model.remove":
                return await RemoveModelAsync(payload);
            case "extension.model.use":
                return await UseLocalModelAsync(payload);
            case "workflow.listRuns":
                return ListWorkflowRuns();
            case "workflow.getRun":
                return GetWorkflowRun(payload);
            case "workflow.getEvents":
                return GetWorkflowEvents(payload);
            case "workflow.retryRun":
                return RetryWorkflowRun(payload);
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
        if (InvokeRequired)
        {
            var completion = new TaskCompletionSource();
            BeginInvoke(async () =>
            {
                try
                {
                    await PushWebStateAsync();
                    completion.SetResult();
                }
                catch (Exception ex)
                {
                    completion.SetException(ex);
                }
            });
            await completion.Task;
            return;
        }
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
        var skillGovernance = await BuildSkillGovernanceStateAsync();
        var promptSnapshots = BuildPromptSnapshotState();
        var memorySkillAssets = MemoryArtifactStore.BuildSkillAssetIndex(skillGovernance.Snapshot ?? default);
        var services = new[]
        {
            BuildServiceItem("bridge", "飞书桥接", _bridgeStatus.Text),
            BuildServiceItem("codex", "Codex CLI", _codexStatus.Text),
            BuildServiceItem("localLlm", "本地模型 API", _localLlmStatus.Text),
            BuildServiceItem("mcp", "MCP 清单", _mcpStatus.Text),
            BuildServiceItem("version", "版本 / 扩展", _buildStatus.Text),
        };
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
            services,
            nodes = BuildNodeSnapshot(suite.Version, services, mcpItems, extensions),
            extensions = new
            {
                total = extensions.Total,
                enabled = extensions.Enabled,
                disabled = extensions.Disabled,
                missingSources = extensions.MissingSources,
                items = BuildExtensionItems(),
            },
            skillGovernance,
            promptSnapshots,
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
            liveSync = BuildLiveSyncStatus(commit),
            settings = GetSettingsSnapshot(),
            history = new
            {
                status = GetFeishuHistorySyncStatusText(full: false),
                sessions = sessionItems.Take(80).ToArray(),
            },
            memory = BuildKnowledgeIndexStatus(),
            memorySkillAssets,
            memoryReminders = BuildTodoReminderSnapshot(),
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

    private WebLiveSyncStatus BuildLiveSyncStatus(string suiteCommit)
    {
        var canSync = !string.IsNullOrWhiteSpace(_suiteRoot) && File.Exists(_syncLiveSkillScript);
        var legacyPanelPath = Path.Combine(_skillDir, "dist", "control-panel", LegacyControlPanelExeName);
        var legacyEntryPresent = File.Exists(legacyPanelPath);
        if (string.IsNullOrWhiteSpace(_suiteRoot) || !Directory.Exists(_suiteRoot) || string.IsNullOrWhiteSpace(_skillDir))
        {
            return new WebLiveSyncStatus("unavailable", "", suiteCommit, "", "Live 同步状态不可用", canSync, "未找到开发版 suiteRoot 或 live skill 路径。");
        }

        var fingerprintPath = Path.Combine(_skillDir, ".suite-release.json");
        if (!File.Exists(fingerprintPath))
        {
            return new WebLiveSyncStatus("missing", "", suiteCommit, "", "Live 未记录同步时间", canSync, fingerprintPath, legacyEntryPresent, legacyPanelPath);
        }

        try
        {
            using var stream = new FileStream(fingerprintPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var doc = JsonDocument.Parse(stream);
            var root = doc.RootElement;
            var lastSyncedAt = ReadJsonString(root, "generatedAt");
            var liveCommit = "";
            if (root.TryGetProperty("suite", out var suiteElement))
            {
                liveCommit = ReadJsonString(suiteElement, "commit");
            }
            if (string.IsNullOrWhiteSpace(lastSyncedAt))
            {
                return new WebLiveSyncStatus("missing", "", suiteCommit, liveCommit, "Live 未记录同步时间", canSync, fingerprintPath, legacyEntryPresent, legacyPanelPath);
            }

            var reasons = new List<string>();
            if (string.IsNullOrWhiteSpace(liveCommit))
            {
                reasons.Add("live commit 缺失");
            }
            else if (!string.IsNullOrWhiteSpace(suiteCommit)
                && !string.Equals(suiteCommit, liveCommit, StringComparison.OrdinalIgnoreCase))
            {
                reasons.Add($"commit {liveCommit} != {suiteCommit}");
            }
            if (HasLiveContentMismatch(reasons))
            {
                var summary = string.IsNullOrWhiteSpace(lastSyncedAt)
                    ? "Live 落后 · 未记录同步时间"
                    : $"Live 落后 · 上次同步 {FormatSyncTime(lastSyncedAt)}";
                return new WebLiveSyncStatus("outdated", lastSyncedAt, suiteCommit, liveCommit, summary, canSync, string.Join("；", reasons.Take(6)), legacyEntryPresent, legacyPanelPath);
            }

            var currentSummary = string.IsNullOrWhiteSpace(lastSyncedAt)
                ? "Live 已同步"
                : $"Live 已同步 · 上次同步 {FormatSyncTime(lastSyncedAt)}";
            return new WebLiveSyncStatus("current", lastSyncedAt, suiteCommit, liveCommit, currentSummary, canSync, "", legacyEntryPresent, legacyPanelPath);
        }
        catch (Exception ex)
        {
            return new WebLiveSyncStatus("error", "", suiteCommit, "", $"Live 状态读取失败：{TrimForStatus(ex.Message, 80)}", canSync, ex.Message);
        }
    }

    private bool HasLiveContentMismatch(List<string> reasons)
    {
        var liveCoreDir = ResolveLiveCoreDir();
        CompareFileHash("runtime src", Path.Combine(_suiteRoot, "packages", "bridge-runtime", "src", "main.ts"), Path.Combine(_skillDir, "src", "main.ts"), reasons);
        CompareFileHash("core bridge", Path.Combine(_suiteRoot, "packages", "bridge-core", "src", "lib", "bridge", "bridge-manager.ts"), Path.Combine(liveCoreDir, "src", "lib", "bridge", "bridge-manager.ts"), reasons);
        CompareFileHash("panel exe", Path.Combine(_suiteRoot, "release", "artifacts", "control-panel", OfficialControlPanelExeName), Path.Combine(_skillDir, "dist", "control-panel", OfficialControlPanelExeName), reasons);
        CompareDirectoryHash("panel wwwroot", Path.Combine(_suiteRoot, "release", "artifacts", "control-panel", "wwwroot"), Path.Combine(_skillDir, "dist", "control-panel", "wwwroot"), reasons);
        return reasons.Count > 0;
    }

    private string ResolveLiveCoreDir()
    {
        var parent = Directory.GetParent(_skillDir)?.FullName;
        return string.IsNullOrWhiteSpace(parent) ? "" : Path.Combine(parent, "claude-to-im-core");
    }

    private static void CompareFileHash(string label, string suitePath, string livePath, List<string> reasons)
    {
        if (!File.Exists(suitePath))
        {
            reasons.Add($"{label} 开发版缺失");
            return;
        }
        if (!File.Exists(livePath))
        {
            reasons.Add($"{label} live 缺失");
            return;
        }
        var suiteHash = ComputeFileSha256(suitePath);
        var liveHash = ComputeFileSha256(livePath);
        if (!string.Equals(suiteHash, liveHash, StringComparison.OrdinalIgnoreCase))
        {
            reasons.Add($"{label} hash 不一致");
        }
    }

    private static void CompareDirectoryHash(string label, string suiteDir, string liveDir, List<string> reasons)
    {
        if (!Directory.Exists(suiteDir))
        {
            reasons.Add($"{label} 开发版缺失");
            return;
        }
        if (!Directory.Exists(liveDir))
        {
            reasons.Add($"{label} live 缺失");
            return;
        }
        var suiteHash = ComputeDirectorySha256(suiteDir);
        var liveHash = ComputeDirectorySha256(liveDir);
        if (!string.Equals(suiteHash, liveHash, StringComparison.OrdinalIgnoreCase))
        {
            reasons.Add($"{label} hash 不一致");
        }
    }

    private static string ComputeFileSha256(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static string ComputeDirectorySha256(string root)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
        {
            var relative = Path.GetRelativePath(root, file).Replace('\\', '/').ToLowerInvariant();
            var nameBytes = Encoding.UTF8.GetBytes(relative);
            hash.AppendData(nameBytes);
            hash.AppendData(new byte[] { 0 });
            hash.AppendData(File.ReadAllBytes(file));
            hash.AppendData(new byte[] { 0 });
        }
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    private static string FormatSyncTime(string value)
    {
        if (DateTimeOffset.TryParse(value, out var parsed))
        {
            return parsed.ToLocalTime().ToString("yyyy-MM-dd HH:mm");
        }
        return value;
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

    private IEnumerable<string> GetMcpManifestDirs()
        => ExistingDistinctDirectories(_manifestDir, _userMcpManifestDir);

    private IEnumerable<(string Dir, string Kind)> GetExtensionManifestDirs()
    {
        foreach (var dir in ExistingDistinctDirectories(_manifestDir, _userMcpManifestDir)) yield return (dir, "extension");
        foreach (var dir in ExistingDistinctDirectories(_skillsManifestDir, _userSkillsManifestDir)) yield return (dir, "skill");
        foreach (var dir in ExistingDistinctDirectories(_pluginsManifestDir, _userPluginsManifestDir)) yield return (dir, "plugin");
    }

    private static IEnumerable<string> ExistingDistinctDirectories(params string[] dirs)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var dir in dirs)
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            var fullPath = Path.GetFullPath(dir);
            if (!seen.Add(fullPath)) continue;
            if (Directory.Exists(fullPath)) yield return fullPath;
        }
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
        foreach (var manifestDir in GetExtensionManifestDirs())
        {
            var dir = manifestDir.Dir;
            var manifestKind = manifestDir.Kind;
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
                    var canRemove = IsUserExtensionPath(file);
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
                        canInstall,
                        canRemove));
                }
                catch (Exception ex)
                {
                    items.Add(new WebExtensionItem(Path.GetFileNameWithoutExtension(file), Path.GetFileName(file), manifestKind, "unknown", "", false, "missing", "", false, ex.Message, file, false, IsUserExtensionPath(file)));
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
                .Select(item => new WebSessionItem(item.DisplayName, item.ChannelType, item.ChatType, item.ChatId, item.SessionId, item.Source, item.LocalMessageCount, item.RemoteMessageCount, item.LastUpdatedAt?.ToString("yyyy-MM-dd HH:mm:ss") ?? "", item.Summary))
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

    private McpManifest? FindMcpManifestById(string id)
        => string.IsNullOrWhiteSpace(id)
            ? null
            : _manifests.FirstOrDefault(manifest => string.Equals(manifest.Id, id, StringComparison.OrdinalIgnoreCase));

    private static string ReadPayloadString(JsonElement payload, string name, string fallback)
    {
        return payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? fallback
            : fallback;
    }

    private static string? ReadPayloadOptionalString(JsonElement payload, string name)
    {
        return payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static int ReadPayloadInt(JsonElement payload, string name, int fallback)
    {
        return payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt32(out var parsed)
            ? parsed
            : fallback;
    }

    private static bool ReadPayloadBool(JsonElement payload, string name, bool fallback)
    {
        return payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty(name, out var value)
            ? value.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => fallback,
            }
            : fallback;
    }

    private static bool? ReadPayloadOptionalBool(JsonElement payload, string name)
    {
        if (payload.ValueKind != JsonValueKind.Object || !payload.TryGetProperty(name, out var value)) return null;
        return value.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null,
        };
    }

    private static string[] ReadPayloadStringArray(JsonElement payload, string name)
    {
        if (payload.ValueKind != JsonValueKind.Object || !payload.TryGetProperty(name, out var value)) return [];
        if (value.ValueKind == JsonValueKind.Array)
        {
            return value.EnumerateArray()
                .Where(item => item.ValueKind == JsonValueKind.String)
                .Select(item => item.GetString()?.Trim() ?? "")
                .Where(item => !string.IsNullOrWhiteSpace(item))
                .ToArray();
        }
        if (value.ValueKind == JsonValueKind.String)
        {
            return (value.GetString() ?? "")
                .Split([',', '，', '\n', '\r'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(item => !string.IsNullOrWhiteSpace(item))
                .ToArray();
        }
        return [];
    }

    private static JsonElement ReadPayloadObject(JsonElement payload, string name)
    {
        return payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.Object
            ? value
            : payload;
    }

    private static FeishuStickerUpdateRequest ReadFeishuStickerUpdatePayload(JsonElement payload)
    {
        var source = ReadPayloadObject(payload, "sticker");
        return new FeishuStickerUpdateRequest
        {
            FileKey = ReadPayloadString(source, "fileKey", ReadPayloadString(payload, "fileKey", "")).Trim(),
            Label = ReadPayloadOptionalString(source, "label"),
            Description = ReadPayloadOptionalString(source, "description"),
            Intent = ReadPayloadOptionalString(source, "intent"),
            Tone = ReadPayloadOptionalString(source, "tone"),
            Usage = ReadPayloadOptionalString(source, "usage"),
            AvoidWhen = ReadPayloadOptionalString(source, "avoidWhen"),
            Disabled = ReadPayloadOptionalBool(source, "disabled") ?? ReadPayloadOptionalBool(payload, "disabled"),
            DisabledReason = ReadPayloadOptionalString(source, "disabledReason") ?? ReadPayloadOptionalString(payload, "disabledReason"),
        };
    }

    private static FeishuStickerAliasMergeRequest ReadFeishuStickerAliasMergePayload(JsonElement payload)
    {
        return new FeishuStickerAliasMergeRequest
        {
            FileKey = ReadPayloadString(payload, "fileKey", "").Trim(),
            Aliases = ReadPayloadStringArray(payload, "aliases"),
        };
    }

    private static FeishuStickerLifecycleRequest ReadFeishuStickerLifecyclePayload(JsonElement payload)
    {
        return new FeishuStickerLifecycleRequest
        {
            FileKey = ReadPayloadString(payload, "fileKey", "").Trim(),
        };
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
            ReadPayloadString(payload, "memoryRepo", current.MemoryRepo),
            // 旧附加目录只保留诊断值，任何控制面板入口都不能再改写它。
            current.AdditionalDirs,
            ReadPayloadString(payload, "replyStyleHint", current.ReplyStyleHint),
            NormalizeExecutorId(ReadPayloadString(payload, "defaultExecutorId", current.DefaultExecutorId)),
            NormalizeLocalAiKind(ReadPayloadString(payload, "localAiKind", current.LocalAiKind)),
            ReadPayloadString(payload, "localAiBaseUrl", current.LocalAiBaseUrl),
            ReadPayloadString(payload, "ollamaModelsDir", current.OllamaModelsDir),
            ReadPayloadString(payload, "localAiModel", current.LocalAiModel),
            ReadPayloadString(payload, "localAiApiKeyAction", current.LocalAiApiKeyAction),
            ReadPayloadString(payload, "localAiApiKeyValue", ""),
            ReadPayloadString(payload, "localAiApiKeyMasked", current.LocalAiApiKeyMasked),
            ReadPayloadBool(payload, "localAiApiKeySet", current.LocalAiApiKeySet),
            ReadPayloadString(payload, "localAiTimeoutMs", current.LocalAiTimeoutMs),
            NormalizeCodexModelSource(ReadPayloadString(payload, "codexModelSource", current.CodexModelSource)),
            NormalizeCodexRoutingMode(ReadPayloadString(payload, "codexRoutingMode", current.CodexRoutingMode)),
            NormalizeCodexApiFallbackChain(ReadPayloadString(payload, "codexApiFallbackChain", current.CodexApiFallbackChain)),
            ReadPayloadString(payload, "codexBaseUrl", current.CodexBaseUrl),
            ReadPayloadString(payload, "codexModel", current.CodexModel),
            ReadPayloadBool(payload, "codexPassModel", current.CodexPassModel),
            NormalizeCodexReasoningEffort(ReadPayloadString(payload, "codexReasoningEffort", current.CodexReasoningEffort)),
            ReadPayloadBool(payload, "memoryOptimizerEnabled", current.MemoryOptimizerEnabled),
            NormalizePositiveNumber(ReadPayloadString(payload, "memoryOptimizerIntervalDays", current.MemoryOptimizerIntervalDays), "7"),
            NormalizeMemoryOptimizerModelSource(ReadPayloadString(payload, "memoryOptimizerModelSource", current.MemoryOptimizerModelSource)),
            ReadPayloadString(payload, "codexApiKeyAction", current.CodexApiKeyAction),
            ReadPayloadString(payload, "codexApiKeyValue", ""),
            ReadPayloadString(payload, "codexApiKeyMasked", current.CodexApiKeyMasked),
            ReadPayloadBool(payload, "codexApiKeySet", current.CodexApiKeySet));
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

        var outboundRefs = LoadOutboundRefs(entry.ChatId);
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
            entry.RemoteMessageCount,
            entry.LastUpdatedAt?.ToString("yyyy-MM-dd HH:mm:ss") ?? "",
            entry.Summary,
            entry.Messages.Select(message =>
            {
                var recall = ConversationHistoryDisplay.ResolveRecallState(
                    entry.ChannelType,
                    entry.ChatId,
                    message.SenderType,
                    message.SenderId,
                    message.MessageId,
                    outboundRefs,
                    GetFeishuBotAppIds());
                return new WebConversationMessage(
                    message.Index,
                    message.MessageId,
                    message.Role,
                    message.MsgType,
                    message.SenderId,
                    message.SenderType,
                    message.SenderName,
                    message.CreatedAt?.ToString("yyyy-MM-dd HH:mm:ss") ?? "",
                    message.Content,
                    message.CardContent,
                    message.RawContentPreview,
                    message.Attachments.Select(attachment => new WebMessageAttachment(
                        attachment.Kind,
                        attachment.Name,
                        attachment.MimeType,
                        attachment.Size,
                        attachment.Path,
                        attachment.Url,
                        attachment.ResourceKey,
                        attachment.Status)).ToArray(),
                    recall.CanRecall,
                    recall.RecallStatus,
                    recall.RecallError);
            }).ToArray(),
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

    private string[] GetFeishuBotAppIds()
        => SplitConfigList(string.Join(",", [
                GetConfig("CTI_FEISHU_APP_ID", ""),
                GetConfig("CTI_FEISHU_BOT_APP_IDS", "")
            ]))
            .ToArray();

    private List<OutboundMessageRefRecord> LoadOutboundRefs(string? chatId = null)
    {
        if (!File.Exists(_outboundRefsPath)) return [];
        try
        {
            var refs = JsonSerializer.Deserialize<Dictionary<string, OutboundMessageRefRecord>>(
                File.ReadAllText(_outboundRefsPath, Encoding.UTF8),
                WebJsonOptions) ?? new Dictionary<string, OutboundMessageRefRecord>(StringComparer.OrdinalIgnoreCase);
            return refs.Values
                .Where(item => string.IsNullOrWhiteSpace(chatId) || string.Equals(item.ChatId, chatId, StringComparison.OrdinalIgnoreCase))
                .ToList();
        }
        catch
        {
            return [];
        }
    }

    private void SaveOutboundRefs(IEnumerable<OutboundMessageRefRecord> refs)
    {
        var map = refs
            .Where(item => !string.IsNullOrWhiteSpace(item.ChannelType)
                && !string.IsNullOrWhiteSpace(item.ChatId)
                && !string.IsNullOrWhiteSpace(item.PlatformMessageId))
            .GroupBy(item => $"{item.ChannelType}:{item.ChatId}:{item.PlatformMessageId}", StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.Last(), StringComparer.OrdinalIgnoreCase);
        Directory.CreateDirectory(Path.GetDirectoryName(_outboundRefsPath)!);
        var tmp = _outboundRefsPath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(map, WebJsonOptions), new UTF8Encoding(false));
        File.Move(tmp, _outboundRefsPath, overwrite: true);
    }

    private async Task<object> RecallBotMessageAsync(JsonElement payload)
    {
        var channelType = ReadPayloadString(payload, "channelType", "feishu").Trim();
        var chatId = ReadPayloadString(payload, "chatId", "").Trim();
        var messageId = ReadPayloadString(payload, "messageId", "").Trim();
        var senderType = ReadPayloadString(payload, "senderType", "").Trim();
        var senderId = ReadPayloadString(payload, "senderId", "").Trim();
        var sessionId = ReadPayloadString(payload, "sessionId", "").Trim();
        if (!string.Equals(channelType, "feishu", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("当前只支持撤回 Feishu 机器人消息。");
        }
        if (string.IsNullOrWhiteSpace(chatId) || string.IsNullOrWhiteSpace(messageId))
        {
            throw new InvalidOperationException("缺少 chatId 或 messageId。");
        }

        var refs = LoadOutboundRefs();
        var target = ConversationHistoryDisplay.ResolveRecallTarget(
            channelType,
            chatId,
            senderType,
            senderId,
            messageId,
            sessionId,
            refs,
            GetFeishuBotAppIds());
        if (target is null)
        {
            throw new InvalidOperationException("未找到这条机器人出站消息记录，拒绝撤回未知消息。");
        }
        var targetTracked = refs.Any(item =>
            string.Equals(item.ChannelType, target.ChannelType, StringComparison.OrdinalIgnoreCase)
            && string.Equals(item.ChatId, target.ChatId, StringComparison.OrdinalIgnoreCase)
            && string.Equals(item.PlatformMessageId, target.PlatformMessageId, StringComparison.OrdinalIgnoreCase));
        if (!targetTracked)
        {
            refs.Add(target);
        }
        if (string.IsNullOrWhiteSpace(target.CodepilotSessionId))
        {
            target.CodepilotSessionId = sessionId;
        }
        if (string.IsNullOrWhiteSpace(target.CreatedAt))
        {
            target.CreatedAt = DateTime.UtcNow.ToString("o");
        }
        if (!string.IsNullOrWhiteSpace(target.RecalledAt))
        {
            return new { ok = true, recalled = true, messageId, status = "already_recalled" };
        }

        var ok = false;
        var error = "";
        try
        {
            // 到达这里前已经完成“仅撤回已记录机器人出站消息”的本地校验；
            // 当前面板点击即为高风险操作的明确确认，因此只在这一受控边界传递 --yes。
            await CreateLarkCliGateway().RecallMessageAsync(messageId, userConfirmed: true, _ctiHome);
            ok = true;
        }
        catch (Exception recallError)
        {
            error = recallError.Message;
        }

        target.RecalledAt = ok ? DateTime.UtcNow.ToString("o") : target.RecalledAt;
        target.RecallError = ok ? "" : string.IsNullOrWhiteSpace(error) ? "官方 lark-cli 撤回失败。" : error;
        target.UpdatedAt = DateTime.UtcNow.ToString("o");
        SaveOutboundRefs(refs);
        _sessionDetailCache.Remove($"{chatId}::{target.CodepilotSessionId}");
        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            _sessionDetailCache.Remove($"{chatId}::{sessionId}");
        }
        if (!ok)
        {
            throw new InvalidOperationException($"撤回失败：{target.RecallError}");
        }
        return new { ok = true, recalled = true, messageId, chatId };
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
        lock (_permissionFileLock)
        {
            var snapshot = ReadPermissionSnapshotFile();
            if (syncFromConfig)
            {
                var merged = MergeConfigPermissions(snapshot);
                if (!PermissionSubjectsEquivalent(snapshot.Subjects, merged.Subjects))
                {
                    SavePermissionSnapshot(merged);
                    SyncPermissionSnapshotToConfig(merged);
                    return merged;
                }
                snapshot.Candidates = BuildPermissionCandidates(snapshot.Subjects);
            }
            return snapshot;
        }
    }

    private PermissionSnapshot ReadPermissionSnapshotFile()
    {
        try
        {
            if (File.Exists(_permissionsPath))
            {
                var loaded = JsonSerializer.Deserialize<PermissionSnapshot>(ReadUtf8TextShared(_permissionsPath), JsonOptions);
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

        PermissionSnapshot snapshot;
        lock (_permissionFileLock)
        {
            snapshot = LoadPermissionSnapshot(syncFromConfig: true);
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
        }
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

        PermissionSnapshot snapshot;
        lock (_permissionFileLock)
        {
            snapshot = LoadPermissionSnapshot(syncFromConfig: true);
            snapshot.Subjects = snapshot.Subjects
                .Where(item => !string.Equals(MakePermissionKey(item.ChannelType, item.UserId), MakePermissionKey(channelType, userId), StringComparison.OrdinalIgnoreCase))
                .ToList();
            snapshot.Candidates = BuildPermissionCandidates(snapshot.Subjects);
            snapshot.UpdatedAt = DateTime.UtcNow.ToString("o");
            SavePermissionSnapshot(snapshot);
            SyncPermissionSnapshotToConfig(snapshot);
        }
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
        WriteUtf8TextAtomic(_permissionsPath, JsonSerializer.Serialize(snapshot, JsonOptions));
    }

    private void SyncPermissionSnapshotToConfig(PermissionSnapshot snapshot)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_configPath)!);
        var lines = ReadEnvFileLines(_configPath);
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

    private object RetryWorkflowRun(JsonElement payload)
    {
        var runId = ReadPayloadString(payload, "id", ReadPayloadString(payload, "runId", ""));
        if (string.IsNullOrWhiteSpace(runId)) throw new InvalidOperationException("runId 不能为空");
        var root = ReadJsonObjectFile(_workflowStatusPath) ?? new JsonObject
        {
            ["protocol"] = "workflow-runtime/v1",
            ["updatedAt"] = DateTime.UtcNow.ToString("o"),
            ["runs"] = new JsonArray(),
        };
        var runs = root["runs"] as JsonArray ?? [];
        var run = runs.OfType<JsonObject>()
            .FirstOrDefault(item => string.Equals(ReadJsonString(item, "id", ""), runId, StringComparison.OrdinalIgnoreCase));
        if (run is null) throw new InvalidOperationException("未找到 workflow run。");

        var recovery = run["recovery"] as JsonObject;
        var input = recovery?["input"] as JsonObject;
        var prompt = ReadJsonString(input, "prompt", "");
        if (string.IsNullOrWhiteSpace(prompt))
        {
            throw new InvalidOperationException("该 workflow run 缺少可重试输入，不能断点续跑。");
        }

        var timestamp = DateTime.UtcNow.ToString("o");
        var retry = run["retry"] as JsonObject ?? new JsonObject();
        var attempts = ReadJsonInt(retry, "attempts", 0);
        var maxAttempts = Math.Max(1, ReadJsonInt(retry, "maxAttempts", 1));
        retry["status"] = "manual_pending";
        retry["attempts"] = attempts;
        retry["maxAttempts"] = maxAttempts;
        retry["requestedBy"] = "manual";
        retry["requestedAt"] = timestamp;
        retry["lastError"] = ReadJsonString(run, "error", "");

        run["status"] = "retry_pending";
        run["retry"] = retry;
        run["updatedAt"] = timestamp;
        var events = run["events"] as JsonArray ?? [];
        events.Add(new JsonObject
        {
            ["id"] = Guid.NewGuid().ToString("D"),
            ["runId"] = runId,
            ["stage"] = ReadJsonString(run, "stage", "failed"),
            ["type"] = "workflow.retry.requested",
            ["message"] = "控制面板请求手动重试",
            ["at"] = timestamp,
            ["data"] = new JsonObject { ["requestedBy"] = "manual" },
        });
        run["events"] = events;
        root["runs"] = runs;
        WriteJsonObjectFile(_workflowStatusPath, root);
        return new { ok = true, run = run.DeepClone() };
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
                defaultExecutorId = NormalizeExecutorId(GetConfig("CTI_DEFAULT_EXECUTOR_ID", "")),
                executors = Array.Empty<object>(),
                sessionDefaults = defaults,
                lastSelection = (object?)null,
            };
        }
        root["defaultExecutorId"] ??= NormalizeExecutorId(GetConfig("CTI_DEFAULT_EXECUTOR_ID", ""));
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

    private static void WriteJsonObjectFile(string path, JsonObject root)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        root["updatedAt"] = DateTime.UtcNow.ToString("o");
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, root.ToJsonString(WebJsonOptions), Encoding.UTF8);
        File.Move(tmp, path, overwrite: true);
    }

    private static string ReadJsonString(JsonObject? root, string name, string fallback)
    {
        if (root is null || !root.TryGetPropertyValue(name, out var node)) return fallback;
        return node?.GetValue<string>() ?? fallback;
    }

    private static int ReadJsonInt(JsonObject? root, string name, int fallback)
    {
        if (root is null || !root.TryGetPropertyValue(name, out var node) || node is null) return fallback;
        try
        {
            return node.GetValue<int>();
        }
        catch
        {
            return fallback;
        }
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

    private Task<string> PickFolderAsync(string currentPath)
    {
        if (!InvokeRequired) return Task.FromResult(PickFolderOnUiThread(currentPath));
        var completion = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        BeginInvoke(() =>
        {
            try { completion.SetResult(PickFolderOnUiThread(currentPath)); }
            catch (Exception ex) { completion.SetException(ex); }
        });
        return completion.Task;
    }

    private string PickFolderOnUiThread(string currentPath)
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "选择目录",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = true,
            SelectedPath = Directory.Exists(currentPath) ? currentPath : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        };
        return dialog.ShowDialog(this) == DialogResult.OK ? dialog.SelectedPath : currentPath;
    }

    private Task<string> PickFileAsync(string currentPath)
    {
        if (!InvokeRequired) return Task.FromResult(PickFileOnUiThread(currentPath));
        var completion = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        BeginInvoke(() =>
        {
            try { completion.SetResult(PickFileOnUiThread(currentPath)); }
            catch (Exception ex) { completion.SetException(ex); }
        });
        return completion.Task;
    }

    private string PickFileOnUiThread(string currentPath)
    {
        using var dialog = new OpenFileDialog
        {
            CheckFileExists = true,
            FileName = File.Exists(currentPath) ? currentPath : "",
            InitialDirectory = Directory.Exists(Path.GetDirectoryName(currentPath) ?? "")
                ? Path.GetDirectoryName(currentPath)
                : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        };
        return dialog.ShowDialog(this) == DialogResult.OK ? dialog.FileName : currentPath;
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

    private string GetKnowledgeIndexPath()
        => Path.Combine(_memoryRepo.Text.Trim(), ".cti-index", "knowledge.json");

    private string GetKnowledgeStatusPath()
        => Path.Combine(_memoryRepo.Text.Trim(), ".cti-index", "status.json");

    private string GetMemoryGraphIndexPath()
        => Path.Combine(_memoryRepo.Text.Trim(), ".cti-index", "memory-graph.json");

    private string GetAnswerReviewAuditPath()
        => Path.Combine(_dataDir, "answer-review-audit.json");

    private string GetTodoReminderIndexPath()
        => Path.Combine(_memoryRepo.Text.Trim(), ".cti-index", "reminders.json");

    private string GetTodoReminderStatePath()
        => Path.Combine(_memoryRepo.Text.Trim(), ".cti-index", "reminder-state.json");

    private string GetMemoryOptimizerStatePath()
        => Path.Combine(_memoryRepo.Text.Trim(), ".cti-index", "memory-optimizer-state.json");

    private string GetMemoryOptimizationDraftsDir()
        => Path.Combine(_memoryRepo.Text.Trim(), ".cti-index", "memory-optimization-drafts");

    private string GetKnowledgeArchiveRoot()
        => Path.Combine(_memoryRepo.Text.Trim(), "archive", "knowledge-units");

    private static string MemoryPartitionSegment(string value)
    {
        var normalized = (value ?? "").Normalize(NormalizationForm.FormKC).Trim();
        var safe = Regex.Replace(normalized, @"[\\/:*?""<>|]+", "_");
        safe = Regex.Replace(safe, @"[\u0000-\u001F]", "");
        if (safe.Length > 96) safe = safe[..96];
        if (!string.IsNullOrWhiteSpace(safe)) return safe;
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized))).ToLowerInvariant()[..20];
    }

    private static string[] GetRelativePathSegments(string root, string sourcePath)
    {
        if (string.IsNullOrWhiteSpace(root) || string.IsNullOrWhiteSpace(sourcePath)) return [];
        var fullRoot = Path.GetFullPath(root);
        var fullSource = Path.GetFullPath(sourcePath);
        if (!IsPathInside(fullRoot, fullSource)) return [];
        return Path.GetRelativePath(fullRoot, fullSource)
            .Replace('\\', '/')
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    private static Dictionary<string, string> ReadSourceMetadata(JsonElement source)
    {
        if (source.ValueKind != JsonValueKind.Object) return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!source.TryGetProperty("metadata", out var metadataElement) || metadataElement.ValueKind != JsonValueKind.Object)
        {
            return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }
        var metadata = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var property in metadataElement.EnumerateObject())
        {
            if (property.Value.ValueKind == JsonValueKind.String)
            {
                metadata[property.Name] = property.Value.GetString() ?? "";
            }
        }
        return metadata;
    }

    private static Dictionary<string, string> ReadMarkdownMetadataFile(string filePath)
    {
        try
        {
            return File.Exists(filePath)
                ? ParseMarkdownFrontmatter(File.ReadAllText(filePath, Encoding.UTF8))
                : new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }
        catch
        {
            return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }
    }

    private static string ClassifyMemoryV2SourceGroup(string root, string sourcePath, IReadOnlyDictionary<string, string> metadata)
        => MemorySourceLayoutClassifier.Classify(root, sourcePath, metadata).SourceGroup;

    private bool IsIndexableMemorySourceFile(string filePath)
        => !string.IsNullOrWhiteSpace(ClassifyMemoryV2SourceGroup(_memoryRepo.Text.Trim(), filePath, ReadMarkdownMetadataFile(filePath)));

    private bool IsIndexableMemorySourceItem(string sourcePath, JsonElement source)
        => !string.IsNullOrWhiteSpace(ClassifyMemoryV2SourceGroup(_memoryRepo.Text.Trim(), sourcePath, ReadSourceMetadata(source)));

    private sealed class SourceCoverageAccumulator
    {
        public string SourcePath { get; init; } = "";
        public string SourceGroup { get; init; } = "other";
        public int ItemCount { get; set; }
        public string UpdatedAt { get; set; } = "";
        public bool AutoSelectable { get; init; }
        public string DefaultRisk { get; init; } = "medium";

        public object ToSnapshot() => new
        {
            sourcePath = SourcePath,
            sourceGroup = SourceGroup,
            itemCount = ItemCount,
            updatedAt = UpdatedAt,
            autoSelectable = AutoSelectable,
            defaultRisk = DefaultRisk,
        };
    }

    private void AddSourceCoverage(Dictionary<string, SourceCoverageAccumulator> coverage, string sourcePath, string updatedAt)
    {
        var sourceGroup = ClassifyMemorySourceGroup(sourcePath);
        if (!coverage.TryGetValue(sourcePath, out var current))
        {
            current = new SourceCoverageAccumulator
            {
                SourcePath = sourcePath,
                SourceGroup = sourceGroup,
                AutoSelectable = IsAutoSelectableSourceGroup(sourceGroup),
                DefaultRisk = IsAutoSelectableSourceGroup(sourceGroup) ? "low" : "medium",
            };
            coverage[sourcePath] = current;
        }
        current.ItemCount += 1;
        if (string.Compare(updatedAt, current.UpdatedAt, StringComparison.Ordinal) > 0)
        {
            current.UpdatedAt = updatedAt;
        }
    }

    private string ClassifyMemorySourceGroup(string sourcePath)
    {
        if (string.IsNullOrWhiteSpace(sourcePath)) return "other";
        var root = Path.GetFullPath(_memoryRepo.Text.Trim());
        var fullPath = string.IsNullOrWhiteSpace(sourcePath) ? sourcePath : Path.GetFullPath(sourcePath);
        var metadata = ReadMarkdownMetadataFile(fullPath);
        var memoryGroup = ClassifyMemoryV2SourceGroup(root, fullPath, metadata);
        if (!string.IsNullOrWhiteSpace(memoryGroup)) return memoryGroup;
        var relative = IsPathInside(root, fullPath)
            ? Path.GetRelativePath(root, fullPath)
            : fullPath;
        var normalized = relative.Replace('\\', '/').TrimStart('/').ToLowerInvariant();
        if (normalized.Contains("data/todos/direct-reminders/", StringComparison.OrdinalIgnoreCase)) return "direct_reminder";
        return "other";
    }

    private static bool IsAutoSelectableSourceGroup(string sourceGroup)
        => string.Equals(sourceGroup, "memory_user", StringComparison.OrdinalIgnoreCase)
            || string.Equals(sourceGroup, "memory_group", StringComparison.OrdinalIgnoreCase)
            || string.Equals(sourceGroup, "memory_long_term", StringComparison.OrdinalIgnoreCase)
            || string.Equals(sourceGroup, "direct_reminder", StringComparison.OrdinalIgnoreCase)
            ;

    private static bool ShouldSkipKnowledgeDirectory(string path)
    {
        var name = Path.GetFileName(path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        return string.Equals(name, ".git", StringComparison.OrdinalIgnoreCase)
            || string.Equals(name, ".cti-index", StringComparison.OrdinalIgnoreCase)
            || string.Equals(name, "archive", StringComparison.OrdinalIgnoreCase)
            || string.Equals(name, "node_modules", StringComparison.OrdinalIgnoreCase)
            || string.Equals(name, ".obsidian", StringComparison.OrdinalIgnoreCase);
    }

    private IEnumerable<string> EnumerateKnowledgeMarkdownFiles(string root)
    {
        if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root)) yield break;
        var stack = new Stack<string>();
        foreach (var sourceRoot in new[] { Path.Combine(root, "memory"), Path.Combine(root, "data", "memory", "v2") })
        {
            if (Directory.Exists(sourceRoot)) stack.Push(sourceRoot);
        }
        while (stack.Count > 0)
        {
            var dir = stack.Pop();
            IEnumerable<string> subdirs = [];
            IEnumerable<string> files = [];
            try
            {
                subdirs = Directory.EnumerateDirectories(dir).Where(path => !ShouldSkipKnowledgeDirectory(path));
                files = Directory.EnumerateFiles(dir, "*.md");
            }
            catch
            {
                continue;
            }
            foreach (var subdir in subdirs) stack.Push(subdir);
            foreach (var file in files)
            {
                if (IsIndexableMemorySourceFile(file)) yield return file;
            }
        }
    }

    private object BuildKnowledgeIndexStatus()
    {
        var root = _memoryRepo.Text.Trim();
        var indexPath = GetKnowledgeIndexPath();
        var statusPath = GetKnowledgeStatusPath();
        var markdownCount = EnumerateKnowledgeMarkdownFiles(root).Take(2001).Count();
        var exists = File.Exists(indexPath);
        var watching = false;
        var itemCount = 0;
        var conflictCount = 0;
        var sourceFileCount = 0;
        var memoryGraphNodeCount = 0;
        var memoryGraphEdgeCount = 0;
        object memoryGraphPreview = new { nodes = Array.Empty<object>(), edges = Array.Empty<object>() };
        var kindCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var sourceCoverage = new Dictionary<string, SourceCoverageAccumulator>(StringComparer.OrdinalIgnoreCase);
        var recentReviewWarnings = ReadRecentAnswerReviewWarnings(6);
        var layout = MemoryLayoutInspector.Inspect(root);
        var generatedAt = "";
        var lastIndexedAt = "";
        var lastEventAt = "";
        var watcherStartedAt = "";
        var watcherPid = 0;
        var statusUpdatedAt = "";
        var lastError = "";

        if (exists)
        {
            try
            {
                using var document = JsonDocument.Parse(File.ReadAllText(indexPath, Encoding.UTF8));
                var rootElement = document.RootElement;
                if (rootElement.TryGetProperty("itemCount", out var itemCountElement) && itemCountElement.ValueKind == JsonValueKind.Number)
                {
                    itemCount = itemCountElement.GetInt32();
                }
                if (rootElement.TryGetProperty("conflictCount", out var conflictElement) && conflictElement.ValueKind == JsonValueKind.Number)
                {
                    conflictCount = conflictElement.GetInt32();
                }
                if (rootElement.TryGetProperty("generatedAt", out var generatedElement) && generatedElement.ValueKind == JsonValueKind.String)
                {
                    generatedAt = generatedElement.GetString() ?? "";
                }
                if (rootElement.TryGetProperty("items", out var itemsElement) && itemsElement.ValueKind == JsonValueKind.Array)
                {
                    var sourcePaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var item in itemsElement.EnumerateArray())
                    {
                        var source = item.TryGetProperty("source", out var sourceElement) && sourceElement.ValueKind == JsonValueKind.Object
                            ? sourceElement
                            : default;
                        var sourcePath = source.ValueKind == JsonValueKind.Object ? ReadJsonString(source, "path") : "";
                        if (!IsIndexableMemorySourceItem(sourcePath, source)) continue;

                        var kind = ReadJsonString(item, "kind");
                        if (!string.IsNullOrWhiteSpace(kind))
                        {
                            kindCounts[kind] = kindCounts.TryGetValue(kind, out var current) ? current + 1 : 1;
                        }
                        if (ReadJsonBool(item, "conflict"))
                        {
                            conflictCount += 1;
                        }

                        if (source.ValueKind == JsonValueKind.Object)
                        {
                            if (!string.IsNullOrWhiteSpace(sourcePath))
                            {
                                sourcePaths.Add(sourcePath);
                                AddSourceCoverage(sourceCoverage, sourcePath, ReadJsonString(source, "updatedAt"));
                            }
                        }
                    }
                    sourceFileCount = sourcePaths.Count;
                    itemCount = kindCounts.Values.Sum();
                }
            }
            catch (Exception ex)
            {
                lastError = ex.Message;
            }
        }
        else if (!Directory.Exists(root))
        {
            lastError = $"记忆仓库不存在：{root}";
        }

        if (File.Exists(statusPath))
        {
            try
            {
                using var statusDocument = JsonDocument.Parse(File.ReadAllText(statusPath, Encoding.UTF8));
                var statusRoot = statusDocument.RootElement;
                statusUpdatedAt = ReadJsonString(statusRoot, "statusUpdatedAt");
                var watcherFresh = IsRecentIsoTimestamp(statusUpdatedAt, TimeSpan.FromMinutes(2));
                watching = ReadJsonBool(statusRoot, "watching") && watcherFresh && IsBridgeRunning();
                var statusItemCount = ReadJsonInt(statusRoot, "itemCount");
                var statusConflictCount = ReadJsonInt(statusRoot, "conflictCount");
                if (!exists && statusItemCount > 0) itemCount = statusItemCount;
                if (!exists && statusConflictCount > 0) conflictCount = statusConflictCount;
                generatedAt = ReadJsonString(statusRoot, "generatedAt", generatedAt);
                lastIndexedAt = ReadJsonString(statusRoot, "lastIndexedAt");
                lastEventAt = ReadJsonString(statusRoot, "lastEventAt");
                watcherStartedAt = ReadJsonString(statusRoot, "watcherStartedAt");
                watcherPid = ReadJsonInt(statusRoot, "watcherPid");
                var statusError = ReadJsonString(statusRoot, "lastError");
                if (!string.IsNullOrWhiteSpace(statusError)) lastError = statusError;
            }
            catch (Exception ex)
            {
                lastError = string.IsNullOrWhiteSpace(lastError) ? ex.Message : $"{lastError}; {ex.Message}";
            }
        }

        var graphPath = GetMemoryGraphIndexPath();
        if (File.Exists(graphPath))
        {
            try
            {
                using var graphDocument = JsonDocument.Parse(File.ReadAllText(graphPath, Encoding.UTF8));
                memoryGraphNodeCount = ReadJsonInt(graphDocument.RootElement, "nodeCount");
                memoryGraphEdgeCount = ReadJsonInt(graphDocument.RootElement, "edgeCount");
                memoryGraphPreview = ReadMemoryGraphPreview(graphDocument.RootElement, 300);
            }
            catch (Exception ex)
            {
                lastError = string.IsNullOrWhiteSpace(lastError) ? ex.Message : $"{lastError}; {ex.Message}";
            }
        }

        return new
        {
            schema = "codex-im-suite/knowledge-index-status/v1",
            memoryRoot = root,
            indexPath,
            statusPath,
            memoryGraphPath = graphPath,
            watching,
            exists,
            markdownFileCount = markdownCount,
            itemCount,
            conflictCount,
            memoryGraphNodeCount,
            memoryGraphEdgeCount,
            memoryGraphPreview,
            sourceFileCount,
            sourceCoverage = sourceCoverage.Values
                .OrderByDescending(item => item.ItemCount)
                .ThenBy(item => item.SourcePath, StringComparer.OrdinalIgnoreCase)
                .Select(item => item.ToSnapshot())
                .ToArray(),
            skippedDirectories = new[] { ".git", ".cti-index", "archive", "node_modules", ".obsidian" },
            kindCounts,
            recentReviewWarnings,
            layout = new
            {
                layoutVersion = layout.LayoutVersion,
                migrationState = layout.MigrationState,
                v3SourceCount = layout.V3SourceCount,
                legacySourceCount = layout.LegacySourceCount,
                agentHome = layout.AgentHome.Select(item => new { name = item.Name, path = item.Path, exists = item.Exists }).ToArray(),
                unclassifiedRootDocuments = layout.UnclassifiedRootDocuments
                    .Select(item => new { name = item.Name, path = item.Path })
                    .ToArray(),
            },
            generatedAt,
            lastIndexedAt,
            lastEventAt,
            watcherStartedAt,
            watcherPid,
            statusUpdatedAt,
            lastError,
            optimization = BuildMemoryOptimizationStatusSnapshot(),
        };
    }

    private object BuildMemoryOptimizationStatusSnapshot()
    {
        var root = _memoryRepo.Text.Trim();
        var statePath = GetMemoryOptimizerStatePath();
        var draftsDir = GetMemoryOptimizationDraftsDir();
        var state = ReadJsonObjectFile(statePath);
        var drafts = new List<JsonObject>();
        if (Directory.Exists(draftsDir))
        {
            foreach (var file in Directory.EnumerateFiles(draftsDir, "*.json"))
            {
                try
                {
                    if (JsonNode.Parse(File.ReadAllText(file, Encoding.UTF8)) is JsonObject draft
                        && string.Equals(ReadJsonString(draft, "schema", ""), "codex-im-suite/memory-optimization-draft/v1", StringComparison.OrdinalIgnoreCase))
                    {
                        drafts.Add(draft);
                    }
                }
                catch
                {
                    // Ignore unreadable draft files; the optimizer CLI will surface hard errors when invoked.
                }
            }
        }
        drafts.Sort((left, right) => string.Compare(ReadJsonString(right, "generatedAt", ""), ReadJsonString(left, "generatedAt", ""), StringComparison.Ordinal));
        var recentDrafts = drafts.Take(20).ToArray();
        var enabled = state is not null && ReadJsonBool(state, "enabled");
        var intervalDays = ReadJsonInt(state, "intervalDays", 7);
        if (intervalDays <= 0) intervalDays = 7;
        var modelSource = ReadJsonString(state, "modelSource", "codex_primary");
        return new
        {
            schema = "codex-im-suite/memory-optimization-status/v1",
            memoryRoot = root,
            statePath,
            draftsDir,
            enabled,
            intervalDays,
            modelSource,
            lastGeneratedAt = ReadJsonString(state, "lastGeneratedAt", ""),
            nextRunAt = ReadJsonString(state, "nextRunAt", ""),
            draftCount = drafts.Count(draft => string.Equals(ReadJsonString(draft, "status", ""), "draft", StringComparison.OrdinalIgnoreCase)),
            recentError = ReadJsonString(state, "recentError", ""),
            drafts = recentDrafts,
        };
    }

    private bool IsVisibleMemoryGraphElement(JsonElement element)
    {
        if (!element.TryGetProperty("sourcePaths", out var sourcePaths) || sourcePaths.ValueKind != JsonValueKind.Array) return false;
        var seen = false;
        foreach (var sourcePathElement in sourcePaths.EnumerateArray())
        {
            var sourcePath = sourcePathElement.GetString() ?? "";
            if (string.IsNullOrWhiteSpace(sourcePath)) return false;
            var group = ClassifyMemoryV2SourceGroup(_memoryRepo.Text.Trim(), sourcePath, ReadMarkdownMetadataFile(sourcePath));
            if (string.IsNullOrWhiteSpace(group)) return false;
            seen = true;
        }
        return seen;
    }

    private object ReadMemoryGraphPreview(JsonElement root, int limit)
    {
        var max = Math.Max(1, limit);
        var nodeSnapshots = root.TryGetProperty("nodes", out var nodesElement) && nodesElement.ValueKind == JsonValueKind.Array
            ? nodesElement.EnumerateArray()
                .Where(IsVisibleMemoryGraphElement)
                .Take(max)
                .Select(node => new
                {
                    id = ReadJsonString(node, "id"),
                    label = ReadJsonString(node, "label"),
                    kind = ReadJsonString(node, "kind"),
                })
                .ToArray<object>()
            : [];
        var nodeLabels = root.TryGetProperty("nodes", out var allNodesElement) && allNodesElement.ValueKind == JsonValueKind.Array
            ? allNodesElement.EnumerateArray()
                .Where(IsVisibleMemoryGraphElement)
                .Select(node => new { id = ReadJsonString(node, "id"), label = ReadJsonString(node, "label") })
                .Where(node => !string.IsNullOrWhiteSpace(node.id))
                .ToDictionary(node => node.id, node => node.label, StringComparer.OrdinalIgnoreCase)
            : new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        var edges = root.TryGetProperty("edges", out var edgesElement) && edgesElement.ValueKind == JsonValueKind.Array
            ? edgesElement.EnumerateArray()
                .Where(IsVisibleMemoryGraphElement)
                .Where(edge => nodeLabels.ContainsKey(ReadJsonString(edge, "from")) && nodeLabels.ContainsKey(ReadJsonString(edge, "to")))
                .Take(max)
                .Select(edge => new
                {
                    from = ReadJsonString(edge, "from"),
                    to = ReadJsonString(edge, "to"),
                    fromLabel = nodeLabels.GetValueOrDefault(ReadJsonString(edge, "from"), ReadJsonString(edge, "from")),
                    toLabel = nodeLabels.GetValueOrDefault(ReadJsonString(edge, "to"), ReadJsonString(edge, "to")),
                    type = ReadJsonString(edge, "type"),
                    weight = ReadJsonDouble(edge, "weight"),
                })
                .ToArray<object>()
            : [];

        return new { nodes = nodeSnapshots, edges };
    }

    private object[] ReadRecentAnswerReviewWarnings(int limit)
    {
        var auditPath = GetAnswerReviewAuditPath();
        if (!File.Exists(auditPath)) return [];
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(auditPath, Encoding.UTF8));
            if (document.RootElement.ValueKind != JsonValueKind.Array) return [];
            return document.RootElement.EnumerateArray()
                .Reverse()
                .Where(item => !string.Equals(ReadJsonString(item, "verdict"), "pass", StringComparison.OrdinalIgnoreCase))
                .Take(Math.Max(1, limit))
                .Select(item => new
                {
                    createdAt = ReadJsonString(item, "createdAt"),
                    verdict = ReadJsonString(item, "verdict"),
                    reasonCodes = item.TryGetProperty("reasonCodes", out var reasons) && reasons.ValueKind == JsonValueKind.Array
                        ? reasons.EnumerateArray().Select(reason => reason.GetString() ?? "").Where(value => !string.IsNullOrWhiteSpace(value)).ToArray()
                        : [],
                    userText = ReadJsonString(item, "userText"),
                    answerText = ReadJsonString(item, "answerText"),
                })
                .ToArray<object>();
        }
        catch
        {
            return [];
        }
    }

    private static bool IsRecentIsoTimestamp(string value, TimeSpan maxAge)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        return DateTimeOffset.TryParse(value, out var parsed)
            && DateTimeOffset.UtcNow - parsed.ToUniversalTime() <= maxAge;
    }

    private bool IsBridgeRunning()
    {
        try
        {
            if (!File.Exists(_statusJsonPath)) return false;
            using var document = JsonDocument.Parse(File.ReadAllText(_statusJsonPath, Encoding.UTF8));
            return document.RootElement.TryGetProperty("running", out var running)
                && running.ValueKind == JsonValueKind.True;
        }
        catch
        {
            return false;
        }
    }

    private object SearchKnowledgeIndex(JsonElement payload)
    {
        var query = ReadPayloadString(payload, "query", "").Trim();
        var limit = Math.Clamp(ReadPayloadInt(payload, "limit", 20), 1, 200);
        var offset = Math.Max(0, ReadPayloadInt(payload, "offset", 0));
        var sourceGroupFilter = ReadPayloadString(payload, "sourceGroup", "").Trim();
        var kindFilter = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty("kinds", out var kindsElement)
            && kindsElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in kindsElement.EnumerateArray())
            {
                var value = item.GetString();
                if (!string.IsNullOrWhiteSpace(value)) kindFilter.Add(value.Trim());
            }
        }

        var indexPath = GetKnowledgeIndexPath();
        if (!File.Exists(indexPath))
        {
            return new { status = BuildKnowledgeIndexStatus(), items = Array.Empty<object>(), totalMatched = 0, offset, limit };
        }

        var matches = new List<object>();
        var graphRelated = BuildMemoryGraphRelatedLookup();
        using var document = JsonDocument.Parse(File.ReadAllText(indexPath, Encoding.UTF8));
        if (!document.RootElement.TryGetProperty("items", out var itemsElement) || itemsElement.ValueKind != JsonValueKind.Array)
        {
            return new { status = BuildKnowledgeIndexStatus(), items = Array.Empty<object>(), totalMatched = 0, offset, limit };
        }

        var normalizedQuery = query.ToLowerInvariant();
        foreach (var item in itemsElement.EnumerateArray())
        {
            var kind = ReadJsonString(item, "kind");
            if (kindFilter.Count > 0 && !kindFilter.Contains(kind)) continue;

            var key = ReadJsonString(item, "key");
            var value = ReadJsonString(item, "value");
            var text = ReadJsonString(item, "text");
            var source = item.TryGetProperty("source", out var sourceElement) && sourceElement.ValueKind == JsonValueKind.Object
                ? sourceElement
                : default;
            var sourcePath = source.ValueKind == JsonValueKind.Object ? ReadJsonString(source, "path") : "";
            if (!IsIndexableMemorySourceItem(sourcePath, source)) continue;
            var sourceUpdatedAt = source.ValueKind == JsonValueKind.Object ? ReadJsonString(source, "updatedAt") : "";
            var snippet = source.ValueKind == JsonValueKind.Object ? ReadJsonString(source, "snippet") : "";
            var sourceGroup = ClassifyMemorySourceGroup(sourcePath);
            if (!string.IsNullOrWhiteSpace(sourceGroupFilter)
                && !string.Equals(sourceGroupFilter, "all", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(sourceGroup, sourceGroupFilter, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            var haystack = $"{kind} {key} {value} {text} {sourcePath} {snippet}".ToLowerInvariant();
            if (!string.IsNullOrWhiteSpace(normalizedQuery) && !haystack.Contains(normalizedQuery))
            {
                var matched = normalizedQuery.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Any(token => haystack.Contains(token));
                if (!matched) continue;
            }

            matches.Add(new
            {
                id = ReadJsonString(item, "id"),
                kind,
                key,
                value,
                text,
                sourceGroup,
                confidence = ReadJsonDouble(item, "confidence"),
                conflict = ReadJsonBool(item, "conflict"),
                classificationReason = ReadJsonString(item, "classificationReason"),
                classificationSource = ReadJsonString(item, "classificationSource"),
                sourcePath,
                sourceUpdatedAt,
                snippet,
                related = LookupMemoryGraphRelated(graphRelated, key, value, text),
            });
        }

        return new
        {
            status = BuildKnowledgeIndexStatus(),
            items = matches.Skip(offset).Take(limit).ToArray(),
            totalMatched = matches.Count,
            offset,
            limit,
        };
    }

    private Dictionary<string, List<object>> BuildMemoryGraphRelatedLookup()
    {
        var graphPath = GetMemoryGraphIndexPath();
        if (!File.Exists(graphPath)) return new Dictionary<string, List<object>>(StringComparer.OrdinalIgnoreCase);
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(graphPath, Encoding.UTF8));
            var root = document.RootElement;
            if (!root.TryGetProperty("nodes", out var nodesElement) || nodesElement.ValueKind != JsonValueKind.Array
                || !root.TryGetProperty("edges", out var edgesElement) || edgesElement.ValueKind != JsonValueKind.Array)
            {
                return new Dictionary<string, List<object>>(StringComparer.OrdinalIgnoreCase);
            }

            var nodesById = nodesElement.EnumerateArray()
                .Where(IsVisibleMemoryGraphElement)
                .Select(node => new
                {
                    id = ReadJsonString(node, "id"),
                    label = ReadJsonString(node, "label"),
                    kind = ReadJsonString(node, "kind"),
                })
                .Where(node => !string.IsNullOrWhiteSpace(node.id) && !string.IsNullOrWhiteSpace(node.label))
                .ToDictionary(node => node.id, node => node, StringComparer.OrdinalIgnoreCase);
            var related = new Dictionary<string, List<object>>(StringComparer.OrdinalIgnoreCase);
            foreach (var edge in edgesElement.EnumerateArray())
            {
                if (!IsVisibleMemoryGraphElement(edge)) continue;
                var from = ReadJsonString(edge, "from");
                var to = ReadJsonString(edge, "to");
                if (!nodesById.TryGetValue(from, out var fromNode) || !nodesById.TryGetValue(to, out var toNode)) continue;
                var item = new
                {
                    label = toNode.label,
                    kind = toNode.kind,
                    type = ReadJsonString(edge, "type"),
                    score = ReadJsonDouble(edge, "weight"),
                };
                var key = fromNode.label.Trim();
                if (!related.TryGetValue(key, out var list))
                {
                    list = [];
                    related[key] = list;
                }
                if (!list.Any(existing => string.Equals(ReadObjectProperty(existing, "label"), item.label, StringComparison.OrdinalIgnoreCase)))
                {
                    list.Add(item);
                }
            }
            return related;
        }
        catch
        {
            return new Dictionary<string, List<object>>(StringComparer.OrdinalIgnoreCase);
        }
    }

    private static object[] LookupMemoryGraphRelated(Dictionary<string, List<object>> related, params string[] labels)
    {
        var merged = new List<object>();
        foreach (var label in labels.Select(value => value.Trim()).Where(value => !string.IsNullOrWhiteSpace(value)))
        {
            if (!related.TryGetValue(label, out var items)) continue;
            foreach (var item in items)
            {
                if (!merged.Any(existing => string.Equals(ReadObjectProperty(existing, "label"), ReadObjectProperty(item, "label"), StringComparison.OrdinalIgnoreCase)))
                {
                    merged.Add(item);
                }
                if (merged.Count >= 8) return merged.ToArray();
            }
        }
        return merged.ToArray();
    }

    private static string ReadObjectProperty(object value, string propertyName)
    {
        var property = value.GetType().GetProperty(propertyName);
        return property?.GetValue(value)?.ToString() ?? "";
    }

    private object ArchiveKnowledgeItem(JsonElement payload)
    {
        var itemId = ReadPayloadString(payload, "id", "");
        var item = FindKnowledgeItem(itemId);
        if (item.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException("未找到知识单元。");
        }

        var source = item.TryGetProperty("source", out var sourceElement) && sourceElement.ValueKind == JsonValueKind.Object
            ? sourceElement
            : default;
        var sourcePath = source.ValueKind == JsonValueKind.Object ? ReadJsonString(source, "path") : "";
        var root = _memoryRepo.Text.Trim();
        if (string.IsNullOrWhiteSpace(sourcePath) || !File.Exists(sourcePath))
        {
            throw new InvalidOperationException("知识单元源文件不存在。");
        }
        var fullRoot = Path.GetFullPath(root);
        var fullSource = Path.GetFullPath(sourcePath);
        if (!IsPathInside(fullRoot, fullSource))
        {
            throw new InvalidOperationException("源文件不在记忆仓库内，已拒绝归档。");
        }

        var content = File.ReadAllText(fullSource, Encoding.UTF8);
        var lines = Regex.Split(content, "\r?\n").ToList();
        var lineIndex = lines.FindIndex(line => KnowledgeLineMatchesItem(line, item));
        if (lineIndex < 0)
        {
            throw new InvalidOperationException("未能在源文件中精确匹配该知识单元。");
        }

        var originalLine = lines[lineIndex];
        var archivedAt = DateTime.UtcNow.ToString("o");
        var archivePath = BuildKnowledgeArchivePath(item, archivedAt);
        Directory.CreateDirectory(Path.GetDirectoryName(archivePath)!);
        File.WriteAllText(archivePath, FormatKnowledgeArchiveMarkdown(item, originalLine, archivedAt), Encoding.UTF8);
        lines.RemoveAt(lineIndex);
        File.WriteAllText(fullSource, string.Join("\n", lines), Encoding.UTF8);

        RemoveKnowledgeItemFromIndex(itemId);
        RemoveReminderForKnowledgeItem(itemId);
        return new { ok = true, itemId, archivePath };
    }

    private object BuildKnowledgeArchiveSnapshot()
    {
        var archiveRoot = GetKnowledgeArchiveRoot();
        var items = new List<object>();
        if (Directory.Exists(archiveRoot))
        {
            foreach (var file in Directory.EnumerateFiles(archiveRoot, "*.md").OrderByDescending(File.GetLastWriteTimeUtc).Take(200))
            {
                try
                {
                    var metadata = ParseMarkdownFrontmatter(File.ReadAllText(file, Encoding.UTF8));
                    items.Add(new
                    {
                        id = Path.GetFileNameWithoutExtension(file),
                        itemId = metadata.GetValueOrDefault("itemId", ""),
                        kind = metadata.GetValueOrDefault("kind", ""),
                        text = metadata.GetValueOrDefault("text", ""),
                        sourcePath = metadata.GetValueOrDefault("sourcePath", ""),
                        archivedAt = metadata.GetValueOrDefault("archivedAt", ""),
                        archivePath = file,
                    });
                }
                catch
                {
                    // Ignore unreadable archive files.
                }
            }
        }
        return new { archiveRoot, items = items.ToArray() };
    }

    private object DeleteKnowledgeArchive(JsonElement payload)
    {
        var archivePath = ReadPayloadString(payload, "path", "");
        var archiveRoot = Path.GetFullPath(GetKnowledgeArchiveRoot());
        var fullArchive = Path.GetFullPath(archivePath);
        if (!IsPathInside(archiveRoot, fullArchive))
        {
            throw new InvalidOperationException("归档文件不在知识归档目录内，已拒绝删除。");
        }
        if (!File.Exists(fullArchive))
        {
            throw new InvalidOperationException("归档文件不存在。");
        }
        File.Delete(fullArchive);
        return new { ok = true, archivePath = fullArchive };
    }

    private object BuildTodoReminderSnapshot()
    {
        var root = _memoryRepo.Text.Trim();
        var indexPath = GetTodoReminderIndexPath();
        var statePath = GetTodoReminderStatePath();
        var pushEnabled = string.Equals(GetConfig("CTI_TODO_PUSH_ENABLED", "false"), "true", StringComparison.OrdinalIgnoreCase);
        var directEnabled = !string.Equals(GetConfig("CTI_DIRECT_REMINDER_ENABLED", "true"), "false", StringComparison.OrdinalIgnoreCase);
        var directPushEnabled = directEnabled && !string.Equals(GetConfig("CTI_DIRECT_REMINDER_PUSH_ENABLED", "true"), "false", StringComparison.OrdinalIgnoreCase);
        var channels = SplitConfigList(GetConfig("CTI_TODO_PUSH_CHANNELS", "feishu")).DefaultIfEmpty("feishu").ToArray();
        var deliveries = ReadReminderDeliveries(statePath);
        var items = new List<object>();
        var lastError = "";

        if (File.Exists(indexPath))
        {
            try
            {
                using var document = JsonDocument.Parse(File.ReadAllText(indexPath, Encoding.UTF8));
                if (document.RootElement.TryGetProperty("reminders", out var remindersElement)
                    && remindersElement.ValueKind == JsonValueKind.Array)
                {
                    foreach (var reminder in remindersElement.EnumerateArray())
                    {
                        var id = ReadJsonString(reminder, "id");
                        var target = reminder.TryGetProperty("target", out var targetElement) && targetElement.ValueKind == JsonValueKind.Object
                            ? targetElement
                            : default;
                        var source = reminder.TryGetProperty("source", out var sourceElement) && sourceElement.ValueKind == JsonValueKind.Object
                            ? sourceElement
                            : default;
                        deliveries.TryGetValue(id, out var delivery);
                        var displayStatus = ResolveReminderDisplayStatus(ReadJsonString(reminder, "status"), ReadJsonString(reminder, "todoStatus"), delivery);
                        items.Add(new
                        {
                            id,
                            title = ReadJsonString(reminder, "title"),
                            dueAt = ReadJsonString(reminder, "dueAt"),
                            todoStatus = ReadJsonString(reminder, "todoStatus"),
                            status = displayStatus,
                            sourceType = ReadJsonString(reminder, "sourceType", "memory"),
                            createdAt = ReadJsonString(reminder, "createdAt"),
                            createdByMessageId = ReadJsonString(reminder, "createdByMessageId"),
                            skipReason = ReadJsonString(reminder, "skipReason"),
                            completedAt = ReadJsonString(delivery, "completedAt", ""),
                            completedByUserId = ReadJsonString(delivery, "completedByUserId", ""),
                            completionSource = ReadJsonString(delivery, "completionSource", ""),
                            completionError = ReadJsonString(delivery, "completionError", ""),
                            target = new
                            {
                                channelType = target.ValueKind == JsonValueKind.Object ? ReadJsonString(target, "channelType") : "",
                                chatId = target.ValueKind == JsonValueKind.Object ? ReadJsonString(target, "chatId") : "",
                                displayName = target.ValueKind == JsonValueKind.Object ? ReadJsonString(target, "displayName") : "",
                                messageId = target.ValueKind == JsonValueKind.Object ? ReadJsonString(target, "messageId") : "",
                            },
                            source = new
                            {
                                path = source.ValueKind == JsonValueKind.Object ? ReadJsonString(source, "path") : "",
                                snippet = source.ValueKind == JsonValueKind.Object ? ReadJsonString(source, "snippet") : "",
                                updatedAt = source.ValueKind == JsonValueKind.Object ? ReadJsonString(source, "updatedAt") : "",
                            },
                            delivery = delivery,
                        });
                    }
                }
            }
            catch (Exception ex)
            {
                lastError = ex.Message;
            }
        }
        else if (!Directory.Exists(root))
        {
            lastError = $"记忆仓库不存在：{root}";
        }

        var pendingCount = items.Count(item => ReminderStatusEquals(item, "pending"));
        var sentCount = items.Count(item => ReminderStatusEquals(item, "sent"));
        var failedCount = items.Count(item => ReminderStatusEquals(item, "failed"));
        var skippedCount = items.Count(item => ReminderStatusEquals(item, "skipped"));
        var completedCount = items.Count(item => ReminderStatusEquals(item, "completed"));

        return new
        {
            schema = "codex-im-suite/reminders-panel/v1",
            memoryRoot = root,
            indexPath,
            statePath,
            exists = File.Exists(indexPath),
            enabled = pushEnabled || directPushEnabled,
            memoryPushEnabled = pushEnabled,
            directReminderEnabled = directEnabled,
            directReminderPushEnabled = directPushEnabled,
            pollMs = int.TryParse(GetConfig("CTI_TODO_PUSH_POLL_MS", "60000"), out var pollMs) ? pollMs : 60000,
            windowMs = int.TryParse(GetConfig("CTI_TODO_PUSH_WINDOW_MS", "300000"), out var windowMs) ? windowMs : 300000,
            channels,
            providers = new[]
            {
                new { channelType = "feishu", state = (pushEnabled || directPushEnabled) && channels.Contains("feishu", StringComparer.OrdinalIgnoreCase) ? "ok" : "disabled", detail = "飞书主动推送" },
                new { channelType = "weixin", state = "unsupported", detail = "微信主动推送 v1 未接入" },
            },
            counts = new
            {
                total = items.Count,
                pending = pendingCount,
                sent = sentCount,
                failed = failedCount,
                skipped = skippedCount,
                completed = completedCount,
            },
            items = items.ToArray(),
            lastError,
        };
    }

    private static bool ReminderStatusEquals(object item, string expected)
    {
        var prop = item.GetType().GetProperty("status");
        return string.Equals(prop?.GetValue(item)?.ToString(), expected, StringComparison.OrdinalIgnoreCase);
    }

    private static string ResolveReminderDisplayStatus(string reminderStatus, string todoStatus, JsonObject? delivery)
    {
        if (!string.IsNullOrWhiteSpace(ReadJsonString(delivery, "completedAt", "")) || string.Equals(todoStatus, "done", StringComparison.OrdinalIgnoreCase))
        {
            return "completed";
        }
        var deliveryStatus = ReadJsonString(delivery, "status", "");
        return string.IsNullOrWhiteSpace(deliveryStatus) ? reminderStatus : deliveryStatus;
    }

    private static Dictionary<string, JsonObject> ReadReminderDeliveries(string statePath)
    {
        var result = new Dictionary<string, JsonObject>(StringComparer.OrdinalIgnoreCase);
        if (!File.Exists(statePath)) return result;
        try
        {
            var node = JsonNode.Parse(File.ReadAllText(statePath, Encoding.UTF8)) as JsonObject;
            var deliveries = node?["deliveries"] as JsonObject;
            if (deliveries is null) return result;
            foreach (var pair in deliveries)
            {
                if (pair.Value is JsonObject obj) result[pair.Key] = obj;
            }
        }
        catch
        {
            return result;
        }
        return result;
    }

    private JsonElement FindKnowledgeItem(string id)
    {
        var indexPath = GetKnowledgeIndexPath();
        if (string.IsNullOrWhiteSpace(id) || !File.Exists(indexPath)) return default;
        using var document = JsonDocument.Parse(File.ReadAllText(indexPath, Encoding.UTF8));
        if (!document.RootElement.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array) return default;
        foreach (var item in items.EnumerateArray())
        {
            var source = item.TryGetProperty("source", out var sourceElement) && sourceElement.ValueKind == JsonValueKind.Object
                ? sourceElement
                : default;
            var sourcePath = source.ValueKind == JsonValueKind.Object ? ReadJsonString(source, "path") : "";
            if (!IsIndexableMemorySourceItem(sourcePath, source)) continue;
            if (string.Equals(ReadJsonString(item, "id"), id, StringComparison.OrdinalIgnoreCase))
            {
                return item.Clone();
            }
        }
        return default;
    }

    private static bool KnowledgeLineMatchesItem(string line, JsonElement item)
    {
        var source = item.TryGetProperty("source", out var sourceElement) && sourceElement.ValueKind == JsonValueKind.Object
            ? sourceElement
            : default;
        var normalizedLine = NormalizeKnowledgeLine(line);
        var snippet = source.ValueKind == JsonValueKind.Object ? NormalizeKnowledgeLine(ReadJsonString(source, "snippet")) : "";
        if (!string.IsNullOrWhiteSpace(snippet) && string.Equals(normalizedLine, snippet, StringComparison.Ordinal)) return true;
        var key = NormalizeKnowledgeLine(ReadJsonString(item, "key"));
        var value = NormalizeKnowledgeLine(ReadJsonString(item, "value"));
        if (!string.IsNullOrWhiteSpace(key) && !string.IsNullOrWhiteSpace(value))
        {
            return normalizedLine.Contains(key, StringComparison.Ordinal) && normalizedLine.Contains(value, StringComparison.Ordinal);
        }
        var text = NormalizeKnowledgeLine(ReadJsonString(item, "text"));
        return !string.IsNullOrWhiteSpace(text) && normalizedLine.Contains(text, StringComparison.Ordinal);
    }

    private static string NormalizeKnowledgeLine(string value)
    {
        var normalized = Regex.Replace(value, @"`([^`]+)`", "$1");
        normalized = Regex.Replace(normalized, @"\[([^\]]+)\]\([^)]+\)", "$1");
        normalized = Regex.Replace(normalized, @"^\s*[-*]\s+", "");
        normalized = Regex.Replace(normalized, @"\s+", " ");
        return normalized.Trim();
    }

    private string BuildKnowledgeArchivePath(JsonElement item, string archivedAt)
    {
        var stamp = Regex.Replace(archivedAt, @"\D", "");
        if (stamp.Length > 14) stamp = stamp[..14];
        if (string.IsNullOrWhiteSpace(stamp)) stamp = DateTime.UtcNow.ToString("yyyyMMddHHmmss");
        var itemId = ReadJsonString(item, "id");
        var kind = ReadJsonString(item, "kind", "item");
        var suffix = Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes($"{itemId}:{archivedAt}"))).ToLowerInvariant()[..8];
        return Path.Combine(GetKnowledgeArchiveRoot(), $"{stamp}-{kind}-{itemId[..Math.Min(8, itemId.Length)]}-{suffix}.md");
    }

    private static string FormatKnowledgeArchiveMarkdown(JsonElement item, string originalLine, string archivedAt)
    {
        var source = item.TryGetProperty("source", out var sourceElement) && sourceElement.ValueKind == JsonValueKind.Object
            ? sourceElement
            : default;
        var text = ReadJsonString(item, "value", ReadJsonString(item, "text"));
        var sourcePath = source.ValueKind == JsonValueKind.Object ? ReadJsonString(source, "path") : "";
        return string.Join("\n", new[]
        {
            "---",
            "schema: codex-im-suite/knowledge-archive/v1",
            $"itemId: {ReadJsonString(item, "id")}",
            $"kind: {ReadJsonString(item, "kind")}",
            $"archivedAt: {archivedAt}",
            $"sourcePath: {sourcePath}",
            $"text: {text.Replace("\r", " ").Replace("\n", " ").Replace("\"", "\\\"")}",
            "---",
            "",
            "# Archived knowledge unit",
            "",
            $"Kind: {ReadJsonString(item, "kind")}",
            $"Text: {text}",
            $"Source: {sourcePath}",
            "",
            "```markdown",
            originalLine,
            "```",
            "",
        });
    }

    private static Dictionary<string, string> ParseMarkdownFrontmatter(string content)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var match = Regex.Match(content, @"^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)");
        if (!match.Success) return result;
        foreach (var rawLine in Regex.Split(match.Groups[1].Value, "\r?\n"))
        {
            var separator = rawLine.IndexOf(':');
            if (separator <= 0) continue;
            var key = rawLine[..separator].Trim();
            var value = rawLine[(separator + 1)..].Trim().Trim('"', '\'');
            if (!string.IsNullOrWhiteSpace(key)) result[key] = value;
        }
        return result;
    }

    private void RemoveKnowledgeItemFromIndex(string itemId)
    {
        var indexPath = GetKnowledgeIndexPath();
        var root = ReadJsonObjectFile(indexPath);
        var items = root?["items"] as JsonArray;
        if (root is null || items is null) return;
        for (var index = items.Count - 1; index >= 0; index--)
        {
            if (items[index] is JsonObject item && string.Equals(ReadJsonString(item, "id", ""), itemId, StringComparison.OrdinalIgnoreCase))
            {
                items.RemoveAt(index);
            }
        }
        root["itemCount"] = items.Count;
        root["conflictCount"] = items.OfType<JsonObject>().Count(item => ReadJsonBool(item, "conflict"));
        WriteJsonObjectFile(indexPath, root);
    }

    private void RemoveReminderForKnowledgeItem(string itemId)
    {
        var indexPath = GetTodoReminderIndexPath();
        var root = ReadJsonObjectFile(indexPath);
        var reminders = root?["reminders"] as JsonArray;
        if (root is null || reminders is null) return;
        for (var index = reminders.Count - 1; index >= 0; index--)
        {
            if (reminders[index] is not JsonObject reminder) continue;
            if (string.Equals(ReadJsonString(reminder, "id", ""), itemId, StringComparison.OrdinalIgnoreCase)
                || string.Equals(ReadJsonString(reminder, "sourceKnowledgeId", ""), itemId, StringComparison.OrdinalIgnoreCase))
            {
                reminders.RemoveAt(index);
            }
        }
        root["reminderCount"] = reminders.Count;
        root["pendingCount"] = reminders.OfType<JsonObject>().Count(item => string.Equals(ReadJsonString(item, "status", ""), "pending", StringComparison.OrdinalIgnoreCase));
        root["skippedCount"] = reminders.OfType<JsonObject>().Count(item => string.Equals(ReadJsonString(item, "status", ""), "skipped", StringComparison.OrdinalIgnoreCase));
        WriteJsonObjectFile(indexPath, root);
    }

    private static bool IsPathInside(string root, string candidate)
    {
        var normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var normalizedCandidate = Path.GetFullPath(candidate);
        return normalizedCandidate.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase);
    }

    private async Task<object> RunMemoryOptimizerCliAsync(string command, JsonElement payload)
    {
        var root = _memoryRepo.Text.Trim();
        if (string.IsNullOrWhiteSpace(root))
        {
            throw new InvalidOperationException("记忆仓库路径为空。");
        }
        var runtimeRoot = Path.Combine(_suiteRoot, "packages", "bridge-runtime");
        var distCli = Path.Combine(runtimeRoot, "dist", "memory-optimizer-cli.mjs");
        var srcCli = Path.Combine(runtimeRoot, "src", "memory-optimizer-cli.ts");
        var useDist = File.Exists(distCli);
        var cliPath = useDist ? distCli : srcCli;
        if (!File.Exists(cliPath))
        {
            throw new InvalidOperationException("未找到记忆整理 CLI。请先运行 bridge-runtime 构建。");
        }

        var args = new List<string>();
        if (!useDist)
        {
            args.Add("--import");
            args.Add("tsx");
        }
        args.Add(cliPath);
        args.Add(command);
        args.Add("--memory-root");
        args.Add(root);

        if (string.Equals(command, "preview", StringComparison.OrdinalIgnoreCase))
        {
            args.Add("--model-source");
            args.Add(ReadPayloadString(payload, "modelSource", GetConfig("CTI_MEMORY_OPTIMIZER_MODEL_SOURCE", "codex_primary")));
            args.Add("--generated-by");
            args.Add("manual");
        }
        else if (string.Equals(command, "apply", StringComparison.OrdinalIgnoreCase)
            || string.Equals(command, "undo", StringComparison.OrdinalIgnoreCase)
            || string.Equals(command, "discard", StringComparison.OrdinalIgnoreCase))
        {
            var draftId = ReadPayloadString(payload, "draftId", "");
            if (string.IsNullOrWhiteSpace(draftId)) throw new InvalidOperationException("缺少草稿 ID。");
            args.Add("--draft-id");
            args.Add(draftId);
            if (string.Equals(command, "apply", StringComparison.OrdinalIgnoreCase))
            {
                args.Add("--select");
                args.Add(ReadSelectedActionIds(payload));
            }
        }
        else if (string.Equals(command, "restore-archive", StringComparison.OrdinalIgnoreCase))
        {
            var archivePath = ReadPayloadString(payload, "archivePath", ReadPayloadString(payload, "path", ""));
            if (string.IsNullOrWhiteSpace(archivePath)) throw new InvalidOperationException("缺少归档文件路径。");
            args.Add("--archive-path");
            args.Add(archivePath);
        }
        else if (string.Equals(command, "schedule", StringComparison.OrdinalIgnoreCase))
        {
            args.Add("--enabled");
            args.Add(ReadPayloadBool(payload, "enabled", false) ? "true" : "false");
            args.Add("--interval-days");
            args.Add(ReadPayloadInt(payload, "intervalDays", 7).ToString(CultureInfo.InvariantCulture));
            args.Add("--model-source");
            args.Add(ReadPayloadString(payload, "modelSource", "codex_primary"));
        }

        var result = await RunProcessAsync("node", string.Join(" ", args.Select(QuoteProcessArgument)), runtimeRoot, timeoutMs: 120000);
        if (result.ExitCode != 0)
        {
            var detail = string.Join("\n", new[] { result.Stdout, result.Stderr }.Where(text => !string.IsNullOrWhiteSpace(text))).Trim();
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(detail) ? "记忆整理命令执行失败。" : detail);
        }
        if (string.Equals(command, "schedule", StringComparison.OrdinalIgnoreCase))
        {
            var lines = ReadEnvFileLines(_configPath);
            SetOrAppendEnv(lines, "CTI_MEMORY_OPTIMIZER_ENABLED", ReadPayloadBool(payload, "enabled", false) ? "true" : "false");
            SetOrAppendEnv(lines, "CTI_MEMORY_OPTIMIZER_INTERVAL_DAYS", NormalizePositiveNumber(ReadPayloadInt(payload, "intervalDays", 7).ToString(CultureInfo.InvariantCulture), "7"));
            SetOrAppendEnv(lines, "CTI_MEMORY_OPTIMIZER_MODEL_SOURCE", NormalizeMemoryOptimizerModelSource(ReadPayloadString(payload, "modelSource", "codex_primary")));
            File.WriteAllLines(_configPath, lines, new UTF8Encoding(false));
            LoadConfig();
        }
        var stdout = result.Stdout.Trim();
        if (string.IsNullOrWhiteSpace(stdout)) return BuildMemoryOptimizationStatusSnapshot();
        return JsonNode.Parse(stdout) ?? new JsonObject();
    }

    private static string ReadSelectedActionIds(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object
            || !payload.TryGetProperty("selectedActionIds", out var element)
            || element.ValueKind != JsonValueKind.Array)
        {
            return "";
        }
        return string.Join(",", element.EnumerateArray()
            .Select(item => item.GetString() ?? "")
            .Where(value => !string.IsNullOrWhiteSpace(value)));
    }

    private static string QuoteProcessArgument(string value)
        => "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

    private async Task<object> TestTodoReminderAsync(JsonElement payload)
    {
        var id = ReadPayloadString(payload, "id", "");
        var reminder = FindTodoReminder(id);
        if (reminder.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException("未找到待办提醒。");
        }
        var target = reminder.TryGetProperty("target", out var targetElement) && targetElement.ValueKind == JsonValueKind.Object
            ? targetElement
            : default;
        var channelType = target.ValueKind == JsonValueKind.Object ? ReadJsonString(target, "channelType") : "";
        var chatId = target.ValueKind == JsonValueKind.Object ? ReadJsonString(target, "chatId") : "";
        if (!string.Equals(channelType, "feishu", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("测试发送 v1 仅支持飞书；微信主动推送未接入。");
        }
        if (string.IsNullOrWhiteSpace(chatId))
        {
            throw new InvalidOperationException("缺少飞书 chatId，不能测试发送。");
        }

        var title = ReadJsonString(reminder, "title", "未命名待办");
        var dueAt = ReadJsonString(reminder, "dueAt");
        var text = $"测试待办提醒：{title}\n时间：{dueAt}\n来源：控制面板测试发送";
        var messageId = await SendFeishuTextAsync(chatId, text);
        return new { ok = true, messageId };
    }

    private object CompleteTodoReminder(JsonElement payload)
    {
        var id = ReadPayloadString(payload, "id", "");
        var reminder = FindTodoReminder(id);
        if (reminder.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException("未找到待办提醒。");
        }

        var delivery = ReadReminderDeliveries(GetTodoReminderStatePath()).GetValueOrDefault(id);
        if (!string.IsNullOrWhiteSpace(ReadJsonString(delivery, "completedAt", "")) ||
            string.Equals(ReadJsonString(reminder, "todoStatus"), "done", StringComparison.OrdinalIgnoreCase))
        {
            return new { ok = true, status = "already_completed", reminderId = id, title = ReadJsonString(reminder, "title") };
        }

        var completedAt = DateTime.UtcNow.ToString("o");
        var sourceUpdated = UpdateReminderMarkdownStatus(reminder, out var completionError);
        UpdateReminderIndexCompletion(id, sourceUpdated, completionError);
        UpsertReminderCompletionState(reminder, completedAt, "panel", completionError);
        return new
        {
            ok = true,
            status = sourceUpdated ? "completed" : "state_only",
            reminderId = id,
            title = ReadJsonString(reminder, "title"),
            sourceUpdated,
            completionError,
        };
    }

    private bool UpdateReminderMarkdownStatus(JsonElement reminder, out string completionError)
    {
        completionError = "";
        var source = reminder.TryGetProperty("source", out var sourceElement) && sourceElement.ValueKind == JsonValueKind.Object
            ? sourceElement
            : default;
        var sourcePath = source.ValueKind == JsonValueKind.Object ? ReadJsonString(source, "path") : "";
        var root = _memoryRepo.Text.Trim();
        if (string.IsNullOrWhiteSpace(sourcePath) || !File.Exists(sourcePath))
        {
            completionError = "源文件不存在。";
            return false;
        }
        var fullSource = Path.GetFullPath(sourcePath);
        var fullRoot = Path.GetFullPath(root);
        if (!fullSource.StartsWith(fullRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        {
            completionError = "源文件不在记忆仓库内，已拒绝自动修改。";
            return false;
        }

        var markdown = File.ReadAllText(fullSource, Encoding.UTF8);
        var lines = Regex.Split(markdown, "\r?\n").ToList();
        var title = ReadJsonString(reminder, "title");
        var index = lines.FindIndex(line =>
            Regex.IsMatch(line, @"状态\s*[:：]\s*未完成") &&
            (string.IsNullOrWhiteSpace(title) || line.Contains(title, StringComparison.Ordinal)));
        if (index >= 0)
        {
            lines[index] = Regex.Replace(lines[index], @"状态\s*[:：]\s*未完成", "状态: 完成");
            File.WriteAllText(fullSource, string.Join("\n", lines), Encoding.UTF8);
            return true;
        }

        if (string.Equals(ReadJsonString(reminder, "sourceType", "memory"), "direct", StringComparison.OrdinalIgnoreCase))
        {
            var replaced = Regex.Replace(markdown, @"状态\s*[:：]\s*未完成", "状态: 完成", RegexOptions.None, TimeSpan.FromSeconds(1));
            if (!string.Equals(replaced, markdown, StringComparison.Ordinal))
            {
                File.WriteAllText(fullSource, replaced, Encoding.UTF8);
                return true;
            }
        }

        completionError = "未能在源文件中精确匹配同一条未完成待办。";
        return false;
    }

    private void UpdateReminderIndexCompletion(string reminderId, bool sourceUpdated, string completionError)
    {
        var indexPath = GetTodoReminderIndexPath();
        var root = ReadJsonObjectFile(indexPath);
        var reminders = root?["reminders"] as JsonArray;
        if (root is null || reminders is null) return;
        foreach (var node in reminders.OfType<JsonObject>())
        {
            if (!string.Equals(ReadJsonString(node, "id", ""), reminderId, StringComparison.OrdinalIgnoreCase)) continue;
            if (sourceUpdated)
            {
                node["todoStatus"] = "done";
                node["status"] = "skipped";
                node["skipReason"] = "状态为完成";
                if (node["source"] is JsonObject source && !string.IsNullOrWhiteSpace(ReadJsonString(source, "snippet", "")))
                {
                    source["snippet"] = Regex.Replace(ReadJsonString(source, "snippet", ""), @"状态\s*[:：]\s*未完成", "状态: 完成");
                }
            }
            else
            {
                node["completionError"] = completionError;
            }
            break;
        }
        root["pendingCount"] = reminders.OfType<JsonObject>().Count(item => string.Equals(ReadJsonString(item, "status", ""), "pending", StringComparison.OrdinalIgnoreCase));
        root["skippedCount"] = reminders.OfType<JsonObject>().Count(item => string.Equals(ReadJsonString(item, "status", ""), "skipped", StringComparison.OrdinalIgnoreCase));
        root["reminderCount"] = reminders.Count;
        WriteJsonObjectFile(indexPath, root);
    }

    private void UpsertReminderCompletionState(JsonElement reminder, string completedAt, string completionSource, string completionError)
    {
        var statePath = GetTodoReminderStatePath();
        var root = ReadJsonObjectFile(statePath) ?? new JsonObject
        {
            ["schema"] = "codex-im-suite/reminder-state/v1",
            ["updatedAt"] = DateTime.UtcNow.ToString("o"),
            ["deliveries"] = new JsonObject(),
        };
        var deliveries = root["deliveries"] as JsonObject ?? new JsonObject();
        root["deliveries"] = deliveries;
        var id = ReadJsonString(reminder, "id");
        var target = reminder.TryGetProperty("target", out var targetElement) && targetElement.ValueKind == JsonValueKind.Object
            ? targetElement
            : default;
        var existing = deliveries[id] as JsonObject ?? new JsonObject();
        existing["reminderId"] = id;
        existing["status"] = ReadJsonString(existing, "status", ReadJsonString(reminder, "status", "pending"));
        existing["channelType"] = target.ValueKind == JsonValueKind.Object ? ReadJsonString(target, "channelType") : "";
        existing["chatId"] = target.ValueKind == JsonValueKind.Object ? ReadJsonString(target, "chatId") : "";
        existing["dueAt"] = ReadJsonString(reminder, "dueAt");
        existing["attempts"] = ReadJsonInt(existing, "attempts", 0);
        existing["completedAt"] = completedAt;
        existing["completionSource"] = completionSource;
        existing["completionError"] = completionError;
        deliveries[id] = existing;
        WriteJsonObjectFile(statePath, root);
    }

    private JsonElement FindTodoReminder(string id)
    {
        var indexPath = GetTodoReminderIndexPath();
        if (string.IsNullOrWhiteSpace(id) || !File.Exists(indexPath)) return default;
        using var document = JsonDocument.Parse(File.ReadAllText(indexPath, Encoding.UTF8));
        if (!document.RootElement.TryGetProperty("reminders", out var reminders) || reminders.ValueKind != JsonValueKind.Array) return default;
        foreach (var reminder in reminders.EnumerateArray())
        {
            if (string.Equals(ReadJsonString(reminder, "id"), id, StringComparison.OrdinalIgnoreCase))
            {
                return reminder.Clone();
            }
        }
        return default;
    }

    private async Task<string> SendFeishuTextAsync(string chatId, string text)
    {
        var idempotencyKey = LarkCliGateway.CreateIdempotencyKey("panel");
        return await CreateLarkCliGateway().SendTextAsync(chatId, text, idempotencyKey, _ctiHome);
    }

    private WebRuntimeUnit[] BuildRuntimeUnits()
    {
        var runtimeManifests = LoadRuntimeUnitManifestMap();
        var units = new List<WebRuntimeUnit>
        {
            BuildBridgeRuntimeUnit(GetRuntimeManifestOrFallback(
                runtimeManifests,
                "service.bridge",
                "飞书桥接",
                "service",
                "bridge",
                "installed",
                _skillDir,
                _skillDir,
                "",
                "负责 Feishu / Codex / 本地执行链路的主桥接服务。")),
            BuildCodexRuntimeUnit(GetRuntimeManifestOrFallback(
                runtimeManifests,
                "service.codex",
                "Codex CLI",
                "tool",
                "codex",
                "installed",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm"),
                "",
                "Codex CLI 工具型服务，默认提供检查与工作目录入口，不伪造常驻 daemon 开关。")),
            BuildManagedToolRuntimeUnit(GetRuntimeManifestOrFallback(
                runtimeManifests,
                "service.feishuCli",
                "Bridge Skill 更新",
                "tool",
                "bridge-skill",
                "installed",
                _skillDir,
                _skillDir,
                "",
                "历史兼容 id；负责桥接 Skill / runtime 包更新，不承担 daemon 启停。")),
            BuildLocalLlmRuntimeUnit(GetRuntimeManifestOrFallback(
                runtimeManifests,
                "service.localLlm",
                "本地模型 API",
                "service",
                "local-ai",
                "installed",
                _localLlmReadmePath,
                Path.GetDirectoryName(_localLlmStartScript) ?? "",
                "",
                "本地或自托管 OpenAI-compatible 模型后端，用作 Codex agent 的可选模型来源。")),
        };

        // 带 update 声明的外部 CLI 工具由 runtime manifest 自动进入面板，避免以后每接一个官方工具都改 C# 分支。
        var knownUnitIds = units.Select(unit => unit.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var manifest in runtimeManifests.Values
                     .Where(item => item.Update is not null && string.Equals(item.Kind, "tool", StringComparison.OrdinalIgnoreCase))
                     .OrderBy(item => item.DisplayName, StringComparer.OrdinalIgnoreCase))
        {
            if (knownUnitIds.Add(manifest.Id))
            {
                units.Add(BuildManagedToolRuntimeUnit(manifest));
            }
        }

        foreach (var manifest in _manifests)
        {
            var hasLauncher = !string.IsNullOrWhiteSpace(ResolveManifestPath(manifest.Launcher, manifest)) && File.Exists(ResolveManifestPath(manifest.Launcher, manifest));
            var canInstall = ManifestSupportsInstall(manifest.ManifestPath);
            var updatePlan = ResolveManifestUpdatePlan(
                manifest.ManifestPath ?? "",
                ResolveManifestDirectory(manifest.Cwd, manifest),
                FormatManifestSource(manifest.Source, manifest));
            var actions = new List<WebRuntimeAction>
            {
                new("check", "检查", true),
                new("start", "启动", manifest.Enabled != false && hasLauncher),
                new("stop", "停止", manifest.Enabled != false),
                new("install", "安装", canInstall),
            };
            if (updatePlan is not null)
            {
                actions.Add(new WebRuntimeAction("update", "更新", updatePlan.CanUpdate, updatePlan.Reason ?? ""));
            }
            actions.Add(new WebRuntimeAction("register", "注册", true));
            actions.Add(new WebRuntimeAction("openLocation", "打开位置", true));
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
                actions.ToArray()));
        }

        foreach (var item in BuildExtensionItems())
        {
            var updatePlan = ResolveManifestUpdatePlan(item.ManifestPath, ExpandManifestValue(item.Source), item.Source);
            var actions = new List<WebRuntimeAction>
            {
                new("enable", "启用", !item.Enabled),
                new("disable", "禁用", item.Enabled),
                new("install", "安装", item.CanInstall),
            };
            if (updatePlan is not null)
            {
                actions.Add(new WebRuntimeAction("update", "更新", updatePlan.CanUpdate, updatePlan.Reason ?? ""));
            }
            actions.Add(new WebRuntimeAction("remove", "移除记录", item.CanRemove));
            actions.Add(new WebRuntimeAction("openManifest", "Manifest", true));
            actions.Add(new WebRuntimeAction("openSource", "Source", item.SourceExists));
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
                actions.ToArray()));
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

    private async Task<WebExtensionCatalogSnapshot> BuildExtensionCatalogSnapshotAsync(bool forceRefresh)
    {
        var entries = await LoadExtensionCatalogEntriesAsync(forceRefresh);
        var lockFile = ReadExtensionInstallLock();
        var ollamaModels = await ReadInstalledOllamaModelNamesAsync();
        var installedManifests = ReadCatalogInstalledManifests();
        var catalogModels = entries
            .Select(entry => GetOllamaCatalogModel(entry.Item))
            .Where(model => !string.IsNullOrWhiteSpace(model))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var items = entries
            .Select(entry =>
            {
                var installed = lockFile.Entries.FirstOrDefault(item =>
                    string.Equals(item.Id, entry.Item.Id, StringComparison.OrdinalIgnoreCase)
                    && string.Equals(item.Type, entry.Item.Type, StringComparison.OrdinalIgnoreCase));
                installedManifests.TryGetValue($"{entry.Item.Type}::{entry.Item.Id}", out var manifestInstall);
                var ollamaModel = GetOllamaCatalogModel(entry.Item);
                var detectedOllamaModel = !string.IsNullOrWhiteSpace(ollamaModel)
                    && ollamaModels.Contains(ollamaModel);
                var isInstalled = installed is not null || manifestInstall is not null || detectedOllamaModel;
                var canRemove = installed is not null || (manifestInstall is not null && IsUserExtensionPath(manifestInstall.ManifestPath));
                return new WebExtensionCatalogItem(
                    entry.Item.Id,
                    entry.Item.Type,
                    entry.Item.DisplayName,
                    entry.Item.Version,
                    entry.Item.Category,
                    entry.Item.Description,
                    entry.Item.InstallHandler,
                    entry.Item.Artifact?.Url ?? entry.Item.Source,
                    entry.CatalogSource,
                    entry.SourceLayer,
                    entry.SourceName,
                    entry.FetchedAt,
                    entry.RankBasis,
                    entry.RankOrder,
                    entry.Trusted || !string.IsNullOrWhiteSpace(entry.Item.Sha256),
                    string.IsNullOrWhiteSpace(entry.Item.Sha256) ? "untrusted" : "sha256",
                    IsSupportedInstallHandler(entry.Item.InstallHandler),
                    isInstalled,
                    canRemove,
                    installed?.Version ?? manifestInstall?.Version ?? (detectedOllamaModel ? entry.Item.Version : ""),
                    installed?.InstalledAt ?? (manifestInstall is not null ? "manifest" : detectedOllamaModel ? "detected by Ollama" : ""),
                    installed?.PackagePath ?? installed?.ManifestPath ?? manifestInstall?.ManifestPath ?? (detectedOllamaModel ? ollamaModel : ""));
            })
            .Concat(ollamaModels
                .Where(model => !catalogModels.Contains(model))
                .Select(model => new WebExtensionCatalogItem(
                    NormalizeCatalogId($"ollama-local-{model}"),
                    "model",
                    model,
                    "local",
                    "model.ollama.local",
                    "Ollama 本机已安装模型；可直接设为本地 API 模型，或从本机卸载。",
                    "ollama.pull",
                    model,
                    "ollama://local",
                    "local",
                    "Ollama 本机",
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
                    "本机 /api/tags",
                    0,
                    true,
                    "local",
                    true,
                    true,
                    true,
                    "local",
                    "detected by Ollama",
                    model)))
            .OrderBy(item => GetCatalogLayerSortRank(item.SourceLayer))
            .ThenBy(item => item.Type, StringComparer.OrdinalIgnoreCase)
            .ThenBy(item => item.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        return new WebExtensionCatalogSnapshot(
            "extension-catalog/v2",
            DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
            entries.Select(item => item.CatalogSource).Distinct(StringComparer.OrdinalIgnoreCase).Count(),
            new WebExtensionCatalogLayerCounts(
                items.Count(item => item.SourceLayer == "seed"),
                items.Count(item => item.SourceLayer == "dynamic"),
                items.Count(item => item.SourceLayer == "custom_url")),
            items);
    }

    private Dictionary<string, CatalogInstalledManifest> ReadCatalogInstalledManifests()
    {
        var results = new Dictionary<string, CatalogInstalledManifest>(StringComparer.OrdinalIgnoreCase);
        foreach (var (dir, kind) in GetExtensionManifestDirs())
        {
            foreach (var file in Directory.GetFiles(dir, "*.json").OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
            {
                try
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(file, Encoding.UTF8));
                    var root = doc.RootElement;
                    var id = ReadJsonString(root, "id");
                    if (string.IsNullOrWhiteSpace(id)) id = Path.GetFileNameWithoutExtension(file);
                    var type = kind == "extension" ? "mcp" : kind;
                    results[$"{type}::{NormalizeCatalogId(id)}"] = new CatalogInstalledManifest(
                        NormalizeCatalogId(id),
                        type,
                        ReadJsonString(root, "displayName"),
                        ReadJsonString(root, "version"),
                        file);
                }
                catch
                {
                    // Ignore malformed extension manifests in catalog state matching.
                }
            }
        }
        return results;
    }

    private async Task<List<ExtensionCatalogEntry>> LoadExtensionCatalogEntriesAsync(bool forceRefresh)
    {
        var entries = new List<ExtensionCatalogEntry>();
        if (File.Exists(_extensionCatalogSeedPath))
        {
            var fetchedAt = File.GetLastWriteTime(_extensionCatalogSeedPath).ToString("yyyy-MM-dd HH:mm:ss");
            entries.AddRange(ParseExtensionCatalog(
                File.ReadAllText(_extensionCatalogSeedPath, Encoding.UTF8),
                _extensionCatalogSeedPath,
                trusted: true,
                sourceLayer: "seed",
                sourceName: "本地种子",
                fetchedAt: fetchedAt,
                rankBasis: "suite 静态种子"));
        }

        entries.AddRange(await LoadDynamicExtensionCatalogEntriesAsync(forceRefresh));

        var urls = SplitConfigList(GetConfig("CTI_EXTENSION_CATALOG_URLS", ""));
        if (urls.Count > 0)
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(forceRefresh ? 25 : 12) };
            foreach (var url in urls)
            {
                if (!IsHttpsUrl(url))
                {
                    AddWebActivity("warning", "扩展目录已跳过", $"只允许 HTTPS：{url}");
                    continue;
                }
                try
                {
                    var raw = await client.GetStringAsync(url);
                    entries.AddRange(ParseExtensionCatalog(
                        raw,
                        url,
                        trusted: true,
                        sourceLayer: "custom_url",
                        sourceName: new Uri(url).Host,
                        fetchedAt: DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
                        rankBasis: "用户自定义 URL"));
                }
                catch (Exception ex)
                {
                    AddWebActivity("warning", "扩展目录读取失败", $"{url} · {ex.Message}");
                }
            }
        }

        var bestEntries = new Dictionary<string, ExtensionCatalogEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in entries.Where(entry => !string.IsNullOrWhiteSpace(entry.Item.Id)))
        {
            var key = $"{entry.Item.Type}::{entry.Item.Id}";
            if (!bestEntries.TryGetValue(key, out var existing) || GetCatalogLayerPriority(entry.SourceLayer) >= GetCatalogLayerPriority(existing.SourceLayer))
            {
                bestEntries[key] = entry;
            }
        }

        return bestEntries.Values.ToList();
    }

    private async Task<HashSet<string>> ReadInstalledOllamaModelNamesAsync()
    {
        var models = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var baseUrl = GetConfig("CTI_OLLAMA_BASE_URL", "http://127.0.0.1:11434");
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            using var response = await client.GetAsync($"{baseUrl.TrimEnd('/')}/api/tags");
            if (!response.IsSuccessStatusCode) return models;
            var body = await response.Content.ReadAsStringAsync();
            using var document = JsonDocument.Parse(body);
            foreach (var model in ReadOllamaTagModelNames(document.RootElement))
            {
                models.Add(model);
            }
        }
        catch
        {
            return models;
        }
        return models;
    }

    private static IEnumerable<string> ReadOllamaTagModelNames(JsonElement root)
    {
        if (!root.TryGetProperty("models", out var modelsElement) || modelsElement.ValueKind != JsonValueKind.Array)
        {
            yield break;
        }

        foreach (var model in modelsElement.EnumerateArray())
        {
            var name = ReadJsonString(model, "name");
            if (string.IsNullOrWhiteSpace(name)) name = ReadJsonString(model, "model");
            if (!string.IsNullOrWhiteSpace(name)) yield return name;
        }
    }

    private static string GetOllamaCatalogModel(ExtensionCatalogItem item)
    {
        if (!string.Equals(item.InstallHandler, "ollama.pull", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(item.Artifact?.Kind, "ollama", StringComparison.OrdinalIgnoreCase))
        {
            return "";
        }

        return (item.Artifact?.Model ?? item.Source ?? "").Trim();
    }

    private async Task<List<ExtensionCatalogEntry>> LoadDynamicExtensionCatalogEntriesAsync(bool forceRefresh)
    {
        if (string.Equals(GetConfig("CTI_EXTENSION_CATALOG_DYNAMIC_ENABLED", "true"), "false", StringComparison.OrdinalIgnoreCase))
        {
            return [];
        }

        var topN = int.TryParse(GetConfig("CTI_EXTENSION_CATALOG_DYNAMIC_TOP_N", "5"), out var configuredTopN) && configuredTopN > 0
            ? Math.Min(configuredTopN, 20)
            : 5;
        var refreshHours = int.TryParse(GetConfig("CTI_EXTENSION_CATALOG_DYNAMIC_REFRESH_HOURS", "24"), out var configuredRefreshHours) && configuredRefreshHours > 0
            ? configuredRefreshHours
            : 24;
        var providers = SplitConfigList(GetConfig("CTI_EXTENSION_CATALOG_DYNAMIC_PROVIDERS", "npm,pypi,github,huggingface,ollama,mcp_registry"))
            .Select(item => item.Trim().ToLowerInvariant())
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var cached = ReadDynamicCatalogCache();
        if (!forceRefresh && cached is not null && IsDynamicCatalogCacheFresh(cached, providers, topN, refreshHours))
        {
            return cached.Items.Select(ConvertCachedCatalogEntry).ToList();
        }

        try
        {
            var freshEntries = await RefreshDynamicCatalogEntriesAsync(providers, topN);
            SaveDynamicCatalogCache(providers, topN, freshEntries);
            return freshEntries;
        }
        catch (Exception ex)
        {
            AddWebActivity("warning", "动态目录刷新失败", ex.Message);
            return cached?.Items.Select(ConvertCachedCatalogEntry).ToList() ?? [];
        }
    }

    private async Task<List<ExtensionCatalogEntry>> RefreshDynamicCatalogEntriesAsync(string[] providers, int topN)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("codex-im-suite-control-panel");
        client.DefaultRequestHeaders.Accept.ParseAdd("application/json");

        var entries = new List<ExtensionCatalogEntry>();
        foreach (var provider in providers)
        {
            var fetchedAt = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss");
            switch (provider)
            {
                case "npm":
                    entries.AddRange(BuildDynamicCatalogEntries(
                        ExtensionCatalogDynamicSources.ParseNpmSearchJson(await client.GetStringAsync($"https://registry.npmjs.org/-/v1/search?text={Uri.EscapeDataString("mcp")}&size={topN}"), topN),
                        "npm",
                        "https://registry.npmjs.org/-/v1/search",
                        fetchedAt,
                        "npm search score"));
                    break;
                case "pypi":
                    entries.AddRange(BuildDynamicCatalogEntries(
                        ExtensionCatalogDynamicSources.ParsePyPiRssXml(await client.GetStringAsync("https://pypi.org/rss/updates.xml"), topN),
                        "PyPI",
                        "https://pypi.org/rss/updates.xml",
                        fetchedAt,
                        "PyPI 官方 RSS 最新更新"));
                    break;
                case "github":
                    entries.AddRange(BuildDynamicCatalogEntries(
                        ExtensionCatalogDynamicSources.ParseGitHubRepositoriesJson(await client.GetStringAsync($"https://api.github.com/search/repositories?q={Uri.EscapeDataString("topic:model-context-protocol")}&sort=stars&order=desc&per_page={topN}"), topN),
                        "GitHub",
                        "https://api.github.com/search/repositories",
                        fetchedAt,
                        "GitHub stars"));
                    break;
                case "huggingface":
                    entries.AddRange(BuildDynamicCatalogEntries(
                        ExtensionCatalogDynamicSources.ParseHuggingFaceModelsJson(await client.GetStringAsync($"https://huggingface.co/api/models?search={Uri.EscapeDataString("mcp")}&sort=downloads&direction=-1&limit={topN}"), topN),
                        "Hugging Face",
                        "https://huggingface.co/api/models",
                        fetchedAt,
                        "Hugging Face downloads"));
                    break;
                case "ollama":
                    entries.AddRange(BuildDynamicCatalogEntries(
                        ExtensionCatalogDynamicSources.ParseOllamaLibraryHtml(await client.GetStringAsync("https://ollama.com/library?sort=popular"), topN),
                        "Ollama Library",
                        "https://ollama.com/library?sort=popular",
                        fetchedAt,
                        "Ollama popular pulls"));
                    break;
                case "mcp_registry":
                    entries.AddRange(BuildDynamicCatalogEntries(
                        ExtensionCatalogDynamicSources.ParseMcpRegistryServersJson(await client.GetStringAsync($"https://registry.modelcontextprotocol.io/v0.1/servers?limit={topN}&version=latest"), topN),
                        "Official MCP Registry",
                        "https://registry.modelcontextprotocol.io/v0.1/servers",
                        fetchedAt,
                        "Registry latest version list"));
                    break;
            }
        }

        return entries;
    }

    private List<ExtensionCatalogEntry> BuildDynamicCatalogEntries(
        IReadOnlyList<DynamicCatalogCandidate> candidates,
        string sourceName,
        string sourceUrl,
        string fetchedAt,
        string rankBasis)
    {
        var entries = new List<ExtensionCatalogEntry>(candidates.Count);
        foreach (var candidate in candidates)
        {
            var item = new ExtensionCatalogItem
            {
                Id = NormalizeCatalogId(candidate.Id),
                Type = NormalizeCatalogType(candidate.Type),
                DisplayName = candidate.DisplayName.Trim(),
                Version = string.IsNullOrWhiteSpace(candidate.Version) ? "latest" : candidate.Version.Trim(),
                Category = candidate.Category.Trim(),
                Description = candidate.Description?.Trim() ?? "",
                Source = string.IsNullOrWhiteSpace(candidate.Source) ? null : candidate.Source.Trim(),
                InstallHandler = candidate.InstallHandler.Trim().ToLowerInvariant(),
                Artifact = string.IsNullOrWhiteSpace(candidate.ArtifactKind)
                    && string.IsNullOrWhiteSpace(candidate.ArtifactUrl)
                    && string.IsNullOrWhiteSpace(candidate.ArtifactModel)
                    && string.IsNullOrWhiteSpace(candidate.ArtifactPackageName)
                    && string.IsNullOrWhiteSpace(candidate.ArtifactCommand)
                    ? null
                    : new ExtensionCatalogArtifact
                    {
                        Url = candidate.ArtifactUrl,
                        Kind = candidate.ArtifactKind,
                        Model = candidate.ArtifactModel,
                        PackageName = candidate.ArtifactPackageName,
                        Command = candidate.ArtifactCommand,
                    },
            };
            entries.Add(new ExtensionCatalogEntry(item, sourceUrl, true, "dynamic", sourceName, fetchedAt, $"{rankBasis} · {candidate.RankMetric}", candidate.RankOrder));
        }

        return entries;
    }

    private DynamicCatalogCacheSnapshot? ReadDynamicCatalogCache()
    {
        if (!File.Exists(_extensionCatalogDynamicCachePath))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<DynamicCatalogCacheSnapshot>(File.ReadAllText(_extensionCatalogDynamicCachePath, Encoding.UTF8), JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    private bool IsDynamicCatalogCacheFresh(DynamicCatalogCacheSnapshot cache, string[] providers, int topN, int refreshHours)
    {
        if (!string.Equals(cache.Protocol, "extension-catalog-dynamic-cache/v1", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (cache.TopN != topN)
        {
            return false;
        }

        if (!providers.SequenceEqual(cache.Providers ?? [], StringComparer.OrdinalIgnoreCase))
        {
            return false;
        }

        return DateTimeOffset.TryParse(cache.GeneratedAt, out var generatedAt)
            && DateTimeOffset.Now - generatedAt.ToLocalTime() <= TimeSpan.FromHours(refreshHours);
    }

    private void SaveDynamicCatalogCache(string[] providers, int topN, List<ExtensionCatalogEntry> entries)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_extensionCatalogDynamicCachePath)!);
        var payload = new DynamicCatalogCacheSnapshot(
            "extension-catalog-dynamic-cache/v1",
            DateTimeOffset.Now.ToString("O"),
            topN,
            providers,
            entries.Select(entry => new CachedExtensionCatalogEntry(
                entry.Item,
                entry.CatalogSource,
                entry.Trusted,
                entry.SourceLayer,
                entry.SourceName,
                entry.FetchedAt,
                entry.RankBasis,
                entry.RankOrder)).ToArray());
        WriteUtf8TextAtomic(_extensionCatalogDynamicCachePath, JsonSerializer.Serialize(payload, JsonOptions));
    }

    private static ExtensionCatalogEntry ConvertCachedCatalogEntry(CachedExtensionCatalogEntry cached)
        => new(cached.Item, cached.CatalogSource, cached.Trusted, cached.SourceLayer, cached.SourceName, cached.FetchedAt, cached.RankBasis, cached.RankOrder);

    private List<ExtensionCatalogEntry> ParseExtensionCatalog(string rawJson, string source, bool trusted, string sourceLayer, string sourceName, string fetchedAt, string rankBasis)
    {
        var entries = new List<ExtensionCatalogEntry>();
        using var doc = JsonDocument.Parse(rawJson, new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
        var root = doc.RootElement;
        if (root.ValueKind == JsonValueKind.Object
            && root.TryGetProperty("items", out var items)
            && items.ValueKind == JsonValueKind.Array)
        {
            var rank = 0;
            foreach (var item in items.EnumerateArray())
            {
                rank++;
                entries.Add(new ExtensionCatalogEntry(ParseExtensionCatalogItem(item), source, trusted, sourceLayer, sourceName, fetchedAt, rankBasis, rank));
            }
            return entries;
        }

        if (root.ValueKind == JsonValueKind.Array)
        {
            var rank = 0;
            foreach (var item in root.EnumerateArray())
            {
                rank++;
                entries.Add(new ExtensionCatalogEntry(ParseExtensionCatalogItem(item), source, trusted, sourceLayer, sourceName, fetchedAt, rankBasis, rank));
            }
            return entries;
        }

        entries.Add(new ExtensionCatalogEntry(ParseExtensionCatalogItem(root), source, trusted, sourceLayer, sourceName, fetchedAt, rankBasis, 1));
        return entries;
    }

    private static ExtensionCatalogItem ParseExtensionCatalogItem(JsonElement root)
    {
        var item = JsonSerializer.Deserialize<ExtensionCatalogItem>(root.GetRawText(), WebJsonOptions)
                   ?? throw new InvalidOperationException("扩展目录条目结构无效。");
        item.Id = NormalizeCatalogId(item.Id);
        item.Type = NormalizeCatalogType(item.Type);
        item.InstallHandler = (item.InstallHandler ?? "").Trim().ToLowerInvariant();
        item.DisplayName = string.IsNullOrWhiteSpace(item.DisplayName) ? item.Id : item.DisplayName.Trim();
        item.Version = string.IsNullOrWhiteSpace(item.Version) ? "1.0.0" : item.Version.Trim();
        item.Category = string.IsNullOrWhiteSpace(item.Category) ? $"catalog.{item.Type}" : item.Category.Trim();
        item.Description = item.Description?.Trim() ?? "";
        return item;
    }

    private static int GetCatalogLayerPriority(string sourceLayer)
        => sourceLayer switch
        {
            "custom_url" => 3,
            "seed" => 2,
            "dynamic" => 1,
            _ => 0,
        };

    private static int GetCatalogLayerSortRank(string sourceLayer)
        => sourceLayer switch
        {
            "local" => 0,
            "seed" => 1,
            "dynamic" => 2,
            "custom_url" => 3,
            _ => 9,
        };

    private async Task<WebRemoteExtensionPreview> PreviewRemoteExtensionAsync(string url)
    {
        var item = await LoadRemoteCatalogItemAsync(url);
        var trusted = !string.IsNullOrWhiteSpace(item.Sha256);
        return new WebRemoteExtensionPreview(
            item.Id,
            item.Type,
            item.DisplayName,
            item.Version,
            item.Category,
            item.Description,
            item.InstallHandler,
            item.Artifact?.Url ?? item.Source,
            url,
            trusted,
            trusted ? "声明 sha256，安装时会校验。" : "未声明 sha256，按不可信 URL 处理；安装前需要 Owner 确认。");
    }

    private async Task<ExtensionCatalogItem> LoadRemoteCatalogItemAsync(string url)
    {
        if (!IsHttpsUrl(url))
        {
            throw new InvalidOperationException("URL 安装只允许 HTTPS。");
        }

        var tempPath = Path.Combine(_extensionDownloadsDir, $"preview-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_extensionDownloadsDir);
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        if (url.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            await DownloadFileAsync(client, url, tempPath);
            try
            {
                using var archive = ZipFile.OpenRead(tempPath);
                var entry = archive.GetEntry("extension.json")
                            ?? archive.Entries.FirstOrDefault(item => item.FullName.EndsWith("/extension.json", StringComparison.OrdinalIgnoreCase));
                if (entry is null) throw new InvalidOperationException("zip 中缺少 extension.json。");
                using var stream = entry.Open();
                using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
                var item = ParseExtensionCatalogItem(JsonDocument.Parse(await reader.ReadToEndAsync()).RootElement);
                item.Artifact ??= new ExtensionCatalogArtifact();
                item.Artifact.Url ??= url;
                return item;
            }
            finally
            {
                TryDeleteFile(tempPath);
            }
        }

        var raw = await client.GetStringAsync(url);
        var entries = ParseExtensionCatalog(raw, url, trusted: false, sourceLayer: "custom_url", sourceName: new Uri(url).Host, fetchedAt: DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"), rankBasis: "URL 预览");
        if (entries.Count != 1)
        {
            throw new InvalidOperationException("URL 预览只接受单个 catalog item JSON；目录 URL 请写入 CTI_EXTENSION_CATALOG_URLS。");
        }
        return entries[0].Item;
    }

    private async Task<object> InstallRemoteExtensionAsync(JsonElement payload)
    {
        var id = ReadPayloadString(payload, "id", "");
        var url = ReadPayloadString(payload, "url", "");
        var allowUntrusted = ReadPayloadBool(payload, "allowUntrusted", false);
        ExtensionCatalogEntry entry;
        if (!string.IsNullOrWhiteSpace(url))
        {
            var remoteItem = await LoadRemoteCatalogItemAsync(url);
            entry = new ExtensionCatalogEntry(remoteItem, url, false, "custom_url", new Uri(url).Host, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"), "URL 安装", 1);
        }
        else
        {
            var entries = await LoadExtensionCatalogEntriesAsync(forceRefresh: false);
            entry = entries.FirstOrDefault(candidate => string.Equals(candidate.Item.Id, id, StringComparison.OrdinalIgnoreCase))
                    ?? throw new InvalidOperationException($"未找到扩展目录条目：{id}");
        }

        if (SkillControlCommandPolicy.UsesLifecycleForExtensionType(entry.Item.Type))
        {
            var source = new[] { entry.Item.Source, entry.Item.Artifact?.Url, entry.CatalogSource }
                .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? "";
            if (string.IsNullOrWhiteSpace(source))
            {
                throw new InvalidOperationException("Skill 目录条目缺少可校验来源，不能进入 lifecycle。");
            }
            var lifecyclePayload = JsonSerializer.SerializeToElement(new
            {
                id = entry.Item.Id,
                sourceClass = "unknown",
                source,
                risk = entry.Trusted || !string.IsNullOrWhiteSpace(entry.Item.Sha256) ? "low" : "medium",
                changeKind = "install",
            });
            var lifecycleResult = await RunSkillLifecycleCommandAsync("prepare-install", lifecyclePayload, includePanelActor: true);
            AddWebActivity("info", "Skill 已转交 lifecycle", $"{entry.Item.DisplayName}：未使用通用扩展安装器。");
            return lifecycleResult;
        }

        var result = await InstallCatalogEntryAsync(entry, allowUntrusted);
        LoadManifests();
        await UpdateMcpManifestStatesAsync();
        AddWebActivity("info", "扩展已安装", $"{entry.Item.DisplayName} -> {result.InstallPath}");
        return result;
    }

    private object RemoveRemoteExtension(JsonElement payload)
    {
        var id = ReadPayloadString(payload, "id", "");
        var type = ReadPayloadString(payload, "type", "");
        if (string.IsNullOrWhiteSpace(id)) throw new InvalidOperationException("缺少扩展 ID。");
        var lockFile = ReadExtensionInstallLock();
        var record = lockFile.Entries.FirstOrDefault(item =>
            string.Equals(item.Id, id, StringComparison.OrdinalIgnoreCase)
            && (string.IsNullOrWhiteSpace(type) || string.Equals(item.Type, type, StringComparison.OrdinalIgnoreCase)));
        if (record is null)
        {
            var manifest = ReadCatalogInstalledManifests().Values.FirstOrDefault(item =>
                string.Equals(item.Id, NormalizeCatalogId(id), StringComparison.OrdinalIgnoreCase)
                && (string.IsNullOrWhiteSpace(type) || string.Equals(item.Type, NormalizeCatalogType(type), StringComparison.OrdinalIgnoreCase)));
            if (manifest is null || !IsUserExtensionPath(manifest.ManifestPath))
            {
                throw new InvalidOperationException($"未找到可移除的用户安装记录：{id}");
            }
            DeleteInstalledPath(manifest.ManifestPath, fileOnly: true);
            LoadManifests();
            AddWebActivity("info", "扩展记录已移除", $"{manifest.DisplayName}：仅移除 suite 用户覆盖层记录。");
            return new { removed = manifest.Id, manifest.Type };
        }

        DeleteInstalledPath(record.ManifestPath, fileOnly: true);
        DeleteInstalledPath(record.LauncherPath, fileOnly: true);
        DeleteInstalledPath(record.PackagePath, fileOnly: false);
        lockFile.Entries.Remove(record);
        SaveExtensionInstallLock(lockFile);
        LoadManifests();
        AddWebActivity("info", "扩展安装记录已移除", record.Type == "model" ? $"{record.DisplayName}：Ollama 模型本体保留在本机。" : record.DisplayName);
        return new { removed = record.Id, record.Type };
    }

    private object GetExtensionInstallJobs()
    {
        lock (_extensionInstallJobLock)
        {
            return _extensionInstallJobs.Values
                .OrderByDescending(job => job.UpdatedAt)
                .Select(ToWebInstallJob)
                .ToArray();
        }
    }

    private async Task<object> StartModelInstallJobAsync(JsonElement payload)
    {
        var id = ReadPayloadString(payload, "id", "");
        var url = ReadPayloadString(payload, "url", "");
        var allowUntrusted = ReadPayloadBool(payload, "allowUntrusted", false);
        var installPath = ReadPayloadString(payload, "installPath", "").Trim();
        var useAfterInstall = ReadPayloadBool(payload, "useAfterInstall", true);
        ExtensionCatalogEntry entry;
        if (!string.IsNullOrWhiteSpace(url))
        {
            var remoteItem = await LoadRemoteCatalogItemAsync(url);
            entry = new ExtensionCatalogEntry(remoteItem, url, false, "custom_url", new Uri(url).Host, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"), "URL 安装", 1);
        }
        else
        {
            var entries = await LoadExtensionCatalogEntriesAsync(forceRefresh: false);
            entry = entries.FirstOrDefault(candidate => string.Equals(candidate.Item.Id, id, StringComparison.OrdinalIgnoreCase))
                    ?? throw new InvalidOperationException($"未找到模型目录条目：{id}");
        }

        var item = entry.Item;
        if (!string.Equals(item.Type, "model", StringComparison.OrdinalIgnoreCase)
            || !string.Equals(item.InstallHandler, "ollama.pull", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("当前异步安装只支持 Ollama model 条目。");
        }

        var trusted = entry.Trusted || !string.IsNullOrWhiteSpace(item.Sha256);
        if (!trusted && !allowUntrusted)
        {
            throw new InvalidOperationException("该模型条目未声明 sha256，必须确认 allowUntrusted 后才能安装。");
        }

        var model = GetOllamaCatalogModel(item);
        if (string.IsNullOrWhiteSpace(model)) throw new InvalidOperationException("Ollama 条目缺少 artifact.model。");
        var normalizedInstallPath = NormalizeOllamaModelsPath(installPath);
        if (!string.IsNullOrWhiteSpace(normalizedInstallPath))
        {
            Directory.CreateDirectory(normalizedInstallPath);
            SaveOllamaModelsPath(normalizedInstallPath);
        }

        var job = new ExtensionInstallJobState
        {
            JobId = Guid.NewGuid().ToString("N"),
            ItemId = item.Id,
            Type = item.Type,
            DisplayName = item.DisplayName,
            Model = model,
            InstallPath = normalizedInstallPath,
            Status = "running",
            Stage = "pull",
            Message = "准备拉取 Ollama 模型。",
            Percent = 0,
            StartedAt = DateTimeOffset.Now,
            UpdatedAt = DateTimeOffset.Now,
            CanCancel = true,
            UseAfterInstall = useAfterInstall,
            SourceUrl = item.Artifact?.Url ?? item.Source ?? entry.CatalogSource,
            Version = item.Version,
            InstallHandler = item.InstallHandler,
        };
        lock (_extensionInstallJobLock)
        {
            _extensionInstallJobs[job.JobId] = job;
        }

        _ = Task.Run(() => RunOllamaInstallJobAsync(job, item));
        AddWebActivity("info", "模型安装已开始", $"{item.DisplayName} · {model}");
        return ToWebInstallJob(job);
    }

    private object CancelModelInstallJob(JsonElement payload)
    {
        var jobId = ReadPayloadString(payload, "jobId", "");
        if (string.IsNullOrWhiteSpace(jobId)) throw new InvalidOperationException("缺少安装任务 ID。");
        ExtensionInstallJobState? job;
        lock (_extensionInstallJobLock)
        {
            _extensionInstallJobs.TryGetValue(jobId, out job);
        }
        if (job is null) throw new InvalidOperationException($"未找到安装任务：{jobId}");
        if (!job.CanCancel || job.Status is "succeeded" or "failed" or "cancelled")
        {
            return ToWebInstallJob(job);
        }
        job.Cancellation.Cancel();
        try { job.Process?.Kill(entireProcessTree: true); } catch { }
        UpdateInstallJob(job, "cancelled", "paused", "已暂停安装；再次安装同一模型会复用 Ollama 已下载的层。", job.Percent, canCancel: false);
        AddWebActivity("warning", "模型安装已暂停", $"{job.DisplayName} · {job.Model}");
        return ToWebInstallJob(job);
    }

    private async Task<object> RemoveModelAsync(JsonElement payload)
    {
        var model = ReadPayloadString(payload, "model", "").Trim();
        var id = ReadPayloadString(payload, "id", "").Trim();
        if (string.IsNullOrWhiteSpace(model) && !string.IsNullOrWhiteSpace(id))
        {
            var entries = await LoadExtensionCatalogEntriesAsync(forceRefresh: false);
            var entry = entries.FirstOrDefault(candidate => string.Equals(candidate.Item.Id, id, StringComparison.OrdinalIgnoreCase));
            if (entry is not null) model = GetOllamaCatalogModel(entry.Item);
        }
        if (string.IsNullOrWhiteSpace(model)) throw new InvalidOperationException("缺少 Ollama 模型名。");

        var environment = BuildOllamaEnvironment(GetConfiguredOllamaModelsPath());
        var ollamaExe = ResolveOllamaExecutablePath();
        var result = await RunProcessAsync(ollamaExe, $"rm {model}", _ctiHome, environment, timeoutMs: 300000);
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(result.Stderr) ? result.Stdout : result.Stderr);
        }

        RemoveModelInstallLock(model, id);
        AddWebActivity("info", "Ollama 模型已卸载", model);
        await RestartBridgeAfterModelChangeAsync($"卸载模型 {model}");
        return new { removed = model };
    }

    private async Task<object> UseLocalModelAsync(JsonElement payload)
    {
        var model = ReadPayloadString(payload, "model", "").Trim();
        if (string.IsNullOrWhiteSpace(model)) throw new InvalidOperationException("缺少模型名。");
        SaveLocalModelSelection(model);
        AddWebActivity("info", "本地 API 模型已切换", model);
        await RestartBridgeAfterModelChangeAsync($"切换模型 {model}");
        return GetSettingsSnapshot();
    }

    private async Task RunOllamaInstallJobAsync(ExtensionInstallJobState job, ExtensionCatalogItem item)
    {
        try
        {
            if (!string.IsNullOrWhiteSpace(job.InstallPath))
            {
                UpdateInstallJob(job, "running", "prepare", "正在按配置重启本机 Ollama，让模型目录生效。", job.Percent);
                await RestartManagedOllamaAsync(job.InstallPath);
            }

            var environment = BuildOllamaEnvironment(job.InstallPath);
            using var process = new Process();
            job.Process = process;
            process.StartInfo = new ProcessStartInfo
            {
                FileName = ResolveOllamaExecutablePath(),
                WorkingDirectory = Directory.Exists(_ctiHome) ? _ctiHome : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                CreateNoWindow = true,
            };
            process.StartInfo.ArgumentList.Add("pull");
            process.StartInfo.ArgumentList.Add(job.Model);
            foreach (var pair in environment) process.StartInfo.Environment[pair.Key] = pair.Value ?? "";
            process.OutputDataReceived += (_, e) => { if (e.Data is not null) UpdateInstallJobFromOutput(job, e.Data); };
            process.ErrorDataReceived += (_, e) => { if (e.Data is not null) UpdateInstallJobFromOutput(job, e.Data); };
            UpdateInstallJob(job, "running", "pull", $"正在拉取 {job.Model}", job.Percent);
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            await process.WaitForExitAsync(job.Cancellation.Token);
            if (job.Cancellation.IsCancellationRequested) return;
            if (process.ExitCode != 0)
            {
                UpdateInstallJob(job, "failed", "failed", $"ollama pull 失败，exitCode={process.ExitCode}", job.Percent, canCancel: false, exitCode: process.ExitCode);
                AddWebActivity("error", "模型安装失败", $"{job.DisplayName} · exitCode={process.ExitCode}");
                return;
            }

            WriteModelInstallLock(job, item);
            UpdateInstallJob(job, "succeeded", "completed", "模型安装完成。", 100, canCancel: false, exitCode: 0);
            AddWebActivity("info", "模型安装完成", $"{job.DisplayName} · {job.Model}");
            if (job.UseAfterInstall)
            {
                SaveLocalModelSelection(job.Model);
                await RestartBridgeAfterModelChangeAsync($"安装模型 {job.Model}");
            }
            else
            {
                await PushWebStateFromAnyThreadAsync();
            }
        }
        catch (OperationCanceledException)
        {
            UpdateInstallJob(job, "cancelled", "paused", "已暂停安装；再次安装会继续复用 Ollama 缓存。", job.Percent, canCancel: false);
        }
        catch (Exception ex)
        {
            UpdateInstallJob(job, "failed", "failed", ex.Message, job.Percent, canCancel: false);
            AddWebActivity("error", "模型安装失败", $"{job.DisplayName} · {ex.Message}");
        }
        finally
        {
            job.Process = null;
            job.Cancellation.Dispose();
        }
    }

    private async Task RestartManagedOllamaAsync(string ollamaModelsPath)
    {
        var environment = BuildOllamaEnvironment(ollamaModelsPath);
        if (File.Exists(_localLlmStopScript))
        {
            await RunPowerShellFileAsync(_localLlmStopScript, "", _suiteRoot, 120000, environment);
        }
        if (File.Exists(_localLlmStartScript))
        {
            await RunPowerShellFileAsync(_localLlmStartScript, "", _suiteRoot, 120000, environment);
        }
    }

    private async Task RestartBridgeAfterModelChangeAsync(string reason)
    {
        UpdateInstallJobsMessage($"正在重启 Bridge：{reason}");
        var result = await RunPowerShellFileAsync(_daemonScript, "restart", _skillDir, 120000);
        AppendCommand("daemon restart", result);
        await PushWebStateFromAnyThreadAsync();
    }

    private Task PushWebStateFromAnyThreadAsync()
    {
        if (!InvokeRequired) return PushWebStateAsync();
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        BeginInvoke(async () =>
        {
            try
            {
                await RefreshAllAsync();
                await PushWebStateAsync();
                completion.SetResult();
            }
            catch (Exception ex)
            {
                completion.SetException(ex);
            }
        });
        return completion.Task;
    }

    private Dictionary<string, string?> BuildOllamaEnvironment(string? ollamaModelsPath)
    {
        var env = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        var path = NormalizeOllamaModelsPath(ollamaModelsPath);
        if (!string.IsNullOrWhiteSpace(path))
        {
            env["OLLAMA_MODELS"] = path;
        }
        return env;
    }

    private string ResolveOllamaExecutablePath()
    {
        var configured = GetConfig("CTI_OLLAMA_EXE", GetConfig("OLLAMA_EXE", "")).Trim().Trim('"');
        if (!string.IsNullOrWhiteSpace(configured))
        {
            var expanded = Environment.ExpandEnvironmentVariables(configured);
            if (File.Exists(expanded)) return Path.GetFullPath(expanded);
            throw new InvalidOperationException($"Ollama CLI 路径无效：{expanded}。请修正 CTI_OLLAMA_EXE，或安装 Ollama 后重启控制面板。");
        }

        var pathResult = ResolveExecutableFromPath("ollama.exe");
        if (!string.IsNullOrWhiteSpace(pathResult)) return pathResult;

        var roots = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
        }.Where(root => !string.IsNullOrWhiteSpace(root));
        foreach (var root in roots)
        {
            foreach (var relative in OllamaRelativeExecutableCandidates)
            {
                var candidate = Path.Combine(root, relative);
                if (File.Exists(candidate)) return Path.GetFullPath(candidate);
            }
        }

        throw new InvalidOperationException("未找到 Ollama CLI。请安装 Ollama，或在 config.env 中设置 CTI_OLLAMA_EXE=C:\\路径\\ollama.exe，然后重启控制面板。");
    }

    private static string ResolveExecutableFromPath(string fileName)
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var candidate = Path.Combine(dir.Trim().Trim('"'), fileName);
                if (File.Exists(candidate)) return Path.GetFullPath(candidate);
            }
            catch
            {
                // Ignore malformed PATH entries.
            }
        }
        return "";
    }

    private string GetConfiguredOllamaModelsPath()
        => NormalizeOllamaModelsPath(GetConfig("CTI_OLLAMA_MODELS_DIR", GetConfig("OLLAMA_MODELS", "")));

    private static string NormalizeOllamaModelsPath(string? value)
    {
        var trimmed = (value ?? "").Trim().Trim('"');
        if (string.IsNullOrWhiteSpace(trimmed)) return "";
        var expanded = Environment.ExpandEnvironmentVariables(trimmed);
        return Path.GetFullPath(expanded);
    }

    private void SaveOllamaModelsPath(string ollamaModelsPath)
    {
        var normalized = NormalizeOllamaModelsPath(ollamaModelsPath);
        if (string.IsNullOrWhiteSpace(normalized)) return;
        Directory.CreateDirectory(Path.GetDirectoryName(_configPath)!);
        var lines = ReadEnvFileLines(_configPath);
        SetOrAppendEnv(lines, "CTI_OLLAMA_MODELS_DIR", normalized);
        SetOrAppendEnv(lines, "OLLAMA_MODELS", normalized);
        File.WriteAllLines(_configPath, lines, new UTF8Encoding(false));
        LoadConfig();
    }

    private void SaveLocalModelSelection(string model)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_configPath)!);
        var lines = ReadEnvFileLines(_configPath);
        SetOrAppendEnv(lines, "CTI_LOCAL_AI_KIND", "ollama");
        SetOrAppendEnv(lines, "CTI_LOCAL_AI_MODEL", model);
        SetOrAppendEnv(lines, "CTI_OLLAMA_MODEL", model);
        SetOrAppendEnv(lines, "CTI_CODEX_PASS_MODEL", "true");
        File.WriteAllLines(_configPath, lines, new UTF8Encoding(false));
        LoadConfig();
    }

    private void WriteModelInstallLock(ExtensionInstallJobState job, ExtensionCatalogItem item)
    {
        var lockFile = ReadExtensionInstallLock();
        lockFile.Entries.RemoveAll(record =>
            string.Equals(record.Id, item.Id, StringComparison.OrdinalIgnoreCase)
            && string.Equals(record.Type, item.Type, StringComparison.OrdinalIgnoreCase));
        lockFile.Entries.Add(new InstalledExtensionRecord
        {
            Id = item.Id,
            Type = item.Type,
            DisplayName = item.DisplayName,
            Version = item.Version,
            InstallHandler = item.InstallHandler,
            InstalledAt = DateTimeOffset.Now.ToString("O"),
            SourceUrl = job.SourceUrl,
            Sha256 = item.Sha256 ?? "",
            PackagePath = "",
            ManifestPath = "",
            LauncherPath = "",
            Status = "installed",
        });
        SaveExtensionInstallLock(lockFile);
    }

    private void RemoveModelInstallLock(string model, string id)
    {
        var lockFile = ReadExtensionInstallLock();
        lockFile.Entries.RemoveAll(record =>
            string.Equals(record.Type, "model", StringComparison.OrdinalIgnoreCase)
            && (string.Equals(record.Id, id, StringComparison.OrdinalIgnoreCase)
                || string.Equals(record.SourceUrl, model, StringComparison.OrdinalIgnoreCase)
                || string.Equals(record.DisplayName, model, StringComparison.OrdinalIgnoreCase)));
        SaveExtensionInstallLock(lockFile);
    }

    private void UpdateInstallJobFromOutput(ExtensionInstallJobState job, string line)
    {
        var normalized = line.Replace('\r', ' ').Trim();
        if (string.IsNullOrWhiteSpace(normalized)) return;
        var percent = ParsePercent(normalized);
        var message = TrimForStatus(normalized, 160);
        var nextPercent = percent.HasValue ? Math.Max(job.Percent, percent.Value) : job.Percent;
        UpdateInstallJob(job, "running", "pull", message, nextPercent);
    }

    private static int? ParsePercent(string text)
    {
        var match = Regex.Match(text, @"(?<percent>\d{1,3})(?:\.\d+)?\s*%");
        if (!match.Success || !int.TryParse(match.Groups["percent"].Value, out var percent)) return null;
        return Math.Max(0, Math.Min(100, percent));
    }

    private void UpdateInstallJobsMessage(string message)
    {
        lock (_extensionInstallJobLock)
        {
            foreach (var job in _extensionInstallJobs.Values.Where(job => job.Status == "succeeded" && job.UseAfterInstall))
            {
                job.Message = message;
                job.Stage = "restart";
                job.UpdatedAt = DateTimeOffset.Now;
            }
        }
    }

    private void UpdateInstallJob(ExtensionInstallJobState job, string status, string stage, string message, int percent, bool canCancel = true, int? exitCode = null)
    {
        lock (_extensionInstallJobLock)
        {
            job.Status = status;
            job.Stage = stage;
            job.Message = message;
            job.Percent = Math.Max(0, Math.Min(100, percent));
            job.CanCancel = canCancel && status == "running";
            job.ExitCode = exitCode;
            job.UpdatedAt = DateTimeOffset.Now;
            if (status is "succeeded" or "failed" or "cancelled") job.CompletedAt = DateTimeOffset.Now;
            job.RecentLines.Add(message);
            if (job.RecentLines.Count > 8) job.RecentLines.RemoveRange(0, job.RecentLines.Count - 8);
        }
    }

    private static WebExtensionInstallJob ToWebInstallJob(ExtensionInstallJobState job)
        => new(
            job.JobId,
            job.ItemId,
            job.Type,
            job.DisplayName,
            job.Model,
            job.InstallPath,
            job.Status,
            job.Stage,
            job.Message,
            job.Percent,
            job.CanCancel,
            job.UseAfterInstall,
            job.ExitCode,
            job.StartedAt.ToString("O"),
            job.UpdatedAt.ToString("O"),
            job.CompletedAt?.ToString("O") ?? "",
            job.RecentLines.ToArray());


    private async Task<WebRemoteInstallResult> InstallCatalogEntryAsync(ExtensionCatalogEntry entry, bool allowUntrusted)
    {
        var item = entry.Item;
        EnsureSupportedInstallHandler(item.InstallHandler);
        var trusted = entry.Trusted || !string.IsNullOrWhiteSpace(item.Sha256);
        if (!trusted && !allowUntrusted)
        {
            throw new InvalidOperationException("该 URL 未声明 sha256，必须确认 allowUntrusted 后才能安装。");
        }

        var packageDir = Path.Combine(_extensionPackagesDir, item.Type, item.Id, item.Version);
        EnsurePathWithin(_extensionPackagesDir, packageDir);
        Directory.CreateDirectory(_extensionPackagesDir);
        Directory.CreateDirectory(_extensionLaunchersDir);
        Directory.CreateDirectory(_userMcpManifestDir);
        Directory.CreateDirectory(_userSkillsManifestDir);
        Directory.CreateDirectory(_userPluginsManifestDir);

        var manifestPath = "";
        var launcherPath = "";
        var installPath = packageDir;
        switch (item.InstallHandler)
        {
            case "ollama.pull":
                var model = item.Artifact?.Model ?? item.Source;
                if (string.IsNullOrWhiteSpace(model)) throw new InvalidOperationException("Ollama 条目缺少 artifact.model。");
                var ollama = await RunProcessAsync(ResolveOllamaExecutablePath(), $"pull {model}", _ctiHome, BuildOllamaEnvironment(GetConfiguredOllamaModelsPath()), timeoutMs: 900000);
                if (ollama.ExitCode != 0)
                {
                    throw new InvalidOperationException(string.IsNullOrWhiteSpace(ollama.Stderr) ? ollama.Stdout : ollama.Stderr);
                }
                installPath = model;
                break;
            case "mcp.uvx":
                launcherPath = Path.Combine(_extensionLaunchersDir, $"{item.Id}.ps1");
                WriteUvxLauncher(launcherPath, item.Artifact?.PackageName ?? item.Source);
                manifestPath = WriteInstalledManifest(item, packageDir, launcherPath);
                break;
            case "mcp.npm":
                launcherPath = Path.Combine(_extensionLaunchersDir, $"{item.Id}.ps1");
                WriteNpxLauncher(launcherPath, item.Artifact?.PackageName ?? item.Source);
                manifestPath = WriteInstalledManifest(item, packageDir, launcherPath);
                break;
            case "manifest.record":
            case "codex-plugin.record":
                manifestPath = WriteInstalledManifest(item, packageDir, launcherPath);
                installPath = "";
                break;
            case "skill.copy":
            case "mcp.zip":
                var artifactPath = await DownloadAndVerifyArtifactAsync(item, trusted, allowUntrusted);
                try
                {
                    if (Directory.Exists(packageDir)) Directory.Delete(packageDir, recursive: true);
                    ZipFile.ExtractToDirectory(artifactPath, packageDir);
                }
                finally
                {
                    TryDeleteFile(artifactPath);
                }
                var sourceDir = item.Type == "skill" ? ResolveSkillPackageSource(packageDir) : packageDir;
                if (item.InstallHandler == "mcp.zip" && !string.IsNullOrWhiteSpace(item.Artifact?.Command))
                {
                    launcherPath = Path.Combine(_extensionLaunchersDir, $"{item.Id}.ps1");
                    WriteCommandLauncher(launcherPath, item.Artifact.Command, sourceDir);
                }
                manifestPath = WriteInstalledManifest(item, sourceDir, launcherPath);
                installPath = sourceDir;
                break;
        }

        var lockFile = ReadExtensionInstallLock();
        lockFile.Entries.RemoveAll(record =>
            string.Equals(record.Id, item.Id, StringComparison.OrdinalIgnoreCase)
            && string.Equals(record.Type, item.Type, StringComparison.OrdinalIgnoreCase));
        lockFile.Entries.Add(new InstalledExtensionRecord
        {
            Id = item.Id,
            Type = item.Type,
            DisplayName = item.DisplayName,
            Version = item.Version,
            InstallHandler = item.InstallHandler,
            InstalledAt = DateTimeOffset.Now.ToString("O"),
            SourceUrl = item.Artifact?.Url ?? item.Source ?? entry.CatalogSource,
            Sha256 = item.Sha256 ?? "",
            PackagePath = item.Type == "model" || item.InstallHandler is "manifest.record" or "codex-plugin.record" ? "" : installPath,
            ManifestPath = manifestPath,
            LauncherPath = launcherPath,
            Status = "installed",
        });
        SaveExtensionInstallLock(lockFile);
        return new WebRemoteInstallResult(item.Id, item.Type, item.DisplayName, item.Version, installPath, manifestPath, launcherPath);
    }

    private async Task<string> DownloadAndVerifyArtifactAsync(ExtensionCatalogItem item, bool trusted, bool allowUntrusted)
    {
        var url = item.Artifact?.Url ?? item.Source;
        if (!IsHttpsUrl(url)) throw new InvalidOperationException("下载 artifact 只允许 HTTPS URL。");
        if (!trusted && !allowUntrusted) throw new InvalidOperationException("未受信任 artifact 不能下载。");

        Directory.CreateDirectory(_extensionDownloadsDir);
        var downloadPath = Path.Combine(_extensionDownloadsDir, $"{item.Id}-{item.Version}-{Guid.NewGuid():N}.zip");
        using var client = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
        await DownloadFileAsync(client, url!, downloadPath);
        if (!string.IsNullOrWhiteSpace(item.Sha256))
        {
            var actual = ComputeSha256(downloadPath);
            var expected = NormalizeSha256(item.Sha256);
            if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
            {
                TryDeleteFile(downloadPath);
                throw new InvalidOperationException($"artifact sha256 不匹配：expected={expected} actual={actual}");
            }
        }
        return downloadPath;
    }

    private string WriteInstalledManifest(ExtensionCatalogItem item, string packageDir, string launcherPath)
    {
        var manifest = item.ManifestTemplate?.DeepClone() as JsonObject ?? BuildDefaultManifest(item, packageDir, launcherPath);
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["ID"] = item.Id,
            ["VERSION"] = item.Version,
            ["PACKAGE_DIR"] = ToCtiManifestPath(packageDir),
            ["LAUNCHER_PATH"] = ToCtiManifestPath(launcherPath),
            ["CTI_HOME"] = "${CTI_HOME}",
            ["SUITE_ROOT"] = "${SUITE_ROOT}",
        };
        SubstituteManifestStrings(manifest, values);
        var manifestPath = item.Type switch
        {
            "skill" => Path.Combine(_userSkillsManifestDir, $"{item.Id}.json"),
            "plugin" => Path.Combine(_userPluginsManifestDir, $"{item.Id}.json"),
            _ => Path.Combine(_userMcpManifestDir, $"{item.Id}.json"),
        };
        SaveManifestNode(manifestPath, manifest);
        return manifestPath;
    }

    private JsonObject BuildDefaultManifest(ExtensionCatalogItem item, string packageDir, string launcherPath)
    {
        var root = new JsonObject
        {
            ["id"] = item.Id,
            ["displayName"] = item.DisplayName,
            ["type"] = item.Type switch
            {
                "skill" => "skill",
                "plugin" => "plugin",
                "mcp" => "stdio",
                _ => item.Type,
            },
            ["version"] = item.Version,
            ["compatibility"] = new JsonObject
            {
                ["protocol"] = "extension-manifest/v1",
                ["suite"] = ">=0.2.0 <1.0.0",
            },
            ["category"] = item.Category,
            ["optional"] = true,
            ["installState"] = "external",
            ["source"] = item.InstallHandler switch
            {
                "mcp.uvx" => $"uvx:{NormalizePackageName(item.Artifact?.PackageName ?? item.Source, "uvx:")}",
                "mcp.npm" => $"npm:{NormalizePackageName(item.Artifact?.PackageName ?? item.Source, "npm:")}",
                "codex-plugin.record" => item.Source ?? $"codex-plugin:{item.Id}",
                _ => ToCtiManifestPath(packageDir),
            },
            ["enabled"] = true,
            ["description"] = item.Description,
        };
        if (item.Type == "mcp")
        {
            root["aliases"] = new JsonArray(item.Id, item.DisplayName.ToLowerInvariant());
            root["launcher"] = ToCtiManifestPath(launcherPath);
            root["registerName"] = item.Id;
            root["cwd"] = ToCtiManifestPath(packageDir);
            root["healthCheck"] = new JsonObject { ["kind"] = "codex-mcp-list" };
        }
        return root;
    }

    private string ResolveSkillPackageSource(string packageDir)
    {
        if (File.Exists(Path.Combine(packageDir, "SKILL.md"))) return packageDir;
        var candidate = Directory.GetDirectories(packageDir)
            .FirstOrDefault(dir => File.Exists(Path.Combine(dir, "SKILL.md")));
        if (candidate is null) throw new InvalidOperationException("Skill artifact 解压后缺少 SKILL.md。");
        return candidate;
    }

    private string ToCtiManifestPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return "";
        var fullPath = Path.GetFullPath(path);
        var ctiHome = Path.GetFullPath(_ctiHome).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (fullPath.StartsWith(ctiHome, StringComparison.OrdinalIgnoreCase))
        {
            return "${CTI_HOME}\\" + Path.GetRelativePath(ctiHome, fullPath).Replace('/', '\\');
        }
        return ToManifestSourcePath(fullPath);
    }

    private static void SubstituteManifestStrings(JsonNode? node, Dictionary<string, string> values)
    {
        if (node is JsonObject obj)
        {
            foreach (var key in obj.Select(pair => pair.Key).ToArray())
            {
                var child = obj[key];
                if (child is JsonValue value && value.TryGetValue<string>(out var text))
                {
                    obj[key] = ReplaceTemplateValues(text, values);
                }
                else
                {
                    SubstituteManifestStrings(child, values);
                }
            }
            return;
        }
        if (node is JsonArray array)
        {
            for (var i = 0; i < array.Count; i++)
            {
                if (array[i] is JsonValue value && value.TryGetValue<string>(out var text))
                {
                    array[i] = ReplaceTemplateValues(text, values);
                }
                else
                {
                    SubstituteManifestStrings(array[i], values);
                }
            }
        }
    }

    private static string ReplaceTemplateValues(string text, Dictionary<string, string> values)
    {
        var result = text;
        foreach (var pair in values)
        {
            result = result.Replace("${" + pair.Key + "}", pair.Value, StringComparison.OrdinalIgnoreCase);
        }
        return result;
    }

    private static string NormalizePackageName(string? value, string prefix)
    {
        var result = (value ?? "").Trim();
        if (result.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) result = result[prefix.Length..].Trim();
        if (string.IsNullOrWhiteSpace(result)) throw new InvalidOperationException("扩展目录条目缺少 packageName/source。");
        return result;
    }

    private void WriteUvxLauncher(string path, string? packageName)
    {
        if (string.IsNullOrWhiteSpace(packageName)) throw new InvalidOperationException("mcp.uvx 条目缺少 packageName/source。");
        packageName = NormalizePackageName(packageName, "uvx:");
        var content = $@"$ErrorActionPreference = 'Stop'
$packageName = '{EscapePowerShellSingleQuoted(packageName)}'
$uvx = Get-Command uvx -ErrorAction SilentlyContinue
if (-not $uvx) {{
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $uv) {{ throw 'uvx / uv not found. Install uv first.' }}
    & $uv.Source tool run $packageName @args
    exit $LASTEXITCODE
}}
& $uvx.Source $packageName @args
exit $LASTEXITCODE
";
        WriteUtf8TextAtomic(path, content);
    }

    private void WriteNpxLauncher(string path, string? packageName)
    {
        if (string.IsNullOrWhiteSpace(packageName)) throw new InvalidOperationException("mcp.npm 条目缺少 packageName/source。");
        packageName = NormalizePackageName(packageName, "npm:");
        var content = $@"$ErrorActionPreference = 'Stop'
$packageName = '{EscapePowerShellSingleQuoted(packageName)}'
$npx = Get-Command npx -ErrorAction SilentlyContinue
if (-not $npx) {{ throw 'npx not found. Install Node.js/npm first.' }}
& $npx.Source --yes $packageName @args
exit $LASTEXITCODE
";
        WriteUtf8TextAtomic(path, content);
    }

    private void WriteCommandLauncher(string path, string command, string workingDirectory)
    {
        var content = $@"$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath '{EscapePowerShellSingleQuoted(workingDirectory)}'
{command} @args
exit $LASTEXITCODE
";
        WriteUtf8TextAtomic(path, content);
    }

    private ExtensionInstallLock ReadExtensionInstallLock()
    {
        try
        {
            if (!File.Exists(_extensionLockPath)) return new ExtensionInstallLock();
            return JsonSerializer.Deserialize<ExtensionInstallLock>(File.ReadAllText(_extensionLockPath, Encoding.UTF8), WebJsonOptions) ?? new ExtensionInstallLock();
        }
        catch
        {
            return new ExtensionInstallLock();
        }
    }

    private void SaveExtensionInstallLock(ExtensionInstallLock lockFile)
    {
        lockFile.UpdatedAt = DateTimeOffset.Now.ToString("O");
        Directory.CreateDirectory(Path.GetDirectoryName(_extensionLockPath)!);
        File.WriteAllText(_extensionLockPath, JsonSerializer.Serialize(lockFile, new JsonSerializerOptions(WebJsonOptions) { WriteIndented = true }), new UTF8Encoding(false));
    }

    private void DeleteInstalledPath(string? targetPath, bool fileOnly)
    {
        if (string.IsNullOrWhiteSpace(targetPath)) return;
        var expanded = ExpandManifestValue(targetPath);
        if (!Path.IsPathRooted(expanded)) return;
        EnsurePathWithin(_userExtensionRoot, expanded);
        if (fileOnly)
        {
            TryDeleteFile(expanded);
            return;
        }
        if (Directory.Exists(expanded)) Directory.Delete(expanded, recursive: true);
        else TryDeleteFile(expanded);
    }

    private bool IsUserExtensionPath(string? targetPath)
    {
        if (string.IsNullOrWhiteSpace(targetPath)) return false;
        var expanded = ExpandManifestValue(targetPath);
        if (!Path.IsPathRooted(expanded)) return false;
        var baseFull = Path.GetFullPath(_userExtensionRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var targetFull = Path.GetFullPath(expanded);
        var relative = Path.GetRelativePath(baseFull, targetFull);
        return !relative.StartsWith("..", StringComparison.Ordinal) && !Path.IsPathRooted(relative);
    }

    private static void EnsureSupportedInstallHandler(string handler)
    {
        if (!IsSupportedInstallHandler(handler))
        {
            throw new InvalidOperationException($"不支持的安装 handler：{handler}");
        }
    }

    private static bool IsSupportedInstallHandler(string handler)
        => handler is "skill.copy" or "mcp.npm" or "mcp.uvx" or "mcp.zip" or "ollama.pull" or "manifest.record" or "codex-plugin.record";

    private static string NormalizeCatalogId(string value)
    {
        var normalized = Regex.Replace((value ?? "").Trim().ToLowerInvariant(), @"[^a-z0-9._-]+", "-").Trim('-');
        if (string.IsNullOrWhiteSpace(normalized)) throw new InvalidOperationException("扩展目录条目 id 不能为空。");
        return normalized;
    }

    private static string NormalizeCatalogType(string value)
    {
        var normalized = (value ?? "").Trim().ToLowerInvariant();
        if (normalized is "mcp" or "skill" or "plugin" or "model") return normalized;
        throw new InvalidOperationException($"不支持的扩展类型：{value}");
    }

    private static bool IsHttpsUrl(string? value)
        => !string.IsNullOrWhiteSpace(value)
           && Uri.TryCreate(value, UriKind.Absolute, out var uri)
           && uri.Scheme == Uri.UriSchemeHttps;

    private static async Task DownloadFileAsync(HttpClient client, string url, string path)
    {
        await using var stream = await client.GetStreamAsync(url);
        await using var output = File.Create(path);
        await stream.CopyToAsync(output);
    }

    private static string ComputeSha256(string path)
    {
        using var stream = File.OpenRead(path);
        var hash = SHA256.HashData(stream);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static string NormalizeSha256(string value)
        => Regex.Replace(value ?? "", @"^sha256:|\s|-", "", RegexOptions.IgnoreCase).ToLowerInvariant();

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
            // best effort cleanup
        }
    }

    private static void EnsurePathWithin(string baseDir, string targetPath)
    {
        var baseFull = Path.GetFullPath(baseDir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var targetFull = Path.GetFullPath(targetPath);
        var relative = Path.GetRelativePath(baseFull, targetFull);
        if (relative.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(relative))
        {
            throw new InvalidOperationException($"路径不在允许目录内：{targetFull}");
        }
    }

    private static string EscapePowerShellSingleQuoted(string value)
        => value.Replace("'", "''");

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
            var manifest = LoadRuntimeUnitManifestMap().GetValueOrDefault("service.codex");
            switch (action)
            {
                case "check":
                    await CheckCodexAsync();
                    return _codexStatus.Text;
                case "update":
                    if (manifest?.Update is null)
                    {
                        throw new InvalidOperationException("Codex CLI 未声明更新策略。");
                    }
                    var codexPlan = ResolveRuntimeUpdatePlan(manifest) ?? throw new InvalidOperationException("Codex CLI 当前不可自动更新。");
                    if (!codexPlan.CanUpdate) throw new InvalidOperationException(codexPlan.Reason);
                    _codexStatus.Text = "正在更新 Codex CLI...";
                    await RunUpdatePlanAsync(codexPlan);
                    return _codexStatus.Text;
                case "openLocation":
                    OpenPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm"));
                    return "opened";
            }
        }

        var managedManifest = LoadRuntimeUnitManifestMap().GetValueOrDefault(unitId);
        if (managedManifest?.Update is not null
            && !string.Equals(unitId, "service.codex", StringComparison.OrdinalIgnoreCase))
        {
            switch (action)
            {
                case "check":
                    return await BuildManagedToolCheckDetailAsync(managedManifest);
                case "update":
                    var managedPlan = ResolveRuntimeUpdatePlan(managedManifest) ?? throw new InvalidOperationException($"{managedManifest.DisplayName} 当前不可自动更新。");
                    if (!managedPlan.CanUpdate) throw new InvalidOperationException(managedPlan.Reason);
                    await RunUpdatePlanAsync(managedPlan);
                    return await BuildManagedToolCheckDetailAsync(managedManifest);
                case "openLocation":
                    OpenPath(ExpandManifestValue(string.IsNullOrWhiteSpace(managedManifest.Cwd) ? managedManifest.Source : managedManifest.Cwd));
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
            var manifest = FindMcpManifestById(id)
                ?? throw new InvalidOperationException($"未找到 MCP 清单：{id}");
            SelectMcpById(id);
            switch (action)
            {
                case "check":
                    await CheckMcpAsync(manifest, appendLog: true);
                    return _mcpRuntimeStatus.Text;
                case "start":
                    await StartMcpAsync(manifest);
                    return _mcpRuntimeStatus.Text;
                case "stop":
                    await StopMcpAsync(manifest);
                    return _mcpRuntimeStatus.Text;
                case "register":
                    await RegisterAllMcpsAsync();
                    return _mcpStatus.Text;
                case "openLocation":
                    OpenMcpPath(manifest);
                    return "opened";
                case "install":
                    if (string.IsNullOrWhiteSpace(manifest.ManifestPath))
                    {
                        throw new InvalidOperationException("当前未选中可安装的 MCP。");
                    }
                    await InstallExtensionAsync(manifest.ManifestPath);
                    return "installed";
                case "update":
                    var mcpPlan = ResolveManifestUpdatePlan(
                        manifest.ManifestPath ?? "",
                        ResolveManifestDirectory(manifest.Cwd, manifest),
                        FormatManifestSource(manifest.Source, manifest))
                        ?? throw new InvalidOperationException("当前 MCP 未声明更新策略。");
                    if (!mcpPlan.CanUpdate) throw new InvalidOperationException(mcpPlan.Reason);
                    await RunUpdatePlanAsync(mcpPlan);
                    return "updated";
            }
        }

        if (unitId.StartsWith("extension.", StringComparison.OrdinalIgnoreCase))
        {
            var manifestPath = unitId["extension.".Length..];
            var isSkill = TryGetSkillManifestItem(manifestPath, out var skillItem);
            switch (action)
            {
                case "enable":
                    if (isSkill)
                    {
                        return await RunSkillLifecycleCommandAsync("enable", JsonSerializer.SerializeToElement(new { id = skillItem.Id }), includePanelActor: true);
                    }
                    await SetExtensionEnabledAsync(manifestPath, true);
                    return "enabled";
                case "disable":
                    if (isSkill)
                    {
                        return await RunSkillLifecycleCommandAsync("disable", JsonSerializer.SerializeToElement(new { id = skillItem.Id }), includePanelActor: true);
                    }
                    await SetExtensionEnabledAsync(manifestPath, false);
                    return "disabled";
                case "remove":
                    await RemoveExtensionAsync(manifestPath);
                    return "removed";
                case "install":
                    if (isSkill)
                    {
                        return await PrepareSkillManifestInstallAsync(skillItem);
                    }
                    await InstallExtensionAsync(manifestPath);
                    return "installed";
                case "update":
                    var updatePlan = ResolveManifestUpdatePlan(
                        manifestPath,
                        BuildExtensionItems().FirstOrDefault(candidate => string.Equals(candidate.ManifestPath, manifestPath, StringComparison.OrdinalIgnoreCase)) is { } extensionItem
                            ? ExpandManifestValue(extensionItem.Source)
                            : "",
                        BuildExtensionItems().FirstOrDefault(candidate => string.Equals(candidate.ManifestPath, manifestPath, StringComparison.OrdinalIgnoreCase))?.Source ?? "")
                        ?? throw new InvalidOperationException("当前扩展未声明更新策略。");
                    if (!updatePlan.CanUpdate) throw new InvalidOperationException(updatePlan.Reason);
                    await RunUpdatePlanAsync(updatePlan);
                    return "updated";
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

    private async Task<string> BuildManagedToolCheckDetailAsync(RuntimeUnitManifestDefinition manifest)
    {
        var installRoot = ExpandManifestValue(string.IsNullOrWhiteSpace(manifest.Cwd) ? manifest.Source : manifest.Cwd);
        var packageRoot = ResolveManagedToolPackageRoot(manifest, installRoot);
        var version = ResolveRuntimeVersion(manifest, packageRoot, installRoot);
        var probeText = "";
        if (string.Equals(manifest.Id, "tool.larkCli", StringComparison.OrdinalIgnoreCase))
        {
            var probe = await CreateLarkCliGateway().ProbeAsync(_ctiHome);
            probeText = probe.Ready
                ? $"身份: {probe.Identity} | token: {probe.TokenStatus} | 官方诊断: ready"
                : $"官方诊断: blocked | {TrimForSummary(probe.Detail, 600)}";
            if (!string.IsNullOrWhiteSpace(probe.Version)) version = probe.Version;
        }
        return BuildManagedToolDetail(manifest, installRoot, version, ResolveRuntimeUpdatePlan(manifest), probeText);
    }

    private Task<string> RestartControlPanelAsync()
    {
        var executablePath = GetOfficialControlPanelPath();
        if (string.IsNullOrWhiteSpace(executablePath) || !File.Exists(executablePath))
        {
            throw new InvalidOperationException("无法定位当前控制面板程序，不能自动重启。");
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = executablePath,
            WorkingDirectory = AppContext.BaseDirectory,
            UseShellExecute = false,
        };
        foreach (var argument in Environment.GetCommandLineArgs().Skip(1))
        {
            startInfo.ArgumentList.Add(argument);
        }

        var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("新控制面板进程启动失败。");
        AddWebActivity("info", "控制面板重启", $"已启动新面板 PID={process.Id}，当前面板即将退出。");

        _ = Task.Run(async () =>
        {
            await Task.Delay(800);
            try
            {
                if (!IsDisposed && IsHandleCreated)
                {
                    BeginInvoke(new Action(Close));
                    return;
                }

                if (_controlApi is not null)
                {
                    await _controlApi.StopAsync();
                    await _controlApi.DisposeAsync();
                }
            }
            catch
            {
                // Restart is a best-effort escape hatch; the new process is already launched.
            }
            Environment.Exit(0);
        });

        return Task.FromResult($"panel restart requested PID={process.Id}");
    }

    private static string? GetOfficialControlPanelPath()
    {
        var officialPath = Path.Combine(AppContext.BaseDirectory, OfficialControlPanelExeName);
        if (File.Exists(officialPath)) return officialPath;
        var processPath = Environment.ProcessPath;
        if (!string.IsNullOrWhiteSpace(processPath)
            && string.Equals(Path.GetFileName(processPath), LegacyControlPanelExeName, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        return processPath;
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
        if (!IsUserExtensionPath(manifestPath))
        {
            throw new InvalidOperationException("只能移除用户覆盖层扩展记录；内置 config 清单不能从面板删除。");
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

    private static string ReadJsonString(JsonElement root, string name, string fallback)
        => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? fallback : fallback;

    private static double ReadJsonDouble(JsonElement root, string name)
        => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetDouble() : 0;

    private static int ReadJsonInt(JsonElement root, string name)
        => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var parsed) ? parsed : 0;

    private static bool ReadJsonBool(JsonElement root, string name)
        => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;

    private static bool ReadJsonBool(JsonObject? root, string name)
    {
        if (root is null || !root.TryGetPropertyValue(name, out var node) || node is null) return false;
        try
        {
            return node.GetValue<bool>();
        }
        catch
        {
            return false;
        }
    }

    private void PostWebMessage(object message)
    {
        var json = JsonSerializer.Serialize(message, WebJsonOptions);
        if (InvokeRequired)
        {
            BeginInvoke(() =>
            {
                if (!_webReady || _webView.CoreWebView2 is null) return;
                _webView.CoreWebView2.PostWebMessageAsJson(json);
            });
            return;
        }
        if (!_webReady || _webView.CoreWebView2 is null) return;
        _webView.CoreWebView2.PostWebMessageAsJson(json);
    }

    private void AddWebActivity(string level, string title, string message)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => AddWebActivity(level, title, message));
            return;
        }
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
            CreateCardButton("更新", async () => await InvokeRuntimeUnitActionAsync("service.codex", "update")),
            CreateCardButton("混合模式", async () => await SetRouterModeAsync("hybrid")),
            CreateCardButton("仅本地", async () => await SetRouterModeAsync("local_only")),
            CreateCardButton("仅 Codex", async () => await SetRouterModeAsync("codex_only")),
            CreateCardButton("路由摘要", ShowLocalRouterSummary));
        AddStatusCard(layout, "MCP 清单", _mcpStatus, 2,
            CreateCardButton("注册全部", async () => await RegisterAllMcpsAsync()),
            CreateCardButton("刷新", async () => await RefreshAllAsync()));
        AddStatusCard(layout, "本地模型 API", _localLlmStatus, 3,
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
        try
        {
            _config = ReadEnvFile(_configPath);
        }
        catch (IOException ex)
        {
            AppendLog($"配置文件暂时不可读，面板将使用当前内存配置或默认值继续启动：{ex.Message}");
            if (_config.Count == 0) _config = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }
        catch (UnauthorizedAccessException ex)
        {
            AppendLog($"配置文件访问被拒绝，面板将使用当前内存配置或默认值继续启动：{ex.Message}");
            if (_config.Count == 0) _config = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        }
        _memoryRepo.Text = ResolveEffectiveMemoryRepoPath(
            GetConfig("CTI_MEMORY_REPO_DIR", GetDefaultMemoryRepoPath()),
            GetConfig("CTI_DEFAULT_WORKDIR", GetDefaultWorkDirPath()),
            appendLog: true);
        AppendLog($"已读取配置：{_configPath}");
    }

    private void LoadManifests()
    {
        _manifests = [];
        Directory.CreateDirectory(_manifestDir);
        var manifestsById = new Dictionary<string, McpManifest>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in GetMcpManifestDirs().SelectMany(dir => Directory.GetFiles(dir, "*.json").OrderBy(p => p, StringComparer.OrdinalIgnoreCase)))
        {
            try
            {
                var manifest = JsonSerializer.Deserialize<McpManifest>(File.ReadAllText(file, Encoding.UTF8), JsonOptions);
                if (manifest is null) continue;
                manifest.Id ??= Path.GetFileNameWithoutExtension(file);
                manifest.DisplayName ??= manifest.Id;
                manifest.ManifestPath = file;
                manifest.ServiceStatePath = _mcpServiceStatePath;
                manifestsById[manifest.Id] = manifest;
            }
            catch (Exception ex)
            {
                AppendLog($"MCP 清单读取失败：{file} {ex.Message}");
            }
        }
        _manifests = manifestsById.Values.OrderBy(item => item.DisplayName ?? item.Id, StringComparer.OrdinalIgnoreCase).ToList();
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
        foreach (var watcher in _manifestWatchers) watcher.Dispose();
        _manifestWatchers.Clear();

        Directory.CreateDirectory(_manifestDir);
        Directory.CreateDirectory(_userMcpManifestDir);

        _manifestReloadTimer = new System.Windows.Forms.Timer { Interval = 600 };
        _manifestReloadTimer.Tick += (_, _) =>
        {
            _manifestReloadTimer?.Stop();
            ReloadManifestList();
        };

        foreach (var dir in GetMcpManifestDirs())
        {
            var watcher = new FileSystemWatcher(dir, "*.json")
            {
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.CreationTime | NotifyFilters.Size,
                IncludeSubdirectories = false,
                EnableRaisingEvents = true,
            };

            watcher.Created += (_, e) => QueueManifestReload($"新增: {Path.GetFileName(e.FullPath)}");
            watcher.Changed += (_, e) => QueueManifestReload($"更新: {Path.GetFileName(e.FullPath)}");
            watcher.Deleted += (_, e) => QueueManifestReload($"删除: {Path.GetFileName(e.FullPath)}");
            watcher.Renamed += (_, e) => QueueManifestReload($"重命名: {Path.GetFileName(e.OldFullPath)} -> {Path.GetFileName(e.FullPath)}");
            _manifestWatchers.Add(watcher);
            _manifestWatcher ??= watcher;
        }

        AppendLog($"已监听 MCP 清单目录：{string.Join(", ", GetMcpManifestDirs())}");
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

    private string InferCodexModelSource()
        => !string.IsNullOrWhiteSpace(GetConfig("CTI_CODEX_BASE_URL", ""))
           || !string.IsNullOrWhiteSpace(GetConfig("CTI_CODEX_MODEL", ""))
           || !string.IsNullOrWhiteSpace(GetConfig("CTI_CODEX_API_KEY", ""))
            ? "external_api"
            : "official";

    private SettingsSnapshot GetSettingsSnapshot() => new(
        GetConfig("CTI_DEFAULT_WORKDIR", GetDefaultWorkDirPath()),
        GetConfig("CTI_ALLOWED_WORKSPACE_ROOTS", GetDefaultWorkDirPath()),
        ResolveEffectiveMemoryRepoPath(
            GetConfig("CTI_MEMORY_REPO_DIR", GetDefaultMemoryRepoPath()),
            GetConfig("CTI_DEFAULT_WORKDIR", GetDefaultWorkDirPath())),
        GetConfig("CTI_CODEX_ADDITIONAL_DIRECTORIES", ""),
        GetConfig("CTI_REPLY_STYLE_HINT", ""),
        NormalizeExecutorId(GetConfig("CTI_DEFAULT_EXECUTOR_ID", "")),
        NormalizeLocalAiKind(GetConfig("CTI_LOCAL_AI_KIND", "ollama")),
        GetConfig("CTI_LOCAL_AI_BASE_URL", GetConfig("CTI_OLLAMA_BASE_URL", "http://127.0.0.1:11434")),
        GetConfiguredOllamaModelsPath(),
        GetConfig("CTI_LOCAL_AI_MODEL", GetConfig("CTI_OLLAMA_MODEL", "qwen2.5-coder:7b")),
        "keep",
        "",
        MaskSecretForSettings(GetConfig("CTI_LOCAL_AI_API_KEY", "")),
        !string.IsNullOrWhiteSpace(GetConfig("CTI_LOCAL_AI_API_KEY", "")),
        GetConfig("CTI_LOCAL_AI_TIMEOUT_MS", GetConfig("CTI_OLLAMA_TIMEOUT_MS", "45000")),
        NormalizeCodexModelSource(GetConfig("CTI_CODEX_MODEL_SOURCE", InferCodexModelSource())),
        NormalizeCodexRoutingMode(GetConfig("CTI_CODEX_ROUTING_MODE", "manual")),
        NormalizeCodexApiFallbackChain(GetConfig("CTI_CODEX_API_FALLBACK_CHAIN", "local_api,external_api")),
        GetConfig("CTI_CODEX_BASE_URL", ""),
        GetConfig("CTI_CODEX_MODEL", ""),
        string.Equals(GetConfig("CTI_CODEX_PASS_MODEL", "false"), "true", StringComparison.OrdinalIgnoreCase),
        NormalizeCodexReasoningEffort(GetConfig("CTI_CODEX_REASONING_EFFORT", "low")),
        string.Equals(GetConfig("CTI_MEMORY_OPTIMIZER_ENABLED", "false"), "true", StringComparison.OrdinalIgnoreCase),
        NormalizePositiveNumber(GetConfig("CTI_MEMORY_OPTIMIZER_INTERVAL_DAYS", "7"), "7"),
        NormalizeMemoryOptimizerModelSource(GetConfig("CTI_MEMORY_OPTIMIZER_MODEL_SOURCE", "codex_primary")),
        "keep",
        "",
        MaskSecretForSettings(GetConfig("CTI_CODEX_API_KEY", "")),
        !string.IsNullOrWhiteSpace(GetConfig("CTI_CODEX_API_KEY", ""))
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
        var memoryRepo = ResolveEffectiveMemoryRepoPath(settings.MemoryRepo.Trim(), settings.DefaultWorkDir.Trim());
        Directory.CreateDirectory(Path.GetDirectoryName(_configPath)!);
        var lines = ReadEnvFileLines(_configPath);
        SetOrAppendEnv(lines, "CTI_DEFAULT_WORKDIR", settings.DefaultWorkDir.Trim());
        SetOrAppendEnv(lines, "CTI_ALLOWED_WORKSPACE_ROOTS", settings.AllowedRoots.Trim());
        SetOrAppendEnv(lines, "CTI_MEMORY_REPO_DIR", memoryRepo);
        // 保留配置文件中的旧值供诊断，不再由控制面板写入或删除。
        SetOrAppendEnv(lines, "CTI_REPLY_STYLE_HINT", settings.ReplyStyleHint.Trim());
        SetOrAppendEnv(lines, "CTI_DEFAULT_EXECUTOR_ID", NormalizeExecutorId(settings.DefaultExecutorId));
        SetOrAppendEnv(lines, "CTI_LOCAL_AI_KIND", NormalizeLocalAiKind(settings.LocalAiKind));
        SetOrAppendEnv(lines, "CTI_LOCAL_AI_BASE_URL", settings.LocalAiBaseUrl.Trim());
        if (!string.IsNullOrWhiteSpace(settings.OllamaModelsDir))
        {
            var ollamaModelsDir = NormalizeOllamaModelsPath(settings.OllamaModelsDir);
            SetOrAppendEnv(lines, "CTI_OLLAMA_MODELS_DIR", ollamaModelsDir);
            SetOrAppendEnv(lines, "OLLAMA_MODELS", ollamaModelsDir);
        }
        SetOrAppendEnv(lines, "CTI_LOCAL_AI_MODEL", settings.LocalAiModel.Trim());
        SetOrAppendEnv(lines, "CTI_LOCAL_AI_TIMEOUT_MS", NormalizePositiveNumber(settings.LocalAiTimeoutMs, "45000"));
        ApplySecretEnv(lines, "CTI_LOCAL_AI_API_KEY", settings.LocalAiApiKeyAction, settings.LocalAiApiKeyValue);
        SetOrAppendEnv(lines, "CTI_OLLAMA_BASE_URL", settings.LocalAiBaseUrl.Trim());
        SetOrAppendEnv(lines, "CTI_OLLAMA_MODEL", settings.LocalAiModel.Trim());
        SetOrAppendEnv(lines, "CTI_OLLAMA_TIMEOUT_MS", NormalizePositiveNumber(settings.LocalAiTimeoutMs, "45000"));
        SetOrAppendEnv(lines, "CTI_CODEX_MODEL_SOURCE", NormalizeCodexModelSource(settings.CodexModelSource));
        SetOrAppendEnv(lines, "CTI_CODEX_ROUTING_MODE", NormalizeCodexRoutingMode(settings.CodexRoutingMode));
        SetOrAppendEnv(lines, "CTI_CODEX_API_FALLBACK_CHAIN", NormalizeCodexApiFallbackChain(settings.CodexApiFallbackChain));
        SetOrAppendEnv(lines, "CTI_CODEX_BASE_URL", settings.CodexBaseUrl.Trim());
        SetOrAppendEnv(lines, "CTI_CODEX_MODEL", settings.CodexModel.Trim());
        SetOrAppendEnv(lines, "CTI_CODEX_PASS_MODEL", settings.CodexPassModel ? "true" : "false");
        SetOrAppendEnv(lines, "CTI_CODEX_REASONING_EFFORT", NormalizeCodexReasoningEffort(settings.CodexReasoningEffort));
        SetOrAppendEnv(lines, "CTI_MEMORY_OPTIMIZER_ENABLED", settings.MemoryOptimizerEnabled ? "true" : "false");
        SetOrAppendEnv(lines, "CTI_MEMORY_OPTIMIZER_INTERVAL_DAYS", NormalizePositiveNumber(settings.MemoryOptimizerIntervalDays, "7"));
        SetOrAppendEnv(lines, "CTI_MEMORY_OPTIMIZER_MODEL_SOURCE", NormalizeMemoryOptimizerModelSource(settings.MemoryOptimizerModelSource));
        ApplySecretEnv(lines, "CTI_CODEX_API_KEY", settings.CodexApiKeyAction, settings.CodexApiKeyValue);
        File.WriteAllLines(_configPath, lines, new UTF8Encoding(false));
        AppendLog("配置已保存。Codex CLI 模型来源、路径和回复风格将在重启飞书桥接后生效。");
        LoadConfig();
    }

    private static bool SettingsRouteIncludesLocalApi(SettingsSnapshot settings)
    {
        if (NormalizeCodexModelSource(settings.CodexModelSource) == "local_api") return true;
        if (NormalizeCodexRoutingMode(settings.CodexRoutingMode) != "auto_failover") return false;
        return NormalizeCodexApiFallbackChain(settings.CodexApiFallbackChain)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Any(item => string.Equals(item, "local_api", StringComparison.OrdinalIgnoreCase));
    }

    private async Task EnsureLocalApiReadyForSettingsAsync(SettingsSnapshot settings)
    {
        if (!SettingsRouteIncludesLocalApi(settings)) return;

        var kind = NormalizeLocalAiKind(settings.LocalAiKind);
        if (kind == "ollama")
        {
            await StartLocalLlmAsync();
            return;
        }

        var apiKey = ResolveSecretForTest("CTI_LOCAL_AI_API_KEY", settings.LocalAiApiKeyAction, settings.LocalAiApiKeyValue);
        var probe = await ProbeLocalLlmAsync(
            settings.LocalAiBaseUrl.Trim(),
            settings.LocalAiModel.Trim(),
            kind,
            apiKey);
        AppendLog(probe.Ok
            ? $"本地 API 预检通过：{probe.Message}"
            : $"本地 API 预检未通过：{probe.Message}");
    }

    private async Task<object> TestLocalAiSettingsAsync(JsonElement payload)
    {
        var settings = ReadSettingsPayload(payload);
        var apiKey = ResolveSecretForTest("CTI_LOCAL_AI_API_KEY", settings.LocalAiApiKeyAction, settings.LocalAiApiKeyValue);
        var result = await ProbeLocalLlmAsync(
            settings.LocalAiBaseUrl.Trim(),
            settings.LocalAiModel.Trim(),
            NormalizeLocalAiKind(settings.LocalAiKind),
            apiKey);
        return new
        {
            ok = result.Ok,
            message = result.Message,
            kind = NormalizeLocalAiKind(settings.LocalAiKind),
            baseUrl = settings.LocalAiBaseUrl.Trim(),
            model = settings.LocalAiModel.Trim(),
        };
    }

    private object TestCodexApiSettings(JsonElement payload)
    {
        var settings = ReadSettingsPayload(payload);
        var apiKey = ResolveSecretForTest("CTI_CODEX_API_KEY", settings.CodexApiKeyAction, settings.CodexApiKeyValue);
        var baseUrl = settings.CodexBaseUrl.Trim();
        var model = settings.CodexModel.Trim();
        var effort = NormalizeCodexReasoningEffort(settings.CodexReasoningEffort);
        var problems = new List<string>();
        if (!string.IsNullOrWhiteSpace(baseUrl)
            && !Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri))
        {
            problems.Add("Codex Base URL 不是有效绝对 URL。");
        }
        if (settings.CodexModelSource == "local_api" && string.IsNullOrWhiteSpace(settings.LocalAiBaseUrl))
        {
            problems.Add("本地 API 作为主模型时，本地 API 地址不能为空。");
        }
        if (settings.CodexModelSource == "external_api" && string.IsNullOrWhiteSpace(baseUrl))
        {
            problems.Add("外部 API 作为主模型时，Base URL 不能为空。");
        }
        if (settings.CodexPassModel && string.IsNullOrWhiteSpace(model))
        {
            var modelSource = settings.CodexModelSource == "local_api" ? settings.LocalAiModel : model;
            if (string.IsNullOrWhiteSpace(modelSource))
            {
                problems.Add("已启用传递 model，但模型名称为空。");
            }
        }
        var keyStatus = string.IsNullOrWhiteSpace(apiKey) ? "未设置 API key，将使用 Codex 登录态或环境默认凭据。" : $"API key 已设置 {MaskSecretForSettings(apiKey)}。";
        if (problems.Count > 0)
        {
            return new { ok = false, message = string.Join(" ", problems), baseUrl, model, reasoningEffort = effort, apiKeySet = !string.IsNullOrWhiteSpace(apiKey) };
        }
        return new
        {
            ok = true,
            message = $"Codex API 配置形态正常。{keyStatus} 未发送真实模型请求。",
            baseUrl,
            model,
            modelSource = settings.CodexModelSource,
            passModel = settings.CodexPassModel,
            reasoningEffort = effort,
            apiKeySet = !string.IsNullOrWhiteSpace(apiKey),
        };
    }

    private string ResolveSecretForTest(string envKey, string action, string value)
    {
        action = (action ?? "keep").Trim().ToLowerInvariant();
        if (action == "set") return value.Trim();
        if (action == "clear") return "";
        return GetConfig(envKey, "");
    }

    private async Task<string> SummarizeReplyStyleAsync(string requestText)
    {
        requestText = requestText.Trim();
        if (string.IsNullOrWhiteSpace(requestText))
        {
            throw new InvalidOperationException("先输入用户对机器人说话方式的要求。");
        }

        var kind = NormalizeLocalAiKind(GetConfig("CTI_LOCAL_AI_KIND", "ollama"));
        var baseUrl = GetConfig("CTI_LOCAL_AI_BASE_URL", GetConfig("CTI_OLLAMA_BASE_URL", "http://127.0.0.1:11434"));
        var model = GetConfig("CTI_LOCAL_AI_MODEL", GetConfig("CTI_OLLAMA_MODEL", "qwen2.5-coder:7b"));
        var apiKey = GetConfig("CTI_LOCAL_AI_API_KEY", "");
        var probe = await ProbeLocalLlmAsync(baseUrl, model, kind, apiKey);
        if (!probe.Ok)
        {
            AppendLog($"本地AI整理失败：本地 AI 不可用 | {probe.Message}");
            throw new InvalidOperationException($"本地 AI 当前不可用：{probe.Message}");
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
                        content = "你不是聊天助手。你只负责把用户对机器人说话方式的原始要求，改写成一段可直接写入配置的中文回复风格规则。即使用户要求扮演某个角色，也只能转成“回复时……”开头的风格约束，不能进入角色、不能回答用户、不能说“好的/请问有什么可以帮忙”。输出要求：1. 只输出最终规则文本；2. 90字以内；3. 必须以“回复时”开头；4. 不要解释原因；5. 不要用项目符号；6. 重点约束语气、长度、是否暴露思考过程。"
                    },
                    new
                    {
                        role = "user",
                        content = requestText
                    }
                }
            };
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl.TrimEnd('/')}/v1/chat/completions")
            {
                Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json"),
            };
            if (!string.IsNullOrWhiteSpace(apiKey))
            {
                request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey.Trim());
            }
            using var response = await client.SendAsync(request);
            var body = await response.Content.ReadAsStringAsync();
            response.EnsureSuccessStatusCode();

            var summarized = NormalizeReplyStyleSummary(requestText, ExtractChatCompletionText(body));
            if (string.IsNullOrWhiteSpace(summarized))
            {
                throw new InvalidOperationException("本地模型没有返回可用的风格摘要。");
            }

            var current = GetSettingsSnapshot();
            SaveSettingsFromDialog(current with { ReplyStyleHint = summarized });
            AppendLog($"本地AI已整理回复风格：{summarized}");
            return summarized;
        }
        catch (Exception ex)
        {
            AppendLog($"本地AI整理失败：{ex.Message}");
            throw;
        }
    }

    private static string NormalizeReplyStyleSummary(string requestText, string modelText)
    {
        var text = Regex.Replace(modelText ?? "", @"^\s*[-*>\d.、\s]+", "").Trim();
        text = text.Trim('`', '"', '\'', '“', '”', '‘', '’');
        if (string.IsNullOrWhiteSpace(text) || LooksLikeAssistantChatReply(text))
        {
            return BuildReplyStyleFallback(requestText);
        }

        text = Regex.Replace(text, "\\s+", " ");
        if (!text.StartsWith("回复时", StringComparison.Ordinal))
        {
            text = "回复时" + text.TrimStart('，', '。', ':', '：', ' ');
        }
        if (LooksLikeAssistantChatReply(text))
        {
            return BuildReplyStyleFallback(requestText);
        }
        return TrimReplyStyleSummary(text);
    }

    private static bool LooksLikeAssistantChatReply(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return true;
        if (Regex.IsMatch(text, "请问|有什么.*帮|我可以.*帮|需要.*帮助|随时告诉我|很高兴|您好|你好", RegexOptions.IgnoreCase)) return true;
        if (Regex.IsMatch(text, "^(好的|好呀|可以呀|当然|没问题)[，,。！!？?\\s]*(请问|有什么|我可以|需要)", RegexOptions.IgnoreCase)) return true;
        return false;
    }

    private static string BuildReplyStyleFallback(string requestText)
    {
        var source = requestText ?? "";
        var parts = new List<string> { "回复时先说结果" };
        if (Regex.IsMatch(source, "自然|轻松|口语|直接回消息|聊天", RegexOptions.IgnoreCase))
        {
            parts.Add("语气自然轻松");
        }
        if (Regex.IsMatch(source, "卖萌|可爱|萌", RegexOptions.IgnoreCase))
        {
            parts.Add("可适度卖萌");
        }
        if (Regex.IsMatch(source, "不要啰嗦|不啰嗦|简洁|短", RegexOptions.IgnoreCase))
        {
            parts.Add("不啰嗦");
        }
        if (Regex.IsMatch(source, "思考|过程", RegexOptions.IgnoreCase))
        {
            parts.Add("不暴露思考过程");
        }
        if (parts.Count == 1)
        {
            parts.Add("按用户要求控制语气和长度");
            parts.Add("不暴露思考过程");
        }
        return TrimReplyStyleSummary(string.Join("，", parts) + "。");
    }

    private static string TrimReplyStyleSummary(string text)
    {
        text = text.Trim();
        if (text.Length <= 120) return text;
        var cut = text[..120];
        var lastPunctuation = cut.LastIndexOfAny(['。', '；', '，', ',', ';']);
        if (lastPunctuation >= 40)
        {
            cut = cut[..lastPunctuation];
        }
        return cut.TrimEnd('，', ',', '；', ';') + "。";
    }

    private static void SetOrAppendEnv(List<string> lines, string key, string value)
    {
        var index = lines.FindIndex(line => line.TrimStart().StartsWith(key + "=", StringComparison.OrdinalIgnoreCase));
        var next = key + "=" + value;
        if (index >= 0) lines[index] = next; else lines.Add(next);
    }

    private static void RemoveEnv(List<string> lines, string key)
    {
        lines.RemoveAll(line => line.TrimStart().StartsWith(key + "=", StringComparison.OrdinalIgnoreCase));
    }

    private static void ApplySecretEnv(List<string> lines, string key, string action, string value)
    {
        action = (action ?? "keep").Trim().ToLowerInvariant();
        if (action == "set")
        {
            SetOrAppendEnv(lines, key, value.Trim());
            return;
        }
        if (action == "clear")
        {
            RemoveEnv(lines, key);
        }
    }

    private static string NormalizeLocalAiKind(string value)
    {
        value = (value ?? "").Trim().ToLowerInvariant();
        return value is "ollama" or "lmstudio" or "vllm" or "openai-compatible" or "custom"
            ? value
            : "ollama";
    }

    private static string NormalizeCodexReasoningEffort(string value)
    {
        value = (value ?? "").Trim().ToLowerInvariant();
        return value is "minimal" or "low" or "medium" or "high" or "xhigh"
            ? value
            : "low";
    }

    private static string NormalizeCodexModelSource(string value)
    {
        value = (value ?? "").Trim().ToLowerInvariant();
        return value is "official" or "local_api" or "external_api" ? value : "official";
    }

    private static string NormalizeCodexRoutingMode(string value)
    {
        value = (value ?? "").Trim().ToLowerInvariant();
        return value == "auto_failover" ? "auto_failover" : "manual";
    }

    private static string NormalizeCodexApiFallbackChain(string value)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var ordered = new List<string>();
        foreach (var part in (value ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var source = NormalizeCodexModelSource(part);
            if (source == "official" && !string.Equals(part, "official", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            if (seen.Add(source))
            {
                ordered.Add(source);
            }
        }
        return ordered.Count > 0 ? string.Join(",", ordered) : "local_api,external_api";
    }

    private static string NormalizeMemoryOptimizerModelSource(string value)
    {
        value = (value ?? "").Trim().ToLowerInvariant();
        return value is "codex_primary" or "local_ai" or "external_api" ? value : "codex_primary";
    }

    private static string NormalizeExecutorId(string value)
    {
        value = (value ?? "").Trim().ToLowerInvariant();
        return value.Length > 0 && value.All(ch => char.IsLetterOrDigit(ch) || ch is '-' or '_' or '.')
            ? value
            : "";
    }

    private static string NormalizePositiveNumber(string value, string fallback)
        => int.TryParse((value ?? "").Trim(), out var parsed) && parsed > 0 ? parsed.ToString() : fallback;

    private static string MaskSecretForSettings(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";
        value = value.Trim();
        return value.Length <= 4 ? "****" : new string('*', value.Length - 4) + value[^4..];
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

    private static bool PermissionSubjectsEquivalent(IEnumerable<PermissionSubject>? left, IEnumerable<PermissionSubject>? right)
    {
        var normalizedLeft = NormalizePermissionSubjects(left)
            .Select(item => $"{NormalizePermissionChannel(item.ChannelType)}\n{item.UserId.Trim()}\n{NormalizePermissionRole(item.Role)}\n{(item.DisplayName ?? "").Trim()}")
            .ToArray();
        var normalizedRight = NormalizePermissionSubjects(right)
            .Select(item => $"{NormalizePermissionChannel(item.ChannelType)}\n{item.UserId.Trim()}\n{NormalizePermissionRole(item.Role)}\n{(item.DisplayName ?? "").Trim()}")
            .ToArray();
        return normalizedLeft.SequenceEqual(normalizedRight, StringComparer.Ordinal);
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

    private async Task CheckLocalLlmAsync(bool updateOnly = false)
    {
        var kind = NormalizeLocalAiKind(GetConfig("CTI_LOCAL_AI_KIND", "ollama"));
        var baseUrl = GetConfig("CTI_LOCAL_AI_BASE_URL", GetConfig("CTI_OLLAMA_BASE_URL", "http://127.0.0.1:11434"));
        var model = GetConfig("CTI_LOCAL_AI_MODEL", GetConfig("CTI_OLLAMA_MODEL", "qwen2.5-coder:7b"));
        var apiKey = GetConfig("CTI_LOCAL_AI_API_KEY", "");

        if (!IsLocalAiModelSourceActive())
        {
            _localLlmStatus.Text = string.Join(Environment.NewLine, new[]
            {
                "未启用",
                model,
                "Codex 当前未选择 local_api",
            });
            if (!updateOnly) AppendLog("本地模型 API 未参与当前 Codex 模型来源。");
            return;
        }

        var enabled = !string.Equals(GetConfig("CTI_OLLAMA_ENABLED", GetConfig("CTI_LOCAL_LLM_ENABLED", "true")), "false", StringComparison.OrdinalIgnoreCase);
        if (!enabled)
        {
            _localLlmStatus.Text = $"未启用{Environment.NewLine}{model}";
            if (!updateOnly) AppendLog("本地模型 API 未启用。");
            return;
        }

        var (ok, message) = await ProbeLocalLlmAsync(baseUrl, model, kind, apiKey);
        var stats = ReadLocalLlmStatus();
        _localLlmStatus.Text = string.Join(Environment.NewLine, new[]
        {
            ok ? "在线" : "离线",
            model,
            $"类型: {LocalAiKindToLabel(kind)}",
            $"服务: {baseUrl}",
            "角色: Codex 模型来源",
            $"路由: {CodexRoutingModeToLabel(NormalizeCodexRoutingMode(GetConfig("CTI_CODEX_ROUTING_MODE", "manual")))}",
            "范围: 由 Codex agent 统一规划和执行",
            $"最近模型路由 {stats.RouteHits}",
            $"本地工具执行 {stats.ExecutionCount} / 失败 {stats.ExecutionFailures}",
            FormatLocalLlmLastStatus(stats),
        });

        if (!updateOnly)
        {
            AppendLog($"本地模型 API 检查：{(ok ? "通过" : "失败")} | {message}");
        }
    }

    private bool IsLocalAiModelSourceActive()
    {
        var source = NormalizeCodexModelSource(GetConfig("CTI_CODEX_MODEL_SOURCE", InferCodexModelSource()));
        var mode = NormalizeCodexRoutingMode(GetConfig("CTI_CODEX_ROUTING_MODE", "manual"));
        if (mode == "manual") return source == "local_api";
        return NormalizeCodexApiFallbackChain(GetConfig("CTI_CODEX_API_FALLBACK_CHAIN", "local_api,external_api"))
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Any(item => string.Equals(item, "local_api", StringComparison.OrdinalIgnoreCase));
    }

    private static string CodexRoutingModeToLabel(string? mode)
        => string.Equals(mode, "auto_failover", StringComparison.OrdinalIgnoreCase)
            ? "自动切换"
            : "手动选择";

    private async Task RefreshBuildInfoAsync()
    {
        var exePath = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(exePath))
        {
            exePath = Path.Combine(AppContext.BaseDirectory, OfficialControlPanelExeName);
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
        var total = 0;
        var enabled = 0;
        var disabled = 0;
        var missingSources = 0;
        foreach (var dir in GetExtensionManifestDirs().Select(item => item.Dir))
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
            var status = string.IsNullOrWhiteSpace(raw)
                ? new LocalLlmStatusRecord()
                : JsonSerializer.Deserialize<LocalLlmStatusRecord>(raw, JsonOptions) ?? new LocalLlmStatusRecord();
            NormalizeOllamaStatus(status);
            return status;
        }
        catch
        {
            return new LocalLlmStatusRecord();
        }
    }

    private void NormalizeOllamaStatus(LocalLlmStatusRecord status)
    {
        if (!IsDeprecatedLlamaStatus(status)) return;
        status.BaseUrl = GetConfig("CTI_OLLAMA_BASE_URL", "http://127.0.0.1:11434");
        status.Model = GetConfig("CTI_OLLAMA_MODEL", "qwen2.5-coder:7b");
        status.ServerReachable = null;
        status.LastCheckAt = null;
        if (string.IsNullOrWhiteSpace(status.LastError))
        {
            status.LastError = "已忽略旧 llama.cpp 状态，等待 Ollama 健康检查刷新。";
        }
    }

    private static bool IsDeprecatedLlamaStatus(LocalLlmStatusRecord status)
    {
        var baseUrl = (status.BaseUrl ?? "").Trim();
        var model = (status.Model ?? "").Trim();
        return string.Equals(baseUrl, "http://127.0.0.1:8080", StringComparison.OrdinalIgnoreCase)
            || model.EndsWith(".gguf", StringComparison.OrdinalIgnoreCase);
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

    private async Task<(bool Ok, string Message)> ProbeLocalLlmAsync(string baseUrl, string? expectedModel = null, string kind = "ollama", string? apiKey = null)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        kind = NormalizeLocalAiKind(kind);
        if (kind != "ollama")
        {
            return await ProbeOpenAiCompatibleAsync(client, baseUrl, expectedModel, apiKey);
        }
        var target = $"{baseUrl.TrimEnd('/')}/api/tags";
        try
        {
            using var response = await client.GetAsync(target);
            var code = (int)response.StatusCode;
            if (!response.IsSuccessStatusCode)
            {
                return (false, $"HTTP {code} | {target}");
            }
            var body = await response.Content.ReadAsStringAsync();
            using var document = JsonDocument.Parse(body);
            var models = new List<string>();
            if (document.RootElement.TryGetProperty("models", out var modelsElement) && modelsElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var model in modelsElement.EnumerateArray())
                {
                    var name = ReadJsonString(model, "name");
                    if (string.IsNullOrWhiteSpace(name)) name = ReadJsonString(model, "model");
                    if (!string.IsNullOrWhiteSpace(name)) models.Add(name);
                }
            }
            if (!string.IsNullOrWhiteSpace(expectedModel) && !models.Contains(expectedModel, StringComparer.OrdinalIgnoreCase))
            {
                return (false, $"在线但缺少模型 {expectedModel} | 可用: {string.Join(", ", models.Take(8))}");
            }
            return (true, $"在线 {code} | 模型 {models.Count}");
        }
        catch (Exception ex)
        {
            return (false, $"{target} | {ex.Message}");
        }
    }

    private static async Task<(bool Ok, string Message)> ProbeOpenAiCompatibleAsync(HttpClient client, string baseUrl, string? model, string? apiKey)
    {
        var target = $"{baseUrl.TrimEnd('/')}/v1/chat/completions";
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, target)
            {
                Content = new StringContent(JsonSerializer.Serialize(new
                {
                    model = string.IsNullOrWhiteSpace(model) ? "default" : model,
                    stream = false,
                    max_tokens = 8,
                    messages = new[] { new { role = "user", content = "ping" } },
                }), Encoding.UTF8, "application/json"),
            };
            if (!string.IsNullOrWhiteSpace(apiKey))
            {
                request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey.Trim());
            }
            using var response = await client.SendAsync(request);
            var body = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
            {
                return (false, $"Chat Completions HTTP {(int)response.StatusCode} {response.ReasonPhrase} | {TrimForStatus(body)}");
            }
            return (true, $"Chat Completions 在线 {(int)response.StatusCode} | {target}");
        }
        catch (Exception ex)
        {
            return (false, $"{target} | {ex.Message}");
        }
    }

    private async Task<object> ProbeLocalLlmToolCallingAsync(JsonElement payload)
    {
        var settings = ReadSettingsPayload(payload);
        var apiKey = ResolveSecretForTest("CTI_LOCAL_AI_API_KEY", settings.LocalAiApiKeyAction, settings.LocalAiApiKeyValue);
        var kind = NormalizeLocalAiKind(settings.LocalAiKind);
        var model = settings.LocalAiModel.Trim();
        var baseUrl = NormalizeOpenAiCompatibleBaseUrl(settings.LocalAiBaseUrl.Trim(), kind);
        var endpoint = $"{baseUrl.TrimEnd('/')}/chat/completions";
        var toolName = "cti_probe_echo";
        using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(Math.Max(5000, ParsePositiveInt(settings.LocalAiTimeoutMs, 45000))) };
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
        if (!string.IsNullOrWhiteSpace(apiKey))
        {
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey.Trim());
        }

        var body = new JsonObject
        {
            ["model"] = string.IsNullOrWhiteSpace(model) ? "default" : model,
            ["stream"] = false,
            ["temperature"] = 0,
            ["max_tokens"] = 96,
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = "Return a structured tool call when a tool is needed. Do not answer in prose." },
                new JsonObject { ["role"] = "user", ["content"] = "Use the probe tool with marker cti-tool-probe." },
            },
            ["tools"] = new JsonArray
            {
                new JsonObject
                {
                    ["type"] = "function",
                    ["function"] = new JsonObject
                    {
                        ["name"] = toolName,
                        ["description"] = "Echo a marker for local tool-call capability probing.",
                        ["parameters"] = new JsonObject
                        {
                            ["type"] = "object",
                            ["required"] = new JsonArray(JsonValue.Create("marker")),
                            ["properties"] = new JsonObject
                            {
                                ["marker"] = new JsonObject
                                {
                                    ["type"] = "string",
                                    ["description"] = "The marker to echo."
                                }
                            }
                        }
                    }
                }
            },
            ["tool_choice"] = "auto",
        };
        request.Content = new StringContent(body.ToJsonString(JsonOptions), Encoding.UTF8, "application/json");

        try
        {
            using var response = await client.SendAsync(request);
            var raw = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
            {
                var failed = WriteLocalToolCapabilityResult(kind, baseUrl, model, "failed", "text_only", $"工具探测请求失败：HTTP {(int)response.StatusCode} {response.ReasonPhrase} | {TrimForStatus(raw)}", endpoint, 0, "", raw);
                return failed;
            }

            using var document = JsonDocument.Parse(raw);
            var (count, names, contentPreview) = ReadToolCallProbeEvidence(document.RootElement);
            var passed = names.Any(name => string.Equals(name, toolName, StringComparison.OrdinalIgnoreCase));
            var state = passed ? "passed" : "text_only";
            var mode = passed ? "agent_verified" : "text_only";
            var message = passed
                ? "本地 API 已返回结构化 tool_calls；可作为受控工具模型候选，仍需运行时执行证据验收。"
                : "本地 API 在线，但没有返回结构化 tool_calls；新路由不会因此自动转官方 Codex。";
            var result = WriteLocalToolCapabilityResult(kind, baseUrl, model, state, mode, message, endpoint, count, string.Join(", ", names), contentPreview);
            return result;
        }
        catch (Exception ex)
        {
            return WriteLocalToolCapabilityResult(kind, baseUrl, model, "failed", "text_only", $"工具探测失败：{ex.Message}", endpoint, 0, "", "");
        }
    }

    private static int ParsePositiveInt(string value, int fallback)
        => int.TryParse((value ?? "").Trim(), out var parsed) && parsed > 0 ? parsed : fallback;

    private static string NormalizeOpenAiCompatibleBaseUrl(string baseUrl, string kind)
    {
        var trimmed = (baseUrl ?? "").Trim().TrimEnd('/');
        if (string.IsNullOrWhiteSpace(trimmed))
        {
            trimmed = kind == "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:8000/v1";
        }
        if (kind == "ollama" && !trimmed.EndsWith("/v1", StringComparison.OrdinalIgnoreCase))
        {
            trimmed += "/v1";
        }
        return trimmed;
    }

    private static (int Count, List<string> Names, string ContentPreview) ReadToolCallProbeEvidence(JsonElement root)
    {
        var names = new List<string>();
        var content = "";
        if (root.TryGetProperty("choices", out var choices) && choices.ValueKind == JsonValueKind.Array && choices.GetArrayLength() > 0)
        {
            var first = choices[0];
            if (first.TryGetProperty("message", out var message))
            {
                if (message.TryGetProperty("content", out var contentElement))
                {
                    content = contentElement.ValueKind == JsonValueKind.String ? contentElement.GetString() ?? "" : contentElement.GetRawText();
                }
                if (message.TryGetProperty("tool_calls", out var toolCalls) && toolCalls.ValueKind == JsonValueKind.Array)
                {
                    foreach (var call in toolCalls.EnumerateArray())
                    {
                        if (call.TryGetProperty("function", out var function)
                            && function.TryGetProperty("name", out var name)
                            && name.ValueKind == JsonValueKind.String
                            && !string.IsNullOrWhiteSpace(name.GetString()))
                        {
                            names.Add(name.GetString()!.Trim());
                        }
                    }
                }
            }
        }
        return (names.Count, names, TrimForStatus(content));
    }

    private object WriteLocalToolCapabilityResult(string kind, string baseUrl, string model, string state, string mode, string message, string endpoint, int toolCallCount, string toolNames, string rawPreview)
    {
        var now = DateTimeOffset.Now.ToString("O");
        Directory.CreateDirectory(Path.GetDirectoryName(_localModelCapabilityPath)!);
        var profile = new JsonObject
        {
            ["schema"] = "codex-im-suite/local-model-capabilities/v1",
            ["updatedAt"] = now,
            ["provider"] = kind,
            ["baseUrl"] = baseUrl,
            ["model"] = model,
            ["toolCallingState"] = state,
            ["recommendedMode"] = mode,
            ["message"] = message,
            ["evidence"] = new JsonObject
            {
                ["endpoint"] = endpoint,
                ["toolCallCount"] = toolCallCount,
                ["toolNames"] = toolNames,
                ["rawContentPreview"] = TrimForStatus(rawPreview),
            },
        };
        File.WriteAllText(_localModelCapabilityPath, profile.ToJsonString(JsonOptions), Encoding.UTF8);

        JsonObject status;
        try
        {
            status = File.Exists(_localLlmStatusPath)
                ? JsonNode.Parse(File.ReadAllText(_localLlmStatusPath, Encoding.UTF8)) as JsonObject ?? new JsonObject()
                : new JsonObject();
        }
        catch
        {
            status = new JsonObject();
        }
        status["toolCallingState"] = state;
        status["toolCallingCheckedAt"] = now;
        status["toolCallingModel"] = model;
        status["toolCallingBaseUrl"] = baseUrl;
        status["toolCallingMessage"] = message;
        status["toolCallingRecommendedMode"] = mode;
        status["updatedAt"] = now;
        Directory.CreateDirectory(Path.GetDirectoryName(_localLlmStatusPath)!);
        File.WriteAllText(_localLlmStatusPath, status.ToJsonString(JsonOptions), Encoding.UTF8);

        return new
        {
            ok = state == "passed",
            state,
            recommendedMode = mode,
            message,
            kind,
            baseUrl,
            model,
            toolCallCount,
            toolNames,
        };
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
            AppendLog($"Ollama 启动脚本不存在：{_localLlmStartScript}");
            return;
        }
        var result = await RunPowerShellFileAsync(_localLlmStartScript, "", _suiteRoot, 120000);
        AppendCommand("启动 Ollama", result);
        await CheckLocalLlmAsync(true);
    }

    private async Task StopLocalLlmAsync()
    {
        if (!File.Exists(_localLlmStopScript))
        {
            AppendLog($"Ollama 停止脚本不存在：{_localLlmStopScript}");
            return;
        }
        var result = await RunPowerShellFileAsync(_localLlmStopScript, "", _suiteRoot, 120000);
        AppendCommand("停止 Ollama", result);
        await CheckLocalLlmAsync(true);
    }

    private void OpenLocalLlmDocs()
    {
        if (File.Exists(_localLlmReadmePath)) OpenPath(_localLlmReadmePath);
    }

    private async Task SetRouterModeAsync(string mode)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_configPath)!);
        var lines = ReadEnvFileLines(_configPath);
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
            $"当前模型来源: {NormalizeCodexModelSource(GetConfig("CTI_CODEX_MODEL_SOURCE", InferCodexModelSource()))}",
            $"当前路由: {CodexRoutingModeToLabel(NormalizeCodexRoutingMode(GetConfig("CTI_CODEX_ROUTING_MODE", "manual")))}",
            $"最近本地模型路由: {status.RouteHits}",
            $"最近升级 Codex: {status.EscalationCount}",
            $"最近本地工具执行: {status.ExecutionCount}",
            $"最近执行失败: {status.ExecutionFailures}",
            $"最近本地轻量模型记录: {Math.Max(status.LocalProfileHits, status.LocalOnlyAnswers)}",
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
        lines.Add("最近本地工具执行摘要:");
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
            Text = "本地模型路由",
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
        OpenMcpPath(manifest);
    }

    private void OpenMcpPath(McpManifest manifest)
    {
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
        await StartMcpAsync(manifest);
    }

    private async Task StartMcpAsync(McpManifest manifest)
    {
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
        await StopMcpAsync(manifest);
    }

    private async Task StopMcpAsync(McpManifest manifest)
    {
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
        await CheckMcpAsync(manifest, appendLog: true);
    }

    private async Task CheckMcpAsync(McpManifest manifest, bool appendLog = false)
    {
        await RefreshSelectedMcpRuntimeStatusAsync(manifest, appendLog);
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
            if (url.EndsWith("/mcp", StringComparison.OrdinalIgnoreCase))
            {
                return await McpHttpHealthChecks.RunGenericAsync(url);
            }
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

        if (kind == "mcp-http-resource")
        {
            var url = ExpandManifestValue(manifest.HealthCheck.Url);
            if (string.IsNullOrWhiteSpace(url)) return (false, "healthCheck.url 为空");
            var resourceUri = manifest.HealthCheck.ResourceUri ?? "";
            if (string.IsNullOrWhiteSpace(resourceUri)) return (false, "healthCheck.resourceUri 为空");
            return await McpHttpHealthChecks.RunResourceAsync(
                url,
                resourceUri,
                manifest.HealthCheck.SuccessRegex,
                manifest.HealthCheck.FailureRegex);
        }

        if (kind == "codex-mcp-list")
        {
            var name = !string.IsNullOrWhiteSpace(manifest.RegisterName) ? manifest.RegisterName! : manifest.Id ?? "";
            var result = await RunProcessAsync("powershell.exe", "-NoLogo -NoProfile -Command \"codex mcp list\"", _skillDir);
            var found = result.ExitCode == 0 && Regex.IsMatch(result.Stdout, $"(?m)^{Regex.Escape(name)}\\s");
            return found
                ? (true, $"已注册到 Codex，未运行握手检查: {name}")
                : (false, $"未在 Codex MCP 列表中发现: {name}");
        }

        return (false, $"未知 healthCheck.kind: {manifest.HealthCheck.Kind}");
    }

    private static string TrimForStatus(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return "";
        var normalized = Regex.Replace(text, "\\s+", " ").Trim();
        return normalized.Length > 260 ? normalized[..260] + "..." : normalized;
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

    private async Task PublishSuiteAsync(bool requireConfirmation = true)
    {
        if (string.IsNullOrWhiteSpace(_publishBackupScript) || !File.Exists(_publishBackupScript))
        {
            throw new InvalidOperationException("未找到 publish-backup.ps1。");
        }

        var preflight = await ValidatePowerShellScriptAsync(_publishBackupScript);
        if (!preflight.Success)
        {
            AppendLog($"发布前语法预检失败：{preflight.Message}");
            if (requireConfirmation)
            {
                MessageBox.Show(
                    this,
                    $"发布前语法预检失败，已阻止继续发布。\n\n{preflight.Message}",
                    "发布预检失败",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
            throw new InvalidOperationException($"发布前语法预检失败：{preflight.Message}");
        }
        AppendLog("发布前语法预检通过：PARSE_OK");

        if (requireConfirmation)
        {
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
        }

        var publishEnvironment = new Dictionary<string, string?>();
        var runningPanelPath = Environment.ProcessPath;
        var defaultPanelOutputDir = Path.Combine(_suiteRoot, "release", "artifacts", "control-panel");
        if (!string.IsNullOrWhiteSpace(runningPanelPath)
            && IsSameOrChildPath(runningPanelPath, defaultPanelOutputDir))
        {
            publishEnvironment["CTI_RELEASE_CONTROL_PANEL_DIR"] = Path.Combine(_suiteRoot, "release", "artifacts", "control-panel-publish");
        }

        var result = await RunPowerShellFileAsync(_publishBackupScript, "", _suiteRoot, 900000, publishEnvironment.Count > 0 ? publishEnvironment : null);
        AppendCommand("本机备份发布", result);
        await RefreshBuildInfoAsync();
        if (result.ExitCode != 0)
        {
            var error = string.IsNullOrWhiteSpace(result.Stderr) ? result.Stdout : result.Stderr;
            throw new InvalidOperationException($"一键发布失败 exit={result.ExitCode}: {TrimForStatus(error)}");
        }
    }

    private async Task PrepareMainReleaseAsync(bool requireConfirmation = true)
    {
        if (string.IsNullOrWhiteSpace(_mainReleaseScript) || !File.Exists(_mainReleaseScript))
        {
            throw new InvalidOperationException("未找到 prepare-main-release.ps1。");
        }

        var preflight = await ValidatePowerShellScriptAsync(_mainReleaseScript);
        if (!preflight.Success)
        {
            AppendLog($"主干发布预检脚本语法失败：{preflight.Message}");
            if (requireConfirmation)
            {
                MessageBox.Show(
                    this,
                    $"主干发布预检脚本语法失败，已阻止继续执行。\n\n{preflight.Message}",
                    "主干发布预检失败",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
            throw new InvalidOperationException($"主干发布预检脚本语法失败：{preflight.Message}");
        }

        if (requireConfirmation)
        {
            var confirm = MessageBox.Show(
                this,
                "将执行主干发布预检：扩展协议校验、架构文档检查、构建、打包和发布摘要生成。\n\n不会同步 live skill，不会自动 git commit、push 或打标签。\n\n如果目标发布目录、portable 或 installer 里的 exe 正在运行，脚本会自动关闭这些目标目录内的进程后继续。",
                "主干发布预检",
                MessageBoxButtons.OKCancel,
                MessageBoxIcon.Information);
            if (confirm != DialogResult.OK)
            {
                AppendLog("已取消主干发布预检。");
                return;
            }
        }

        var result = await RunPowerShellFileAsync(_mainReleaseScript, "", _suiteRoot, 900000);
        AppendCommand("主干发布预检", result);
        await RefreshBuildInfoAsync();
        if (result.ExitCode != 0)
        {
            var error = string.IsNullOrWhiteSpace(result.Stderr) ? result.Stdout : result.Stderr;
            throw new InvalidOperationException($"主干发布预检失败 exit={result.ExitCode}: {TrimForStatus(error)}");
        }
    }

    private async Task<WebLiveSyncStatus> SyncLiveSkillAsync()
    {
        if (string.IsNullOrWhiteSpace(_syncLiveSkillScript) || !File.Exists(_syncLiveSkillScript))
        {
            throw new InvalidOperationException("未找到 sync-live-skill.ps1。");
        }

        var preflight = await ValidatePowerShellScriptAsync(_syncLiveSkillScript);
        if (!preflight.Success)
        {
            AppendLog($"live 同步脚本语法失败：{preflight.Message}");
            throw new InvalidOperationException($"live 同步脚本语法失败：{preflight.Message}");
        }

        var result = await RunPowerShellFileAsync(_syncLiveSkillScript, "", _suiteRoot, 900000);
        AppendCommand("同步 live skill", result);
        await RefreshBuildInfoAsync();
        if (result.ExitCode != 0)
        {
            var error = string.IsNullOrWhiteSpace(result.Stderr) ? result.Stdout : result.Stderr;
            throw new InvalidOperationException($"同步 live skill 失败 exit={result.ExitCode}: {TrimForStatus(error, 240)}");
        }

        AddWebActivity("success", "Live 同步完成", "已执行开发版 suite -> live skill 同步；未提交、推送、打包或重启 bridge。");
        var commit = !string.IsNullOrWhiteSpace(_suiteRoot) ? await RunGitTextAsync("rev-parse --short HEAD") : "unknown";
        return BuildLiveSyncStatus(commit);
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
        builder.AppendLine("如果目标发布目录、live skill、portable 或 installer 里的 exe 正在运行，脚本会自动关闭这些目标目录内的进程后继续。");
        builder.AppendLine("若当前面板窗口来自被更新目录，窗口可能在更新过程中关闭。");
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
            "5. 本机备份发布会用开发版生成 live skill、构建并推送当前分支；主干发布预检只验证和打包，不会自动同步 live 或推送。发布或同步时若目标目录内 exe 正在运行，会自动关闭后继续。",
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
            feishuHistoryIndex.TryGetValue(chatId, out var historyRecord);
            var remoteMessageCount = Math.Max(0, historyRecord?.MessageCount ?? 0);
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
                LastUpdatedAt = ConversationHistoryDisplay.MaxDateTime(ParseDateTime(pair.Value?.LastMessageAt), ParseDateTime(pair.Value?.UpdatedAt), ConversationHistoryDisplay.ResolveRemoteLatestAt(historyRecord)),
                Summary = "仅本地会话索引",
                Messages = [],
                Source = "仅本地索引",
                HasLocalBinding = false,
                LocalMessageCount = 0,
                RemoteMessageCount = remoteMessageCount,
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
        var feishuHistoryIndex = LoadFeishuHistoryIndex();

        var merged = new List<ConversationEntry>();
        var visibleRemoteChatIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var remoteChats = await FetchFeishuRemoteChatsAsync();
            var remoteChatIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var chat in remoteChats)
            {
                if (string.IsNullOrWhiteSpace(chat.ChatId)) continue;
                remoteChatIds.Add(chat.ChatId);
                visibleRemoteChatIds.Add(chat.ChatId);
                localByChatId.TryGetValue(chat.ChatId, out var local);
                feishuHistoryIndex.TryGetValue(chat.ChatId, out var historyRecord);
                var remoteMessageCount = Math.Max(local?.RemoteMessageCount ?? 0, Math.Max(0, historyRecord?.MessageCount ?? 0));
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
                    LastUpdatedAt = ConversationHistoryDisplay.MaxDateTime(chat.LastUpdatedAt, local?.LastUpdatedAt, ConversationHistoryDisplay.ResolveRemoteLatestAt(historyRecord)),
                    Summary = local?.Summary ?? "远端飞书会话",
                    Messages = local?.Messages ?? [],
                    Source = local is null ? "远端" : "远端 + 本地绑定",
                    HasLocalBinding = local is not null,
                    LocalMessageCount = local?.Messages.Count ?? 0,
                    RemoteMessageCount = remoteMessageCount,
                    RemoteLoaded = false,
                });
            }

            foreach (var local in localEntries)
            {
                feishuHistoryIndex.TryGetValue(local.ChatId, out var historyRecord);
                local.RemoteMessageCount = Math.Max(local.RemoteMessageCount, Math.Max(0, historyRecord?.MessageCount ?? 0));
                local.LastUpdatedAt = ConversationHistoryDisplay.MaxDateTime(local.LastUpdatedAt, ConversationHistoryDisplay.ResolveRemoteLatestAt(historyRecord));
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

        foreach (var entry in merged)
        {
            var isFeishu = string.Equals(entry.ChannelType, "feishu", StringComparison.OrdinalIgnoreCase);
            if (isFeishu && !string.IsNullOrWhiteSpace(entry.ChatId))
            {
                feishuHistoryIndex.TryGetValue(entry.ChatId, out var historyRecord);
                entry.RemoteMessageCount = Math.Max(entry.RemoteMessageCount, Math.Max(0, historyRecord?.MessageCount ?? 0));
                entry.LastUpdatedAt = ConversationHistoryDisplay.MaxDateTime(entry.LastUpdatedAt, ConversationHistoryDisplay.ResolveRemoteLatestAt(historyRecord));
            }
            entry.Source = ConversationHistoryDisplay.ResolveSource(isFeishu, visibleRemoteChatIds.Contains(entry.ChatId), entry.HasLocalBinding, entry.RemoteMessageCount);
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
        feishuHistoryIndex.TryGetValue(chatId, out var historyRecord);
        var remoteMessageCount = Math.Max(0, historyRecord?.MessageCount ?? 0);
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
            LastUpdatedAt = ConversationHistoryDisplay.MaxDateTime(ParseDateTime(binding?.UpdatedAt), ReadMessageFileTimestamp(sessionId), ConversationHistoryDisplay.ResolveRemoteLatestAt(historyRecord)),
            Summary = BuildConversationSummary(messages),
            Messages = messages,
            Source = "仅本地",
            HasLocalBinding = !string.IsNullOrWhiteSpace(bindingKey),
            LocalMessageCount = messages.Count,
            RemoteMessageCount = remoteMessageCount,
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
        entry.RemoteMessageCount = Math.Max(entry.RemoteMessageCount, rawMessages.Count);
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
        var gateway = CreateLarkCliGateway();
        var entries = new List<ConversationEntry>();
        string? pageToken = null;

        while (true)
        {
            var page = await gateway.ListChatsAsync(50, pageToken, _ctiHome);
            foreach (var item in page.Items)
            {
                if (string.IsNullOrWhiteSpace(item.ChatId)) continue;
                entries.Add(new ConversationEntry
                {
                    ChannelType = "feishu",
                    ChatId = item.ChatId,
                    ChatType = item.ChatMode,
                    DisplayName = string.IsNullOrWhiteSpace(item.Name) ? item.ChatId : item.Name,
                });
            }
            pageToken = page.PageToken;
            if (!page.HasMore || string.IsNullOrWhiteSpace(pageToken)) break;
        }

        return entries;
    }

    private async Task<LarkCliPage<FeishuIndexedMessageRecord>> FetchFeishuRemoteMessagesAsync(string chatId, int limit, string? pageToken = null)
    {
        var page = await CreateLarkCliGateway().ListMessagesAsync(chatId, limit, pageToken, _ctiHome);
        var result = new List<FeishuIndexedMessageRecord>();
        foreach (var item in page.Items)
        {
            if (item.Deleted) continue;
            if (string.Equals(item.MessageType, "system", StringComparison.OrdinalIgnoreCase)) continue;
            var msgType = item.MessageType;
            var rawContent = item.Content;
            var itemRaw = JsonSerializer.Serialize(new
            {
                message_id = item.MessageId,
                chat_id = item.ChatId,
                create_time = item.CreateTime,
                msg_type = msgType,
                content = rawContent,
                sender = new
                {
                    id = item.SenderId,
                    id_type = item.SenderIdType,
                    name = item.SenderName,
                    sender_type = item.SenderType,
                },
            }, WebJsonOptions);
            var indexedRawContent = ResolveFeishuIndexedRawContent(msgType, rawContent, itemRaw);
            var hasDirectResource = IsDirectFeishuResourceMessage(msgType);
            var resourceKey = hasDirectResource ? ExtractFeishuResourceKey(rawContent) : "";
            if (hasDirectResource && string.IsNullOrWhiteSpace(resourceKey)) resourceKey = ExtractFeishuResourceKey(itemRaw);
            var fileName = hasDirectResource ? ExtractFeishuFileName(rawContent) : "";
            if (hasDirectResource && string.IsNullOrWhiteSpace(fileName)) fileName = ExtractFeishuFileName(itemRaw);
            result.Add(new FeishuIndexedMessageRecord
            {
                MessageId = item.MessageId,
                ChatId = string.IsNullOrWhiteSpace(item.ChatId) ? chatId : item.ChatId,
                CreateTime = item.CreateTime,
                MsgType = msgType,
                SenderId = item.SenderId,
                SenderType = item.SenderType,
                SenderName = item.SenderName,
                Text = ExtractFeishuMessageText(msgType, rawContent),
                RawContent = indexedRawContent,
                ResourceKey = resourceKey,
                ResourceType = ResolveFeishuResourceType(msgType),
                FileName = fileName,
            });
        }
        return page.WithItems<FeishuIndexedMessageRecord>(result);
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

            foreach (var item in page.Items)
            {
                if (!string.IsNullOrWhiteSpace(item.SenderId) && speakerNames.TryGetValue(item.SenderId, out var speakerName))
                {
                    item.SenderName = speakerName;
                }
                merged[item.MessageId] = item;
            }

            if (!full && page.Items.Count > 0)
            {
                var hasNewer = page.Items.Any(item => long.TryParse(item.CreateTime, out var parsed) && parsed > latestKnown);
                if (!hasNewer) break;
            }

            if (!page.HasMore || string.IsNullOrWhiteSpace(page.PageToken)) break;
            pageToken = page.PageToken;
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
        var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var memberPage = await CreateLarkCliGateway().ListMembersAsync(chatId, _ctiHome);
        if (memberPage.Truncated)
        {
            AppendLog($"警告：飞书群成员列表被平台安全策略截断：{chatId}；当前仅使用官方 CLI 返回的可见成员。");
        }
        foreach (var member in memberPage.Items)
        {
            if (!string.IsNullOrWhiteSpace(member.MemberId) && !string.IsNullOrWhiteSpace(member.Name))
            {
                names[member.MemberId] = member.Name;
            }
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
        return ConversationHistoryDisplay.IsFeishuCardCompatibilityPlaceholderOnly(text)
            || ConversationHistoryDisplay.ContainsFeishuCardCompatibilityPlaceholder(text);
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
                if (ConversationHistoryDisplay.IsFeishuCardCompatibilityPlaceholderOnly(summary)) continue;
                if (ConversationHistoryDisplay.ContainsFeishuCardCompatibilityPlaceholder(summary))
                {
                    summary = ConversationHistoryDisplay.RemoveFeishuCardCompatibilityPlaceholder(summary);
                    if (string.IsNullOrWhiteSpace(summary)) continue;
                }
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
        return selected.Select((item, index) =>
        {
            var display = ConversationHistoryDisplay.ResolveMessageDisplay(item.MsgType, item.RawContent, item.Text);
            return new ConversationMessageView
            {
                Index = index + 1,
                MessageId = item.MessageId,
                Role = string.Equals(item.SenderType, "app", StringComparison.OrdinalIgnoreCase) ? "assistant" : "user",
                MsgType = item.MsgType,
                SenderId = item.SenderId ?? "",
                SenderType = item.SenderType ?? "",
                SenderName = item.SenderName ?? "",
                CreatedAt = ParseUnixMsOrIso(item.CreateTime),
                Content = NormalizeDisplayText($"{(string.IsNullOrWhiteSpace(item.SenderName) ? item.SenderId : item.SenderName)}: {display.Text}"),
                CardContent = NormalizeDisplayText(display.CardContent),
                RawContentPreview = display.RawContentPreview,
                Attachments = BuildFeishuAttachmentPlaceholders(item),
            };
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
            var display = ConversationHistoryDisplay.ResolveMessageDisplay(item.MsgType, item.RawContent, item.Text);
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
                Content = NormalizeDisplayText($"{(string.IsNullOrWhiteSpace(item.SenderName) ? item.SenderId : item.SenderName)}: {display.Text}"),
                CardContent = NormalizeDisplayText(display.CardContent),
                RawContentPreview = display.RawContentPreview,
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
        var attachments = new List<ConversationAttachmentView>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void AddPlaceholder(string kind, string resourceKey, string name)
        {
            if (string.IsNullOrWhiteSpace(resourceKey)) return;
            var normalizedKind = string.Equals(kind, "image", StringComparison.OrdinalIgnoreCase) ? "image" : "file";
            var effectiveName = !string.IsNullOrWhiteSpace(name)
                ? name
                : $"{resourceKey}.{(normalizedKind == "image" ? "png" : "bin")}";
            if (!seen.Add($"{normalizedKind}:{resourceKey}")) return;
            attachments.Add(new ConversationAttachmentView(normalizedKind, effectiveName, GuessMimeType(effectiveName), 0, "", "", resourceKey, "未下载"));
        }

        if (IsDirectFeishuResourceMessage(item.MsgType))
        {
            var kind = string.Equals(item.ResourceType, "image", StringComparison.OrdinalIgnoreCase) ? "image" : "file";
            var name = !string.IsNullOrWhiteSpace(item.FileName)
                ? item.FileName!
                : $"{item.ResourceKey}.{(kind == "image" ? "png" : "bin")}";
            AddPlaceholder(kind, item.ResourceKey, name);
        }

        foreach (var reference in ConversationHistoryDisplay.ResolveCardResourceReferences(item.MsgType, item.RawContent))
        {
            AddPlaceholder(reference.Kind, reference.ResourceKey, reference.Name);
        }

        return attachments;
    }

    private async Task<List<ConversationAttachmentView>> BuildFeishuAttachmentsAsync(FeishuIndexedMessageRecord item, bool allowDownload)
    {
        var placeholders = BuildFeishuAttachmentPlaceholders(item);
        if (placeholders.Count == 0) return [];
        var result = new List<ConversationAttachmentView>();
        foreach (var placeholder in placeholders)
        {
            var resourceType = string.Equals(placeholder.Kind, "image", StringComparison.OrdinalIgnoreCase) ? "image" : "file";
            var cached = TryGetCachedFeishuResource(item.MessageId, placeholder.ResourceKey, resourceType, placeholder.Name);
            if (cached is not null)
            {
                result.Add(cached);
                continue;
            }
            if (!allowDownload)
            {
                result.Add(placeholder with { Status = "未下载，点击刷新详情会优先加载最近附件" });
                continue;
            }
            var downloaded = await TryDownloadFeishuResourceAsync(item.MessageId, placeholder.ResourceKey, resourceType, placeholder.Name);
            result.Add(downloaded ?? placeholder with { Status = "下载失败或无权限" });
        }
        return result;
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
                var typeParam = string.Equals(resourceType, "image", StringComparison.OrdinalIgnoreCase) ? "image" : "file";
                var outputName = Path.GetFileName(cachePath);
                await CreateLarkCliGateway().DownloadMessageResourceAsync(
                    messageId,
                    resourceKey,
                    typeParam,
                    outputName,
                    _mediaCacheDir);
                if (!File.Exists(cachePath) || new FileInfo(cachePath).Length is <= 0 or > 104_857_600) return null;
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

    private static string ResolveFeishuIndexedRawContent(string msgType, string rawContent, string itemRaw)
    {
        var raw = rawContent?.Trim() ?? "";
        if (!string.Equals((msgType ?? "").Trim(), "interactive", StringComparison.OrdinalIgnoreCase))
        {
            return raw;
        }

        var parsedRaw = string.IsNullOrWhiteSpace(raw) ? "" : ParseFeishuInteractiveContent(raw);
        if (!ConversationHistoryDisplay.IsFeishuCardCompatibilityPlaceholderOnly(parsedRaw))
        {
            return raw;
        }

        // 兼容飞书历史接口只把 body.content 返回为“请升级...”的情况；保留整条 item 供面板继续解析附件、image_key 或摘要。
        return string.IsNullOrWhiteSpace(itemRaw) ? raw : itemRaw;
    }

    private static string ExtractFeishuMessageText(JsonElement item)
    {
        var msgType = GetJsonString(item, "msg_type") ?? "";
        if (!item.TryGetProperty("body", out var body) || body.ValueKind != JsonValueKind.Object)
        {
            return $"[{msgType}]";
        }

        var content = ExtractFeishuBodyContentRaw(item);
        return ExtractFeishuMessageText(msgType, content);
    }

    private static string ExtractFeishuMessageText(string msgType, string content)
    {
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
            var cleaned = ConversationHistoryDisplay.RemoveFeishuCardCompatibilityPlaceholder(merged);
            return string.IsNullOrWhiteSpace(cleaned) ? "[卡片消息]" : cleaned;
        }
        catch
        {
            var normalized = Regex.Replace(raw, @"\s+", " ").Trim();
            var cleaned = ConversationHistoryDisplay.RemoveFeishuCardCompatibilityPlaceholder(normalized);
            return string.IsNullOrWhiteSpace(cleaned) ? "[卡片消息]" : cleaned;
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
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        while (reader.ReadLine() is { } rawLine)
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith("#")) continue;
            var index = line.IndexOf('=');
            if (index <= 0) continue;
            values[line[..index].Trim()] = line[(index + 1)..].Trim();
        }
        return values;
    }

    private static List<string> ReadEnvFileLines(string path)
    {
        if (!File.Exists(path)) return [];
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        var lines = new List<string>();
        while (reader.ReadLine() is { } line) lines.Add(line);
        return lines;
    }

    private static string ReadUtf8TextShared(string path)
    {
        const int maxAttempts = 6;
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
                return reader.ReadToEnd();
            }
            catch (IOException) when (attempt < maxAttempts)
            {
                Thread.Sleep(40 * attempt);
            }
        }
    }

    private static void WriteUtf8TextAtomic(string path, string content)
    {
        const int maxAttempts = 6;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tempPath = $"{path}.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(tempPath, content, new UTF8Encoding(false));
            for (var attempt = 1; ; attempt++)
            {
                try
                {
                    if (File.Exists(path))
                    {
                        File.Replace(tempPath, path, null, ignoreMetadataErrors: true);
                    }
                    else
                    {
                        File.Move(tempPath, path);
                    }
                    return;
                }
                catch (IOException) when (attempt < maxAttempts)
                {
                    Thread.Sleep(40 * attempt);
                }
            }
        }
        finally
        {
            try
            {
                if (File.Exists(tempPath)) File.Delete(tempPath);
            }
            catch
            {
                // best effort cleanup
            }
        }
    }

    private SkillLifecycleGateway CreateSkillLifecycleGateway()
    {
        var codexHome = GetConfig(
            "CODEX_HOME",
            Environment.GetEnvironmentVariable("CODEX_HOME")
                ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex"));
        return new SkillLifecycleGateway(
            _suiteRoot,
            _skillDir,
            _ctiHome,
            codexHome,
            nodeExecutable: GetConfig("CTI_NODE_EXE", "node"));
    }

    private async Task<JsonElement> RunSkillLifecycleCommandAsync(string cliCommand, JsonElement payload, bool includePanelActor)
    {
        var input = BuildSkillLifecycleInput(payload, includePanelActor);
        using var document = await CreateSkillLifecycleGateway().RunAsync(cliCommand, input);
        return document.RootElement.Clone();
    }

    private JsonObject BuildSkillLifecycleInput(JsonElement payload, bool includePanelActor)
    {
        JsonObject input;
        if (payload.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
        {
            input = new JsonObject();
        }
        else if (payload.ValueKind == JsonValueKind.Object)
        {
            input = JsonNode.Parse(payload.GetRawText()) as JsonObject ?? new JsonObject();
        }
        else
        {
            throw new InvalidOperationException("Skill lifecycle 命令 payload 必须是 JSON 对象。");
        }

        if (includePanelActor)
        {
            // 面板 actor 由受控宿主生成，不能信任浏览器 payload 自报身份。
            input["actor"] = new JsonObject
            {
                ["channelType"] = "control_panel",
                ["chatId"] = "control-panel",
                ["userId"] = GetConfig("CTI_CONTROL_PANEL_ACTOR_ID", "control-panel"),
            };
        }
        return input;
    }

    private async Task<WebSkillGovernanceState> BuildSkillGovernanceStateAsync()
    {
        try
        {
            using var document = await CreateSkillLifecycleGateway().ReadSnapshotAsync();
            return new WebSkillGovernanceState(true, "", document.RootElement.Clone());
        }
        catch (Exception error)
        {
            return new WebSkillGovernanceState(false, TrimForSummary(error.Message, 800), null);
        }
    }

    private object BuildPromptSnapshotState()
    {
        var snapshotPath = Path.Combine(_ctiHome, "runtime", "prompt-snapshots.json");
        if (!File.Exists(snapshotPath))
        {
            return new
            {
                available = false,
                path = snapshotPath,
                error = "尚未生成 Prompt Snapshot。",
                data = new
                {
                    protocol = "cti-prompt-snapshot-store/v1",
                    policy = new { maxItems = 100, maxAgeDays = 7 },
                    snapshots = Array.Empty<object>(),
                },
            };
        }

        try
        {
            using var stream = new FileStream(snapshotPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var document = JsonDocument.Parse(stream);
            return new
            {
                available = true,
                path = snapshotPath,
                error = "",
                data = document.RootElement.Clone(),
            };
        }
        catch (Exception error)
        {
            return new
            {
                available = false,
                path = snapshotPath,
                error = $"Prompt Snapshot 读取失败：{TrimForSummary(error.Message, 600)}",
                data = (JsonElement?)null,
            };
        }
    }

    private bool TryGetSkillManifestItem(string manifestPath, out WebExtensionItem item)
    {
        item = BuildExtensionItems().FirstOrDefault(candidate =>
            string.Equals(candidate.ManifestPath, manifestPath, StringComparison.OrdinalIgnoreCase)
            && (string.Equals(candidate.ManifestKind, "skill", StringComparison.OrdinalIgnoreCase)
                || string.Equals(candidate.Type, "skill", StringComparison.OrdinalIgnoreCase)))!;
        return item is not null;
    }

    private async Task<JsonElement> PrepareSkillManifestInstallAsync(WebExtensionItem item)
    {
        var risk = "low";
        try
        {
            var manifest = LoadManifestNode(item.ManifestPath);
            var declaredRisk = manifest["risk"]?.GetValue<string?>()?.Trim().ToLowerInvariant();
            if (declaredRisk is "low" or "medium" or "high") risk = declaredRisk;
        }
        catch
        {
            // Registry/lifecycle 仍会按真实来源重新判定；这里只保留兼容 manifest 的低风险默认输入。
        }
        var payload = JsonSerializer.SerializeToElement(new
        {
            id = item.Id,
            sourceClass = "unknown",
            source = ExpandManifestValue(item.Source),
            risk,
            changeKind = "install",
        });
        return await RunSkillLifecycleCommandAsync("prepare-install", payload, includePanelActor: true);
    }

    private LarkCliGateway CreateLarkCliGateway()
        => new(GetConfig("CTI_FEISHUCLI_PROFILE", ""), ExecuteLarkCliCommandAsync);

    private async Task<LarkCliExecutionResult> ExecuteLarkCliCommandAsync(
        IReadOnlyList<string> arguments,
        string workingDirectory,
        int timeoutMs)
    {
        var commandPath = ResolveLarkCliCommandPath();
        // 所有参数均作为 PowerShell 单引号字面量传递，避免消息正文、群名或路径被二次解释。
        var trailingArgs = string.Join(" ", arguments.Select(QuotePowerShellLiteral));
        var result = await RunPowerShellFileAsync(
            commandPath,
            trailingArgs,
            string.IsNullOrWhiteSpace(workingDirectory) ? _ctiHome : workingDirectory,
            timeoutMs);
        return new LarkCliExecutionResult(result.ExitCode, result.Stdout, result.Stderr);
    }

    private string ResolveLarkCliCommandPath()
    {
        var configured = GetConfig("CTI_FEISHUCLI_PATH", "").Trim();
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured;
        }

        var npmRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm");
        foreach (var candidate in new[] { "lark-cli.ps1", "lark-cli.cmd", "lark-cli" })
        {
            var path = Path.Combine(npmRoot, candidate);
            if (File.Exists(path)) return path;
        }
        return "lark-cli";
    }

    private static async Task<ProcessResult> RunPowerShellFileAsync(string scriptPath, string trailingArgs, string workingDirectory, int timeoutMs, Dictionary<string, string?>? environment = null)
    {
        var command = new StringBuilder();
        command.Append("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ");
        command.Append("$OutputEncoding = [Console]::OutputEncoding; ");
        command.Append("$ProgressPreference = 'SilentlyContinue'; ");
        command.Append("$InformationPreference = 'Continue'; ");
        command.Append("& ").Append(QuotePowerShellLiteral(scriptPath));
        if (!string.IsNullOrWhiteSpace(trailingArgs)) command.Append(' ').Append(trailingArgs);
        command.Append(" 6>&1");
        command.Append("; if ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }");
        var encodedCommand = Convert.ToBase64String(Encoding.Unicode.GetBytes(command.ToString()));
        var arguments = $"-NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand {encodedCommand}";
        return await RunProcessAsync("powershell.exe", arguments, workingDirectory, environment, timeoutMs);
    }

    private static string QuotePowerShellLiteral(string value)
        => "'" + value.Replace("'", "''") + "'";

    private static async Task<ProcessResult> RunProcessAsync(string fileName, string arguments, string workingDirectory, Dictionary<string, string?>? environment = null, int timeoutMs = 30000)
    {
        using var process = new Process();
        var outputEncoding = fileName.EndsWith("powershell.exe", StringComparison.OrdinalIgnoreCase) ? new UTF8Encoding(false) : Encoding.UTF8;
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
            return new ProcessResult(-1, NormalizeProcessOutput(stdout.ToString()), NormalizeProcessOutput(stderr + $"Timeout after {timeoutMs} ms."));
        }
        return new ProcessResult(process.ExitCode, NormalizeProcessOutput(stdout.ToString()), NormalizeProcessOutput(stderr.ToString()));
    }

    private static string NormalizeProcessOutput(string text)
    {
        if (string.IsNullOrWhiteSpace(text) || !text.Contains("#< CLIXML", StringComparison.OrdinalIgnoreCase))
        {
            return text;
        }

        var marker = text.IndexOf("#< CLIXML", StringComparison.OrdinalIgnoreCase);
        var prefix = marker > 0 ? text[..marker].Trim() : "";
        var xmlStart = text.IndexOf("<Objs", marker, StringComparison.OrdinalIgnoreCase);
        if (xmlStart < 0)
        {
            return string.IsNullOrWhiteSpace(prefix) ? StripCliXmlMarker(text) : prefix;
        }

        var decoded = DecodePowerShellCliXml(text[xmlStart..]);
        var parts = new[] { prefix, decoded }
            .Where(part => !string.IsNullOrWhiteSpace(part))
            .Select(part => part.Trim());
        return string.Join(Environment.NewLine, parts);
    }

    private static string StripCliXmlMarker(string text)
        => text.Replace("#< CLIXML", "", StringComparison.OrdinalIgnoreCase).Trim();

    private static string DecodePowerShellCliXml(string xml)
    {
        try
        {
            var document = XDocument.Parse(xml.Trim(), LoadOptions.None);
            var lines = new List<string>();
            foreach (var value in document.Descendants().Where(element => element.Name.LocalName == "ToString").Select(element => element.Value))
            {
                AddCliXmlLine(lines, value);
            }
            if (lines.Count == 0)
            {
                foreach (var value in document.Descendants().Where(element => element.Name.LocalName == "S").Select(element => element.Value))
                {
                    AddCliXmlLine(lines, value);
                }
            }
            return string.Join(Environment.NewLine, lines);
        }
        catch
        {
            return StripCliXmlMarker(xml);
        }
    }

    private static void AddCliXmlLine(List<string> lines, string value)
    {
        var decoded = DecodeCliXmlEscapes(value).Trim();
        if (string.IsNullOrWhiteSpace(decoded)) return;
        if (!lines.Contains(decoded, StringComparer.Ordinal)) lines.Add(decoded);
    }

    private static string DecodeCliXmlEscapes(string value)
        => Regex.Replace(value, "_x([0-9A-Fa-f]{4})_", match => ((char)Convert.ToInt32(match.Groups[1].Value, 16)).ToString());

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

    private static string LocalAiKindToLabel(string? kind)
        => NormalizeLocalAiKind(kind ?? "ollama") switch
        {
            "lmstudio" => "LM Studio",
            "vllm" => "vLLM / OpenAI-compatible",
            "openai-compatible" => "OpenAI-compatible",
            "custom" => "自定义 OpenAI-compatible",
            _ => "Ollama",
        };

    private static string FormatLastBrainStatus(LocalLlmStatusRecord status)
    {
        var routeLabel = (status.LastRouteLabel ?? "").Trim().ToLowerInvariant();
        if (routeLabel.Length > 0)
        {
            return routeLabel switch
            {
                "codex_primary" => "Codex 主脑",
                "codex_local_fallback" => "本地模型来源",
                "local_explicit_task" => "本地受控执行",
                "local_fallback_no_codex" => "本地模型来源",
                "local_refused_out_of_scope" => "本地拒绝（超范围）",
                _ => "暂无记录",
            };
        }

        var provider = (status.LastProvider ?? "").Trim().ToLowerInvariant();
        return provider switch
        {
            "codex" or "codex_only" => "Codex 主脑",
            "codex_local_fallback" => "本地模型来源",
            "local" => "本地受控执行",
            "local_best_effort" => "本地模型来源",
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
            "codex_local_fallback" => "codex_local_fallback",
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
        => OperatingSystem.IsWindows() ? @"E:\cli-md" : Path.Combine(_ctiHome, "memory-repo");

    private string GetDefaultWorkDirPath()
        => Path.Combine(_ctiHome, "workspace");

    private MemoryArtifactStore GetMemoryArtifactStore()
        => new(ResolveEffectiveMemoryRepoPath(
            GetConfig("CTI_MEMORY_REPO_DIR", GetDefaultMemoryRepoPath()),
            GetConfig("CTI_DEFAULT_WORKDIR", GetDefaultWorkDirPath())));

    private string ResolveEffectiveMemoryRepoPath(string configuredPath, string defaultWorkDir, bool appendLog = false)
    {
        var fallback = Path.GetFullPath(GetDefaultMemoryRepoPath());
        var normalized = string.IsNullOrWhiteSpace(configuredPath) ? fallback : Path.GetFullPath(configuredPath.Trim());
        var blockedRoots = new[] { defaultWorkDir }
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
internal sealed record WebSkillGovernanceState(bool Available, string Error, JsonElement? Snapshot);
internal sealed record WebServiceItem(string Id, string Title, string Status, string Detail);
internal sealed record WebNodeCapability(string Id, string DisplayName, string Category, string Status, string Detail, string Risk);
internal sealed record WebNodeAgent(
    string NodeId,
    string DisplayName,
    string Kind,
    string Status,
    string Version,
    string Host,
    string LastSeenAt,
    WebNodeCapability[] Capabilities,
    string Detail,
    bool IsLocal,
    bool CanManage);
internal sealed record WebNodeSnapshot(string Schema, string GeneratedAt, string ActiveNodeId, WebNodeAgent[] Nodes);
internal sealed record WebLiveSyncStatus(string Status, string LastSyncedAt, string SuiteCommit, string LiveCommit, string Summary, bool CanSync, string Detail, bool LegacyEntryPresent = false, string LegacyEntryPath = "");
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
    bool CanInstall,
    bool CanRemove);

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

internal sealed record WebExtensionCatalogSnapshot(
    string Protocol,
    string RefreshedAt,
    int SourceCount,
    WebExtensionCatalogLayerCounts LayerCounts,
    WebExtensionCatalogItem[] Items);

internal sealed record WebExtensionCatalogLayerCounts(
    int Seed,
    int Dynamic,
    int CustomUrl);

internal sealed record WebExtensionCatalogItem(
    string Id,
    string Type,
    string DisplayName,
    string Version,
    string Category,
    string Description,
    string InstallHandler,
    string? ArtifactUrl,
    string CatalogSource,
    string SourceLayer,
    string SourceName,
    string FetchedAt,
    string RankBasis,
    int RankOrder,
    bool Trusted,
    string TrustReason,
    bool CanInstall,
    bool Installed,
    bool CanRemove,
    string InstalledVersion,
    string InstalledAt,
    string InstallPath);

internal sealed record WebRemoteExtensionPreview(
    string Id,
    string Type,
    string DisplayName,
    string Version,
    string Category,
    string Description,
    string InstallHandler,
    string? ArtifactUrl,
    string SourceUrl,
    bool Trusted,
    string Reason);

internal sealed record WebRemoteInstallResult(
    string Id,
    string Type,
    string DisplayName,
    string Version,
    string InstallPath,
    string ManifestPath,
    string LauncherPath);

internal sealed record WebExtensionInstallJob(
    string JobId,
    string ItemId,
    string Type,
    string DisplayName,
    string Model,
    string InstallPath,
    string Status,
    string Stage,
    string Message,
    int Percent,
    bool CanCancel,
    bool UseAfterInstall,
    int? ExitCode,
    string StartedAt,
    string UpdatedAt,
    string CompletedAt,
    string[] RecentLines);

internal sealed class ExtensionInstallJobState
{
    public string JobId { get; set; } = "";
    public string ItemId { get; set; } = "";
    public string Type { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string Model { get; set; } = "";
    public string InstallPath { get; set; } = "";
    public string Status { get; set; } = "pending";
    public string Stage { get; set; } = "";
    public string Message { get; set; } = "";
    public int Percent { get; set; }
    public bool CanCancel { get; set; }
    public bool UseAfterInstall { get; set; }
    public int? ExitCode { get; set; }
    public string SourceUrl { get; set; } = "";
    public string Version { get; set; } = "";
    public string InstallHandler { get; set; } = "";
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public List<string> RecentLines { get; } = [];
    public CancellationTokenSource Cancellation { get; } = new();
    public Process? Process { get; set; }
}

internal sealed record ExtensionCatalogEntry(
    ExtensionCatalogItem Item,
    string CatalogSource,
    bool Trusted,
    string SourceLayer,
    string SourceName,
    string FetchedAt,
    string RankBasis,
    int RankOrder);
internal sealed record CatalogInstalledManifest(string Id, string Type, string DisplayName, string Version, string ManifestPath);
internal sealed record DynamicCatalogCacheSnapshot(string Protocol, string GeneratedAt, int TopN, string[] Providers, CachedExtensionCatalogEntry[] Items);
internal sealed record CachedExtensionCatalogEntry(
    ExtensionCatalogItem Item,
    string CatalogSource,
    bool Trusted,
    string SourceLayer,
    string SourceName,
    string FetchedAt,
    string RankBasis,
    int RankOrder);

internal sealed class ExtensionCatalogItem
{
    public string Id { get; set; } = "";
    public string Type { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string Version { get; set; } = "";
    public string Category { get; set; } = "";
    public string Description { get; set; } = "";
    public string? Source { get; set; }
    public ExtensionCatalogArtifact? Artifact { get; set; }
    public string? Sha256 { get; set; }
    public string InstallHandler { get; set; } = "";
    public JsonObject? ManifestTemplate { get; set; }
}

internal sealed class ExtensionCatalogArtifact
{
    public string? Url { get; set; }
    public string? Kind { get; set; }
    public string? Model { get; set; }
    public string? PackageName { get; set; }
    public string? Command { get; set; }
}

internal sealed class ExtensionInstallLock
{
    public string Protocol { get; set; } = "extension-install-lock/v1";
    public string UpdatedAt { get; set; } = "";
    public List<InstalledExtensionRecord> Entries { get; set; } = [];
}

internal sealed class InstalledExtensionRecord
{
    public string Id { get; set; } = "";
    public string Type { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string Version { get; set; } = "";
    public string InstallHandler { get; set; } = "";
    public string InstalledAt { get; set; } = "";
    public string SourceUrl { get; set; } = "";
    public string Sha256 { get; set; } = "";
    public string PackagePath { get; set; } = "";
    public string ManifestPath { get; set; } = "";
    public string LauncherPath { get; set; } = "";
    public string Status { get; set; } = "";
}

internal sealed record WebSessionItem(
    string DisplayName,
    string ChannelType,
    string ChatType,
    string ChatId,
    string SessionId,
    string Source,
    int LocalMessageCount,
    int RemoteMessageCount,
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
    int RemoteMessageCount,
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
    string CardContent,
    string RawContentPreview,
    WebMessageAttachment[] Attachments,
    bool CanRecall,
    string RecallStatus,
    string RecallError);
internal sealed record WebFeishuPerson(
    string UserId,
    string SenderType,
    string DisplayName,
    string Role,
    bool IsOwner,
    int MessageCount);
internal sealed record MessageRecallState(bool CanRecall, string RecallStatus, string RecallError);
internal sealed record MessageDisplayState(bool IsCard, string Text, string CardContent, string RawContentPreview);
internal sealed record CardResourceReference(string Kind, string ResourceKey, string Name);
internal sealed class OutboundMessageRefRecord
{
    public string ChannelType { get; set; } = "";
    public string ChatId { get; set; } = "";
    public string CodepilotSessionId { get; set; } = "";
    public string PlatformMessageId { get; set; } = "";
    public string Purpose { get; set; } = "";
    public string MessageKind { get; set; } = "";
    public string CreatedAt { get; set; } = "";
    public string RecalledAt { get; set; } = "";
    public string RecallError { get; set; } = "";
    public string UpdatedAt { get; set; } = "";
}
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

internal sealed record WebRuntimeAction(string Id, string Label, bool Enabled, string Reason = "");
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
    public string? ResourceUri { get; set; }
    public string? SuccessRegex { get; set; }
    public string? FailureRegex { get; set; }
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
    public int LocalProfileHits { get; set; }
    public int LocalOnlyAnswers { get; set; }
    public int LocalRefusals { get; set; }
    public int ExecutionCount { get; set; }
    public int ExecutionFailures { get; set; }
    public int FallbackCount { get; set; }
    public bool? ServerReachable { get; set; }
    public string? ToolCallingState { get; set; }
    public string? ToolCallingCheckedAt { get; set; }
    public string? ToolCallingModel { get; set; }
    public string? ToolCallingBaseUrl { get; set; }
    public string? ToolCallingMessage { get; set; }
    public string? ToolCallingRecommendedMode { get; set; }
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

internal static class ConversationHistoryDisplay
{
    private const string CardBodyUnavailableText = "卡片正文暂不可解析；飞书历史接口未返回完整卡片内容。";
    private static readonly Regex FeishuCardCompatibilityPlaceholderRegex = new(
        @"(?:请升级至(?:最新版本|最新版)客户端[，,]?\s*以查看内容|please\s+upgrade\s+.*?(?:client|app).*?(?:view|see).*?content)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex CardMessagePlaceholderRegex = new(
        @"\[(?:card message|卡片消息|鍗＄墖娑堟伅)\]",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static string ResolveSource(bool isFeishu, bool remoteVisible, bool hasLocalBinding, int remoteMessageCount)
    {
        if (!isFeishu) return "仅本地";
        if (remoteVisible && hasLocalBinding) return "远端 + 本地绑定";
        if (remoteVisible) return "远端";
        if (remoteMessageCount > 0 && hasLocalBinding) return "远端历史 + 本地绑定";
        if (remoteMessageCount > 0) return "远端历史索引";
        return hasLocalBinding ? "仅本地绑定（远端当前不可见）" : "仅本地索引";
    }

    public static DateTime? ResolveRemoteLatestAt(FeishuHistorySyncRecord? record)
        => ParseUnixMsOrIso(record?.LatestMessageTime) ?? ParseUnixMsOrIso(record?.LastSyncAt);

    public static MessageDisplayState ResolveMessageDisplay(string msgType, string rawContent, string fallbackText)
    {
        var normalizedType = (msgType ?? "").Trim();
        var fallback = NormalizeMessageText(fallbackText);
        if (!string.Equals(normalizedType, "interactive", StringComparison.OrdinalIgnoreCase))
        {
            return new MessageDisplayState(false, fallback, "", "");
        }

        var raw = rawContent?.Trim() ?? "";
        var parts = new List<string>();
        var references = new List<string>();
        if (!string.IsNullOrWhiteSpace(raw))
        {
            TryCollectCardDisplayParts(raw, parts, references);
        }

        var cardText = RemoveFeishuCardCompatibilityPlaceholder(
            string.Join(Environment.NewLine + Environment.NewLine, DeduplicateTextParts(parts)));
        var referenceText = NormalizeMessageText(string.Join(Environment.NewLine, references.Select(reference => $"卡片引用: {reference}")));
        var cleanedFallback = RemoveFeishuCardCompatibilityPlaceholder(fallback);
        var fallbackContainsCompatibilityNoise = ContainsFeishuCardCompatibilityPlaceholder(fallback)
            || IsCardPlaceholderText(fallback);
        var effectiveCardText = !string.IsNullOrWhiteSpace(cardText)
            ? cardText
            : !string.IsNullOrWhiteSpace(referenceText)
                ? referenceText
                : cleanedFallback;
        var text = !fallbackContainsCompatibilityNoise && !string.IsNullOrWhiteSpace(fallback)
            ? fallback
            : !string.IsNullOrWhiteSpace(effectiveCardText)
                ? effectiveCardText
                : CardBodyUnavailableText;
        var cardContent = !string.IsNullOrWhiteSpace(effectiveCardText)
            ? effectiveCardText
            : !fallbackContainsCompatibilityNoise && !string.IsNullOrWhiteSpace(fallback)
                ? fallback
                : CardBodyUnavailableText;

        return new MessageDisplayState(
            true,
            text,
            cardContent,
            BuildRawContentPreview(raw));
    }

    public static IReadOnlyList<CardResourceReference> ResolveCardResourceReferences(string msgType, string rawContent)
    {
        if (!string.Equals((msgType ?? "").Trim(), "interactive", StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrWhiteSpace(rawContent))
        {
            return [];
        }

        try
        {
            using var document = JsonDocument.Parse(rawContent);
            var references = new List<CardResourceReference>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            CollectCardResourceReferences(document.RootElement, references, seen);
            return references;
        }
        catch
        {
            return [];
        }
    }

    public static MessageRecallState ResolveRecallState(
        string channelType,
        string chatId,
        string senderType,
        string messageId,
        IEnumerable<OutboundMessageRefRecord> outboundRefs)
        => ResolveRecallState(channelType, chatId, senderType, "", messageId, outboundRefs, []);

    public static MessageRecallState ResolveRecallState(
        string channelType,
        string chatId,
        string senderType,
        string senderId,
        string messageId,
        IEnumerable<OutboundMessageRefRecord> outboundRefs,
        IEnumerable<string>? botAppIds = null)
    {
        if (!string.Equals(channelType, "feishu", StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrWhiteSpace(chatId)
            || !string.Equals(senderType, "app", StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrWhiteSpace(messageId))
        {
            return new MessageRecallState(false, "none", "");
        }
        var match = ResolveRecallTarget(channelType, chatId, senderType, senderId, messageId, "", outboundRefs, botAppIds);
        if (match is null) return new MessageRecallState(false, "none", "");
        if (!string.IsNullOrWhiteSpace(match.RecalledAt)) return new MessageRecallState(false, "recalled", "");
        if (!string.IsNullOrWhiteSpace(match.RecallError)) return new MessageRecallState(true, "failed", match.RecallError);
        return new MessageRecallState(true, "none", "");
    }

    public static OutboundMessageRefRecord? ResolveRecallTarget(
        string channelType,
        string chatId,
        string senderType,
        string senderId,
        string messageId,
        string codepilotSessionId,
        IEnumerable<OutboundMessageRefRecord> outboundRefs,
        IEnumerable<string>? botAppIds = null)
    {
        if (!string.Equals(channelType, "feishu", StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrWhiteSpace(chatId)
            || !string.Equals(senderType, "app", StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrWhiteSpace(messageId))
        {
            return null;
        }

        var match = outboundRefs.FirstOrDefault(item =>
            string.Equals(item.ChannelType, "feishu", StringComparison.OrdinalIgnoreCase)
            && string.Equals(item.ChatId, chatId, StringComparison.OrdinalIgnoreCase)
            && string.Equals(item.PlatformMessageId, messageId, StringComparison.OrdinalIgnoreCase));
        if (match is not null) return match;

        var isCurrentBotApp = botAppIds is not null
            && botAppIds.Any(id => string.Equals(id?.Trim(), senderId?.Trim(), StringComparison.OrdinalIgnoreCase));
        if (!isCurrentBotApp) return null;

        // 旧历史消息可能没有 outbound-refs 记录；只要 senderId 属于当前 bot app，也允许走同一撤回 API。
        return new OutboundMessageRefRecord
        {
            ChannelType = "feishu",
            ChatId = chatId,
            CodepilotSessionId = codepilotSessionId,
            PlatformMessageId = messageId,
            Purpose = "history",
            MessageKind = "history",
        };
    }

    private static void CollectCardResourceReferences(JsonElement element, List<CardResourceReference> references, HashSet<string> seen)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                var fileName = ResolveCardResourceFileName(element);
                foreach (var property in element.EnumerateObject())
                {
                    if (property.Value.ValueKind == JsonValueKind.String)
                    {
                        var value = property.Value.GetString() ?? "";
                        if (IsCardImageResourceProperty(property.Name))
                        {
                            AddCardResourceReference(references, seen, "image", value, "");
                        }
                        else if (IsCardFileResourceProperty(property.Name))
                        {
                            AddCardResourceReference(references, seen, "file", value, fileName);
                        }
                    }
                    CollectCardResourceReferences(property.Value, references, seen);
                }
                break;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                {
                    CollectCardResourceReferences(item, references, seen);
                }
                break;
            case JsonValueKind.String:
                var text = NormalizeMessageText(element.GetString() ?? "");
                if ((text.StartsWith("{", StringComparison.Ordinal) || text.StartsWith("[", StringComparison.Ordinal))
                    && text.Length <= 20000)
                {
                    try
                    {
                        using var nested = JsonDocument.Parse(text);
                        CollectCardResourceReferences(nested.RootElement, references, seen);
                    }
                    catch
                    {
                        // 卡片内容里偶尔会出现普通 Markdown/文本，不是 JSON 时跳过即可。
                    }
                }
                break;
        }
    }

    private static void AddCardResourceReference(
        List<CardResourceReference> references,
        HashSet<string> seen,
        string kind,
        string resourceKey,
        string name)
    {
        var key = (resourceKey ?? "").Trim();
        if (string.IsNullOrWhiteSpace(key)) return;
        var normalizedKind = string.Equals(kind, "image", StringComparison.OrdinalIgnoreCase) ? "image" : "file";
        if (!seen.Add($"{normalizedKind}:{key}")) return;
        references.Add(new CardResourceReference(normalizedKind, key, ResolveCardResourceName(normalizedKind, key, name)));
    }

    private static string ResolveCardResourceName(string kind, string resourceKey, string name)
    {
        var ext = string.Equals(kind, "image", StringComparison.OrdinalIgnoreCase) ? ".png" : ".bin";
        var effectiveName = NormalizeMessageText(name);
        if (string.IsNullOrWhiteSpace(effectiveName))
        {
            effectiveName = $"{resourceKey}{ext}";
        }
        return string.IsNullOrWhiteSpace(Path.GetExtension(effectiveName))
            ? $"{effectiveName}{ext}"
            : effectiveName;
    }

    private static string ResolveCardResourceFileName(JsonElement element)
    {
        foreach (var property in element.EnumerateObject())
        {
            if (property.Value.ValueKind != JsonValueKind.String) continue;
            if (!IsCardFileNameProperty(property.Name)) continue;
            var value = NormalizeMessageText(property.Value.GetString() ?? "");
            if (!string.IsNullOrWhiteSpace(value)) return value;
        }
        return "";
    }

    private static bool IsCardImageResourceProperty(string key)
        => NormalizeCardPropertyName(key) is "image_key" or "imagekey" or "img_key" or "imgkey";

    private static bool IsCardFileResourceProperty(string key)
        => NormalizeCardPropertyName(key) is "file_key" or "filekey";

    private static bool IsCardFileNameProperty(string key)
        => NormalizeCardPropertyName(key) is "file_name" or "filename" or "name";

    private static string NormalizeCardPropertyName(string key)
        => (key ?? "").Trim().ToLowerInvariant();

    private static bool TryCollectCardDisplayParts(string raw, List<string> parts, List<string> references)
    {
        try
        {
            using var document = JsonDocument.Parse(raw);
            CollectCardDisplayParts(document.RootElement, parts, references, parentName: "");
            return true;
        }
        catch
        {
            var fallback = NormalizeMessageText(raw);
            if (!string.IsNullOrWhiteSpace(fallback)) parts.Add(fallback);
            return false;
        }
    }

    private static void CollectCardDisplayParts(JsonElement element, List<string> parts, List<string> references, string parentName)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var property in element.EnumerateObject())
                {
                    CollectCardProperty(property.Name, property.Value, parts, references);
                }
                break;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                {
                    CollectCardDisplayParts(item, parts, references, parentName);
                }
                break;
            case JsonValueKind.String:
                AddCardString(parentName, element.GetString() ?? "", parts, references);
                break;
        }
    }

    private static void CollectCardProperty(string name, JsonElement value, List<string> parts, List<string> references)
    {
        if (value.ValueKind == JsonValueKind.String)
        {
            AddCardString(name, value.GetString() ?? "", parts, references);
            return;
        }

        CollectCardDisplayParts(value, parts, references, name);
    }

    private static void AddCardString(string propertyName, string value, List<string> parts, List<string> references)
    {
        var text = NormalizeMessageText(value);
        if (string.IsNullOrWhiteSpace(text)) return;

        var key = (propertyName ?? "").Trim().ToLowerInvariant();
        if (IsCardReferenceProperty(key))
        {
            references.Add(text);
            return;
        }
        if (!IsCardTextProperty(key)) return;

        // Some Feishu payloads nest card JSON as an escaped string inside content.
        // Parse it opportunistically and avoid showing the JSON envelope as card body.
        if ((text.StartsWith("{", StringComparison.Ordinal) || text.StartsWith("[", StringComparison.Ordinal))
            && text.Length <= 20000)
        {
            var beforeCount = parts.Count + references.Count;
            TryCollectCardDisplayParts(text, parts, references);
            if (parts.Count + references.Count > beforeCount) return;
        }

        parts.Add(text);
    }

    private static bool IsCardTextProperty(string key)
        => key is "content" or "text" or "title" or "subtitle" or "label" or "placeholder" or "summary" or "alt";

    private static bool IsCardReferenceProperty(string key)
        => key is "card_id" or "cardid" or "template_id" or "templateid";

    private static IEnumerable<string> DeduplicateTextParts(IEnumerable<string> parts)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var part in parts)
        {
            var normalized = NormalizeMessageText(part);
            if (string.IsNullOrWhiteSpace(normalized)) continue;
            var comparable = Regex.Replace(normalized, @"\s+", " ").Trim();
            if (seen.Add(comparable)) yield return normalized;
        }
    }

    private static string NormalizeMessageText(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return "";
        var normalized = text.Replace("\r\n", "\n").Replace('\r', '\n');
        normalized = Regex.Replace(normalized, @"[ \t\f\v]+", " ");
        normalized = Regex.Replace(normalized, @"\n{3,}", "\n\n");
        return normalized.Trim();
    }

    public static string RemoveFeishuCardCompatibilityPlaceholder(string text)
    {
        var normalized = NormalizeMessageText(text);
        if (string.IsNullOrWhiteSpace(normalized)) return "";

        // 飞书历史接口对新版交互卡片可能只给客户端兼容占位文案；展示层只清理这类噪声，保留标题/摘要等真实文本。
        var cleaned = FeishuCardCompatibilityPlaceholderRegex.Replace(normalized, " ");
        cleaned = CardMessagePlaceholderRegex.Replace(cleaned, " ");
        cleaned = Regex.Replace(cleaned, @"(^|\n)[ \t，,。；;：:、\-]+", "$1");
        cleaned = Regex.Replace(cleaned, @"[ \t，,。；;：:、\-]+($|\n)", "$1");
        return NormalizeMessageText(cleaned);
    }

    public static bool ContainsFeishuCardCompatibilityPlaceholder(string text)
        => !string.IsNullOrWhiteSpace(text)
            && (FeishuCardCompatibilityPlaceholderRegex.IsMatch(text)
                || CardMessagePlaceholderRegex.IsMatch(text));

    public static bool IsFeishuCardCompatibilityPlaceholderOnly(string text)
    {
        var normalized = NormalizeMessageText(text);
        return string.IsNullOrWhiteSpace(normalized)
            || (ContainsFeishuCardCompatibilityPlaceholder(normalized)
                && string.IsNullOrWhiteSpace(RemoveFeishuCardCompatibilityPlaceholder(normalized)));
    }

    private static bool IsCardPlaceholderText(string text)
    {
        return IsFeishuCardCompatibilityPlaceholderOnly(text);
    }

    private static string BuildRawContentPreview(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "";
        var preview = Regex.Replace(raw, @"\s+", " ").Trim();
        return preview.Length <= 800 ? preview : preview[..797] + "...";
    }

    public static DateTime? MaxDateTime(params DateTime?[] values)
    {
        var max = values
            .Where(value => value.HasValue)
            .Select(value => value!.Value)
            .DefaultIfEmpty(DateTime.MinValue)
            .Max();
        return max == DateTime.MinValue ? null : max;
    }

    private static DateTime? ParseUnixMsOrIso(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var value = raw.Trim();
        if (long.TryParse(value, out var unix))
        {
            try { return DateTimeOffset.FromUnixTimeMilliseconds(unix).LocalDateTime; }
            catch { }
        }
        return DateTimeOffset.TryParse(value, out var parsed) ? parsed.LocalDateTime : null;
    }
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
    public int RemoteMessageCount { get; set; }
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
    public string CardContent { get; set; } = "";
    public string RawContentPreview { get; set; } = "";
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
    string MemoryRepo,
    string AdditionalDirs,
    string ReplyStyleHint,
    string DefaultExecutorId = "",
    string LocalAiKind = "ollama",
    string LocalAiBaseUrl = "http://127.0.0.1:11434",
    string OllamaModelsDir = "",
    string LocalAiModel = "qwen2.5-coder:7b",
    string LocalAiApiKeyAction = "keep",
    string LocalAiApiKeyValue = "",
    string LocalAiApiKeyMasked = "",
    bool LocalAiApiKeySet = false,
    string LocalAiTimeoutMs = "45000",
    string CodexModelSource = "official",
    string CodexRoutingMode = "manual",
    string CodexApiFallbackChain = "local_api,external_api",
    string CodexBaseUrl = "",
    string CodexModel = "",
    bool CodexPassModel = false,
    string CodexReasoningEffort = "low",
    bool MemoryOptimizerEnabled = false,
    string MemoryOptimizerIntervalDays = "7",
    string MemoryOptimizerModelSource = "codex_primary",
    string CodexApiKeyAction = "keep",
    string CodexApiKeyValue = "",
    string CodexApiKeyMasked = "",
    bool CodexApiKeySet = false);

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
    private readonly TextBox _memoryRepo = new();
    private readonly TextBox _additionalDirs = new();
    private readonly ComboBox _replyStylePreset = new();
    private readonly TextBox _replyStyleRequest = new();
    private readonly TextBox _replyStyleHint = new();
    private readonly IReadOnlyDictionary<string, string> _presets;
    private readonly Func<string, Task<string>> _summarizeReplyStyleAsync;
    private readonly Action<SettingsSnapshot> _saveSettings;
    private readonly Action<string> _openPath;
    private string _defaultExecutorId = "";

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
            try
            {
                _saveSettings(ReadSnapshot());
                MessageBox.Show(this, "配置已保存。回复风格将在重启飞书桥接后生效。", "设置", MessageBoxButtons.OK, MessageBoxIcon.Information);
                Close();
            }
            catch (IOException ex)
            {
                MessageBox.Show(this, $"配置文件正在被其他进程占用，暂时无法保存。\n\n{ex.Message}", "设置", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            catch (UnauthorizedAccessException ex)
            {
                MessageBox.Show(this, $"配置文件访问被拒绝，暂时无法保存。\n\n{ex.Message}", "设置", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
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
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 4, Padding = new Padding(8) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 100));
        for (var i = 0; i < 4; i++) layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        group.Controls.Add(layout);

        AddPathRow(layout, 0, "默认工作目录", _workdir, true);
        AddPathRow(layout, 1, "允许仓库根目录", _allowedRoots, false);
        AddPathRow(layout, 2, "聊天记忆仓库", _memoryRepo, true);
        _additionalDirs.ReadOnly = true;
        _additionalDirs.BackColor = SystemColors.Control;
        AddPathRow(layout, 3, "旧附加目录（诊断）", _additionalDirs, false);
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
        _memoryRepo.Text = settings.MemoryRepo;
        _additionalDirs.Text = settings.AdditionalDirs;
        _replyStyleHint.Text = settings.ReplyStyleHint;
        _defaultExecutorId = settings.DefaultExecutorId;
        _replyStylePreset.SelectedItem = ResolveReplyStylePreset(settings.ReplyStyleHint);
    }

    private SettingsSnapshot ReadSnapshot() => new(
        _workdir.Text,
        _allowedRoots.Text,
        _memoryRepo.Text,
        _additionalDirs.Text,
        _replyStyleHint.Text,
        _defaultExecutorId);

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
