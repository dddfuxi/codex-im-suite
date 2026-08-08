using System.Text.Json;

namespace ClaudeToImControlPanel;

internal sealed record SpeechReferenceVoiceImportMetadata(
    string DisplayName,
    string Transcript,
    string SourceLabel,
    string License,
    bool AuthorizationConfirmed,
    bool CleanSingleSpeakerConfirmed);

internal sealed partial class MainForm
{
    private SpeechRuntimeGateway CreateSpeechRuntimeGateway()
        => new(
            _suiteRoot,
            _skillDir,
            _ctiHome,
            nodeExecutable: GetConfig("CTI_NODE_EXE", "node"));

    private Task<SpeechPanelStateContract> BuildSpeechPanelStateAsync()
        => CreateSpeechRuntimeGateway().ReadPanelStateAsync();

    private async Task<object> RunSpeechControlCommandAsync(string command, JsonElement payload)
    {
        object input = command switch
        {
            "speech.refresh" => new { },
            "speech.saveSettings" => ReadSpeechSettings(payload),
            "speech.installComponent" or "speech.installPresetVoice" => new
            {
                componentId = ReadRequiredSpeechString(payload, "componentId"),
            },
            "speech.benchmarkTtsModel" => new
            {
                modelId = ReadRequiredSpeechString(payload, "modelId"),
            },
            "speech.benchmarkSingingModel" => new { },
            "speech.previewVoice" or "speech.previewSingingVoice" => new
            {
                modelId = ReadRequiredSpeechString(payload, "modelId"),
                voiceProfileId = ReadOptionalSpeechString(payload, "voiceProfileId"),
                text = ReadRequiredSpeechString(payload, "text"),
            },
            "speech.activateVoiceProfile" => new
            {
                voiceProfileId = ReadRequiredSpeechString(payload, "voiceProfileId"),
            },
            "speech.importReferenceVoice" => await BuildReferenceVoiceImportInputAsync(payload),
            _ => throw new SpeechRuntimeGatewayException("speech_action_not_allowed"),
        };
        var gateway = CreateSpeechRuntimeGateway();
        return command is "speech.previewVoice" or "speech.previewSingingVoice"
            ? await gateway.RunPreviewAsync(command, input)
            : await gateway.RunActionAsync(command, input);
    }

    private static SpeechSettingsContract ReadSpeechSettings(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object)
        {
            throw new SpeechRuntimeGatewayException("speech_settings_invalid");
        }
        SpeechSettingsContract? settings;
        try
        {
            settings = JsonSerializer.Deserialize<SpeechSettingsContract>(payload.GetRawText(), WebJsonOptions);
        }
        catch (JsonException)
        {
            throw new SpeechRuntimeGatewayException("speech_settings_invalid");
        }
        if (settings is null
            || !string.Equals(settings.Schema, "codex-im-suite/speech-settings/v2", StringComparison.Ordinal)
            || settings.ChannelIds is null
            || settings.ChannelIds.Any(string.IsNullOrWhiteSpace)
            || settings.ChannelIds.Distinct(StringComparer.Ordinal).Count() != settings.ChannelIds.Length)
        {
            throw new SpeechRuntimeGatewayException("speech_settings_invalid");
        }
        return settings;
    }

    private async Task<object> BuildReferenceVoiceImportInputAsync(JsonElement payload)
    {
        var metadata = ReadSpeechReferenceVoiceImportMetadata(payload);
        if (!_webReady || _webView.CoreWebView2 is null)
        {
            throw new SpeechRuntimeGatewayException("speech_reference_picker_unavailable");
        }
        var sourcePath = await PickSpeechReferenceFileAsync();
        if (string.IsNullOrWhiteSpace(sourcePath))
        {
            throw new SpeechRuntimeGatewayException("speech_reference_import_cancelled");
        }

        // sourcePath 只在当前调用内交给 Runtime；不会写入面板状态、活动或 receipt。
        return new
        {
            sourcePath,
            displayName = metadata.DisplayName,
            transcript = metadata.Transcript,
            sourceLabel = metadata.SourceLabel,
            license = metadata.License,
            authorizationConfirmed = metadata.AuthorizationConfirmed,
            cleanSingleSpeakerConfirmed = metadata.CleanSingleSpeakerConfirmed,
        };
    }

    internal static SpeechReferenceVoiceImportMetadata ReadSpeechReferenceVoiceImportMetadata(JsonElement payload)
    {
        if (!ReadSpeechBoolean(payload, "authorizationConfirmed"))
        {
            throw new SpeechRuntimeGatewayException("speech_reference_authorization_required");
        }
        if (!ReadSpeechBoolean(payload, "cleanSingleSpeakerConfirmed"))
        {
            throw new SpeechRuntimeGatewayException("speech_reference_clean_single_speaker_confirmation_required");
        }
        return new SpeechReferenceVoiceImportMetadata(
            ReadRequiredSpeechString(payload, "displayName"),
            ReadRequiredSpeechString(payload, "transcript"),
            ReadRequiredSpeechString(payload, "sourceLabel"),
            ReadRequiredSpeechString(payload, "license"),
            true,
            true);
    }

    private Task<string> PickSpeechReferenceFileAsync()
    {
        if (!InvokeRequired) return Task.FromResult(PickSpeechReferenceFileOnUiThread());
        var completion = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        BeginInvoke(() =>
        {
            try { completion.SetResult(PickSpeechReferenceFileOnUiThread()); }
            catch { completion.SetException(new SpeechRuntimeGatewayException("speech_reference_picker_failed")); }
        });
        return completion.Task;
    }

    private string PickSpeechReferenceFileOnUiThread()
    {
        using var dialog = new OpenFileDialog
        {
            CheckFileExists = true,
            Multiselect = false,
            Title = "选择已获授权的参考音频",
            Filter = "音频文件|*.wav;*.mp3;*.m4a;*.ogg;*.flac;*.webm|所有文件|*.*",
            InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyMusic),
        };
        return dialog.ShowDialog(this) == DialogResult.OK ? dialog.FileName : string.Empty;
    }

    private static string ReadRequiredSpeechString(JsonElement payload, string name)
    {
        var value = ReadOptionalSpeechString(payload, name);
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new SpeechRuntimeGatewayException($"speech_{name}_required");
        }
        return value;
    }

    private static string ReadOptionalSpeechString(JsonElement payload, string name)
        => payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.String
                ? value.GetString()?.Trim() ?? string.Empty
                : string.Empty;

    private static bool ReadSpeechBoolean(JsonElement payload, string name)
        => payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.True;
}
