using Xunit;

namespace ClaudeToImControlPanel.Tests;

public sealed class AgentCollaborationModePolicyTests
{
    [Theory]
    [InlineData("off", "off")]
    [InlineData(" Shadow ", "shadow")]
    [InlineData("ASSIST", "assist")]
    public void Normalize_AcceptsOnlySupportedModes(string input, string expected)
    {
        Assert.Equal(expected, AgentCollaborationModePolicy.Normalize(input));
    }

    [Theory]
    [InlineData("")]
    [InlineData("on")]
    [InlineData("enabled")]
    public void Normalize_RejectsAmbiguousOrUnknownModes(string input)
    {
        Assert.Throws<InvalidOperationException>(() => AgentCollaborationModePolicy.Normalize(input));
    }
}
