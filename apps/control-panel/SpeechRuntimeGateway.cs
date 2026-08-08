using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ClaudeToImControlPanel;

internal sealed record SpeechCliExecutionResult(int ExitCode, string Stdout, string Stderr);
internal sealed record SpeechCliInvocation(
    string FileName,
    IReadOnlyList<string> Arguments,
    string WorkingDirectory,
    IReadOnlyDictionary<string, string?> Environment,
    int TimeoutMs,
    bool UseShellExecute = false,
    CancellationToken CancellationToken = default);
internal delegate Task<SpeechCliExecutionResult> SpeechCliCommandExecutor(SpeechCliInvocation invocation);

// 以下 DTO 只镜像 packages/contracts/schemas/speech.schema.json，不承载业务裁决。
internal sealed record SpeechSelectionOptionContract(string Id, string DisplayName, string State, bool Enabled, string? DiagnosticCode);
internal sealed record SpeechSelectionContract(string Value, SpeechSelectionOptionContract[] Options);
internal sealed record SpeechModelBenchmarkContract(string State, string Revision, string? TestedAt, double? ColdStartMs, double? WarmSynthesisMs, double? OutputDurationMs, double? RealTimeFactor, double? PeakVramMiB, string? DiagnosticCode);
internal sealed record SpeechModelOptionContract(string Id, string DisplayName, string State, bool Enabled, string? DiagnosticCode, string ProviderId, string Variant, string SizeLabel, string ComponentId, string[] Capabilities, string DefaultVoiceProfileId, SpeechModelBenchmarkContract Benchmark);
internal sealed record SpeechModelSelectionContract(string Value, string LiveValue, bool RestartRequired, SpeechModelOptionContract[] Options);
internal sealed record SpeechChannelContract(string Id, string DisplayName, string State, bool Enabled, string? DiagnosticCode, bool InputSupported, bool OutputSupported, bool Selected);
internal sealed record SpeechCapabilityContract(string Id, string DisplayName, string State, bool Supported, string? DiagnosticCode);
internal sealed record SpeechComponentContract(string Id, string DisplayName, string Kind, string State, bool Installable, string? Version, string[] Capabilities, string? DiagnosticCode);
internal sealed record SpeechVoiceProfileContract(string Id, string DisplayName, string Kind, string State, bool Active, string License, string SourceLabel, bool AuthorizationConfirmed, string[] Capabilities, string[] CompatibleTtsModelIds, string? DiagnosticCode);
internal sealed record SpeechLimitsContract(long MaxInputBytes, double MaxInputDurationSeconds, int MaxOutputCharacters, int MaxPreviewCharacters, int MaxSongDurationSeconds);
internal sealed record SpeechActionContract(string Id, string Label, bool Enabled, string? DiagnosticCode);
internal sealed record SpeechSettingsContract(string Schema, bool InputEnabled, bool OutputEnabled, bool SingingEnabled, string[] ChannelIds, string ReplyPolicy, string DeliveryMode, string AsrProvider, string TtsProvider, string TtsModelId, string TonePolicy, string SingingProvider, string ActiveVoiceProfileId, string ActiveSingingVoiceProfileId);
internal sealed record SpeechStatusContract(
    string Protocol,
    string State,
    bool InputEnabled,
    bool OutputEnabled,
    bool SingingEnabled,
    SpeechChannelContract[] Channels,
    SpeechSelectionContract ReplyPolicy,
    SpeechSelectionContract DeliveryMode,
    SpeechSelectionContract AsrProvider,
    SpeechSelectionContract TtsProvider,
    SpeechModelSelectionContract TtsModel,
    SpeechSelectionContract TonePolicy,
    SpeechSelectionContract SingingProvider,
    SpeechModelBenchmarkContract SingingBenchmark,
    string ActiveVoiceProfileId,
    string ActiveSingingVoiceProfileId,
    SpeechCapabilityContract[] Capabilities,
    SpeechComponentContract[] Components,
    SpeechVoiceProfileContract[] VoiceProfiles,
    SpeechLimitsContract Limits,
    SpeechActionContract[] Actions,
    string? DiagnosticCode,
    string LastCheckedAt);
internal sealed record SpeechPanelStateContract(bool Available, string? UnavailableCode, SpeechStatusContract? Status);
internal sealed record SpeechCommandReceiptContract(string Action, bool Completed, bool RestartRequired, string? Notice);
internal sealed record SpeechPreviewReceiptContract(
    string Protocol,
    string MediaType,
    string Base64,
    int Bytes,
    string Sha256,
    double DurationMs,
    string ModelId,
    string VoiceProfileId,
    bool Validated);

internal static class SpeechCommandPolicy
{
    public static string? GetRequiredRole(string command) => command switch
    {
        "speech.refresh" => "viewer",
        "speech.saveSettings" or "speech.previewVoice" or "speech.previewSingingVoice" or "speech.activateVoiceProfile" or "speech.benchmarkTtsModel" or "speech.benchmarkSingingModel" => "operator",
        "speech.installComponent" or "speech.installPresetVoice" or "speech.importReferenceVoice" => "owner",
        _ => null,
    };

    /** 独立 CLI 只更新磁盘事实源；这些动作需要用户随后通过受控入口重启 Bridge。 */
    public static bool RequiresBridgeRestart(string command) => command switch
    {
        "speech.saveSettings" or
        "speech.installComponent" or
        "speech.installPresetVoice" or
        "speech.importReferenceVoice" or
        "speech.activateVoiceProfile" => true,
        _ => false,
    };

    // 模型/Runtime 下载与全哈希安装可能持续数十分钟；其余动作继续使用短门禁，
    // 避免为了安装放宽所有面板子进程的生命周期。
    public static int GetTimeoutMs(string command) => command switch
    {
        "speech.installComponent" or "speech.installPresetVoice" => 60 * 60 * 1000,
        "speech.benchmarkTtsModel" or "speech.benchmarkSingingModel" => 15 * 60 * 1000,
        "speech.previewVoice" or "speech.previewSingingVoice" or "speech.importReferenceVoice" => 5 * 60 * 1000,
        _ => 2 * 60 * 1000,
    };
}

internal sealed class SpeechRuntimeGatewayException : InvalidOperationException
{
    public SpeechRuntimeGatewayException(string code)
        : base($"语音 Runtime 命令未完成（{NormalizeCode(code)}）。")
    {
        Code = NormalizeCode(code);
    }

    public string Code { get; }

    private static string NormalizeCode(string? value)
    {
        var code = (value ?? string.Empty).Trim();
        return code.Length is > 0 and <= 80 && code.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '_' or '-' or '.')
            ? code
            : "speech_runtime_error";
    }
}

/// <summary>控制面板只调用 Runtime 白名单 CLI，不直接读写语音配置或 Profile 存储。</summary>
internal sealed class SpeechRuntimeGateway
{
    internal const string StatusProtocol = "codex-im-suite/speech-status/v2";
    internal const string PreviewProtocol = "codex-im-suite/speech-preview/v2";
    private const int MaxPreviewBytes = 4 * 1024 * 1024;
    private static readonly HashSet<string> AllowedCommands = new(StringComparer.Ordinal)
    {
        "speech.refresh",
        "speech.saveSettings",
        "speech.installComponent",
        "speech.installPresetVoice",
        "speech.benchmarkTtsModel",
        "speech.benchmarkSingingModel",
        "speech.importReferenceVoice",
        "speech.previewVoice",
        "speech.previewSingingVoice",
        "speech.activateVoiceProfile",
    };
    private static readonly HashSet<string> AllowedStates = new(StringComparer.Ordinal)
    {
        "ready", "optional_missing", "blocked", "error",
    };
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly string _suiteRoot;
    private readonly string _skillRoot;
    private readonly string _ctiHome;
    private readonly SpeechCliCommandExecutor _executor;
    private readonly string _nodeExecutable;

    public SpeechRuntimeGateway(
        string suiteRoot,
        string skillRoot,
        string ctiHome,
        SpeechCliCommandExecutor? executor = null,
        string nodeExecutable = "node")
    {
        _suiteRoot = suiteRoot;
        _skillRoot = skillRoot;
        _ctiHome = Path.GetFullPath(ctiHome);
        _executor = executor ?? ExecuteProcessAsync;
        _nodeExecutable = string.IsNullOrWhiteSpace(nodeExecutable) ? "node" : nodeExecutable.Trim();
    }

    public async Task<SpeechPanelStateContract> ReadPanelStateAsync()
    {
        try
        {
            using var data = await RunAsync("speech.refresh", new { });
            var status = JsonSerializer.Deserialize<SpeechStatusContract>(data.RootElement.GetRawText(), JsonOptions);
            if (!IsValidStatus(data.RootElement, status))
            {
                return new SpeechPanelStateContract(false, "speech_status_invalid", null);
            }
            return new SpeechPanelStateContract(true, null, status);
        }
        catch (SpeechRuntimeGatewayException error)
        {
            return new SpeechPanelStateContract(false, error.Code, null);
        }
        catch
        {
            return new SpeechPanelStateContract(false, "speech_runtime_unavailable", null);
        }
    }

    public async Task<SpeechCommandReceiptContract> RunActionAsync(
        string command,
        object? input,
        int timeoutMs = 0,
        CancellationToken cancellationToken = default)
    {
        using var data = await RunAsync(command, input, timeoutMs > 0 ? timeoutMs : SpeechCommandPolicy.GetTimeoutMs(command), cancellationToken);
        // 普通动作的 Runtime data 不直接外发。
        var restartRequired = SpeechCommandPolicy.RequiresBridgeRestart(command);
        return new SpeechCommandReceiptContract(
            command,
            true,
            restartRequired,
            restartRequired ? "语音配置已写入；请在服务页受控重启 Bridge 后再做现场验收。" : null);
    }

    public Task<SpeechPreviewReceiptContract> RunPreviewAsync(
        object? input,
        int timeoutMs = 0,
        CancellationToken cancellationToken = default)
        => RunPreviewAsync("speech.previewVoice", input, timeoutMs, cancellationToken);

    public async Task<SpeechPreviewReceiptContract> RunPreviewAsync(
        string command,
        object? input,
        int timeoutMs = 0,
        CancellationToken cancellationToken = default)
    {
        if (command is not ("speech.previewVoice" or "speech.previewSingingVoice"))
        {
            throw new SpeechRuntimeGatewayException("speech_action_not_allowed");
        }
        using var data = await RunAsync(command, input, timeoutMs > 0 ? timeoutMs : SpeechCommandPolicy.GetTimeoutMs(command), cancellationToken);
        var preview = JsonSerializer.Deserialize<SpeechPreviewReceiptContract>(data.RootElement.GetRawText(), JsonOptions);
        if (!IsValidPreviewReceipt(data.RootElement, preview))
        {
            throw new SpeechRuntimeGatewayException("speech_preview_response_invalid");
        }
        // 试听是唯一允许外发 Runtime data 的命令，且只返回已复验的受限媒体 DTO。
        return preview!;
    }

    internal async Task<JsonDocument> RunAsync(
        string command,
        object? input,
        int timeoutMs = 120_000,
        CancellationToken cancellationToken = default)
    {
        if (!AllowedCommands.Contains(command))
        {
            throw new SpeechRuntimeGatewayException("speech_action_not_allowed");
        }

        var inputBytes = JsonSerializer.SerializeToUtf8Bytes(input ?? new { }, JsonOptions);
        var arguments = new List<string>
        {
            ResolveCliPath(),
            command,
            "--input-json",
            ToBase64Url(inputBytes),
        };
        var invocation = new SpeechCliInvocation(
            _nodeExecutable,
            arguments,
            Directory.Exists(_suiteRoot) ? _suiteRoot : _ctiHome,
            new Dictionary<string, string?>
            {
                ["CTI_HOME"] = _ctiHome,
                ["PYTHONUTF8"] = "1",
                ["PYTHONIOENCODING"] = "utf-8",
            },
            Math.Max(1_000, timeoutMs),
            CancellationToken: cancellationToken);

        SpeechCliExecutionResult result;
        try
        {
            result = await _executor(invocation);
        }
        catch (OperationCanceledException)
        {
            throw new SpeechRuntimeGatewayException("speech_cli_timeout");
        }
        catch
        {
            throw new SpeechRuntimeGatewayException("speech_cli_unavailable");
        }

        JsonDocument envelope;
        try
        {
            envelope = JsonDocument.Parse(result.Stdout);
        }
        catch (JsonException)
        {
            throw new SpeechRuntimeGatewayException(result.ExitCode == 0
                ? "speech_cli_protocol_invalid"
                : "speech_cli_failed");
        }

        using (envelope)
        {
            var root = envelope.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("ok", out var ok)
                || ok.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            {
                throw new SpeechRuntimeGatewayException(result.ExitCode == 0
                    ? "speech_cli_protocol_invalid"
                    : "speech_cli_failed");
            }
            if (!ok.GetBoolean())
            {
                var code = root.TryGetProperty("errorCode", out var errorCode) && errorCode.ValueKind == JsonValueKind.String
                    ? errorCode.GetString()
                    : "speech_runtime_error";
                throw new SpeechRuntimeGatewayException(code ?? "speech_runtime_error");
            }
            if (result.ExitCode != 0)
            {
                // Runtime 只有在 ok=false 时才可用 errorCode 解释非零退出；
                // “非零 + ok=true”属于不可信协议组合，不能当成功处理。
                throw new SpeechRuntimeGatewayException("speech_cli_failed");
            }
            if (!root.TryGetProperty("data", out var data))
            {
                throw new SpeechRuntimeGatewayException("speech_cli_protocol_invalid");
            }
            return JsonDocument.Parse(data.GetRawText());
        }
    }

    private string ResolveCliPath()
    {
        var candidates = new[]
        {
            Path.Combine(_suiteRoot, "packages", "bridge-runtime", "dist", "speech-control-cli.mjs"),
            Path.Combine(_skillRoot, "dist", "speech-control-cli.mjs"),
        };
        return candidates.FirstOrDefault(File.Exists)
            ?? throw new SpeechRuntimeGatewayException("speech_cli_missing");
    }

    private static bool IsValidStatus(JsonElement rawStatus, SpeechStatusContract? status)
        => status is not null
            && IsValidRawStatusShape(rawStatus)
            && string.Equals(status.Protocol, StatusProtocol, StringComparison.Ordinal)
            && AllowedStates.Contains(status.State)
            && !string.IsNullOrWhiteSpace(status.LastCheckedAt)
            && HasUniqueNonEmptyIds(status.Channels, item => item.Id, item =>
                !string.IsNullOrWhiteSpace(item.DisplayName) && AllowedStates.Contains(item.State))
            && IsValidSelection(status.ReplyPolicy)
            && IsValidSelection(status.DeliveryMode)
            && IsValidSelection(status.AsrProvider)
            && IsValidSelection(status.TtsProvider)
            && IsValidModelSelection(status.TtsModel)
            && IsValidSelection(status.TonePolicy)
            && IsValidSelection(status.SingingProvider)
            && HasUniqueNonEmptyIds(status.Capabilities, item => item.Id, item =>
                !string.IsNullOrWhiteSpace(item.DisplayName) && AllowedStates.Contains(item.State))
            && HasUniqueNonEmptyIds(status.Components, item => item.Id, item =>
                !string.IsNullOrWhiteSpace(item.DisplayName)
                && !string.IsNullOrWhiteSpace(item.Kind)
                && AllowedStates.Contains(item.State)
                && HasUniqueNonEmptyStrings(item.Capabilities))
            && HasUniqueNonEmptyIds(status.VoiceProfiles, item => item.Id, item =>
                !string.IsNullOrWhiteSpace(item.DisplayName)
                && item.Kind is "preset" or "reference"
                && AllowedStates.Contains(item.State)
                && HasUniqueNonEmptyStrings(item.Capabilities)
                && item.Capabilities.All(capability => capability is "speech" or "singing")
                && HasUniqueNonEmptyStrings(item.CompatibleTtsModelIds))
            && (string.IsNullOrEmpty(status.ActiveVoiceProfileId)
                || status.VoiceProfiles.Any(item => string.Equals(item.Id, status.ActiveVoiceProfileId, StringComparison.Ordinal)))
            && (string.IsNullOrEmpty(status.ActiveSingingVoiceProfileId)
                || status.VoiceProfiles.Any(item => string.Equals(item.Id, status.ActiveSingingVoiceProfileId, StringComparison.Ordinal)
                    && item.Capabilities.Contains("singing", StringComparer.Ordinal)))
            && status.Limits is not null
            && status.Limits.MaxInputBytes >= 0
            && double.IsFinite(status.Limits.MaxInputDurationSeconds)
            && status.Limits.MaxInputDurationSeconds >= 0
            && status.Limits.MaxOutputCharacters >= 0
            && status.Limits.MaxPreviewCharacters is >= 1 and <= 240
            && status.Limits.MaxSongDurationSeconds is >= 10 and <= 600
            && HasUniqueNonEmptyIds(status.Actions, item => item.Id, item => !string.IsNullOrWhiteSpace(item.Label));

    private static bool IsValidPreviewReceipt(JsonElement raw, SpeechPreviewReceiptContract? receipt)
    {
        if (receipt is null
            || raw.ValueKind != JsonValueKind.Object
            || raw.EnumerateObject().Count() != 9
            || !string.Equals(receipt.Protocol, PreviewProtocol, StringComparison.Ordinal)
            || !string.Equals(receipt.MediaType, "audio/ogg; codecs=opus", StringComparison.Ordinal)
            || !receipt.Validated
            || string.IsNullOrEmpty(receipt.Base64)
            || receipt.Bytes <= 0
            || receipt.Bytes > MaxPreviewBytes
            || receipt.DurationMs <= 0
            || !double.IsFinite(receipt.DurationMs)
            || string.IsNullOrEmpty(receipt.ModelId)
            || receipt.ModelId.Length is < 1 or > 80
            || !receipt.ModelId.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '.' or '_' or '-')
            || string.IsNullOrEmpty(receipt.VoiceProfileId)
            || receipt.VoiceProfileId.Length is < 1 or > 80
            || !receipt.VoiceProfileId.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '.' or '_' or '-')
            || string.IsNullOrEmpty(receipt.Sha256)
            || receipt.Sha256.Length != 64
            || !receipt.Sha256.All(ch => ch is >= '0' and <= '9' or >= 'a' and <= 'f'))
        {
            return false;
        }

        byte[] media;
        try
        {
            media = Convert.FromBase64String(receipt.Base64);
        }
        catch (FormatException)
        {
            return false;
        }
        if (media.Length != receipt.Bytes
            || media.Length < 4
            || media[0] != (byte)'O'
            || media[1] != (byte)'g'
            || media[2] != (byte)'g'
            || media[3] != (byte)'S'
            || !string.Equals(Convert.ToHexString(SHA256.HashData(media)).ToLowerInvariant(), receipt.Sha256, StringComparison.Ordinal))
        {
            return false;
        }
        var allowed = new HashSet<string>(StringComparer.Ordinal)
        {
            "protocol", "mediaType", "base64", "bytes", "sha256", "durationMs", "modelId", "voiceProfileId", "validated",
        };
        return raw.EnumerateObject().All(property => allowed.Contains(property.Name));
    }

    private static bool IsValidSelection(SpeechSelectionContract? selection)
        => selection is not null
            && !string.IsNullOrWhiteSpace(selection.Value)
            && HasUniqueNonEmptyIds(selection.Options, item => item.Id, item =>
                !string.IsNullOrWhiteSpace(item.DisplayName) && AllowedStates.Contains(item.State))
            && selection.Options.Any(item => string.Equals(item.Id, selection.Value, StringComparison.Ordinal));

    private static bool IsValidModelSelection(SpeechModelSelectionContract? selection)
        => selection is not null
            && !string.IsNullOrWhiteSpace(selection.Value)
            && selection.LiveValue is not null
            && HasUniqueNonEmptyIds(selection.Options, item => item.Id, item =>
                !string.IsNullOrWhiteSpace(item.DisplayName)
                && AllowedStates.Contains(item.State)
                && !string.IsNullOrWhiteSpace(item.ProviderId)
                && !string.IsNullOrWhiteSpace(item.Variant)
                && !string.IsNullOrWhiteSpace(item.SizeLabel)
                && !string.IsNullOrWhiteSpace(item.ComponentId)
                && HasUniqueNonEmptyStrings(item.Capabilities)
                && item.Capabilities.All(capability => capability is "preset_voice" or "voice_clone" or "instruction_control")
                && item.Benchmark is not null
                && AllowedStates.Contains(item.Benchmark.State)
                && !string.IsNullOrWhiteSpace(item.Benchmark.Revision))
            && selection.Options.Any(item => string.Equals(item.Id, selection.Value, StringComparison.Ordinal));

    private static bool HasUniqueNonEmptyIds<T>(
        IEnumerable<T>? items,
        Func<T, string?> idSelector,
        Func<T, bool> validator)
        where T : class
    {
        if (items is null) return false;
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in items)
        {
            if (item is null || !validator(item)) return false;
            var id = idSelector(item);
            if (string.IsNullOrWhiteSpace(id) || !ids.Add(id)) return false;
        }
        return true;
    }

    private static bool HasUniqueNonEmptyStrings(IEnumerable<string>? values)
    {
        if (values is null) return false;
        var unique = new HashSet<string>(StringComparer.Ordinal);
        foreach (var value in values)
        {
            if (string.IsNullOrWhiteSpace(value) || !unique.Add(value)) return false;
        }
        return true;
    }

    /**
     * System.Text.Json 会把缺失的 bool/number 构造参数静默还原为默认值。
     * 在 DTO 语义校验前核对必填 JSON 类型，避免不完整 Runtime 状态伪装成可用状态。
     */
    private static bool IsValidRawStatusShape(JsonElement status)
        => status.ValueKind == JsonValueKind.Object
            && HasString(status, "protocol")
            && HasString(status, "state")
            && HasBoolean(status, "inputEnabled")
            && HasBoolean(status, "outputEnabled")
            && HasBoolean(status, "singingEnabled")
            && HasString(status, "activeVoiceProfileId")
            && HasString(status, "activeSingingVoiceProfileId")
            && HasString(status, "lastCheckedAt")
            && HasArray(status, "channels", item =>
                HasString(item, "id")
                && HasString(item, "displayName")
                && HasString(item, "state")
                && HasBoolean(item, "enabled")
                && HasBoolean(item, "inputSupported")
                && HasBoolean(item, "outputSupported")
                && HasBoolean(item, "selected"))
            && HasSelection(status, "replyPolicy")
            && HasSelection(status, "deliveryMode")
            && HasSelection(status, "asrProvider")
            && HasSelection(status, "ttsProvider")
            && HasModelSelection(status, "ttsModel")
            && HasSelection(status, "tonePolicy")
            && HasSelection(status, "singingProvider")
            && status.TryGetProperty("singingBenchmark", out var singingBenchmark)
            && singingBenchmark.ValueKind == JsonValueKind.Object
            && HasString(singingBenchmark, "state")
            && HasString(singingBenchmark, "revision")
            && HasArray(status, "capabilities", item =>
                HasString(item, "id")
                && HasString(item, "displayName")
                && HasString(item, "state")
                && HasBoolean(item, "supported"))
            && HasArray(status, "components", item =>
                HasString(item, "id")
                && HasString(item, "displayName")
                && HasString(item, "kind")
                && HasString(item, "state")
                && HasBoolean(item, "installable")
                && HasArray(item, "capabilities", capability => capability.ValueKind == JsonValueKind.String))
            && HasArray(status, "voiceProfiles", item =>
                HasString(item, "id")
                && HasString(item, "displayName")
                && HasString(item, "kind")
                && HasString(item, "state")
                && HasBoolean(item, "active")
                && HasString(item, "license")
                && HasString(item, "sourceLabel")
                && HasBoolean(item, "authorizationConfirmed")
                && HasArray(item, "capabilities", capability => capability.ValueKind == JsonValueKind.String)
                && HasArray(item, "compatibleTtsModelIds", model => model.ValueKind == JsonValueKind.String))
            && status.TryGetProperty("limits", out var limits)
            && limits.ValueKind == JsonValueKind.Object
            && HasNumber(limits, "maxInputBytes")
            && HasNumber(limits, "maxInputDurationSeconds")
            && HasNumber(limits, "maxOutputCharacters")
            && HasNumber(limits, "maxPreviewCharacters")
            && HasNumber(limits, "maxSongDurationSeconds")
            && HasArray(status, "actions", item =>
                HasString(item, "id")
                && HasString(item, "label")
                && HasBoolean(item, "enabled"));

    private static bool HasSelection(JsonElement owner, string name)
        => owner.TryGetProperty(name, out var selection)
            && selection.ValueKind == JsonValueKind.Object
            && HasString(selection, "value")
            && HasArray(selection, "options", item =>
                HasString(item, "id")
                && HasString(item, "displayName")
                && HasString(item, "state")
                && HasBoolean(item, "enabled"));

    private static bool HasModelSelection(JsonElement owner, string name)
        => owner.TryGetProperty(name, out var selection)
            && selection.ValueKind == JsonValueKind.Object
            && HasString(selection, "value")
            && HasString(selection, "liveValue")
            && HasBoolean(selection, "restartRequired")
            && HasArray(selection, "options", item =>
                HasString(item, "id")
                && HasString(item, "displayName")
                && HasString(item, "state")
                && HasBoolean(item, "enabled")
                && HasString(item, "providerId")
                && HasString(item, "variant")
                && HasString(item, "sizeLabel")
                && HasString(item, "componentId")
                && HasString(item, "defaultVoiceProfileId")
                && HasArray(item, "capabilities", capability => capability.ValueKind == JsonValueKind.String)
                && item.TryGetProperty("benchmark", out var benchmark)
                && benchmark.ValueKind == JsonValueKind.Object
                && HasString(benchmark, "state")
                && HasString(benchmark, "revision"));

    private static bool HasArray(JsonElement owner, string name, Func<JsonElement, bool> validator)
    {
        if (!owner.TryGetProperty(name, out var array) || array.ValueKind != JsonValueKind.Array) return false;
        foreach (var item in array.EnumerateArray())
        {
            if (!validator(item)) return false;
        }
        return true;
    }

    private static bool HasString(JsonElement owner, string name)
        => owner.ValueKind == JsonValueKind.Object
            && owner.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.String;

    private static bool HasNumber(JsonElement owner, string name)
        => owner.ValueKind == JsonValueKind.Object
            && owner.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.Number;

    private static bool HasBoolean(JsonElement owner, string name)
        => owner.ValueKind == JsonValueKind.Object
            && owner.TryGetProperty(name, out var value)
            && value.ValueKind is JsonValueKind.True or JsonValueKind.False;

    private static string ToBase64Url(byte[] bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    internal static async Task<SpeechCliExecutionResult> ExecuteProcessAsync(SpeechCliInvocation invocation)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = invocation.FileName,
                WorkingDirectory = invocation.WorkingDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false),
                CreateNoWindow = true,
            },
        };
        foreach (var argument in invocation.Arguments) process.StartInfo.ArgumentList.Add(argument);
        foreach (var pair in invocation.Environment) process.StartInfo.Environment[pair.Key] = pair.Value ?? string.Empty;
        process.Start();
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(invocation.TimeoutMs);
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token, invocation.CancellationToken);
        try
        {
            await process.WaitForExitAsync(cancellation.Token);
        }
        catch (OperationCanceledException)
        {
            await TerminateAndDrainAsync(process, stdout, stderr);
            throw;
        }
        var output = await Task.WhenAll(stdout, stderr);
        return new SpeechCliExecutionResult(process.ExitCode, output[0], output[1]);
    }

    private static async Task TerminateAndDrainAsync(Process process, Task<string> stdout, Task<string> stderr)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch
        {
            // 原始超时/取消仍是主错误；清理失败不能覆盖稳定错误码。
        }

        try
        {
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch
        {
            // 若平台拒绝终止，主动关闭读取端，避免 drain 永久等待继承句柄。
            try { process.StandardOutput.Close(); } catch { }
            try { process.StandardError.Close(); } catch { }
        }

        try
        {
            await Task.WhenAll(stdout, stderr).WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch
        {
            // 取消路径不消费输出，这里只负责观察并释放重定向任务。
        }
    }
}
