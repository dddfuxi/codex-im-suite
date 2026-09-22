using System.Text;
using ClaudeToImControlPanel;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class SuiteTargetResolverTests
{
    [Fact]
    public void PrefersTheCurrentWorktreeOverTheDefaultMainCheckout()
    {
        var root = Path.Combine(Path.GetTempPath(), $"suite-target-resolver-{Guid.NewGuid():N}");
        var worktree = Path.Combine(root, "main", ".worktrees", "feature");
        var defaultMain = Path.Combine(root, "profile", "Documents", "New project", "codex-im-suite");

        try
        {
            CreateSuite(worktree);
            CreateSuite(defaultMain);

            var resolved = SuiteTargetResolver.Resolve(
                explicitRoot: "",
                currentDirectory: worktree,
                appBaseDirectory: Path.Combine(worktree, "apps", "control-panel", "bin", "Release", "net9.0-windows"),
                userProfile: Path.Combine(root, "profile"),
                skillDir: Path.Combine(root, "live-skill"));

            Assert.Equal(Path.GetFullPath(worktree), resolved);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }

    [Fact]
    public void UsesAnExplicitValidSuiteRootBeforeAutomaticDiscovery()
    {
        var root = Path.Combine(Path.GetTempPath(), $"suite-target-explicit-{Guid.NewGuid():N}");
        var explicitRoot = Path.Combine(root, "explicit");
        var current = Path.Combine(root, "current");

        try
        {
            CreateSuite(explicitRoot);
            CreateSuite(current);

            var resolved = SuiteTargetResolver.Resolve(explicitRoot, current, current, root, Path.Combine(root, "skill"));

            Assert.Equal(Path.GetFullPath(explicitRoot), resolved);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }

    private static void CreateSuite(string root)
    {
        Directory.CreateDirectory(Path.Combine(root, "scripts"));
        File.WriteAllText(Path.Combine(root, "suite.manifest.json"), "{}", new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(root, "scripts", "publish-backup.ps1"), "# fixture", new UTF8Encoding(false));
    }
}
