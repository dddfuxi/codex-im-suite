using Microsoft.AspNetCore.Http;
using Xunit;

namespace ClaudeToImControlPanel.Tests;

public sealed class ControlPanelWebCachePolicyTests
{
    [Fact]
    public void Apply_PreventsStalePanelBundlesAcrossLiveUpdates()
    {
        var context = new DefaultHttpContext();

        ControlPanelWebCachePolicy.Apply(context.Response);

        Assert.Equal(ControlPanelWebCachePolicy.CacheControlValue, context.Response.Headers.CacheControl);
        Assert.Equal("no-cache", context.Response.Headers.Pragma);
        Assert.Equal("0", context.Response.Headers.Expires);
    }
}
