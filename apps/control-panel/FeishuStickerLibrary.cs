using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ClaudeToImControlPanel;

internal sealed record FeishuStickerLibrarySnapshot(
    string Schema,
    string StorePath,
    string MediaDir,
    string UpdatedAt,
    IReadOnlyList<FeishuStickerLibraryItem> Stickers);

internal sealed record FeishuStickerLibraryAudit(
    int Total,
    int Enabled,
    int Disabled,
    int Archived,
    int ActualMedia,
    int MissingMedia,
    int DownloadFailed,
    int TrustedSemantic,
    int UserAnnotationOnly,
    int CachedWithoutTrustedSemantic,
    int OnlyDefaultAliases,
    int HistoryOnly,
    int FormatMismatch);

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
    string AnnotationSource,
    string AnnotationVerifiedAt,
    bool HasUserAnnotation,
    bool HasTrustedSemantic,
    bool HasMedia,
    bool IsLibraryAsset,
    bool IsHistoryOnly,
    bool HasMediaDownloadFailure,
    bool MediaExtensionMismatch,
    string StatusLabel,
    string FirstSeenAt,
    string LastSeenAt,
    string LastUsedAt,
    string MediaCachedAt,
    string MediaDownloadFailedAt,
    string MediaDownloadError,
    int UseCount,
    bool Disabled,
    string DisabledReason,
    string LastEditedAt,
    bool Archived,
    string ArchivedAt);

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

internal sealed record FeishuStickerLifecycleRequest
{
    public string FileKey { get; init; } = "";
}

internal static class FeishuStickerLibrary
{
    private const string Schema = "codex-im-suite/feishu-sticker-library/v1";
    private static readonly string[] StickerMediaExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
    public static FeishuStickerLibrarySnapshot Read(MemoryArtifactStore artifacts)
        => Read(artifacts.FeishuStickerStorePath, artifacts.FeishuStickerMediaDirPath);

    public static FeishuStickerLibraryAudit Audit(MemoryArtifactStore artifacts)
        => Audit(artifacts.FeishuStickerStorePath, artifacts.FeishuStickerMediaDirPath);

    public static FeishuStickerLibrarySnapshot Update(MemoryArtifactStore artifacts, FeishuStickerUpdateRequest request)
        => throw RuntimeWriteRequired();

    public static FeishuStickerLibrarySnapshot MergeAliases(MemoryArtifactStore artifacts, FeishuStickerAliasMergeRequest request)
        => throw RuntimeWriteRequired();

    public static FeishuStickerLibrarySnapshot Archive(MemoryArtifactStore artifacts, FeishuStickerLifecycleRequest request)
        => throw RuntimeWriteRequired();

    public static FeishuStickerLibrarySnapshot Restore(MemoryArtifactStore artifacts, FeishuStickerLifecycleRequest request)
        => throw RuntimeWriteRequired();

    public static FeishuStickerLibrarySnapshot DeleteArchived(MemoryArtifactStore artifacts, FeishuStickerLifecycleRequest request)
        => throw RuntimeWriteRequired();

    private static InvalidOperationException RuntimeWriteRequired()
        => new("表情包语义写入必须通过 runtime StickerSemanticGateway 执行。");

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

    private static FeishuStickerLibraryAudit Audit(string storePath, string mediaDir)
    {
        var snapshot = Read(storePath, mediaDir);
        var total = snapshot.Stickers.Count;
        var disabled = snapshot.Stickers.Count(item => item.Disabled);
        var archived = snapshot.Stickers.Count(item => item.Archived);
        var enabled = snapshot.Stickers.Count(item => !item.Disabled && !item.Archived);
        var actualMedia = snapshot.Stickers.Count(item => item.HasMedia);
        var downloadFailed = snapshot.Stickers.Count(item => !string.IsNullOrWhiteSpace(item.MediaDownloadFailedAt) || !string.IsNullOrWhiteSpace(item.MediaDownloadError));
        var trustedSemantic = snapshot.Stickers.Count(item => item.HasTrustedSemantic);
        var userAnnotationOnly = snapshot.Stickers.Count(item => item.HasUserAnnotation && !item.HasTrustedSemantic);
        var cachedWithoutTrustedSemantic = snapshot.Stickers.Count(item => item.HasMedia && !item.HasTrustedSemantic);
        var onlyDefaultAliases = snapshot.Stickers.Count(item => item.Aliases.Count > 0 && item.Aliases.All(IsDefaultAlias));
        var historyOnly = snapshot.Stickers.Count(item => item.IsHistoryOnly);
        var formatMismatch = snapshot.Stickers.Count(item => item.MediaExtensionMismatch);
        return new FeishuStickerLibraryAudit(
            Total: total,
            Enabled: enabled,
            Disabled: disabled,
            Archived: archived,
            ActualMedia: actualMedia,
            MissingMedia: total - actualMedia,
            DownloadFailed: downloadFailed,
            TrustedSemantic: trustedSemantic,
            UserAnnotationOnly: userAnnotationOnly,
            CachedWithoutTrustedSemantic: cachedWithoutTrustedSemantic,
            OnlyDefaultAliases: onlyDefaultAliases,
            HistoryOnly: historyOnly,
            FormatMismatch: formatMismatch);
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
                ["deletedStickers"] = new JsonObject(),
            };
        }

        var root = JsonNode.Parse(File.ReadAllText(storePath, Encoding.UTF8)) as JsonObject;
        if (root is null) throw new InvalidOperationException("Feishu 表情包库 JSON 结构无效。");
        if (root["stickers"] is not JsonArray) root["stickers"] = new JsonArray();
        if (root["deletedStickers"] is not JsonObject) root["deletedStickers"] = new JsonObject();
        return root;
    }

    private static JsonArray ReadStickerArray(JsonObject root)
        => root["stickers"] as JsonArray ?? [];

    private static FeishuStickerLibraryItem ToItem(JsonObject item, string mediaDir)
    {
        var fileKey = ReadString(item, "fileKey");
        var mediaPath = ResolveStickerMediaPath(mediaDir, fileKey);
        var mediaMimeType = string.IsNullOrWhiteSpace(mediaPath) ? "" : GuessImageMimeType(mediaPath);
        var previewUrl = BuildPreviewUrl(mediaPath, mediaMimeType);
        var annotationSource = ReadString(item, "annotationSource");
        var annotationVerifiedAt = ReadString(item, "annotationVerifiedAt");
        var hasUserAnnotation = HasObjectProperties(item, "userAnnotation");
        var hasTrustedSemantic = HasTrustedSemantic(item);
        var hasMedia = !string.IsNullOrWhiteSpace(mediaPath);
        var mediaExtensionMismatch = hasMedia && IsMediaExtensionMismatch(mediaPath, mediaMimeType);
        var disabled = ReadBool(item, "disabled");
        var archived = ReadBool(item, "archived");
        var hasMediaDownloadFailure = HasMediaDownloadFailure(
            ReadString(item, "mediaDownloadFailedAt"),
            ReadString(item, "mediaDownloadError"));
        var isLibraryAsset = IsLibraryAsset(
            disabled,
            hasTrustedSemantic,
            hasUserAnnotation,
            hasMedia);
        var isHistoryOnly = IsHistoryOnly(
            disabled,
            hasTrustedSemantic,
            hasUserAnnotation,
            hasMedia,
            hasMediaDownloadFailure);
        var statusLabel = BuildStatusLabel(
            archived,
            disabled,
            hasTrustedSemantic,
            hasUserAnnotation,
            hasMedia,
            ReadString(item, "mediaDownloadFailedAt"),
            ReadString(item, "mediaDownloadError"));
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
            AnnotationSource: annotationSource,
            AnnotationVerifiedAt: annotationVerifiedAt,
            HasUserAnnotation: hasUserAnnotation,
            HasTrustedSemantic: hasTrustedSemantic,
            HasMedia: hasMedia,
            IsLibraryAsset: isLibraryAsset,
            IsHistoryOnly: isHistoryOnly,
            HasMediaDownloadFailure: hasMediaDownloadFailure,
            MediaExtensionMismatch: mediaExtensionMismatch,
            StatusLabel: statusLabel,
            FirstSeenAt: ReadString(item, "firstSeenAt"),
            LastSeenAt: ReadString(item, "lastSeenAt"),
            LastUsedAt: ReadString(item, "lastUsedAt"),
            MediaCachedAt: ReadString(item, "mediaCachedAt"),
            MediaDownloadFailedAt: ReadString(item, "mediaDownloadFailedAt"),
            MediaDownloadError: ReadString(item, "mediaDownloadError"),
            UseCount: ReadInt(item, "useCount"),
            Disabled: disabled,
            DisabledReason: ReadString(item, "disabledReason"),
            LastEditedAt: ReadString(item, "lastEditedAt"),
            Archived: archived,
            ArchivedAt: ReadString(item, "archivedAt"));
    }

    private static string ResolveStickerMediaPath(string mediaDir, string fileKey)
    {
        if (string.IsNullOrWhiteSpace(mediaDir) || string.IsNullOrWhiteSpace(fileKey)) return "";
        foreach (var extension in StickerMediaExtensions)
        {
            var mediaPath = Path.Combine(mediaDir, MemoryArtifactStore.StableFileName(fileKey, extension));
            if (File.Exists(mediaPath)) return Path.GetFullPath(mediaPath);
        }
        return "";
    }

    private static string GuessImageMimeType(string path)
    {
        var sniffed = SniffImageMimeType(path);
        if (!string.IsNullOrWhiteSpace(sniffed)) return sniffed;
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".bmp" => "image/bmp",
            _ => "image/png",
        };
    }

    private static string SniffImageMimeType(string path)
    {
        Span<byte> header = stackalloc byte[12];
        using var stream = File.OpenRead(path);
        var read = stream.Read(header);
        if (read >= 8
            && header[0] == 0x89
            && header[1] == 0x50
            && header[2] == 0x4E
            && header[3] == 0x47
            && header[4] == 0x0D
            && header[5] == 0x0A
            && header[6] == 0x1A
            && header[7] == 0x0A)
        {
            return "image/png";
        }
        if (read >= 3 && header[0] == 0xFF && header[1] == 0xD8 && header[2] == 0xFF) return "image/jpeg";
        if (read >= 6)
        {
            var gif = Encoding.ASCII.GetString(header[..6]);
            if (gif is "GIF87a" or "GIF89a") return "image/gif";
        }
        if (read >= 12
            && Encoding.ASCII.GetString(header[..4]) == "RIFF"
            && Encoding.ASCII.GetString(header.Slice(8, 4)) == "WEBP")
        {
            return "image/webp";
        }
        return "";
    }

    private static bool IsMediaExtensionMismatch(string mediaPath, string mediaMimeType)
    {
        var extension = Path.GetExtension(mediaPath).ToLowerInvariant();
        return mediaMimeType switch
        {
            "image/png" => extension != ".png",
            "image/jpeg" => extension is not ".jpg" and not ".jpeg",
            "image/gif" => extension != ".gif",
            "image/webp" => extension != ".webp",
            _ => false,
        };
    }

    private static bool HasObjectProperties(JsonObject item, string key)
        => item[key] is JsonObject obj && obj.Count > 0;

    private static bool HasSemanticFields(JsonObject item)
        => !string.IsNullOrWhiteSpace(ReadString(item, "label"))
           || !string.IsNullOrWhiteSpace(ReadString(item, "description"))
           || !string.IsNullOrWhiteSpace(ReadString(item, "intent"))
           || !string.IsNullOrWhiteSpace(ReadString(item, "tone"))
           || !string.IsNullOrWhiteSpace(ReadString(item, "usage"));

    private static bool HasTrustedSemantic(JsonObject item)
    {
        if (!HasSemanticFields(item)) return false;
        var source = ReadString(item, "annotationSource");
        return source.Equals("vision", StringComparison.OrdinalIgnoreCase)
               || source.Equals("manual", StringComparison.OrdinalIgnoreCase)
               || !string.IsNullOrWhiteSpace(ReadString(item, "annotationVerifiedAt"));
    }

    private static bool IsDefaultAlias(string alias)
        => alias is "最近" or "默认" or "表情包";

    private static bool IsLibraryAsset(
        bool disabled,
        bool hasTrustedSemantic,
        bool hasUserAnnotation,
        bool hasMedia)
    {
        // 历史同步可能只登记 file_key。它是索引证据，不是可编辑/可发送的表情包资产；
        // 默认主列表只放有可展示/可人工整理内容的资产。纯下载失败壳进入异常筛选，不再冒充空表情包。
        return disabled
               || hasTrustedSemantic
               || hasUserAnnotation
               || hasMedia;
    }

    private static bool IsHistoryOnly(
        bool disabled,
        bool hasTrustedSemantic,
        bool hasUserAnnotation,
        bool hasMedia,
        bool hasMediaDownloadFailure)
    {
        return !disabled
               && !hasTrustedSemantic
               && !hasUserAnnotation
               && !hasMedia
               && !hasMediaDownloadFailure;
    }

    private static bool HasMediaDownloadFailure(string mediaDownloadFailedAt, string mediaDownloadError)
    {
        return !string.IsNullOrWhiteSpace(mediaDownloadFailedAt)
               || !string.IsNullOrWhiteSpace(mediaDownloadError);
    }

    private static string BuildStatusLabel(
        bool archived,
        bool disabled,
        bool hasTrustedSemantic,
        bool hasUserAnnotation,
        bool hasMedia,
        string mediaDownloadFailedAt,
        string mediaDownloadError)
    {
        if (archived) return "已归档";
        if (disabled) return "已禁用";
        if (hasTrustedSemantic) return "可信语义";
        if (hasUserAnnotation) return "仅用户解释，待图片核验";
        if (!hasMedia && (!string.IsNullOrWhiteSpace(mediaDownloadFailedAt) || !string.IsNullOrWhiteSpace(mediaDownloadError))) return "媒体下载失败";
        if (hasMedia) return "已缓存图片，待视觉标注";
        return "仅历史 key，无媒体";
    }

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

}
