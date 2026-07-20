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
    object ProjectRegistry,
    object Memory,
    object MemorySkillAssets,
    object MemoryReminders,
    object Executors,
    object Permissions,
    object Paths,
    object Activities,
    object? Diagnostics = null);
