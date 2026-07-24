using System.Reflection;
using System.Text.Json;
using Xunit;

namespace CodexImSuite.ControlPanel.Tests;

public sealed class ControlApiContractTests
{
    [Fact]
    public void ControlApiDtos_AlignWithSharedJsonSchema()
    {
        var assembly = typeof(ClaudeToImControlPanel.RuntimeUpdateSupport).Assembly;
        var panelStateType = assembly.GetType("ClaudeToImControlPanel.ControlPanelStateContract");
        var commandType = assembly.GetType("ClaudeToImControlPanel.ControlCommandRequest");
        var resultType = assembly.GetType("ClaudeToImControlPanel.ControlCommandResult");
        var runtimeUnitType = assembly.GetType("ClaudeToImControlPanel.RuntimeUnitContract");
        var projectRegistryType = assembly.GetType("ClaudeToImControlPanel.ProjectRegistrySnapshotContract");
        var agentPanelStateType = assembly.GetType("ClaudeToImControlPanel.AgentCollaborationPanelStateContract");
        var agentManifestType = assembly.GetType("ClaudeToImControlPanel.CollaborationAgentManifestContract");
        var agentWorkerType = assembly.GetType("ClaudeToImControlPanel.AgentWorkerViewContract");
        var agentResponsibilityType = assembly.GetType("ClaudeToImControlPanel.AgentResponsibilityViewContract");
        var agentMetricsType = assembly.GetType("ClaudeToImControlPanel.AgentCollaborationMetricsViewContract");

        Assert.NotNull(panelStateType);
        Assert.NotNull(commandType);
        Assert.NotNull(resultType);
        Assert.NotNull(runtimeUnitType);
        Assert.NotNull(projectRegistryType);
        Assert.NotNull(agentPanelStateType);
        Assert.NotNull(agentManifestType);
        Assert.NotNull(agentWorkerType);
        Assert.NotNull(agentResponsibilityType);
        Assert.NotNull(agentMetricsType);

        var schemaPath = Path.Combine(FindRepositoryRoot(), "packages", "contracts", "schemas", "control-api.schema.json");
        Assert.True(File.Exists(schemaPath), $"共享协议 schema 不存在：{schemaPath}");

        using var schema = JsonDocument.Parse(File.ReadAllText(schemaPath));
        var definitions = schema.RootElement.GetProperty("$defs");
        AssertDtoProperties(panelStateType!, definitions.GetProperty("ControlPanelStateContract"));
        AssertDtoProperties(commandType!, definitions.GetProperty("ControlCommandRequest"));
        AssertDtoProperties(resultType!, definitions.GetProperty("ControlCommandResult"));
        AssertDtoProperties(runtimeUnitType!, definitions.GetProperty("RuntimeUnitContract"));
        AssertDtoProperties(projectRegistryType!, definitions.GetProperty("ProjectRegistrySnapshotContract"));

        var agentSchemaPath = Path.Combine(FindRepositoryRoot(), "packages", "contracts", "schemas", "agent-collaboration.schema.json");
        Assert.True(File.Exists(agentSchemaPath), $"Agent 协作 schema 不存在：{agentSchemaPath}");
        using var agentSchema = JsonDocument.Parse(File.ReadAllText(agentSchemaPath));
        var agentDefinitions = agentSchema.RootElement.GetProperty("$defs");
        AssertDtoProperties(agentPanelStateType!, agentDefinitions.GetProperty("AgentCollaborationPanelState"));
        AssertDtoProperties(agentManifestType!, agentDefinitions.GetProperty("CollaborationAgentManifest"));
        AssertDtoProperties(agentWorkerType!, agentDefinitions.GetProperty("AgentWorkerView"));
        AssertDtoProperties(agentResponsibilityType!, agentDefinitions.GetProperty("AgentResponsibilityView"));
        AssertDtoProperties(agentMetricsType!, agentDefinitions.GetProperty("AgentCollaborationMetricsView"));
    }

    private static void AssertDtoProperties(Type dtoType, JsonElement schema)
    {
        var serializerOptions = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
        var dtoProperties = dtoType
            .GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Select(property => serializerOptions.PropertyNamingPolicy!.ConvertName(property.Name))
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
        var schemaProperties = schema.GetProperty("properties")
            .EnumerateObject()
            .Select(property => property.Name)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(schemaProperties, dtoProperties);
    }

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "package.json"))
                && Directory.Exists(Path.Combine(directory.FullName, "packages", "contracts")))
            {
                return directory.FullName;
            }
            directory = directory.Parent;
        }
        throw new DirectoryNotFoundException("无法定位 codex-im-suite 仓库根目录。");
    }
}
