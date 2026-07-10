using System.Security.Cryptography;
using System.Text;

namespace ClaudeToImControlPanel;

internal sealed class MemoryArtifactStore
{
    public MemoryArtifactStore(string root)
    {
        Root = Path.GetFullPath(string.IsNullOrWhiteSpace(root) ? GetDefaultRoot() : root.Trim());
    }

    public string Root { get; }

    public string FeishuStickerStorePath
        => Resolve("data", "im", "feishu", "stickers", "stickers.json");

    public string FeishuStickerMediaDirPath
        => Resolve("data", "im", "feishu", "stickers", "media");

    public string FeishuChatSummaryDirPath
        => Resolve("data", "im", "feishu", "summaries");

    public string ProjectFactsPath
        => Resolve("data", "projects", "facts.json");

    public static string StableFileName(string key, string extension = "")
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(key));
        var suffix = string.IsNullOrWhiteSpace(extension)
            ? ""
            : extension.StartsWith('.') ? extension : $".{extension}";
        return $"{Convert.ToHexString(hash).ToLowerInvariant()}{suffix}";
    }

    private string Resolve(params string[] segments)
        => Path.GetFullPath(Path.Combine([Root, .. segments]));

    private static string GetDefaultRoot()
        => OperatingSystem.IsWindows()
            ? @"E:\cli-md"
            : Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".claude-to-im",
                "memory-repo");
}
