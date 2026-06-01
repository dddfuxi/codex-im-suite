using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace ClaudeToImControlPanel;

internal sealed record DynamicCatalogCandidate(
    string Id,
    string Type,
    string DisplayName,
    string Version,
    string Category,
    string Description,
    string? Source,
    string? ArtifactUrl,
    string? ArtifactKind,
    string? ArtifactModel,
    string? ArtifactPackageName,
    string? ArtifactCommand,
    string InstallHandler,
    int RankOrder,
    string RankMetric);

internal static class ExtensionCatalogDynamicSources
{
    private static readonly Regex HtmlTagPattern = new("<.*?>", RegexOptions.Singleline | RegexOptions.Compiled);
    private static readonly Regex OllamaListItemPattern = new(
        """<li[^>]*x-test-model[^>]*>.*?<a href="/library/(?<slug>[^"]+)"[^>]*>.*?<span class="group-hover:underline truncate">(?<name>[^<]+)</span>.*?<p class="max-w-lg[^"]*"[^>]*>(?<description>.*?)</p>.*?<span x-test-pull-count>(?<pulls>[^<]+)</span>""",
        RegexOptions.Singleline | RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public static IReadOnlyList<DynamicCatalogCandidate> ParseNpmSearchJson(string json, int topN)
    {
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("objects", out var objects) || objects.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var items = new List<DynamicCatalogCandidate>();
        var rank = 0;
        foreach (var entry in objects.EnumerateArray())
        {
            if (!entry.TryGetProperty("package", out var packageElement))
            {
                continue;
            }

            var packageName = ReadString(packageElement, "name");
            if (string.IsNullOrWhiteSpace(packageName))
            {
                continue;
            }

            rank++;
            items.Add(new DynamicCatalogCandidate(
                Id: $"npm-{NormalizeSegment(packageName)}",
                Type: "mcp",
                DisplayName: packageName,
                Version: ReadString(packageElement, "version", "latest"),
                Category: "mcp.npm.ranking",
                Description: ReadString(packageElement, "description"),
                Source: packageName,
                ArtifactUrl: ReadNestedString(packageElement, "links", "npm"),
                ArtifactKind: "npm",
                ArtifactModel: null,
                ArtifactPackageName: packageName,
                ArtifactCommand: null,
                InstallHandler: "mcp.npm",
                RankOrder: rank,
                RankMetric: $"npm search score {ReadNestedNumber(entry, "score", "final"):0.##}"));

            if (items.Count >= topN)
            {
                break;
            }
        }

        return items;
    }

    public static IReadOnlyList<DynamicCatalogCandidate> ParseHuggingFaceModelsJson(string json, int topN)
    {
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var items = new List<DynamicCatalogCandidate>();
        var rank = 0;
        foreach (var model in doc.RootElement.EnumerateArray())
        {
            var modelId = ReadString(model, "id");
            if (string.IsNullOrWhiteSpace(modelId))
            {
                modelId = ReadString(model, "modelId");
            }

            if (string.IsNullOrWhiteSpace(modelId))
            {
                continue;
            }

            rank++;
            var downloads = ReadInt(model, "downloads");
            var likes = ReadInt(model, "likes");
            items.Add(new DynamicCatalogCandidate(
                Id: $"hf-{NormalizeSegment(modelId)}",
                Type: "model",
                DisplayName: modelId,
                Version: ReadString(model, "createdAt", "latest"),
                Category: "model.huggingface.ranking",
                Description: BuildSummary(ReadString(model, "pipeline_tag"), downloads, likes),
                Source: $"https://huggingface.co/{modelId}",
                ArtifactUrl: $"https://huggingface.co/{modelId}",
                ArtifactKind: null,
                ArtifactModel: null,
                ArtifactPackageName: null,
                ArtifactCommand: null,
                InstallHandler: "",
                RankOrder: rank,
                RankMetric: $"downloads {downloads}"));

            if (items.Count >= topN)
            {
                break;
            }
        }

        return items;
    }

    public static IReadOnlyList<DynamicCatalogCandidate> ParseGitHubRepositoriesJson(string json, int topN)
    {
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("items", out var itemsElement) || itemsElement.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var items = new List<DynamicCatalogCandidate>();
        var rank = 0;
        foreach (var repo in itemsElement.EnumerateArray())
        {
            var fullName = ReadString(repo, "full_name");
            if (string.IsNullOrWhiteSpace(fullName))
            {
                continue;
            }

            rank++;
            var stars = ReadInt(repo, "stargazers_count");
            items.Add(new DynamicCatalogCandidate(
                Id: $"github-{NormalizeSegment(fullName)}",
                Type: "mcp",
                DisplayName: fullName,
                Version: ReadString(repo, "updated_at", "latest"),
                Category: "mcp.github.ranking",
                Description: ReadString(repo, "description"),
                Source: ReadString(repo, "html_url"),
                ArtifactUrl: ReadString(repo, "html_url"),
                ArtifactKind: null,
                ArtifactModel: null,
                ArtifactPackageName: null,
                ArtifactCommand: null,
                InstallHandler: "",
                RankOrder: rank,
                RankMetric: $"stars {stars}"));

            if (items.Count >= topN)
            {
                break;
            }
        }

        return items;
    }

    public static IReadOnlyList<DynamicCatalogCandidate> ParsePyPiRssXml(string xml, int topN)
    {
        var doc = XDocument.Parse(xml, LoadOptions.PreserveWhitespace);
        var channel = doc.Root?.Element("channel");
        if (channel is null)
        {
            return [];
        }

        var items = new List<DynamicCatalogCandidate>();
        var rank = 0;
        foreach (var item in channel.Elements("item"))
        {
            var title = item.Element("title")?.Value?.Trim() ?? "";
            var description = HtmlDecode(item.Element("description")?.Value ?? "");
            var packageName = ParsePyPiPackageName(item.Element("link")?.Value ?? "", title);
            if (string.IsNullOrWhiteSpace(packageName))
            {
                continue;
            }

            if (!IsMcpRelevant($"{packageName} {title} {description}"))
            {
                continue;
            }

            rank++;
            items.Add(new DynamicCatalogCandidate(
                Id: $"pypi-{NormalizeSegment(packageName)}",
                Type: "mcp",
                DisplayName: packageName,
                Version: title,
                Category: "mcp.pypi.ranking",
                Description: description,
                Source: packageName,
                ArtifactUrl: $"https://pypi.org/project/{packageName}/",
                ArtifactKind: "pypi",
                ArtifactModel: null,
                ArtifactPackageName: packageName,
                ArtifactCommand: null,
                InstallHandler: "mcp.uvx",
                RankOrder: rank,
                RankMetric: "official RSS latest updates"));

            if (items.Count >= topN)
            {
                break;
            }
        }

        return items;
    }

    public static IReadOnlyList<DynamicCatalogCandidate> ParseOllamaLibraryHtml(string html, int topN)
    {
        var items = new List<DynamicCatalogCandidate>();
        var rank = 0;
        foreach (Match match in OllamaListItemPattern.Matches(html))
        {
            var slug = HtmlDecode(match.Groups["slug"].Value);
            var name = HtmlDecode(match.Groups["name"].Value);
            if (string.IsNullOrWhiteSpace(slug) || string.IsNullOrWhiteSpace(name))
            {
                continue;
            }

            rank++;
            items.Add(new DynamicCatalogCandidate(
                Id: $"ollama-{NormalizeSegment(slug)}",
                Type: "model",
                DisplayName: name,
                Version: "latest",
                Category: "model.ollama.ranking",
                Description: StripHtml(HtmlDecode(match.Groups["description"].Value)),
                Source: slug,
                ArtifactUrl: $"https://ollama.com/library/{slug}",
                ArtifactKind: "ollama",
                ArtifactModel: slug,
                ArtifactPackageName: null,
                ArtifactCommand: null,
                InstallHandler: "ollama.pull",
                RankOrder: rank,
                RankMetric: $"pulls {HtmlDecode(match.Groups["pulls"].Value)}"));

            if (items.Count >= topN)
            {
                break;
            }
        }

        return items;
    }

    public static IReadOnlyList<DynamicCatalogCandidate> ParseMcpRegistryServersJson(string json, int topN)
    {
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("servers", out var serversElement) || serversElement.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var items = new List<DynamicCatalogCandidate>();
        var rank = 0;
        foreach (var entry in serversElement.EnumerateArray())
        {
            if (!entry.TryGetProperty("server", out var server))
            {
                continue;
            }

            var serverName = ReadString(server, "name");
            if (string.IsNullOrWhiteSpace(serverName))
            {
                continue;
            }

            rank++;
            var description = ReadString(server, "description");
            var version = ReadString(server, "version", "latest");
            var registryPackage = ParseRegistryPackage(server);
            items.Add(new DynamicCatalogCandidate(
                Id: $"mcp-registry-{NormalizeSegment(serverName)}",
                Type: "mcp",
                DisplayName: serverName,
                Version: version,
                Category: "mcp.registry.official",
                Description: description,
                Source: registryPackage.Identifier ?? ReadNestedString(server, "repository", "url") ?? ReadRegistryRemoteUrl(server),
                ArtifactUrl: ReadNestedString(server, "repository", "url") ?? ReadRegistryRemoteUrl(server),
                ArtifactKind: registryPackage.Kind,
                ArtifactModel: null,
                ArtifactPackageName: registryPackage.Identifier,
                ArtifactCommand: null,
                InstallHandler: registryPackage.InstallHandler,
                RankOrder: rank,
                RankMetric: $"registry latest v{version}"));

            if (items.Count >= topN)
            {
                break;
            }
        }

        return items;
    }

    private static (string? Kind, string? Identifier, string InstallHandler) ParseRegistryPackage(JsonElement server)
    {
        if (!server.TryGetProperty("packages", out var packages) || packages.ValueKind != JsonValueKind.Array)
        {
            return (null, null, "");
        }

        foreach (var package in packages.EnumerateArray())
        {
            var registryType = ReadString(package, "registryType").ToLowerInvariant();
            var identifier = ReadString(package, "identifier");
            if (string.IsNullOrWhiteSpace(identifier))
            {
                continue;
            }

            if (registryType is "npm" or "node")
            {
                return ("npm", identifier, "mcp.npm");
            }

            if (registryType is "pypi" or "python")
            {
                return ("pypi", identifier, "mcp.uvx");
            }
        }

        return (null, null, "");
    }

    private static string ReadRegistryRemoteUrl(JsonElement server)
    {
        if (!server.TryGetProperty("remotes", out var remotes) || remotes.ValueKind != JsonValueKind.Array)
        {
            return "";
        }

        foreach (var remote in remotes.EnumerateArray())
        {
            var url = ReadString(remote, "url");
            if (!string.IsNullOrWhiteSpace(url))
            {
                return url;
            }
        }

        return "";
    }

    private static string ParsePyPiPackageName(string link, string title)
    {
        if (Uri.TryCreate(link, UriKind.Absolute, out var uri))
        {
            var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
            var projectIndex = Array.FindIndex(segments, segment => string.Equals(segment, "project", StringComparison.OrdinalIgnoreCase));
            if (projectIndex >= 0 && projectIndex + 1 < segments.Length)
            {
                return segments[projectIndex + 1];
            }
        }

        var parts = title.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length > 0 ? parts[0] : "";
    }

    private static bool IsMcpRelevant(string value)
    {
        return Regex.IsMatch(value, @"\bmcp\b|model context protocol", RegexOptions.IgnoreCase);
    }

    private static string BuildSummary(string pipelineTag, int downloads, int likes)
    {
        var bits = new List<string>();
        if (!string.IsNullOrWhiteSpace(pipelineTag))
        {
            bits.Add(pipelineTag);
        }
        if (downloads > 0)
        {
            bits.Add($"downloads {downloads}");
        }
        if (likes > 0)
        {
            bits.Add($"likes {likes}");
        }
        return string.Join(" · ", bits);
    }

    private static string NormalizeSegment(string value)
        => Regex.Replace(value.ToLowerInvariant(), @"[^a-z0-9._-]+", "-").Trim('-');

    private static string StripHtml(string value)
        => Regex.Replace(HtmlTagPattern.Replace(value, " "), @"\s+", " ").Trim();

    private static string HtmlDecode(string value)
        => WebUtility.HtmlDecode(value ?? "")?.Trim() ?? "";

    private static string ReadString(JsonElement element, string propertyName, string fallback = "")
        => element.TryGetProperty(propertyName, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()?.Trim() ?? fallback
            : fallback;

    private static string? ReadNestedString(JsonElement element, string propertyName, string nestedPropertyName)
        => element.TryGetProperty(propertyName, out var nested) && nested.ValueKind == JsonValueKind.Object
            ? ReadString(nested, nestedPropertyName)
            : null;

    private static int ReadInt(JsonElement element, string propertyName)
        => element.TryGetProperty(propertyName, out var value) && value.TryGetInt32(out var result) ? result : 0;

    private static double ReadNestedNumber(JsonElement element, string propertyName, string nestedPropertyName)
    {
        if (!element.TryGetProperty(propertyName, out var nested) || nested.ValueKind != JsonValueKind.Object)
        {
            return 0;
        }

        if (!nested.TryGetProperty(nestedPropertyName, out var value))
        {
            return 0;
        }

        return value.ValueKind switch
        {
            JsonValueKind.Number when value.TryGetDouble(out var number) => number,
            _ => 0,
        };
    }
}
