using System.Text.Json;
using Xunit;

namespace ClaudeToImControlPanel.Tests;

public sealed class ControlPanelJsonBoundaryTests
{
    [Fact]
    public void ParseObject_ReplacesUnpairedSurrogateEscapesWithoutDroppingRecord()
    {
        const string raw = """
            {"runs":[{"promptPreview":"国旗 \ud83c","status":"succeeded"}]}
            """;

        var parsed = ControlPanelJsonBoundary.ParseObject(raw, out var replacements);

        Assert.Equal(1, replacements);
        Assert.Equal("国旗 \uFFFD", parsed?["runs"]?[0]?["promptPreview"]?.GetValue<string>());
        Assert.Equal("succeeded", parsed?["runs"]?[0]?["status"]?.GetValue<string>());
        _ = JsonSerializer.Serialize(parsed);
    }

    [Fact]
    public void SanitizeMalformedUnicodeEscapes_PreservesValidEmojiChineseAndEscapedLiteral()
    {
        const string raw = """
            {"emoji":"🇨🇳","escaped":"\ud83c\uddf3","literal":"\\ud83c","text":"中文"}
            """;

        var result = ControlPanelJsonBoundary.SanitizeMalformedUnicodeEscapes(raw);

        Assert.Equal(0, result.ReplacementCount);
        Assert.Equal(raw, result.Text);
        using var parsed = JsonDocument.Parse(result.Text);
        Assert.Equal("🇨🇳", parsed.RootElement.GetProperty("emoji").GetString());
        Assert.Equal("\\ud83c", parsed.RootElement.GetProperty("literal").GetString());
    }

    [Fact]
    public void ParseObject_ReplacesOrphanLowSurrogateAndRawHighSurrogate()
    {
        var raw = "{\"low\":\"\\uddf3\",\"high\":\"" + '\ud83c' + "\"}";

        var parsed = ControlPanelJsonBoundary.ParseObject(raw, out var replacements);

        Assert.Equal(2, replacements);
        Assert.Equal("\uFFFD", parsed?["low"]?.GetValue<string>());
        Assert.Equal("\uFFFD", parsed?["high"]?.GetValue<string>());
    }
}
