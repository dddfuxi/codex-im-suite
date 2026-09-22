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
    public void WriteOperationsRequireRuntimeGateway()
    {
        var artifacts = WriteSampleStore(CreateTempRoot());
        var operations = new Action[]
        {
            () => FeishuStickerLibrary.Update(artifacts, new FeishuStickerUpdateRequest { FileKey = "sticker_1", Intent = "疑惑" }),
            () => FeishuStickerLibrary.MergeAliases(artifacts, new FeishuStickerAliasMergeRequest { FileKey = "sticker_1", Aliases = ["疑惑"] }),
            () => FeishuStickerLibrary.Archive(artifacts, new FeishuStickerLifecycleRequest { FileKey = "sticker_1" }),
            () => FeishuStickerLibrary.Restore(artifacts, new FeishuStickerLifecycleRequest { FileKey = "sticker_1" }),
            () => FeishuStickerLibrary.DeleteArchived(artifacts, new FeishuStickerLifecycleRequest { FileKey = "sticker_1" }),
        };

        foreach (var operation in operations)
        {
            var error = Assert.Throws<InvalidOperationException>(operation);
            Assert.Contains("StickerSemanticGateway", error.Message);
        }
    }

    [Fact]
    public void Read_SniffsLegacyStickerMediaMimeAndAuditStatus()
    {
        var root = CreateTempRoot();
        var artifacts = new MemoryArtifactStore(root);
        Directory.CreateDirectory(Path.GetDirectoryName(artifacts.FeishuStickerStorePath)!);
        Directory.CreateDirectory(artifacts.FeishuStickerMediaDirPath);
        File.WriteAllText(artifacts.FeishuStickerStorePath, JsonSerializer.Serialize(new
        {
            version = 1,
            updatedAt = "2026-07-13T00:00:00.000Z",
            stickers = new object[]
            {
                new
                {
                    fileKey = "jpeg_sticker",
                    aliases = new[] { "最近", "默认", "表情包" },
                    chatId = "oc_group",
                    annotationSource = "user",
                    userAnnotation = new
                    {
                        intent = "用户说它是无语",
                    },
                    firstSeenAt = "2026-07-13T00:00:00.000Z",
                    lastSeenAt = "2026-07-13T00:01:00.000Z",
                    useCount = 0,
                },
                new
                {
                    fileKey = "missing_sticker",
                    aliases = new[] { "最近", "默认", "表情包" },
                    chatId = "oc_group",
                    mediaDownloadError = "Feishu message resource API did not return sticker media",
                    firstSeenAt = "2026-07-13T00:00:00.000Z",
                    lastSeenAt = "2026-07-13T00:01:00.000Z",
                    useCount = 0,
                },
            },
        }), new UTF8Encoding(false));
        File.WriteAllBytes(
            Path.Combine(artifacts.FeishuStickerMediaDirPath, MemoryArtifactStore.StableFileName("jpeg_sticker", ".png")),
            [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x01, 0x02]);

        var snapshot = FeishuStickerLibrary.Read(artifacts);
        var audit = FeishuStickerLibrary.Audit(artifacts);

        var jpeg = snapshot.Stickers.Single(item => item.FileKey == "jpeg_sticker");
        Assert.Equal("image/jpeg", jpeg.MediaMimeType);
        Assert.StartsWith("data:image/jpeg;base64,", jpeg.PreviewUrl);
        Assert.Equal("user", jpeg.AnnotationSource);
        Assert.True(jpeg.HasUserAnnotation);
        Assert.False(jpeg.HasTrustedSemantic);
        Assert.True(jpeg.IsLibraryAsset);
        Assert.False(jpeg.IsHistoryOnly);
        Assert.False(jpeg.HasMediaDownloadFailure);
        Assert.Equal("仅用户解释，待图片核验", jpeg.StatusLabel);

        var missing = snapshot.Stickers.Single(item => item.FileKey == "missing_sticker");
        Assert.False(missing.IsLibraryAsset);
        Assert.False(missing.IsHistoryOnly);
        Assert.True(missing.HasMediaDownloadFailure);
        Assert.Equal("媒体下载失败", missing.StatusLabel);

        Assert.Equal(2, audit.Total);
        Assert.Equal(1, audit.ActualMedia);
        Assert.Equal(1, audit.DownloadFailed);
        Assert.Equal(1, audit.UserAnnotationOnly);
        Assert.Equal(0, audit.TrustedSemantic);
        Assert.Equal(2, audit.OnlyDefaultAliases);
        Assert.Equal(0, audit.HistoryOnly);
    }

    [Fact]
    public void Read_MarksHistoryOnlyStickerKeysAsIndexRecords()
    {
        var root = CreateTempRoot();
        var artifacts = new MemoryArtifactStore(root);
        Directory.CreateDirectory(Path.GetDirectoryName(artifacts.FeishuStickerStorePath)!);
        Directory.CreateDirectory(artifacts.FeishuStickerMediaDirPath);
        File.WriteAllText(artifacts.FeishuStickerStorePath, JsonSerializer.Serialize(new
        {
            version = 1,
            updatedAt = "2026-07-14T00:00:00.000Z",
            stickers = new object[]
            {
                new
                {
                    fileKey = "history_only",
                    aliases = new[] { "最近", "默认", "表情包" },
                    chatId = "oc_group",
                    firstSeenAt = "2026-07-14T00:00:00.000Z",
                    lastSeenAt = "2026-07-14T00:01:00.000Z",
                    useCount = 0,
                },
                new
                {
                    fileKey = "trusted_no_media",
                    aliases = new[] { "挥手" },
                    chatId = "oc_group",
                    label = "挥手",
                    intent = "打招呼",
                    annotationSource = "vision",
                    annotationConfidence = 0.9,
                    annotationVerifiedAt = "2026-07-14T00:00:00.000Z",
                    firstSeenAt = "2026-07-14T00:00:00.000Z",
                    lastSeenAt = "2026-07-14T00:01:00.000Z",
                    useCount = 0,
                },
            },
        }), new UTF8Encoding(false));

        var snapshot = FeishuStickerLibrary.Read(artifacts);
        var audit = FeishuStickerLibrary.Audit(artifacts);

        var historyOnly = snapshot.Stickers.Single(item => item.FileKey == "history_only");
        var trusted = snapshot.Stickers.Single(item => item.FileKey == "trusted_no_media");
        Assert.False(historyOnly.IsLibraryAsset);
        Assert.True(historyOnly.IsHistoryOnly);
        Assert.Equal("仅历史 key，无媒体", historyOnly.StatusLabel);
        Assert.True(trusted.IsLibraryAsset);
        Assert.False(trusted.IsHistoryOnly);
        Assert.Equal("可信语义", trusted.StatusLabel);
        Assert.Equal(1, audit.HistoryOnly);
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
