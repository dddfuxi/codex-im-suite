using System.Diagnostics;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace ClaudeToImControlPanel;

internal sealed record StickerSemanticCliExecutionResult(int ExitCode, string Stdout, string Stderr);
internal sealed record StickerSemanticCliInvocation(
    string FileName,
    IReadOnlyList<string> Arguments,
    string WorkingDirectory,
    IReadOnlyDictionary<string, string?> Environment,
    int TimeoutMs,
    bool UseShellExecute = false);
internal delegate Task<StickerSemanticCliExecutionResult> StickerSemanticCliCommandExecutor(StickerSemanticCliInvocation invocation);

/// <summary>
/// 控制面板到 runtime 表情包语义主库的唯一写边界。
/// 浏览器只能提交 fileKey、revisionId、baseHash 和结构化 patch，不能指定文件路径。
/// </summary>
internal sealed class StickerSemanticGateway
{
    private static readonly JsonSerializerOptions PayloadJsonOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };
    private static readonly HashSet<string> AllowedCommands = new(StringComparer.Ordinal)
    {
        "status", "list", "history", "accept-revision", "reject-revision", "rollback",
        "update-manual", "archive", "restore", "delete-archived",
    };

    private readonly string _suiteRoot;
    private readonly string _skillRoot;
    private readonly string _ctiHome;
    private readonly string _memoryRoot;
    private readonly StickerSemanticCliCommandExecutor _executor;
    private readonly string _nodeExecutable;

    public StickerSemanticGateway(
        string suiteRoot,
        string skillRoot,
        string ctiHome,
        string memoryRoot,
        StickerSemanticCliCommandExecutor? executor = null,
        string nodeExecutable = "node")
    {
        _suiteRoot = NormalizeOptionalPath(suiteRoot);
        _skillRoot = NormalizeOptionalPath(skillRoot);
        _ctiHome = NormalizeRequiredPath(ctiHome, nameof(ctiHome));
        _memoryRoot = NormalizeRequiredPath(memoryRoot, nameof(memoryRoot));
        _executor = executor ?? ExecuteProcessAsync;
        _nodeExecutable = string.IsNullOrWhiteSpace(nodeExecutable) ? "node" : nodeExecutable.Trim();
    }

    public async Task<JsonDocument> RunAsync(string command, object? input, int timeoutMs = 120_000)
    {
        if (!AllowedCommands.Contains(command)) throw new InvalidOperationException($"未知表情包语义命令：{command}");
        var payload = input is null ? JsonSerializer.SerializeToElement(new { }) : JsonSerializer.SerializeToElement(input);
        if (payload.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("表情包语义命令 payload 必须是 JSON 对象。");
        RejectPathPayload(payload);

        var arguments = new List<string> { ResolveCliPath(), command };
        switch (command)
        {
            case "history":
                arguments.Add(RequireSafeId(ReadString(payload, "fileKey"), "fileKey"));
                AddOptional(arguments, "--scope", ReadString(payload, "scope"));
                AddOptional(arguments, "--scope-id", ReadString(payload, "scopeId"));
                break;
            case "accept-revision":
            case "reject-revision":
            case "rollback":
                arguments.Add(RequireSafeId(ReadString(payload, "revisionId"), "revisionId"));
                AddExpectedBaseHash(arguments, ReadString(payload, "expectedBaseHash"));
                break;
            case "update-manual":
                arguments.Add(RequireSafeId(ReadString(payload, "fileKey"), "fileKey"));
                var patch = payload.TryGetProperty("patch", out var patchElement) && patchElement.ValueKind == JsonValueKind.Object
                    ? patchElement
                    : BuildLegacyPatch(payload);
                arguments.Add("--payload-base64");
                arguments.Add(Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(patch, PayloadJsonOptions)));
                AddExpectedBaseHash(arguments, ReadString(payload, "expectedBaseHash"));
                break;
            case "archive":
            case "restore":
            case "delete-archived":
                arguments.Add(RequireSafeId(ReadString(payload, "fileKey"), "fileKey"));
                AddExpectedBaseHash(arguments, ReadString(payload, "expectedBaseHash"));
                break;
            case "list":
                AddOptional(arguments, "--status", ReadString(payload, "status"));
                break;
        }
        arguments.Add("--memory-root");
        arguments.Add(_memoryRoot);

        var invocation = new StickerSemanticCliInvocation(
            _nodeExecutable,
            arguments,
            ResolveWorkingDirectory(),
            new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
            {
                ["CTI_HOME"] = _ctiHome,
                ["CTI_MEMORY_REPO_DIR"] = _memoryRoot,
                ["PYTHONUTF8"] = "1",
                ["PYTHONIOENCODING"] = "utf-8",
            },
            Math.Max(1_000, timeoutMs));
        var result = await _executor(invocation);
        if (result.ExitCode != 0)
        {
            var detail = FirstNonEmpty(result.Stderr, result.Stdout, "runtime CLI 未返回错误详情。").Trim();
            throw new InvalidOperationException($"表情包语义 CLI 退出码 {result.ExitCode}：{detail}");
        }
        try { return JsonDocument.Parse(result.Stdout); }
        catch (JsonException error) { throw new InvalidOperationException($"表情包语义 CLI 未返回合法 JSON：{error.Message}"); }
    }

    private static JsonElement BuildLegacyPatch(JsonElement payload)
    {
        var allowed = new[] { "label", "description", "intent", "tone", "usage", "aliases", "examples", "avoidWhen", "avoidRules", "disabled", "disabledReason" };
        using var document = JsonDocument.Parse("{}");
        var values = new Dictionary<string, object?>();
        foreach (var name in allowed)
        {
            if (!payload.TryGetProperty(name, out var value)) continue;
            values[name] = JsonSerializer.Deserialize<object>(value.GetRawText());
        }
        return JsonSerializer.SerializeToElement(values);
    }

    private static void RejectPathPayload(JsonElement payload)
    {
        foreach (var name in new[] { "path", "sourcePath", "storePath", "mediaPath", "archivePath" })
        {
            if (payload.TryGetProperty(name, out _)) throw new InvalidOperationException($"表情包语义命令不接受路径参数：{name}");
        }
    }

    private static void AddExpectedBaseHash(List<string> arguments, string value)
    {
        var normalized = value.Trim();
        if (normalized.Length != 64 || normalized.Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
            throw new InvalidOperationException("expectedBaseHash 无效。");
        arguments.Add("--expected-base-hash");
        arguments.Add(normalized);
    }

    private static void AddOptional(List<string> arguments, string name, string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        arguments.Add(name);
        arguments.Add(value.Trim());
    }

    private static string RequireSafeId(string value, string name)
    {
        var normalized = value.Trim();
        if (string.IsNullOrWhiteSpace(normalized) || normalized.Length > 256 || normalized.Any(character => !(char.IsLetterOrDigit(character) || character is '.' or '_' or ':' or '-')))
            throw new InvalidOperationException($"{name} 无效。");
        return normalized;
    }

    private string ResolveCliPath()
    {
        var candidates = new[]
        {
            string.IsNullOrWhiteSpace(_suiteRoot) ? "" : Path.Combine(_suiteRoot, "packages", "bridge-runtime", "dist", "sticker-semantic-cli.mjs"),
            string.IsNullOrWhiteSpace(_skillRoot) ? "" : Path.Combine(_skillRoot, "dist", "sticker-semantic-cli.mjs"),
        }.Where(candidate => !string.IsNullOrWhiteSpace(candidate)).ToArray();
        return candidates.FirstOrDefault(File.Exists)
            ?? throw new InvalidOperationException($"未找到 sticker-semantic-cli.mjs。已检查：{string.Join("；", candidates)}");
    }

    private string ResolveWorkingDirectory()
        => !string.IsNullOrWhiteSpace(_suiteRoot) && Directory.Exists(_suiteRoot) ? _suiteRoot
            : !string.IsNullOrWhiteSpace(_skillRoot) && Directory.Exists(_skillRoot) ? _skillRoot
            : _ctiHome;

    private static string ReadString(JsonElement payload, string name)
        => payload.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
    private static string NormalizeOptionalPath(string value) => string.IsNullOrWhiteSpace(value) ? "" : Path.GetFullPath(value);
    private static string NormalizeRequiredPath(string value, string name) => string.IsNullOrWhiteSpace(value) ? throw new ArgumentException($"{name} 不能为空。", name) : Path.GetFullPath(value);
    private static string FirstNonEmpty(params string[] values) => values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? "";

    private static async Task<StickerSemanticCliExecutionResult> ExecuteProcessAsync(StickerSemanticCliInvocation invocation)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = invocation.FileName,
            WorkingDirectory = invocation.WorkingDirectory,
            UseShellExecute = invocation.UseShellExecute,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var argument in invocation.Arguments) startInfo.ArgumentList.Add(argument);
        foreach (var pair in invocation.Environment) startInfo.Environment[pair.Key] = pair.Value;
        using var process = new Process { StartInfo = startInfo };
        if (!process.Start()) throw new InvalidOperationException("无法启动表情包语义 CLI。");
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(invocation.TimeoutMs);
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            throw new TimeoutException($"表情包语义 CLI 超时（{invocation.TimeoutMs}ms）。");
        }
        return new StickerSemanticCliExecutionResult(process.ExitCode, await stdoutTask, await stderrTask);
    }
}
