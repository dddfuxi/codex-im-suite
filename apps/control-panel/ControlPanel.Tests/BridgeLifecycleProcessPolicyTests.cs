using ClaudeToImControlPanel;
using Xunit;

namespace ControlPanel.Tests;

public sealed class BridgeLifecycleProcessPolicyTests
{
    [Theory]
    [InlineData("start")]
    [InlineData("restart")]
    [InlineData(" RESTART ")]
    public void PreservesDetachedServiceTreeForStartCommands(string action)
    {
        Assert.True(BridgeLifecycleProcessPolicy.PreserveManagedChildrenOnTimeout(action));
    }

    [Theory]
    [InlineData("stop")]
    [InlineData("status")]
    [InlineData("logs 120")]
    [InlineData("")]
    public void KeepsDefaultCleanupForOtherCommands(string action)
    {
        Assert.False(BridgeLifecycleProcessPolicy.PreserveManagedChildrenOnTimeout(action));
    }
}
