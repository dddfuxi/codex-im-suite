using ClaudeToImControlPanel;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class MemoryArtifactStoreTests
{
    [Fact]
    public void ResolvesLongTermArtifactPathsUnderMemoryRepository()
    {
        var memoryRoot = CreateTempRoot();
        var artifacts = new MemoryArtifactStore(memoryRoot);

        Assert.Equal(
            Path.GetFullPath(Path.Combine(memoryRoot, "data", "im", "feishu", "stickers", "stickers.json")),
            artifacts.FeishuStickerStorePath);
        Assert.Equal(
            Path.GetFullPath(Path.Combine(memoryRoot, "data", "im", "feishu", "stickers", "media")),
            artifacts.FeishuStickerMediaDirPath);
        Assert.Equal(
            Path.GetFullPath(Path.Combine(memoryRoot, "data", "im", "feishu", "summaries")),
            artifacts.FeishuChatSummaryDirPath);
        Assert.Equal(
            Path.GetFullPath(Path.Combine(memoryRoot, "data", "projects", "facts.json")),
            artifacts.ProjectFactsPath);
    }

    [Fact]
    public void FeishuStickerLibrarySnapshotIncludesMediaPreviewWhenCachedFileExists()
    {
        var memoryRoot = CreateTempRoot();
        var artifacts = new MemoryArtifactStore(memoryRoot);
        Directory.CreateDirectory(Path.GetDirectoryName(artifacts.FeishuStickerStorePath)!);
        Directory.CreateDirectory(artifacts.FeishuStickerMediaDirPath);
        File.WriteAllText(artifacts.FeishuStickerStorePath, """
        {
          "version": 1,
          "updatedAt": "2026-07-08T00:00:00.000Z",
          "stickers": [
            {
              "fileKey": "sticker_file_key",
              "aliases": ["wave"],
              "chatId": "oc_group",
              "label": "wave",
              "intent": "greeting",
              "firstSeenAt": "2026-07-08T00:00:00.000Z",
              "lastSeenAt": "2026-07-08T00:00:00.000Z",
              "useCount": 0
            }
          ]
        }
        """);
        File.WriteAllBytes(
            Path.Combine(artifacts.FeishuStickerMediaDirPath, MemoryArtifactStore.StableFileName("sticker_file_key", ".png")),
            [0x89, 0x50, 0x4e, 0x47]);

        var snapshot = FeishuStickerLibrary.Read(artifacts);
        var item = Assert.Single(snapshot.Stickers);

        Assert.Equal(artifacts.FeishuStickerStorePath, snapshot.StorePath);
        Assert.Equal(artifacts.FeishuStickerMediaDirPath, snapshot.MediaDir);
        Assert.Equal("image/png", item.MediaMimeType);
        Assert.EndsWith(MemoryArtifactStore.StableFileName("sticker_file_key", ".png"), item.MediaPath);
        Assert.StartsWith("data:image/png;base64,", item.PreviewUrl);
    }

    private static string CreateTempRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), $"cti-memory-artifacts-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        return root;
    }
}
