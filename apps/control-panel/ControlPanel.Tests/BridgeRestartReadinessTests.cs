using ClaudeToImControlPanel;
using Xunit;

namespace ControlPanel.Tests;

public sealed class BridgeRestartReadinessTests
{
    private static readonly DateTimeOffset Now = new(2026, 8, 1, 10, 30, 0, TimeSpan.Zero);

    [Fact]
    public void RequiresProcessManagerAndBridge()
    {
        var missingSupervisor = BridgeRestartReadiness.Evaluate(HealthyInput() with { ProcessManagerAlive = false });
        var missingBridge = BridgeRestartReadiness.Evaluate(HealthyInput() with { BridgeProcessAlive = false });

        Assert.False(missingSupervisor.Ready);
        Assert.Contains("Supervisor", missingSupervisor.Reason);
        Assert.False(missingBridge.Ready);
        Assert.Contains("Bridge", missingBridge.Reason);
    }

    [Fact]
    public void RejectsStaleAuditAndHeartbeat()
    {
        var stalePid = BridgeRestartReadiness.Evaluate(HealthyInput() with { AuditPid = 99 });
        var staleHeartbeat = BridgeRestartReadiness.Evaluate(HealthyInput() with
        {
            LastHeartbeatAt = Now.AddMinutes(-2).ToString("O"),
        });

        Assert.False(stalePid.Ready);
        Assert.Contains("旧 Bridge", stalePid.Reason);
        Assert.False(staleHeartbeat.Ready);
        Assert.Contains("心跳", staleHeartbeat.Reason);
    }

    [Fact]
    public void WaitsForKnownEnabledCallbackChannels()
    {
        var starting = BridgeRestartReadiness.Evaluate(HealthyInput() with
        {
            CallbackStates = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
            {
                ["feishu"] = "starting",
            },
        });
        var connected = BridgeRestartReadiness.Evaluate(HealthyInput());

        Assert.False(starting.Ready);
        Assert.Contains("feishu 回调通道", starting.Reason);
        Assert.True(connected.Ready);
    }

    [Fact]
    public void IgnoresChannelsWithoutAnAuditedCallbackState()
    {
        var result = BridgeRestartReadiness.Evaluate(HealthyInput() with
        {
            EnabledChannels = ["feishu", "telegram"],
        });

        Assert.True(result.Ready);
    }

    private static BridgeRestartReadinessInput HealthyInput()
        => new(
            DaemonReportsRunning: true,
            BridgeProcessAlive: true,
            ProcessManagerAlive: true,
            StatusPid: 18400,
            AuditPid: 18400,
            StatusRunId: "run-new",
            AuditRunId: "run-new",
            LastHeartbeatAt: Now.AddSeconds(-2).ToString("O"),
            EnabledChannels: ["feishu"],
            CallbackStates: new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
            {
                ["feishu"] = "connected",
            },
            ObservedAt: Now);
}
