using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ClaudeToImControlPanel;

internal sealed record FeishuStickerLibrarySnapshot(
    string Schema,
    string StorePath,
    string MediaDir,
    string UpdatedAt,
    IReadOnlyList<FeishuStickerLibraryItem> Stickers);

internal sealed record FeishuStickerLibraryItem(
    string FileKey,
    string MediaPath,
    string PreviewUrl,
    string MediaMimeType,
    IReadOnlyList<string> Aliases,
    string ChatId,
    string UserId,
    string Label,
    string Description,
    string Intent,
    string Tone,
    string Usage,
    string AvoidWhen,
    IReadOnlyList<string> Examples,
    double AnnotationConfidence,
    string FirstSeenAt,
    string LastSeenAt,
    string LastUsedAt,
    string MediaCachedAt,
    string MediaDownloadFailedAt,
    string MediaDownloadError,
    int UseCount,
    bool Disabled,
    string DisabledReason,
    string LastEditedAt);

internal sealed record FeishuStickerUpdateRequest
{
    public string FileKey { get; init; } = "";
    public string? Label { get; init; }
    public string? Description { get; init; }
    public string? Intent { get; init; }
    public string? Tone { get; init; }
    public string? Usage { get; init; }
    public string? AvoidWhen { get; init; }
    public bool? Disabled { get; init; }
    public string? DisabledReason { get; init; }
}

internal sealed record FeishuStickerAliasMergeRequest
{
    public string FileKey { get; init; } = "";
    public IReadOnlyList<string> Aliases { get; init; } = [];
}

internal static class FeishuStickerLibrary
{
    private const string Schema = "codex-im-suite/feishu-sticker-library/v1";
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static FeishuStickerLibrarySnapshot Read(MemoryArtifactStore artifacts)
        => Read(artifacts.FeishuStickerStorePath, artifacts.FeishuStickerMediaDirPath);

    public static FeishuStickerLibrarySnapshot Update(MemoryArtifactStore artifacts, FeishuStickerUpdateRequest request)
        => Update(artifacts.FeishuStickerStorePath, artifacts.FeishuStickerMediaDirPath, request);

    public static FeishuStickerLibrarySnapshot MergeAliases(MemoryArtifactStore artifacts, FeishuStickerAliasMergeRequest request)
        => MergeAliases(artifacts.FeishuStickerStorePath, artifacts.FeishuStickerMediaDirPath, request);

    private static FeishuStickerLibrarySnapshot Read(string storePath, string mediaDir)
    {
        var root = ReadStore(storePath);
        var stickers = ReadStickerArray(root)
            .OfType<JsonObject>()
            .Where(item => !string.IsNullOrWhiteSpace(ReadString(item, "fileKey")))
            .Select(item => ToItem(item, mediaDir))
            .OrderByDescending(item => item.LastSeenAt)
            .ToArray();
        return new FeishuStickerLibrarySnapshot(
            Schema,
            Path.GetFullPath(storePath),
            string.IsNullOrWhiteSpace(mediaDir) ? "" : Path.GetFullPath(mediaDir),
            ReadString(root, "updatedAt"),
            stickers);
    }

    private static FeishuStickerLibrarySnapshot Update(string storePath, string mediaDir, FeishuStickerUpdateRequest request)
    {
        var root = ReadStore(storePath);
        var sticker = FindSticker(root, request.FileKey);
        var now = DateTime.UtcNow.ToString("o");
        SetString(sticker, "label", request.Label);
        SetString(sticker, "description", request.Description);
        SetString(sticker, "intent", request.Intent);
        SetString(sticker, "tone", request.Tone);
        SetString(sticker, "usage", request.Usage);
        SetString(sticker, "avoidWhen", request.AvoidWhen);
        if (HasSemanticUpdate(request))
        {
            sticker["annotationSource"] = "manual";
            sticker["annotationVerifiedAt"] = now;
        }
        if (request.Disabled.HasValue) sticker["disabled"] = request.Disabled.Value;
        SetString(sticker, "disabledReason", request.DisabledReason);
        sticker["lastEditedAt"] = now;
        root["updatedAt"] = now;
        WriteStore(storePath, root);
        return Read(storePath, mediaDir);
    }

    private static FeishuStickerLibrarySnapshot MergeAliases(string storePath, string mediaDir, FeishuStickerAliasMergeRequest request)
    {
        var root = ReadStore(storePath);
        var sticker = FindSticker(root, request.FileKey);
        var aliases = ReadStringArray(sticker, "aliases")
            .Concat(request.Aliases)
            .Select(item => item.Trim())
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(20)
            .ToArray();
        sticker["aliases"] = new JsonArray(aliases.Select(alias => JsonValue.Create(alias)).ToArray<JsonNode?>());
        var now = DateTime.UtcNow.ToString("o");
        sticker["lastEditedAt"] = now;
        root["updatedAt"] = now;
        WriteStore(storePath, root);
        return Read(storePath, mediaDir);
    }

    private static JsonObject ReadStore(string storePath)
    {
        if (!File.Exists(storePath))
        {
            return new JsonObject
            {
                ["version"] = 1,
                ["updatedAt"] = "",
                ["stickers"] = new JsonArray(),
            };
        }

        var root = JsonNode.Parse(File.ReadAllText(storePath, Encoding.UTF8)) as JsonObject;
        if (root is null) throw new InvalidOperationException("Feishu 表情包库 JSON 结构无效。");
        if (root["stickers"] is not JsonArray) root["stickers"] = new JsonArray();
        return root;
    }

    private static void WriteStore(string storePath, JsonObject root)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(storePath)!);
        var tmp = $"{storePath}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(tmp, root.ToJsonString(JsonOptions), new UTF8Encoding(false));
        if (File.Exists(storePath)) File.Replace(tmp, storePath, null);
        else File.Move(tmp, storePath);
    }

    private static JsonArray ReadStickerArray(JsonObject root)
        => root["stickers"] as JsonArray ?? [];

    private static JsonObject FindSticker(JsonObject root, string fileKey)
    {
        var normalized = fileKey.Trim();
        if (string.IsNullOrWhiteSpace(normalized)) throw new InvalidOperationException("缺少表情包 fileKey。");
        var sticker = ReadStickerArray(root)
            .OfType<JsonObject>()
            .FirstOrDefault(item => string.Equals(ReadString(item, "fileKey"), normalized, StringComparison.Ordinal));
        return sticker ?? throw new InvalidOperationException("未找到指定表情包。");
    }

    private static FeishuStickerLibraryItem ToItem(JsonObject item, string mediaDir)
    {
        var fileKey = ReadString(item, "fileKey");
        var mediaPath = ResolveStickerMediaPath(mediaDir, fileKey);
        var mediaMimeType = string.IsNullOrWhiteSpace(mediaPath) ? "" : GuessImageMimeType(mediaPath);
        var previewUrl = BuildPreviewUrl(mediaPath, mediaMimeType);
        return new(
            FileKey: fileKey,
            MediaPath: mediaPath,
            PreviewUrl: previewUrl,
            MediaMimeType: mediaMimeType,
            Aliases: ReadStringArray(item, "aliases").Distinct(StringComparer.OrdinalIgnoreCase).Take(20).ToArray(),
            ChatId: ReadString(item, "chatId"),
            UserId: ReadString(item, "userId"),
            Label: ReadString(item, "label"),
            Description: ReadString(item, "description"),
            Intent: ReadString(item, "intent"),
            Tone: ReadString(item, "tone"),
            Usage: ReadString(item, "usage"),
            AvoidWhen: ReadString(item, "avoidWhen"),
            Examples: ReadStringArray(item, "examples").Take(8).ToArray(),
            AnnotationConfidence: ReadDouble(item, "annotationConfidence"),
            FirstSeenAt: ReadString(item, "firstSeenAt"),
            LastSeenAt: ReadString(item, "lastSeenAt"),
            LastUsedAt: ReadString(item, "lastUsedAt"),
            MediaCachedAt: ReadString(item, "mediaCachedAt"),
            MediaDownloadFailedAt: ReadString(item, "mediaDownloadFailedAt"),
            MediaDownloadError: ReadString(item, "mediaDownloadError"),
            UseCount: ReadInt(item, "useCount"),
            Disabled: ReadBool(item, "disabled"),
            DisabledReason: ReadString(item, "disabledReason"),
            LastEditedAt: ReadString(item, "lastEditedAt"));
    }

    private static string ResolveStickerMediaPath(string mediaDir, string fileKey)
    {
        if (string.IsNullOrWhiteSpace(mediaDir) || string.IsNullOrWhiteSpace(fileKey)) return "";
        var pngPath = Path.Combine(mediaDir, MemoryArtifactStore.StableFileName(fileKey, ".png"));
        if (File.Exists(pngPath)) return Path.GetFullPath(pngPath);
        return "";
    }

    private static string GuessImageMimeType(string path)
        => Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".bmp" => "image/bmp",
            _ => "image/png",
        };

    private static string BuildPreviewUrl(string mediaPath, string mediaMimeType)
    {
        if (string.IsNullOrWhiteSpace(mediaPath) || !File.Exists(mediaPath)) return "";
        var info = new FileInfo(mediaPath);
        if (info.Length <= 0 || info.Length > 8 * 1024 * 1024) return "";
        var bytes = File.ReadAllBytes(mediaPath);
        return $"data:{mediaMimeType};base64,{Convert.ToBase64String(bytes)}";
    }

    private static string[] ReadStringArray(JsonObject item, string key)
    {
        if (item[key] is not JsonArray array) return [];
        return array
            .Select(value => value?.GetValue<string>()?.Trim() ?? "")
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .ToArray();
    }

    private static string ReadString(JsonObject? item, string key)
        => item is not null && item[key] is JsonValue value && value.TryGetValue<string>(out var result) ? result : "";

    private static int ReadInt(JsonObject item, string key)
        => item[key] is JsonValue value && value.TryGetValue<int>(out var result) ? result : 0;

    private static double ReadDouble(JsonObject item, string key)
        => item[key] is JsonValue value && value.TryGetValue<double>(out var result) ? result : 0;

    private static bool ReadBool(JsonObject item, string key)
        => item[key] is JsonValue value && value.TryGetValue<bool>(out var result) && result;

    private static bool HasSemanticUpdate(FeishuStickerUpdateRequest request)
        => request.Label is not null
           || request.Description is not null
           || request.Intent is not null
           || request.Tone is not null
           || request.Usage is not null
           || request.AvoidWhen is not null;

    private static void SetString(JsonObject item, string key, string? value)
    {
        if (value is null) return;
        var normalized = value.Trim();
        if (string.IsNullOrWhiteSpace(normalized)) item.Remove(key);
        else item[key] = normalized;
    }
}
