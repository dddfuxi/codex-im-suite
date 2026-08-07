using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace ClaudeToImControlPanel;

internal static class ActiveReplyCommandPolicy
{
    public static string? GetRequiredRole(string command)
        => string.Equals(command, "workflow.cancelActiveReply", StringComparison.Ordinal) ? "operator" : null;
}

/// <summary>
/// 面板通过 Runtime 自带 CLI 把终止请求交给仍在运行的 Bridge；这里不直接
/// 改 Workflow 状态文件，也不通过停止服务伪造取消。
/// </summary>
internal sealed class ActiveReplyGateway
{
    private readonly string _suiteRoot;
    private readonly string _skillRoot;
    private readonly string _ctiHome;
    private readonly ScheduledTaskCliCommandExecutor _executor;
    private readonly string _nodeExecutable;

    public ActiveReplyGateway(
        string suiteRoot,
        string skillRoot,
        string ctiHome,
        ScheduledTaskCliCommandExecutor? executor = null,
        string nodeExecutable = "node")
    {
        _suiteRoot = suiteRoot;
        _skillRoot = skillRoot;
        _ctiHome = Path.GetFullPath(ctiHome);
        _executor = executor ?? ExecuteProcessAsync;
        _nodeExecutable = string.IsNullOrWhiteSpace(nodeExecutable) ? "node" : nodeExecutable.Trim();
    }

    public async Task<JsonDocument> CancelAsync(string workflowRunId, int timeoutMs = 20_000)
    {
        var normalized = workflowRunId.Trim();
        if (string.IsNullOrWhiteSpace(normalized)) throw new InvalidOperationException("runId 不能为空");
        var invocation = new ScheduledTaskCliInvocation(
            _nodeExecutable,
            new[] { ResolveCliPath(), "cancel", normalized, "--json" },
            Directory.Exists(_suiteRoot) ? _suiteRoot : _ctiHome,
            new Dictionary<string, string?>
            {
                ["CTI_HOME"] = _ctiHome,
                ["PYTHONUTF8"] = "1",
                ["PYTHONIOENCODING"] = "utf-8",
            },
            Math.Max(1_000, timeoutMs));
        var result = await _executor(invocation);
        JsonDocument document;
        try { document = JsonDocument.Parse(result.Stdout); }
        catch (JsonException error)
        {
            throw new InvalidOperationException($"终止回复 CLI 未返回合法 JSON：{error.Message}");
        }
        if (result.ExitCode == 0) return document;
        using (document)
        {
            var detail = document.RootElement.TryGetProperty("detail", out var detailElement)
                ? detailElement.GetString()
                : null;
            throw new InvalidOperationException(detail ?? result.Stderr.Trim() ?? $"终止回复 CLI 退出码 {result.ExitCode}");
        }
    }

    private string ResolveCliPath()
    {
        var candidates = new[]
        {
            Path.Combine(_suiteRoot, "packages", "bridge-runtime", "dist", "active-reply-control-cli.mjs"),
            Path.Combine(_skillRoot, "dist", "active-reply-control-cli.mjs"),
        };
        return candidates.FirstOrDefault(File.Exists)
            ?? throw new InvalidOperationException($"未找到 active-reply-control-cli.mjs。已检查：{string.Join("；", candidates)}");
    }

    private static async Task<ScheduledTaskCliExecutionResult> ExecuteProcessAsync(ScheduledTaskCliInvocation invocation)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = invocation.FileName,
                WorkingDirectory = invocation.WorkingDirectory,
                UseShellExecute = false,
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
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(invocation.TimeoutMs);
        await process.WaitForExitAsync(timeout.Token);
        return new ScheduledTaskCliExecutionResult(process.ExitCode, await stdout, await stderr);
    }
}
