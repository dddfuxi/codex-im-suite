using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace ClaudeToImControlPanel;

internal sealed record MemorySourceLayoutClassification(string SourceGroup, bool Legacy, string LayoutVersion);

internal static class MemorySourceLayoutClassifier
{
    private const string MemoryV2Schema = "codex-im-suite/memory/v2";
    private const string MemoryV3Schema = "codex-im-suite/memory/v3";

    public static MemorySourceLayoutClassification Classify(
        string root,
        string sourcePath,
        IReadOnlyDictionary<string, string> metadata)
    {
        if (string.IsNullOrWhiteSpace(root)
            || string.IsNullOrWhiteSpace(sourcePath)
            || !sourcePath.EndsWith(".md", StringComparison.OrdinalIgnoreCase)
            || !metadata.TryGetValue("schema", out var schema)
            || !metadata.TryGetValue("memoryScope", out var scope))
        {
            return new("", false, "");
        }

        var isV3 = string.Equals(schema, MemoryV3Schema, StringComparison.Ordinal);
        var isV2 = string.Equals(schema, MemoryV2Schema, StringComparison.Ordinal);
        if (!isV3 && !isV2) return new("", false, "");

        var segments = RelativeSegments(root, sourcePath);
        var offset = isV3 ? 1 : 3;
        if (isV3 && (segments.Length < 3 || !segments[0].Equals("memory", StringComparison.OrdinalIgnoreCase)))
        {
            return new("", false, "");
        }
        if (isV2 && (segments.Length < 5
            || !segments[0].Equals("data", StringComparison.OrdinalIgnoreCase)
            || !segments[1].Equals("memory", StringComparison.OrdinalIgnoreCase)
            || !segments[2].Equals("v2", StringComparison.OrdinalIgnoreCase)))
        {
            return new("", false, "");
        }

        var legacy = isV2;
        var version = isV3 ? "v3" : "v2";
        if (scope.Equals("long_term", StringComparison.OrdinalIgnoreCase))
        {
            return segments.Length > offset && segments[offset].Equals("long-term", StringComparison.OrdinalIgnoreCase)
                ? new("memory_long_term", legacy, version)
                : new("", legacy, version);
        }

        if (!metadata.TryGetValue("channelType", out var channelType) || string.IsNullOrWhiteSpace(channelType))
        {
            return new("", legacy, version);
        }
        var channelSegment = PartitionSegment(channelType);
        if (scope.Equals("user", StringComparison.OrdinalIgnoreCase)
            && metadata.TryGetValue("userId", out var userId)
            && !string.IsNullOrWhiteSpace(userId)
            && segments.Length >= offset + 4
            && segments[offset].Equals("users", StringComparison.OrdinalIgnoreCase)
            && segments[offset + 1].Equals(channelSegment, StringComparison.OrdinalIgnoreCase)
            && segments[offset + 2].Equals(PartitionSegment(userId), StringComparison.OrdinalIgnoreCase))
        {
            return new("memory_user", legacy, version);
        }
        if (scope.Equals("group", StringComparison.OrdinalIgnoreCase)
            && metadata.TryGetValue("chatId", out var chatId)
            && !string.IsNullOrWhiteSpace(chatId)
            && segments.Length >= offset + 4
            && segments[offset].Equals("groups", StringComparison.OrdinalIgnoreCase)
            && segments[offset + 1].Equals(channelSegment, StringComparison.OrdinalIgnoreCase)
            && segments[offset + 2].Equals(PartitionSegment(chatId), StringComparison.OrdinalIgnoreCase))
        {
            return new("memory_group", legacy, version);
        }
        return new("", legacy, version);
    }

    private static string[] RelativeSegments(string root, string sourcePath)
    {
        var fullRoot = Path.GetFullPath(root);
        var fullSource = Path.GetFullPath(sourcePath);
        var relative = Path.GetRelativePath(fullRoot, fullSource);
        if (relative == ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)) return [];
        return relative.Replace('\\', '/').Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    private static string PartitionSegment(string value)
    {
        var normalized = value.Normalize(NormalizationForm.FormKC).Trim();
        var safe = Regex.Replace(normalized, @"[\\/:*?""<>|]+", "_");
        safe = Regex.Replace(safe, @"[\u0000-\u001F]", "");
        if (safe.Length > 96) safe = safe[..96];
        return !string.IsNullOrWhiteSpace(safe)
            ? safe
            : Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized))).ToLowerInvariant()[..20];
    }
}

internal sealed record AgentHomeEntry(string Name, string Path, bool Exists);
internal sealed record RootMarkdownDocument(string Name, string Path);

internal sealed record MemoryLayoutSnapshot(
    string LayoutVersion,
    string MigrationState,
    int V3SourceCount,
    int LegacySourceCount,
    IReadOnlyList<AgentHomeEntry> AgentHome,
    IReadOnlyList<RootMarkdownDocument> UnclassifiedRootDocuments);

internal static class MemoryLayoutInspector
{
    private static readonly string[] AgentHomeNames =
    [
        "机器人身份.md",
        "行为与安全规则.md",
        "工具与环境.md",
        "记忆总索引.md",
        "记忆库说明.md",
    ];

    public static MemoryLayoutSnapshot Inspect(string memoryRoot)
    {
        var root = Path.GetFullPath(memoryRoot);
        var v3SourceCount = CountMarkdown(Path.Combine(root, "memory"));
        var legacySourceCount = CountMarkdown(Path.Combine(root, "data", "memory", "v2"));
        var migrationState = v3SourceCount > 0 && legacySourceCount > 0
            ? "mixed"
            : v3SourceCount > 0
                ? "v3_only"
                : legacySourceCount > 0
                    ? "legacy_only"
                    : "empty";
        var agentHome = AgentHomeNames
            .Select(name =>
            {
                var filePath = Path.Combine(root, name);
                return new AgentHomeEntry(name, filePath, File.Exists(filePath));
            })
            .ToArray();
        var unclassifiedRootDocuments = FindUnclassifiedRootDocuments(root);
        return new MemoryLayoutSnapshot(
            v3SourceCount > 0 ? "v3" : legacySourceCount > 0 ? "v2" : "none",
            migrationState,
            v3SourceCount,
            legacySourceCount,
            agentHome,
            unclassifiedRootDocuments);
    }

    private static IReadOnlyList<RootMarkdownDocument> FindUnclassifiedRootDocuments(string root)
    {
        if (!Directory.Exists(root)) return [];
        var agentHomeNames = AgentHomeNames.ToHashSet(StringComparer.OrdinalIgnoreCase);
        try
        {
            return Directory.EnumerateFiles(root, "*.md", SearchOption.TopDirectoryOnly)
                .Where(filePath => !agentHomeNames.Contains(Path.GetFileName(filePath)))
                .Select(filePath => new RootMarkdownDocument(Path.GetFileName(filePath), filePath))
                .OrderBy(item => item.Name, StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }
        catch
        {
            return [];
        }
    }

    private static int CountMarkdown(string root)
    {
        if (!Directory.Exists(root)) return 0;
        try
        {
            return Directory.EnumerateFiles(root, "*.md", SearchOption.AllDirectories).Count();
        }
        catch
        {
            return 0;
        }
    }
}
