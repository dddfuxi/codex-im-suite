using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace ClaudeToImControlPanel;

internal sealed record ScheduledTaskCliExecutionResult(int ExitCode, string Stdout, string Stderr);
internal sealed record ScheduledTaskCliInvocation(string FileName, IReadOnlyList<string> Arguments, string WorkingDirectory, IReadOnlyDictionary<string, string?> Environment, int TimeoutMs, bool UseShellExecute = false);
internal sealed record ScheduledTaskPanelSnapshot(bool Available, string Error, JsonElement Status, IReadOnlyList<JsonElement> Items);
internal delegate Task<ScheduledTaskCliExecutionResult> ScheduledTaskCliCommandExecutor(ScheduledTaskCliInvocation invocation);

internal static class ScheduledTaskCommandPolicy
{
    public static string? GetRequiredRole(string command) => command switch
    {
        "scheduledTasks.list" or "scheduledTasks.get" or "scheduledTasks.pause" or "scheduledTasks.resume" or "scheduledTasks.runNow" or "scheduledTasks.history" or "scheduledTasks.status" => "operator",
        "scheduledTasks.cancelRun" or "scheduledTasks.delete" or "scheduledTasks.retryDelivery" => "owner",
        _ => null,
    };
}

/// <summary>控制面板只调用 runtime CLI，不直接读写计划任务 Store。</summary>
internal sealed class ScheduledTaskGateway
{
    private static readonly HashSet<string> Allowed = new(StringComparer.Ordinal)
    { "list", "get", "pause", "resume", "run-now", "cancel-run", "delete", "history", "retry-delivery", "status" };
    private readonly string _suiteRoot;
    private readonly string _skillRoot;
    private readonly string _ctiHome;
    private readonly ScheduledTaskCliCommandExecutor _executor;
    private readonly string _nodeExecutable;

    public ScheduledTaskGateway(string suiteRoot, string skillRoot, string ctiHome, ScheduledTaskCliCommandExecutor? executor = null, string nodeExecutable = "node")
    {
        _suiteRoot = suiteRoot;
        _skillRoot = skillRoot;
        _ctiHome = Path.GetFullPath(ctiHome);
        _executor = executor ?? ExecuteProcessAsync;
        _nodeExecutable = string.IsNullOrWhiteSpace(nodeExecutable) ? "node" : nodeExecutable.Trim();
    }

    public async Task<JsonDocument> RunAsync(string command, object? input, int timeoutMs = 120_000)
    {
        if (!Allowed.Contains(command)) throw new InvalidOperationException($"未知计划任务命令：{command}");
        var payload = input is null ? JsonDocument.Parse("{}").RootElement : JsonSerializer.SerializeToElement(input);
        var arguments = new List<string> { ResolveCliPath(), command };
        var taskId = ReadString(payload, "taskId");
        if (!string.IsNullOrWhiteSpace(taskId)) arguments.Add(taskId);
        var expectedVersion = ReadInt(payload, "expectedVersion");
        if (expectedVersion > 0) { arguments.Add("--expected-version"); arguments.Add(expectedVersion.ToString()); }
        var runId = ReadString(payload, "runId");
        if (!string.IsNullOrWhiteSpace(runId)) { arguments.Add("--run-id"); arguments.Add(runId); }
        arguments.Add("--json");
        var invocation = new ScheduledTaskCliInvocation(_nodeExecutable, arguments, Directory.Exists(_suiteRoot) ? _suiteRoot : _ctiHome,
            new Dictionary<string, string?> { ["CTI_HOME"] = _ctiHome, ["PYTHONUTF8"] = "1", ["PYTHONIOENCODING"] = "utf-8" }, Math.Max(1000, timeoutMs));
        var result = await _executor(invocation);
        if (result.ExitCode != 0) throw new InvalidOperationException($"计划任务 CLI 退出码 {result.ExitCode}：{(string.IsNullOrWhiteSpace(result.Stderr) ? result.Stdout : result.Stderr).Trim()}");
        try { return JsonDocument.Parse(result.Stdout); }
        catch (JsonException error) { throw new InvalidOperationException($"计划任务 CLI 未返回合法 JSON：{error.Message}"); }
    }

    public async Task<ScheduledTaskPanelSnapshot> ReadPanelStateAsync()
    {
        try
        {
            using var statusDocument = await RunAsync("status", new { });
            using var listDocument = await RunAsync("list", new { });
            var items = listDocument.RootElement.TryGetProperty("items", out var itemsElement)
                && itemsElement.ValueKind == JsonValueKind.Array
                ? itemsElement.EnumerateArray().Select(item => item.Clone()).ToArray()
                : Array.Empty<JsonElement>();
            return new ScheduledTaskPanelSnapshot(true, "", statusDocument.RootElement.Clone(), items);
        }
        catch (Exception error)
        {
            return new ScheduledTaskPanelSnapshot(false, error.Message, JsonSerializer.SerializeToElement(new { }), Array.Empty<JsonElement>());
        }
    }

    private string ResolveCliPath()
    {
        var candidates = new[] { Path.Combine(_suiteRoot, "packages", "bridge-runtime", "dist", "scheduled-task-cli.mjs"), Path.Combine(_skillRoot, "dist", "scheduled-task-cli.mjs") };
        return candidates.FirstOrDefault(File.Exists) ?? throw new InvalidOperationException($"未找到 scheduled-task-cli.mjs。已检查：{string.Join("；", candidates)}");
    }

    private static string ReadString(JsonElement payload, string name) => payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";
    private static int ReadInt(JsonElement payload, string name) => payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(name, out var value) && value.TryGetInt32(out var result) ? result : 0;

    private static async Task<ScheduledTaskCliExecutionResult> ExecuteProcessAsync(ScheduledTaskCliInvocation invocation)
    {
        using var process = new Process { StartInfo = new ProcessStartInfo { FileName = invocation.FileName, WorkingDirectory = invocation.WorkingDirectory, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false), CreateNoWindow = true } };
        foreach (var argument in invocation.Arguments) process.StartInfo.ArgumentList.Add(argument);
        foreach (var pair in invocation.Environment) process.StartInfo.Environment[pair.Key] = pair.Value ?? "";
        process.Start();
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(invocation.TimeoutMs);
        await process.WaitForExitAsync(timeout.Token);
        return new ScheduledTaskCliExecutionResult(process.ExitCode, await stdout, await stderr);
    }
}
