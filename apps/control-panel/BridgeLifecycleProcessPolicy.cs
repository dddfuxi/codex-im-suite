namespace ClaudeToImControlPanel;

internal static class BridgeLifecycleProcessPolicy
{
    public static bool PreserveManagedChildrenOnTimeout(string action)
    {
        var command = (action ?? "")
            .Trim()
            .Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault();
        return string.Equals(command, "start", StringComparison.OrdinalIgnoreCase)
            || string.Equals(command, "restart", StringComparison.OrdinalIgnoreCase);
    }
}
