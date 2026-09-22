using ClaudeToImControlPanel;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class ActiveReplyGatewayTests
{
    [Fact]
    public void Policy_RequiresOperator()
        => Assert.Equal("operator", ActiveReplyCommandPolicy.GetRequiredRole("workflow.cancelActiveReply"));

    [Fact]
    public async Task CancelAsync_InvokesRuntimeCliWithControlledRunId()
    {
        var root = Path.Combine(Path.GetTempPath(), $"active-reply-gateway-{Guid.NewGuid():N}");
        var suiteRoot = Path.Combine(root, "suite");
        var skillRoot = Path.Combine(root, "live");
        var ctiHome = Path.Combine(root, "cti");
        var cliPath = Path.Combine(suiteRoot, "packages", "bridge-runtime", "dist", "active-reply-control-cli.mjs");
        Directory.CreateDirectory(Path.GetDirectoryName(cliPath)!);
        File.WriteAllText(cliPath, "// fixture");
        try
        {
            ScheduledTaskCliInvocation? captured = null;
            var gateway = new ActiveReplyGateway(suiteRoot, skillRoot, ctiHome, invocation =>
            {
                captured = invocation;
                return Task.FromResult(new ScheduledTaskCliExecutionResult(0, "{\"ok\":true,\"disposition\":\"accepted\"}", ""));
            });
            using var result = await gateway.CancelAsync("run-123");
            Assert.True(result.RootElement.GetProperty("ok").GetBoolean());
            Assert.NotNull(captured);
            Assert.Equal(new[] { cliPath, "cancel", "run-123", "--json" }, captured.Arguments);
            Assert.Equal(ctiHome, captured.Environment["CTI_HOME"]);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }
}
