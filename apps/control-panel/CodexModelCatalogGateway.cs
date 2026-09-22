using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace ClaudeToImControlPanel;

internal sealed record CodexModelCatalogCliInvocation(
    string FileName,
    IReadOnlyList<string> Arguments,
    string WorkingDirectory,
    IReadOnlyDictionary<string, string?> Environment,
    int TimeoutMs);

internal sealed record CodexModelCatalogCliExecutionResult(int ExitCode, string Stdout, string Stderr);
internal delegate Task<CodexModelCatalogCliExecutionResult> CodexModelCatalogCliCommandExecutor(CodexModelCatalogCliInvocation invocation);

/// <summary>
/// 面板到 Runtime 模型目录 CLI 的只读薄边界。模型发现、鉴权和 endpoint 读取均由 Runtime 负责。
/// </summary>
internal sealed class CodexModelCatalogGateway
{
    private const int TimeoutMs = 30_000;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly string _suiteRoot;
    private readonly string _skillRoot;
    private readonly string _ctiHome;
    private readonly CodexModelCatalogCliCommandExecutor _executor;
    private readonly string _nodeExecutable;

    public CodexModelCatalogGateway(
        string suiteRoot,
        string skillRoot,
        string ctiHome,
        CodexModelCatalogCliCommandExecutor? executor = null,
        string nodeExecutable = "node")
    {
        _suiteRoot = NormalizeOptionalPath(suiteRoot);
        _skillRoot = NormalizeOptionalPath(skillRoot);
        _ctiHome = Path.GetFullPath(ctiHome);
        _executor = executor ?? ExecuteProcessAsync;
        _nodeExecutable = string.IsNullOrWhiteSpace(nodeExecutable) ? "node" : nodeExecutable.Trim();
    }

    public async Task<CodexModelCatalogContract> DiscoverAsync(
        object? input,
        string configuredModel,
        string source,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var errorSource = ResolveCatalogSource(source, input);
            object payload = input is null
                ? new { source, configuredModel }
                : new { source, configuredModel, input };
            var bytes = JsonSerializer.SerializeToUtf8Bytes(payload, JsonOptions);
            var invocation = new CodexModelCatalogCliInvocation(
                _nodeExecutable,
                [ResolveCliPath(), "--input-json", Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')],
                ResolveWorkingDirectory(),
                new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
                {
                    ["CTI_HOME"] = _ctiHome,
                    ["CODEX_IM_SUITE_ROOT"] = string.IsNullOrWhiteSpace(_suiteRoot) ? null : _suiteRoot,
                    ["PYTHONUTF8"] = "1",
                    ["PYTHONIOENCODING"] = "utf-8",
                },
                TimeoutMs);
            var result = await _executor(invocation).WaitAsync(cancellationToken);
            using var document = JsonDocument.Parse(result.Stdout);
            var root = document.RootElement;
            if (result.ExitCode != 0 || root.ValueKind != JsonValueKind.Object)
            {
                return ErrorCatalog(configuredModel, errorSource, "Runtime 模型目录探测未完成。");
            }
            var data = root.TryGetProperty("data", out var wrapped) ? wrapped : root;
            var catalog = JsonSerializer.Deserialize<CodexModelCatalogContract>(data.GetRawText(), JsonOptions);
            return catalog is not null && IsValidCatalog(catalog)
                ? catalog
                : ErrorCatalog(configuredModel, errorSource, "Runtime 模型目录响应无效。");
        }
        catch (OperationCanceledException)
        {
            return ErrorCatalog(configuredModel, ResolveCatalogSource(source, input), "读取模型目录超时。");
        }
        catch
        {
            return ErrorCatalog(configuredModel, ResolveCatalogSource(source, input), "读取模型目录失败，请检查当前模型来源和服务状态。");
        }
    }

    private string ResolveCliPath()
    {
        var candidates = new[]
        {
            string.IsNullOrWhiteSpace(_suiteRoot) ? "" : Path.Combine(_suiteRoot, "packages", "bridge-runtime", "dist", "codex-model-catalog-cli.mjs"),
            string.IsNullOrWhiteSpace(_skillRoot) ? "" : Path.Combine(_skillRoot, "dist", "codex-model-catalog-cli.mjs"),
        };
        var path = candidates.FirstOrDefault(candidate => !string.IsNullOrWhiteSpace(candidate) && File.Exists(candidate));
        return !string.IsNullOrWhiteSpace(path)
            ? Path.GetFullPath(path)
            : throw new InvalidOperationException("未找到 Runtime 模型目录 CLI。");
    }

    private string ResolveWorkingDirectory()
        => !string.IsNullOrWhiteSpace(_suiteRoot) && Directory.Exists(_suiteRoot) ? _suiteRoot
            : !string.IsNullOrWhiteSpace(_skillRoot) && Directory.Exists(_skillRoot) ? _skillRoot
            : _ctiHome;

    private static CodexModelCatalogContract ErrorCatalog(string configuredModel, string source, string error)
        => new(
            "cti-codex-model-catalog/v1",
            DateTimeOffset.UtcNow.ToString("O"),
            "error",
            source.Equals("official", StringComparison.OrdinalIgnoreCase) ? "codex_app_server" : source.Equals("local_api", StringComparison.OrdinalIgnoreCase) ? "ollama" : "openai_compatible",
            [],
            configuredModel.Trim(),
            error);

    private static string ResolveCatalogSource(string source, object? input)
    {
        if (source.Equals("official", StringComparison.OrdinalIgnoreCase)) return "codex_app_server";
        if (source.Equals("external_api", StringComparison.OrdinalIgnoreCase)) return "openai_compatible";
        var localKind = "ollama";
        if (input is JsonElement element && element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty("localKind", out var kind)
            && kind.ValueKind == JsonValueKind.String)
        {
            localKind = kind.GetString() ?? localKind;
        }
        return localKind.Equals("ollama", StringComparison.OrdinalIgnoreCase) ? "ollama" : "openai_compatible";
    }

    private static string NormalizeOptionalPath(string value)
        => string.IsNullOrWhiteSpace(value) ? "" : Path.GetFullPath(value.Trim());

    private static bool IsValidCatalog(CodexModelCatalogContract catalog)
    {
        if (!string.Equals(catalog.Protocol, "cti-codex-model-catalog/v1", StringComparison.Ordinal)
            || string.IsNullOrWhiteSpace(catalog.GeneratedAt)
            || catalog.Status is not ("ready" or "empty" or "error")
            || catalog.Source is not ("codex_app_server" or "openai_compatible" or "ollama")
            || catalog.Models is null
            || catalog.Models.Length > 500
            || catalog.Error.Length > 240)
        {
            return false;
        }

        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var model in catalog.Models)
        {
            if (model is null
                || string.IsNullOrWhiteSpace(model.Id)
                || string.IsNullOrWhiteSpace(model.DisplayName)
                || model.Hidden
                || !ids.Add(model.Id.Trim())
                || model.InputModalities is null
                || model.SupportedReasoningEfforts is null
                || model.InputModalities.Any(string.IsNullOrWhiteSpace)
                || model.SupportedReasoningEfforts.Any(string.IsNullOrWhiteSpace))
            {
                return false;
            }
        }
        return catalog.Status != "ready" || catalog.Models.Length > 0;
    }

    private static async Task<CodexModelCatalogCliExecutionResult> ExecuteProcessAsync(CodexModelCatalogCliInvocation invocation)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = invocation.FileName,
            WorkingDirectory = invocation.WorkingDirectory,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            CreateNoWindow = true,
        };
        foreach (var argument in invocation.Arguments) startInfo.ArgumentList.Add(argument);
        foreach (var (key, value) in invocation.Environment)
        {
            if (value is null) startInfo.Environment.Remove(key);
            else startInfo.Environment[key] = value;
        }
        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException("无法启动 Runtime 模型目录 CLI。");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(invocation.TimeoutMs);
        await process.WaitForExitAsync(timeout.Token);
        return new CodexModelCatalogCliExecutionResult(process.ExitCode, await stdoutTask, await stderrTask);
    }
}
