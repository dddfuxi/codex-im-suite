using ClaudeToImControlPanel;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class CodexModelCatalogGatewayTests
{
    [Fact]
    public async Task DiscoverAsync_UsesRuntimeCliAndReturnsAllowlistedCatalog()
    {
        using var fixture = new Fixture();
        CodexModelCatalogCliInvocation? captured = null;
        var gateway = fixture.CreateGateway(invocation =>
        {
            captured = invocation;
            return Task.FromResult(new CodexModelCatalogCliExecutionResult(0, """
                {"protocol":"cti-codex-model-catalog/v1","generatedAt":"2026-09-20T00:00:00Z","status":"ready","source":"openai_compatible","models":[{"id":"gpt-6-astra","displayName":"GPT-6 Astra","hidden":false,"isDefault":true,"inputModalities":[],"defaultReasoningEffort":"low","supportedReasoningEfforts":["low"]}],"configuredModel":"gpt-6-astra","error":""}
                """, ""));
        });

        var result = await gateway.DiscoverAsync(new { source = "external_api", localKind = "custom" }, "gpt-6-astra", "external_api");

        Assert.Equal("openai_compatible", result.Source);
        Assert.Equal("gpt-6-astra", result.Models[0].Id);
        Assert.NotNull(captured);
        Assert.Equal(fixture.DevelopmentCliPath, captured!.Arguments[0]);
        Assert.Equal("--input-json", captured.Arguments[1]);
        Assert.Equal(fixture.CtiHome, captured.Environment["CTI_HOME"]);
        Assert.DoesNotContain("apiKey", captured.Arguments[^1], StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task DiscoverAsync_FailsClosedWithStableErrorWhenRuntimeCliFails()
    {
        using var fixture = new Fixture();
        var gateway = fixture.CreateGateway(_ => Task.FromResult(new CodexModelCatalogCliExecutionResult(1, "", $"secret path {fixture.Root}")));

        var result = await gateway.DiscoverAsync(null, "gpt-6-astra", "external_api");

        Assert.Equal("error", result.Status);
        Assert.Empty(result.Models);
        Assert.DoesNotContain(fixture.Root, result.Error, StringComparison.Ordinal);
    }

    private sealed class Fixture : IDisposable
    {
        public Fixture()
        {
            Root = Path.Combine(Path.GetTempPath(), $"codex-model-catalog-{Guid.NewGuid():N}");
            SuiteRoot = Path.Combine(Root, "suite");
            SkillRoot = Path.Combine(Root, "live-skill");
            CtiHome = Path.Combine(Root, "cti-home");
            DevelopmentCliPath = Path.Combine(SuiteRoot, "packages", "bridge-runtime", "dist", "codex-model-catalog-cli.mjs");
            Directory.CreateDirectory(Path.GetDirectoryName(DevelopmentCliPath)!);
            File.WriteAllText(DevelopmentCliPath, "// fixture");
        }

        public string Root { get; }
        public string SuiteRoot { get; }
        public string SkillRoot { get; }
        public string CtiHome { get; }
        public string DevelopmentCliPath { get; }

        public CodexModelCatalogGateway CreateGateway(CodexModelCatalogCliCommandExecutor executor)
            => new(SuiteRoot, SkillRoot, CtiHome, executor, "node");

        public void Dispose()
        {
            if (Directory.Exists(Root)) Directory.Delete(Root, true);
        }
    }
}
