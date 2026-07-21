using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class CodexModelSettingsSupportTests
{
    [Theory]
    [InlineData("", false)]
    [InlineData("   ", false)]
    [InlineData("gpt-5.4", true)]
    public void ShouldPassModel_IsDerivedFromModelText(string model, bool expected)
    {
        Assert.Equal(expected, ClaudeToImControlPanel.CodexModelSettingsSupport.ShouldPassModel(model));
    }

    [Fact]
    public void BuildLoadedSummary_DoesNotClaimProviderConfirmation()
    {
        var summary = ClaudeToImControlPanel.CodexModelSettingsSupport.BuildLoadedSummary(
            "official",
            "gpt-5.4",
            "xhigh");

        Assert.Contains("Bridge 已加载", summary);
        Assert.Contains("gpt-5.4", summary);
        Assert.Contains("xhigh", summary);
        Assert.DoesNotContain("服务端已确认", summary);
    }
}
