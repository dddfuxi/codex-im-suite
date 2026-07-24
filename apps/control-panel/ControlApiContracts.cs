using System.Text.Json;

namespace ClaudeToImControlPanel;

/// <summary>
/// 控制面板跨 HTTP、WebView2 和 React 共用的薄 wire DTO。
/// 字段集合由 packages/contracts/schemas/control-api.schema.json 约束，
/// 这里不复制任何权限、工作区或业务裁决逻辑。
/// </summary>
internal static class ControlApiContracts
{
    internal const string PanelStateSchema = "codex-im-suite/control-panel-state/v1";
    internal const string CommandSchema = "codex-im-suite/control-command/v1";
    internal const string ResultSchema = "codex-im-suite/control-result/v1";
}

internal sealed class ControlCommandRequest
{
    public string Schema { get; set; } = ControlApiContracts.CommandSchema;
    public string Id { get; set; } = "";
    public string Type { get; set; } = "command";
    public string Command { get; set; } = "";
    public JsonElement Payload { get; set; }
    public string? NodeId { get; set; }
}

internal sealed record ControlCommandResult(
    string Schema,
    string Id,
    string Type,
    bool Ok,
    object? Data = null,
    string? Error = null,
    string? NodeId = null)
{
    internal static ControlCommandResult Success(string id, object? data)
        => new(ControlApiContracts.ResultSchema, id, "result", true, data);

    internal static ControlCommandResult Failure(string id, string error)
        => new(ControlApiContracts.ResultSchema, id, "result", false, null, error);
}

internal sealed record RuntimeActionContract(string Id, string Label, bool Enabled, string Reason = "");

internal sealed record RuntimeUnitContract(
    string UnitId,
    string Id,
    string DisplayName,
    string Kind,
    string Category,
    string Status,
    string Detail,
    bool Enabled,
    string InstallState,
    string Source,
    string Cwd,
    string Version,
    string Description,
    bool CanInstall,
    RuntimeActionContract[] Actions);

internal sealed record RegisteredProjectContract(
    string Id,
    string DisplayName,
    string Type,
    string WorkspaceRoot,
    string AccessMode,
    bool Enabled,
    string? UnityProjectRoot = null,
    string[]? McpProfileIds = null);

internal sealed record ProjectRegistrySnapshotContract(
    string Schema,
    string GeneratedAt,
    string RegistryPath,
    bool Exists,
    RegisteredProjectContract[] Projects,
    string Error);

internal sealed record CollaborationAgentManifestContract(
    string Protocol,
    string Id,
    string DisplayName,
    bool Enabled,
    string[] Responsibilities,
    string[] Owns,
    string[] Excludes,
    string[] Capabilities,
    string[] InputEvidenceKinds,
    string OutputSchemaId,
    string SideEffectLevel,
    int TimeoutMs,
    int Concurrency,
    string ModelProfile);

internal sealed record AgentWorkerViewContract(
    string WorkerId,
    int? Pid,
    string Health,
    string? ActiveTaskId,
    string? StartedAt,
    string? LastHeartbeatAt,
    int RestartCount,
    int TimeoutCount,
    int CircuitOpenCount,
    string? CircuitOpenUntil,
    string? LastErrorCode);

internal sealed record AgentResponsibilityViewContract(
    CollaborationAgentManifestContract Manifest,
    string? WorkerId,
    string Health,
    string? LastInvokedAt,
    double? LastDurationMs,
    int SuccessCount,
    int FailureCount,
    int TimeoutCount,
    double? AverageDurationMs,
    double? P95DurationMs);

internal sealed record AgentCollaborationMetricsViewContract(
    int WindowRunCount,
    double CoordinatorTriggerRate,
    double FallbackRate,
    int WorkerRestartCount,
    int WorkerTimeoutCount,
    int CircuitOpenCount,
    object SpecialistCallDistribution);

internal sealed record AgentCollaborationPanelStateContract(
    string Protocol,
    string UpdatedAt,
    string Mode,
    string PoolHealth,
    int ActiveTaskCount,
    AgentWorkerViewContract[] Workers,
    AgentResponsibilityViewContract[] Agents,
    object? CurrentRun,
    object[] RecentRuns,
    AgentCollaborationMetricsViewContract Metrics,
    object? LatestPerformanceSuggestion);

internal sealed record ControlPanelStateContract(
    string Schema,
    string GeneratedAt,
    object Suite,
    object Services,
    object Nodes,
    object Extensions,
    object SkillGovernance,
    object PromptSnapshots,
    object ScheduledTasks,
    object Mcp,
    object Release,
    object LiveSync,
    object Settings,
    object History,
    object Workflow,
    object? AgentCollaboration,
    object ProjectRegistry,
    object Memory,
    object MemorySkillAssets,
    object MemoryReminders,
    object Executors,
    object Permissions,
    object Paths,
    object Activities,
    object? Diagnostics = null);
