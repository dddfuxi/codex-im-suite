using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace ClaudeToImControlPanel;

internal sealed record MemoryItemCliExecutionResult(int ExitCode, string Stdout, string Stderr);
internal sealed record MemoryItemCliInvocation(
    string FileName,
    IReadOnlyList<string> Arguments,
    string WorkingDirectory,
    IReadOnlyDictionary<string, string?> Environment,
    int TimeoutMs,
    bool UseShellExecute = false);
internal delegate Task<MemoryItemCliExecutionResult> MemoryItemCliCommandExecutor(MemoryItemCliInvocation invocation);

/// <summary>
/// 控制面板到 runtime 记忆生命周期 CLI 的薄边界。
/// 这里只接受 opaque ID 和并发 hash，不允许浏览器传入任意源文件或归档路径。
/// </summary>
internal sealed class MemoryItemGateway
{
    private static readonly HashSet<string> AllowedCommands = new(StringComparer.Ordinal)
    {
        "status",
        "list-confirmed",
        "list-candidates",
        "list-archives",
        "confirm",
        "archive",
        "restore",
        "delete-archive",
        "archive-candidates",
    };

    private readonly string _suiteRoot;
    private readonly string _skillRoot;
    private readonly string _ctiHome;
    private readonly string _memoryRoot;
    private readonly MemoryItemCliCommandExecutor _executor;
    private readonly string _nodeExecutable;

    public MemoryItemGateway(
        string suiteRoot,
        string skillRoot,
        string ctiHome,
        string memoryRoot,
        MemoryItemCliCommandExecutor? executor = null,
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
        if (!AllowedCommands.Contains(command)) throw new InvalidOperationException($"未知记忆生命周期命令：{command}");
        var payload = input is null ? JsonSerializer.SerializeToElement(new { }) : JsonSerializer.SerializeToElement(input);
        if (payload.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("记忆生命周期命令 payload 必须是 JSON 对象。");
        RejectPathPayload(payload);

        var arguments = new List<string> { ResolveCliPath(), command };
        switch (command)
        {
            case "confirm":
            case "archive":
                arguments.Add(RequireOpaqueId(ReadString(payload, "itemId", ReadString(payload, "id")), "itemId"));
                AddExpectedBaseHash(arguments, ReadString(payload, "expectedBaseHash"));
                if (command == "confirm") AddKey(arguments, ReadString(payload, "key"));
                break;
            case "restore":
            case "delete-archive":
                arguments.Add(RequireOpaqueId(ReadString(payload, "archiveId"), "archiveId"));
                break;
            case "archive-candidates":
                var itemIds = ReadOpaqueIdArray(payload, "itemIds");
                arguments.Add("--ids-base64");
                arguments.Add(Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(itemIds)));
                break;
        }
        arguments.Add("--memory-root");
        arguments.Add(_memoryRoot);

        var invocation = new MemoryItemCliInvocation(
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
            throw new InvalidOperationException($"记忆生命周期 CLI 退出码 {result.ExitCode}：{detail}");
        }
        try
        {
            return JsonDocument.Parse(result.Stdout);
        }
        catch (JsonException error)
        {
            throw new InvalidOperationException($"记忆生命周期 CLI 未返回合法 JSON：{error.Message}");
        }
    }

    private string ResolveCliPath()
    {
        var candidates = new List<string>();
        if (!string.IsNullOrWhiteSpace(_suiteRoot))
        {
            candidates.Add(Path.Combine(_suiteRoot, "packages", "bridge-runtime", "dist", "memory-item-cli.mjs"));
        }
        if (!string.IsNullOrWhiteSpace(_skillRoot))
        {
            candidates.Add(Path.Combine(_skillRoot, "dist", "memory-item-cli.mjs"));
        }
        var resolved = candidates.FirstOrDefault(File.Exists);
        if (!string.IsNullOrWhiteSpace(resolved)) return Path.GetFullPath(resolved);
        throw new InvalidOperationException($"未找到 memory-item-cli.mjs。已检查：{string.Join("；", candidates)}");
    }

    private string ResolveWorkingDirectory()
    {
        if (!string.IsNullOrWhiteSpace(_suiteRoot) && Directory.Exists(_suiteRoot)) return _suiteRoot;
        if (!string.IsNullOrWhiteSpace(_skillRoot) && Directory.Exists(_skillRoot)) return _skillRoot;
        return _ctiHome;
    }

    private static void RejectPathPayload(JsonElement payload)
    {
        foreach (var name in new[] { "path", "archivePath", "sourcePath" })
        {
            if (payload.TryGetProperty(name, out _))
            {
                throw new InvalidOperationException($"记忆生命周期命令不接受路径参数：{name}");
            }
        }
    }

    private static void AddExpectedBaseHash(List<string> arguments, string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        arguments.Add("--expected-base-hash");
        arguments.Add(RequireOpaqueId(value, "expectedBaseHash"));
    }

    private static void AddKey(List<string> arguments, string value)
    {
        var key = value.Trim();
        if (string.IsNullOrWhiteSpace(key)) return;
        if (key.Length > 120 || key.Contains('\r') || key.Contains('\n')) throw new InvalidOperationException("记忆 key 无效。");
        arguments.Add("--key");
        arguments.Add(key);
    }

    private static string[] ReadOpaqueIdArray(JsonElement payload, string name)
    {
        if (!payload.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidOperationException($"缺少 {name} 数组。");
        }
        var ids = value.EnumerateArray()
            .Select(item => item.ValueKind == JsonValueKind.String ? RequireOpaqueId(item.GetString() ?? "", name) : throw new InvalidOperationException($"{name} 含无效 ID。"))
            .ToArray();
        if (ids.Length == 0 || ids.Length > 500 || ids.Distinct(StringComparer.Ordinal).Count() != ids.Length)
        {
            throw new InvalidOperationException($"{name} 数量或去重校验失败。");
        }
        return ids;
    }

    private static string RequireOpaqueId(string value, string name)
    {
        var normalized = value.Trim();
        if (normalized.Length != 64 || normalized.Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
        {
            throw new InvalidOperationException($"{name} 无效。");
        }
        return normalized;
    }

    private static string ReadString(JsonElement payload, string name, string fallback = "")
        => payload.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? fallback
            : fallback;

    private static string NormalizeOptionalPath(string value)
        => string.IsNullOrWhiteSpace(value) ? "" : Path.GetFullPath(value);

    private static string NormalizeRequiredPath(string value, string name)
    {
        if (string.IsNullOrWhiteSpace(value)) throw new ArgumentException($"{name} 不能为空。", name);
        return Path.GetFullPath(value);
    }

    private static string FirstNonEmpty(params string[] values)
        => values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? "";

    private static async Task<MemoryItemCliExecutionResult> ExecuteProcessAsync(MemoryItemCliInvocation invocation)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = invocation.FileName,
                WorkingDirectory = Directory.Exists(invocation.WorkingDirectory)
                    ? invocation.WorkingDirectory
                    : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                UseShellExecute = invocation.UseShellExecute,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false),
                CreateNoWindow = true,
            },
        };
        foreach (var argument in invocation.Arguments) process.StartInfo.ArgumentList.Add(argument);
        foreach (var pair in invocation.Environment) process.StartInfo.Environment[pair.Key] = pair.Value ?? "";
        process.Start();
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        using var cancellation = new CancellationTokenSource(invocation.TimeoutMs);
        try
        {
            await process.WaitForExitAsync(cancellation.Token);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            return new MemoryItemCliExecutionResult(-1, await stdoutTask, $"{await stderrTask}\nTimeout after {invocation.TimeoutMs} ms.");
        }
        return new MemoryItemCliExecutionResult(process.ExitCode, await stdoutTask, await stderrTask);
    }
}
