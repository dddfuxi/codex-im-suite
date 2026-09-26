using ClaudeToImControlPanel;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class ModelUsageGatewayTests
{
    [Fact]
    public async Task Snapshot_UsesRuntimeCliAndReturnsControlledFields()
    {
        var root = Path.Combine(Path.GetTempPath(), $"usage-gateway-{Guid.NewGuid():N}");
        var suiteRoot = Path.Combine(root, "suite");
        var ctiHome = Path.Combine(root, "cti");
        var cliPath = Path.Combine(suiteRoot, "packages", "bridge-runtime", "dist", "usage-control.mjs");
        Directory.CreateDirectory(Path.GetDirectoryName(cliPath)!);
        File.WriteAllText(cliPath, "// fixture");
        ModelUsageCliInvocation? captured = null;
        try
        {
            var gateway = new ModelUsageGateway(suiteRoot, Path.Combine(root, "live"), ctiHome, invocation =>
            {
                captured = invocation;
                return Task.FromResult(new ModelUsageCliExecutionResult(0, FixtureJson, "ignored stderr"));
            });
            var snapshot = await gateway.ReadPanelStateAsync();
            Assert.Equal("cti-model-usage-snapshot/v1", snapshot.Protocol);
            Assert.Null(snapshot.Status);
            Assert.NotNull(snapshot.Summary);
            Assert.Single(snapshot.Records);
            Assert.Equal("jev", snapshot.Records[0].Provider);
            Assert.Equal(new[] { cliPath, "snapshot", "--json" }, captured!.Arguments);
            Assert.Equal(ctiHome, captured.Environment["CTI_HOME"]);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }

    [Fact]
    public async Task InvalidPayloadFailsClosedWithoutRawError()
    {
        var root = CreateFixtureRoot(out var suiteRoot, out var cliPath, out var ctiHome);
        try
        {
            var gateway = new ModelUsageGateway(suiteRoot, "", ctiHome, _ =>
                Task.FromResult(new ModelUsageCliExecutionResult(0, "{\"protocol\":\"bad\"}", "secret path")));
            var snapshot = await gateway.ReadPanelStateAsync();
            Assert.Equal("unavailable", snapshot.Status);
            Assert.Equal("usage_invalid_protocol", snapshot.Error);
            Assert.Empty(snapshot.Records);
            Assert.Null(snapshot.Summary);
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task CliFailureUsesStableUnavailableCode()
    {
        var root = CreateFixtureRoot(out var suiteRoot, out var cliPath, out var ctiHome);
        try
        {
            var gateway = new ModelUsageGateway(suiteRoot, "", ctiHome, _ =>
                Task.FromResult(new ModelUsageCliExecutionResult(2, "", "Bearer sk-secret")));
            var snapshot = await gateway.ReadPanelStateAsync();
            Assert.Equal("unavailable", snapshot.Status);
            Assert.Equal("cli_failed", snapshot.Error);
        }
        finally { Directory.Delete(root, true); }
    }

    private static string CreateFixtureRoot(out string suiteRoot, out string cliPath, out string ctiHome)
    {
        var root = Path.Combine(Path.GetTempPath(), $"usage-gateway-{Guid.NewGuid():N}");
        suiteRoot = Path.Combine(root, "suite");
        ctiHome = Path.Combine(root, "cti");
        cliPath = Path.Combine(suiteRoot, "packages", "bridge-runtime", "dist", "usage-control.mjs");
        Directory.CreateDirectory(Path.GetDirectoryName(cliPath)!);
        File.WriteAllText(cliPath, "// fixture");
        return root;
    }

    private const string FixtureJson = """
        {
          "protocol":"cti-model-usage-snapshot/v1",
          "generatedAt":"2026-09-25T12:00:00.000Z",
          "records":[{
            "protocol":"cti-model-usage/v1","callId":"call-1","turnId":null,
            "timestamp":"2026-09-25T12:00:00.000Z","operation":"light_chat_route","provider":"jev","model":"typesafe/jev-1.13","status":"succeeded",
            "inputTokens":10,"outputTokens":2,"cacheReadInputTokens":null,"cacheCreationInputTokens":null,"totalTokens":12,"latencyMs":30,
            "reportedCostUsd":null,"calculatedCostUsd":null,"costSource":"unknown","inputRateUsdPer1M":null,"outputRateUsdPer1M":null,
            "cacheReadInputRateUsdPer1M":null,"cacheCreationInputRateUsdPer1M":null,"routeDecision":"task","fallbackReason":null
          }],
          "summary":{
            "protocol":"cti-model-usage/v1","generatedAt":"2026-09-25T12:00:00.000Z","from":"2026-09-25T12:00:00.000Z","to":"2026-09-25T12:00:00.000Z",
            "calls":1,"succeededCalls":1,"failedCalls":0,"totalInputTokens":10,"totalOutputTokens":2,"totalCacheReadInputTokens":0,"totalCacheCreationInputTokens":0,"totalTokens":12,
            "reportedCostUsd":0,"calculatedCostUsd":0,"knownCostCalls":0,"unknownCostCalls":1,"p50LatencyMs":30,"p95LatencyMs":30,
            "byProvider":{"jev":{"calls":1,"totalTokens":12,"knownCostUsd":0}},"byModel":{"typesafe/jev-1.13":{"calls":1,"totalTokens":12,"knownCostUsd":0}},"byDate":{"2026-09-25":{"calls":1,"totalTokens":12,"knownCostUsd":0}}
          },
          "window":{"maxRetainedRecords":5000,"retainedRecords":1,"displayLimit":200,"recordsTruncated":false,"oldestTimestamp":"2026-09-25T12:00:00.000Z","newestTimestamp":"2026-09-25T12:00:00.000Z","dateTimeZone":"UTC"}
        }
        """;
}
