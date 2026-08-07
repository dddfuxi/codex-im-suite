namespace ClaudeToImControlPanel;

internal sealed record BridgeRestartReadinessInput(
    bool DaemonReportsRunning,
    bool BridgeProcessAlive,
    bool ProcessManagerAlive,
    int StatusPid,
    int AuditPid,
    string? StatusRunId,
    string? AuditRunId,
    string? LastHeartbeatAt,
    IReadOnlyCollection<string>? EnabledChannels,
    IReadOnlyDictionary<string, string?>? CallbackStates,
    DateTimeOffset ObservedAt);

internal sealed record BridgeRestartReadinessResult(bool Ready, string Reason);

internal static class BridgeRestartReadiness
{
    private static readonly TimeSpan MaxHeartbeatAge = TimeSpan.FromSeconds(30);

    public static BridgeRestartReadinessResult Evaluate(BridgeRestartReadinessInput input)
    {
        if (!input.ProcessManagerAlive)
        {
            return new(false, "Supervisor 或 Windows Service 尚未在线");
        }
        if (!input.DaemonReportsRunning || !input.BridgeProcessAlive || input.StatusPid <= 0)
        {
            return new(false, "Bridge 进程尚未在线");
        }
        if (input.AuditPid != input.StatusPid)
        {
            return new(false, "运行审计仍属于旧 Bridge 进程");
        }
        if (!string.IsNullOrWhiteSpace(input.StatusRunId)
            && !string.Equals(input.StatusRunId, input.AuditRunId, StringComparison.Ordinal))
        {
            return new(false, "运行审计仍属于旧 Bridge 回合");
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
