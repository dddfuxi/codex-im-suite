namespace ClaudeToImControlPanel;

/// <summary>
/// 统一约束控制面板可写入的协作模式，避免 UI 或任意 payload 把未知值写入 config.env。
/// </summary>
internal static class AgentCollaborationModePolicy
{
    public static string Normalize(string? value)
    {
        var mode = (value ?? "").Trim().ToLowerInvariant();
        return mode switch
        {
            "off" => "off",
            "shadow" => "shadow",
            "assist" => "assist",
            _ => throw new InvalidOperationException("协作模式只允许 off、shadow 或 assist。"),
        };
    }
}
