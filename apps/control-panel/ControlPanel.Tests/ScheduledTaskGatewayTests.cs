using ClaudeToImControlPanel;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class ScheduledTaskGatewayTests
{
    [Theory]
    [InlineData("scheduledTasks.list", "operator")]
    [InlineData("scheduledTasks.get", "operator")]
    [InlineData("scheduledTasks.pause", "operator")]
    [InlineData("scheduledTasks.resume", "operator")]
    [InlineData("scheduledTasks.runNow", "operator")]
    [InlineData("scheduledTasks.history", "operator")]
    [InlineData("scheduledTasks.cancelRun", "owner")]
    [InlineData("scheduledTasks.delete", "owner")]
    [InlineData("scheduledTasks.retryDelivery", "owner")]
    public void Policy_UsesExplicitScheduledTaskRoles(string command, string expected)
        => Assert.Equal(expected, ScheduledTaskCommandPolicy.GetRequiredRole(command));

    [Fact]
    public async Task RunAsync_InvokesOfficialBundleWithUtf8Arguments()
    {
        using var fixture = new ScheduledTaskGatewayFixture();
        ScheduledTaskCliInvocation? captured = null;
        var gateway = fixture.CreateGateway(invocation =>
        {
            captured = invocation;
            return Task.FromResult(new ScheduledTaskCliExecutionResult(0, "{\"tasks\":[]}", ""));
        });

        using var result = await gateway.RunAsync("list", new { });

        Assert.Equal(0, result.RootElement.GetProperty("tasks").GetArrayLength());
        Assert.NotNull(captured);
        Assert.Equal(fixture.DevelopmentCliPath, captured.Arguments[0]);
        Assert.Equal("list", captured.Arguments[1]);
        Assert.Equal("--json", captured.Arguments[^1]);
        Assert.Equal(fixture.CtiHome, captured.Environment["CTI_HOME"]);
        Assert.False(captured.UseShellExecute);
    }

    [Fact]
    public async Task ReadPanelStateAsync_CombinesStatusAndTaskItems()
    {
        using var fixture = new ScheduledTaskGatewayFixture();
        var gateway = fixture.CreateGateway(invocation =>
        {
            var command = invocation.Arguments[1];
            var stdout = command == "status"
                ? "{\"counts\":{\"total\":1},\"capabilities\":{\"runNow\":false}}"
                : "{\"items\":[{\"task\":{\"id\":\"task_001\"},\"state\":{\"taskId\":\"task_001\"}}]}";
            return Task.FromResult(new ScheduledTaskCliExecutionResult(0, stdout, ""));
        });

        var snapshot = await gateway.ReadPanelStateAsync();

        Assert.True(snapshot.Available);
        Assert.Equal(1, snapshot.Status.GetProperty("counts").GetProperty("total").GetInt32());
        Assert.Equal("task_001", snapshot.Items[0].GetProperty("task").GetProperty("id").GetString());
    }

    [Fact]
    public async Task ReadPanelStateAsync_FailsClosedWithoutInventingCapabilities()
    {
        using var fixture = new ScheduledTaskGatewayFixture();
        var gateway = fixture.CreateGateway(_ => Task.FromResult(new ScheduledTaskCliExecutionResult(1, "", "store unavailable")));

        var snapshot = await gateway.ReadPanelStateAsync();

        Assert.False(snapshot.Available);
        Assert.Contains("store unavailable", snapshot.Error);
        Assert.Empty(snapshot.Items);
    }

    private sealed class ScheduledTaskGatewayFixture : IDisposable
    {
        public ScheduledTaskGatewayFixture()
        {
            Root = Path.Combine(Path.GetTempPath(), $"scheduled-task-gateway-{Guid.NewGuid():N}");
            SuiteRoot = Path.Combine(Root, "suite");
            SkillRoot = Path.Combine(Root, "live-skill");
            CtiHome = Path.Combine(Root, "cti-home");
            DevelopmentCliPath = Path.Combine(SuiteRoot, "packages", "bridge-runtime", "dist", "scheduled-task-cli.mjs");
            Directory.CreateDirectory(Path.GetDirectoryName(DevelopmentCliPath)!);
            File.WriteAllText(DevelopmentCliPath, "// fixture");
        }

        public string Root { get; }
        public string SuiteRoot { get; }
        public string SkillRoot { get; }
        public string CtiHome { get; }
        public string DevelopmentCliPath { get; }

        public ScheduledTaskGateway CreateGateway(ScheduledTaskCliCommandExecutor executor)
            => new(SuiteRoot, SkillRoot, CtiHome, executor, "node");

        public void Dispose()
        {
            if (Directory.Exists(Root)) Directory.Delete(Root, true);
        }
    }
}
