using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ClaudeToImControlPanel;

internal sealed record ModelUsageCliExecutionResult(int ExitCode, string Stdout, string Stderr);
internal sealed record ModelUsageCliInvocation(
    string FileName,
    IReadOnlyList<string> Arguments,
    string WorkingDirectory,
    IReadOnlyDictionary<string, string?> Environment,
    int TimeoutMs);
internal delegate Task<ModelUsageCliExecutionResult> ModelUsageCliCommandExecutor(ModelUsageCliInvocation invocation);

internal sealed class ModelUsageRecordDto
{
    public string Protocol { get; init; } = "";
    public string CallId { get; init; } = "";
    public string? TurnId { get; init; }
    public string Timestamp { get; init; } = "";
    public string Operation { get; init; } = "";
    public string Provider { get; init; } = "";
    public string Model { get; init; } = "";
    public string Status { get; init; } = "";
    public double? InputTokens { get; init; }
    public double? OutputTokens { get; init; }
    public double? CacheReadInputTokens { get; init; }
    public double? CacheCreationInputTokens { get; init; }
    public double? TotalTokens { get; init; }
    public double? LatencyMs { get; init; }
    public double? ReportedCostUsd { get; init; }
    public double? CalculatedCostUsd { get; init; }
    public string CostSource { get; init; } = "";
    public double? InputRateUsdPer1M { get; init; }
    public double? OutputRateUsdPer1M { get; init; }
    public double? CacheReadInputRateUsdPer1M { get; init; }
    public double? CacheCreationInputRateUsdPer1M { get; init; }
    public string? RouteDecision { get; init; }
    public string? FallbackReason { get; init; }
    public string? RouteMode { get; init; }
    public string? EffectivePath { get; init; }
    public string? CoordinatorRoute { get; init; }
    public string? RouteComparisonId { get; init; }
}

internal sealed class ModelUsageBucketDto
{
    public int Calls { get; init; }
    public double TotalTokens { get; init; }
    public double KnownCostUsd { get; init; }
}

internal sealed class ModelUsageRouteMetricsDto
{
    public int PairedComparisons { get; init; }
    public int AgreeingComparisons { get; init; }
    public double? AgreementRate { get; init; }
    public int SkippedCoordinatorCalls { get; init; }
}

internal sealed class ModelUsageSummaryDto
{
    public string Protocol { get; init; } = "";
    public string GeneratedAt { get; init; } = "";
    public string? From { get; init; }
    public string? To { get; init; }
    public int Calls { get; init; }
    public int SucceededCalls { get; init; }
    public int FailedCalls { get; init; }
    public double TotalInputTokens { get; init; }
    public double TotalOutputTokens { get; init; }
    public double TotalCacheReadInputTokens { get; init; }
    public double TotalCacheCreationInputTokens { get; init; }
    public double TotalTokens { get; init; }
    public double ReportedCostUsd { get; init; }
    public double CalculatedCostUsd { get; init; }
    public int KnownCostCalls { get; init; }
    public int UnknownCostCalls { get; init; }
    public double KnownCostUsd { get; init; }
    public int UnknownInputTokenCalls { get; init; }
    public int UnknownOutputTokenCalls { get; init; }
    public int UnknownTotalTokenCalls { get; init; }
    public double? FailureRate { get; init; }
    public double? P50LatencyMs { get; init; }
    public double? P95LatencyMs { get; init; }
    public Dictionary<string, ModelUsageBucketDto> ByProvider { get; init; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, ModelUsageBucketDto> ByModel { get; init; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, ModelUsageBucketDto> ByDate { get; init; } = new(StringComparer.OrdinalIgnoreCase);
    public ModelUsageRouteMetricsDto RouteMetrics { get; init; } = new();
}

internal sealed class ModelUsageSnapshotWindowDto
{
    public int MaxRetainedRecords { get; init; }
    public int RetainedRecords { get; init; }
    public int DisplayLimit { get; init; }
    public bool RecordsTruncated { get; init; }
    public string? OldestTimestamp { get; init; }
    public string? NewestTimestamp { get; init; }
    public string DateTimeZone { get; init; } = "UTC";
}

internal sealed record ModelUsagePanelSnapshotDto(
    string Protocol,
    string GeneratedAt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Status,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Error,
    IReadOnlyList<ModelUsageRecordDto> Records,
    ModelUsageSummaryDto? Summary,
    ModelUsageSnapshotWindowDto Window);

/// <summary>控制面板只通过 runtime usage-control CLI 读取受控用量快照。</summary>
internal sealed class ModelUsageGateway
{
    private const string SnapshotProtocol = "cti-model-usage-snapshot/v1";
    private const string RecordProtocol = "cti-model-usage/v1";
    private const int MaxStdoutChars = 8 * 1024 * 1024;
    private const int MaxRecords = 200;
    private static readonly HashSet<string> Statuses = new(StringComparer.Ordinal) { "succeeded", "failed", "cancelled", "timeout", "fallback" };
    private static readonly HashSet<string> CostSources = new(StringComparer.Ordinal) { "provider_reported", "price_table", "unknown" };
    private readonly string _suiteRoot;
    private readonly string _skillRoot;
    private readonly string _ctiHome;
    private readonly ModelUsageCliCommandExecutor _executor;
    private readonly string _nodeExecutable;

    public ModelUsageGateway(
        string suiteRoot,
        string skillRoot,
        string ctiHome,
        ModelUsageCliCommandExecutor? executor = null,
        string nodeExecutable = "node")
    {
        _suiteRoot = string.IsNullOrWhiteSpace(suiteRoot) ? "" : Path.GetFullPath(suiteRoot);
        _skillRoot = string.IsNullOrWhiteSpace(skillRoot) ? "" : Path.GetFullPath(skillRoot);
        _ctiHome = Path.GetFullPath(ctiHome);
        _executor = executor ?? ExecuteProcessAsync;
        _nodeExecutable = string.IsNullOrWhiteSpace(nodeExecutable) ? "node" : nodeExecutable.Trim();
    }

    public async Task<ModelUsagePanelSnapshotDto> ReadPanelStateAsync()
    {
        try
        {
            var result = await _executor(new ModelUsageCliInvocation(
                _nodeExecutable,
                [ResolveCliPath(), "snapshot", "--json"],
                ResolveWorkingDirectory(),
                new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
                {
                    ["CTI_HOME"] = _ctiHome,
                    ["PYTHONUTF8"] = "1",
                    ["PYTHONIOENCODING"] = "utf-8",
                },
                5_000));
            if (result.ExitCode == -1) return Unavailable("cli_timeout");
            if (result.ExitCode != 0) return Unavailable("cli_failed");
            if (result.Stdout.Length == 0 || result.Stdout.Length > MaxStdoutChars) return Unavailable("output_too_large");
            using var document = JsonDocument.Parse(result.Stdout);
            return ParseSnapshot(document.RootElement);
        }
        catch (OperationCanceledException)
        {
            return Unavailable("cli_timeout");
        }
        catch (InvalidOperationException error) when (error.Message.StartsWith("usage_", StringComparison.Ordinal))
        {
            return Unavailable(error.Message);
        }
        catch (JsonException)
        {
            return Unavailable("invalid_json");
        }
        catch
        {
            return Unavailable("cli_unavailable");
        }
    }

    private ModelUsagePanelSnapshotDto ParseSnapshot(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object || ReadString(root, "protocol") != SnapshotProtocol)
            return Unavailable("usage_invalid_protocol");
        var generatedAt = ReadRequiredTimestamp(root, "generatedAt");
        var window = ParseWindow(root.TryGetProperty("window", out var windowElement) ? windowElement : default);
        var status = ReadString(root, "status");
        if (!string.IsNullOrWhiteSpace(status) && !string.Equals(status, "unavailable", StringComparison.Ordinal))
            return Unavailable("usage_invalid_status");
        if (string.Equals(status, "unavailable", StringComparison.Ordinal))
        {
            var error = ReadString(root, "error");
            RequireBounded(error, 96, "usage_invalid_error");
            if (root.TryGetProperty("records", out var unavailableRecords) && unavailableRecords.ValueKind != JsonValueKind.Array)
                return Unavailable("usage_invalid_records");
            if (root.TryGetProperty("records", out unavailableRecords) && unavailableRecords.GetArrayLength() != 0)
                return Unavailable("usage_invalid_records");
            if (root.TryGetProperty("summary", out var unavailableSummary) && unavailableSummary.ValueKind != JsonValueKind.Null)
                return Unavailable("usage_invalid_summary");
            return new ModelUsagePanelSnapshotDto(SnapshotProtocol, generatedAt, "unavailable", error, Array.Empty<ModelUsageRecordDto>(), null, window);
        }
        if (!root.TryGetProperty("records", out var recordsElement)) return Unavailable("usage_invalid_records");
        var records = new List<ModelUsageRecordDto>();
        if (recordsElement.ValueKind != JsonValueKind.Array || recordsElement.GetArrayLength() > MaxRecords)
            return Unavailable("usage_invalid_records");
        foreach (var item in recordsElement.EnumerateArray()) records.Add(ParseRecord(item));
        if (!root.TryGetProperty("summary", out var summaryElement) || summaryElement.ValueKind != JsonValueKind.Object)
            return Unavailable("usage_invalid_summary");
        var summary = ParseSummary(summaryElement);
        if (summary.Calls < records.Count || summary.Calls < 0 || summary.SucceededCalls < 0 || summary.FailedCalls < 0)
            return Unavailable("usage_invalid_summary");
        return new ModelUsagePanelSnapshotDto(SnapshotProtocol, generatedAt, null, null, records, summary, window);
    }

    private static ModelUsageRecordDto ParseRecord(JsonElement item)
    {
        if (item.ValueKind != JsonValueKind.Object || ReadString(item, "protocol") != RecordProtocol)
            throw new InvalidOperationException("usage_invalid_record");
        var record = JsonSerializer.Deserialize<ModelUsageRecordDto>(item.GetRawText(), Options)
            ?? throw new InvalidOperationException("usage_invalid_record");
        RequireBounded(record.Protocol, 80, "usage_invalid_record");
        RequireBounded(record.CallId, 128, "usage_invalid_record");
        RequireBounded(record.Operation, 128, "usage_invalid_record");
        RequireBounded(record.Provider, 128, "usage_invalid_record");
        RequireBounded(record.Model, 256, "usage_invalid_record");
        RequireBounded(record.Status, 32, "usage_invalid_record");
        RequireBounded(record.CostSource, 32, "usage_invalid_record");
        RequireOptionalBounded(record.TurnId, 128, "usage_invalid_record");
        RequireOptionalBounded(record.RouteDecision, 128, "usage_invalid_record");
        RequireOptionalBounded(record.FallbackReason, 256, "usage_invalid_record");
        RequireOptionalBounded(record.RouteMode, 32, "usage_invalid_record");
        RequireOptionalBounded(record.EffectivePath, 32, "usage_invalid_record");
        RequireOptionalBounded(record.CoordinatorRoute, 32, "usage_invalid_record");
        RequireOptionalBounded(record.RouteComparisonId, 128, "usage_invalid_record");
        if (!Statuses.Contains(record.Status) || !CostSources.Contains(record.CostSource)) throw new InvalidOperationException("usage_invalid_record");
        RequireTimestamp(record.Timestamp, "usage_invalid_record");
        ValidateNumbers(record, "usage_invalid_record");
        return record;
    }

    private static ModelUsageSummaryDto ParseSummary(JsonElement element)
    {
        var summary = JsonSerializer.Deserialize<ModelUsageSummaryDto>(element.GetRawText(), Options)
            ?? throw new InvalidOperationException("usage_invalid_summary");
        if (summary.Protocol != RecordProtocol) throw new InvalidOperationException("usage_invalid_summary");
        RequireTimestamp(summary.GeneratedAt, "usage_invalid_summary");
        foreach (var value in new[] { summary.Calls, summary.SucceededCalls, summary.FailedCalls, summary.KnownCostCalls, summary.UnknownCostCalls })
            if (value < 0) throw new InvalidOperationException("usage_invalid_summary");
        ValidateNonNegative(summary.TotalInputTokens, "usage_invalid_summary");
        ValidateNonNegative(summary.TotalOutputTokens, "usage_invalid_summary");
        ValidateNonNegative(summary.TotalCacheReadInputTokens, "usage_invalid_summary");
        ValidateNonNegative(summary.TotalCacheCreationInputTokens, "usage_invalid_summary");
        ValidateNonNegative(summary.TotalTokens, "usage_invalid_summary");
        ValidateNonNegative(summary.ReportedCostUsd, "usage_invalid_summary");
        ValidateNonNegative(summary.CalculatedCostUsd, "usage_invalid_summary");
        ValidateNonNegative(summary.KnownCostUsd, "usage_invalid_summary");
        foreach (var value in new[] { summary.UnknownInputTokenCalls, summary.UnknownOutputTokenCalls, summary.UnknownTotalTokenCalls })
            if (value < 0) throw new InvalidOperationException("usage_invalid_summary");
        ValidateNullable(summary.FailureRate, "usage_invalid_summary");
        if (summary.FailureRate is < 0 or > 1) throw new InvalidOperationException("usage_invalid_summary");
        ValidateNullable(summary.P50LatencyMs, "usage_invalid_summary");
        ValidateNullable(summary.P95LatencyMs, "usage_invalid_summary");
        if (summary.RouteMetrics.PairedComparisons < 0 || summary.RouteMetrics.AgreeingComparisons < 0 || summary.RouteMetrics.SkippedCoordinatorCalls < 0)
            throw new InvalidOperationException("usage_invalid_summary");
        ValidateNullable(summary.RouteMetrics.AgreementRate, "usage_invalid_summary");
        if (summary.RouteMetrics.AgreementRate is < 0 or > 1) throw new InvalidOperationException("usage_invalid_summary");
        ValidateBuckets(summary.ByProvider, "usage_invalid_summary");
        ValidateBuckets(summary.ByModel, "usage_invalid_summary");
        ValidateBuckets(summary.ByDate, "usage_invalid_summary");
        return summary;
    }

    private static ModelUsageSnapshotWindowDto ParseWindow(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("usage_invalid_window");
        var window = JsonSerializer.Deserialize<ModelUsageSnapshotWindowDto>(element.GetRawText(), Options)
            ?? throw new InvalidOperationException("usage_invalid_window");
        if (window.MaxRetainedRecords is < 0 or > 50_000 || window.RetainedRecords is < 0 or > MaxRecords || window.DisplayLimit is < 0 or > MaxRecords
            || window.RetainedRecords > window.MaxRetainedRecords || !string.Equals(window.DateTimeZone, "UTC", StringComparison.Ordinal))
            throw new InvalidOperationException("usage_invalid_window");
        if (window.OldestTimestamp is not null) RequireTimestamp(window.OldestTimestamp, "usage_invalid_window");
        if (window.NewestTimestamp is not null) RequireTimestamp(window.NewestTimestamp, "usage_invalid_window");
        return window;
    }

    private static void ValidateBuckets(Dictionary<string, ModelUsageBucketDto> buckets, string code)
    {
        if (buckets.Count > 1_000) throw new InvalidOperationException(code);
        foreach (var pair in buckets)
        {
            RequireBounded(pair.Key, 256, code);
            if (pair.Value is null || pair.Value.Calls < 0) throw new InvalidOperationException(code);
            ValidateNonNegative(pair.Value.TotalTokens, code);
            ValidateNonNegative(pair.Value.KnownCostUsd, code);
        }
    }

    private static void ValidateNumbers(ModelUsageRecordDto value, string code)
    {
        ValidateNullable(value.InputTokens, code); ValidateNullable(value.OutputTokens, code);
        ValidateNullable(value.CacheReadInputTokens, code); ValidateNullable(value.CacheCreationInputTokens, code);
        ValidateNullable(value.TotalTokens, code); ValidateNullable(value.LatencyMs, code);
        ValidateNullable(value.ReportedCostUsd, code); ValidateNullable(value.CalculatedCostUsd, code);
        ValidateNullable(value.InputRateUsdPer1M, code); ValidateNullable(value.OutputRateUsdPer1M, code);
        ValidateNullable(value.CacheReadInputRateUsdPer1M, code); ValidateNullable(value.CacheCreationInputRateUsdPer1M, code);
    }

    private static void ValidateNullable(double? value, string code)
    {
        if (value is not null) ValidateNonNegative(value.Value, code);
    }

    private static void ValidateNonNegative(double value, string code)
    {
        if (!double.IsFinite(value) || value < 0) throw new InvalidOperationException(code);
    }

    private static string ReadRequiredTimestamp(JsonElement root, string property)
    {
        var value = ReadString(root, property);
        RequireTimestamp(value, "usage_invalid_snapshot");
        return value;
    }

    private static void RequireTimestamp(string value, string code)
    {
        if (string.IsNullOrWhiteSpace(value) || !DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out _)) throw new InvalidOperationException(code);
    }

    private static void RequireBounded(string value, int maxLength, string code)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maxLength || value.IndexOfAny(['\r', '\n', '\0']) >= 0) throw new InvalidOperationException(code);
    }

    private static void RequireOptionalBounded(string? value, int maxLength, string code)
    {
        if (value is not null) RequireBounded(value, maxLength, code);
    }

    private static string ReadString(JsonElement element, string property)
        => element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";

    private string ResolveCliPath()
    {
        var candidates = new[]
        {
            Path.Combine(_suiteRoot, "packages", "bridge-runtime", "dist", "usage-control.mjs"),
            Path.Combine(_skillRoot, "dist", "usage-control.mjs"),
        };
        var resolved = candidates.FirstOrDefault(File.Exists);
        return resolved is null ? throw new InvalidOperationException("usage_cli_missing") : Path.GetFullPath(resolved);
    }

    private string ResolveWorkingDirectory()
        => !string.IsNullOrWhiteSpace(_suiteRoot) && Directory.Exists(_suiteRoot) ? _suiteRoot
            : !string.IsNullOrWhiteSpace(_skillRoot) && Directory.Exists(_skillRoot) ? _skillRoot
            : _ctiHome;

    private static ModelUsagePanelSnapshotDto Unavailable(string error)
        => new(SnapshotProtocol, DateTime.UtcNow.ToString("o"), "unavailable", error, Array.Empty<ModelUsageRecordDto>(), null,
            new ModelUsageSnapshotWindowDto { MaxRetainedRecords = 0, RetainedRecords = 0, DisplayLimit = MaxRecords, RecordsTruncated = false, DateTimeZone = "UTC" });

    private static readonly JsonSerializerOptions Options = new() { PropertyNameCaseInsensitive = true, NumberHandling = JsonNumberHandling.Strict };

    private static async Task<ModelUsageCliExecutionResult> ExecuteProcessAsync(ModelUsageCliInvocation invocation)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = invocation.FileName,
                WorkingDirectory = Directory.Exists(invocation.WorkingDirectory) ? invocation.WorkingDirectory : Environment.CurrentDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardErrorEncoding = new UTF8Encoding(false),
                CreateNoWindow = true,
            },
        };
        foreach (var argument in invocation.Arguments) process.StartInfo.ArgumentList.Add(argument);
        foreach (var pair in invocation.Environment) process.StartInfo.Environment[pair.Key] = pair.Value ?? "";
        process.Start();
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(invocation.TimeoutMs);
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            return new ModelUsageCliExecutionResult(-1, await stdout, $"timeout after {invocation.TimeoutMs} ms");
        }
        return new ModelUsageCliExecutionResult(process.ExitCode, await stdout, await stderr);
    }
}
