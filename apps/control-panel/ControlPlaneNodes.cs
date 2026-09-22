namespace ClaudeToImControlPanel;

internal sealed partial class MainForm
{
    private WebNodeSnapshot BuildNodeSnapshot(
        string suiteVersion,
        WebServiceItem[] services,
        WebMcpItem[] mcpItems,
        (int Total, int Enabled, int Disabled, int MissingSources) extensions)
    {
        var generatedAt = DateTimeOffset.Now.ToString("O");
        var localCapabilities = new List<WebNodeCapability>();

        foreach (var service in services)
        {
            localCapabilities.Add(new WebNodeCapability(
                service.Id,
                service.Title,
                service.Id switch
                {
                    "bridge" => "bridge",
                    "codex" or "localLlm" => "executor",
                    "mcp" => "mcp",
                    _ => "custom",
                },
                MapPanelStatusToNodeStatus(service.Status),
                FirstLine(service.Detail),
                service.Id is "bridge" or "mcp" ? "medium" : "low"));
        }

        localCapabilities.Add(new WebNodeCapability(
            "mcp.inventory",
            "MCP 能力清单",
            "mcp",
            mcpItems.Any(item => item.IsRunning) ? "online" : (mcpItems.Length > 0 ? "degraded" : "unknown"),
            $"已启用 {mcpItems.Count(item => item.Enabled)} / 共 {mcpItems.Length}，运行 {mcpItems.Count(item => item.IsRunning)}",
            "medium"));
        localCapabilities.Add(new WebNodeCapability(
            "extension.inventory",
            "扩展目录",
            "extension",
            extensions.MissingSources > 0 ? "degraded" : "online",
            $"启用 {extensions.Enabled}/{extensions.Total}，缺依赖 {extensions.MissingSources}",
            "medium"));
        localCapabilities.Add(new WebNodeCapability(
            "workflow.trace",
            "Workflow Trace",
            "executor",
            File.Exists(_workflowStatusPath) ? "online" : "unknown",
            File.Exists(_workflowStatusPath) ? _workflowStatusPath : "尚未生成 workflow-runs.json",
            "low"));
        localCapabilities.Add(new WebNodeCapability(
            "media.proxy",
            "媒体缓存代理",
            "media",
            Directory.Exists(_mediaCacheDir) ? "online" : "unknown",
            _mediaCacheDir,
            "low"));

        var localStatus = localCapabilities.Any(item => item.Status == "offline")
            ? "offline"
            : localCapabilities.Any(item => item.Status == "degraded")
                ? "degraded"
                : "online";

        var nodes = new List<WebNodeAgent>
        {
            new(
                "local",
                "本机 runtime 节点",
                "local",
                localStatus,
                suiteVersion,
                _controlApiBaseUrl,
                generatedAt,
                localCapabilities.ToArray(),
                "默认节点，直接管理当前 Windows 本机 bridge、MCP、记忆、发布和媒体缓存。",
                true,
                true),
        };

        var fakeEnabled = !string.Equals(GetConfig("CTI_CONTROL_FAKE_REMOTE_NODE_ENABLED", "true"), "false", StringComparison.OrdinalIgnoreCase);
        if (fakeEnabled)
        {
            nodes.Add(new WebNodeAgent(
                "fake-remote",
                "模拟远端 runtime",
                "fake",
                "degraded",
                suiteVersion,
                "fake://remote-runtime",
                generatedAt,
                new[]
                {
                    new WebNodeCapability("heartbeat", "Heartbeat", "custom", "online", "用于验证多节点控制面数据结构。", "low"),
                    new WebNodeCapability("action.lease", "Action Lease", "custom", "degraded", "只读模拟节点，不执行真实命令。", "medium"),
                    new WebNodeCapability("log.stream", "Log Stream", "custom", "degraded", "后续接入远端日志流。", "low"),
                },
                "只读 fake 节点，用于先验证控制面、契约和 UI，不触发任何远端副作用。",
                false,
                false));
        }

        return new WebNodeSnapshot(
            "codex-im-suite/control-plane-state/v1",
            generatedAt,
            "local",
            nodes.ToArray());
    }

    private static string MapPanelStatusToNodeStatus(string status)
        => status switch
        {
            "ok" => "online",
            "warning" => "degraded",
            "error" => "offline",
            _ => "unknown",
        };
}
