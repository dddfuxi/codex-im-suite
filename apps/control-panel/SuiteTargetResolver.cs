namespace ClaudeToImControlPanel;

/// <summary>
/// 统一解析控制面板当前对应的 suite 源码根目录。
/// 允许显式覆盖，但默认优先当前 worktree/运行程序集祖先，避免外部路径抢占当前开发入口。
/// </summary>
internal static class SuiteTargetResolver
{
    public static string Resolve(
        string explicitRoot,
        string currentDirectory,
        string appBaseDirectory,
        string userProfile,
        string skillDir)
    {
        var candidates = new List<string>();
        AddCandidate(candidates, explicitRoot);
        AddAncestors(candidates, currentDirectory);
        AddAncestors(candidates, appBaseDirectory);
        AddCandidate(candidates, Path.Combine(currentDirectory, "codex-im-suite"));
        AddCandidate(candidates, Path.Combine(userProfile, "Documents", "New project", "codex-im-suite"));
        AddCandidate(candidates, Path.Combine(skillDir, "codex-im-suite"));

        foreach (var candidate in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (IsSuiteRoot(candidate)) return Path.GetFullPath(candidate);
        }
        return "";
    }

    private static void AddAncestors(List<string> candidates, string startPath)
    {
        if (string.IsNullOrWhiteSpace(startPath)) return;
        DirectoryInfo? current;
        try { current = new DirectoryInfo(Path.GetFullPath(startPath)); }
        catch { return; }
        for (var depth = 0; current is not null && depth < 12; depth += 1, current = current.Parent)
        {
            AddCandidate(candidates, current.FullName);
        }
    }

    private static void AddCandidate(List<string> candidates, string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        try { candidates.Add(Path.GetFullPath(value.Trim())); }
        catch { }
    }

    private static bool IsSuiteRoot(string candidate)
        => File.Exists(Path.Combine(candidate, "suite.manifest.json"))
           && File.Exists(Path.Combine(candidate, "scripts", "publish-backup.ps1"));
}
