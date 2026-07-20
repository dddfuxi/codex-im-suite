using System.Text;
using ClaudeToImControlPanel;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class MemoryItemGatewayTests
{
    private const string ItemId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string OtherItemId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string ArchiveId = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string BaseHash = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    [Fact]
    public async Task ListsCandidatesThroughRuntimeCli()
    {
        using var fixture = new MemoryItemGatewayFixture();
        MemoryItemCliInvocation? captured = null;
        var gateway = fixture.CreateGateway(invocation =>
        {
            captured = invocation;
            return Task.FromResult(new MemoryItemCliExecutionResult(0, "{\"ok\":true,\"data\":{\"items\":[]}}", ""));
        });

        using var result = await gateway.RunAsync("list-candidates", new { });

        Assert.True(result.RootElement.GetProperty("ok").GetBoolean());
        Assert.NotNull(captured);
        Assert.Equal(fixture.DevelopmentCliPath, captured.Arguments[0]);
        Assert.Equal("list-candidates", captured.Arguments[1]);
        Assert.Equal(["--memory-root", fixture.MemoryRoot], captured.Arguments.Skip(2).ToArray());
        Assert.Equal(fixture.CtiHome, captured.Environment["CTI_HOME"]);
        Assert.False(captured.UseShellExecute);
    }

    [Fact]
    public async Task MapsOpaqueIdsAndExpectedBaseHashWithoutShellStrings()
    {
        using var fixture = new MemoryItemGatewayFixture();
        MemoryItemCliInvocation? captured = null;
        var gateway = fixture.CreateGateway(invocation =>
        {
            captured = invocation;
            return Task.FromResult(new MemoryItemCliExecutionResult(0, "{\"ok\":true,\"data\":{}}", ""));
        });

        using var result = await gateway.RunAsync("confirm", new { itemId = ItemId, expectedBaseHash = BaseHash, key = "工作区规则" });

        Assert.True(result.RootElement.GetProperty("ok").GetBoolean());
        Assert.NotNull(captured);
        Assert.Equal(
            [fixture.DevelopmentCliPath, "confirm", ItemId, "--expected-base-hash", BaseHash, "--key", "工作区规则", "--memory-root", fixture.MemoryRoot],
            captured.Arguments);
    }

    [Fact]
    public async Task EncodesOnlyReviewedBatchIdsAsUtf8Json()
    {
        using var fixture = new MemoryItemGatewayFixture();
        MemoryItemCliInvocation? captured = null;
        var gateway = fixture.CreateGateway(invocation =>
        {
            captured = invocation;
            return Task.FromResult(new MemoryItemCliExecutionResult(0, "{\"ok\":true,\"data\":{\"archived\":[]}}", ""));
        });

        using var result = await gateway.RunAsync("archive-candidates", new { itemIds = new[] { ItemId, OtherItemId } });

        Assert.True(result.RootElement.GetProperty("ok").GetBoolean());
        Assert.NotNull(captured);
        var encodedIndex = captured.Arguments.ToList().IndexOf("--ids-base64") + 1;
        Assert.True(encodedIndex > 0);
        Assert.Equal($"[\"{ItemId}\",\"{OtherItemId}\"]", Encoding.UTF8.GetString(Convert.FromBase64String(captured.Arguments[encodedIndex])));
    }

    [Theory]
    [InlineData("restore")]
    [InlineData("delete-archive")]
    public async Task RejectsArbitraryArchivePaths(string command)
    {
        using var fixture = new MemoryItemGatewayFixture();
        var gateway = fixture.CreateGateway(_ => throw new InvalidOperationException("executor should not run"));

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            gateway.RunAsync(command, new { archiveId = ArchiveId, path = "C:\\outside\\x.json" }));
    }

    private sealed class MemoryItemGatewayFixture : IDisposable
    {
        public MemoryItemGatewayFixture()
        {
            Root = Path.Combine(Path.GetTempPath(), $"memory-item-gateway-{Guid.NewGuid():N}");
            SuiteRoot = Path.Combine(Root, "suite");
            SkillRoot = Path.Combine(Root, "live-skill");
            CtiHome = Path.Combine(Root, "cti-home");
            MemoryRoot = Path.Combine(Root, "记忆仓库");
            DevelopmentCliPath = Path.Combine(SuiteRoot, "packages", "bridge-runtime", "dist", "memory-item-cli.mjs");
            Directory.CreateDirectory(Path.GetDirectoryName(DevelopmentCliPath)!);
            Directory.CreateDirectory(MemoryRoot);
            File.WriteAllText(DevelopmentCliPath, "// fixture", new UTF8Encoding(false));
        }

        public string Root { get; }
        public string SuiteRoot { get; }
        public string SkillRoot { get; }
        public string CtiHome { get; }
        public string MemoryRoot { get; }
        public string DevelopmentCliPath { get; }

        public MemoryItemGateway CreateGateway(MemoryItemCliCommandExecutor executor)
            => new(SuiteRoot, SkillRoot, CtiHome, MemoryRoot, executor, "node");

        public void Dispose()
        {
            if (Directory.Exists(Root)) Directory.Delete(Root, true);
        }
    }
}
