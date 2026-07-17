using ClaudeToImControlPanel;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class MemoryLayoutInspectorTests
{
    [Fact]
    public void Classifier_AcceptsV3UserMemoryAndMarksV2AsLegacy()
    {
        var root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        var v3Path = Path.Combine(root, "memory", "users", "feishu", "ou_user_1", "用户印象.md");
        var v2Path = Path.Combine(root, "data", "memory", "v2", "users", "feishu", "ou_user_1", "legacy.md");
        var common = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["memoryScope"] = "user",
            ["channelType"] = "feishu",
            ["userId"] = "ou_user_1",
        };

        var v3 = MemorySourceLayoutClassifier.Classify(root, v3Path, new Dictionary<string, string>(common)
        {
            ["schema"] = "codex-im-suite/memory/v3",
        });
        var v2 = MemorySourceLayoutClassifier.Classify(root, v2Path, new Dictionary<string, string>(common)
        {
            ["schema"] = "codex-im-suite/memory/v2",
        });

        Assert.Equal("memory_user", v3.SourceGroup);
        Assert.False(v3.Legacy);
        Assert.Equal("memory_user", v2.SourceGroup);
        Assert.True(v2.Legacy);
    }

    [Fact]
    public void Inspector_ReportsAgentHomeAndMigrationState()
    {
        var root = Path.Combine(Path.GetTempPath(), "cti-memory-layout-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(root, "memory", "users", "feishu", "ou_user_1"));
        Directory.CreateDirectory(Path.Combine(root, "data", "memory", "v2", "users", "feishu", "ou_user_1"));
        File.WriteAllText(Path.Combine(root, "机器人身份.md"), "# 机器人身份", System.Text.Encoding.UTF8);
        File.WriteAllText(Path.Combine(root, "memory", "users", "feishu", "ou_user_1", "用户印象.md"), "---\nschema: codex-im-suite/memory/v3\n---", System.Text.Encoding.UTF8);
        File.WriteAllText(Path.Combine(root, "data", "memory", "v2", "users", "feishu", "ou_user_1", "legacy.md"), "---\nschema: codex-im-suite/memory/v2\n---", System.Text.Encoding.UTF8);

        try
        {
            var snapshot = MemoryLayoutInspector.Inspect(root);

            Assert.Equal("mixed", snapshot.MigrationState);
            Assert.Equal(1, snapshot.V3SourceCount);
            Assert.Equal(1, snapshot.LegacySourceCount);
            Assert.Equal(5, snapshot.AgentHome.Count);
            Assert.True(snapshot.AgentHome.Single(item => item.Name == "机器人身份.md").Exists);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Inspector_ReportsRootMarkdownOutsideAgentHomeWithoutMovingIt()
    {
        var root = Path.Combine(Path.GetTempPath(), "cti-memory-root-docs-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        File.WriteAllText(Path.Combine(root, "机器人身份.md"), "# 机器人身份", System.Text.Encoding.UTF8);
        File.WriteAllText(Path.Combine(root, "CodexNotes.md"), "# 旧笔记", System.Text.Encoding.UTF8);
        File.WriteAllText(Path.Combine(root, "临时说明.md"), "# 临时说明", System.Text.Encoding.UTF8);

        try
        {
            var snapshot = MemoryLayoutInspector.Inspect(root);

            Assert.Equal(
                ["CodexNotes.md", "临时说明.md"],
                snapshot.UnclassifiedRootDocuments.Select(item => item.Name).ToArray());
            Assert.All(snapshot.UnclassifiedRootDocuments, item => Assert.True(File.Exists(item.Path)));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
