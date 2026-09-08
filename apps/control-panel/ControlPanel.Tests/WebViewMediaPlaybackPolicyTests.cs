using ClaudeToImControlPanel;
using Xunit;

namespace ControlPanel.Tests;

public sealed class WebViewMediaPlaybackPolicyTests
{
    [Fact]
    public void EnablesDelayedUserInitiatedPreviewPlayback()
    {
        var options = WebViewMediaPlaybackPolicy.CreateEnvironmentOptions();

        Assert.Contains(
            WebViewMediaPlaybackPolicy.AutoplayBrowserArgument,
            options.AdditionalBrowserArguments,
            StringComparison.Ordinal);
    }
}
