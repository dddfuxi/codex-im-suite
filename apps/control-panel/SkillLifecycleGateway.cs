using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace ClaudeToImControlPanel;

internal sealed record SkillCliExecutionResult(int ExitCode, string Stdout, string Stderr);

internal sealed record SkillCliInvocation(
    string FileName,
    IReadOnlyList<string> Arguments,
    string WorkingDirectory,
    IReadOnlyDictionary<string, string?> Environment,
    int TimeoutMs,
    bool UseShellExecute = false);

internal delegate Task<SkillCliExecutionResult> SkillCliCommandExecutor(SkillCliInvocation invocation);

internal static class SkillControlCommandPolicy
{
    public static bool UsesLifecycleForExtensionType(string extensionType)
        => string.Equals(extensionType?.Trim(), "skill", StringComparison.OrdinalIgnoreCase);

    public static string? GetRequiredRole(string command)
        => command switch
        {
            "skill.registry.snapshot" or "skill.catalog.search" => "viewer",
            "skill.draft.create" or "skill.lifecycle.validate" => "operator",
            "skill.lifecycle.prepareInstall"
                or "skill.lifecycle.confirmInstall"
                or "skill.lifecycle.enable"
                or "skill.lifecycle.disable"
                or "skill.lifecycle.rollback" => "owner",
            _ => null,
        };
}

/// <summary>
/// 控制面板到 runtime Skill 生命周期 CLI 的薄边界。
/// 这里只负责定位构建产物、保留 JSON payload、隔离进程参数和解析返回值，
/// 不在面板内复制来源、风险、审批或安装策略。
/// </summary>
internal sealed class SkillLifecycleGateway
{
    private static readonly HashSet<string> AllowedCommands = new(StringComparer.Ordinal)
    {
        "snapshot",
        "search",
        "create-draft",
        "validate",
        "prepare-install",
        "confirm-install",
        "enable",
        "disable",
        "rollback",
    };

    private readonly string _suiteRoot;
    private readonly string _skillDir;
    private readonly string _ctiHome;
    private readonly string _codexHome;
    private readonly SkillCliCommandExecutor _executor;
    private readonly string _nodeExecutable;

    public SkillLifecycleGateway(
        string suiteRoot,
        string skillDir,
        string ctiHome,
        string codexHome,
        SkillCliCommandExecutor? executor = null,
        string nodeExecutable = "node")
    {
        _suiteRoot = NormalizeOptionalPath(suiteRoot);
        _skillDir = NormalizeOptionalPath(skillDir);
        _ctiHome = NormalizeRequiredPath(ctiHome, nameof(ctiHome));
        _codexHome = NormalizeRequiredPath(codexHome, nameof(codexHome));
        _executor = executor ?? ExecuteProcessAsync;
        _nodeExecutable = string.IsNullOrWhiteSpace(nodeExecutable) ? "node" : nodeExecutable.Trim();
    }

    public async Task<JsonDocument> RunAsync(string command, object? input, int timeoutMs = 120_000)
    {
        if (!AllowedCommands.Contains(command))
        {
            throw new InvalidOperationException($"未知 Skill lifecycle 命令：{command}");
        }

        var cliPath = ResolveCliPath();
        var encodedInput = Convert.ToBase64String(SerializeInput(input));
        var workingDirectory = ResolveWorkingDirectory();
        var invocation = new SkillCliInvocation(
            _nodeExecutable,
            [cliPath, command, "--input-base64", encodedInput],
            workingDirectory,
            new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
            {
                ["CTI_HOME"] = _ctiHome,
                ["CODEX_HOME"] = _codexHome,
                ["PYTHONUTF8"] = "1",
                ["PYTHONIOENCODING"] = "utf-8",
            },
            Math.Max(1_000, timeoutMs));

        var result = await _executor(invocation);
        if (result.ExitCode != 0)
        {
            var detail = FirstNonEmpty(result.Stderr, result.Stdout, "runtime CLI 未返回错误详情。").Trim();
            throw new InvalidOperationException($"Skill lifecycle CLI 退出码 {result.ExitCode}：{detail}");
        }

        try
        {
            return JsonDocument.Parse(result.Stdout);
        }
        catch (JsonException error)
        {
            throw new InvalidOperationException($"Skill lifecycle CLI 未返回合法 JSON：{error.Message}");
        }
    }

    public async Task<JsonDocument> ReadSnapshotAsync(int timeoutMs = 120_000)
    {
        var registryPath = Path.Combine(_ctiHome, "data", "skill-registry.json");
        if (File.Exists(registryPath))
        {
            try
            {
                using var stream = new FileStream(registryPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                var document = await JsonDocument.ParseAsync(stream);
                if (document.RootElement.TryGetProperty("protocol", out var protocol)
                    && string.Equals(protocol.GetString(), "cti-skill-registry/v1", StringComparison.Ordinal))
                {
                    return document;
                }
                document.Dispose();
            }
            catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException)
            {
                // 损坏的 runtime 状态由 lifecycle CLI 按 Registry 备份/扫描规则恢复。
            }
        }
        return await RunAsync("snapshot", null, timeoutMs);
    }

    private string ResolveCliPath()
    {
        var candidates = new List<string>();
        if (!string.IsNullOrWhiteSpace(_suiteRoot))
        {
            candidates.Add(Path.Combine(_suiteRoot, "packages", "bridge-runtime", "dist", "skill-lifecycle-cli.mjs"));
        }
        if (!string.IsNullOrWhiteSpace(_skillDir))
        {
            candidates.Add(Path.Combine(_skillDir, "dist", "skill-lifecycle-cli.mjs"));
        }

        var resolved = candidates.FirstOrDefault(File.Exists);
        if (!string.IsNullOrWhiteSpace(resolved)) return Path.GetFullPath(resolved);

        var checkedPaths = candidates.Count > 0 ? string.Join("；", candidates) : "未配置 suiteRoot 或 skillDir";
        throw new InvalidOperationException($"未找到 skill-lifecycle-cli.mjs。已检查：{checkedPaths}");
    }

    private string ResolveWorkingDirectory()
    {
        if (!string.IsNullOrWhiteSpace(_suiteRoot) && Directory.Exists(_suiteRoot)) return _suiteRoot;
        if (!string.IsNullOrWhiteSpace(_skillDir) && Directory.Exists(_skillDir)) return _skillDir;
        return _ctiHome;
    }

    private static byte[] SerializeInput(object? input)
    {
        if (input is null) return "{}"u8.ToArray();
        if (input is JsonElement element && element.ValueKind == JsonValueKind.Undefined) return "{}"u8.ToArray();
        return JsonSerializer.SerializeToUtf8Bytes(input);
    }

    private static async Task<SkillCliExecutionResult> ExecuteProcessAsync(SkillCliInvocation invocation)
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
        foreach (var argument in invocation.Arguments)
        {
            process.StartInfo.ArgumentList.Add(argument);
        }
        foreach (var pair in invocation.Environment)
        {
            process.StartInfo.Environment[pair.Key] = pair.Value ?? "";
        }

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
            return new SkillCliExecutionResult(-1, await stdoutTask, $"{await stderrTask}\nTimeout after {invocation.TimeoutMs} ms.");
        }
        return new SkillCliExecutionResult(process.ExitCode, await stdoutTask, await stderrTask);
    }

    private static string NormalizeOptionalPath(string value)
        => string.IsNullOrWhiteSpace(value) ? "" : Path.GetFullPath(value);

    private static string NormalizeRequiredPath(string value, string name)
    {
        if (string.IsNullOrWhiteSpace(value)) throw new ArgumentException($"{name} 不能为空。", name);
        return Path.GetFullPath(value);
    }

    private static string FirstNonEmpty(params string[] values)
        => values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? "";
}
