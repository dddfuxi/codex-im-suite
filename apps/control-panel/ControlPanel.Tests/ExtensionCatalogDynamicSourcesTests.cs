using ClaudeToImControlPanel;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class ExtensionCatalogDynamicSourcesTests
{
    [Fact]
    public void ParseNpmSearchJson_ExtractsTopPackage()
    {
        const string json = """
        {
          "objects": [
            {
              "package": {
                "name": "@playwright/mcp",
                "version": "0.0.75",
                "description": "Playwright Tools for MCP",
                "links": {
                  "npm": "https://www.npmjs.com/package/@playwright/mcp"
                }
              },
              "score": {
                "final": 312.87
              }
            }
          ]
        }
        """;

        var items = ExtensionCatalogDynamicSources.ParseNpmSearchJson(json, 5);

        var item = Assert.Single(items);
        Assert.Equal("mcp", item.Type);
        Assert.Equal("@playwright/mcp", item.DisplayName);
        Assert.Equal("mcp.npm", item.InstallHandler);
        Assert.Equal("npm", item.ArtifactKind);
        Assert.Equal("@playwright/mcp", item.ArtifactPackageName);
    }

    [Fact]
    public void ParsePyPiRssXml_FiltersForMcpPackages()
    {
        const string xml = """
        <rss version="2.0">
          <channel>
            <item>
              <title>acme-mcp 1.2.3</title>
              <link>https://pypi.org/project/acme-mcp/1.2.3/</link>
              <description>Model Context Protocol toolkit</description>
            </item>
            <item>
              <title>plain-package 0.1.0</title>
              <link>https://pypi.org/project/plain-package/0.1.0/</link>
              <description>Unrelated package</description>
            </item>
          </channel>
        </rss>
        """;

        var items = ExtensionCatalogDynamicSources.ParsePyPiRssXml(xml, 5);

        var item = Assert.Single(items);
        Assert.Equal("acme-mcp", item.DisplayName);
        Assert.Equal("mcp.uvx", item.InstallHandler);
        Assert.Equal("pypi", item.ArtifactKind);
    }

    [Fact]
    public void ParseOllamaLibraryHtml_ExtractsPopularModelRows()
    {
        const string html = """
        <ul>
          <li x-test-model>
            <a href="/library/llama3.1" class="group">
              <span class="group-hover:underline truncate">llama3.1</span>
              <p class="max-w-lg break-words text-neutral-800 text-md">Meta model</p>
              <span x-test-pull-count>114.8M</span>
            </a>
          </li>
        </ul>
        """;

        var items = ExtensionCatalogDynamicSources.ParseOllamaLibraryHtml(html, 5);

        var item = Assert.Single(items);
        Assert.Equal("model", item.Type);
        Assert.Equal("ollama.pull", item.InstallHandler);
        Assert.Equal("llama3.1", item.ArtifactModel);
    }

    [Fact]
    public void ParseMcpRegistryServersJson_PrefersInstallablePackages()
    {
        const string json = """
        {
          "servers": [
            {
              "server": {
                "name": "io.example/server",
                "description": "Example server",
                "version": "1.0.0",
                "packages": [
                  {
                    "registryType": "npm",
                    "identifier": "@example/server"
                  }
                ],
                "repository": {
                  "url": "https://github.com/example/server"
                }
              }
            }
          ]
        }
        """;

        var items = ExtensionCatalogDynamicSources.ParseMcpRegistryServersJson(json, 5);

        var item = Assert.Single(items);
        Assert.Equal("mcp.npm", item.InstallHandler);
        Assert.Equal("@example/server", item.ArtifactPackageName);
        Assert.Equal("npm", item.ArtifactKind);
    }
}
