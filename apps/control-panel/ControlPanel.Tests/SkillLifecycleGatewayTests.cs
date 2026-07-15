using System.Text;
using System.Text.Json;
using ClaudeToImControlPanel;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class SkillLifecycleGatewayTests
{
    [Theory]
    [InlineData("skill.registry.snapshot", "viewer")]
    [InlineData("skill.catalog.search", "viewer")]
    [InlineData("skill.draft.create", "operator")]
    [InlineData("skill.lifecycle.validate", "operator")]
    [InlineData("skill.lifecycle.prepareInstall", "owner")]
    [InlineData("skill.lifecycle.confirmInstall", "owner")]
    [InlineData("skill.lifecycle.enable", "owner")]
    [InlineData("skill.lifecycle.disable", "owner")]
    [InlineData("skill.lifecycle.rollback", "owner")]
    public void GetRequiredRole_UsesConfirmedSkillAutonomyBoundary(string command, string expectedRole)
    {
        Assert.Equal(expectedRole, SkillControlCommandPolicy.GetRequiredRole(command));
    }

    [Fact]
    public async Task RunAsync_InvokesRuntimeCliAndParsesJson()
    {
        using var fixture = new SkillGatewayFixture(includeDevelopmentCli: true, includeLiveCli: true);
        SkillCliInvocation? captured = null;
        var gateway = fixture.CreateGateway(invocation =>
        {
            captured = invocation;
            return Task.FromResult(new SkillCliExecutionResult(
                0,
                "{\"protocol\":\"cti-skill-registry/v1\",\"items\":[]}",
                ""));
        });

        using var snapshot = await gateway.RunAsync("snapshot", new Dictionary<string, string>());

        Assert.Equal("cti-skill-registry/v1", snapshot.RootElement.GetProperty("protocol").GetString());
        Assert.NotNull(captured);
        Assert.Equal("node", captured.FileName);
        Assert.Equal(fixture.DevelopmentCliPath, captured.Arguments[0]);
        Assert.Equal("snapshot", captured.Arguments[1]);
        Assert.Equal("--input-base64", captured.Arguments[2]);
        Assert.Equal("{}", DecodeInput(captured.Arguments[3]));
        Assert.Equal(fixture.CtiHome, captured.Environment["CTI_HOME"]);
        Assert.Equal(fixture.CodexHome, captured.Environment["CODEX_HOME"]);
    }

    [Fact]
    public async Task ReadSnapshotAsync_UsesRuntimeRegistryFileWithoutRepeatedCliExecution()
    {
        using var fixture = new SkillGatewayFixture(includeDevelopmentCli: true, includeLiveCli: false);
        fixture.WriteRegistry("{\"protocol\":\"cti-skill-registry/v1\",\"generatedAt\":\"2026-07-15T00:00:00.000Z\",\"items\":[{\"id\":\"installed\"}]}");
        var called = false;
        var gateway = fixture.CreateGateway(invocation =>
        {
            called = true;
            return Task.FromResult(new SkillCliExecutionResult(0, "{}", ""));
        });

        using var first = await gateway.ReadSnapshotAsync();
        using var second = await gateway.ReadSnapshotAsync();

        Assert.False(called);
        Assert.Equal("installed", first.RootElement.GetProperty("items")[0].GetProperty("id").GetString());
        Assert.Equal("installed", second.RootElement.GetProperty("items")[0].GetProperty("id").GetString());
    }

    [Fact]
    public async Task RunAsync_PreservesInputAsOneArgumentWithoutShellInterpolation()
    {
        using var fixture = new SkillGatewayFixture(includeDevelopmentCli: true, includeLiveCli: false);
        SkillCliInvocation? captured = null;
        var gateway = fixture.CreateGateway(invocation =>
        {
            captured = invocation;
            return Task.FromResult(new SkillCliExecutionResult(0, "[]", ""));
        });
        var query = "官方 skill'; Remove-Item C:\\\\important; #";

        using var _ = await gateway.RunAsync("search", new { query });

        Assert.NotNull(captured);
        Assert.False(captured.UseShellExecute);
        Assert.Equal(4, captured.Arguments.Count);
        Assert.Equal("search", captured.Arguments[1]);
        using var input = JsonDocument.Parse(DecodeInput(captured.Arguments[3]));
        Assert.Equal(query, input.RootElement.GetProperty("query").GetString());
    }

    [Fact]
    public async Task RunAsync_UsesLiveCliWhenDevelopmentArtifactIsUnavailable()
    {
        using var fixture = new SkillGatewayFixture(includeDevelopmentCli: false, includeLiveCli: true);
        SkillCliInvocation? captured = null;
        var gateway = fixture.CreateGateway(invocation =>
        {
            captured = invocation;
            return Task.FromResult(new SkillCliExecutionResult(0, "{}", ""));
        });

        using var _ = await gateway.RunAsync("snapshot", null);

        Assert.NotNull(captured);
        Assert.Equal(fixture.LiveCliPath, captured.Arguments[0]);
    }

    [Fact]
    public async Task RunAsync_RejectsMissingCliBeforeStartingProcess()
    {
        using var fixture = new SkillGatewayFixture(includeDevelopmentCli: false, includeLiveCli: false);
        var called = false;
        var gateway = fixture.CreateGateway(invocation =>
        {
            called = true;
            return Task.FromResult(new SkillCliExecutionResult(0, "{}", ""));
        });

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => gateway.RunAsync("snapshot", null));

        Assert.False(called);
        Assert.Contains("skill-lifecycle-cli.mjs", error.Message);
    }

    [Fact]
    public async Task RunAsync_ReportsNonZeroExitCode()
    {
        using var fixture = new SkillGatewayFixture(includeDevelopmentCli: true, includeLiveCli: false);
        var gateway = fixture.CreateGateway(_ => Task.FromResult(new SkillCliExecutionResult(2, "", "审批已过期")));

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => gateway.RunAsync("confirm-install", new { nonce = "expired" }));

        Assert.Contains("审批已过期", error.Message);
        Assert.Contains("退出码 2", error.Message);
    }

    [Fact]
    public async Task RunAsync_RejectsInvalidJsonOutput()
    {
        using var fixture = new SkillGatewayFixture(includeDevelopmentCli: true, includeLiveCli: false);
        var gateway = fixture.CreateGateway(_ => Task.FromResult(new SkillCliExecutionResult(0, "not-json", "")));

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => gateway.RunAsync("snapshot", null));

        Assert.Contains("合法 JSON", error.Message);
    }

    private static string DecodeInput(string value)
        => Encoding.UTF8.GetString(Convert.FromBase64String(value));

    private sealed class SkillGatewayFixture : IDisposable
    {
        public SkillGatewayFixture(bool includeDevelopmentCli, bool includeLiveCli)
        {
            Root = Path.Combine(Path.GetTempPath(), $"skill-lifecycle-gateway-{Guid.NewGuid():N}");
            SuiteRoot = Path.Combine(Root, "suite");
            SkillDir = Path.Combine(Root, "live-skill");
            CtiHome = Path.Combine(Root, "cti-home");
            CodexHome = Path.Combine(Root, "codex-home");
            DevelopmentCliPath = Path.Combine(SuiteRoot, "packages", "bridge-runtime", "dist", "skill-lifecycle-cli.mjs");
            LiveCliPath = Path.Combine(SkillDir, "dist", "skill-lifecycle-cli.mjs");
            Directory.CreateDirectory(CtiHome);
            Directory.CreateDirectory(CodexHome);
            if (includeDevelopmentCli) WriteCli(DevelopmentCliPath);
            if (includeLiveCli) WriteCli(LiveCliPath);
        }

        public string Root { get; }
        public string SuiteRoot { get; }
        public string SkillDir { get; }
        public string CtiHome { get; }
        public string CodexHome { get; }
        public string DevelopmentCliPath { get; }
        public string LiveCliPath { get; }
        public string RegistryPath => Path.Combine(CtiHome, "data", "skill-registry.json");

        public SkillLifecycleGateway CreateGateway(SkillCliCommandExecutor executor)
            => new(SuiteRoot, SkillDir, CtiHome, CodexHome, executor, "node");

        public void Dispose()
        {
            if (Directory.Exists(Root)) Directory.Delete(Root, recursive: true);
        }

        public void WriteRegistry(string json)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(RegistryPath)!);
            File.WriteAllText(RegistryPath, json, new UTF8Encoding(false));
        }

        private static void WriteCli(string path)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, "// fixture", new UTF8Encoding(false));
        }
    }
}
