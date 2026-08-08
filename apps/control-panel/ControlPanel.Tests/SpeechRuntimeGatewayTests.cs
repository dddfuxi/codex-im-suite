using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ClaudeToImControlPanel;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class SpeechRuntimeGatewayTests
{
    [Theory]
    [InlineData("speech.refresh", "viewer")]
    [InlineData("speech.saveSettings", "operator")]
    [InlineData("speech.previewVoice", "operator")]
    [InlineData("speech.previewSingingVoice", "operator")]
    [InlineData("speech.activateVoiceProfile", "operator")]
    [InlineData("speech.benchmarkTtsModel", "operator")]
    [InlineData("speech.benchmarkSingingModel", "operator")]
    [InlineData("speech.installComponent", "owner")]
    [InlineData("speech.installPresetVoice", "owner")]
    [InlineData("speech.importReferenceVoice", "owner")]
    public void Policy_UsesExplicitSpeechRoles(string command, string expected)
        => Assert.Equal(expected, SpeechCommandPolicy.GetRequiredRole(command));

    [Theory]
    [InlineData("speech.saveSettings", true)]
    [InlineData("speech.installComponent", true)]
    [InlineData("speech.installPresetVoice", true)]
    [InlineData("speech.importReferenceVoice", true)]
    [InlineData("speech.activateVoiceProfile", true)]
    [InlineData("speech.refresh", false)]
    [InlineData("speech.previewVoice", false)]
    [InlineData("speech.previewSingingVoice", false)]
    public void Policy_MarksStateChangingSpeechActionsAsRestartRequired(string command, bool expected)
        => Assert.Equal(expected, SpeechCommandPolicy.RequiresBridgeRestart(command));

    [Theory]
    [InlineData("speech.installComponent", 3600000)]
    [InlineData("speech.installPresetVoice", 3600000)]
    [InlineData("speech.benchmarkTtsModel", 900000)]
    [InlineData("speech.benchmarkSingingModel", 900000)]
    [InlineData("speech.previewVoice", 300000)]
    [InlineData("speech.refresh", 120000)]
    public void Policy_UsesActionSpecificTimeouts(string command, int expected)
        => Assert.Equal(expected, SpeechCommandPolicy.GetTimeoutMs(command));

    [Fact]
    public async Task RunActionAsync_UsesLongInstallTimeoutWithoutChangingOtherActions()
    {
        using var fixture = new SpeechRuntimeGatewayFixture();
        var timeouts = new List<int>();
        var gateway = fixture.CreateGateway(invocation =>
        {
            timeouts.Add(invocation.TimeoutMs);
            return Task.FromResult(new SpeechCliExecutionResult(0, "{\"ok\":true,\"data\":{}}", ""));
        });

        await gateway.RunActionAsync("speech.installComponent", new { componentId = "qwen3_tts_runtime" });
        await gateway.RunActionAsync("speech.refresh", new { });

        Assert.Equal(new[] { 3600000, 120000 }, timeouts);
    }

    [Fact]
    public async Task RunActionAsync_ReportsRestartRequirementWithoutRestartingAnything()
    {
        using var fixture = new SpeechRuntimeGatewayFixture();
        var gateway = fixture.CreateGateway(_ => Task.FromResult(new SpeechCliExecutionResult(0, "{\"ok\":true,\"data\":{}}", "")));

        var writeReceipt = await gateway.RunActionAsync("speech.saveSettings", new { });
        var readReceipt = await gateway.RunActionAsync("speech.refresh", new { });

        Assert.True(writeReceipt.RestartRequired);
        Assert.Contains("重启 Bridge", writeReceipt.Notice);
        Assert.False(readReceipt.RestartRequired);
        Assert.Null(readReceipt.Notice);
    }

    [Fact]
    public async Task RunAsync_UsesWhitelistCliAndUtf8Base64UrlPayload()
    {
        using var fixture = new SpeechRuntimeGatewayFixture();
        SpeechCliInvocation? captured = null;
        var gateway = fixture.CreateGateway(invocation =>
        {
            captured = invocation;
            return Task.FromResult(new SpeechCliExecutionResult(0, "{\"ok\":true,\"data\":{\"saved\":true}}", ""));
        });

        using var result = await gateway.RunAsync("speech.saveSettings", new { channelIds = new[] { "飞书" }, outputEnabled = true });

        Assert.True(result.RootElement.GetProperty("saved").GetBoolean());
        Assert.NotNull(captured);
        Assert.Equal(fixture.DevelopmentCliPath, captured.Arguments[0]);
        Assert.Equal("speech.saveSettings", captured.Arguments[1]);
        Assert.Equal("--input-json", captured.Arguments[2]);
        var payload = DecodeBase64Url(captured.Arguments[3]);
        using var document = JsonDocument.Parse(payload);
        Assert.Equal("飞书", document.RootElement.GetProperty("channelIds")[0].GetString());
        Assert.Equal(fixture.CtiHome, captured.Environment["CTI_HOME"]);
        Assert.False(captured.UseShellExecute);
    }

    [Fact]
    public async Task ReadPanelStateAsync_DeserializesOnlySharedStatusFields()
    {
        using var fixture = new SpeechRuntimeGatewayFixture();
        var status = JsonNode.Parse(ValidStatusJson)!.AsObject();
        status["sourcePath"] = "C:/must-not-leak.wav";
        var gateway = fixture.CreateGateway(_ => Task.FromResult(new SpeechCliExecutionResult(0, $"{{\"ok\":true,\"data\":{status}}}", "")));

        var panel = await gateway.ReadPanelStateAsync();
        var serialized = JsonSerializer.Serialize(panel);

        Assert.True(panel.Available);
        Assert.Equal("ready", panel.Status?.State);
        Assert.DoesNotContain("must-not-leak", serialized, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("sourcePath", serialized, StringComparison.OrdinalIgnoreCase);
        Assert.True(panel.Status?.Components.Single().Installable);
    }

    [Theory]
    [InlineData("nested_state")]
    [InlineData("negative_limit")]
    [InlineData("empty_id")]
    [InlineData("duplicate_action")]
    [InlineData("selection_value_missing")]
    [InlineData("duplicate_selection_option")]
    [InlineData("installable_missing")]
    public async Task ReadPanelStateAsync_RejectsMalformedNestedStatus(string mutation)
    {
        using var fixture = new SpeechRuntimeGatewayFixture();
        var status = JsonNode.Parse(ValidStatusJson)!.AsObject();
        switch (mutation)
        {
            case "nested_state":
                status["channels"]![0]!["state"] = "invented";
                break;
            case "negative_limit":
                status["limits"]!["maxInputDurationSeconds"] = -1;
                break;
            case "empty_id":
                status["components"]![0]!["id"] = " ";
                break;
            case "duplicate_action":
                status["actions"]!.AsArray().Add(status["actions"]![0]!.DeepClone());
                break;
            case "selection_value_missing":
                status["replyPolicy"]!["value"] = "not-declared";
                break;
            case "duplicate_selection_option":
                status["replyPolicy"]!["options"]!.AsArray().Add(status["replyPolicy"]!["options"]![0]!.DeepClone());
                break;
            case "installable_missing":
                status["components"]![0]!.AsObject().Remove("installable");
                break;
            default:
                throw new InvalidOperationException($"未知测试变体：{mutation}");
        }
        var gateway = fixture.CreateGateway(_ => Task.FromResult(new SpeechCliExecutionResult(
            0,
            $"{{\"ok\":true,\"data\":{status}}}",
            "")));

        var panel = await gateway.ReadPanelStateAsync();

        Assert.False(panel.Available);
        Assert.Equal("speech_status_invalid", panel.UnavailableCode);
        Assert.Null(panel.Status);
    }

    [Fact]
    public async Task ReadPanelStateAsync_FailsClosedWithStableCode()
    {
        using var fixture = new SpeechRuntimeGatewayFixture();
        var gateway = fixture.CreateGateway(_ => Task.FromResult(new SpeechCliExecutionResult(1, "", $"failure at {fixture.Root}")));

        var panel = await gateway.ReadPanelStateAsync();

        Assert.False(panel.Available);
        Assert.Equal("speech_cli_failed", panel.UnavailableCode);
        Assert.Null(panel.Status);
        Assert.DoesNotContain(fixture.Root, JsonSerializer.Serialize(panel), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task RunAsync_PreservesTrustedRuntimeErrorCodeOnNonZeroExit()
    {
        using var fixture = new SpeechRuntimeGatewayFixture();
        var gateway = fixture.CreateGateway(_ => Task.FromResult(new SpeechCliExecutionResult(
            1,
            "{\"ok\":false,\"errorCode\":\"speech_dependency_install_failed\"}",
            $"failure at {fixture.Root}")));

        var error = await Assert.ThrowsAsync<SpeechRuntimeGatewayException>(() =>
            gateway.RunAsync("speech.installComponent", new { componentId = "asr" }));

        Assert.Equal("speech_dependency_install_failed", error.Code);
        Assert.DoesNotContain(fixture.Root, error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task RunAsync_RejectsNonZeroExitThatClaimsSuccess()
    {
        using var fixture = new SpeechRuntimeGatewayFixture();
        var gateway = fixture.CreateGateway(_ => Task.FromResult(new SpeechCliExecutionResult(
            1,
            "{\"ok\":true,\"data\":{\"saved\":true}}",
            "")));

        var error = await Assert.ThrowsAsync<SpeechRuntimeGatewayException>(() =>
            gateway.RunAsync("speech.saveSettings", new { }));

        Assert.Equal("speech_cli_failed", error.Code);
    }

    [Fact]
    public async Task RunAsync_RejectsUnknownActionBeforeExecuting()
    {
        using var fixture = new SpeechRuntimeGatewayFixture();
        var called = false;
        var gateway = fixture.CreateGateway(_ =>
        {
            called = true;
            return Task.FromResult(new SpeechCliExecutionResult(0, "{}", ""));
        });

        var error = await Assert.ThrowsAsync<SpeechRuntimeGatewayException>(() => gateway.RunAsync("speech.deleteEverything", new { }));

        Assert.Equal("speech_action_not_allowed", error.Code);
        Assert.False(called);
    }

    [Theory]
    [InlineData("speech.previewVoice")]
    [InlineData("speech.previewSingingVoice")]
    public async Task RunPreviewAsync_ProjectsOnlyValidatedOggOpusMedia(string command)
    {
        using var fixture = new SpeechRuntimeGatewayFixture();
        var media = Encoding.ASCII.GetBytes("OggS-safe-preview");
        var base64 = Convert.ToBase64String(media);
        var sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(media)).ToLowerInvariant();
        var response = JsonSerializer.Serialize(new
        {
            ok = true,
            data = new
            {
                protocol = "codex-im-suite/speech-preview/v2",
                mediaType = "audio/ogg; codecs=opus",
                base64,
                bytes = media.Length,
                sha256,
                durationMs = 1000,
                modelId = "model-a",
                voiceProfileId = "acestep.default",
                validated = true,
            },
        });
        var gateway = fixture.CreateGateway(_ => Task.FromResult(new SpeechCliExecutionResult(
            0,
            response,
            "")));

        var receipt = await gateway.RunPreviewAsync(command, new { text = "试听", voiceProfileId = "acestep.default" });

        Assert.Equal(base64, receipt.Base64);
        Assert.Equal(media.Length, receipt.Bytes);
        Assert.True(receipt.Validated);
    }

    [Theory]
    [InlineData("extra", "OggS-safe-preview")]
    [InlineData("bad_hash", "OggS-safe-preview")]
    [InlineData("bad_header", "RIFF-not-ogg-data")]
    public async Task RunPreviewAsync_RejectsUntrustedMediaVariants(string mutation, string content)
    {
        using var fixture = new SpeechRuntimeGatewayFixture();
        var media = Encoding.ASCII.GetBytes(content);
        var base64 = Convert.ToBase64String(media);
        var sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(media)).ToLowerInvariant();
        if (mutation == "bad_hash") sha256 = new string('0', 64);
        var data = new JsonObject
        {
            ["protocol"] = "codex-im-suite/speech-preview/v2",
            ["mediaType"] = "audio/ogg; codecs=opus",
            ["base64"] = base64,
            ["bytes"] = media.Length,
            ["sha256"] = sha256,
            ["durationMs"] = 1000,
            ["modelId"] = "model-a",
            ["voiceProfileId"] = "acestep.default",
            ["validated"] = true,
        };
        if (mutation == "extra") data["path"] = "C:/must-not-leak.ogg";
        var response = new JsonObject { ["ok"] = true, ["data"] = data }.ToJsonString();
        var gateway = fixture.CreateGateway(_ => Task.FromResult(new SpeechCliExecutionResult(
            0,
            response,
            "")));

        var error = await Assert.ThrowsAsync<SpeechRuntimeGatewayException>(() =>
            gateway.RunPreviewAsync("speech.previewSingingVoice", new { text = "试听", voiceProfileId = "acestep.default" }));

        Assert.Equal("speech_preview_response_invalid", error.Code);
    }

    [Fact]
    public async Task ExecuteProcessAsync_DrainsStdoutAndStderrConcurrently()
    {
        using var fixture = new SpeechRuntimeGatewayFixture();
        var script = """
        $utf8 = [System.Text.UTF8Encoding]::new($false)
        $OutputEncoding = $utf8
        [Console]::InputEncoding = $utf8
        [Console]::OutputEncoding = $utf8
        for ($i = 0; $i -lt 5000; $i++) {
          [Console]::Out.WriteLine("stdout-$i")
          [Console]::Error.WriteLine("stderr-$i")
        }
        """;
        var result = await SpeechRuntimeGateway.ExecuteProcessAsync(new SpeechCliInvocation(
            PowerShellPath,
            ["-NoProfile", "-NonInteractive", "-Command", script],
            fixture.Root,
            new Dictionary<string, string?>(),
            15_000));

        Assert.Equal(0, result.ExitCode);
        Assert.Contains("stdout-4999", result.Stdout);
        Assert.Contains("stderr-4999", result.Stderr);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExecuteProcessAsync_KillsEntireProcessTreeOnTimeoutOrCancellation(bool externalCancellation)
    {
        using var fixture = new SpeechRuntimeGatewayFixture();
        var childPidPath = Path.Combine(fixture.Root, $"child-{Guid.NewGuid():N}.pid");
        var script = """
        $utf8 = [System.Text.UTF8Encoding]::new($false)
        $OutputEncoding = $utf8
        [Console]::InputEncoding = $utf8
        [Console]::OutputEncoding = $utf8
        $child = Start-Process -FilePath $env:SPEECH_CHILD_EXE -ArgumentList @('127.0.0.1', '-n', '30') -PassThru -WindowStyle Hidden
        [System.IO.File]::WriteAllText($env:SPEECH_CHILD_PID_FILE, [string]$child.Id, $utf8)
        [Console]::Out.WriteLine('parent-stdout-ready')
        [Console]::Error.WriteLine('parent-stderr-ready')
        Start-Sleep -Seconds 30
        """;
        using var cancellation = new CancellationTokenSource();
        if (externalCancellation) cancellation.CancelAfter(1_500);
        var invocation = new SpeechCliInvocation(
            PowerShellPath,
            ["-NoProfile", "-NonInteractive", "-Command", script],
            fixture.Root,
            new Dictionary<string, string?>
            {
                ["SPEECH_CHILD_EXE"] = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "ping.exe"),
                ["SPEECH_CHILD_PID_FILE"] = childPidPath,
            },
            externalCancellation ? 30_000 : 1_500,
            CancellationToken: cancellation.Token);

        var stopwatch = Stopwatch.StartNew();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => SpeechRuntimeGateway.ExecuteProcessAsync(invocation));
        stopwatch.Stop();

        Assert.True(File.Exists(childPidPath), "父进程应在取消前创建真实子进程并记录 PID。");
        var childPid = int.Parse(File.ReadAllText(childPidPath, Encoding.UTF8));
        try
        {
            Assert.True(await WaitForProcessExitAsync(childPid, TimeSpan.FromSeconds(5)), $"子进程 {childPid} 未被进程树清理。");
            Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(10), "取消清理不应因 stdout/stderr drain 永久阻塞。");
        }
        finally
        {
            TryKillTestProcess(childPid);
        }
    }

    [Fact]
    public void ReferenceVoiceImportMetadata_RequiresIndependentSafetyConfirmations()
    {
        using var valid = JsonDocument.Parse("""
        {"displayName":"授权音色","transcript":"这是一段准确转写。","sourceLabel":"用户本人录音","license":"本人授权","authorizationConfirmed":true,"cleanSingleSpeakerConfirmed":true}
        """);
        var metadata = MainForm.ReadSpeechReferenceVoiceImportMetadata(valid.RootElement);
        Assert.True(metadata.AuthorizationConfirmed);
        Assert.True(metadata.CleanSingleSpeakerConfirmed);

        using var missingClean = JsonDocument.Parse("""
        {"displayName":"授权音色","transcript":"这是一段准确转写。","sourceLabel":"用户本人录音","license":"本人授权","authorizationConfirmed":true,"cleanSingleSpeakerConfirmed":false}
        """);
        var error = Assert.Throws<SpeechRuntimeGatewayException>(() =>
            MainForm.ReadSpeechReferenceVoiceImportMetadata(missingClean.RootElement));
        Assert.Equal("speech_reference_clean_single_speaker_confirmation_required", error.Code);
    }

    private static string DecodeBase64Url(string value)
    {
        var normalized = value.Replace('-', '+').Replace('_', '/');
        normalized += new string('=', (4 - normalized.Length % 4) % 4);
        return Encoding.UTF8.GetString(Convert.FromBase64String(normalized));
    }

    private static string PowerShellPath
        => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe");

    private static async Task<bool> WaitForProcessExitAsync(int processId, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                using var process = Process.GetProcessById(processId);
                if (process.HasExited) return true;
            }
            catch (ArgumentException)
            {
                return true;
            }
            await Task.Delay(50);
        }
        return false;
    }

    private static void TryKillTestProcess(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch
        {
            // 测试兜底清理：目标已退出或 PID 已失效时无需处理。
        }
    }

    private const string ValidStatusJson = """
    {"protocol":"codex-im-suite/speech-status/v2","state":"ready","inputEnabled":true,"outputEnabled":true,"singingEnabled":false,"channels":[{"id":"feishu","displayName":"飞书","state":"ready","enabled":true,"inputSupported":true,"outputSupported":true,"selected":true}],"replyPolicy":{"value":"on","options":[{"id":"on","displayName":"开启","state":"ready","enabled":true}]},"deliveryMode":{"value":"voice_only","options":[{"id":"voice_only","displayName":"仅语音","state":"ready","enabled":true}]},"asrProvider":{"value":"asr","options":[{"id":"asr","displayName":"ASR","state":"ready","enabled":true}]},"ttsProvider":{"value":"tts","options":[{"id":"tts","displayName":"TTS","state":"ready","enabled":true}]},"ttsModel":{"value":"model-a","liveValue":"model-a","restartRequired":false,"options":[{"id":"model-a","displayName":"模型 A","state":"ready","enabled":true,"providerId":"tts","variant":"custom_voice","sizeLabel":"1.7B","componentId":"model-a","capabilities":["preset_voice","instruction_control"],"defaultVoiceProfileId":"voice","benchmark":{"state":"ready","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]},"tonePolicy":{"value":"adaptive_natural","options":[{"id":"adaptive_natural","displayName":"自适应自然","state":"ready","enabled":true}]},"singingProvider":{"value":"ace_step_1_5","options":[{"id":"ace_step_1_5","displayName":"ACE-Step 1.5","state":"blocked","enabled":true}]},"singingBenchmark":{"state":"optional_missing","revision":"uninstalled","diagnosticCode":"singing_benchmark_not_verified"},"activeVoiceProfileId":"voice","activeSingingVoiceProfileId":"","capabilities":[{"id":"speech.input","displayName":"语音输入","state":"ready","supported":true}],"components":[{"id":"sensevoice","displayName":"SenseVoice","kind":"model","state":"optional_missing","installable":true,"capabilities":["asr"]}],"voiceProfiles":[{"id":"voice","displayName":"预设音色","kind":"preset","state":"ready","active":true,"license":"内置","sourceLabel":"Runtime","authorizationConfirmed":true,"capabilities":["speech"],"compatibleTtsModelIds":["model-a"]}],"limits":{"maxInputBytes":1024,"maxInputDurationSeconds":60,"maxOutputCharacters":500,"maxPreviewCharacters":240,"maxSongDurationSeconds":60},"actions":[{"id":"speech.previewVoice","label":"试听","enabled":true},{"id":"speech.previewSingingVoice","label":"试听歌声","enabled":false,"diagnosticCode":"singing_benchmark_not_verified"}],"lastCheckedAt":"2026-08-07T00:00:00.000Z"}
    """;

    private sealed class SpeechRuntimeGatewayFixture : IDisposable
    {
        public SpeechRuntimeGatewayFixture()
        {
            Root = Path.Combine(Path.GetTempPath(), $"speech-gateway-{Guid.NewGuid():N}");
            SuiteRoot = Path.Combine(Root, "suite");
            SkillRoot = Path.Combine(Root, "live-skill");
            CtiHome = Path.Combine(Root, "cti-home");
            DevelopmentCliPath = Path.Combine(SuiteRoot, "packages", "bridge-runtime", "dist", "speech-control-cli.mjs");
            Directory.CreateDirectory(Path.GetDirectoryName(DevelopmentCliPath)!);
            Directory.CreateDirectory(CtiHome);
            File.WriteAllText(DevelopmentCliPath, "// fixture", new UTF8Encoding(false));
        }

        public string Root { get; }
        public string SuiteRoot { get; }
        public string SkillRoot { get; }
        public string CtiHome { get; }
        public string DevelopmentCliPath { get; }

        public SpeechRuntimeGateway CreateGateway(SpeechCliCommandExecutor executor)
            => new(SuiteRoot, SkillRoot, CtiHome, executor, "node");

        public void Dispose()
        {
            if (Directory.Exists(Root)) Directory.Delete(Root, true);
        }
    }
}
