namespace ClaudeToImControlPanel;

internal sealed record BridgeRuntimeIdentitySnapshot(
    int Pid,
    string? RunId,
    string? StartedAt);

internal sealed record BridgeRestartReadinessInput(
    bool DaemonReportsRunning,
    bool BridgeProcessAlive,
    bool ProcessManagerAlive,
    BridgeRuntimeIdentitySnapshot StatusIdentity,
    BridgeRuntimeIdentitySnapshot AuditIdentity,
    BridgeRuntimeIdentitySnapshot? PreviousIdentity,
    string? LastHeartbeatAt,
    string? StatusLastExitReason,
    string? AuditLastExitReason,
    bool AuditHasUnhandledError,
    IReadOnlyCollection<string>? EnabledChannels,
    IReadOnlyDictionary<string, string?>? CallbackStates,
    DateTimeOffset ObservedAt);

internal sealed record BridgeRestartReadinessResult(bool Ready, string Reason);

internal static class BridgeRestartReadiness
{
    private static readonly TimeSpan MaxHeartbeatAge = TimeSpan.FromSeconds(30);
    // 本机语音 Runtime 和 Feishu WS 冷启动实测可在包装器返回后约 90 秒才
    // 完整 connected；窗口覆盖真实冷启动，同时保持有界失败。
    internal static readonly TimeSpan VerificationTimeout = TimeSpan.FromSeconds(120);

    public static BridgeRestartReadinessResult Evaluate(BridgeRestartReadinessInput input)
    {
        if (!input.ProcessManagerAlive)
        {
            return new(false, "Supervisor 或 Windows Service 尚未在线");
        }
        if (!input.DaemonReportsRunning || !input.BridgeProcessAlive || input.StatusIdentity.Pid <= 0)
        {
            return new(false, "Bridge 进程尚未在线");
        }
        if (input.AuditIdentity.Pid != input.StatusIdentity.Pid)
        {
            return new(false, "运行审计仍属于旧 Bridge 进程");
        }
        if (!string.IsNullOrWhiteSpace(input.StatusIdentity.RunId)
            && !string.Equals(input.StatusIdentity.RunId, input.AuditIdentity.RunId, StringComparison.Ordinal))
        {
            return new(false, "运行审计仍属于旧 Bridge 回合");
        }
        if (input.PreviousIdentity is { } previous)
        {
            if (previous.Pid > 0 && previous.Pid == input.StatusIdentity.Pid)
            {
                return new(false, "Bridge 仍是重启前的进程");
            }
            if (!string.IsNullOrWhiteSpace(previous.RunId)
                && string.Equals(previous.RunId, input.StatusIdentity.RunId, StringComparison.Ordinal))
            {
                return new(false, "Bridge 仍是重启前的运行回合");
            }
            if (DateTimeOffset.TryParse(previous.StartedAt, out var previousStartedAt))
            {
                if (!DateTimeOffset.TryParse(input.StatusIdentity.StartedAt, out var statusStartedAt)
                    || !DateTimeOffset.TryParse(input.AuditIdentity.StartedAt, out var auditStartedAt)
                    || statusStartedAt <= previousStartedAt
                    || auditStartedAt <= previousStartedAt)
                {
                    return new(false, "Bridge 启动时间尚未切换到新运行实例");
                }
            }
        }
        if (!string.IsNullOrWhiteSpace(input.StatusLastExitReason)
            || !string.IsNullOrWhiteSpace(input.AuditLastExitReason))
        {
            return new(false, "Bridge 新运行实例仍记录退出原因");
        }
        if (input.AuditHasUnhandledError)
        {
            return new(false, "Bridge 新运行实例存在未处理错误");
        }
        if (!DateTimeOffset.TryParse(input.LastHeartbeatAt, out var heartbeatAt)
            || heartbeatAt > input.ObservedAt.AddSeconds(5)
            || input.ObservedAt - heartbeatAt > MaxHeartbeatAge)
        {
            return new(false, "Bridge 心跳尚未恢复");
        }

        var callbackStates = input.CallbackStates
            ?? new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (var channel in input.EnabledChannels ?? Array.Empty<string>())
        {
            if (!callbackStates.TryGetValue(channel, out var state)) continue;
            if (!string.Equals(state, "connected", StringComparison.OrdinalIgnoreCase))
            {
                return new(false, $"{channel} 回调通道尚未在线（{state ?? "unknown"}）");
            }
        }

        return new(true, "Bridge、进程管理器和回调通道均已在线");
    }
}

internal static class BridgeRestartCommandPolicy
{
    public static bool IsAuthoritativeRejection(int exitCode, string? stdout, string? stderr)
    {
        var combined = $"{stdout}\n{stderr}";
        return exitCode is 12 or 13
            || combined.Contains("restart was postponed", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("Workflow drain script missing", StringComparison.OrdinalIgnoreCase);
    }

    public static string DescribeUnverifiedFailure(int exitCode, string? stdout, string? stderr)
    {
        var combined = $"{stdout}\n{stderr}";
        if (exitCode == 12 || combined.Contains("restart was postponed", StringComparison.OrdinalIgnoreCase))
        {
            return "Workflow 尚未安全收口，Bridge 重启已延期（workflow_drain_postponed）。";
        }
        if (exitCode == 13 || combined.Contains("Workflow drain script missing", StringComparison.OrdinalIgnoreCase))
        {
            return "Workflow drain 门禁不可用，Bridge 未执行重启（workflow_drain_gate_unavailable）。";
        }
        if (combined.Contains("Access is denied", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("拒绝访问", StringComparison.OrdinalIgnoreCase))
        {
            return "Bridge 重启包装器权限不足，且新运行实例未通过验证（bridge_restart_permission_denied）。";
        }
        var receipt = exitCode == -1 ? "包装器超时" : $"包装器退出码 {exitCode}";
        return $"Bridge {receipt}，且新运行实例未通过验证（bridge_restart_not_verified）。";
    }
}
