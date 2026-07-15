using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

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

    /// <summary>
    /// 把 runtime Skill Registry 投影成记忆资产索引。这里只保留引用和治理元数据，
    /// 不读取 SKILL.md，也不把正文复制到面板或记忆仓库。
    /// </summary>
    public static SkillAssetIndexSnapshot BuildSkillAssetIndex(JsonElement registrySnapshot)
    {
        var items = new List<SkillAssetIndexItem>();
        if (registrySnapshot.ValueKind == JsonValueKind.Object
            && registrySnapshot.TryGetProperty("items", out var registryItems)
            && registryItems.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in registryItems.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) continue;
                var id = ReadString(item, "id");
                if (string.IsNullOrWhiteSpace(id)) continue;
                items.Add(new SkillAssetIndexItem(
                    id,
                    ReadString(item, "displayName", id),
                    ReadString(item, "sourceClass"),
                    ReadString(item, "state"),
                    ReadString(item, "risk"),
                    ReadBool(item, "enabled"),
                    FirstNonEmpty(ReadString(item, "path"), ReadString(item, "source")),
                    ReadString(item, "version"),
                    ReadString(item, "updatedAt"),
                    null));
            }
        }
        return new SkillAssetIndexSnapshot(
            "cti-memory-skill-asset-index/v1",
            ReadString(registrySnapshot, "generatedAt"),
            items.OrderBy(item => item.Id, StringComparer.OrdinalIgnoreCase).ToArray());
    }

    private string Resolve(params string[] segments)
        => Path.GetFullPath(Path.Combine([Root, .. segments]));

    private static string ReadString(JsonElement element, string propertyName, string fallback = "")
        => element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(propertyName, out var value)
            && value.ValueKind == JsonValueKind.String
                ? value.GetString() ?? fallback
                : fallback;

    private static bool ReadBool(JsonElement element, string propertyName)
        => element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(propertyName, out var value)
            && value.ValueKind is JsonValueKind.True or JsonValueKind.False
            && value.GetBoolean();

    private static string FirstNonEmpty(params string[] values)
        => values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? "";

    private static string GetDefaultRoot()
        => OperatingSystem.IsWindows()
            ? @"E:\cli-md"
            : Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".claude-to-im",
                "memory-repo");
}

internal sealed record SkillAssetIndexSnapshot(
    string Protocol,
    string GeneratedAt,
    SkillAssetIndexItem[] Items);

internal sealed record SkillAssetIndexItem(
    string Id,
    string DisplayName,
    string SourceClass,
    string State,
    string Risk,
    bool Enabled,
    string SourcePath,
    string Version,
    string UpdatedAt,
    string? SkillBody);
