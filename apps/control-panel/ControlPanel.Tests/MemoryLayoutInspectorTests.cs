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

    [Fact]
    public void Inspector_AlsoReportsMarkdownUnderDocsButExcludesHumanDocumentArchives()
    {
        var root = Path.Combine(Path.GetTempPath(), "cti-memory-doc-tree-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(root, "docs", "nested"));
        Directory.CreateDirectory(Path.Combine(root, "archive", "human-documents", "batch-1"));
        File.WriteAllText(Path.Combine(root, "docs", "AI_BRIDGE_CONTEXT.md"), "# 旧说明", System.Text.Encoding.UTF8);
        File.WriteAllText(Path.Combine(root, "docs", "nested", "操作手册.md"), "# 操作手册", System.Text.Encoding.UTF8);
        File.WriteAllText(Path.Combine(root, "archive", "human-documents", "batch-1", "旧说明.md"), "# 已归档", System.Text.Encoding.UTF8);

        try
        {
            var snapshot = MemoryLayoutInspector.Inspect(root);

            Assert.Equal(
                ["docs/AI_BRIDGE_CONTEXT.md", "docs/nested/操作手册.md"],
                snapshot.UnclassifiedRootDocuments.Select(item => item.Name).ToArray());
            Assert.DoesNotContain(snapshot.UnclassifiedRootDocuments, item => item.Name.Contains("archive", StringComparison.OrdinalIgnoreCase));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void Inspector_ReportsVisibleSelfMaintenanceArchivesAndHiddenVersionHistory()
    {
        var root = Path.Combine(Path.GetTempPath(), "cti-self-layout-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(root, "daily-reflection"));
        Directory.CreateDirectory(Path.Combine(root, "work", "alpha-123"));
        Directory.CreateDirectory(Path.Combine(root, "corrections"));
        Directory.CreateDirectory(Path.Combine(root, ".cti-self-history", "versions", "v1"));
        File.WriteAllText(Path.Combine(root, "daily-reflection", "每日反思-2026-07-18.md"), "# 每日反思", System.Text.Encoding.UTF8);
        File.WriteAllText(Path.Combine(root, "work", "alpha-123", "工作档案.md"), "# 工作档案", System.Text.Encoding.UTF8);
        File.WriteAllText(Path.Combine(root, "corrections", "纠错记录-2026-07-18.md"), "# 纠错记录", System.Text.Encoding.UTF8);
        File.WriteAllText(Path.Combine(root, ".cti-self-history", "versions", "v1", "机器人身份.md"), "# 旧身份", System.Text.Encoding.UTF8);
        File.WriteAllText(Path.Combine(root, ".cti-self-history", "status.json"), "{\"updatedAt\":\"2026-07-18T08:00:00.000Z\"}", System.Text.Encoding.UTF8);
        File.WriteAllText(Path.Combine(root, ".cti-self-history", "metrics.json"), "{\"totalCalls\":12,\"applied\":3,\"rejected\":2,\"skipped\":8,\"averageDurationMs\":95,\"lockConflicts\":1,\"hashConflicts\":1}", System.Text.Encoding.UTF8);
        Directory.CreateDirectory(Path.Combine(root, ".cti-self-history", "rules", "tool_rules"));
        File.WriteAllText(Path.Combine(root, ".cti-self-history", "rules", "tool_rules", "trial.json"), "{\"status\":\"trial\"}", System.Text.Encoding.UTF8);
        File.WriteAllText(Path.Combine(root, ".cti-self-history", "rules", "tool_rules", "confirmed.json"), "{\"status\":\"confirmed\"}", System.Text.Encoding.UTF8);
        File.WriteAllText(Path.Combine(root, ".cti-self-history", "rules", "tool_rules", "regressed.json"), "{\"status\":\"regressed\"}", System.Text.Encoding.UTF8);

        try
        {
            var snapshot = MemoryLayoutInspector.Inspect(root);

            Assert.Equal(1, snapshot.SelfMaintenance.DailyReflectionCount);
            Assert.Equal(1, snapshot.SelfMaintenance.WorkProfileCount);
            Assert.Equal(1, snapshot.SelfMaintenance.CorrectionDocumentCount);
            Assert.Equal(1, snapshot.SelfMaintenance.VersionBackupCount);
            Assert.Equal("2026-07-18T08:00:00.000Z", snapshot.SelfMaintenance.LastUpdatedAt);
            Assert.Equal(12, snapshot.SelfMaintenance.ClassifierCalls);
            Assert.Equal(8, snapshot.SelfMaintenance.ClassifierSkips);
            Assert.Equal(95, snapshot.SelfMaintenance.AverageDurationMs);
            Assert.Equal(1, snapshot.SelfMaintenance.TrialRuleCount);
            Assert.Equal(1, snapshot.SelfMaintenance.ConfirmedRuleCount);
            Assert.Equal(1, snapshot.SelfMaintenance.RegressedRuleCount);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
