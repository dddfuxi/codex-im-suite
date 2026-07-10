using System.Text;
using System.Text.Json;
using ClaudeToImControlPanel;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class FeishuStickerLibraryTests
{
    [Fact]
    public void Read_ReturnsSanitizedStickerRecords()
    {
        var root = CreateTempRoot();
        var artifacts = new MemoryArtifactStore(root);
        Directory.CreateDirectory(Path.GetDirectoryName(artifacts.FeishuStickerStorePath)!);
        File.WriteAllText(artifacts.FeishuStickerStorePath, JsonSerializer.Serialize(new
        {
            version = 1,
            updatedAt = "2026-06-06T08:00:00.000Z",
            stickers = new[]
            {
                new
                {
                    fileKey = "sticker_1",
                    aliases = new[] { "表情包", "疑惑", "疑惑" },
                    chatId = "oc_group",
                    label = "疑惑猫",
                    intent = "表达疑惑",
                    disabled = true,
                    disabledReason = "误学语义",
                    firstSeenAt = "2026-06-06T01:00:00.000Z",
                    lastSeenAt = "2026-06-06T02:00:00.000Z",
                    useCount = 3,
                },
            },
        }), new UTF8Encoding(false));

        var snapshot = FeishuStickerLibrary.Read(artifacts);

        Assert.Equal("codex-im-suite/feishu-sticker-library/v1", snapshot.Schema);
        Assert.Equal(artifacts.FeishuStickerStorePath, snapshot.StorePath);
        Assert.Single(snapshot.Stickers);
        Assert.Equal("疑惑猫", snapshot.Stickers[0].Label);
        Assert.Equal(["表情包", "疑惑"], snapshot.Stickers[0].Aliases);
        Assert.True(snapshot.Stickers[0].Disabled);
        Assert.Equal("误学语义", snapshot.Stickers[0].DisabledReason);
    }

    [Fact]
    public void Update_EditsSemanticFieldsAndPreservesUtf8()
    {
        var root = CreateTempRoot();
        var artifacts = WriteSampleStore(root);

        var snapshot = FeishuStickerLibrary.Update(artifacts, new FeishuStickerUpdateRequest
        {
            FileKey = "sticker_1",
            Label = "干嘛猫",
            Description = "疑惑地看着对方",
            Intent = "疑惑、吐槽",
            Tone = "轻松吐槽",
            Usage = "别人突然丢奇怪需求时",
            Disabled = true,
            DisabledReason = "先禁用确认",
        });

        var item = Assert.Single(snapshot.Stickers);
        Assert.Equal("干嘛猫", item.Label);
        Assert.Equal("疑惑、吐槽", item.Intent);
        Assert.True(item.Disabled);
        Assert.Equal("先禁用确认", item.DisabledReason);
        Assert.False(string.IsNullOrWhiteSpace(item.LastEditedAt));
        Assert.DoesNotContain('\uFEFF', File.ReadAllText(artifacts.FeishuStickerStorePath, Encoding.UTF8));
        Assert.Contains("干嘛猫", File.ReadAllText(artifacts.FeishuStickerStorePath, Encoding.UTF8));
        using var document = JsonDocument.Parse(File.ReadAllText(artifacts.FeishuStickerStorePath, Encoding.UTF8));
        var sticker = document.RootElement.GetProperty("stickers")[0];
        Assert.Equal("manual", sticker.GetProperty("annotationSource").GetString());
        Assert.False(string.IsNullOrWhiteSpace(sticker.GetProperty("annotationVerifiedAt").GetString()));
    }

    [Fact]
    public void MergeAliases_DeduplicatesAndTrimsAliases()
    {
        var root = CreateTempRoot();
        var artifacts = WriteSampleStore(root);

        var snapshot = FeishuStickerLibrary.MergeAliases(artifacts, new FeishuStickerAliasMergeRequest
        {
            FileKey = "sticker_1",
            Aliases = ["疑惑", "干嘛猫", "  吐槽  ", ""],
        });

        var item = Assert.Single(snapshot.Stickers);
        Assert.Equal(["表情包", "疑惑", "干嘛猫", "吐槽"], item.Aliases);
        Assert.False(string.IsNullOrWhiteSpace(item.LastEditedAt));
    }

    private static string CreateTempRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), $"cti-sticker-library-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        return root;
    }

    private static MemoryArtifactStore WriteSampleStore(string root)
    {
        var artifacts = new MemoryArtifactStore(root);
        Directory.CreateDirectory(Path.GetDirectoryName(artifacts.FeishuStickerStorePath)!);
        File.WriteAllText(artifacts.FeishuStickerStorePath, JsonSerializer.Serialize(new
        {
            version = 1,
            updatedAt = "2026-06-06T08:00:00.000Z",
            stickers = new[]
            {
                new
                {
                    fileKey = "sticker_1",
                    aliases = new[] { "表情包", "疑惑" },
                    chatId = "oc_group",
                    label = "疑惑",
                    intent = "疑惑",
                    firstSeenAt = "2026-06-06T01:00:00.000Z",
                    lastSeenAt = "2026-06-06T02:00:00.000Z",
                    useCount = 3,
                },
            },
        }), new UTF8Encoding(false));
        return artifacts;
    }
}
