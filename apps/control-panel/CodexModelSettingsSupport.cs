namespace ClaudeToImControlPanel;

internal static class CodexModelSettingsSupport
{
    internal static bool ShouldPassModel(string? model)
        => !string.IsNullOrWhiteSpace(model);

    internal static string BuildLoadedSummary(string source, string model, string effort)
    {
        var normalizedSource = string.IsNullOrWhiteSpace(source) ? "official" : source.Trim();
        var modelText = string.IsNullOrWhiteSpace(model) ? "来源默认模型" : model.Trim();
        var normalizedEffort = string.IsNullOrWhiteSpace(effort) ? "low" : effort.Trim();
        return $"Bridge 已加载 Codex 配置：来源={normalizedSource}，模型={modelText}，普通任务推理强度={normalizedEffort}。实际任务参数请查看 Workflow。";
    }
}
