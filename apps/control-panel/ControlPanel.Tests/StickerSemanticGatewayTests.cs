using System.Text;
using ClaudeToImControlPanel;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class StickerSemanticGatewayTests
{
    private const string BaseHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public async Task Gateway_DelegatesMutationToRuntimeCli()
    {
        using var fixture = new Fixture();
        StickerSemanticCliInvocation? captured = null;
        var gateway = fixture.CreateGateway(invocation =>
        {
            captured = invocation;
            return Task.FromResult(new StickerSemanticCliExecutionResult(0, "{\"ok\":true,\"data\":{\"revision\":{\"status\":\"confirmed\"}}}", ""));
        });

        using var result = await gateway.RunAsync("accept-revision", new { revisionId = "revision-1", expectedBaseHash = BaseHash });

        Assert.Equal("confirmed", result.RootElement.GetProperty("data").GetProperty("revision").GetProperty("status").GetString());
        Assert.NotNull(captured);
        Assert.Equal(
            [fixture.CliPath, "accept-revision", "revision-1", "--expected-base-hash", BaseHash, "--memory-root", fixture.MemoryRoot],
            captured.Arguments);
        Assert.False(captured.UseShellExecute);
    }

    [Fact]
    public async Task Gateway_EncodesManualPayloadAsUtf8JsonAndRejectsPaths()
    {
        using var fixture = new Fixture();
        StickerSemanticCliInvocation? captured = null;
        var gateway = fixture.CreateGateway(invocation =>
        {
            captured = invocation;
            return Task.FromResult(new StickerSemanticCliExecutionResult(0, "{\"ok\":true,\"data\":{}}", ""));
        });

        using var result = await gateway.RunAsync("update-manual", new
        {
            fileKey = "file-1",
            expectedBaseHash = BaseHash,
            patch = new { usage = "用于庆祝" },
        });
        Assert.True(result.RootElement.GetProperty("ok").GetBoolean());
        Assert.NotNull(captured);
        var encodedIndex = captured.Arguments.ToList().IndexOf("--payload-base64") + 1;
        Assert.True(encodedIndex > 0);
        Assert.Contains("用于庆祝", Encoding.UTF8.GetString(Convert.FromBase64String(captured.Arguments[encodedIndex])));

        await Assert.ThrowsAsync<InvalidOperationException>(() => gateway.RunAsync("update-manual", new
        {
            fileKey = "file-1",
            expectedBaseHash = BaseHash,
            path = "C:\\outside\\stickers.json",
        }));
    }

    private sealed class Fixture : IDisposable
    {
        public Fixture()
        {
            Root = Path.Combine(Path.GetTempPath(), $"sticker-semantic-gateway-{Guid.NewGuid():N}");
            SuiteRoot = Path.Combine(Root, "suite");
            SkillRoot = Path.Combine(Root, "live");
            CtiHome = Path.Combine(Root, "cti-home");
            MemoryRoot = Path.Combine(Root, "记忆仓库");
            CliPath = Path.Combine(SuiteRoot, "packages", "bridge-runtime", "dist", "sticker-semantic-cli.mjs");
            Directory.CreateDirectory(Path.GetDirectoryName(CliPath)!);
            Directory.CreateDirectory(MemoryRoot);
            File.WriteAllText(CliPath, "// fixture", new UTF8Encoding(false));
        }

        public string Root { get; }
        public string SuiteRoot { get; }
        public string SkillRoot { get; }
        public string CtiHome { get; }
        public string MemoryRoot { get; }
        public string CliPath { get; }

        public StickerSemanticGateway CreateGateway(StickerSemanticCliCommandExecutor executor)
            => new(SuiteRoot, SkillRoot, CtiHome, MemoryRoot, executor, "node");

        public void Dispose()
        {
            if (Directory.Exists(Root)) Directory.Delete(Root, true);
        }
    }
}
