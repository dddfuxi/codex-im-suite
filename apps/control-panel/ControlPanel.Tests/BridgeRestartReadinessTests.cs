using ClaudeToImControlPanel;
using Xunit;

namespace ControlPanel.Tests;

public sealed class BridgeRestartReadinessTests
{
    private static readonly DateTimeOffset Now = new(2026, 8, 1, 10, 30, 0, TimeSpan.Zero);

    [Fact]
    public void VerificationWindowCoversObservedColdStartWithoutBecomingUnbounded()
    {
        Assert.True(BridgeRestartReadiness.VerificationTimeout >= TimeSpan.FromSeconds(100));
        Assert.True(BridgeRestartReadiness.VerificationTimeout <= TimeSpan.FromMinutes(3));
    }

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
        var stalePid = BridgeRestartReadiness.Evaluate(HealthyInput() with
        {
            AuditIdentity = HealthyInput().AuditIdentity with { Pid = 99 },
        });
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
    public void RequiresANewRuntimeIdentityAfterRestart()
    {
        var unchangedPid = BridgeRestartReadiness.Evaluate(HealthyInput() with
        {
            StatusIdentity = HealthyInput().StatusIdentity with { Pid = 17200 },
            AuditIdentity = HealthyInput().AuditIdentity with { Pid = 17200 },
        });
        var unchangedRun = BridgeRestartReadiness.Evaluate(HealthyInput() with
        {
            StatusIdentity = HealthyInput().StatusIdentity with { RunId = "run-old" },
            AuditIdentity = HealthyInput().AuditIdentity with { RunId = "run-old" },
        });

        Assert.False(unchangedPid.Ready);
        Assert.Contains("重启前", unchangedPid.Reason);
        Assert.False(unchangedRun.Ready);
        Assert.Contains("重启前", unchangedRun.Reason);
    }

    [Theory]
    [InlineData("fatal", null, false, "退出原因")]
    [InlineData(null, "uncaughtException", false, "退出原因")]
    [InlineData(null, null, true, "未处理错误")]
    public void RejectsRuntimeErrorResidue(
        string? statusExitReason,
        string? auditExitReason,
        bool hasUnhandledError,
        string expected)
    {
        var result = BridgeRestartReadiness.Evaluate(HealthyInput() with
        {
            StatusLastExitReason = statusExitReason,
            AuditLastExitReason = auditExitReason,
            AuditHasUnhandledError = hasUnhandledError,
        });

        Assert.False(result.Ready);
        Assert.Contains(expected, result.Reason);
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

    [Fact]
    public void WrapperExitOneCanBeVerifiedWithoutBeingAnAuthoritativeRejection()
    {
        Assert.False(BridgeRestartCommandPolicy.IsAuthoritativeRejection(1, "", ""));
        Assert.Contains(
            "bridge_restart_not_verified",
            BridgeRestartCommandPolicy.DescribeUnverifiedFailure(1, "", ""));
    }

    [Theory]
    [InlineData(12, "", "")]
    [InlineData(1, "", "Workflow drain timed out; Bridge restart was postponed.")]
    public void DrainPostponementAlwaysRemainsAFailure(int exitCode, string stdout, string stderr)
    {
        Assert.True(BridgeRestartCommandPolicy.IsAuthoritativeRejection(exitCode, stdout, stderr));
        Assert.Contains(
            "workflow_drain_postponed",
            BridgeRestartCommandPolicy.DescribeUnverifiedFailure(exitCode, stdout, stderr));
    }

    private static BridgeRestartReadinessInput HealthyInput()
        => new(
            DaemonReportsRunning: true,
            BridgeProcessAlive: true,
            ProcessManagerAlive: true,
            StatusIdentity: new BridgeRuntimeIdentitySnapshot(18400, "run-new", Now.AddSeconds(-5).ToString("O")),
            AuditIdentity: new BridgeRuntimeIdentitySnapshot(18400, "run-new", Now.AddSeconds(-5).ToString("O")),
            PreviousIdentity: new BridgeRuntimeIdentitySnapshot(17200, "run-old", Now.AddMinutes(-10).ToString("O")),
            LastHeartbeatAt: Now.AddSeconds(-2).ToString("O"),
            StatusLastExitReason: null,
            AuditLastExitReason: null,
            AuditHasUnhandledError: false,
            EnabledChannels: ["feishu"],
            CallbackStates: new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
            {
                ["feishu"] = "connected",
            },
            ObservedAt: Now);
}
